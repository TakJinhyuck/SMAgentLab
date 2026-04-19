"""VOC 에이전트 전용 하이브리드 검색 파이프라인.

voc_case  — 과거 장애·VOC 이력
voc_manual — 운영 매뉴얼·런북
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from core.database import get_conn, resolve_namespace_id

MIN_SCORE = 0.30
HIGH_SCORE = 0.70
MID_SCORE = 0.50

SEVERITY_LABEL: dict[str, str] = {
    "critical": "🔴 긴급",
    "high":     "🟠 높음",
    "medium":   "🟡 보통",
    "low":      "🟢 낮음",
}


@dataclass
class VocCaseResult:
    id: int
    title: str
    category: Optional[str]
    severity: str
    status: str
    content: str
    resolution: Optional[str]
    root_cause: Optional[str]
    affected_system: Optional[str]
    tags: list[str]
    final_score: float
    v_score: float = field(default=0.0)
    k_score: float = field(default=0.0)


@dataclass
class VocManualResult:
    id: int
    title: str
    category: Optional[str]
    step_order: int
    content: str
    final_score: float
    v_score: float = field(default=0.0)
    k_score: float = field(default=0.0)


async def search_voc_cases(
    namespace: str,
    query_vec: list[float],
    enriched_query: str,
    w_vector: float = 0.6,
    w_keyword: float = 0.4,
    top_k: int = 5,
    category: Optional[str] = None,
    severity: Optional[str] = None,
) -> list[VocCaseResult]:
    """voc_case 테이블 대상 하이브리드 검색 (벡터 + FTS)."""
    async with get_conn() as conn:
        ns_id = await resolve_namespace_id(conn, namespace)
        if ns_id is None:
            return []

        extra_filters = ""
        params: list = [str(query_vec), ns_id, enriched_query, w_vector, w_keyword, top_k]

        if category:
            extra_filters += f" AND c.category = ${len(params) + 1}"
            params.append(category)
        if severity:
            extra_filters += f" AND c.severity = ${len(params) + 1}"
            params.append(severity)

        rows = await conn.fetch(
            f"""
            WITH fts_query AS (
                SELECT to_tsquery('simple', string_agg(lexeme, ' | ')) AS tsq
                FROM (
                    SELECT DISTINCT lexeme
                    FROM unnest(to_tsvector('simple', $3)) t
                    WHERE lexeme IS NOT NULL
                ) t
            ),
            vector_scores AS (
                SELECT id, 1 - (embedding <=> $1::vector) AS v_score
                FROM voc_case
                WHERE namespace_id = $2 AND embedding IS NOT NULL
            ),
            keyword_scores AS (
                SELECT c.id,
                    ts_rank(
                        to_tsvector('simple',
                            c.title || ' ' || c.content || ' ' ||
                            COALESCE(c.resolution, '') || ' ' ||
                            COALESCE(c.root_cause, '')),
                        fq.tsq
                    ) AS k_score
                FROM voc_case c, fts_query fq
                WHERE c.namespace_id = $2
                  AND to_tsvector('simple',
                        c.title || ' ' || c.content || ' ' ||
                        COALESCE(c.resolution, '') || ' ' ||
                        COALESCE(c.root_cause, ''))
                      @@ fq.tsq
            )
            SELECT c.id, c.title, c.category, c.severity, c.status,
                   c.content, c.resolution, c.root_cause, c.affected_system, c.tags,
                   c.base_weight,
                   COALESCE(vs.v_score, 0.0) AS v_score,
                   COALESCE(ks.k_score, 0.0) AS k_score,
                   ($4 * COALESCE(vs.v_score, 0.0) + $5 * COALESCE(ks.k_score, 0.0))
                     * (1.0 + c.base_weight) AS final_score
            FROM voc_case c
            LEFT JOIN vector_scores  vs ON c.id = vs.id
            LEFT JOIN keyword_scores ks ON c.id = ks.id
            WHERE c.namespace_id = $2
              AND (vs.v_score IS NOT NULL OR ks.k_score IS NOT NULL)
              {extra_filters}
            ORDER BY final_score DESC
            LIMIT $6
            """,
            *params,
        )

    return [
        VocCaseResult(
            id=r["id"],
            title=r["title"],
            category=r["category"],
            severity=r["severity"] or "medium",
            status=r["status"] or "resolved",
            content=r["content"],
            resolution=r["resolution"],
            root_cause=r["root_cause"],
            affected_system=r["affected_system"],
            tags=list(r["tags"]) if r["tags"] else [],
            v_score=float(r["v_score"]),
            k_score=float(r["k_score"]),
            final_score=float(r["final_score"]),
        )
        for r in rows
    ]


async def search_voc_manuals(
    namespace: str,
    query_vec: list[float],
    enriched_query: str,
    w_vector: float = 0.6,
    w_keyword: float = 0.4,
    top_k: int = 3,
    category: Optional[str] = None,
) -> list[VocManualResult]:
    """voc_manual 테이블 대상 하이브리드 검색 — step_order 순 정렬."""
    async with get_conn() as conn:
        ns_id = await resolve_namespace_id(conn, namespace)
        if ns_id is None:
            return []

        cat_filter = ""
        params: list = [str(query_vec), ns_id, enriched_query, w_vector, w_keyword, top_k]
        if category:
            cat_filter = f" AND m.category = ${len(params) + 1}"
            params.append(category)

        rows = await conn.fetch(
            f"""
            WITH fts_query AS (
                SELECT to_tsquery('simple', string_agg(lexeme, ' | ')) AS tsq
                FROM (
                    SELECT DISTINCT lexeme
                    FROM unnest(to_tsvector('simple', $3)) t
                    WHERE lexeme IS NOT NULL
                ) t
            ),
            vector_scores AS (
                SELECT id, 1 - (embedding <=> $1::vector) AS v_score
                FROM voc_manual
                WHERE namespace_id = $2 AND embedding IS NOT NULL
            ),
            keyword_scores AS (
                SELECT m.id,
                    ts_rank(
                        to_tsvector('simple', m.title || ' ' || m.content),
                        fq.tsq
                    ) AS k_score
                FROM voc_manual m, fts_query fq
                WHERE m.namespace_id = $2
                  AND to_tsvector('simple', m.title || ' ' || m.content) @@ fq.tsq
            )
            SELECT m.id, m.title, m.category, m.step_order, m.content,
                   m.base_weight,
                   COALESCE(vs.v_score, 0.0) AS v_score,
                   COALESCE(ks.k_score, 0.0) AS k_score,
                   ($4 * COALESCE(vs.v_score, 0.0) + $5 * COALESCE(ks.k_score, 0.0))
                     * (1.0 + m.base_weight) AS final_score
            FROM voc_manual m
            LEFT JOIN vector_scores  vs ON m.id = vs.id
            LEFT JOIN keyword_scores ks ON m.id = ks.id
            WHERE m.namespace_id = $2
              AND (vs.v_score IS NOT NULL OR ks.k_score IS NOT NULL)
              {cat_filter}
            ORDER BY m.step_order ASC, final_score DESC
            LIMIT $6
            """,
            *params,
        )

    return [
        VocManualResult(
            id=r["id"],
            title=r["title"],
            category=r["category"],
            step_order=r["step_order"] or 0,
            content=r["content"],
            v_score=float(r["v_score"]),
            k_score=float(r["k_score"]),
            final_score=float(r["final_score"]),
        )
        for r in rows
    ]


def build_case_context(cases: list[VocCaseResult]) -> str:
    """검색된 VOC 사례를 LLM 프롬프트용 텍스트로 조립."""
    relevant = [c for c in cases if c.final_score >= MIN_SCORE]
    if not relevant:
        return ""

    parts: list[str] = []
    for i, c in enumerate(relevant, 1):
        confidence = (
            "높음" if c.final_score >= HIGH_SCORE
            else "보통" if c.final_score >= MID_SCORE
            else "낮음"
        )
        sev = SEVERITY_LABEL.get(c.severity, c.severity)
        lines = [
            f"--- [VOC 사례 {i}] {c.title}  (점수: {c.final_score:.4f} | 신뢰도: {confidence}) ---",
            f"심각도: {sev}  |  상태: {c.status}",
        ]
        if c.affected_system:
            lines.append(f"영향 시스템: {c.affected_system}")
        if c.category:
            lines.append(f"분류: {c.category}")
        lines.append(f"증상:\n{c.content}")
        if c.root_cause:
            lines.append(f"근본 원인:\n{c.root_cause}")
        if c.resolution:
            lines.append(f"해결 방법:\n{c.resolution}")
        if c.tags:
            lines.append(f"태그: {', '.join(c.tags)}")
        parts.append("\n".join(lines))

    return "\n\n".join(parts)


def build_manual_context(manuals: list[VocManualResult]) -> str:
    """검색된 운영 매뉴얼을 LLM 프롬프트용 텍스트로 조립."""
    relevant = [m for m in manuals if m.final_score >= MIN_SCORE]
    if not relevant:
        return ""

    parts: list[str] = []
    for i, m in enumerate(relevant, 1):
        lines = [
            f"--- [운영 매뉴얼 {i}] {m.title}  (점수: {m.final_score:.4f}) ---",
        ]
        if m.category:
            lines.append(f"카테고리: {m.category}")
        lines.append(f"내용:\n{m.content}")
        parts.append("\n".join(lines))

    return "\n\n".join(parts)
