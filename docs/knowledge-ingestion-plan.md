# 지식 인제스천 고도화 분석 및 구현 계획

> **Version**: 1.1
> **작성일**: 2026-04-15
> **상태**: Tier 1 구현 진행 중
> **브랜치**: `dev_0`
> **검토자**: Claude (코드 레벨 분석) + Gemini (아키텍처 검토)

---

## 1. 현재 시스템 진단

### 1-1. 현재 지식 등록 아키텍처

```
사용자 (Admin UI - KnowledgeTable.tsx)
  │
  │  1건씩 수동 입력 (textarea)
  │  - content: 텍스트
  │  - container_name: 수동 태깅
  │  - target_tables: 수동 태깅
  │  - category: 드롭다운 선택
  │  - base_weight: 슬라이더 (0~3.0)
  │
  ▼
POST /api/knowledge (router.py)
  │
  ▼
service.create_knowledge()
  │  embedding_service.embed(content) → 768dim vector
  │  INSERT INTO rag_knowledge (1 row)
  ▼
pgvector HNSW index (cosine_ops, m=16, ef_construction=64)
```

### 1-2. 현재 코드 레벨 사실

| 항목 | 현황 | 코드 위치 |
|------|------|-----------|
| **지식 구조** | 1 row = 1 embedding. 청킹 없음 | `service.py:29` — `embed(content)` 전체를 한 번에 |
| **입력 방식** | REST API 1건씩. 벌크/파일 업로드 없음 | `router.py` — POST 1건만 존재 |
| **메타데이터** | container_name, target_tables, category 전부 수동 | `schemas.py:8-15` — KnowledgeCreate |
| **소스 추적** | 없음. 어디서 온 지식인지 알 수 없음 | DB 스키마에 source 필드 부재 |
| **검색** | 하이브리드 (벡터 0.7 + 키워드 0.3) × (1 + base_weight) | `retrieval.py:102-161` |
| **용어집** | 수동 등록 + AI 제안(승인 필요) | `service.py:175-189` |
| **Few-shot** | 수동 등록 + 피드백 좋아요 → candidate | `fewshot/router.py` |
| **카테고리 필터** | `category IS NULL`이면 전체 공유, 있으면 해당 카테고리만 | `retrieval.py:111` |

### 1-3. 핵심 문제점

```
┌─────────────────────────────────────────────────────────────┐
│              검색 파이프라인 (잘 되어 있음)                     │
│                                                             │
│  용어 매핑 → 하이브리드 검색 → Few-shot → LLM 스트리밍        │
│  멀티턴 보강, 시맨틱 캐시, 가중치 피드백 루프                   │
│                                                             │
│  ✅ 아키텍처 성숙도: 높음                                     │
└─────────────────────────────────────────────────────────────┘
                        ▲
                        │  검색할 지식이 부족
                        │
┌─────────────────────────────────────────────────────────────┐
│              지식 등록 파이프라인 (병목)                       │
│                                                             │
│  수동 1건씩 → 청킹 없음 → 메타데이터 수동 → 소스 추적 없음    │
│                                                             │
│  ❌ 현실: 등록이 귀찮아서 시스템이 텅 빈 채로 운영             │
│  ❌ 결론: 검색 엔진이 아무리 좋아도 지식이 없으면 무용지물      │
└─────────────────────────────────────────────────────────────┘
```

**진단 요약**: RAG 성능 = 검색 품질 × 지식의 양과 질. 현재 검색 품질은 충분하나, 지식 등록의 병목이 전체 시스템 가치를 제한하고 있음.

---

## 2. 목표 아키텍처: Automated Ingestion Layer

### 2-1. 전체 흐름도

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Automated Ingestion Layer                        │
│                                                                     │
│  ┌────────────┐    ┌────────────────┐    ┌────────────────┐        │
│  │   Source    │───▶│    Analyzer    │───▶│    Strategy    │        │
│  │  Adapter   │    │     Agent      │    │    Planner     │        │
│  │            │    │                │    │                │        │
│  │ - File     │    │ - 문서 유형     │    │ - 청킹 전략     │        │
│  │ - CSV      │    │ - 도메인 분석   │    │ - 메타데이터    │        │
│  │ - Paste    │    │ - 구조 파악     │    │ - 카테고리      │        │
│  │ - URL      │    │ - 중요도 추정   │    │ - 가중치 추정   │        │
│  └────────────┘    └────────────────┘    └───────┬────────┘        │
│                                                  │                  │
│                                          ┌───────▼────────┐        │
│                                          │    Indexing     │        │
│                                          │    Engine       │        │
│                                          │                │        │
│                                          │ - Chunk 생성    │        │
│                                          │ - Bulk 임베딩   │        │
│                                          │ - pgvector     │        │
│                                          │ - 용어집 자동   │        │
│                                          │ - Q&A 자동 생성 │        │
│                                          └────────────────┘        │
│                                                  │                  │
│                              ┌────────────────────┼──────────┐      │
│                              ▼                    ▼          ▼      │
│                      rag_knowledge         rag_glossary  rag_fewshot│
│                      (bulk insert)         (auto-extract) (auto-gen)│
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  rag_ingestion_job (작업 추적)                                │   │
│  │  - source_file, source_type, status                         │   │
│  │  - total_chunks, created_chunks                             │   │
│  │  - embedding_model, chunk_strategy                          │   │
│  │  - created_at, completed_at                                 │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 2-2. 각 Phase 상세 로직

#### Phase 1: Source Adapter — 다양한 입력 소스 통일

```
지원 포맷:
├── 텍스트: .txt, .md, .log
├── 오피스: .pdf, .docx, .xlsx (.pptx는 추후)
├── 구조화: .csv, .json
├── 웹: URL → 크롤링 (Confluence, Wiki)
└── 직접 입력: 대량 텍스트 붙여넣기

각 어댑터 출력 → 통일 포맷:
{
  "source_type": "pdf",
  "source_name": "운영매뉴얼_v3.pdf",
  "raw_text": "전체 텍스트",
  "sections": [                    // 구조화된 섹션 (있으면)
    { "title": "1. 개요", "content": "...", "level": 1 },
    { "title": "1-1. 배경", "content": "...", "level": 2 }
  ],
  "tables": [                     // 표 데이터 (있으면)
    { "headers": [...], "rows": [[...], [...]] }
  ],
  "metadata": {
    "author": "...", "created_date": "...", "page_count": 42
  }
}
```

**표(Table) 처리 전략** (Gemini 리뷰 반영):
- 표 데이터를 단순 텍스트로 flatten하면 관계 정보 유실
- 표 → Markdown Table 포맷으로 변환하여 구조 보존
- 또는 LLM으로 표의 핵심 내용을 자연어 요약 후 임베딩
- 두 가지를 병행: 원본 테이블(Markdown) + LLM 요약을 각각 chunk로 저장

#### Phase 2: Analyzer Agent — LLM 기반 '선 분석, 후 청킹'

이 설계의 핵심. 일반 RAG는 무조건 고정 크기로 자르지만, 여기서는 LLM이 문서를 먼저 이해합니다.

```
입력: raw_text (처음 3000자 샘플 + 마지막 500자)
  │
  ▼  LLM 1회 호출 (분석용 — 저비용 모델 권장)
┌─────────────────────────────────────────────────────┐
│ 시스템: "문서 분석 전문가. 구조와 도메인을 파악하라."   │
│                                                     │
│ 응답 (JSON):                                         │
│ {                                                   │
│   "doc_type": "operation_manual",                   │
│     // operation_manual, troubleshooting_guide,     │
│     // log_data, api_doc, meeting_notes,            │
│     // tabular_data, faq, mixed                     │
│   "domain": "IT운영/쿠폰시스템",                      │
│   "structure": "hierarchical_sections",              │
│     // hierarchical_sections, flat_paragraphs,      │
│     // log_entries, table_rows, qa_pairs            │
│   "has_tables": true,                               │
│   "has_code_blocks": true,                          │
│   "has_log_patterns": false,                        │
│   "suggested_categories": ["쿠폰", "배치", "장애"],   │
│   "key_terms": [                                    │
│     {"term": "쿠폰회수", "description": "만료 쿠폰 자동 회수 배치"},│
│     {"term": "재처리",   "description": "실패 건 수동 재실행"}     │
│   ],                                                │
│   "priority_score": 0.8,                            │
│     // 0.0~1.0 → base_weight 매핑 (0.5~2.0)         │
│   "chunk_strategy": "section_based",                │
│   "estimated_chunks": 24                            │
│ }                                                   │
└─────────────────────────────────────────────────────┘
```

**중요도 자동 추정** (Gemini 리뷰 반영):
- Analyzer가 `priority_score`를 함께 출력
- 매핑: `base_weight = 0.5 + priority_score * 1.5` → 범위 0.5~2.0
- 관리자가 나중에 수동 조정 가능

**문서 유형별 청킹 전략 매핑:**

| doc_type | structure | chunk_strategy | 설명 |
|----------|-----------|---------------|------|
| operation_manual | hierarchical_sections | `section_based` | ## 헤더 기준 분할 |
| troubleshooting_guide | hierarchical_sections | `section_based` | 문제-원인-해결 단위 |
| log_data | log_entries | `event_based` | 타임스탬프+에러스택 묶음 |
| api_doc | hierarchical_sections | `endpoint_based` | 엔드포인트 단위 |
| tabular_data | table_rows | `row_group` | N행씩 그룹 + 헤더 |
| meeting_notes | flat_paragraphs | `semantic` | 의미 유사도 기반 |
| faq | qa_pairs | `pair_based` | Q-A 쌍 단위 |
| mixed | mixed | `hybrid` | 섹션 + 시맨틱 혼합 |

#### Phase 3: Strategy Planner — 청킹 실행 + 메타데이터 생성

```python
# 의사 코드
class StrategyPlanner:
    def execute(self, analysis: dict, source: dict) -> list[ChunkPlan]:
        strategy = analysis["chunk_strategy"]

        if strategy == "section_based":
            # 마크다운 헤더(##, ###) 또는 줄바꿈 패턴으로 분할
            chunks = self._split_by_sections(source["raw_text"])

        elif strategy == "semantic":
            # 문장 단위 → 임베딩 → 유사도 기반 그룹핑
            sentences = self._split_sentences(source["raw_text"])
            chunks = self._group_by_similarity(sentences, threshold=0.85)

        elif strategy == "event_based":
            # 로그: 타임스탬프+에러스택을 하나의 사건으로 묶음
            chunks = self._split_log_events(source["raw_text"])

        elif strategy == "row_group":
            # 테이블: N행씩 + 컬럼 헤더 포함
            chunks = self._group_table_rows(source["tables"], group_size=20)

        elif strategy == "pair_based":
            # FAQ: Q-A 쌍 단위
            chunks = self._split_qa_pairs(source["raw_text"])

        # 청크 크기 검증 및 보정
        chunks = self._normalize_chunk_sizes(chunks,
            min_tokens=100, max_tokens=800, overlap_ratio=0.2)

        # 각 chunk에 메타데이터 자동 생성
        for i, chunk in enumerate(chunks):
            chunk.source_file = source["source_name"]
            chunk.source_chunk_idx = i
            chunk.source_type = source["source_type"]
            chunk.category = analysis["suggested_categories"][0]
            chunk.container_name = self._extract_system_refs(chunk.text)
            chunk.target_tables = self._extract_table_refs(chunk.text)
            chunk.base_weight = 0.5 + analysis["priority_score"] * 1.5

        return chunks

    def _normalize_chunk_sizes(self, chunks, min_tokens, max_tokens, overlap_ratio):
        """청크 크기 보정: 너무 작으면 병합, 너무 크면 재분할."""
        result = []
        buffer = ""
        for chunk in chunks:
            if len(chunk.text.split()) < min_tokens:
                buffer += "\n" + chunk.text  # 작은 건 병합
            else:
                if buffer:
                    result.append(ChunkPlan(text=buffer.strip(), ...))
                    buffer = ""
                if len(chunk.text.split()) > max_tokens:
                    # 너무 크면 overlap 포함 재분할
                    result.extend(self._split_with_overlap(chunk, max_tokens, overlap_ratio))
                else:
                    result.append(chunk)
        if buffer:
            result.append(ChunkPlan(text=buffer.strip(), ...))
        return result
```

**청킹 사이즈 가이드:**
- 목표: 100~800 토큰 (paraphrase-multilingual-mpnet-base-v2 최적 범위)
- overlap 20%: 앞뒤 chunk 경계의 문맥 유지
- 너무 작으면 → 맥락 손실 (현재는 이 문제 없음 — 청킹 자체가 없으니)
- 너무 크면 → 의미 희석 (현재 문제 — content 전체가 1 embedding)

#### Phase 4: Indexing Engine — 실제 저장

```
ChunkPlan[]
  │
  ├─▶ rag_knowledge BULK INSERT
  │     - content: chunk.text
  │     - embedding: embed_batch(texts)  ← 배치 임베딩 (1건씩이 아님)
  │     - category: 자동 분류
  │     - container_name: 자동 추출
  │     - base_weight: 자동 추정 (priority_score 기반)
  │     - source_file: 원본 파일명 (신규 필드)
  │     - source_chunk_idx: 청크 순번 (신규 필드)
  │     - source_type: 'csv_import' | 'file_upload' | 'auto_chunk' (신규 필드)
  │
  ├─▶ rag_glossary INSERT (자동 추출)
  │     - key_terms → 용어 + 설명 자동 생성
  │     - 기존 용어와 중복 체크 (embedding 유사도 > 0.9 → skip)
  │     - status: 'pending_review' (확신도 낮은 항목은 관리자 승인 대기)
  │
  └─▶ rag_fewshot INSERT (자동 Q&A 생성)
        - LLM으로 "이 지식에서 나올 법한 질문-답변" 생성
        - status: 'candidate' (관리자 승인 대기)
        - knowledge_id: 원본 지식 연결

rag_ingestion_job UPDATE
  - status: 'completed'
  - total_chunks: N
  - created_chunks: N
  - auto_glossary_count: M
  - auto_fewshot_count: K
  - completed_at: NOW()
```

---

## 3. Human-in-the-loop 설계 (Gemini 리뷰 반영)

단순 자동화가 아닌, **관리자 검수 포인트**를 적절히 배치합니다.

### 3-1. 자동 확정 vs 관리자 승인 대기

| 항목 | 자동 확정 | 관리자 승인 대기 | 판단 기준 |
|------|----------|----------------|----------|
| **지식 청크** | O (바로 검색 가능) | - | 원본 문서의 분할이므로 내용 자체는 정확 |
| **카테고리 분류** | O (LLM 확신 > 70%) | O (LLM 확신 ≤ 70%) | Analyzer의 confidence score |
| **용어집** | - | O (항상 관리자 승인) | 도메인 용어는 오분류 리스크 |
| **Few-shot Q&A** | - | O (status='candidate') | 생성된 답변 품질 검증 필요 |
| **base_weight** | O (자동 추정) | △ (관리자 미세 조정) | UI에서 나중에 조정 가능 |

### 3-2. 관리자 검수 UI 흐름

```
[인제스천 완료 알림]
  "운영매뉴얼_v3.pdf → 24개 지식 청크 생성 완료"
  "자동 추출: 용어 5건(승인 대기), Q&A 8건(승인 대기)"
  │
  ├─▶ [지식 탭] 소스별 필터 → 해당 파일의 청크 확인·수정·삭제
  ├─▶ [용어집 탭] pending_review 배지 → 원클릭 승인/반려
  └─▶ [Few-shot 탭] candidate 배지 → 원클릭 승인/반려 (기존 기능)
```

---

## 4. DB 스키마 변경 계획

### 4-1. rag_knowledge 테이블 확장

```sql
-- 소스 추적 필드 추가
ALTER TABLE rag_knowledge ADD COLUMN IF NOT EXISTS source_file VARCHAR(500);
ALTER TABLE rag_knowledge ADD COLUMN IF NOT EXISTS source_chunk_idx INT;
ALTER TABLE rag_knowledge ADD COLUMN IF NOT EXISTS source_type VARCHAR(50) DEFAULT 'manual';
  -- 'manual', 'csv_import', 'file_upload', 'auto_chunk', 'paste_split'
```

### 4-2. 인제스천 작업 추적 테이블 (신규)

```sql
CREATE TABLE IF NOT EXISTS rag_ingestion_job (
  id SERIAL PRIMARY KEY,
  namespace_id INT REFERENCES ops_namespace(id) ON DELETE CASCADE,
  source_file VARCHAR(500),
  source_type VARCHAR(50),            -- csv, pdf, txt, md, paste, url
  status VARCHAR(20) DEFAULT 'processing',
    -- processing, analyzing, chunking, indexing, completed, failed
  total_chunks INT DEFAULT 0,
  created_chunks INT DEFAULT 0,
  auto_glossary_count INT DEFAULT 0,
  auto_fewshot_count INT DEFAULT 0,
  chunk_strategy VARCHAR(50),         -- section_based, semantic, event_based, ...
  embedding_model VARCHAR(200),       -- 사용한 임베딩 모델 정보 (재인덱싱 판단용)
  analyzer_result JSONB,              -- Analyzer Agent의 분석 결과 전체 보관
  error_message TEXT,
  created_by_user_id INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
```

**embedding_model + chunk_strategy 필드** (Gemini 리뷰 반영):
- 나중에 더 좋은 임베딩 모델로 교체하거나 청킹 로직을 업데이트할 때
- "어떤 데이터를 재인덱싱해야 하는가?"를 판단하는 기준
- 예: `WHERE embedding_model != 'new-model'` → 해당 지식만 재임베딩

---

## 5. 피드백 루프: 지식의 선순환 (Gemini 리뷰 반영)

```
                    ┌──────────────────────────┐
                    │   지식 등록 (Ingestion)    │
                    │   파일 업로드 → 자동 청킹   │
                    └───────────┬──────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │   검색 & 답변 (Retrieval)  │
                    │   하이브리드 검색 + LLM     │
                    └───────────┬──────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │   사용자 피드백             │
                    │   👍 좋아요 → base_weight↑  │
                    │   👍 좋아요 → fewshot 후보   │
                    │   검색 miss → 지식 부족 감지 │
                    └───────────┬──────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │   관리자 검수               │
                    │   fewshot 승인/반려         │
                    │   용어집 승인/반려           │
                    │   누락 지식 추가 등록       │
                    └───────────┬──────────────┘
                                │
                                └──────▶ (순환)
```

**검색 miss 감지** (추후 확장):
- 질문에 대해 `knowledge_min_score` 이상의 결과가 0건이면 "미답변" 로그 기록
- 미답변 로그가 특정 키워드/카테고리에 집중되면 → 관리자에게 "이 영역의 지식이 부족합니다" 알림
- 이를 통해 "어떤 문서를 추가로 등록해야 하는지" 데이터 기반 판단

---

## 6. 기술 스택 및 라이브러리

### 6-1. 현재 프로젝트 (Python/FastAPI 기반)

| 용도 | 라이브러리 | 비고 |
|------|-----------|------|
| **PDF 파싱** | `pymupdf` (PyMuPDF) | 페이지별 텍스트+표+이미지 추출. 속도 빠름 |
| **Word/Excel** | `python-docx`, `openpyxl` | .docx 단락 추출, .xlsx 시트별 읽기 |
| **마크다운 파싱** | `markdown-it-py` 또는 정규식 | 헤더 기준 섹션 분할 |
| **CSV** | `csv` (표준 라이브러리) | 이미 사용 가능 |
| **Semantic Chunking** | `sentence-transformers` (기존) | 문장 임베딩 → 유사도 그룹핑 |
| **비동기 처리** | `asyncio.create_task` | 대용량 파일은 백그라운드 처리 |
| **임베딩 배치** | `embedding_service.embed_batch` (기존) | 1건씩이 아닌 배치 임베딩 |

### 6-2. Java/Spring 환경 통합 시 (Gemini 제언 반영)

| 용도 | 라이브러리 | 비고 |
|------|-----------|------|
| **파일 파싱** | Apache Tika | PDF, Office 등 100+ 포맷 지원 |
| **비동기 처리** | Spring Batch / TaskExecutor | 대용량 인제스천 비동기 처리 |
| **LLM 연동** | Spring AI | Analyzer Agent LLM 호출 |
| **벡터 DB** | pgvector + Spring Data JPA | 기존 인프라 활용 |

### 6-3. LLM 비용 최적화

| 단계 | 모델 | 이유 |
|------|------|------|
| **Analyzer (분석)** | 저비용 모델 (GPT-4o mini, Haiku) | 1회 호출, 구조 분석만 |
| **메타데이터 태깅** | 저비용 모델 | 카테고리/용어 추출 |
| **Q&A 생성** | 고품질 모델 (GPT-4o, Sonnet) | 답변 품질이 중요 |
| **검색 시 답변** | 고품질 모델 (기존 설정) | 변경 없음 |

---

## 7. 구현 우선순위 (Tier 분류)

### Tier 1: 즉시 효과, 난이도 낮음 (1~2일)

기존 코드 구조를 최소한으로 확장하여 즉시 체감 가능한 개선.

| # | 기능 | 변경 내용 | 파일 |
|---|------|----------|------|
| **1-1** | CSV/JSON 벌크 임포트 | CSV 업로드 → 파싱 → `create_knowledge` 루프 + `embed_batch` | router.py, service.py, UI 모달 |
| **1-2** | 대량 텍스트 붙여넣기 분할 | `\n\n` 또는 `---` 기준 자동 분할 → 여러 row 등록 | UI 로직 + service |
| **1-3** | 소스 추적 필드 | `source_file`, `source_chunk_idx`, `source_type` 컬럼 | migration + schema |
| **1-4** | 인제스천 작업 테이블 | `rag_ingestion_job` 테이블 생성 | migration |

### Tier 2: 높은 임팩트, 중간 난이도 (3~5일)

파일 업로드 + LLM 자동화. "파일 던지면 지식화" 핵심 UX.

| # | 기능 | 변경 내용 | 파일 |
|---|------|----------|------|
| **2-1** | 파일 업로드 + 섹션 기반 청킹 | PDF/TXT/MD 업로드 → 헤더 기반 분할 → bulk 등록 | 새 endpoint + 파싱 로직 |
| **2-2** | LLM 자동 메타데이터 태깅 | 청크 등록 시 category, container_name 자동 추천 | LLM 1회 호출 |
| **2-3** | 용어집 자동 추출 + 연동 | 인제스천 시 도메인 용어 자동 감지 → pending_review 등록 | service 확장 |
| **2-4** | 인제스천 진행 상태 UI | SSE로 실시간 진행률 표시 + 완료 알림 | 프론트 + SSE |

### Tier 3: 게임체인저, 높은 난이도 (1~2주)

NotebookLM 수준의 지능형 인제스천.

| # | 기능 | 변경 내용 | 파일 |
|---|------|----------|------|
| **3-1** | Analyzer Agent | LLM이 문서 유형/구조 분석 → 최적 청킹 전략 자동 결정 | 새 agent 모듈 |
| **3-2** | Semantic Chunking | 문장 임베딩 → 유사도 기반 그룹핑 (의미 단위 분할) | 청킹 엔진 신규 |
| **3-3** | 자동 Q&A 생성 | 등록 지식에서 LLM이 예상 Q&A → fewshot candidate | LLM + fewshot |
| **3-4** | 로그 패턴 분석 | 타임스탬프+에러스택 사건 단위 청킹 | 로그 파서 신규 |
| **3-5** | 미답변 분석 대시보드 | 검색 miss 로그 → 지식 부족 영역 시각화 | 통계 + UI |

---

## 8. 구현 로드맵

```
Week 1 ─── Tier 1 ────────────────────────────────────────
  │  CSV 벌크 임포트 + 텍스트 자동분할 + 소스 추적 필드
  │  → 즉시 체감: "CSV 파일 하나로 50건 한번에 등록"
  │
Week 2 ─── Tier 2-1, 2-4 ────────────────────────────────
  │  파일 업로드 + 섹션 기반 청킹 + 진행 상태 UI
  │  → 핵심 UX: "PDF 던지면 자동으로 지식화"
  │
Week 3 ─── Tier 2-2, 2-3 ────────────────────────────────
  │  LLM 메타데이터 태깅 + 용어집 자동 추출
  │  → 태깅 수동 작업 제거
  │
Week 4+ ── Tier 3 ────────────────────────────────────────
     Analyzer Agent + Semantic Chunking + Q&A 자동 생성
     → NotebookLM 수준 도달
```

---

## 9. 리더십 보고용 논리

### 9-1. 핵심 메시지

> **기존**: "사람이 지식을 한 줄씩 타이핑해서 AI에 가르침" → **수동 학습**
>
> **고도화**: "문서를 던지면 AI가 스스로 읽고, 핵심을 추출하고, 검색 가능하게 정리" → **동적 학습**

### 9-2. 정량 비교

| 비교 항목 | 현재 (수동) | Tier 1 후 | Tier 2 후 | Tier 3 후 |
|-----------|-----------|----------|----------|----------|
| 지식 1건 등록 시간 | 3~5분 | 0.5분 (벌크) | 자동 | 자동 |
| 100페이지 문서 등록 | 2~3일 (안 함) | 30분 (CSV) | 5분 (업로드) | 2분 |
| 메타데이터 품질 | 사람마다 다름 | 수동 | LLM 일관 태깅 | LLM + 검증 |
| 용어집 관리 | 별도 수동 | 수동 | 자동 추출 | 자동 + 피드백 |
| 시스템 활용률 | 낮음 | 중간 | 높음 | 매우 높음 |

### 9-3. 데이터 자산화 가속도 (Gemini 제언 반영)

> "기존 시스템은 사람이 지식을 넣는 속도에 AI의 성장이 묶여 있었습니다.
> 고도화 후에는 **회사의 데이터가 생성되는 속도**와 **AI의 학습 속도가 동기화**됩니다.
> 100페이지 매뉴얼이 작성되면 5분 안에 AI가 그 내용을 학습합니다.
> 이것이 진정한 의미의 **기업 지능화**입니다."

---

## 10. 리스크 및 대응

| 리스크 | 영향 | 대응 |
|--------|------|------|
| LLM 분석 비용 증가 | 대량 파일 인제스천 시 API 비용 | Analyzer에 저비용 모델 사용, 배치 최적화 |
| 자동 청킹 품질 | 잘못 잘리면 검색 품질 저하 | Human-in-the-loop (관리자 검수 포인트) |
| 임베딩 모델 교체 시 | 기존 벡터와 새 벡터 호환 불가 | `embedding_model` 필드로 추적, 선택적 재인덱싱 |
| 대용량 파일 처리 시간 | 사용자 대기 | 비동기 처리 + SSE 진행률 + 인제스천 작업 추적 |
| 중복 지식 등록 | 같은 파일 재업로드 시 중복 | `source_file` + 유사도 체크로 중복 감지 |

---

## 부록 A: 현재 rag_knowledge 테이블 필드 정의

| 필드 | 타입 | 현재 용도 | 고도화 후 변화 |
|------|------|----------|--------------|
| id | SERIAL PK | 자동 생성 | 변경 없음 |
| namespace_id | INT FK | 네임스페이스 격리 | 변경 없음 |
| container_name | VARCHAR(200) | 수동 태깅 | 자동 추출 (수동 보정 가능) |
| target_tables | TEXT[] | 수동 태깅 | 자동 추출 (수동 보정 가능) |
| content | TEXT | 전체 텍스트 (1 row) | 청킹된 텍스트 (chunk 단위) |
| query_template | TEXT | 수동 SQL 예시 | 변경 없음 |
| embedding | VECTOR(768) | content 전체 임베딩 | chunk 단위 임베딩 |
| base_weight | FLOAT | 수동 설정 | 자동 추정 + 피드백 조정 |
| category | VARCHAR(100) | 수동 선택 | LLM 자동 분류 |
| source_file | VARCHAR(500) | **(신규)** | 원본 파일명 |
| source_chunk_idx | INT | **(신규)** | 원본 내 청크 순번 |
| source_type | VARCHAR(50) | **(신규)** | manual/csv/file/auto/paste |
| created_by_* | | 감사 필드 | 변경 없음 |

## 부록 B: 기존 검색 파이프라인과의 호환성

고도화된 인제스천은 기존 검색 파이프라인에 **변경 없이** 호환됩니다:

- `retrieval.search_knowledge()` → 기존과 동일하게 작동
- 차이점: rag_knowledge에 더 많은 row가, 더 적절한 크기로, 더 좋은 메타데이터와 함께 존재
- category 필터, base_weight 가중치, 용어집 매핑 모두 기존 로직 그대로 활용
- **즉, 검색 코드 수정 없이 지식의 양과 질만 개선하여 전체 RAG 성능 향상**

---

## WBS (Work Breakdown Structure) — 구현 진행 추적

> 작업 완료 시 상태를 업데이트하고, 비고란에 날짜/커밋/특이사항을 기록합니다.

### Tier 1: 즉시 효과 (목표: 1~2일)

| ID | 작업 | 상태 | 변경 파일 | 비고 |
|----|------|------|----------|------|
| **1-1** | **CSV/JSON 벌크 임포트** | | | |
| 1-1-1 | DB 마이그레이션: `source_file`, `source_chunk_idx`, `source_type` 컬럼 추가 | `DONE` | `main.py` | 2026-04-15 |
| 1-1-2 | DB 마이그레이션: `rag_ingestion_job` 테이블 생성 | `DONE` | `main.py` | 2026-04-15 |
| 1-1-3 | Pydantic 스키마에 source 필드 추가 | `DONE` | `knowledge/schemas.py` | BulkCreateRequest, IngestionJobOut 추가 |
| 1-1-4 | 벌크 등록 service 함수 (`bulk_create_knowledge`) | `DONE` | `knowledge/service.py` | embed_batch + job 추적 |
| 1-1-5 | CSV 파싱 + 벌크 등록 API endpoint | `DONE` | `knowledge/router.py` | POST /import/csv (multipart) |
| 1-1-6 | 인제스천 작업 CRUD service | `DONE` | `knowledge/service.py` | list_ingestion_jobs |
| 1-1-7 | 프론트: CSV 임포트 모달 (파일선택 + 컬럼매핑 + 미리보기) | `DONE` | `KnowledgeTable.tsx` | CsvImportModal 컴포넌트 |
| 1-1-8 | 프론트: API 클라이언트 함수 추가 | `DONE` | `api/knowledge.ts` | importCsv, bulkCreate 등 6개 함수 |
| 1-1-9 | 단위 테스트 (벌크 등록, CSV 파싱) | `DONE` | `tests/test_ingestion.py` | 32 TC 전체 통과 |
| **1-2** | **대량 텍스트 붙여넣기 → 자동 분할** | | | |
| 1-2-1 | 텍스트 분할 유틸 함수 (`split_text_to_chunks`) | `DONE` | `knowledge/service.py` | auto/heading/blank_line/separator/none |
| 1-2-2 | 프론트: 텍스트 붙여넣기 모달 (분할 기준 선택 + 미리보기) | `DONE` | `KnowledgeTable.tsx` | TextSplitModal + preview API |
| 1-2-3 | 분할 결과 → bulk_create_knowledge 호출 | `DONE` | `knowledge/router.py` | POST /import/text-split |
| **1-3** | **지식 리스트 소스 표시** | | | |
| 1-3-1 | 기존 리스트 API 응답에 source 필드 포함 | `DONE` | `knowledge/service.py` | SELECT에 source_* 추가 |
| 1-3-2 | 프론트: 소스 뱃지 + 소스 필터 드롭다운 | `DONE` | `KnowledgeTable.tsx` | 📊📋📄 아이콘 뱃지 |
| **1-4** | **인제스천 작업 이력 UI** | | | |
| 1-4-1 | 인제스천 작업 목록 API | `DONE` | `knowledge/router.py` | GET /ingestion-jobs |
| 1-4-2 | 프론트: 작업 이력 패널 (상태, 청크 수, 소요시간) | `DONE` | `KnowledgeTable.tsx` | 최근 5건 표시 |

### Tier 2: 파일 업로드 + LLM 자동화 (목표: 3~5일)

| ID | 작업 | 상태 | 변경 파일 | 비고 |
|----|------|------|----------|------|
| **2-1** | **파일 업로드 + 섹션 기반 청킹** | | | |
| 2-1-1 | 파일 파싱 어댑터 (TXT/MD → 섹션 분할) | `TODO` | 신규: `ingestion/adapters.py` | |
| 2-1-2 | PDF 파싱 어댑터 (pymupdf) | `TODO` | 신규: `ingestion/adapters.py` | 라이브러리 추가 |
| 2-1-3 | 파일 업로드 API endpoint (multipart) | `TODO` | `knowledge/router.py` | |
| 2-1-4 | 청킹 엔진 (섹션/단락/고정크기 전략) | `TODO` | 신규: `ingestion/chunker.py` | |
| 2-1-5 | 프론트: 파일 업로드 모달 (드래그&드롭, 옵션, 미리보기) | `TODO` | `KnowledgeTable.tsx` | |
| **2-2** | **LLM 자동 메타데이터 태깅** | | | |
| 2-2-1 | 메타데이터 추출 LLM 프롬프트 설계 | `TODO` | `ingestion/tagger.py` | |
| 2-2-2 | 청크별 category, container_name 자동 태깅 | `TODO` | `ingestion/tagger.py` | |
| 2-2-3 | base_weight 자동 추정 (priority_score → weight) | `TODO` | `ingestion/tagger.py` | |
| **2-3** | **용어집 자동 추출** | | | |
| 2-3-1 | 인제스천 시 도메인 용어 자동 감지 | `TODO` | `ingestion/tagger.py` | |
| 2-3-2 | 기존 용어 중복 체크 (임베딩 유사도 > 0.9) | `TODO` | `knowledge/service.py` | |
| 2-3-3 | pending_review 상태로 rag_glossary 등록 | `TODO` | `knowledge/service.py` | |
| **2-4** | **인제스천 진행 상태 UI** | | | |
| 2-4-1 | 비동기 인제스천 처리 (asyncio.create_task) | `TODO` | `knowledge/router.py` | |
| 2-4-2 | 진행률 SSE 이벤트 또는 폴링 API | `TODO` | `knowledge/router.py` | |
| 2-4-3 | 프론트: 실시간 진행률 바 + 완료 알림 | `TODO` | `KnowledgeTable.tsx` | |

### Tier 3: 지능형 인제스천 (목표: 1~2주)

| ID | 작업 | 상태 | 변경 파일 | 비고 |
|----|------|------|----------|------|
| **3-1** | **Analyzer Agent** | | | |
| 3-1-1 | 문서 분석 LLM 프롬프트 (유형/구조/도메인/중요도) | `TODO` | 신규: `ingestion/analyzer.py` | |
| 3-1-2 | 분석 결과 → 청킹 전략 자동 결정 로직 | `TODO` | `ingestion/analyzer.py` | |
| 3-1-3 | 프론트: 분석 결과 미리보기 + 전략 수정 UI | `TODO` | `KnowledgeTable.tsx` | |
| **3-2** | **Semantic Chunking** | | | |
| 3-2-1 | 문장 단위 임베딩 → 유사도 기반 그룹핑 | `TODO` | `ingestion/chunker.py` | |
| 3-2-2 | overlap 처리 + 크기 정규화 | `TODO` | `ingestion/chunker.py` | |
| **3-3** | **자동 Q&A 생성** | | | |
| 3-3-1 | 지식 청크 → LLM Q&A 생성 프롬프트 | `TODO` | `ingestion/qa_gen.py` | |
| 3-3-2 | rag_fewshot에 candidate 상태로 등록 | `TODO` | `knowledge/service.py` | |
| **3-4** | **로그 패턴 분석** | `TODO` | 신규: `ingestion/log_parser.py` | |
| **3-5** | **미답변 분석 대시보드** | `TODO` | 통계 + UI | |

### 변경 이력

| 날짜 | 버전 | 작업 ID | 내용 | 커밋 |
|------|------|---------|------|------|
| 2026-04-15 | v1.0 | - | 초기 설계 문서 작성 | - |
| 2026-04-15 | v1.1 | - | WBS 추가, dev_0 브랜치 작업 시작 | `7a2ea81` |
| 2026-04-15 | v1.2 | 1-1 ~ 1-4 | Tier 1 전체 구현 완료 (CSV 임포트, 텍스트 분할, 소스 추적, 작업 이력) | `ef8e5ea` |
| 2026-04-15 | v1.3 | 1-1-9 | 자체 테스트 32 TC 작성 + BOM 처리 버그 수정 + tsc 통과 확인 | - |
