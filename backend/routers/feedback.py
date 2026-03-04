"""
POST /api/feedback  — 좋아요/싫어요 기록

👍 긍정 피드백 효과:
  1. ops_feedback 로그 저장
  2. 해당 지식 문서의 base_weight +0.1 (최대 5.0) → 검색 랭킹 상승
  3. Q&A 쌍을 ops_fewshot에 저장 → 이후 유사 질문 시 LLM 프롬프트에 few-shot으로 삽입

👎 부정 피드백 효과:
  1. ops_feedback 로그 저장
  2. 해당 지식 문서의 base_weight -0.1 (최소 0.0) → 검색 랭킹 하락
  3. 해당 질의 로그를 미해결(resolved=FALSE)로 표시 → 통계 대시보드 미해결 케이스
"""
from fastapi import APIRouter

from database import get_conn
from models.api_models import FeedbackCreate
from services.embedding import embedding_service

router = APIRouter(prefix="/api/feedback", tags=["feedback"])


@router.post("", status_code=201)
async def submit_feedback(body: FeedbackCreate):
    async with get_conn() as conn:
        # 1. 피드백 로그 저장
        await conn.execute(
            """
            INSERT INTO ops_feedback (knowledge_id, namespace, question, is_positive)
            VALUES ($1, $2, $3, $4)
            """,
            body.knowledge_id,
            body.namespace,
            body.question,
            body.is_positive,
        )

        if body.is_positive:
            if body.knowledge_id:
                # 2. 긍정: base_weight 상승 (+0.1, 최대 5.0)
                await conn.execute(
                    """
                    UPDATE ops_knowledge
                    SET base_weight = LEAST(base_weight + 0.1, 5.0)
                    WHERE id = $1
                    """,
                    body.knowledge_id,
                )

            # 3. 긍정: Q&A 쌍을 few-shot 테이블에 저장 (answer가 있을 때만)
            if body.answer:
                embedding = await embedding_service.embed(body.question)
                await conn.execute(
                    """
                    INSERT INTO ops_fewshot
                        (namespace, question, answer, knowledge_id, embedding)
                    VALUES ($1, $2, $3, $4, $5::vector)
                    """,
                    body.namespace,
                    body.question,
                    body.answer,
                    body.knowledge_id,
                    str(embedding),
                )

        else:
            if body.knowledge_id:
                # 4. 부정: base_weight 하락 (-0.1, 최소 0.0)
                await conn.execute(
                    """
                    UPDATE ops_knowledge
                    SET base_weight = GREATEST(base_weight - 0.1, 0.0)
                    WHERE id = $1
                    """,
                    body.knowledge_id,
                )

            # 5. 부정: 해당 질의 로그를 미해결로 표시
            await conn.execute(
                """
                UPDATE ops_query_log
                SET resolved = FALSE
                WHERE namespace = $1
                  AND question = $2
                  AND id = (
                      SELECT id FROM ops_query_log
                      WHERE namespace = $1 AND question = $2
                      ORDER BY created_at DESC
                      LIMIT 1
                  )
                """,
                body.namespace,
                body.question,
            )

    return {"status": "ok"}
