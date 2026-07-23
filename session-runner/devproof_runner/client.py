"""Streaming client for the Devproof gateway's /v1/messages endpoint.

Speaks the SSE wire format the gateway serves (LiteLLM chat-completions
bridge, incl. thinking deltas and the injected prompt-estimate usage). The
whole response is buffered into blocks before returning — callers consume
complete messages, which is all the session runner ever emits.
"""
from __future__ import annotations

import json
import os
import random
import time
from dataclasses import dataclass, field

import anyio
import httpx

from .errors import APIError
from .types import TextBlock, ThinkingBlock, ToolUseBlock

RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504, 529}
MAX_ATTEMPTS = 4

# Patient retries (spec 2026-07-23, amended 2026-07-23 after a live outage):
# a gateway 503 means "the model is coming back — wait" (hold-cap expiry,
# rolling config reload, model still loading), and a connect-level failure
# means no request was consumed. Both retry on a TIME budget instead of an
# attempt count, so a session waits out a model rollout instead of failing
# the turn. Other retryables keep MAX_ATTEMPTS.
#
# The 503 trigger is the STATUS ITSELF, not the presence of a Retry-After
# header: wire probes proved LiteLLM's /v1/messages (the Messages-API bridge)
# surface drops the Retry-After response header entirely (it IS present on
# /chat/completions), and the runner only ever calls /v1/messages. So a
# header-gated trigger can never fire on this platform and every 503 stayed
# attempt-bounded (~15s) — turns died mid-outage. Every gateway 503 here is a
# transient hold/reload/unavailable state, so the status alone is the signal;
# the header, when present, only refines the delay.
PATIENT_WINDOW = float(os.environ.get("DEVPROOF_SDK_PATIENT_RETRY", "1800"))

# Scale-to-zero wake detection (spec 2026-07-23d). A wake-hold (custom_callbacks
# _hold_for_wake) holds the FIRST call until the model is routable, then returns
# 200 — no 503, no retry — whenever the wake fits inside the 300s hold. Such a
# wake leaves NO patient-retry trace, so its time silently folds into the first
# model step (a held gemma wake showed as a 43s "Think" row, no Wait badge —
# live sesn_vd9nfd8qxwig). Infer it from the time-to-first-frame instead: a call
# whose first SSE frame lands this long after the request was sent was held for
# the model to come up. Threshold sits above warm prefill (measured ~3-10s on
# CPU) and below a real wake (13s+); env-tunable. Reported as reason "wake".
WAKE_MIN_MS = int(float(os.environ.get("DEVPROOF_SDK_WAKE_MIN_SEC", "12")) * 1000)


def wake_wait_ms(ttfb_ms: int, had_retry_wait: bool) -> int:
    """Held time to charge as a scale-up/wake wait (0 = not a wake): a long
    time-to-first-frame on a call that did NOT already patient-retry (a retry
    records its own wait; don't double-count)."""
    return ttfb_ms if (not had_retry_wait and ttfb_ms >= WAKE_MIN_MS) else 0


def parse_custom_headers(raw: str) -> dict[str, str]:
    """DEVPROOF_CUSTOM_HEADERS: newline-separated "Name: value" lines."""
    headers: dict[str, str] = {}
    for line in (raw or "").splitlines():
        name, sep, value = line.partition(":")
        if sep and name.strip():
            headers[name.strip()] = value.strip()
    return headers


@dataclass
class ApiResponse:
    content: list = field(default_factory=list)
    stop_reason: str | None = None
    usage: dict = field(default_factory=dict)
    model: str = ""
    # Wait accounting (trace follow-up 2026-07-23): time spent in the retry
    # loop before the attempt that succeeded (0 = clean first try), and the
    # monotonic timestamp of that attempt's start — the moment the model was
    # back up. Lets the runner stamp a dedicated model.wait trace row so
    # deploy/scale time is not misread as generation time.
    waited_ms: int = 0
    wait_ended: float = 0.0
    # Time-to-first-frame (ms): request-send to first SSE frame. A held first
    # call (scale-to-zero wake-hold) inflates this — see wake_wait_ms.
    ttfb_ms: int = 0
    # Why the wait happened, classified from the last retried error (None =
    # unclassified/no wait): "reload" (gateway rolling-reload guard), "wake"
    # (scale-to-zero wake hold), "gateway" (gateway itself unreachable).
    wait_reason: str | None = None


def classify_wait_reason(err: "APIError | None") -> str | None:
    """Map the last retried error to a wait cause. The 503 detail strings are
    the gateway's stable markers (helm-charts/files/custom_callbacks.py) —
    keep them in sync. Connect-level APIErrors carry no HTTP status."""
    if err is None:
        return None
    if err.status is None:
        return "gateway"
    msg = str(err)
    if "reloading on this gateway replica" in msg:
        return "reload"
    if "waking from scale-to-zero" in msg:
        return "wake"
    return None


class _BlockBuilder:
    """Accumulates one content block across start/delta/stop SSE frames."""

    def __init__(self, start: dict):
        self.type = start.get("type", "text")
        self.text = start.get("text", "")
        self.thinking = start.get("thinking", "")
        self.signature = start.get("signature", "")
        self.id = start.get("id", "")
        self.name = start.get("name", "")
        self.json_parts: list[str] = []

    def delta(self, d: dict) -> None:
        kind = d.get("type")
        if kind == "text_delta":
            self.text += d.get("text", "")
        elif kind == "thinking_delta":
            self.thinking += d.get("thinking", "")
        elif kind == "signature_delta":
            self.signature += d.get("signature", "")
        elif kind == "input_json_delta":
            self.json_parts.append(d.get("partial_json", ""))

    def finish(self):
        if self.type == "tool_use":
            raw = "".join(self.json_parts).strip()
            try:
                tool_input = json.loads(raw) if raw else {}
                if isinstance(tool_input, str):
                    # Some bridges double-encode tool input (seen live from an
                    # external provider): the JSON parses to a STRING that is
                    # itself the argument object.
                    tool_input = json.loads(tool_input)
            except json.JSONDecodeError:
                tool_input = {"_raw": raw}
            if not isinstance(tool_input, dict):
                tool_input = {"_raw": tool_input}
            return ToolUseBlock(id=self.id, name=self.name, input=tool_input)
        if self.type == "thinking":
            return ThinkingBlock(thinking=self.thinking, signature=self.signature)
        if self.type == "redacted_thinking":
            return None
        return TextBlock(text=self.text)


class MessagesClient:
    def __init__(self, base_url: str | None = None, auth_token: str | None = None,
                 read_timeout: float | None = None):
        base = (base_url or os.environ.get("DEVPROOF_BASE_URL") or "").rstrip("/")
        if not base:
            raise APIError("DEVPROOF_BASE_URL is not set and no base_url was given")
        token = auth_token or os.environ.get("DEVPROOF_AUTH_TOKEN") or ""
        headers = {"content-type": "application/json"}
        if token:
            # Both auth spellings: the gateway's custom auth accepts either.
            headers["authorization"] = f"Bearer {token}"
            headers["x-api-key"] = token
        headers.update(parse_custom_headers(os.environ.get("DEVPROOF_CUSTOM_HEADERS", "")))
        read = read_timeout or float(os.environ.get("DEVPROOF_SDK_READ_TIMEOUT", "600"))
        self._client = httpx.AsyncClient(
            base_url=base, headers=headers, trust_env=True,
            timeout=httpx.Timeout(connect=30.0, read=read, write=60.0, pool=30.0),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def create(self, *, model: str, system: str, messages: list,
                     tools: list | None, max_tokens: int) -> ApiResponse:
        body: dict = {"model": model, "max_tokens": max_tokens,
                      "messages": messages, "stream": True}
        if system:
            body["system"] = system
        if tools:
            body["tools"] = tools
        last_err: APIError | None = None
        patient = False
        # Two independent budgets: patient iterations (Retry-After 503s, or a
        # connect-level failure) are bounded purely by PATIENT_WINDOW time and
        # never touch bounded_attempts, so a run of patient retries can't eat
        # into the MAX_ATTEMPTS budget a later non-patient retryable needs.
        bounded_attempts = 0
        entry = time.monotonic()
        deadline = entry + PATIENT_WINDOW
        while True:
            if last_err is not None:
                # Jitter: hundreds of session pods retrying a gateway blip must
                # not re-arrive in lockstep. EVERY patient iteration (503s and
                # connect-level failures alike) uses the patient delay —
                # Retry-After (capped) when parsed, else a fixed 5s fallback —
                # never the exponential formula, or a run of patient connect
                # errors (no status, no retry_after) collapses to the ~1s
                # bounded-attempts floor for the whole PATIENT_WINDOW.
                if patient:
                    delay = 5.0 + random.uniform(0, 1)
                    if last_err.retry_after is not None:
                        delay = min(last_err.retry_after, 30.0) + random.uniform(0, 1)
                else:
                    delay = 2 ** min(bounded_attempts, 4) + random.uniform(0, 1)
                await anyio.sleep(delay)
            try:
                attempt_start = time.monotonic()
                resp = await self._stream_once(body)
                if last_err is not None:
                    resp.waited_ms = int((attempt_start - entry) * 1000)
                    resp.wait_ended = attempt_start
                    resp.wait_reason = classify_wait_reason(last_err)
                else:
                    # No retry, but a long time-to-first-frame means the gateway
                    # held this call for a scale-to-zero wake (200 within the
                    # 300s hold). Charge the held time as a wake wait.
                    held = wake_wait_ms(resp.ttfb_ms, had_retry_wait=False)
                    if held:
                        resp.waited_ms = held
                        resp.wait_ended = attempt_start + held / 1000.0
                        resp.wait_reason = "wake"
                return resp
            except APIError as err:
                if not err.retryable:
                    raise
                last_err = err
                # 503 alone is the patient trigger (see PATIENT_WINDOW comment
                # above) — Retry-After is a delay refinement only, not a gate.
                patient = err.status == 503
            except httpx.HTTPError as err:
                last_err = APIError(f"connection error: {err}", retryable=True)
                # No response consumed -> always safe to resend.
                patient = isinstance(err, (httpx.ConnectError, httpx.ConnectTimeout,
                                           httpx.RemoteProtocolError))
            if patient:
                if time.monotonic() >= deadline:
                    raise last_err
            else:
                bounded_attempts += 1
                if bounded_attempts >= MAX_ATTEMPTS:
                    raise last_err

    async def _stream_once(self, body: dict) -> ApiResponse:
        # t0 before the stream opens: a wake-hold blocks here (response headers
        # arrive only once the gateway releases the held request), so the
        # time-to-first-frame measured from t0 captures the hold.
        t0 = time.monotonic()
        async with self._client.stream("POST", "/v1/messages", json=body) as res:
            if res.status_code != 200:
                raw = (await res.aread()).decode("utf-8", "replace")
                try:
                    detail = json.loads(raw).get("error", {}).get("message") or raw
                except (json.JSONDecodeError, AttributeError):
                    detail = raw
                ra = res.headers.get("retry-after")
                try:
                    retry_after = float(ra) if ra is not None else None
                except ValueError:
                    retry_after = None
                raise APIError(f"API Error: {res.status_code} {detail}"[:4000],
                               status=res.status_code,
                               retryable=res.status_code in RETRYABLE_STATUS,
                               retry_after=retry_after)
            return await self._parse_sse(res, t0)

    async def _parse_sse(self, res: httpx.Response, t0: float | None = None) -> ApiResponse:
        out = ApiResponse()
        builders: dict[int, _BlockBuilder] = {}
        order: list[int] = []
        data_lines: list[str] = []
        async for line in res.aiter_lines():
            if out.ttfb_ms == 0 and t0 is not None and line.strip():
                out.ttfb_ms = int((time.monotonic() - t0) * 1000)
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
                continue
            if line.strip() != "" or not data_lines:
                continue  # event:/comment lines and interior blanks
            raw = "\n".join(data_lines)
            data_lines = []
            if raw == "[DONE]":
                break
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = event.get("type")
            if kind == "message_start":
                msg = event.get("message", {})
                out.model = msg.get("model", "")
                self._merge_usage(out.usage, msg.get("usage") or {})
            elif kind == "content_block_start":
                idx = event.get("index", len(order))
                builders[idx] = _BlockBuilder(event.get("content_block") or {})
                order.append(idx)
            elif kind == "content_block_delta":
                b = builders.get(event.get("index", -1))
                if b:
                    b.delta(event.get("delta") or {})
            elif kind == "message_delta":
                delta = event.get("delta") or {}
                out.stop_reason = delta.get("stop_reason") or out.stop_reason
                self._merge_usage(out.usage, event.get("usage") or {})
            elif kind == "error":
                err = event.get("error") or {}
                retryable = err.get("type") in ("overloaded_error", "api_error")
                raise APIError(f"API Error: {err.get('type')}: {err.get('message')}",
                               retryable=retryable)
            elif kind == "message_stop":
                break
        for idx in order:
            block = builders[idx].finish()
            if block is None:
                continue
            # The gateway bridge emits an empty text block ahead of tool_use
            # blocks — pure transcript noise downstream (empty agent.message
            # events); drop empties unless they are the whole response.
            if isinstance(block, TextBlock) and not block.text.strip():
                continue
            out.content.append(block)
        return out

    @staticmethod
    def _merge_usage(into: dict, usage: dict) -> None:
        for key, value in usage.items():
            if isinstance(value, (int, float)) and value:
                into[key] = value
