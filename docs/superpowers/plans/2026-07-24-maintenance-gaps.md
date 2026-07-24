# Maintenance Cleanup Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three maintenance-coverage gaps: `routing_rejects` retention (G1), an orphaned-k8s-resource sweep (G3), and an orphaned `resource_prices` prune (G4) — per spec `docs/superpowers/specs/2026-07-24-maintenance-gaps-design.md`.

**Architecture:** Three new sections join `runMaintenance` (`control-plane/src/maintenance.ts`) using its existing idiom (settings-gated, `guard`-isolated, counts in the summary). Run order becomes `billing → tokens → rejects → sessions → files → prices → k8s → orphans`. The k8s sweep is an expected-set diff (DB ids → rendered names vs listed resources), implemented in `orchestrator.ts` (owner of kube clients + naming) and injected as an optional dep. No SQL migration — settings live in the `app_settings` JSONB.

**Tech Stack:** Node/TS (Fastify CP), `@kubernetes/client-node`, Postgres, Next.js console, `node:test`.

## Global Constraints

- **Commits: no Claude/AI references** — no `Co-Authored-By: Claude` trailer, no "Generated with Claude Code" (project CLAUDE.md, user decision 2026-07-23).
- **Never bump versions** (image tags, Chart.yaml, package.json, version constants) — CI/CD's job.
- Backend tests: `cd control-plane && npm test` (runs serial, `--test-concurrency=1` — shared dev DB; do not parallelize) and `npx tsc --noEmit`.
- DB tests share ONE dev database: seed throwaway workspaces with the swept `t-<tag>-${Date.now()}` prefix; never touch pre-existing rows destructively.
- Console: production build only (`npx next build`), dev mode is too slow.
- New settings defaults (user decisions): `rejects` **ON** `{keep: 30, unit: "days"}`; `prices` **ON**; `k8s` **ON**.
- k8s sweep safety invariants (spec): DB ids load **before** any k8s list; any DB error aborts the section before a single delete; 1h creation-age grace (`GRACE_MS`); per-class isolation; strict id-shape name matching; agents namespace only.
- This repo is CRLF; when deleting whole lines via Edit, re-check `git diff` afterward (known Edit gotcha).

---

### Task 1: Settings schema — `rejects`/`prices`/`k8s` in maintenance settings

**Files:**
- Modify: `control-plane/src/maintenance.ts` (types, `defaultMaintenanceSettings`, `mergeMaintenanceSettings`, `validateMaintenanceSettings`, `MaintenanceSummary`)
- Test: `control-plane/test/maintenance-unit.test.ts`

**Interfaces:**
- Produces: `MaintenanceSettings` gains `rejects: Retention`, `prices: { enabled: boolean }`, `k8s: { enabled: boolean }`. `MaintenanceSummary["sections"]` gains `rejects: { ran: boolean; rows?: number; error?: string }`, `prices: { ran: boolean; rows?: number; error?: string }`, `k8s: { ran: boolean; secrets?: number; egress?: number; policies?: number; pvcs?: number; error?: string }`. Later tasks rely on these exact names.

- [ ] **Step 1: Extend the failing tests**

In `control-plane/test/maintenance-unit.test.ts`, extend the existing `defaultMaintenanceSettings` test (after the `files.output` assertion, before the legacy-cron line):

```ts
  assert.deepEqual(d.rejects, { enabled: true, keep: 30, unit: "days" });
  assert.deepEqual(d.prices, { enabled: true });
  assert.deepEqual(d.k8s, { enabled: true });
```

Extend the `mergeMaintenanceSettings` test (before the `noop` lines):

```ts
  const m2 = mergeMaintenanceSettings(base, { rejects: { keep: 90 }, prices: { enabled: false }, k8s: { enabled: false } });
  assert.deepEqual(m2.rejects, { enabled: true, keep: 90, unit: "days" }); // partial keeps base enabled/unit
  assert.equal(m2.prices.enabled, false);
  assert.equal(m2.k8s.enabled, false);
```

Extend the `validateMaintenanceSettings` test (before the final `"nope"` line):

```ts
  assert.match(validateMaintenanceSettings({ rejects: { keep: 0 } })!, /keep/);
  assert.match(validateMaintenanceSettings({ prices: { enabled: "yes" } })!, /prices/);
  assert.match(validateMaintenanceSettings({ k8s: { enabled: 1 } })!, /k8s/);
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && node --test --test-concurrency=1 test/maintenance-unit.test.ts`
Expected: FAIL — `d.rejects` is `undefined`.

- [ ] **Step 3: Implement in `maintenance.ts`**

`MaintenanceSettings` (after `orphans`):

```ts
  orphans: { enabled: boolean };
  rejects: Retention;
  prices: { enabled: boolean };
  k8s: { enabled: boolean };
```

`MaintenanceSummary["sections"]` (after `files`):

```ts
    rejects:  { ran: boolean; rows?: number; error?: string };
    prices:   { ran: boolean; rows?: number; error?: string };
    k8s:      { ran: boolean; secrets?: number; egress?: number; policies?: number; pvcs?: number; error?: string };
```

`defaultMaintenanceSettings` (after `orphans`):

```ts
    rejects: { enabled: true, keep: 30, unit: "days" },
    prices: { enabled: true },
    k8s: { enabled: true },
```

`mergeMaintenanceSettings` (after `orphans`):

```ts
    rejects: mergeRetention(base.rejects, m?.rejects),
    prices: { enabled: typeof m?.prices?.enabled === "boolean" ? m.prices.enabled : base.prices.enabled },
    k8s: { enabled: typeof m?.k8s?.enabled === "boolean" ? m.k8s.enabled : base.k8s.enabled },
```

`validateMaintenanceSettings`: add to the boolean checks (mirroring `orphans`):

```ts
  if (m.prices?.enabled !== undefined && typeof m.prices.enabled !== "boolean") {
    return "maintenance.prices.enabled must be a boolean";
  }
  if (m.k8s?.enabled !== undefined && typeof m.k8s.enabled !== "boolean") {
    return "maintenance.k8s.enabled must be a boolean";
  }
```

and add `["rejects", m.rejects],` to the `rules` array (after `["tokens", m.tokens],`).

In `runMaintenance`, extend the `sections` initializer so the summary type stays complete (sections themselves come in Tasks 3/5):

```ts
  const sections: MaintenanceSummary["sections"] = {
    orphans: { ran: false }, billing: { ran: false }, tokens: { ran: false },
    sessions: { ran: false }, files: { ran: false },
    rejects: { ran: false }, prices: { ran: false }, k8s: { ran: false },
  };
```

- [ ] **Step 4: Run to verify pass**

Run: `cd control-plane && node --test --test-concurrency=1 test/maintenance-unit.test.ts && npx tsc --noEmit`
Expected: PASS (the three `runMaintenance` tests still pass — new sections default to `ran:false` because nothing runs them yet).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/maintenance.ts control-plane/test/maintenance-unit.test.ts
git commit -m "feat(maintenance): rejects/prices/k8s settings schema (spec 2026-07-24)"
```

---

### Task 2: Repo methods — `pruneRoutingRejects`, `pruneOrphanResourcePrices`, `listAllIds`

**Files:**
- Modify: `control-plane/src/repo.ts` (add after `listExpiredFiles`, ~line 1900, in the "Maintenance retention queries" block)
- Test: `control-plane/test/maintenance.test.ts`

**Interfaces:**
- Produces (exact signatures Tasks 3/5/6 use):
  - `pruneRoutingRejects(cutoffMs: number): Promise<number>`
  - `pruneOrphanResourcePrices(kind: "pool" | "deployment" | "external" | "environment", liveRefs: string[]): Promise<number>`
  - `listAllIds(table: "vaults" | "environments" | "sessions" | "external_deployments"): Promise<string[]>`

- [ ] **Step 1: Write the failing tests**

Append to `control-plane/test/maintenance.test.ts` (before the trailing `deleteSessionFully` block is fine; the file's `pool`, `repo` pattern, `tag`, `wsId`, `seedSession` are already set up — instantiate `new Repo(pool)` inside each test like its siblings):

```ts
test("pruneRoutingRejects deletes only pre-cutoff rows (3650d guard)", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const marker = `t-maint-rej-${tag}`;
  try {
    await pool.query(
      `INSERT INTO routing_rejects (routing, created_at)
       VALUES ($1, now() - interval '4000 days'), ($1, now())`, [marker]);
    const n = await repo.pruneRoutingRejects(3650 * 86_400_000);
    assert.ok(n >= 1);
    const left = await pool.query("SELECT count(*)::int AS n FROM routing_rejects WHERE routing = $1", [marker]);
    assert.equal(left.rows[0].n, 1, "fresh reject row survives");
  } finally {
    await pool.query("DELETE FROM routing_rejects WHERE routing = $1", [marker]);
  }
});

test("pruneOrphanResourcePrices deletes only refs missing from the live set", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const orphanRef = `t-maint-price-orphan-${tag}`;
  const liveRef = `t-maint-price-live-${tag}`;
  try {
    await pool.query(
      `INSERT INTO resource_prices (kind, ref, prices) VALUES ('environment', $1, '{"time":{}}'::jsonb), ('environment', $2, '{"time":{}}'::jsonb)`,
      [orphanRef, liveRef]);
    // Live set = every currently-priced environment ref EXCEPT our orphan, so
    // pre-existing dev rows are never touched by this test.
    const { rows } = await pool.query("SELECT ref FROM resource_prices WHERE kind = 'environment'");
    const live = rows.map((r: any) => r.ref).filter((ref: string) => ref !== orphanRef);
    const n = await repo.pruneOrphanResourcePrices("environment", live);
    assert.ok(n >= 1);
    const left = await pool.query(
      "SELECT ref FROM resource_prices WHERE kind = 'environment' AND ref IN ($1, $2)", [orphanRef, liveRef]);
    assert.deepEqual(left.rows.map((r: any) => r.ref), [liveRef], "orphan gone, live ref survives");
  } finally {
    await pool.query("DELETE FROM resource_prices WHERE ref IN ($1, $2)", [orphanRef, liveRef]);
  }
});

test("listAllIds returns global id lists", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const sesn = `sesn_tmids${tag}`;
  try {
    await seedSession(sesn, "idle", 0);
    assert.ok((await repo.listAllIds("sessions")).includes(sesn));
    for (const t of ["vaults", "environments", "external_deployments"] as const) {
      assert.ok(Array.isArray(await repo.listAllIds(t)), t);
    }
  } finally {
    await pool.query("DELETE FROM sessions WHERE id = $1", [sesn]);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && node --test --test-concurrency=1 test/maintenance.test.ts`
Expected: FAIL — `repo.pruneRoutingRejects is not a function`.

- [ ] **Step 3: Implement in `repo.ts`** (append inside the maintenance-queries block, after `listExpiredFiles`):

```ts
  /** Routing 403 diagnostics (spec 2026-07-24 G1) — no FKs, safe bulk delete. */
  async pruneRoutingRejects(cutoffMs: number): Promise<number> {
    const res = await this.pool.query(
      "DELETE FROM routing_rejects WHERE created_at < now() - ($1 * interval '1 millisecond')", [cutoffMs]);
    return res.rowCount ?? 0;
  }
  /** Price rows whose resource is gone (spec 2026-07-24 G4). An empty liveRefs
   *  is valid — zero live resources means every row of the kind is orphaned. */
  async pruneOrphanResourcePrices(
    kind: "pool" | "deployment" | "external" | "environment", liveRefs: string[],
  ): Promise<number> {
    const res = await this.pool.query(
      "DELETE FROM resource_prices WHERE kind = $1 AND NOT (ref = ANY($2::text[]))", [kind, liveRefs]);
    return res.rowCount ?? 0;
  }
  /** Global id lists for the maintenance orphan sweeps. The table name is a
   *  compile-time union, never user input. */
  async listAllIds(table: "vaults" | "environments" | "sessions" | "external_deployments"): Promise<string[]> {
    const { rows } = await this.pool.query(`SELECT id FROM ${table}`);
    return rows.map((r: any) => r.id);
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd control-plane && node --test --test-concurrency=1 test/maintenance.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/repo.ts control-plane/test/maintenance.test.ts
git commit -m "feat(maintenance): reject/price prune + global id-list repo methods"
```

---

### Task 3: `rejects` + `prices` sections in `runMaintenance`

**Files:**
- Modify: `control-plane/src/maintenance.ts` (`MaintenanceRepo`, `MaintenanceDeps`, `runMaintenance`)
- Test: `control-plane/test/maintenance-unit.test.ts`

**Interfaces:**
- Consumes: Task 1 types; Task 2 repo signatures (as interface members — unit tests stub them).
- Produces: `MaintenanceRepo` gains `pruneRoutingRejects`, `pruneOrphanResourcePrices`, `listAllIds` (Task 2 signatures). `MaintenanceDeps` gains `listServing?: () => Promise<{ pools: string[]; deployments: string[] }>`. Task 6 wires `listServing`.

- [ ] **Step 1: Extend `fakeDeps` and write failing tests**

In `maintenance-unit.test.ts`, extend `fakeDeps`: add to `calls` —

```ts
    rejects: [] as number[], priceKinds: [] as [string, string[]][],
```

add to the `repo` stub —

```ts
      async pruneRoutingRejects(ms: number) { calls.rejects.push(ms); return 4; },
      async pruneOrphanResourcePrices(kind: string, refs: string[]) { calls.priceKinds.push([kind, refs]); return 2; },
      async listAllIds(table: string) { return [`${table}_id1`]; },
```

and add to `deps` (sibling of `deleteSession`) —

```ts
    listServing: async () => ({ pools: ["p1"], deployments: ["d1"] }),
    sweepK8s: async () => ({ secrets: 0, egress: 0, policies: 0, pvcs: 0, errors: [] }),
```

(`sweepK8s` is consumed in Task 5; stubbing it now keeps the default-on `k8s` section green there.)

Update the existing test `"runMaintenance: disabled sections are skipped (ran:false), orphans run by default"` — the new sections are default-ON, so rename its intent and adjust:

```ts
test("runMaintenance: default sections — retention legs skipped, sweeps run", async () => {
  const { deps, calls, cleanup } = fakeDeps(defaultMaintenanceSettings());
  try {
    const s = await runMaintenance(deps);
    assert.equal(s.sections.billing.ran, false);
    assert.equal(s.sections.tokens.ran, false);
    assert.equal(s.sections.sessions.ran, false);
    assert.equal(s.sections.files.ran, false);
    assert.equal(s.sections.orphans.ran, true);
    assert.equal(s.sections.rejects.ran, true);      // default ON (spec 2026-07-24)
    assert.deepEqual(calls.rejects, [30 * 86_400_000]);
    assert.equal(s.sections.rejects.rows, 4);
    assert.equal(s.sections.prices.ran, true);       // default ON
    assert.equal(s.sections.prices.rows, 8);         // 4 kinds × stub 2
    assert.deepEqual(calls.priceKinds.map(([k]) => k), ["pool", "deployment", "external", "environment"]);
    assert.deepEqual(calls.priceKinds[0][1], ["p1"]);
    assert.deepEqual(calls.priceKinds[2][1], ["external_deployments_id1"]);
    assert.deepEqual(calls.cost, []);
    assert.deepEqual(calls.deleted, []);
    assert.ok(calls.persisted, "summary persisted");
  } finally { cleanup(); }
});
```

Add new tests:

```ts
test("runMaintenance prices: failed serving list skips pool/deployment legs only", async () => {
  const { deps, calls, cleanup } = fakeDeps(defaultMaintenanceSettings());
  deps.listServing = async () => { throw new Error("no CRDs"); };
  try {
    const s = await runMaintenance(deps);
    assert.deepEqual(calls.priceKinds.map(([k]: [string, string[]]) => k), ["external", "environment"]);
    assert.equal(s.sections.prices.rows, 4);
    assert.match(s.sections.prices.error!, /serving.*no CRDs/);
  } finally { cleanup(); }
});

test("runMaintenance prices: absent listServing dep fails the serving legs closed", async () => {
  const { deps, calls, cleanup } = fakeDeps(defaultMaintenanceSettings());
  delete deps.listServing;
  try {
    const s = await runMaintenance(deps);
    assert.deepEqual(calls.priceKinds.map(([k]: [string, string[]]) => k), ["external", "environment"]);
    assert.match(s.sections.prices.error!, /no kubestore access/);
  } finally { cleanup(); }
});

test("runMaintenance rejects: disabled section is skipped", async () => {
  const settings = defaultMaintenanceSettings();
  settings.rejects.enabled = false;
  const { deps, calls, cleanup } = fakeDeps(settings);
  try {
    const s = await runMaintenance(deps);
    assert.equal(s.sections.rejects.ran, false);
    assert.deepEqual(calls.rejects, []);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && node --test --test-concurrency=1 test/maintenance-unit.test.ts`
Expected: FAIL — `s.sections.rejects.ran` is `false` (section not implemented).

- [ ] **Step 3: Implement in `maintenance.ts`**

Extend `MaintenanceRepo`:

```ts
  pruneRoutingRejects(cutoffMs: number): Promise<number>;
  pruneOrphanResourcePrices(
    kind: "pool" | "deployment" | "external" | "environment", liveRefs: string[]): Promise<number>;
  listAllIds(table: "vaults" | "environments" | "sessions" | "external_deployments"): Promise<string[]>;
```

Extend `MaintenanceDeps`:

```ts
  /** Live pool/deployment CR names (kubestore) for the prices sweep. Absent ⇒
   *  the pool/deployment legs fail closed. */
  listServing?: () => Promise<{ pools: string[]; deployments: string[] }>;
```

In `runMaintenance`, insert after the `tokens` block:

```ts
  if (m.rejects.enabled) await guard(sections.rejects, async () => {
    sections.rejects.rows = await deps.repo.pruneRoutingRejects(retentionMs(m.rejects));
  });
```

Insert after the `files` block (before `orphans`):

```ts
  // Prices: per-kind fail-closed — a failed lister skips that kind only; an
  // empty-but-successful list is valid (zero live resources ⇒ all orphaned).
  if (m.prices.enabled) await guard(sections.prices, async () => {
    let rows = 0;
    const errs: string[] = [];
    const leg = async (kind: "pool" | "deployment" | "external" | "environment", refs: () => Promise<string[]>) => {
      try { rows += await deps.repo.pruneOrphanResourcePrices(kind, await refs()); }
      catch (err) { errs.push(`${kind}: ${String((err as Error)?.message ?? err)}`); }
    };
    if (deps.listServing) {
      let serving: { pools: string[]; deployments: string[] } | null = null;
      try { serving = await deps.listServing(); }
      catch (err) { errs.push(`serving: ${String((err as Error)?.message ?? err)}`); }
      if (serving) {
        await leg("pool", async () => serving.pools);
        await leg("deployment", async () => serving.deployments);
      }
    } else errs.push("serving: no kubestore access");
    await leg("external", () => deps.repo.listAllIds("external_deployments"));
    await leg("environment", () => deps.repo.listAllIds("environments"));
    sections.prices.rows = rows;
    if (errs.length) sections.prices.error = errs.join("; ");
  });
```

- [ ] **Step 4: Run to verify pass**

Run: `cd control-plane && node --test --test-concurrency=1 test/maintenance-unit.test.ts && npx tsc --noEmit`
Expected: PASS. (`tsc` will flag the `sweepK8s` stub in `fakeDeps` if `MaintenanceDeps` lacks it — that member arrives in Task 5; if `tsc` complains here, cast the stub deps as `any` — `fakeDeps` already returns `deps as any`.)

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/maintenance.ts control-plane/test/maintenance-unit.test.ts
git commit -m "feat(maintenance): rejects retention + orphan price prune sections"
```

---

### Task 4: k8s sweep — pure helpers + `sweepOrphanedK8s` in `orchestrator.ts`

**Files:**
- Modify: `control-plane/src/orchestrator.ts` (append after `buildEnvNetworkPolicy`)
- Test: Create `control-plane/test/k8s-sweep.test.ts`

**Interfaces:**
- Produces:
  - `orphanCandidates(items: { name?: string; creationTimestamp?: string | Date }[], prefix: string, ownerIds: string[], graceMs: number, now?: () => Date): string[]` (pure, exported for tests)
  - `orphanPvcNames(items: { name?: string; creationTimestamp?: string | Date; sessionLabel?: string }[], sessionIds: string[], graceMs: number, now?: () => Date): string[]` (pure, exported for tests)
  - `sweepOrphanedK8s(input: { vaultIds: string[]; environmentIds: string[]; sessionIds: string[]; graceMs: number }): Promise<{ secrets?: number; egress?: number; policies?: number; pvcs?: number; errors: string[] }>` — Task 5 consumes this exact signature as `MaintenanceDeps["sweepK8s"]`; Task 6 wires it.

- [ ] **Step 1: Write the failing tests**

Create `control-plane/test/k8s-sweep.test.ts`:

```ts
// Pure logic of the orphaned-k8s maintenance sweep (spec 2026-07-24 G3).
// The k8s glue in sweepOrphanedK8s is thin (list → filter → delete) and is
// verified live; everything decision-making is tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { orphanCandidates, orphanPvcNames } from "../src/orchestrator.ts";

const NOW = () => new Date("2026-07-24T12:00:00Z");
const OLD = "2026-07-24T10:00:00Z"; // 2h ago — past the 1h grace
const YOUNG = "2026-07-24T11:30:00Z"; // 30min ago — inside grace
const H = 3_600_000;

test("orphanCandidates: strict id-shape match, expected-set survival, grace", () => {
  const items = [
    { name: "devproof-vault-vlt-abc123def456", creationTimestamp: OLD },  // orphan, new-style id
    { name: "devproof-vault-0123456789abcdef01234567", creationTimestamp: OLD }, // orphan, legacy hex
    { name: "devproof-vault-vlt-live00000001", creationTimestamp: OLD },  // live — in ownerIds
    { name: "devproof-vault-vlt-young0000001", creationTimestamp: YOUNG }, // orphan but young — grace keeps it
    { name: "devproof-vault-vlt-noage0000001" },                           // no creationTimestamp — keep (fail-safe)
    { name: "devproof-vault-registry-auth", creationTimestamp: OLD },      // chart-ish name — not id-shaped
    { name: "some-other-secret", creationTimestamp: OLD },                 // wrong prefix
  ];
  const got = orphanCandidates(items, "devproof-vault-", ["vlt_live00000001"], H, NOW);
  assert.deepEqual(got.sort(), [
    "devproof-vault-0123456789abcdef01234567",
    "devproof-vault-vlt-abc123def456",
  ]);
});

test("orphanCandidates: env NetworkPolicy double-prefix shape", () => {
  const items = [
    { name: "env-env-abc123def456", creationTimestamp: OLD },  // orphan (rendered env_abc123def456)
    { name: "env-env-live00000002", creationTimestamp: OLD },  // live
    { name: "env-gateway-lockdown", creationTimestamp: OLD },  // operator-added policy — not id-shaped
  ];
  assert.deepEqual(
    orphanCandidates(items, "env-", ["env_live00000002"], H, NOW),
    ["env-env-abc123def456"]);
});

test("orphanPvcNames: label-driven, session row wins, grace + missing label fail-safe", () => {
  const items = [
    { name: "sesn-dead00000001-work", creationTimestamp: OLD, sessionLabel: "sesn_dead00000001" },  // orphan
    { name: "sesn-live00000001-work", creationTimestamp: OLD, sessionLabel: "sesn_live00000001" },  // live session
    { name: "sesn-young0000001-work", creationTimestamp: YOUNG, sessionLabel: "sesn_young0000001" }, // young
    { name: "sesn-nolabel000001-work", creationTimestamp: OLD },                                     // no label — keep
  ];
  assert.deepEqual(
    orphanPvcNames(items, ["sesn_live00000001"], H, NOW),
    ["sesn-dead00000001-work"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && node --test --test-concurrency=1 test/k8s-sweep.test.ts`
Expected: FAIL — `orphanCandidates` is not exported.

- [ ] **Step 3: Implement in `orchestrator.ts`** (append after `buildEnvNetworkPolicy`):

```ts
// ── Orphaned-resource sweep (maintenance `k8s` section, spec 2026-07-24 G3) ──
// Expected-set diff: the CALLER supplies every live owner id; anything in the
// agents namespace whose name is id-shaped but not expected is an orphan.
// Never reverses a name back to an id.

const rendered = (id: string) => id.replace(/_/g, "-").toLowerCase();
// Rendered forms of the two id generations: `prefix_`+12-base36 → `prefix-…`,
// and legacy 24-hex. Anything else (chart/operator resources) never matches.
const ID_SHAPES = [/^[a-z0-9]+-[a-z0-9]{12}$/, /^[0-9a-f]{24}$/];

/** Pure: names to delete among `items` for one resource class. Keeps anything
 *  not id-shaped, anything expected, and anything younger than graceMs (or of
 *  unknown age — fail-safe). Exported for tests. */
export function orphanCandidates(
  items: { name?: string; creationTimestamp?: string | Date }[],
  prefix: string, ownerIds: string[], graceMs: number, now: () => Date = () => new Date(),
): string[] {
  const expected = new Set(ownerIds.map((id) => prefix + rendered(id)));
  const out: string[] = [];
  for (const it of items) {
    const name = it.name ?? "";
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!ID_SHAPES.some((re) => re.test(suffix))) continue;
    if (expected.has(name)) continue;
    const created = it.creationTimestamp ? new Date(it.creationTimestamp).getTime() : NaN;
    if (!(now().getTime() - created >= graceMs)) continue;
    out.push(name);
  }
  return out;
}

/** Pure: /work PVCs to delete — label-driven (the devproof.ai/session label
 *  carries the exact owner id), no name parsing at all. Exported for tests. */
export function orphanPvcNames(
  items: { name?: string; creationTimestamp?: string | Date; sessionLabel?: string }[],
  sessionIds: string[], graceMs: number, now: () => Date = () => new Date(),
): string[] {
  const live = new Set(sessionIds);
  const out: string[] = [];
  for (const it of items) {
    if (!it.name || !it.sessionLabel || live.has(it.sessionLabel)) continue;
    const created = it.creationTimestamp ? new Date(it.creationTimestamp).getTime() : NaN;
    if (!(now().getTime() - created >= graceMs)) continue;
    out.push(it.name);
  }
  return out;
}

/** k8s glue for the maintenance `k8s` section: list per class, filter via the
 *  pure helpers, delete (404-tolerant). Per-class isolation — a failed list
 *  skips that class (count stays undefined) and records an error. */
export async function sweepOrphanedK8s(input: {
  vaultIds: string[]; environmentIds: string[]; sessionIds: string[]; graceMs: number;
}): Promise<{ secrets?: number; egress?: number; policies?: number; pvcs?: number; errors: string[] }> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  const networking = kc.makeApiClient(k8s.NetworkingV1Api);
  const errors: string[] = [];
  const meta = (r: any) => ({ name: r.metadata?.name, creationTimestamp: r.metadata?.creationTimestamp });
  const del = async (p: Promise<unknown>) => {
    try { await p; return 1; } catch (err: any) { if (err?.code === 404) return 0; throw err; }
  };
  const cls = async (label: string, run: () => Promise<number>): Promise<number | undefined> => {
    try { return await run(); }
    catch (err) { errors.push(`${label}: ${String((err as Error)?.message ?? err)}`); return undefined; }
  };

  const secrets = await cls("secrets", async () => {
    const res: any = await core.listNamespacedSecret({ namespace: AGENTS_NAMESPACE });
    let n = 0;
    for (const name of orphanCandidates((res.items ?? []).map(meta), "devproof-vault-", input.vaultIds, input.graceMs)) {
      n += await del(core.deleteNamespacedSecret({ name, namespace: AGENTS_NAMESPACE }));
    }
    return n;
  });
  const egress = await cls("egress", async () => {
    let n = 0;
    const [cms, deploys, svcs]: any[] = await Promise.all([
      core.listNamespacedConfigMap({ namespace: AGENTS_NAMESPACE }),
      apps.listNamespacedDeployment({ namespace: AGENTS_NAMESPACE }),
      core.listNamespacedService({ namespace: AGENTS_NAMESPACE }),
    ]);
    for (const name of orphanCandidates((cms.items ?? []).map(meta), "egress-", input.environmentIds, input.graceMs))
      n += await del(core.deleteNamespacedConfigMap({ name, namespace: AGENTS_NAMESPACE }));
    for (const name of orphanCandidates((deploys.items ?? []).map(meta), "egress-", input.environmentIds, input.graceMs))
      n += await del(apps.deleteNamespacedDeployment({ name, namespace: AGENTS_NAMESPACE }));
    for (const name of orphanCandidates((svcs.items ?? []).map(meta), "egress-", input.environmentIds, input.graceMs))
      n += await del(core.deleteNamespacedService({ name, namespace: AGENTS_NAMESPACE }));
    return n;
  });
  const policies = await cls("policies", async () => {
    const res: any = await networking.listNamespacedNetworkPolicy({ namespace: AGENTS_NAMESPACE });
    let n = 0;
    for (const name of orphanCandidates((res.items ?? []).map(meta), "env-", input.environmentIds, input.graceMs))
      n += await del(networking.deleteNamespacedNetworkPolicy({ name, namespace: AGENTS_NAMESPACE }));
    return n;
  });
  const pvcs = await cls("pvcs", async () => {
    const res: any = await core.listNamespacedPersistentVolumeClaim({
      namespace: AGENTS_NAMESPACE, labelSelector: "app=devproof-session",
    });
    const items = (res.items ?? []).map((r: any) => ({
      ...meta(r), sessionLabel: r.metadata?.labels?.["devproof.ai/session"],
    }));
    let n = 0;
    for (const name of orphanPvcNames(items, input.sessionIds, input.graceMs))
      n += await del(core.deleteNamespacedPersistentVolumeClaim({ name, namespace: AGENTS_NAMESPACE }));
    return n;
  });
  return { secrets, egress, policies, pvcs, errors };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd control-plane && node --test --test-concurrency=1 test/k8s-sweep.test.ts test/orchestrator.test.ts && npx tsc --noEmit`
Expected: PASS (orchestrator tests included to confirm nothing existing broke).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/orchestrator.ts control-plane/test/k8s-sweep.test.ts
git commit -m "feat(maintenance): orphaned-k8s sweep — expected-set diff over agents namespace"
```

---

### Task 5: `k8s` section in `runMaintenance`

**Files:**
- Modify: `control-plane/src/maintenance.ts` (`MaintenanceDeps`, `runMaintenance`)
- Test: `control-plane/test/maintenance-unit.test.ts`

**Interfaces:**
- Consumes: `sweepOrphanedK8s` signature from Task 4 (as the `sweepK8s` dep type — maintenance.ts does NOT import orchestrator.ts).
- Produces: `MaintenanceDeps.sweepK8s?: (input: { vaultIds: string[]; environmentIds: string[]; sessionIds: string[]; graceMs: number }) => Promise<{ secrets?: number; egress?: number; policies?: number; pvcs?: number; errors: string[] }>` — Task 6 wires it.

- [ ] **Step 1: Write the failing tests**

In `maintenance-unit.test.ts`, add to `calls` in `fakeDeps`:

```ts
    sweeps: [] as any[],
```

and change the `sweepK8s` stub added in Task 3 to record its input:

```ts
    sweepK8s: async (input: any) => { calls.sweeps.push(input); return { secrets: 1, egress: 3, policies: 1, pvcs: 2, errors: [] }; },
```

New tests:

```ts
test("runMaintenance k8s: id sets flow to the sweep, counts land in the summary", async () => {
  const { deps, calls, cleanup } = fakeDeps(defaultMaintenanceSettings());
  try {
    const s = await runMaintenance(deps);
    assert.equal(s.sections.k8s.ran, true);
    assert.equal(calls.sweeps.length, 1);
    assert.deepEqual(calls.sweeps[0].vaultIds, ["vaults_id1"]);
    assert.deepEqual(calls.sweeps[0].environmentIds, ["environments_id1"]);
    assert.deepEqual(calls.sweeps[0].sessionIds, ["sessions_id1"]);
    assert.equal(calls.sweeps[0].graceMs, 3_600_000);
    assert.equal(s.sections.k8s.secrets, 1);
    assert.equal(s.sections.k8s.egress, 3);
    assert.equal(s.sections.k8s.policies, 1);
    assert.equal(s.sections.k8s.pvcs, 2);
    assert.equal(s.sections.k8s.error, undefined);
  } finally { cleanup(); }
});

test("runMaintenance k8s: absent dep reports error, class errors joined", async () => {
  const { deps, cleanup } = fakeDeps(defaultMaintenanceSettings());
  delete deps.sweepK8s;
  try {
    const s = await runMaintenance(deps);
    assert.equal(s.sections.k8s.ran, true);
    assert.match(s.sections.k8s.error!, /no k8s access/);
  } finally { cleanup(); }
  const withErrs = fakeDeps(defaultMaintenanceSettings());
  withErrs.deps.sweepK8s = async () => ({ secrets: 1, errors: ["pvcs: list timed out"] });
  try {
    const s = await runMaintenance(withErrs.deps);
    assert.equal(s.sections.k8s.secrets, 1);
    assert.equal(s.sections.k8s.pvcs, undefined, "failed class stays undefined");
    assert.match(s.sections.k8s.error!, /pvcs: list timed out/);
  } finally { withErrs.cleanup(); }
});

test("runMaintenance k8s: DB id-list failure aborts before the sweep (fail-closed)", async () => {
  const { deps, calls, cleanup } = fakeDeps(defaultMaintenanceSettings());
  deps.repo.listAllIds = async (table: string) => {
    if (table === "sessions") throw new Error("db down");
    return [];
  };
  try {
    const s = await runMaintenance(deps);
    assert.match(s.sections.k8s.error!, /db down/);
    assert.equal(calls.sweeps.length, 0, "sweep never called on partial DB data");
  } finally { cleanup(); }
});
```

Note: the prices section also calls `listAllIds` — the `db down` stub above only throws for `"sessions"`, so prices stays green.

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && node --test --test-concurrency=1 test/maintenance-unit.test.ts`
Expected: FAIL — `s.sections.k8s.ran` is `false`.

- [ ] **Step 3: Implement in `maintenance.ts`**

Extend `MaintenanceDeps`:

```ts
  /** Orphaned-k8s sweep (orchestrator.sweepOrphanedK8s). Absent ⇒ the k8s
   *  section reports an error instead of silently claiming success. */
  sweepK8s?: (input: { vaultIds: string[]; environmentIds: string[]; sessionIds: string[]; graceMs: number }) =>
    Promise<{ secrets?: number; egress?: number; policies?: number; pvcs?: number; errors: string[] }>;
```

In `runMaintenance`, insert after the `prices` block (before `orphans`):

```ts
  // k8s sweep: DB ids load FIRST and any failure aborts before a single
  // delete (fail-closed — spec 2026-07-24 G3 safety rails).
  if (m.k8s.enabled) await guard(sections.k8s, async () => {
    if (!deps.sweepK8s) throw new Error("no k8s access");
    const [vaultIds, environmentIds, sessionIds] = await Promise.all([
      deps.repo.listAllIds("vaults"),
      deps.repo.listAllIds("environments"),
      deps.repo.listAllIds("sessions"),
    ]);
    const r = await deps.sweepK8s({ vaultIds, environmentIds, sessionIds, graceMs: GRACE_MS });
    sections.k8s.secrets = r.secrets;
    sections.k8s.egress = r.egress;
    sections.k8s.policies = r.policies;
    sections.k8s.pvcs = r.pvcs;
    if (r.errors.length) sections.k8s.error = r.errors.join("; ");
  });
```

- [ ] **Step 4: Run to verify pass**

Run: `cd control-plane && node --test --test-concurrency=1 test/maintenance-unit.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/maintenance.ts control-plane/test/maintenance-unit.test.ts
git commit -m "feat(maintenance): k8s orphan-sweep section with fail-closed id snapshot"
```

---

### Task 6: Wiring — shared `maintenanceDeps` in `main.ts` + the manual-run route

**Files:**
- Modify: `control-plane/src/main.ts` (~line 227 `registerAgentRoutes` call, ~line 248 `startMaintenanceScheduler` call, imports)
- Modify: `control-plane/src/agents-api.ts` (`registerAgentRoutes` opts type ~line 127; `/v1/maintenance/run` route ~line 1154)

**Interfaces:**
- Consumes: `sweepOrphanedK8s` (Task 4), `MaintenanceDeps` incl. `listServing`/`sweepK8s` (Tasks 3/5), `kube.list` (existing KubeStore).
- Produces: `registerAgentRoutes` opts gains `maintenanceDeps?: import("./maintenance.ts").MaintenanceDeps`.

- [ ] **Step 1: agents-api.ts — accept shared deps**

Add to the `opts?` type of `registerAgentRoutes`:

```ts
    maintenanceDeps?: import("./maintenance.ts").MaintenanceDeps;
```

Change the manual-run route (keep the inline fallback so tests registering routes without opts stay green):

```ts
  // Manual maintenance trigger (console "Run maintenance now"). Synchronous:
  // bounded work, the console shows the returned per-section summary. Uses the
  // SAME deps object as the scheduler (main.ts) so the two can never diverge.
  app.post("/v1/maintenance/run", async () => runMaintenance(opts?.maintenanceDeps ?? {
    repo, files,
    deleteSession: (w, id) => deleteSessionFully({ repo, orchestrator, files }, w, id),
  }));
```

- [ ] **Step 2: main.ts — build once, wire twice**

Add `sweepOrphanedK8s` to the orchestrator import (line 12):

```ts
import { realOrchestrator, sweepOrphanedK8s } from "./orchestrator.ts";
```

Replace the `startMaintenanceScheduler({...})` call (~line 248) with:

```ts
const maintenanceDeps = {
  repo, files,
  deleteSession: (w: string, id: string) => deleteSessionFully({ repo, orchestrator, files }, w, id),
  sweepK8s: sweepOrphanedK8s,
  listServing: async () => {
    const [pools, mds] = await Promise.all([kube.list("modelpools"), kube.list("modeldeployments")]);
    return {
      pools: pools.map((p: any) => p.metadata?.name).filter(Boolean),
      deployments: mds.map((d: any) => d.metadata?.name).filter(Boolean),
    };
  },
};
startMaintenanceScheduler(maintenanceDeps);
```

`maintenanceDeps` must be defined BEFORE the `registerAgentRoutes` call at ~line 227 — move the block above it, then add `maintenanceDeps` to that call's opts:

```ts
await registerAgentRoutes(app, repo, orchestrator, files, notify, { modelPhase, mcpRegistry, settleSession: settle, releaseWriterSlot, wakeModel: wake, maintenanceDeps });
```

(`registerPublicApi` on the next line is unchanged — it has no maintenance route.)

- [ ] **Step 3: Typecheck + full suite**

Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: both green (no new tests in this task — it's pure wiring; behavior is covered by Task 8 live verification).

- [ ] **Step 4: Commit**

```bash
git add control-plane/src/main.ts control-plane/src/agents-api.ts
git commit -m "feat(maintenance): wire shared deps into scheduler and manual-run route"
```

---

### Task 7: Console — settings rows + last-run lines

**Files:**
- Modify: `console/app/settings/form.tsx`

**Interfaces:**
- Consumes: Task 1's settings/summary field names (`rejects`, `prices`, `k8s`) via `GET /v1/settings` / `POST /v1/maintenance/run`.

- [ ] **Step 1: Types** — extend the console-side mirrors:

In `MaintenanceSettings` (after `orphans`):

```ts
  rejects: { enabled: boolean; keep: number; unit: Unit };
  prices: { enabled: boolean };
  k8s: { enabled: boolean };
```

In `MaintenanceSummary["sections"]` — new sections OPTIONAL here (summaries persisted before this upgrade lack them; the UI must not crash rendering an old `maintenanceLastRun`):

```ts
    rejects?: { ran: boolean; rows?: number; error?: string };
    prices?: { ran: boolean; rows?: number; error?: string };
    k8s?: { ran: boolean; secrets?: number; egress?: number; policies?: number; pvcs?: number; error?: string };
```

- [ ] **Step 2: `sectionLines` — undefined-tolerant `line` + three new lines**

Change `line` to accept a possibly-absent section:

```ts
  const line = (x: { ran: boolean; error?: string } | undefined, ok: () => string) =>
    !x || !x.ran ? "skipped (disabled)" : x.error ? `failed — ${x.error}` : ok();
```

Add to the returned array (after the "Token usage" entry):

```ts
    ["Routing rejects", line(sec.rejects, () => `${sec.rejects?.rows ?? 0} rows removed`)],
    ["Price rows", line(sec.prices, () => `${sec.prices?.rows ?? 0} rows removed`)],
    ["Cluster resources", line(sec.k8s, () =>
      `${sec.k8s?.secrets ?? 0} secrets, ${sec.k8s?.egress ?? 0} egress objects, ${sec.k8s?.policies ?? 0} policies, ${sec.k8s?.pvcs ?? 0} PVCs removed`)],
```

Also fix the "completed with errors" check (line ~298) for optional sections:

```ts
{Object.values(summary.sections).some((x) => x?.error) ? "completed with errors" : "completed successfully"}
```

- [ ] **Step 3: State + dirty + save**

State (after the `outFiles` line):

```ts
  const [rejects, setRejects] = useState(toForm(initialMaintenance.rejects));
  const [prices, setPrices] = useState(initialMaintenance.prices.enabled);
  const [k8sOn, setK8sOn] = useState(initialMaintenance.k8s.enabled);
```

`maintDirty` (add to the chain):

```ts
    retDirty(rejects, savedMaint.rejects) ||
    prices !== savedMaint.prices.enabled ||
    k8sOn !== savedMaint.k8s.enabled;
```

`save()` maintenance object (after `files:`):

```ts
        rejects: fromForm("Routing rejects", rejects),
        prices: { enabled: prices },
        k8s: { enabled: k8sOn },
```

- [ ] **Step 4: JSX rows**

After the "Delete orphaned data" `Row` (~line 274), add the two sweep toggles:

```tsx
          <Row label="Delete orphaned cluster resources" checked={k8sOn}
               hint="removes egress proxies, network policies, vault secrets, and work volumes whose owning record is gone — 1h grace, live records always survive"
               onChange={setK8sOn} />
          <Row label="Delete orphaned price rows" checked={prices}
               hint="removes prices whose pool, deployment, endpoint, or environment no longer exists"
               onChange={setPrices} />
```

After the "Clean up token usage" `RetRow` (~line 278), add:

```tsx
          <RetRow label="Clean up routing rejects" value={rejects} onChange={setRejects}
                  hint="removes routing 403 diagnostic rows older than this — routing stats read recent windows only" />
```

- [ ] **Step 5: Build + verify**

Run: `cd console && npx next build`
Expected: build succeeds. (Full visual check happens in Task 8 with CP + console running.)

- [ ] **Step 6: Commit**

```bash
git add console/app/settings/form.tsx
git commit -m "feat(console): maintenance toggles for rejects, price, and cluster sweeps"
```

---

### Task 8: Live verification (docker-desktop) + full suite

**Files:**
- Create (scratch, NOT committed): `<scratchpad>/sweep-live.ts` — direct `sweepOrphanedK8s` exercise with `graceMs: 0` (fresh test resources are minutes old; the section's 1h grace would — correctly — skip them, so the run-route pass verifies grace and the script verifies deletion).

The k8s deletion path can't be exercised through `POST /v1/maintenance/run` alone in one sitting (grace). Two-pronged verification:

- [ ] **Step 1: Ensure infra + CP running** — cluster up, CP started per CLAUDE.md run notes (env vars incl. `DEVPROOF_RUNNER_IMAGE`), console `npx next build && npx next start -p 7090`.

- [ ] **Step 2: Seed orphans via SQL** (Postgres at `localhost:15432`). Create a throwaway environment + vault through the console (any name, e.g. `t-sweep-env`, `t-sweep-vault`), confirm their k8s resources exist:

```bash
kubectl get deploy,svc,cm,netpol,secret -n devproof-agents | grep -E "egress-env-|env-env-|devproof-vault-"
```

Then orphan them (note the ids from the console first):

```sql
DELETE FROM environments WHERE id = '<env id>';
DELETE FROM vaults WHERE id = '<vault id>';
```

Also seed an old reject + an orphan price row:

```sql
INSERT INTO routing_rejects (routing, created_at) VALUES ('t-sweep-rej', now() - interval '40 days');
INSERT INTO resource_prices (kind, ref, prices) VALUES ('environment', 't-sweep-price', '{"time":{}}'::jsonb);
```

- [ ] **Step 3: Grace verified via the real route** — `POST http://localhost:7080/v1/maintenance/run` (console "Run maintenance now" or curl). Expected summary: `rejects.rows ≥ 1`, `prices.rows ≥ 1`, `k8s` ran with **0 deletions** (resources minutes old — grace holds), no errors. Verify in SQL that the reject and price rows are gone and the k8s resources still exist.

- [ ] **Step 4: Deletion verified via the seam** — scratch script (run with `npx tsx` from `control-plane/`):

```ts
import { createPool } from "./src/db.ts";
import { Repo } from "./src/repo.ts";
import { sweepOrphanedK8s } from "./src/orchestrator.ts";

const repo = new Repo(createPool());
const [vaultIds, environmentIds, sessionIds] = await Promise.all([
  repo.listAllIds("vaults"), repo.listAllIds("environments"), repo.listAllIds("sessions")]);
console.log(await sweepOrphanedK8s({ vaultIds, environmentIds, sessionIds, graceMs: 0 }));
process.exit(0);
```

Expected: counts ≥ 1 for `secrets`, `egress` (3 objects), `policies`; `errors: []`. Then verify with kubectl: the orphaned `egress-env-*` trio, `env-env-*` policy, and `devproof-vault-*` Secret are GONE, and every resource belonging to live rows (list envs/vaults in the console) still exists. If any live resource vanished: STOP, investigate before proceeding.

- [ ] **Step 5: Console check** — `/settings` shows the three new controls; toggle + Save roundtrips; last-run lines render (including for the pre-upgrade summary if one existed). All console pages 200.

- [ ] **Step 6: Full suite**

```bash
cd control-plane && npx tsc --noEmit && npm test
```

Expected: green.

- [ ] **Step 7: Final commit (if any stragglers) + wrap up** — delete the scratch script; `git status` clean apart from intended changes.
