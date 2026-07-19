# Deployment Monitoring & Live Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deployment detail page (`/deployments/[name]`, tabs Overview | Stats | Trace) with a realtime token-consumption graph and an ephemeral live request/response trace window, working identically for local and remote models.

**Architecture:** Every request already flows through the LiteLLM gateway (`custom_callbacks.py` in the `litellm-config` ConfigMap). We (1) extend its metering to ALL traffic with agent/session attribution via headers, (2) add a fine-grained stats query over `gateway_usage`, and (3) add an ephemeral trace pipeline: SSE viewers register rows in an UNLOGGED `trace_subscriptions` table, the gateway polls it and fire-and-forget-POSTs truncated events to the subscribing control-plane instance, which fans out in memory. Spec: `docs/superpowers/specs/2026-07-10-deployment-monitoring-and-trace-design.md`.

**Tech Stack:** Fastify/TS control plane (node:test via `npm test`, Postgres localhost:15432), LiteLLM 1.91.1 gateway (Python callbacks, asyncpg + httpx already in image), Next.js console (production builds only), kubectl against docker-desktop.

## Global Constraints

- Trace previews truncated at **32,768 chars per message/response**; message content is NEVER stored — only `trace_subscriptions` routing rows (UNLOGGED, 15s TTL, 5s heartbeat) touch the DB.
- Stats windows → bucket seconds: `1m→2`, `5m→10`, `30m→30`, `1h→60`, `3h→180`. Buckets zero-filled.
- `gateway_usage.source` ∈ `'api' | 'session'`, default `'api'`; every existing Usage-page query gains `AND u.source = 'api'`.
- Internal-request attribution headers (trusted only on the internal key): `X-Devproof-Agent`, `X-Devproof-Session`, `X-Devproof-Workspace`; injected via `ANTHROPIC_CUSTOM_HEADERS` (newline-separated `Name: Value` pairs). Runner image is NOT changed (env-only) — no tag bump.
- Trace event kinds: `request` | `response` | `error`, correlated by a per-request uuid in `metadata.devproof_trace_id`.
- Gateway → CP callback: `POST <callback_url>/internal/trace-events`, `Authorization: Bearer <DEVPROOF_INTERNAL_KEY>`, 2s timeout, fire-and-forget. **Tracing/metering must never fail or slow a request** — every gateway addition is wrapped in try/except that prints and swallows.
- Callback URL env: `DEVPROOF_TRACE_CALLBACK_URL`, falling back to `DEVPROOF_CALLBACK_URL`, falling back to `http://host.docker.internal:7080`.
- CP gateway-sync patches ONLY the `config.yaml` ConfigMap key (`kubestore.ts writeGatewayConfig`) — `custom_callbacks.py` edits are safe. After `kubectl apply` of `deploy/gateway/litellm.yaml`, ALWAYS `POST /v1/gateway/sync` to restore the synced model list (the file's bootstrap `config.yaml` is stale).
- Console: production build (`npx next build`); SSE responses set `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Content-Encoding: identity`, `X-Accel-Buffering: no` and send `: ka` keep-alives (Next-proxy gzip buffering). Dialogs use shared `Modal`; no transparent text buttons; table links regular weight.
- Backend gates: `cd control-plane && npm test` green + `npx tsc --noEmit` clean.
- Work on branch `feature/deployment-monitoring` off `main`.

---

### Task 0 (controller, no subagent): create the branch

```bash
cd C:/Users/carst/Desktop/devproofai && git checkout -b feature/deployment-monitoring
```

---

### Task 1: Migration 019 + repo layer (source filter, stats query, trace subscriptions)

**Files:**
- Create: `control-plane/sql/019_gateway_trace.sql`
- Modify: `control-plane/src/repo.ts` (method `gatewayUsage` ~line 355; new methods at the end of the class, before the closing `}`)
- Test: `control-plane/test/repo.test.ts` (insert new tests before the final `test.after(...)` line)

**Interfaces:**
- Consumes: existing `gateway_usage` table, `Repo` class, `this.pool` (pg Pool).
- Produces (later tasks call these exactly):
  - `deploymentStats(model: string, opts: { windowSec: number; bucketSec: number; apiKeyId?: string; agentId?: string; sessionOnly?: boolean }): Promise<{ buckets: { t: number; tokens_in: number; tokens_out: number; requests: number }[]; totals: { tokens_in: number; tokens_out: number; requests: number } }>` — `buckets` zero-filled, `t` = epoch seconds (bucket start), ascending.
  - `upsertTraceSubscription(id: string, deployment: string, callbackUrl: string): Promise<void>` (15s TTL, refreshed on conflict)
  - `deleteTraceSubscription(id: string): Promise<void>`

- [ ] **Step 1: Write the migration**

Create `control-plane/sql/019_gateway_trace.sql`:

```sql
-- Deployment monitoring & trace (spec 2026-07-10-deployment-monitoring-and-trace).
-- source: 'api' (external key) | 'session' (managed-agent internal traffic, newly metered).
ALTER TABLE gateway_usage ADD COLUMN IF NOT EXISTS source     TEXT NOT NULL DEFAULT 'api';
ALTER TABLE gateway_usage ADD COLUMN IF NOT EXISTS agent_id   TEXT;
ALTER TABLE gateway_usage ADD COLUMN IF NOT EXISTS session_id TEXT;
CREATE INDEX IF NOT EXISTS gateway_usage_model_time ON gateway_usage (model, created_at);

-- Ephemeral trace routing: one row per open trace window (SSE viewer), heartbeat-
-- refreshed by the control plane, polled by the gateway. UNLOGGED: pure transient
-- state, safe to lose on crash. Message content NEVER touches the database.
CREATE UNLOGGED TABLE IF NOT EXISTS trace_subscriptions (
  id           TEXT PRIMARY KEY,
  deployment   TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL
);
```

- [ ] **Step 2: Write the failing tests**

In `control-plane/test/repo.test.ts`, add before `test.after(...)`:

```ts
test("gatewayUsage counts only source='api' rows", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = await repo.createWorkspace(`src-${Date.now()}`);
  const key = await repo.createApiKey(ws.id, "src-key");
  await pool.query(
    `INSERT INTO gateway_usage (workspace_id, api_key_id, model, tokens_in, tokens_out, source, agent_id) VALUES
     ($1, $2, 'dep-src', 100, 10, 'api', NULL),
     ($1, NULL, 'dep-src', 700, 70, 'session', 'agent_x')`,
    [ws.id, key.id]);
  const u = await repo.gatewayUsage(ws.id, { range: "7d" });
  assert.equal(u.totals.tokens_in, 100);   // session row invisible to billing views
  assert.equal(u.totals.requests, 1);
});

test("deploymentStats: zero-filled buckets, totals, filters", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const model = `dep-stats-${Date.now()}`;
  await pool.query(
    `INSERT INTO gateway_usage (workspace_id, api_key_id, model, tokens_in, tokens_out, source, agent_id, session_id, created_at) VALUES
     ('wrkspc_default', NULL, $1, 10, 1, 'session', 'agent_a', 'sesn_1', now() - interval '5 seconds'),
     ('wrkspc_default', NULL, $1, 20, 2, 'session', 'agent_b', 'sesn_2', now() - interval '5 seconds'),
     ('wrkspc_default', NULL, $1, 40, 4, 'api',     NULL,      NULL,     now() - interval '200 seconds')`,
    [model]);
  const s = await repo.deploymentStats(model, { windowSec: 60, bucketSec: 2 });
  assert.equal(s.buckets.length, 30);                       // 60s / 2s, zero-filled
  assert.equal(s.totals.tokens_in, 30);                     // 200s-old row outside window
  assert.equal(s.totals.requests, 2);
  assert.equal(s.buckets.reduce((a, b) => a + b.tokens_in, 0), 30);
  assert.ok(s.buckets.every((b, i) => i === 0 || b.t === s.buckets[i - 1].t + 2)); // ascending, contiguous
  const agents = await repo.deploymentStats(model, { windowSec: 60, bucketSec: 2, agentId: "agent_a" });
  assert.equal(agents.totals.tokens_in, 10);
  const sess = await repo.deploymentStats(model, { windowSec: 300, bucketSec: 10, sessionOnly: true });
  assert.equal(sess.totals.tokens_in, 30);
});

test("trace subscriptions: upsert refreshes TTL, delete removes", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const id = `tsub-${Date.now()}`;
  await repo.upsertTraceSubscription(id, "dep-x", "http://cp:7080");
  const { rows: [r1] } = await pool.query("SELECT * FROM trace_subscriptions WHERE id = $1", [id]);
  assert.equal(r1.deployment, "dep-x");
  assert.ok(new Date(r1.expires_at).getTime() > Date.now() + 5_000);
  await repo.upsertTraceSubscription(id, "dep-x", "http://cp:7080"); // heartbeat: no PK error
  await repo.deleteTraceSubscription(id);
  const { rows } = await pool.query("SELECT 1 FROM trace_subscriptions WHERE id = $1", [id]);
  assert.equal(rows.length, 0);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd control-plane && npx tsx --test test/repo.test.ts`
Expected: FAIL — first test fails on totals (200 vs 100... actually `column "source" does not exist` until the migration runs; the migration runs automatically at test load via `migrate(pool)`, so after creating the SQL file the failures are: `gatewayUsage` counts 800/2 (no source filter yet), `deploymentStats is not a function`, `upsertTraceSubscription is not a function`.

- [ ] **Step 4: Implement the repo changes**

In `control-plane/src/repo.ts`, method `gatewayUsage` (~line 360), change:

```ts
    const conds = ["u.workspace_id = $1", "u.created_at >= $2"];
```

to

```ts
    // Billing/usage views only see external API traffic; session rows are for
    // deployment monitoring (deploymentStats), never for the Usage page.
    const conds = ["u.workspace_id = $1", "u.created_at >= $2", "u.source = 'api'"];
```

Add at the end of the `Repo` class (before its closing `}`):

```ts
  // ── Deployment monitoring & trace (spec 2026-07-10) ──────────────────────
  /** Fine-grained realtime buckets for one deployment. All-workspace by design:
   *  the detail page monitors the deployment as a whole. */
  async deploymentStats(model: string, opts: {
    windowSec: number; bucketSec: number; apiKeyId?: string; agentId?: string; sessionOnly?: boolean;
  }) {
    const conds = ["model = $1", "created_at > now() - make_interval(secs => $2)"];
    const params: unknown[] = [model, opts.windowSec];
    if (opts.apiKeyId) { params.push(opts.apiKeyId); conds.push(`api_key_id = $${params.length}`); }
    if (opts.agentId) { params.push(opts.agentId); conds.push(`agent_id = $${params.length}`); }
    if (opts.sessionOnly) conds.push("source = 'session'");
    params.push(opts.bucketSec);
    const bs = `$${params.length}`;
    const { rows } = await this.pool.query(
      `SELECT (floor(extract(epoch FROM created_at) / ${bs}) * ${bs})::bigint AS t,
              COALESCE(sum(tokens_in),0)::bigint AS tokens_in,
              COALESCE(sum(tokens_out),0)::bigint AS tokens_out, count(*)::int AS requests
       FROM gateway_usage WHERE ${conds.join(" AND ")} GROUP BY 1`, params);
    const byT = new Map(rows.map((r: any) => [Number(r.t), r]));
    const nowSec = Math.floor(Date.now() / 1000);
    const t0 = Math.floor((nowSec - opts.windowSec) / opts.bucketSec) * opts.bucketSec + opts.bucketSec;
    const buckets = [];
    const totals = { tokens_in: 0, tokens_out: 0, requests: 0 };
    for (let t = t0; t <= nowSec; t += opts.bucketSec) {
      const r: any = byT.get(t);
      const b = {
        t,
        tokens_in: Number(r?.tokens_in ?? 0),
        tokens_out: Number(r?.tokens_out ?? 0),
        requests: Number(r?.requests ?? 0),
      };
      totals.tokens_in += b.tokens_in; totals.tokens_out += b.tokens_out; totals.requests += b.requests;
      buckets.push(b);
    }
    return { buckets, totals };
  }

  /** Trace-window routing row; 15s TTL, re-upserted every 5s while the SSE stream lives. */
  async upsertTraceSubscription(id: string, deployment: string, callbackUrl: string) {
    await this.pool.query(
      `INSERT INTO trace_subscriptions (id, deployment, callback_url, expires_at)
       VALUES ($1, $2, $3, now() + interval '15 seconds')
       ON CONFLICT (id) DO UPDATE SET expires_at = now() + interval '15 seconds'`,
      [id, deployment, callbackUrl]);
  }
  async deleteTraceSubscription(id: string) {
    await this.pool.query("DELETE FROM trace_subscriptions WHERE id = $1", [id]);
  }
```

Note on `deploymentStats` zero-fill: the first bucket start is `t0` (the oldest FULLY inside the window, hence `+ bucketSec`); with `windowSec=60, bucketSec=2` that yields exactly 30 buckets. Totals are computed from the zero-filled buckets so window edges match the chart.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd control-plane && npx tsx --test test/repo.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 6: Full gate + commit**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: all pass, tsc clean.

```bash
git add control-plane/sql/019_gateway_trace.sql control-plane/src/repo.ts control-plane/test/repo.test.ts
git commit -m "feat(control-plane): migration 019 + repo layer for deployment stats and trace subscriptions"
```

---

### Task 2: Stats + deployment-detail endpoints

**Files:**
- Modify: `control-plane/src/server.ts` (extract list builder ~line 186; add GET `/v1/deployments/:name`)
- Modify: `control-plane/src/agents-api.ts` (add GET `/v1/deployments/:name/stats` near the usage route ~line 150)
- Test: `control-plane/test/agents-api.test.ts` (stats route), `control-plane/test/server.test.ts` (detail route)

**Interfaces:**
- Consumes: `repo.deploymentStats` from Task 1 (exact signature above).
- Produces:
  - `GET /v1/deployments/:name` → one merged deployment object (same shape as a `/v1/deployments` list element) or 404 `{ error: "deployment not found" }`.
  - `GET /v1/deployments/:name/stats?window=1m|5m|30m|1h|3h&api_key=<id|__internal__>&agent=<id>` → `{ window, bucketSeconds, buckets, totals }`; invalid window → 400.
  - `api_key=__internal__` maps to `sessionOnly: true` (the "(internal sessions)" pseudo-filter).

- [ ] **Step 1: Failing test — stats route (fake repo)**

In `control-plane/test/agents-api.test.ts`: add to the `fakes()` repo object (alongside `gatewayUsage`):

```ts
    async deploymentStats(model: string, opts: any) {
      return { calledWith: { model, ...opts }, buckets: [], totals: { tokens_in: 0, tokens_out: 0, requests: 0 } };
    },
```

Add tests at the end of the file:

```ts
test("GET /v1/deployments/:name/stats maps windows and filters", async () => {
  const { app } = await build();
  const res = await app.inject({ method: "GET", url: "/v1/deployments/dep-a/stats?window=5m&agent=agent_1" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.window, "5m");
  assert.equal(body.bucketSeconds, 10);
  assert.deepEqual(body.calledWith, { model: "dep-a", windowSec: 300, bucketSec: 10, agentId: "agent_1" });
});

test("GET stats: __internal__ key maps to sessionOnly; bad window -> 400", async () => {
  const { app } = await build();
  const internal = await app.inject({ method: "GET", url: "/v1/deployments/dep-a/stats?window=1m&api_key=__internal__" });
  assert.deepEqual(internal.json().calledWith, { model: "dep-a", windowSec: 60, bucketSec: 2, sessionOnly: true });
  const bad = await app.inject({ method: "GET", url: "/v1/deployments/dep-a/stats?window=2d" });
  assert.equal(bad.statusCode, 400);
});
```

Note: the route spreads `repo.deploymentStats`'s result into the response, so the fake's `calledWith` surfaces at the top level — that's what the assertions read.

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && npx tsx --test test/agents-api.test.ts`
Expected: FAIL 404 (route not registered).

- [ ] **Step 3: Implement the stats route**

In `control-plane/src/agents-api.ts`, after the environments DELETE route (~line 156), add:

```ts
  // ── Deployment realtime stats (spec 2026-07-10 deployment monitoring) ──
  // Whole-deployment monitoring: buckets count all workspaces' traffic.
  const STAT_WINDOWS: Record<string, { windowSec: number; bucketSec: number }> = {
    "1m": { windowSec: 60, bucketSec: 2 }, "5m": { windowSec: 300, bucketSec: 10 },
    "30m": { windowSec: 1800, bucketSec: 30 }, "1h": { windowSec: 3600, bucketSec: 60 },
    "3h": { windowSec: 10800, bucketSec: 180 },
  };
  app.get("/v1/deployments/:name/stats", async (req, reply) => {
    const q = req.query as { window?: string; api_key?: string; agent?: string };
    const win = STAT_WINDOWS[q.window ?? "5m"];
    if (!win) return reply.code(400).send({ error: `window must be one of ${Object.keys(STAT_WINDOWS).join("|")}` });
    const opts: any = { ...win };
    if (q.api_key === "__internal__") opts.sessionOnly = true;
    else if (q.api_key) opts.apiKeyId = q.api_key;
    if (q.agent) opts.agentId = q.agent;
    const stats = await repo.deploymentStats((req.params as any).name, opts);
    return { window: q.window ?? "5m", bucketSeconds: win.bucketSec, ...stats };
  });
```

- [ ] **Step 4: Failing test — detail route**

In `control-plane/test/server.test.ts` (each test builds its own app from the file's `fakeStore()` helper; seed a deployment by pushing into `objects.modeldeployments`), add at the end:

```ts
test("GET /v1/deployments/:name returns the single merged entry, 404 otherwise", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push({
    metadata: { name: "dep-one", namespace: "devproof-serving" },
    spec: { catalogId: "qwen2.5-0.5b-instruct-q4", replicas: { min: 1, max: 2 } },
    status: { phase: "Ready", endpoint: "http://dep-one.devproof-serving.svc:8080/v1/chat/completions", readyReplicas: 1 },
  });
  const app = buildServer(catalog, store);
  const hit = await app.inject({ method: "GET", url: "/v1/deployments/dep-one" });
  assert.equal(hit.statusCode, 200);
  assert.equal(hit.json().name, "dep-one");
  assert.equal(hit.json().kind, "local");
  assert.equal(hit.json().replicas.max, 2);
  const miss = await app.inject({ method: "GET", url: "/v1/deployments/nope-missing" });
  assert.equal(miss.statusCode, 404);
});
```

- [ ] **Step 5: Implement the detail route**

In `control-plane/src/server.ts`, refactor the deployments list (~line 186): extract the merge into a local helper directly above the route, then reuse it:

```ts
  // Merged local (CRD + metrics) + external (workspace-scoped) deployment view.
  const listDeployments = async (req: any): Promise<any[]> => {
    const items = await store.list("modeldeployments");
    const locals = items.map((d: any) => ({
      kind: "local",
      name: d.metadata.name,
      catalogId: d.spec?.catalogId,
      poolRef: d.spec?.poolRef,
      replicas: d.spec?.replicas ?? null,
      phase: d.status?.phase ?? "Pending",
      downloadPercent: d.status?.downloadPercent ?? null,
      endpoint: d.status?.endpoint,
      readyReplicas: d.status?.readyReplicas ?? 0,
    }));
    const { tokens, queue } = await fetchServingMetrics();
    const merged = mergeMetrics(locals, tokens, queue) as any[];
    for (const e of externals ? await externals.list(ws(req)) : []) {
      merged.push({
        kind: "external", id: e.id, name: e.name, provider: e.provider, modelId: e.model_id,
        baseUrl: e.base_url, phase: "External", downloadPercent: null, readyReplicas: 0,
        tokensPerSec: null, queueDepth: null,
      });
    }
    merged.sort((a, b) => a.name.localeCompare(b.name));
    return merged;
  };

  app.get("/v1/deployments", async (req) => {
    const { rows, count, offset } = paged(await listDeployments(req), req);
    return { deployments: rows, count, offset };
  });

  app.get("/v1/deployments/:name", async (req, reply) => {
    const d = (await listDeployments(req)).find((x) => x.name === (req.params as any).name);
    if (!d) return reply.code(404).send({ error: "deployment not found" });
    return d;
  });
```

(The body of `listDeployments` is the EXACT current list-route body — this is a move, not a rewrite.)

- [ ] **Step 6: Run tests, full gate, commit**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: all pass (incl. both new files' tests), tsc clean.

```bash
git add control-plane/src/server.ts control-plane/src/agents-api.ts control-plane/test/agents-api.test.ts control-plane/test/server.test.ts
git commit -m "feat(control-plane): deployment detail + realtime stats endpoints"
```

---

### Task 3: TraceHub + trace SSE stream + internal ingest route

**Files:**
- Create: `control-plane/src/trace.ts`
- Modify: `control-plane/src/main.ts` (register trace routes after `registerAgentRoutes`, line 58)
- Test: Create `control-plane/test/trace.test.ts`

**Interfaces:**
- Consumes: `repo.upsertTraceSubscription` / `repo.deleteTraceSubscription` (Task 1).
- Produces:
  - `class TraceHub { subscribe(deployment: string, fn: (e: object) => void): () => void; publish(e: { deployment: string }): void }`
  - `registerTraceRoutes(app: FastifyInstance, repo: { upsertTraceSubscription: Function; deleteTraceSubscription: Function }, hub: TraceHub): void` registering:
    - `POST /internal/trace-events` — body `{ events: TraceEvent[] }`; `Authorization: Bearer <DEVPROOF_INTERNAL_KEY>` required iff the env var is set (matches phase-1 runner-callback posture when unset); 202.
    - `GET /v1/deployments/:name/trace/stream` — SSE; one `trace_subscriptions` row per connection, heartbeat every 5s, deleted on close.

- [ ] **Step 1: Write the failing tests**

Create `control-plane/test/trace.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { TraceHub, registerTraceRoutes } from "../src/trace.ts";

const fakeRepo = () => {
  const calls: { upserts: any[]; deletes: string[] } = { upserts: [], deletes: [] };
  return {
    calls,
    async upsertTraceSubscription(id: string, deployment: string, url: string) { calls.upserts.push({ id, deployment, url }); },
    async deleteTraceSubscription(id: string) { calls.deletes.push(id); },
  };
};

test("TraceHub fans out per deployment and unsubscribes cleanly", () => {
  const hub = new TraceHub();
  const got: any[] = [];
  const un = hub.subscribe("dep-a", (e) => got.push(e));
  hub.publish({ deployment: "dep-a", kind: "request" });
  hub.publish({ deployment: "dep-b", kind: "request" });   // other deployment: not delivered
  assert.equal(got.length, 1);
  un();
  hub.publish({ deployment: "dep-a", kind: "response" });
  assert.equal(got.length, 1);                              // after unsubscribe: not delivered
});

test("POST /internal/trace-events: auth enforced when key set, publishes to hub", async () => {
  process.env.DEVPROOF_INTERNAL_KEY = "test-internal";
  const app = Fastify();
  const hub = new TraceHub();
  registerTraceRoutes(app as any, fakeRepo() as any, hub);
  const got: any[] = [];
  hub.subscribe("dep-a", (e) => got.push(e));

  const noAuth = await app.inject({ method: "POST", url: "/internal/trace-events",
    payload: { events: [{ deployment: "dep-a", kind: "request" }] } });
  assert.equal(noAuth.statusCode, 401);

  const ok = await app.inject({ method: "POST", url: "/internal/trace-events",
    headers: { authorization: "Bearer test-internal" },
    payload: { events: [{ deployment: "dep-a", kind: "request" }, { deployment: "dep-a", kind: "response" }] } });
  assert.equal(ok.statusCode, 202);
  assert.equal(got.length, 2);
  delete process.env.DEVPROOF_INTERNAL_KEY;
});
```

(The SSE stream loop is exercised live in Task 6 — Fastify `inject` cannot hold a streaming response open. The subscription lifecycle it drives is covered by the repo tests in Task 1 plus the live check.)

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && npx tsx --test test/trace.test.ts`
Expected: FAIL — cannot find module `../src/trace.ts`.

- [ ] **Step 3: Implement `control-plane/src/trace.ts`**

```ts
// Ephemeral live-trace fan-out (spec 2026-07-10 deployment monitoring & trace).
// The gateway POSTs truncated request/response/error events here — ONLY while a
// trace window is open (it polls trace_subscriptions). Events are never stored;
// this hub is in-memory and lossy by design.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

export interface TraceEvent {
  id?: string; kind: "request" | "response" | "error"; deployment: string;
  ts?: string; [k: string]: unknown;
}

export class TraceHub {
  private subs = new Map<string, Set<(e: TraceEvent) => void>>();
  subscribe(deployment: string, fn: (e: TraceEvent) => void): () => void {
    let set = this.subs.get(deployment);
    if (!set) { set = new Set(); this.subs.set(deployment, set); }
    set.add(fn);
    return () => { set!.delete(fn); if (set!.size === 0) this.subs.delete(deployment); };
  }
  publish(e: TraceEvent) { this.subs.get(e.deployment)?.forEach((fn) => fn(e)); }
}

const CALLBACK =
  process.env.DEVPROOF_TRACE_CALLBACK_URL ?? process.env.DEVPROOF_CALLBACK_URL ?? "http://host.docker.internal:7080";

export function registerTraceRoutes(
  app: FastifyInstance,
  repo: {
    upsertTraceSubscription(id: string, deployment: string, url: string): Promise<void>;
    deleteTraceSubscription(id: string): Promise<void>;
  },
  hub: TraceHub,
) {
  // Gateway-facing ingest. Bearer auth against the internal key when configured
  // (same phase-1 posture as runner callbacks when it isn't).
  app.post("/internal/trace-events", async (req, reply) => {
    const key = process.env.DEVPROOF_INTERNAL_KEY;
    if (key && req.headers.authorization !== `Bearer ${key}`) {
      return reply.code(401).send({ error: "internal key required" });
    }
    for (const e of ((req.body as any)?.events ?? []) as TraceEvent[]) {
      if (e?.deployment && e?.kind) hub.publish(e);
    }
    return reply.code(202).send({ ok: true });
  });

  // Browser-facing SSE. Opening this stream IS the capture switch: the
  // subscription row it maintains is what makes the gateway start emitting.
  app.get("/v1/deployments/:name/trace/stream", async (req, reply) => {
    const deployment = (req.params as any).name as string;
    const subId = `trace_${randomUUID()}`;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Content-Encoding": "identity",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    await repo.upsertTraceSubscription(subId, deployment, CALLBACK);
    const heartbeat = setInterval(() => {
      repo.upsertTraceSubscription(subId, deployment, CALLBACK).catch(() => { /* next beat retries */ });
      reply.raw.write(": ka\n\n");
    }, 5000);
    const unsub = hub.subscribe(deployment, (e) => {
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    });
    await new Promise<void>((resolve) => { req.raw.on("close", resolve); });
    clearInterval(heartbeat);
    unsub();
    await repo.deleteTraceSubscription(subId).catch(() => { /* 15s TTL cleans up */ });
    reply.raw.end();
    return reply;
  });
}
```

- [ ] **Step 4: Wire into `control-plane/src/main.ts`**

Add to the imports: `import { TraceHub, registerTraceRoutes } from "./trace.ts";`
After line 58 (`await registerAgentRoutes(...)`), add:

```ts
registerTraceRoutes(app, repo, new TraceHub());
```

- [ ] **Step 5: Run tests, full gate, commit**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: all pass, tsc clean.

```bash
git add control-plane/src/trace.ts control-plane/src/main.ts control-plane/test/trace.test.ts
git commit -m "feat(control-plane): TraceHub, trace SSE stream, internal trace-events ingest"
```

---

### Task 4: Gateway — attribution headers, all-traffic metering, trace emitter

**Files:**
- Modify: `deploy/gateway/litellm.yaml` (`custom_callbacks.py` key ONLY — do not touch the bootstrap `config.yaml`, Deployment, or Service)

**Interfaces:**
- Consumes: `trace_subscriptions` table (Task 1), CP ingest `POST /internal/trace-events` with `Authorization: Bearer <DEVPROOF_INTERNAL_KEY>` (Task 3).
- Produces: `gateway_usage` rows for ALL traffic (`source` = `'api'`/`'session'`, `agent_id`, `session_id`); trace events shaped:
  - request: `{ id, kind: "request", deployment, ts, source, api_key_id?, agent_id?, session_id?, messages: [{ role, preview, length }], tool_count, model_params: { stream?, max_tokens? } }`
  - response: `{ id, kind: "response", deployment, ts, source, api_key_id?, agent_id?, session_id?, tokens_in, tokens_out, duration_ms, preview, length }`
  - error: `{ id, kind: "error", deployment, ts, source, error }`

- [ ] **Step 1: Extend `user_custom_auth` (attribution headers, internal key only)**

In `deploy/gateway/litellm.yaml` `custom_callbacks.py`, replace the internal-key branch:

```python
        if INTERNAL_KEY and hmac.compare_digest(api_key, INTERNAL_KEY):
            return UserAPIKeyAuth(api_key=api_key, key_alias="devproof-internal",
                                  metadata={"devproof_internal": True})
```

with:

```python
        if INTERNAL_KEY and hmac.compare_digest(api_key, INTERNAL_KEY):
            # Attribution headers are trusted ONLY on the internal key (platform-
            # injected via ANTHROPIC_CUSTOM_HEADERS in session pods); external
            # callers' headers are ignored, so attribution cannot be spoofed.
            md = {"devproof_internal": True}
            for header, key in (("x-devproof-agent", "devproof_agent"),
                                ("x-devproof-session", "devproof_session"),
                                ("x-devproof-workspace", "devproof_workspace")):
                v = request.headers.get(header)
                if v:
                    md[key] = v
            return UserAPIKeyAuth(api_key=api_key, key_alias="devproof-internal", metadata=md)
```

- [ ] **Step 2: Add the trace machinery (module level, after the `_touch` function)**

```python
    # ── Live trace (spec 2026-07-10): capture ONLY while a window is open. ──
    # CP maintains trace_subscriptions rows (15s TTL) per open SSE viewer; we
    # poll them into memory and fire-and-forget events at the subscribing CP
    # instance. Content is truncated and NEVER stored. Best-effort throughout.
    TRACE_POLL = 2.0
    PREVIEW_MAX = 32768
    _trace_subs = {}      # deployment -> set(callback_url)
    _trace_task = None

    async def _trace_poller():
        global _trace_subs
        while True:
            try:
                pool = await _db()
                rows = await pool.fetch(
                    "SELECT deployment, callback_url FROM trace_subscriptions WHERE expires_at > now()")
                subs = {}
                for r in rows:
                    subs.setdefault(r["deployment"], set()).add(r["callback_url"])
                _trace_subs = subs
            except Exception as e:  # noqa: BLE001
                print(f"devproof-trace: subscription poll failed: {e}", flush=True)
            await asyncio.sleep(TRACE_POLL)

    def _ensure_trace_poller():
        global _trace_task
        if _trace_task is None or _trace_task.done():
            _trace_task = asyncio.ensure_future(_trace_poller())

    def _preview(content):
        """Message content -> (32k-capped text, true length). Handles OpenAI string
        content and Anthropic content-block lists; non-text blocks become markers."""
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            parts = []
            for b in content:
                if isinstance(b, dict):
                    t = b.get("type")
                    if t == "text":
                        parts.append(b.get("text") or "")
                    elif t:
                        name = b.get("name")
                        parts.append(f"[{t}: {name}]" if name else f"[{t}]")
            text = "\n".join(parts)
        else:
            text = "" if content is None else str(content)
        return text[:PREVIEW_MAX], len(text)

    def _attribution(md):
        out = {"source": "session" if md.get("devproof_internal") else "api"}
        if md.get("devproof_key_id"):
            out["api_key_id"] = md.get("devproof_key_id")
        if md.get("devproof_agent"):
            out["agent_id"] = md.get("devproof_agent")
        if md.get("devproof_session"):
            out["session_id"] = md.get("devproof_session")
        return out

    async def _post_trace(url, event):
        try:
            import httpx
            async with httpx.AsyncClient(timeout=2.0) as client:
                await client.post(f"{url}/internal/trace-events", json={"events": [event]},
                                  headers={"Authorization": f"Bearer {INTERNAL_KEY}"})
        except Exception as e:  # noqa: BLE001
            print(f"devproof-trace: post to {url} failed: {e}", flush=True)

    def _emit_trace(deployment, event):
        for url in _trace_subs.get(deployment) or ():
            asyncio.ensure_future(_post_trace(url, event))
```

- [ ] **Step 3: Emit request events + trace id in `async_pre_call_hook`**

Replace the `SchemaSanitizer.async_pre_call_hook` body:

```python
        async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
            if SCRUB_ALL or data.get("model") in SANITIZE_MODELS:
                for t in data.get("tools") or []:
                    _scrub(t)
            try:  # trace capture must never fail a request
                _ensure_trace_poller()
                deployment = data.get("model")
                if deployment and deployment in _trace_subs:
                    import time as _t, uuid
                    trace_id = str(uuid.uuid4())
                    data.setdefault("metadata", {})["devproof_trace_id"] = trace_id
                    md = getattr(user_api_key_dict, "metadata", None) or {}
                    msgs = []
                    for m in (data.get("messages") or [])[-50:]:
                        preview, length = _preview(m.get("content"))
                        msgs.append({"role": m.get("role"), "preview": preview, "length": length})
                    _emit_trace(deployment, {
                        "id": trace_id, "kind": "request", "deployment": deployment,
                        "ts": _t.strftime("%Y-%m-%dT%H:%M:%S+00:00", _t.gmtime()),
                        **_attribution(md),
                        "messages": msgs,
                        "tool_count": len(data.get("tools") or []),
                        "model_params": {"stream": bool(data.get("stream")),
                                         "max_tokens": data.get("max_tokens")},
                    })
            except Exception as e:  # noqa: BLE001
                print(f"devproof-trace: request capture failed: {e}", flush=True)
            return data
```

- [ ] **Step 4: All-traffic metering + response events in `async_log_success_event`**

Replace the whole method:

```python
        async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
            # Metering/trace must never fail a request: everything is best-effort.
            try:
                slo = kwargs.get("standard_logging_object") or {}
                auth_md = (slo.get("metadata") or {}).get("user_api_key_auth_metadata") or {}
                md = (kwargs.get("litellm_params") or {}).get("metadata") or {}
                model = (slo.get("model_group") or md.get("model_group")
                         or kwargs.get("model") or slo.get("model") or "unknown")
                tokens_in = int(slo.get("prompt_tokens") or 0)
                tokens_out = int(slo.get("completion_tokens") or 0)
                internal = bool(auth_md.get("devproof_internal"))
                if internal:
                    key_id = None
                    # NOT NULL column; pre-rollout session pods lack the header.
                    ws = auth_md.get("devproof_workspace") or "wrkspc_default"
                else:
                    key_id = auth_md.get("devproof_key_id")
                    ws = auth_md.get("devproof_workspace")
                    if not key_id:
                        return  # unattributed external traffic (shouldn't happen): skip
                pool = await _db()
                await pool.execute(
                    """INSERT INTO gateway_usage
                       (workspace_id, api_key_id, model, tokens_in, tokens_out, source, agent_id, session_id)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
                    ws, key_id, model,
                    tokens_in, tokens_out,
                    "session" if internal else "api",
                    auth_md.get("devproof_agent"), auth_md.get("devproof_session"))
            except Exception as e:  # noqa: BLE001
                print(f"devproof-metering: dropped usage row: {e}", flush=True)
            try:
                slo = kwargs.get("standard_logging_object") or {}
                md = (kwargs.get("litellm_params") or {}).get("metadata") or {}
                deployment = slo.get("model_group") or md.get("model_group") or kwargs.get("model")
                trace_id = md.get("devproof_trace_id")
                if deployment and trace_id and deployment in _trace_subs:
                    auth_md = (slo.get("metadata") or {}).get("user_api_key_auth_metadata") or {}
                    preview, length = _preview(slo.get("response"))
                    import time as _t
                    _emit_trace(deployment, {
                        "id": trace_id, "kind": "response", "deployment": deployment,
                        "ts": _t.strftime("%Y-%m-%dT%H:%M:%S+00:00", _t.gmtime()),
                        **_attribution(auth_md),
                        "tokens_in": int(slo.get("prompt_tokens") or 0),
                        "tokens_out": int(slo.get("completion_tokens") or 0),
                        "duration_ms": int(((slo.get("response_time") or 0)) * 1000),
                        "preview": preview, "length": length,
                    })
            except Exception as e:  # noqa: BLE001
                print(f"devproof-trace: response capture failed: {e}", flush=True)
```


- [ ] **Step 5: Add `async_log_failure_event` (error events) to the class**

```python
        async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
            try:
                slo = kwargs.get("standard_logging_object") or {}
                md = (kwargs.get("litellm_params") or {}).get("metadata") or {}
                deployment = slo.get("model_group") or md.get("model_group") or kwargs.get("model")
                trace_id = md.get("devproof_trace_id")
                if deployment and trace_id and deployment in _trace_subs:
                    auth_md = (slo.get("metadata") or {}).get("user_api_key_auth_metadata") or {}
                    import time as _t
                    _emit_trace(deployment, {
                        "id": trace_id, "kind": "error", "deployment": deployment,
                        "ts": _t.strftime("%Y-%m-%dT%H:%M:%S+00:00", _t.gmtime()),
                        **_attribution(auth_md),
                        "error": str(slo.get("error_str") or "")[:PREVIEW_MAX],
                    })
            except Exception as e:  # noqa: BLE001
                print(f"devproof-trace: error capture failed: {e}", flush=True)
```

- [ ] **Step 6: Apply + restore synced config + verify metering live**

```bash
kubectl apply -f deploy/gateway/litellm.yaml
kubectl rollout restart deployment/gateway -n devproof-gateway
kubectl rollout status deployment/gateway -n devproof-gateway --timeout=180s
# CRITICAL: the file's bootstrap config.yaml is stale — resync the real model list:
curl -s -X POST http://127.0.0.1:7080/v1/gateway/sync
```

Live spike (the design's step-1 gate — headers reach the auth hook, rows carry attribution):

```bash
IK=$(kubectl get secret -n devproof-gateway gateway-auth -o jsonpath='{.data.internal-key}' | base64 -d)
curl -s http://localhost:14000/v1/chat/completions -H "Authorization: Bearer $IK" \
  -H "X-Devproof-Agent: agent_spike" -H "X-Devproof-Session: sesn_spike" -H "X-Devproof-Workspace: wrkspc_default" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen05b-dp","messages":[{"role":"user","content":"say hi"}],"max_tokens":10}'
cd control-plane && node --import tsx -e "import {createPool} from './src/db.ts'; const p=createPool(); const r=await p.query(\"SELECT model, source, agent_id, session_id, workspace_id, tokens_in FROM gateway_usage ORDER BY created_at DESC LIMIT 1\"); console.log(r.rows[0]); await p.end();"
```

Expected: completion succeeds; the printed row shows `source: 'session'`, `agent_id: 'agent_spike'`, `session_id: 'sesn_spike'`, nonzero `tokens_in`. Also confirm an external-key request (any `dpk_` key) still writes a `source: 'api'` row, and `kubectl logs deployment/gateway -n devproof-gateway | grep devproof-trace` shows no crash lines.

- [ ] **Step 7: Commit**

```bash
git add deploy/gateway/litellm.yaml
git commit -m "feat(gateway): all-traffic metering with agent attribution + ephemeral trace emitter"
```

---

### Task 5: Orchestrator — inject attribution headers into session pods

**Files:**
- Modify: `control-plane/src/orchestrator.ts` (env list ~line 246), `control-plane/src/agents-api.ts` (Orchestrator interface line 9; the 3 `startSession` call sites ~lines 370, 396, 607)
- Test: `control-plane/test/agents-api.test.ts`

**Interfaces:**
- Consumes: `session.config.agent_id` (already present in every config built by `repo.createSession`).
- Produces: `startSession` spec gains `workspace?: string`; pods get `ANTHROPIC_CUSTOM_HEADERS`.

- [ ] **Step 1: Failing test**

In `control-plane/test/agents-api.test.ts`, extend the fake orchestrator in `fakes()`: change

```ts
  const orchestrator: Orchestrator = { async startSession(s) { started.push(s.id); }, ...
```

to capture the spec:

```ts
  const startSpecs: any[] = [];
  const orchestrator: Orchestrator = { async startSession(s) { started.push(s.id); startSpecs.push(s); }, ...
```

(and add `startSpecs` to the returned object). Add the test:

```ts
test("startSession receives the workspace for attribution headers", async () => {
  const { app, startSpecs } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "attr", model: "m" } })).json();
  await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "p" },
    headers: { "x-devproof-workspace": "wrkspc_attr" } });
  assert.equal(startSpecs[0].workspace, "wrkspc_attr");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && npx tsx --test test/agents-api.test.ts`
Expected: FAIL — `startSpecs[0].workspace` is `undefined`.

- [ ] **Step 3: Implement**

`control-plane/src/agents-api.ts`: add `workspace?: string;` to the `startSession` spec type (after `prompt: string;`, line 11). At each of the 3 call sites, add `workspace: ws(req)` — e.g. the session-create site becomes:

```ts
    await orchestrator.startSession({ id: session.id, prompt: b.prompt, config: session.config, attachments, skills, memory, workspace: ws(req) });
```

(same addition at the messages/resume site and the webhook/remote-trigger site — for the webhook site use its existing `workspace` variable instead of `ws(req)`).

`control-plane/src/orchestrator.ts`: in the runner env array (directly after the `ANTHROPIC_AUTH_TOKEN` entry, line 248), add:

```ts
                      {
                        // Attribution for gateway metering/trace (spec 2026-07-10):
                        // the CLI runtime (since replaced by devproof_runner) sends these on every request to the gateway.
                        name: "ANTHROPIC_CUSTOM_HEADERS",
                        value: [
                          `X-Devproof-Agent: ${(session.config as any).agent_id ?? ""}`,
                          `X-Devproof-Session: ${session.id}`,
                          `X-Devproof-Workspace: ${session.workspace ?? "wrkspc_default"}`,
                        ].join("\n"),
                      },
```

- [ ] **Step 4: Run tests, full gate, commit**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: all pass, tsc clean.

```bash
git add control-plane/src/orchestrator.ts control-plane/src/agents-api.ts control-plane/test/agents-api.test.ts
git commit -m "feat(control-plane): inject devproof attribution headers into session pods"
```

---

### Task 6 (controller, no subagent): live integration gate

The controller (not a subagent) runs this — it owns the CP/console server processes.

- [ ] Restart the control plane on the new code (kill port 7080, start with the usual env per CLAUDE.md).
- [ ] Open a trace stream and hold it: `curl -sN http://127.0.0.1:7080/v1/deployments/qwen05b-dp/trace/stream` (background). Within ~3s, confirm a subscription row exists (`SELECT * FROM trace_subscriptions`).
- [ ] Send one internal-key chat request with attribution headers (Task 4 Step 6 curl) and one external `dpk_` request. Expected: the held curl prints `data: {...kind":"request"...}` then `data: {...kind":"response"...tokens_out...}` for both; the session one carries `agent_id`/`session_id`.
- [ ] `GET /v1/deployments/qwen05b-dp/stats?window=5m` returns nonzero totals; `?api_key=__internal__` isolates the internal request.
- [ ] Kill the curl; within ~15s the `trace_subscriptions` row disappears (TTL) or immediately (delete-on-close).
- [ ] Run a REAL agent session (create via console/API against a test agent) and confirm its `gateway_usage` rows carry `source='session'` + real agent/session ids — this proves ANTHROPIC_CUSTOM_HEADERS propagates through the runner's SDK-driven CLI.
- [ ] Workspace Usage page (`/usage`) totals unchanged by the session traffic (spot-check `/v1/usage/gateway?range=1d` before/after).

---

### Task 7: Console — detail page skeleton, Overview tab, list link, Edit button

**Files:**
- Create: `console/app/deployments/[name]/page.tsx`, `console/app/deployments/[name]/tabs.tsx`
- Modify: `console/app/deployments/page.tsx` (name cell), `console/app/deployments/deploy-modal.tsx` (`EditDeploymentName` button variant), `CLAUDE.md` (dialogs bullet)
- Test: production build + browser check (controller assists on server restart).

**Interfaces:**
- Consumes: `GET /v1/deployments/:name` (Task 2), `GET /v1/api-keys` → `{ keys }`, `GET /v1/agents` → `{ agents }`.
- Produces: `DeploymentTabs({ d, keys, agents })` client component with `tab` state `"overview" | "stats" | "trace"`; Tasks 8/9 fill the stats/trace tabs (their components mount inside this switcher).

- [ ] **Step 1: `EditDeploymentName` gains a button variant**

In `console/app/deployments/deploy-modal.tsx`, change the signature's props union to add `asButton?: boolean` on both variants, and the trigger to:

```tsx
    {props.asButton
      ? <button onClick={() => setOpen(true)}><Icon.deploy /> Edit deployment</button>
      : <button className="namebtn" title="Edit deployment" onClick={() => setOpen(true)}>{props.name}</button>}
```

- [ ] **Step 2: List page — name links to the detail page**

In `console/app/deployments/page.tsx`: add `import Link from "next/link";` and replace the name cell (both branches collapse to one link — the edit affordance moves to the detail page):

```tsx
              <td><Link href={`/deployments/${encodeURIComponent(d.name)}`}>{d.name}</Link></td>
```

Remove the now-unused `EditDeploymentName` import from this file (it remains exported for the detail page).

- [ ] **Step 3: Server page**

Create `console/app/deployments/[name]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { wsGet } from "../../lib/api";
import { DeploymentTabs } from "./tabs";

export const dynamic = "force-dynamic";

export default async function DeploymentDetail({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const [d, keys, agents] = await Promise.all([
    wsGet<any>(`/v1/deployments/${encodeURIComponent(name)}`).catch(() => null),
    wsGet<{ keys: { id: string; name: string }[] }>("/v1/api-keys").catch(() => ({ keys: [] })),
    wsGet<{ agents: { id: string; name: string }[] }>("/v1/agents").catch(() => ({ agents: [] })),
  ]);
  if (!d) notFound();
  return <DeploymentTabs d={d} keys={keys.keys} agents={agents.agents} />;
}
```

- [ ] **Step 4: Tabs + Overview**

Create `console/app/deployments/[name]/tabs.tsx`:

```tsx
"use client";
// Deployment detail (spec 2026-07-10): Overview | Stats | Trace, agents-page pattern.
import { useState } from "react";
import { EditDeploymentName } from "../deploy-modal";
import { StatsTab } from "./stats";
import { TraceTab } from "./trace";

export function DeploymentTabs({ d, keys, agents }:
  { d: any; keys: { id: string; name: string }[]; agents: { id: string; name: string }[] }) {
  const [tab, setTab] = useState<"overview" | "stats" | "trace">("overview");
  const phase = d.phase === "External" ? "Ready" : d.phase === "Failed" ? "Failed" : d.phase === "Ready" ? "Ready" : "Deploying";
  return (
    <>
      <div className="pagehead">
        <h1>{d.name} <span className={`phase ${phase}`} style={{ marginLeft: 10, verticalAlign: "middle" }}>{d.phase}</span></h1>
        {d.kind === "external"
          ? <EditDeploymentName asButton kind="external" name={d.name} externalId={d.id}
              provider={d.provider} baseUrl={d.baseUrl ?? null} modelId={d.modelId} />
          : <EditDeploymentName asButton kind="local" name={d.name} poolRef={d.poolRef}
              replicas={d.replicas ?? undefined} />}
      </div>
      <p className="sub">{d.kind === "external"
        ? `Remote endpoint — ${d.provider}/${d.modelId}`
        : `Local model serving through the gateway — catalog ${d.catalogId ?? "—"}`}</p>

      <div className="tabs">
        <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>Overview</button>
        <button className={tab === "stats" ? "active" : ""} onClick={() => setTab("stats")}>Stats</button>
        <button className={tab === "trace" ? "active" : ""} onClick={() => setTab("trace")}>Trace</button>
      </div>

      {tab === "overview" && (
        <div className="cards">
          <div className="card"><h3>Serving</h3>
            <div className="row"><span className="muted">Kind</span><span>{d.kind}</span></div>
            {d.kind === "local" && <>
              <div className="row"><span className="muted">Pool</span><span>{d.poolRef ?? "—"}</span></div>
              <div className="row"><span className="muted">Replicas</span>
                <span>{d.readyReplicas} ready{d.replicas ? ` · ${d.replicas.min}–${d.replicas.max}` : ""}</span></div>
              <div className="row"><span className="muted">Download</span>
                <span>{d.downloadPercent != null ? `${d.downloadPercent}%` : "—"}</span></div>
            </>}
            {d.kind === "external" && <>
              <div className="row"><span className="muted">Provider</span><span>{d.provider}</span></div>
              <div className="row"><span className="muted">Model</span><code>{d.modelId}</code></div>
            </>}
          </div>
          <div className="card"><h3>Live</h3>
            <div className="row"><span className="muted">Tokens/sec</span>
              <span>{d.tokensPerSec != null ? d.tokensPerSec.toFixed(1) : "—"}</span></div>
            <div className="row"><span className="muted">Queue depth</span>
              <span>{d.queueDepth != null ? d.queueDepth : "—"}</span></div>
          </div>
          <div className="card"><h3>Endpoint</h3>
            <code style={{ fontSize: 11.5, wordBreak: "break-all" }}>
              {d.kind === "external" ? (d.baseUrl ?? "provider default") : (d.endpoint ?? "—")}
            </code>
          </div>
        </div>
      )}
      {tab === "stats" && <StatsTab name={d.name} keys={keys} agents={agents} />}
      {tab === "trace" && <TraceTab name={d.name} keys={keys} agents={agents} />}
    </>
  );
}
```

For THIS task only, create placeholder implementations so the build passes (Tasks 8/9 replace them):
`console/app/deployments/[name]/stats.tsx` → `"use client"; export function StatsTab(_: { name: string; keys: any[]; agents: any[] }) { return <div className="empty">Stats — next task.</div>; }`
`console/app/deployments/[name]/trace.tsx` → same shape, label "Trace — next task."

- [ ] **Step 5: CLAUDE.md**

In the **Dialogs** bullet, change "Edit opens by clicking the row's **name** (deployments/catalog/pools)" to "Edit opens by clicking the row's **name** (catalog/pools); deployments and agents edit from their detail pages" (keep the rest of the bullet intact).

- [ ] **Step 6: Build + commit**

Run: `cd console && npx next build`
Expected: success; route list gains `/deployments/[name]`.

```bash
git add console/app/deployments CLAUDE.md
git commit -m "feat(console): deployment detail page — overview tab, edit button, list links"
```

---

### Task 8: Console — Stats tab (realtime chart + filters)

**Files:**
- Modify (replace placeholder): `console/app/deployments/[name]/stats.tsx`
- Modify: `console/app/globals.css` (chart styles, appended at the end)

**Interfaces:**
- Consumes: `GET /api/v1/deployments/:name/stats?window=&api_key=&agent=` (Task 2 shape), `wsHeader()` from `app/lib/client.ts`. Props from Task 7: `{ name, keys: {id,name}[], agents: {id,name}[] }`.

- [ ] **Step 1: Implement `stats.tsx`**

```tsx
"use client";
// Realtime token graph (spec 2026-07-10): 3s polling over gateway_usage buckets.
import { useEffect, useState } from "react";
import { wsHeader } from "../../lib/client";

const WINDOWS: [string, string][] = [["1m", "Last minute"], ["5m", "Last 5 min"],
  ["30m", "Last 30 min"], ["1h", "Last hour"], ["3h", "Last 3 hours"]];

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

interface Stats {
  bucketSeconds: number;
  buckets: { t: number; tokens_in: number; tokens_out: number; requests: number }[];
  totals: { tokens_in: number; tokens_out: number; requests: number };
}

export function StatsTab({ name, keys, agents }:
  { name: string; keys: { id: string; name: string }[]; agents: { id: string; name: string }[] }) {
  const [win, setWin] = useState("5m");
  const [apiKey, setApiKey] = useState("");
  const [agent, setAgent] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let stale = false;
    const load = () => {
      const q = new URLSearchParams({ window: win });
      if (apiKey) q.set("api_key", apiKey);
      if (agent) q.set("agent", agent);
      fetch(`/api/v1/deployments/${encodeURIComponent(name)}/stats?${q}`, { headers: wsHeader() })
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => { if (!stale && s) { setStats(s); setLive(true); } })
        .catch(() => { if (!stale) setLive(false); });
    };
    load();
    const iv = setInterval(load, 3000);
    return () => { stale = true; clearInterval(iv); };
  }, [name, win, apiKey, agent]);

  const peak = Math.max(1, ...(stats?.buckets ?? []).map((b) => b.tokens_in + b.tokens_out));
  const label = (t: number) => new Date(t * 1000).toLocaleTimeString();
  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <select value={win} onChange={(e) => setWin(e.target.value)}>
          {WINDOWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={apiKey} onChange={(e) => setApiKey(e.target.value)}>
          <option value="">All traffic</option>
          <option value="__internal__">(internal sessions)</option>
          {keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
        </select>
        <select value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">All agents</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <span className={`livedot ${live ? "on" : ""}`} title={live ? "updating every 3s" : "not connected"} />
      </div>

      <div className="cards">
        <div className="card"><h3>Input tokens</h3><div className="big">{fmt(stats?.totals.tokens_in ?? 0)}</div></div>
        <div className="card"><h3>Output tokens</h3><div className="big">{fmt(stats?.totals.tokens_out ?? 0)}</div></div>
        <div className="card"><h3>Requests</h3><div className="big">{stats?.totals.requests ?? 0}</div></div>
      </div>

      <div className="group" style={{ padding: "6px 0 8px" }}>
        Tokens per {stats ? `${stats.bucketSeconds}s` : "bucket"}
        <span style={{ marginLeft: 12, fontSize: 11, color: "var(--muted)" }}>
          <span style={{ color: "var(--blue)" }}>■</span> input&nbsp;&nbsp;
          <span style={{ color: "#d97706" }}>■</span> output
        </span>
      </div>
      <div className="rt-chart">
        {(stats?.buckets ?? []).map((b) => (
          <div key={b.t} className="rt-col"
               title={`${label(b.t)}: ${fmt(b.tokens_in)} in / ${fmt(b.tokens_out)} out, ${b.requests} req`}>
            <div className="rt-bar out" style={{ height: `${(b.tokens_out / peak) * 100}%` }} />
            <div className="rt-bar in" style={{ height: `${(b.tokens_in / peak) * 100}%` }} />
          </div>
        ))}
        {!stats?.buckets.length && <div className="empty" style={{ margin: "auto", border: 0 }}>No traffic yet.</div>}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Chart CSS** (append to `console/app/globals.css`)

```css
/* Deployment realtime stats (spec 2026-07-10) */
.rt-chart { display: flex; align-items: flex-end; gap: 2px; height: 180px; padding: 4px;
  border: 1px solid var(--line); border-radius: 6px; background: var(--panel); margin-bottom: 22px; }
.rt-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; min-width: 2px; }
.rt-bar.in { background: var(--blue); }
.rt-bar.out { background: #d97706; }
.livedot { width: 8px; height: 8px; border-radius: 50%; background: var(--edge); display: inline-block; }
.livedot.on { background: #16a34a; animation: pulse 2.4s ease-in-out infinite; }
```

(`pulse` keyframes already exist from the session activity indicator — reuse, don't redefine.)

- [ ] **Step 3: Build + commit**

Run: `cd console && npx next build`
Expected: success.

```bash
git add console/app/deployments/[name]/stats.tsx console/app/globals.css
git commit -m "feat(console): deployment stats tab — realtime token chart with filters"
```

---

### Task 9: Console — Trace tab (live window)

**Files:**
- Modify (replace placeholder): `console/app/deployments/[name]/trace.tsx`
- Modify: `console/app/globals.css` (trace styles, appended)

**Interfaces:**
- Consumes: SSE `GET /api/v1/deployments/:name/trace/stream` emitting Task 4's event shapes. Props from Task 7 (keys/agents for name lookups).

- [ ] **Step 1: Implement `trace.tsx`**

```tsx
"use client";
// Live trace window (spec 2026-07-10): ephemeral — capture exists only while
// this component is mounted (the SSE connection maintains the gateway-side
// subscription). Nothing is stored; refresh = empty window.
import { useEffect, useRef, useState } from "react";

interface TraceEvent {
  id: string; kind: "request" | "response" | "error"; deployment: string; ts: string;
  source: "api" | "session"; api_key_id?: string; agent_id?: string; session_id?: string;
  messages?: { role: string; preview: string; length: number }[];
  tool_count?: number; tokens_in?: number; tokens_out?: number; duration_ms?: number;
  preview?: string; length?: number; error?: string;
}

const CAP = 200;   // newest-first, oldest dropped

export function TraceTab({ name, keys, agents }:
  { name: string; keys: { id: string; name: string }[]; agents: { id: string; name: string }[] }) {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [live, setLive] = useState(false);
  const [filter, setFilter] = useState("");
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const bufferRef = useRef<TraceEvent[]>([]);

  useEffect(() => {
    const es = new EventSource(`/api/v1/deployments/${encodeURIComponent(name)}/trace/stream`);
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);   // EventSource auto-reconnects
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as TraceEvent;
        if (pausedRef.current) { bufferRef.current.push(e); return; }
        setEvents((prev) => [e, ...prev].slice(0, CAP));
      } catch { /* keep-alive or malformed frame */ }
    };
    return () => { es.close(); setLive(false); };
  }, [name]);

  function resume() {
    setPaused(false);
    setEvents((prev) => [...bufferRef.current.reverse(), ...prev].slice(0, CAP));
    bufferRef.current = [];
  }
  const who = (e: TraceEvent) =>
    e.source === "session"
      ? `agent: ${agents.find((a) => a.id === e.agent_id)?.name ?? e.agent_id ?? "session"}`
      : `key: ${keys.find((k) => k.id === e.api_key_id)?.name ?? e.api_key_id ?? "api"}`;
  const visible = filter
    ? events.filter((e) => JSON.stringify(e).toLowerCase().includes(filter.toLowerCase()))
    : events;

  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <span className={`livedot ${live ? "on" : ""}`} title={live ? "capturing" : "reconnecting…"} />
        <span className="muted" style={{ fontSize: 12 }}>
          Capturing while this tab is open — nothing is stored.
        </span>
        <input type="search" placeholder="Filter…" value={filter}
          onChange={(e) => setFilter(e.target.value)} style={{ width: 180, marginLeft: "auto" }} />
        {paused
          ? <button onClick={resume}>Resume ({bufferRef.current.length})</button>
          : <button className="ghost" onClick={() => setPaused(true)}>Pause</button>}
        <button className="ghost" onClick={() => { setEvents([]); bufferRef.current = []; }}>Clear</button>
      </div>

      {visible.length === 0 && <div className="empty">Waiting for traffic to {name}…</div>}
      {visible.map((e, i) => (
        <div key={`${e.id}-${e.kind}-${i}`} className={`trace-card${e.kind === "error" ? " err" : ""}`}>
          <div className="trace-head">
            <span className={`chip ${e.kind}`}>{e.kind}</span>
            <span className="chip">{who(e)}</span>
            {e.kind === "response" && <span className="chip">{e.tokens_in}/{e.tokens_out} tok · {((e.duration_ms ?? 0) / 1000).toFixed(1)}s</span>}
            {e.kind === "request" && <span className="chip">{e.messages?.length ?? 0} msg · {e.tool_count} tools</span>}
            <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>{new Date(e.ts).toLocaleTimeString()}</span>
          </div>
          {e.kind === "request" && e.messages?.map((m, j) => (
            <details key={j} className="trace-msg">
              <summary><code>{m.role}</code> <span className="muted">{m.length.toLocaleString()} chars{m.length > m.preview.length ? " (truncated)" : ""}</span></summary>
              <pre className="block" style={{ maxHeight: 260 }}>{m.preview}</pre>
            </details>
          ))}
          {e.kind === "response" && (
            <details className="trace-msg" open={(e.length ?? 0) < 600}>
              <summary><code>assistant</code> <span className="muted">{(e.length ?? 0).toLocaleString()} chars{(e.length ?? 0) > (e.preview?.length ?? 0) ? " (truncated)" : ""}</span></summary>
              <pre className="block" style={{ maxHeight: 260 }}>{e.preview}</pre>
            </details>
          )}
          {e.kind === "error" && <pre className="block block-error" style={{ maxHeight: 200 }}>{e.error}</pre>}
        </div>
      ))}
    </>
  );
}
```

- [ ] **Step 2: Trace CSS** (append to `console/app/globals.css`)

```css
/* Deployment trace window */
.trace-card { border: 1px solid var(--line); border-radius: 6px; background: var(--panel);
  padding: 10px 12px; margin-bottom: 10px; }
.trace-card.err { border-color: color-mix(in srgb, #dc2626 45%, var(--line)); }
.trace-head { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
.trace-head .chip.request { color: var(--blue); }
.trace-head .chip.response { color: #16a34a; }
.trace-head .chip.error { color: #dc2626; }
.trace-msg summary { cursor: pointer; font-size: 12.5px; padding: 3px 0; }
.trace-msg pre { margin-top: 6px; }
```

- [ ] **Step 3: Build + commit**

Run: `cd console && npx next build`
Expected: success.

```bash
git add console/app/deployments/[name]/trace.tsx console/app/globals.css
git commit -m "feat(console): deployment trace tab — live request/response window"
```

---

### Task 10 (controller, no subagent): browser verification

- [ ] Restart the console on the new build; all pages 200; `/deployments` names link to detail pages.
- [ ] Detail page: Overview cards correct for one local + one external deployment; Edit button opens the shared modal (both kinds).
- [ ] Stats tab: run traffic (session + external), watch bars appear within ~3s; switch windows 1m→3h; filter by agent, by key, by "(internal sessions)".
- [ ] Trace tab: open, send both traffic kinds, see request/response cards with previews and token counts; truncation note on a large prompt; Pause buffers, Resume flushes, Clear empties; close the tab → `trace_subscriptions` row gone ≤15s; reopen works (EventSource reconnect through the Next proxy — verify with the browser, not plain curl, per SSE conventions).
- [ ] Usage page unchanged by session traffic.
- [ ] Update `.superpowers/sdd/progress.md` and CLAUDE.md is already updated (Task 7); then finishing-a-development-branch.
