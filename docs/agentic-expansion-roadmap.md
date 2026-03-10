# Ops-Navigator Agentic 확장 로드맵

> **목적**: 현재 하드코딩 RAG 파이프라인을 LLM Tool Use + MCP 기반 자율 Agent로 전환하기 위한 설계 문서.
> **작성일**: 2026-03-10

---

## 1. 현재 구조 vs 목표 구조

### 현재: 하드코딩 파이프라인

```
질문 → 용어매핑 → 하이브리드검색 → 퓨샷 → 프롬프트 조립 → LLM → 답변
         (항상)      (항상)        (항상)     (고정)
```

- 모든 질문에 동일한 5단계 실행 (인사에도 검색 수행)
- 1회 검색 결과가 전부 (실패 시 대응 없음)
- 단일 네임스페이스만 검색

### 목표: LLM Tool Use Agent

```
질문 → LLM 판단 → [필요한 Tool만 선택적 호출] → 답변
                    ↑ 결과 부족 시 재시도/전략 변경
```

- LLM이 질문 성격에 따라 도구 선택 (검색 0~N회)
- 결과 불충분 시 키워드 변경, 다른 네임스페이스 재검색
- 쓰기 도구로 지식 자동 축적 가능

---

## 2. MCP Tool 후보 함수

### 1순위 — 읽기 도구 (LLM 자율 호출)

| Tool Name | 현재 함수 | 설명 |
|---|---|---|
| `search_knowledge` | `retrieval.py:search_knowledge()` | 네임스페이스별 하이브리드 검색 (vector + keyword) |
| `map_glossary_term` | `retrieval.py:map_glossary_term()` | 질문 → 용어 매핑 (유사도 기반) |
| `fetch_fewshots` | `retrieval.py:fetch_fewshots()` | 유사 Q&A 예시 조회 |
| `retrieve_relevant_summaries` | `memory.py:retrieve_relevant_summaries()` | 과거 대화 요약 시맨틱 리콜 |
| `list_glossary` | `knowledge/service.py:list_glossary()` | 용어 사전 조회 |

### 2순위 — 조회 도구 (상황 파악용)

| Tool Name | 현재 함수 | 설명 |
|---|---|---|
| `list_namespaces` | `admin/service.py:list_namespaces_detail()` | 사용 가능한 네임스페이스 목록 |
| `list_knowledge` | `knowledge/service.py:list_knowledge()` | 지식 문서 목록 |
| `load_recent_history` | `memory.py:load_recent_history()` | 최근 대화 이력 |
| `get_namespace_stats` | `admin/router.py` 내부 로직 | 네임스페이스별 통계 |

### 3순위 — 쓰기 도구 (human-in-the-loop 승인 필요)

| Tool Name | 현재 함수 | 설명 |
|---|---|---|
| `create_knowledge` | `knowledge/service.py:create_knowledge()` | 새 지식 등록 |
| `create_glossary` | `knowledge/service.py:create_glossary()` | 용어 추가 |
| `resolve_query_log` | `admin/router.py` 내부 로직 | 미해결 질의 → 지식 자동 등록 |
| `create_fewshot` | `fewshot/router.py` 내부 로직 | Few-shot 예시 추가 |

### 함수 시그니처 적합성

현재 함수들이 이미 Tool 스키마로 변환하기 좋은 구조:
- 명확한 input/output
- namespace 기반 스코핑 (권한 모델 재활용 가능)
- 독립적 실행 가능 (상호 의존성 낮음)

---

## 3. Agent 자율 흐름 시나리오

### Flow 1: 적응형 RAG (검색 스킵)

```
User: "안녕"
Agent 판단: 인사 → tool 호출 0회 → 바로 답변
```

현재는 "안녕"에도 용어매핑→검색→퓨샷 전부 실행됨. 불필요한 임베딩/검색 비용 절감.

### Flow 2: 멀티스텝 검색 (재시도)

```
User: "배포 후 롤백 절차가 어떻게 되지?"

① search_knowledge(ns="infra", "배포 롤백 절차") → sim 낮음
② Agent: 다른 각도로 재검색
   search_knowledge(ns="infra", "deployment rollback") → 성공
③ 보충 필요 → search_knowledge(ns="devops", "롤백 스크립트")
④ 종합 답변 생성
```

### Flow 3: 용어 연쇄 탐색

```
User: "CMS 콘텐츠 승인 프로세스 설명해줘"

① map_glossary_term("CMS 콘텐츠 승인") → "CONTENT_APPROVAL"
② search_knowledge(term="CONTENT_APPROVAL") → 승인 문서
③ 문서 내 "워크플로우 엔진" 언급 발견
④ map_glossary_term("워크플로우 엔진") → "WORKFLOW_ENGINE"
⑤ search_knowledge(term="WORKFLOW_ENGINE") → 엔진 문서
⑥ 두 문서 종합 답변
```

### Flow 4: 대화 맥락 인식

```
Turn 1: "주문 테이블 구조 알려줘" → 검색 → 답변
Turn 2: "거기서 환불은?"
  ① load_recent_history() → "주문 테이블" 맥락 파악
  ② retrieve_relevant_summaries("주문 환불") → 과거 대화
  ③ search_knowledge("주문 테이블 환불 컬럼")
  ④ fetch_fewshots("주문 환불 처리")
  ⑤ 맥락 + 검색 + 예시 종합 답변
```

### Flow 5: 자기 검증 (교차 확인)

```
User: "ops_order 테이블의 status 컬럼 값 종류"

① search_knowledge → 문서 A: 4개 값
② fetch_fewshots → 과거 답변에서 "CANCELLED" 추가 발견
③ list_glossary → "ORDER_STATUS" 정의에 5개 값 확인
④ 교차 검증된 답변 생성
```

### Flow 6: 지식 자동 축적 (쓰기 도구)

```
User: "PG사 연동 방식 정리해줘"
  ① search_knowledge("PG사 연동") → 없음
  ② Agent: "관련 지식이 없습니다. 알려주시면 등록해드릴까요?"
User: "토스페이먼츠 API v2, 웹훅으로 결과 받아"
  ③ 사용자 승인 후
     create_knowledge(ns="payment", content=...)
     create_glossary(ns="payment", term="PG_INTEGRATION", ...)
```

### Flow 7: 미해결 질의 자동 처리

```
[관리자 요청 또는 배치 트리거]
① get_namespace_stats("infra") → 미해결 5건
② 각 건에 search_knowledge → 유사 지식 존재?
   YES (sim > 0.8) → resolve_query_log 자동
   NO → 보류, 알림
③ 리포트: "5건 중 3건 자동 해결, 2건 검토 필요"
```

### Flow 8: 크로스 네임스페이스 횡단 검색

```
User: "신규 입사자 온보딩 전체 절차"

① list_namespaces() → ["hr", "infra", "security", "devops"]
② Agent: 온보딩은 여러 파트에 걸침
   search_knowledge(ns="hr", "입사 절차")
   search_knowledge(ns="infra", "장비 세팅")
   search_knowledge(ns="security", "보안 교육")
   search_knowledge(ns="devops", "개발환경 설정")
③ 4개 NS 결과를 단계별로 종합
```

---

## 4. 통제 메커니즘 (가드레일)

### a) Tool 레벨 정책

```python
TOOL_POLICY = {
    # 읽기: 자유 호출, 횟수 cap
    "search_knowledge":          {"max_calls_per_turn": 5, "requires_approval": False},
    "map_glossary_term":         {"max_calls_per_turn": 3, "requires_approval": False},
    "fetch_fewshots":            {"max_calls_per_turn": 2, "requires_approval": False},
    "retrieve_relevant_summaries": {"max_calls_per_turn": 2, "requires_approval": False},
    "list_glossary":             {"max_calls_per_turn": 2, "requires_approval": False},
    "list_namespaces":           {"max_calls_per_turn": 1, "requires_approval": False},

    # 쓰기: 사용자 확인 필수
    "create_knowledge":          {"max_calls_per_turn": 1, "requires_approval": True},
    "create_glossary":           {"max_calls_per_turn": 1, "requires_approval": True},
    "resolve_query_log":         {"max_calls_per_turn": 3, "requires_approval": True},
}
```

### b) 전역 제한

- 1턴당 최대 tool call: **10회** (초과 시 강제 답변 생성)
- 1턴당 최대 토큰 소비: **임계치 설정** (서킷 브레이커)
- 네임스페이스 스코핑: 사용자 접근 권한 내에서만 (기존 파트 기반 권한 재활용)
- 크로스 NS 검색: 관리자 토글로 허용/비허용 설정

### c) Human-in-the-loop

- 쓰기 도구는 Agent가 "제안" → 사용자가 "승인" → 실행
- 프론트엔드에서 확인 모달 표시 후 실행

---

## 5. 관리자 감독 기능

### 5-1. 데이터 저장: tool_trace

`ops_query_log` 테이블에 `tool_trace JSONB` 컬럼 추가:

```json
[
  {"tool": "map_glossary_term", "input": {"query": "배포 롤백"}, "sim": 0.62, "result": "DEPLOYMENT", "latency_ms": 82},
  {"tool": "search_knowledge", "input": {"ns": "infra", "top_k": 3}, "hits": 2, "max_sim": 0.45, "latency_ms": 45},
  {"tool": "search_knowledge", "input": {"ns": "devops", "query": "rollback"}, "hits": 1, "max_sim": 0.85, "latency_ms": 38},
  {"tool": "fetch_fewshots", "input": {}, "hits": 1, "latency_ms": 22}
]
```

### 5-2. Level 1: 개별 대화 트레이스 뷰어

통계 > 질의 로그 목록에서 특정 건 클릭 시 표시:

```
┌─ 질의 #1042 ─────────────────────────────────────────────┐
│  질문: "배포 후 롤백 절차가 어떻게 되지?"                 │
│  답변: "1. ArgoCD에서 이전 리비전 선택..."                │
│  피드백: 👍 긍정                                          │
│  ─────────────────────────────────────────────────────── │
│  🔧 Tool 실행 흐름 (4단계, 1.2초)                        │
│                                                           │
│  ① map_glossary_term ─── 82ms                            │
│     → "DEPLOYMENT" (sim: 0.62)                            │
│           ↓                                               │
│  ② search_knowledge (ns: infra) ─── 45ms                 │
│     → 2건 (sim: 0.45, 0.38) ⚠️ 낮음                     │
│           ↓  Agent: "유사도 낮음, 재검색"                 │
│  ③ search_knowledge (ns: devops) ─── 38ms                │
│     → 1건 (sim: 0.85) ✅ 충분                            │
│           ↓                                               │
│  ④ fetch_fewshots ─── 22ms                               │
│     → 1건 예시                                            │
│           ↓                                               │
│  📝 답변 생성 (컨텍스트: 3문서 + 1예시, 토큰: 2,847)    │
│                                                           │
│  [컨텍스트 원문 보기]  [프롬프트 전문 보기]               │
└───────────────────────────────────────────────────────────┘
```

- 현재 디버그 미리보기 모달 패턴 재활용
- 각 단계 클릭 시 input/output 원문 확인 가능

### 5-3. Level 2: 집계 대시보드

통계 대시보드에 **"Agent 행동 분석"** 섹션 추가:

| 차트/지표 | 데이터 소스 | 용도 |
|---|---|---|
| 검색 성공률 | tool_trace + feedback JOIN | 전체 답변 품질 모니터링 |
| 평균 Tool 호출 수/턴 | tool_trace 배열 길이 평균 | Agent 효율성 확인 |
| NS별 재검색률 | 같은 NS 2회+ 호출 비율 | 지식 보강 필요 영역 식별 |
| Tool 사용 분포 | tool_trace.tool 집계 | Agent 행동 패턴 이해 |
| 주의 항목 알림 | 연속 실패 / 부정 피드백 패턴 | 관리자 액션 유도 |

---

## 6. 피드백 루프 (정확도 자동 개선)

### 6-1. 검색 품질 자동 튜닝

tool_trace 로그에서 추출 가능한 데이터:
- 검색 유사도 분포 (매 tool call마다 sim score)
- 사용자 피드백 (ops_feedback)
- 재검색 빈도

분석 → 반영:

| 분석 결과 | 반영 위치 | 방법 |
|---|---|---|
| NS별 최적 가중치 | `ops_namespace` 테이블 (w_vector, w_keyword 컬럼 추가) | 검색 시 NS별 가중치 자동 적용 |
| 동의어 발견 ("배포"→"deployment") | `ops_glossary` synonym | 검색 시 자동 쿼리 확장 |
| 지식 갭 주제 | 미해결 질의 클러스터링 | 관리자에게 "지식 등록 필요" 리포트 |
| 낮은 품질 문서 | `ops_knowledge` quality_score | 검색 히트 대비 부정 피드백 비율 |

### 6-2. Agent 행동 최적화

```
로그 분석:
  "map_glossary_term 호출 후 sim < 0.3 → 결과 미사용" 비율 40%

→ 시스템 프롬프트에 "유사도 0.3 미만 예상 시 용어 매핑 생략" 반영
```

```
로그 통계:
  패턴 A: glossary → search → answer (피드백 3.2/5)
  패턴 B: search → fewshot → answer (피드백 4.1/5)

→ 시스템 프롬프트에 "fewshot 먼저 참고" 반영
```

### 6-3. 성공 패턴의 Few-shot 자동 등록

```
"검색 실패 → 키워드 변경 → 성공" 케이스 추출
  → ops_fewshot에 자동 등록
  → 다음에 비슷한 질문 시 fetch_fewshots로 참조
```

### 피드백 데이터 흐름 요약

```
tool_trace 로그 (JSONB)
    ↓
┌───────────────────────────────────────┐
│  반영 위치            참조 시점       │
│                                       │
│  ops_namespace         검색 시 NS별   │
│  (w_vector 등)         가중치 자동적용│
│                                       │
│  ops_glossary          용어 매핑 시   │
│  (synonym)             확장 검색      │
│                                       │
│  ops_fewshot           fetch_fewshot  │
│  (성공 패턴)           으로 자동 참조 │
│                                       │
│  system_prompt         Agent 프롬프트 │
│  (search_hints)        조립 시 삽입   │
│                                       │
│  ops_knowledge         검색 랭킹 시   │
│  (quality_score)       가중치 반영    │
└───────────────────────────────────────┘
```

---

## 7. 구현 우선순위

### Phase 1: 기반 (Tool Use 도입)

1. 1순위 함수 5개를 MCP Tool 스키마로 래핑
2. `ops_query_log`에 `tool_trace JSONB` 컬럼 추가
3. 기존 하드코딩 파이프라인을 Tool Use 방식으로 전환
4. Tool 정책 (max_calls, requires_approval) 적용

### Phase 2: 감독 (관리자 뷰)

5. 개별 트레이스 뷰어 (디버그 미리보기 확장)
6. 집계 대시보드 (Agent 행동 분석 섹션)

### Phase 3: 자동 개선 (피드백 루프)

7. tool_trace + feedback 분석 배치/리포트
8. NS별 가중치 자동 조정
9. 성공 패턴 Few-shot 자동 등록
10. 시스템 프롬프트 동적 관리 (프롬프트 템플릿 CRUD — 기존 백로그 항목)

### Phase 4: 확장 (쓰기 Agent)

11. 쓰기 도구 (create_knowledge, create_glossary) Tool 등록
12. Human-in-the-loop 승인 UI
13. 미해결 질의 자동 처리 흐름

---

## 8. 현재 프로젝트와의 호환성

| 기존 구조 | 확장 시 재활용 |
|---|---|
| 파트 기반 네임스페이스 권한 | Tool의 네임스페이스 스코핑 |
| 디버그 미리보기 (5단계) | 동적 트레이스 뷰어 |
| ops_query_log (질문/답변/상태) | + tool_trace 컬럼 |
| ops_feedback (좋아요/싫어요) | + tool_trace JOIN 분석 |
| 통계 대시보드 (도넛 차트) | + Agent 행동 분석 차트 |
| 프롬프트 템플릿 동적 관리 (백로그) | search_hints 주입 |
| 검색 설정 중앙화 (config → API) | NS별 가중치 확장 |

별도 ML 파이프라인이나 외부 시스템 없이, 기존 PostgreSQL + JSONB 쿼리 + 현재 UI 패턴으로 구현 가능.
