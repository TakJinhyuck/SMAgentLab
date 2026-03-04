"""
/api/knowledge  — 지식 베이스 및 용어집 CRUD
"""
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from models.api_models import (
    GlossaryCreate, GlossaryOut, GlossaryUpdate,
    KnowledgeCreate, KnowledgeOut, KnowledgeUpdate,
)
from services.knowledge import (
    create_glossary, create_knowledge,
    delete_glossary, delete_knowledge,
    list_glossary, list_knowledge,
    update_glossary, update_knowledge,
)

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])


# ─── ops_knowledge ─────────────────────────────────────────────────────────────

@router.get("", response_model=list[KnowledgeOut])
async def get_knowledge_list(namespace: Optional[str] = Query(default=None)):
    rows = await list_knowledge(namespace)
    return rows


@router.post("", response_model=KnowledgeOut, status_code=201)
async def add_knowledge(body: KnowledgeCreate):
    row = await create_knowledge(
        namespace=body.namespace,
        content=body.content,
        container_name=body.container_name,
        target_tables=body.target_tables,
        query_template=body.query_template,
        base_weight=body.base_weight,
    )
    return row


@router.put("/{knowledge_id}", response_model=KnowledgeOut)
async def modify_knowledge(knowledge_id: int, body: KnowledgeUpdate):
    row = await update_knowledge(
        knowledge_id=knowledge_id,
        content=body.content,
        container_name=body.container_name,
        target_tables=body.target_tables,
        query_template=body.query_template,
        base_weight=body.base_weight,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Knowledge not found")
    return row


@router.delete("/{knowledge_id}", status_code=204)
async def remove_knowledge(knowledge_id: int):
    deleted = await delete_knowledge(knowledge_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Knowledge not found")


# ─── ops_glossary ──────────────────────────────────────────────────────────────

@router.get("/glossary", response_model=list[GlossaryOut])
async def get_glossary_list(namespace: Optional[str] = Query(default=None)):
    return await list_glossary(namespace)


@router.post("/glossary", response_model=GlossaryOut, status_code=201)
async def add_glossary(body: GlossaryCreate):
    return await create_glossary(body.namespace, body.term, body.description)


@router.put("/glossary/{glossary_id}", response_model=GlossaryOut)
async def modify_glossary(glossary_id: int, body: GlossaryUpdate):
    row = await update_glossary(glossary_id, body.term, body.description)
    if not row:
        raise HTTPException(status_code=404, detail="Glossary term not found")
    return row


@router.delete("/glossary/{glossary_id}", status_code=204)
async def remove_glossary(glossary_id: int):
    deleted = await delete_glossary(glossary_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Glossary term not found")
