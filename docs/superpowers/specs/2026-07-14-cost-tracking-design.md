# Cost tracking & billing — design (2026-07-14)

Approved section-by-section in brainstorming. Adds cost tracking (what the
infrastructure and external tokens cost the operator — "real costs") and
billing (what is charged to the consumer, possibly marked up — "billed costs")
across settings, pricing, metering, and every usage surface.

## Decisions (user-confirmed)

- **Two independent ledgers.** Real costs = infra + external-token cost to the
  operator. Billed costs = what consumers are charged; may exceed real. The
  session chip shows *billed* cost.
- **Usage-time stamping.** Every cost is computed with the price valid at the
  moment of usage and stored immutably. Price edits only affect future usage.
  No price-history table needed.
- **Pool real cost** meters per running replica pod (price × replica-hours).
- **Session time billing** meters turn-pod runtime only (pod start → pod end,
  summed across turns; idle sessions bill nothing), charged exact-to-the-second.
- **Time-based deployment billing** is local-only, per running replica pod.
  External deployments bill via token prices only. Local token billing +
  time-based deployment billing may both be on and sum.
- **Currency is a display label.** Settings store the ISO code; a shared
  formatter maps code → symbol (EUR→€, USD→$, GBP→£, JPY→¥, CHF→"CHF").
  Changing currency never converts amounts. Dropdown labels: "EUR (€)" etc.
- **Toggle off = stop accruing, keep history.** Cost UI hides while the
  governing toggle is off; re-enabling resumes from that moment (no backfill).
  Stored prices survive toggling and reappear when re-enabled.
- **Architecture A:** Postgres trigger stamps token costs on `gateway_usage`;
  a CP sampler accrues time costs into a `cost_entries` ledger; prices in a
  uniform `resource_prices` table; settings in a singleton `app_settings` row.

## 1. Settings

**Migration `030_app_settings.sql`** (idempotent — migrate() re-runs every file):
`app_settings (id TEXT PRIMARY KEY CHECK (id='global'), data JSONB NOT NULL
DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT now())` +
`INSERT ... ON CONFLICT DO NOTHING` for the `global` row.

**Shape** (`data.costs`):

```json
{
  "enabled": false,
  "currency": "EUR",
  "trackPoolCosts": false,
  "trackExternalCosts": false,
  "trackEnvCosts": false,
  "billing": {
    "enabled": false,
    "showSessionCosts": false,
    "billSessionTime": false,
    "billExternalTokens": false,
    "billLocalTokens": false,
    "billDeploymentTime": false
  }
}
```

**API:** `GET /v1/settings` (public read — console pages need it to decide
whether to render cost UI), `PUT /v1/settings` (validated whole-object replace
of `data.costs`). Global, not workspace-scoped; workspace write-guard does not
apply. Currencies offered: EUR, USD, GBP, CHF, JPY (label-only; extendable).

**Console:** new `/settings` page; nav entry "Settings" in the Manage group
between "API keys" and "Workspaces" (`nav.tsx:25`) + `settings` icon in
`lib/icons.tsx`. Master checkbox reveals Currency + "Track real costs" group
(3 checkboxes) + "Enable billing" checkbox revealing its 5 checkboxes.
Explicit Save button (no auto-save per toggle). New helper
`console/app/lib/currency.ts`: `currencySymbol(code)`, `fmtCost(amount, code)` —
every cost surface renders through it.

**Gating semantics:** each toggle gates accrual of its cost kind AND visibility
of its UI. Master off ⇒ nothing accrues, all cost UI hidden (usage page,
deployment stats, dashboard, session chip, price fields in dialogs). The
trigger and sampler read the settings row live (single-row PK lookup) — a save
takes effect on the next request/tick, no CP restart.

## 2. Prices

**Migration adds** `resource_prices (kind TEXT, ref TEXT, prices JSONB NOT NULL,
updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (kind, ref))`.
`kind ∈ pool | deployment | external | environment`; `ref` = pool/deployment
name (CRD-backed) or row id (external, environment).

| kind | `real` | `billing` |
|---|---|---|
| `pool` | pod-time price | — |
| `deployment` (local) | — | pod-time price + token prices |
| `external` | token prices | token prices |
| `environment` | pod-time price | session-time price |

**Shapes:** time price `{ amount, per }`, `per ∈ minute|hour|day|month|year`
(minute offered only for session billing). Normalization to per-second at
accrual: hour=3600, day=86400, month=30 days, year=365 days. Token price
`{ inPerM, outPerM }` = currency per 1,000,000 tokens. Non-negative numbers;
no currency in the data. Empty/cleared field deletes that sub-object; a
resource without a price simply accrues nothing (no warning).

**API:** `GET /v1/prices` (full list), `PUT /v1/prices/:kind/:ref` (upsert).
CRD routes untouched — dialogs save the resource first, then PUT the price.

**Drift / cleanup (verified):** pools + local deployments are CRDs; the only
programmatic delete paths are `DELETE /v1/pools/:name` (server.ts:301) and
`DELETE /v1/deployments/:name` (server.ts:393); the operator never deletes
these CRs. Those routes, plus `DELETE /v1/deployments/external/:id` and the
environments delete route, also delete the matching `resource_prices` row.
Residual accepted limitation: `kubectl delete` bypasses the CP and leaves an
inert price row (accrues nothing — the sampler joins live resources); a
same-named resource created later would inherit it until edited.

**Dialog fields** (visible only when the governing toggle is on):
- Pool modal: "Real cost" amount + per-unit (per running replica pod) —
  `trackPoolCosts`.
- Deploy modal, local: "Billing" pod-time price (`billDeploymentTime`) and
  input/output per-1M token prices (`billLocalTokens`); both may be set (sum).
- Deploy modal, remote: "Real cost" token prices (`trackExternalCosts`) and
  "Billing" token prices (`billExternalTokens`).
- Environment modal: "Real cost" pod-time price (`trackEnvCosts`) and
  "Session billing" time price, minute…year units (`billSessionTime`).

## 3. Token costing (stamping + live session chip)

**Migration adds** `gateway_usage.real_cost NUMERIC`, `gateway_usage.billed_cost
NUMERIC` (NULL = not tracked at the time; 0 = tracked but free) and
`sessions.billed_cost NUMERIC NOT NULL DEFAULT 0`.

**BEFORE INSERT trigger on `gateway_usage`** (extends the 027 pattern): reads
`app_settings` + the `resource_prices` row for `NEW.model` — if the name
matches `external_deployments.name`, the model is external and the price row
is `(kind='external', ref=<that row's id>)`; else local with
`(kind='deployment', ref=NEW.model)`. Name collisions between the two
namespaces are already prevented at creation (server.ts:441).
- `real_cost` = tokens × external real token prices, only when
  `enabled && trackExternalCosts` and the model is external. Local models have
  no per-token real cost (their real cost is pool pod-time).
- `billed_cost` = tokens × billing token prices — external when
  `billExternalTokens`, local when `billLocalTokens` (each also requires
  `billing.enabled`).
- Defensive: any error ⇒ NULL costs, insert proceeds (EXCEPTION block returns
  NEW). A pricing bug may lose cost data, never token metering.

The existing AFTER INSERT session trigger additionally accumulates
`NEW.billed_cost` into `sessions.billed_cost`. Same insert, same NOTIFY.

**Live chip:** SSE `status` frame (`session-sse.ts`) gains `billed_cost`;
`use-session-live.ts` carries it in `Totals`; `header.tsx` renders a cost chip
right of the tokens chip (same `tok-tick` blink), `fmtCost`-formatted.
Rendered only when `enabled && billing.enabled && showSessionCosts`. The chip
shows one number — token billing + session-time billing — because time billing
writes into the same `sessions.billed_cost` column (§4); it ticks instantly on
token movement and ~per-minute from time billing.

## 4. Time costing (`cost_entries` + sampler)

**Migration adds** `cost_entries (id BIGSERIAL PK, ts TIMESTAMPTZ NOT NULL,
kind TEXT NOT NULL, deployment TEXT, pool TEXT, environment_id TEXT,
session_id TEXT, workspace_id TEXT, seconds NUMERIC NOT NULL, replicas INT,
real_cost NUMERIC, billed_cost NUMERIC)`; indexes `(kind, ts)`,
`(deployment, ts)`, `(session_id)`.

| kind | ledger | meter | attribution |
|---|---|---|---|
| `pool_pod` | real | replicas × pool rate × seconds | deployment, pool |
| `deployment_time` | billing | replicas × deployment rate × seconds | deployment, pool |
| `env_pod` | real | env rate × seconds (per turn pod) | environment_id, session_id, workspace_id |
| `session_time` | billing | env session rate × seconds | environment_id, session_id, workspace_id |

**Sampler** (`src/cost-sampler.ts`, 60s tick from `main.ts`, reconciler-style):
- *Engine side:* lists live ModelDeployments; for each local deployment with
  `status.readyReplicas > 0` (already surfaced, server.ts:331), accrues
  elapsed-since-watermark × replicas against the pool real price
  (`trackPoolCosts`) and the deployment billing time price
  (`billDeploymentTime`). Watermark = subject's latest `cost_entries.ts`;
  first sighting starts at now (never retroactive).
- *Session side:* same in-flight view as the zombie reconciler
  (`repo.listStuckSessions` filtered to running + `sessionJobState` active;
  launch-gate-parked sessions are excluded by construction). Environment
  resolved live via sessions.agent_id/agent_version →
  `agent_versions.environment_id` (an env price edit mid-session applies from
  that moment). Accrues env real cost (`trackEnvCosts`) and session-time
  billing (`billSessionTime`); session-time billing ALSO increments
  `sessions.billed_cost` and fires the session NOTIFY so the chip ticks.
  The orchestrator is extended to expose the turn Job's `status.startTime` so
  the first accrual starts at pod start.
- *Turn end:* the runner result callback (status leaves running) runs a final
  accrual watermark → now, making totals exact-to-the-second. The zombie
  reconciler's `session.failed` path does the same closing accrual, so
  unreported pod deaths still bill observed runtime.
- *Gap cap:* a watermark older than 2 ticks (CP was down) accrues at most 120s;
  the rest is skipped — replica counts/turn liveness during an outage are
  unknown; under-counting beats fabricating. Documented limitation.
- *Purity:* accrual math is a pure function
  `computeAccruals(observations, prices, settings, watermarks) → entries`
  (squidConf/buildTurnJob pattern), unit-testable without k8s/DB.

**Knobs (explicit policy, changeable without schema impact):** replica measure
= `readyReplicas` (unready pods accrue nothing — conservative, only signal the
CP already has); gap cap = 120s.

## 5. Deployment detail — Stats tab

`GET /v1/deployments/:name/stats` gains per-bucket `real_cost`/`billed_cost` +
window totals when tracking is on (fields absent when master off; UI renders
nothing). Real = external token real costs OR pool pod-time (local); billed =
token billed costs + `deployment_time` entries.

- "Real cost" box right of Requests, "Billed cost" right of it, currency
  formatted, same window/filters.
- **Filter rule:** api-key/agent filters exist only for token rows;
  `cost_entries` is deployment-wide. With a key/agent filter active, cost
  boxes + chart show token costs only, with a small "tokens only" hint.
  (No pro-rating of pod time across keys — it invents precision.)
- **"Cost per 10s" chart** below "Tokens per 10s": same bucket grid, reused
  `AreaChart`, two overlaid (NOT stacked) series — real and billed (billed may
  exceed real; they are not additive). Server spreads each `cost_entries` row
  evenly across the buckets its `[ts − seconds, ts]` span covers so 60s-grain
  entries don't render as per-minute spikes in 10s buckets.

## 6. Usage page + dashboard

**Shared filter bar** at the top of `/usage`, governing both sections: range
(existing presets), deployment, API key, and an **"All workspaces" checkbox**
right of the key dropdown. Checked ⇒ queries drop the `workspace_id` condition
(repo.ts:551) and the key dropdown reloads cross-workspace (`GET
/v1/api-keys?all=1`, new param; keys labeled with their workspace). The key
filter applies to the API section only (session traffic has no key).

**API usage:** "Real costs" + "Billed costs" boxes right of Requests, from
`gateway_usage` cost sums (`source='api'`), same filters.

**Session usage — rebuilt on `gateway_usage(source='session')`.** The old
`workspaceUsage` rollup cannot honor filters (its byModel query has no time
filter at all, repo.ts:527-534, and sums session-lifetime tokens). Session
rows carry workspace/model/agent/session ids (verified in the gateway
callback), so range/deployment/workspace filtering and
`count(DISTINCT session_id)` are plain SQL. The comment "session rows … never
for the Usage page" (repo.ts:549) is deliberately revoked. Cards: Input /
Output / Sessions (kept — from `sessions.created_at` in-range) / Real costs
(env pod-time + external-token real cost of session traffic) / Billed costs
(token billing + session-time billing).

**Tables:** sessions "By model" → **"By deployment"**; all By-deployment /
By-API-key tables gain Real/Billed columns; rows with all-zero window totals
are dropped.

**Chart component:** one shared bar-chart component replaces the two ad-hoc
140px flex-div charts (page.tsx:32-47, api-usage.tsx:77-91): ~200px tall,
theme palette (`--blue` input / `#d97706` output, matching the stats chart),
readable date labels (thinned to ~8 ticks, "Mon 07-13" style).

**Dashboard:** below the existing four cards (untouched), a "Usage" panel
replicating the deployment Stats surface cross-deployment: same filter bar
(range, deployment, API key, all-workspaces), boxes Requests / Input / Output /
Real / Billed, tokens chart + cost chart (shared components). Backed by new
`GET /v1/usage/summary` accepting all four filters, returning bucketed tokens +
costs from `gateway_usage` (both sources) + `cost_entries` — same shape as the
deployment stats endpoint. Same tokens-only-under-key-filter rule.

## 7. Error handling, testing, limits

**Error handling:** trigger never fails the insert (defensive EXCEPTION →
NULL costs); sampler log-and-continue per subject, failed tick widens the next
span bounded by the gap cap; missing settings row ⇒ everything off.

**Tests** (Node test runner + live DB, `npx tsc --noEmit`):
- `computeAccruals` unit tests: rate normalization (minute…year →
  per-second), replica multiplication, gap cap, toggle gating, exact final
  span on turn end.
- Trigger tests: each settings/price combination → stamped values,
  `sessions.billed_cost` accumulation, NULL-vs-0 semantics.
- Query tests: cost sums in gatewayUsage / session usage / deployment stats /
  usage summary; all-workspaces scope; zero-row dropping; price upsert +
  delete-route cleanup.
- Console: `next build`, all pages 200, live flow (set prices → run session →
  chip ticks → stats/usage/dashboard show costs) per the repo verify rule.

**Non-goals:** role-based access to billing data (a later session adds a role
system; until then the chip doubles as user cost awareness), invoicing/exports,
currency conversion, price-history tables (stamping obviates them),
`cost_entries` retention/rollups (~1–2M rows/day worst case at hundreds of
deployments is fine for Postgres; compaction is future work — note that
pruning `cost_entries` or `gateway_usage` breaks accumulated totals).
