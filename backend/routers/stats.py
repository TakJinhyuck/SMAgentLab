"""
GET /api/stats  — 통계 대시보드용 데이터
"""
from fastapi import APIRouter, HTTPException

from database import get_conn
from models.api_models import NamespaceStats, StatsResponse, TermStat, NamespaceDetailStats

router = APIRouter(prefix="/api/stats", tags=["stats"])


@router.get("", response_model=StatsResponse)
async def get_stats():
    async with get_conn() as conn:
        # 전체 네임스페이스 + 질의/피드백/지식 통계 통합 조회
        ns_rows = await conn.fetch(
            """
            WITH all_ns AS (
                SELECT DISTINCT name AS namespace FROM ops_namespace
                UNION SELECT DISTINCT namespace FROM ops_knowledge
                UNION SELECT DISTINCT namespace FROM ops_glossary
            ),
            q_agg AS (
                SELECT namespace,
                    COUNT(*)                                AS total_queries,
                    COUNT(*) FILTER (WHERE resolved = TRUE) AS resolved,
                    COUNT(*) FILTER (WHERE resolved = FALSE) AS unresolved
                FROM ops_query_log GROUP BY namespace
            ),
            fb_agg AS (
                SELECT namespace,
                    COUNT(*) FILTER (WHERE is_positive = TRUE)  AS positive_feedback,
                    COUNT(*) FILTER (WHERE is_positive = FALSE) AS negative_feedback
                FROM ops_feedback GROUP BY namespace
            ),
            k_agg AS (
                SELECT namespace, COUNT(*) AS knowledge_count
                FROM ops_knowledge GROUP BY namespace
            ),
            g_agg AS (
                SELECT namespace, COUNT(*) AS glossary_count
                FROM ops_glossary GROUP BY namespace
            )
            SELECT
                n.namespace,
                COALESCE(q.total_queries, 0)     AS total_queries,
                COALESCE(q.resolved, 0)           AS resolved,
                COALESCE(q.unresolved, 0)         AS unresolved,
                COALESCE(f.positive_feedback, 0)  AS positive_feedback,
                COALESCE(f.negative_feedback, 0)  AS negative_feedback,
                COALESCE(k.knowledge_count, 0)    AS knowledge_count,
                COALESCE(g.glossary_count, 0)     AS glossary_count
            FROM all_ns n
            LEFT JOIN q_agg  q ON n.namespace = q.namespace
            LEFT JOIN fb_agg f ON n.namespace = f.namespace
            LEFT JOIN k_agg  k ON n.namespace = k.namespace
            LEFT JOIN g_agg  g ON n.namespace = g.namespace
            ORDER BY total_queries DESC, n.namespace
            """
        )

        # 미해결 케이스 (최근 20건)
        unresolved_rows = await conn.fetch(
            """
            SELECT namespace, question, created_at::text
            FROM ops_query_log
            WHERE resolved = FALSE
            ORDER BY created_at DESC
            LIMIT 20
            """
        )

    namespaces = [
        NamespaceStats(
            namespace=r["namespace"],
            total_queries=r["total_queries"],
            resolved=r["resolved"],
            unresolved=r["unresolved"],
            positive_feedback=r["positive_feedback"],
            negative_feedback=r["negative_feedback"],
            knowledge_count=r["knowledge_count"],
            glossary_count=r["glossary_count"],
        )
        for r in ns_rows
    ]

    unresolved_cases = [
        {"namespace": r["namespace"], "question": r["question"], "created_at": r["created_at"]}
        for r in unresolved_rows
    ]

    return StatsResponse(namespaces=namespaces, unresolved_cases=unresolved_cases)


@router.get("/namespace/{name}", response_model=NamespaceDetailStats)
async def get_namespace_stats(name: str):
    """네임스페이스별 업무 유형 분포 + 미해결 케이스."""
    async with get_conn() as conn:
        summary = await conn.fetchrow(
            """
            SELECT
                COUNT(*)                                AS total_queries,
                COUNT(*) FILTER (WHERE resolved = TRUE) AS resolved,
                COUNT(*) FILTER (WHERE resolved = FALSE) AS unresolved
            FROM ops_query_log WHERE namespace = $1
            """,
            name,
        )

        term_rows = await conn.fetch(
            """
            SELECT
                COALESCE(mapped_term, '(미분류)') AS term,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE resolved = FALSE) AS unresolved
            FROM ops_query_log
            WHERE namespace = $1
            GROUP BY mapped_term
            ORDER BY total DESC
            LIMIT 20
            """,
            name,
        )

        unresolved_rows = await conn.fetch(
            """
            SELECT id, question, mapped_term, created_at::text
            FROM ops_query_log
            WHERE namespace = $1 AND resolved = FALSE
            ORDER BY created_at DESC
            LIMIT 30
            """,
            name,
        )

    return NamespaceDetailStats(
        namespace=name,
        total_queries=summary["total_queries"] or 0,
        resolved=summary["resolved"] or 0,
        unresolved=summary["unresolved"] or 0,
        term_distribution=[
            TermStat(term=r["term"], total=r["total"], unresolved=r["unresolved"])
            for r in term_rows
        ],
        unresolved_cases=[
            {
                "id": r["id"],
                "question": r["question"],
                "mapped_term": r["mapped_term"],
                "created_at": r["created_at"],
            }
            for r in unresolved_rows
        ],
    )


@router.delete("/query-log/{log_id}", status_code=204)
async def delete_query_log(log_id: int):
    """미해결 질문 로그 삭제 (지식 등록 후 처리)."""
    async with get_conn() as conn:
        result = await conn.execute("DELETE FROM ops_query_log WHERE id = $1", log_id)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Query log not found")
