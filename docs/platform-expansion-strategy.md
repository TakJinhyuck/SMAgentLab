# Ops-Navigator → AI 통합 플랫폼 확장 전략

> **작성일**: 2026-03-11 | **최종 수정**: 2026-03-11
> **참조**: `agentic-expansion-roadmap.md` (Tool Use 전환), `architecture.md` (현재 시스템)

---

## 1. 전환 흐름: As-Is → 현재 → To-Be

```
[As-Is]   Chat = RAG 1:1 강결합 / 에이전트 개념 없음
    ↓ Step 1 완료 (2026-03-11)
[현재]    AgentRegistry + KnowledgeRagAgent 위임 / DB agent_type 추가 / UI 무변경
    ↓ Step 2 예정 (두 번째 에이전트 추가 시)
[To-Be]   domain/ → platform/ + agents/ 완전 분리 / 프론트엔드 에이전트 UI / 전수 테스트
```

### Step 1에서 바뀐 것

| 영역 | As-Is | 현재 |
|------|-------|------|
| 스트리밍 채팅 | `chat/router.py`가 `_generate_worker`로 직접 실행 | `AgentRegistry.get("knowledge_rag").stream_chat()` 위임 |
| 에이전트 뼈대 | 없음 | `agents/base.py` + `agents/knowledge_rag/agent.py` |
| 공유 헬퍼 | `chat/router.py`에 DB 유틸 혼재 | `domain/chat/helpers.py`로 분리 |
| DB 스키마 | 에이전트 구분 없음 | `agent_type VARCHAR(50)` + `ops_feedback.meta JSONB` |
| 프론트엔드 | - | **변경 없음** (API 계약 동일) |

### Step 2에서 바뀔 것

| 영역 | 현재 | Step 2 이후 |
|------|------|-------------|
| 백엔드 디렉토리 | `domain/`에 플랫폼+RAG 혼재 | `platform/` + `agents/` 완전 분리 |
| DB 테이블명 | `ops_knowledge` 등 | `rag_knowledge` (에이전트별 prefix) |
| 프론트엔드 | 변경 없음 | `components/platform/` + `components/agents/` 분리, 사이드바 에이전트 네비게이션 |

---

## 2. 핵심 아키텍처: 에이전트 레지스트리 패턴

```
사용자 질문
  └→ chat/router.py (플랫폼: 세션 관리, 인증)
       └→ AgentRegistry.get(agent_type)
            └→ agent.stream_chat(query, user, context)
                  ├─ knowledge_rag: 용어매핑 → 검색 → 퓨샷 → LLM
                  ├─ text2sql:      스키마탐색 → SQL생성 → 실행 → LLM 설명  (미래)
                  └─ log_monitor:   패턴매칭 → 이상탐지 → LLM 요약         (미래)
```

- 플랫폼 = 에이전트 실행 **런타임** (인증, 세션, 피드백)
- 에이전트 = 독립 **플러그인** (각자 파이프라인 + 관리 API)
- 공유 인프라: Auth, Part, LLM Factory, Embedding

### 현재 코드 구조

```
backend/
├── agents/
│   ├── base.py                    # AgentBase + AgentRegistry
│   └── knowledge_rag/agent.py     # KnowledgeRagAgent (stream_chat)
├── domain/
│   ├── chat/
│   │   ├── router.py              # 플랫폼 채팅 (AgentRegistry 위임)
│   │   ├── helpers.py             # 공유 DB 헬퍼
│   │   ├── memory.py              # 대화 요약 + 시맨틱 리콜
│   │   └── schemas.py
│   ├── knowledge/                 # RAG 검색 (→ 추후 agents/knowledge_rag/로 이동)
│   ├── fewshot/                   # 퓨샷 관리 (→ 추후 agents/knowledge_rag/로 이동)
│   ├── auth/, admin/, feedback/   # 플랫폼 공통 (→ 추후 platform/로 이동)
│   └── llm/                       # LLM 팩토리 (→ 추후 shared/llm/로 이동)
├── core/                          # DB, JWT, security, config
└── shared/                        # embedding
```

---

## 3. 목표 디렉토리 구조 (Step 2 완료 후)

```
backend/
├── core/, shared/          # 그대로
├── platform/               # 에이전트 무관 플랫폼
│   ├── auth/, admin/, chat/, feedback/
└── agents/
    ├── base.py
    ├── knowledge_rag/      # RAG 에이전트 (retrieval, memory, fewshot, admin)
    ├── text2sql/           # (미래)
    └── log_monitor/        # (미래)

frontend-react/src/
├── components/
│   ├── platform/           # UserManager, NamespaceManager, StatsPanel, LLMSettings
│   ├── agents/
│   │   ├── knowledge_rag/  # KnowledgeTable, FewshotTable, GlossaryTable, DebugPanel
│   │   └── text2sql/       # (미래) SqlResultTable, SchemaViewer
│   └── chat/               # AgentSelector, ChatContainer (output_type 분기)
└── store/useAppStore.ts    # selectedAgentType 추가
```

---

## 4. DB 전략

**테이블 분리**: 플랫폼 공유 `ops_*` + 에이전트별 `rag_*`, `sql_*`, `log_*`

**agent_type 컬럼** (Step 1에서 추가 완료):
- `ops_conversation.agent_type` / `ops_query_log.agent_type` / `ops_feedback.agent_type` + `meta JSONB`

**파트 = 유일한 공유 스코핑 단위**: 에이전트별 네임스페이스는 각자 내부에서 독립 관리

**pgvector**: 팀 내 규모에 최적. HNSW `m=16, ef_construction=64`. 500만 건 이상 시 전문 Vector DB 검토.

---

## 5. 인프라 단계

| 단계 | 트리거 | 내용 |
|------|--------|------|
| Phase 1 | 즉시 | 단일 컨테이너, 코드 모듈화만 (현재 진행 중) |
| Phase 1.5 | 에이전트 2~3개 | Celery + Redis 비동기 워커 분리 (LLM 호출 디커플링) |
| Phase 2 | 에이전트 3개+ | 서비스 분리: platform-api + agent-rag + agent-sql |
| Phase 3 | 운영 규모 | API Gateway + 서킷 브레이커 + 분산 트레이싱 |

---

## 6. 피드백 & 통계

- **수집**: `ops_feedback`에서 중앙 수집, `agent_type`으로 구분, `meta JSONB`에 에이전트별 데이터
- **분석**: 통계 대시보드에서 `agent_type` 필터링. 공통 지표(사용량, 긍정률) + 에이전트별 지표(검색 유사도, SQL 성공률 등)

---

## 7. 구현 단계

### Step 1: AgentBase 뼈대 + DB 확장 + 파이프라인 위임 — ✅ 완료

1. `agents/base.py` — AgentBase + AgentRegistry
2. `agents/knowledge_rag/agent.py` — KnowledgeRagAgent.stream_chat()
3. `domain/chat/helpers.py` — 공유 DB 헬퍼 추출
4. `domain/chat/router.py` — chat_stream → AgentRegistry 위임
5. `main.py` — 에이전트 등록 + agent_type 마이그레이션
6. DB: agent_type 컬럼 + meta JSONB

### Step 2: 디렉토리 재편 + 프론트엔드 + 플랫폼 어드민 — 미착수

> 트리거: 두 번째 에이전트 추가 결정 시. 전수 테스트 필요.

- 백엔드: `domain/` → `platform/` + `agents/` 이동
- DB: `ops_knowledge` → `rag_knowledge` 등 prefix rename
- 프론트엔드: `components/platform/` + `components/agents/` 분리, AgentSelector, selectedAgentType
- 플랫폼 어드민: 에이전트 디렉토리 UI, `AgentBase.health_check()`, 파트-에이전트 접근 제어, 통합 대시보드 agent_type 필터

### Step 3: Tool Use 전환

- `agents/knowledge_rag/tools.py` MCP Tool 래핑
- 하드코딩 파이프라인 → Tool Use 방식 전환

### Step 4: 두 번째 에이전트 (Text2SQL)

- `agents/text2sql/` AgentBase 구현 + `sql_*` 테이블 + 프론트 UI

---

## 8. UI 전략

- **B안 (에이전트별 전용 페이지)**: 에이전트마다 출력 형태가 다름 (텍스트/데이터그리드/타임라인)
- **Ctrl+K Global Command Bar**: 에이전트 모를 때 통합 진입점 → 자동 추천 후 해당 페이지 라우팅
- **사이드바**: [플랫폼] 관리 대시보드 + [에이전트] 목록 (각 클릭 시 해당 대화 목록)

---

## 9. 플랫폼 어드민 확장 (에이전트 거버넌스)

> 에이전트 개별 데이터(Knowledge, Few-shot)는 각 에이전트 어드민에 위임.
> 플랫폼 어드민은 **에이전트 라이프사이클 + 공통 정책**을 총괄.

### 채택 항목 (Step 2~3에서 구현)

| 기능 | 설명 | 구현 방식 | 시점 |
|------|------|-----------|------|
| **에이전트 디렉토리** | 등록된 에이전트 목록, 상태, 메타데이터 표시 | `AgentRegistry.list_all()` → 어드민 UI 카드 | Step 2 |
| **에이전트 헬스체크** | 각 에이전트 파이프라인 정상 여부 확인 | `AgentBase.health_check()` 메서드 추가 | Step 2 |
| **파트-에이전트 접근 제어** | 특정 파트만 특정 에이전트 사용 허용 | `ops_part_agent_access(part_id, agent_type)` 매핑 테이블 | Step 2 |
| **프롬프트 템플릿 관리** | 플랫폼 공통 프롬프트 + 에이전트별 프롬프트 DB 관리 | `ops_prompt_template(scope, agent_type, content)` | Step 2~3 |
| **통합 대시보드 확장** | 에이전트별 사용량·만족도·응답 시간 비교 | 기존 통계에 `agent_type` 필터 추가 (새 테이블 불필요) | Step 2 |

### 보류 항목 (규모 확대 시 재검토)

| 기능 | 보류 이유 | 재검토 트리거 |
|------|-----------|---------------|
| 토큰 쿼터/비용 제어 | 사내 LLM은 비용 직접 미발생 | 외부 유료 LLM(GPT-4 등) 전환 시 |
| 보안 필터/가드레일 | 사용자=팀원, 사내 운영 도구 | 외부 사용자 노출 또는 민감 데이터 취급 시 |
| 크로스 에이전트 트레이싱 | 에이전트 1~2개에서 불필요 | Phase 2(서비스 분리) 이후 |
| 라우터 에이전트 (자동 추천) | Ctrl+K 진입점으로 충분 | 에이전트 3개+ 시 AI 라우팅 검토 |
| ops_agent_registry 테이블 | 코드 기반 레지스트리가 2~3개에 충분 | 에이전트 10개+ 시 DB화 검토 |

### 설계 원칙

- **Self-registration**: 에이전트가 `AgentRegistry.register()` 호출 시 어드민 UI에 자동 노출. 마스터 어드민 코드 수정 불필요.
- **에이전트는 독립, 플랫폼은 통합**: 로그·통계는 `agent_type`으로 한곳에서 수집, 에이전트 내부 로직은 건드리지 않음.
- **점진적 확장**: 에이전트 수 증가에 따라 보류 항목을 단계적으로 도입.

---

## 10. 호환성 현황

| 기존 구조 | 현재 상태 | 확장 시 |
|------|------|------|
| 파트 기반 권한 | 유지 | 모든 에이전트 스코핑 단위 |
| LLM Factory | 유지 | stream_chat() 내부에서 사용 |
| SSE 스트리밍 | **AgentRegistry 위임 전환** | 공통 endpoint 재활용 |
| ops_feedback | **agent_type 추가 완료** | 다중 에이전트 준비 완료 |
| pgvector + HNSW | 유지 | 테이블 분리로 확장 |
