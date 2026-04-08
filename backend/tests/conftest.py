"""Shared fixtures for text2sql tests."""
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

# backend 디렉토리를 path에 추가
backend_dir = str(Path(__file__).resolve().parent.parent)
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

# ── 외부 의존성 stub (agents 패키지는 건드리지 않음) ──────────────────────────
# DB, embedding, config 등 실제 연결 없이 테스트하기 위한 mock

# core.config stub
_settings_mock = MagicMock()
_settings_mock.fernet_secret_key = "test-secret-key-for-tests"
_settings_mock.jwt_secret_key = "test-jwt-secret"

_config_mod = MagicMock(settings=_settings_mock)
sys.modules["core"] = MagicMock()
sys.modules["core.config"] = _config_mod

# core.database — get_conn을 AsyncMock context manager로 설정
_db_mod = MagicMock()
_fake_conn = MagicMock()
_fake_conn.__aenter__ = AsyncMock(return_value=_fake_conn)
_fake_conn.__aexit__ = AsyncMock(return_value=False)
_db_mod.get_conn = MagicMock(return_value=_fake_conn)
sys.modules["core.database"] = _db_mod

sys.modules["core.dependencies"] = MagicMock()
sys.modules["core.security"] = MagicMock()

# shared stubs
_embedding_mod = MagicMock()
_embedding_mod.embedding_service = MagicMock()
_embedding_mod.embedding_service.embed = AsyncMock(return_value=[0.1] * 768)
_embedding_mod.embedding_service.embed_batch = AsyncMock(return_value=[[0.1] * 768])
sys.modules["shared"] = MagicMock()
sys.modules["shared.embedding"] = _embedding_mod
sys.modules["shared.reranker"] = MagicMock()
sys.modules["shared.cache"] = MagicMock()

# service stubs — prompt loader 등
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

# agents.base stub (base class만)
_agents_base_mod = MagicMock()
sys.modules["agents.base"] = _agents_base_mod

# cryptography stub for service.py Fernet
try:
    import cryptography  # noqa: F401
except ImportError:
    sys.modules["cryptography"] = MagicMock()
    sys.modules["cryptography.fernet"] = MagicMock()
