# Public API (dpk_-authenticated managed-agents surface) — Design

**Date:** 2026-07-12
**Status:** Approved (brainstorming session; all transport behaviors verified on the live cluster)

## Problem

`dpk_` API keys today unlock only model inference at the gateway. Every managed-agents
component — files, skills, memory stores, credential vaults, environments, agents,
sessions — is served exclusively by the control plane on :7080 with **no auth at all**
(workspace header = attribution only). External clients (Python scripts, CI, other
services) cannot upload files or skills, manage memory/vaults, or drive agents at all.

## Goals

- API keys work for the **full managed-agents surface** through **one base URL** (the
  gateway, `localhost:14000` in dev), aligned in spirit with the Anthropic Python SDK.
- The UI path stays untouched: console keeps calling `/v1/*` on the CP with the
  workspace header (SAML/OAuth comes later, separately).
- Public API is a **stable contract, decoupled from UI routes** — console-driven route
  changes must never break Python clients.
- File uploads up to **4 GB**.
- A `devproof` Python library mirroring the Anthropic SDK's design, plus five example
  scripts (Tools, Memory, Files, Vault, Skills) that double as end-to-end smoke tests.

## Non-goals

- No auth on the existing `/v1/*` UI routes (future SAML/OAuth work).
- No Serving surface (pools/deployments/catalog — global/admin territory).
- No wire-format compatibility with the Anthropic API (the lib mirrors the SDK's
  *design*, not its wire shapes).
- No async Python client.

## Architecture

```
Console (UI)      ──▶ CP :7080 /v1/*          (unchanged; later SAML/OAuth)
Runner pods       ──▶ CP :7080 /v1/*          (unchanged, internal callbacks)

Python / external ──▶ Gateway :14000
   ├── /v1/messages, /v1/chat/completions  → LiteLLM model routing (existing)
   └── /api/*                              → pass_through_endpoint → CP /api/*  (NEW)
```

Two route namespaces in the control plane; one external URL via the gateway.

### Gateway (config-only change)

`buildGatewayConfig` (`control-plane/src/gateway-config.ts`) emits one additional block:

```yaml
general_settings:
  pass_through_endpoints:
    - path: "/api"
      target: "<DEVPROOF_PUBLIC_API_TARGET, default http://host.docker.internal:7080/api>"
      include_subpath: true
      forward_headers: true
      auth: false
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"]
```

`custom_callbacks.py` is **not touched**. One `syncGateway` run rolls it out.

### Verified transport facts (measured on the live gateway, 2026-07-12)

These are load-bearing constraints; do not regress them:

1. **Multipart bodies survive byte-perfect** (verified at 2 MB and 32 MB: part sha256
   identical end-to-end). LiteLLM re-encodes the envelope (new boundary) but part
   content, filename, and part content-type are preserved.
2. **Raw `application/octet-stream` bodies do NOT survive** — LiteLLM JSON-parses
   non-multipart bodies and 400s on binary. All public upload endpoints are multipart.
3. **Path collision:** paths shaped `<one-segment>/v1/<openai-resource>` (e.g.
   `/api/v1/files`) match LiteLLM's built-in OpenAI routes (`/{provider}/v1/files`)
   before the configured pass-through → 500 `'api' is not a valid LlmProviders`.
   **Therefore the public prefix is `/api/<resource>` with no `/v1` segment.**
   (`/api/v2/...`-style deeper prefixes verified routable if versioning is ever needed.)
4. **Plain GET responses are buffered** by the pass-through (TTFB ≈ total time).
   **`POST` with `{"stream": true}` in the body streams** end-to-end (~10 ms TTFB,
   measured for both SSE and 10 MB binary). Session-event streams and file downloads
   therefore use POST + `stream: true`.
5. **The gateway's existing `custom_auth` fires on pass-through routes** and rejects
   invalid `dpk_` keys with 401 before forwarding (free defense in depth). The
   `Authorization` header is forwarded intact. LiteLLM's own `auth: true` is
   Enterprise-only — not needed.

## Control plane: public API namespace

New `control-plane/src/public-api.ts`, registered in `main.ts`. Handlers are thin
wrappers over the **same** `repo` / `s3FileStore` functions the UI routes use —
separation is at the route/contract layer only, zero logic duplication.

### Auth (preHandler on everything under `/api`)

- Accepts `Authorization: Bearer dpk_...` (also `x-api-key: dpk_...`).
- `sha256(key)` → `api_keys WHERE secret_hash=$1 AND status='active'`; in-memory TTL
  cache (30 s, same as the gateway hook); fail-closed 401.
- **Workspace is derived from the key row.** The `X-Devproof-Workspace` header is
  ignored on `/api/*`.
- Fire-and-forget `last_used_at` update, throttled to once/minute per key.
- The CP check is authoritative; the gateway's `custom_auth` is defense in depth.

### Routes

Devproof-native shapes; same response bodies and `{rows, count, offset}` pagination
(100/page) as the `/v1` handlers.

| Resource | Routes |
|---|---|
| Files | `POST /api/files` (multipart, ≤32 MB fast path) · `GET /api/files` · `GET /api/files/:id` · `POST /api/files/:id/content` (`{"stream": true}` → streamed download) · `DELETE /api/files/:id` |
| File uploads (chunked) | `POST /api/files/uploads` → `{upload_id, part_size}` · `POST /api/files/uploads/:id/parts/:n` (multipart chunk) → `{etag}` · `POST /api/files/uploads/:id/complete` → file record · `DELETE /api/files/uploads/:id` (abort) |
| Skills | `POST /api/skills` (multipart `SKILL.md` or `.zip`) · `GET /api/skills` · `GET /api/skills/:id` · `DELETE /api/skills/:id` |
| Memory | `POST/GET/DELETE /api/memory-stores[...]` · `POST/DELETE .../entries` · `GET .../tree` · `GET .../content` |
| Vaults | `POST/GET/DELETE /api/vaults[...]` · `POST .../credentials` · `DELETE .../credentials/:name` |
| Environments | `POST/GET/PATCH/DELETE /api/environments[...]` |
| Agents | `POST/GET/PATCH/DELETE /api/agents[...]` · `POST .../versions` · `POST .../status` |
| Sessions | `POST /api/sessions` · `POST .../messages` · `POST .../interrupt` · `GET .../events` (poll) · `POST .../events/stream` (SSE via `{"stream": true}`) · `GET .../resources` · `GET /api/sessions` · `GET /:id` · `DELETE /:id` |

### Contract rules

- `/api/*` is the stable public contract. Breaking changes require a new prefix
  (`/api/v2/...`). `/v1/*` UI routes remain free to evolve with the console.
- Internal runner callback routes stay on `/v1`, untouched.

## Large files (up to 4 GB)

Single-shot 4 GB is wrong by construction: the pass-through re-encodes multipart
(whole body in gateway RAM) and one giant request has no resume story.

- **≤ 32 MB:** single `POST /api/files` (multipart).
- **> 32 MB:** chunked flow mapped 1:1 onto MinIO's native S3 multipart-upload API
  (parts 5 MB–5 GB, ≤10k parts). Default chunk 32 MB → 4 GB ≈ 128 requests; bounded
  memory everywhere. CP streams each part to MinIO via `uploadPart`, accumulates a
  running sha256, and on `complete` finalizes the object + inserts the file row (same
  record shape as small uploads). Parts are idempotent by number → resumable.
- **Stale-upload sweep:** uncompleted uploads older than 24 h are aborted (frees MinIO
  parts); piggybacks on the existing 60 s reconciler tick.
- **Download (any size):** `POST /api/files/:id/content` with `{"stream": true}` —
  verified to stream through the gateway unbuffered; CP streams from MinIO.

## Python library (`clients/python/devproof`)

Mirrors the Anthropic SDK's *design* — resource namespaces, constructor with env-var
fallbacks, typed exceptions, retries — over Devproof wire shapes. Sync-only; `httpx`
is the single dependency. Redesigns the existing minimal lib (pre-1.0, breaking OK);
`examples/demo_agent.py` is updated to match.

```python
from devproof import Devproof
client = Devproof()  # DEVPROOF_BASE_URL (default http://localhost:14000), DEVPROOF_API_KEY
```

| Namespace | Methods |
|---|---|
| `client.files` | `upload(path, kind=None, on_progress=None)` (auto single-shot/chunked) · `list()` · `retrieve(id)` · `download(id, dest, on_progress=None)` · `delete(id)` |
| `client.skills` | `upload(path)` · `list()` · `retrieve(id)` · `delete(id)` |
| `client.memory_stores` | `create` · `list` · `delete` · `entries.add` / `entries.delete` · `tree(id)` · `content(id, path)` |
| `client.vaults` | `create` · `list` · `retrieve` · `delete` · `credentials.create` · `credentials.delete` |
| `client.environments` | `create` / `list` / `update` / `delete` |
| `client.agents` | `create` / `list` / `retrieve` / `update` / `set_status` / `delete` |
| `client.sessions` | `create` / `list` / `retrieve` / `send_message` / `interrupt` / `delete` / `resources` · `events.list(id)` · `events.stream(id)` (SSE generator, polling fallback) |

Behaviors: typed exceptions (`AuthenticationError`, `NotFoundError`, `RateLimitError`,
`APIStatusError`, `APIConnectionError`); auto-retry with backoff on 429/5xx/connection
errors (`max_retries=2`); configurable `timeout`; auto-paginating `list()` iterators.

**Split of responsibilities:** the lib covers the platform API only. Model inference
(including tool-use) uses the official `anthropic` package against the same base URL
(`ANTHROPIC_BASE_URL=http://localhost:14000`, `ANTHROPIC_AUTH_TOKEN=dpk_...`).

## Example scripts (`examples/api/`)

Standalone, env-configured (`DEVPROOF_API_KEY`, `DEVPROOF_BASE_URL`), assert real
outcomes, exit non-zero on failure, clean up in `finally`. Shared `_common.py`.
Plus `examples/api/README.md` (create key on the API Keys page, set env vars, run).

| Script | Proves |
|---|---|
| `test_files.py` | Small upload → list/retrieve → streamed download → byte-compare; big file (`DEVPROOF_TEST_BIG_MB`, default 100) through chunked path + sha256; delete → 404 |
| `test_skills.py` | In-memory skill zip (SKILL.md + helper) → upload → manifest verification → delete |
| `test_memory.py` | Create store → add entries → tree + content round trip → delete |
| `test_vault.py` | Create vault → add credentials → assert secrets never echoed → delete |
| `test_tools.py` | End-to-end managed agent: environment + agent (`DEVPROOF_TEST_MODEL`) → session with a tool-forcing prompt → stream events → assert `tool_use` + completion → outputs → teardown. Requires a tool-capable model (not qwen0.5b) |

## Testing & verification

- **Unit (Node test runner):** auth preHandler (valid/invalid/deleted key, workspace
  derivation, header precedence); chunked-upload state machine (part ordering,
  complete, abort, sweep); every `/api` route 401s without a key.
- **Contract guard:** test asserting the public route table (paths + methods) against
  a checked-in snapshot — accidental public-contract changes fail CI.
- **Live (per project convention):** restart CP + console; `syncGateway`; console
  pages all 200 (UI untouched); run all five example scripts through
  `localhost:14000`; re-verify the Anthropic-dialect CLI flow (`/v1/messages` + dpk_ key) still
  works after the gateway config change.
- `npx tsc --noEmit` in control-plane; runner image untouched (no tag bump).

## Risks / open items

- LiteLLM-side request body limits for 32 MB chunks under concurrency: verified
  functionally at 32 MB; watch gateway pod memory during the live big-file test.
- Long-lived event streams vs `pass_through_request_timeout` (default 600 s): set a
  per-route `timeout` on the `/api` pass-through if streams need to outlive it;
  the lib reconnects/polls on drop.
- The gateway `custom_auth` 30 s key cache means a just-deleted key may work for up
  to 30 s at the gateway layer; the CP check has the same TTL — acceptable (matches
  existing inference behavior).

## Decision log (this session)

1. Platform routes live in the **control plane**, in a **separate public namespace**
   (`/api/*`) decoupled from UI routes (`/v1/*`). (User initially considered
   gateway-internal implementation; reverted after clarifying CP/UI split.)
2. **One external URL** via LiteLLM `pass_through_endpoints`; key validation in the
   CP (authoritative) + existing gateway custom_auth (incidental defense in depth).
3. **Devproof lib mirrors the Anthropic SDK design**; no Anthropic wire compatibility.
4. **Full managed-agents scope** including agents/sessions.
5. **4 GB uploads** via chunked protocol on MinIO multipart; streamed downloads via
   POST `{"stream": true}`.
