"""
LLM Provider 팩토리

사용법:
    from services.llm import get_llm_provider

    llm = get_llm_provider()
    answer = await llm.generate(context, question)
    async for token in llm.generate_stream(context, question):
        ...

Provider 전환:
    .env 의 LLM_PROVIDER 값만 변경하면 됩니다.
    "ollama"   → OllamaProvider  (로컬/내부망 Ollama)
    "inhouse"  → InHouseLLMProvider  (사내 OpenAI 호환 API)
"""
from config import settings
from services.llm.base import LLMProvider
from services.llm.inhouse import InHouseLLMProvider
from services.llm.ollama import OllamaProvider

_provider: LLMProvider | None = None


def get_llm_provider() -> LLMProvider:
    """싱글톤 LLM Provider 반환."""
    global _provider
    if _provider is None:
        if settings.llm_provider == "inhouse":
            _provider = InHouseLLMProvider()
        else:
            _provider = OllamaProvider()
    return _provider
