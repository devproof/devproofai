"""Minimal MCP client: JSON-RPC 2.0 over streamable HTTP.

Scope matches the platform: remote servers only (`type: "http" | "sse"` in the
agent config — the bundled registry is streamable-HTTP only, so both types are
served by this transport), per-server headers already expanded by the runner.
Tools are exposed to the model as mcp__<server>__<tool>.
"""
from __future__ import annotations

import json
from typing import Any

import anyio
import httpx

PROTOCOL_VERSION = "2025-03-26"
MCP_PREFIX = "mcp__"


class McpError(Exception):
    pass


def mcp_tool_name(server: str, tool: str) -> str:
    return f"{MCP_PREFIX}{server}__{tool}"


def _parse_rpc_body(res: httpx.Response, request_id: int) -> dict:
    """A streamable-HTTP server answers a POST with either a JSON body or an
    SSE stream; in the stream, the reply is the message whose id matches."""
    content_type = res.headers.get("content-type", "")
    if "text/event-stream" in content_type:
        # Normalize CRLF first: a server framing events with \r\n\r\n would
        # otherwise arrive as one unsplittable chunk.
        for chunk in res.text.replace("\r\n", "\n").split("\n\n"):
            data_lines = [ln[5:].lstrip() for ln in chunk.splitlines() if ln.startswith("data:")]
            if not data_lines:
                continue
            try:
                msg = json.loads("\n".join(data_lines))
            except json.JSONDecodeError:
                continue
            if msg.get("id") == request_id and ("result" in msg or "error" in msg):
                return msg
        raise McpError("no JSON-RPC response in SSE stream")
    try:
        return res.json()
    except json.JSONDecodeError as err:
        raise McpError(f"invalid JSON-RPC response: {err}") from err


class McpServer:
    def __init__(self, name: str, config: dict):
        self.name = name
        self.url = str(config.get("url") or "")
        headers = {k: v for k, v in (config.get("headers") or {}).items()
                   if isinstance(v, str)}
        headers.setdefault("Accept", "application/json, text/event-stream")
        headers.setdefault("Content-Type", "application/json")
        # Read generous: MCP tools can legitimately run minutes (searches,
        # doc queries); the turn deadline is the real upper bound.
        self._client = httpx.AsyncClient(
            trust_env=True, headers=headers, follow_redirects=True,
            timeout=httpx.Timeout(connect=30.0, read=300.0, write=60.0, pool=30.0))
        self._next_id = 0
        self._session_id: str | None = None
        self.tools: list[dict] = []

    async def _rpc(self, method: str, params: dict | None = None,
                   notification: bool = False) -> Any:
        body: dict = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            body["params"] = params
        headers = {}
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        if notification:
            res = await self._client.post(self.url, json=body, headers=headers)
            if res.status_code >= 400:
                raise McpError(f"{method}: HTTP {res.status_code}")
            return None
        self._next_id += 1
        body["id"] = self._next_id
        res = await self._client.post(self.url, json=body, headers=headers)
        if res.status_code >= 400:
            raise McpError(f"{method}: HTTP {res.status_code} {res.text[:300]}")
        if sid := res.headers.get("Mcp-Session-Id"):
            self._session_id = sid
        msg = _parse_rpc_body(res, self._next_id)
        if "error" in msg:
            err = msg["error"]
            raise McpError(f"{method}: {err.get('code')} {err.get('message')}")
        return msg.get("result")

    async def start(self) -> None:
        await self._rpc("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "devproof-runner", "version": "0.1.0"},
        })
        await self._rpc("notifications/initialized", notification=True)
        result = await self._rpc("tools/list", {})
        self.tools = (result or {}).get("tools") or []

    async def call(self, tool: str, arguments: dict) -> tuple[str, bool]:
        try:
            result = await self._rpc("tools/call", {"name": tool, "arguments": arguments})
        except (McpError, httpx.HTTPError) as err:
            return f"MCP call failed: {err}", True
        parts = []
        for item in (result or {}).get("content") or []:
            if item.get("type") == "text":
                parts.append(item.get("text", ""))
            else:
                parts.append(json.dumps(item, default=str))
        text = "\n".join(p for p in parts if p) or "(empty result)"
        return text, bool((result or {}).get("isError"))

    async def aclose(self) -> None:
        await self._client.aclose()


class McpManager:
    """Connects configured servers; a server that fails its handshake is
    skipped with a warning (its tools just don't exist this turn) — one broken
    upstream must not fail the whole session turn."""

    def __init__(self, servers: dict[str, dict]):
        self._configs = servers or {}
        self._servers: dict[str, McpServer] = {}
        self.warnings: list[str] = []

    async def start(self) -> dict[str, tuple[McpServer, str, dict]]:
        """Returns enabled tools: qualified name -> (server, raw tool name, schema).
        Handshakes run CONCURRENTLY — one slow/dead server must not add its
        connect timeout to every turn's startup for the others."""
        connected: dict[str, McpServer] = {}

        async def connect(name: str, config: dict) -> None:
            server = McpServer(name, config)
            try:
                await server.start()
            except (McpError, httpx.HTTPError, json.JSONDecodeError) as err:
                self.warnings.append(f"mcp server {name}: {err} — skipped")
                await server.aclose()
                return
            connected[name] = server

        async with anyio.create_task_group() as tg:
            for name, config in self._configs.items():
                if not isinstance(config, dict) or not config.get("url"):
                    self.warnings.append(f"mcp server {name}: missing url — skipped")
                    continue
                tg.start_soon(connect, name, config)

        tools: dict[str, tuple[McpServer, str, dict]] = {}
        for name in self._configs:  # deterministic tool order regardless of connect order
            server = connected.get(name)
            if not server:
                continue
            self._servers[name] = server
            for tool in server.tools:
                raw = tool.get("name") or ""
                if not raw:
                    continue
                schema = tool.get("inputSchema") or {"type": "object", "properties": {}}
                tools[mcp_tool_name(name, raw)] = (server, raw, {
                    "name": mcp_tool_name(name, raw),
                    "description": tool.get("description") or f"{raw} on MCP server {name}",
                    "input_schema": schema,
                })
        return tools

    async def aclose(self) -> None:
        for server in self._servers.values():
            await server.aclose()
