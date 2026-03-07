"""
대화 메모리 관리 — ConversationSummaryBuffer + Semantic Recall 패턴

동작 원리:
1. [Working Memory]  최근 RECENT_EXCHANGES회 교환 → 항상 raw 텍스트로 LLM에 전달
2. [Summarization]   총 교환 수가 SUMMARY_TRIGGER 배수에 도달하면
                     오래된 교환을 LLM으로 요약 → ops_conv_summary에 임베딩 저장
3. [Semantic Recall] 새 질문의 임베딩으로 과거 요약을 검색 →
                     유사도 RECALL_THRESHOLD 이상인 요약만 컨텍스트에 포함

LLM 컨텍스트 구성:
  [관련 과거 요약(system)] + [최근 raw 교환] + [현재 질문]
"""
from __future__ import annotations

import logging
from typing import Optional

from database import get_conn
from services.embedding import embedding_service

logger = logging.getLogger(__name__)

# ── 튜닝 파라미터 ──────────────────────────────────────────────────────────────
SUMMARY_TRIGGER = 4      # 교환 N회마다 오래된 교환을 요약
RECENT_EXCHANGES = 2     # 항상 raw로 유지하는 최근 교환 수
MAX_RECALL = 2           # 검색으로 가져올 과거 요약 최대 수
RECALL_THRESHOLD = 0.45  # 요약 유사도 임계치 (이 이상만 컨텍스트에 포함)


# ── 최근 raw 교환 로드 ─────────────────────────────────────────────────────────

async def load_recent_history(
    conversation_id: int,
    exchanges: int = RECENT_EXCHANGES,
) -> list[dict]:
    """최근 exchanges회 user+assistant 쌍을 시간순으로 반환."""
    async with get_conn() as conn:
        rows = await conn.fetch(
            """
            SELECT role, content FROM (
                SELECT role, content, created_at, id
                FROM ops_message
                WHERE conversation_id = $1
                ORDER BY created_at DESC, CASE WHEN role = 'user' THEN 1 ELSE 0 END, id DESC
                LIMIT $2
            ) sub
            ORDER BY sub.created_at ASC, CASE WHEN sub.role = 'user' THEN 0 ELSE 1 END, sub.id ASC
            """,
            conversation_id, exchanges * 2,
        )
    return [{"role": r["role"], "content": r["content"]} for r in rows]


# ── 요약 저장 / 검색 ───────────────────────────────────────────────────────────

async def _store_summary(
    conversation_id: int,
    summary: str,
    turn_start: int,
    turn_end: int,
) -> None:
    vec = await embedding_service.embed(summary)
    async with get_conn() as conn:
        await conn.execute(
            """
            INSERT INTO ops_conv_summary
                (conversation_id, summary, embedding, turn_start, turn_end)
            VALUES ($1, $2, $3::vector, $4, $5)
            """,
            conversation_id, summary, str(vec), turn_start, turn_end,
        )


async def retrieve_relevant_summaries(
    conversation_id: int,
    query_vec: list[float],
    limit: int = MAX_RECALL,
    threshold: float = RECALL_THRESHOLD,
) -> list[str]:
    """현재 질문과 의미적으로 유사한 과거 요약을 반환 (유사도 threshold 이상)."""
    async with get_conn() as conn:
        rows = await conn.fetch(
            """
            SELECT summary,
                   1 - (embedding <=> $2::vector) AS similarity
            FROM ops_conv_summary
            WHERE conversation_id = $1
              AND embedding IS NOT NULL
              AND 1 - (embedding <=> $2::vector) >= $3
            ORDER BY embedding <=> $2::vector
            LIMIT $4
            """,
            conversation_id, str(query_vec), threshold, limit,
        )
    return [r["summary"] for r in rows]


# ── 요약 트리거 ────────────────────────────────────────────────────────────────

async def maybe_summarize(
    conversation_id: int,
    llm_provider,
) -> None:
    """
    총 교환 수가 SUMMARY_TRIGGER 배수에 도달하면 오래된 교환을 요약하여 저장.
    최근 RECENT_EXCHANGES회는 요약 대상에서 제외 (working memory 보호).
    """
    async with get_conn() as conn:
        # 전체 user 메시지 수 (= 교환 횟수)
        total_pairs = await conn.fetchval(
            "SELECT COUNT(*) FROM ops_message WHERE conversation_id=$1 AND role='user'",
            conversation_id,
        )

        # 이미 요약된 마지막 message.id
        last_summarized_end = await conn.fetchval(
            "SELECT COALESCE(MAX(turn_end), 0) FROM ops_conv_summary WHERE conversation_id=$1",
            conversation_id,
        )

        # 요약 대상: 전체에서 최근 RECENT_EXCHANGES회를 제외한 범위의 미요약 교환
        # 최근 RECENT_EXCHANGES*2 개의 message id를 제외
        recent_cutoff_row = await conn.fetchrow(
            """
            SELECT id FROM ops_message
            WHERE conversation_id = $1
            ORDER BY created_at DESC
            OFFSET $2 LIMIT 1
            """,
            conversation_id, RECENT_EXCHANGES * 2,
        )
        if not recent_cutoff_row:
            return  # 메시지가 충분하지 않음

        recent_cutoff_id = recent_cutoff_row["id"]

        # 요약 대상 user 메시지 (last_summarized_end 이후 ~ recent_cutoff_id 이하)
        unsummarized = await conn.fetch(
            """
            SELECT m.id, m.role, m.content
            FROM ops_message m
            WHERE m.conversation_id = $1
              AND m.id > $2
              AND m.id <= $3
            ORDER BY m.created_at ASC, CASE WHEN m.role = 'user' THEN 0 ELSE 1 END, m.id ASC
            """,
            conversation_id, last_summarized_end, recent_cutoff_id,
        )

    if not unsummarized:
        return

    # user 메시지 수 기준으로 trigger 판정
    user_count = sum(1 for r in unsummarized if r["role"] == "user")
    if user_count < SUMMARY_TRIGGER:
        return

    # SUMMARY_TRIGGER 단위로 잘라서 요약
    pairs: list[tuple] = []
    current_pair: list = []
    for row in unsummarized:
        current_pair.append(row)
        if row["role"] == "assistant":
            pairs.append(tuple(current_pair))
            current_pair = []

    # 완성된 pair만 처리
    chunks = [pairs[i:i + SUMMARY_TRIGGER] for i in range(0, len(pairs), SUMMARY_TRIGGER)]
    for chunk in chunks:
        if len(chunk) < SUMMARY_TRIGGER:
            break  # 미완성 chunk는 다음 기회에
        messages = [m for pair in chunk for m in pair]
        turn_start = messages[0]["id"]
        turn_end = messages[-1]["id"]
        summary = await _summarize_with_llm(messages, llm_provider)
        if summary:
            await _store_summary(conversation_id, summary, turn_start, turn_end)
            logger.info(
                "대화 요약 저장: conv=%d, msg %d~%d", conversation_id, turn_start, turn_end
            )


async def _summarize_with_llm(messages: list, llm_provider) -> Optional[str]:
    """메시지 목록을 LLM으로 요약. 실패 시 None 반환."""
    dialogue = "\n".join(
        f"{'사용자' if r['role'] == 'user' else '어시스턴트'}: {r['content']}"
        for r in messages
    )
    prompt = (
        "다음은 IT 운영 지원 챗봇과의 대화 기록입니다. "
        "핵심 질문, 파악된 원인, 제시된 해결책, 주요 기술 사실을 "
        "3~5문장으로 간결하게 요약해 주세요.\n\n"
        f"[대화 기록]\n{dialogue}\n\n요약:"
    )
    try:
        summary = await llm_provider.generate(context="", question=prompt)
        return summary.strip() or None
    except Exception as e:
        logger.warning("요약 생성 실패: %s", e)
        return None


# ── 컨텍스트 히스토리 빌드 (chat.py에서 호출) ────────────────────────────────

async def build_context_history(
    conversation_id: int,
    query_vec: list[float],
) -> list[dict]:
    """
    LLM에 전달할 대화 히스토리 구성:
      1. 의미적으로 관련된 과거 요약 (system 메시지)
      2. 최근 RECENT_EXCHANGES회 raw 교환
    """
    summaries = await retrieve_relevant_summaries(conversation_id, query_vec)
    recent = await load_recent_history(conversation_id)

    history: list[dict] = []
    if summaries:
        summary_block = "\n\n".join(
            f"[과거 맥락 {i + 1}]\n{s}" for i, s in enumerate(summaries)
        )
        history.append({
            "role": "system",
            "content": f"이 대화의 관련 과거 맥락입니다:\n\n{summary_block}",
        })
    history.extend(recent)
    return history
