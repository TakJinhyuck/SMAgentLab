"""
TC-03: 용어집 CRUD
"""

TEST_NS = "test_coupon"


def test_create_glossary(client):
    """용어 등록 시 201과 id를 반환한다."""
    resp = client.post("/api/knowledge/glossary", json={
        "namespace": TEST_NS,
        "term": "회수_테스트",
        "description": "쿠폰 회수 테스트용 용어",
    })
    assert resp.status_code == 201
    body = resp.json()
    assert body["term"] == "회수_테스트"
    client.delete(f"/api/knowledge/glossary/{body['id']}")


def test_list_glossary_by_namespace(client, sample_glossary):
    """namespace 필터 시 해당 용어만 반환된다."""
    resp = client.get("/api/knowledge/glossary", params={"namespace": TEST_NS})
    assert resp.status_code == 200
    items = resp.json()
    assert any(g["id"] == sample_glossary["id"] for g in items)


def test_delete_glossary(client):
    """용어 삭제 시 204를 반환하고 이후 목록에서 사라진다."""
    create = client.post("/api/knowledge/glossary", json={
        "namespace": TEST_NS,
        "term": "삭제용어",
        "description": "삭제 테스트용",
    })
    gid = create.json()["id"]
    assert client.delete(f"/api/knowledge/glossary/{gid}").status_code == 204

    resp = client.get("/api/knowledge/glossary", params={"namespace": TEST_NS})
    ids = [g["id"] for g in resp.json()]
    assert gid not in ids


def test_delete_nonexistent_glossary(client):
    """존재하지 않는 용어 삭제 시 404를 반환한다."""
    resp = client.delete("/api/knowledge/glossary/99999999")
    assert resp.status_code == 404
