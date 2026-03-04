"""
Ollama LLM Provider
/api/chat 엔드포인트 사용 (GPT 방식 multi-turn messages 배열)
"""
import json
from typing import AsyncIterator

import httpx

from config import settings
from services.llm.base import LLMProvider, build_messages


def _ollama_timeout() -> httpx.Timeout:
    return httpx.Timeout(
        connect=10.0,
        read=float(settings.ollama_timeout),
        write=30.0,
        pool=10.0,
    )


class OllamaProvider(LLMProvider):

    def __init__(self):
        self._base_url = settings.ollama_base_url
        self._model = settings.ollama_model

    async def generate(self, context: str, question: str, history: list[dict] | None = None) -> str:
        messages = build_messages(context, question, history)
        async with httpx.AsyncClient(timeout=_ollama_timeout()) as client:
            resp = await client.post(
                f"{self._base_url}/api/chat",
                json={"model": self._model, "messages": messages, "stream": False},
            )
            resp.raise_for_status()
            return resp.json()["message"]["content"]

    async def generate_stream(self, context: str, question: str, history: list[dict] | None = None) -> AsyncIterator[str]:
        messages = build_messages(context, question, history)
        async with httpx.AsyncClient(timeout=_ollama_timeout()) as client:
            async with client.stream(
                "POST",
                f"{self._base_url}/api/chat",
                json={"model": self._model, "messages": messages, "stream": True},
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if line:
                        try:
                            chunk = json.loads(line)
                            token = chunk.get("message", {}).get("content", "")
                            if token:
                                yield token
                            if chunk.get("done"):
                                break
                        except json.JSONDecodeError:
                            continue

    async def health_check(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self._base_url}/api/tags")
                return resp.status_code == 200
        except Exception:
            return False
