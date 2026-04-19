"""VOC 처리 에이전트 — OpsMaster AI.

과거 장애·VOC 이력(voc_case)과 운영 매뉴얼(voc_manual)을 RAG 소스로 사용해
사용자가 입력한 오류·장애 내용에 대한 근본 원인 분석과 단계별 해결책을 스트리밍으로 반환한다.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator, Optional

from agents.base import AgentBase
from agents.voc_agent import retrieval
from core.database import get_conn
from service.chat import memory
from service.chat.helpers import (
    LLM_UNAVAILABLE_MSG,
    create_query_log,
    post_save_tasks,
    update_assistant_message,
    update_inhouse_conv_id,
)
from service.llm.factory import get_llm_provider
from shared import cache as sem_cache
from shared.embedding import embedding_service

logger = logging.getLogger(__name__)

_FLUSH_INTERVAL = 20

_VOC_SYSTEM_PROMPT = """\
당신은 IT 운영팀 전담 장애·VOC 처리 AI 에이전트 "OpsMaster AI"입니다.
제공된 과거 장애 이력과 운영 매뉴얼을 근거로 명확하고 실행 가능한 해결책을 제시합니다.

[응답 형식]
## 🔍 근본 원인 분석
과거 유사 사례 또는 매뉴얼 기반 원인 설명

## ✅ 단계별 해결 절차
1. 첫 번째 조치 사항
2. 두 번째 조치 사항
(필요한 만큼 기술)

## 📎 참고 출처
- VOC 사례 N: 사례 제목
- 매뉴얼 M: 섹션 제목

## 🚨 에스컬레이션 경로 (미해결 시)
담당 팀 또는 다음 단계 조치 안내

[원칙]
- 제공된 [VOC 이력]과 [운영 매뉴얼]만 근거로 답변한다
- 근거 없이 추측하지 않는다
- 해결책이 없는 경우 솔직히 인정하고 에스컬레이션을 권고한다
- Markdown 형식으로 작성한다\
"""


async def _safe_post_save(conv_id: int, namespace: str) -> None:
    try:
        await post_save_tasks(conv_id, namespace)
    except Exception as e:
        logger.warning("post_save_tasks 실패: %s", e)


class VocAgent(AgentBase):
    """OpsMaster AI — VOC·장애 처리 전담 에이전트."""

    @property
    def agent_id(self) -> str:
        return "voc_agent"

    @property
    def metadata(self) -> dict:
        return {
            "display_name": "VOC 처리 AI",
            "description": "장애 이력 및 운영 매뉴얼 기반 VOC·장애 해결 에이전트",
            "icon": "AlertTriangle",
            "color": "orange",
            "output_type": "text",
            "welcome_message": (
                "장애 증상이나 VOC 내용을 입력해주세요. "
                "과거 이력과 운영 매뉴얼을 기반으로 해결책을 제시합니다."
            ),
            "supports_debug": True,
        }

    async def stream_chat(
        self,
        query: str,
        user: dict,
        conversation_id: int,
        context: dict,
    ) -> AsyncIterator[dict]:
        namespace: str = context["namespace"]
        msg_id: int = context["msg_id"]
        w_vector: float = context.get("w_vector", 0.6)
        w_keyword: float = context.get("w_keyword", 0.4)
        top_k: int = context.get("top_k", 5)
        api_key: Optional[str] = context.get("api_key")
        inhouse_conv_id: Optional[str] = context.get("inhouse_conv_id")
        category: Optional[str] = context.get("category")
        severity: Optional[str] = context.get("severity")

        full_answer = ""
        token_count = 0
        has_results = False
        llm_failed = False
        results_payload: list[dict] = []

        try:
            yield {"type": "status", "step": "embedding", "message": "질문 임베딩 생성 중..."}

            # 멀티턴 검색 보강: 직전 교환 내용을 쿼리에 결합
            search_question = query
            async with get_conn() as conn:
                prev_pair = await conn.fetch(
                    """
                    SELECT role, content FROM (
                        SELECT role, content, created_at, id FROM ops_message
                        WHERE conversation_id = $1 AND id < $2
                        ORDER BY created_at DESC, id DESC LIMIT 2
                    ) sub ORDER BY sub.created_at ASC, sub.id ASC
                    """,
                    conversation_id, msg_id,
                )
            if prev_pair:
                prev_ctx = " ".join(r["content"][:80] for r in prev_pair if r["content"])
                search_question = f"{prev_ctx} {query}"

            query_vec, cache_vec = await asyncio.gather(
                embedding_service.embed(search_question),
                embedding_service.embed(sem_cache.normalize_query(search_question)),
            )

            # ── Semantic Cache 조회 ──────────────────────────────────────────
            cached = await sem_cache.get_cached(namespace, cache_vec)
            if cached:
                await update_assistant_message(msg_id, cached["answer"], "completed")
                yield {
                    "type": "meta",
                    "conversation_id": conversation_id,
                    "message_id": msg_id,
                    "mapped_term": None,
                    "results": cached.get("results", []),
                }
                yield {"type": "token", "data": cached["answer"]}
                await create_query_log(
                    namespace, query, cached["answer"],
                    bool(cached.get("results")), None, msg_id,
                )
                yield {"type": "done", "message_id": msg_id, "status": "completed"}
                return

            yield {"type": "status", "step": "context", "message": "대화 맥락 로딩 중..."}
            history = await memory.build_context_history(conversation_id, query_vec)

            yield {"type": "status", "step": "search", "message": "VOC 이력 및 운영 매뉴얼 검색 중..."}
            cases, manuals = await asyncio.gather(
                retrieval.search_voc_cases(
                    namespace, query_vec, search_question,
                    w_vector, w_keyword, top_k, category, severity,
                ),
                retrieval.search_voc_manuals(
                    namespace, query_vec, search_question,
                    w_vector, w_keyword, 3, category,
                ),
            )

            case_ctx = retrieval.build_case_context(cases)
            manual_ctx = retrieval.build_manual_context(manuals)

            llm_context_parts: list[str] = []
            if case_ctx:
                llm_context_parts.append(f"[VOC 이력]\n{case_ctx}")
            if manual_ctx:
                llm_context_parts.append(f"[운영 매뉴얼]\n{manual_ctx}")
            llm_context = "\n\n".join(llm_context_parts)

            has_results = bool(cases or manuals)
            results_payload = [
                {
                    "id": c.id, "type": "voc_case", "title": c.title,
                    "severity": c.severity, "category": c.category,
                    "final_score": c.final_score,
                }
                for c in cases
                if c.final_score >= retrieval.MIN_SCORE
            ] + [
                {
                    "id": m.id, "type": "voc_manual", "title": m.title,
                    "category": m.category, "final_score": m.final_score,
                }
                for m in manuals
                if m.final_score >= retrieval.MIN_SCORE
            ]

            async with get_conn() as conn:
                await conn.execute(
                    "UPDATE ops_message SET results = $1::jsonb WHERE id = $2",
                    json.dumps(results_payload, ensure_ascii=False), msg_id,
                )

            yield {
                "type": "meta",
                "conversation_id": conversation_id,
                "message_id": msg_id,
                "mapped_term": None,
                "results": results_payload,
            }

            yield {"type": "status", "step": "llm", "message": "AI 해결책 생성 중..."}

            new_inhouse_conv_id: Optional[str] = None

            def _capture_inhouse_conv_id(cid: str) -> None:
                nonlocal new_inhouse_conv_id
                new_inhouse_conv_id = cid

            try:
                async for token in get_llm_provider().generate_stream(
                    llm_context, query, history,
                    api_key=api_key,
                    ext_conversation_id=inhouse_conv_id,
                    on_ext_conversation_id=_capture_inhouse_conv_id,
                    system_prompt=_VOC_SYSTEM_PROMPT,
                ):
                    full_answer += token
                    token_count += 1
                    if token_count == 1 or token_count % _FLUSH_INTERVAL == 0:
                        await update_assistant_message(msg_id, full_answer)
                    yield {"type": "token", "data": token}
            except Exception as e:
                logger.warning("LLM 스트리밍 실패: %s", e)
                llm_failed = True
                full_answer = LLM_UNAVAILABLE_MSG
                yield {"type": "token", "data": LLM_UNAVAILABLE_MSG}

            final_answer = full_answer or LLM_UNAVAILABLE_MSG
            msg_status = "failed" if llm_failed else "completed"
            await update_assistant_message(msg_id, final_answer, msg_status)

            if new_inhouse_conv_id and new_inhouse_conv_id != inhouse_conv_id:
                await update_inhouse_conv_id(conversation_id, new_inhouse_conv_id)

            await create_query_log(namespace, query, final_answer, has_results, None, msg_id)

            if final_answer != LLM_UNAVAILABLE_MSG:
                await sem_cache.set_cached(namespace, cache_vec, {
                    "answer": final_answer,
                    "results": results_payload,
                    "query": query,
                })

            yield {"type": "done", "message_id": msg_id, "status": msg_status}

        except Exception as e:
            logger.error("VocAgent 에러: %s", e, exc_info=True)
            if not full_answer:
                full_answer = LLM_UNAVAILABLE_MSG
            await update_assistant_message(msg_id, full_answer, "completed")
        finally:
            asyncio.create_task(_safe_post_save(conversation_id, namespace))
