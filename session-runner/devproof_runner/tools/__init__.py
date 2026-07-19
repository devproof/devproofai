"""Built-in tool registry. Every schema is GBNF-friendly by construction —
plain types, no regex `pattern`, no large `maxLength` — so llama.cpp grammar
compilation never needs a gateway-side sanitizer for session traffic.
"""
from __future__ import annotations

from .base import Tool
from .bash import BASH_TOOL
from .files import EDIT_TOOL, READ_TOOL, WRITE_TOOL
from .search import GLOB_TOOL, GREP_TOOL
from .webfetch import WEBFETCH_TOOL

BUILTIN_TOOLS: dict[str, Tool] = {
    t.name: t
    for t in (BASH_TOOL, READ_TOOL, WRITE_TOOL, EDIT_TOOL, GLOB_TOOL, GREP_TOOL, WEBFETCH_TOOL)
}


def select_builtins(names: list[str]) -> dict[str, Tool]:
    """Enabled built-ins = configured names that we implement; unknown names
    are ignored (an agent config may list tools a future runner adds)."""
    return {n: BUILTIN_TOOLS[n] for n in names if n in BUILTIN_TOOLS}

__all__ = ["Tool", "BUILTIN_TOOLS", "select_builtins"]
