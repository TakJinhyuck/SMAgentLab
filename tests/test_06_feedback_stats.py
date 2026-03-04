"""
TC-06: 피드백 및 통계
"""

TEST_NS = "test_coupon"


class TestFeedback:
    def test_positive_feedback_returns_200(self, client, sample_knowledge):
        """긍정 피드백 제출 시 200을 반환한다."""
        resp = client.post("/api/feedback", json={
            "knowledge_id": sample_knowledge["id"],
            "namespace": TEST_NS,
            "question": "테스트 질문",
            "is_positive": True,
        })
        assert resp.status_code == 201
        assert resp.json()["status"] == "ok"

    def test_negative_feedback_returns_200(self, client, sample_knowledge):
        """부정 피드백 제출 시 200을 반환한다."""
        resp = client.post("/api/feedback", json={
            "knowledge_id": sample_knowledge["id"],
            "namespace": TEST_NS,
            "question": "해결 안 된 질문",
            "is_positive": False,
        })
        assert resp.status_code == 201

    def test_feedback_without_knowledge_id(self, client):
        """knowledge_id 없이도 피드백 제출이 가능하다."""
        resp = client.post("/api/feedback", json={
            "namespace": TEST_NS,
            "question": "매핑 안 된 질문",
            "is_positive": False,
        })
        assert resp.status_code == 201


class TestStats:
    def test_stats_returns_structure(self, client):
        """GET /api/stats 가 올바른 구조를 반환한다."""
        resp = client.get("/api/stats")
        assert resp.status_code == 200
        body = resp.json()
        assert "namespaces" in body
        assert "unresolved_cases" in body
        assert isinstance(body["namespaces"], list)
        assert isinstance(body["unresolved_cases"], list)

    def test_stats_namespace_fields(self, client, sample_knowledge):
        """채팅 후 통계에 namespace 집계가 포함된다."""
        # 질의 로그가 없을 수 있으므로 먼저 채팅 1회 실행
        client.post("/api/chat", json={
            "namespace": TEST_NS,
            "question": "통계 테스트용 질문",
            "w_vector": 0.7,
            "w_keyword": 0.3,
            "top_k": 1,
        }, timeout=30.0)

        resp = client.get("/api/stats")
        body = resp.json()
        ns_list = body["namespaces"]
        if ns_list:
            ns = ns_list[0]
            assert "namespace" in ns
            assert "total_queries" in ns
            assert "resolved" in ns
            assert "unresolved" in ns
            assert "positive_feedback" in ns
            assert "negative_feedback" in ns
