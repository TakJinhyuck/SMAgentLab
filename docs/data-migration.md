# Ops-Navigator 데이터 이관 가이드

> **목적**: 로컬 베타 환경에서 축적한 데이터를 릴리즈(운영) 환경으로 이관하는 절차를 정리한다.

---

## 현재 환경 구성

```
[로컬 베타]
Docker Compose
├── ops-postgres (PostgreSQL + pgvector)  ← 데이터 여기에만 존재
├── backend (FastAPI :8000)
└── frontend (React+nginx :8501)
```

---

## 릴리즈 환경 권장 구성

```
[릴리즈]
├── PostgreSQL 서버 (사내 DB 서버 or 클라우드 RDS)
│   └── pgvector 확장 필수 (CREATE EXTENSION vector)
├── Docker Backend  (DATABASE_URL만 변경)
└── Docker Frontend (그대로)
```

**핵심**: `.env`의 `DATABASE_URL`만 변경하면 된다.

```env
# 로컬 베타
DATABASE_URL=postgresql://ops:ops1234@ops-postgres:5432/opsdb

# 릴리즈
DATABASE_URL=postgresql://ops:secure-password@db-server.internal:5432/opsdb
```

---

## 이관 대상 분류

| 테이블 | 이관 여부 | 이유 |
|--------|----------|------|
| `ops_namespace` | **O** | 네임스페이스 구조 (핵심) |
| `ops_knowledge` | **O** | 지식 베이스 + 임베딩 벡터 (핵심) |
| `ops_glossary` | **O** | 용어 사전 + 임베딩 벡터 (핵심) |
| `ops_fewshot` | **O** | 학습된 Q&A 예시 + 임베딩 벡터 |
| `ops_part` | **△** | 파트 구조. 릴리즈에서 새로 만들 수도 있음 |
| `ops_user` | **△** | 사용자 계정. 릴리즈에서 새로 등록 권장 |
| `ops_query_log` | **X** | 테스트 질의 로그, 불필요 |
| `ops_feedback` | **X** | 테스트 피드백, 불필요 |
| `ops_conversation` | **X** | 테스트 대화 이력, 불필요 |
| `ops_message` | **X** | 테스트 메시지, 불필요 |
| `ops_conv_summary` | **X** | 대화 요약, 불필요 |

---

## 이관 절차

### 1단계: 로컬에서 핵심 데이터 덤프

```bash
# 스키마 없이 핵심 테이블 데이터만 추출
docker exec ops-postgres pg_dump -U ops opsdb \
  -t ops_namespace \
  -t ops_knowledge \
  -t ops_glossary \
  -t ops_fewshot \
  --data-only \
  > knowledge_data.sql
```

파트/사용자도 이관하려면:

```bash
docker exec ops-postgres pg_dump -U ops opsdb \
  -t ops_part \
  -t ops_user \
  -t ops_namespace \
  -t ops_knowledge \
  -t ops_glossary \
  -t ops_fewshot \
  --data-only \
  > full_data.sql
```

전체 백업 (스키마 포함):

```bash
docker exec ops-postgres pg_dump -U ops opsdb > opsdb_full_backup.sql
```

### 2단계: 릴리즈 서버 DB 초기화

릴리즈 서버에서 백엔드를 처음 기동하면 `init_db()`가 자동으로:
- pgvector 확장 생성
- 모든 테이블 생성
- HNSW/GIN 인덱스 생성
- 기본 admin 계정 생성
- '기본' 파트 생성

```bash
# 릴리즈 서버에서 컨테이너 시작 (스키마 자동 생성)
docker compose up -d backend

# 로그 확인 - init_db 완료 확인
docker compose logs backend | grep "init_db"
```

### 3단계: 데이터 복원

```bash
# 릴리즈 DB에 데이터 복원
psql -U ops -h db-server.internal -d opsdb < knowledge_data.sql
```

Docker 환경이면:

```bash
docker exec -i ops-postgres psql -U ops opsdb < knowledge_data.sql
```

### 4단계: 시퀀스 리셋

데이터 복원 후 auto-increment 시퀀스가 꼬일 수 있으므로 리셋:

```sql
-- 각 테이블의 시퀀스를 현재 최대 ID 기준으로 리셋
SELECT setval('ops_namespace_id_seq', COALESCE((SELECT MAX(id) FROM ops_namespace), 0) + 1, false);
SELECT setval('ops_knowledge_id_seq', COALESCE((SELECT MAX(id) FROM ops_knowledge), 0) + 1, false);
SELECT setval('ops_glossary_id_seq', COALESCE((SELECT MAX(id) FROM ops_glossary), 0) + 1, false);
SELECT setval('ops_fewshot_id_seq', COALESCE((SELECT MAX(id) FROM ops_fewshot), 0) + 1, false);
```

### 5단계: 검증

```bash
# 릴리즈 서버 접속 확인
curl http://릴리즈서버:8000/health

# 데이터 확인
docker exec -it ops-postgres psql -U ops opsdb -c "
  SELECT 'namespace' AS tbl, COUNT(*) FROM ops_namespace
  UNION ALL SELECT 'knowledge', COUNT(*) FROM ops_knowledge
  UNION ALL SELECT 'glossary', COUNT(*) FROM ops_glossary
  UNION ALL SELECT 'fewshot', COUNT(*) FROM ops_fewshot;
"
```

---

## 임베딩 호환성 주의사항

**임베딩 모델이 동일해야 벡터 데이터를 재사용할 수 있다.**

| 항목 | 값 |
|------|-----|
| 모델 | `paraphrase-multilingual-mpnet-base-v2` |
| 차원 | 768 |
| 설정 위치 | `.env` → `EMBEDDING_MODEL`, `VECTOR_DIM` |

모델을 변경하면:
- 기존 벡터 데이터는 모두 무효화됨
- 전체 재임베딩 필요 (현재 자동화 스크립트 없음, 수동 필요)

---

## 환경변수 체크리스트 (릴리즈)

```env
# 필수 변경
DATABASE_URL=postgresql://ops:secure-pw@db-server:5432/opsdb
JWT_SECRET_KEY=프로덕션용-시크릿-키
FERNET_SECRET_KEY=프로덕션용-Fernet-키
ADMIN_DEFAULT_PASSWORD=초기-admin-비밀번호

# LLM 설정
LLM_PROVIDER=inhouse
INHOUSE_LLM_URL=https://devx-mcp-api.shinsegae-inc.com/api/v1/mcp-command/chat
INHOUSE_LLM_API_KEY=시스템-기본-API-키
INHOUSE_LLM_AGENT_CODE=playground
INHOUSE_LLM_RESPONSE_MODE=streaming

# Ollama (사용하지 않으면 생략 가능)
# OLLAMA_BASE_URL=http://host.docker.internal:11434
# OLLAMA_MODEL=exaone3.5:7.8b
```

> `FERNET_SECRET_KEY`가 변경되면 기존 암호화된 사용자 API Key는 복호화 불가. 사용자에게 재등록 안내 필요.

---

## 롤백 계획

문제 발생 시:

```bash
# 1. 릴리즈 DB를 전체 백업에서 복원
psql -U ops -d opsdb < opsdb_full_backup.sql

# 2. 또는 릴리즈 DB를 초기화하고 처음부터
docker compose down -v  # 볼륨 삭제 (주의!)
docker compose up -d    # init_db 재실행
```
