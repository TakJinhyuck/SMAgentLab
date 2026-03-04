"""
Sentence-Transformers 기반 임베딩 서비스 (싱글톤)
모델은 최초 1회 로드 후 메모리에 유지됩니다.
"""
import asyncio
from functools import partial

from sentence_transformers import SentenceTransformer

from config import settings


class EmbeddingService:
    _instance: "EmbeddingService | None" = None
    _model: SentenceTransformer | None = None

    def __new__(cls) -> "EmbeddingService":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def load(self) -> None:
        """앱 시작 시 1회 호출하여 모델을 메모리에 올립니다."""
        if self._model is None:
            print(f"[Embedding] Loading model: {settings.embedding_model}")
            self._model = SentenceTransformer(settings.embedding_model)
            print("[Embedding] Model loaded.")

    async def embed(self, text: str) -> list[float]:
        """텍스트를 벡터로 변환합니다 (thread pool에서 실행)."""
        assert self._model is not None, "EmbeddingService.load() must be called first"
        loop = asyncio.get_event_loop()
        vec = await loop.run_in_executor(
            None, partial(self._model.encode, text, normalize_embeddings=True)
        )
        return vec.tolist()

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        assert self._model is not None
        loop = asyncio.get_event_loop()
        vecs = await loop.run_in_executor(
            None, partial(self._model.encode, texts, normalize_embeddings=True)
        )
        return [v.tolist() for v in vecs]


embedding_service = EmbeddingService()
