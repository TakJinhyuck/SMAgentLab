"""
2단계 하이브리드 검색 파이프라인

Step 1: Semantic Glossary Mapping
  - 질문 벡터 → ops_glossary에서 가장 유사한 표준 용어 추출

Step 2: Weighted Hybrid Search
  - (원본 질문 + 표준 용어) 임베딩 & 키워드 검색
  - 최종 점수: (w_vec * v_score + w_kw * k_score) * (1 + base_weight)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from database import get_conn
from services.embedding import embedding_service


@dataclass
class GlossaryMatch:
    """용어집 매핑 결과 (유사도 포함)."""
    term: str
    description: str
    similarity: float  # 1 - cosine_distance (0~1, 높을수록 유사)


@dataclass
class RetrievalResult:
    id: int
    namespace: str
    container_name: Optional[str]
    target_tables: Optional[list[str]]
    content: str
    query_template: Optional[str]
    base_weight: float
    final_score: float
    v_score: float = field(default=0.0)   # 벡터 유사도 (코사인)
    k_score: float = field(default=0.0)   # 키워드 점수 (ts_rank)


async def map_glossary_term(
    namespace: str, query_vec: list[float]
) -> Optional[GlossaryMatch]:
    """Step 1: 벡터 유사도로 표준 용어 매핑 (유사도 스코어 포함)."""
    async with get_conn() as conn:
        row = await conn.fetchrow(
            """
            SELECT term, description,
                   1 - (embedding <=> $2::vector) AS similarity
            FROM ops_glossary
            WHERE namespace = $1
              AND embedding IS NOT NULL
            ORDER BY embedding <=> $2::vector
            LIMIT 1
            """,
            namespace,
            str(query_vec),
        )
    if row:
        return GlossaryMatch(
            term=row["term"],
            description=row["description"],
            similarity=float(row["similarity"]),
        )
    return None


async def search_knowledge(
    namespace: str,
    query_vec: list[float],
    enriched_query: str,
    w_vector: float = 0.7,
    w_keyword: float = 0.3,
    top_k: int = 5,
) -> list[RetrievalResult]:
    """Step 2: v_score + k_score 포함 하이브리드 검색."""
    async with get_conn() as conn:
        rows = await conn.fetch(
            """
            WITH vector_scores AS (
                SELECT
                    id,
                    1 - (embedding <=> $1::vector) AS v_score
                FROM ops_knowledge
                WHERE namespace = $2
                  AND embedding IS NOT NULL
            ),
            keyword_scores AS (
                SELECT
                    id,
                    ts_rank(
                        to_tsvector('simple', content),
                        plainto_tsquery('simple', $3)
                    ) AS k_score
                FROM ops_knowledge
                WHERE namespace = $2
                  AND to_tsvector('simple', content)
                      @@ plainto_tsquery('simple', $3)
            )
            SELECT
                k.id,
                k.namespace,
                k.container_name,
                k.target_tables,
                k.content,
                k.query_template,
                k.base_weight,
                COALESCE(vs.v_score, 0.0) AS v_score,
                COALESCE(ks.k_score, 0.0) AS k_score,
                (
                    $4 * COALESCE(vs.v_score, 0.0)
                  + $5 * COALESCE(ks.k_score, 0.0)
                ) * (1.0 + k.base_weight) AS final_score
            FROM ops_knowledge k
            LEFT JOIN vector_scores vs ON k.id = vs.id
            LEFT JOIN keyword_scores ks ON k.id = ks.id
            WHERE k.namespace = $2
              AND (vs.v_score IS NOT NULL OR ks.k_score IS NOT NULL)
            ORDER BY final_score DESC
            LIMIT $6
            """,
            str(query_vec),
            namespace,
            enriched_query,
            w_vector,
            w_keyword,
            top_k,
        )

    return [
        RetrievalResult(
            id=r["id"],
            namespace=r["namespace"],
            container_name=r["container_name"],
            target_tables=list(r["target_tables"]) if r["target_tables"] else [],
            content=r["content"],
            query_template=r["query_template"],
            base_weight=r["base_weight"],
            v_score=float(r["v_score"]),
            k_score=float(r["k_score"]),
            final_score=float(r["final_score"]),
        )
        for r in rows
    ]


async def hybrid_search(
    namespace: str,
    question: str,
    w_vector: float = 0.7,
    w_keyword: float = 0.3,
    top_k: int = 5,
) -> tuple[Optional[str], list[RetrievalResult]]:
    """
    2단계 하이브리드 검색 수행.

    Returns:
        (mapped_term, results)
    """
    query_vec = await embedding_service.embed(question)
    glossary_match = await map_glossary_term(namespace, query_vec)
    mapped_term = glossary_match.term if glossary_match else None
    enriched_query = f"{question} {mapped_term}" if mapped_term else question
    results = await search_knowledge(namespace, query_vec, enriched_query, w_vector, w_keyword, top_k)
    return mapped_term, results


async def fetch_fewshots(
    namespace: str, query_vec: list[float], limit: int = 2
) -> list[dict]:
    """긍정 피드백으로 쌓인 Q&A 예시를 벡터 유사도 순으로 반환 (유사도 0.6 이상만)."""
    async with get_conn() as conn:
        rows = await conn.fetch(
            """
            SELECT question, answer,
                   1 - (embedding <=> $2::vector) AS similarity
            FROM ops_fewshot
            WHERE namespace = $1
              AND 1 - (embedding <=> $2::vector) >= 0.6
            ORDER BY embedding <=> $2::vector
            LIMIT $3
            """,
            namespace,
            str(query_vec),
            limit,
        )
    return [{"question": r["question"], "answer": r["answer"]} for r in rows]


def build_fewshot_section(fewshots: list[dict]) -> str:
    """Few-shot Q&A 목록을 프롬프트 삽입용 문자열로 변환."""
    if not fewshots:
        return ""
    examples = "\n\n".join(
        f"Q: {fs['question']}\nA: {fs['answer']}" for fs in fewshots
    )
    return f"[과거 유사 질문 답변 사례 — 참고용]\n{examples}"


def build_context(results: list[RetrievalResult]) -> str:
    """검색 결과를 LLM 프롬프트용 컨텍스트 문자열로 변환."""
    if not results:
        return "관련 문서를 찾지 못했습니다."

    parts = []
    for i, r in enumerate(results, 1):
        part = [f"--- 문서 {i} (점수: {r.final_score:.4f}) ---"]
        if r.container_name:
            part.append(f"컨테이너: {r.container_name}")
        if r.target_tables:
            part.append(f"관련 테이블: {', '.join(r.target_tables)}")
        part.append(f"내용:\n{r.content}")
        if r.query_template:
            part.append(f"SQL:\n{r.query_template}")
        parts.append("\n".join(part))

    return "\n\n".join(parts)
