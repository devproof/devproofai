"""Shared test plumbing: env sandboxing and query collection."""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from devproof_runner import ErrorResultError, query  # noqa: E402

ENV_KEYS = [
    "DEVPROOF_BASE_URL", "DEVPROOF_AUTH_TOKEN", "DEVPROOF_CUSTOM_HEADERS",
    "DEVPROOF_SDK_HOME", "DEVPROOF_SDK_SHELL",
    "DEVPROOF_SDK_READ_TIMEOUT", "DEVPROOF_MAX_OUTPUT_TOKENS",
    "DEVPROOF_CONTEXT_WINDOW",
    "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
    "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy",
]


class EnvSandbox:
    """Isolates the env vars the loop reads; gives each test a fresh session home."""

    def __enter__(self):
        self._saved = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)
        self.home = tempfile.mkdtemp(prefix="devproof-runner-test-")
        os.environ["DEVPROOF_SDK_HOME"] = self.home
        return self

    def __exit__(self, *exc):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return False


def collect(prompt, options):
    """Drain query() into a list; returns (messages, error_or_None)."""
    async def go():
        out, err = [], None
        try:
            async for message in query(prompt, options):
                out.append(message)
        except ErrorResultError as e:
            err = e
        return out, err
    return asyncio.run(go())


def by_type(messages, cls):
    return [m for m in messages if isinstance(m, cls)]


def run_tool(tool, tool_input, cwd):
    return asyncio.run(tool.executor(tool_input, cwd))
