"""Read / Write / Edit tools."""
from __future__ import annotations

import os

from .base import Tool, is_binary, resolve_path as _resolve, threaded as _async

MAX_LINES = 2000
MAX_LINE_CHARS = 2000
# Image files are returned as viewable base64 image blocks (vision models).
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
               ".gif": "image/gif", ".webp": "image/webp"}
MAX_IMAGE_BYTES = 3 * 1024 * 1024


def _read(tool_input: dict, cwd: str) -> tuple[str, bool]:
    path = _resolve(str(tool_input.get("file_path") or ""), cwd)
    if not path.strip():
        return "file_path is required", True
    if not os.path.exists(path):
        return f"File not found: {path}", True
    if os.path.isdir(path):
        return f"{path} is a directory", True
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError as err:
        return f"Cannot read {path}: {err}", True
    media_type = IMAGE_TYPES.get(os.path.splitext(path)[1].lower())
    if media_type:
        if len(data) > MAX_IMAGE_BYTES:
            return (f"{path} is {len(data)} bytes — too large to view "
                    f"(max {MAX_IMAGE_BYTES}); resize/compress it first."), True
        import base64
        return [{"type": "image", "source": {
            "type": "base64", "media_type": media_type,
            "data": base64.b64encode(data).decode()}}], False
    if is_binary(data):
        return (f"{path} is a binary file ({len(data)} bytes) — Read only supports "
                "text and images; check it with shell tools (file, ls -la) instead."), True
    text = data.decode("utf-8", "replace")
    offset = max(int(tool_input.get("offset") or 0), 0)
    limit = int(tool_input.get("limit") or MAX_LINES)
    lines = text.splitlines()
    if offset >= len(lines) and lines:
        return f"offset {offset} is past the end of the file ({len(lines)} lines)", True
    window = lines[offset:offset + limit]
    numbered = []
    for i, line in enumerate(window, start=offset + 1):
        if len(line) > MAX_LINE_CHARS:
            line = line[:MAX_LINE_CHARS] + "… [line truncated]"
        numbered.append(f"{i}\t{line}")
    body = "\n".join(numbered) if numbered else "(empty file)"
    if offset + limit < len(lines):
        body += f"\n... [{len(lines) - offset - limit} more lines — use offset/limit to read further]"
    return body, False


def _write(tool_input: dict, cwd: str) -> tuple[str, bool]:
    path = _resolve(str(tool_input.get("file_path") or ""), cwd)
    content = tool_input.get("content")
    if not path.strip():
        return "file_path is required", True
    if not isinstance(content, str):
        return "content must be a string", True
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(content)
    except OSError as err:
        return f"Cannot write {path}: {err}", True
    return f"Wrote {len(content.encode('utf-8'))} bytes to {path}", False


def _edit(tool_input: dict, cwd: str) -> tuple[str, bool]:
    path = _resolve(str(tool_input.get("file_path") or ""), cwd)
    old = tool_input.get("old_string")
    new = tool_input.get("new_string")
    replace_all = bool(tool_input.get("replace_all"))
    if not isinstance(old, str) or not isinstance(new, str):
        return "old_string and new_string are required", True
    if old == new:
        return "old_string and new_string must differ", True
    if not old:
        return "old_string must not be empty", True
    if not os.path.isfile(path):
        return f"File not found: {path}", True
    try:
        with open(path, encoding="utf-8", errors="replace", newline="") as f:
            text = f.read()
    except OSError as err:
        return f"Cannot read {path}: {err}", True
    count = text.count(old)
    if count == 0:
        return "old_string not found in file — it must match exactly, including whitespace", True
    if count > 1 and not replace_all:
        return (f"old_string occurs {count} times — add more surrounding context to make it "
                "unique, or set replace_all"), True
    updated = text.replace(old, new) if replace_all else text.replace(old, new, 1)
    try:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(updated)
    except OSError as err:
        return f"Cannot write {path}: {err}", True
    return f"Replaced {count if replace_all else 1} occurrence(s) in {path}", False


READ_TOOL = Tool(
    name="Read",
    description=(
        "Reads a file from the filesystem. Text files return numbered lines "
        "(line-number, tab, content; up to 2000 lines by default — pass offset "
        "and limit for large files). Image files (png/jpg/gif/webp) are "
        "returned as a viewable image on vision-capable models."),
    input_schema={
        "type": "object",
        "properties": {
            "file_path": {"type": "string", "description": "Absolute path of the file to read"},
            "offset": {"type": "number", "description": "0-based line to start reading from"},
            "limit": {"type": "number", "description": "Maximum number of lines to read"},
        },
        "required": ["file_path"],
    },
    executor=_async(_read),
)

WRITE_TOOL = Tool(
    name="Write",
    description=("Writes content to a file, creating parent directories as needed and "
                 "overwriting any existing file."),
    input_schema={
        "type": "object",
        "properties": {
            "file_path": {"type": "string", "description": "Absolute path of the file to write"},
            "content": {"type": "string", "description": "Full content to write"},
        },
        "required": ["file_path", "content"],
    },
    executor=_async(_write),
)

EDIT_TOOL = Tool(
    name="Edit",
    description=(
        "Replaces an exact string in a file. old_string must match the file exactly "
        "(including whitespace) and be unique unless replace_all is set."),
    input_schema={
        "type": "object",
        "properties": {
            "file_path": {"type": "string", "description": "Absolute path of the file to modify"},
            "old_string": {"type": "string", "description": "Exact text to replace"},
            "new_string": {"type": "string", "description": "Replacement text"},
            "replace_all": {"type": "boolean", "description": "Replace every occurrence (default false)"},
        },
        "required": ["file_path", "old_string", "new_string"],
    },
    executor=_async(_edit),
)
