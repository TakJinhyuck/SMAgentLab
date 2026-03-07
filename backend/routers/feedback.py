"""POST /api/feedback — 좋아요/싫어요 피드백 처리."""
from fastapi import APIRouter

from database import get_conn
from models.api_models import FeedbackCreate
from services.embedding import embedding_service

router = APIRouter(prefix="/api/feedback", tags=["feedback"])

_UPDATE_QUERY_LOG_STATUS = """
    UPDATE ops_query_log SET status = $3
    WHERE namespace = $1 AND question = $2
      AND id = (
          SELECT id FROM ops_query_log
          WHERE namespace = $1 AND question = $2
          ORDER BY created_at DESC LIMIT 1
      )
"""


@router.post("", status_code=201)
async def submit_feedback(body: FeedbackCreate):
    async with get_conn() as conn:
        await conn.execute(
            "INSERT INTO ops_feedback (knowledge_id, namespace, question, is_positive, message_id) VALUES ($1,$2,$3,$4,$5)",
            body.knowledge_id, body.namespace, body.question, body.is_positive, body.message_id,
        )

        if body.knowledge_id:
            weight_delta = 0.1 if body.is_positive else -0.1
            clamp_fn = "LEAST" if body.is_positive else "GREATEST"
            bound = 5.0 if body.is_positive else 0.0
            await conn.execute(
                f"UPDATE ops_knowledge SET base_weight = {clamp_fn}(base_weight + $1, $2) WHERE id = $3",
                weight_delta, bound, body.knowledge_id,
            )

        new_status = "resolved" if body.is_positive else "unresolved"
        await conn.execute(_UPDATE_QUERY_LOG_STATUS, body.namespace, body.question, new_status)

        if body.is_positive and body.answer:
            embedding = await embedding_service.embed(body.question)
            await conn.execute(
                """
                INSERT INTO ops_fewshot (namespace, question, answer, knowledge_id, embedding)
                VALUES ($1, $2, $3, $4, $5::vector)
                """,
                body.namespace, body.question, body.answer, body.knowledge_id, str(embedding),
            )

    return {"status": "ok"}
