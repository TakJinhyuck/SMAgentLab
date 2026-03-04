from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import database
from routers import chat, conversations, feedback, knowledge, namespaces, stats
from config import settings
from services.embedding import embedding_service
from services.llm import get_llm_provider


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 시작 시
    await database.init_pool()
    embedding_service.load()

    llm = get_llm_provider()
    llm_ok = await llm.health_check()
    if not llm_ok:
        print(f"[WARNING] LLM({settings.llm_provider}) 서버에 연결할 수 없습니다. LLM 기능이 제한됩니다.")
    else:
        print(f"[INFO] LLM({settings.llm_provider}) 연결 확인됨.")

    yield

    # 종료 시
    await database.close_pool()


app = FastAPI(
    title="Ops-Navigator API",
    description="지능형 IT 운영 보조 에이전트 백엔드",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router)
app.include_router(conversations.router)
app.include_router(knowledge.router)
app.include_router(feedback.router)
app.include_router(stats.router)
app.include_router(namespaces.router)


@app.get("/health")
async def health():
    llm = get_llm_provider()
    llm_ok = await llm.health_check()
    return {
        "status": "ok",
        "llm_provider": settings.llm_provider,
        "llm": "connected" if llm_ok else "unavailable",
    }
