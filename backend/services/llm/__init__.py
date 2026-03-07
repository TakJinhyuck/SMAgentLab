"""
LLM Provider 팩토리

사용법:
    from services.llm import get_llm_provider

    llm = get_llm_provider()
    answer = await llm.generate(context, question)
    async for token in llm.generate_stream(context, question):
        ...

Provider 전환:
    1. .env 의 LLM_PROVIDER 값 변경 (재시작 필요, 영구 적용)
    2. switch_provider() 호출 (재시작 전까지 메모리에서 유지)
    "ollama"   → OllamaProvider  (로컬/내부망 Ollama)
    "inhouse"  → InHouseLLMProvider  (사내 OpenAI 호환 API)
"""
from config import settings
from services.llm.base import LLMProvider
from services.llm.inhouse import InHouseLLMProvider
from services.llm.ollama import OllamaProvider

_provider: LLMProvider | None = None

# 런타임 오버라이드 설정 (switch_provider()로 변경, 재시작 시 초기화)
_runtime_config: dict | None = None


def get_llm_provider() -> LLMProvider:
    """싱글톤 LLM Provider 반환."""
    global _provider
    if _provider is None:
        _provider = _create_provider()
    return _provider


def _create_provider() -> LLMProvider:
    """_runtime_config 또는 settings 기반으로 Provider 인스턴스 생성."""
    if _runtime_config is not None:
        provider_type = _runtime_config.get("provider", settings.llm_provider)
    else:
        provider_type = settings.llm_provider

    if provider_type == "inhouse":
        return InHouseLLMProvider(_runtime_config)
    else:
        return OllamaProvider(_runtime_config)


def switch_provider(config: dict) -> LLMProvider:
    """런타임에 LLM Provider를 전환한다. 재시작 시 .env 값으로 복귀."""
    global _provider, _runtime_config
    _runtime_config = config
    _provider = _create_provider()
    return _provider


def get_runtime_config() -> dict:
    """현재 유효한 LLM 설정 반환 (런타임 오버라이드 우선)."""
    cfg = _runtime_config or {}
    provider = cfg.get("provider", settings.llm_provider)
    return {
        "provider": provider,
        "is_runtime_override": _runtime_config is not None,
        "ollama": {
            "base_url": cfg.get("ollama_base_url", settings.ollama_base_url),
            "model": cfg.get("ollama_model", settings.ollama_model),
            "timeout": cfg.get("ollama_timeout", settings.ollama_timeout),
        },
        "inhouse": {
            "url": cfg.get("inhouse_llm_url", settings.inhouse_llm_url),
            "model": cfg.get("inhouse_llm_model", settings.inhouse_llm_model),
            "has_api_key": bool(cfg.get("inhouse_llm_api_key", settings.inhouse_llm_api_key)),
            "timeout": cfg.get("inhouse_llm_timeout", settings.inhouse_llm_timeout),
        },
    }
