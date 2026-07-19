"""Bash tool: run a shell command in the session workspace."""
from __future__ import annotations

import os
import shutil
import subprocess

import anyio

MAX_OUTPUT_CHARS = 30_000
DEFAULT_TIMEOUT_MS = 120_000
MAX_TIMEOUT_MS = 600_000

_SCHEMA = {
    "type": "object",
    "properties": {
        "command": {"type": "string", "description": "The shell command to execute"},
        "timeout": {"type": "number",
                    "description": "Optional timeout in milliseconds (default 120000, max 600000)"},
        "description": {"type": "string",
                        "description": "One short sentence describing what the command does"},
    },
    "required": ["command"],
}


def _shell() -> str:
    return os.environ.get("DEVPROOF_SDK_SHELL") or shutil.which("bash") or "/bin/sh"


def _truncate(text: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[:MAX_OUTPUT_CHARS] + f"\n... [output truncated at {MAX_OUTPUT_CHARS} chars]"


def _run(command: str, timeout_s: float, cwd: str) -> tuple[str, bool]:
    try:
        proc = subprocess.run(
            [_shell(), "-c", command], cwd=cwd, timeout=timeout_s,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            errors="replace",
        )
    except subprocess.TimeoutExpired:
        return f"Command timed out after {timeout_s:.0f}s", True
    except OSError as err:
        return f"Failed to start shell: {err}", True
    out = _truncate(proc.stdout or "")
    if proc.returncode != 0:
        return f"Exit code {proc.returncode}\n{out}".rstrip(), True
    return out if out.strip() else "(no output)", False


async def _execute(tool_input: dict, cwd: str) -> tuple[str, bool]:
    command = str(tool_input.get("command") or "").strip()
    if not command:
        return "command is required", True
    timeout_ms = tool_input.get("timeout") or DEFAULT_TIMEOUT_MS
    try:
        timeout_s = min(float(timeout_ms), MAX_TIMEOUT_MS) / 1000
    except (TypeError, ValueError):
        timeout_s = DEFAULT_TIMEOUT_MS / 1000
    return await anyio.to_thread.run_sync(_run, command, timeout_s, cwd)


def _make():
    from .base import Tool
    return Tool(
        name="Bash",
        description=(
            "Executes a shell command in the session workspace and returns its "
            "combined stdout/stderr. Use for running programs (including python), "
            "installing packages, and inspecting the environment. Output is "
            "truncated at 30000 characters."),
        input_schema=_SCHEMA,
        executor=_execute,
    )


BASH_TOOL = _make()
