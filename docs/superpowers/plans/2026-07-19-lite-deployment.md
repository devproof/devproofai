# Lite Deployment (External-Only Serving) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `DEVPROOF_LOCAL_SERVING=false` install (chart: `llmkube.enabled: false`) runs the full platform against external model endpoints only — no local-serving routes, loops, kubestore calls, operator, or serving CRDs — and the console hides the local-only UI.

**Architecture:** A tiny env-read flag module (`serving-mode.ts`) + explicit checks at every seam. Local-only routes 404; mixed surfaces skip their kubestore leg; local-only loops aren't started; `GET /v1/settings` exposes a computed read-only `serving.localEnabled` the console gates on; the chart derives everything from `llmkube.enabled`.

**Tech Stack:** Node/TS (Fastify) control plane, Next.js console, Helm chart. Spec: `docs/superpowers/specs/2026-07-19-lite-deployment-design.md`.

## Global Constraints

- Error body for gated routes is exactly `{ "error": "local serving disabled" }`, status 404.
- Env absent ⇒ enabled. Only the literal string `"false"` disables (`process.env.DEVPROOF_LOCAL_SERVING !== "false"`).
- `llmkube.enabled` is the single chart switch — no new top-level value.
- Zero behavior change with the flag on: the existing suite must stay green untouched.
- Backend tests: `cd control-plane && npm test` (serialized on a shared dev DB — never remove `--test-concurrency=1`) and `npx tsc --noEmit`.
- This repo is CRLF; when deleting whole lines with Edit, re-check `git diff` afterwards (known Edit line-join gotcha).
- Console UI rules: no browser `prompt/confirm/alert`; no transparent text buttons.

---

### Task 1: `serving-mode.ts` + gate the local-only routes

**Files:**
- Create: `control-plane/src/serving-mode.ts`
- Modify: `control-plane/src/server.ts` (signature at `:39-55`, guard near `:56`, handlers at `:137, :189, :218, :224, :245, :296, :325, :340, :361, :430, :466, :472, :627`)
- Test: `control-plane/test/serving-mode.test.ts` (new)

**Interfaces:**
- Produces: `localServingEnabled(): boolean` (reads env per call — tests flip `process.env.DEVPROOF_LOCAL_SERVING`); `buildServer(bundled, store, custom?, externals?, hooks?, routings?, opts?: { localServing?: boolean })` — the new trailing `opts` defaults to `localServingEnabled()`. Inside `buildServer`, a `const localServing: boolean` and `localGate(reply): boolean` helper that later tasks (Task 2) reuse.

- [ ] **Step 1: Write the failing test file**

Create `control-plane/test/serving-mode.test.ts`:

```ts
// Lite deployments (spec 2026-07-19): local serving disabled ⇒ local-only
// routes 404 and mixed surfaces never touch the serving kubestore.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "../src/catalog.ts";
import { buildServer } from "../src/server.ts";
import { localServingEnabled } from "../src/serving-mode.ts";

const catalog = loadCatalog(fileURLToPath(new URL("../../catalog/models.yaml", import.meta.url)));

// Kubestore whose serving methods throw — proves lite mode never touches them.
// Gateway-config/provider-key writes stay functional (externals need them).
function throwingStore(): any {
  const boom = (m: string) => () => { throw new Error(`kubestore touched: ${m}`); };
  return {
    list: boom("list"), get: boom("get"), create: boom("create"),
    patch: boom("patch"), delete: boom("delete"),
    listCachedModels: boom("listCachedModels"), deleteCachedModel: boom("deleteCachedModel"),
    writeGatewayConfig: async () => false,
    awaitGatewayRollout: async () => true,
    writeProviderKey: async () => {}, deleteProviderKey: async () => {},
  };
}

const externalRows: any[] = [{ id: "ext_1", name: "ext-a", provider: "openai", model_id: "gpt-x",
  base_url: null, reasoning_effort: null, context_tokens: 200000 }];
const externals: any = {
  create: async (d: any) => { const row = { id: `ext_${externalRows.length + 1}`, model_id: d.modelId, base_url: d.baseUrl ?? null, context_tokens: d.contextTokens, ...d }; externalRows.push(row); return row; },
  list: async () => externalRows,
  get: async (id: string) => externalRows.find((e) => e.id === id) ?? null,
  getByName: async (n: string) => externalRows.find((e) => e.name === n) ?? null,
  update: async () => null, delete: async () => null,
};
const routings = new Map<string, any>();
const routingStore: any = {
  list: async () => [...routings.values()],
  get: async (n: string) => routings.get(n) ?? null,
  create: async (n: string, rules: any, terminal: any) => { const r = { name: n, rules, terminal }; routings.set(n, r); return r; },
  update: async () => null, delete: async () => null,
};

const app = buildServer(catalog, throwingStore(), undefined, externals, undefined, routingStore,
  { localServing: false });

test("serving-mode: default on, off only on explicit false", () => {
  delete process.env.DEVPROOF_LOCAL_SERVING;
  assert.equal(localServingEnabled(), true);
  process.env.DEVPROOF_LOCAL_SERVING = "true";
  assert.equal(localServingEnabled(), true);
  process.env.DEVPROOF_LOCAL_SERVING = "false";
  assert.equal(localServingEnabled(), false);
  delete process.env.DEVPROOF_LOCAL_SERVING;
});

test("local-only routes 404 with a clear error", async () => {
  const gated = [
    ["GET", "/v1/catalog"], ["POST", "/v1/catalog"], ["PATCH", "/v1/catalog/x"], ["DELETE", "/v1/catalog/x"],
    ["GET", "/v1/cache"], ["DELETE", "/v1/cache/x"],
    ["GET", "/v1/pools"], ["POST", "/v1/pools"], ["PATCH", "/v1/pools/x"], ["DELETE", "/v1/pools/x"],
    ["POST", "/v1/deployments"], ["PATCH", "/v1/deployments/x"], ["DELETE", "/v1/deployments/x"],
  ] as const;
  for (const [method, url] of gated) {
    const res = await app.inject({ method, url,
      ...(method === "POST" || method === "PATCH" ? { payload: {} } : {}) });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
    assert.equal(res.json().error, "local serving disabled", `${method} ${url}`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npx tsx --test test/serving-mode.test.ts`
Expected: FAIL — `buildServer` takes no 7th argument / routes answer 200, not 404.
(If plain `npx tsx --test` isn't how this repo invokes single files, use `node --test --import tsx test/serving-mode.test.ts` — match whatever `scripts/run-tests.mjs` uses.)

- [ ] **Step 3: Create the flag module**

Create `control-plane/src/serving-mode.ts`:

```ts
// Lite deployments (spec 2026-07-19): DEVPROOF_LOCAL_SERVING is rendered by
// the chart from llmkube.enabled — an install-time truth, not a runtime
// toggle. Absent = enabled (out-of-cluster dev default). Read per call so
// tests can flip the env.
export const localServingEnabled = (): boolean =>
  process.env.DEVPROOF_LOCAL_SERVING !== "false";
```

- [ ] **Step 4: Add the option + guard to `buildServer`**

In `control-plane/src/server.ts`:

Add to the imports (top of file):

```ts
import { localServingEnabled } from "./serving-mode.ts";
```

Extend the signature (`server.ts:39-55`) with a trailing param after `routings`:

```ts
  routings?: RoutingStore,
  opts?: { localServing?: boolean },
) {
  const app = Fastify({ logger: false });

  // Lite deployments (spec 2026-07-19): local serving off ⇒ the local-only
  // surfaces 404 and no serving-CRD kubestore call is ever made.
  const localServing = opts?.localServing ?? localServingEnabled();
  const localGate = (reply: { code(n: number): { send(b: unknown): unknown } }): boolean => {
    if (localServing) return false;
    reply.code(404).send({ error: "local serving disabled" });
    return true;
  };
```

- [ ] **Step 5: Gate each local-only handler**

Add `if (localGate(reply)) return reply;` as the FIRST statement of each of these handlers. Three handlers currently lack a `reply` parameter — add it:

- `app.get("/v1/catalog", async (req) => {` (`:137`) → `async (req, reply) => { if (localGate(reply)) return reply;`
- `app.post("/v1/catalog", ...)` (`:189`), `app.delete("/v1/catalog/:id", ...)` (`:218`), `app.patch("/v1/catalog/:id", ...)` (`:224`) — already have `reply`; add the guard line.
- `app.get("/v1/cache", async (req) => {` (`:245`) → `async (req, reply) => { if (localGate(reply)) return reply;`
- `app.get("/v1/pools", async () => {` (`:296`) → `async (_req, reply) => { if (localGate(reply)) return reply;`
- `app.post("/v1/pools", ...)` (`:325`), `app.patch("/v1/pools/:name", ...)` (`:340`), `app.delete("/v1/pools/:name", ...)` (`:361`) — add the guard line.
- `app.post("/v1/deployments", ...)` (`:430`), `app.delete("/v1/deployments/:name", ...)` (`:466`), `app.patch("/v1/deployments/:name", ...)` (`:627`) — add the guard line. (The `/v1/deployments/external/...` routes are separate registrations and stay unguarded.)
- `app.delete("/v1/cache/:name", ...)` (`:472`) — add the guard line.

- [ ] **Step 6: Run the new test to verify it passes**

Run: `cd control-plane && npx tsx --test test/serving-mode.test.ts`
Expected: PASS (both tests).

- [ ] **Step 7: Verify no regression with the flag on**

Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: clean tsc; full suite green (existing tests build servers without `opts` ⇒ default-on).

- [ ] **Step 8: Commit**

```bash
git add control-plane/src/serving-mode.ts control-plane/src/server.ts control-plane/test/serving-mode.test.ts
git commit -m "feat(cp): DEVPROOF_LOCAL_SERVING flag gates local-only serving routes"
```

---

### Task 2: Mixed surfaces drop their local leg

**Files:**
- Modify: `control-plane/src/server.ts` (`:85` syncGateway, `:375-376` listDeployments, `:479` sync route, `:525` external collision check, `:695` routingTargetCtx)
- Test: `control-plane/test/serving-mode.test.ts` (extend)

**Interfaces:**
- Consumes: `localServing` const from Task 1 (all edits are inside `buildServer`).
- Produces: no new exports — behavioral guarantee that `GET /v1/deployments`, `POST /v1/gateway/sync`, `POST /v1/deployments/external`, and routing CRUD work with a kubestore whose serving methods throw.

- [ ] **Step 1: Extend the test file with failing mixed-surface tests**

Append to `control-plane/test/serving-mode.test.ts`:

```ts
test("GET /v1/deployments lists externals without touching the kubestore", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/deployments" });
  assert.equal(res.statusCode, 200);
  const { deployments } = res.json();
  assert.equal(deployments.length >= 1, true);
  assert.equal(deployments.every((d: any) => d.kind === "external"), true);
  const one = await app.inject({ method: "GET", url: "/v1/deployments/ext-a" });
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().kind, "external");
});

test("POST /v1/gateway/sync builds external-only config", async () => {
  const res = await app.inject({ method: "POST", url: "/v1/gateway/sync" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().synced, true);
});

test("POST /v1/deployments/external skips the local-name collision check", async () => {
  const res = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "ext-b", provider: "openai", modelId: "gpt-y", contextTokens: 128000 } });
  assert.equal(res.statusCode, 201); // would 500 "kubestore touched: get" without the gate
});

test("routing create validates targets against externals only", async () => {
  const ok = await app.inject({ method: "POST", url: "/v1/routings",
    payload: { name: "t-lite-route", terminal: { action: "route", target: "ext-a" } } });
  assert.equal(ok.statusCode, 201); // would 500 "kubestore touched: list" without the gate
  const bad = await app.inject({ method: "POST", url: "/v1/routings",
    payload: { name: "t-lite-bad", terminal: { action: "route", target: "no-such-model" } } });
  assert.equal(bad.statusCode, 400);
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd control-plane && npx tsx --test test/serving-mode.test.ts`
Expected: the four new tests FAIL with 500s whose error mentions `kubestore touched`.

- [ ] **Step 3: Implement the local-leg skips**

In `control-plane/src/server.ts`, five one-line edits (all inside `buildServer`, so `localServing` is in scope):

`syncGateway` (`:85`):
```ts
    const deployments = localServing ? await store.list("modeldeployments") : [];
```

`listDeployments` (`:375-376`):
```ts
    const items = localServing ? await store.list("modeldeployments") : [];
    const { tokens } = localServing ? await fetchServingMetrics() : { tokens: {} as Record<string, number> };
```

`POST /v1/gateway/sync` handler (`:479`):
```ts
    const deployments = localServing ? await store.list("modeldeployments") : [];
```

External-create collision check (`:525`):
```ts
    if (await externals.getByName(b.name) || (localServing && await store.get("modeldeployments", b.name)))
```

`routingTargetCtx` (`:695`):
```ts
    localNames: new Set<string>(localServing ? (await store.list("modeldeployments")).map((d: any) => d.metadata.name) : []),
```

No edit needed in `GET /v1/routings/:name` (`:718`): its `store.get` loop iterates `reachableLocalTargets(...)`, which is empty when `localNames` is empty.

- [ ] **Step 4: Run the test file, then the full gate**

Run: `cd control-plane && npx tsx --test test/serving-mode.test.ts`
Expected: PASS.
Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/server.ts control-plane/test/serving-mode.test.ts
git commit -m "feat(cp): mixed serving surfaces skip their local leg when local serving is off"
```

---

### Task 3: Expose the flag via `GET /v1/settings`

**Files:**
- Modify: `control-plane/src/agents-api.ts:1036-1042` (GET /v1/settings)
- Test: `control-plane/test/serving-mode.test.ts` (extend)

**Interfaces:**
- Consumes: `localServingEnabled()` from `serving-mode.ts`.
- Produces: `GET /v1/settings` response gains `serving: { localEnabled: boolean }` — computed per request, never stored, ignored by `PUT /v1/settings` (no PUT change needed; it only reads known blocks). The console (Task 5) reads exactly this field.

- [ ] **Step 1: Write the failing test**

Append to `control-plane/test/serving-mode.test.ts` (pattern from `test/version.test.ts` — DB-backed, skipped when the dev DB is down). Add these imports at the top of the file:

```ts
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { registerAgentRoutes, type Orchestrator } from "../src/agents-api.ts";
import { localFileStore } from "../src/filestore.ts";
```

and change the first import line to `import { test, after } from "node:test";`.

And below the existing tests:

```ts
const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

test("GET /v1/settings exposes computed serving.localEnabled", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const root = mkdtempSync(join(tmpdir(), "serving-mode-test-"));
  const api = Fastify();
  await registerAgentRoutes(api, repo, {} as unknown as Orchestrator, localFileStore(root));
  try {
    process.env.DEVPROOF_LOCAL_SERVING = "false";
    assert.equal((await api.inject({ method: "GET", url: "/v1/settings" })).json().serving.localEnabled, false);
    delete process.env.DEVPROOF_LOCAL_SERVING;
    assert.equal((await api.inject({ method: "GET", url: "/v1/settings" })).json().serving.localEnabled, true);
  } finally {
    delete process.env.DEVPROOF_LOCAL_SERVING;
    await api.close();
    rmSync(root, { recursive: true, force: true });
  }
});
after(async () => { await pool.end().catch(() => {}); });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd control-plane && npx tsx --test test/serving-mode.test.ts`
Expected: new test FAILS — `serving` is undefined in the response.

- [ ] **Step 3: Implement**

In `control-plane/src/agents-api.ts`, add the import:

```ts
import { localServingEnabled } from "./serving-mode.ts";
```

Extend the GET handler (`:1036`):

```ts
  app.get("/v1/settings", async () => ({
    costs: await repo.getCostSettings(),
    limits: await repo.getLimits(),
    maintenance: await repo.getMaintenanceSettings(),
    appearance: await repo.getAppearance(),
    maintenanceLastRun: await repo.getMaintenanceLastRun(),
    // Read-only, computed from env (lite-deployment spec 2026-07-19) — never
    // stored in app_settings; PUT ignores it.
    serving: { localEnabled: localServingEnabled() },
  }));
```

- [ ] **Step 4: Run tests**

Run: `cd control-plane && npx tsx --test test/serving-mode.test.ts`
Expected: PASS.
Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: green (settings PUT round-trip tests don't assert an exhaustive GET shape; if one does a `deepEqual` on the full response, add the `serving` block to its expectation).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/test/serving-mode.test.ts
git commit -m "feat(cp): GET /v1/settings exposes read-only serving.localEnabled"
```

---

### Task 4: `main.ts` — skip local-serving loops and lookups

**Files:**
- Modify: `control-plane/src/main.ts` (`:57-104` modelPhase, `:109-118` projectModelRouting, `:158-160` onWake, `:182` samplerDeps)

**Interfaces:**
- Consumes: `localServingEnabled()` from `serving-mode.ts`.
- Produces: nothing exported — boot-time guarantee that a lite CP never touches the serving CRDs. (`main.ts` is the composition root with no unit-test harness; this task is verified by tsc + the full suite + Task 7's live run. `buildServer` needs no explicit opts here — its default reads the same env.)

- [ ] **Step 1: Add the flag read**

In `control-plane/src/main.ts`, add the import and a boot-time const near the other top-level env reads (`:27-31`):

```ts
import { localServingEnabled } from "./serving-mode.ts";
const localServing = localServingEnabled();
```

- [ ] **Step 2: Guard `modelPhase`**

Replace the two kubestore touches (`:72` and `:88`):

```ts
    const localNames = new Set<string>(localServing
      ? (await kube.list("modeldeployments")).map((x: any) => x.metadata.name) : []);
```

(the `for (const t of locals)` loop needs no edit — `locals` is empty when `localNames` is), and:

```ts
  const d = localServing ? await kube.get("modeldeployments", name).catch(() => null) : null;
```

- [ ] **Step 3: No-op the model_routing projection**

`projectModelRouting` (`:109`) becomes:

```ts
const projectModelRouting = () => {
  if (!localServing) return Promise.resolve();
  return sweepModelRouting({
    listDeployments: async () => (await kube.list("modeldeployments"))
      .map((d: any) => ({ name: d.metadata.name, phase: d.status?.phase ?? "Pending" })),
    isWarmed: (n) => warmedModels.has(n),
    setModelRouting: (m, s, p) => repo.setModelRouting(m, s, p),
    pruneModelRouting: (k) => repo.pruneModelRouting(k),
    takeWakeRequests: () => repo.takeWakeRequests(),
    wake,
  }).catch((err) => console.warn("model_routing sweep failed:", err));
};
```

(This covers both call sites — the reconciler sweep at `:208` and the `onGatewaySynced` hook at `:146` — with one guard.)

- [ ] **Step 4: Skip the wake listener and the sampler's kube leg**

Wake listener (`:158-160`):

```ts
if (localServing) notify.onWake((model) => {
  void wakeIfIdle({ kube, repo }, model).catch((err) => console.warn(`wake ${model} failed (sweep retries):`, err));
});
```

Sampler deps (`:182`):

```ts
const samplerDeps = { repo, kube: localServing ? kube : { list: async () => [] as any[] }, orchestrator };
```

(Session/env time billing keeps working — only the engine-pod observation leg empties. The pending-launch sweep at `:206` stays as is: nothing can park in lite mode, `gateDecision` launches `external`/`routing` immediately.)

- [ ] **Step 5: Verify**

Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: green.
Then boot the CP with the flag off against the dev cluster (kill it after the log line):

```bash
cd control-plane && DEVPROOF_LOCAL_SERVING=false \
DEVPROOF_RUNNER_IMAGE=devproof/devproofai-session-runner:dev50 \
DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files \
DEVPROOF_S3_ACCESS_KEY=devproof DEVPROOF_S3_SECRET_KEY=devproof-dev-secret \
DEVPROOF_GATEWAY_NAMESPACE=devproof DEVPROOF_SERVING_NAMESPACE=devproof \
npx tsx src/main.ts
```

Expected: `devproof control-plane listening on …`, boot gateway sync succeeds, NO warnings mentioning modeldeployments/model_routing. `curl -s localhost:7080/v1/catalog` → `{"error":"local serving disabled"}`; `curl -s localhost:7080/v1/settings` shows `"serving":{"localEnabled":false}`.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/main.ts
git commit -m "feat(cp): lite mode skips wake/model-routing/sampler kubestore legs"
```

---

### Task 5: Console — hide local-serving UI

**Files:**
- Modify: `console/app/layout.tsx` (`:19-23`, `:44`), `console/app/nav.tsx` (`:29`, `:47`), `console/app/deployments/page.tsx` (`:37-51`, `:79-81`)
- Modify: `console/app/catalog/page.tsx`, `console/app/pools/page.tsx`, `console/app/cache/page.tsx` (top-of-function notice)

**Interfaces:**
- Consumes: `GET /v1/settings` → `serving.localEnabled` (Task 3), via the existing `wsGet` helper (`app/lib/api.ts`).
- Produces: `Nav` gains a required `localServing: boolean` prop. Convention used everywhere: `settings?.serving?.localEnabled !== false` (CP down or old CP ⇒ treat as enabled — fail open, matching the theme fallback).

- [ ] **Step 1: Thread the flag through the layout**

In `console/app/layout.tsx`, widen the settings fetch type (`:21`):

```ts
    wsGet<{ appearance?: { theme?: string }; serving?: { localEnabled?: boolean } }>("/v1/settings"),
```

After the `theme` line (`:28`), derive the flag:

```ts
  const localServing = setRes.status === "fulfilled" ? setRes.value?.serving?.localEnabled !== false : true;
```

And pass it to Nav (`:44`):

```tsx
          <Nav workspaces={workspaces} current={current} version={version} localServing={localServing} />
```

- [ ] **Step 2: Filter the Serving nav group**

In `console/app/nav.tsx`, extend the props (`:29`):

```tsx
export function Nav({ workspaces, current, version, localServing }: { workspaces: { id: string; name: string; status: string }[]; current: string; version: { cp: string; console: string }; localServing: boolean }) {
```

Above the `return`, derive the visible groups, and change the render loop at `:47` from `GROUPS.map` to `groups.map`:

```tsx
  // Lite install (serving.localEnabled=false): the Serving group keeps only
  // the surfaces that work without local serving.
  const groups = localServing ? GROUPS : GROUPS.map((g) =>
    g.title === "Serving"
      ? { ...g, items: g.items.filter(([, href]) => href === "/deployments" || href === "/routings") }
      : g);
```

- [ ] **Step 3: Gate the deployments-page buttons**

In `console/app/deployments/page.tsx`, add the settings fetch to the `Promise.all` (`:39-42`):

```ts
  const [{ deployments, count }, { routings }, settings] = await Promise.all([
    wsGet<{ deployments: Deployment[]; count: number }>(`/v1/deployments?offset=${offset}`),
    wsGet<{ routings: any[] }>("/v1/routings?limit=1000").catch(() => ({ routings: [] })),
    wsGet<{ serving?: { localEnabled?: boolean } }>("/v1/settings").catch(() => null),
  ]);
  const localServing = settings?.serving?.localEnabled !== false;
```

Button row (`:50`) — keep AddEndpoint + Refresh always:

```tsx
        <div className="formrow" style={{ margin: 0 }}><AddEndpointButton />{localServing && <DeployModelButton />}{localServing && <SyncButton />}<RefreshButton /></div>
```

Empty-state row (`:80`):

```tsx
            <tr><td colSpan={8} className="empty">No deployments — {localServing ? "deploy a model from the catalog." : "add an external endpoint."}</td></tr>
```

- [ ] **Step 4: Notice pages for direct URLs**

In each of `console/app/catalog/page.tsx`, `console/app/pools/page.tsx`, `console/app/cache/page.tsx`, insert as the FIRST statements of the page component — BEFORE any data fetch (the gated CP endpoints 404 and `wsGet` would throw):

```tsx
  const settings = await wsGet<{ serving?: { localEnabled?: boolean } }>("/v1/settings").catch(() => null);
  if (settings?.serving?.localEnabled === false) return (
    <>
      <h1>Model Catalog</h1>
      <p className="sub">Local serving is disabled on this installation.</p>
    </>
  );
```

with the matching `<h1>` per page: `Model Catalog` / `Pools` / `Model Cache`. (`pools/page.tsx` imports `wsGet` already; all three do.)

- [ ] **Step 5: Build and verify both modes**

```bash
cd console && npx next build && npx next start -p 7090
```

With the CP from Task 4 still running flag-OFF: nav shows Serving → only Deployments + Routings; `/deployments` shows Add endpoint but no Deploy model/Sync; direct `/catalog`, `/pools`, `/cache` render the notice; all pages 200.
Then restart the CP WITHOUT `DEVPROOF_LOCAL_SERVING` and reload: full nav and buttons are back (no console rebuild needed — the flag is fetched per request).
Expected: both modes render correctly. (Remember: a console rebuild under a running `next start` pins old chunk hashes — restart `next start` after the build.)

- [ ] **Step 6: Commit**

```bash
git add console/app/layout.tsx console/app/nav.tsx console/app/deployments/page.tsx console/app/catalog/page.tsx console/app/pools/page.tsx console/app/cache/page.tsx
git commit -m "feat(console): hide local-serving UI when serving.localEnabled is false"
```

---

### Task 6: Helm chart — derive everything from `llmkube.enabled`

**Files:**
- Modify: `helm-charts/templates/controlplane/deployment.yaml:80` (env list)
- Modify: `helm-charts/templates/operator/deployment.yaml:1`, `helm-charts/templates/operator/rbac.yaml:1`, `helm-charts/templates/operator/serviceaccount.yaml:1`
- Modify: `helm-charts/templates/operator/crds/modelpools.yaml:1`, `helm-charts/templates/operator/crds/modeldeployments.yaml:1`

**Interfaces:**
- Consumes: `.Values.llmkube.enabled` (exists, `values.yaml:37`).
- Produces: CP env `DEVPROOF_LOCAL_SERVING` (`"true"`/`"false"`); operator + serving CRDs render only when llmkube does.

- [ ] **Step 1: CP env var**

In `helm-charts/templates/controlplane/deployment.yaml`, after the `DEVPROOF_SERVING_NAMESPACE` line (`:80`):

```yaml
            - { name: DEVPROOF_LOCAL_SERVING, value: {{ .Values.llmkube.enabled | quote }} }
```

- [ ] **Step 2: Gate operator + CRD templates**

Change line 1 in each file:

`operator/deployment.yaml`, `operator/rbac.yaml`, `operator/serviceaccount.yaml`:
```yaml
{{- if and .Values.operator.enabled .Values.llmkube.enabled }}
```

`operator/crds/modelpools.yaml`, `operator/crds/modeldeployments.yaml`:
```yaml
{{- if and .Values.crds.install .Values.llmkube.enabled }}
```

- [ ] **Step 3: Verify both renders**

```bash
helm template devproof helm-charts --skip-schema-validation > /tmp/full.yaml
helm template devproof helm-charts --set llmkube.enabled=false --set controlplane.enabled=true --skip-schema-validation > /tmp/lite.yaml
grep -c "serving.devproof.ai" /tmp/full.yaml        # > 0
grep -c "devproof-operator" /tmp/full.yaml          # > 0
grep 'DEVPROOF_LOCAL_SERVING' /tmp/full.yaml        # value: "true"
grep -c "kind: CustomResourceDefinition" /tmp/lite.yaml   # 0
grep -c "devproof-operator" /tmp/lite.yaml          # 0
grep 'DEVPROOF_LOCAL_SERVING' /tmp/lite.yaml        # value: "false"
```

Expected: as annotated. Also confirm the lite render still contains the gateway, postgres, minio, controlplane, and console workloads.

- [ ] **Step 4: Commit**

```bash
git add helm-charts/templates/controlplane/deployment.yaml helm-charts/templates/operator
git commit -m "feat(chart): llmkube.enabled drives operator, serving CRDs, and DEVPROOF_LOCAL_SERVING"
```

---

### Task 7: End-to-end verification

**Files:** none new — full-flow check per the repo's "Verify before claiming done" rule.

- [ ] **Step 1: Backend gate**

Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 2: Live lite-mode flow**

With the CP running flag-OFF (Task 4 Step 5 command) and the console running (Task 5 Step 5):
1. `curl -s localhost:7080/v1/settings` → `"serving":{"localEnabled":false}`.
2. Console: every nav page 200; Serving shows only Deployments + Routings.
3. Create (or reuse) an external endpoint on /deployments → appears with the External badge; Test connection works.
4. Create a routing on /routings whose terminal routes to that endpoint → 201; a routing targeting a bogus name → inline 400.
5. Start a session with an agent whose routing targets the external endpoint → launches immediately (no `session.waiting`), completes a turn.
6. CP log: zero warnings referencing modeldeployments / model_routing / wake.

- [ ] **Step 3: Flag-on regression**

Restart the CP without `DEVPROOF_LOCAL_SERVING`; reload the console.
Expected: full nav returns, /catalog lists models, /deployments shows local deployments with live phases, existing local sessions still work.

- [ ] **Step 4: Commit any fixes; done**

If steps 2-3 surfaced fixes, commit them (`fix(cp)/fix(console): …`). Then the branch is ready for review/merge.
