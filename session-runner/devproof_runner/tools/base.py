from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Awaitable, Callable

import anyio


@dataclass
class Tool:
    name: str
    description: str
    input_schema: dict
    # executor(input, cwd) -> (output_text, is_error)
    executor: Callable[[dict, str], Awaitable[tuple[str, bool]]]

    def to_api(self) -> dict:
        return {"name": self.name, "description": self.description,
                "input_schema": self.input_schema}


def resolve_path(path: str, cwd: str) -> str:
    return path if os.path.isabs(path) else os.path.join(cwd, path)


def is_binary(data: bytes) -> bool:
    return b"\x00" in data[:8192]


def threaded(fn):
    """Wrap a sync executor(fn(input, cwd)) as the async executor Tool expects."""
    async def run(tool_input: dict, cwd: str) -> tuple[str, bool]:
        return await anyio.to_thread.run_sync(fn, tool_input, cwd)
    return run
