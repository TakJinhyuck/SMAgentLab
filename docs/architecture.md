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
│   │  │  Streamlit  │    │   FastAPI   │                 │  │
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
│   │  exaone3.5:7.8b      │       internal:11434 으로 호출   │
│   │  :11434              │                                  │
│   └──────────────────────┘                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 컴포넌트별 역할

### 1. Frontend — Streamlit (`:8501`)

| 페이지 | 역할 |
|--------|------|
| `1_Chat.py` | 운영 보조 챗 — SSE 스트리밍, 단계별 진행 상태(`st.status`), 결과 카드, 피드백(👍→few-shot 저장/base_weight 상승) |
| `2_Admin.py` | 관리 화면 — **네임스페이스 관리**, 지식/용어집 CRUD, 통계 대시보드(KPI 카드+미해결 가이드), **벡터 검색 테스트** |

- Backend REST API만 호출 (직접 DB 접근 없음)
- 검색 비중(벡터/키워드 비율), Top-K를 사이드바 슬라이더로 실시간 조정
- `BACKEND_URL` 환경변수로 Backend 주소 설정

### 2. Backend — FastAPI (`:8000`)

```
backend/
├── main.py              # 앱 진입점, 라이프사이클 (DB풀·임베딩·LLM 초기화)
├── config.py            # 환경변수 기반 설정 (pydantic-settings)
├── database.py          # asyncpg 커넥션 풀 관리
├── models/
│   ├── api_models.py    # Pydantic Request/Response 스키마
│   └── db_models.py     # DB 결과 매핑 dataclass
├── services/
│   ├── embedding.py     # Sentence-Transformers 싱글톤
│   ├── retrieval.py     # 2단계 하이브리드 검색 파이프라인
│   ├── knowledge.py     # 지식/용어집 CRUD + 임베딩 자동 생성
│   └── llm/
│       ├── base.py      # LLMProvider 추상 클래스 + build_messages() (GPT 방식 messages 배열)
│       ├── ollama.py    # OllamaProvider — /api/chat (multi-turn messages 배열)
│       └── inhouse.py   # InHouseLLMProvider (OpenAI 호환 /v1/chat/completions)
└── routers/
    ├── chat.py          # POST /api/chat, /api/chat/stream, /api/chat/debug
    │                    #   ↳ 대화방 생성/로드, 최근 2회 교환 history → LLM messages 삽입
    ├── conversations.py # GET/POST /api/conversations, GET /{id}/messages, DELETE /{id}
    ├── knowledge.py     # CRUD /api/knowledge, /api/knowledge/glossary
    ├── feedback.py      # POST /api/feedback (base_weight 조정 + few-shot 저장)
    ├── stats.py         # GET /api/stats, GET /api/stats/namespace/{name}
    └── namespaces.py    # GET/POST/DELETE /api/namespaces, GET /api/namespaces/detail
```

**주요 설계 원칙:**
- **비동기 전용**: asyncpg + httpx async — 블로킹 없는 I/O
- **임베딩 싱글톤**: 앱 시작 시 모델 1회 로드, 이후 thread executor로 재사용
- **LLM Provider 패턴**: `ollama` / `inhouse` 환경변수 하나로 교체 가능
- **GPT 방식 Multi-turn**: `build_messages()`로 system+history+user messages 배열 생성 → Ollama `/api/chat`, InHouse `/v1/chat/completions`에 동일 형식 전달
- **대화 맥락**: 최근 2회 교환(4메시지)을 history로 LLM에 전달, DB에 전체 이력 보관
- **Graceful Degradation**: LLM 연결 실패 시 검색 결과는 정상 반환, 안내 메시지 출력

### 3. PostgreSQL + pgvector (`:5432`)

```sql
ops_namespace    -- 네임스페이스 레지스트리 (이름, 설명, 생성일)
ops_glossary     -- 용어집: 모호 표현 → 표준 용어 매핑 (HNSW 벡터 인덱스)
ops_knowledge    -- 지식 베이스: 운영 가이드 + SQL 템플릿 (HNSW + GIN FTS 인덱스)
ops_fewshot      -- 긍정 피드백 Q&A 쌍 (LLM 프롬프트 few-shot 삽입용, HNSW 인덱스)
ops_feedback     -- 좋아요/싫어요 피드백 로그
ops_query_log    -- 질의 로그 (namespace, question, resolved, mapped_term — 업무 유형 분류)
ops_conversation -- 대화방 (namespace, title, created_at)
ops_message      -- 대화 메시지 (conversation_id FK, role, content, mapped_term, results JSONB)
```

- **HNSW 인덱스** (`vector_cosine_ops`): 벡터 근사 최근접 이웃 검색
- **GIN 인덱스** (`to_tsvector('simple', content)`): 전문 검색(FTS)
- **pg_trgm**: 트리그램 유사도 지원 (활성화됨)
- **namespace 컬럼**: 모든 테이블에서 도메인 격리 (coupon, gift, order 등)

### 4. Ollama — LLM 추론 (`:11434`)

- 호스트 머신에서 직접 실행 (컨테이너 외부)
- 모델: `exaone3.5:7.8b`
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
| `POST` | `/api/chat/debug` | LLM 없이 검색 파이프라인 전 과정 반환 (v_score, k_score, 용어집 유사도 포함) |
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
| `GET` | `/api/stats` | 네임스페이스별 통계 (전체 namespace, 지식/용어집 개수 포함) |
| `GET` | `/api/stats/namespace/{name}` | 네임스페이스 상세 통계 (업무 유형별 분포, 미해결 목록) |
| `DELETE` | `/api/stats/query-log/{id}` | 미해결 질의 로그 삭제 (지식 등록 후 처리 완료 표시) |
| `GET` | `/api/conversations` | 네임스페이스별 대화방 목록 (최근 50개) |
| `POST` | `/api/conversations` | 대화방 신규 생성 |
| `GET` | `/api/conversations/{id}/messages` | 대화방 전체 메시지 조회 |
| `DELETE` | `/api/conversations/{id}` | 대화방 삭제 (메시지 cascade) |

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

**대화 맥락 전달 방식 (GPT 방식):**
```
messages = [
  {"role": "system",    "content": "시스템 프롬프트\n\n[참고 문서]\n{검색 결과}"},
  {"role": "user",      "content": "이전 질문 1"},   ← history (최근 2회)
  {"role": "assistant", "content": "이전 답변 1"},
  {"role": "user",      "content": "현재 질문"},
]
```

새 LLM 추가 시: `LLMProvider` 상속 → 3개 메서드 구현 → `llm/__init__.py` 팩토리에 등록

---

## 환경변수 설정

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DATABASE_URL` | `postgresql://ops:ops1234@postgres:5432/opsdb` | DB 연결 문자열 |
| `LLM_PROVIDER` | `ollama` | `ollama` 또는 `inhouse` |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | Ollama 서버 주소 |
| `OLLAMA_MODEL` | `exaone3.5:7.8b` | 사용할 Ollama 모델명 |
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
| `ops_glossary` | `embedding VECTOR(768)` | 용어 설명 임베딩 → 질문과 비교해 표준 용어 자동 매핑 |
| `ops_fewshot` | `embedding VECTOR(768)` | 과거 질문 임베딩 → 유사 Q&A를 LLM 프롬프트에 few-shot 삽입 |

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
| `ops_query_log` | 질의 이력 — `mapped_term` 컬럼으로 업무 유형 분류 |
| `ops_conversation` | 대화방 (namespace, title, created_at) |
| `ops_message` | 대화 메시지 (role, content, mapped_term, results JSONB) |
