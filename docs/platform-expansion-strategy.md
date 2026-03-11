# Ops-Navigator → AI 통합 플랫폼 확장 전략

> **작성일**: 2026-03-11
> **목적**: 현재 지식관리 시스템(RAG 파이프라인 단일 에이전트)을 팀 내 AI 기반 운영 통합 플랫폼으로 확장하기 위한 아키텍처 설계 문서.
> **참조**: `agentic-expansion-roadmap.md` (Tool Use 전환 세부 로드맵), `architecture.md` (현재 시스템 구조)

---

## 1. 현재 구조의 한계

```
현재: Chat = RAG (1:1 강결합)

사용자 질문
  └→ domain/chat/router.py
       └→ 용어매핑 → 하이브리드검색 → 퓨샷 → 프롬프트조립 → SSE 스트리밍
```

- `chat/router.py`가 RAG 파이프라인 전체를 직접 orchestrate
- Text2SQL, 로그모니터링 추가 시 if/else 분기 또는 별도 라우터 임시 추가 → 스파게티화 필연
- 에이전트마다 출력 UI가 다름 (RAG: 텍스트, Text2SQL: 데이터그리드, 로그: 타임라인) → 단일 ChatContainer로 수용 불가

---

## 2. 목표 구조: 에이전트 레지스트리 패턴

```
목표: Platform(런타임) + Agents(플러그인)

사용자 질문
  └→ platform/chat/router.py
       └→ AgentRegistry.get(agent_type)
            └→ agent.stream_chat(query, user, context)
                  ├─ knowledge_rag: 용어매핑 → 검색 → 퓨샷 → LLM
                  ├─ text2sql:      스키마탐색 → SQL생성 → 실행 → LLM 설명
                  └─ log_monitor:   패턴매칭 → 이상탐지 → LLM 요약
```

**핵심 원칙:**
- 플랫폼은 에이전트를 실행하는 **런타임**만 담당
- 에이전트는 독립적으로 배포·테스트 가능한 **플러그인 모듈**
- 공유 인프라(Auth, Part, LLM Factory, Embedding)는 모든 에이전트가 재활용

---

## 3. 백엔드 구조 재편

### 3-1. 디렉토리 구조

```
backend/
├── core/                   # 그대로 유지: DB, JWT, security, config
├── shared/                 # 그대로 유지: embedding, LLM factory
│
├── platform/               # 에이전트 무관 플랫폼 서비스 (현재 domain/ 일부)
│   ├── auth/               # 로그인, JWT, 회원가입 (현재 domain/auth)
│   ├── admin/              # 사용자·파트 관리, 통계 (현재 domain/admin)
│   ├── chat/               # 대화 세션 관리, SSE 공통 핸들러 (현재 domain/chat에서 분리)
│   └── feedback/           # 피드백 수집 (현재 domain/feedback)
│
└── agents/                 # 에이전트별 독립 모듈
    ├── base.py             # AgentBase 추상 클래스 + AgentRegistry
    ├── knowledge_rag/      # 현재 knowledge + fewshot + glossary + chat 파이프라인
    │   ├── router.py       # /agents/knowledge-rag/chat (SSE)
    │   ├── retrieval.py    # 현재 domain/knowledge/retrieval.py 이동
    │   ├── tools.py        # MCP Tool 래핑 (agentic-roadmap Phase 1)
    │   ├── admin.py        # 지식/퓨샷/용어집 관리 API
    │   └── memory.py       # 현재 domain/chat/memory.py 이동
    ├── text2sql/           # (미래)
    │   ├── router.py       # /agents/text2sql/chat
    │   ├── schema_inspector.py
    │   └── admin.py        # DB 연결 설정
    └── log_monitor/        # (미래)
        ├── router.py       # /agents/log-monitor/chat
        └── alert_rules.py
```

### 3-2. AgentBase 인터페이스

```python
# agents/base.py

from abc import ABC, abstractmethod
from typing import AsyncIterator

class AgentBase(ABC):

    @property
    @abstractmethod
    def agent_id(self) -> str:
        """고유 식별자: "knowledge_rag", "text2sql" """
        ...

    @property
    @abstractmethod
    def metadata(self) -> dict:
        """프론트엔드 동적 렌더링에 필요한 메타데이터"""
        # 예시:
        # {
        #   "display_name": "지식베이스 AI",
        #   "description": "운영 가이드 및 매뉴얼 기반 질의응답",
        #   "icon": "BookOpen",          # lucide icon name
        #   "color": "indigo",           # Badge 색상
        #   "output_type": "text",       # "text" | "table" | "timeline"
        #   "welcome_message": "...",
        #   "supports_debug": True,
        # }
        ...

    @abstractmethod
    async def stream_chat(
        self,
        query: str,
        user: dict,
        conversation_id: int,
        context: dict,
    ) -> AsyncIterator[str]:
        """SSE 스트리밍 응답 생성"""
        ...

    @abstractmethod
    def get_admin_router(self):
        """에이전트 전용 관리 API 라우터 반환"""
        ...


class AgentRegistry:
    _agents: dict[str, AgentBase] = {}

    @classmethod
    def register(cls, agent: AgentBase):
        cls._agents[agent.agent_id] = agent

    @classmethod
    def get(cls, agent_id: str) -> AgentBase:
        if agent_id not in cls._agents:
            raise ValueError(f"Unknown agent: {agent_id}")
        return cls._agents[agent_id]

    @classmethod
    def list_all(cls) -> list[dict]:
        return [a.metadata for a in cls._agents.values()]
```

### 3-3. 플랫폼 공통 채팅 핸들러

```python
# platform/chat/router.py

@router.post("/chat/stream")
async def chat_stream(req: ChatRequest, user = Depends(get_current_user)):
    agent = AgentRegistry.get(req.agent_type)  # "knowledge_rag", "text2sql" 등
    return StreamingResponse(
        agent.stream_chat(req.query, user, req.conversation_id, req.context),
        media_type="text/event-stream",
    )
```

---

## 4. 프론트엔드 구조 재편

### 4-1. 디렉토리 구조

```
frontend-react/src/
├── pages/
│   ├── Chat.tsx            # 에이전트별 전용 채팅 페이지 (agent_type으로 분기)
│   ├── Admin.tsx           # 플랫폼 관리 (사용자·파트·기준정보·LLM 설정)
│   └── AgentAdmin.tsx      # (미래) 에이전트별 관리 탭 통합
│
├── components/
│   ├── platform/           # 플랫폼 공통 관리 UI (현재 admin/ 일부)
│   │   ├── UserManager.tsx
│   │   ├── NamespaceManager.tsx
│   │   ├── StatsPanel.tsx
│   │   └── LLMSettings.tsx
│   ├── agents/             # 에이전트별 독립 UI
│   │   ├── knowledge_rag/  # 현재 admin/ 컴포넌트 이동
│   │   │   ├── KnowledgeTable.tsx
│   │   │   ├── FewshotTable.tsx
│   │   │   ├── GlossaryTable.tsx
│   │   │   └── DebugPanel.tsx
│   │   ├── text2sql/       # (미래)
│   │   │   ├── SqlResultTable.tsx    # 쿼리 결과 데이터그리드
│   │   │   └── SchemaViewer.tsx
│   │   └── log_monitor/    # (미래)
│   │       └── LogTimeline.tsx
│   ├── chat/               # 에이전트 무관 공통 채팅 UI
│   │   ├── AgentSelector.tsx   # 에이전트 선택 패널 (신규)
│   │   ├── ChatContainer.tsx   # agent_type에 따라 결과 렌더러 교체
│   │   ├── MessageItem.tsx
│   │   └── ...
│   └── ui/                 # 그대로 유지
│
└── store/
    └── useAppStore.ts      # selectedAgentType 상태 추가
```

### 4-2. UI 전략: B안 + Global Command 하이브리드

**B안 (별도 페이지) 선택 이유:**
- 에이전트마다 출력 데이터 성격이 다름: 텍스트 / 데이터그리드 / 타임라인
- 에이전트별 관리 패널(KnowledgeTable, SchemaViewer 등)이 독립 운영되어야 함
- GPT 스타일(A안)은 범용적이라 각 에이전트 특유의 UX를 살리기 어려움

**추가: Global Command Bar (Ctrl+K)**
- 사용자가 어떤 에이전트를 써야 할지 모를 때를 위한 통합 진입점
- 메인 화면 상단에 "무엇이든 물어보세요" 입력창 → 에이전트 자동 추천 후 해당 페이지로 라우팅

```
사이드바 구조 (예시):
─────────────────────
[플랫폼]
  └ 관리자 대시보드

[에이전트]
  ├ 📚 지식베이스 AI     ← 현재 Chat
  ├ 🗄️  Text2SQL        ← (미래)
  └ 📊 로그 모니터링    ← (미래)
─────────────────────
각 에이전트 클릭 시 해당 에이전트의 대화 목록 표시
```

---

## 5. DB 전략

### 5-1. 테이블 분리 원칙

```
공유 (플랫폼): ops_user, ops_part, ops_feedback
에이전트별 prefix: rag_*, sql_*, log_*

현재 테이블 rename:
  ops_namespace  → rag_namespace
  ops_knowledge  → rag_knowledge
  ops_glossary   → rag_glossary
  ops_fewshot    → rag_fewshot
```

### 5-2. 대화 테이블 agent_type 추가

```sql
-- ops_conversation에 에이전트 구분 추가
ALTER TABLE ops_conversation
  ADD COLUMN agent_type VARCHAR(50) NOT NULL DEFAULT 'knowledge_rag';

ALTER TABLE ops_query_log
  ADD COLUMN agent_type VARCHAR(50) NOT NULL DEFAULT 'knowledge_rag';

-- 피드백에 에이전트별 확장 메타데이터
ALTER TABLE ops_feedback
  ADD COLUMN agent_type VARCHAR(50) NOT NULL DEFAULT 'knowledge_rag',
  ADD COLUMN meta JSONB;
  -- meta 예시:
  --   knowledge_rag: {"search_sim": 0.82, "context_count": 3}
  --   text2sql:      {"sql_executed": true, "row_count": 42}
  --   log_monitor:   {"alert_triggered": true, "severity": "warn"}
```

### 5-3. 파트(Part) = 유일한 공유 스코핑 단위

- 플랫폼의 `ops_part`는 팀/부서 정보만 관리
- 각 에이전트는 `owner_part` (FK → ops_part)로 자기 데이터를 스코핑
- `rag_namespace.owner_part`, `sql_schema.owner_part` 등 동일 패턴 적용
- 에이전트별 네임스페이스 개념(RAG: 문서 카테고리, SQL: DB 스키마)은 에이전트 내부에서 독립 관리

### 5-4. pgvector 확장성

**현재 스택 (pgvector on PostgreSQL) 평가:**

| 항목 | 내용 |
|------|------|
| 권장 규모 | 팀 내 운영 수준: 수십만 건 이하에서 최적 |
| 강점 | 복합 필터(날짜+파트+키워드+벡터) 원자적 SQL, JSONB 시너지 |
| 임베딩 차원 | 현재 768차원 → 수백만 건까지 커버 가능 |
| 인덱스 전략 | HNSW (기본) → RAM 부담 시 IVFFlat으로 전환 |
| 한계 | 수백만 건 이상 + 고차원(3072+) 조합 시 메모리 압박 |
| 대응 | 에이전트별 테이블 분리로 인덱스 범위 축소, 필요 시 pgBouncer + 읽기 전용 레플리카 |

**인덱스 파라미터 권장값 (HNSW):**
```sql
-- rag_knowledge 예시
CREATE INDEX ON rag_knowledge
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
-- 데이터 증가 시 m=32, ef_construction=128로 조정
```

**전문 Vector DB로의 전환 기준:**
- 단일 에이전트 벡터 데이터 > 500만 건
- 검색 지연시간 목표 < 50ms
- 위 조건 전까지는 pgvector가 운영 편의성에서 압도적으로 유리

---

## 6. 인프라 단계별 전환

### Phase 1: 코드 모듈화 (현재 → 즉시)

```
단일 backend 컨테이너 유지, 코드 구조만 재편
domain/ → platform/ + agents/ 분리

목표: 에이전트 추가 시 agents/ 하위 디렉토리 생성만으로 완결
```

### Phase 1.5: 비동기 워커 분리 (에이전트 2~3개 시점)

```
LLM 호출(수 초~수십 초) 을 API 서버에서 분리
API 서버 → Redis Queue → LLM Worker → SSE

도입 효과:
  - API 서버 스케일 아웃 독립
  - 에이전트별 워커 우선순위 큐 설정 가능
  - LLM 타임아웃 장애가 API 서버로 전파 차단
```

```yaml
# docker-compose 추가 서비스
services:
  redis:
    image: redis:7-alpine

  llm-worker:
    build: ./backend
    command: celery -A core.celery worker -Q llm_tasks
    depends_on: [redis, postgres]
```

### Phase 2: 서비스 분리 (에이전트 3개+)

```
platform-api:   인증, 사용자, 피드백, 대화 세션 관리
agent-rag:      knowledge_rag 에이전트 전용 서비스
agent-sql:      text2sql 에이전트 전용 서비스
postgres:       공유 DB (스키마 prefix로 격리)
redis:          공유 큐
```

### Phase 3: 완전한 MSA (운영 규모)

```
API Gateway (nginx/Kong) → 서비스별 라우팅
에이전트별 독립 스케일 아웃
서킷 브레이커, 분산 트레이싱 도입
```

**Phase 1 → 2 전환 비용이 낮은 이유:**
Phase 1에서 AgentBase 인터페이스와 모듈 경계만 잘 잡아두면, Phase 2 전환은 라우터 분리 + Dockerfile 복사 수준으로 끝남. 코드 재작성 없음.

---

## 7. 통합 피드백 & 통계 전략

### 수집: Centralized Logging

모든 에이전트의 피드백을 `ops_feedback`에서 중앙 수집:
- `agent_type` 컬럼으로 구분
- `meta JSONB`에 에이전트별 특유 데이터 저장

### 분석: Decentralized per Agent

통계 대시보드에서 `agent_type`으로 필터링하여 에이전트별 분석:

| 지표 | 모든 에이전트 공통 | knowledge_rag 전용 | text2sql 전용 |
|------|------|------|------|
| 긍정/부정 비율 | ✅ | ✅ | ✅ |
| 일별 사용량 | ✅ | ✅ | ✅ |
| 검색 유사도 분포 | ❌ | ✅ | ❌ |
| SQL 실행 성공률 | ❌ | ❌ | ✅ |
| 평균 응답 시간 | ✅ | ✅ | ✅ |

---

## 8. 구현 우선순위

### Step 1: 코드 경계 설정 (리팩토링, 기능 변화 없음)

1. `domain/` 구조를 `platform/` + `agents/knowledge_rag/`로 이동
2. `AgentBase`, `AgentRegistry` 작성
3. `main.py`에서 AgentRegistry 등록 + 공통 chat endpoint 적용
4. DB 테이블 prefix rename (`ops_knowledge` → `rag_knowledge` 등)
5. `ops_conversation`, `ops_query_log`에 `agent_type` 컬럼 추가

### Step 2: agentic-expansion-roadmap.md Phase 1 (Tool Use 전환)

6. knowledge_rag 에이전트에 MCP Tool 래핑 (`agents/knowledge_rag/tools.py`)
7. 하드코딩 파이프라인 → Tool Use 방식 전환

### Step 3: 프론트엔드 에이전트 선택 UI

8. `AgentSelector.tsx` 컴포넌트
9. 사이드바 에이전트별 네비게이션
10. `useAppStore`에 `selectedAgentType` 추가
11. `ChatContainer`에 `output_type` 기반 렌더러 분기

### Step 4: 두 번째 에이전트 추가 (Text2SQL)

12. `agents/text2sql/` 모듈 생성 → AgentBase 구현
13. `sql_*` 테이블 설계
14. `components/agents/text2sql/` UI 컴포넌트

---

## 9. 현재 코드와의 호환성

| 기존 구조 | 확장 후 재활용 |
|------|------|
| 파트 기반 권한 모델 | 모든 에이전트의 스코핑 기준 단위 |
| LLM Factory (ollama/inhouse) | AgentBase.stream_chat() 내부에서 그대로 사용 |
| SSE 스트리밍 패턴 | 공통 chat endpoint에서 그대로 재활용 |
| JWT 인증/의존성 | platform/auth 이동 후 전 에이전트 공유 |
| ops_feedback | agent_type 컬럼 추가만으로 다중 에이전트 지원 |
| 통계 대시보드 | agent_type 필터 추가 후 재활용 |
| 디버그 패널 | knowledge_rag 에이전트 전용 UI로 그대로 유지 |
| pgvector + HNSW | 에이전트별 테이블 분리로 확장성 확보 |
