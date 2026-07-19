"""Session transcript store: one JSON file per session under
$DEVPROOF_SDK_HOME/sessions (default ~/.devproof/sessions). The runner's
checkpoint tarball captures that directory, which is what makes `resume`
survive pod death.
"""
from __future__ import annotations

import json
import os
import uuid

_ID_SAFE = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")


def sessions_dir() -> str:
    home = os.environ.get("DEVPROOF_SDK_HOME") or os.path.join(os.path.expanduser("~"), ".devproof")
    return os.path.join(home, "sessions")


class SessionStore:
    def __init__(self, session_id: str, messages: list, resumed: bool = False):
        self.id = session_id
        self.messages = messages
        # True only when a resume id actually restored a transcript — callers
        # surface the difference (a pre-dev29 checkpoint resumes empty).
        self.resumed = resumed

    @classmethod
    def load_or_create(cls, resume: str | None) -> "SessionStore":
        if resume:
            safe = "".join(c for c in resume if c in _ID_SAFE)
            path = os.path.join(sessions_dir(), f"{safe}.json")
            if os.path.isfile(path):
                try:
                    with open(path, encoding="utf-8") as f:
                        doc = json.load(f)
                    return cls(safe, list(doc.get("messages") or []), resumed=True)
                except (OSError, json.JSONDecodeError):
                    pass
            # Missing/corrupt transcript (e.g. checkpoint didn't restore):
            # start fresh under the SAME id so the platform's resume chain
            # stays intact instead of failing the turn.
            return cls(safe or uuid.uuid4().hex, [])
        return cls(uuid.uuid4().hex, [])

    def save(self) -> None:
        os.makedirs(sessions_dir(), exist_ok=True)
        path = os.path.join(sessions_dir(), f"{self.id}.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"id": self.id, "messages": self.messages}, f)
        os.replace(tmp, path)
