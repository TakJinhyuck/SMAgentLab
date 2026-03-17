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

> **마지막 업데이트**: 2026-03-17
> **브랜치**: dev_0
> **최근 변경**: MCP 감사로그 파라미터 버그 수정 + 시맨틱 캐시 쿼리 정규화 + 코드 정리

### 진행 중 / 미완료

없음 — 클린 상태

### 백로그

- [ ] **Step 2: 디렉토리 재편 + 프론트엔드** (두 번째 에이전트 추가 시): `domain/` → `platform/` + `agents/`, DB prefix rename, 에이전트 선택 UI → [platform-expansion-strategy.md](platform-expansion-strategy.md) Step 2 참조
- [ ] **플랫폼 어드민 확장**: 에이전트 디렉토리 UI, 파트-에이전트 접근 제어, 통합 대시보드 agent_type 필터
- [ ] Docker 이미지 레지스트리 push
- [ ] 사용자별 검색 설정 저장 (현재 세션 단위)
- [ ] 테스트 코드 (pytest)
- [ ] CI/CD 파이프라인
- [ ] 사용자 매뉴얼 (최종 UI 확정 후)

---

## 아키텍처 핵심 결정사항

> 코드 작업 전 반드시 숙지할 비자명한 설계들

| 항목 | 내용 |
|------|------|
| **AgentRegistry 패턴** | `chat_stream` → `AgentRegistry.get("knowledge_rag").stream_chat()` 위임. 새 에이전트 추가 시 `agents/` 하위 모듈 + Registry 등록만으로 완결 |
| **시스템 설정 DB 영속화** | `ops_system_config (key PK, value TEXT, updated_at)` 테이블. 현재 캐시 설정 3종 저장 (`cache_enabled`, `cache_similarity_threshold`, `cache_ttl`). 앱 시작 시 `sem_cache.load_config_from_db()` 자동 로드 |
| **MCP 도구 에이전트 플로우** | Case 3(첫 진입): LLM 도구 선택 → `tool_request` SSE → ToolRequestCard. Case 2(`selected_tool_id`): 사용자 직접 선택 시 파라미터 입력 폼. Case 1(`approved_tool`): HTTP 호출 + RAG 검색 병렬 → LLM 프롬프트에 API 응답 + `## 참고 문서` 포함. 매 호출 `ops_mcp_tool_log` 감사 로그 기록 |
| **MCP 파라미터 타입 변환** | 프론트 `Record<string,string>` → 백엔드 `_coerce_params(params, schema)` 에서 `param_schema.type` 기반으로 number/boolean/array 변환 |
| **MCP URL 구조** | `hub_base_url`(도구레벨) + `tool_path`(도구레벨) = 최종 URL. DB `ops_mcp_tool`에 분리 저장 |
| **Semantic Cache** | `shared/cache.py`. 유사도 임계값 기본 **0.88**, TTL 30분. `ops_system_config`에 영속화. 엔트리별 hits 카운터 저장 (TTL 만료 시 함께 소멸). graceful degradation. **구조적 한계**: 코사인 유사도 100% 기반이라 동일·유사 표현(띄어쓰기 변형 등)에만 효과적이며 의도가 다른 유사 질문은 히트 안 됨 |
| **캐시 쿼리 정규화** | `sem_cache.normalize_query()` — 캐시 embed 전용 전처리. 연속 공백 제거, 한글 자모 간 공백 제거(`"섹션 도구"→"섹션도구"`), 소문자 변환. RAG 검색 벡터(`query_vec`)는 원본 유지, 캐시 벡터(`cache_vec`)만 정규화 적용 |
| **MCP 감사로그 JSONB 파싱** | asyncpg는 JSONB 컬럼을 Python `str`로 반환. `list_mcp_tool_logs`에서 `r["params"]`를 `json.loads()` 처리 필수. `isinstance(r["params"], dict)` 체크만 하면 항상 `{}` 반환되는 버그 주의 |
| **MCP 감사로그 coerced params** | 감사 로그에는 `approved_tool["params"]`(원본 문자열) 아닌 `_coerce_params()` 적용 후 실제 전송된 값 저장. `request_url`, `http_method` 컬럼도 함께 기록 |
| **필수 파라미터 유효성** | `ToolRequestCard`의 승인 버튼은 `required:true` 파라미터가 비어있으면 항상 비활성화 |
| **SSE tool_request 상태 유지** | 스트림 종료 시 `toolRequest`가 대기 중이면 `clearStreamState()` 호출 안 함. DB에는 placeholder 저장 → `convertMessages`에서 필터링 |
| **프롬프트 관리** | `ops_prompt` 테이블. `domain/prompt/loader.py`의 `get_prompt(key, fallback)` → DB 우선, 없으면 fallback |
| **공유 헬퍼** | `domain/chat/helpers.py` — 에이전트·라우터 양쪽에서 사용하는 DB 헬퍼 |
| **resolve_namespace_id** | `core/database.py` — NS name→id 변환 공통 헬퍼. 모든 도메인에서 사용 (인라인 쿼리 금지) |
| **네임스페이스 권한** | `owner_part = NULL` → 전체 CRUD / 같은 파트 → CRUD / 다른 파트 → 읽기 전용 |
| **검색 설정 단일 소스** | `config.py` 기본값 → `GET/PUT /api/llm/search-defaults` → 프론트엔드 fetch |
| **LLM SSE 파서** | DevX 비표준: `data:` JSON 안에 `event` 포함, `401/403`도 서버 도달로 판정 |
| **멀티턴 검색** | 직전 user+assistant 각 80자를 현재 질문에 결합해 임베딩 |

---

## 완료 이력 (최근순)

- **MCP 감사로그 버그 수정 + 캐시 정규화 + 코드 정리** (2026-03-17): ① 감사로그 `params` 항상 `{}` 버그 수정 — asyncpg JSONB→str 반환 특성으로 `json.loads()` 처리 추가. ② `request_url`·`http_method` 컬럼 신설 — 실제 전송 URL·HTTP 메서드 로깅. ③ coerced params 저장 — `_coerce_params()` 적용 후 실제 전송값 기록. ④ 캐시 쿼리 정규화 `normalize_query()` — 한글 자모 간 공백 제거로 "섹션 도구"↔"섹션도구" 동일 캐시 키. ⑤ `useNamespaceAccess` hook 추출 — KnowledgeTable·GlossaryTable·FewshotTable 중복 코드 제거. ⑥ Http* 타입 별칭 완전 제거 (`httpTools.ts` 삭제, `McpTool` 계열로 통합). ⑦ asyncpg TIMESTAMPTZ 파라미터 버그 수정 (`str` → `datetime` 변환으로 24h 필터 500 에러 수정). ⑧ McpToolManager 네임스페이스 미선택 시 서브탭 노출 버그 수정. ⑨ 모달 로그 조회 silently fail 버그 수정 (catch 블록 + error state 추가)
- **MCP 호출 로그 전면 개편** (2026-03-17): 도구별 집계 테이블 (호출 수·성공률·평균응답시간·마지막 호출), 도구 클릭 → 모달(도넛차트 + 페이지네이션 로그 목록 + 행 토글로 파라미터 상세), 시간 필터 (1h/24h/7d/30d/직접입력), backend `GET /api/mcp-tools/logs/stats` 추가, 기존 logs API 페이지네이션+시간필터 확장
- **캐시 임계값 하향 + UI 개선** (2026-03-17): 유사도 임계값 0.92 → **0.88** (한국어 단문 매칭 개선), CachePanel 자동갱신 `refetchInterval: 10s` + `refetchOnMount: always`, McpToolManager Globe → Wrench 아이콘, 파트 미선택 상태 도구 노출 버그 수정
- **Semantic Cache DB 영속화 + 버그 수정** (2026-03-17): `ops_system_config` 테이블 신설, 앱 시작 시 DB 설정 자동 로드, `int(bytes)` TypeError 수정 (히트·저장캐시 0 고정 버그), 캐시 저장 조건 완화 (LLM 정상 응답이면 항상 저장), MCP 도구 에이전트 캐시 체크 추가 (Case 3 앞단)
- **MCP 도구 전면 리네임 + 기능 강화** (2026-03-17): `ops_http_tool` → `ops_mcp_tool`, `hub_base_url`+`tool_path` 분리 구조, `ops_mcp_tool_log` 감사 로그 테이블, `agents/http_tool` → `agents/mcp_tool`, Admin 탭명 변경
- **Semantic Cache 임계값·TTL 런타임 설정** (2026-03-17): `GET/PUT /api/admin/cache/config` 확장, LLMSettings 검색설정 서브탭 슬라이더 UI, Cache API 이중 `/api` 버그 수정
- **HTTP 도구 채팅 버그 수정** (2026-03-16): `_coerce_params` 타입 변환, 선택 파라미터 기본값 전송, Case 2 파라미터 폼 항상 표시, 필수 파라미터 유효성 검사 강화
- **HTTP 도구 에이전트 고도화** (2026-03-16): RAG 컨텍스트 통합, HTTP+RAG 병렬화, HTTP 실패 시 RAG-only 폴백, 도구 재선택 플로우
- **초기 개발** (2026-03-12~13): HTTP 도구 시스템 MVP, AgentBase/AgentRegistry 도입, DDD 구조 전환, JWT 인증, Semantic Cache, Few-shot 라이프사이클, Glossary AI 추천, 멀티턴 검색, 사내 LLM DevX 연동

---

## 알려진 이슈

| # | 증상 | 우선도 |
|---|------|--------|
| 1 | 라이트모드 `bg-slate-N` 다크 네이비로 렌더링 | 낮음 (zinc로 우회 완료) |
| 2 | 시맨틱 캐시 의도 변형 히트 불가 | 낮음 — 구조적 한계. 임계값 0.80으로 낮추거나 LLM 의도 추출 기반 캐시로 전환 필요 (현재 LLM 재호출 비용 문제로 보류) |

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
