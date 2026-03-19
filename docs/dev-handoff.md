# Ops-Navigator 개발 핸드오프

> **규칙**: 작업 종료 시 이 문서 업데이트 후 커밋·푸시

---

## 바톤 받기

```bash
git pull origin main
docker compose up --build -d
# http://localhost:8501  /  http://localhost:8000/docs
# 초기 로그인: admin / (ADMIN_DEFAULT_PASSWORD in .env)
```

---

## 현재 작업 상태

> **마지막 업데이트**: 2026-03-19
> **브랜치**: dev_0
> **최근 변경**: Text-to-SQL 어드민 UI 전면 개편 + ERD 고도화 + AI 자동생성 (테스트 후 커밋 예정)

### 진행 중 / 미완료

없음 — 클린 상태

### 백로그

- [ ] **Text2SQL 네임스페이스 선택 UI**: 현재 채팅 시 text2sql 에이전트가 chat namespace를 그대로 쓰는데, 전용 DB 네임스페이스를 별도 선택하는 UI 필요 (현재는 Admin에서 설정만 가능)
- [ ] **통합 대시보드 agent_type 필터**: 통계 탭에 에이전트별 필터 추가
- [ ] Docker 이미지 레지스트리 push
- [ ] 테스트 코드 (pytest)
- [ ] CI/CD 파이프라인

---

## 아키텍처 핵심 결정사항

> 코드 작업 전 반드시 숙지할 비자명한 설계들

| 항목 | 내용 |
|------|------|
| **Agent-centric UI** | 로그인 → `AgentSelect` 페이지(에이전트 선택) → 에이전트별 채팅+어드민. `useAppStore.selectedAgent: 'knowledge_rag' \| 'text2sql' \| null` 로 상태 관리. `null` = 선택 화면 표시 |
| **MCP 도구는 에이전트 아님** | ChatContainer 내 `useHttpTool` boolean 토글 → `agentType: 'mcp_tool'`. 3-버튼 선택기 제거. 각 에이전트에서 도구로 붙이는 형태 |
| **Admin 탭 에이전트 스코핑** | `TABS` 배열의 `agentScope: 'knowledge_rag' \| 'text2sql' \| 'all'` 으로 필터링. 에이전트 전환 시 탭 자동 리셋 (`resolvedTab`) |
| **AgentRegistry 패턴** | `chat_stream` → `AgentRegistry.get(agent_type).stream_chat()` 위임. 에이전트 추가 시 `agents/` 하위 모듈 + `main.py`에 `AgentRegistry.register()` 1줄이면 완결 |
| **generate_once() api_key** | 사내 LLM의 `generate_once()`는 반드시 `api_key=context.get("api_key")` 를 넘겨야 함. per-user 키를 안 넘기면 401. `generate()`, `generate_stream()`도 동일 |
| **Text2SQL 파이프라인** | `parse → rag → generate → validate → fix → execute → summarize → (cache)` 7단계. 각 스테이지는 `pipeline_ctx` dict를 공유하며 순차 업데이트. `sql_pipeline_stage` 테이블에 설정 영속화 |
| **Text2SQL 벡터 저장** | asyncpg에서 pgvector INSERT/UPDATE 시 반드시 `$N::vector` 캐스트 + `str(emb)` 변환 필요. 파이썬 list를 직접 넘기면 DataError |
| **Text2SQL api_key 경로** | `context["api_key"]` → `pipeline_ctx["api_key"]` → 각 스테이지 `run(context, llm, ...)` → `llm.generate_once(..., api_key=context.get("api_key"))` |
| **Fernet 암호화 키** | `settings.fernet_secret_key` 우선, 없으면 `settings.jwt_secret_key` fallback. `service.py`의 `_get_fernet()` 참조 |
| **Ollama num_ctx** | `generate_once()`에서 `num_ctx: 8192` 설정. 기본값 2048은 SQL 생성 프롬프트(스키마 포함) 처리에 부족 |
| **시스템 설정 DB 영속화** | `ops_system_config (key PK, value TEXT, updated_at)` 테이블. 캐시 설정 3종 저장. 앱 시작 시 `sem_cache.load_config_from_db()` 자동 로드 |
| **MCP 도구 에이전트 플로우** | Case 3(첫 진입): LLM 도구 선택 → `tool_request` SSE. Case 2(`selected_tool_id`): 파라미터 폼. Case 1(`approved_tool`): HTTP+RAG 병렬 → LLM 답변. 매 호출 `ops_mcp_tool_log` 감사 로그 |
| **MCP 파라미터 타입 변환** | 프론트 `Record<string,string>` → `_coerce_params(params, schema)`에서 `param_schema.type` 기반 number/boolean/array 변환 |
| **MCP URL 구조** | `hub_base_url`(도구레벨) + `tool_path`(도구레벨) = 최종 URL. DB `ops_mcp_tool`에 분리 저장 |
| **Semantic Cache** | `shared/cache.py`. 유사도 임계값 **0.88**, TTL 30분. `ops_system_config`에 영속화. graceful degradation |
| **캐시 쿼리 정규화** | `sem_cache.normalize_query()` — 연속 공백 제거, 한글 자모 간 공백 제거, 소문자 변환. 캐시 벡터만 적용, RAG 검색 벡터는 원본 유지 |
| **MCP 감사로그 JSONB 파싱** | asyncpg는 JSONB를 `str`로 반환. `json.loads()` 처리 필수. `isinstance(dict)` 체크만 하면 항상 `{}` 반환되는 버그 주의 |
| **SSE tool_request 상태 유지** | 스트림 종료 시 `toolRequest` 대기 중이면 `clearStreamState()` 호출 안 함. DB에는 placeholder 저장 → `convertMessages`에서 필터링 |
| **프롬프트 관리** | `ops_prompt` 테이블. `domain/prompt/loader.py`의 `get_prompt(key, fallback)` → DB 우선, 없으면 fallback |
| **resolve_namespace_id** | `core/database.py` — NS name→id 변환 공통 헬퍼. 모든 도메인에서 사용 (인라인 쿼리 금지) |
| **네임스페이스 권한** | `owner_part = NULL` → 전체 CRUD / 같은 파트 → CRUD / 다른 파트 → 읽기 전용 |
| **멀티턴 검색** | 직전 user+assistant 각 80자를 현재 질문에 결합해 임베딩 |

---

## 완료 이력 (최근순)

- **Text-to-SQL 어드민 UI 전면 개편 + ERD 고도화 + AI 자동생성** (2026-03-19): ① Admin 탭 구조 재편 — 에이전트현황 탭 제거, text2sql 서브탭(대상DB·스키마·ERD·용어사전·SQL Few-shot·파이프라인·감사로그)을 메인 탭으로 승격, 캐시·통계 → knowledge_rag 전용으로 분리. ② AgentSelect 헬스체크 뱃지 — `GET /health` 응답(`status/llm/llm_provider`)으로 서버·LLM 상태 실시간 표시(30초 폴링). ③ ERD 고도화 — 위치 DB 저장(`PUT /schema/positions`, pos_x/pos_y), 되돌리기(Ctrl+Z, 최대 20단계 undo 스택), 자동 정리(격자 배치), 줌 버튼(+/-/%), Alt+Wheel 줌, 라이트 카드 스타일(흰색 카드·노란 헤더·오렌지 텍스트), 점 그리드 SVG 배경, 관계선 색상 4종 구분. ④ AI 관계 추천(`POST /relations/suggest-ai`) — LLM이 컬럼명 패턴(_id/_no/_code) 분석, 미등록 관계만 필터링해 제안 모달. ⑤ AI 용어 자동생성(`POST /synonyms/generate-ai`) — LLM 스키마 분석 → 30+ 용어·SQL 매핑, SQL 키워드 포함 항목 필터, 중복 스킵. ⑥ AI 예제 자동생성(`POST /fewshots/generate-ai`) — LLM이 스키마+용어사전 기반 20+ 한국어 Q&A 쌍 생성. ⑦ 파이프라인 편집 버튼에 "프롬프트 편집" 레이블 명시. ⑧ 아키텍처 문서(architecture.md) v2.6 현행화

- **Agent-centric UI 전환 + 백엔드 성능 최적화** (2026-03-19): ① `AgentSelect` 페이지 신설 — 로그인 후 에이전트 선택 화면. ② `useAppStore`에 `selectedAgent: AgentType | null` 상태 추가. ③ Admin 탭 `agentScope` 필드로 에이전트별 필터링. ④ ChatContainer 3버튼 선택기 → `useHttpTool` 단일 토글로 대체. ⑤ Sidebar에 에이전트 배지 + "에이전트 변경" 버튼. ⑥ `Text2SqlAdmin` 전면 재설계 (SchemaTab/ErdTab/SynonymTab/FewshotTab). ⑦ MessageItem SQL 블록 기본 펼침 + 복사 버튼 + 테이블 N행×M열 + CSV export. ⑧ **백엔드 최적화**: RAG 3중 embed → 1회 embed+병렬 DB 검색, knowledge_rag 이중 embed 병렬화, text2sql 에이전트 startup 3쿼리 병렬화, Fernet 싱글톤, `get_cached_sql` 2-RT → 1-RT(UPDATE RETURNING), Redis pipeline 배치 hget, `main.py` 마이그레이션 5개 서브함수 분리. ⑨ `dev_knowledge` 브랜치 생성 — main 브랜치(단일 에이전트 원본) 보관

- **Text2SQL 에이전트 이식 + E2E 검증** (2026-03-19): ① `agents/text2sql/` 신규 — 7단계 파이프라인(parse/rag/generate/validate/fix/execute/summarize) + `Text2SqlAgent` 등록. ② `sql_*` 테이블 10개 마이그레이션 (`sql_target_db`, `sql_schema_table`, `sql_schema_column`, `sql_schema_vector`, `sql_relation`, `sql_synonym`, `sql_fewshot`, `sql_pipeline_stage`, `sql_audit_log`, `sql_cache`). ③ Admin Text-to-SQL 탭 8개 서브탭 (대상DB·스키마·관계·용어·예제·파이프라인·감사로그·캐시). ④ 채팅 에이전트 선택 UI (knowledge_rag / mcp_tool / text2sql 3-버튼). ⑤ MessageItem에 SQL 코드블록(react-syntax-highlighter) + 결과 테이블 + SVG 바차트 렌더러 추가. ⑥ Admin 에이전트 현황 탭 (`AgentDirectoryTab`). ⑦ `/api/agents`, `/api/agents/{id}/health` 엔드포인트 신설. ⑧ 버그 수정 5건: Fernet 키 속성명, `embedding_service.embed()` await 누락(11개소), pgvector `::vector` 캐스트 누락, `generate_once()` api_key 미전달(401 에러), Ollama `num_ctx: 8192` 추가
- **MCP 감사로그 버그 수정 + 캐시 정규화 + 코드 정리** (2026-03-17): ① 감사로그 `params` 항상 `{}` 버그 (asyncpg JSONB→str). ② `request_url`·`http_method` 컬럼 신설. ③ coerced params 저장. ④ `normalize_query()` 한글 자모 간 공백 제거. ⑤ `useNamespaceAccess` hook 추출. ⑥ `httpTools.ts` 삭제 (`McpTool` 계열로 통합). ⑦ asyncpg TIMESTAMPTZ str→datetime 변환. ⑧ McpToolManager 네임스페이스 미선택 버그 수정
- **MCP 호출 로그 전면 개편** (2026-03-17): 도구별 집계 테이블, 모달(도넛차트 + 페이지네이션 로그), 시간 필터, `GET /api/mcp-tools/logs/stats` 추가
- **캐시 임계값 하향 + UI 개선** (2026-03-17): 유사도 임계값 0.92 → **0.88**, CachePanel `refetchInterval: 10s`, McpToolManager Globe → Wrench 아이콘
- **Semantic Cache DB 영속화 + 버그 수정** (2026-03-17): `ops_system_config` 테이블 신설, 앱 시작 시 DB 설정 자동 로드, MCP 도구 에이전트 캐시 체크 추가
- **MCP 도구 전면 리네임 + 기능 강화** (2026-03-17): `ops_http_tool` → `ops_mcp_tool`, `hub_base_url`+`tool_path` 분리, `ops_mcp_tool_log` 감사 로그, `agents/http_tool` → `agents/mcp_tool`
- **HTTP 도구 에이전트 고도화** (2026-03-16): RAG 컨텍스트 통합, HTTP+RAG 병렬화, HTTP 실패 시 RAG-only 폴백, 도구 재선택 플로우
- **초기 개발** (2026-03-12~13): HTTP 도구 시스템 MVP, AgentBase/AgentRegistry 도입, DDD 구조 전환, JWT 인증, Semantic Cache, Few-shot 라이프사이클, Glossary AI 추천, 멀티턴 검색, 사내 LLM DevX 연동

---

## 알려진 이슈

| # | 증상 | 우선도 |
|---|------|--------|
| 1 | 라이트모드 `bg-slate-N` 다크 네이비로 렌더링 | 낮음 (zinc로 우회 완료) |
| 2 | 시맨틱 캐시 의도 변형 히트 불가 | 낮음 — 구조적 한계. 임계값 낮추거나 LLM 의도 추출 기반 캐시로 전환 필요 |
| 3 | Ollama 서버 ~1600자 이상 프롬프트 연결 끊김 | 중간 — 해당 Ollama 서버(10.149.172.233) 측 body size 제한으로 추정. 사내 LLM은 정상 동작 |

---

## 빠른 명령어

```bash
# 재빌드
docker compose build backend frontend && docker compose up -d

# 타입 체크
cd frontend-react && npx tsc --noEmit

# 로그
docker compose logs -f backend --tail=50

# DB 접속
docker exec -it ops-postgres psql -U ops opsdb

# 백업/복원
docker exec ops-postgres pg_dump -U ops opsdb > backup.sql
docker exec -i ops-postgres psql -U ops opsdb < backup.sql
```
