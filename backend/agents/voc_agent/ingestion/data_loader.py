"""VOC 데이터 인제스션 파이프라인.

지원 형식:
  CSV — voc_case 또는 voc_manual 레코드 일괄 로드
  TXT — 전체 텍스트를 단일 voc_manual 청크로 로드

사용법 (독립 실행):
  python data_loader.py --file sample.csv --namespace default --type case
  python data_loader.py --file runbook.txt --namespace default --type manual --title "서버 재시작 절차"

API 사용 (비동기 함수):
  from agents.voc_agent.ingestion.data_loader import ingest_csv, ingest_txt
  result = await ingest_csv(file_path, namespace, record_type)

CSV 컬럼 (type=case):
  title, category, severity, status, content,
  resolution, root_cause, affected_system, tags

CSV 컬럼 (type=manual):
  title, category, step_order, content
"""
from __future__ import annotations

import asyncio
import csv
import logging
import os
import re
import sys
from pathlib import Path
from typing import Literal

logger = logging.getLogger(__name__)

RecordType = Literal["case", "manual"]

# 텍스트 청크 설정 (TXT 파일용)
_MAX_CHUNK_CHARS = 1500
_OVERLAP_CHARS   = 100


# ── 텍스트 청킹 ──────────────────────────────────────────────────────────────

def _chunk_text(text: str, max_chars: int = _MAX_CHUNK_CHARS, overlap: int = _OVERLAP_CHARS) -> list[str]:
    """긴 텍스트를 overlap이 있는 고정 크기 청크로 분할."""
    paragraphs = re.split(r"\n\s*\n", text.strip())
    chunks: list[str] = []
    buffer = ""

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if buffer and len(buffer) + len(para) + 2 > max_chars:
            chunks.append(buffer.strip())
            buffer = buffer[-overlap:] + "\n\n" + para if overlap else para
        else:
            buffer = (buffer + "\n\n" + para).strip() if buffer else para

    if buffer.strip():
        chunks.append(buffer.strip())

    return chunks or [text[:max_chars]]


# ── DB 연산 ──────────────────────────────────────────────────────────────────

async def _get_namespace_id(conn, namespace: str) -> int | None:
    row = await conn.fetchrow(
        "SELECT id FROM ops_namespace WHERE name = $1", namespace
    )
    return row["id"] if row else None


async def _upsert_case(conn, ns_id: int, record: dict, embedding: list[float]) -> None:
    tags = [t.strip() for t in record.get("tags", "").split(",") if t.strip()]
    await conn.execute(
        """
        INSERT INTO voc_case
            (namespace_id, title, category, severity, status,
             content, resolution, root_cause, affected_system, tags, embedding)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector)
        ON CONFLICT DO NOTHING
        """,
        ns_id,
        record.get("title", "").strip(),
        record.get("category") or None,
        record.get("severity", "medium").strip() or "medium",
        record.get("status", "resolved").strip() or "resolved",
        record.get("content", "").strip(),
        record.get("resolution") or None,
        record.get("root_cause") or None,
        record.get("affected_system") or None,
        tags or None,
        str(embedding),
    )


async def _upsert_manual(conn, ns_id: int, record: dict, embedding: list[float], step: int = 0) -> None:
    await conn.execute(
        """
        INSERT INTO voc_manual
            (namespace_id, title, category, step_order, content, embedding)
        VALUES ($1,$2,$3,$4,$5,$6::vector)
        ON CONFLICT DO NOTHING
        """,
        ns_id,
        record.get("title", "").strip(),
        record.get("category") or None,
        int(record.get("step_order", step)),
        record.get("content", "").strip(),
        str(embedding),
    )


# ── 공개 API ─────────────────────────────────────────────────────────────────

async def ingest_csv(
    file_path: str | Path,
    namespace: str,
    record_type: RecordType = "case",
) -> dict:
    """CSV 파일을 읽어 voc_case 또는 voc_manual에 일괄 저장.

    Returns:
        {"total": int, "success": int, "failed": int, "errors": list[str]}
    """
    from core.database import get_conn
    from shared.embedding import embedding_service

    file_path = Path(file_path)
    if not file_path.exists():
        raise FileNotFoundError(f"파일 없음: {file_path}")

    results = {"total": 0, "success": 0, "failed": 0, "errors": []}

    with open(file_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    results["total"] = len(rows)
    logger.info("[VOC Ingest] %s 로드: %d 행 (type=%s)", file_path.name, len(rows), record_type)

    async with get_conn() as conn:
        ns_id = await _get_namespace_id(conn, namespace)
        if ns_id is None:
            raise ValueError(f"네임스페이스 '{namespace}' 를 찾을 수 없습니다.")

        # 배치 임베딩 (I/O 효율)
        if record_type == "case":
            embed_texts = [
                f"{r.get('title', '')} {r.get('content', '')} {r.get('resolution', '')} {r.get('root_cause', '')}"
                for r in rows
            ]
        else:
            embed_texts = [f"{r.get('title', '')} {r.get('content', '')}" for r in rows]

        embeddings = await embedding_service.embed_batch(embed_texts)

        for i, (record, emb) in enumerate(zip(rows, embeddings)):
            try:
                if record_type == "case":
                    await _upsert_case(conn, ns_id, record, emb)
                else:
                    await _upsert_manual(conn, ns_id, record, emb, step=i)
                results["success"] += 1
            except Exception as e:
                results["failed"] += 1
                results["errors"].append(f"행 {i + 2}: {e}")
                logger.warning("[VOC Ingest] 행 %d 실패: %s", i + 2, e)

    logger.info(
        "[VOC Ingest] 완료 — 성공: %d / 실패: %d",
        results["success"], results["failed"],
    )
    return results


async def ingest_txt(
    file_path: str | Path,
    namespace: str,
    title: str,
    category: str | None = None,
) -> dict:
    """TXT 파일을 단락 기반으로 청킹해 voc_manual에 저장.

    Returns:
        {"total": int, "success": int, "failed": int}
    """
    from core.database import get_conn
    from shared.embedding import embedding_service

    file_path = Path(file_path)
    if not file_path.exists():
        raise FileNotFoundError(f"파일 없음: {file_path}")

    text = file_path.read_text(encoding="utf-8")
    chunks = _chunk_text(text)

    results = {"total": len(chunks), "success": 0, "failed": 0}
    logger.info("[VOC Ingest TXT] '%s' → %d 청크", title, len(chunks))

    embed_texts = [f"{title} {chunk}" for chunk in chunks]
    embeddings = await embedding_service.embed_batch(embed_texts)

    async with get_conn() as conn:
        ns_id = await _get_namespace_id(conn, namespace)
        if ns_id is None:
            raise ValueError(f"네임스페이스 '{namespace}' 를 찾을 수 없습니다.")

        for step, (chunk, emb) in enumerate(zip(chunks, embeddings)):
            try:
                record = {"title": f"{title} (Part {step + 1})", "category": category, "content": chunk}
                await _upsert_manual(conn, ns_id, record, emb, step=step)
                results["success"] += 1
            except Exception as e:
                results["failed"] += 1
                logger.warning("[VOC Ingest TXT] 청크 %d 실패: %s", step, e)

    return results


# ── CLI 진입점 ────────────────────────────────────────────────────────────────

async def _cli_main() -> None:
    import argparse

    # FastAPI 앱의 DB/임베딩 초기화를 재사용
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

    from core.database import init_db
    from shared.embedding import embedding_service as emb_svc

    emb_svc.load()
    await init_db()

    parser = argparse.ArgumentParser(description="VOC 데이터 인제스션")
    parser.add_argument("--file", required=True, help="입력 파일 경로 (CSV 또는 TXT)")
    parser.add_argument("--namespace", required=True, help="대상 네임스페이스 이름")
    parser.add_argument("--type", choices=["case", "manual"], default="case",
                        dest="record_type", help="레코드 종류 (case|manual)")
    parser.add_argument("--title", default="", help="TXT 파일 매뉴얼 제목 (type=manual 필수)")
    parser.add_argument("--category", default=None, help="카테고리 (선택)")
    args = parser.parse_args()

    file_path = Path(args.file)
    ext = file_path.suffix.lower()

    if ext == ".csv":
        result = await ingest_csv(file_path, args.namespace, args.record_type)
        print(
            f"\n[결과] 총 {result['total']}행 — "
            f"성공 {result['success']} / 실패 {result['failed']}"
        )
        for err in result["errors"]:
            print(f"  ⚠️  {err}")
    elif ext == ".txt":
        if not args.title:
            parser.error("TXT 파일 인제스션에는 --title 이 필요합니다.")
        result = await ingest_txt(file_path, args.namespace, args.title, args.category)
        print(
            f"\n[결과] 총 {result['total']}청크 — "
            f"성공 {result['success']} / 실패 {result['failed']}"
        )
    else:
        print(f"지원하지 않는 확장자: {ext}  (csv 또는 txt만 지원)")
        sys.exit(1)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s — %(message)s")
    asyncio.run(_cli_main())
