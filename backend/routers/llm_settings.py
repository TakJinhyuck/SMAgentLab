"""LLM 프로바이더 설정, 연결 테스트, 검색 임계값 API."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from services.llm import get_llm_provider, switch_provider, get_runtime_config
from services.llm.ollama import OllamaProvider
from services.llm.inhouse import InHouseLLMProvider
from services.retrieval import get_thresholds, set_thresholds

router = APIRouter(prefix="/api/llm", tags=["llm"])

_CONFIG_FIELDS = (
    "ollama_base_url", "ollama_model", "ollama_timeout",
    "inhouse_llm_url", "inhouse_llm_api_key", "inhouse_llm_model", "inhouse_llm_timeout",
)


class LLMConfigUpdate(BaseModel):
    provider: str
    ollama_base_url: Optional[str] = None
    ollama_model: Optional[str] = None
    ollama_timeout: Optional[int] = None
    inhouse_llm_url: Optional[str] = None
    inhouse_llm_api_key: Optional[str] = None
    inhouse_llm_model: Optional[str] = None
    inhouse_llm_timeout: Optional[int] = None


class LLMTestRequest(BaseModel):
    provider: str
    ollama_base_url: Optional[str] = None
    ollama_model: Optional[str] = None
    inhouse_llm_url: Optional[str] = None
    inhouse_llm_api_key: Optional[str] = None
    inhouse_llm_model: Optional[str] = None


def _extract_config(body) -> dict:
    """body에서 None이 아닌 설정 필드만 추출."""
    cfg = {"provider": body.provider}
    for field in _CONFIG_FIELDS:
        val = getattr(body, field, None)
        if val is not None:
            cfg[field] = val
    return cfg


@router.get("/config")
async def get_llm_config():
    config = get_runtime_config()
    is_connected = await get_llm_provider().health_check()
    return {**config, "is_connected": is_connected}


@router.put("/config")
async def update_llm_config(body: LLMConfigUpdate):
    if body.provider not in ("ollama", "inhouse"):
        raise HTTPException(status_code=400, detail="provider는 'ollama' 또는 'inhouse'여야 합니다.")
    try:
        new_provider = switch_provider(_extract_config(body))
        is_connected = await new_provider.health_check()
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {**get_runtime_config(), "is_connected": is_connected}


@router.post("/test")
async def test_llm_connection(body: LLMTestRequest):
    cfg = _extract_config(body)
    try:
        provider = InHouseLLMProvider(cfg) if body.provider == "inhouse" else OllamaProvider(cfg)
        is_connected = await provider.health_check()
    except ValueError as e:
        return {"is_connected": False, "error": str(e)}
    return {"is_connected": is_connected, "provider": body.provider}


# ── 검색 임계값 설정 ─────────────────────────────────────────────────────────

class ThresholdUpdate(BaseModel):
    glossary_min_similarity: Optional[float] = None
    fewshot_min_similarity: Optional[float] = None
    knowledge_min_score: Optional[float] = None
    knowledge_high_score: Optional[float] = None
    knowledge_mid_score: Optional[float] = None


@router.get("/thresholds")
async def get_threshold_config():
    return get_thresholds()


@router.put("/thresholds")
async def update_threshold_config(body: ThresholdUpdate):
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    for k, v in updates.items():
        if not 0.0 <= v <= 1.0:
            raise HTTPException(status_code=400, detail=f"{k}는 0~1 범위여야 합니다.")
    return set_thresholds(updates)
