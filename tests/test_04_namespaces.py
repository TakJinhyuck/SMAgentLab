"""
TC-04: 네임스페이스 목록 조회
"""

TEST_NS = "test_coupon"


def test_namespaces_returns_list(client):
    """GET /api/namespaces 가 리스트를 반환한다."""
    resp = client.get("/api/namespaces")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


def test_namespace_appears_after_knowledge_create(client):
    """지식 등록 후 해당 namespace 가 목록에 나타난다."""
    new_ns = "test_gift_ns_unique"
    create = client.post("/api/knowledge", json={
        "namespace": new_ns,
        "content": "네임스페이스 노출 테스트",
    })
    kid = create.json()["id"]

    resp = client.get("/api/namespaces")
    assert new_ns in resp.json()

    client.delete(f"/api/knowledge/{kid}")
