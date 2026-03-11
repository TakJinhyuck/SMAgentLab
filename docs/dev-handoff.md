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

> **마지막 업데이트**: 2026-03-11
> **브랜치**: main
> **최근 변경**: rename_part cascade 완전 수정 / 지식 베이스 배지 cyan·amber 구분 / 사용자 목록 파트 필터 / 디버그 패널 퓨샷 모달화 / context_preview 버그 수정

### 진행 중 / 미완료

- [ ] (없음 — 현재 안정 상태)

### 백로그

- [ ] Docker 이미지 레지스트리 push
- [ ] 사용자별 검색 설정 저장 (현재 세션 단위)
- [ ] 테스트 코드 (pytest)
- [ ] CI/CD 파이프라인
- [ ] **프롬프트 템플릿 동적 관리**: 코드 하드코딩 → DB 저장·편집 (Admin UI), 네임스페이스/파트 단위, 변수 치환 미리보기

---

## 아키텍처 핵심 결정사항

> 코드 작업 전 반드시 숙지할 비자명한 설계들

| 항목 | 내용 |
|------|------|
| 네임스페이스 권한 | `owner_part = NULL` → 전체 CRUD / 같은 파트 → CRUD / 다른 파트 → 읽기 전용 |
| 파트 비정규화 | `created_by_part`, `owner_part`는 FK가 아닌 문자열 → `rename_part` 시 4개 테이블 수동 cascade |
| 검색 설정 단일 소스 | `config.py` 기본값 → `GET/PUT /api/llm/search-defaults` → 프론트엔드 fetch |
| 슈퍼어드민 파트 | `GET /auth/parts`는 admin 소속 파트 제외 (회원가입 노출 차단) / `GET /auth/parts/all` admin 전용 |
| debug 모드 퓨샷 | `min_similarity=0.0`으로 전체 조회, context 빌드는 실제 임계값으로 별도 필터링 |
| slate 색상 주의 | `[data-theme="light"]`에서 slate 팔레트 역전 → 고정색 필요 시 zinc 사용 |
| LLM SSE 파서 | DevX 비표준: `data:` JSON 안에 `event` 포함, `401/403`도 서버 도달로 판정 |
| 멀티턴 검색 | 직전 user+assistant 각 80자를 현재 질문에 결합해 임베딩 |

---

## 완료 이력 (최근순)

- **rename_part cascade 완전 수정**: `ops_namespace.owner_part` + `ops_knowledge/glossary/fewshot.created_by_part` 4개 테이블 cascade UPDATE
- **지식 베이스 배지 cyan·amber**: 컨테이너명 cyan / 테이블명 amber, 레이블+배지 `<span>` 그룹 포함관계 시각화
- **사용자 목록 파트 필터**: `UserManager > UserSection` 파트별 필터 버튼 + 인원 수 표시
- **디버그 패널 퓨샷 모달화**: 검색 결과와 동일 UI 패턴 (border-l-4 색상, 컨텍스트 제외 뱃지, 클릭→모달)
- **context_preview 버그**: debug 시 미달 퓨샷이 포함되던 문제 → context 빌드용 퓨샷 별도 임계값 필터
- **LLM 컨텍스트 미리보기 버튼 항상 표시**: 빈 컨텍스트 시 모달에서 "컨텍스트 없음" 안내
- **파트 관리 UI 재설계**: chip → 카드 그리드 (Building2 아이콘, 인라인 편집, user_count 뱃지, Modal 삭제)
- **파트 삭제 보호**: 소속 사용자 있으면 삭제 불가 (400 응답 + UI 안내)
- **파트 사용자 수 API**: `list_parts()` LEFT JOIN COUNT, `PartOut.user_count`, `Part.user_count?`
- **통계 수정 후 등록 모달화**: `KnowledgeRegisterModal` (AI 답변 미리채움, TagInput, 우선순위)
- **Namespace 자동 선택 개선**: `lastHandledUserPartRef` 파트당 1회 자동 전환
- **공통 namespace (v2.1)**: admin 생성 namespace `owner_part = NULL` → 전체 CRUD
- **검색 설정값 중앙화**: `config.py` 단일 소스 → API → 프론트엔드 fetch
- **다크/라이트 테마**: CSS 변수 기반 slate 팔레트 재정의, Sun/Moon 토글
- **멀티턴 검색 보강**: 직전 대화 맥락 결합 임베딩
- **사내 LLM (DevX MCP API) 연동**: SSE 비표준 파서, per-user Fernet 암호화 API Key
- **백엔드 DDD 구조**: domain별 schemas/service/router, JWT 인증, SSE 스트리밍

---

## 알려진 이슈

| # | 증상 | 우선도 |
|---|------|--------|
| 1 | 라이트모드 `bg-slate-N` 다크 네이비로 렌더링 | 낮음 (zinc로 우회 완료) |

---

## 빠른 명령어

```bash
# 재빌드
docker compose build backend && docker compose up -d --force-recreate backend

# 타입 체크
cd frontend-react && npx tsc --noEmit

# 로그
docker compose logs -f backend --tail=50

# DB
docker exec -it ops-postgres psql -U ops opsdb

# 백업/복원
docker exec ops-postgres pg_dump -U ops opsdb > backup.sql
docker exec -i ops-postgres psql -U ops opsdb < backup.sql
```
