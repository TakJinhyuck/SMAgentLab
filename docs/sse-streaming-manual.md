# SSE 스트리밍 채팅 — 문제점 및 해결 매뉴얼

> Ops-Navigator 개발 과정에서 겪은 모든 문제와 최종 해결 방안 정리.
> FastAPI + React + Zustand + fetch SSE + nginx 환경 기준.

---

## 아키텍처 요약 (최종)

```
[React Frontend]                    [FastAPI Backend]
    |                                    |
    |-- POST /api/chat/stream --------->|
    |   (fetch + SSE)                   |-- conv/msg DB 생성 (Early Meta)
    |<-- meta (conv_id, msg_id) --------|
    |                                   |-- asyncio.create_task(_generate_worker)
    |                                   |      |
    |<-- status/meta/token/done --------+------| (Queue로 이벤트 전달)
    |                                          |
    |   [연결 끊겨도 worker 계속 실행]          |
    |                                          |-- DB: status=generating → completed
    |                                          |
    |-- GET /conversations/{id}/messages ----->|  (돌아오면 polling)
    |<-- messages (status 포함) ---------------|
```

---

## 문제 1: 메시지 겹침 (대화방 간 메시지 혼선)

### 증상
- 대화방 A에서 스트리밍 중 대화방 B로 이동하면, A의 답변이 B 화면에 표시됨
- 또는 B의 기존 메시지 위에 A의 스트리밍 토큰이 덧붙여짐

### 원인
- `_runStream`이 `useStreamStore.setState`로 상태를 업데이트할 때, 어떤 대화방에서 시작된 스트림인지 구분하지 않음
- 사용자가 대화방을 전환해도 이전 스트림의 상태 업데이트가 계속됨

### 해결
- **module-level `_controller`** 패턴: `AbortController`를 Zustand 외부에 둠
- **`isOwner()` 가드**: `_controller === controller`로 현재 스트림이 소유권을 가진 스트림인지 확인
- 새 스트림 시작 시 이전 `_controller`를 null로 만들고 abort → 이전 `_runStream`은 `!isOwner()`로 즉시 종료

```typescript
// module-level (Zustand 외부)
let _controller: AbortController | null = null;

function startChatStream(params) {
  if (_controller) {
    const old = _controller;
    _controller = null;  // 이전 스트림의 isOwner() = false
    old.abort();
  }
  _controller = new AbortController();
  const controller = _controller;
  // ...
}

async function _runStream(params, controller) {
  const isOwner = () => _controller === controller;
  for await (const event of stream) {
    if (!isOwner()) return;  // 소유권 없으면 즉시 종료
    // ... 상태 업데이트
  }
}
```

### 추가 가드: `historyConvIdRef`
- `historyMessages`가 어떤 `conversationId`에 속하는지 추적
- `safeHistory`에서 현재 `conversationId`와 일치할 때만 사용

```typescript
const historyConvIdRef = useRef<number | null>(null);
const safeHistory = historyConvIdRef.current === conversationId ? historyMessages : [];
```

### 추가 가드: `loadEpochRef`
- `conversationId` 변경 시 epoch를 증가시켜, 이전 비동기 `getMessages` 결과가 도착해도 무시

```typescript
const loadEpochRef = useRef(0);
// conversationId 변경 시
loadEpochRef.current++;
// getMessages 콜백 내
if (epoch !== loadEpochRef.current) return;  // stale → 무시
```

---

## 문제 2: 스트림 중단 시 빈 메시지 잔여 (Ghost Message)

### 증상
- 질문 입력 후 바로 "새 대화" 클릭 → DB에 빈 assistant 메시지 + user 메시지가 남음
- 돌아가면 빈 대화방이 보임

### 원인
- Early Meta 패턴에서 user 메시지 + 빈 assistant 메시지를 DB에 먼저 생성
- 스트림이 중단되면 content가 채워지지 않은 채 남음

### 해결 (구 방식 → 현재 불필요)

> 현재 asyncio.Task 방식에서는 worker가 항상 끝까지 실행하므로 ghost 문제 자체가 발생하지 않음.
> 아래는 과거에 적용했던 방식 (참고용).

- `DELETE /api/chat/messages/{msg_id}` 엔드포인트:
  - 빈 assistant 메시지 삭제
  - 바로 앞 user 메시지도 삭제
  - 메시지가 0개가 된 대화방도 삭제
- `_cleanup_ghost_messages`: 스트림 시작 시 기존 ghost 정리 (status != 'generating'인 빈 assistant)

### 현재 방식
- `stopChatStream()`은 단순히 SSE 연결만 abort
- ghost 삭제/부분 저장 로직 제거 — worker가 독립적으로 완료하므로 불필요
- `_cleanup_ghost_messages`는 혹시 모를 잔여 ghost 정리용으로 유지

```typescript
// 현재 stopChatStream — 단순함
export function stopChatStream() {
  const c = _controller;
  _controller = null;
  c?.abort();
  if (c) {
    useStreamStore.setState({ active: false, messages: updated });
  }
  // deleteGhostMessage, savePartialContent 호출 없음
}
```

---

## 문제 3: 답변이 끊김 (새 대화 시 백엔드 생성 중단)

### 증상
- 스트리밍 중 "새 대화" 클릭 → 이전 대화로 돌아가면 답변이 중간에 잘려있음
- 또는 답변이 아예 없음

### 원인
- `abort()`가 fetch 연결을 끊으면 FastAPI의 `StreamingResponse` 제너레이터에서 `GeneratorExit` 발생
- LLM 호출 자체가 취소됨 → DB에 불완전한 답변만 저장

### 시도했던 중간 방안: Detach 패턴

```typescript
// abort() 대신 _controller = null만 하여 fetch 연결 유지
function detachChatStream() {
  _controller = null;  // isOwner() = false → 상태 업데이트 중지
  // fetch 연결은 유지 → 백엔드 계속 생성
}

// _runStream에서
if (!isOwner()) continue;  // return이 아닌 continue → 드레인 유지
```

**문제점**: 브라우저가 fetch를 끊을 수 있음 (탭 전환, 네트워크 변경, nginx timeout 등)

### 최종 해결: asyncio.Task + Queue 디커플링

핵심 아이디어: **LLM 생성을 HTTP 연결 수명에서 완전히 분리**

```python
@router.post("/stream")
async def chat_stream(req: ChatRequest):
    conv_id = await _get_or_create_conversation(...)
    await _save_user_message(conv_id, req.question)
    msg_id = await _pre_create_assistant_message(conv_id, ...)  # status='generating'

    queue: asyncio.Queue = asyncio.Queue()

    # 독립 백그라운드 태스크 — HTTP 연결과 무관하게 끝까지 실행
    asyncio.create_task(_generate_worker(queue, conv_id, msg_id, ...))

    async def event_generator():
        yield _sse({"type": "meta", "conversation_id": conv_id, "message_id": msg_id, ...})
        try:
            while True:
                event = await queue.get()
                if event is None: break  # EOF
                yield _sse(event)
        except (asyncio.CancelledError, GeneratorExit):
            pass  # 클라이언트 끊겨도 worker는 계속 실행

    return StreamingResponse(event_generator(), media_type="text/event-stream")


async def _generate_worker(queue, conv_id, msg_id, ...):
    """HTTP 연결과 무관한 독립 생성 워커"""
    try:
        # 임베딩 → 용어 매핑 → 검색 → LLM 스트리밍
        # 각 단계마다 queue.put()으로 이벤트 전송
        # 주기적으로 DB UPDATE content (20토큰마다)
        ...
        await _update_assistant_message(msg_id, final_answer, "completed")
    except Exception:
        await _update_assistant_message(msg_id, fallback, "completed")
    finally:
        await queue.put(None)  # EOF 신호
```

**핵심 포인트:**
- `asyncio.create_task`로 생성된 태스크는 HTTP 연결과 독립적
- `event_generator`는 Queue에서 읽기만 함 — 클라이언트가 끊기면 `GeneratorExit`로 빠져나옴
- worker는 Queue에 쓰기만 함 — 읽는 쪽이 없어도 상관없이 계속 실행
- 최종적으로 DB에 `status='completed'`로 저장

---

## 문제 4: 돌아가면 빈 화면 (백그라운드 생성 중 UX)

### 증상
- "새 대화" 후 이전 대화로 돌아가면 빈 화면 또는 부분 답변
- 수동으로 새로고침해야 답변이 보임

### 원인
- 백엔드가 아직 생성 중 → DB에 빈/부분 content
- `convertMessages`가 빈 assistant를 스킵 → 화면에 아무것도 안 보임
- 자동 갱신 메커니즘 없음

### 해결: DB status 필드 + 프론트엔드 polling

#### 1) DB: ops_message.status 컬럼

```sql
ALTER TABLE ops_message ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'completed';
```

- `generating`: 백엔드 워커가 생성 중
- `completed`: 생성 완료 (기본값 — 기존 데이터 호환)

#### 2) API: MessageResponse에 status 포함

```python
class MessageResponse(BaseModel):
    # ... 기존 필드
    status: str = "completed"
```

#### 3) 프론트엔드: convertMessages 수정

```typescript
const isGenerating = m.status === 'generating';
if (!m.content || m.content.trim().length <= 1) {
  if (!isGenerating) continue;  // 완료된 빈 메시지 → 스킵
}
converted.push({
  content: isGenerating && (!m.content || m.content.trim().length <= 1)
    ? '답변 생성 중...'  // placeholder 표시
    : m.content,
  isStreaming: isGenerating,
  // ...
});
```

#### 4) 프론트엔드: 3초 polling

```typescript
useEffect(() => {
  if (!conversationId || streamActive) return;
  const lastMsg = safeHistory[safeHistory.length - 1];
  if (!lastMsg || !lastMsg.isStreaming) return;  // 생성 중인 메시지 없으면 skip

  const interval = setInterval(() => {
    getMessages(conversationId).then((msgs) => {
      const converted = convertMessages(msgs);
      setHistoryMessages(converted);
      const last = converted[converted.length - 1];
      if (!last || !last.isStreaming) clearInterval(interval);  // 완료되면 중지
    });
  }, 3000);

  return () => clearInterval(interval);
}, [conversationId, streamActive, safeHistory]);
```

---

## 문제 5: 사이드바 대화 목록 타이밍

### 증상
- 질문 입력하자마자 사이드바에 대화방이 나타남
- "새 대화" 누르면 사라졌다가 답변 완성 후 다시 나타남
- 사용자가 "왔다갔다 하는" 느낌을 받음

### 원인
- `onConversationCreated`가 `conversationId`를 설정 → 사이드바가 즉시 `refreshConversations()`
- 대화방이 DB에 생성되자마자 목록에 노출

### 해결: 스트리밍 중 사이드바 갱신 억제

```typescript
// conversationId 변경 시 — 스트리밍 중이면 갱신 skip
useEffect(() => {
  if (prevConvIdRef.current !== conversationId) {
    prevConvIdRef.current = conversationId;
    if (!streamActive) {
      refreshConversations();  // 스트리밍 중이 아닐 때만
    }
  }
}, [conversationId, streamActive]);

// 스트림 완료 시 — 대화방 목록 갱신
useEffect(() => {
  if (prevStreamActiveRef.current && !streamActive) {
    refreshConversations();  // active → false 전환 시
  }
  prevStreamActiveRef.current = streamActive;
}, [streamActive]);
```

---

## 문제 6: PATCH/DELETE 레이스 컨디션

### 증상 (과거)
- `stopChatStream()` 후 즉시 `clearStreamState()` → PATCH 요청이 완료되기 전에 상태 초기화
- 부분 답변 저장 실패

### 원인
- fire-and-forget 패턴의 비동기 API 호출이 완료되기 전에 다음 동작 진행

### 해결 (과거)
- `_stopSavePromise` + `waitForStopSave()` await 패턴

### 현재
- asyncio.Task 방식으로 전환하면서 프론트에서 PATCH/DELETE 자체가 불필요해짐
- `stopChatStream()`은 단순 abort만 수행 — 레이스 컨디션 원천 제거

---

## 문제 7: Ollama 동시 요청 행

### 증상
- 여러 번 abort → 재질문 반복하면 Ollama가 응답하지 않음
- 첫 토큰까지 수십 초 이상 대기

### 원인
- abort된 요청들이 Ollama 큐에 쌓여서 순차 처리됨
- CPU 모델(exaone3.5:2.4b)이라 동시 처리 불가

### 해결
- `pkill -f "ollama serve" && ollama serve` 로 재시작
- asyncio.Task 방식에서는 abort가 백엔드 LLM 호출을 취소하지 않으므로 이 문제가 오히려 줄어듦
  (abort해도 worker가 끝까지 실행 → Ollama에 반복 요청하지 않음)

---

## 최종 아키텍처 체크리스트

새 프로젝트에서 SSE 스트리밍 채팅 구현 시:

### Backend
- [ ] `asyncio.create_task` + `asyncio.Queue`로 LLM 생성을 HTTP 연결에서 디커플링
- [ ] DB에 `status` 필드 (generating/completed) 추가
- [ ] Early Meta: DB insert 즉시 수행 후 meta 이벤트 전송 (검색 전에)
- [ ] worker는 `finally`에서 반드시 `queue.put(None)` (EOF) + status=completed 저장
- [ ] ghost cleanup: 이전 빈 메시지 정리 (status != 'generating' 조건 필수)

### Frontend
- [ ] module-level `_controller` + `isOwner()` 가드로 대화방 간 메시지 혼선 방지
- [ ] `historyConvIdRef` + `loadEpochRef`로 stale 비동기 결과 차단
- [ ] `convertMessages`에서 `status=generating`인 빈 메시지는 placeholder 표시
- [ ] 3초 polling: 마지막 메시지가 generating이면 자동 갱신, completed되면 중지
- [ ] `stopChatStream()`은 SSE 연결만 abort — ghost 삭제/부분 저장 불필요
- [ ] 사이드바: 스트리밍 중 대화 목록 갱신 억제, 완료 시에만 갱신

### nginx
- [ ] `proxy_buffering off` — SSE 이벤트 즉시 전달
- [ ] `proxy_read_timeout 900s` — 장시간 스트리밍 대응
- [ ] `X-Accel-Buffering: no` 헤더

### 핵심 원칙
1. **LLM 생성은 HTTP 연결에 의존하면 안 된다** — asyncio.Task로 분리
2. **프론트엔드는 DB를 진실의 원천으로** — 스트림 끊겨도 polling으로 복구
3. **상태 가드는 3중으로** — isOwner + historyConvIdRef + loadEpochRef
4. **사용자 UX 타이밍 맞추기** — 사이드바, placeholder, polling 모두 "적시에" 반응
