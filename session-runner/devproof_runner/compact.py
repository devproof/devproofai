"""Client-side auto-compaction.

The context window comes from options.context_window or the
DEVPROOF_CONTEXT_WINDOW env var the control plane renders into session pods;
when neither is set a conservative default applies so long sessions on
large-context models still compact instead of eventually overflowing the
provider limit. Usage is estimated as serialized-request-chars / 4 — the same
rule the gateway's prompt-estimate hook uses — tracked incrementally by the
query loop (recomputing over the full history every step is O(n) per step for
nothing; only appends and compaction change it).
"""
from __future__ import annotations

import json
import os

COMPACT_THRESHOLD = 0.8
# No window configured ⇒ assume the platform's local-model context cap
# (operator transform.MaxContextTokens). The control plane normally always
# renders DEVPROOF_CONTEXT_WINDOW; if it is ever missing, a SMALL default makes
# a long turn compact early instead of overflowing a 32k local model at ~160k
# (a large frontier default would silently never compact on this platform).
DEFAULT_WINDOW_TOKENS = 32_768
SUMMARY_PROMPT = (
    "Context is nearly full — summarize this conversation so work can continue "
    "in a fresh context. Capture: the original task and constraints; everything "
    "completed so far (files created or changed, with paths); key findings and "
    "decisions; what remains to be done and the exact next step. Reply with the "
    "summary only."
)


def context_window(option_value: int | None) -> int:
    if option_value:
        return int(option_value)
    raw = os.environ.get("DEVPROOF_CONTEXT_WINDOW", "")
    if raw.isdigit() and int(raw) > 0:
        return int(raw)
    return DEFAULT_WINDOW_TOKENS


# Flat cost per image block: vision tokens scale with pixels, not base64
# length — counting the base64 as chars/4 would overestimate a single photo
# as hundreds of k tokens and trigger a permanent compaction loop.
IMAGE_FLAT_CHARS = 6400  # ≈1600 tokens, a provider's max-image ballpark


def est_chars(message: dict) -> int:
    content = message.get("content")
    if not isinstance(content, list):
        return len(json.dumps(message, default=str))
    total = 32  # envelope overhead
    for block in content:
        inner = block.get("content") if isinstance(block, dict) else None
        if isinstance(inner, list) and any(
                isinstance(b, dict) and b.get("type") == "image" for b in inner):
            non_image = [b for b in inner
                         if not (isinstance(b, dict) and b.get("type") == "image")]
            images = len(inner) - len(non_image)
            total += images * IMAGE_FLAT_CHARS + len(json.dumps(non_image, default=str))
        else:
            total += len(json.dumps(block, default=str))
    return total


def chars_of(messages: list) -> int:
    return sum(est_chars(m) for m in messages)


def should_compact(window: int, estimated_tokens: int, message_count: int) -> bool:
    if message_count < 3:
        return False
    return estimated_tokens > window * COMPACT_THRESHOLD


def compacted_history(summary: str) -> list:
    return [{"role": "user", "content": [{"type": "text", "text":
        "Continuing an in-progress session; earlier context was compacted. "
        f"Summary of the work so far:\n\n{summary}\n\nContinue the task from here."}]}]


def _plain_user(message: dict) -> bool:
    """True for a user message with no tool_result blocks — the only valid
    transcript head (the history is exclusively self-produced, so content is
    always a list of typed dicts)."""
    if message.get("role") != "user":
        return False
    content = message.get("content")
    if not isinstance(content, list):
        return True
    return all(not (isinstance(b, dict) and b.get("type") == "tool_result")
               for b in content)


def drop_oldest(messages: list) -> list:
    """Fallback when the summarization call itself fails: drop the older half,
    re-aligned so history still starts on a plain user message (a leading
    tool_result without its tool_use is an invalid transcript)."""
    keep = messages[len(messages) // 2:]
    while keep and not _plain_user(keep[0]):
        keep.pop(0)
    note = {"role": "user", "content": [{"type": "text", "text":
        "[Earlier conversation history was dropped to fit the context window.]"}]}
    return [note] + keep
