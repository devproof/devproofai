"""Message and option types for the Devproof runner loop.

Block classes mirror the WIRE format the gateway serves on /v1/messages
(text / thinking / tool_use / tool_result content blocks) — that vocabulary is
the protocol, not ours. The options and message envelope are Devproof's own.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class TextBlock:
    text: str


@dataclass
class ThinkingBlock:
    thinking: str
    signature: str = ""


@dataclass
class ToolUseBlock:
    id: str
    name: str
    input: dict


@dataclass
class ToolResultBlock:
    tool_use_id: str
    content: Any = None  # str, or list of content dicts
    is_error: bool = False


@dataclass
class SystemMessage:
    """Out-of-band loop events. subtype "init" carries
    {"session_id", "tools", "model"}; "compact_boundary" marks auto-compaction."""
    subtype: str
    data: dict = field(default_factory=dict)


@dataclass
class AssistantMessage:
    content: list
    model: str = ""
    usage: dict = field(default_factory=dict)


@dataclass
class UserMessage:
    content: Any  # list of blocks (tool results) or plain str


@dataclass
class ResultMessage:
    """Terminal message of a query. subtype: success | error_max_turns |
    error_during_execution. `result` carries the error detail on failures."""
    subtype: str
    num_turns: int
    is_error: bool
    duration_ms: int
    usage: dict = field(default_factory=dict)
    stop_reason: str | None = None
    result: str | None = None
    session_id: str = ""


@dataclass
class AgentOptions:
    """Options for query(). There is no permission model — the session pod IS
    the sandbox; every configured tool is allowed."""
    model: str
    system_prompt: str = ""
    tools: list = field(default_factory=list)      # enabled built-in tool names
    max_turns: int = 100
    resume: str | None = None                      # session id to continue
    cwd: str | None = None                         # tool workspace
    mcp_servers: dict = field(default_factory=dict)
    skills_dir: str | None = None                  # dir of <skill>/SKILL.md packages
    # Fully-formed Tool instances injected by the caller (e.g. the session
    # runner's Delegate tool) — merged into the toolbox alongside built-ins.
    extra_tools: list = field(default_factory=list)
    # All optional; env fallbacks keep the runner thin.
    context_window: int | None = None      # tokens; else DEVPROOF_CONTEXT_WINDOW
    max_output_tokens: int | None = None   # else derived from context_window
    base_url: str | None = None            # else DEVPROOF_BASE_URL
    auth_token: str | None = None          # else DEVPROOF_AUTH_TOKEN
