"""
/api/conversations  — 대화방 CRUD + 메시지 조회
"""
import json
import logging

from fastapi import APIRouter, HTTPException, Query

from database import get_conn
from models.api_models import ConversationCreate, ConversationResponse, MessageResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/conversations", tags=["conversations"])

MAX_MESSAGES_PER_NS = 100
QUERY_LOG_RETENTION_DAYS = 90


@router.get("", response_model=list[ConversationResponse])
async def list_conversations(namespace: str = Query(...)):
    async with get_conn() as conn:
        rows = await conn.fetch(
            """
            SELECT id, namespace, title, trimmed, created_at::text
            FROM ops_conversation
            WHERE namespace = $1
            ORDER BY created_at DESC
            LIMIT 50
            """,
            namespace,
        )
    return [ConversationResponse(**dict(r)) for r in rows]


@router.post("", response_model=ConversationResponse, status_code=201)
async def create_conversation(body: ConversationCreate):
    async with get_conn() as conn:
        row = await conn.fetchrow(
            "INSERT INTO ops_conversation (namespace, title) VALUES ($1, $2) RETURNING id, namespace, title, trimmed, created_at::text",
            body.namespace, body.title[:200] if body.title else "",
        )
    return ConversationResponse(**dict(row))


@router.get("/{conv_id}/messages", response_model=list[MessageResponse])
async def get_messages(conv_id: int):
    async with get_conn() as conn:
        exists = await conn.fetchval("SELECT 1 FROM ops_conversation WHERE id = $1", conv_id)
        if not exists:
            raise HTTPException(status_code=404, detail="Conversation not found")
        rows = await conn.fetch(
            """
            SELECT
                m.id, m.conversation_id, m.role, m.content,
                m.mapped_term, m.results, m.status, m.created_at::text,
                EXISTS(
                    SELECT 1 FROM ops_feedback f WHERE f.message_id = m.id
                ) AS has_feedback
            FROM ops_message m
            WHERE m.conversation_id = $1
            ORDER BY m.id ASC
            """,
            conv_id,
        )
    return [
        MessageResponse(
            id=r["id"],
            conversation_id=r["conversation_id"],
            role=r["role"],
            content=r["content"],
            mapped_term=r["mapped_term"],
            results=json.loads(r["results"]) if isinstance(r["results"], str) else r["results"],
            status=r["status"],
            has_feedback=r["has_feedback"],
            created_at=r["created_at"],
        )
        for r in rows
    ]


@router.delete("/{conv_id}", status_code=204)
async def delete_conversation(conv_id: int):
    async with get_conn() as conn:
        result = await conn.execute("DELETE FROM ops_conversation WHERE id = $1", conv_id)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Conversation not found")


# ── Cleanup 함수 (chat.py 등에서 호출) ──────────────────────────────────────

async def cleanup_old_messages(namespace: str) -> int:
    """네임스페이스 내 총 메시지가 MAX_MESSAGES_PER_NS를 초과하면 오래된 메시지부터 삭제.

    대화방 자체는 유지하고 메시지만 트리밍한다.
    trimmed 플래그를 설정하여 프론트엔드에서 '이전 대화 삭제됨' 안내를 표시할 수 있다.

    Returns: 삭제된 메시지 수
    """
    async with get_conn() as conn:
        total = await conn.fetchval(
            """
            SELECT COUNT(*) FROM ops_message m
            JOIN ops_conversation c ON m.conversation_id = c.id
            WHERE c.namespace = $1
            """,
            namespace,
        )
        if total <= MAX_MESSAGES_PER_NS:
            return 0

        excess = total - MAX_MESSAGES_PER_NS

        # 삭제 대상 메시지의 대화방 ID 먼저 수집
        affected_conv_ids = await conn.fetch(
            """
            SELECT DISTINCT m.conversation_id FROM ops_message m
            JOIN ops_conversation c ON m.conversation_id = c.id
            WHERE c.namespace = $1
            ORDER BY m.conversation_id
            LIMIT $2
            """,
            namespace, excess,
        )
        affected_ids = [r["conversation_id"] for r in affected_conv_ids]

        # 가장 오래된 메시지부터 삭제 (대화방은 유지)
        result = await conn.execute(
            """
            DELETE FROM ops_message
            WHERE id IN (
                SELECT m.id FROM ops_message m
                JOIN ops_conversation c ON m.conversation_id = c.id
                WHERE c.namespace = $1
                ORDER BY m.created_at ASC
                LIMIT $2
            )
            """,
            namespace, excess,
        )
        deleted = int(result.split()[-1]) if result else 0

        if deleted > 0 and affected_ids:
            await conn.execute(
                """
                UPDATE ops_conversation SET trimmed = TRUE
                WHERE id = ANY($1::int[])
                """,
                affected_ids,
            )
            logger.info("cleanup: %s 네임스페이스에서 %d개 메시지 트리밍", namespace, deleted)
        return deleted


async def cleanup_resolved_query_logs() -> int:
    """QUERY_LOG_RETENTION_DAYS일 지난 resolved query_log 삭제."""
    async with get_conn() as conn:
        result = await conn.execute(
            """
            DELETE FROM ops_query_log
            WHERE status = 'resolved'
              AND created_at < NOW() - INTERVAL '1 day' * $1
            """,
            QUERY_LOG_RETENTION_DAYS,
        )
    deleted = int(result.split()[-1]) if result else 0
    if deleted > 0:
        logger.info("cleanup: resolved query_log %d건 삭제 (%d일 경과)", deleted, QUERY_LOG_RETENTION_DAYS)
    return deleted
