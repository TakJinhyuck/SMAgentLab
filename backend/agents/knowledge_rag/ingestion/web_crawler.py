"""웹 크롤러 + Confluence REST API 어댑터 — URL → ParsedDocument 변환."""
import logging
import re
from urllib.parse import urlparse, parse_qs, urljoin

import httpx

from agents.knowledge_rag.ingestion.adapters import ParsedDocument, parse_markdown

logger = logging.getLogger(__name__)

_CONFLUENCE_PATTERNS = re.compile(
    r"/(display/|pages/viewpage\.action|spaces/viewspace\.action|rest/api/content)",
    re.IGNORECASE,
)

FETCH_TIMEOUT = 30.0


# ── 공개 진입점 ───────────────────────────────────────────────────────────────

async def fetch_url(url: str, confluence_token: str | None = None) -> ParsedDocument:
    """URL을 받아 ParsedDocument로 반환.

    - Confluence URL이면 REST API로 정확히 파싱
    - 일반 URL이면 httpx + BeautifulSoup으로 텍스트 추출
    """
    if _is_confluence(url):
        if not confluence_token:
            raise ValueError("Confluence 페이지를 가져오려면 Personal Access Token이 필요합니다.")
        return await _fetch_confluence(url, confluence_token)
    return await _fetch_web(url)


# ── 일반 웹 크롤러 ─────────────────────────────────────────────────────────────

async def _fetch_web(url: str) -> ParsedDocument:
    """일반 웹 페이지 → BeautifulSoup 텍스트 추출."""
    from bs4 import BeautifulSoup

    async with httpx.AsyncClient(follow_redirects=True, timeout=FETCH_TIMEOUT) as client:
        resp = client.build_request("GET", url, headers={"User-Agent": "SMAgentLab/1.0"})
        r = await client.send(resp)
        r.raise_for_status()
        html = r.text

    soup = BeautifulSoup(html, "lxml")

    # 불필요한 태그 제거
    for tag in soup(["script", "style", "nav", "footer", "header", "aside", "noscript"]):
        tag.decompose()

    title = ""
    if soup.title and soup.title.string:
        title = soup.title.string.strip()

    # 메인 콘텐츠 우선 추출 (article > main > body 순서)
    main = (
        soup.find("article")
        or soup.find("main")
        or soup.find(id=re.compile(r"content|main|body", re.I))
        or soup.find("body")
    )
    raw_text = _extract_text(main or soup)

    sections = _extract_heading_sections(main or soup)

    parsed = ParsedDocument(
        source_type="web",
        source_name=title or url,
        raw_text=raw_text,
        sections=sections,
        metadata={"url": url, "title": title},
    )
    logger.info("웹 크롤링 완료: %s (%d자)", url, len(raw_text))
    return parsed


# ── Confluence REST API ────────────────────────────────────────────────────────

async def _fetch_confluence(url: str, token: str) -> ParsedDocument:
    """Confluence URL → REST API → ParsedDocument."""
    from bs4 import BeautifulSoup

    base_url, page_id, space_key, title_hint = _parse_confluence_url(url)

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }

    async with httpx.AsyncClient(follow_redirects=True, timeout=FETCH_TIMEOUT, verify=False) as client:
        if page_id:
            api_url = f"{base_url}/rest/api/content/{page_id}?expand=body.storage,title,space"
            r = await client.get(api_url, headers=headers)
            r.raise_for_status()
            data = r.json()
            pages = [data]
        elif space_key and title_hint:
            # 공간 + 제목으로 검색
            api_url = f"{base_url}/rest/api/content"
            r = await client.get(api_url, headers=headers, params={
                "spaceKey": space_key,
                "title": title_hint,
                "expand": "body.storage,title",
                "limit": 1,
            })
            r.raise_for_status()
            pages = r.json().get("results", [])
            if not pages:
                raise ValueError(f"Confluence 페이지를 찾을 수 없습니다: space={space_key}, title={title_hint}")
        else:
            raise ValueError(f"지원하지 않는 Confluence URL 형식: {url}")

    page = pages[0]
    page_title = page.get("title", "Confluence Page")
    storage_html = page.get("body", {}).get("storage", {}).get("value", "")
    space_name = page.get("space", {}).get("name", "")

    soup = BeautifulSoup(storage_html, "lxml")
    raw_text = _extract_text(soup)
    sections = _extract_heading_sections(soup)

    parsed = ParsedDocument(
        source_type="confluence",
        source_name=page_title,
        raw_text=raw_text,
        sections=sections,
        metadata={
            "url": url,
            "page_id": page_id,
            "space": space_name,
            "title": page_title,
        },
    )
    logger.info("Confluence 페이지 수집 완료: %s (%d자)", page_title, len(raw_text))
    return parsed


# ── URL 파싱 헬퍼 ──────────────────────────────────────────────────────────────

def _is_confluence(url: str) -> bool:
    parsed = urlparse(url)
    return bool(_CONFLUENCE_PATTERNS.search(parsed.path)) or "atlassian.net" in parsed.netloc


def _parse_confluence_url(url: str) -> tuple[str, str | None, str | None, str | None]:
    """Confluence URL에서 (base_url, page_id, space_key, title) 추출."""
    parsed = urlparse(url)
    base_url = f"{parsed.scheme}://{parsed.netloc}"
    qs = parse_qs(parsed.query)

    page_id: str | None = None
    space_key: str | None = None
    title_hint: str | None = None

    # /pages/viewpage.action?pageId=12345
    if "pageId" in qs:
        page_id = qs["pageId"][0]

    # /display/SPACEKEY/Page+Title
    elif "/display/" in parsed.path:
        parts = parsed.path.split("/display/", 1)[1].split("/", 1)
        space_key = parts[0]
        if len(parts) > 1:
            title_hint = parts[1].replace("+", " ").replace("-", " ")

    # /spaces/viewspace.action?key=SPACE → space overview (페이지 목록이므로 에러)
    elif "viewspace.action" in parsed.path and "key" in qs:
        raise ValueError(
            "Space 전체 URL은 지원하지 않습니다. 특정 페이지 URL을 입력해주세요.\n"
            "예: https://confl.sinc.co.kr/display/SPACE/페이지제목\n"
            "    https://confl.sinc.co.kr/pages/viewpage.action?pageId=12345"
        )

    # /rest/api/content/{id} 직접 입력
    elif "/rest/api/content/" in parsed.path:
        m = re.search(r"/rest/api/content/(\d+)", parsed.path)
        if m:
            page_id = m.group(1)

    return base_url, page_id, space_key, title_hint


# ── 텍스트 추출 헬퍼 ───────────────────────────────────────────────────────────

def _extract_text(tag) -> str:
    """BS4 태그 → 줄바꿈 정리된 순수 텍스트."""
    lines = []
    for element in tag.descendants:
        if element.name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            text = element.get_text(" ", strip=True)
            if text:
                lines.append(f"\n## {text}\n")
        elif element.name in ("p", "li", "td", "th", "div") and not any(
            p.name in ("p", "li", "td", "th") for p in element.parents if p != tag
        ):
            text = element.get_text(" ", strip=True)
            if text:
                lines.append(text)
        elif element.name == "br":
            lines.append("")

    raw = "\n".join(lines)
    # 연속 공백줄 정리
    raw = re.sub(r"\n{3,}", "\n\n", raw)
    return raw.strip()


def _extract_heading_sections(tag) -> list[dict]:
    """헤딩 태그 기반 섹션 분리."""
    sections: list[dict] = []
    current_title = ""
    current_level = 0
    current_lines: list[str] = []

    for element in tag.find_all(["h1", "h2", "h3", "h4", "p", "li", "td"]):
        if element.name in ("h1", "h2", "h3", "h4"):
            if current_lines or current_title:
                sections.append({
                    "title": current_title,
                    "content": "\n".join(current_lines).strip(),
                    "level": current_level,
                })
            current_title = element.get_text(" ", strip=True)
            current_level = int(element.name[1])
            current_lines = []
        else:
            text = element.get_text(" ", strip=True)
            if text:
                current_lines.append(text)

    if current_lines or current_title:
        sections.append({
            "title": current_title,
            "content": "\n".join(current_lines).strip(),
            "level": current_level,
        })

    return sections
