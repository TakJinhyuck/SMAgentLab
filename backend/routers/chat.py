"""운영 보조 챗 엔드포인트 — SSE 스트리밍 + 단일 응답 + 디버그."""
import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Optional

import httpx
from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from database import get_conn
from models.api_models import (
    ChatRequest, ChatResponse, KnowledgeResult,
    DebugSearchResponse, GlossaryMatchInfo, DebugResult, FewshotResult,
)
from services.llm import get_llm_provider
from services import retrieval, memory
from services.embedding import embedding_service
from services.retrieval import GlossaryMatch, RetrievalResult
from routers.conversations import cleanup_old_messages, cleanup_resolved_query_logs

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/chat", tags=["chat"])

_LLM_UNAVAILABLE_MSG = "[LLM 서버에 연결할 수 없습니다. 검색 결과를 참고하세요.]"


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


# ── 공통 파이프라인 ──────────────────────────────────────────────────────────

@dataclass
class PipelineResult:
    query_vec: list[float]
    glossary_match: Optional[GlossaryMatch]
    mapped_term: Optional[str]
    enriched_query: str
    results: list[RetrievalResult]
    fewshots: list[dict]
    context: str


async def _run_pipeline(
    namespace: str, question: str, query_vec: list[float],
    w_vector: float, w_keyword: float, top_k: int,
    *, debug: bool = False,
) -> PipelineResult:
    """용어 매핑 → 하이브리드 검색 → 컨텍스트 빌드 공통 파이프라인."""
    glossary_match = await retrieval.map_glossary_term(namespace, query_vec)
    mapped_term = glossary_match.term if glossary_match else None
    enriched_query = f"{question} {mapped_term}" if mapped_term else question

    fewshot_kwargs = {"min_similarity": 0.0} if debug else {}
    results, fewshots = await asyncio.gather(
        retrieval.search_knowledge(namespace, query_vec, enriched_query, w_vector, w_keyword, top_k),
        retrieval.fetch_fewshots(namespace, query_vec, **fewshot_kwargs),
    )

    fs_section = retrieval.build_fewshot_section(fewshots)
    doc_context = retrieval.build_context(results)
    context = f"{fs_section}\n\n{doc_context}" if fs_section else doc_context

    return PipelineResult(
        query_vec=query_vec, glossary_match=glossary_match,
        mapped_term=mapped_term, enriched_query=enriched_query,
        results=results, fewshots=fewshots, context=context,
    )


def _results_to_json(results: list[RetrievalResult]) -> str:
    return json.dumps(
        [{"id": r.id, "content": r.content, "final_score": r.final_score,
          "container_name": r.container_name, "target_tables": r.target_tables,
          "query_template": r.query_template}
         for r in results],
        ensure_ascii=False,
    )


def _results_to_payload(results: list[RetrievalResult]) -> list[dict]:
    return [
        {"id": r.id, "container_name": r.container_name,
         "target_tables": r.target_tables, "content": r.content,
         "query_template": r.query_template, "final_score": r.final_score}
        for r in results
    ]


# ── DB 헬퍼 ──────────────────────────────────────────────────────────────────

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


async def _save_user_message(conversation_id: int, question: str) -> None:
    async with get_conn() as conn:
        await conn.execute(
            "INSERT INTO ops_message (conversation_id, role, content) VALUES ($1, $2, $3)",
            conversation_id, "user", question,
        )


async def _save_assistant_message(
    conversation_id: int, answer: str,
    mapped_term: Optional[str], results: list[RetrievalResult],
) -> int:
    async with get_conn() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO ops_message (conversation_id, role, content, mapped_term, results)
            VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id
            """,
            conversation_id, "assistant", answer, mapped_term, _results_to_json(results),
        )
    return row["id"]


async def _pre_create_assistant_message(
    conversation_id: int, mapped_term: Optional[str], results: list[RetrievalResult],
) -> int:
    async with get_conn() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO ops_message (conversation_id, role, content, mapped_term, results, status)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id
            """,
            conversation_id, "assistant", "", mapped_term, _results_to_json(results), "generating",
        )
    return row["id"]


async def _update_assistant_message(msg_id: int, content: str, status: str = "generating") -> None:
    async with get_conn() as conn:
        await conn.execute(
            "UPDATE ops_message SET content = $1, status = $2 WHERE id = $3", content, status, msg_id,
        )


async def _cleanup_ghost_messages(conversation_id: int) -> None:
    async with get_conn() as conn:
        await conn.execute(
            "DELETE FROM ops_message WHERE conversation_id = $1 AND role = 'assistant' AND content = '' AND status != 'generating'",
            conversation_id,
        )


async def _safe_generate(context: str, question: str, history: list[dict] | None = None) -> str:
    try:
        return await get_llm_provider().generate(context, question, history)
    except (httpx.ConnectError, httpx.TimeoutException, httpx.HTTPStatusError) as e:
        logger.warning("LLM 호출 실패: %s", e)
        return _LLM_UNAVAILABLE_MSG


async def _create_query_log(
    namespace: str, question: str, answer: str,
    has_results: bool, mapped_term: Optional[str] = None,
    message_id: Optional[int] = None,
) -> int:
    # 검색 결과가 없고 LLM 답변도 정상이 아닌 경우만 unresolved
    is_real_answer = answer and answer != _LLM_UNAVAILABLE_MSG
    status = "unresolved" if (not has_results and not is_real_answer) else "pending"
    async with get_conn() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO ops_query_log (namespace, question, answer, status, mapped_term, message_id)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
            """,
            namespace, question, answer, status, mapped_term, message_id,
        )
    return row["id"]


async def _post_save_tasks(conv_id: int, namespace: Optional[str] = None) -> None:
    try:
        await memory.maybe_summarize(conv_id, get_llm_provider())
    except Exception as e:
        logger.warning("요약 후처리 실패: %s", e)
    try:
        if namespace:
            await cleanup_old_messages(namespace)
        await cleanup_resolved_query_logs()
    except Exception as e:
        logger.warning("cleanup 실패: %s", e)


# ── 엔드포인트 ────────────────────────────────────────────────────────────────

@router.post("", response_model=ChatResponse)
async def chat(req: ChatRequest):
    conv_id = await _get_or_create_conversation(req.namespace, req.question, req.conversation_id)
    query_vec = await embedding_service.embed(req.question)

    pipe, history = await asyncio.gather(
        _run_pipeline(req.namespace, req.question, query_vec, req.w_vector, req.w_keyword, req.top_k),
        memory.build_context_history(conv_id, query_vec),
    )

    answer = await _safe_generate(pipe.context, req.question, history)

    await _save_user_message(conv_id, req.question)
    msg_id = await _save_assistant_message(conv_id, answer, pipe.mapped_term, pipe.results)
    await _create_query_log(
        req.namespace, req.question, answer,
        len(pipe.results) > 0, pipe.mapped_term, msg_id,
    )
    asyncio.create_task(_post_save_tasks(conv_id, req.namespace))

    return ChatResponse(
        conversation_id=conv_id,
        question=req.question,
        mapped_term=pipe.mapped_term,
        results=[
            KnowledgeResult(
                id=r.id, container_name=r.container_name,
                target_tables=r.target_tables, content=r.content,
                query_template=r.query_template, final_score=r.final_score,
            )
            for r in pipe.results
        ],
        answer=answer,
    )


@router.post("/stream")
async def chat_stream(req: ChatRequest):
    conv_id = await _get_or_create_conversation(req.namespace, req.question, req.conversation_id)
    await _cleanup_ghost_messages(conv_id)

    # ── Early Meta: DB insert 즉시 수행 ──
    await _save_user_message(conv_id, req.question)
    msg_id = await _pre_create_assistant_message(conv_id, None, [])

    # ── Worker와 통신할 Queue ──
    queue: asyncio.Queue = asyncio.Queue()

    # ── 독립 Background Task: 클라이언트 연결과 무관하게 끝까지 실행 ──
    asyncio.create_task(_generate_worker(
        queue, conv_id, msg_id, req.namespace, req.question,
        req.w_vector, req.w_keyword, req.top_k,
    ))

    async def event_generator():
        # Early Meta 즉시 전송
        yield _sse({
            "type": "meta",
            "conversation_id": conv_id,
            "message_id": msg_id,
            "mapped_term": None,
            "results": [],
        })

        try:
            while True:
                event = await queue.get()
                if event is None:  # EOF
                    break
                yield _sse(event)
        except (asyncio.CancelledError, GeneratorExit):
            # 클라이언트가 끊어져도 worker task는 백그라운드에서 계속 실행됨
            pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _generate_worker(
    queue: asyncio.Queue,
    conv_id: int, msg_id: int,
    namespace: str, question: str,
    w_vector: float, w_keyword: float, top_k: int,
) -> None:
    """HTTP 연결과 무관한 독립 생성 워커. 끝까지 실행되어 DB에 저장."""
    full_answer = ""
    token_count = 0
    _FLUSH_INTERVAL = 20
    mapped_term = None
    has_results = False

    try:
        await queue.put({"type": "status", "step": "embedding", "message": "질문 임베딩 생성 중..."})
        query_vec = await embedding_service.embed(question)

        await queue.put({"type": "status", "step": "context", "message": "용어 매핑 및 대화 맥락 검색 중..."})
        glossary_task = retrieval.map_glossary_term(namespace, query_vec)
        history_task = memory.build_context_history(conv_id, query_vec)
        glossary_match, history = await asyncio.gather(glossary_task, history_task)
        mapped_term = glossary_match.term if glossary_match else None
        enriched_query = f"{question} {mapped_term}" if mapped_term else question

        await queue.put({"type": "status", "step": "search", "message": "관련 문서 검색 중..."})
        results, fewshots = await asyncio.gather(
            retrieval.search_knowledge(
                namespace, query_vec, enriched_query,
                w_vector, w_keyword, top_k,
            ),
            retrieval.fetch_fewshots(namespace, query_vec),
        )

        fs_section = retrieval.build_fewshot_section(fewshots)
        doc_context = retrieval.build_context(results)
        context = f"{fs_section}\n\n{doc_context}" if fs_section else doc_context
        has_results = len(results) > 0

        # DB에 검색 결과 업데이트
        async with get_conn() as conn:
            await conn.execute(
                "UPDATE ops_message SET mapped_term = $1, results = $2::jsonb WHERE id = $3",
                mapped_term, _results_to_json(results), msg_id,
            )

        # 검색 결과를 클라이언트에 전송
        await queue.put({
            "type": "meta",
            "conversation_id": conv_id,
            "message_id": msg_id,
            "mapped_term": mapped_term,
            "results": _results_to_payload(results),
        })

        await queue.put({"type": "status", "step": "llm", "message": "AI 답변 생성 중..."})

        try:
            async for token in get_llm_provider().generate_stream(context, question, history):
                full_answer += token
                token_count += 1
                if token_count == 1 or token_count % _FLUSH_INTERVAL == 0:
                    await _update_assistant_message(msg_id, full_answer)
                await queue.put({"type": "token", "data": token})
        except Exception as e:
            logger.warning("LLM 스트리밍 실패: %s", e)
            full_answer = _LLM_UNAVAILABLE_MSG
            await queue.put({"type": "token", "data": _LLM_UNAVAILABLE_MSG})

        # 최종 저장 (status → completed)
        final_answer = full_answer or _LLM_UNAVAILABLE_MSG
        await _update_assistant_message(msg_id, final_answer, "completed")
        await _create_query_log(namespace, question, final_answer, has_results, mapped_term, msg_id)
        await queue.put({"type": "done", "message_id": msg_id})

    except Exception as e:
        logger.error("generate_worker 에러: %s", e, exc_info=True)
        if not full_answer:
            full_answer = _LLM_UNAVAILABLE_MSG
        await _update_assistant_message(msg_id, full_answer, "completed")
    finally:
        await queue.put(None)  # EOF — event_generator 종료 신호
        try:
            await _post_save_tasks(conv_id, namespace)
        except Exception as e:
            logger.warning("post_save_tasks 실패: %s", e)


@router.patch("/messages/{msg_id}/content")
async def save_partial_content(msg_id: int, body: dict):
    """프론트엔드가 스트림 중단 시 축적된 content를 저장."""
    content = (body.get("content") or "").strip()
    if not content:
        return {"ok": True}
    async with get_conn() as conn:
        # 기존 content보다 길 때만 업데이트 (더 완전한 내용 보존)
        current = await conn.fetchval(
            "SELECT LENGTH(content) FROM ops_message WHERE id = $1 AND role = 'assistant'",
            msg_id,
        )
        if current is not None and len(content) > current:
            await conn.execute(
                "UPDATE ops_message SET content = $1 WHERE id = $2",
                content, msg_id,
            )
    return {"ok": True}


@router.delete("/messages/{msg_id}")
async def delete_ghost_message(msg_id: int):
    """빈 assistant 메시지(ghost) + 짝 user 메시지 삭제 — 스트림 중단 시 프론트엔드가 호출."""
    async with get_conn() as conn:
        # 먼저 대화 ID와 바로 앞 user 메시지 ID를 조회
        row = await conn.fetchrow(
            """
            SELECT m.conversation_id,
                   (SELECT id FROM ops_message
                    WHERE conversation_id = m.conversation_id AND id < m.id AND role = 'user'
                    ORDER BY id DESC LIMIT 1) AS prev_user_id
            FROM ops_message m
            WHERE m.id = $1 AND m.role = 'assistant' AND (m.content IS NULL OR m.content = '')
            """,
            msg_id,
        )
        if not row:
            return {"ok": True}
        conv_id = row["conversation_id"]
        # ghost assistant 삭제
        await conn.execute("DELETE FROM ops_message WHERE id = $1", msg_id)
        # 짝 user 메시지 삭제
        if row["prev_user_id"]:
            await conn.execute("DELETE FROM ops_message WHERE id = $1", row["prev_user_id"])
        # 메시지가 0개가 된 빈 대화방도 삭제
        remaining = await conn.fetchval(
            "SELECT COUNT(*) FROM ops_message WHERE conversation_id = $1", conv_id,
        )
        if remaining == 0:
            await conn.execute("DELETE FROM ops_conversation WHERE id = $1", conv_id)
    return {"ok": True}


@router.post("/debug", response_model=DebugSearchResponse)
async def chat_debug(req: ChatRequest):
    query_vec = await embedding_service.embed(req.question)
    pipe = await _run_pipeline(
        req.namespace, req.question, query_vec,
        req.w_vector, req.w_keyword, req.top_k,
        debug=True,
    )

    return DebugSearchResponse(
        question=req.question,
        namespace=req.namespace,
        enriched_query=pipe.enriched_query,
        glossary_match=GlossaryMatchInfo(
            term=pipe.glossary_match.term,
            description=pipe.glossary_match.description,
            similarity=pipe.glossary_match.similarity,
        ) if pipe.glossary_match else None,
        w_vector=req.w_vector,
        w_keyword=req.w_keyword,
        fewshots=[
            FewshotResult(question=fs["question"], answer=fs["answer"], similarity=fs.get("similarity", 0.0))
            for fs in pipe.fewshots
        ],
        results=[
            DebugResult(
                id=r.id, container_name=r.container_name,
                target_tables=r.target_tables, content=r.content,
                query_template=r.query_template, base_weight=r.base_weight,
                v_score=r.v_score, k_score=r.k_score, final_score=r.final_score,
            )
            for r in pipe.results
        ],
        context_preview=pipe.context[:1200] + "\n..." if len(pipe.context) > 1200 else pipe.context,
    )
