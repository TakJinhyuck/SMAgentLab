"""Shared fixtures for knowledge ingestion tests."""
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

# backend 디렉토리를 path에 추가
backend_dir = str(Path(__file__).resolve().parent.parent)
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

# ── 외부 의존성 stub ──────────────────────────────────────────────────────────

_settings_mock = MagicMock()
_settings_mock.fernet_secret_key = "test-secret-key"
_settings_mock.jwt_secret_key = "test-jwt-secret"
_settings_mock.glossary_min_similarity = 0.6
_settings_mock.fewshot_min_similarity = 0.6
_settings_mock.knowledge_min_score = 0.1
_settings_mock.knowledge_high_score = 0.5
_settings_mock.knowledge_mid_score = 0.3
_settings_mock.default_top_k = 5
_settings_mock.default_w_vector = 0.7
_settings_mock.default_w_keyword = 0.3

sys.modules["core"] = MagicMock()
sys.modules["core.config"] = MagicMock(settings=_settings_mock)

# core.database
_fake_conn = MagicMock()
_fake_conn.__aenter__ = AsyncMock(return_value=_fake_conn)
_fake_conn.__aexit__ = AsyncMock(return_value=False)
_fake_conn.fetchval = AsyncMock(return_value=1)
_fake_conn.fetchrow = AsyncMock(return_value=None)
_fake_conn.fetch = AsyncMock(return_value=[])
_fake_conn.execute = AsyncMock()

_db_mod = MagicMock()
_db_mod.get_conn = MagicMock(return_value=_fake_conn)
_db_mod.resolve_namespace_id = AsyncMock(return_value=1)
sys.modules["core.database"] = _db_mod

sys.modules["core.dependencies"] = MagicMock()
sys.modules["core.security"] = MagicMock()

# shared
_embedding_mod = MagicMock()
_embedding_mod.embedding_service = MagicMock()
_embedding_mod.embedding_service.embed = AsyncMock(return_value=[0.1] * 768)
_embedding_mod.embedding_service.embed_batch = AsyncMock(return_value=[[0.1] * 768])
sys.modules["shared"] = MagicMock()
sys.modules["shared.embedding"] = _embedding_mod
sys.modules["shared.reranker"] = MagicMock()
sys.modules["shared.cache"] = MagicMock()

# service
_prompt_mod = MagicMock()
_prompt_mod.get_prompt = AsyncMock(side_effect=lambda key, default: default)
sys.modules["service"] = MagicMock()
sys.modules["service.prompt"] = MagicMock()
sys.modules["service.prompt.loader"] = _prompt_mod
sys.modules["service.llm"] = MagicMock()
sys.modules["service.llm.factory"] = MagicMock()
sys.modules["service.llm.base"] = MagicMock()
sys.modules["service.chat"] = MagicMock()
sys.modules["service.chat.helpers"] = MagicMock()
sys.modules["service.chat.memory"] = MagicMock()

# agents.base
sys.modules["agents.base"] = MagicMock()

# cryptography
try:
    import cryptography  # noqa
except ImportError:
    sys.modules["cryptography"] = MagicMock()
    sys.modules["cryptography.fernet"] = MagicMock()
