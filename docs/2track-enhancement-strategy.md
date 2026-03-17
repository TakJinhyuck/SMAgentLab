# 2-Track AI 고도화 전략

> **기준일**: 2026-03-17 (최종 업데이트)
> **전제**: 사내 표준(MCP Protocol, LLM Provider, Auth, API Gateway)은 준수 대상이지 설계 대상이 아님.
> 우리 팀이 **독자적으로 컨트롤하는 레이어**에서 정확도·효율화를 극대화하는 전략.

---

## 전체 구조: 역할 분리

```
┌─────────────────────────────────────────────────────────────────┐
│                     사내 공통 인프라 (준수)                        │
│                                                                   │
│   MCP Tool Hub          LLM Provider       Auth / API Gateway     │
│   ├── 배포 API Tool      사내 LLM 서버       JWT / 방화벽           │
│   ├── 모니터링 API Tool                                            │
│   ├── 쿠폰 API Tool                                               │
│   └── ...공통 Tool 풀                                             │
│                                                                   │
│   → Tool 정의·등록·관리는 MCP 허브 팀 담당. 우리는 사용자.           │
└──────────────────────┬──────────────────────────────────────────┘
                       │ MCP Tool 호출 / LLM API
         ┌─────────────┴──────────────┐
         │                            │
   Track A                      Track B
   지식 정확도 레이어              MCP 오케스트레이션 레이어
   (RAG 고도화)                  (Tool 조합 + 워크플로우)
         │                            │
   우리 팀 pgvector DB           사내 MCP Tool 구독 관리
   우리 팀 Embedding 파이프라인   Tool 선택·체이닝·승인 흐름
   팀 전용 지식 자산 누적          RAG + Tool 통합 답변
```

**Track A** — 질문에 대해 더 정확한 답을 내는 것 (RAG 파이프라인 고도화)

**Track B** — MCP Tool을 잘 조합해서 반복 업무를 AI가 처리하게 만드는 것

Tool 자체를 만드는 건 MCP 허브 팀. **Tool을 잘 선택하고, 연결하고, 지식과 결합하는 건 우리 팀.**

---

## Track A — 지식 정확도 고도화

### A-1. 고도화 가능한 기존 기능

#### ① 하이브리드 검색 가중치 자동 학습

**현재**: `w_vector=0.7, w_keyword=0.3` 고정값 (관리자가 슬라이더로 수동 조정)

**고도화**: Feedback 데이터로 최적 가중치 자동 학습

```
흐름:
ops_feedback (긍정/부정) + ops_query_log (검색 당시 w_vector, w_keyword, top_k)
  → 주 1회 배치: 긍정 피드백이 많은 파라미터 조합 분석
  → namespace별 최적 가중치를 ops_namespace_config에 자동 저장
  → 다음 검색부터 해당 namespace의 학습된 가중치 사용

저장 구조:
ops_namespace_config (key: "optimal_w_vector", value: "0.65", updated_at)
```

**파괴적 효과**: 사람이 임계값을 건드리지 않아도 namespace마다 최적화된 검색 비중이 자동으로 수렴. 도입 후 3~4주면 피드백 누적으로 명확한 차이 발생.

---

#### ② 용어 사전(Glossary) 자동 확장

**현재**: 관리자가 수동으로 용어+설명을 등록. 임베딩 기반 최근접 용어 1개 매핑.

**고도화**: 대화 로그에서 미매핑 질문 패턴을 자동 감지 → 신규 용어 후보 생성

```
흐름:
1. ops_query_log 중 mapped_term IS NULL && feedback 부정인 레코드 분류
2. LLM: "이 질문들에서 공통 업무 용어를 추출해줘" → 용어 후보 리스트
3. 어드민 UI: "미등록 용어 추천" 탭 → 관리자가 1-click 승인
4. 승인 즉시 임베딩 생성 + ops_glossary 등록

승인 전까지 자동 등록하지 않음 (hallucination 방지)
```

**파괴적 효과**: 현재 "용어 등록을 잊으면 영원히 못 찾는" 구조에서, 운영하면서 자연스럽게 용어 사전이 두꺼워지는 구조로 전환. 6개월 운영 후 Glossary가 팀의 독자 자산이 됨.

---

#### ③ Few-shot 자동 학습 (피드백 기반)

**현재**: 관리자가 Q&A 쌍을 수동으로 등록. 유사 질문 시 few-shot으로 LLM에 주입.

**고도화**: 긍정 피드백 받은 대화를 few-shot 후보로 자동 등록

```
흐름:
1. 대화 종료 후 사용자 👍 → ops_feedback에 positive 저장
2. 비동기 워커: feedback_type=positive인 (question, answer) 쌍 → ops_fewshot_candidate 저장
3. 어드민 UI: "few-shot 후보" 탭 → 관리자 검토 후 ops_fewshot으로 승인
4. 승인된 Q&A는 임베딩 생성 후 검색에 즉시 반영

ops_fewshot_candidate (신규 테이블):
  id, namespace_id, question, answer, msg_id, created_at, status(pending/approved/rejected)
```

**파괴적 효과**: 운영팀의 노하우가 AI 답변으로 자동 전사. 3개월 운영 후 비슷한 질문에서 정확도가 급상승. "팀이 쓸수록 AI가 똑똑해지는" 복리 효과.

---

#### ④ 멀티턴 메모리 품질 개선

**현재**: 4회 교환마다 LLM이 요약 → pgvector에 저장 → 유사도 0.45 이상 시 리콜.

**고도화**: 요약 구조화 + 리콜 기준 namespace별 튜닝

```
개선 1 — 요약 구조화:
현재: "3~5문장 요약"
개선: 구조화된 요약 포맷 강제
  {"topic": "쿠폰 처리 오류", "resolved": true,
   "key_facts": ["테이블명: ops_coupon", "상태코드: ERR_04"],
   "unresolved": []}
  → LLM 컨텍스트에 삽입 시 더 정밀한 정보 제공

개선 2 — 미해결 이슈 장기 보존:
resolved=false인 요약은 만료 없이 유지
resolved=true는 TTL 적용 (오래된 해결 이슈 자동 정리)
```

---

### A-2. 신규 추가로 정확도를 높이는 기능

#### ⑥ RAGAS 오프라인 품질 평가 파이프라인

**없는 이유**: 현재 "피드백 긍정/부정" 외에 정량 품질 지표 없음.

**설계**:
```
평가 지표 (LLM-as-Judge 방식, 사내 LLM 사용):
  - Faithfulness: 답변이 검색된 컨텍스트에만 근거하는가 (0~1)
  - Context Utilization: 상위 검색 결과를 실제로 활용했는가 (0~1)
  - Answer Completeness: 질문의 모든 의도를 커버했는가 (0~1)

실행 방식:
  1. 주 1회 배치 — ops_query_log 최근 100건 샘플링
  2. (question, context_docs, answer) 3쌍을 LLM에게 평가 요청
  3. ops_eval_result 테이블에 저장
  4. 어드민 "품질 리포트" 탭: 주간 평균 트렌드 차트

ops_eval_result (신규 테이블):
  id, query_log_id, evaluated_at, faithfulness,
  context_utilization, answer_completeness, unfaithful_claims JSONB
```

**파괴적 효과**: "왠지 요즘 답변이 이상한 것 같다"가 아닌 수치로 회귀를 감지. Glossary 추가/문서 업데이트 후 품질 변화를 정량 비교. 의사결정 근거가 생김.

---

#### ⑦ Parent-Document Retrieval

**없는 이유**: 현재 단일 chunk 검색+반환. chunk가 작을수록 검색 정확도 ↑, 크면 컨텍스트 품질 ↑ — 둘 다 잡으려면 분리 필요.

**설계**:
```
현재: ops_knowledge (chunk) → 검색 & 반환 동일 레코드

개선:
ops_knowledge
  ├── parent chunk (embedding=NULL, content=전체 섹션)
  └── child chunk (embedding=✓, content=300자 이내 소단위, parent_id FK)

검색: child chunk 임베딩으로 정밀 매칭
반환: parent chunk 전체 content를 LLM 컨텍스트에 삽입 (맥락 풍부)

스키마: ops_knowledge에 parent_id INT NULL 컬럼 추가
업로드 시 chunk 전략 선택 가능 (기존 / parent-child)
```

**파괴적 효과**: 긴 운영 매뉴얼에서 "정확한 섹션은 찾지만 앞뒤 맥락이 없어 엉뚱한 답변" 문제 해결. 문서 품질이 높을수록 답변 품질이 선형으로 오름.

---

## Track B — MCP Tool 오케스트레이션 레이어

> MCP 허브가 Tool을 제공하면, 우리 팀은 그걸 **어떻게 쓸지**를 담당.
> Tool 등록·관리는 허브 팀. 선택·조합·승인·지식 통합은 우리 팀.

### 우리 팀 역할 구조

```
[사내 MCP 허브]          [우리 팀 오케스트레이션 레이어]
  Tool 풀 제공      →    1. namespace별 Tool 구독 (on/off)
                         2. 사용자 질문 → LLM이 Tool 선택
                         3. 파라미터 추출 + 사용자 승인
                         4. Tool 응답 + RAG 지식 통합 → 최종 답변
                         5. Tool 체이닝 (A 결과 → B 입력)
                         6. 호출 이력 감사 로그
```

`ops_http_tool` 테이블의 역할 변화:
- **현재**: Tool URL/헤더/파라미터 직접 저장 (우리가 등록)
- **앞으로**: MCP 허브 Tool 중 우리 namespace가 구독하는 목록 + on/off 상태 관리

---

### B-1. 고도화 가능한 기존 기능

#### ⑧ MCP Tool 조건부 체이닝

**현재**: Tool A 호출 → 결과 → LLM 답변. 단방향 1회.

**고도화**: Tool A 응답의 특정 필드를 Tool B 파라미터에 자동 바인딩 (조건부)

```
설계 — ops_mcp_tool_subscription에 chain_config JSONB 컬럼 추가:
{
  "next_tool_id": 7,
  "condition": "$.data.status == 'ERROR'",   // JSONPath 조건
  "param_mapping": {
    "containerId": "$.data.id",              // A 응답 필드 → B 파라미터
    "errorCode": "$.data.error.code"
  }
}

실행 흐름:
MCP Tool A 호출 → 응답 파싱 → condition 평가
  → true: param_mapping으로 Tool B 파라미터 자동 채움 → 사용자 승인 → Tool B 호출
  → false: Tool A 결과로만 LLM 답변

사용자 경험:
"장애 컨테이너 상태 확인"
  → Tool A: 컨테이너 목록 조회 → 이상 컨테이너 발견
  → 자동 연결: "이 컨테이너 상세 로그도 조회할까요?" (파라미터 자동 채움)
  → 승인 → Tool B 호출
```

**파괴적 효과**: "질문 → 확인 → 다시 질문 → 확인" 반복을 "질문 → 승인 → 승인"으로 단축. 장애 대응 시나리오에서 특히 극적.

---

#### ⑨ MCP Tool 호출 감사 로그

**현재**: Tool 호출 결과가 ops_message에 텍스트로만 남음. 누가 어떤 파라미터로 호출했는지 추적 불가.

**고도화**: 구조화된 감사 로그

```sql
-- ops_mcp_tool_log (신규 테이블)
CREATE TABLE ops_mcp_tool_log (
  id              SERIAL PRIMARY KEY,
  mcp_tool_name   VARCHAR(100),          -- MCP 허브 Tool 식별자
  user_id         INT REFERENCES ops_user(id),
  namespace_id    INT REFERENCES ops_namespace(id),
  msg_id          INT REFERENCES ops_message(id),
  params          JSONB,
  response_status INT,
  response_kb     FLOAT,
  duration_ms     INT,
  error           TEXT,
  called_at       TIMESTAMPTZ DEFAULT NOW()
);
```

어드민 UI: Tool별 호출 빈도 / 평균 응답 시간 / 에러율 차트
운영팀: "이 Tool을 누가, 언제, 어떤 파라미터로 썼는지" 즉시 확인

**파괴적 효과**: MCP 허브 API rate limit 이슈 발생 시 원인 즉시 파악. 실제로 많이 쓰이는 Tool vs 사장된 Tool 데이터 기반 관리. MCP 허브 팀에 사용 현황 피드백 가능.

---

### B-2. 신규 추가로 효율화를 극대화하는 기능

#### ⑩ 반복 질문 Semantic Cache

**없는 이유**: 현재 동일한 질문도 매번 임베딩 → 벡터 검색 → LLM 호출 전 과정 반복.

**설계**:
```
캐시 레이어 (Redis):
질문 임베딩 → Redis에서 코사인 유사도 > 0.97 탐색
  → 히트: 저장된 답변 즉시 스트리밍 (< 100ms)
  → 미스: 정상 파이프라인 실행 → 결과를 Redis 저장 (TTL 30분)

캐시 대상: knowledge_rag 에이전트만
           (MCP Tool 호출은 실시간 데이터라 제외)
키 구조: "semcache:{namespace}:{embedding_hash}"
메모리: maxmemory 256MB, allkeys-lru

docker-compose.yml 추가:
  ops-redis:
    image: redis:7-alpine
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
```

**파괴적 효과**: "아침 출근 후 동일한 운영 질문이 10명에게서 들어오는" 패턴에서 2번째 이후는 LLM 호출 없이 응답. 사내 LLM 부하 절감 + 응답 속도 극적 향상.

---

#### ⑪ ReAct 멀티홉 오케스트레이터 (신규 에이전트)

**없는 이유**: 현재 "질문 1개 → 답변 1개" 단방향. 복합 질문에서 MCP Tool 여러 개를 순차 조합 불가.

**설계**: 기존 `AgentBase` 위에 while-loop — LangGraph 불필요.

```
Thought → Action → Observation 루프 (최대 4스텝)

사용 가능한 Action:
  - mcp_tool_call: 사내 MCP Tool 호출 (사용자 승인 포함)
  - rag_search: 우리 팀 지식베이스 검색 (승인 불필요)
  - final_answer: 수집된 정보로 최종 답변 생성
```

**사용 시나리오**:
```
Q: "지난주 배포 이후 에러율 올라간 컨테이너 확인하고 담당자 찾아줘"

Step 1 — Thought: "배포 이력 MCP Tool로 지난주 배포 목록 조회"
         Action: mcp_tool_call → 배포이력조회Tool
         Obs: [{container: "order-svc", deployed: "2026-03-10"}, ...]

Step 2 — Thought: "order-svc 에러율 확인 필요"
         Action: mcp_tool_call → 모니터링Tool (container=order-svc)
         Obs: {error_rate: 0.34, baseline: 0.02}

Step 3 — Thought: "에러율 급증 확인. 담당자는 지식베이스에서"
         Action: rag_search → "order-svc 담당자"
         Obs: "order 서비스 담당: 홍길동 (010-...)"

Step 4 — final_answer: 세 단계 정보를 통합한 장애 보고서 생성
```

**파괴적 효과**: 장애 대응 시 "API 확인 → 지식베이스 검색 → 담당자 찾기"를 사람이 3번 질문하던 것을 AI가 자율 처리. MCP Tool이 추가될수록 조합 가능한 시나리오가 기하급수적으로 늘어남.

---

#### ⑫ 사용자별 질문 패턴 분석 + 지식 보강 우선순위

**없는 이유**: 현재 "지식베이스에 뭘 더 넣어야 하는지" 감으로 결정.

**설계**:
```
ops_query_log 집계 분석:
  - mapped_term IS NULL && has_results=false → 지식 공백 영역
  - feedback=negative가 많은 질문 유형 → 보강 우선순위
  - MCP Tool 호출 후에도 RAG 결과 없는 패턴 → Tool+지식 공백 동시 탐지

어드민 "인사이트" 탭:
  - 답변 실패율 높은 질문 Top 10 → "이 영역 문서 추가 필요"
  - 가장 많이 묻는 질문 → Semantic Cache 후보
  - MCP Tool 사용 후 추가 질문 패턴 → Tool 체이닝 시나리오 발굴
```

**파괴적 효과**: 문서 관리가 "담당자 판단"에서 "데이터 기반 우선순위"로 전환. Tool 체이닝 시나리오도 사용 데이터에서 자연스럽게 발굴됨.

---

## 우선순위 + 파괴적 효과 매트릭스

> 파괴적 효과 ↓ 순 정렬. 동일 효과면 구현 규모 작은 것 우선.

| 순위 | 기능 | 구현 규모 | 파괴적 효과 | 효과 발현 시점 |
|------|------|-----------|-------------|----------------|
| **1** | ~~⑩ Semantic Cache~~ ✅ | 소 (Redis + 30줄) | ★★★★★ | 즉시 |
| **2** | ~~③ Few-shot 라이프사이클~~ ✅ | 소 (status 컬럼 + UI) | ★★★★★ | 즉시 |
| **3** | ~~② Glossary AI 추천~~ ✅ | 소 (LLM 호출 + 버튼 UI) | ★★★★★ | 즉시 |
| **4** | ⑧ MCP Tool 체이닝 | 중 (스키마 + 실행 로직) | ★★★★★ | 즉시 (등록 후) |
| **5** | ⑪ ReAct 오케스트레이터 | 대 (신규 에이전트) | ★★★★★ | 즉시 (등록 후) |
| **6** | ⑥ RAGAS 평가 파이프라인 | 중 (배치 + 테이블) | ★★★★☆ | 첫 실행 후 |
| **8** | ① 가중치 자동 학습 | 중 (배치 + config) | ★★★★☆ | 3~4주 후 |
| **9** | ⑦ Parent-Document Retrieval | 대 (스키마 + 재인덱싱) | ★★★★☆ | 문서 이전 후 |
| **10** | ⑨ MCP Tool 감사 로그 | 소 (테이블 + UI) | ★★★☆☆ | 즉시 |
| **11** | ④ 멀티턴 메모리 개선 | 소~중 | ★★★☆☆ | 즉시 |
| **12** | ⑫ 질문 패턴 분석 | 중 (집계 뷰 + UI) | ★★★☆☆ | 데이터 누적 후 |

---

## 단계별 실행 계획

### Phase 2-A — 즉시 수확 (1~2주) ✅ 완료

1. **Semantic Cache** ✅ — `shared/cache.py` + Redis 컨테이너 + KnowledgeRagAgent 통합 + 어드민 캐시 현황 UI (`CachePanel.tsx`: 통계·목록·초기화)
2. **MCP Tool 감사 로그** — `ops_mcp_tool_log` 테이블 + Tool 호출 후 로그 저장

### Phase 2-B — 지식 자산 자동화 (1~2개월) ✅ 일부 완료

> 운영할수록 AI가 똑똑해지는 구조 구축

4. **Few-shot 라이프사이클** ✅ — `ops_fewshot.status` 컬럼 (active/candidate) + 피드백 시 candidate로 저장 + 어드민 status 필터·활성화/후보 전환 UI
5. **Glossary AI 추천** ✅ — 미매핑 질문 on-demand LLM 분석 + 어드민 "AI 용어 추천" 버튼 + 1-click 등록 + 조회 한도 어드민 UI에서 설정 가능(기본 50건, 최대 200건)
6. **가중치 자동 학습** — `ops_namespace_config` 테이블 + 주간 배치 최적화

### Phase 2-C — 품질·인사이트 가시화 (2~3개월)

> 의사결정을 데이터로

7. **RAGAS 평가 파이프라인** — `ops_eval_result` 테이블 + 배치 스크립트 + 어드민 품질 리포트 탭
8. **질문 패턴 분석** — 집계 뷰 + 어드민 "인사이트" 탭 (지식 보강 우선순위 + Tool 체이닝 시나리오 발굴)

### Phase 3 — 오케스트레이션 고도화 (3~6개월)

> MCP Tool 조합으로 복합 업무 처리

9. **MCP Tool 체이닝** — `chain_config JSONB` + JSONPath 바인딩 실행기
10. **ReAct 오케스트레이터** — `agents/react/agent.py` 신규 에이전트 등록
11. **멀티턴 메모리 개선** — 구조화된 요약 포맷 전환
12. **Parent-Document Retrieval** — 스키마 변경 + 재인덱싱

---

## 우리 팀 경쟁 우위

```
6개월 후 동일한 사내 LLM + MCP Tool을 쓰는 다른 팀과의 차이:

[다른 팀]
사내 LLM + MCP Tool 표준 → 공통 기능 그대로 사용

[우리 팀]
사내 LLM + MCP Tool 표준
  + namespace별 자동 최적화된 검색 가중치       (Track A)
  + 업무 대화로 학습된 Few-shot 수백 개 누적    (Track A)
  + 팀 전용 용어 사전 자동 구축                 (Track A)
  + 반복 질문 캐시로 응답 속도 10배+            (Track A+B)
  + MCP Tool 체이닝으로 복합 장애 자동 대응     (Track B)
  + ReAct로 다단계 업무 자율 처리               (Track B)
  + 주간 품질 리포트 기반 지속 개선             (Track A)

→ LLM과 Tool은 같아도, "팀의 지식 자산"과 "오케스트레이션 노하우"가 품질을 결정.
  시간이 지날수록 이 레이어의 두께가 진입 장벽이 됨.
```

---

> **핵심 역할 분리 요약**
> - MCP 허브 팀: Tool 정의·등록·유지보수
> - 우리 팀: Tool 구독 관리 + 선택·조합·승인 오케스트레이션 + RAG 지식 통합 + 지식 자산 누적
