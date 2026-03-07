"""
GET    /api/fewshots            — few-shot 목록 조회 (namespace 필터)
POST   /api/fewshots            — few-shot 수동 등록 (임베딩 자동 생성)
POST   /api/fewshots/search     — 자연어 질의 시 검색될 few-shot 미리보기
PUT    /api/fewshots/{id}       — few-shot 수정 (질문 변경 시 재임베딩)
DELETE /api/fewshots/{id}       — few-shot 삭제
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import get_conn
from models.api_models import FewshotCreate, FewshotOut, FewshotUpdate, FewshotResult
from services.embedding import embedding_service
from services import retrieval


class FewshotSearchRequest(BaseModel):
    namespace: str
    question: str


class FewshotSearchResponse(BaseModel):
    question: str
    namespace: str
    fewshots: list[FewshotResult]
    prompt_section: str  # 실제 LLM 프롬프트에 삽입되는 텍스트

router = APIRouter(prefix="/api/fewshots", tags=["fewshots"])


@router.get("", response_model=list[FewshotOut])
async def list_fewshots(namespace: str):
    async with get_conn() as conn:
        rows = await conn.fetch(
            """
            SELECT id, namespace, question, answer, knowledge_id, created_at::text
            FROM ops_fewshot
            WHERE namespace = $1
            ORDER BY created_at DESC
            """,
            namespace,
        )
    return [dict(r) for r in rows]


@router.post("/search", response_model=FewshotSearchResponse)
async def search_fewshots(body: FewshotSearchRequest):
    """자연어 질의로 검색될 few-shot 미리보기 (유사도 0.6 이상, 최대 2개)."""
    query_vec = await embedding_service.embed(body.question)
    fewshots = await retrieval.fetch_fewshots(body.namespace, query_vec, limit=2)
    prompt_section = retrieval.build_fewshot_section(fewshots)
    return FewshotSearchResponse(
        question=body.question,
        namespace=body.namespace,
        fewshots=[
            FewshotResult(
                question=fs["question"],
                answer=fs["answer"],
                similarity=fs["similarity"],
            )
            for fs in fewshots
        ],
        prompt_section=prompt_section or "(검색된 few-shot 없음 — 유사도 0.6 미만)",
    )


@router.post("", response_model=FewshotOut, status_code=201)
async def create_fewshot(body: FewshotCreate):
    embedding = await embedding_service.embed(body.question)
    async with get_conn() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO ops_fewshot (namespace, question, answer, knowledge_id, embedding)
            VALUES ($1, $2, $3, $4, $5::vector)
            RETURNING id, namespace, question, answer, knowledge_id, created_at::text
            """,
            body.namespace,
            body.question,
            body.answer,
            body.knowledge_id,
            str(embedding),
        )
    return dict(row)


@router.put("/{fewshot_id}", response_model=FewshotOut)
async def update_fewshot(fewshot_id: int, body: FewshotUpdate):
    async with get_conn() as conn:
        existing = await conn.fetchrow(
            "SELECT * FROM ops_fewshot WHERE id = $1", fewshot_id
        )
        if not existing:
            raise HTTPException(status_code=404, detail="Few-shot not found")

        new_question = body.question if body.question is not None else existing["question"]
        new_answer = body.answer if body.answer is not None else existing["answer"]

        # 질문이 바뀌면 재임베딩
        if body.question is not None and body.question != existing["question"]:
            embedding = await embedding_service.embed(new_question)
            row = await conn.fetchrow(
                """
                UPDATE ops_fewshot
                SET question = $2, answer = $3, embedding = $4::vector
                WHERE id = $1
                RETURNING id, namespace, question, answer, knowledge_id, created_at::text
                """,
                fewshot_id,
                new_question,
                new_answer,
                str(embedding),
            )
        else:
            row = await conn.fetchrow(
                """
                UPDATE ops_fewshot
                SET question = $2, answer = $3
                WHERE id = $1
                RETURNING id, namespace, question, answer, knowledge_id, created_at::text
                """,
                fewshot_id,
                new_question,
                new_answer,
            )
    return dict(row)


@router.delete("/{fewshot_id}", status_code=204)
async def delete_fewshot(fewshot_id: int):
    async with get_conn() as conn:
        result = await conn.execute(
            "DELETE FROM ops_fewshot WHERE id = $1", fewshot_id
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Few-shot not found")
