from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql://ops:ops1234@localhost:5432/opsdb"

    # ── 임베딩 (Sentence-Transformers) ────────────────────────────────────────
    embedding_model: str = "paraphrase-multilingual-mpnet-base-v2"
    vector_dim: int = 768

    # ── LLM Provider 선택 ─────────────────────────────────────────────────────
    # "ollama" | "inhouse"
    llm_provider: str = "ollama"

    # Ollama 설정
    ollama_base_url: str = "http://host.docker.internal:11434"
    ollama_model: str = "exaone3.5:7.8b"
    ollama_timeout: int = 900  # CPU 추론 최대 대기 (초) — 7.8B 모델 기준 최대 15분

    # 사내 LLM 설정 (llm_provider="inhouse" 시 사용)
    # OpenAI 호환 API 형식 기준
    inhouse_llm_url: str = ""          # 예: http://llm-gateway.internal/v1
    inhouse_llm_api_key: str = ""
    inhouse_llm_model: str = ""        # 예: exaone-32b
    inhouse_llm_timeout: int = 120

    # ── 검색 기본값 ───────────────────────────────────────────────────────────
    default_top_k: int = 5
    default_w_vector: float = 0.7
    default_w_keyword: float = 0.3

    class Config:
        env_file = ".env"


settings = Settings()
