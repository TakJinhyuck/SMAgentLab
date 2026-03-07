"""통계 대시보드 + 질의 로그 관리 API."""
from typing import Optional
from fastapi import APIRouter, HTTPException, Query as QueryParam

from database import get_conn
from models.api_models import NamespaceStats, StatsResponse, TermStat, NamespaceDetailStats
from services.embedding import embedding_service

router = APIRouter(prefix="/api/stats", tags=["stats"])


async def _insert_feedback_if_message_exists(conn, namespace: str, question: str, message_id: int | None) -> None:
    if not message_id:
        return
    exists = await conn.fetchval("SELECT EXISTS(SELECT 1 FROM ops_message WHERE id = $1)", message_id)
    if exists:
        await conn.execute(
            "INSERT INTO ops_feedback (namespace, question, is_positive, message_id) VALUES ($1, $2, TRUE, $3)",
            namespace, question, message_id,
        )


@router.get("", response_model=StatsResponse)
async def get_stats():
    async with get_conn() as conn:
        ns_rows = await conn.fetch(
            """
            WITH all_ns AS (
                SELECT DISTINCT name AS namespace FROM ops_namespace
                UNION SELECT DISTINCT namespace FROM ops_knowledge
                UNION SELECT DISTINCT namespace FROM ops_glossary
            ),
            q_agg AS (
                SELECT namespace,
                    COUNT(*) AS total_queries,
                    COUNT(*) FILTER (WHERE status = 'resolved')   AS resolved,
                    COUNT(*) FILTER (WHERE status = 'pending')    AS pending,
                    COUNT(*) FILTER (WHERE status = 'unresolved') AS unresolved
                FROM ops_query_log GROUP BY namespace
            ),
            fb_agg AS (
                SELECT namespace,
                    COUNT(*) FILTER (WHERE is_positive)      AS positive_feedback,
                    COUNT(*) FILTER (WHERE NOT is_positive)  AS negative_feedback
                FROM ops_feedback GROUP BY namespace
            ),
            k_agg AS (SELECT namespace, COUNT(*) AS cnt FROM ops_knowledge GROUP BY namespace),
            g_agg AS (SELECT namespace, COUNT(*) AS cnt FROM ops_glossary GROUP BY namespace)
            SELECT n.namespace,
                COALESCE(q.total_queries, 0) AS total_queries,
                COALESCE(q.resolved, 0) AS resolved,
                COALESCE(q.pending, 0) AS pending,
                COALESCE(q.unresolved, 0) AS unresolved,
                COALESCE(f.positive_feedback, 0) AS positive_feedback,
                COALESCE(f.negative_feedback, 0) AS negative_feedback,
                COALESCE(k.cnt, 0) AS knowledge_count,
                COALESCE(g.cnt, 0) AS glossary_count
            FROM all_ns n
            LEFT JOIN q_agg  q ON n.namespace = q.namespace
            LEFT JOIN fb_agg f ON n.namespace = f.namespace
            LEFT JOIN k_agg  k ON n.namespace = k.namespace
            LEFT JOIN g_agg  g ON n.namespace = g.namespace
            ORDER BY total_queries DESC, n.namespace
            """
        )
        unresolved_rows = await conn.fetch(
            """
            SELECT namespace, question, created_at::text
            FROM ops_query_log WHERE status = 'unresolved'
            ORDER BY created_at DESC LIMIT 20
            """
        )

    return StatsResponse(
        namespaces=[NamespaceStats(**dict(r)) for r in ns_rows],
        unresolved_cases=[dict(r) for r in unresolved_rows],
    )


@router.get("/namespace/{name}", response_model=NamespaceDetailStats)
async def get_namespace_stats(name: str):
    async with get_conn() as conn:
        summary = await conn.fetchrow(
            """
            SELECT COUNT(*) AS total_queries,
                COUNT(*) FILTER (WHERE status = 'resolved')   AS resolved,
                COUNT(*) FILTER (WHERE status = 'pending')    AS pending,
                COUNT(*) FILTER (WHERE status = 'unresolved') AS unresolved
            FROM ops_query_log WHERE namespace = $1
            """,
            name,
        )
        term_rows = await conn.fetch(
            """
            SELECT COALESCE(mapped_term, '기타') AS term,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                COUNT(*) FILTER (WHERE status = 'unresolved') AS unresolved
            FROM ops_query_log WHERE namespace = $1
            GROUP BY mapped_term ORDER BY total DESC LIMIT 20
            """,
            name,
        )
        unresolved_rows = await conn.fetch(
            """
            SELECT id, question, mapped_term, created_at::text
            FROM ops_query_log WHERE namespace = $1 AND status = 'unresolved'
            ORDER BY created_at DESC LIMIT 30
            """,
            name,
        )

    return NamespaceDetailStats(
        namespace=name,
        total_queries=summary["total_queries"] or 0,
        resolved=summary["resolved"] or 0,
        pending=summary["pending"] or 0,
        unresolved=summary["unresolved"] or 0,
        term_distribution=[TermStat(**dict(r)) for r in term_rows],
        unresolved_cases=[dict(r) for r in unresolved_rows],
    )


@router.get("/namespace/{name}/queries")
async def get_namespace_queries(
    name: str,
    status: Optional[str] = None,
    limit: int = QueryParam(default=100, le=500),
):
    async with get_conn() as conn:
        if status:
            rows = await conn.fetch(
                "SELECT id, question, answer, mapped_term, status, created_at::text FROM ops_query_log WHERE namespace = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3",
                name, status, limit,
            )
        else:
            rows = await conn.fetch(
                "SELECT id, question, answer, mapped_term, status, created_at::text FROM ops_query_log WHERE namespace = $1 ORDER BY created_at DESC LIMIT $2",
                name, limit,
            )
    return [dict(r) for r in rows]


@router.patch("/query-log/{log_id}/resolve", status_code=200)
async def resolve_query_log(log_id: int):
    async with get_conn() as conn:
        row = await conn.fetchrow(
            "SELECT namespace, question, answer, mapped_term, message_id FROM ops_query_log WHERE id = $1 AND status = 'pending'",
            log_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Query log not found or not pending")
        if not row["answer"]:
            raise HTTPException(status_code=400, detail="답변이 없어 지식으로 등록할 수 없습니다.")

        vec = await embedding_service.embed(row["answer"])
        await conn.execute(
            "INSERT INTO ops_knowledge (namespace, container_name, content, embedding) VALUES ($1, $2, $3, $4::vector)",
            row["namespace"], row["mapped_term"] or "미분류", row["answer"], str(vec),
        )
        await conn.execute("UPDATE ops_query_log SET status = 'resolved' WHERE id = $1", log_id)
        await _insert_feedback_if_message_exists(conn, row["namespace"], row["question"], row["message_id"])
    return {"status": "ok"}


@router.patch("/query-log/{log_id}/mark-resolved", status_code=200)
async def mark_query_log_resolved(log_id: int):
    async with get_conn() as conn:
        row = await conn.fetchrow(
            "SELECT namespace, question, message_id FROM ops_query_log WHERE id = $1", log_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Query log not found")
        await conn.execute("UPDATE ops_query_log SET status = 'resolved' WHERE id = $1", log_id)
        await _insert_feedback_if_message_exists(conn, row["namespace"], row["question"], row["message_id"])
    return {"status": "ok"}


@router.delete("/query-log/{log_id}", status_code=204)
async def delete_query_log(log_id: int):
    async with get_conn() as conn:
        result = await conn.execute("DELETE FROM ops_query_log WHERE id = $1", log_id)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Query log not found")


@router.post("/query-logs/bulk-delete", status_code=200)
async def bulk_delete_query_logs(body: dict):
    ids: list[int] = body.get("ids", [])
    if not ids:
        raise HTTPException(status_code=400, detail="ids is required")
    async with get_conn() as conn:
        result = await conn.execute("DELETE FROM ops_query_log WHERE id = ANY($1::int[])", ids)
    deleted = int(result.split()[-1]) if result else 0
    return {"deleted": deleted}
