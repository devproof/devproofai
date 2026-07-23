"""query(): the agentic loop.

Yields, in order: SystemMessage("init"), then per model turn an
AssistantMessage (text / thinking / tool_use blocks) and — when tools ran — a
UserMessage of ToolResultBlocks, and finally exactly one ResultMessage.
Subtypes: success | error_max_turns (budget spent while the model still wants
tools) | error_during_execution (API failure after retries; detail in
.result). After an is_error result the generator raises ErrorResultError,
matching the error contract session-runner already handles.

Transcript persistence is pair-atomic: an assistant message with tool_use
blocks is only saved together with its tool results, so a crash at any yield
can never persist a dangling tool_use that would poison every later resume.
"""
from __future__ import annotations

import json
import os
import time
import uuid

from . import compact
from .client import MessagesClient
from .errors import APIError, ErrorResultError
from .mcp import McpManager
from .session import SessionStore
from .skills import discover_skills, make_skill_tool, skills_prompt
from .tools import BUILTIN_TOOLS, Tool, select_builtins
from .types import (AgentOptions, AssistantMessage, ResultMessage, SystemMessage,
                    TextBlock, ToolResultBlock, ToolUseBlock, UserMessage)

DEFAULT_MAX_OUTPUT_TOKENS = 8192
# Prompt-side margin (tokens) kept between estimate+max_tokens and the window,
# absorbing the chars/4 estimate's error before a strict backend 400s.
WINDOW_MARGIN_TOKENS = 256
# Minimum patient-retry wait that earns a dedicated model_wait trace marker —
# a single quick retry blip stays out of the transcript.
WAIT_MARKER_MS = 2000


def _max_output_tokens(options: AgentOptions, window: int) -> int:
    if options.max_output_tokens:
        return int(options.max_output_tokens)
    return max(1024, min(DEFAULT_MAX_OUTPUT_TOKENS, window // 4))


def _serialize_assistant(content: list) -> dict:
    """API-shaped assistant message for the transcript. Thinking blocks are
    dropped: reasoning is server-side (llama.cpp --reasoning-budget) and
    replaying unsolicited thinking blocks trips provider validation."""
    blocks = []
    for block in content:
        if isinstance(block, TextBlock) and block.text:
            blocks.append({"type": "text", "text": block.text})
        elif isinstance(block, ToolUseBlock):
            blocks.append({"type": "tool_use", "id": block.id,
                           "name": block.name, "input": block.input})
    if not blocks:
        blocks = [{"type": "text", "text": "(no output)"}]
    return {"role": "assistant", "content": blocks}


def _serialize_results(results: list[ToolResultBlock]) -> dict:
    # list content = structured blocks (e.g. Read's image blocks) — pass
    # through in wire shape; anything else stringifies.
    return {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": r.tool_use_id,
         "content": r.content if isinstance(r.content, (str, list)) else str(r.content),
         **({"is_error": True} if r.is_error else {})}
        for r in results
    ]}


def _textified(messages: list) -> list:
    """History with tool blocks rewritten as plain text, for requests that
    carry NO tools param (wrap-up turn, compaction summary) — strict backends
    reject tool_use/tool_result blocks when the request defines no tools."""
    out = []
    for message in messages:
        content = message.get("content")
        if not isinstance(content, list):
            out.append(message)
            continue
        blocks = []
        for b in content:
            kind = b.get("type") if isinstance(b, dict) else None
            if kind == "tool_use":
                blocks.append({"type": "text", "text":
                    f"[tool call {b.get('name')}: "
                    f"{json.dumps(b.get('input'), default=str)[:500]}]"})
            elif kind == "tool_result":
                raw = b.get("content")
                if isinstance(raw, list) and any(
                        isinstance(x, dict) and x.get("type") == "image" for x in raw):
                    text = "[image omitted]"
                else:
                    text = raw if isinstance(raw, str) else json.dumps(raw, default=str)
                blocks.append({"type": "text", "text": f"[tool result: {text[:1000]}]"})
            else:
                blocks.append(b)
        out.append({"role": message.get("role"), "content": blocks})
    return out


class _Toolbox:
    def __init__(self):
        self.builtin: dict[str, Tool] = {}
        self.mcp: dict[str, tuple] = {}  # qualified -> (server, raw name, api schema)

    def api_tools(self) -> list[dict]:
        return ([t.to_api() for t in self.builtin.values()]
                + [schema for (_s, _r, schema) in self.mcp.values()])

    def names(self) -> list[str]:
        return list(self.builtin) + list(self.mcp)

    async def execute(self, block: ToolUseBlock, cwd: str) -> tuple[str, bool]:
        tool_input = block.input if isinstance(block.input, dict) else {}
        if block.name in self.builtin:
            try:
                return await self.builtin[block.name].executor(tool_input, cwd)
            except Exception as err:  # noqa: BLE001 — a tool bug fails the call, not the turn
                return f"Tool error: {type(err).__name__}: {err}", True
        if block.name in self.mcp:
            server, raw, _schema = self.mcp[block.name]
            return await server.call(raw, tool_input)
        return f"Unknown tool: {block.name}", True


def _cap_result(content, window: int):
    # chars ≈ tokens*4, so `window` chars ≈ a quarter of the window in tokens —
    # one huge tool output cannot instantly overflow a small local-model context.
    # Structured (list) results — image blocks — are size-bounded at the tool.
    if not isinstance(content, str) or len(content) <= window:
        return content
    return content[:window] + f"\n... [tool result truncated at {window} chars]"


async def query(prompt: str, options: AgentOptions):
    start = time.monotonic()
    cwd = options.cwd or os.getcwd()
    window = compact.context_window(options.context_window)
    max_tokens = _max_output_tokens(options, window)
    max_turns = max(int(options.max_turns or 1), 1)

    toolbox = _Toolbox()
    enabled = list(dict.fromkeys(options.tools or []))
    toolbox.builtin = select_builtins(enabled)
    for extra in options.extra_tools or []:
        toolbox.builtin[extra.name] = extra
    ignored_tools = [n for n in enabled if n not in BUILTIN_TOOLS]
    system = options.system_prompt or ""

    # Wrap-up turns run with tools=[] AND mcp_servers={} — nothing to connect.
    mcp = McpManager(options.mcp_servers or {})
    if options.mcp_servers:
        toolbox.mcp = await mcp.start()
        for warning in mcp.warnings:
            print(f"devproof-runner: {warning}", flush=True)

    # Skills need SOME way to act (built-in or MCP tools); gating on built-ins
    # alone would silently drop skills for MCP-only agents.
    if (toolbox.builtin or toolbox.mcp) and options.skills_dir:
        skills = discover_skills(options.skills_dir)
        if skills:
            skill_tool = make_skill_tool(skills)
            toolbox.builtin[skill_tool.name] = skill_tool
            system = system + "\n\n" + skills_prompt(skills) if system else skills_prompt(skills)

    session = SessionStore.load_or_create(options.resume)
    client = MessagesClient(base_url=options.base_url, auth_token=options.auth_token)

    init_data = {"session_id": session.id, "tools": toolbox.names(),
                 "model": options.model}
    if options.resume:
        # False = the transcript did not restore (e.g. pre-dev29 checkpoint):
        # the turn proceeds fresh under the same id, but observably so.
        init_data["resumed"] = session.resumed
    if ignored_tools:
        init_data["ignored_tools"] = ignored_tools
        print(f"devproof-runner: unknown tools ignored: {', '.join(ignored_tools)}",
              flush=True)
    yield SystemMessage("init", init_data)

    messages = session.messages
    api_tools = toolbox.api_tools()

    # Context estimate, tracked incrementally (chars/4): static request parts
    # once, message chars on append, full recount only after compaction.
    static_chars = len(json.dumps({"system": system, "tools": api_tools}, default=str))
    msg_chars = compact.chars_of(messages)

    def append(message: dict) -> None:
        nonlocal msg_chars
        messages.append(message)
        msg_chars += compact.est_chars(message)

    append({"role": "user", "content": [{"type": "text", "text": prompt}]})
    session.save()

    num_turns = 0
    usage_in = 0
    usage_out = 0
    stop_reason: str | None = None
    subtype = "success"
    error_text: str | None = None

    try:
        while True:
            if num_turns >= max_turns:
                subtype = "error_max_turns"
                break

            estimate = (static_chars + msg_chars) // 4
            if compact.should_compact(window, estimate, len(messages)):
                try:
                    summary_resp = await client.create(
                        model=options.model, system="",
                        messages=_textified(messages) + [{"role": "user", "content":
                                              [{"type": "text", "text": compact.SUMMARY_PROMPT}]}],
                        tools=None, max_tokens=max_tokens)
                    summary = "".join(b.text for b in summary_resp.content
                                      if isinstance(b, TextBlock)).strip()
                    messages[:] = compact.compacted_history(summary or "(summary unavailable)")
                    yield SystemMessage("compact_boundary", {"trigger": "auto"})
                except APIError:
                    # Degraded: no summary — drop oldest until the history fits.
                    while len(messages) > 2 and compact.should_compact(
                            window, (static_chars + compact.chars_of(messages)) // 4,
                            len(messages)):
                        messages[:] = compact.drop_oldest(messages)
                    yield SystemMessage("compact_boundary", {"trigger": "auto",
                                                             "degraded": True})
                msg_chars = compact.chars_of(messages)
                session.save()
                estimate = (static_chars + msg_chars) // 4

            # Never ask for more output than the window has room for — the
            # compaction threshold alone leaves less headroom than the default
            # max_tokens on small windows.
            request_max = max(512, min(max_tokens,
                                       window - estimate - WINDOW_MARGIN_TOKENS))

            try:
                resp = await client.create(model=options.model, system=system,
                                           messages=messages if api_tools else _textified(messages),
                                           tools=api_tools or None,
                                           max_tokens=request_max)
            except APIError as err:
                subtype = "error_during_execution"
                error_text = str(err)
                break

            if resp.waited_ms >= WAIT_MARKER_MS:
                # Dedicated trace marker BEFORE the assistant step: the model
                # was deploying/scaling and the call waited (patient retries).
                # wait_ended is monotonic — the consumer stamps the trace row
                # at that offset so the wait is not misread as generation time.
                yield SystemMessage("model_wait", {"waited_ms": resp.waited_ms,
                                                   "wait_ended": resp.wait_ended})

            num_turns += 1
            usage_in += int(resp.usage.get("input_tokens") or 0)
            usage_out += int(resp.usage.get("output_tokens") or 0)
            stop_reason = resp.stop_reason

            content = resp.content
            tool_uses = [b for b in content if isinstance(b, ToolUseBlock)]
            # Mint missing ids BEFORE anything observes the blocks, so the
            # serialized transcript and the tool_result pairing agree.
            for tool_use in tool_uses:
                if not tool_use.id:
                    tool_use.id = f"toolu_{uuid.uuid4().hex[:12]}"

            yield AssistantMessage(content=content, model=resp.model or options.model,
                                   usage=resp.usage)
            append(_serialize_assistant(content))

            if not tool_uses:
                session.save()
                break  # final answer

            results = []
            for tool_use in tool_uses:
                output, is_error = await toolbox.execute(tool_use, cwd)
                results.append(ToolResultBlock(tool_use_id=tool_use.id,
                                               content=_cap_result(output, window),
                                               is_error=is_error))
            append(_serialize_results(results))
            session.save()
            yield UserMessage(content=results)
    finally:
        await client.aclose()
        await mcp.aclose()

    is_error = subtype != "success"
    yield ResultMessage(
        subtype=subtype, num_turns=num_turns, is_error=is_error,
        duration_ms=int((time.monotonic() - start) * 1000),
        usage={"input_tokens": usage_in, "output_tokens": usage_out},
        stop_reason=stop_reason, result=error_text, session_id=session.id,
    )
    if is_error:
        raise ErrorResultError(subtype)
