# Default Resource Seeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-time, marker-guarded seeding of two starter environments (`default-all-blocked`, `default-all-allowed`, in `wrkspc_default`) and two starter pools (`default-cpu`, `default-gpu`) at first control-plane boot, disableable via a Helm values flag.

**Architecture:** A new `control-plane/src/seed-defaults.ts` module runs at CP boot (in `main.ts`, warn-and-continue), guarded by `DEVPROOF_SEED_DEFAULTS === "true"` AND the absence of an `app_settings` marker `data->'seed'->>'defaultsApplied'`. Environments are created via the existing `repo.createEnvironment`; pools via the kubestore `create("modelpools", …)` (same shape as the `/v1/pools` route). Per-resource skip-if-exists; the marker is set only after all four succeeded, so transient failures retry next boot. The Helm chart renders the env var from `controlplane.seedDefaults` (default `true`).

**Tech Stack:** Node/TS (Fastify CP), `node --test` via tsx, Postgres (shared dev DB for tests), Helm chart render tests (`helm-charts/tests/render.test.mjs`).

**Spec:** `docs/superpowers/specs/2026-07-24-default-resource-seeding-design.md`

## Global Constraints

- **Never bump versions** — no image tags, no Chart.yaml, no package.json changes; CI/CD owns versioning (BUILD.md).
- **No AI references in commit messages** — no `Co-Authored-By: Claude`, no "Generated with Claude Code" (user decision 2026-07-23).
- **No SQL migrations** — this feature adds none; do not touch `control-plane/sql/`.
- **Flag semantics:** seeding runs only when `DEVPROOF_SEED_DEFAULTS === "true"`; any other value including unset is OFF (out-of-cluster dev CP must not seed by accident).
- **Marker semantics:** once `app_settings` `data->'seed'->>'defaultsApplied'` is set, seeding never runs again — deleted resources are never resurrected.
- **Nothing is ever overwritten:** existing same-named resources are skipped, not replaced.
- Backend tests run against the shared dev DB: throwaway workspaces MUST use a swept prefix (`t-seed-…`); the `app_settings` singleton must be snapshotted and restored by any test touching it. Do not touch `--test-concurrency=1`.
- CP test/typecheck commands: `cd control-plane && npm test` and `npx tsc --noEmit`. Single file: `node --import tsx --test test/seed-defaults.test.ts` (from `control-plane/`).
- Chart tests: `node --test helm-charts/tests/render.test.mjs` (from repo root; needs `helm` on PATH and `helm-charts/charts/` built — the test builds it if missing).

---

### Task 1: Repo marker methods

**Files:**
- Modify: `control-plane/src/repo.ts` (after `setMaintenanceLastRun`, ~line 1854)
- Create: `control-plane/test/seed-defaults.test.ts`

**Interfaces:**
- Consumes: existing `Repo` class, `app_settings` singleton row (`id='global'`, JSONB `data`).
- Produces: `Repo.getSeedDefaultsApplied(): Promise<boolean>` and `Repo.setSeedDefaultsApplied(): Promise<void>` — Task 2's `seedDefaults` calls both.

- [ ] **Step 1: Write the failing test**

Create `control-plane/test/seed-defaults.test.ts`:

```ts
// One-time default resource seed (spec 2026-07-24-default-resource-seeding-
// design.md): marker-guarded, per-resource skip-if-exists, flag-gated.
// Shared dev DB — throwaway t-seed-* workspaces (swept by run-tests.mjs);
// the app_settings singleton is snapshotted and restored around every test
// (safe under --test-concurrency=1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

const tag = Date.now();
const repo = new Repo(pool);

test("seed marker: absent → false, set → true", { skip: !available }, async () => {
  const { rows: snap } = await pool.query("SELECT data FROM app_settings WHERE id = 'global'");
  const original = snap[0].data;
  try {
    await pool.query("UPDATE app_settings SET data = data - 'seed' WHERE id = 'global'");
    assert.equal(await repo.getSeedDefaultsApplied(), false);
    await repo.setSeedDefaultsApplied();
    assert.equal(await repo.getSeedDefaultsApplied(), true);
  } finally {
    await pool.query("UPDATE app_settings SET data = $1 WHERE id = 'global'", [original]);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `control-plane/`): `node --import tsx --test test/seed-defaults.test.ts`
Expected: FAIL — `repo.getSeedDefaultsApplied is not a function`.

- [ ] **Step 3: Implement the marker methods**

In `control-plane/src/repo.ts`, directly after `setMaintenanceLastRun` (~line 1854), add:

```ts
  // ── One-time default resource seed (spec 2026-07-24) ─────────────────────
  async getSeedDefaultsApplied(): Promise<boolean> {
    const { rows } = await this.pool.query(
      "SELECT data->'seed'->>'defaultsApplied' AS applied FROM app_settings WHERE id = 'global'");
    return rows[0]?.applied === "true";
  }
  async setSeedDefaultsApplied() {
    await this.pool.query(
      `UPDATE app_settings SET data = jsonb_set(data, '{seed}', '{"defaultsApplied": true}'::jsonb), updated_at = now() WHERE id = 'global'`);
  }
```

(Note: the write targets the top-level `{seed}` path with the whole object — `jsonb_set` does not create intermediate keys, so a nested `{seed,defaultsApplied}` path would silently no-op when `seed` is absent.)

- [ ] **Step 4: Run test to verify it passes**

Run (from `control-plane/`): `node --import tsx --test test/seed-defaults.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/repo.ts control-plane/test/seed-defaults.test.ts
git commit -m "feat(cp): app_settings marker for one-time default-resource seed"
```

---

### Task 2: seedDefaults module

**Files:**
- Create: `control-plane/src/seed-defaults.ts`
- Modify: `control-plane/test/seed-defaults.test.ts` (extend)

**Interfaces:**
- Consumes: `Repo.createEnvironment(workspaceId, name, allowPackageManagers, allowedHosts, pod, allowMcpServers)` (`repo.ts:1258`), `Repo.getSeedDefaultsApplied` / `setSeedDefaultsApplied` (Task 1), `KubeStore.get/create` (`kubestore.ts:10-16`), `SERVING_NAMESPACE` (`namespaces.ts`), `DEFAULT_WORKSPACE` (`repo.ts:19`).
- Produces: `seedDefaults(opts: { repo: Repo; kube: Pick<KubeStore, "get" | "create"> | null; workspaceId?: string }): Promise<void>` plus exported constants `SEED_ENVIRONMENTS`, `SEED_POOLS` — Task 3 calls `seedDefaults({ repo, kube })` from `main.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `control-plane/test/seed-defaults.test.ts` (add the import at the top of the file alongside the existing ones):

```ts
import { seedDefaults } from "../src/seed-defaults.ts";
```

and the test body below the marker test:

```ts
function fakeKube() {
  const pools = new Map<string, any>();
  const kube = {
    async get(_plural: any, name: string) { return pools.get(name) ?? null; },
    async create(_plural: any, body: any) { pools.set(body.metadata.name, body); return body; },
  };
  return { pools, kube };
}

// Fresh throwaway workspace + cleared marker per test; restores the whole
// app_settings singleton and the flag env afterwards.
async function withSeedRun(n: number, fn: (wsId: string) => Promise<void>) {
  const wsId = `t-seed-${tag}-${n}`;
  await pool.query("INSERT INTO workspaces (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING", [wsId]);
  const { rows: snap } = await pool.query("SELECT data FROM app_settings WHERE id = 'global'");
  const original = snap[0].data;
  await pool.query("UPDATE app_settings SET data = data - 'seed' WHERE id = 'global'");
  try {
    await fn(wsId);
  } finally {
    delete process.env.DEVPROOF_SEED_DEFAULTS;
    await pool.query("UPDATE app_settings SET data = $1 WHERE id = 'global'", [original]);
  }
}

const envRows = async (wsId: string) => (await pool.query(
  "SELECT name, allow_package_managers, allowed_hosts, allow_mcp_servers, pod FROM environments WHERE workspace_id = $1 ORDER BY name",
  [wsId])).rows;

test("seedDefaults: seeds 2 envs + 2 pools and sets the marker", { skip: !available }, async () => {
  await withSeedRun(1, async (wsId) => {
    process.env.DEVPROOF_SEED_DEFAULTS = "true";
    const { pools, kube } = fakeKube();
    await seedDefaults({ repo, kube, workspaceId: wsId });

    const rows = await envRows(wsId);
    assert.deepEqual(rows.map((r) => r.name), ["default-all-allowed", "default-all-blocked"]);
    const allowed = rows[0], blocked = rows[1];
    assert.equal(allowed.allow_package_managers, true);
    assert.equal(allowed.allow_mcp_servers, true);
    assert.deepEqual(allowed.allowed_hosts, ["*"]);
    assert.deepEqual(allowed.pod, { disk: { type: "emptyDir" } });
    assert.equal(blocked.allow_package_managers, false);
    assert.equal(blocked.allow_mcp_servers, false);
    assert.deepEqual(blocked.allowed_hosts, []);
    assert.deepEqual(blocked.pod, { disk: { type: "emptyDir" } });

    assert.equal(pools.size, 2);
    assert.deepEqual(pools.get("default-cpu").spec,
      { gpuType: "cpu", gpusPerNode: 0, maxNodes: 1, nodeSelector: {}, tolerations: [] });
    assert.deepEqual(pools.get("default-gpu").spec,
      { gpuType: "gpu", gpusPerNode: 1, maxNodes: 1, nodeSelector: {}, tolerations: [] });
    assert.equal(pools.get("default-cpu").kind, "ModelPool");

    assert.equal(await repo.getSeedDefaultsApplied(), true);
  });
});

test("seedDefaults: skips existing resources untouched, seeds the rest", { skip: !available }, async () => {
  await withSeedRun(2, async (wsId) => {
    process.env.DEVPROOF_SEED_DEFAULTS = "true";
    // Pre-existing env with a DIFFERENT config — must survive unmodified.
    await repo.createEnvironment(wsId, "default-all-blocked", true, ["keep.me"], {}, true);
    const { pools, kube } = fakeKube();
    pools.set("default-cpu", { metadata: { name: "default-cpu" }, spec: { sentinel: true } });

    await seedDefaults({ repo, kube, workspaceId: wsId });

    const rows = await envRows(wsId);
    assert.equal(rows.length, 2); // no duplicate default-all-blocked
    const blocked = rows.find((r) => r.name === "default-all-blocked")!;
    assert.deepEqual(blocked.allowed_hosts, ["keep.me"]); // untouched
    assert.equal(pools.get("default-cpu").spec.sentinel, true); // untouched
    assert.ok(pools.get("default-gpu"), "missing pool seeded");
    assert.equal(await repo.getSeedDefaultsApplied(), true);
  });
});

test("seedDefaults: marker present → no-op", { skip: !available }, async () => {
  await withSeedRun(3, async (wsId) => {
    process.env.DEVPROOF_SEED_DEFAULTS = "true";
    await repo.setSeedDefaultsApplied();
    const { pools, kube } = fakeKube();
    await seedDefaults({ repo, kube, workspaceId: wsId });
    assert.equal((await envRows(wsId)).length, 0);
    assert.equal(pools.size, 0);
  });
});

test("seedDefaults: flag unset or not 'true' → no-op, no marker", { skip: !available }, async () => {
  await withSeedRun(4, async (wsId) => {
    delete process.env.DEVPROOF_SEED_DEFAULTS;
    const { pools, kube } = fakeKube();
    await seedDefaults({ repo, kube, workspaceId: wsId });
    process.env.DEVPROOF_SEED_DEFAULTS = "false";
    await seedDefaults({ repo, kube, workspaceId: wsId });
    assert.equal((await envRows(wsId)).length, 0);
    assert.equal(pools.size, 0);
    assert.equal(await repo.getSeedDefaultsApplied(), false);
  });
});

test("seedDefaults: no kubestore → envs seeded, pools skipped, marker set", { skip: !available }, async () => {
  await withSeedRun(5, async (wsId) => {
    process.env.DEVPROOF_SEED_DEFAULTS = "true";
    await seedDefaults({ repo, kube: null, workspaceId: wsId });
    assert.equal((await envRows(wsId)).length, 2);
    assert.equal(await repo.getSeedDefaultsApplied(), true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `control-plane/`): `node --import tsx --test test/seed-defaults.test.ts`
Expected: FAIL — cannot find module `../src/seed-defaults.ts`.

- [ ] **Step 3: Implement the module**

Create `control-plane/src/seed-defaults.ts`:

```ts
// One-time default resource seed (spec 2026-07-24-default-resource-seeding-
// design.md): the first boot with DEVPROOF_SEED_DEFAULTS=true and no
// app_settings marker seeds two starter environments into the default
// workspace and two starter pools — skip-if-exists per resource, nothing is
// ever overwritten — then sets the marker so deletions never resurrect them.
import type { KubeStore } from "./kubestore.ts";
import { SERVING_NAMESPACE } from "./namespaces.ts";
import { DEFAULT_WORKSPACE, Repo } from "./repo.ts";

export const SEED_ENVIRONMENTS = [
  { name: "default-all-blocked", allowPackageManagers: false, allowedHosts: [] as string[], allowMcpServers: false },
  { name: "default-all-allowed", allowPackageManagers: true, allowedHosts: ["*"], allowMcpServers: true },
];

export const SEED_POOLS = [
  { name: "default-cpu", spec: { gpuType: "cpu", gpusPerNode: 0, maxNodes: 1, nodeSelector: {}, tolerations: [] } },
  { name: "default-gpu", spec: { gpuType: "gpu", gpusPerNode: 1, maxNodes: 1, nodeSelector: {}, tolerations: [] } },
];

export async function seedDefaults(opts: {
  repo: Repo;
  kube: Pick<KubeStore, "get" | "create"> | null; // null = local serving disabled
  workspaceId?: string; // tests only; production always seeds the default workspace
}): Promise<void> {
  if (process.env.DEVPROOF_SEED_DEFAULTS !== "true") return;
  const { repo, kube } = opts;
  const workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE;
  if (await repo.getSeedDefaultsApplied()) return;

  for (const e of SEED_ENVIRONMENTS) {
    try {
      await repo.createEnvironment(workspaceId, e.name, e.allowPackageManagers,
        e.allowedHosts, { disk: { type: "emptyDir" } }, e.allowMcpServers);
    } catch (err: any) {
      if (err?.code !== "23505") throw err; // unique (workspace_id, name) → already exists, skip
    }
  }

  if (kube) {
    for (const p of SEED_POOLS) {
      if (await kube.get("modelpools", p.name)) continue;
      await kube.create("modelpools", {
        apiVersion: "serving.devproof.ai/v1alpha1",
        kind: "ModelPool",
        metadata: { name: p.name, namespace: SERVING_NAMESPACE },
        spec: p.spec,
      });
    }
  } else {
    console.warn("seed-defaults: local serving disabled — pools default-cpu/default-gpu not seeded");
  }

  // Marker only after every resource succeeded (created or skipped): a
  // transient failure above leaves it unset so the next boot retries, and
  // skip-if-exists makes the retry harmless.
  await repo.setSeedDefaultsApplied();
  console.log("seed-defaults: default environments and pools ensured");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `control-plane/`): `node --import tsx --test test/seed-defaults.test.ts`
Expected: PASS (6 tests). If the `fakeKube` object fails to typecheck against `Pick<KubeStore, "get" | "create">`, pass it as `kube: kube as Pick<KubeStore, "get" | "create">` inside `fakeKube` rather than loosening the production signature.

- [ ] **Step 5: Typecheck**

Run (from `control-plane/`): `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/seed-defaults.ts control-plane/test/seed-defaults.test.ts
git commit -m "feat(cp): one-time default environments + pools seed (flag- and marker-guarded)"
```

---

### Task 3: Wire into main.ts boot

**Files:**
- Modify: `control-plane/src/main.ts` (imports ~line 1-25; boot sequence at lines 48-50)

**Interfaces:**
- Consumes: `seedDefaults` (Task 2), existing `repo` (line 48), `kube` (line 49), `localServing` (line 35).
- Produces: nothing new — boot-time side effect only.

- [ ] **Step 1: Add the import**

In `control-plane/src/main.ts`, add to the import block (alphabetical placement near the other `./` imports):

```ts
import { seedDefaults } from "./seed-defaults.ts";
```

- [ ] **Step 2: Add the boot call**

Directly after `const kube = realKubeStore();` (line 49, before `const orchestrator = realOrchestrator();`), insert:

```ts
// One-time default resource seed (spec 2026-07-24): flag- and marker-guarded.
// Warn-and-continue like the gateway-secret bootstrap above — a failed seed
// leaves the marker unset, so the next boot retries (skip-if-exists makes
// that harmless) and never blocks the CP.
try {
  await seedDefaults({ repo, kube: localServing ? kube : null });
} catch (err) {
  console.warn("default-resource seed failed — will retry next boot:", err);
}
```

- [ ] **Step 3: Typecheck**

Run (from `control-plane/`): `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Live boot verification against the dev cluster**

The dev DB already holds both environments and the cluster both pools, and the marker is unset — so this exercises the skip-everything-then-mark path end to end. From `control-plane/` (note `DEVPROOF_SERVING_NAMESPACE=default` — the in-cluster dev topology serves from `default`):

```bash
DEVPROOF_SEED_DEFAULTS=true \
DEVPROOF_RUNNER_IMAGE=devproof/devproofai-session-runner:dev55 \
DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files \
DEVPROOF_S3_ACCESS_KEY=devproof DEVPROOF_S3_SECRET_KEY=devproof-dev-secret \
DEVPROOF_GATEWAY_NAMESPACE=default DEVPROOF_SERVING_NAMESPACE=default \
npx tsx src/main.ts
```

Wait for the listen log plus `seed-defaults: default environments and pools ensured`, then stop the process (Ctrl-C / kill). Verify nothing was duplicated and the marker stuck:

```bash
kubectl exec -n default deploy/postgres -- psql -U devproof -d devproof -c \
  "SELECT data->'seed' AS seed FROM app_settings WHERE id = 'global'; \
   SELECT name FROM environments WHERE workspace_id = 'wrkspc_default' ORDER BY name;"
kubectl get modelpools -n default
```

Expected: `seed` = `{"defaultsApplied": true}`; exactly two `default-*` environment rows (`default-all-allowed`, `default-all-blocked`, unchanged ids); exactly the two pre-existing pools.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/main.ts
git commit -m "feat(cp): run default-resource seed at boot"
```

---

### Task 4: Helm values flag + env rendering

**Files:**
- Modify: `helm-charts/values.yaml` (controlplane block, ~line 215)
- Modify: `helm-charts/templates/controlplane/deployment.yaml` (env list, after `DEVPROOF_LOCAL_SERVING` ~line 85)
- Modify: `helm-charts/tests/render.test.mjs` (append one test)

**Interfaces:**
- Consumes: values path `controlplane.seedDefaults`; the existing `render(args)` helper in `render.test.mjs`.
- Produces: env var `DEVPROOF_SEED_DEFAULTS` (`"true"`/`"false"`) on the controlplane container — consumed by Task 2's flag check.

- [ ] **Step 1: Write the failing render test**

Append to `helm-charts/tests/render.test.mjs`:

```js
test("controlplane seedDefaults flag: on by default, --set off renders false", () => {
  const on = render();
  assert.ok(/DEVPROOF_SEED_DEFAULTS[^\n]*"true"/.test(on));
  const off = render(["--set", "controlplane.seedDefaults=false"]);
  assert.ok(/DEVPROOF_SEED_DEFAULTS[^\n]*"false"/.test(off));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from repo root): `node --test helm-charts/tests/render.test.mjs`
Expected: the new test FAILS (no `DEVPROOF_SEED_DEFAULTS` in the render); all pre-existing tests PASS.

- [ ] **Step 3: Add the values key**

In `helm-charts/values.yaml`, inside the `controlplane:` block, directly after `enabled: true`:

```yaml
  # One-time starter-resource seed at first CP boot (marker-guarded — runs
  # once ever, then never again): environments default-all-blocked and
  # default-all-allowed in the default workspace, plus pools default-cpu and
  # default-gpu. Existing names are skipped; deleting the resources later is
  # fine (they are not resurrected). Set false to disable.
  seedDefaults: true
```

- [ ] **Step 4: Render the env var**

In `helm-charts/templates/controlplane/deployment.yaml`, directly after the `DEVPROOF_LOCAL_SERVING` line (~line 85), add:

```yaml
            - { name: DEVPROOF_SEED_DEFAULTS, value: {{ .Values.controlplane.seedDefaults | quote }} }
```

- [ ] **Step 5: Run test to verify it passes**

Run (from repo root): `node --test helm-charts/tests/render.test.mjs`
Expected: ALL tests PASS (including lint and the pre-existing render tests).

- [ ] **Step 6: Commit**

```bash
git add helm-charts/values.yaml helm-charts/templates/controlplane/deployment.yaml helm-charts/tests/render.test.mjs
git commit -m "feat(chart): controlplane.seedDefaults flag for the one-time resource seed"
```

---

### Task 5: Docs + full verification

**Files:**
- Modify: `CLAUDE.md` (repo root — "Conventions & gotchas" bullet list)

**Interfaces:**
- Consumes: everything above.
- Produces: documentation only.

- [ ] **Step 1: Document the convention**

Add one bullet to the "Conventions & gotchas" list in `CLAUDE.md` (after the **Egress** bullet is a sensible spot):

```markdown
- **Default resource seeding (spec 2026-07-24):** first CP boot with `DEVPROOF_SEED_DEFAULTS=true` (chart flag `controlplane.seedDefaults`, default true; unset env = off, so the out-of-cluster dev CP never seeds by accident) creates envs `default-all-blocked`/`default-all-allowed` in `wrkspc_default` + pools `default-cpu`/`default-gpu` (skip-if-exists, nothing overwritten; pools skipped when local serving is off), then sets the `app_settings` `seed.defaultsApplied` marker — once ever; deleting the resources never resurrects them.
```

- [ ] **Step 2: Full backend suite + typecheck**

Run (from `control-plane/`): `npm test` then `npx tsc --noEmit`
Expected: suite green (the sweep cleans the `t-seed-*` workspaces), tsc clean.

- [ ] **Step 3: Chart tests**

Run (from repo root): `node --test helm-charts/tests/render.test.mjs`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: default resource seeding convention"
```
