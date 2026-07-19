"""Typed exceptions, mirroring the Anthropic SDK's error design."""
from __future__ import annotations

from typing import Any


class DevproofError(Exception):
    """Base for all devproof client errors."""


class APIConnectionError(DevproofError):
    """Network-level failure before an HTTP response arrived."""


class APIStatusError(DevproofError):
    """Non-2xx HTTP response."""

    def __init__(self, status_code: int, body: Any):
        self.status_code = status_code
        self.body = body
        message = body.get("error") if isinstance(body, dict) else str(body)
        super().__init__(f"HTTP {status_code}: {message}")


class BadRequestError(APIStatusError):
    """400 — invalid or missing request fields."""


class AuthenticationError(APIStatusError):
    """401 — missing/invalid dpk_ API key."""


class PermissionDeniedError(APIStatusError):
    """403 — key not allowed (e.g. routing-only external keys)."""


class NotFoundError(APIStatusError):
    """404 — no such resource."""


class ConflictError(APIStatusError):
    """409 — e.g. agent disabled, session not idle, environment in use."""


class RateLimitError(APIStatusError):
    """429 — retried automatically before this is raised."""


ERROR_BY_STATUS = {400: BadRequestError, 401: AuthenticationError, 403: PermissionDeniedError,
                   404: NotFoundError, 409: ConflictError, 429: RateLimitError}
