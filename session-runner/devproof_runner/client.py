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
from dataclasses import dataclass, field

import anyio
import httpx

from .errors import APIError
from .types import TextBlock, ThinkingBlock, ToolUseBlock

RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504, 529}
MAX_ATTEMPTS = 4


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
        last_err: Exception | None = None
        for attempt in range(MAX_ATTEMPTS):
            if attempt:
                # Jitter: hundreds of session pods retrying a gateway blip must
                # not re-arrive in lockstep.
                await anyio.sleep(2 ** attempt + random.uniform(0, 1))
            try:
                return await self._stream_once(body)
            except APIError as err:
                if not err.retryable:
                    raise
                last_err = err
            except httpx.HTTPError as err:
                last_err = APIError(f"connection error: {err}", retryable=True)
        raise last_err  # type: ignore[misc]

    async def _stream_once(self, body: dict) -> ApiResponse:
        async with self._client.stream("POST", "/v1/messages", json=body) as res:
            if res.status_code != 200:
                raw = (await res.aread()).decode("utf-8", "replace")
                try:
                    detail = json.loads(raw).get("error", {}).get("message") or raw
                except (json.JSONDecodeError, AttributeError):
                    detail = raw
                raise APIError(f"API Error: {res.status_code} {detail}"[:4000],
                               status=res.status_code,
                               retryable=res.status_code in RETRYABLE_STATUS)
            return await self._parse_sse(res)

    async def _parse_sse(self, res: httpx.Response) -> ApiResponse:
        out = ApiResponse()
        builders: dict[int, _BlockBuilder] = {}
        order: list[int] = []
        data_lines: list[str] = []
        async for line in res.aiter_lines():
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
