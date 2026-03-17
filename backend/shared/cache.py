"""Semantic Cache — Redis 기반 유사 질문 캐싱.

normalize_embeddings=True로 생성된 벡터는 dot product = cosine similarity.
TTL 내 코사인 유사도 > SIMILARITY_THRESHOLD 이면 캐시 히트.
Redis 연결 실패 시 모든 함수가 graceful degradation (캐시 없이 동작).
"""
from __future__ import annotations

import json
import hashlib
import logging

import numpy as np

from core.config import settings

logger = logging.getLogger(__name__)

CACHE_TTL = 1800              # 30분
SIMILARITY_THRESHOLD = 0.97  # cosine similarity
MAX_CANDIDATES = 200          # 비교할 최대 캐시 엔트리 수

_redis_client = None


async def _get_redis():
    global _redis_client
    if _redis_client is None and settings.redis_url:
        try:
            import redis.asyncio as redis
            _redis_client = redis.from_url(settings.redis_url, decode_responses=False)
            await _redis_client.ping()
            logger.info("[Cache] Redis 연결 성공: %s", settings.redis_url)
        except Exception as e:
            logger.warning("[Cache] Redis 연결 실패 (캐시 비활성화): %s", e)
            _redis_client = None
    return _redis_client


def _make_key(namespace: str, vec: list[float]) -> str:
    h = hashlib.md5(str(vec[:8]).encode()).hexdigest()[:12]
    return f"semcache:{namespace}:{h}"


async def get_cached(namespace: str, query_vec: list[float]) -> dict | None:
    """유사 질문 캐시 조회. 없거나 Redis 미연결이면 None 반환."""
    r = await _get_redis()
    if r is None:
        return None
    try:
        pattern = f"semcache:{namespace}:*"
        keys: list[bytes] = []
        async for key in r.scan_iter(pattern, count=100):
            keys.append(key)
            if len(keys) >= MAX_CANDIDATES:
                break
        if not keys:
            return None

        q = np.array(query_vec, dtype=np.float32)
        best_score, best_key = 0.0, None

        for key in keys:
            raw = await r.hget(key, "emb")
            if not raw:
                continue
            cached_vec = np.frombuffer(raw, dtype=np.float32)
            if len(cached_vec) != len(q):
                continue
            score = float(np.dot(q, cached_vec))  # normalize=True → dot = cosine
            if score > best_score:
                best_score, best_key = score, key

        if best_score >= SIMILARITY_THRESHOLD and best_key:
            payload_raw = await r.hget(best_key, "payload")
            if payload_raw:
                logger.info("[Cache HIT] namespace=%s cosine=%.4f", namespace, best_score)
                return json.loads(payload_raw)
    except Exception as e:
        logger.warning("[Cache] 조회 실패 (무시): %s", e)
    return None


async def set_cached(namespace: str, query_vec: list[float], payload: dict) -> None:
    """캐시 저장. Redis 미연결이면 무시."""
    r = await _get_redis()
    if r is None:
        return
    try:
        key = _make_key(namespace, query_vec)
        emb_bytes = np.array(query_vec, dtype=np.float32).tobytes()
        await r.hset(key, mapping={
            "emb": emb_bytes,
            "payload": json.dumps(payload, ensure_ascii=False),
        })
        await r.expire(key, CACHE_TTL)
        logger.info("[Cache SET] namespace=%s key=%s", namespace, key)
    except Exception as e:
        logger.warning("[Cache] 저장 실패 (무시): %s", e)


async def invalidate_namespace(namespace: str) -> int:
    """namespace 캐시 전체 무효화. 지식베이스 업데이트 시 호출."""
    r = await _get_redis()
    if r is None:
        return 0
    try:
        count = 0
        async for key in r.scan_iter(f"semcache:{namespace}:*"):
            await r.delete(key)
            count += 1
        if count:
            logger.info("[Cache INVALIDATE] namespace=%s count=%d", namespace, count)
        return count
    except Exception as e:
        logger.warning("[Cache] 무효화 실패 (무시): %s", e)
        return 0
