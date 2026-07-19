"""Devproof AI Python client — public API (/api/*) through the gateway.

Mirrors the Anthropic SDK's design (resource namespaces, env-var fallbacks,
typed errors) over Devproof-native wire shapes. Model inference is NOT here:
point the official `anthropic` package at the same base URL
(ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN=dpk_...).

Usage:
    from devproof import Devproof
    client = Devproof()  # DEVPROOF_BASE_URL, DEVPROOF_API_KEY
    rec = client.files.upload("report.pdf")
    for event in client.sessions.events.stream(session["id"]):
        print(event["type"])
"""
from __future__ import annotations

import os

from ._http import HttpClient
from .errors import (APIConnectionError, APIStatusError, AuthenticationError, BadRequestError,
                     ConflictError, DevproofError, NotFoundError, PermissionDeniedError, RateLimitError)
from .resources import Agents, Environments, Files, McpRegistry, MemoryStores, Sessions, Skills, Vaults, Wikis

__all__ = [
    "Devproof", "DevproofError", "APIConnectionError", "APIStatusError",
    "BadRequestError", "AuthenticationError", "PermissionDeniedError",
    "NotFoundError", "ConflictError", "RateLimitError",
]


class Devproof:
    def __init__(self, base_url: str | None = None, api_key: str | None = None,
                 timeout: float = 60.0, max_retries: int = 2):
        base_url = base_url or os.environ.get("DEVPROOF_BASE_URL", "http://localhost:14000")
        api_key = api_key or os.environ.get("DEVPROOF_API_KEY")
        if not api_key:
            raise DevproofError("api_key required (or set DEVPROOF_API_KEY)")
        http = HttpClient(base_url, api_key, timeout=timeout, max_retries=max_retries)
        self.files = Files(http)
        self.skills = Skills(http)
        self.memory_stores = MemoryStores(http)
        self.wikis = Wikis(http)
        self.vaults = Vaults(http)
        self.environments = Environments(http)
        self.agents = Agents(http)
        self.sessions = Sessions(http)
        self.mcp_registry = McpRegistry(http)
