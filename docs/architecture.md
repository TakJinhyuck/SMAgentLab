# Ops-Navigator 시스템 아키텍처

## 개요

Ops-Navigator는 IT 운영팀의 반복적인 조회·확인 업무를 자동화하는 **지능형 운영 보조 에이전트**다.
사용자의 자연어 질문을 받아 관련 운영 가이드를 검색하고, LLM이 맥락에 맞는 답변을 생성한다.

---

## 전체 구성도

```
┌─────────────────────────────────────────────────────────────┐
│                        Host Machine                         │
│                                                             │
│   ┌──────────────────────────────────────────────────────┐  │
│   │              Docker Compose Network                  │  │
│   │                                                      │  │
│   │  ┌─────────────┐    ┌─────────────┐                 │  │
│   │  │  Frontend   │───▶│   Backend   │                 │  │
│   │  │  React+nginx│    │   FastAPI   │                 │  │
│   │  │  :8501      │    │   :8000     │                 │  │
│   │  └─────────────┘    └──────┬──────┘                 │  │
│   │                            │                         │  │
│   │                    ┌───────┴────────┐                │  │
│   │                    │   PostgreSQL   │                │  │
│   │                    │  + pgvector    │                │  │
│   │                    │   :5432        │                │  │
│   │                    └───────────────┘                 │  │
│   └──────────────────────────────────────────────────────┘  │
│                                                             │
│   ┌──────────────────────┐                                  │
│   │  Ollama (호스트 직접)  │  ◀── Backend이 host.docker.      │
│   │  exaone3.5:2.4b      │       internal:11434 으로 호출   │
│   │  :11434              │                                  │
│   └──────────────────────┘                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 컴포넌트별 역할

### 1. Frontend — React + Nginx (`:8501`)

| 페이지 | 역할 |
|--------|------|
| **Chat** (`/`) | 운영 보조 챗 — SSE 스트리밍(2-phase: 전처리→generator), 결과 카드, 피드백(👍→few-shot 저장/base_weight 상승), 대화 메모리(요약+리콜) |
| **Admin** (`/admin`) | 관리 화면 — **네임스페이스**, 지식 베이스, 용어집, **Few-shot**, 통계, **파이프라인 디버그**, **LLM 설정** 탭 |

- Backend REST API만 호출 (직접 DB 접근 없음)
- 검색 비중(벡터/키워드 비율), Top-K를 사이드바 슬라이더로 실시간 조정
- nginx 정적 빌드 서빙 + `/api/*` 요청을 Backend(`:8000`)로 프록시

### 2. Backend — FastAPI (`:8000`)

```
backend/
├── main.py              # 앱 진입점, 라이프사이클 (DB풀·임베딩·LLM 초기화)
├── config.py            # 환경변수 기반 설정 (pydantic-settings)
├── database.py          # asyncpg 커넥션 풀 관리
├── models/
│   └── api_models.py    # Pydantic Request/Response 스키마
├── services/
│   ├── embedding.py     # Sentence-Transformers 싱글톤
│   ├── retrieval.py     # 2단계 하이브리드 검색 파이프라인 (용어 매핑 유사도 임계치 0.5)
│   ├── memory.py        # 대화 메모리 관리 (ConversationSummaryBuffer + Semantic Recall)
│   ├── knowledge.py     # 지식/용어집 CRUD + 임베딩 자동 생성
│   └── llm/
│       ├── base.py      # LLMProvider 추상 클래스 + build_messages()
│       ├── ollama.py    # OllamaProvider — /api/chat (multi-turn messages 배열)
│       └── inhouse.py   # InHouseLLMProvider (OpenAI 호환 /v1/chat/completions)
└── routers/
    ├── chat.py          # POST /api/chat, /api/chat/stream, /api/chat/debug
    │                    #   ↳ 대화방 생성/로드, memory 서비스로 컨텍스트 구성 → LLM messages 삽입
    ├── conversations.py # GET/POST /api/conversations, GET /{id}/messages, DELETE /{id}
    ├── knowledge.py     # CRUD /api/knowledge, /api/knowledge/glossary
    ├── feedback.py      # POST /api/feedback (base_weight 조정 + few-shot 저장)
    ├── fewshots.py      # CRUD /api/fewshots, POST /api/fewshots/search (검색 테스트)
    ├── llm_settings.py  # GET/PUT /api/llm/config, POST /api/llm/test (런타임 LLM 전환)
    ├── stats.py         # GET /api/stats, GET /api/stats/namespace/{name}
    └── namespaces.py    # GET/POST/DELETE /api/namespaces, GET /api/namespaces/detail
```

**주요 설계 원칙:**
- **비동기 전용**: asyncpg + httpx async — 블로킹 없는 I/O
- **임베딩 싱글톤**: 앱 시작 시 모델 1회 로드, 이후 thread executor로 재사용
- **LLM Provider 패턴**: `ollama` / `inhouse` 환경변수 하나로 교체 가능
- **GPT 방식 Multi-turn**: `build_messages()`로 system+history+user messages 배열 생성 → Ollama `/api/chat`, InHouse `/v1/chat/completions`에 동일 형식 전달
- **대화 맥락**: ConversationSummaryBuffer + Semantic Recall — 오래된 교환을 LLM으로 요약·벡터 저장, 현재 질문과 유사한 과거 요약 + 최근 2회 raw 교환을 history로 LLM에 전달
- **Graceful Degradation**: LLM 연결 실패 시 검색 결과는 정상 반환, 안내 메시지 출력

### 3. PostgreSQL + pgvector (`:5432`)

```sql
ops_namespace    -- 네임스페이스 레지스트리 (이름, 설명, 생성일)
ops_glossary     -- 용어집: 모호 표현 → 표준 용어 매핑 (HNSW 벡터 인덱스)
ops_knowledge    -- 지식 베이스: 운영 가이드 + SQL 템플릿 (HNSW + GIN FTS 인덱스)
ops_fewshot      -- 긍정 피드백 Q&A 쌍 (LLM 프롬프트 few-shot 삽입용, HNSW 인덱스)
ops_feedback     -- 좋아요/싫어요 피드백 로그
ops_query_log    -- 질의 로그 (namespace, question, status[pending/resolved/unresolved], mapped_term — 업무 유형 분류)
ops_conversation -- 대화방 (namespace, title, created_at)
ops_message      -- 대화 메시지 (conversation_id FK, role, content, mapped_term, results JSONB, status[generating/completed])
ops_conv_summary -- 대화 요약 (conversation_id FK, summary, embedding, turn_start, turn_end — Semantic Recall용)
```

- **HNSW 인덱스** (`vector_cosine_ops`): 벡터 근사 최근접 이웃 검색
- **GIN 인덱스** (`to_tsvector('simple', content)`): 전문 검색(FTS)
- **pg_trgm**: 트리그램 유사도 지원 (활성화됨)
- **namespace 컬럼**: 모든 테이블에서 도메인 격리 (coupon, gift, order 등)

### 4. Ollama — LLM 추론 (`:11434`)

- 호스트 머신에서 직접 실행 (컨테이너 외부)
- 모델: `exaone3.5:2.4b`
- Backend에서 `host.docker.internal:11434`로 접근
- **`/api/chat` 엔드포인트** 사용 (GPT 방식 messages 배열, multi-turn 지원)

---

## 임베딩 모델

| 항목 | 값 |
|------|-----|
| 모델명 | `paraphrase-multilingual-mpnet-base-v2` |
| 벡터 차원 | 768 |
| 한국어 지원 | O |
| 실행 위치 | Backend 컨테이너 내 (CPU) |
| 캐시 볼륨 | `model-cache:/root/.cache/huggingface` |

- Docker 빌드 시 이미지에 모델 사전 다운로드 (컨테이너 시작 지연 없음)
- `normalize_embeddings=True` 적용 → 코사인 유사도 = 내적

---

## API 엔드포인트 목록

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/health` | 서버·LLM 상태 확인 |
| `POST` | `/api/chat` | 하이브리드 검색 + LLM 답변 (JSON) |
| `POST` | `/api/chat/stream` | 하이브리드 검색 + LLM 답변 (SSE 스트리밍, 단계별 status 이벤트) |
| `POST` | `/api/chat/debug` | LLM 없이 검색 파이프라인 전 과정 반환 (v_score, k_score, 용어집 유사도, few-shot 목록, LLM 컨텍스트 미리보기 포함) |
| `GET` | `/api/namespaces` | 등록된 네임스페이스 목록 (문자열 배열) |
| `GET` | `/api/namespaces/detail` | 네임스페이스 상세 목록 (지식 수, 용어집 수 포함) |
| `POST` | `/api/namespaces` | 네임스페이스 신규 생성 |
| `DELETE` | `/api/namespaces/{name}` | 네임스페이스 및 하위 데이터 전체 삭제 |
| `GET` | `/api/knowledge` | 지식 목록 조회 (namespace 필터) |
| `POST` | `/api/knowledge` | 지식 신규 등록 (임베딩 자동 생성) |
| `PUT` | `/api/knowledge/{id}` | 지식 수정 |
| `DELETE` | `/api/knowledge/{id}` | 지식 삭제 |
| `GET` | `/api/knowledge/glossary` | 용어집 목록 |
| `POST` | `/api/knowledge/glossary` | 용어 신규 등록 (임베딩 자동 생성) |
| `PUT` | `/api/knowledge/glossary/{id}` | 용어 수정 (재임베딩 자동) |
| `DELETE` | `/api/knowledge/glossary/{id}` | 용어 삭제 |
| `POST` | `/api/feedback` | 피드백 기록 + base_weight 조정 + few-shot 저장(👍시) |
| `GET` | `/api/fewshots` | Few-shot 목록 조회 (namespace 필터) |
| `POST` | `/api/fewshots` | Few-shot 신규 등록 (임베딩 자동 생성) |
| `PUT` | `/api/fewshots/{id}` | Few-shot 수정 (질문 변경 시 재임베딩) |
| `DELETE` | `/api/fewshots/{id}` | Few-shot 삭제 |
| `POST` | `/api/fewshots/search` | 질문으로 few-shot 검색 테스트 (실제 검색 결과 + 프롬프트 섹션 미리보기) |
| `GET` | `/api/llm/config` | 현재 LLM 프로바이더 설정 + 연결 상태 조회 |
| `PUT` | `/api/llm/config` | LLM 프로바이더 런타임 전환 (재시작 전까지 유지) |
| `POST` | `/api/llm/test` | 설정값으로 연결 테스트 (실제 전환 없음) |
| `GET` | `/api/stats` | 네임스페이스별 통계 (전체 namespace, 지식/용어집 개수 포함) |
| `GET` | `/api/stats/namespace/{name}` | 네임스페이스 상세 통계 (업무 유형별 분포, 미해결 목록) |
| `DELETE` | `/api/stats/query-log/{id}` | 미해결 질의 로그 삭제 (지식 등록 후 처리 완료 표시) |
| `GET` | `/api/conversations` | 네임스페이스별 대화방 목록 (최근 50개) |
| `POST` | `/api/conversations` | 대화방 신규 생성 |
| `GET` | `/api/conversations/{id}/messages` | 대화방 전체 메시지 조회 (status 필드 포함) |
| `DELETE` | `/api/conversations/{id}` | 대화방 삭제 (메시지 cascade) |
| `PATCH` | `/api/chat/messages/{id}/content` | 메시지 부분 저장 (프론트엔드 스트림 중단 시) |
| `DELETE` | `/api/chat/messages/{id}` | Ghost 메시지 삭제 (빈 assistant + 짝 user + 빈 대화방) |

---

## LLM Provider 확장 구조

```python
# services/llm/base.py
def build_messages(context, question, history=None) -> list[dict]:
    # [system: 시스템프롬프트+참고문서] + [history...] + [user: 질문]

class LLMProvider(ABC):
    async def generate(context, question, history=None) -> str: ...
    async def generate_stream(context, question, history=None) -> AsyncIterator[str]: ...
    async def health_check() -> bool: ...

# 현재 구현체
OllamaProvider     # LLM_PROVIDER=ollama — /api/chat (messages 배열, multi-turn)
InHouseLLMProvider # LLM_PROVIDER=inhouse — /v1/chat/completions (messages 배열, multi-turn)
```

**대화 맥락 전달 방식 (ConversationSummaryBuffer + Semantic Recall):**
```
messages = [
  {"role": "system",    "content": "시스템 프롬프트\n\n[참고 문서]\n{검색 결과}"},
  {"role": "system",    "content": "이 대화의 관련 과거 맥락:\n[과거 맥락 1]\n{요약}"},  ← Semantic Recall (유사도 0.45 이상)
  {"role": "user",      "content": "이전 질문"},   ← 최근 2회 raw 교환
  {"role": "assistant", "content": "이전 답변"},
  {"role": "user",      "content": "현재 질문"},
]
```

**메모리 동작 원리:**
- 4회 교환마다 오래된 대화를 LLM으로 요약 → `ops_conv_summary`에 임베딩 저장 (백그라운드)
- 새 질문 시 현재 질문 벡터로 과거 요약 검색 → 유사도 0.45 이상 최대 2개 추출
- 최근 2회 raw 교환은 항상 포함 (working memory)

**런타임 전환 (재시작 없음):**
- Admin → LLM 설정 탭에서 프로바이더 선택/설정 후 "저장 및 적용"
- `switch_provider(config)` 호출 → 싱글톤 교체, `_runtime_config` 전역 저장
- 컨테이너 재시작 시 `.env` 설정으로 복귀
- `get_runtime_config()`: 런타임 override 여부(`is_runtime_override`), 연결 상태(`is_connected`) 포함 반환

새 LLM 추가 시: `LLMProvider` 상속 → 3개 메서드 구현 → `llm/__init__.py` 팩토리에 등록

---

## 환경변수 설정

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DATABASE_URL` | `postgresql://ops:ops1234@postgres:5432/opsdb` | DB 연결 문자열 |
| `LLM_PROVIDER` | `ollama` | `ollama` 또는 `inhouse` |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | Ollama 서버 주소 |
| `OLLAMA_MODEL` | `exaone3.5:2.4b` | 사용할 Ollama 모델명 |
| `OLLAMA_TIMEOUT` | `900` | CPU 추론 최대 대기 시간(초), httpx read timeout에 적용 |
| `INHOUSE_LLM_URL` | (없음) | 사내 LLM API 주소 |
| `INHOUSE_LLM_API_KEY` | (없음) | 사내 LLM API 키 |
| `INHOUSE_LLM_MODEL` | (없음) | 사내 LLM 모델명 |
| `EMBEDDING_MODEL` | `paraphrase-multilingual-mpnet-base-v2` | 임베딩 모델명 |
| `VECTOR_DIM` | `768` | 벡터 차원 수 |
| `DEFAULT_TOP_K` | `5` | 기본 검색 결과 수 |
| `DEFAULT_W_VECTOR` | `0.7` | 기본 벡터 검색 비중 |
| `DEFAULT_W_KEYWORD` | `0.3` | 기본 키워드 검색 비중 |
| `BACKEND_URL` | `http://backend:8000` | Frontend → Backend 주소 |

---

## pgvector 데이터 구성

### 벡터가 쓰이는 테이블

| 테이블 | 벡터 컬럼 | 용도 |
|--------|----------|------|
| `ops_knowledge` | `embedding VECTOR(768)` | 문서 내용 임베딩 → 질문과 코사인 유사도로 관련 문서 검색 |
| `ops_glossary` | `embedding VECTOR(768)` | 용어 설명 임베딩 → 질문과 비교해 표준 용어 자동 매핑 (유사도 0.5 이상만 사용) |
| `ops_fewshot` | `embedding VECTOR(768)` | 과거 질문 임베딩 → 유사 Q&A를 LLM 프롬프트에 few-shot 삽입 (유사도 0.6 이상) |
| `ops_conv_summary` | `embedding VECTOR(768)` | 과거 대화 요약 임베딩 → 현재 질문과 유사한 과거 맥락 Semantic Recall (유사도 0.45 이상) |

### 검색 점수 공식

```
final_score = (w_vec × v_score + w_kw × k_score) × (1 + base_weight)
               └벡터 유사도    └BM25 키워드 점수    └문서 자체 가중치
```

- **v_score**: 코사인 유사도 (0~1) — HNSW 인덱스로 근사 탐색
- **k_score**: `ts_rank` BM25 점수 — GIN 인덱스로 전문 검색
- **base_weight**: `ops_knowledge` 행(문서)에 직접 붙는 가중치. 👍 피드백 시 +0.1, 👎 시 -0.1 자동 조정

### 비벡터 테이블

| 테이블 | 역할 |
|--------|------|
| `ops_namespace` | 도메인 단위 레지스트리 (name, description) |
| `ops_feedback` | 👍/👎 피드백 로그 |
| `ops_query_log` | 질의 이력 — `status`(pending/resolved/unresolved) + `mapped_term`으로 업무 유형 분류 |
| `ops_conversation` | 대화방 (namespace, title, created_at) |
| `ops_message` | 대화 메시지 (role, content, mapped_term, results JSONB, status[generating/completed]) |

> `ops_conv_summary`는 벡터 컬럼 보유 — 위 벡터 테이블 목록 참조.
