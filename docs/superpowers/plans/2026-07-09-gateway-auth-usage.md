# Gateway API-Key Enforcement + Metered Usage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** UI-managed API keys become mandatory at the LiteLLM gateway; every authenticated request is metered per key/deployment into Postgres; the Usage page gains an "API usage" section with deployment/key/date-range filters.

**Architecture:** Auth + metering live inside the gateway (LiteLLM `custom_auth` + success-callback hooks in the `litellm-config` ConfigMap) querying the existing `api_keys` table and writing a new `gateway_usage` table over asyncpg. The control plane never sits in the request path: it manages keys, provisions a hidden internal key for agent session pods, and serves the read-side `/v1/usage/gateway` API to the console. Spec: `docs/superpowers/specs/2026-07-09-gateway-auth-usage-design.md` (spike-verified 2026-07-09).

**Tech Stack:** LiteLLM proxy (`ghcr.io/berriai/litellm:main-stable`), asyncpg 0.31 (installed at container start via `ensurepip` — spike-verified), Postgres 17, Fastify/TypeScript control plane, Next.js console, Node test runner.

## Global Constraints

- Everything workspace-scoped via `X-Devproof-Workspace` header (default `wrkspc_default`).
- All migrations idempotent (`IF NOT EXISTS`) — `db.ts migrate()` re-runs every file on each boot.
- `buildGatewayConfig` MUST keep `litellm_settings.callbacks: custom_callbacks.proxy_handler_instance` and MUST keep the schema-sanitizer `_scrub` logic in `custom_callbacks.py` — regressing either breaks Anthropic-dialect CLI clients against GGUF models (CLAUDE.md don't-regress items).
- Metering must never fail or delay a request (insert errors are logged and dropped).
- Auth fails closed: unknown key + Postgres down → reject; cached keys ride out blips (30 s TTL).
- Internal session-pod key is never shown in the UI and never metered.
- Range presets (exact set): `1d, 3d, 7d, 14d, month, last_month, 3m, 6m`; default `7d`.
- Backend verify: `cd control-plane && npm test` and `npx tsc --noEmit`. Console: production build only (`npx next build`).
- Commit after every green task; commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `control-plane/src/usage-range.ts` | create | pure preset→`{start,end,bucket}` resolver (unit-testable, no DB) |
| `control-plane/test/usage-range.test.ts` | create | preset window/bucket tests |
| `control-plane/sql/016_gateway_usage.sql` | create | `gateway_usage` table + indexes |
| `control-plane/src/repo.ts` | modify | add `gatewayUsage()` read aggregation |
| `control-plane/test/repo.test.ts` | modify | integration test for `gatewayUsage` (skip-if-no-DB) |
| `control-plane/src/agents-api.ts` | modify | `GET /v1/usage/gateway` route |
| `control-plane/test/agents-api.test.ts` | modify | route test with fake repo |
| `control-plane/src/gateway-config.ts` | modify | emit `general_settings.custom_auth` |
| `control-plane/test/gateway-config.test.ts` | modify | assert new block + callbacks retained |
| `control-plane/src/gateway-secret.ts` | create | ensure `gateway-auth` Secret, return internal key |
| `control-plane/src/main.ts` | modify | provision internal key at startup |
| `control-plane/src/orchestrator.ts` | modify | session pods use internal key |
| `deploy/gateway/litellm.yaml` | modify | auth+metering Python, bootstrap `general_settings`, env, startup command |
| `console/app/usage/api-usage.tsx` | create | client component: filters + chart + tables |
| `console/app/usage/page.tsx` | modify | render ApiUsage above retitled session section |
| `CLAUDE.md`, `docs/concept/platform-alignment-and-scale.md` | modify | connection docs + alignment note |

---

### Task 1: Date-range preset resolver (`usage-range.ts`)

**Files:**
- Create: `control-plane/src/usage-range.ts`
- Test: `control-plane/test/usage-range.test.ts`

**Interfaces:**
- Produces: `rangeWindow(range: string, now?: Date): { start: Date; end: Date | null; bucket: "day" | "week" }` — consumed by Task 2's `repo.gatewayUsage`. `end === null` means "unbounded (now)". Unknown/missing `range` falls back to `7d`.

- [ ] **Step 1: Write the failing tests**

```ts
// control-plane/test/usage-range.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { rangeWindow } from "../src/usage-range.ts";

// Fixed "now": Wed 2026-07-15 12:00 UTC
const NOW = new Date(Date.UTC(2026, 6, 15, 12, 0, 0));

test("rolling-day presets subtract whole days and bucket daily", () => {
  for (const [preset, days] of [["1d", 1], ["3d", 3], ["7d", 7], ["14d", 14]] as const) {
    const w = rangeWindow(preset, NOW);
    assert.equal(w.start.getTime(), NOW.getTime() - days * 86_400_000, preset);
    assert.equal(w.end, null);
    assert.equal(w.bucket, "day");
  }
});

test("month = start of current calendar month, unbounded", () => {
  const w = rangeWindow("month", NOW);
  assert.equal(w.start.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(w.end, null);
  assert.equal(w.bucket, "day");
});

test("last_month = previous calendar month, bounded", () => {
  const w = rangeWindow("last_month", NOW);
  assert.equal(w.start.toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal(w.end!.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(w.bucket, "day");
});

test("3m/6m are rolling months with weekly buckets", () => {
  const w3 = rangeWindow("3m", NOW);
  assert.equal(w3.start.toISOString(), "2026-04-15T12:00:00.000Z");
  assert.equal(w3.bucket, "week");
  const w6 = rangeWindow("6m", NOW);
  assert.equal(w6.start.toISOString(), "2026-01-15T12:00:00.000Z");
  assert.equal(w6.bucket, "week");
  assert.equal(w6.end, null);
});

test("unknown preset falls back to 7d", () => {
  const w = rangeWindow("bogus", NOW);
  assert.equal(w.start.getTime(), NOW.getTime() - 7 * 86_400_000);
  assert.equal(w.bucket, "day");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd control-plane && npx tsx --test test/usage-range.test.ts`
Expected: FAIL — `Cannot find module '../src/usage-range.ts'`

- [ ] **Step 3: Implement**

```ts
// control-plane/src/usage-range.ts
// Resolves a Usage-page date-range preset into a query window + chart bucket.
// Calendar presets (month/last_month) are UTC month boundaries; the rest are
// rolling windows ending now. 3m/6m bucket weekly so the chart stays readable.

const DAY_MS = 86_400_000;

export interface RangeWindow {
  start: Date;
  end: Date | null; // null = unbounded (now)
  bucket: "day" | "week";
}

export function rangeWindow(range: string, now = new Date()): RangeWindow {
  const monthsBack = (n: number) => {
    const d = new Date(now);
    d.setUTCMonth(d.getUTCMonth() - n);
    return d;
  };
  switch (range) {
    case "1d": return { start: new Date(now.getTime() - DAY_MS), end: null, bucket: "day" };
    case "3d": return { start: new Date(now.getTime() - 3 * DAY_MS), end: null, bucket: "day" };
    case "14d": return { start: new Date(now.getTime() - 14 * DAY_MS), end: null, bucket: "day" };
    case "month":
      return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: null, bucket: "day" };
    case "last_month":
      return {
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
        end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        bucket: "day",
      };
    case "3m": return { start: monthsBack(3), end: null, bucket: "week" };
    case "6m": return { start: monthsBack(6), end: null, bucket: "week" };
    case "7d":
    default: return { start: new Date(now.getTime() - 7 * DAY_MS), end: null, bucket: "day" };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npx tsx --test test/usage-range.test.ts`
Expected: 5 passing

- [ ] **Step 5: Typecheck and commit**

```bash
cd control-plane && npx tsc --noEmit
git add control-plane/src/usage-range.ts control-plane/test/usage-range.test.ts
git commit -m "feat(usage): date-range preset resolver for gateway usage queries"
```

---

### Task 2: `gateway_usage` table + `repo.gatewayUsage()`

**Files:**
- Create: `control-plane/sql/016_gateway_usage.sql`
- Modify: `control-plane/src/repo.ts` (add method after `workspaceUsage`, ~line 341; add import at top)
- Test: `control-plane/test/repo.test.ts` (append test)

**Interfaces:**
- Consumes: `rangeWindow` from Task 1.
- Produces: `repo.gatewayUsage(workspaceId: string, opts: { range?: string; deployment?: string; apiKeyId?: string })` → `Promise<{ bucket: "day"|"week"; buckets: {bucket: string; tokens_in: number; tokens_out: number; requests: number}[]; totals: {tokens_in: number; tokens_out: number; requests: number}; byDeployment: {model: string; tokens_in: number; tokens_out: number; requests: number}[]; byKey: {api_key_id: string|null; name: string|null; tokens_in: number; tokens_out: number; requests: number}[] }>` — consumed by Task 3's route and Task 7's UI. The gateway (Task 6) INSERTs into this table directly; the repo only reads.

- [ ] **Step 1: Write the migration**

```sql
-- control-plane/sql/016_gateway_usage.sql
-- Per-request token metering written by the gateway's success hook
-- (custom_callbacks.py). ON DELETE SET NULL keeps historical totals when a
-- key is deleted; the UI shows such rows as "(deleted key)".
CREATE TABLE IF NOT EXISTS gateway_usage (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  api_key_id    TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  model         TEXT NOT NULL,
  tokens_in     BIGINT NOT NULL DEFAULT 0,
  tokens_out    BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gateway_usage_ws_time  ON gateway_usage (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS gateway_usage_key_time ON gateway_usage (api_key_id, created_at);
```

- [ ] **Step 2: Write the failing integration test**

Append to `control-plane/test/repo.test.ts` (before `test.after`); it follows the file's existing skip-if-no-DB pattern (`{ skip: !available }`):

```ts
test("gatewayUsage aggregates buckets, totals, and filters", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const WS = `wsu-${Date.now()}`; // isolated workspace so reruns don't accumulate
  const key = await repo.createApiKey(WS, "usage-test-key");
  await pool.query(
    `INSERT INTO gateway_usage (workspace_id, api_key_id, model, tokens_in, tokens_out, created_at) VALUES
     ($1, $2, 'dep-a', 100, 10, now()),
     ($1, $2, 'dep-b', 200, 20, now()),
     ($1, NULL, 'dep-a', 50, 5, now()),                         -- deleted-key row
     ($1, $2, 'dep-a', 999, 99, now() - interval '30 days')`,   -- outside 7d window
    [WS, key.id],
  );

  const all = await repo.gatewayUsage(WS, { range: "7d" });
  assert.equal(all.bucket, "day");
  assert.equal(all.totals.tokens_in, 350);
  assert.equal(all.totals.tokens_out, 35);
  assert.equal(all.totals.requests, 3);
  assert.equal(all.buckets.length, 1); // all three rows land in today's bucket
  assert.equal(all.byDeployment.find((d: any) => d.model === "dep-a")!.tokens_in, 150);
  const deleted = all.byKey.find((k: any) => k.api_key_id === null)!;
  assert.equal(deleted.name, null);
  assert.equal(deleted.tokens_in, 50);
  assert.equal(all.byKey.find((k: any) => k.api_key_id === key.id)!.name, "usage-test-key");

  const depOnly = await repo.gatewayUsage(WS, { range: "7d", deployment: "dep-b" });
  assert.equal(depOnly.totals.tokens_in, 200);

  const keyOnly = await repo.gatewayUsage(WS, { range: "7d", apiKeyId: key.id });
  assert.equal(keyOnly.totals.tokens_in, 300);

  const sixMonths = await repo.gatewayUsage(WS, { range: "6m" });
  assert.equal(sixMonths.bucket, "week");
  assert.equal(sixMonths.totals.tokens_in, 350 + 999);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd control-plane && npx tsx --test test/repo.test.ts`
Expected: FAIL — `repo.gatewayUsage is not a function` (or skip if DB unreachable — start the localhost-lb Postgres first; this test REQUIRES the live dev DB)

- [ ] **Step 4: Implement `gatewayUsage`**

In `control-plane/src/repo.ts`: add `import { rangeWindow } from "./usage-range.ts";` next to the existing imports, then insert after the `workspaceUsage` method (after line 341):

```ts
  /** Gateway-metered API usage (gateway_usage, written by the gateway's
   *  success hook). Read-side only — filters + bucketing for the Usage page. */
  async gatewayUsage(
    workspaceId: string,
    opts: { range?: string; deployment?: string; apiKeyId?: string } = {},
  ) {
    const { start, end, bucket } = rangeWindow(opts.range ?? "7d");
    const conds = ["u.workspace_id = $1", "u.created_at >= $2"];
    const params: unknown[] = [workspaceId, start];
    if (end) { params.push(end); conds.push(`u.created_at < $${params.length}`); }
    if (opts.deployment) { params.push(opts.deployment); conds.push(`u.model = $${params.length}`); }
    if (opts.apiKeyId) { params.push(opts.apiKeyId); conds.push(`u.api_key_id = $${params.length}`); }
    const where = conds.join(" AND ");
    const num = (r: any) => ({ ...r, tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out), requests: Number(r.requests) });

    const [buckets, totals, byDeployment, byKey] = await Promise.all([
      this.pool.query(
        `SELECT to_char(date_trunc('${bucket}', u.created_at), 'YYYY-MM-DD') AS bucket,
                COALESCE(sum(u.tokens_in),0)::bigint AS tokens_in,
                COALESCE(sum(u.tokens_out),0)::bigint AS tokens_out, count(*)::int AS requests
         FROM gateway_usage u WHERE ${where} GROUP BY 1 ORDER BY 1`, params),
      this.pool.query(
        `SELECT COALESCE(sum(u.tokens_in),0)::bigint AS tokens_in,
                COALESCE(sum(u.tokens_out),0)::bigint AS tokens_out, count(*)::int AS requests
         FROM gateway_usage u WHERE ${where}`, params),
      this.pool.query(
        `SELECT u.model, COALESCE(sum(u.tokens_in),0)::bigint AS tokens_in,
                COALESCE(sum(u.tokens_out),0)::bigint AS tokens_out, count(*)::int AS requests
         FROM gateway_usage u WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, params),
      this.pool.query(
        `SELECT u.api_key_id, k.name, COALESCE(sum(u.tokens_in),0)::bigint AS tokens_in,
                COALESCE(sum(u.tokens_out),0)::bigint AS tokens_out, count(*)::int AS requests
         FROM gateway_usage u LEFT JOIN api_keys k ON k.id = u.api_key_id
         WHERE ${where} GROUP BY 1, 2 ORDER BY 3 DESC`, params),
    ]);
    return {
      bucket,
      buckets: buckets.rows.map(num),
      totals: num(totals.rows[0]),
      byDeployment: byDeployment.rows.map(num),
      byKey: byKey.rows.map(num),
    };
  }
```

Note: `bucket` is interpolated but comes only from `rangeWindow`'s literal `"day" | "week"` — never from user input. All user input goes through `$n` params.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd control-plane && npx tsx --test test/repo.test.ts`
Expected: PASS (both roundtrip and gatewayUsage tests)

- [ ] **Step 6: Typecheck and commit**

```bash
cd control-plane && npx tsc --noEmit
git add control-plane/sql/016_gateway_usage.sql control-plane/src/repo.ts control-plane/test/repo.test.ts
git commit -m "feat(usage): gateway_usage table + workspace-scoped aggregation with deployment/key/range filters"
```

---

### Task 3: `GET /v1/usage/gateway` route

**Files:**
- Modify: `control-plane/src/agents-api.ts` (next to the existing `/v1/usage` route, ~line 503)
- Test: `control-plane/test/agents-api.test.ts`

**Interfaces:**
- Consumes: `repo.gatewayUsage(ws, {range, deployment, apiKeyId})` from Task 2.
- Produces: `GET /v1/usage/gateway?range=&deployment=&api_key=` returning the Task 2 shape verbatim — consumed by Task 7's client component. Query param is `api_key` (external name) mapping to `apiKeyId` (internal).

- [ ] **Step 1: Write the failing test**

Append to the fake `repo` object in `control-plane/test/agents-api.test.ts` `fakes()` (after `listApiKeys`-style methods; if none exists just add to the object):

```ts
    async gatewayUsage(ws: string, opts: any) {
      return { calledWith: { ws, ...opts }, bucket: "day", buckets: [], totals: { tokens_in: 0, tokens_out: 0, requests: 0 }, byDeployment: [], byKey: [] };
    },
```

Then add the test (same style as the file's other route tests, using `app.inject`):

```ts
test("GET /v1/usage/gateway forwards workspace and filters to repo", async () => {
  const { app } = await build(); // reuse the file's existing builder helper name — check top of file
  const res = await app.inject({
    method: "GET",
    url: "/v1/usage/gateway?range=3m&deployment=dep-a&api_key=apikey_1",
    headers: { "x-devproof-workspace": "wrkspc_test" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.calledWith, { ws: "wrkspc_test", range: "3m", deployment: "dep-a", apiKeyId: "apikey_1" });
});
```

(Adapt the builder call to the file's actual helper — the file constructs `Fastify()` + `registerAgentRoutes(app, repo as any, orch, files, hub)`; follow the pattern of the nearest existing test verbatim.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npx tsx --test test/agents-api.test.ts`
Expected: FAIL — 404 route not found

- [ ] **Step 3: Implement the route**

In `control-plane/src/agents-api.ts`, directly under the existing `/v1/usage` route (~line 504):

```ts
  // Gateway-metered API usage (external clients via API keys).
  app.get("/v1/usage/gateway", async (req) => {
    const q = req.query as { range?: string; deployment?: string; api_key?: string };
    return repo.gatewayUsage(ws(req), {
      range: q.range ?? "7d",
      ...(q.deployment ? { deployment: q.deployment } : {}),
      ...(q.api_key ? { apiKeyId: q.api_key } : {}),
    });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npx tsx --test test/agents-api.test.ts`
Expected: PASS

- [ ] **Step 5: Full backend test + commit**

```bash
cd control-plane && npm test && npx tsc --noEmit
git add control-plane/src/agents-api.ts control-plane/test/agents-api.test.ts
git commit -m "feat(usage): GET /v1/usage/gateway with range/deployment/api_key filters"
```

---

### Task 4: `buildGatewayConfig` emits `general_settings.custom_auth`

**Files:**
- Modify: `control-plane/src/gateway-config.ts`
- Test: `control-plane/test/gateway-config.test.ts`

**Interfaces:**
- Produces: generated `config.yaml` containing `general_settings: { custom_auth: "custom_callbacks.user_custom_auth" }` — the Python function ships in Task 6. Existing `model_list`/`litellm_settings` output unchanged.

- [ ] **Step 1: Write the failing test**

Append to `control-plane/test/gateway-config.test.ts`:

```ts
test("buildGatewayConfig enables custom auth and keeps sanitizer callbacks", () => {
  const cfg = parse(buildGatewayConfig([dep("a", "Ready")]));
  assert.equal(cfg.general_settings.custom_auth, "custom_callbacks.user_custom_auth");
  // CLAUDE.md don't-regress: sanitizer callback must survive any config change.
  assert.equal(cfg.litellm_settings.callbacks, "custom_callbacks.proxy_handler_instance");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npx tsx --test test/gateway-config.test.ts`
Expected: FAIL — `general_settings` undefined

- [ ] **Step 3: Implement**

In `control-plane/src/gateway-config.ts`, extend the returned object (lines 21–30):

```ts
  return stringify({
    model_list,
    litellm_settings: {
      drop_params: true,
      // custom_callbacks.py (mounted beside config.yaml) strips oversized
      // string-length bounds from tool schemas — they break llama.cpp's
      // JSON-schema→grammar conversion ("failed to parse grammar").
      callbacks: "custom_callbacks.proxy_handler_instance",
    },
    general_settings: {
      // API-key enforcement against the api_keys table (custom_callbacks.py).
      custom_auth: "custom_callbacks.user_custom_auth",
    },
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npx tsx --test test/gateway-config.test.ts`
Expected: 3 passing

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/gateway-config.ts control-plane/test/gateway-config.test.ts
git commit -m "feat(gateway): generated config enables custom_auth key enforcement"
```

---

### Task 5: Internal session-pod key (Secret provisioning + orchestrator env)

**Files:**
- Create: `control-plane/src/gateway-secret.ts`
- Modify: `control-plane/src/main.ts` (after `migrate`, before `realOrchestrator()` use)
- Modify: `control-plane/src/orchestrator.ts:247`

**Interfaces:**
- Produces: `ensureGatewayAuthSecret(): Promise<string>` — idempotently ensures Secret `gateway-auth` (key `internal-key`) in namespace `devproof-gateway`, returns the key value. `main.ts` stores it in `process.env.DEVPROOF_INTERNAL_KEY`; the orchestrator reads that env when building session Job specs; the gateway Deployment consumes the same Secret via `secretKeyRef` (Task 6).
- No unit test (thin K8s wrapper following `kubestore.ts` conventions) — verified live in Task 8.

- [ ] **Step 1: Implement `gateway-secret.ts`**

```ts
// control-plane/src/gateway-secret.ts
// Internal API key for platform-owned gateway traffic (agent session pods).
// Never shown in the UI, never metered. Lives in a K8s Secret consumed by
// both the gateway Deployment (env DEVPROOF_INTERNAL_KEY) and session Jobs.
import { randomBytes } from "node:crypto";
import * as k8s from "@kubernetes/client-node";
import { GATEWAY_NAMESPACE } from "./kubestore.ts";

const SECRET_NAME = "gateway-auth";

export async function ensureGatewayAuthSecret(): Promise<string> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(k8s.CoreV1Api);
  try {
    const s: any = await core.readNamespacedSecret({ name: SECRET_NAME, namespace: GATEWAY_NAMESPACE });
    const b64 = s.data?.["internal-key"];
    if (b64) return Buffer.from(b64, "base64").toString("utf8");
  } catch (err: any) {
    if (err?.code !== 404) throw err;
  }
  const key = `dpk_internal_${randomBytes(24).toString("hex")}`;
  const body = { metadata: { name: SECRET_NAME }, stringData: { "internal-key": key } };
  try {
    await core.createNamespacedSecret({ namespace: GATEWAY_NAMESPACE, body });
  } catch (err: any) {
    if (err?.code !== 409) throw err; // lost a create race: another replica made it
    return ensureGatewayAuthSecret();
  }
  return key;
}
```

- [ ] **Step 2: Wire into `main.ts`**

In `control-plane/src/main.ts`, after `await migrate(pool);` (line 16) add:

```ts
import { ensureGatewayAuthSecret } from "./gateway-secret.ts";
```
(with the other imports), and after the `migrate` call:

```ts
// Internal key for session pods → gateway; gateway pods read the same Secret.
try {
  process.env.DEVPROOF_INTERNAL_KEY = await ensureGatewayAuthSecret();
} catch (err) {
  console.warn("gateway-auth secret unavailable — session pods will send 'none':", err);
}
```

- [ ] **Step 3: Use it in the orchestrator**

`control-plane/src/orchestrator.ts:247` — replace:

```ts
                      { name: "ANTHROPIC_AUTH_TOKEN", value: "none" },
```

with:

```ts
                      // Internal key: passes gateway auth, excluded from metering.
                      { name: "ANTHROPIC_AUTH_TOKEN", value: process.env.DEVPROOF_INTERNAL_KEY ?? "none" },
```

(Read at Job-build time, not module load — main.ts sets the env before any session starts.)

- [ ] **Step 4: Verify and commit**

```bash
cd control-plane && npx tsc --noEmit && npm test
git add control-plane/src/gateway-secret.ts control-plane/src/main.ts control-plane/src/orchestrator.ts
git commit -m "feat(gateway): provision internal session-pod key via gateway-auth Secret"
```

---

### Task 6: Gateway manifest — auth + metering hooks

**Files:**
- Modify: `deploy/gateway/litellm.yaml` (all three: ConfigMap `custom_callbacks.py`, ConfigMap bootstrap `config.yaml`, Deployment)

This is the production version of the spike (spike-verified field names). No repo-side tests possible — verified live in steps 4–5 and Task 8.

- [ ] **Step 1: Replace `custom_callbacks.py` in the ConfigMap**

The full new `data.custom_callbacks.py` content (keeps `_scrub` verbatim; adds auth + metering):

```python
# Devproof gateway hooks — three responsibilities:
#  1. Schema sanitizer (DON'T REGRESS — Anthropic-dialect CLI clients on GGUF break without it):
#     strips string bounds >1024 and backslash-class regex patterns that
#     llama.cpp's GBNF grammar parser rejects ("failed to parse grammar").
#  2. custom_auth: enforce console-managed API keys (api_keys table, sha256,
#     status='active'), 30s TTL cache, fail closed. Internal session-pod key
#     via DEVPROOF_INTERNAL_KEY env (gateway-auth Secret).
#  3. Metering: one gateway_usage row per successful external request
#     (spike-verified fields: standard_logging_object prompt/completion_tokens
#     + metadata.user_api_key_auth_metadata; kwargs["model"] = deployment).
import asyncio, hashlib, hmac, os, time

import asyncpg
from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy._types import UserAPIKeyAuth

DATABASE_URL = os.environ.get("DEVPROOF_DATABASE_URL", "")  # NOT "DATABASE_URL" — that name activates LiteLLM's destructive Prisma DB mode
INTERNAL_KEY = os.environ.get("DEVPROOF_INTERNAL_KEY", "")
CACHE_TTL = 30.0          # seconds; also the max revocation latency
TOUCH_INTERVAL = 60.0     # min seconds between last_used_at writes per key

MAX_BOUND = 1024

def _scrub(node):
    if isinstance(node, dict):
        for key in ("maxLength", "minLength"):
            v = node.get(key)
            if isinstance(v, int) and v > MAX_BOUND:
                node.pop(key, None)
        p = node.get("pattern")
        if isinstance(p, str) and "\\" in p:
            node.pop("pattern", None)
        for v in node.values():
            _scrub(v)
    elif isinstance(node, list):
        for v in node:
            _scrub(v)

_pool = None
_pool_lock = asyncio.Lock()

async def _db():
    global _pool
    if _pool is None:
        async with _pool_lock:
            if _pool is None:
                _pool = await asyncpg.create_pool(DATABASE_URL, min_size=0, max_size=4)
    return _pool

_cache = {}       # sha256(key) -> (expires_monotonic, key_id, workspace_id)
_last_touch = {}  # key_id -> monotonic time of last last_used_at write

async def _touch(key_id):
    try:
        pool = await _db()
        await pool.execute("UPDATE api_keys SET last_used_at = now() WHERE id = $1", key_id)
    except Exception as e:  # noqa: BLE001 — best-effort
        print(f"devproof-auth: last_used_at update failed: {e}", flush=True)

async def user_custom_auth(request, api_key: str) -> UserAPIKeyAuth:
    if not api_key:
        raise Exception("Missing Devproof API key")
    if INTERNAL_KEY and hmac.compare_digest(api_key, INTERNAL_KEY):
        return UserAPIKeyAuth(api_key=api_key, key_alias="devproof-internal",
                              metadata={"devproof_internal": True})
    h = hashlib.sha256(api_key.encode()).hexdigest()
    now = time.monotonic()
    hit = _cache.get(h)
    if hit and hit[0] > now:
        _, key_id, ws = hit
    else:
        pool = await _db()  # DB unreachable + uncached -> raises -> fail closed
        row = await pool.fetchrow(
            "SELECT id, workspace_id FROM api_keys WHERE secret_hash = $1 AND status = 'active'", h)
        if row is None:
            _cache.pop(h, None)
            raise Exception("Invalid Devproof API key")
        key_id, ws = row["id"], row["workspace_id"]
        _cache[h] = (now + CACHE_TTL, key_id, ws)
    if now - _last_touch.get(key_id, 0.0) > TOUCH_INTERVAL:
        _last_touch[key_id] = now
        asyncio.ensure_future(_touch(key_id))
    return UserAPIKeyAuth(api_key=api_key, key_alias=key_id,
                          metadata={"devproof_key_id": key_id, "devproof_workspace": ws})

class SchemaSanitizer(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        for t in data.get("tools") or []:
            _scrub(t)
        return data

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        # Metering must never fail a request: everything is best-effort.
        try:
            slo = kwargs.get("standard_logging_object") or {}
            auth_md = (slo.get("metadata") or {}).get("user_api_key_auth_metadata") or {}
            if auth_md.get("devproof_internal"):
                return  # platform-owned traffic (agent sessions) is not metered
            key_id = auth_md.get("devproof_key_id")
            ws = auth_md.get("devproof_workspace")
            if not key_id:
                return
            model = kwargs.get("model") or slo.get("model") or "unknown"
            tokens_in = int(slo.get("prompt_tokens") or 0)
            tokens_out = int(slo.get("completion_tokens") or 0)
            pool = await _db()
            await pool.execute(
                """INSERT INTO gateway_usage (workspace_id, api_key_id, model, tokens_in, tokens_out)
                   VALUES ($1, $2, $3, $4, $5)""",
                ws, key_id, model, tokens_in, tokens_out)
        except Exception as e:  # noqa: BLE001
            print(f"devproof-metering: dropped usage row: {e}", flush=True)

proxy_handler_instance = SchemaSanitizer()
```

- [ ] **Step 2: Update the bootstrap `config.yaml` in the same ConfigMap**

Add to the end of `data.config.yaml` (after the `litellm_settings` block) so a fresh install is never open:

```yaml
    general_settings:
      custom_auth: custom_callbacks.user_custom_auth
```

- [ ] **Step 3: Update the Deployment (env + startup command)**

In the `gateway` Deployment container spec, replace

```yaml
          args: ["--config", "/etc/litellm/config.yaml", "--port", "4000"]
```

with (spike-verified — the image venv ships no pip; `ensurepip` bootstraps it):

```yaml
          command: ["/bin/sh", "-c"]
          # asyncpg is not in the litellm image and its venv has no pip;
          # ensurepip is available. Air-gap follow-up: bake a devproof/gateway image.
          args:
            - python3 -m ensurepip && python3 -m pip install --no-cache-dir asyncpg
              && exec litellm --config /etc/litellm/config.yaml --port 4000
          env:
            # DEVPROOF_ prefix is load-bearing: a literal DATABASE_URL env makes
            # LiteLLM run its own Prisma migration and DROP the shared schema
            # (happened live 2026-07-09 — see task-6 report).
            - name: DEVPROOF_DATABASE_URL
              # dev creds from deploy/postgres/postgres.yaml; real secret mgmt is phase 4+
              value: postgresql://devproof:devproof-dev@postgres.devproof-system.svc.cluster.local:5432/devproof
            - name: DEVPROOF_INTERNAL_KEY
              valueFrom:
                secretKeyRef: { name: gateway-auth, key: internal-key, optional: true }
```

(`optional: true`: on a fresh cluster the Secret appears on first control-plane boot; the next config-sync restart picks it up.)

- [ ] **Step 4: Apply and verify auth live**

```bash
kubectl apply -f deploy/gateway/litellm.yaml
kubectl rollout status deployment/gateway -n devproof-gateway --timeout=240s
# no key -> 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:14000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen05b-dp","messages":[{"role":"user","content":"hi"}],"max_tokens":3}'
```
Expected: `401`. Then create a real key and use it:

```bash
KEY=$(curl -s -X POST http://localhost:7080/v1/api-keys -H "Content-Type: application/json" \
  -H "X-Devproof-Workspace: wrkspc_default" -d '{"name":"e2e"}' | python -c "import sys,json;print(json.load(sys.stdin)['key'])")
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:14000/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"model":"qwen05b-dp","messages":[{"role":"user","content":"hi"}],"max_tokens":3}'
```
Expected: `200` (control plane must be running for key creation; start it per CLAUDE.md if needed).

- [ ] **Step 5: Verify a metering row landed**

```bash
kubectl exec -n devproof-system deploy/postgres -- psql -U devproof -d devproof \
  -c "SELECT api_key_id, model, tokens_in, tokens_out FROM gateway_usage ORDER BY id DESC LIMIT 3"
```
Expected: a row with your key id, `qwen05b-dp`, nonzero tokens_in.

- [ ] **Step 6: Commit**

```bash
git add deploy/gateway/litellm.yaml
git commit -m "feat(gateway): enforce console API keys + per-request token metering in LiteLLM hooks"
```

---

### Task 7: Console Usage page — "API usage" section

**Files:**
- Create: `console/app/usage/api-usage.tsx`
- Modify: `console/app/usage/page.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/usage/gateway?range=&deployment=&api_key=` (Next rewrite → control plane, Task 3 shape); `wsHeader()` from `app/lib/client.ts`; props from the server page: `deployments: string[]`, `keys: {id: string; name: string}[]`.
- Produces: `<ApiUsage deployments={...} keys={...} />` default-exported client component.

- [ ] **Step 1: Write the client component**

```tsx
// console/app/usage/api-usage.tsx
"use client";
// Gateway-metered API usage: tokens by external API key/deployment, with
// deployment / key / date-range filters (spec 2026-07-09).
import { useEffect, useState } from "react";
import { wsHeader } from "../lib/client";

const RANGES: [string, string][] = [
  ["1d", "Last day"], ["3d", "Last 3 days"], ["7d", "Last 7 days"], ["14d", "Last 14 days"],
  ["month", "Current month"], ["last_month", "Last month"], ["3m", "Last 3 months"], ["6m", "Last 6 months"],
];

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

interface Usage {
  bucket: "day" | "week";
  buckets: { bucket: string; tokens_in: number; tokens_out: number; requests: number }[];
  totals: { tokens_in: number; tokens_out: number; requests: number };
  byDeployment: { model: string; tokens_in: number; tokens_out: number; requests: number }[];
  byKey: { api_key_id: string | null; name: string | null; tokens_in: number; tokens_out: number; requests: number }[];
}

export default function ApiUsage({ deployments, keys }: { deployments: string[]; keys: { id: string; name: string }[] }) {
  const [range, setRange] = useState("7d");
  const [deployment, setDeployment] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    const q = new URLSearchParams({ range });
    if (deployment) q.set("deployment", deployment);
    if (apiKey) q.set("api_key", apiKey);
    let stale = false;
    fetch(`/api/v1/usage/gateway?${q}`, { headers: wsHeader() })
      .then((r) => r.json())
      .then((u) => { if (!stale) setUsage(u); })
      .catch(() => { if (!stale) setUsage(null); });
    return () => { stale = true; };
  }, [range, deployment, apiKey]);

  const peak = Math.max(1, ...(usage?.buckets ?? []).map((b) => b.tokens_in + b.tokens_out));
  const keyLabel = (k: { api_key_id: string | null; name: string | null }) =>
    k.api_key_id === null ? "(deleted key)" : k.name ?? k.api_key_id;

  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <select value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <select value={deployment} onChange={(e) => setDeployment(e.target.value)}>
          <option value="">All deployments</option>
          {deployments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={apiKey} onChange={(e) => setApiKey(e.target.value)}>
          <option value="">All API keys</option>
          {keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
        </select>
      </div>

      <div className="cards">
        <div className="card"><h3>Input tokens</h3><div className="big">{fmt(usage?.totals.tokens_in ?? 0)}</div></div>
        <div className="card"><h3>Output tokens</h3><div className="big">{fmt(usage?.totals.tokens_out ?? 0)}</div></div>
        <div className="card"><h3>Requests</h3><div className="big">{usage?.totals.requests ?? 0}</div></div>
      </div>

      <div className="group" style={{ padding: "6px 0 8px" }}>
        Tokens per {usage?.bucket === "week" ? "week" : "day"}
        <span style={{ marginLeft: 12, fontSize: 11, color: "var(--muted)" }}>
          <span style={{ color: "var(--blue)" }}>■</span> input&nbsp;&nbsp;
          <span style={{ color: "#d97706" }}>■</span> output
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 140, padding: "0 4px 4px",
                    border: "1px solid var(--line)", borderRadius: 6, background: "var(--panel)", marginBottom: 22 }}>
        {(usage?.buckets ?? []).length === 0 && <div className="empty" style={{ margin: "auto", border: 0 }}>No API usage in this range.</div>}
        {(usage?.buckets ?? []).map((b) => (
          <div key={b.bucket} title={`${b.bucket}: ${fmt(b.tokens_in)} in / ${fmt(b.tokens_out)} out, ${b.requests} requests`}
               style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, height: "100%", justifyContent: "flex-end" }}>
            <div style={{ width: "70%", display: "flex", flexDirection: "column", justifyContent: "flex-end",
                          height: `${((b.tokens_in + b.tokens_out) / peak) * 100}%`, minHeight: b.tokens_in + b.tokens_out ? 3 : 0 }}>
              <div style={{ background: "#d97706", height: `${(b.tokens_out / Math.max(1, b.tokens_in + b.tokens_out)) * 100}%`, borderRadius: "3px 3px 0 0" }} />
              <div style={{ background: "var(--blue)", flex: 1 }} />
            </div>
            <div style={{ fontSize: 9, color: "var(--muted)", writingMode: "vertical-rl", transform: "rotate(180deg)" }}>{b.bucket.slice(5)}</div>
          </div>
        ))}
      </div>

      <div className="group" style={{ padding: "0 0 8px" }}>By deployment</div>
      <div className="tablewrap" style={{ marginBottom: 22 }}><table>
        <thead><tr><th>Deployment</th><th>Requests</th><th>Input tokens</th><th>Output tokens</th></tr></thead>
        <tbody>
          {(usage?.byDeployment ?? []).map((d) => (
            <tr key={d.model}><td><code>{d.model}</code></td><td>{d.requests}</td><td>{fmt(d.tokens_in)}</td><td>{fmt(d.tokens_out)}</td></tr>
          ))}
          {(usage?.byDeployment ?? []).length === 0 && <tr><td colSpan={4} className="empty">No API usage yet.</td></tr>}
        </tbody>
      </table></div>

      <div className="group" style={{ padding: "0 0 8px" }}>By API key</div>
      <div className="tablewrap" style={{ marginBottom: 22 }}><table>
        <thead><tr><th>API key</th><th>Requests</th><th>Input tokens</th><th>Output tokens</th></tr></thead>
        <tbody>
          {(usage?.byKey ?? []).map((k) => (
            <tr key={k.api_key_id ?? "deleted"}><td>{keyLabel(k)}</td><td>{k.requests}</td><td>{fmt(k.tokens_in)}</td><td>{fmt(k.tokens_out)}</td></tr>
          ))}
          {(usage?.byKey ?? []).length === 0 && <tr><td colSpan={4} className="empty">No API usage yet.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
```

- [ ] **Step 2: Restructure the server page**

`console/app/usage/page.tsx` — keep the existing session content but: fetch deployments + keys, render `<ApiUsage>` first, retitle the session block. New top of the component:

```tsx
import { wsGet } from "../lib/api";
import ApiUsage from "./api-usage";

export const dynamic = "force-dynamic";

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export default async function UsagePage() {
  const usage = await wsGet<{ daily: any[]; byModel: any[] }>("/v1/usage").catch(() => ({ daily: [], byModel: [] }));
  const deps = await wsGet<{ deployments: { name: string }[] }>("/v1/deployments").catch(() => ({ deployments: [] }));
  const keys = await wsGet<{ keys: { id: string; name: string }[] }>("/v1/api-keys").catch(() => ({ keys: [] }));
  const totalIn = usage.byModel.reduce((a, m) => a + Number(m.tokens_in), 0);
  const totalOut = usage.byModel.reduce((a, m) => a + Number(m.tokens_out), 0);
  const totalSessions = usage.daily.reduce((a, d) => a + Number(d.sessions), 0);
  const peak = Math.max(1, ...usage.daily.map((d) => Number(d.tokens_in) + Number(d.tokens_out)));
  return (
    <>
      <div className="pagehead"><h1>Usage</h1></div>
      <p className="sub">API usage is metered at the gateway per API key and deployment. Session usage below covers managed-agent runs.</p>

      <div className="group" style={{ padding: "6px 0 8px", fontWeight: 600 }}>API usage</div>
      <ApiUsage deployments={deps.deployments.map((d) => d.name)} keys={keys.keys} />

      <div className="group" style={{ padding: "6px 0 8px", fontWeight: 600 }}>Session usage (last 14 days)</div>
      {/* ...existing cards + chart + by-model table stay EXACTLY as they are today... */}
```

Everything from the old `<div className="cards">` down stays byte-identical (it becomes the "Session usage" section); only the old `<p className="sub">` line is replaced by the new one above.

- [ ] **Step 3: Build and verify in the browser**

```bash
cd console && npx next build && npx next start -p 7090
```
Expected: build succeeds. Open `http://localhost:7090/usage`: filter bar renders with 8 range options, cards show the Task 6 test traffic, changing filters refetches (network tab shows `/api/v1/usage/gateway?...`), session section unchanged below.

- [ ] **Step 4: Commit**

```bash
git add console/app/usage/api-usage.tsx console/app/usage/page.tsx
git commit -m "feat(console): API usage section with deployment/key/date-range filters on Usage page"
```

---

### Task 8: End-to-end verification + docs

**Files:**
- Modify: `CLAUDE.md` ("Using Claude Code against a Devproof model" section)
- Modify: `docs/concept/platform-alignment-and-scale.md` (§1 table + §2)

- [ ] **Step 1: Full e2e checklist against the live cluster**

With control plane (env per CLAUDE.md), console, and operator running:

```bash
# 1. Revocation: deactivate the e2e key, expect 401 within ~30s
curl -s -X POST http://localhost:7080/v1/api-keys/<id> -H "Content-Type: application/json" \
  -H "X-Devproof-Workspace: wrkspc_default" -d '{"status":"inactive"}'
sleep 35
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:14000/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"model":"qwen05b-dp","messages":[{"role":"user","content":"hi"}],"max_tokens":3}'   # expect 401
# 2. Delete the key; usage rows must survive as api_key_id NULL
curl -s -X DELETE http://localhost:7080/v1/api-keys/<id> -H "X-Devproof-Workspace: wrkspc_default"
kubectl exec -n devproof-system deploy/postgres -- psql -U devproof -d devproof \
  -c "SELECT count(*) FROM gateway_usage WHERE api_key_id IS NULL"                          # expect >= 1
# 3. Anthropic dialect + streaming with a fresh active key (expect 200 + new usage row)
# 4. Agent session e2e: create agent + session in the console; session completes
#    (internal key works) and gateway_usage row count does NOT increase from it
# 5. Coding-agent CLI smoke: ANTHROPIC_BASE_URL=http://localhost:14000 ANTHROPIC_API_KEY=<fresh key>
#    <agent-cli> --model qwen05b-dp --strict-mcp-config --mcp-config empty.json -p "say hi"
# 6. Usage page: totals/filters consistent with SELECTs; "(deleted key)" row visible
# 7. Regression: all console pages 200; cd control-plane && npm test && npx tsc --noEmit
```

- [ ] **Step 2: Update CLAUDE.md**

In "Using Claude Code against a Devproof model": replace `ANTHROPIC_API_KEY=none` with "create a key on the API Keys page and set `ANTHROPIC_API_KEY=dpk_…` — the gateway now enforces console-managed keys (401 otherwise)". Add a fourth bullet to the "platform pieces" list: gateway auth/metering hooks live in `custom_callbacks.py` + `general_settings.custom_auth`; `buildGatewayConfig` must keep BOTH `litellm_settings.callbacks` and `general_settings`.

- [ ] **Step 3: Update the alignment doc**

`docs/concept/platform-alignment-and-scale.md`: in the §1 table row "Usage report", change Devproof column to "`/v1/usage` (sessions) + `/v1/usage/gateway` (per key/model/date-range presets)" and status to "aligned in dimensions (key, model, time)". In §2, update the "Gateway sync" row's State cell to note keys are now real authentication at the gateway (attribution → enforcement).

- [ ] **Step 4: Final commit**

```bash
git add CLAUDE.md docs/concept/platform-alignment-and-scale.md
git commit -m "docs: gateway keys are enforced — connection guide + alignment notes"
```

---

## Self-Review Notes

- **Spec coverage:** enforcement (T4/T5/T6), revocation semantics (T6 cache TTL, e2e T8), separate-service requirement (in-gateway, no CP in path — T6), internal session key (T5/T6), `gateway_usage` schema incl. SET NULL (T2), usage API with 8 presets + filters (T1/T2/T3), two-section Usage page with "(deleted key)" (T7), fail-closed + never-fail metering (T6 Python), docs (T8). Bootstrap-never-open: T6 Step 2.
- **Type consistency:** `rangeWindow` → `gatewayUsage` (`start/end/bucket`), route param `api_key` → `apiKeyId`, response shape identical in T2/T3/T7 (`buckets/totals/byDeployment/byKey`).
- 503-on-DB-down surfaces as a generic auth error from the raised exception (LiteLLM maps hook exceptions to 401); accepted deviation from the spec's 503 — noted here deliberately, semantics (fail closed) preserved.
