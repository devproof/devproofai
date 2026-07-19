"""MCP client tests: discovery, call round-trips, header auth, SSE bodies,
and resilience when a server is unreachable."""
import os
import tempfile
import unittest

from helpers import EnvSandbox, by_type, collect
from mock_gateway import MockGateway, MockMcpServer

from devproof_runner import AgentOptions
from devproof_runner.types import (ResultMessage, SystemMessage, ToolResultBlock,
                                      UserMessage)

LOOKUP_TOOL = {"name": "lookup", "description": "Look something up",
               "inputSchema": {"type": "object",
                               "properties": {"q": {"type": "string"}},
                               "required": ["q"]}}
CALL_RESULT = {"content": [{"type": "text", "text": "mcp says hi"}]}


class McpTest(unittest.TestCase):
    def setUp(self):
        self.sandbox = EnvSandbox().__enter__()
        self.gw = MockGateway()
        os.environ["DEVPROOF_BASE_URL"] = self.gw.url
        os.environ["DEVPROOF_AUTH_TOKEN"] = "dpk_test"
        self.cwd = tempfile.mkdtemp(prefix="devproof-mcp-")

    def tearDown(self):
        self.gw.close()
        self.sandbox.__exit__(None, None, None)

    def opts(self, mcp_servers):
        return AgentOptions(model="m", tools=["Bash"], max_turns=5, cwd=self.cwd,
                            mcp_servers=mcp_servers)

    def script_tool_call(self):
        self.gw.script = [
            {"blocks": [{"type": "tool_use", "id": "t1", "name": "mcp__docs__lookup",
                         "input": {"q": "howto"}}], "stop_reason": "tool_use"},
            {"blocks": [{"type": "text", "text": "answered"}]},
        ]

    def test_roundtrip_with_auth_header(self):
        mcp = MockMcpServer([LOOKUP_TOOL], CALL_RESULT, require_auth="Bearer tok")
        try:
            self.script_tool_call()
            messages, err = collect("q", self.opts({
                "docs": {"type": "http", "url": mcp.url,
                         "headers": {"Authorization": "Bearer tok"}}}))
        finally:
            mcp.close()
        self.assertIsNone(err)
        init = by_type(messages, SystemMessage)[0]
        self.assertIn("mcp__docs__lookup", init.data["tools"])
        result_block = by_type(messages, UserMessage)[0].content[0]
        self.assertIsInstance(result_block, ToolResultBlock)
        self.assertEqual(result_block.content, "mcp says hi")
        self.assertFalse(result_block.is_error)
        methods = [c.get("method") for c in mcp.calls]
        self.assertEqual(methods,
                         ["initialize", "notifications/initialized", "tools/list",
                          "tools/call"])
        self.assertEqual(mcp.calls[-1]["params"]["arguments"], {"q": "howto"})
        # The MCP tool schema was advertised to the model.
        advertised = [t["name"] for t in self.gw.requests[0]["tools"]]
        self.assertIn("mcp__docs__lookup", advertised)

    def test_sse_encoded_reply(self):
        mcp = MockMcpServer([LOOKUP_TOOL], CALL_RESULT, sse_replies=True)
        try:
            self.script_tool_call()
            messages, err = collect("q", self.opts({
                "docs": {"type": "http", "url": mcp.url}}))
        finally:
            mcp.close()
        self.assertIsNone(err)
        self.assertEqual(by_type(messages, UserMessage)[0].content[0].content,
                         "mcp says hi")

    def test_is_error_result_propagates(self):
        mcp = MockMcpServer([LOOKUP_TOOL],
                            {"content": [{"type": "text", "text": "boom"}],
                             "isError": True})
        try:
            self.script_tool_call()
            messages, err = collect("q", self.opts({
                "docs": {"type": "http", "url": mcp.url}}))
        finally:
            mcp.close()
        self.assertIsNone(err)
        block = by_type(messages, UserMessage)[0].content[0]
        self.assertTrue(block.is_error)
        self.assertEqual(block.content, "boom")

    def test_unreachable_server_is_skipped(self):
        self.gw.script = [{"blocks": [{"type": "text", "text": "fine without mcp"}]}]
        messages, err = collect("q", self.opts({
            "dead": {"type": "http", "url": "http://127.0.0.1:1/mcp"}}))
        self.assertIsNone(err)
        init = by_type(messages, SystemMessage)[0]
        self.assertNotIn("mcp__dead__lookup", init.data["tools"])
        self.assertEqual(by_type(messages, ResultMessage)[0].subtype, "success")


if __name__ == "__main__":
    unittest.main()
