"""사내 LLM Provider (DevX MCP API) — per-user api_key 지원."""
import json
import logging
from typing import AsyncIterator, Optional

import httpx

from core.config import settings
from domain.llm.base import LLMProvider, _SYSTEM_PROMPT

logger = logging.getLogger(__name__)


def _build_query(context: str, question: str, history: list[dict] | None = None) -> str:
    """시스템 프롬프트 + 컨텍스트 + 대화 이력 + 질문을 단일 query 문자열로 합친다."""
    parts = [_SYSTEM_PROMPT, f"\n[참고 문서]\n{context}"]
    if history:
        for msg in history:
            role = "사용자" if msg["role"] == "user" else "어시스턴트"
            parts.append(f"\n[{role}] {msg['content']}")
    parts.append(f"\n[사용자] {question}")
    return "\n".join(parts)


def _extract_answer(data: dict) -> str:
    """응답 JSON에서 answer를 추출한다. SDK extractAnswer() 우선순위 준수."""
    # 1) external_response.dify_response.answer
    ext = data.get("external_response")
    if isinstance(ext, dict):
        dify = ext.get("dify_response")
        if isinstance(dify, dict) and dify.get("answer"):
            return dify["answer"]
    # 2) message
    if data.get("message"):
        return data["message"]
    # 3) answer
    if data.get("answer"):
        return data["answer"]
    # 4) fallback
    return json.dumps(data, ensure_ascii=False)


class InHouseLLMProvider(LLMProvider):

    def __init__(self, runtime_cfg: dict | None = None):
        cfg = runtime_cfg or {}
        url = cfg.get("inhouse_llm_url", settings.inhouse_llm_url)
        if not url:
            raise ValueError(
                "LLM_PROVIDER=inhouse 이지만 INHOUSE_LLM_URL 이 설정되지 않았습니다."
            )
        self._url = url.rstrip("/")
        self._usecase_code = cfg.get("inhouse_llm_agent_code", settings.inhouse_llm_agent_code)
        self._model = cfg.get("inhouse_llm_model", settings.inhouse_llm_model) or None
        self._response_mode = cfg.get("inhouse_llm_response_mode", settings.inhouse_llm_response_mode)
        self._system_api_key = cfg.get("inhouse_llm_api_key", settings.inhouse_llm_api_key)
        self._timeout = cfg.get("inhouse_llm_timeout", settings.inhouse_llm_timeout)

    def _build_headers(self, api_key: Optional[str] = None) -> dict:
        """per-user api_key 우선 사용, 없으면 시스템 키 fallback (health_check 등)."""
        key = api_key or self._system_api_key
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        return headers

    def _build_payload(self, query: str, response_mode: str) -> dict:
        payload: dict = {
            "usecase_code": self._usecase_code,
            "query": query,
            "response_mode": response_mode,
        }
        if self._model:
            payload["inputs"] = {"model": self._model}
        return payload

    async def generate(
        self,
        context: str,
        question: str,
        history: list[dict] | None = None,
        *,
        api_key: Optional[str] = None,
    ) -> str:
        query = _build_query(context, question, history)
        payload = self._build_payload(query, response_mode="blocking")
        headers = self._build_headers(api_key)
        logger.info("generate(blocking) → POST %s (query=%d chars)", self._url, len(query))
        async with httpx.AsyncClient(timeout=self._timeout, headers=headers) as client:
            resp = await client.post(self._url, json=payload)
            logger.info("generate ← status=%d, body=%s", resp.status_code, resp.text[:200])
            resp.raise_for_status()
            data = resp.json()
            return _extract_answer(data)

    async def generate_stream(
        self,
        context: str,
        question: str,
        history: list[dict] | None = None,
        *,
        api_key: Optional[str] = None,
    ) -> AsyncIterator[str]:
        query = _build_query(context, question, history)
        use_streaming = self._response_mode == "streaming"
        payload = self._build_payload(query, response_mode=self._response_mode)
        headers = self._build_headers(api_key)

        if not use_streaming:
            # blocking 모드: 전체 응답을 한번에 받아서 yield
            async with httpx.AsyncClient(timeout=self._timeout, headers=headers) as client:
                resp = await client.post(self._url, json=payload)
                resp.raise_for_status()
                data = resp.json()
                yield _extract_answer(data)
            return

        # streaming 모드: SSE 파싱
        # DevX MCP API 형식: event 필드가 별도 행이 아닌 data JSON 안에 포함
        # data: {"event":"message","answer":"토큰",...}
        # data: {"event":"message_end",...}
        logger.info("generate_stream(streaming) → POST %s (query=%d chars)", self._url, len(query))
        async with httpx.AsyncClient(timeout=self._timeout, headers=headers) as client:
            async with client.stream("POST", self._url, json=payload) as resp:
                logger.info("generate_stream ← status=%d", resp.status_code)
                resp.raise_for_status()
                line_count = 0
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line:
                        continue
                    if not line.startswith("data:"):
                        continue
                    line_count += 1
                    try:
                        chunk = json.loads(line[5:].strip())
                    except json.JSONDecodeError:
                        logger.warning("SSE parse error: %s", line[:100])
                        continue
                    event_type = chunk.get("event", "")
                    if event_type == "message_end":
                        logger.info("SSE message_end (total data lines=%d)", line_count)
                        break
                    if event_type == "message":
                        token = chunk.get("answer", "")
                        if token:
                            yield token

    async def health_check(self) -> bool:
        """서버 도달 가능 여부 확인. 인증 없이 401이 와도 서버는 살아있는 것."""
        try:
            headers = self._build_headers()
            async with httpx.AsyncClient(timeout=10.0, headers=headers) as client:
                resp = await client.post(
                    self._url,
                    json=self._build_payload("health check", response_mode="blocking"),
                )
                logger.info("health_check ← status=%d", resp.status_code)
                # 200=정상, 401/403=서버 도달 가능(인증만 없음)
                return resp.status_code in (200, 401, 403)
        except Exception as e:
            logger.warning("health_check 실패: %s: %s", type(e).__name__, e)
            return False
