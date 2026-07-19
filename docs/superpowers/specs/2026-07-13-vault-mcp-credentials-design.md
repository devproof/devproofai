# Typed Vault Credentials + MCP Server Support — Design

**Date:** 2026-07-13
**Status:** Approved (sections 1–4 approved individually in brainstorming)
**Mockups:** `tmp/screens_vault/` (Anthropic "Add credential" dialog, 4 screens)

## Goal

Make credential vaults typed (Environment variable / Bearer token / MCP OAuth) and
make remote MCP servers actually work end-to-end: pick a server from a bundled
registry (or custom URL) in the console, attach a credential to it, have the
session authenticate to it through the per-environment egress proxy. Closes TODO
"Credential vaults testing → MCP → context7".

## Scope decisions (user-confirmed)

| Decision | Choice |
|---|---|
| MCP OAuth depth | **Store tokens only** — access token (+ inert client id/secret). No browser OAuth flow; "Connect" flow deferred. |
| MCP registry source | **Bundled file** `catalog/mcp-servers.yaml` (sovereignty/air-gap), same pattern as the model catalog. No live registry dependency. |
| MCP egress | **Env-level toggle** `allow_mcp_servers` (mirrors Anthropic `config.networking.allow_mcp_servers`). Auto-allows configured MCP hosts through Squid. |
| Env-var credential extras | **Plain name+value.** Mockup's per-credential Networking / Injection-location is Anthropic-proxy-specific; documented deviation. |
| Credential→server matching | **By URL** (credential stores the server URL; matched against agent MCP servers), following Anthropic. No explicit reference from agent config. |
| Vault attachment | **Stays agent-version-level.** Session-level `vault_ids[]` remains the documented deferred item (alignment doc §3). |
| Approach | **A — typed rows + env-var indirection** (over first-class MCP entities, or UI-only polish). |

## 1. Data model, secret layout, registry

### Migration `028_typed_credentials.sql` (idempotent — every file re-runs each boot)

```sql
ALTER TABLE vault_credentials ADD COLUMN IF NOT EXISTS type TEXT NOT NULL
  DEFAULT 'environment_variable'
  CHECK (type IN ('environment_variable','bearer_token','mcp_oauth'));
ALTER TABLE vault_credentials ADD COLUMN IF NOT EXISTS mcp_server_url  TEXT;
ALTER TABLE vault_credentials ADD COLUMN IF NOT EXISTS mcp_server_name TEXT; -- display label
ALTER TABLE environments      ADD COLUMN IF NOT EXISTS allow_mcp_servers BOOLEAN NOT NULL DEFAULT false;
```

- Inline `CHECK` rides the `ADD COLUMN IF NOT EXISTS` (023/024 idiom): applied only at
  column creation, skipped on boot re-runs. No `ADD CONSTRAINT` (no `IF NOT EXISTS` in PG).
- Existing rows become `environment_variable` — zero behavior change.

### Secret layout

Values live **only** in the per-vault K8s Secret (`devproof-vault-<id>`), injected
into session pods via the existing `envFrom` secretRef (`orchestrator.ts` `buildTurnJob`).
Never in the DB, Job spec, or `DEVPROOF_AGENT_CONFIG`.

| Type | Secret key(s) |
|---|---|
| `environment_variable` | credential name verbatim (e.g. `MY_API_KEY`) — unchanged |
| `bearer_token` | `DEVPROOF_CRED_<SAN>_TOKEN` |
| `mcp_oauth` | `DEVPROOF_CRED_<SAN>_TOKEN`, optional `…_CLIENT_ID`, `…_CLIENT_SECRET` (inert groundwork for the future OAuth flow) |

`<SAN>` = credential name sanitized to `[A-Z0-9_]+` (uppercase, other chars → `_`).
By construction valid as both a Secret key (`[-._a-zA-Z0-9]+`) and a `C_IDENTIFIER`
env var name — the "envFrom skips invalid names" edge case cannot occur.
Deleting a credential deletes **all** its derived keys.

Name is optional for the MCP types (auto-derived from the picked server, e.g.
`context7`); required for `environment_variable` (it *is* the variable name, must be
a valid env var name).

**Name-collision rule** (today `addVaultCredential` is a blind upsert, `repo.ts:528-532`):
same name + same type + same `mcp_server_url` ⇒ **rotate** (upsert, today's semantics);
same name but different type or server URL ⇒ **409**. One SELECT in the POST handler
before the upsert.

### Registry: `catalog/mcp-servers.yaml`

Entries `{name, label, url, description?, auth: oauth|bearer|none}`. Seeded with
Context7, GitHub, and a handful of well-known **remote** (streamable-HTTP) servers.
Served read-only via `GET /v1/mcp-registry` — global, like the model catalog (Serving
posture, not workspace-scoped). Custom URLs are typed into the picker, not persisted
to the registry.

## 2. Orchestration: header injection + egress

### Header injection (control plane)

New pure helper `renderMcpServers(mcpServers, credentials)` (orchestrator):

- For each credential of type `bearer_token`/`mcp_oauth`, match `mcp_server_url`
  against agent MCP server URLs. Normalization: lowercase scheme+host, strip trailing
  slash, keep path. Exact match after normalization.
- On match, that server config gains
  `headers: { Authorization: "Bearer ${DEVPROOF_CRED_<SAN>_TOKEN}" }` — a
  **placeholder**, not the value. The token reaches the pod only via `envFrom`.
- A server whose config already carries an `Authorization` header (raw API) is left
  untouched.
- Credential metadata (names/types/URLs — no values) is fetched at `startTurn` time
  and passed in; `buildTurnJob` stays pure. Rendered map replaces `mcp_servers` in
  `DEVPROOF_AGENT_CONFIG`.

Known simplification: bearer injection hardcodes `Authorization: Bearer`. Custom
header names remain possible via raw API `headers` passthrough.

### Egress (Squid)

- `squidConf(hosts, allowPackageManagers, mcpHosts)` — third arg, stays pure/testable.
- `ensureEnvironmentPolicy`: when `env.allow_mcp_servers`, `mcpHosts` = union of
  hostnames from `mcp_servers` across the **latest versions of all agents pointing at
  that environment** (one repo query).
- Re-sync triggers: environment create/update (exists) **plus** agent create / new
  version save — re-sync the agent's environment, and the previous environment if it
  changed.
- Documented softnesses (allowlist-only, fail-open within the allowlist): a deleted
  agent's hosts linger until the env's next sync; other agents' sessions in the same
  env can reach the allowed MCP hosts (proxy is per-environment — same granularity as
  Anthropic's boolean).

### Proxy path (verified 2026-07-13)

The runner's then-bundled CLI (part of the legacy runner runtime, dev26 image —
since superseded by the in-process `devproof_runner` loop) installs
undici's `EnvHttpProxyAgent` via `setGlobalDispatcher` — global `fetch` honors
`HTTP(S)_PROXY`/`NO_PROXY` — and its MCP `StreamableHTTPClientTransport` uses global
fetch. Session pods already set `HTTP(S)_PROXY` (`orchestrator.ts:333-335`); WebFetch
already rides Squid in production. Fail-closed either way (NetworkPolicy blocks
direct egress); the Context7 e2e is the acceptance gate.

## 3. Console UI

### Add-credential dialog (`app/vaults/[id]/credentials.tsx`, rebuilt on shared `Modal`/`Field`)

Replaces the inline name/value row. Mirrors the mockups:

- **Name** — required for Environment variable; optional for MCP types (auto-derived
  from picked server).
- **Type** select — Environment variable / Bearer token / MCP OAuth.
- Per-type fields — env var: variable name + value. Bearer: MCP server picker + token.
  MCP OAuth: MCP server picker + **access token (required — no Connect flow yet, so a
  token-less OAuth credential is useless; deliberate deviation from the mockup's
  "Optional" label)** + optional Client ID / Client secret (stored inert).
- Shared-credential **warning panel + acknowledge checkbox**; submit disabled until
  checked. Button: "Add credential" (no "Connect" until the real OAuth flow).
- Credential list: type badge + server URL column. Clicking a credential's **name**
  reopens the dialog for **rotate** (name/type/server locked, new value only) —
  consistent with the 409-on-mismatch rule. Rotate accepts the same per-type value
  fields; omitted optional parts (OAuth client id/secret) leave the existing Secret
  keys unchanged.

### MCP server picker (shared component)

Searchable dropdown fed by `GET /v1/mcp-registry`; a "Custom server" row switches to
a URL input. Used in the credential dialog and the agent form.

### Agent form (`agent-form.tsx`)

The missing MCP editor: list of server rows (name + URL) added via the picker, stored
in the existing SDK shape `{name: {type: "http", url}}` on `agent_versions.mcp_servers`.
Inline hint when the selected environment has `allow_mcp_servers` off ("MCP servers
won't be reachable…"). Detail tabs keep the chips, now showing the URL.

### Environment form

"Allow MCP servers" toggle in the networking section, next to allowed hosts.

### Public API parity

`public-api.ts` mirrors the extended credential routes and the registry endpoint, as
it mirrors every vault route today (`public-api.ts:216-261`).

## 4. Runner, error handling, testing

### Runner (`session-runner/runner.py`, tag `dev26` → `dev27`)

One addition: a pure function expands `${VAR}` placeholders in
`mcp_servers[*].headers` values from `os.environ` before building the runtime's
options object.
Unresolved placeholder ⇒ drop that header + stderr warning (never pass literal
`${…}` upstream). No settings.json change.

### Error handling

- `POST /v1/vaults/:id/credentials`: 400 on unknown type, missing per-type required
  fields, non-http(s) `mcpServerUrl`, or invalid env-var name; 409 per the
  name-collision rule.
- Agent create/version: `mcpServers` validated (name pattern + http(s) URL per
  entry) ⇒ 400 otherwise; extra fields (e.g. pre-set `headers`) pass through.
- `allow_mcp_servers` off + MCP servers configured: not an error — console hint only;
  proxy blocks, fail-closed.

### Testing

- **CP unit tests** (Node runner + `npx tsc --noEmit`): `squidConf` with MCP hosts;
  secret-key derivation/sanitization; `renderMcpServers` (URL matching, header
  injection, preserve-existing-Authorization); credential validation/409 matrix.
- **Runner tests** (`session-runner/test_runner.py`, run inside the image):
  placeholder expansion incl. unresolved-drop.
- **E2E acceptance gate** (live cluster): restart CP + console, all pages 200; create
  a Context7 credential, an agent with the Context7 MCP server, an env with Allow MCP
  servers on; run a session exercising a Context7 tool — proves picker → credential →
  header injection → Squid egress → MCP round-trip.

### Docs

Update CLAUDE.md (vault/MCP conventions bullet, runner tag dev27) and
`docs/concept/platform-alignment-and-scale.md` vault/MCP rows.

## Deferred (explicitly out of scope)

- Real MCP OAuth browser flow (Connect button, callback, token refresh).
- Per-credential networking / request-header-vs-body injection (Anthropic-proxy
  semantics; would need secret-injecting egress proxy infrastructure).
- Session-level `vault_ids[]` + credential auth-type matching at session scope.
- First-class MCP server entities/page (Approach B).
- Custom auth header names in the console (raw API only).

## Amendment (2026-07-13)

The "Add credential" dialog's shared-credential warning box ("This credential will
be shared across this workspace…") and its "I acknowledge this credential is shared
and that I am responsible for its storage and use." checkbox were removed
post-implementation at the owner's request. Both were carried over from the
Anthropic mockups; they don't apply here since Devproof credentials are
workspace-scoped, not shared across workspaces. `ready` gating in
`credentials.tsx` now depends only on the value + type-specific requirements.

Separately, `app/lib/mcp-picker.tsx` was reworked from an inline expanding list
into a left-aligned dropdown (button + panel below), with a deterministic
per-server logo tile (hashed hue, first-letter initial; a globe glyph for
"Custom server…"). Exported names/props are unchanged.
