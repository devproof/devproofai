"""Agentic-loop tests against the scripted mock gateway."""
import os
import tempfile
import unittest

from helpers import EnvSandbox, by_type, collect
from mock_gateway import MockGateway

from devproof_runner import AgentOptions
from devproof_runner.types import (AssistantMessage, ResultMessage, SystemMessage,
                                      TextBlock, ThinkingBlock, ToolResultBlock,
                                      ToolUseBlock, UserMessage)


class QueryLoopTest(unittest.TestCase):
    def setUp(self):
        self.sandbox = EnvSandbox().__enter__()
        self.gw = MockGateway()
        os.environ["DEVPROOF_BASE_URL"] = self.gw.url
        os.environ["DEVPROOF_AUTH_TOKEN"] = "dpk_test"
        self.cwd = tempfile.mkdtemp(prefix="devproof-work-")

    def tearDown(self):
        self.gw.close()
        self.sandbox.__exit__(None, None, None)

    def opts(self, **kw):
        base = dict(model="test-routing", system_prompt="You are a test agent.",
                    tools=["Bash", "Read"], max_turns=10, cwd=self.cwd)
        base.update(kw)
        return AgentOptions(**base)

    def test_plain_text_turn(self):
        self.gw.script = [{"blocks": [{"type": "text", "text": "hello there"}]}]
        messages, err = collect("hi", self.opts())
        self.assertIsNone(err)
        init = by_type(messages, SystemMessage)[0]
        self.assertEqual(init.subtype, "init")
        self.assertTrue(init.data["session_id"])
        self.assertIn("Bash", init.data["tools"])
        assistant = by_type(messages, AssistantMessage)[0]
        self.assertEqual(assistant.content[0].text, "hello there")
        result = by_type(messages, ResultMessage)[0]
        self.assertEqual(result.subtype, "success")
        self.assertFalse(result.is_error)
        self.assertEqual(result.num_turns, 1)
        self.assertEqual(result.usage["input_tokens"], 10)
        self.assertEqual(result.usage["output_tokens"], 5)
        body = self.gw.requests[0]
        self.assertEqual(body["model"], "test-routing")
        self.assertEqual(body["system"], "You are a test agent.")
        self.assertTrue(body["stream"])
        self.assertIn("max_tokens", body)
        tool_names = [t["name"] for t in body["tools"]]
        self.assertEqual(tool_names, ["Bash", "Read"])
        headers = self.gw.headers[0]
        self.assertEqual(headers.get("x-api-key"), "dpk_test")
        self.assertEqual(headers.get("authorization"), "Bearer dpk_test")

    def test_custom_headers_ride_every_request(self):
        os.environ["DEVPROOF_CUSTOM_HEADERS"] = (
            "X-Devproof-Agent: agent_1\nX-Devproof-Session: sesn_1\nX-Devproof-Turn: 3")
        self.gw.script = [{"blocks": [{"type": "text", "text": "ok"}]}]
        _messages, err = collect("hi", self.opts())
        self.assertIsNone(err)
        headers = self.gw.headers[0]
        self.assertEqual(headers.get("x-devproof-agent"), "agent_1")
        self.assertEqual(headers.get("x-devproof-session"), "sesn_1")
        self.assertEqual(headers.get("x-devproof-turn"), "3")

    def test_tool_loop_executes_bash(self):
        self.gw.script = [
            {"blocks": [{"type": "text", "text": "running it"},
                        {"type": "tool_use", "id": "toolu_1", "name": "Bash",
                         "input": {"command": "echo hello-from-bash"}}],
             "stop_reason": "tool_use"},
            {"blocks": [{"type": "text", "text": "done"}]},
        ]
        messages, err = collect("run echo", self.opts())
        self.assertIsNone(err)
        tool_use = [b for m in by_type(messages, AssistantMessage) for b in m.content
                    if isinstance(b, ToolUseBlock)][0]
        self.assertEqual(tool_use.name, "Bash")
        results = [b for m in by_type(messages, UserMessage) for b in m.content
                   if isinstance(b, ToolResultBlock)]
        self.assertEqual(len(results), 1)
        self.assertIn("hello-from-bash", results[0].content)
        self.assertFalse(results[0].is_error)
        result = by_type(messages, ResultMessage)[0]
        self.assertEqual(result.subtype, "success")
        self.assertEqual(result.num_turns, 2)
        # Second request carries the tool_result transcript.
        second = self.gw.requests[1]["messages"]
        self.assertEqual(second[-1]["role"], "user")
        self.assertEqual(second[-1]["content"][0]["type"], "tool_result")
        self.assertEqual(second[-1]["content"][0]["tool_use_id"], "toolu_1")

    def test_thinking_yielded_but_not_replayed(self):
        self.gw.script = [
            {"blocks": [{"type": "thinking", "thinking": "let me reason"},
                        {"type": "tool_use", "id": "toolu_t", "name": "Bash",
                         "input": {"command": "echo x"}}],
             "stop_reason": "tool_use"},
            {"blocks": [{"type": "text", "text": "done"}]},
        ]
        messages, err = collect("think", self.opts())
        self.assertIsNone(err)
        thinking = [b for m in by_type(messages, AssistantMessage) for b in m.content
                    if isinstance(b, ThinkingBlock)]
        self.assertEqual(thinking[0].thinking, "let me reason")
        replayed = self.gw.requests[1]["messages"]
        assistant_blocks = [b for m in replayed if m["role"] == "assistant"
                            for b in m["content"]]
        self.assertTrue(all(b["type"] != "thinking" for b in assistant_blocks))

    def test_max_turns_then_wrap_up(self):
        self.gw.script = [
            {"blocks": [{"type": "tool_use", "id": "t1", "name": "Bash",
                         "input": {"command": "echo 1"}}], "stop_reason": "tool_use"},
            {"blocks": [{"type": "tool_use", "id": "t2", "name": "Bash",
                         "input": {"command": "echo 2"}}], "stop_reason": "tool_use"},
        ]
        messages, err = collect("loop forever", self.opts(max_turns=2))
        self.assertIsNotNone(err)
        self.assertIn("error_max_turns", str(err))
        result = by_type(messages, ResultMessage)[0]
        self.assertEqual(result.subtype, "error_max_turns")
        self.assertTrue(result.is_error)
        self.assertEqual(result.num_turns, 2)
        session_id = by_type(messages, SystemMessage)[0].data["session_id"]

        # Wrap-up turn: same session, no tools — the runner's exhaustion path.
        self.gw.script = [{"blocks": [{"type": "text", "text": "final answer"}]}]
        wrap, wrap_err = collect(
            "Budget exhausted — reply with plain text.",
            self.opts(max_turns=2, tools=[], resume=session_id))
        self.assertIsNone(wrap_err)
        self.assertEqual(by_type(wrap, ResultMessage)[0].subtype, "success")
        wrap_body = self.gw.requests[-1]
        self.assertNotIn("tools", wrap_body)
        # Resume really carried the previous conversation across.
        self.assertGreater(len(wrap_body["messages"]), 3)
        # Tool-less requests must not replay tool_use/tool_result blocks —
        # strict backends 400 on tool blocks without a tools param.
        wrap_blocks = [b for m in wrap_body["messages"] for b in m["content"]]
        self.assertTrue(all(b["type"] == "text" for b in wrap_blocks))
        self.assertTrue(any("tool call Bash" in b["text"] for b in wrap_blocks))

    def test_resume_continues_transcript(self):
        self.gw.script = [{"blocks": [{"type": "text", "text": "first reply"}]}]
        first, _ = collect("first prompt", self.opts())
        session_id = by_type(first, SystemMessage)[0].data["session_id"]

        self.gw.script = [{"blocks": [{"type": "text", "text": "second reply"}]}]
        second, err = collect("follow-up", self.opts(resume=session_id))
        self.assertIsNone(err)
        self.assertEqual(by_type(second, SystemMessage)[0].data["session_id"], session_id)
        replayed = self.gw.requests[1]["messages"]
        texts = [b.get("text", "") for m in replayed for b in m["content"]]
        self.assertIn("first prompt", " ".join(texts))
        self.assertIn("first reply", " ".join(texts))
        self.assertIn("follow-up", " ".join(texts))

    def test_resume_with_missing_transcript_starts_fresh_same_id(self):
        self.gw.script = [{"blocks": [{"type": "text", "text": "ok"}]}]
        messages, err = collect("hi", self.opts(resume="sess-never-seen"))
        self.assertIsNone(err)
        self.assertEqual(by_type(messages, SystemMessage)[0].data["session_id"],
                         "sess-never-seen")
        self.assertEqual(len(self.gw.requests[0]["messages"]), 1)

    def test_api_error_is_error_during_execution(self):
        self.gw.script = [{"status": 400,
                           "message": "litellm.ContextWindowExceededError: too long"}]
        messages, err = collect("hi", self.opts())
        self.assertIsNotNone(err)
        self.assertIn("returned an error result", str(err))
        result = by_type(messages, ResultMessage)[0]
        self.assertEqual(result.subtype, "error_during_execution")
        self.assertIn("API Error: 400", result.result)
        self.assertIn("ContextWindowExceededError", result.result)

    def test_retryable_500_is_retried(self):
        self.gw.script = [{"status": 500, "message": "transient"},
                          {"blocks": [{"type": "text", "text": "recovered"}]}]
        messages, err = collect("hi", self.opts())
        self.assertIsNone(err)
        self.assertEqual(len(self.gw.requests), 2)
        self.assertEqual(by_type(messages, ResultMessage)[0].subtype, "success")

    def test_utf8_text_survives_the_wire(self):
        text = "89 × 91 = 8099 — größer als Ø?"
        self.gw.script = [{"blocks": [{"type": "text", "text": text}]}]
        messages, err = collect("unicode", self.opts())
        self.assertIsNone(err)
        self.assertEqual(by_type(messages, AssistantMessage)[0].content[0].text, text)

    def test_empty_text_blocks_are_dropped(self):
        self.gw.script = [
            {"blocks": [{"type": "text", "text": ""},
                        {"type": "tool_use", "id": "t1", "name": "Bash",
                         "input": {"command": "echo x"}}], "stop_reason": "tool_use"},
            {"blocks": [{"type": "text", "text": "done"}]},
        ]
        messages, err = collect("hi", self.opts())
        self.assertIsNone(err)
        first = by_type(messages, AssistantMessage)[0]
        self.assertEqual([type(b).__name__ for b in first.content], ["ToolUseBlock"])

    def test_image_read_rides_transcript_and_textified_strips_it(self):
        png = os.path.join(self.cwd, "shot.png")
        with open(png, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
        self.gw.script = [
            {"blocks": [{"type": "tool_use", "id": "t1", "name": "Read",
                         "input": {"file_path": png}}], "stop_reason": "tool_use"},
            {"blocks": [{"type": "tool_use", "id": "t2", "name": "Bash",
                         "input": {"command": "echo x"}}], "stop_reason": "tool_use"},
        ]
        messages, err = collect("look at the image", self.opts(max_turns=2))
        self.assertIsNotNone(err)  # error_max_turns — we only need the requests
        # Second request carries the image tool_result in wire shape.
        second = self.gw.requests[1]["messages"]
        image_results = [b for m in second if m["role"] == "user"
                         for b in m["content"] if b["type"] == "tool_result"
                         and isinstance(b["content"], list)]
        self.assertEqual(image_results[0]["content"][0]["type"], "image")

        # A tool-less wrap-up over the same session must strip the base64.
        self.gw.script = [{"blocks": [{"type": "text", "text": "wrapped"}]}]
        session_id = by_type(messages, SystemMessage)[0].data["session_id"]
        _wrap, wrap_err = collect("final answer please",
                                  self.opts(max_turns=2, tools=[], resume=session_id))
        self.assertIsNone(wrap_err)
        wrap_blocks = [b for m in self.gw.requests[-1]["messages"] for b in m["content"]]
        self.assertTrue(all(b["type"] == "text" for b in wrap_blocks))
        self.assertTrue(any("[image omitted]" in b["text"] for b in wrap_blocks))

    def test_double_encoded_tool_input_unwrapped(self):
        # Seen live: a provider bridge double-encodes the arguments — the
        # input_json parses to a STRING containing the real object.
        self.gw.script = [
            {"blocks": [{"type": "tool_use", "id": "t1", "name": "Bash",
                         "input": '{"command": "echo double-decoded"}'}],
             "stop_reason": "tool_use"},
            {"blocks": [{"type": "text", "text": "done"}]},
        ]
        messages, err = collect("hi", self.opts())
        self.assertIsNone(err)
        results = [b for m in by_type(messages, UserMessage) for b in m.content]
        self.assertFalse(results[0].is_error)
        self.assertIn("double-decoded", results[0].content)

    def test_missing_tool_use_id_minted_consistently(self):
        # A bridge that omits tool_use ids must not desync the transcript:
        # the persisted assistant block and the tool_result must carry the
        # SAME minted id.
        self.gw.script = [
            {"blocks": [{"type": "tool_use", "id": "", "name": "Bash",
                         "input": {"command": "echo x"}}], "stop_reason": "tool_use"},
            {"blocks": [{"type": "text", "text": "done"}]},
        ]
        messages, err = collect("hi", self.opts())
        self.assertIsNone(err)
        second = self.gw.requests[1]["messages"]
        tool_use = [b for m in second if m["role"] == "assistant"
                    for b in m["content"] if b["type"] == "tool_use"][0]
        result = [b for m in second if m["role"] == "user"
                  for b in m["content"] if b["type"] == "tool_result"][0]
        self.assertTrue(tool_use["id"].startswith("toolu_"))
        self.assertEqual(tool_use["id"], result["tool_use_id"])

    def test_unknown_configured_tools_reported_not_advertised(self):
        self.gw.script = [{"blocks": [{"type": "text", "text": "ok"}]}]
        messages, err = collect("hi", self.opts(tools=["Bash", "WebSearch"]))
        self.assertIsNone(err)
        init = by_type(messages, SystemMessage)[0]
        self.assertNotIn("WebSearch", init.data["tools"])
        self.assertEqual(init.data["ignored_tools"], ["WebSearch"])
        advertised = [t["name"] for t in self.gw.requests[0]["tools"]]
        self.assertNotIn("WebSearch", advertised)

    def test_max_tokens_clamped_to_window_headroom(self):
        self.gw.script = [{"blocks": [{"type": "text", "text": "ok"}]}]
        _messages, err = collect("hi", self.opts(context_window=1000))
        self.assertIsNone(err)
        body = self.gw.requests[0]
        # window 1000 minus estimate minus margin — never the raw default.
        self.assertLess(body["max_tokens"], 1000)
        self.assertGreaterEqual(body["max_tokens"], 512)

    def test_unknown_tool_returns_error_result_block(self):
        self.gw.script = [
            {"blocks": [{"type": "tool_use", "id": "tx", "name": "Teleport",
                         "input": {}}], "stop_reason": "tool_use"},
            {"blocks": [{"type": "text", "text": "ok"}]},
        ]
        messages, err = collect("hi", self.opts())
        self.assertIsNone(err)
        block = by_type(messages, UserMessage)[0].content[0]
        self.assertTrue(block.is_error)
        self.assertIn("Unknown tool", block.content)

    def test_extra_tools_are_registered_and_executed(self):
        from devproof_runner.tools import Tool

        async def echo(tool_input, cwd):
            return f"echo:{tool_input.get('text')}", False

        extra = Tool(name="Echo", description="Echo back",
                     input_schema={"type": "object",
                                   "properties": {"text": {"type": "string"}},
                                   "required": ["text"]},
                     executor=echo)
        self.gw.script = [
            {"blocks": [{"type": "tool_use", "id": "toolu_1", "name": "Echo",
                         "input": {"text": "hi"}}], "stop_reason": "tool_use"},
            {"blocks": [{"type": "text", "text": "done"}]},
        ]
        messages, err = collect("go", self.opts(extra_tools=[extra]))
        self.assertIsNone(err)
        init = by_type(messages, SystemMessage)[0]
        self.assertIn("Echo", init.data["tools"])
        results = [b for m in by_type(messages, UserMessage) for b in m.content
                   if isinstance(b, ToolResultBlock)]
        self.assertEqual(results[0].content, "echo:hi")
        self.assertFalse(results[0].is_error)
        # The tool schema rides the API request like any built-in's.
        tool_names = [t["name"] for t in self.gw.requests[0]["tools"]]
        self.assertIn("Echo", tool_names)


if __name__ == "__main__":
    unittest.main()
