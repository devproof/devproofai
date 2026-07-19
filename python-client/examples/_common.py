"""Shared setup for the public-API example scripts."""
from __future__ import annotations

import sys
from pathlib import Path

# Allow running straight from the repo without pip-installing the client.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from devproof import Devproof  # noqa: E402


def client() -> Devproof:
    return Devproof()  # DEVPROOF_BASE_URL (default http://localhost:14000), DEVPROOF_API_KEY


def step(msg: str) -> None:
    print(f"==> {msg}", flush=True)


def check(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        raise SystemExit(1)
    print(f"    ok: {msg}")
