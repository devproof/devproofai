"""Agent skills: packages of <name>/SKILL.md under options.skills_dir.

Every SKILL.md under the skills dir becomes available. The skill list (name +
description) rides the system prompt; the model loads a skill's full
instructions through the Skill tool.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class SkillInfo:
    name: str
    description: str
    directory: str
    path: str  # SKILL.md


_BLOCK_SCALAR_INDICATORS = (">", ">-", ">+", "|", "|-", "|+")


def parse_frontmatter(text: str) -> dict[str, str]:
    """Minimal YAML frontmatter: leading --- block of single-line key: value
    pairs, plus YAML block scalars (folded '>' and literal '|', with
    optional '-'/'+' chomping indicators, which we treat the same — we
    always strip trailing whitespace off the resulting single string)."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    out: dict[str, str] = {}
    i = 1
    while i < len(lines):
        line = lines[i]
        if line.strip() == "---":
            break
        key, sep, value = line.partition(":")
        if not (sep and key.strip() and not key.startswith((" ", "\t"))):
            i += 1
            continue
        key = key.strip()
        value = value.strip()
        if value in _BLOCK_SCALAR_INDICATORS:
            folded = value[0] == ">"
            block_lines: list[str] = []
            indent = None
            j = i + 1
            while j < len(lines):
                block_line = lines[j]
                if block_line.strip() == "":
                    block_lines.append("")
                    j += 1
                    continue
                stripped = block_line.lstrip(" \t")
                cur_indent = len(block_line) - len(stripped)
                if indent is None:
                    if cur_indent == 0:
                        break
                    indent = cur_indent
                elif cur_indent < indent:
                    break
                block_lines.append(block_line[indent:])
                j += 1
            if folded:
                groups: list[list[str]] = []
                current: list[str] = []
                for block_line in block_lines:
                    if block_line == "":
                        if current:
                            groups.append(current)
                            current = []
                    else:
                        current.append(block_line)
                if current:
                    groups.append(current)
                out[key] = "\n".join(" ".join(g) for g in groups).strip()
            else:
                out[key] = "\n".join(block_lines).strip()
            i = j
            continue
        out[key] = value.strip("'\"")
        i += 1
    return out


def discover_skills(root: str) -> list[SkillInfo]:
    if not os.path.isdir(root):
        return []
    skills = []
    for entry in sorted(os.listdir(root)):
        directory = os.path.join(root, entry)
        path = os.path.join(directory, "SKILL.md")
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                meta = parse_frontmatter(f.read())
        except OSError:
            continue
        skills.append(SkillInfo(
            name=meta.get("name") or entry,
            description=meta.get("description") or "",
            directory=directory, path=path,
        ))
    return skills


def skills_prompt(skills: list[SkillInfo]) -> str:
    lines = [f"- {s.name}: {s.description}".rstrip(": ") for s in skills]
    return ("Available skills — packaged instructions for specific kinds of work. "
            "When a task matches one, call the Skill tool with its name BEFORE "
            "starting, and follow the loaded instructions:\n" + "\n".join(lines))


EVALS_DIR = "evals"
MAX_FILE_CHARS = 30_000


def package_files(skill: SkillInfo) -> list[tuple[str, str, int]]:
    """(relative path, full path, size) of every package file except SKILL.md
    and the evals/ subtree, sorted by relative path."""
    out: list[tuple[str, str, int]] = []
    for root, dirs, names in os.walk(skill.directory):
        dirs[:] = sorted(d for d in dirs if d != EVALS_DIR)
        for n in sorted(names):
            full = os.path.join(root, n)
            if full == skill.path:
                continue
            rel = os.path.relpath(full, skill.directory).replace(os.sep, "/")
            try:
                size = os.path.getsize(full)
            except OSError:
                size = 0
            out.append((rel, full, size))
    return sorted(out)


def _read_text(full: str, rel: str) -> str:
    from .tools.base import is_binary
    with open(full, "rb") as f:
        data = f.read()
    if is_binary(data):
        return f"{rel} is binary ({len(data)} bytes) — use it from disk: {full}"
    text = data.decode("utf-8", "replace")
    if len(text) > MAX_FILE_CHARS:
        text = text[:MAX_FILE_CHARS] + "\n… [truncated — read the rest from disk]"
    return text


def load_skill(skill: SkillInfo) -> str:
    """Lazy loading with an explicit index (user decision 2026-07-17, rev 2):
    SKILL.md plus a listing of the bundled files — content is loaded on demand
    via Skill(skill, path), keeping small context windows usable."""
    body = _read_text(skill.path, "SKILL.md")
    files = package_files(skill)
    listing = "\n".join(f"- {rel} ({size} bytes)" for rel, _full, size in files)
    parts = [f"Base directory for this skill: {skill.directory}", body]
    if listing:
        parts.append(
            "Bundled files (load one with the Skill tool's path parameter when the "
            f"instructions call for it; scripts run from the base directory):\n{listing}")
    return "\n\n".join(parts)


def load_skill_file(skill: SkillInfo, rel: str) -> tuple[str, bool]:
    for cand_rel, full, _size in package_files(skill):
        if cand_rel == rel:
            try:
                return f"--- {skill.name}/{rel} ---\n{_read_text(full, rel)}", False
            except OSError as err:
                return f"Cannot read {rel}: {err}", True
    available = ", ".join(r for r, _f, _s in package_files(skill)) or "(none)"
    return f"No file \"{rel}\" in skill {skill.name}. Available: {available}", True


def make_skill_tool(skills: list[SkillInfo]):
    from .tools.base import Tool

    by_name = {s.name: s for s in skills}

    async def execute(tool_input: dict, cwd: str) -> tuple[str, bool]:
        name = str(tool_input.get("skill") or "").strip()
        skill = by_name.get(name)
        if not skill:
            return f"Unknown skill \"{name}\". Available: {', '.join(by_name) or '(none)'}", True
        rel = str(tool_input.get("path") or "").strip().replace("\\", "/")
        try:
            if rel:
                return load_skill_file(skill, rel)
            return load_skill(skill), False
        except OSError as err:
            return f"Cannot load skill {name}: {err}", True

    return Tool(
        name="Skill",
        description=("Loads a skill's instructions plus an index of its bundled files. "
                     "Invoke it with a name from the available-skills list before doing "
                     "work the skill covers, then follow the returned instructions; pass "
                     "path to load a bundled reference file when the instructions call "
                     "for it."),
        input_schema={
            "type": "object",
            "properties": {
                "skill": {"type": "string", "description": "Name of the skill to load"},
                "path": {"type": "string",
                         "description": "Optional: relative path of one bundled file to load"},
            },
            "required": ["skill"],
        },
        executor=execute,
    )
