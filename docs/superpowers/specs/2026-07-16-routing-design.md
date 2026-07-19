# Routing — design spec (2026-07-16)

## Summary

A **Routing** is a named, ordered rule table that resolves an incoming gateway
request to a model (local deployment or external endpoint) — or rejects it.
Clients and managed agents address the routing **as a model name** at the
existing gateway URL (`<agent-cli> --model my-routing`); the gateway's pre-call hook
evaluates the table per request and rewrites the model before LiteLLM routes.
The Connect tab moves from deployment detail to routing detail. Routings get
their own token/cost attribution plus Overview and Trace tabs.

External `dpk_` keys become **routing-only**: bare deployment/external names
are rejected for external callers, so cost limits and reject rules are
enforceable, not advisory. Internal-key traffic (session pods, CP warmup) is
exempt — agents pointing directly at a model keep working.

## Decisions (user, 2026-07-16)

- Addressing: routing name as model name at the one gateway URL (no separate
  URL path). Routing names share the gateway namespace with deployment and
  external names, and **may shadow** them (a routing may take a deployment/
  external name to front it — resolution runs first; fix wave E).
- Agents reference a **routing ONLY**, via the field named `routing` (renamed
  from `model` end-to-end in fix wave C — DB `agent_versions.routing`, CP
  internals, `/api` + `/v1` payloads, console). No "either a model or a
  routing"; create/version 400 unless the value resolves to a routing.
- Cost/token-rule scopes: calling API key, calling workspace, calling agent,
  the routing itself, the rule's target deployment.
- Cost/token window: configurable per condition (calendar month, calendar
  day, rolling N hours).
- Classifier rule: LLM classify → label → target mapping (constrained labels,
  not free-form model names). The classifier deployment may be **local or
  external** (fix wave D).
- Extra condition types in scope: context-size guard, availability failover,
  weighted split, time-of-day window.
- **Conditions are combinable in one rule line (AND)** — e.g. cost && context
  size.
- Terminal reject when no rule matched.
- External keys are routing-only (bypass prevention).
- Routing-level token/cost tracking; Stats and Trace tabs on routing detail
  (same as deployments).
- **External endpoints get a MANDATORY `contextTokens`** (fix wave L) — no
  backwards compatibility: migration `039` backfills existing rows to
  `262144`, then the column goes `NOT NULL`. External targets now join local
  targets in a routing's min-window calculation.

## Architecture

Evaluation lives in the **gateway pre-call hook** (`custom_callbacks.py`),
at the top of `async_pre_call_hook`, BEFORE the scale-to-zero wake-hold block
— so the hold operates on the resolved target. The hook:

1. Loads the routing table for `data["model"]` from Postgres (TTL cache ~2s,
   `model_routing` pattern; stale-tolerant — see Error handling).
2. Evaluates rules top-down; first rule whose conditions ALL match wins.
3. Rewrites `data["model"]` to the target, stamps `devproof_routing = <name>`
   and `devproof_routing_rule = <index>` (`-1` for the terminal) into **BOTH**
   `metadata` AND `litellm_metadata` (dual-channel — see below), or raises
   HTTPException 403 on reject / 503 on a terminal route to a vanished target.
4. Enforces routing-only for external keys: a `dpk_` key naming a bare
   deployment/external → 403 "external keys must call a routing name".
   Internal-key/session traffic may still name a deployment directly.

**Dual-channel metadata attribution (don't drop either side):** the routing
name and trace ids ride BOTH `data["metadata"]` and `data["litellm_metadata"]`,
and the metering/trace callbacks read them MERGED. On the `/v1/messages`
(Anthropic) surface LiteLLM's chat-completions bridge treats plain `metadata`
as the Anthropic-native user param and rebuilds the request, so only
`litellm_metadata` survives to the logging callback (verified live 2026-07-16).
Removing either write silently kills routing attribution + trace ids on one
API surface.

**`devproof_direct` — internal-only escape hatch:** under name shadowing two
internal callers must address a deployment/external DIRECTLY without recursing
into a same-named routing — the CP warmup (`warmDeployment`; a routing must not
hold/reroute it or the wake deadlocks) and the `_classify` sub-call. Both send
`devproof_direct`; the hook honors it ONLY for `devproof_internal` callers (an
external caller's marker is ignored → a bare non-routing name still 403s).

Rule edits touch only the DB row — **no gateway config sync, no rolling
reload** (live within the cache TTL). Routing create/delete triggers one
gateway sync purely so the name appears in `/v1/models` (discovery UX). The
generated `model_list` entry points at a blackhole `api_base`
(`http://devproof-routing-unresolved.invalid`) — never hit because the hook
rewrites first (spike-verified); reaching it is a loud hook-bug signal, never
silent misrouting. **The blackhole entry is SKIPPED when the routing name
collides with a deployment/external `model_name`** (fix wave E) — two same-named
entries would form a LiteLLM load-balance group that round-robins real traffic
onto the unreachable blackhole; exactly one real `/v1/models` entry results.

### Spike evidence (live, 2026-07-16, this cluster)

- Rewriting `data["model"]` in `async_pre_call_hook` routes correctly on BOTH
  `/v1/chat/completions` and `/v1/messages`; the name did not need to exist in
  `model_list` (hook runs before model validation). Client sees the requested
  routing name echoed in the response.
- After rewrite, `gateway_usage.model` records the RESOLVED deployment
  (`model_group` follows the rewrite) — per-deployment stats/pricing stay
  correct unchanged; routing attribution therefore needs the metadata stamp.
- Hook can call the gateway itself (classify) — clean async self-call, no
  deadlock.
- qwen-medium (reasoning model, temperature 0) classified both test prompts
  correctly; one answer was `code (programming related)` → label extraction
  MUST be prefix/word-boundary matching, not equality.
- Classifier against an Idle deployment fails (internal key bypasses the
  hold) → label unmatched → fall-through; reproduced live. Hence the classify
  wake requirement below.
- The narrowed hold-bypass (hold applies to internal traffic when
  routing-resolved): internal-key request against an Idle model held, fired
  the wake pipeline, completed 200 in 13.4s; CP warmup (direct model name, no
  flag) kept bypassing — no deadlock.
- Reject via HTTPException from the hook returns a structured 403.

## Data model (migration 036)

```sql
CREATE TABLE IF NOT EXISTS routings (
  name       TEXT PRIMARY KEY,          -- gateway model-namespace member
  rules      JSONB NOT NULL DEFAULT '[]',
  terminal   JSONB NOT NULL,            -- {"action":"route","target":...} | {"action":"reject"}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE gateway_usage ADD COLUMN IF NOT EXISTS routing TEXT;      -- NULL = direct call
CREATE INDEX IF NOT EXISTS gateway_usage_routing_time ON gateway_usage (routing, created_at);
CREATE TABLE IF NOT EXISTS routing_rejects (
  id           BIGSERIAL PRIMARY KEY,
  routing      TEXT NOT NULL,
  api_key_id   TEXT,
  workspace_id TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS routing_rejects_routing_time ON routing_rejects (routing, created_at);
```

`trace_subscriptions` gains a nullable `routing TEXT` column; a subscription
row targets exactly one of `deployment` / `routing` (both become nullable,
CHECK enforces one set).

Routings are **global** (Serving is never workspace-scoped). No versioning;
edits apply live. `updated_at` self-bumped in repo.ts (migration-035
convention). Name uniqueness is enforced only **among routings** (PK + 409),
plus DNS-1035 and the reserved name `external`. Routings **may shadow**
deployment/external names in both directions (fix wave E): the cross-namespace
collision checks were removed from `POST /v1/routings`, `POST /v1/deployments`,
and `POST /v1/deployments/external` (`src/server.ts`) — a same-named routing
transparently fronts the deployment because routing resolution runs first.

## Rule & condition semantics

`rules` = ordered array of `{conditions: [...], target: "<name>"}`.
Conditions AND together; empty conditions = always match. First match wins.
`terminal` fires when nothing matched: `route` (the "always route to model X"
minimal routing is a terminal route with zero rules) or `reject` (403
`{"error":"no routing rule matched","routing":<name>}`).

Condition types (validated by pure `control-plane/src/routing-rules.ts`):

1. **cost** — `{type, ledger: "billed"|"real", scope: "key"|"workspace"|
   "agent"|"routing"|"target", op: "<"|">=", threshold: number, window:
   {kind: "month"|"day"|"rolling", hours?}}`.
   **Deployment costs only (fix wave M, user decision 2026-07-16)** — cost
   conditions never count session-pod/env time, only token spend (+
   deployment/pool time for `target`'s real ledger), matching every console
   cost surface exactly. SQL SUM at evaluation: `key`/`workspace`/`agent`/
   `routing` read `gateway_usage` ONLY (billed_cost/real_cost, filtered by
   api_key_id/workspace_id/agent_id/routing); `target` reads the rule
   target's `gateway_usage` (billed) or its `cost_entries` deployment/pool
   time-kinds (real) — that leg stays because pool/deployment time IS a
   deployment cost. The old `workspace` (`cost_entries` env_pod/session_time)
   and `agent` (`cost_entries` JOIN sessions session_time) legs are GONE —
   they used to silently double an agent's number against every displayed
   figure (36.41 shown vs. 62.41 enforced, live bug 2026-07-16) — rejecting
   requests on a number the user could never see. Cached ~30s per
   (condition, scope-key) with the bounded-cache eviction pattern
   (`CACHE_MAX`). Thresholds are enforcement brakes, not accounting — cache
   lag means a few requests of overshoot at the edge (same tolerance as key
   revocation). `key`/`agent` scopes never match when the request carries no
   such attribution → fall through. Calendar windows (`month`/`day`) are UTC
   (matching `gateway_usage`/`cost_entries` timestamps and the Usage page).
   **Settings coupling (fix wave G):** a cost condition whose ledger is
   disabled never matches — `billed` requires billing.enabled, `real` requires
   cost tracking enabled (`app_settings.data.costs`, gateway caches it ~30s,
   stale-tolerant). When disabled the condition is UNMATCHED and the trace
   value says WHY (`"skipped: billing disabled"` / `"skipped: cost tracking
   disabled"`, ok=false) — the SQL SUM is skipped entirely. The validator is
   uncoupled (rules persist across settings toggles); the console editor gates
   the type/ledger (see Console).
2. **tokens** (fix wave G) — `{type, scope: "key"|"workspace"|"agent"|
   "routing"|"target", op: "<"|">=", threshold: integer ≥ 0, window:
   {kind: "month"|"day"|"rolling", hours?}}`. Like `cost` minus the ledger:
   SQL SUM of `COALESCE(sum(tokens_in),0)+COALESCE(sum(tokens_out),0)` from
   `gateway_usage` ONLY (all scopes — key→api_key_id, workspace→workspace_id,
   agent→agent_id, routing→routing, target→model; tokens live only in
   `gateway_usage`, no `cost_entries` ledger). Tokens are **always metered** —
   independent of cost/billing settings (no settings coupling). Same ~30s
   bounded cache as cost (keys type-prefixed so `cost`/`tokens` never collide);
   `key`/`agent` scopes without attribution fall through; windows UTC.
3. **context** — `{type, op: "<="|">", tokens}`. Estimated request size:
   serialized length of messages + system + tools ÷ 4. Deterministic, cheap;
   precision is adequate for the 32k-local vs big-context use case.
4. **available** — `{type}` (no params; refers to the rule's own target).
   True when the target is servable: local deployment phase Ready or Idle
   (Idle wakes via the hold — counts as available), external endpoint exists.
   Failed/absent → false → fall through. Enables "premium first, local
   fallback" tables.
5. **time** — `{type, days: ["mon"...], from: "HH:MM", to: "HH:MM", tz}`.
   Overnight windows (from > to) wrap.
6. **split** — `{type, percent}`. Random per request; no stickiness in v1.
   Canary = `[split 10] → new-model` with the next rule catching the rest.
7. **classify** — `{type, deployment, labels: {label: description}, match:
   [labels]}`. The classifier `deployment` may be **local or external** (fix
   wave D — an external name has no `model_routing` row, so the evaluator
   calls straight through with no wake/hold). Default form example is a yes/no
   split (`{yes: "…", no: "anything else"}`, match `[yes]`). The hook sends
   the request's last user message (truncated to 2000 chars) to the classifier
   THROUGH the gateway (internal key + `devproof_direct`, self-call —
   spike-verified), prompting for exactly one label, temperature 0,
   `max_tokens: 512` (reasoning models think before answering; a small cap
   starves the label — observed live). Label extraction is prefix/word-boundary
   matching over known labels; unknown output → false → fall through (never a
   500). The classification result is cached per request during evaluation so
   several rules share one classifier call.
   Classifier sub-calls are metered normally and stamped with the routing
   name — classification overhead bills to the routing (model = classifier
   deployment, so deployment stats stay truthful).
   - **Idle classifier:** the classify path fires the wake pipeline
     (wake_requests INSERT + NOTIFY, idempotent) and treats the condition as
     unmatched for THIS request — self-heals in ~40s. Reproduced live: without
     this, an Idle classifier never wakes (internal key bypasses the hold).
   - Console hint on the classify rule form: prefer a small non-reasoning (or
     reasoning-off) deployment — a CPU reasoning model measured ~11s per
     classification (thinking dominates).

**Evaluation errors** (PG blip, classifier timeout): the condition counts as
NOT matched — rule skipped, table continues, terminal always applies.
Deterministic, never fail-500. Deliberate consequence: with a reject terminal
an infrastructure outage rejects rather than over-spends — budgets stay hard.

## Gateway hook changes

Block order in `async_pre_call_hook`: **routing resolution → wake-hold →
sanitizer → reasoning default → thinking strip → trace capture**. The
wake-hold bypass narrows from "internal key" to "internal key AND NOT
routing-resolved" (a local flag set during resolution — never survives to
warmup traffic, which always calls deployment names directly; deadlock
invariant preserved, spike-verified). Anthropic-dialect CLI clients tolerate the hold: default
request timeout 600s (`API_TIMEOUT_MS`) vs 300s hold cutoff and ~13–40s
measured wakes; 503/timeouts retry with exponential backoff (default 10
attempts), and retried attempts re-enter the hold idempotently.

Metering callbacks (`async_log_success_event` / `async_log_failure_event`)
read `devproof_routing` from `litellm_params` metadata MERGED across
`metadata`+`litellm_metadata` (dual-channel, above) and stamp
`gateway_usage.routing`. The 027/031 triggers are untouched — token costs keep
pricing off the resolved model; session totals keep ticking.

Reject path: best-effort INSERT into `routing_rejects` before raising the 403
(mirrors the wake-request INSERT on the same code path).

## Control plane changes

- `GET/POST/PATCH/DELETE /v1/routings` (+ `GET /v1/routings/:name`) live in
  `src/server.ts` (not a `routings-api.ts`), global, not workspace-guarded.
  Validation via pure `src/routing-rules.ts`: shapes, targets exist
  (deployment ∪ external), classifier is a deployment OR external endpoint
  (fix wave D). Name uniqueness is AMONG routings only (fix wave E — no
  cross-namespace collision checks). DELETE 409s while any agent's latest
  version references the routing ("referenced by agent(s): … — point them at
  another routing first").
- Create/delete → gateway sync (blackhole `model_list` entries in
  `buildGatewayConfig`, skipped on a name collision). Rule edits → DB only.
- Agent create/edit: the `routing` field (fix wave C) accepts routing names
  ONLY — 400 `routing must reference an existing routing` otherwise.
- **Launch gate:** routing-referenced sessions skip park-on-phase and launch
  immediately; their gateway calls ride the (now-applicable) hold. No
  fail-fast 409 at create — the outcome is request-dependent by design; a
  rejected turn fails in-band with `failure_detail` carrying the gateway 403
  message, session stays resumable.
- The CLI auto-compact window env (renamed `DEVPROOF_CONTEXT_WINDOW` at dev29)
  for routing-referenced sessions = MIN
  `effectiveContextTokens` across the routing's reachable local targets
  (conservative: compaction fires before any possible target overflows);
  externals count as 200k. No reachable local targets → no cap env.
- Deleting a deployment/external that a routing references: allowed, but the
  delete response/console confirm lists the affected routings; the target
  then evaluates as unavailable (`available` condition false; a rule
  targeting it without an `available` condition falls through — resolution
  treats a missing target as unmatched rule) and a terminal route to a
  missing target rejects with a distinct 503 "routing target unavailable".

## Console

- New top-level **Routings** page under Serving (nav next to Deployments):
  list = name (clickable → detail), rule count, "No match" (route to <model> /
  reject (403), raw stored value), last modified; shared `Pager` (100/page).
  Row delete confirms + is blocked (409) while any agent references the routing.
- Detail `/routings/[name]`, tab order **Overview | Rules | Connect | Trace**
  (fix wave J: the former *Stats* tab is renamed *Overview* and moved first —
  it's the default selection on open):
  - *Rules*: ordered rule rows (reorder/add/remove), condition builder per
    row (type dropdown → type-specific fields), "No match" terminal picker.
    Shared `Modal`/`Field`/`ConfirmDialog`; no browser prompts. Saves PATCH
    the routing (no restart confirm needed — nothing rolls). Target `<select>`s
    UNION the live target list with the rule's/terminal's own stored value
    (`optionsFor`) so an orphaned reference (deleted target) still renders
    correctly instead of silently showing the first option. **Cost gating
    (fix wave G):** the type dropdown offers `cost` only when at least one
    ledger is enabled (page fetches `/v1/settings`); a cost row's ledger select
    lists only enabled ledgers; an already-persisted disabled-ledger cost
    condition still renders, with a warning ("billing disabled — this condition
    never matches"). The `tokens` type is always available (tokens are always
    metered). **Fix wave L addendum:** a muted line near the top shows the
    routing's `minContextTokens` ("min context window: N tokens — drives
    session auto-compaction"); every target `<select>` on the page (rule
    "Route to", the terminal's route-to, and the classify condition's
    deployment select) shows the selected target's context window as muted
    text beside it ("· N tok"), from a name→window map (`tabs.tsx`, built off
    the already-fetched deployments list — locals: `effectiveContextTokens`
    falling back to `contextTokens`; externals: `contextTokens`); unknown
    target shows nothing.
  - *Connect*: the existing `ConnectTab` component moved (model = routing
    name). Small-context warning uses the MIN served context across reachable
    local targets. **Removed from deployment detail.** Fix wave J adds a
    "Gateway endpoint" card at the top (curl snippet, model = routing name;
    "every routing is called the same way through the gateway" hint) — moved
    here from deployment Overview, which no longer shows it (clients now call
    routings, not deployments directly).
  - *Overview* (fix wave J rename of *Stats*, now first + default): same
    windows/polling/chart as deployment Overview's stats section, filtered by
    the `gateway_usage.routing` column: requests, tokens in/out, billed/real
    cost, PLUS outcome breakdown per resolved target and reject count (from
    `routing_rejects`). **Two stacked breakdown charts (fix wave H)** replace
    the "Resolved targets" card: "Requests by target" (per resolved model per
    bucket) and "Requests by rule" (per matched `routing_rule` index + a
    rejects series), both honoring the window/api_key/agent filters; the
    reject count stays visible above the target chart. Charts render only when
    the payload carries the breakdowns (deployment Overview's stats never do).
  - *Trace*: same live-trace panel; subscriptions keyed by routing (SSE stream
    `/v1/routings/:name/trace/stream`); events additionally carry resolved
    target + matched rule index + a per-visited-rule **evaluation detail**
    (each visited rule's verdict and, per condition, the full configured
    condition + its evaluated value + ok — expandable from a chip on the
    request row; "why did this request land there"). Rules after the first
    match and conditions after the first failing one are NOT visited, so never
    shown. Delivery is **exactly-once** per subscriber URL (`_emit_trace_multi`
    unions a deployment+routing window's shared CP callback). The `key` cost/
    tokens scope renders as "api key" everywhere.
- Deleting a deployment/external whose name a routing targets is allowed; the
  deployments-page delete confirm warns "Referenced by routing(s): … — their
  rules will treat it as unavailable."

## Error handling summary

- PG blip in hook: stale-tolerant rules cache (serve last-known on error);
  fresh-data conditions unmatched; terminal applies. Never-cached routing
  during an outage → blackhole entry → clear 5xx (auth fails closed first in
  practice).
- Reject: 403 structured (live-verified shape). External key + bare model
  name: 403 "'<model>' is not a routing - external keys must call a routing name".
- Deleted routing mid-flight: config sync removes the name → 400 invalid
  model; in-flight requests finish on their resolved target.

## Scale posture

Per-request: one TTL-cached PG read (pattern live at scale), cost/token
conditions 30s-cached per scope-key + a 30s settings cache (bounded caches),
classify only when used. All
caches per-process; gateway HPA (2→10) scales horizontally; PG QPS bounded by
TTLs, not request rate. Stats queries are time-window-bounded like deployment
stats.

## Testing & verification

- Unit (Node test runner): `routing-rules.ts` — condition combos/AND,
  ordering, terminals, window math incl. overnight wrap, validation errors;
  `gateway-config.test.ts` — blackhole entries; API tests — CRUD, collision
  both directions, agent create with routing name (swept `t-` naming).
- Migration 036: idempotent, boot-safe, no backfill (NULL routing = direct
  call, historically correct).
- Live verification checklist (hook has no offline harness — repo
  convention):
  1. Rewrite routes on both API surfaces (re-run of spike).
  2. Classify both branches (route + reject) against a warm classifier.
  3. Idle classifier fires wake and falls through; self-heals next request.
  4. Internal-key session traffic held + woken via routing (spike re-run).
  5. Streaming request through a routing (residual — not yet spiked).
  6. External `dpk_` key: routing name OK, bare deployment name 403
     (residual — not yet spiked).
  7. Cost rule flips behavior when a threshold is crossed (seed
     `gateway_usage`).
  8. Reject terminal 403 + `routing_rejects` row + Stats reject count.
  9. Console: build, all pages 200, Rules/Stats/Trace/Connect exercised,
     Connect gone from deployments.

## Out of scope (v1)

- Split stickiness (per-session/user affinity).
- Per-key routing pinning (key ↔ routing ACLs beyond routing-only
  enforcement).
- Nested routings (a routing targeting a routing) — validation rejects.
- Classifier prompt customization beyond labels+descriptions.
- LiteLLM-native fallbacks/model-groups as an internal optimization.

## Amendments (2026-07-16, post-verification)

- **Agents are routings-only** (supersedes the "either a model or a routing"
  decision above): `POST /v1/agents` and `POST /v1/agents/:id/versions`
  (`control-plane/src/agents-api.ts`) now 400 `model must be a routing name`
  unless the value resolves via `repo.getRoutingByName`. The app is
  unreleased, so this is a hard cutover, not an additive option — no legacy
  shim for agents pointing directly at a deployment/external name. Console:
  the agent form's Model field is relabeled "Routing" (hint: "requests route
  through the routing's rule table"); its stale-value fallback option reads
  "(missing routing)" instead of "(not deployed)"; the agents list/detail
  pages source `models` from `/v1/routings` only (the `/v1/deployments` fetch
  used only for that prop was dropped from both pages).
- **Terminology + a real console data bug**, found via live click-through
  testing: the list page's "No match" column and the routing detail page's
  terminal selector must show the SAME resolved value for the SAME routing.
  Root cause: the detail page's Rules tab renders the rule/terminal target as
  a controlled `<select>` whose options came ONLY from the currently-live
  `/v1/deployments` list. A routing may legitimately reference a deployment
  or external endpoint that was deleted AFTER the routing was created/edited
  (deletion of a referenced target is explicitly allowed elsewhere in this
  spec) — when the stored target string has no matching `<option>`, the
  browser silently renders the FIRST option instead, showing a target that
  isn't what's actually stored. The list page renders the raw stored string
  directly and was never affected — only the detail page's dropdowns lied.
  Fix: the Rules tab now unions the live target list with the rule's/
  terminal's own current value before rendering `<option>`s, so an orphaned
  reference still displays correctly (`console/app/routings/[name]/rules.tsx`,
  `optionsFor`). Wording aligned across both surfaces: "No match" is the
  shared label (list column header; detail card heading renamed from "When
  no rule matches"); values read "route to <model>" / "reject (403)" in both
  the list cells and the Rules tab's terminal action options.
- **Agent reference field renamed `model` → `routing` (fix wave C, 2026-07-16)**:
  since agents reference routings only, the field that stored an agent's target
  is now called `routing` at EVERY layer the agent reference passes through —
  DB (`agent_versions.routing`, migration 037: guarded column rename +
  idempotent rewrite of parked `pending_launches.payload.config` snapshots),
  CP internals (`AgentConfig.routing`, the orchestrator `startSession` config
  type, `session.config.routing`, `session-actions` `launch.config.routing`),
  the public `/api` and console `/v1` create/edit payloads, and the console
  (agents list column "Routing", detail chip, agent form key, session detail
  panel). NO backwards compatibility / dual-read / legacy-key acceptance — the
  app is unreleased. Create/version validation now 400s
  `routing must reference an existing routing`. This DELIBERATELY diverges from
  the Anthropic-API mirror on this one field. Two boundaries held firm: the
  serving side keeps `model` everywhere (gateway wire protocol, `gateway_usage`,
  deployments, `model_routing`, the `pending_launches.model` match column, and
  the launch-gate `waitingFor`/`session.waiting` payloads — "which
  model/deployment are we waiting on" is a serving concept), and the runner Job
  env `model:` key is unchanged (dev27 is frozen; it now carries
  `session.config.routing`). Verified: `tsc` + full 412-test suite green; live
  E2E created a routing + agent via the API with `routing:`, confirmed the
  `model:` key is rejected, and ran a session to completion.
- **Classifiers may be external endpoints too (fix wave D, user decision
  2026-07-16)**: the `classify` condition's `deployment` field was validated
  against local deployments only, but the gateway evaluator already handled
  externals correctly — `_routing_state(dep)` (`deploy/gateway/litellm.yaml`)
  returns `None` for any name with no `model_routing` row, which is exactly
  the external case, and the `None` path calls straight through with no wake
  and no hold. So the restriction was console/validator-only, not a real
  limitation. `control-plane/src/routing-rules.ts` now accepts a local OR
  external deployment name (error: "must be a deployment or external endpoint
  name"); the console classifier dropdown (`rules.tsx`) now lists all targets,
  not just local ones. The non-reasoning-classifier hint stays as-is — it
  applies equally to a small external model.
- **Routings may SHADOW deployment/external names (fix wave E, user decision
  2026-07-16)**: the previous name-uniqueness rule (a routing could not take a
  deployment/external name and vice-versa) is GONE in both directions. A routing
  MAY share a deployment's or external endpoint's name to transparently front it
  (e.g. routing `qwen-medium` with rules, terminal → deployment `qwen-medium`).
  For all NORMAL traffic, routing resolution runs FIRST in the hook, so a
  same-named routing shadows the deployment; agents and external keys are
  routings-only anyway. Removed: the four collision checks — `POST /v1/routings`
  no longer checks deployments/externals, and `POST /v1/deployments` /
  `POST /v1/deployments/external` no longer check routings
  (`control-plane/src/server.ts`). Kept: routing-name uniqueness AMONG routings
  (PK + 409), DNS-1035, and the reserved name `external`.
  - **Gateway config skips the blackhole on collision** (`gateway-config.ts`):
    when a routing name equals a deployment/external `model_name` already
    emitted, the blackhole entry is NOT pushed — two same-named entries would
    form a LiteLLM load-balance group and real requests to the resolved target
    would round-robin onto the unreachable blackhole. Exactly ONE `/v1/models`
    entry (the real target) results.
  - **`devproof_direct` — internal-only escape hatch** (`custom_callbacks.py`):
    with shadowing, name-based disambiguation is gone, but two internal callers
    still must address a deployment/external name DIRECTLY without recursing into
    a same-named shadowing routing: the CP warmup (`warmDeployment` sends
    `metadata.devproof_direct` — a routing must NOT hold/reroute it or the wake
    deadlocks, scale-to-zero invariant 2) and the `_classify` sub-call (adds
    `devproof_direct` alongside its `devproof_routing`/`-2` attribution stamp — a
    routing would otherwise loop). The hook honors the marker (in either
    `metadata`/`litellm_metadata` channel) ONLY when the caller is INTERNAL
    (`devproof_internal`); an external caller's marker is IGNORED — a bare
    non-routing name still hits the routing-only 403.
  - **Known/accepted:** a same-named routing and deployment share a trace key —
    the Trace/Stats window for either shows the union of both. Fine while
    workspaces are attribution-only.
- **`tokens` condition (fix wave G, user decision 2026-07-16)**: a new condition
  type that thresholds on TOKEN consumption, independent of any cost/billing
  settings (tokens are always metered). Shape mirrors `cost` minus the ledger:
  `{type: "tokens", scope: "key"|"workspace"|"agent"|"routing"|"target",
  op: "<"|">=", threshold: integer ≥ 0, window: {kind, hours?}}`. Validator
  (`control-plane/src/routing-rules.ts`) + unit tests. Gateway
  (`deploy/gateway/litellm.yaml`) `_consumed_tokens` sums
  `COALESCE(sum(tokens_in),0)+COALESCE(sum(tokens_out),0)` from `gateway_usage`
  ONLY (all scopes; no `cost_entries`), sharing the cost cache dict with
  type-prefixed keys; `_cond_ok` gains the `tokens` branch (trace value = the
  summed int). Console `rules.tsx` COND_DEFAULTS + editor row (scope/op/int
  threshold/window, mirroring cost minus ledger) + trace formatter
  (`deployments/[name]/trace.tsx`). Verified live 2026-07-16 on routing `test`:
  a `tokens scope routing >= 1 (day)` rule matched with trace value `1496208`
  (ok); raising the threshold above consumption flipped it to no-match →
  terminal.
- **Cost conditions gated on cost/billing settings (fix wave G, user decision
  2026-07-16)**: a `cost` condition on a disabled ledger can never match, so
  both the editor and the gateway make that explicit. **Console** — the routing
  detail page (`console/app/routings/[name]/page.tsx`) additionally fetches
  `GET /v1/settings`; the Rules tab offers the `cost` type only when
  `enabled || billing.enabled`, lists only enabled ledgers within a cost row,
  and renders an already-persisted disabled-ledger cost condition with a
  warning ("billing disabled — this condition never matches" / "cost tracking
  disabled — …") rather than hiding it. **Gateway** — `_cost_settings()` caches
  `data->'costs'` from `app_settings` (~30s, stale-tolerant); the `cost` branch
  of `_cond_ok` short-circuits to `(value="skipped: billing disabled" |
  "skipped: cost tracking disabled", ok=False)` before the SQL SUM. The
  validator stays uncoupled (rules persist across toggles). Verified live
  2026-07-16 (both ledgers disabled in settings): a `cost billed` rule on
  routing `test` traced `verdict: no-match`, value `"skipped: billing
  disabled"`.
- **Routing analytics + session deployment visibility (fix wave H, user
  decision 2026-07-16)** — migration `038_routing_analytics.sql` (idempotent):
  `gateway_usage.routing_rule INT` (matched rule index; `-1` terminal/no-match,
  `-2` classifier sub-call, NULL = direct/pre-feature) and `gateway_usage.turn
  INT`; `sessions.last_model TEXT`, stamped by the SAME session-totals
  accumulate trigger that ticks tokens/billed_cost (full `CREATE OR REPLACE` of
  031's function + a `last_model = NEW.model` line — later file wins; 027/031
  untouched). Attribution plumbing: the gateway metering INSERT
  (`deploy/gateway/litellm.yaml`) gains `routing_rule` (from md
  `devproof_routing_rule`) and `turn` (from the internal-key auth metadata
  `devproof_turn`, parsed as an INT in `user_custom_auth` from a new
  `x-devproof-turn` header — asyncpg is strict about int4 params); the CP
  renders `X-Devproof-Turn: <turn>` per turn Job in `ANTHROPIC_CUSTOM_HEADERS`
  (`orchestrator.ts`; runner image untouched).
  - **Routing Stats charts**: `GET /v1/routings/:name/stats` additionally
    returns `targetBuckets`/`targetSeries` (requests per resolved model per
    bucket) and `ruleBuckets`/`ruleSeries` (per matched rule + a rejects
    series), lean (only buckets with data; a `series` key list per chart for
    stack order), honoring the api_key/agent/window filters. Rejects have only
    api_key attribution — an agent filter omits the rejects series;
    `__internal__` matches NULL-key rejects. `repo.routingBreakdownBuckets`
    follows the deploymentStats bucketing idiom. Console `stats.tsx` renders
    two `UsageBars` stacked charts (palette + `seriesFrom` in `usage/shared.tsx`;
    rule labels: `0→"Rule 1"`, `-1→"No match (default)"`, `-2→"classifier"`,
    `null→"(pre-feature)"`, `rejects→"rejected"`), keeping the reject count
    visible.
  - **Session deployment visibility**: the session header gains a chip showing
    `sessions.last_model`, carried live on the SSE totals frame
    (`session-sse.ts` → `use-session-live.ts` `Totals.lastModel`, same tick as
    tokens). The step panel (`panels.tsx` `EventPanel`) lazily fetches
    `GET /v1/sessions/:id/deployments?turn=N` (workspace-scoped, in
    `agents-api.ts`; turn derived client-side from the last `user` event's
    `payload.turn` at/before the step) and shows the deployment(s) whose usage
    timestamps fall within the step's `[start-2s, end+2s]` window, falling back
    to the whole turn's distinct models labeled "turn" when no row is contained.
  - **Trace formatter nit (wave G leftover)**: `deployments/[name]/trace.tsx`
    `condLine` now renders a skipped cost/tokens value (`"skipped: …"`) as just
    the reason, muted, with no `spent`/`used` metric prefix.
  - Verified live 2026-07-16: 5 completions through routing `test` (internal
    key) stamped `routing_rule=-1, turn=0`; older rows NULL; Stats endpoint
    returned both breakdowns and filters changed them (agent filter dropped
    rejects); a real session (agent→routing `test`→qwen-medium) set
    `last_model=qwen-medium` and `/deployments?turn=0` returned the resolved
    model. Full 419-test suite + double-boot migration green.
- **Resolution order is routing-first, everywhere (fix wave I, 2026-07-16)**:
  `main.ts`'s `modelPhase` checked deployments before routings, so a routing
  that shadows a deployment of the same name (allowed by design — `POST
  /v1/routings` explicitly skips the collision check) silently resolved as
  the deployment instead — wrong `contextWindow` and wrong launch gating
  (parks on the deployment's phase instead of always launching via the
  routing branch). Fixed by moving the routing lookup first; the per-target
  reads inside the routing branch (direct `kube.get` of reachable local
  targets) and the deployment branch's warmed-bit self-heal are unchanged.
  Verified live: routing `qwen-medium` created shadowing deployment
  `qwen-medium` (Idle), session on an agent pointed at it launched
  immediately with no `session.waiting` event and completed via the
  gateway wake. Full 420-test suite green.
- **Auto-compact trigger was blind on the bridged `/v1/messages` stream (fix
  wave K, 2026-07-16)** — a pre-existing platform bug the routing work
  surfaced (sessions overflowed a 32k model despite
  the auto-compact window env — now `DEVPROOF_CONTEXT_WINDOW` — set to 32768).
  K1 (confirmed statically against
  the legacy bundled CLI 2.1.202 and empirically with a mock backend + that
  CLI): the CLI derives its context size — the auto-compact trigger
  `SKa(contextTokens,…)` — from `Xie(usage) = input_tokens +
  cache_creation_input_tokens + cache_read_input_tokens + output_tokens` of
  the last assistant message, whose `usage` is seeded from the SSE
  `message_start`. LiteLLM's chat-completions bridge
  (`use_chat_completions_url_for_anthropic_messages`) hardcodes
  `message_start.usage.input_tokens=0` (adapter
  `_create_initial_usage_delta`, verified live) and delivers real counts only
  in the final `message_delta`, which the loop accumulator then overwrites
  `input_tokens` from — so the CLI's counter read ~0 and never compacted.
  Empirically: a mock reporting a large `message_start.input_tokens` fires the
  CLI's `{"subtype":"status","status":"compacting"}`; reporting 0 does not.
  Fix (K2): a new `async_post_call_streaming_iterator_hook` in the gateway's
  `custom_callbacks.py` — the hook receives **already-serialized `bytes` SSE
  frames, not dicts** (learned the hard way) — rewrites `input_tokens` in
  BOTH `message_start` and the final `message_delta` up to a prompt estimate
  (`_estimate_tokens`, serialized prompt ÷ 4), scoped to SANITIZE_MODELS
  (named-anthropic streams already stream correct usage and are untouched).
  Best-effort, never fails a stream. Pure cores `_inject_prompt_estimate` /
  `_rewrite_sse_usage` / `_bump_usage_dict` are covered in
  `deploy/gateway/test_custom_callbacks.py`. K3 verified live: message_start
  `input_tokens` 0→16 at the wire through the gateway; thinking blocks still
  render; non-stream calls unaffected; `gateway_usage` metering still records
  the real backend `prompt_tokens` (17, not the estimate 16) so the 027
  trigger stays the sole writer of session token totals — no double-count.
  DON'T REGRESS: deleting the stream hook silently re-disables ALL session
  auto-compaction. Gateway-only change (config `custom_callbacks.py` +
  offline harness); no CP/migration touched.
- **Mandatory context-window metadata on external endpoints (fix wave L,
  2026-07-16, user decision)**: the platform had no idea how big an external
  model's window is — an external-only routing's `minContextTokens` (and
  therefore the session auto-compact cap) was always `null`. Migration `039`
  adds `external_deployments.context_tokens INT`, backfills every existing row
  to `262144`, then sets the column `NOT NULL` — no legacy fallback, matching
  the "unreleased app, no back-compat" posture used throughout this feature.
  `POST /v1/deployments/external` and `PATCH /v1/deployments/external/:id`
  require an integer `contextTokens` 1024..2000000 (`400 "contextTokens
  required (1024-2000000)"` otherwise); the deployments projection exposes it
  as `contextTokens`. Min-window now folds in externals: `routing-rules.ts`
  gained a sibling `reachableTargets(spec)` (all targets, local + external,
  deduped — unlike `reachableLocalTargets` it doesn't filter by kind) used by
  both `main.ts`'s `modelPhase` routing branch and `GET /v1/routings/:name` to
  add reachable externals' `context_tokens` into the same min as the local
  targets' `effectiveContextTokens`; the response's `reachableTargets` field
  stays locals-only (console back-compat) — only the min changed. Console: the
  Connect tab's small-context warning keyed off `reachableTargets.length` to
  guess local-vs-external kind, which no longer works once externals feed the
  min with zero local targets — fixed by keying off `minContextTokens != null`
  instead (`routings/[name]/tabs.tsx`). The deploy/edit modal
  (`deployments/deploy-modal.tsx`) gained a required "Context tokens" field
  directly after Reasoning in the remote/external form (deploy AND edit paths
  of the shared modal), prefilled from the row on edit, Save disabled without a
  valid value; the deployment detail external Overview card gained a Context
  row. Addendum (L8, same wave): the routing Rules tab now shows the routing's
  `minContextTokens` as a muted line near the top ("min context window: N
  tokens — drives session auto-compaction"), and every target `<select>` (rule
  "Route to", the terminal's route-to, and the classify condition's deployment
  select) shows the currently selected target's context window as muted text
  beside the select ("· N tok"), sourced from a name→window map built in
  `tabs.tsx` from the already-fetched deployments list (locals:
  `effectiveContextTokens` falling back to `contextTokens`; externals:
  `contextTokens`); unknown target renders nothing. Verified live: `glm-5.2`
  (a pre-existing external row) backfilled to `262144` tokens; a throwaway
  routing targeting only `glm-5.2` reported `minContextTokens: 262144`
  (deleted after); routing `test` unchanged at `32768` (qwen-medium still the
  min); the edit dialog showed Context tokens prefilled `262144`; creating an
  endpoint without the field was blocked in the UI (Deploy button disabled)
  and 400s via curl; the Rules tab on `qwen-medium` showed the min-window line
  and the per-select hint updated live when switching the terminal target
  between `qwen-medium` (32,768 tok) and `glm-5.2` (262,144 tok). Full
  423-test suite green (added: 1 routing-rules unit test for
  `reachableTargets`, 1 server contextTokens-validation test, 1 routings-api
  external-min test, plus payload fixups to existing external-endpoint tests
  for the now-mandatory field) and `tsc --noEmit` clean.
- **Cost conditions are deployment costs only (fix wave M, 2026-07-16, user
  decision)** — found via live debugging: an `agent`-scope cost rule
  (`cost agent < 44 (rolling 24h)`) rejected requests at ~62.41 while every
  console cost surface for that agent showed 36.41 — the enforced number
  silently summed `gateway_usage` (token spend, 36.41) PLUS `cost_entries`
  session-time/env-pod rows (26.00), a total the user had no way to see
  before being rejected by it. Fix: `_consumed_cost`'s `workspace` and
  `agent` scopes now read `gateway_usage` ONLY, matching `key`/`routing`
  (already token-only); the `cost_entries` env_pod/session_time legs for
  those two scopes are GONE. `target`'s real-ledger leg is UNCHANGED — it
  reads `cost_entries` pool_pod/deployment_time, which ARE deployment
  costs, not session/env time. Net rule: routing cost conditions enforce
  deployment costs only (token spend via `gateway_usage`, plus deployment/
  pool time for `target`); session-pod and environment time never count
  toward a routing reject, for any scope. Verified live: after the fix and
  a gateway redeploy, `agent_hbw02te7tq97`'s rolling-24h `gateway_usage`
  billed_cost was 36.41 (< 44) while the now-removed `cost_entries`
  session-time leg alone was 26.00 (36.41+26.00=62.41 ≥ 44, confirming the
  exact double-count) — cost/billing tracking had to be temporarily
  re-enabled (`app_settings` had it off in this dev DB, which skips `billed`
  conditions entirely per the fix-wave-G settings coupling) for the ledger
  to evaluate at all; with it on, an agent-attributed request against
  routing `test` (rule 0: `cost agent < 44 (rolling 24h) → glm-5.2`,
  terminal reject) matched rule 0 and got a 200, with the new
  `gateway_usage` row recording `model=glm-5.2, routing=test,
  routing_rule=0, agent_id=agent_hbw02te7tq97`; settings were restored to
  their prior (disabled) state afterward. Harness (`test_custom_callbacks.py`)
  is unaffected — the cost SQL is deps-injected and not offline-driven — all
  checks stayed green.
