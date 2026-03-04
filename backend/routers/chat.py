"""
POST /api/chat  — 운영 보조 챗 엔드포인트
SSE 스트리밍 + 단일 응답 모두 지원
대화방(conversation) 맥락 유지 (최근 2회 교환 LLM 전달)
"""
import asyncio
import json
import logging
from typing import Optional

import httpx
from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from database import get_conn
from models.api_models import (
    ChatRequest, ChatResponse, KnowledgeResult,
    DebugSearchResponse, GlossaryMatchInfo, DebugResult,
)
from services.llm import get_llm_provider
from services import retrieval
from services.embedding import embedding_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/chat", tags=["chat"])

_LLM_UNAVAILABLE_MSG = "[LLM 서버에 연결할 수 없습니다. 검색 결과를 참고하세요.]"


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


# ── 대화방 관리 헬퍼 ──────────────────────────────────────────────────────────

async def _get_or_create_conversation(
    namespace: str, question: str, conversation_id: Optional[int]
) -> int:
    async with get_conn() as conn:
        if conversation_id:
            exists = await conn.fetchval(
                "SELECT 1 FROM ops_conversation WHERE id = $1", conversation_id
            )
            if exists:
                return conversation_id
        row = await conn.fetchrow(
            "INSERT INTO ops_conversation (namespace, title) VALUES ($1, $2) RETURNING id",
            namespace, question[:200],
        )
        return row["id"]


async def _load_history(conversation_id: int, exchanges: int = 2) -> list[dict]:
    """최근 N회 교환(user+assistant 쌍)을 시간순으로 반환."""
    async with get_conn() as conn:
        rows = await conn.fetch(
            """
            SELECT role, content FROM (
                SELECT role, content, created_at
                FROM ops_message
                WHERE conversation_id = $1
                ORDER BY created_at DESC
                LIMIT $2
            ) sub
            ORDER BY created_at ASC
            """,
            conversation_id, exchanges * 2,
        )
    return [{"role": r["role"], "content": r["content"]} for r in rows]


async def _save_user_message(conversation_id: int, question: str) -> None:
    async with get_conn() as conn:
        await conn.execute(
            "INSERT INTO ops_message (conversation_id, role, content) VALUES ($1, $2, $3)",
            conversation_id, "user", question,
        )


async def _save_assistant_message(
    conversation_id: int,
    answer: str,
    mapped_term: Optional[str],
    results: list,
) -> None:
    results_json = json.dumps(
        [{"id": r.id, "content": r.content, "final_score": r.final_score,
          "container_name": r.container_name, "target_tables": r.target_tables,
          "query_template": r.query_template}
         for r in results],
        ensure_ascii=False,
    )
    async with get_conn() as conn:
        await conn.execute(
            """
            INSERT INTO ops_message (conversation_id, role, content, mapped_term, results)
            VALUES ($1, $2, $3, $4, $5::jsonb)
            """,
            conversation_id, "assistant", answer, mapped_term, results_json,
        )


async def _save_messages(
    conversation_id: int,
    question: str,
    answer: str,
    mapped_term: Optional[str],
    results: list,
) -> None:
    await _save_user_message(conversation_id, question)
    await _save_assistant_message(conversation_id, answer, mapped_term, results)


# ── 공통 헬퍼 ────────────────────────────────────────────────────────────────

async def _safe_generate(context: str, question: str, history: list[dict] | None = None) -> str:
    try:
        return await get_llm_provider().generate(context, question, history)
    except (httpx.ConnectError, httpx.TimeoutException, httpx.HTTPStatusError) as e:
        logger.warning("LLM 호출 실패: %s", e)
        return _LLM_UNAVAILABLE_MSG


async def _log_query(
    namespace: str, question: str, resolved: bool, mapped_term: Optional[str] = None
) -> None:
    async with get_conn() as conn:
        await conn.execute(
            """
            INSERT INTO ops_query_log (namespace, question, resolved, mapped_term)
            VALUES ($1, $2, $3, $4)
            """,
            namespace, question, resolved, mapped_term,
        )


# ── 엔드포인트 ────────────────────────────────────────────────────────────────

@router.post("", response_model=ChatResponse)
async def chat(req: ChatRequest):
    """하이브리드 검색 후 LLM 답변 반환 (단일 JSON)."""
    conv_id = await _get_or_create_conversation(req.namespace, req.question, req.conversation_id)
    history = await _load_history(conv_id)

    query_vec = await embedding_service.embed(req.question)
    glossary_match = await retrieval.map_glossary_term(req.namespace, query_vec)
    mapped_term = glossary_match.term if glossary_match else None
    enriched_query = f"{req.question} {mapped_term}" if mapped_term else req.question

    results, fewshots = await asyncio.gather(
        retrieval.search_knowledge(
            req.namespace, query_vec, enriched_query,
            req.w_vector, req.w_keyword, req.top_k,
        ),
        retrieval.fetch_fewshots(req.namespace, query_vec),
    )

    fs_section = retrieval.build_fewshot_section(fewshots)
    doc_context = retrieval.build_context(results)
    context = f"{fs_section}\n\n{doc_context}" if fs_section else doc_context

    answer = await _safe_generate(context, req.question, history)

    await asyncio.gather(
        _log_query(req.namespace, req.question, len(results) > 0, mapped_term),
        _save_messages(conv_id, req.question, answer, mapped_term, results),
    )

    return ChatResponse(
        conversation_id=conv_id,
        question=req.question,
        mapped_term=mapped_term,
        results=[
            KnowledgeResult(
                id=r.id,
                container_name=r.container_name,
                target_tables=r.target_tables,
                content=r.content,
                query_template=r.query_template,
                final_score=r.final_score,
            )
            for r in results
        ],
        answer=answer,
    )


@router.post("/stream")
async def chat_stream(req: ChatRequest):
    """단계별 status 이벤트 + SSE 스트리밍 응답."""

    async def event_generator():
        conv_id = await _get_or_create_conversation(
            req.namespace, req.question, req.conversation_id
        )
        history = await _load_history(conv_id)

        yield _sse({"type": "status", "step": "embedding",
                    "message": "🔍 질문 임베딩 생성 중..."})
        query_vec = await embedding_service.embed(req.question)

        yield _sse({"type": "status", "step": "glossary",
                    "message": "📖 용어집에서 표준 용어 매핑 중..."})
        glossary_match = await retrieval.map_glossary_term(req.namespace, query_vec)
        mapped_term = glossary_match.term if glossary_match else None
        enriched_query = f"{req.question} {mapped_term}" if mapped_term else req.question

        yield _sse({"type": "status", "step": "search",
                    "message": "🔎 하이브리드 검색 중 (벡터 + 키워드)..."})
        results, fewshots = await asyncio.gather(
            retrieval.search_knowledge(
                req.namespace, query_vec, enriched_query,
                req.w_vector, req.w_keyword, req.top_k,
            ),
            retrieval.fetch_fewshots(req.namespace, query_vec),
        )

        fs_section = retrieval.build_fewshot_section(fewshots)
        doc_context = retrieval.build_context(results)
        context = f"{fs_section}\n\n{doc_context}" if fs_section else doc_context

        await asyncio.gather(
            _log_query(req.namespace, req.question, len(results) > 0, mapped_term),
            _save_user_message(conv_id, req.question),  # 사용자 메시지 즉시 저장
        )

        meta_results = [
            {
                "id": r.id,
                "container_name": r.container_name,
                "target_tables": r.target_tables,
                "content": r.content,
                "query_template": r.query_template,
                "final_score": r.final_score,
            }
            for r in results
        ]
        yield _sse({
            "type": "meta",
            "conversation_id": conv_id,
            "mapped_term": mapped_term,
            "results": meta_results,
        })

        yield _sse({"type": "status", "step": "llm",
                    "message": "🤖 AI 답변 생성 중..."})
        full_answer = ""
        try:
            async for token in get_llm_provider().generate_stream(context, req.question, history):
                full_answer += token
                yield _sse({"type": "token", "data": token})
        except Exception as e:
            logger.warning("LLM 스트리밍 실패: %s", e)
            full_answer = _LLM_UNAVAILABLE_MSG
            yield _sse({"type": "token", "data": _LLM_UNAVAILABLE_MSG})
        finally:
            await _save_assistant_message(conv_id, full_answer or _LLM_UNAVAILABLE_MSG, mapped_term, results)

        yield _sse({"type": "done"})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/debug", response_model=DebugSearchResponse)
async def chat_debug(req: ChatRequest):
    """벡터 검색 디버그 — LLM 없이 파이프라인 전 과정 반환."""
    query_vec = await embedding_service.embed(req.question)

    glossary_match = await retrieval.map_glossary_term(req.namespace, query_vec)
    mapped_term = glossary_match.term if glossary_match else None
    enriched_query = f"{req.question} {mapped_term}" if mapped_term else req.question

    results = await retrieval.search_knowledge(
        req.namespace, query_vec, enriched_query,
        req.w_vector, req.w_keyword, req.top_k,
    )
    context = retrieval.build_context(results)

    return DebugSearchResponse(
        question=req.question,
        namespace=req.namespace,
        enriched_query=enriched_query,
        glossary_match=GlossaryMatchInfo(
            term=glossary_match.term,
            description=glossary_match.description,
            similarity=glossary_match.similarity,
        ) if glossary_match else None,
        w_vector=req.w_vector,
        w_keyword=req.w_keyword,
        results=[
            DebugResult(
                id=r.id,
                container_name=r.container_name,
                target_tables=r.target_tables,
                content=r.content,
                query_template=r.query_template,
                base_weight=r.base_weight,
                v_score=r.v_score,
                k_score=r.k_score,
                final_score=r.final_score,
            )
            for r in results
        ],
        context_preview=context[:800] + "\n..." if len(context) > 800 else context,
    )
