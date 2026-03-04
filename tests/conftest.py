"""
pytest 공통 설정 및 fixture
"""
import pytest
import httpx

BASE_URL = "http://localhost:8000"
TEST_NS = "test_coupon"


@pytest.fixture(scope="session")
def client():
    """동기 httpx 클라이언트 (세션 전체 공유)."""
    with httpx.Client(base_url=BASE_URL, timeout=60.0) as c:
        yield c


@pytest.fixture(scope="session", autouse=True)
def wait_for_backend(client):
    """백엔드가 준비될 때까지 대기."""
    import time
    for _ in range(30):
        try:
            resp = client.get("/health")
            if resp.status_code == 200:
                return
        except Exception:
            pass
        time.sleep(2)
    pytest.fail("Backend did not start within 60 seconds")


@pytest.fixture
def sample_knowledge(client):
    """테스트용 지식 1건 등록 후 반환, 테스트 종료 시 삭제."""
    resp = client.post("/api/knowledge", json={
        "namespace": TEST_NS,
        "container_name": "coupon-api",
        "target_tables": ["coupon_issue", "coupon_use_history"],
        "content": "쿠폰 회수 처리 실패 시 coupon_issue 테이블에서 status='FAILED' 건을 확인하고 "
                   "coupon_use_history에서 이력을 조회한다. 회수 API는 coupon-api 컨테이너에서 처리한다.",
        "query_template": (
            "SELECT ci.id, ci.status, ci.user_id, cuh.action\n"
            "FROM coupon_issue ci\n"
            "LEFT JOIN coupon_use_history cuh ON ci.id = cuh.coupon_issue_id\n"
            "WHERE ci.status = 'FAILED'\n"
            "  AND ci.updated_at >= NOW() - INTERVAL '1 day'\n"
            "ORDER BY ci.updated_at DESC;"
        ),
        "base_weight": 1.0,
    })
    assert resp.status_code == 201, resp.text
    item = resp.json()
    yield item
    # cleanup
    client.delete(f"/api/knowledge/{item['id']}")


@pytest.fixture
def sample_glossary(client):
    """테스트용 용어 1건 등록 후 반환, 테스트 종료 시 삭제."""
    resp = client.post("/api/knowledge/glossary", json={
        "namespace": TEST_NS,
        "term": "회수",
        "description": "쿠폰 회수, 뺏어오기, 강제 반납, 쿠폰 취소 등 쿠폰을 사용자로부터 되돌리는 처리",
    })
    assert resp.status_code == 201, resp.text
    item = resp.json()
    yield item
    client.delete(f"/api/knowledge/glossary/{item['id']}")
