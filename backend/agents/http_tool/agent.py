"""HTTP Tool 에이전트 — 외부 API 호출을 LLM 컨텍스트에 통합."""
import json
import logging
from typing import AsyncIterator, Optional

import httpx

from agents.base import AgentBase
from core.database import get_conn, resolve_namespace_id
from domain.chat.helpers import (
    LLM_UNAVAILABLE_MSG,
    update_assistant_message, create_query_log, post_save_tasks,
)
from domain.llm.factory import get_llm_provider

logger = logging.getLogger(__name__)


# ── LLM 프롬프트: 도구 선택 + 파라미터 추출 ─────────────────────────────────

_TOOL_SELECT_PROMPT = """\
당신은 사용자의 질문을 분석하여 적절한 HTTP 도구를 선택하고 파라미터를 추출하는 AI입니다.

## 사용 가능한 도구 목록
{tool_list}

## 규칙
1. 질문에 맞는 도구가 있으면 선택하고, 질문에서 파라미터 값을 추출하세요.
2. 필수(required=true) 파라미터 중 값을 알 수 없으면 missing_params에 넣으세요.
3. 도구가 필요 없으면 "no_tool"을 반환하세요.

반드시 아래 JSON만 출력하세요:
- 도구 선택 시: {{"tool_id": 숫자, "tool_name": "이름", "params": {{"key": "value"}}, "missing_params": ["누락된 필수 파라미터명"]}}
- 도구 불필요 시: {{"tool_id": null, "reason": "이유"}}

사용자 질문: {question}

JSON:"""


async def _select_tool(question: str, tools: list[dict]) -> dict:
    """LLM에게 도구 선택 + 파라미터 추출을 요청."""
    tool_descriptions = []
    for t in tools:
        params_desc = []
        for p in (t.get("param_schema") or []):
            req = "필수" if p.get("required") else "선택"
            ex = f' (예: {p["example"]})' if p.get("example") else ""
            params_desc.append(f'    - {p["name"]} ({req}, {p.get("type","string")}): {p.get("description","")}{ex}')
        tool_descriptions.append(
            f'- ID: {t["id"]}, 이름: {t["name"]}\n'
            f'  설명: {t["description"]}\n'
            f'  Method: {t["method"]} {t["url"]}\n'
            f'  파라미터:\n' + "\n".join(params_desc)
        )

    prompt = _TOOL_SELECT_PROMPT.format(
        tool_list="\n\n".join(tool_descriptions),
        question=question,
    )
    answer, _ = await get_llm_provider().generate(context="", question=prompt)
    text = answer.strip()
    if "```" in text:
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    return json.loads(text)


async def _fetch_active_tools(namespace: str) -> list[dict]:
    """네임스페이스의 활성 도구 목록 조회."""
    async with get_conn() as conn:
        ns_id = await resolve_namespace_id(conn, namespace)
        if ns_id is None:
            return []
        rows = await conn.fetch(
            """
            SELECT id, name, description, method, url, headers,
                   param_schema, response_example, timeout_sec, max_response_kb
            FROM ops_http_tool
            WHERE namespace_id = $1 AND is_active = true
            ORDER BY name
            """,
            ns_id,
        )
    return [dict(r) for r in rows]


async def _execute_http_call(tool: dict, params: dict) -> str:
    """실제 HTTP 호출 실행 + 응답 반환."""
    method = tool["method"].upper()
    url = tool["url"]
    headers = tool.get("headers") or {}
    timeout = tool.get("timeout_sec", 10)
    max_kb = tool.get("max_response_kb", 50)

    async with httpx.AsyncClient(timeout=timeout) as client:
        if method == "GET":
            resp = await client.get(url, params=params, headers=headers)
        else:
            resp = await client.request(method, url, json=params, headers=headers)

    resp.raise_for_status()

    body = resp.text
    # 응답 크기 제한
    max_bytes = max_kb * 1024
    if len(body.encode("utf-8")) > max_bytes:
        body = body.encode("utf-8")[:max_bytes].decode("utf-8", errors="ignore")
        body += "\n... (응답이 잘렸습니다)"

    return body


# ── LLM 프롬프트: HTTP 응답 기반 최종 답변 ───────────────────────────────────

_ANSWER_WITH_DATA_PROMPT = """\
사용자의 질문에 대해 외부 API에서 가져온 데이터를 기반으로 답변해주세요.

## 사용된 도구
- 이름: {tool_name}
- URL: {method} {url}
- 파라미터: {params}

## API 응답 데이터
{response_data}

## 사용자 질문
{question}

위 데이터를 바탕으로 사용자에게 도움이 되는 답변을 생성해주세요. 데이터가 비어있거나 오류인 경우 그 사실을 알려주세요."""


class HttpToolAgent(AgentBase):

    @property
    def agent_id(self) -> str:
        return "http_tool"

    @property
    def metadata(self) -> dict:
        return {
            "display_name": "HTTP 도구",
            "description": "외부 API 연동으로 실시간 데이터 조회",
            "icon": "Globe",
            "color": "emerald",
            "output_type": "text",
            "welcome_message": "외부 API 도구를 활용하여 질문에 답변합니다.",
            "supports_debug": False,
        }

    async def stream_chat(
        self,
        query: str,
        user: dict,
        conversation_id: int,
        context: dict,
    ) -> AsyncIterator[dict]:
        namespace: str = context["namespace"]
        msg_id: int = context["msg_id"]
        approved_tool: Optional[dict] = context.get("approved_tool")

        full_answer = ""

        try:
            # ── Case 1: 승인된 도구가 있으면 바로 HTTP 호출 실행 ──
            if approved_tool:
                yield {"type": "status", "step": "http_call", "message": "HTTP 호출 실행 중..."}

                tool_id = approved_tool["tool_id"]
                params = approved_tool["params"]

                # DB에서 도구 정보 조회
                async with get_conn() as conn:
                    tool_row = await conn.fetchrow(
                        "SELECT * FROM ops_http_tool WHERE id = $1 AND is_active = true",
                        tool_id,
                    )
                if not tool_row:
                    yield {"type": "tool_error", "message": "도구가 비활성화되었거나 존재하지 않습니다."}
                    return

                tool = dict(tool_row)

                try:
                    response_data = await _execute_http_call(tool, params)
                except httpx.TimeoutException:
                    yield {"type": "tool_error", "message": f"HTTP 호출 타임아웃 ({tool['timeout_sec']}초)"}
                    await update_assistant_message(msg_id, f"[HTTP 호출 타임아웃: {tool['name']}]", "completed")
                    return
                except httpx.HTTPStatusError as e:
                    yield {"type": "tool_error", "message": f"HTTP 오류: {e.response.status_code}"}
                    await update_assistant_message(msg_id, f"[HTTP 오류 {e.response.status_code}: {tool['name']}]", "completed")
                    return
                except Exception as e:
                    yield {"type": "tool_error", "message": f"HTTP 호출 실패: {e}"}
                    await update_assistant_message(msg_id, f"[HTTP 호출 실패: {tool['name']}]", "completed")
                    return

                yield {"type": "tool_result", "data": response_data[:500]}

                # LLM으로 최종 답변 생성
                yield {"type": "status", "step": "llm", "message": "AI 답변 생성 중..."}

                llm_prompt = _ANSWER_WITH_DATA_PROMPT.format(
                    tool_name=tool["name"],
                    method=tool["method"],
                    url=tool["url"],
                    params=json.dumps(params, ensure_ascii=False),
                    response_data=response_data,
                    question=query,
                )

                try:
                    async for token in get_llm_provider().generate_stream(
                        llm_prompt, query, "",
                    ):
                        full_answer += token
                        yield {"type": "token", "data": token}
                except Exception as e:
                    logger.warning("LLM 스트리밍 실패: %s", e)
                    full_answer = LLM_UNAVAILABLE_MSG
                    yield {"type": "token", "data": LLM_UNAVAILABLE_MSG}

                final_answer = full_answer or LLM_UNAVAILABLE_MSG
                await update_assistant_message(msg_id, final_answer, "completed")
                await create_query_log(namespace, query, final_answer, True, None, msg_id)
                yield {"type": "done", "message_id": msg_id}
                return

            # ── Case 2: 도구 선택 요청 (첫 진입) ──
            yield {"type": "status", "step": "tool_select", "message": "사용 가능한 도구 분석 중..."}

            tools = await _fetch_active_tools(namespace)
            if not tools:
                yield {"type": "tool_request", "action": "no_tools", "message": "등록된 활성 도구가 없습니다."}
                return

            # LLM으로 도구 선택 + 파라미터 추출
            try:
                selection = await _select_tool(query, tools)
            except Exception as e:
                logger.warning("도구 선택 LLM 실패: %s", e)
                yield {"type": "tool_error", "message": "도구 선택에 실패했습니다. 다시 시도해주세요."}
                return

            # 도구 불필요 판단
            if selection.get("tool_id") is None:
                yield {
                    "type": "tool_request",
                    "action": "no_tool_needed",
                    "message": selection.get("reason", "이 질문에는 HTTP 도구가 필요하지 않습니다."),
                    "tools": [{"id": t["id"], "name": t["name"], "description": t["description"]} for t in tools],
                }
                return

            # 파라미터 누락 확인
            missing = selection.get("missing_params", [])
            tool_summary = [{"id": t["id"], "name": t["name"], "description": t["description"]} for t in tools]
            selected_tool = next((t for t in tools if t["id"] == selection["tool_id"]), None)

            if not selected_tool:
                yield {"type": "tool_error", "message": "선택된 도구를 찾을 수 없습니다."}
                return

            if missing:
                # 파라미터 부족 → 재질의 요청
                yield {
                    "type": "tool_request",
                    "action": "missing_params",
                    "tool_id": selection["tool_id"],
                    "tool_name": selection["tool_name"],
                    "tool_url": f'{selected_tool["method"]} {selected_tool["url"]}',
                    "params": selection.get("params", {}),
                    "missing_params": missing,
                    "param_schema": selected_tool.get("param_schema", []),
                    "tools": tool_summary,
                }
            else:
                # 파라미터 완성 → 승인 요청
                yield {
                    "type": "tool_request",
                    "action": "confirm",
                    "tool_id": selection["tool_id"],
                    "tool_name": selection["tool_name"],
                    "tool_url": f'{selected_tool["method"]} {selected_tool["url"]}',
                    "params": selection.get("params", {}),
                    "param_schema": selected_tool.get("param_schema", []),
                    "tools": tool_summary,
                }

        except Exception as e:
            logger.error("HttpToolAgent 에러: %s", e, exc_info=True)
            if not full_answer:
                full_answer = LLM_UNAVAILABLE_MSG
            await update_assistant_message(msg_id, full_answer, "completed")
