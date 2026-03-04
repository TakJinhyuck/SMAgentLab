"""
TC-01: 서버 상태 확인
"""


def test_health_ok(client):
    """백엔드 /health 가 200을 반환하고 필수 필드를 포함한다."""
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "llm_provider" in body
    assert body["llm_provider"] in ("ollama", "inhouse")
    assert "llm" in body


def test_docs_accessible(client):
    """FastAPI Swagger UI(/docs)가 접근 가능하다."""
    resp = client.get("/docs")
    assert resp.status_code == 200
