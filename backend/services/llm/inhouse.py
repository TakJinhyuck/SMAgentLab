"""
사내 LLM Provider (OpenAI 호환 API 기준)

대부분의 사내 LLM 게이트웨이는 OpenAI /v1/chat/completions 형식을 사용합니다.
환경 변수만 바꾸면 어떤 엔드포인트든 연결 가능합니다.

필요 환경 변수:
    INHOUSE_LLM_URL      예: http://llm-gateway.internal/v1
    INHOUSE_LLM_API_KEY  예: sk-...  (없으면 빈 문자열)
    INHOUSE_LLM_MODEL    예: exaone-32b
"""
import json
from typing import AsyncIterator

import httpx

from config import settings
from services.llm.base import LLMProvider, build_messages


class InHouseLLMProvider(LLMProvider):

    def __init__(self, runtime_cfg: dict | None = None):
        cfg = runtime_cfg or {}
        url = cfg.get("inhouse_llm_url", settings.inhouse_llm_url)
        if not url:
            raise ValueError(
                "LLM_PROVIDER=inhouse 이지만 INHOUSE_LLM_URL 이 설정되지 않았습니다."
            )
        self._url = url.rstrip("/")
        self._model = cfg.get("inhouse_llm_model", settings.inhouse_llm_model)
        api_key = cfg.get("inhouse_llm_api_key", settings.inhouse_llm_api_key)
        self._headers = {
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {api_key}"} if api_key else {}),
        }
        self._timeout = cfg.get("inhouse_llm_timeout", settings.inhouse_llm_timeout)

    async def generate(self, context: str, question: str, history: list[dict] | None = None) -> str:
        payload = {
            "model": self._model,
            "messages": build_messages(context, question, history),
            "stream": False,
        }
        async with httpx.AsyncClient(timeout=self._timeout, headers=self._headers) as client:
            resp = await client.post(f"{self._url}/chat/completions", json=payload)
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"]

    async def generate_stream(self, context: str, question: str, history: list[dict] | None = None) -> AsyncIterator[str]:
        payload = {
            "model": self._model,
            "messages": build_messages(context, question, history),
            "stream": True,
        }
        async with httpx.AsyncClient(timeout=self._timeout, headers=self._headers) as client:
            async with client.stream(
                "POST", f"{self._url}/chat/completions", json=payload
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if line.startswith("data: "):
                        chunk_str = line[6:]
                        if chunk_str.strip() == "[DONE]":
                            break
                        try:
                            chunk = json.loads(chunk_str)
                            token = chunk["choices"][0]["delta"].get("content", "")
                            if token:
                                yield token
                        except (json.JSONDecodeError, KeyError):
                            continue

    async def health_check(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0, headers=self._headers) as client:
                resp = await client.get(f"{self._url}/models")
                return resp.status_code == 200
        except Exception:
            return False
