# Ops-Navigator 시스템 흐름도

## 1. 질문 처리 전체 흐름

```
사용자
  │
  │  자연어 질문 입력
  │  "쿠폰 뺏어오기 실패한 건 어떻게 확인해?"
  ▼
┌─────────────────────┐
│  Streamlit Frontend │
│  (1_Chat.py)        │
│                     │
│  - namespace 선택    │
│  - 벡터/키워드 비중  │
│  - Top-K 설정       │
└────────┬────────────┘
         │  POST /api/chat
         │  { namespace, question, w_vector, w_keyword, top_k }
         ▼
┌─────────────────────────────────────────────────────────────┐
│  FastAPI Backend                                            │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Step 1: Semantic Glossary Mapping                  │   │
│  │                                                     │   │
│  │  질문 텍스트                                         │   │
│  │      │                                              │   │
│  │      ▼                                              │   │
│  │  EmbeddingService.embed()                           │   │
│  │  "쿠폰 뺏어오기 실패한 건 어떻게 확인해?"            │   │
│  │      │  → vector [0.12, -0.34, ...] (768차원)       │   │
│  │      ▼                                              │   │
│  │  ops_glossary 벡터 유사도 검색                       │   │
│  │  SELECT term ORDER BY embedding <=> $query_vec      │   │
│  │      │  → mapped_term: "회수"                       │   │
│  │      ▼                                              │   │
│  │  enriched_query = "쿠폰 뺏어오기 실패한 건 어떻게 확인해? 회수"  │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Step 2: Weighted Hybrid Search                     │   │
│  │                                                     │   │
│  │  enriched_query 임베딩                              │   │
│  │      │                                              │   │
│  │      ├──────────────────────────────────────────┐  │   │
│  │      │ Vector Search                            │  │   │
│  │      │ 1 - (embedding <=> query_vec)            │  │   │
│  │      │ → v_score (0~1, 코사인 유사도)            │  │   │
│  │      │                                          │  │   │
│  │      │ Keyword Search                           │  │   │
│  │      │ ts_rank(to_tsvector, plainto_tsquery)    │  │   │
│  │      │ → k_score (BM25 기반 TF-IDF)             │  │   │
│  │      ▼                                          │  │   │
│  │  final_score = (w_vec × v_score + w_kw × k_score) │  │
│  │               × (1 + base_weight)              │  │   │
│  │                                                │  │   │
│  │  ORDER BY final_score DESC LIMIT top_k         │  │   │
│  └─────────────────────────────────────────────────┘   │   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Step 3: LLM 답변 생성                              │   │
│  │                                                     │   │
│  │  build_context(results)                             │   │
│  │  → 검색된 문서들을 프롬프트 형식으로 포맷             │   │
│  │                                                     │   │
│  │  OllamaProvider.generate(context, question)         │   │
│  │  POST http://host.docker.internal:11434/api/generate│   │
│  │  model: exaone3.5:7.8b                              │   │
│  │  → LLM 답변 텍스트                                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ops_query_log에 질의 기록 (namespace, question, resolved)  │
└─────────────────────────────────────────────────────────────┘
         │
         │  ChatResponse { question, mapped_term, results[], answer }
         ▼
┌─────────────────────┐
│  Streamlit Frontend │
│                     │
│  - 용어 매핑 표시    │
│  - 결과 카드 렌더링  │
│    (컨테이너, 테이블, SQL) │
│  - AI 답변 출력     │
│  - 👍/👎 피드백 버튼 │
└─────────────────────┘
```

---

## 2. 벡터 DB (pgvector) 동작 원리

### 임베딩이란

텍스트를 768개의 숫자 배열(벡터)로 변환한 것이다.
의미가 비슷한 텍스트일수록 벡터 공간에서 가까운 위치에 배치된다.

```
"쿠폰 회수"     → [0.12, -0.34, 0.87, ...]  ─┐ 벡터 공간에서 가깝다
"쿠폰 강제 반납" → [0.11, -0.31, 0.89, ...]  ─┘

"배송 조회"     → [-0.54, 0.22, -0.11, ...]  ─ 위와 멀다
```

### 저장 구조

```
ops_knowledge 테이블
┌────┬───────────┬─────────────────────────┬──────────────────────────────┐
│ id │ namespace │ content                 │ embedding (VECTOR 768)       │
├────┼───────────┼─────────────────────────┼──────────────────────────────┤
│  1 │ coupon    │ "쿠폰 강제 회수 처리..."  │ [0.12, -0.34, 0.87, ... 768개] │
│  2 │ coupon    │ "쿠폰 발급 오류 대응..."  │ [0.23,  0.11, 0.45, ... 768개] │
│  3 │ gift      │ "선물 발송 실패 처리..."  │ [-0.05, 0.67, 0.31, ... 768개] │
└────┴───────────┴─────────────────────────┴──────────────────────────────┘
                                                         ▲
                                                HNSW 인덱스로 빠른 검색
```

### HNSW 인덱스 (Hierarchical Navigable Small World)

```
전체 벡터 중 가장 유사한 것 찾기 = ANN(Approximate Nearest Neighbor)

인덱스 없이:  모든 문서와 거리 계산 → O(N) → 문서 수 늘수록 느려짐
HNSW 사용:    계층적 그래프 탐색    → O(log N) → 수십만 문서도 빠름

인덱스 생성:
CREATE INDEX ON ops_knowledge USING hnsw (embedding vector_cosine_ops);
→ vector_cosine_ops: 코사인 거리 기준으로 인덱스 구성
```

### 코사인 유사도 계산

```
거리 = embedding <=> query_vector      (pgvector 연산자)
점수 = 1 - 거리                         (유사도: 1에 가까울수록 비슷)

normalize_embeddings=True 적용 시:
  모든 벡터의 크기(norm) = 1
  → 코사인 유사도 = 내적 = 1 - L2거리 (수학적으로 동일)
  → 계산이 더 빠르고 안정적
```

### 지식 등록 시 임베딩 생성

```
관리자 지식 등록
  │  content = "쿠폰 강제 회수 처리 방법은..."
  ▼
EmbeddingService.embed(content)
  │  SentenceTransformer("paraphrase-multilingual-mpnet-base-v2")
  │  → 모델이 텍스트를 768차원 공간에 매핑
  │  → normalize_embeddings=True 적용
  ▼
[0.12, -0.34, 0.87, 0.45, -0.22, ...] (768개 float)
  │
  ▼
INSERT INTO ops_knowledge (content, embedding, ...)
  │
  ▼
HNSW 인덱스에 자동 반영 → 즉시 검색 가능
```

---

## 3. 용어집 등록 및 검색 반영 흐름

### 용어집이 필요한 이유

같은 의미라도 사람마다 다르게 표현한다:

```
실제 시스템 용어: "회수"
사용자 표현:
  - "뺏어오기"
  - "강제 반납"
  - "쿠폰 취소"
  - "발급 취소"

→ "뺏어오기"로 검색하면 "회수"가 포함된 문서를 못 찾을 수 있음
→ 용어집이 이를 브리지함
```

### 용어 등록 흐름

```
관리자
  │  { namespace: "coupon", term: "회수",
  │    description: "쿠폰 회수, 뺏어오기, 강제 반납, 강제 취소 등..." }
  ▼
POST /api/knowledge/glossary
  │
  ▼
knowledge.py
  │  1. EmbeddingService.embed(description)
  │     description의 의미 벡터 생성
  │     (용어 자체가 아닌 설명 전체를 임베딩 → 다양한 표현 포괄)
  │
  │  2. INSERT INTO ops_glossary
  │     (namespace, term, description, embedding)
  ▼
ops_glossary 테이블
┌────┬───────────┬───────┬───────────────────────────────┬───────────┐
│ id │ namespace │ term  │ description                   │ embedding │
├────┼───────────┼───────┼───────────────────────────────┼───────────┤
│  1 │ coupon    │ 회수  │ "쿠폰 회수, 뺏어오기, 강제..."  │ [...]     │
│  2 │ coupon    │ 발급  │ "쿠폰 지급, 발행, 부여..."       │ [...]     │
└────┴───────────┴───────┴───────────────────────────────┴───────────┘
```

### 검색 시 용어 매핑 흐름

```
사용자 질문: "쿠폰 뺏어오기 실패한 거 어떻게 확인해?"
  │
  ▼
질문 임베딩 생성
  "쿠폰 뺏어오기 실패한 거 어떻게 확인해?" → query_vec [...]
  │
  ▼
ops_glossary 벡터 검색 (namespace 필터)
  SELECT term FROM ops_glossary
  WHERE namespace = 'coupon'
  ORDER BY embedding <=> query_vec
  LIMIT 1
  │
  │  "뺏어오기"와 "회수" 설명의 벡터가 가장 가까움
  ▼
  mapped_term = "회수"
  │
  ▼
검색어 강화 (Query Enrichment)
  enriched_query = "쿠폰 뺏어오기 실패한 거 어떻게 확인해? 회수"
  │             ← 원본 질문 + 표준 용어 추가
  ▼
강화된 쿼리로 ops_knowledge 하이브리드 검색
  → "회수" 키워드가 포함된 문서 우선 반환
  → 결과 카드에 "🔤 용어 매핑: 회수" 표시
```

### 용어집이 없을 때 vs 있을 때

```
용어집 없음:
  질문: "뺏어오기"
  검색어: "쿠폰 뺏어오기 실패한 거 어떻게 확인해?" (원본만)
  → "뺏어오기" 단어가 지식에 없으면 키워드 매치 실패
  → 벡터 유사도만으로 부족할 수 있음

용어집 있음:
  질문: "뺏어오기"
  검색어: "쿠폰 뺏어오기 실패한 거 어떻게 확인해? 회수" (강화됨)
  → "회수" 키워드가 지식에 매치
  → 벡터 + 키워드 모두 높은 점수
  → 정확한 결과 반환
```

---

## 6. 지식 등록 흐름

```
관리자
  │
  │  지식 등록 폼 입력
  │  { namespace, container_name, target_tables, content, query_template, base_weight }
  ▼
┌─────────────────────┐
│  Admin (2_Admin.py) │
└────────┬────────────┘
         │  POST /api/knowledge
         ▼
┌─────────────────────────────────────────┐
│  knowledge.py (서비스 레이어)            │
│                                         │
│  1. EmbeddingService.embed(content)     │
│     → 768차원 벡터 생성                  │
│                                         │
│  2. INSERT INTO ops_knowledge           │
│     (content, embedding, base_weight, …)│
│                                         │
│  3. Return KnowledgeOut                 │
└─────────────────────────────────────────┘
         │
         │  { id, namespace, content, embedding, ... }
         ▼
┌─────────────────────┐
│  Admin              │
│  "등록 완료! (ID: 3)"│
└─────────────────────┘
```

---

## 5. 통계 수집 전체 사이클

### 질의 → 로그 → 피드백 → 통계 흐름

```
① 사용자 질문
   │
   ▼
POST /api/chat
   │
   ▼
검색 수행 (hybrid_search)
   │  results = [문서1, 문서2, ...]
   │
   ▼
ops_query_log INSERT
   ┌───────────────────────────────────────────────────────┐
   │ namespace  │ question          │ resolved │ created_at │
   ├───────────────────────────────────────────────────────┤
   │ coupon     │ "쿠폰 뺏어오기..."  │ TRUE     │ 2024-01-15 │
   │            │  (검색 결과 있음)  │          │            │
   ├───────────────────────────────────────────────────────┤
   │ gift       │ "알 수 없는 오류"  │ FALSE    │ 2024-01-15 │
   │            │  (검색 결과 없음)  │          │            │
   └───────────────────────────────────────────────────────┘
   resolved = TRUE   : 검색 결과가 1건 이상 반환됨
   resolved = FALSE  : 검색 결과 0건 (지식 없음)

② 사용자 피드백 (품질 자동 개선)

   👍 좋아요 클릭
   │
   ▼  POST /api/feedback { knowledge_id, is_positive: true, answer: "AI 답변 텍스트" }
   │
   ├─ ops_feedback INSERT  (로그)
   ├─ UPDATE ops_knowledge SET base_weight = LEAST(base_weight + 0.1, 5.0)
   │   WHERE id = knowledge_id
   │   → 이 문서가 이후 동일 주제 검색에서 더 높은 점수를 받음 (검색 랭킹 상승)
   └─ INSERT INTO ops_fewshot (namespace, question, answer, knowledge_id, embedding)
       → 질문 임베딩 생성 후 저장
       → 다음 유사 질문 시 LLM 프롬프트에 "[과거 유사 질문 답변 사례]"로 자동 삽입

   👎 싫어요 클릭
   │
   ▼  POST /api/feedback { knowledge_id, is_positive: false }
   │
   ├─ ops_feedback INSERT  (로그)
   ├─ UPDATE ops_knowledge SET base_weight = GREATEST(base_weight - 0.1, 0.0)
   │   → 이 문서가 이후 검색에서 낮은 점수를 받음 (검색 랭킹 하락)
   └─ UPDATE ops_query_log SET resolved = FALSE
       → "결과는 나왔지만 내용이 틀렸음" → 미해결로 재분류
       → 통계 대시보드 미해결 케이스에 표시

③ Few-shot 활용 흐름

   다음 사용자가 유사한 질문 입력
   │
   ▼  질문 임베딩 생성 → query_vec
   │
   ▼  ops_fewshot 벡터 검색 (유사도 ≥ 0.6, 최대 2건)
   │   SELECT question, answer FROM ops_fewshot
   │   WHERE namespace = ? AND 1-(embedding <=> query_vec) >= 0.6
   │   ORDER BY embedding <=> query_vec LIMIT 2
   │
   ▼  LLM 프롬프트 구성
   │   [과거 유사 질문 답변 사례]
   │   Q: "쿠폰 뺏어오기 실패한 건 어떻게 확인해?"
   │   A: "ops_feedback 테이블에서 is_positive=false 건을 조회하세요..."
   │
   │   [참고 문서]
   │   --- 문서 1 (점수: 0.8432) ---
   │   ...
   │
   ▼  LLM이 과거 좋은 답변 패턴을 참고하여 더 나은 답변 생성

④ 통계 집계
   │  Admin > 통계 탭 클릭
   ▼
GET /api/stats
   │  WITH all_ns (ops_namespace UNION ops_knowledge UNION ops_glossary)
   │  LEFT JOIN q_agg  (질의 수, 해결/미해결)
   │  LEFT JOIN fb_agg (좋아요/싫어요 수)
   │  LEFT JOIN k_agg  (지식 문서 수)
   │  LEFT JOIN g_agg  (용어집 항목 수)
   ▼

⑤ 대시보드 렌더링
   │
   ├─ KPI 카드  (총 질의 수 / 전체 해결률 / 만족도 % / 미해결 건수)
   ├─ 지식 베이스 현황 테이블  (namespace별 지식·용어집 개수)
   ├─ 질의 처리 현황  (해결 vs 미해결 스택 바차트)
   ├─ 피드백 현황    (👍/👎 그룹 바차트 + 만족도 텍스트 바)
   └─ 미해결 케이스 목록  (지식 보완 가이드 + 취약 namespace 자동 알림)

⑤ 미해결 케이스 → 지식 보완 사이클

   미해결 케이스 확인
      │
      ├─ 해당 질문 유형의 지식 없음 → 지식 베이스에 신규 등록
      ├─ 지식 있지만 내용 부족     → 기존 지식 수정
      └─ 용어 표현 문제            → 용어집에 유의어 추가
      │
      ▼
   다음 동일 질문에서 resolved = TRUE 로 기록
```

### 해결률이 낮을 때 체크리스트

```
해결률 = resolved 건수 / total_queries × 100

낮은 경우 원인:
  1. 해당 namespace에 지식 등록 부족
     → Admin > 지식 베이스에서 신규 등록

  2. 용어 표현 불일치
     → Admin > 용어집에 유의어 추가

  3. 질문 패턴이 기존 지식과 의미적으로 멀리 떨어짐
     → 해당 표현을 그대로 포함한 지식 등록
     → 또는 벡터 비중 낮추고 키워드 비중 높임 (슬라이더)
```

---

## 7. SSE 스트리밍 응답 흐름 (`/api/chat/stream`)

백엔드가 파이프라인 각 단계에 진입할 때마다 `status` 이벤트를 먼저 발행하므로,
프론트엔드는 실시간으로 현재 단계를 표시할 수 있다.

```
Frontend (st.status 박스)          Backend event_generator()
─────────────────────────          ──────────────────────────────────────────

                           ◀──── data: {"type":"status","step":"embedding",
"🔍 질문 임베딩 생성 중..."              "message":"🔍 질문 임베딩 생성 중..."}
                                   │  await embedding_service.embed(question)
                                   ▼
                           ◀──── data: {"type":"status","step":"glossary",
"📖 용어집 매핑 중..."                  "message":"📖 용어집에서 표준 용어 매핑 중..."}
                                   │  await map_glossary_term(...)
                                   ▼
                           ◀──── data: {"type":"status","step":"search",
"🔎 하이브리드 검색 중..."              "message":"🔎 하이브리드 검색 중..."}
                                   │  await search_knowledge(...)
                                   ▼
                           ◀──── data: {"type":"meta","mapped_term":"회수",
[결과 카드 즉시 렌더링]                  "results":[...]}
                                   ▼
                           ◀──── data: {"type":"status","step":"llm",
"🤖 AI 답변 생성 중..."                 "message":"🤖 AI 답변 생성 중..."}
                                   │  get_llm_provider().generate_stream(...)
                                   ▼
                           ◀──── data: {"type":"token","data":"쿠폰"}
[답변 텍스트 스트리밍 출력]    ◀──── data: {"type":"token","data":" 회수"}
                                   ...
                           ◀──── data: {"type":"done"}
✅ 완료 — N건 검색됨
```

**이벤트 타입 요약:**

| type | 발행 시점 | 프론트엔드 처리 |
|------|----------|---------------|
| `status` | 각 단계 진입 시 | `st.status` 박스 메시지 갱신 |
| `meta` | 검색 완료 후 | 결과 카드(컨테이너/테이블/SQL) 즉시 렌더링 |
| `token` | LLM 토큰마다 | 답변 영역에 토큰 누적 출력 |
| `done` | 모든 처리 완료 | status 박스 "완료" 상태로 닫힘, 피드백 버튼 활성화 |

---

## 8. 하이브리드 검색 점수 계산 상세

```
입력:
  w_vector = 0.7   (벡터 비중, 사용자 슬라이더)
  w_keyword = 0.3  (키워드 비중, 자동 보완)
  base_weight = 1.0 (문서별 가중치)

벡터 점수 (v_score):
  코사인 유사도 = 1 - cosine_distance
  범위: 0.0 ~ 1.0
  → 의미가 유사할수록 높음

키워드 점수 (k_score):
  ts_rank(FTS 벡터, 검색어)
  범위: 0.0 ~ (이론상 무제한, 보통 0~0.1)
  → 정확한 단어 매치일수록 높음

최종 점수:
  final_score = (0.7 × v_score + 0.3 × k_score) × (1 + base_weight)
              = (0.7 × v_score + 0.3 × k_score) × 2.0  (base_weight=1.0 기본값)

필터 조건:
  - v_score IS NOT NULL OR k_score IS NOT NULL
  → 완전히 관련 없는 문서는 제외
  → 벡터 또는 키워드 중 하나라도 매치된 경우만 반환
```

---

## 9. LLM Provider 전환 흐름

```
.env 또는 환경변수
  LLM_PROVIDER=ollama   →  OllamaProvider
                             POST :11434/api/generate

  LLM_PROVIDER=inhouse  →  InHouseLLMProvider
                             POST {INHOUSE_LLM_URL}/v1/chat/completions
                             Authorization: Bearer {INHOUSE_LLM_API_KEY}

신규 LLM 추가 시:
  1. services/llm/new_llm.py 생성
     class NewLLMProvider(LLMProvider):
         async def generate(...): ...
         async def generate_stream(...): ...
         async def health_check(...): ...

  2. services/llm/__init__.py 팩토리에 등록
     elif settings.llm_provider == "new_llm":
         _provider = NewLLMProvider()

  3. 환경변수 LLM_PROVIDER=new_llm 설정
```
