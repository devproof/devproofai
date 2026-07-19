"""Resource namespaces over the Devproof public API (/api/*)."""
from __future__ import annotations

import hashlib
import os
import time
from pathlib import Path
from typing import Any, Callable, Iterator

from ._http import HttpClient
from .errors import APIConnectionError

CHUNK_THRESHOLD = 32 * 1024 * 1024  # server PART_SIZE — files above this go chunked

Progress = Callable[[int, int], None]  # (bytes_done, bytes_total)


class Files:
    def __init__(self, http: HttpClient):
        self._h = http

    def upload(self, path: str | Path, *, kind: str | None = None, on_progress: Progress | None = None) -> dict:
        path = Path(path)
        size = path.stat().st_size
        if size <= CHUNK_THRESHOLD:
            with path.open("rb") as f:
                params = {"kind": kind} if kind else {}
                rec = self._h.json("POST", "/api/files", params=params, files={"file": (path.name, f)})
            if on_progress:
                on_progress(size, size)
            return rec
        return self._upload_chunked(path, size, kind=kind, on_progress=on_progress)

    def _upload_chunked(self, path: Path, size: int, *, kind: str | None, on_progress: Progress | None) -> dict:
        up = self._h.json("POST", "/api/files/uploads", json={"name": path.name, **({"kind": kind} if kind else {})})
        part_size = up["part_size"]
        part_hashes: list[str] = []
        done = 0
        try:
            with path.open("rb") as f:
                n = 0
                while chunk := f.read(part_size):
                    n += 1
                    self._h.json("POST", f"/api/files/uploads/{up['upload_id']}/parts/{n}",
                                 files={"file": (f"part{n}", chunk)})
                    part_hashes.append(hashlib.sha256(chunk).hexdigest())
                    done += len(chunk)
                    if on_progress:
                        on_progress(done, size)
            rec = self._h.json("POST", f"/api/files/uploads/{up['upload_id']}/complete", json={})
        except BaseException:
            # Abort the server-side multipart upload so MinIO parts are freed
            # now instead of by the 24h stale-upload sweep.
            try:
                self._h.request("DELETE", f"/api/files/uploads/{up['upload_id']}")
            except Exception:
                pass
            raise
        composite = hashlib.sha256("".join(part_hashes).encode()).hexdigest()
        if rec["sha256"] != composite:
            raise RuntimeError(f"composite hash mismatch: server {rec['sha256']} != client {composite}")
        return rec

    def list(self, *, kind: str | None = None) -> Iterator[dict]:
        return self._h.paginate("/api/files", "files", {"kind": kind} if kind else None)

    def retrieve(self, file_id: str) -> dict:
        return self._h.json("GET", f"/api/files/{file_id}")

    def download(self, file_id: str, dest: str | Path, *, on_progress: Progress | None = None) -> Path:
        dest = Path(dest)
        total = int(self.retrieve(file_id).get("size") or 0)
        done = 0
        with self._h.stream("POST", f"/api/files/{file_id}/content", json={"stream": True}, timeout=None) as resp:
            with dest.open("wb") as f:
                for chunk in resp.iter_bytes():
                    f.write(chunk)
                    done += len(chunk)
                    if on_progress:
                        on_progress(done, total)
        return dest

    def delete(self, file_id: str) -> None:
        self._h.request("DELETE", f"/api/files/{file_id}")


class Skills:
    def __init__(self, http: HttpClient):
        self._h = http

    def upload(self, path: str | Path, *, name: str | None = None) -> dict:
        path = Path(path)
        with path.open("rb") as f:
            params = {"name": name} if name else {}
            return self._h.json("POST", "/api/skills", params=params, files={"file": (path.name, f)})

    def list(self) -> Iterator[dict]:
        return self._h.paginate("/api/skills", "skills")

    def retrieve(self, skill_id: str) -> dict:
        return self._h.json("GET", f"/api/skills/{skill_id}")["skill"]

    def delete(self, skill_id: str) -> None:
        self._h.request("DELETE", f"/api/skills/{skill_id}")


class _MemoryEntries:
    def __init__(self, http: HttpClient):
        self._h = http

    def add(self, store_id: str, path: str, content: bytes) -> dict:
        return self._h.json("POST", f"/api/memory-stores/{store_id}/entries",
                            params={"path": path}, files={"file": (os.path.basename(path) or "entry", content)})

    def delete(self, store_id: str, path: str) -> None:
        self._h.request("DELETE", f"/api/memory-stores/{store_id}/entries", params={"path": path})


class MemoryStores:
    def __init__(self, http: HttpClient):
        self._h = http
        self.entries = _MemoryEntries(http)

    def create(self, *, name: str) -> dict:
        return self._h.json("POST", "/api/memory-stores", json={"name": name})

    def list(self) -> Iterator[dict]:
        return self._h.paginate("/api/memory-stores", "stores")

    def tree(self, store_id: str) -> list[dict]:
        return self._h.json("GET", f"/api/memory-stores/{store_id}/tree")["entries"]

    def content(self, store_id: str, path: str) -> bytes:
        return self._h.request("GET", f"/api/memory-stores/{store_id}/content", params={"path": path}).content

    def delete(self, store_id: str) -> None:
        self._h.request("DELETE", f"/api/memory-stores/{store_id}")


class _WikiPages:
    def __init__(self, http: HttpClient):
        self._h = http

    def add(self, wiki_id: str, path: str, content: bytes) -> dict:
        return self._h.json("POST", f"/api/wikis/{wiki_id}/entries",
                            params={"path": path}, files={"file": (os.path.basename(path) or "page", content)})

    def delete(self, wiki_id: str, path: str) -> None:
        self._h.request("DELETE", f"/api/wikis/{wiki_id}/entries", params={"path": path})


class Wikis:
    """LLM wikis (spec 2026-07-18): hierarchical, read-index-first knowledge
    bases attached to agents (read for many, write for one — see Agents.create's
    `wiki_refs`). Structure is a hardcoded platform convention, so there is no
    per-wiki config beyond name/description."""

    def __init__(self, http: HttpClient):
        self._h = http
        self.pages = _WikiPages(http)

    def create(self, *, name: str, description: str | None = None) -> dict:
        return self._h.json("POST", "/api/wikis",
                            json={"name": name, **({"description": description} if description is not None else {})})

    def list(self) -> Iterator[dict]:
        return self._h.paginate("/api/wikis", "wikis")

    def retrieve(self, wiki_id: str) -> dict:
        return self._h.json("GET", f"/api/wikis/{wiki_id}")["wiki"]

    def update(self, wiki_id: str, **fields: Any) -> dict:
        return self._h.json("PATCH", f"/api/wikis/{wiki_id}", json=fields)["wiki"]

    def tree(self, wiki_id: str) -> list[dict]:
        return self._h.json("GET", f"/api/wikis/{wiki_id}/tree")["entries"]

    def content(self, wiki_id: str, path: str) -> bytes:
        return self._h.request("GET", f"/api/wikis/{wiki_id}/content", params={"path": path}).content

    def delete(self, wiki_id: str) -> None:
        self._h.request("DELETE", f"/api/wikis/{wiki_id}")


class _VaultCredentials:
    def __init__(self, http: HttpClient):
        self._h = http

    def create(self, vault_id: str, *, name: str | None = None, value: str | None = None,
               type: str = "environment_variable", mcp_server_url: str | None = None,
               mcp_server_name: str | None = None, token: str | None = None,
               access_token: str | None = None, client_id: str | None = None,
               client_secret: str | None = None) -> dict:
        body: dict[str, Any] = {"type": type}
        if name is not None:
            body["name"] = name
        if type == "environment_variable":
            if value is not None:
                body["value"] = value
        else:
            if mcp_server_url is not None:
                body["mcpServerUrl"] = mcp_server_url
            if mcp_server_name is not None:
                body["mcpServerName"] = mcp_server_name
            if type == "bearer_token":
                if token is not None:
                    body["token"] = token
            elif type == "mcp_oauth":
                if access_token is not None:
                    body["accessToken"] = access_token
                if client_id is not None:
                    body["clientId"] = client_id
                if client_secret is not None:
                    body["clientSecret"] = client_secret
        return self._h.json("POST", f"/api/vaults/{vault_id}/credentials", json=body)

    def delete(self, vault_id: str, name: str) -> None:
        self._h.request("DELETE", f"/api/vaults/{vault_id}/credentials/{name}")


class Vaults:
    def __init__(self, http: HttpClient):
        self._h = http
        self.credentials = _VaultCredentials(http)

    def create(self, *, name: str, secrets: dict[str, str] | None = None) -> dict:
        return self._h.json("POST", "/api/vaults", json={"name": name, **({"secrets": secrets} if secrets else {})})

    def list(self) -> Iterator[dict]:
        return self._h.paginate("/api/vaults", "vaults")

    def retrieve(self, vault_id: str) -> dict:
        return self._h.json("GET", f"/api/vaults/{vault_id}")

    def delete(self, vault_id: str) -> None:
        self._h.request("DELETE", f"/api/vaults/{vault_id}")


class Environments:
    def __init__(self, http: HttpClient):
        self._h = http

    def create(self, *, name: str, allowed_hosts: list[str] | None = None,
               allow_package_managers: bool = False, allow_mcp_servers: bool = False,
               pod: dict | None = None) -> dict:
        return self._h.json("POST", "/api/environments", json={
            "name": name, "allowedHosts": allowed_hosts or [],
            "allowPackageManagers": allow_package_managers, "allowMcpServers": allow_mcp_servers,
            **({"pod": pod} if pod else {}),
        })

    def list(self) -> Iterator[dict]:
        return self._h.paginate("/api/environments", "environments")

    def update(self, environment_id: str, **fields: Any) -> dict:
        return self._h.json("PATCH", f"/api/environments/{environment_id}", json=fields)

    def delete(self, environment_id: str) -> None:
        self._h.request("DELETE", f"/api/environments/{environment_id}")


class Agents:
    def __init__(self, http: HttpClient):
        self._h = http

    def create(self, *, name: str, routing: str, environment_id: str, system_prompt: str = "",
               tools: list[str] | None = None, max_turns: int = 10, skill_ids: list[str] | None = None,
               vault_id: str | None = None, turn_deadline_seconds: int | None = None,
               mcp_servers: dict | None = None,
               subagents: list[dict] | None = None,
               wiki_refs: list[dict] | None = None, **extra: Any) -> dict:
        """`routing` names an existing routing (agents reference routings only,
        2026-07-16). `subagents` = [{"agentId": ..., "instructions": ...}].
        `wiki_refs` = [{"wikiId": ..., "mode": "read"|"write"}] — one writer per
        wiki (409 otherwise); a writer agent runs one session at a time.
        (Memory stores and files attach to sessions, not agents.)"""
        return self._h.json("POST", "/api/agents", json={
            "name": name, "routing": routing, "environmentId": environment_id,
            "systemPrompt": system_prompt, "tools": tools or [], "maxTurns": max_turns,
            **({"skillIds": skill_ids} if skill_ids else {}),
            **({"vaultId": vault_id} if vault_id else {}),
            **({"turnDeadlineSeconds": turn_deadline_seconds} if turn_deadline_seconds is not None else {}),
            **({"mcpServers": mcp_servers} if mcp_servers else {}),
            **({"subagents": subagents} if subagents else {}),
            **({"wikiRefs": wiki_refs} if wiki_refs else {}), **extra,
        })

    def list(self) -> Iterator[dict]:
        return self._h.paginate("/api/agents", "agents")

    def retrieve(self, agent_id: str) -> dict:
        return self._h.json("GET", f"/api/agents/{agent_id}")

    def update(self, agent_id: str, **config: Any) -> dict:
        """Creates a new agent version (POST :id/versions)."""
        return self._h.json("POST", f"/api/agents/{agent_id}/versions", json=config)

    def rename(self, agent_id: str, name: str) -> dict:
        """Rename only — the name is row metadata, not part of the versioned config."""
        return self._h.json("PATCH", f"/api/agents/{agent_id}", json={"name": name})

    def set_status(self, agent_id: str, status: str) -> dict:
        return self._h.json("POST", f"/api/agents/{agent_id}/status", json={"status": status})

    def delete(self, agent_id: str) -> None:
        self._h.request("DELETE", f"/api/agents/{agent_id}")


class McpRegistry:
    def __init__(self, http: HttpClient):
        self._h = http

    def list(self) -> list[dict]:
        return self._h.json("GET", "/api/mcp-registry")["servers"]


class _SessionEvents:
    def __init__(self, http: HttpClient):
        self._h = http

    def list(self, session_id: str, *, after: int = 0) -> list[dict]:
        return self._h.json("GET", f"/api/sessions/{session_id}/events", params={"after": after})["events"]

    def stream(self, session_id: str, *, after: int = 0) -> Iterator[dict]:
        """Yield events (and {'type': 'status', ...} markers) until terminal.
        A dropped connection (proxy timeout, gateway reload) reconnects and
        resumes from the last seen seq; consecutive failures give up."""
        last, failures = after, 0
        while True:
            try:
                for name, data in self._h.sse(f"/api/sessions/{session_id}/events/stream", {"after": last}):
                    failures = 0
                    if name == "status":
                        yield {"type": "status", "payload": data}
                    else:
                        if isinstance(data.get("seq"), int):
                            last = max(last, data["seq"])
                        yield data
                return  # server sent 'end' (session reached completed/failed)
            except APIConnectionError:
                failures += 1
                if failures > 5:
                    raise
                time.sleep(min(0.5 * 2 ** failures, 10))


class Sessions:
    def __init__(self, http: HttpClient):
        self._h = http
        self.events = _SessionEvents(http)

    def create(self, *, agent: str, prompt: str, name: str | None = None,
               files: list[str] | None = None, memory_store: str | None = None) -> dict:
        return self._h.json("POST", "/api/sessions", json={
            "agent": agent, "prompt": prompt, "name": name,
            **({"files": files} if files else {}), **({"memoryStore": memory_store} if memory_store else {}),
        })

    def send_message(self, session_id: str, *, prompt: str, files: list[str] | None = None) -> dict:
        return self._h.json("POST", f"/api/sessions/{session_id}/messages",
                            json={"prompt": prompt, **({"files": files} if files else {})})

    def list(self, *, agent: str | None = None, file: str | None = None) -> Iterator[dict]:
        """Filter by agent id and/or attached file id."""
        params = {**({"agent": agent} if agent else {}), **({"file": file} if file else {})}
        return self._h.paginate("/api/sessions", "sessions", params or None)

    def retrieve(self, session_id: str) -> dict:
        return self._h.json("GET", f"/api/sessions/{session_id}")

    def resources(self, session_id: str) -> dict:
        return self._h.json("GET", f"/api/sessions/{session_id}/resources")

    def interrupt(self, session_id: str) -> dict:
        return self._h.json("POST", f"/api/sessions/{session_id}/interrupt", json={})

    def delete(self, session_id: str) -> None:
        self._h.request("DELETE", f"/api/sessions/{session_id}")
