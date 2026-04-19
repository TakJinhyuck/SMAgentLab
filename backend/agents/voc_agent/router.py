"""VOC 에이전트 관리 API — 데이터 인제스션 및 조회."""
from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from pydantic import BaseModel

from core.database import get_conn, resolve_namespace_id
from core.dependencies import get_current_admin as require_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/voc", tags=["VOC Agent"])


# ── 응답 스키마 ──────────────────────────────────────────────────────────────

class IngestResult(BaseModel):
    total: int
    success: int
    failed: int
    errors: list[str] = []


class VocCaseSummary(BaseModel):
    id: int
    title: str
    category: Optional[str]
    severity: str
    status: str
    affected_system: Optional[str]
    tags: list[str]


class VocManualSummary(BaseModel):
    id: int
    title: str
    category: Optional[str]
    step_order: int


# ── 인제스션 엔드포인트 ──────────────────────────────────────────────────────

@router.post("/ingest/csv", response_model=IngestResult, summary="CSV 파일 일괄 인제스션")
async def ingest_csv_endpoint(
    file: UploadFile = File(..., description="UTF-8 CSV 파일"),
    namespace: str = Form(..., description="대상 네임스페이스"),
    record_type: Literal["case", "manual"] = Form("case", description="레코드 종류"),
    _admin=Depends(require_admin),
):
    """CSV 파일을 읽어 voc_case 또는 voc_manual에 일괄 저장한다."""
    from agents.voc_agent.ingestion.data_loader import ingest_csv

    if not file.filename.endswith(".csv"):
        raise HTTPException(400, "CSV 파일만 지원합니다.")

    with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = Path(tmp.name)

    try:
        result = await ingest_csv(tmp_path, namespace, record_type)
    finally:
        tmp_path.unlink(missing_ok=True)

    if result["failed"] and result["success"] == 0:
        raise HTTPException(422, detail=result["errors"][:5])

    return result


@router.post("/ingest/txt", response_model=IngestResult, summary="TXT 파일 인제스션 (매뉴얼)")
async def ingest_txt_endpoint(
    file: UploadFile = File(..., description="UTF-8 텍스트 파일"),
    namespace: str = Form(..., description="대상 네임스페이스"),
    title: str = Form(..., description="매뉴얼 제목"),
    category: Optional[str] = Form(None, description="카테고리 (선택)"),
    _admin=Depends(require_admin),
):
    """TXT 파일을 청킹해 voc_manual에 저장한다."""
    from agents.voc_agent.ingestion.data_loader import ingest_txt

    if not file.filename.endswith(".txt"):
        raise HTTPException(400, "TXT 파일만 지원합니다.")

    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = Path(tmp.name)

    try:
        result = await ingest_txt(tmp_path, namespace, title, category)
    finally:
        tmp_path.unlink(missing_ok=True)

    return result


# ── 조회 엔드포인트 ──────────────────────────────────────────────────────────

@router.get("/cases", response_model=list[VocCaseSummary], summary="VOC 사례 목록 조회")
async def list_voc_cases(
    namespace: str = Query(...),
    category: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    async with get_conn() as conn:
        ns_id = await resolve_namespace_id(conn, namespace)
        if ns_id is None:
            raise HTTPException(404, "네임스페이스를 찾을 수 없습니다.")

        conditions = ["namespace_id = $1"]
        params: list = [ns_id]

        if category:
            params.append(category)
            conditions.append(f"category = ${len(params)}")
        if severity:
            params.append(severity)
            conditions.append(f"severity = ${len(params)}")

        where = " AND ".join(conditions)
        params += [limit, offset]

        rows = await conn.fetch(
            f"""
            SELECT id, title, category, severity, status, affected_system, tags
            FROM voc_case
            WHERE {where}
            ORDER BY created_at DESC
            LIMIT ${len(params) - 1} OFFSET ${len(params)}
            """,
            *params,
        )

    return [
        VocCaseSummary(
            id=r["id"], title=r["title"], category=r["category"],
            severity=r["severity"] or "medium", status=r["status"] or "resolved",
            affected_system=r["affected_system"],
            tags=list(r["tags"]) if r["tags"] else [],
        )
        for r in rows
    ]


@router.get("/manuals", response_model=list[VocManualSummary], summary="운영 매뉴얼 목록 조회")
async def list_voc_manuals(
    namespace: str = Query(...),
    category: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    async with get_conn() as conn:
        ns_id = await resolve_namespace_id(conn, namespace)
        if ns_id is None:
            raise HTTPException(404, "네임스페이스를 찾을 수 없습니다.")

        params: list = [ns_id]
        cat_filter = ""
        if category:
            params.append(category)
            cat_filter = f"AND category = ${len(params)}"

        params += [limit, offset]
        rows = await conn.fetch(
            f"""
            SELECT id, title, category, step_order
            FROM voc_manual
            WHERE namespace_id = $1 {cat_filter}
            ORDER BY step_order ASC, created_at ASC
            LIMIT ${len(params) - 1} OFFSET ${len(params)}
            """,
            *params,
        )

    return [
        VocManualSummary(
            id=r["id"], title=r["title"],
            category=r["category"], step_order=r["step_order"] or 0,
        )
        for r in rows
    ]


@router.delete("/cases/{case_id}", summary="VOC 사례 삭제")
async def delete_voc_case(case_id: int, _admin=Depends(require_admin)):
    async with get_conn() as conn:
        result = await conn.execute("DELETE FROM voc_case WHERE id = $1", case_id)
    if result == "DELETE 0":
        raise HTTPException(404, "사례를 찾을 수 없습니다.")
    return {"deleted": case_id}


@router.delete("/manuals/{manual_id}", summary="운영 매뉴얼 삭제")
async def delete_voc_manual(manual_id: int, _admin=Depends(require_admin)):
    async with get_conn() as conn:
        result = await conn.execute("DELETE FROM voc_manual WHERE id = $1", manual_id)
    if result == "DELETE 0":
        raise HTTPException(404, "매뉴얼을 찾을 수 없습니다.")
    return {"deleted": manual_id}
