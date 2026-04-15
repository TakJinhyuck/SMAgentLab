"""지식 베이스 및 용어집 CRUD — 네임스페이스 소유 파트 기반 권한."""
import csv
import io
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form

from core.dependencies import get_current_user, check_namespace_ownership
from agents.knowledge_rag.knowledge.schemas import (
    GlossaryCreate, GlossaryOut, GlossaryUpdate,
    KnowledgeCreate, KnowledgeOut, KnowledgeUpdate,
    BulkCreateRequest, IngestionJobOut,
)
from agents.knowledge_rag.knowledge import service

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])


# ─── ops_knowledge ─────────────────────────────────────────────────────────────

@router.get("", response_model=list[KnowledgeOut])
async def get_knowledge_list(
    namespace: Optional[str] = Query(default=None),
    user: dict = Depends(get_current_user),
):
    return await service.list_knowledge(namespace)


@router.post("", response_model=KnowledgeOut, status_code=201)
async def add_knowledge(body: KnowledgeCreate, user: dict = Depends(get_current_user)):
    await check_namespace_ownership(body.namespace, user)
    row = await service.create_knowledge(
        namespace=body.namespace,
        content=body.content,
        container_name=body.container_name,
        target_tables=body.target_tables,
        query_template=body.query_template,
        base_weight=body.base_weight,
        category=body.category,
        created_by_part=user["part"],
        created_by_user_id=user["id"],
    )
    return row


@router.put("/{knowledge_id}", response_model=KnowledgeOut)
async def modify_knowledge(knowledge_id: int, body: KnowledgeUpdate, user: dict = Depends(get_current_user)):
    ns = await service.get_knowledge_namespace(knowledge_id)
    if ns is None:
        raise HTTPException(status_code=404, detail="Knowledge not found")
    await check_namespace_ownership(ns, user)

    row = await service.update_knowledge(
        knowledge_id=knowledge_id,
        content=body.content,
        container_name=body.container_name,
        target_tables=body.target_tables,
        query_template=body.query_template,
        base_weight=body.base_weight,
        category=body.category,
        updated_by_part=user["part"],
        updated_by_user_id=user["id"],
    )
    if not row:
        raise HTTPException(status_code=404, detail="Knowledge not found")
    return row


@router.delete("/{knowledge_id}", status_code=204)
async def remove_knowledge(knowledge_id: int, user: dict = Depends(get_current_user)):
    ns = await service.get_knowledge_namespace(knowledge_id)
    if ns is None:
        raise HTTPException(status_code=404, detail="Knowledge not found")
    await check_namespace_ownership(ns, user)

    deleted = await service.delete_knowledge(knowledge_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Knowledge not found")


# ─── ops_glossary ──────────────────────────────────────────────────────────────

@router.get("/glossary", response_model=list[GlossaryOut])
async def get_glossary_list(
    namespace: Optional[str] = Query(default=None),
    user: dict = Depends(get_current_user),
):
    return await service.list_glossary(namespace)


@router.post("/glossary", response_model=GlossaryOut, status_code=201)
async def add_glossary(body: GlossaryCreate, user: dict = Depends(get_current_user)):
    await check_namespace_ownership(body.namespace, user)
    return await service.create_glossary(
        body.namespace, body.term, body.description,
        created_by_part=user["part"], created_by_user_id=user["id"],
    )


@router.put("/glossary/{glossary_id}", response_model=GlossaryOut)
async def modify_glossary(glossary_id: int, body: GlossaryUpdate, user: dict = Depends(get_current_user)):
    ns = await service.get_glossary_namespace(glossary_id)
    if ns is None:
        raise HTTPException(status_code=404, detail="Glossary term not found")
    await check_namespace_ownership(ns, user)

    row = await service.update_glossary(
        glossary_id, body.term, body.description,
        updated_by_part=user["part"], updated_by_user_id=user["id"],
    )
    if not row:
        raise HTTPException(status_code=404, detail="Glossary term not found")
    return row


@router.delete("/glossary/{glossary_id}", status_code=204)
async def remove_glossary(glossary_id: int, user: dict = Depends(get_current_user)):
    ns = await service.get_glossary_namespace(glossary_id)
    if ns is None:
        raise HTTPException(status_code=404, detail="Glossary term not found")
    await check_namespace_ownership(ns, user)

    deleted = await service.delete_glossary(glossary_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Glossary term not found")


# ─── 벌크 등록 / 인제스천 ────────────────────────────────────────────────────

@router.post("/bulk", status_code=201)
async def bulk_create(body: BulkCreateRequest, user: dict = Depends(get_current_user)):
    """JSON 배열로 지식 벌크 등록."""
    await check_namespace_ownership(body.namespace, user)
    result = await service.bulk_create_knowledge(
        namespace=body.namespace,
        items=[item.model_dump() for item in body.items],
        source_file=body.source_file,
        source_type=body.source_type,
        created_by_part=user["part"],
        created_by_user_id=user["id"],
    )
    return result


@router.post("/import/csv", status_code=201)
async def import_csv(
    file: UploadFile = File(...),
    namespace: str = Form(...),
    column_mapping: str = Form(...),
    category: Optional[str] = Form(default=None),
    user: dict = Depends(get_current_user),
):
    """CSV 파일 업로드 → 파싱 → 벌크 등록.

    column_mapping: JSON 문자열 {"content": "csv_col_name", "category": "csv_col_name", ...}
    """
    await check_namespace_ownership(namespace, user)

    # CSV 파싱
    try:
        raw = await file.read()
        text = raw.decode("utf-8-sig")  # BOM 대응
        reader = csv.DictReader(io.StringIO(text))
        rows = list(reader)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"CSV 파싱 실패: {e}")

    if not rows:
        raise HTTPException(status_code=400, detail="CSV에 데이터가 없습니다.")

    # 컬럼 매핑
    try:
        mapping = json.loads(column_mapping)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="column_mapping이 유효한 JSON이 아닙니다.")

    content_col = mapping.get("content")
    if not content_col:
        raise HTTPException(status_code=400, detail="content 컬럼 매핑이 필요합니다.")

    # 매핑 적용
    items = []
    for row in rows:
        content = row.get(content_col, "").strip()
        if not content:
            continue
        item = {"content": content}
        if mapping.get("category") and row.get(mapping["category"]):
            item["category"] = row[mapping["category"]].strip()
        elif category:
            item["category"] = category
        if mapping.get("container_name") and row.get(mapping["container_name"]):
            item["container_name"] = row[mapping["container_name"]].strip()
        if mapping.get("target_tables") and row.get(mapping["target_tables"]):
            item["target_tables"] = [t.strip() for t in row[mapping["target_tables"]].split(",") if t.strip()]
        if mapping.get("query_template") and row.get(mapping["query_template"]):
            item["query_template"] = row[mapping["query_template"]].strip()
        items.append(item)

    if not items:
        raise HTTPException(status_code=400, detail="유효한 데이터가 없습니다.")

    result = await service.bulk_create_knowledge(
        namespace=namespace,
        items=items,
        source_file=file.filename,
        source_type="csv_import",
        created_by_part=user["part"],
        created_by_user_id=user["id"],
    )
    return result


from pydantic import BaseModel as _BM


class _TextSplitBody(_BM):
    namespace: str
    raw_text: str
    strategy: str = "auto"
    category: Optional[str] = None


@router.post("/import/text-split", status_code=201)
async def import_text_split(body: _TextSplitBody, user: dict = Depends(get_current_user)):
    """대량 텍스트 → 자동 분할 → 벌크 등록."""
    await check_namespace_ownership(body.namespace, user)

    chunks = service.split_text_to_chunks(body.raw_text, body.strategy)
    if not chunks:
        raise HTTPException(status_code=400, detail="분할된 청크가 없습니다.")

    items = [{"content": c, "category": body.category} for c in chunks]
    result = await service.bulk_create_knowledge(
        namespace=body.namespace,
        items=items,
        source_file=None,
        source_type="paste_split",
        created_by_part=user["part"],
        created_by_user_id=user["id"],
    )
    return {**result, "chunks": len(chunks)}


class _TextSplitPreviewBody(_BM):
    raw_text: str
    strategy: str = "auto"


@router.post("/import/text-split/preview")
async def preview_text_split(body: _TextSplitPreviewBody, _: dict = Depends(get_current_user)):
    """텍스트 분할 미리보기 (등록 없이 결과만 반환)."""
    chunks = service.split_text_to_chunks(body.raw_text, body.strategy)
    return {"chunks": chunks, "count": len(chunks)}


# ─── 인제스천 작업 이력 ──────────────────────────────────────────────────────

@router.get("/ingestion-jobs", response_model=list[IngestionJobOut])
async def get_ingestion_jobs(
    namespace: str = Query(...),
    user: dict = Depends(get_current_user),
):
    return await service.list_ingestion_jobs(namespace)
