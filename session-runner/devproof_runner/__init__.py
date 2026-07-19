"""Devproof runner loop — in-process agentic loop against the Devproof gateway.
Implements exactly the surface the Devproof platform uses: query(),
AgentOptions, built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebFetch),
remote MCP servers, skills, resume, and client-side auto-compaction.
Clean-room implementation."""
from .errors import APIError, ErrorResultError
from .query import query
from .types import AgentOptions

__version__ = "0.1.0"
__all__ = ["query", "AgentOptions", "APIError", "ErrorResultError", "__version__"]
