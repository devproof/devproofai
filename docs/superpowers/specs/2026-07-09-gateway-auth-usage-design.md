# Gateway API-Key Enforcement + Metered Usage — Design

**Date:** 2026-07-09
**Status:** Approved (brainstorming session)
**Owner docs:** companion to `docs/concept/devproof-ai-concept.md` §5.7 and
`docs/concept/platform-alignment-and-scale.md` §1.

## Problem

The gateway (LiteLLM, `devproof-gateway` ns, `localhost:14000` via localhost-lb)
accepts any request — `ANTHROPIC_API_KEY` can be empty. API keys created on the
console's API Keys page are pure attribution objects; nothing validates them.
Usage is aggregated only from the `sessions` table, so direct gateway traffic
(Anthropic-dialect coding CLIs, OpenAI SDKs) is invisible, and there is no per-key or
per-deployment dimension and no date-range control.

## Requirements (user, 2026-07-08)

1. UI-managed API keys **must** be enforced for model access through the
   gateway. Deleting or deactivating a key revokes access. Users can create any
   number of keys.
2. Enforcement must not live in the control plane — it stays in a separate
   service so model traffic can later be routed via a different service or load
   balancer.
3. The Usage page shows input/output token consumption for this traffic, with
   filters: deployment, API key, and date range with presets **1d, 3d, 7d, 14d,
   current month, last month, last 3 months, last 6 months**.
4. Scope is external model access only. Managed agents are not part of the
   feature — but agent session pods call the same gateway internally, so they
   receive a hidden internal credential (technical necessity, invisible in UI).
5. Usage page layout: **two sections** — new gateway-metered "API usage" on
   top, existing session rollup below (unchanged). No merged/double-counted
   numbers.

## Decision: enforce + meter inside the gateway (in-gateway hooks)

Chosen over (B) a dedicated Devproof auth-proxy in front of LiteLLM and (C)
LiteLLM-native virtual keys.

- The gateway is already a separate Service/Deployment from the control plane —
  requirement 2 holds with no new hop or component; any LB can front it later.
- LiteLLM already parses per-request token usage for **both dialects including
  streaming** — the hard part B would have to re-implement.
- C creates a second key store (sync bugs = security bugs) and locks usage data
  into LiteLLM's Prisma schema, against the concept's "gateway is replaceable"
  principle.
- Trade-off accepted: the logic is Python inside the `litellm-config`
  ConfigMap, extending the existing schema-sanitizer precedent.

## Architecture & request flow

```
Anthropic-dialect CLI / OpenAI SDK
   │  Authorization: Bearer dpk_…   (or x-api-key)
   ▼
Gateway (LiteLLM)
   ├─ custom_auth hook ── sha256(key) → api_keys (Postgres), 30 s TTL cache
   │                      no match / not active → 401
   ├─ schema sanitizer (existing, unchanged)
   ├─ route to model deployment (llama.cpp/vLLM)
   └─ success hook ────── INSERT gateway_usage (key, workspace, model, tokens)
Control plane: never in the request path — manages keys, reads usage.
```

## Components

### 1. Migration `sql/016_gateway_usage.sql`

```sql
CREATE TABLE gateway_usage (
  id            bigserial PRIMARY KEY,
  workspace_id  text NOT NULL,
  api_key_id    text REFERENCES api_keys(id) ON DELETE SET NULL,
  model         text NOT NULL,              -- deployment name
  tokens_in     bigint NOT NULL DEFAULT 0,
  tokens_out    bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gateway_usage_ws_time  ON gateway_usage (workspace_id, created_at);
CREATE INDEX gateway_usage_key_time ON gateway_usage (api_key_id, created_at);
```

`ON DELETE SET NULL` (migration-014 convention): deleting a key revokes access
but keeps historical totals honest; the UI groups such rows as "(deleted key)".

### 2. Gateway hooks (`custom_callbacks.py` in the `litellm-config` ConfigMap)

- **Auth** — `user_custom_auth(request, api_key)` wired via
  `general_settings.custom_auth`:
  - sha256 the presented key; check an in-memory `{hash → (key_id,
    workspace_id, status)}` cache with 30 s TTL; on miss query
    `api_keys WHERE secret_hash = $1 AND status = 'active'` via asyncpg
    (`DEVPROOF_DATABASE_URL` env — **never name this env `DATABASE_URL`**:
    LiteLLM treats `DATABASE_URL` as "enable my Prisma-managed DB" and runs a
    destructive migration against the shared schema; this wiped the dev
    Postgres once, 2026-07-09).
  - Internal key: constant-time compare against `DEVPROOF_INTERNAL_KEY` env
    (from the internal-key Secret). Accepted, flagged internal, not metered.
  - No match → 401. Postgres down → cached keys keep working until TTL expiry,
    unknown keys → rejected (401 via hook exception) (**fail closed**; an outage can't open the gateway).
  - Updates `api_keys.last_used_at`, throttled to once per minute per key.
- **Metering** — the existing `SchemaSanitizer` CustomLogger gains
  `async_log_success_event`: reads LiteLLM's parsed usage (prompt/completion
  tokens; covers streaming and both dialects) plus the auth context, inserts
  one `gateway_usage` row. Insert failure is logged and dropped — metering must
  never fail or delay a request. Internal-key traffic writes no row.
- **Config generation** — `buildGatewayConfig` (control-plane
  `gateway-config.ts`) adds the `general_settings.custom_auth` block and MUST
  keep `litellm_settings.callbacks` (CLAUDE.md don't-regress item). The
  bootstrap ConfigMap in `deploy/gateway/litellm.yaml` ships the same hooks so
  a fresh install is never open.
- **Image note (spike-verified):** asyncpg is NOT in
  `ghcr.io/berriai/litellm:main-stable`, and the image's venv has no `pip` on
  PATH. Verified working startup command:
  `/bin/sh -c "python3 -m ensurepip && python3 -m pip install --no-cache-dir asyncpg && exec litellm --config /etc/litellm/config.yaml --port 4000"`
  (installs asyncpg 0.31.0 in ~5 s). This adds a PyPI dependency at pod start —
  acceptable for now; the air-gap-friendly follow-up is a `devproof/gateway`
  image baking asyncpg in (same pattern as the session-runner image).

### 3. Control plane

- **`GET /v1/usage/gateway?range=<preset>&deployment=<name>&api_key=<id>`**
  (workspace-scoped via `X-Devproof-Workspace`, like every endpoint).
  - `range` ∈ `1d | 3d | 7d | 14d | month | last_month | 3m | 6m`
    (`month` = current calendar month, `last_month` = previous calendar month,
    others = rolling windows). Default `7d`.
  - Optional `deployment` (model name) and `api_key` (key id) filters, ANDed.
  - Response: `{ buckets: [{bucket, tokens_in, tokens_out, requests}],
    totals: {tokens_in, tokens_out, requests},
    byDeployment: [{model, tokens_in, tokens_out, requests}],
    byKey: [{api_key_id, name|null, tokens_in, tokens_out, requests}] }`.
  - Bucketing decided server-side: daily for `1d…last_month`, weekly for
    `3m`/`6m` (chart never renders ~180 bars). UI renders what it gets.
  - `byKey` LEFT JOINs `api_keys` for names; `api_key_id IS NULL` rows surface
    as name `null` → UI shows "(deleted key)".
- **Internal key provisioning** (startup, idempotent): ensure a
  `gateway-internal-key` Secret exists in `devproof-gateway` (random value on
  first creation); mount as env in the gateway Deployment; inject the value as
  `ANTHROPIC_API_KEY` into session-runner Job specs (replacing today's dummy
  value).
- Existing `/v1/usage` (session rollup) is untouched.

### 4. Console Usage page (`console/app/usage/page.tsx`)

Two sections:

1. **API usage** (new, client component — filters need interactivity):
   - Filter bar: deployment dropdown (All + deployments seen in usage; lists
     live deployments from `/v1/deployments`, an implementation choice), API-key
     dropdown (All + keys from `/v1/api-keys` + a static "(deleted key)" option
     that filters to `api_key_id IS NULL` rows via the `__deleted__` sentinel
     value), date-range dropdown with the 8 presets (default **7 days**).
   - Cards: total input tokens, total output tokens, requests.
   - Bar chart in the existing style, one bar per bucket, split
     input/output.
   - Tables: **By deployment** and **By API key** (tokens in/out, requests).
2. **Session usage** — the existing content, retitled, unchanged.

### 5. Behavior changes & docs

- Connecting an external coding-agent CLI now requires a real key from the API Keys page:
  `ANTHROPIC_API_KEY=dpk_…` (empty/`none` → 401). Update the "Using Claude
  Code against a Devproof model" section of `CLAUDE.md`.
- Gateway `/v1/models` requires a key; `/health/*` stays open (probes).
- Record in `platform-alignment-and-scale.md`: per-key/per-model metering moves
  the usage report closer to Anthropic's `usage_report/messages` dimensions.

## Spike results (2026-07-09, live cluster — de-risks the hook surface)

Ran a hardcoded-key `custom_auth` + field-discovery success callback against
the running gateway and `qwen05b-dp`:

- **Auth:** missing key → 401; wrong key → 401 with clean dialect error body
  (`{"error":{"message":"Authentication Error, …","code":"401"}}`). Raising
  from `user_custom_auth` is sufficient; `x-api-key` (Anthropic) and
  `Authorization: Bearer` (OpenAI) both reach the hook.
- **Metering:** `async_log_success_event` fired on ALL four permutations —
  OpenAI + Anthropic dialect × streaming + non-streaming — with correct token
  counts for streaming (llama.cpp usage propagated; e.g. stream `/v1/messages`
  → prompt 31 / completion 6).
- **Canonical extraction fields** (verified present in every permutation):
  - `kwargs["standard_logging_object"]["prompt_tokens" | "completion_tokens"]`
  - `kwargs["model"]` = deployment name (`qwen05b-dp`, not the `openai/`-prefixed route)
  - `kwargs["standard_logging_object"]["metadata"]["user_api_key_auth_metadata"]`
    = the exact `metadata` dict returned from `UserAPIKeyAuth` at auth time
    (carries `devproof_key_id`, `devproof_workspace` per request).
- `UserAPIKeyAuth(api_key=…, key_alias=…, metadata={…})` round-trips auth
  context into the logging callback with no globals or request-state hacks.

Gateway was restored to the repo manifest afterwards; no spike code remains
deployed.

## Error handling summary

| Case | Behavior |
|---|---|
| Missing / unknown / inactive / deleted key | 401 (dialect-appropriate error body via LiteLLM) |
| Postgres unreachable, key in cache | request proceeds until TTL expiry |
| Postgres unreachable, key not cached | rejected 401 (hook exception) — fail closed |
| Usage INSERT fails | logged, dropped; request unaffected |
| Key deleted mid-session of use | 401 within ≤30 s (cache TTL); history retained |

## Testing & verification

- **Unit (control-plane, Node test runner + tsc):** `buildGatewayConfig` emits
  `general_settings.custom_auth` and keeps `callbacks`; usage query covers all
  8 presets × filter combinations (bucket edges: calendar months vs rolling
  windows); internal-key provisioning idempotent.
- **E2E (live docker-desktop cluster):** no key → 401; bad key → 401; active
  key → 200 + `gateway_usage` row; deactivate → 401 within ~30 s; delete →
  401 + history retained under "(deleted key)"; agent session still runs
  (internal key, no usage row); an Anthropic-dialect CLI connects with a UI key; Usage page
  filters consistent with DB. Restart CP + console; all pages 200.

## Out of scope (deliberate)

- Per-key rate limits, budgets, or expiry (`expired` status).
- Per-workspace deployment ACLs — any active key reaches any deployment
  (single implicit org; keys attribute usage to their workspace).
- Usage-row rollup/retention — per-request rows with time indexes are fine at
  current scale; batch/rollup is the named follow-up before thousands of pods.
- Any change to agent-session usage accounting.

## Scale posture

Auth adds no per-request control-plane involvement and scales with gateway
replicas; the 30 s cache bounds Postgres QPS by distinct-keys, not requests.
Metering is one narrow indexed INSERT per request — the named follow-up at
thousands-of-pods scale is client-side batching in the hook plus a daily
rollup table with retention on raw rows.
