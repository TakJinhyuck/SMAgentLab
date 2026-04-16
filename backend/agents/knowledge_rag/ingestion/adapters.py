"""파일 포맷별 파싱 어댑터 — 다양한 입력을 통일 포맷으로 변환."""
import logging
import re
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class ParsedDocument:
    """파싱된 문서 통일 포맷."""
    source_type: str  # txt, md, pdf, csv
    source_name: str
    raw_text: str
    sections: list[dict] = field(default_factory=list)  # [{title, content, level}]
    tables: list[dict] = field(default_factory=list)     # [{headers, rows}]
    metadata: dict = field(default_factory=dict)


def parse_text(content: str, filename: str) -> ParsedDocument:
    """일반 텍스트 파싱."""
    return ParsedDocument(
        source_type="txt",
        source_name=filename,
        raw_text=content,
    )


def parse_markdown(content: str, filename: str) -> ParsedDocument:
    """마크다운 파싱 — 헤더 기반 섹션 추출."""
    sections: list[dict] = []
    current_title = ""
    current_level = 0
    current_lines: list[str] = []

    for line in content.split("\n"):
        m = re.match(r'^(#{1,4})\s+(.+)', line)
        if m:
            # 이전 섹션 저장
            if current_lines or current_title:
                sections.append({
                    "title": current_title,
                    "content": "\n".join(current_lines).strip(),
                    "level": current_level,
                })
            current_level = len(m.group(1))
            current_title = m.group(2).strip()
            current_lines = []
        else:
            current_lines.append(line)

    # 마지막 섹션
    if current_lines or current_title:
        sections.append({
            "title": current_title,
            "content": "\n".join(current_lines).strip(),
            "level": current_level,
        })

    # 테이블 추출 (마크다운 테이블)
    tables = _extract_md_tables(content)

    return ParsedDocument(
        source_type="md",
        source_name=filename,
        raw_text=content,
        sections=sections,
        tables=tables,
    )


def parse_pdf(content_bytes: bytes, filename: str) -> ParsedDocument:
    """PDF 파싱 — pymupdf 사용."""
    try:
        import pymupdf  # PyMuPDF
    except ImportError:
        try:
            import fitz as pymupdf  # 구 버전 호환
        except ImportError:
            logger.warning("pymupdf 미설치 — PDF를 텍스트로만 추출합니다.")
            # fallback: 바이너리를 디코딩 시도 (당연히 실패하지만 에러 메시지용)
            raise ImportError("PDF 파싱을 위해 pymupdf를 설치하세요: pip install pymupdf")

    doc = pymupdf.open(stream=content_bytes, filetype="pdf")
    pages: list[str] = []
    all_text_lines: list[str] = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text()
        pages.append(text)
        all_text_lines.append(f"--- Page {page_num + 1} ---")
        all_text_lines.append(text)

    raw_text = "\n".join(all_text_lines)

    # 헤더 패턴으로 섹션 추출 시도 (PDF에서 추출된 텍스트 기반)
    sections = _extract_sections_from_text(raw_text)

    return ParsedDocument(
        source_type="pdf",
        source_name=filename,
        raw_text=raw_text,
        sections=sections,
        metadata={"page_count": len(doc)},
    )


def parse_file(content_bytes: bytes, filename: str) -> ParsedDocument:
    """파일 확장자로 적절한 어댑터 선택."""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if ext == "pdf":
        return parse_pdf(content_bytes, filename)
    elif ext in ("md", "markdown"):
        return parse_markdown(content_bytes.decode("utf-8-sig"), filename)
    elif ext in ("txt", "log", "text"):
        return parse_text(content_bytes.decode("utf-8-sig"), filename)
    else:
        # fallback: 텍스트로 시도
        try:
            text = content_bytes.decode("utf-8-sig")
            return parse_text(text, filename)
        except UnicodeDecodeError:
            raise ValueError(f"지원하지 않는 파일 형식: {ext}")


# ── 내부 헬퍼 ────────────────────────────────────────────────────────────────

def _extract_sections_from_text(text: str) -> list[dict]:
    """텍스트에서 번호 매기기 패턴 (1. 2. 또는 # 헤더) 기반 섹션 추출."""
    sections: list[dict] = []
    # 패턴: "1. ", "1-1. ", "## " 등
    pattern = re.compile(r'^(?:#{1,4}\s+|(?:\d+[\.\-])+\s*)', re.MULTILINE)

    parts = pattern.split(text)
    titles = pattern.findall(text)

    # 첫 부분 (헤더 없는 서두)
    if parts and parts[0].strip():
        sections.append({"title": "", "content": parts[0].strip(), "level": 0})

    for i, title in enumerate(titles):
        content = parts[i + 1].strip() if i + 1 < len(parts) else ""
        level = title.count("#") if "#" in title else 1
        sections.append({
            "title": title.strip().rstrip("."),
            "content": content,
            "level": level,
        })

    return sections


def _extract_md_tables(text: str) -> list[dict]:
    """마크다운 테이블 추출."""
    tables: list[dict] = []
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        # 테이블 헤더 감지: | col1 | col2 |
        if line.startswith("|") and line.endswith("|") and line.count("|") >= 3:
            headers = [h.strip() for h in line.split("|")[1:-1]]
            # 다음 줄이 구분선인지 확인: |---|---|
            if i + 1 < len(lines) and re.match(r'^\|[\s\-:]+\|', lines[i + 1].strip()):
                rows: list[list[str]] = []
                j = i + 2
                while j < len(lines):
                    row_line = lines[j].strip()
                    if not row_line.startswith("|"):
                        break
                    cells = [c.strip() for c in row_line.split("|")[1:-1]]
                    rows.append(cells)
                    j += 1
                if rows:
                    tables.append({"headers": headers, "rows": rows})
                i = j
                continue
        i += 1
    return tables
