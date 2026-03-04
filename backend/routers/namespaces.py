"""
/api/namespaces  — 네임스페이스 목록 조회 / 추가 / 삭제
"""
from fastapi import APIRouter, HTTPException

from models.api_models import NamespaceCreate, NamespaceInfo
from services.knowledge import (
    create_namespace,
    delete_namespace,
    list_namespaces,
    list_namespaces_detail,
)

router = APIRouter(prefix="/api/namespaces", tags=["namespaces"])


@router.get("", response_model=list[str])
async def get_namespaces():
    return await list_namespaces()


@router.get("/detail", response_model=list[NamespaceInfo])
async def get_namespaces_detail():
    return await list_namespaces_detail()


@router.post("", response_model=dict)
async def create_namespace_endpoint(body: NamespaceCreate):
    return await create_namespace(body.name, body.description)


@router.delete("/{name}", status_code=204)
async def delete_namespace_endpoint(name: str):
    success = await delete_namespace(name)
    if not success:
        raise HTTPException(status_code=404, detail=f"Namespace '{name}' not found")
