"""Re-Ranking — Cross-Encoder 기반 검색 결과 재정렬.

RERANKER_MODEL이 설정되지 않으면 비활성화 (원본 결과 반환).
모델 로드 실패 시에도 graceful degradation.

권장 모델:
  - cross-encoder/ms-marco-MiniLM-L-6-v2  (영문 최적화, ~80MB)
  - cross-encoder/mmarco-mMiniLMv2-L12-H384-v1  (다국어, ~120MB)
"""
from __future__ import annotations

import asyncio
import logging
from functools import partial

from core.config import settings

logger = logging.getLogger(__name__)

_model = None
_model_loaded = False  # 로드 시도 여부 (실패해도 재시도 방지)


def _load_model():
    global _model, _model_loaded
    if _model_loaded:
        return _model
    _model_loaded = True
    if not settings.reranker_model:
        return None
    try:
        from sentence_transformers import CrossEncoder
        logger.info("[Reranker] Loading model: %s", settings.reranker_model)
        _model = CrossEncoder(settings.reranker_model)
        logger.info("[Reranker] Model loaded.")
    except Exception as e:
        logger.warning("[Reranker] 모델 로드 실패 (비활성화): %s", e)
        _model = None
    return _model


async def rerank(query: str, results: list, top_k: int) -> list:
    """Cross-encoder로 results 재정렬 후 top_k 반환.

    모델 미설정/로드 실패 시 원본 results[:top_k] 반환.
    """
    model = _load_model()
    if model is None or len(results) <= top_k:
        return results[:top_k]

    pairs = [(query, r.content[:512]) for r in results]
    try:
        scores = await asyncio.get_running_loop().run_in_executor(
            None, partial(model.predict, pairs)
        )
        ranked = sorted(zip(scores, results), key=lambda x: float(x[0]), reverse=True)
        top = [r for _, r in ranked[:top_k]]
        logger.info(
            "[Reranker] %d → %d | top scores: %s",
            len(results), top_k,
            [f"{s:.3f}" for s, _ in ranked[:3]],
        )
        return top
    except Exception as e:
        logger.warning("[Reranker] 재정렬 실패 (원본 반환): %s", e)
        return results[:top_k]
