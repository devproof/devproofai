"""Glob / Grep tools."""
from __future__ import annotations

import fnmatch
import os
import re
import threading

from .base import Tool, is_binary, resolve_path, threaded as _async

MAX_RESULTS = 100
MAX_FILE_BYTES = 10 * 1024 * 1024
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv"}
GREP_TIMEOUT_SEC = 120  # bound catastrophic regex backtracking / huge trees


def _walk_files(root: str):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            yield os.path.join(dirpath, name)


def _glob(tool_input: dict, cwd: str) -> tuple[str, bool]:
    pattern = str(tool_input.get("pattern") or "").strip()
    if not pattern:
        return "pattern is required", True
    root = resolve_path(str(tool_input.get("path") or cwd), cwd)
    if not os.path.isdir(root):
        return f"Not a directory: {root}", True
    norm = pattern.replace("\\", "/")
    matches = []
    for full in _walk_files(root):
        rel = os.path.relpath(full, root).replace(os.sep, "/")
        # "**/*.py" should also match top-level files, like ripgrep/fast-glob do.
        if fnmatch.fnmatch(rel, norm) or (
                norm.startswith("**/") and fnmatch.fnmatch(rel, norm[3:])):
            matches.append(full)
    matches.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    if not matches:
        return "No files found", False
    clipped = matches[:MAX_RESULTS]
    body = "\n".join(clipped)
    if len(matches) > MAX_RESULTS:
        body += f"\n... [{len(matches) - MAX_RESULTS} more matches not shown]"
    return body, False


def _grep(tool_input: dict, cwd: str) -> tuple[str, bool]:
    pattern = str(tool_input.get("pattern") or "")
    if not pattern:
        return "pattern is required", True
    flags = re.IGNORECASE if tool_input.get("case_insensitive") else 0
    try:
        rx = re.compile(pattern, flags)
    except re.error as err:
        return f"Invalid regex: {err}", True
    target = resolve_path(str(tool_input.get("path") or cwd), cwd)
    file_glob = str(tool_input.get("glob") or "")
    mode = str(tool_input.get("output_mode") or "files_with_matches")
    files = [target] if os.path.isfile(target) else list(_walk_files(target))

    def _scan() -> tuple[str, bool]:
        lines_out: list[str] = []
        matched_files: list[str] = []
        counts: list[str] = []
        for path in files:
            if file_glob and not fnmatch.fnmatch(os.path.basename(path), file_glob):
                continue
            try:
                if os.path.getsize(path) > MAX_FILE_BYTES:
                    continue
                with open(path, "rb") as f:
                    data = f.read()
            except OSError:
                continue
            if is_binary(data):
                continue
            text = data.decode("utf-8", "replace")
            hits = 0
            for lineno, line in enumerate(text.splitlines(), start=1):
                if rx.search(line):
                    hits += 1
                    if mode == "content" and len(lines_out) < MAX_RESULTS:
                        lines_out.append(f"{path}:{lineno}:{line[:500]}")
                    elif mode == "files_with_matches":
                        break  # first hit is all this mode needs from the file
            if hits:
                matched_files.append(path)
                counts.append(f"{path}:{hits}")
            if mode != "content" and len(matched_files) >= MAX_RESULTS:
                break
        if mode == "content":
            return ("\n".join(lines_out) or "No matches found"), False
        if mode == "count":
            return ("\n".join(counts) or "No matches found"), False
        return ("\n".join(matched_files) or "No matches found"), False

    # re.search can't be interrupted, so run the scan in a daemon thread and
    # abandon it if it blows past the deadline (catastrophic backtracking on a
    # model-supplied pattern, or an enormous tree). The daemon thread won't hold
    # up process exit.
    box: dict[str, tuple[str, bool]] = {}
    worker = threading.Thread(target=lambda: box.__setitem__("r", _scan()), daemon=True)
    worker.start()
    worker.join(GREP_TIMEOUT_SEC)
    if worker.is_alive():
        return (f"Grep aborted after {GREP_TIMEOUT_SEC}s — the pattern is too expensive "
                f"(possible catastrophic backtracking); simplify it or narrow the path."), True
    return box["r"]


GLOB_TOOL = Tool(
    name="Glob",
    description=("Finds files whose relative path matches a glob pattern (e.g. \"**/*.py\" "
                 "or \"src/*.ts\"), newest first."),
    input_schema={
        "type": "object",
        "properties": {
            "pattern": {"type": "string", "description": "Glob pattern to match file paths against"},
            "path": {"type": "string", "description": "Directory to search (default: workspace)"},
        },
        "required": ["pattern"],
    },
    executor=_async(_glob),
)

GREP_TOOL = Tool(
    name="Grep",
    description=("Searches file contents with a regular expression. output_mode: "
                 "\"files_with_matches\" (default) lists matching files, \"content\" shows "
                 "matching lines as path:line:text, \"count\" shows per-file match counts."),
    input_schema={
        "type": "object",
        "properties": {
            "pattern": {"type": "string", "description": "Regular expression to search for"},
            "path": {"type": "string", "description": "File or directory to search (default: workspace)"},
            "glob": {"type": "string", "description": "Only search files whose name matches this glob (e.g. \"*.py\")"},
            "output_mode": {"type": "string",
                            "description": "files_with_matches (default), content, or count"},
            "case_insensitive": {"type": "boolean", "description": "Case-insensitive search"},
        },
        "required": ["pattern"],
    },
    executor=_async(_grep),
)
