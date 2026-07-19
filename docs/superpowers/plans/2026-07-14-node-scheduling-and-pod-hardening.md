# Node-driven Scheduling Pickers + Pod-Config Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace free-text nodeSelector/toleration inputs with pickers populated from the cluster's actual node labels and taints, make the `/work` PVC size cap a platform setting, declutter the settings page with a native accordion, and close the remaining pod-config hardening items (label-syntax validation, render-time toleration whitelist, typed environment).

**Architecture:** Backend adds a pure node-aggregation helper behind a new `GET /v1/node-scheduling` route (mirrors the existing `/v1/storage-classes`), a `limits` key in the `app_settings` JSON singleton (mirrors `costs`), and threads a settings-driven cap into the pure `validatePodConfig`. `buildTurnJob` rebuilds tolerations/nodeSelector from allow-listed fields. Console gets an editable-combobox component (modeled on `mcp-picker.tsx`) wired into the environment form, and a native `<details>` accordion on the settings page.

**Tech Stack:** control-plane = Node/TypeScript (Fastify, `@kubernetes/client-node`, `pg`), tests via `node --import tsx --test`. console = Next.js (React, TSX), no test runner — console tasks verify via `npx next build` + manual exercise against the live docker-desktop cluster.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-14-node-scheduling-and-pod-hardening-design.md`. Copy verbatim values below.
- **Default disk cap:** `maxWorkGb = 2048` GiB when the setting is absent.
- **`/v1/node-scheduling` and `/v1/settings` are registered on `agents-api.ts` ONLY** (the console-facing surface), mirroring `/v1/storage-classes`. `public-api.ts` has neither today. (This corrects the spec's "both surfaces" wording for the *read* endpoint.)
- **`validatePodConfig` runs on BOTH surfaces** at the four env-write call sites: `agents-api.ts:272,283` and `public-api.ts:386,397`. The cap must be threaded at all four.
- **Backend tests** run with: `cd control-plane && npm test` (which is `node --import tsx --test "test/*.test.ts"`). Type-check with `npx tsc --noEmit`.
- **Console has no automated tests.** Verify with `cd console && npx next build`; then restart and exercise manually per the spec's Verification section. Never run `npm run dev` for the console (too slow / exits under tool backgrounding) — always a production build.
- **Adding a method to the `Orchestrator` interface (`agents-api.ts`) forces updating BOTH implementations:** the real one in `orchestrator.ts` and the fake one in `test/agents-api.test.ts:186-198`. Miss either and `tsc --noEmit` fails.
- **Dialogs:** no `prompt()`/`confirm()`/`alert()` in the console (banned). UI rule: no transparent text buttons (ghost = solid panel fill; quiet row icon-buttons are the exception).
- **Commit** after each task with the shown message.

---

### Task 1: Limits settings module + repo accessors

**Files:**
- Create: `control-plane/src/limits.ts`
- Modify: `control-plane/src/repo.ts` (add imports near the top where `CostSettings` is imported; add methods after `putCostSettings` at `repo.ts:1230`)
- Test: `control-plane/test/limits-settings.test.ts`

**Interfaces:**
- Produces: `interface Limits { maxWorkGb: number }`; `const DEFAULT_MAX_WORK_GB = 2048`; `const DEFAULT_LIMITS: Limits`; `normalizeLimits(raw: unknown): Limits`; `validateLimits(raw: unknown): string | null`; `Repo.getLimits(): Promise<Limits>`; `Repo.putLimits(limits: Limits): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `control-plane/test/limits-settings.test.ts`:

```typescript
// Disk-cap limit setting: defaults, validation, repo round-trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { DEFAULT_LIMITS, normalizeLimits, validateLimits } from "../src/limits.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

test("normalize: absent/invalid maxWorkGb reads as the 2048 default", () => {
  assert.deepEqual(normalizeLimits(undefined), DEFAULT_LIMITS);
  assert.equal(normalizeLimits({}).maxWorkGb, 2048);
  assert.equal(normalizeLimits({ maxWorkGb: 0 }).maxWorkGb, 2048);
  assert.equal(normalizeLimits({ maxWorkGb: 1.5 }).maxWorkGb, 2048);
  assert.equal(normalizeLimits({ maxWorkGb: 500 }).maxWorkGb, 500);
});

test("validate: type errors are named, valid passes", () => {
  assert.equal(validateLimits(undefined), null);
  assert.equal(validateLimits({ maxWorkGb: 500 }), null);
  assert.match(validateLimits({ maxWorkGb: 0 })!, /maxWorkGb/);
  assert.match(validateLimits({ maxWorkGb: 1.5 })!, /maxWorkGb/);
  assert.match(validateLimits([])!, /object/);
});

test("limits round-trip via repo", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const before = await repo.getLimits();
  try {
    await repo.putLimits({ maxWorkGb: 777 });
    assert.deepEqual(await repo.getLimits(), { maxWorkGb: 777 });
  } finally {
    await repo.putLimits(before); // restore — the dev DB is shared
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --import tsx --test test/limits-settings.test.ts`
Expected: FAIL — cannot find module `../src/limits.ts`.

- [ ] **Step 3: Create the limits module**

Create `control-plane/src/limits.ts`:

```typescript
// Platform limits stored in the app_settings JSON singleton under `limits`
// (spec 2026-07-14). Today just the durable /work PVC size cap. Mirrors the
// costs.ts normalize/validate pattern.

export interface Limits {
  maxWorkGb: number;
}

export const DEFAULT_MAX_WORK_GB = 2048;
export const DEFAULT_LIMITS: Limits = { maxWorkGb: DEFAULT_MAX_WORK_GB };

/** Coerce stored/absent JSON to a valid Limits, falling back to the default. */
export function normalizeLimits(raw: unknown): Limits {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as any) : {};
  const n = Number(r.maxWorkGb);
  return { maxWorkGb: Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_WORK_GB };
}

/** Returns an error message, or null when the input is a valid partial. */
export function validateLimits(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "limits must be an object";
  const m = (raw as any).maxWorkGb;
  if (m != null && (!Number.isInteger(m) || m < 1)) return "limits.maxWorkGb must be an integer ≥ 1";
  return null;
}
```

- [ ] **Step 4: Add repo accessors**

In `control-plane/src/repo.ts`, find the existing import of cost types (search for `from "./costs.ts"`) and add a limits import right after it:

```typescript
import { normalizeLimits, type Limits } from "./limits.ts";
```

Then insert these two methods immediately after `putCostSettings` (after `repo.ts:1230`, before `listResourcePrices`):

```typescript
  async getLimits(): Promise<Limits> {
    const { rows } = await this.pool.query("SELECT data->'limits' AS limits FROM app_settings WHERE id = 'global'");
    return normalizeLimits(rows[0]?.limits);
  }

  async putLimits(limits: Limits) {
    await this.pool.query(
      `UPDATE app_settings SET data = jsonb_set(data, '{limits}', $1::jsonb), updated_at = now() WHERE id = 'global'`,
      [JSON.stringify(limits)]);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd control-plane && node --import tsx --test test/limits-settings.test.ts`
Expected: PASS (the round-trip test runs if the dev DB is reachable, else skips).

- [ ] **Step 6: Type-check**

Run: `cd control-plane && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/limits.ts control-plane/src/repo.ts control-plane/test/limits-settings.test.ts
git commit -m "feat(settings): limits module + repo accessors for maxWorkGb"
```

---

### Task 2: Expose limits on GET/PUT /v1/settings

**Files:**
- Modify: `control-plane/src/agents-api.ts:757-766` (the `/v1/settings` handlers)
- Test: `control-plane/test/agents-api.test.ts` (extend the fake repo at `:169-183` and add a route test)

**Interfaces:**
- Consumes: `Repo.getLimits`/`Repo.putLimits` (Task 1), `validateLimits`/`normalizeLimits` (Task 1).
- Produces: `GET /v1/settings` → `{ costs, limits }`; `PUT /v1/settings` accepts `{ costs?, limits? }`.

- [ ] **Step 1: Add limits to the fake repo and write the failing route test**

In `control-plane/test/agents-api.test.ts`, the fake repo object (ends at `:183` with `} as unknown as Repo;`). Add these two methods inside it (place them near the other simple stubs, e.g. right before the closing `} as unknown as Repo;`):

```typescript
    _limits: { maxWorkGb: 2048 },
    async getLimits() { return (this as any)._limits; },
    async putLimits(l: any) { (this as any)._limits = l; },
```

Then add a new test at the end of the file:

```typescript
test("GET /v1/settings returns costs and limits; PUT persists limits", async () => {
  const { app } = await build();
  const got = await app.inject({ method: "GET", url: "/v1/settings" });
  assert.equal(got.statusCode, 200);
  const body = got.json();
  assert.ok(body.costs, "costs present");
  assert.equal(body.limits.maxWorkGb, 2048);

  const put = await app.inject({
    method: "PUT", url: "/v1/settings",
    payload: { costs: body.costs, limits: { maxWorkGb: 999 } },
  });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().limits.maxWorkGb, 999);

  const bad = await app.inject({
    method: "PUT", url: "/v1/settings",
    payload: { costs: body.costs, limits: { maxWorkGb: 0 } },
  });
  assert.equal(bad.statusCode, 400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --import tsx --test test/agents-api.test.ts`
Expected: FAIL — GET body has no `limits` key (`body.limits` is undefined).

- [ ] **Step 3: Update the /v1/settings handlers**

In `control-plane/src/agents-api.ts`, first add the limits import near the cost-settings import (search for `validateCostSettings` / `normalizeCostSettings` import and add beside it):

```typescript
import { validateLimits, normalizeLimits } from "./limits.ts";
```

Replace the two handlers at `:757-766`:

```typescript
  app.get("/v1/settings", async () => ({
    costs: await repo.getCostSettings(),
    limits: await repo.getLimits(),
  }));

  app.put("/v1/settings", async (req, reply) => {
    const b = req.body as { costs?: unknown; limits?: unknown };
    const costErr = validateCostSettings(b?.costs);
    if (costErr) return reply.code(400).send({ error: costErr });
    const limErr = validateLimits(b?.limits);
    if (limErr) return reply.code(400).send({ error: limErr });
    const costs = normalizeCostSettings(b!.costs);
    await repo.putCostSettings(costs);
    const limits = normalizeLimits(b?.limits);
    if (b?.limits !== undefined) await repo.putLimits(limits);
    return { costs, limits };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd control-plane && node --import tsx --test test/agents-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `cd control-plane && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/test/agents-api.test.ts
git commit -m "feat(settings): expose limits on GET/PUT /v1/settings"
```

---

### Task 3: sizeGb cap in validatePodConfig

**Files:**
- Modify: `control-plane/src/pod-config.ts:26,50-55`
- Test: `control-plane/test/pod-config.test.ts`

**Interfaces:**
- Produces: `validatePodConfig(pod: unknown, opts?: { maxWorkGb?: number }): string | null` — `sizeGb` must be an integer in `[1, maxWorkGb]`; `maxWorkGb` defaults to `2048` when `opts` is omitted (so existing zero-arg callers/tests are unaffected).

- [ ] **Step 1: Write the failing test**

Add to `control-plane/test/pod-config.test.ts`:

```typescript
test("sizeGb is capped at maxWorkGb (default 2048)", () => {
  const okDisk = { type: "pvc", storageClass: "standard" };
  assert.equal(validatePodConfig({ disk: { ...okDisk, sizeGb: 2048 } }), null);
  assert.match(validatePodConfig({ disk: { ...okDisk, sizeGb: 2049 } })!, /sizeGb/);
  // explicit lower cap
  assert.equal(validatePodConfig({ disk: { ...okDisk, sizeGb: 100 } }, { maxWorkGb: 100 }), null);
  assert.match(validatePodConfig({ disk: { ...okDisk, sizeGb: 101 } }, { maxWorkGb: 100 })!, /sizeGb/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --import tsx --test test/pod-config.test.ts`
Expected: FAIL — `sizeGb: 2049` currently returns null (no upper bound).

- [ ] **Step 3: Add the cap parameter and check**

In `control-plane/src/pod-config.ts`, change the signature at `:26` and the disk block at `:50-55`:

```typescript
export function validatePodConfig(pod: unknown, opts?: { maxWorkGb?: number }): string | null {
  const maxWorkGb = opts?.maxWorkGb ?? 2048;
  if (pod == null) return null;
  if (typeof pod !== "object" || Array.isArray(pod)) return "pod must be an object";
  const p = pod as PodConfig;
  // ... existing requests/limits/nodeSelector/tolerations checks unchanged ...
```

Then in the disk block replace the `sizeGb` check:

```typescript
  if (p.disk != null && p.disk.type !== "emptyDir") {
    if (p.disk.type !== "pvc") return "pod.disk.type must be emptyDir or pvc";
    if (!p.disk.storageClass?.trim()) return "pod.disk.storageClass is required for a pvc disk";
    if (!Number.isInteger(p.disk.sizeGb) || (p.disk.sizeGb as number) < 1 || (p.disk.sizeGb as number) > maxWorkGb)
      return `pod.disk.sizeGb must be an integer between 1 and ${maxWorkGb}`;
  }
```

(Keep every other line of the function as-is; only the signature line, the new `maxWorkGb` const, and the `sizeGb` condition change in this task.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd control-plane && node --import tsx --test test/pod-config.test.ts`
Expected: PASS (including the pre-existing `sizeGb: 0` / `1.5` cases, whose messages still match `/sizeGb/`).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/pod-config.ts control-plane/test/pod-config.test.ts
git commit -m "feat(pod-config): cap disk sizeGb at maxWorkGb (default 2048)"
```

---

### Task 4: k8s label-syntax validation + strict unknown-field rejection

**Files:**
- Modify: `control-plane/src/pod-config.ts` (nodeSelector block at `:37-39`, tolerations block at `:40-49`, and add a top-level unknown-key check)
- Test: `control-plane/test/pod-config.test.ts`

**Interfaces:**
- Produces: same `validatePodConfig` signature; now also rejects malformed k8s label keys/values, unknown top-level `pod` keys, and unknown toleration keys.

- [ ] **Step 1: Write the failing test**

Add to `control-plane/test/pod-config.test.ts`:

```typescript
test("nodeSelector keys/values must be valid k8s labels", () => {
  assert.equal(validatePodConfig({ nodeSelector: { "topology.kubernetes.io/zone": "eu-a" } }), null);
  assert.equal(validatePodConfig({ nodeSelector: { "kubernetes.io/arch": "amd64" } }), null);
  assert.equal(validatePodConfig({ nodeSelector: { role: "" } }), null); // empty value allowed
  assert.match(validatePodConfig({ nodeSelector: { "bad key": "x" } })!, /nodeSelector/);
  assert.match(validatePodConfig({ nodeSelector: { role: "has space" } })!, /nodeSelector/);
  assert.match(validatePodConfig({ nodeSelector: { role: "a".repeat(64) } })!, /nodeSelector/);
});

test("toleration keys must be valid label keys", () => {
  assert.equal(validatePodConfig({ tolerations: [{ key: "nvidia.com/gpu", operator: "Exists" }] }), null);
  assert.match(validatePodConfig({ tolerations: [{ key: "bad key", operator: "Exists" }] })!, /key/);
});

test("rejects unknown top-level pod fields and unknown toleration fields", () => {
  assert.match(validatePodConfig({ bogus: 1 } as any)!, /unknown/);
  assert.match(validatePodConfig({ tolerations: [{ key: "k", operator: "Exists", bogus: 1 }] } as any)!, /unknown/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --import tsx --test test/pod-config.test.ts`
Expected: FAIL — `{ "bad key": "x" }` currently passes (only non-empty key + string value is checked); unknown fields currently pass.

- [ ] **Step 3: Add label helpers, unknown-key check, and stronger nodeSelector/toleration validation**

In `control-plane/src/pod-config.ts`, add these constants near the top (below the existing `QUANTITY`/`TOL_OPERATORS`/`TOL_EFFECTS` at `:20-23`):

```typescript
// k8s label key: optional DNS-subdomain prefix ("prefix/") + a name segment.
// Each of prefix and name is ≤63 chars, alnum-bounded, [A-Za-z0-9._-] inside.
const LABEL_SEG = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
// k8s label value: empty, or the same alnum-bounded ≤63 form.
const LABEL_VAL = /^([A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)?$/;
const POD_KEYS = ["requests", "limits", "nodeSelector", "tolerations", "disk"];
const TOL_KEYS = ["key", "operator", "value", "effect"];

function isLabelKey(k: string): boolean {
  const slash = k.indexOf("/");
  if (slash === -1) return LABEL_SEG.test(k);
  const prefix = k.slice(0, slash), name = k.slice(slash + 1);
  return prefix.length > 0 && prefix.length <= 253 && LABEL_SEG.test(name) && name.length > 0;
}
```

Add the unknown-top-level-key check right after the `const p = pod as PodConfig;` line (around `:29`):

```typescript
  for (const k of Object.keys(p)) {
    if (!POD_KEYS.includes(k)) return `pod has unknown field ${k}`;
  }
```

Replace the nodeSelector block at `:37-39`:

```typescript
  if (p.nodeSelector != null) {
    if (typeof p.nodeSelector !== "object" || Array.isArray(p.nodeSelector))
      return "pod.nodeSelector must be an object mapping label keys to string values";
    for (const [k, v] of Object.entries(p.nodeSelector)) {
      if (!k || typeof v !== "string") return "pod.nodeSelector must map non-empty label keys to string values";
      if (!isLabelKey(k)) return `pod.nodeSelector key ${k} is not a valid Kubernetes label key`;
      if (!LABEL_VAL.test(v)) return `pod.nodeSelector value for ${k} is not a valid Kubernetes label value`;
    }
  }
```

In the tolerations loop (`:42-48`), add an unknown-key check and a key-syntax check. Replace the loop body:

```typescript
    for (const t of p.tolerations) {
      if (typeof t !== "object" || t === null || Array.isArray(t)) return "pod.tolerations entries must be objects";
      for (const k of Object.keys(t)) {
        if (!TOL_KEYS.includes(k)) return `pod.tolerations has unknown field ${k}`;
      }
      if (t.key != null && typeof t.key !== "string") return "pod.tolerations key must be a string";
      if (t.key != null && !isLabelKey(t.key)) return `pod.tolerations key ${t.key} is not a valid Kubernetes label key`;
      if (t.value != null && typeof t.value !== "string") return "pod.tolerations value must be a string";
      if (!TOL_OPERATORS.includes(t?.operator ?? "Equal")) return "pod.tolerations operator must be Equal or Exists";
      if (!TOL_EFFECTS.includes(t?.effect ?? "")) return "pod.tolerations effect must be NoSchedule, PreferNoSchedule or NoExecute";
    }
```

- [ ] **Step 4: Run the full pod-config suite to verify pass**

Run: `cd control-plane && node --import tsx --test test/pod-config.test.ts`
Expected: PASS — including the existing `accepts a full valid config` test (its `nodeSelector: { "kubernetes.io/arch": "amd64" }` and toleration keys are valid).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/pod-config.ts control-plane/test/pod-config.test.ts
git commit -m "feat(pod-config): validate k8s label syntax; reject unknown fields"
```

---

### Task 5: Thread the cap through the four env-write call sites

**Files:**
- Modify: `control-plane/src/agents-api.ts:272,283`
- Modify: `control-plane/src/public-api.ts:386,397`
- Test: `control-plane/test/agents-api.test.ts` (add an over-cap 400 route test)

**Interfaces:**
- Consumes: `validatePodConfig(pod, { maxWorkGb })` (Task 3), `repo.getLimits()` (Task 1), fake-repo `getLimits` (Task 2).

- [ ] **Step 1: Write the failing test**

Add to `control-plane/test/agents-api.test.ts`. This posts an environment whose disk exceeds the fake repo's cap (2048):

```typescript
test("POST /v1/environments rejects a disk sizeGb above the cap", async () => {
  const { app } = await build();
  const res = await app.inject({
    method: "POST", url: "/v1/environments",
    payload: { name: "big", pod: { disk: { type: "pvc", storageClass: "standard", sizeGb: 9999 } } },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /sizeGb/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --import tsx --test test/agents-api.test.ts`
Expected: FAIL — currently `sizeGb: 9999` passes validation (no cap wired), so the route does not 400 on it.

- [ ] **Step 3: Thread the cap at both agents-api call sites**

In `control-plane/src/agents-api.ts`, the create handler (`:272`) and edit handler (`:283`). Replace each `const podErr = validatePodConfig(b.pod);` with a cap-aware call.

Create handler (`:270-273` context):

```typescript
    if (!b?.name) return reply.code(400).send({ error: "name required" });
    const { maxWorkGb } = await repo.getLimits();
    const podErr = validatePodConfig(b.pod, { maxWorkGb });
    if (podErr) return reply.code(400).send({ error: podErr });
```

Edit handler (`:282-284` context):

```typescript
    if (b.pod !== undefined) {
      const { maxWorkGb } = await repo.getLimits();
      const podErr = validatePodConfig(b.pod, { maxWorkGb });
      if (podErr) return reply.code(400).send({ error: podErr });
    }
```

- [ ] **Step 4: Thread the cap at both public-api call sites**

In `control-plane/src/public-api.ts`, apply the identical change at `:386` and `:397` (same two shapes as Step 3 — `const { maxWorkGb } = await repo.getLimits();` immediately before each `validatePodConfig(b.pod, { maxWorkGb })`). `repo` is already in scope (the module receives it as a parameter).

- [ ] **Step 5: Run tests to verify pass**

Run: `cd control-plane && node --import tsx --test test/agents-api.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check**

Run: `cd control-plane && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/src/public-api.ts control-plane/test/agents-api.test.ts
git commit -m "feat(pod-config): enforce settings-driven sizeGb cap at env write sites"
```

---

### Task 6: buildTurnJob rebuilds tolerations/nodeSelector from allow-listed fields

**Files:**
- Modify: `control-plane/src/orchestrator.ts:294-295`
- Test: `control-plane/test/orchestrator.test.ts`

**Interfaces:**
- Produces: unchanged `buildTurnJob` signature; the rendered pod spec's `tolerations` contain only `{ key, operator, value, effect }` (present keys only), and `nodeSelector` is a rebuilt plain map.

- [ ] **Step 1: Write the failing test**

Add to `control-plane/test/orchestrator.test.ts`:

```typescript
test("buildTurnJob strips unknown toleration fields, keeps the four allowed", () => {
  const s: any = base();
  s.environment.pod = {
    nodeSelector: { zone: "a" },
    tolerations: [{ key: "gpu", operator: "Equal", value: "true", effect: "NoSchedule", tolerationSeconds: 5, bogus: "x" } as any],
  };
  const podSpec: any = buildTurnJob(s).spec.template.spec;
  assert.deepEqual(podSpec.tolerations, [{ key: "gpu", operator: "Equal", value: "true", effect: "NoSchedule" }]);
  assert.deepEqual(podSpec.nodeSelector, { zone: "a" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --import tsx --test test/orchestrator.test.ts`
Expected: FAIL — the current raw spread keeps `tolerationSeconds` and `bogus`.

- [ ] **Step 3: Rebuild placement from allow-listed fields**

In `control-plane/src/orchestrator.ts`, just before the `return {` in `buildTurnJob` (before `:279`), add:

```typescript
  const nodeSelector = pod.nodeSelector && Object.keys(pod.nodeSelector).length ? { ...pod.nodeSelector } : undefined;
  const tolerations = (pod.tolerations ?? []).map((t) => ({
    ...(t.key != null ? { key: t.key } : {}),
    ...(t.operator != null ? { operator: t.operator } : {}),
    ...(t.value != null ? { value: t.value } : {}),
    ...(t.effect ? { effect: t.effect } : {}),
  }));
```

Then replace the two placement lines at `:294-295`:

```typescript
          ...(nodeSelector ? { nodeSelector } : {}),
          ...(tolerations.length ? { tolerations } : {}),
```

- [ ] **Step 4: Run the full orchestrator suite to verify pass**

Run: `cd control-plane && node --import tsx --test test/orchestrator.test.ts`
Expected: PASS — including the existing `resources and placement come from the pod config` test (it asserts `[{ key: "gpu", operator: "Exists" }]`, which the rebuild reproduces exactly).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/orchestrator.ts control-plane/test/orchestrator.test.ts
git commit -m "fix(orchestrator): whitelist toleration/nodeSelector fields in buildTurnJob"
```

---

### Task 7: Node introspection — pure aggregator + endpoint

**Files:**
- Create: `control-plane/src/node-scheduling.ts`
- Modify: `control-plane/src/orchestrator.ts` (add `listNodeScheduling` to the returned object after `listStorageClasses` at `:241`; import the aggregator)
- Modify: `control-plane/src/agents-api.ts:57` (interface) and `:314` (route, next to `/v1/storage-classes`)
- Modify: `control-plane/test/agents-api.test.ts:197` (fake orchestrator)
- Test: `control-plane/test/node-scheduling.test.ts`

**Interfaces:**
- Produces: `interface NodeScheduling { labels: Record<string, string[]>; taints: { key: string; value: string; effect: string }[] }`; `aggregateNodeScheduling(nodes: any[]): NodeScheduling`; `Orchestrator.listNodeScheduling(): Promise<NodeScheduling>`; route `GET /v1/node-scheduling` → `NodeScheduling`.

- [ ] **Step 1: Write the failing aggregator test**

Create `control-plane/test/node-scheduling.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateNodeScheduling } from "../src/node-scheduling.ts";

test("aggregates distinct label values and dedupes taints across nodes", () => {
  const nodes = [
    { metadata: { labels: { "topology.kubernetes.io/zone": "a", role: "gpu" } },
      spec: { taints: [{ key: "nvidia.com/gpu", value: "true", effect: "NoSchedule" }] } },
    { metadata: { labels: { "topology.kubernetes.io/zone": "b", role: "gpu" } },
      spec: { taints: [{ key: "nvidia.com/gpu", value: "true", effect: "NoSchedule" }] } },
    { metadata: { labels: {} }, spec: {} },
  ];
  const out = aggregateNodeScheduling(nodes);
  assert.deepEqual(out.labels["topology.kubernetes.io/zone"], ["a", "b"]);
  assert.deepEqual(out.labels["role"], ["gpu"]);
  assert.deepEqual(out.taints, [{ key: "nvidia.com/gpu", value: "true", effect: "NoSchedule" }]);
});

test("empty node list yields empty maps", () => {
  assert.deepEqual(aggregateNodeScheduling([]), { labels: {}, taints: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --import tsx --test test/node-scheduling.test.ts`
Expected: FAIL — cannot find module `../src/node-scheduling.ts`.

- [ ] **Step 3: Create the pure aggregator**

Create `control-plane/src/node-scheduling.ts`:

```typescript
// Aggregates the cluster's node labels and taints into pick-lists for the
// environment scheduling editors (spec 2026-07-14). Pure — the orchestrator
// feeds it `core.listNode().items`.

export interface NodeScheduling {
  labels: Record<string, string[]>;
  taints: { key: string; value: string; effect: string }[];
}

export function aggregateNodeScheduling(nodes: any[]): NodeScheduling {
  const labelSets: Record<string, Set<string>> = {};
  const seenTaints = new Set<string>();
  const taints: NodeScheduling["taints"] = [];
  for (const n of nodes ?? []) {
    for (const [k, v] of Object.entries(n?.metadata?.labels ?? {})) {
      (labelSets[k] ??= new Set()).add(String(v));
    }
    for (const t of n?.spec?.taints ?? []) {
      const key = t?.key ?? "", value = t?.value ?? "", effect = t?.effect ?? "";
      const id = `${key}|${value}|${effect}`;
      if (!seenTaints.has(id)) { seenTaints.add(id); taints.push({ key, value, effect }); }
    }
  }
  const labels: Record<string, string[]> = {};
  for (const [k, set] of Object.entries(labelSets)) labels[k] = [...set].sort();
  return { labels, taints };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd control-plane && node --import tsx --test test/node-scheduling.test.ts`
Expected: PASS.

- [ ] **Step 5: Add to the Orchestrator interface**

In `control-plane/src/agents-api.ts`, add after `:57` (below `listStorageClasses`):

```typescript
  /** Cluster node labels + taints for the environment scheduling pickers. */
  listNodeScheduling(): Promise<import("./node-scheduling.ts").NodeScheduling>;
```

- [ ] **Step 6: Implement in the real orchestrator**

In `control-plane/src/orchestrator.ts`, add the import near the top (below the `PodConfig` import at `:7`):

```typescript
import { aggregateNodeScheduling } from "./node-scheduling.ts";
```

Add the method inside the returned object, immediately after `listStorageClasses` (after `:241`, before the closing `};` at `:242`):

```typescript
    async listNodeScheduling() {
      const res: any = await core.listNode();
      return aggregateNodeScheduling(res.items ?? []);
    },
```

- [ ] **Step 7: Add to the fake orchestrator**

In `control-plane/test/agents-api.test.ts`, after the `listStorageClasses` stub at `:197`, add:

```typescript
    async listNodeScheduling() {
      return {
        labels: { "topology.kubernetes.io/zone": ["a", "b"], role: ["gpu"] },
        taints: [{ key: "nvidia.com/gpu", value: "true", effect: "NoSchedule" }],
      };
    },
```

- [ ] **Step 8: Register the route + write its test**

In `control-plane/src/agents-api.ts`, add after the storage-classes route at `:314`:

```typescript
  // Cluster node labels + taints for the environment scheduling pickers (spec 2026-07-14).
  app.get("/v1/node-scheduling", async () => await orchestrator.listNodeScheduling());
```

Add a route test at the end of `control-plane/test/agents-api.test.ts`:

```typescript
test("GET /v1/node-scheduling returns labels and taints", async () => {
  const { app } = await build();
  const res = await app.inject({ method: "GET", url: "/v1/node-scheduling" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.labels["role"], ["gpu"]);
  assert.equal(body.taints[0].key, "nvidia.com/gpu");
});
```

- [ ] **Step 9: Run tests + type-check**

Run: `cd control-plane && node --import tsx --test test/node-scheduling.test.ts test/agents-api.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 10: Commit**

```bash
git add control-plane/src/node-scheduling.ts control-plane/src/orchestrator.ts control-plane/src/agents-api.ts control-plane/test/node-scheduling.test.ts control-plane/test/agents-api.test.ts
git commit -m "feat(scheduling): GET /v1/node-scheduling aggregating node labels + taints"
```

---

### Task 8: Typed environment in session routes

**Files:**
- Modify: `control-plane/src/session-actions.ts:60,112` (and the launch payload `environment` fields at `:93,141`)

**Interfaces:**
- Consumes: `PodConfig` from `./pod-config.ts`.
- Produces: no runtime change; replaces `any` with `{ id: string; pod: PodConfig | null } | null` and types the payload `environment: { id: string; pod: PodConfig }`.

- [ ] **Step 1: Add the type import and replace the `any` declarations**

In `control-plane/src/session-actions.ts`, add to the existing imports:

```typescript
import type { PodConfig } from "./pod-config.ts";

type EnvRow = { id: string; pod: PodConfig | null };
```

Replace `const environment: any = ...` at `:60`:

```typescript
  const environment: EnvRow | null = v?.environment_id ? await repo.getEnvironment(v.environment_id) : null;
```

Replace `let environment: any = null;` at `:112`:

```typescript
  let environment: EnvRow | null = null;
```

The two launch-payload lines (`:93`, `:141`) already read `environment: { id: environment.id, pod: environment.pod ?? {} }` — leave them; they now type-check against `EnvRow`.

- [ ] **Step 2: Type-check**

Run: `cd control-plane && npx tsc --noEmit`
Expected: no errors. If `repo.getEnvironment`'s return type is looser than `EnvRow`, the assignment still narrows structurally; if `tsc` complains that `getEnvironment` returns `any`, that is fine (an `any` is assignable to `EnvRow | null`).

- [ ] **Step 3: Run the session-related suites**

Run: `cd control-plane && node --import tsx --test test/agents-api.test.ts test/public-api.test.ts test/launch-gate.test.ts`
Expected: PASS (behavior unchanged).

- [ ] **Step 4: Commit**

```bash
git add control-plane/src/session-actions.ts
git commit -m "refactor(session): type the environment row instead of any"
```

---

### Task 9: Editable label-combobox component (console)

**Files:**
- Create: `console/app/lib/label-combobox.tsx`
- Modify: `console/app/globals.css` (append combobox styles)

**Interfaces:**
- Produces: `LabelCombobox({ value, onChange, options, placeholder })` — an editable text input with a filtered dropdown of `options`; typing fires `onChange` (free text allowed); clicking an option sets the value and closes.

- [ ] **Step 1: Create the component**

Create `console/app/lib/label-combobox.tsx`:

```tsx
"use client";
// Editable combobox: a text input with a filtered dropdown of suggestions read
// from the cluster (node labels/values). Free text is always allowed — typing
// updates the value directly; picking a suggestion fills it. Modeled on the
// open/click-outside pattern in mcp-picker.tsx.
import { useEffect, useRef, useState } from "react";

export function LabelCombobox({ value, onChange, options, placeholder }: {
  value: string; onChange: (v: string) => void; options: string[]; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const q = value.trim().toLowerCase();
  const hits = options.filter((o) => !q || o.toLowerCase().includes(q)).slice(0, 50);

  return (
    <div className="lcbx" ref={wrapRef}
         onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); } }}>
      <input value={value} placeholder={placeholder}
             onChange={(e) => { onChange(e.target.value); setOpen(true); }}
             onFocus={() => setOpen(true)} />
      {open && hits.length > 0 && (
        <div className="lcbx-panel">
          {hits.map((o) => (
            <button type="button" key={o} className="lcbx-option"
                    onClick={() => { onChange(o); setOpen(false); }}>{o}</button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Append styles**

Append to `console/app/globals.css`:

```css
.lcbx { position: relative; flex: 1; }
.lcbx > input { width: 100%; }
.lcbx-panel {
  position: absolute; z-index: 30; top: calc(100% + 2px); left: 0; right: 0;
  max-height: 220px; overflow-y: auto;
  background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.25);
}
.lcbx-option {
  display: block; width: 100%; text-align: left; padding: 6px 10px;
  background: none; border: none; color: inherit; font-family: var(--font-mono); font-size: 12px; cursor: pointer;
}
.lcbx-option:hover { background: var(--hover, rgba(127,127,127,0.15)); }
```

(If `--panel`/`--border`/`--hover` are not defined in this file, grep `globals.css` for the equivalents already used by `.mcp-panel` and reuse those exact variable names.)

- [ ] **Step 3: Verify it builds**

Run: `cd console && npx next build`
Expected: build succeeds (the component is not yet imported anywhere, so this only checks it compiles). If the build tree-shakes unused modules and skips it, that is fine — Task 10 imports it and rebuilds.

- [ ] **Step 4: Commit**

```bash
git add console/app/lib/label-combobox.tsx console/app/globals.css
git commit -m "feat(console): editable label-combobox component"
```

---

### Task 10: Wire node-driven pickers into the environment form (console)

**Files:**
- Modify: `console/app/environments/create.tsx`

**Interfaces:**
- Consumes: `LabelCombobox` (Task 9); `GET /v1/node-scheduling` → `{ labels: Record<string,string[]>; taints: {key,value,effect}[] }` (Task 7).

- [ ] **Step 1: Load node scheduling data on modal open**

In `console/app/environments/create.tsx`, add the import:

```tsx
import { LabelCombobox } from "../lib/label-combobox";
```

Add state + fetch beside the existing storage-classes loader (after `create.tsx:47`):

```tsx
  const [nodeSched, setNodeSched] = useState<{ labels: Record<string, string[]>; taints: { key: string; value: string; effect: string }[] } | null>(null);
  useEffect(() => {
    apiGet<{ labels: Record<string, string[]>; taints: { key: string; value: string; effect: string }[] }>("/v1/node-scheduling")
      .then(setNodeSched)
      .catch(() => setNodeSched({ labels: {}, taints: [] })); // degrade to free-text inputs
  }, []);
  const labelKeys = Object.keys(nodeSched?.labels ?? {}).sort();
```

- [ ] **Step 2: Swap the node-selector row inputs for comboboxes**

In the "Node selector" `Field` (`create.tsx:145-159`), replace the two `<input>` elements inside each `kvrow` with comboboxes (keep the `=` span and the remove button):

```tsx
            <div className="kvrow" key={i}>
              <LabelCombobox value={r.k} onChange={(v) => setRow(i, "k", v)} options={labelKeys}
                             placeholder="kubernetes.io/arch" />
              <span className="muted">=</span>
              <LabelCombobox value={r.v} onChange={(v) => setRow(i, "v", v)}
                             options={nodeSched?.labels?.[r.k] ?? []} placeholder="amd64" />
              <button className="iconbtn danger" title="Remove label" aria-label="Remove label"
                      onClick={() => set("selector", form.selector.filter((_, j) => j !== i))}>✕</button>
            </div>
```

(`setRow`, `form.selector`, and the `submit()` assembly are unchanged — the combobox emits the same string values the plain inputs did.)

- [ ] **Step 3: Add a taint quick-pick to each toleration row**

In the "Tolerations" `Field` (`create.tsx:160-189`), add a taint dropdown as the first control in each `kvrow`, before the key input. It fills key+value+effect in one action:

```tsx
            <div className="kvrow" key={i}>
              {(nodeSched?.taints?.length ?? 0) > 0 && (
                <select value="" style={{ flex: "none", width: 150 }}
                        onChange={(e) => {
                          const t = nodeSched!.taints[Number(e.target.value)];
                          if (!t) return;
                          set("tolerations", form.tolerations.map((r, j) => j === i
                            ? { key: t.key, operator: t.value ? "Equal" : "Exists", value: t.value, effect: t.effect }
                            : r));
                        }}>
                  <option value="">from a node taint…</option>
                  {nodeSched!.taints.map((t, ti) => (
                    <option key={ti} value={ti}>{t.key}{t.value ? `=${t.value}` : ""} · {t.effect || "any"}</option>
                  ))}
                </select>
              )}
              <input value={t.key} placeholder="nvidia.com/gpu"
                     onChange={(e) => setTol(i, "key", e.target.value)} />
              {/* operator/value/effect selects + remove button: unchanged from the existing row */}
```

Leave the existing operator `<select>`, conditional value `<input>`, effect `<select>`, and remove `<button>` exactly as they are (`create.tsx:167-184`). Only the leading taint `<select>` and the surrounding `kvrow` open tag are added here.

- [ ] **Step 4: Verify it builds**

Run: `cd console && npx next build`
Expected: build succeeds.

- [ ] **Step 5: Manual verification against the live cluster**

Ensure control plane + console are running (see repo `CLAUDE.md` run commands). Then:
1. Open the console → Environments → Create environment.
2. In Node selector, click **+ Add label**; the key field should suggest the docker-desktop node's labels (e.g. `kubernetes.io/arch`, `kubernetes.io/hostname`) as you type; the value field suggests values for the chosen key. Typing a value not on any node still works.
3. In Tolerations, click **+ Add toleration**; the "from a node taint…" dropdown lists any node taints (docker-desktop's single node is normally untainted → dropdown hidden, which is expected). Manual key/operator/effect entry still works.
4. Save the environment; confirm it persists (edit it and see the values round-trip).

Expected: all four behaviors hold; on a `/v1/node-scheduling` failure the fields fall back to plain typing (no error blocks the modal).

- [ ] **Step 6: Commit**

```bash
git add console/app/environments/create.tsx
git commit -m "feat(console): node-driven pickers for nodeSelector and tolerations"
```

---

### Task 11: Settings page accordion + Limits section (console)

**Files:**
- Modify: `console/app/settings/page.tsx`
- Modify: `console/app/settings/form.tsx`
- Modify: `console/app/globals.css` (append accordion styles)

**Interfaces:**
- Consumes: `GET /v1/settings` → `{ costs, limits }` (Task 2); `PUT /v1/settings` accepts `{ costs, limits }` (Task 2).

- [ ] **Step 1: Load limits in the page and pass to the form**

Replace `console/app/settings/page.tsx` body:

```tsx
import { wsGet } from "../lib/api";
import type { CostSettings } from "../lib/currency";
import { SettingsForm } from "./form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const s = await wsGet<{ costs: CostSettings; limits: { maxWorkGb: number } }>("/v1/settings").catch(() => null);
  return (
    <>
      <div className="pagehead"><h1>Settings</h1></div>
      <p className="sub">Platform-wide settings. Cost tracking and billing apply across all workspaces.</p>
      {s ? <SettingsForm initial={s.costs} initialLimits={s.limits} />
         : <div className="empty">Control plane unreachable.</div>}
    </>
  );
}
```

- [ ] **Step 2: Add accordion sections + Limits to the form**

In `console/app/settings/form.tsx`:

Change the component signature and add limits state (at `:32-38`):

```tsx
export function SettingsForm({ initial, initialLimits }: { initial: CostSettings; initialLimits: { maxWorkGb: number } }) {
  const router = useRouter();
  const [c, setC] = useState<CostSettings>(initial);
  const [maxWorkGb, setMaxWorkGb] = useState(String(initialLimits?.maxWorkGb ?? 2048));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (patch: Partial<CostSettings>) => setC({ ...c, ...patch });
  const setB = (patch: Partial<CostSettings["billing"]>) => setC({ ...c, billing: { ...c.billing, ...patch } });
```

Update `save()` to send limits (at `:40-46`):

```tsx
  const save = async () => {
    setBusy(true); setMsg(null);
    const n = Math.floor(Number(maxWorkGb));
    if (!(n >= 1)) { setBusy(false); setMsg("Max session disk must be an integer ≥ 1."); return; }
    const err = await submitJson("PUT", "/v1/settings", { costs: c, limits: { maxWorkGb: n } });
    setBusy(false);
    setMsg(err ?? "Saved.");
    if (!err) router.refresh();
  };
```

Wrap the existing "Cost tracking" `setpanel` in a `<details>` accordion and add a second "Limits" accordion. Replace the outer `<div className="setpanel"> … </div>` (the whole cost block at `:50-101`) with:

```tsx
      <details className="setacc" open>
        <summary>Cost tracking</summary>
        <div className="setpanel">
          {/* ← the ENTIRE existing cost block moves here unchanged: the
               "Enable cost tracking" Row, the Currency row, the Real costs
               Section + Rows, and the Billing Section + Rows (lines 51-100). */}
        </div>
      </details>

      <details className="setacc" open>
        <summary>Limits</summary>
        <div className="setpanel">
          <label className="setrow plain">
            <span />
            <span className="setrow-name">Max session disk (GiB)</span>
            <span className="setrow-hint" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input value={maxWorkGb} onChange={(e) => setMaxWorkGb(e.target.value)}
                     style={{ width: 110, flex: "none" }} />
              ceiling for an environment&apos;s durable /work volume — default 2048
            </span>
          </label>
        </div>
      </details>
```

Keep the existing `<h2>Cost tracking</h2>` heading removed (the `<summary>` now names the section) — do NOT leave a duplicate heading inside the panel. The Save button row at `:103-106` stays after both `<details>` blocks.

- [ ] **Step 3: Append accordion styles**

Append to `console/app/globals.css`:

```css
.setacc { margin-bottom: 12px; }
.setacc > summary {
  cursor: pointer; font-weight: 600; font-size: 15px; padding: 8px 0; list-style: none;
}
.setacc > summary::before { content: "▸ "; }
.setacc[open] > summary::before { content: "▾ "; }
.setacc > summary::-webkit-details-marker { display: none; }
```

- [ ] **Step 4: Verify it builds**

Run: `cd console && npx next build`
Expected: build succeeds.

- [ ] **Step 5: Manual verification**

With control plane + console running:
1. Open Settings. The page shows two collapsible sections — **Cost tracking** (open) and **Limits** (open) — no longer one long panel.
2. Collapse/expand each; the cost toggles still work exactly as before.
3. In Limits, change "Max session disk (GiB)" to e.g. `100`, Save → "Saved.". Reload → the value persists.
4. Go to Environments → Create, enable "Persist turns locally", set Size to `101` GiB, Save → the API rejects it with a `sizeGb` error (cap enforced end-to-end). Set it back to `2048` cap by re-saving Settings to `2048`.

Expected: accordion works, the cap round-trips, and the environment write is rejected above the cap.

- [ ] **Step 6: Commit**

```bash
git add console/app/settings/page.tsx console/app/settings/form.tsx console/app/globals.css
git commit -m "feat(console): settings accordion + Max session disk limit"
```

---

## Final Verification (after all tasks)

- [ ] **Backend:** `cd control-plane && npm test && npx tsc --noEmit` — all suites pass, no type errors.
- [ ] **Console:** `cd console && npx next build` — succeeds.
- [ ] **Live exercise:** restart control plane + console (per repo `CLAUDE.md`), confirm all pages 200, then run the manual checks from Task 10 Step 5 and Task 11 Step 5 against the docker-desktop cluster: node-driven pickers populate from the real node, the settings accordion renders two sections, a saved cap persists, and an over-cap environment `sizeGb` is rejected with a 400.

## Self-Review notes

- **Spec §1 (node endpoint):** Task 7. Registered on agents-api only (corrected from spec's "both surfaces" — storage-classes/settings live there only; documented in Global Constraints).
- **Spec §2 (pickers):** Tasks 9-10.
- **Spec §3 (settings accordion + Limits):** Tasks 1, 2, 11. Environment form stays flat (Task 10 only swaps the two editors).
- **Spec §4 (settings-driven cap):** Tasks 1-5.
- **Spec §5 (hardening):** label syntax + unknown-field rejection (Task 4), render-time whitelist (Task 6), typed environment (Task 8).
- **Type consistency:** `NodeScheduling` shape identical in `node-scheduling.ts`, the `Orchestrator` interface, the fake orchestrator, the route, and the console fetch. `Limits`/`maxWorkGb` identical across `limits.ts`, repo, route, `validatePodConfig` opts, and the console form. `validatePodConfig(pod, { maxWorkGb })` signature used identically at all four call sites (Task 5) and in tests (Task 3).
