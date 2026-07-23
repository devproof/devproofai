"""Test doubles: a scripted /v1/messages SSE gateway, a scriptable MCP server,
and a tiny recording HTTP forward proxy."""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def sse_frames(blocks: list[dict], stop_reason: str = "end_turn",
               usage_in: int = 10, usage_out: int = 5) -> str:
    """Render scripted content blocks as the SSE stream a gateway would send.
    tool_use input arrives as split input_json_delta chunks to exercise
    partial-JSON accumulation."""
    frames = [("message_start", {"type": "message_start", "message": {
        "id": "msg_mock", "model": "mock-model", "role": "assistant",
        "usage": {"input_tokens": usage_in, "output_tokens": 1}}})]
    for i, block in enumerate(blocks):
        kind = block.get("type", "text")
        if kind == "tool_use":
            frames.append(("content_block_start", {
                "type": "content_block_start", "index": i,
                "content_block": {"type": "tool_use", "id": block.get("id", f"toolu_{i}"),
                                  "name": block["name"], "input": {}}}))
            raw = json.dumps(block.get("input", {}))
            mid = max(len(raw) // 2, 1)
            for part in (raw[:mid], raw[mid:]):
                if part:
                    frames.append(("content_block_delta", {
                        "type": "content_block_delta", "index": i,
                        "delta": {"type": "input_json_delta", "partial_json": part}}))
        elif kind == "thinking":
            frames.append(("content_block_start", {
                "type": "content_block_start", "index": i,
                "content_block": {"type": "thinking", "thinking": ""}}))
            frames.append(("content_block_delta", {
                "type": "content_block_delta", "index": i,
                "delta": {"type": "thinking_delta", "thinking": block.get("thinking", "")}}))
        else:
            frames.append(("content_block_start", {
                "type": "content_block_start", "index": i,
                "content_block": {"type": "text", "text": ""}}))
            text = block.get("text", "")
            mid = max(len(text) // 2, 1)
            for part in (text[:mid], text[mid:]):
                if part:
                    frames.append(("content_block_delta", {
                        "type": "content_block_delta", "index": i,
                        "delta": {"type": "text_delta", "text": part}}))
        frames.append(("content_block_stop", {"type": "content_block_stop", "index": i}))
    frames.append(("message_delta", {"type": "message_delta",
                   "delta": {"stop_reason": stop_reason},
                   "usage": {"output_tokens": usage_out}}))
    frames.append(("message_stop", {"type": "message_stop"}))
    return "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in frames)


class MockGateway:
    """Scripted /v1/messages server. Script entries:
    {"blocks": [...], "stop_reason": ...} for a streamed message, or
    {"status": 400, "message": "..."} for an HTTP error response."""

    def __init__(self):
        self.script: list[dict] = []
        self.requests: list[dict] = []       # parsed JSON bodies, in order
        self.headers: list[dict] = []        # lowercased header dicts, in order
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length) or b"{}")
                outer.requests.append(body)
                outer.headers.append({k.lower(): v for k, v in self.headers.items()})
                entry = outer.script.pop(0) if outer.script else {"status": 500,
                                                                  "message": "script exhausted"}
                if "status" in entry:
                    payload = json.dumps({"type": "error", "error": {
                        "type": "invalid_request_error", "message": entry.get("message", "boom")}})
                    self.send_response(entry["status"])
                    self.send_header("Content-Type", "application/json")
                    for name, value in (entry.get("headers") or {}).items():
                        self.send_header(name, value)
                    self.end_headers()
                    self.wfile.write(payload.encode())
                    return
                stream = sse_frames(entry.get("blocks", []),
                                    entry.get("stop_reason", "end_turn"),
                                    entry.get("usage_in", 10), entry.get("usage_out", 5))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(stream.encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class MockMcpServer:
    """Minimal streamable-HTTP MCP server: initialize / initialized /
    tools/list / tools/call. Set sse_replies=True to answer tools/call with an
    SSE-encoded body (both encodings are legal for streamable HTTP)."""

    def __init__(self, tools: list[dict], call_result: dict, sse_replies: bool = False,
                 require_auth: str | None = None):
        self.calls: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send_json(self, payload: dict, status: int = 200):
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Mcp-Session-Id", "mock-session-1")
                self.end_headers()
                self.wfile.write(data)

            def _send_sse(self, payload: dict):
                data = f"event: message\ndata: {json.dumps(payload)}\n\n".encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                if require_auth and self.headers.get("Authorization") != require_auth:
                    self._send_json({"error": "unauthorized"}, status=401)
                    return
                length = int(self.headers.get("Content-Length", "0"))
                msg = json.loads(self.rfile.read(length) or b"{}")
                outer.calls.append(msg)
                method = msg.get("method")
                if method == "notifications/initialized":
                    self.send_response(202)
                    self.end_headers()
                    return
                if method == "initialize":
                    result = {"protocolVersion": "2025-03-26", "capabilities": {},
                              "serverInfo": {"name": "mock-mcp", "version": "0"}}
                elif method == "tools/list":
                    result = {"tools": tools}
                elif method == "tools/call":
                    result = call_result
                else:
                    self._send_json({"jsonrpc": "2.0", "id": msg.get("id"),
                                     "error": {"code": -32601, "message": "unknown method"}})
                    return
                reply = {"jsonrpc": "2.0", "id": msg.get("id"), "result": result}
                if sse_replies and method == "tools/call":
                    self._send_sse(reply)
                else:
                    self._send_json(reply)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/mcp"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class MockProxy:
    """Recording HTTP forward proxy (plain-HTTP absolute-URI requests only).
    deny=True answers 403 like Squid does for a host outside the allowlist."""

    def __init__(self, deny: bool = False, body: str = "proxied content"):
        self.seen: list[str] = []  # absolute request URIs
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _respond(self):
                outer.seen.append(self.path)
                if deny:
                    self.send_response(403)
                    self.send_header("Content-Type", "text/plain")
                    self.end_headers()
                    self.wfile.write(b"Squid: access denied")
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(body.encode())

            def do_GET(self):
                self._respond()

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                if length:
                    self.rfile.read(length)
                self._respond()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
