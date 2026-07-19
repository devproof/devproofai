"""WebFetch tool: fetch a URL and return its text content.

No hostname preflight of any kind — the environment's egress allowlist (Squid)
is the only fetch control, per the platform's locked-down-environment stance.
Proxy env vars (HTTP(S)_PROXY / NO_PROXY) are honored via httpx trust_env.
"""
from __future__ import annotations

import html
import re

import httpx

from .base import Tool

MAX_CONTENT_CHARS = 50_000
# Hard byte cap on the download itself: without it a fetch of a huge artifact
# (dataset, ISO) buffers fully in memory and OOM-kills the session pod.
MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024

_DROP_BLOCKS = re.compile(r"<(script|style|noscript)\b.*?</\1>", re.IGNORECASE | re.DOTALL)
_TAGS = re.compile(r"<[^>]+>")
_BLANK_RUNS = re.compile(r"\n{3,}")


def html_to_text(markup: str) -> str:
    text = _DROP_BLOCKS.sub(" ", markup)
    # Keep some block structure so headings/paragraphs stay separated.
    text = re.sub(r"(?i)<(br|/p|/div|/h[1-6]|/li|/tr)\s*/?>", "\n", text)
    text = _TAGS.sub(" ", text)
    text = html.unescape(text)
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.splitlines()]
    return _BLANK_RUNS.sub("\n\n", "\n".join(lines)).strip()


async def _execute(tool_input: dict, cwd: str) -> tuple[str, bool]:
    url = str(tool_input.get("url") or "").strip()
    # Models routinely pass bare hostnames ("example.com") — default to https
    # rather than burning a turn on an error (seen live, 2026-07-17).
    if url and "://" not in url:
        url = f"https://{url}"
    if not url.lower().startswith(("http://", "https://")):
        return "url must be http(s)", True
    try:
        async with httpx.AsyncClient(
                trust_env=True, follow_redirects=True, timeout=30.0,
                headers={"User-Agent": "devproof-runner/0.1"}) as client:
            async with client.stream("GET", url) as res:
                if res.status_code >= 400:
                    return f"HTTP {res.status_code} fetching {url}", True
                content_type = res.headers.get("content-type", "")
                chunks: list[bytes] = []
                total = 0
                async for chunk in res.aiter_bytes():
                    chunks.append(chunk)
                    total += len(chunk)
                    if total >= MAX_DOWNLOAD_BYTES:
                        break
    except httpx.HTTPError as err:
        return f"Fetch failed ({url}): {err}", True
    body = b"".join(chunks).decode(res.charset_encoding or "utf-8", "replace")
    if "html" in content_type:
        body = html_to_text(body)
    if len(body) > MAX_CONTENT_CHARS:
        body = body[:MAX_CONTENT_CHARS] + f"\n... [truncated at {MAX_CONTENT_CHARS} chars]"
    return body or "(empty response)", False


WEBFETCH_TOOL = Tool(
    name="WebFetch",
    description=("Fetches a URL and returns its content as text (HTML is stripped to "
                 "readable text, truncated at 50000 characters). Subject to the "
                 "environment's egress allowlist."),
    input_schema={
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "The http(s) URL to fetch"},
            "prompt": {"type": "string",
                       "description": "Optional note on what to look for in the page"},
        },
        "required": ["url"],
    },
    executor=_execute,
)
