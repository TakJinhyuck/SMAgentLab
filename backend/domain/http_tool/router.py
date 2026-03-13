"""HTTP 도구 CRUD + LLM 자동완성 라우터."""
import json
import logging

from fastapi import APIRouter, Depends, HTTPException

from core.database import get_conn, resolve_namespace_id
from core.dependencies import get_current_user, check_namespace_ownership
from domain.http_tool.schemas import (
    HttpToolCreate, HttpToolUpdate, HttpToolOut, HttpToolToggle, AutoCompleteRequest,
)
from domain.llm.factory import get_llm_provider

logger = logging.getLogger(__name__)
router = APIRouter(tags=["http-tools"])


# ── helpers ──────────────────────────────────────────────────────────────────

def _row_to_out(row) -> dict:
    """DB row → HttpToolOut 호환 dict."""
    d = dict(row)
    d["param_schema"] = d.get("param_schema") or []
    d["headers"] = d.get("headers") or {}
    d["created_at"] = str(d["created_at"])
    return d


# ── CRUD ─────────────────────────────────────────────────────────────────────

@router.get("/api/http-tools", response_model=list[HttpToolOut])
async def list_http_tools(namespace: str, user: dict = Depends(get_current_user)):
    async with get_conn() as conn:
        ns_id = await resolve_namespace_id(conn, namespace)
        if ns_id is None:
            return []
        rows = await conn.fetch(
            """
            SELECT ht.*, n.name AS namespace
            FROM ops_http_tool ht
            JOIN ops_namespace n ON ht.namespace_id = n.id
            WHERE ht.namespace_id = $1
            ORDER BY ht.created_at DESC
            """,
            ns_id,
        )
    return [_row_to_out(r) for r in rows]


@router.post("/api/http-tools", response_model=HttpToolOut, status_code=201)
async def create_http_tool(body: HttpToolCreate, user: dict = Depends(get_current_user)):
    await check_namespace_ownership(body.namespace, user)
    async with get_conn() as conn:
        ns_id = await resolve_namespace_id(conn, body.namespace)
        if ns_id is None:
            raise HTTPException(status_code=404, detail="네임스페이스를 찾을 수 없습니다.")
        row = await conn.fetchrow(
            """
            INSERT INTO ops_http_tool
                (namespace_id, name, description, method, url, headers,
                 param_schema, response_example, timeout_sec, max_response_kb, created_by_user_id)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11)
            RETURNING *, $12::text AS namespace
            """,
            ns_id, body.name, body.description, body.method, body.url,
            json.dumps(body.headers), json.dumps([p.model_dump() for p in body.param_schema]),
            json.dumps(body.response_example) if body.response_example else None,
            body.timeout_sec, body.max_response_kb, user["id"], body.namespace,
        )
    return _row_to_out(row)


@router.patch("/api/http-tools/{tool_id}", response_model=HttpToolOut)
async def update_http_tool(tool_id: int, body: HttpToolUpdate, user: dict = Depends(get_current_user)):
    async with get_conn() as conn:
        existing = await conn.fetchrow(
            "SELECT ht.*, n.name AS namespace FROM ops_http_tool ht JOIN ops_namespace n ON ht.namespace_id = n.id WHERE ht.id = $1",
            tool_id,
        )
        if not existing:
            raise HTTPException(status_code=404, detail="도구를 찾을 수 없습니다.")
        await check_namespace_ownership(existing["namespace"], user)

        updates = body.model_dump(exclude_none=True)
        if not updates:
            return _row_to_out(existing)

        # param_schema, headers → JSON 직렬화
        if "param_schema" in updates:
            updates["param_schema"] = json.dumps([p.model_dump() if hasattr(p, "model_dump") else p for p in updates["param_schema"]])
        if "headers" in updates:
            updates["headers"] = json.dumps(updates["headers"])
        if "response_example" in updates:
            updates["response_example"] = json.dumps(updates["response_example"])

        set_clauses = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates.keys()))
        set_clauses += f", updated_at = now()"
        vals = list(updates.values())

        row = await conn.fetchrow(
            f"""
            UPDATE ops_http_tool SET {set_clauses}
            WHERE id = $1
            RETURNING *, (SELECT name FROM ops_namespace WHERE id = namespace_id) AS namespace
            """,
            tool_id, *vals,
        )
    return _row_to_out(row)


@router.patch("/api/http-tools/{tool_id}/toggle", response_model=HttpToolOut)
async def toggle_http_tool(tool_id: int, body: HttpToolToggle, user: dict = Depends(get_current_user)):
    async with get_conn() as conn:
        existing = await conn.fetchrow(
            "SELECT n.name AS namespace FROM ops_http_tool ht JOIN ops_namespace n ON ht.namespace_id = n.id WHERE ht.id = $1",
            tool_id,
        )
        if not existing:
            raise HTTPException(status_code=404, detail="도구를 찾을 수 없습니다.")
        await check_namespace_ownership(existing["namespace"], user)

        row = await conn.fetchrow(
            """
            UPDATE ops_http_tool SET is_active = $2, updated_at = now()
            WHERE id = $1
            RETURNING *, (SELECT name FROM ops_namespace WHERE id = namespace_id) AS namespace
            """,
            tool_id, body.is_active,
        )
    return _row_to_out(row)


@router.delete("/api/http-tools/{tool_id}", status_code=204)
async def delete_http_tool(tool_id: int, user: dict = Depends(get_current_user)):
    async with get_conn() as conn:
        existing = await conn.fetchrow(
            "SELECT n.name AS namespace FROM ops_http_tool ht JOIN ops_namespace n ON ht.namespace_id = n.id WHERE ht.id = $1",
            tool_id,
        )
        if not existing:
            raise HTTPException(status_code=404, detail="도구를 찾을 수 없습니다.")
        await check_namespace_ownership(existing["namespace"], user)
        await conn.execute("DELETE FROM ops_http_tool WHERE id = $1", tool_id)


# ── LLM 자동완성 ─────────────────────────────────────────────────────────────

_AUTOCOMPLETE_PROMPT = """\
사용자가 HTTP API 도구를 등록하려고 합니다. 아래 자연어 설명을 읽고 구조화된 JSON으로 변환해주세요.

반드시 아래 JSON 형식만 출력하고, 다른 설명은 절대 하지 마세요:
{{
  "name": "도구 이름 (한글 가능, 간결하게)",
  "description": "이 도구가 하는 일 (1~2문장)",
  "method": "GET 또는 POST",
  "url": "API URL",
  "headers": {{"키": "값"}},
  "param_schema": [
    {{
      "name": "파라미터명",
      "type": "string | number | boolean",
      "required": true 또는 false,
      "description": "설명",
      "example": "예시값"
    }}
  ],
  "response_example": {{ "응답 예시 JSON" }}
}}

사용자 입력:
{raw_text}

JSON:"""


@router.post("/api/http-tools/autocomplete")
async def autocomplete_http_tool(body: AutoCompleteRequest, user: dict = Depends(get_current_user)):
    prompt = _AUTOCOMPLETE_PROMPT.format(raw_text=body.raw_text)
    try:
        answer, _ = await get_llm_provider().generate(context="", question=prompt)
        # JSON 블록 추출
        text = answer.strip()
        if "```" in text:
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
            text = text.strip()
        parsed = json.loads(text)
        return {"status": "ok", "tool": parsed}
    except json.JSONDecodeError:
        return {"status": "error", "message": "LLM 응답을 파싱할 수 없습니다. 입력을 더 구체적으로 작성해주세요.", "raw": answer}
    except Exception as e:
        logger.exception("autocomplete error")
        raise HTTPException(status_code=500, detail=f"자동완성 실패: {e}")
