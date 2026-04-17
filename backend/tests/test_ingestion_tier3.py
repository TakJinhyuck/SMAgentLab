"""Tests for Tier 3 — Analyzer Agent + 자동 Q&A 생성."""
import pytest
from unittest.mock import AsyncMock, MagicMock


# ─── Analyzer Agent 테스트 ───────────────────────────────────────────────────

from agents.knowledge_rag.ingestion.analyzer import (
    analyze_document, _validate_and_normalize, _default_result, _parse_json_object,
)


class TestParseJsonObject:
    def test_plain_json(self):
        result = _parse_json_object('{"key": "value"}')
        assert result == {"key": "value"}

    def test_code_block(self):
        result = _parse_json_object('```json\n{"a": 1}\n```')
        assert result == {"a": 1}

    def test_array_raises(self):
        with pytest.raises(ValueError, match="object"):
            _parse_json_object('[1, 2, 3]')

    def test_invalid_raises(self):
        with pytest.raises(Exception):
            _parse_json_object("not json")


class TestValidateAndNormalize:
    def test_valid_strategy_kept(self):
        result = _validate_and_normalize({"chunk_strategy": "section"})
        assert result["chunk_strategy"] == "section"

    def test_invalid_strategy_fallback_by_doc_type(self):
        result = _validate_and_normalize({
            "chunk_strategy": "semantic",
            "doc_type": "operation_manual",
        })
        assert result["chunk_strategy"] == "section"

    def test_unknown_doc_type_fallback_auto(self):
        result = _validate_and_normalize({
            "chunk_strategy": "invalid",
            "doc_type": "unknown_type",
        })
        assert result["chunk_strategy"] == "auto"

    def test_priority_score_clamped(self):
        result = _validate_and_normalize({"priority_score": 1.5})
        assert result["priority_score"] == 1.0

        result = _validate_and_normalize({"priority_score": -0.3})
        assert result["priority_score"] == 0.0

    def test_priority_score_non_numeric(self):
        result = _validate_and_normalize({"priority_score": "high"})
        assert result["priority_score"] == 0.5

    def test_estimated_chunks_non_numeric(self):
        result = _validate_and_normalize({"estimated_chunks": "many"})
        assert result["estimated_chunks"] == 0

    def test_defaults_filled(self):
        result = _validate_and_normalize({})
        assert result["doc_type"] == "mixed"
        assert result["domain"] == ""
        assert result["suggested_categories"] == []
        assert result["key_terms"] == []


class TestAnalyzeDocument:
    @pytest.mark.asyncio
    async def test_success(self):
        llm = MagicMock()
        llm.generate_once = AsyncMock(return_value='{"doc_type": "operation_manual", "domain": "IT운영/쿠폰", "structure": "hierarchical_sections", "has_tables": false, "has_code_blocks": true, "suggested_categories": ["쿠폰"], "key_terms": [{"term": "쿠폰회수", "description": "만료 쿠폰 자동 회수"}], "priority_score": 0.8, "chunk_strategy": "section", "estimated_chunks": 12}')

        result = await analyze_document("## 1. 개요\n쿠폰 시스템..." * 100, llm)
        assert result["doc_type"] == "operation_manual"
        assert result["chunk_strategy"] == "section"
        assert result["priority_score"] == 0.8
        assert len(result["key_terms"]) == 1

    @pytest.mark.asyncio
    async def test_llm_failure_returns_default(self):
        llm = MagicMock()
        llm.generate_once = AsyncMock(side_effect=Exception("LLM down"))

        result = await analyze_document("some text", llm)
        assert result["doc_type"] == "mixed"
        assert result["chunk_strategy"] == "auto"
        assert result["priority_score"] == 0.5

    @pytest.mark.asyncio
    async def test_empty_text_returns_default(self):
        result = await analyze_document("", MagicMock())
        assert result == _default_result()

    @pytest.mark.asyncio
    async def test_invalid_json_returns_default(self):
        llm = MagicMock()
        llm.generate_once = AsyncMock(return_value="This is not JSON at all")

        result = await analyze_document("text", llm)
        assert result["chunk_strategy"] == "auto"


# ─── Q&A 자동 생성 테스트 ────────────────────────────────────────────────────

from agents.knowledge_rag.ingestion.qa_gen import (
    generate_qa_pairs, bulk_generate_qa,
)


class TestGenerateQaPairs:
    @pytest.mark.asyncio
    async def test_success(self):
        llm = MagicMock()
        llm.generate_once = AsyncMock(return_value='[{"question": "쿠폰 회수 배치는 언제 실행되나요?", "answer": "매일 02:00에 자동으로 실행됩니다. 만료된 쿠폰을 회수합니다."}]')

        result = await generate_qa_pairs("쿠폰 회수 배치는 매일 02:00에 실행됩니다..." * 5, llm)
        assert len(result) == 1
        assert "쿠폰" in result[0]["question"]
        assert len(result[0]["answer"]) >= 10

    @pytest.mark.asyncio
    async def test_max_pairs_limit(self):
        llm = MagicMock()
        llm.generate_once = AsyncMock(return_value='[{"question": "첫번째 질문입니다?", "answer": "첫번째 답변 내용이 충분히 길게 작성되었습니다."}, {"question": "두번째 질문입니다?", "answer": "두번째 답변 내용이 충분히 길게 작성되었습니다."}, {"question": "세번째 질문입니다?", "answer": "세번째 답변 내용이 충분히 길게 작성되었습니다."}, {"question": "네번째 질문입니다?", "answer": "네번째 답변 내용이 충분히 길게 작성되었습니다."}]')

        result = await generate_qa_pairs("long content " * 50, llm, max_pairs=2)
        assert len(result) == 2

    @pytest.mark.asyncio
    async def test_short_content_returns_empty(self):
        result = await generate_qa_pairs("짧음", MagicMock())
        assert result == []

    @pytest.mark.asyncio
    async def test_empty_content_returns_empty(self):
        result = await generate_qa_pairs("", MagicMock())
        assert result == []

    @pytest.mark.asyncio
    async def test_llm_failure_returns_empty(self):
        llm = MagicMock()
        llm.generate_once = AsyncMock(side_effect=Exception("fail"))
        result = await generate_qa_pairs("content " * 50, llm)
        assert result == []

    @pytest.mark.asyncio
    async def test_invalid_pairs_filtered(self):
        """짧은 question/answer는 필터링됨."""
        llm = MagicMock()
        llm.generate_once = AsyncMock(return_value='[{"question": "Q?", "answer": "A"}, {"question": "정상적인 질문입니다?", "answer": "정상적인 답변 내용입니다. 충분히 길게 작성합니다."}]')

        result = await generate_qa_pairs("content " * 50, llm)
        # "Q?" (5자 미만) + "A" (10자 미만) → 필터링, 정상 건만 남음
        assert len(result) == 1
        assert "정상" in result[0]["question"]


class TestBulkGenerateQa:
    @pytest.mark.asyncio
    async def test_multiple_chunks(self):
        call_count = {"n": 0}
        async def mock_generate(*args, **kwargs):
            call_count["n"] += 1
            return f'[{{"question": "Q{call_count["n"]}에 대한 질문?", "answer": "A{call_count["n"]}에 대한 충분히 긴 답변입니다."}}]'

        llm = MagicMock()
        llm.generate_once = AsyncMock(side_effect=mock_generate)

        chunks = [
            {"idx": 0, "content": "청크 1 내용 " * 20},
            {"idx": 1, "content": "청크 2 내용 " * 20},
        ]
        result = await bulk_generate_qa(chunks, llm)
        assert len(result) == 2
        assert result[0]["chunk_idx"] == 0
        assert result[1]["chunk_idx"] == 1

    @pytest.mark.asyncio
    async def test_empty_chunks(self):
        result = await bulk_generate_qa([], MagicMock())
        assert result == []
