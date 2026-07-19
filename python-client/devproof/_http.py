"""HTTP transport: auth header, retries with backoff, pagination, SSE."""
from __future__ import annotations

import json
import random
import time
from contextlib import contextmanager
from typing import Any, Iterator

import httpx

from .errors import APIConnectionError, APIStatusError, ERROR_BY_STATUS

RETRY_STATUSES = {429, 500, 502, 503, 504}
PAGE_SIZE = 100


class HttpClient:
    def __init__(self, base_url: str, api_key: str, timeout: float = 60.0, max_retries: int = 2):
        self.max_retries = max_retries
        self._c = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            headers={"Authorization": f"Bearer {api_key}"},
        )

    def request(self, method: str, path: str, **kw: Any) -> httpx.Response:
        last: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                resp = self._c.request(method, path, **kw)
            except httpx.TransportError as err:
                last = APIConnectionError(str(err))
            else:
                if resp.status_code < 400:
                    return resp
                body = _safe_json(resp)
                err_cls = ERROR_BY_STATUS.get(resp.status_code, APIStatusError)
                last = err_cls(resp.status_code, body)
                if resp.status_code not in RETRY_STATUSES:
                    raise last
            if attempt < self.max_retries:
                time.sleep(0.5 * 2**attempt + random.uniform(0, 0.25))
        raise last  # type: ignore[misc]

    def json(self, method: str, path: str, **kw: Any) -> Any:
        return self.request(method, path, **kw).json()

    def paginate(self, path: str, key: str, params: dict | None = None) -> Iterator[dict]:
        """Iterate every item across {key: [...], count/total, offset} pages."""
        offset = 0
        while True:
            page = self.json("GET", path, params={**(params or {}), "offset": offset, "limit": PAGE_SIZE})
            items = page.get(key) or page.get("rows") or []
            yield from items
            offset += len(items)
            total = page.get("count", page.get("total", 0))
            if not items or offset >= total:
                return

    @contextmanager
    def stream(self, method: str, path: str, **kw: Any):
        """Streaming request; raises typed errors on non-2xx before yielding."""
        with self._c.stream(method, path, **kw) as resp:
            if resp.status_code >= 400:
                resp.read()
                err_cls = ERROR_BY_STATUS.get(resp.status_code, APIStatusError)
                raise err_cls(resp.status_code, _safe_json(resp))
            yield resp

    def sse(self, path: str, body: dict) -> Iterator[tuple[str, dict]]:
        """POST {"stream": true, ...}; yield (event_name, data) pairs until 'end'.
        A dropped connection raises APIConnectionError (callers may resume)."""
        try:
            with self.stream("POST", path, json={**body, "stream": True}, timeout=None) as resp:
                event_name = "message"
                for line in resp.iter_lines():
                    if line.startswith("event:"):
                        event_name = line.split(":", 1)[1].strip()
                    elif line.startswith("data:"):
                        if event_name == "end":
                            return
                        yield event_name, json.loads(line.split(":", 1)[1])
                        event_name = "message"
        except httpx.TransportError as err:
            raise APIConnectionError(str(err)) from err


def _safe_json(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except Exception:
        return {"error": resp.text[:500]}
