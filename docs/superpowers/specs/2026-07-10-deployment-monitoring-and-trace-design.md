# Deployment monitoring & live trace — design

Date: 2026-07-10. Status: approved by Carsten (traffic scope: ALL traffic; trace previews
truncated at 32,768 chars/message; graph filters: API key + agent + time range
1m/5m/30m/1h/3h; graph lives on the deployment detail page only; transport approach A).

New deployment detail page (`/deployments/[name]`, tabs **Overview | Stats | Trace**)
adding realtime token monitoring and an ephemeral request/response trace window. Works
identically for local (cluster pod) and remote (external provider) deployments because
every request flows through the LiteLLM gateway and its `custom_callbacks.py` hooks.

## Verified foundations (2026-07-10, live gateway litellm 1.91.1)

- `async_log_failure_event(kwargs, response_obj, start_time, end_time)` exists.
- `user_custom_auth(request=request, api_key=…)` receives the full FastAPI request —
  custom headers readable (`litellm/proxy/auth/user_api_key_auth.py:1043`).
- Gateway pod reaches `host.docker.internal:7080` (dev CP, out-of-cluster): tested 200.
- `StandardLoggingPayload` carries `messages`, `response`, `error_str`,
  `error_information`, `response_time`, `status`, `model_group`, prompt/completion
  tokens. Both hooks provably fire on the Anthropic `/v1/messages` route (sanitizer +
  metering already rely on that in production).
- `ANTHROPIC_CUSTOM_HEADERS` env: newline-separated `Name: Value` pairs, applies to all
  of the coding-agent CLI's requests incl. SDK-driven runs (per the vendor CLI docs).
- `async_pre_call_hook` receives `user_api_key_dict` → request-side attribution needs no
  extra plumbing.

## 1. Metering covers all traffic (migration 019)

Today the gateway meters ONLY external-API-key traffic; internal (managed-session)
requests return early. Change: meter everything.

- `gateway_usage` gains: `source TEXT NOT NULL DEFAULT 'api'` (`'api' | 'session'`),
  `agent_id TEXT` (nullable), `session_id TEXT` (nullable), and index
  `gateway_usage_model_time ON gateway_usage (model, created_at)`.
- **Session attribution:** the orchestrator injects into every session pod:
  `ANTHROPIC_CUSTOM_HEADERS = "X-Devproof-Agent: <agent_id>\nX-Devproof-Session: <session_id>\nX-Devproof-Workspace: <workspace_id>"`.
  `user_custom_auth` copies these three headers into auth metadata **only for
  internal-key requests** (trusted platform traffic; external callers cannot spoof
  attribution because their headers are ignored).
- Metering hook: drop the `devproof_internal` early-return. Internal requests write
  `source='session'`, `api_key_id=NULL`, agent/session/workspace from headers
  (workspace nullable if the header is absent — old pods during rollout). External
  rows unchanged except `source='api'`.
- **Usage page semantics unchanged:** every query in `repo.gatewayUsage` gains
  `AND source = 'api'`. Billing/usage views never see session rows.
- Session pods predating the header injection meter with NULL attribution — acceptable
  during rollout; runner image is NOT changed (headers are env-only → no tag bump).

## 2. Stats endpoint (realtime graph data)

`GET /v1/deployments/:name/stats?window=1m|5m|30m|1h|3h&api_key=<id>&agent=<id>`
(workspace-scoped like every other route; matches rows for this deployment name).

- Bucket widths: 1m→2s, 5m→10s, 30m→30s, 1h→1m, 3h→3m (30, 30, 60, 60, 60 buckets).
- Response: `{ window, bucketSeconds, buckets: [{ t, tokens_in, tokens_out, requests }],
  totals: { tokens_in, tokens_out, requests } }` — zero-filled buckets so the chart
  never has holes.
- Implementation: single SQL over `gateway_usage` using `date_bin`/width-bucket grouping
  on `created_at`, `WHERE model = $name AND created_at > now() - $window`, optional
  `api_key_id` / `agent_id` filters. Sessions rows count regardless of workspace column
  nullability (deployment monitoring is whole-deployment).
- Console polls every 3s while the Stats tab is visible; no SSE.

## 3. Live trace pipeline (approach A: DB-routed subscriptions, direct callbacks)

Nothing about message content is ever stored. Capture happens only while a window is
open.

**Subscription registry — migration 019:** `CREATE UNLOGGED TABLE trace_subscriptions (
id TEXT PRIMARY KEY, deployment TEXT NOT NULL, callback_url TEXT NOT NULL,
expires_at TIMESTAMPTZ NOT NULL )`. UNLOGGED: pure ephemeral routing state.

**Flow:**
1. Console opens `GET /v1/deployments/:name/trace/stream` (SSE). CP inserts a
   subscription row (`expires_at = now() + 15s`), re-upserts it every 5s while the
   stream is open (heartbeat), deletes it on disconnect. Callback URL comes from env
   `DEVPROOF_TRACE_CALLBACK_URL` (dev default `http://host.docker.internal:7080`; in-cluster
   CP pods advertise their pod IP).
2. Gateway: a background task polls `SELECT deployment, callback_url FROM
   trace_subscriptions WHERE expires_at > now()` every 2s into an in-memory dict
   (`asyncpg` pool already exists). Zero open windows → the poll is the entire overhead.
3. On a request to a traced deployment:
   - `async_pre_call_hook` → `request` event: id (uuid4 per request, correlates the
     pair), ts, deployment (model_group), source (`api`/`session`), key id / agent id /
     session id, message list as `{ role, preview, length }` — **preview = first 32,768
     chars** of the content (handle BOTH OpenAI string content and Anthropic
     content-block arrays; concatenate text blocks, note tool_use/tool_result blocks as
     `[tool_use: name]`), plus tool count and model params summary.
   - `async_log_success_event` → `response` event: same id, tokens_in/out,
     response_time, finish reason, response text preview (32,768-char cap) from the SLO
     `response`.
   - `async_log_failure_event` → `error` event: same id, `error_str` +
     `error_information` summary.
   - Delivery: fire-and-forget `POST <callback_url>/internal/trace-events` with
     `Authorization: Bearer <DEVPROOF_INTERNAL_KEY>`, 2s timeout, exceptions printed and
     swallowed. **Tracing must never fail or slow a request.**
4. CP `POST /internal/trace-events` (internal-key auth, NOT workspace-scoped): pushes to
   an in-memory `TraceHub` (subscribers keyed by deployment) → SSE fan-out. Events are
   dropped if no local subscriber (e.g. raced disconnect) — lossy by design.

**Gateway deploy note:** `custom_callbacks.py` grows; it ships inside the
`litellm-config` ConfigMap (`deploy/gateway/litellm.yaml`). The CP gateway-sync
regenerates ONLY `config.yaml` — verify during implementation that sync leaves
`custom_callbacks.py` intact (constraint from CLAUDE.md: `buildGatewayConfig` must keep
`litellm_settings.callbacks` + `general_settings`). Gateway pod needs env
`DEVPROOF_INTERNAL_KEY` (already present) — no new secrets.

## 4. Console: deployment detail page

`console/app/deployments/[name]/` with tabs **Overview | Stats | Trace**, leaning on the
agents `[id]` tab pattern (`useState` tab switcher, cards).

- **List page change:** the deployment name cell becomes a Link to the detail page
  (replacing name-click-opens-edit). **Edit** moves to a button on the detail page
  header, opening the existing shared deploy/edit modal (`EditDeploymentName` internals
  reused as a button trigger). Update the CLAUDE.md dialogs note: deployments now edit
  from the detail page like agents; catalog/pools keep name-click.
- **Overview tab:** the row's data as cards — phase (incl. download bar), kind,
  catalog/provider+model, pool, replicas min/max, ready count, tok/s, queue depth,
  endpoint, and for external: base URL, key version. Data from the existing
  `/v1/deployments` handler (add `GET /v1/deployments/:name` returning the single
  merged entry — same shape as one list element).
- **Stats tab:** realtime chart, Grafana-flavored: stacked in/out bars per bucket (SVG,
  hand-rolled like `usage/api-usage.tsx` — no chart lib), auto-refresh 3s, live dot.
  Filters: time range (1m/5m/30m/1h/3h), API key (workspace's keys + "(internal
  sessions)" pseudo-entry = `source='session'`), agent (workspace's agents). Totals row
  (in/out/requests for the window).
- **Trace tab:** SSE-driven list, newest on top, capped at 200 entries in memory
  (oldest dropped). Each entry: time, source chip (key name or agent name), request
  messages (role + collapsible preview, "N chars" note when truncated), response
  preview, tokens in/out, duration; error events tinted like session-view error blocks.
  Controls: Pause (buffer while paused), Clear, client-side text filter. Stream opens
  when the tab mounts, closes when it unmounts/page hides — capture stops with it.
  Reconnect-on-drop like `use-session-live`. SSE goes through the Next proxy —
  keep-alives + identity encoding per the established SSE conventions.

## 5. Failure & scale posture

- Trace: lossy, ephemeral, best-effort end to end; a dead CP callback just drops events
  (gateway logs once per POST failure). Heartbeat expiry (15s) bounds orphaned
  subscriptions from crashed CP instances.
- Stats: plain indexed SQL; 3s polling × open tabs is negligible. `gateway_usage`
  volume grows with session traffic now metered — same per-request insert cost external
  traffic already pays; the `(model, created_at)` index serves the new queries.
- Multiple CP instances: subscriptions carry per-instance callback URLs, so fan-out
  scales horizontally; the gateway POSTs to every subscribed instance.
- Multiple gateway replicas: each polls and posts independently — correct by
  construction (each request traverses exactly one replica).

## 6. Verification

- CP tests: stats bucketing (zero-fill, widths, filters), `source='api'` filtering on
  all Usage queries, TraceHub subscribe/fan-out/unsubscribe, subscription heartbeat +
  expiry, `/internal/trace-events` auth (401 without internal key).
- Plan step 1 is a live spike: inject `ANTHROPIC_CUSTOM_HEADERS` into a session pod,
  assert the headers arrive in `user_custom_auth` and SLO `messages`/`response` are
  non-null on the anthropic route, before building on top.
- Live: run one agent session AND one external Anthropic-dialect CLI request against the same
  deployment; both appear in Stats (with correct source/agent filters) and stream
  through an open Trace window; the workspace Usage page totals are unchanged by the
  session traffic; closing the Trace tab removes the subscription row within 15s.
