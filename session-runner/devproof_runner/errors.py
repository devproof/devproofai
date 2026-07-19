"""Error types. ErrorResultError's message intentionally contains the phrase
"returned an error result: <subtype>" — the session runner's failure_detail()
keys on that substring to prefer the turn's real error text."""
from __future__ import annotations


class APIError(Exception):
    def __init__(self, message: str, status: int | None = None, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class ErrorResultError(Exception):
    """Raised after query() yields an is_error ResultMessage, mirroring the
    predecessor runtime's behaviour so existing error handling keeps working."""
    def __init__(self, subtype: str):
        super().__init__(f"Devproof agent returned an error result: {subtype}")
        self.subtype = subtype
