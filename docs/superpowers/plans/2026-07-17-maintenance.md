# Maintenance Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the GC "Storage" feature into a Maintenance panel: the existing orphan sweep plus five new retention-based cleanups (billing, tokens, sessions ×2, files ×2), one schedule, one run-now button, per-section result reporting.

**Architecture:** One runner (`src/maintenance.ts`, renamed from `gc.ts`) executes enabled tasks in fixed order — billing → tokens → sessions → files → orphans — so session deletion detaches files before file cleanup and the orphan sweep mops up last. Session deletion goes through a new shared helper (`src/session-delete.ts`) used by both the DELETE routes and the runner. Settings live under `app_settings.data.maintenance` (JSONB key, no migration); one SQL migration (043) adds `files.last_attached_at` + an attach trigger.

**Tech Stack:** Node/TS (Fastify) control plane, Postgres, Next.js console. Tests: Node test runner via `npm test` (serialized, shared dev DB).

**Spec:** `docs/superpowers/specs/2026-07-17-maintenance-design.md` — read it before starting; its "Decisions" block is binding.

## Global Constraints

- **Shared dev DB:** tests run against the real dev database. NEVER let a test delete rows it didn't seed: retention-prune tests must use cutoffs ≥ 3650 days with seeds older than that; session/file cleanup tests assert on seeded ids only and never call `runMaintenance` with real settings that enable destructive sections. Throwaway workspaces MUST use a `t-<tag>-${Date.now()}` name (the post-suite sweep collects them).
- **`migrate()` re-runs every SQL file each boot** — every statement in migration 043 must be idempotent; the `WHERE last_attached_at IS NULL` backfill guard is load-bearing.
- **Run tests:** `cd control-plane` then `npm test` (full suite + workspace sweep) or `npm test -- test/<file>.test.ts` (single file + sweep). Type check: `npx tsc --noEmit`. Do not remove `--test-concurrency=1`.
- **Console:** production build only (`npx next build`), no `prompt()/confirm()/alert()`, no transparent text buttons, shared `Modal`/`setrow` patterns. Do not export server-callable values from `"use client"` modules (types are fine).
- **CRLF repo:** after bulk line deletions via Edit, re-check `git diff` for accidental line joins.
- **Defaults (from spec, binding):** all new cleanups `enabled: false`; orphans `enabled: true`; billing/tokens 365 days; sessions idle 7 days, completed 4 hours; files input/output 4 hours. `unit` ∈ `hours|days`. `keep` integer ≥ 1.
- Commit after every task with the message given in the task.

---

### Task 1: Migration 043 — `files.last_attached_at` + attach trigger

**Files:**
- Create: `control-plane/sql/043_file_last_attached.sql`
- Create: `control-plane/test/maintenance.test.ts` (DB-backed test file; later tasks extend it)

**Interfaces:**
- Produces: `files.last_attached_at TIMESTAMPTZ` (default `now()`, backfilled from `created_at`), bumped by trigger `trg_session_files_touch` on every `session_files` INSERT. Later tasks rely on the column name `last_attached_at` exactly.

- [ ] **Step 1: Write the failing test**

Create `control-plane/test/maintenance.test.ts`:

```ts
// Maintenance DB-backed tests (spec 2026-07-17-maintenance-design.md):
// migration 043, retention repo methods, session/file cleanup integration.
// Shared dev DB — seeds use the swept t- workspace prefix; prune tests use
// ≥3650-day cutoffs so they can never touch real data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

const tag = Date.now();
const wsId = `t-maint-${tag}`;
const agentId = `agent_tmaint${tag}`;

if (available) {
  await pool.query("INSERT INTO workspaces (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING", [wsId]);
  await pool.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $1) ON CONFLICT DO NOTHING", [agentId, wsId]);
}

async function seedSession(id: string, status: string, ageDays: number, workspaceId = wsId, agent = agentId) {
  await pool.query(
    `INSERT INTO sessions (id, workspace_id, agent_id, agent_version, status, created_at, updated_at)
     VALUES ($1, $2, $3, 1, $4, now() - ($5 * interval '1 day'), now() - ($5 * interval '1 day'))`,
    [id, workspaceId, agent, status, ageDays]);
}

test("043: last_attached_at set on insert, bumped by attach trigger", { skip: !available }, async () => {
  const fileId = `file_t043a${tag}`;
  const sesnId = `sesn_t043a${tag}`;
  try {
    await pool.query(
      "INSERT INTO files (id, workspace_id, name, size, sha256, kind, object_key) VALUES ($1, $2, 't.bin', 1, 'x', 'upload', $1)",
      [fileId, wsId]);
    const a = await pool.query("SELECT last_attached_at FROM files WHERE id = $1", [fileId]);
    assert.ok(a.rows[0].last_attached_at, "default now() on insert");

    await pool.query("UPDATE files SET last_attached_at = now() - interval '10 days' WHERE id = $1", [fileId]);
    await seedSession(sesnId, "idle", 0);
    await pool.query("INSERT INTO session_files (session_id, file_id, role) VALUES ($1, $2, 'input')", [sesnId, fileId]);
    const b = await pool.query("SELECT last_attached_at FROM files WHERE id = $1", [fileId]);
    assert.ok(new Date(b.rows[0].last_attached_at).getTime() > Date.now() - 60_000, "attach bumps last_attached_at");
  } finally {
    await pool.query("DELETE FROM sessions WHERE id = $1", [sesnId]); // cascades session_files
    await pool.query("DELETE FROM files WHERE id = $1", [fileId]);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `control-plane/`): `npm test -- test/maintenance.test.ts`
Expected: FAIL — `column "last_attached_at" does not exist`.

- [ ] **Step 3: Write the migration**

Create `control-plane/sql/043_file_last_attached.sql`:

```sql
-- "Last attached" for file retention (maintenance spec 2026-07-17). Stamped at
-- insert (default), bumped on every session attach by a statement-level
-- trigger (035 idiom — covers all present and future attach paths). No bump
-- on detach: eligibility is "no session_files rows AND last_attached_at older
-- than cutoff", so a freed file ages from its last attach.
ALTER TABLE files ADD COLUMN IF NOT EXISTS last_attached_at TIMESTAMPTZ;
ALTER TABLE files ALTER COLUMN last_attached_at SET DEFAULT now();
-- Guard is load-bearing: migrate() re-runs every file each boot.
UPDATE files SET last_attached_at = created_at WHERE last_attached_at IS NULL;

CREATE OR REPLACE FUNCTION touch_file_last_attached() RETURNS trigger AS $$
BEGIN
  UPDATE files SET last_attached_at = now()
   WHERE id IN (SELECT DISTINCT file_id FROM new_rows);
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_session_files_touch ON session_files;
CREATE TRIGGER trg_session_files_touch
  AFTER INSERT ON session_files
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION touch_file_last_attached();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/maintenance.test.ts`
Expected: PASS (the `migrate()` in the test applies 043).

- [ ] **Step 5: Run the full suite + type check to catch regressions**

Run: `npm test` and `npx tsc --noEmit`
Expected: green (043 is additive).

- [ ] **Step 6: Commit**

```bash
git add control-plane/sql/043_file_last_attached.sql control-plane/test/maintenance.test.ts
git commit -m "feat(maintenance): migration 043 — files.last_attached_at + attach trigger"
```

---

### Task 2: Rename `gc.ts` → `maintenance.ts` (mechanical)

**Files:**
- Rename: `control-plane/src/gc.ts` → `control-plane/src/maintenance.ts`
- Rename: `control-plane/test/gc.test.ts` → `control-plane/test/maintenance-unit.test.ts`
- Rename: `control-plane/test/gc-settings.test.ts` → `control-plane/test/maintenance-settings.test.ts`
- Modify: import sites — `control-plane/src/repo.ts`, `control-plane/src/agents-api.ts`, `control-plane/src/main.ts` (find all with grep)

**Interfaces:**
- Produces: module `src/maintenance.ts` exporting everything `gc.ts` did, with `DEFAULT_GC_CRON` renamed to `DEFAULT_MAINTENANCE_CRON` (same value `"0 1 * * *"`). `cronMatches`, `validateCron`, `runGc`, `GcSummary`, `GcRepo`, `startGcScheduler` keep their names for now (reworked in Task 6).

- [ ] **Step 1: Find every import site**

Run (in `control-plane/`): `rg -n "from \"\./gc|from \"\.\./src/gc" src test`
Expected: hits in `src/repo.ts`, `src/agents-api.ts`, `src/main.ts`, `test/gc.test.ts`, `test/gc-settings.test.ts`. If more appear, update those too.

- [ ] **Step 2: Rename files with git mv**

```bash
git mv control-plane/src/gc.ts control-plane/src/maintenance.ts
git mv control-plane/test/gc.test.ts control-plane/test/maintenance-unit.test.ts
git mv control-plane/test/gc-settings.test.ts control-plane/test/maintenance-settings.test.ts
```

- [ ] **Step 3: Update the module and all import sites**

In `src/maintenance.ts`: rename `DEFAULT_GC_CRON` → `DEFAULT_MAINTENANCE_CRON` (export). Update the header comment's first line to `// Maintenance runner (spec 2026-07-17): orphan sweep + retention cleanups.` Keep everything else as-is.

In each import site: change `"./gc.ts"` → `"./maintenance.ts"` (tests: `"../src/gc.ts"` → `"../src/maintenance.ts"`) and `DEFAULT_GC_CRON` → `DEFAULT_MAINTENANCE_CRON` everywhere it's referenced (repo.ts uses it in `getStorageSettings`; the two renamed test files use it in assertions/restores).

- [ ] **Step 4: Verify suite + types**

Run: `npx tsc --noEmit` then `npm test`
Expected: both green — this task is purely mechanical.

- [ ] **Step 5: Commit**

```bash
git add -A control-plane
git commit -m "refactor(maintenance): rename gc.ts to maintenance.ts (mechanical)"
```

---

### Task 3: Settings model + repo settings methods

**Files:**
- Modify: `control-plane/src/maintenance.ts` (types + default/merge/validate + `retentionMs`)
- Modify: `control-plane/src/repo.ts` (add `getMaintenanceSettings`/`putMaintenanceSettings`/`getMaintenanceLastRun`/`setMaintenanceLastRun`; do NOT remove the old storage/gc methods yet — routes still use them until Task 7)
- Test: `control-plane/test/maintenance-unit.test.ts` (pure), `control-plane/test/maintenance.test.ts` (DB)

**Interfaces:**
- Produces (from `maintenance.ts`):
  - `type RetentionUnit = "hours" | "days"`
  - `type Retention = { enabled: boolean; keep: number; unit: RetentionUnit }`
  - `type MaintenanceSettings = { cron: string; orphans: { enabled: boolean }; billing: Retention; tokens: Retention; sessions: { idle: Retention; completed: Retention }; files: { input: Retention; output: Retention } }`
  - `type MaintenanceSummary = { at: string; ms: number; sections: { orphans: { ran: boolean; rows?: number; objects?: number; bytes?: number; error?: string }; billing: { ran: boolean; rows?: number; error?: string }; tokens: { ran: boolean; rows?: number; error?: string }; sessions: { ran: boolean; idle?: number; completed?: number; error?: string }; files: { ran: boolean; input?: number; output?: number; bytes?: number; error?: string } } }`
  - `defaultMaintenanceSettings(legacyCron?: string | null): MaintenanceSettings`
  - `mergeMaintenanceSettings(base: MaintenanceSettings, raw: unknown): MaintenanceSettings` (per-field: any absent/invalid field keeps `base`'s value)
  - `validateMaintenanceSettings(raw: unknown): string | null`
  - `retentionMs(r: Retention): number`
- Produces (from `Repo`): `getMaintenanceSettings(): Promise<MaintenanceSettings>` (legacy `storage.gcCron` fallback), `putMaintenanceSettings(m)`, `getMaintenanceLastRun(): Promise<MaintenanceSummary | null>`, `setMaintenanceLastRun(s)`.

- [ ] **Step 1: Write the failing unit tests**

Append to `test/maintenance-unit.test.ts` (extend the existing import from `../src/maintenance.ts` with the new names):

```ts
import {
  defaultMaintenanceSettings, mergeMaintenanceSettings, validateMaintenanceSettings,
  retentionMs, DEFAULT_MAINTENANCE_CRON,
} from "../src/maintenance.ts";

test("defaultMaintenanceSettings: spec defaults + legacy cron fallback", () => {
  const d = defaultMaintenanceSettings();
  assert.equal(d.cron, DEFAULT_MAINTENANCE_CRON);
  assert.deepEqual(d.orphans, { enabled: true });
  assert.deepEqual(d.billing, { enabled: false, keep: 365, unit: "days" });
  assert.deepEqual(d.tokens, { enabled: false, keep: 365, unit: "days" });
  assert.deepEqual(d.sessions.idle, { enabled: false, keep: 7, unit: "days" });
  assert.deepEqual(d.sessions.completed, { enabled: false, keep: 4, unit: "hours" });
  assert.deepEqual(d.files.input, { enabled: false, keep: 4, unit: "hours" });
  assert.deepEqual(d.files.output, { enabled: false, keep: 4, unit: "hours" });
  assert.equal(defaultMaintenanceSettings("*/5 * * * *").cron, "*/5 * * * *");
});

test("mergeMaintenanceSettings: per-field merge over base", () => {
  const base = defaultMaintenanceSettings();
  const m = mergeMaintenanceSettings(base, { cron: "*/30 * * * *", billing: { enabled: true } });
  assert.equal(m.cron, "*/30 * * * *");
  assert.equal(m.billing.enabled, true);
  assert.equal(m.billing.keep, 365);          // absent field keeps base
  assert.equal(m.sessions.idle.keep, 7);      // untouched section keeps base
  const noop = mergeMaintenanceSettings(base, {});
  assert.deepEqual(noop, base);               // empty object is a no-op, not a reset
});

test("validateMaintenanceSettings rejects bad fields", () => {
  assert.equal(validateMaintenanceSettings(undefined), null);
  assert.equal(validateMaintenanceSettings({}), null);
  assert.match(validateMaintenanceSettings({ cron: "bad" })!, /cron/);
  assert.match(validateMaintenanceSettings({ billing: { keep: 0 } })!, /keep/);
  assert.match(validateMaintenanceSettings({ billing: { keep: 1.5 } })!, /keep/);
  assert.match(validateMaintenanceSettings({ files: { input: { unit: "weeks" } } })!, /unit/);
  assert.match(validateMaintenanceSettings({ tokens: { enabled: "yes" } })!, /enabled/);
  assert.match(validateMaintenanceSettings("nope")!, /object/);
});

test("retentionMs converts hours and days", () => {
  assert.equal(retentionMs({ enabled: true, keep: 4, unit: "hours" }), 14_400_000);
  assert.equal(retentionMs({ enabled: true, keep: 7, unit: "days" }), 604_800_000);
});
```

And append to `test/maintenance.test.ts`:

```ts
import { Repo } from "../src/repo.ts";
import { DEFAULT_MAINTENANCE_CRON } from "../src/maintenance.ts";

test("repo maintenance settings: legacy storage.gcCron fallback + roundtrip", { skip: !available }, async () => {
  const repo = new Repo(pool);
  try {
    await pool.query(`UPDATE app_settings SET data = (data - 'maintenance') || '{"storage":{"gcCron":"*/10 * * * *"}}'::jsonb WHERE id = 'global'`);
    const m = await repo.getMaintenanceSettings();
    assert.equal(m.cron, "*/10 * * * *");           // legacy fallback
    assert.equal(m.billing.enabled, false);          // defaults elsewhere

    const next = { ...m, cron: "0 2 * * *", tokens: { enabled: true, keep: 30, unit: "days" as const } };
    await repo.putMaintenanceSettings(next);
    assert.deepEqual(await repo.getMaintenanceSettings(), next);
  } finally {
    // restore the shared dev DB singleton
    await pool.query(`UPDATE app_settings SET data = (data - 'maintenance') - 'storage' WHERE id = 'global'`);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/maintenance-unit.test.ts test/maintenance.test.ts`
Expected: FAIL — `defaultMaintenanceSettings` etc. not exported; `repo.getMaintenanceSettings` not a function.

- [ ] **Step 3: Implement the settings model in `maintenance.ts`**

Add below the existing `GcSummary` type:

```ts
export type RetentionUnit = "hours" | "days";
export type Retention = { enabled: boolean; keep: number; unit: RetentionUnit };
export type MaintenanceSettings = {
  cron: string;
  orphans: { enabled: boolean };
  billing: Retention;
  tokens: Retention;
  sessions: { idle: Retention; completed: Retention };
  files: { input: Retention; output: Retention };
};
export type MaintenanceSummary = {
  at: string; ms: number;
  sections: {
    orphans:  { ran: boolean; rows?: number; objects?: number; bytes?: number; error?: string };
    billing:  { ran: boolean; rows?: number; error?: string };
    tokens:   { ran: boolean; rows?: number; error?: string };
    sessions: { ran: boolean; idle?: number; completed?: number; error?: string };
    files:    { ran: boolean; input?: number; output?: number; bytes?: number; error?: string };
  };
};

export function defaultMaintenanceSettings(legacyCron?: string | null): MaintenanceSettings {
  return {
    cron: typeof legacyCron === "string" && legacyCron.trim() ? legacyCron.trim() : DEFAULT_MAINTENANCE_CRON,
    orphans: { enabled: true },
    billing: { enabled: false, keep: 365, unit: "days" },
    tokens: { enabled: false, keep: 365, unit: "days" },
    sessions: {
      idle: { enabled: false, keep: 7, unit: "days" },
      completed: { enabled: false, keep: 4, unit: "hours" },
    },
    files: {
      input: { enabled: false, keep: 4, unit: "hours" },
      output: { enabled: false, keep: 4, unit: "hours" },
    },
  };
}

function mergeRetention(base: Retention, raw: any): Retention {
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : base.enabled,
    keep: Number.isInteger(raw?.keep) && raw.keep >= 1 ? raw.keep : base.keep,
    unit: raw?.unit === "hours" || raw?.unit === "days" ? raw.unit : base.unit,
  };
}

/** Per-field merge: any absent/invalid field keeps the base value, so a
 *  partial PUT body never resets sibling settings (limits/storage idiom). */
export function mergeMaintenanceSettings(base: MaintenanceSettings, raw: unknown): MaintenanceSettings {
  const m = raw as any;
  return {
    cron: typeof m?.cron === "string" && m.cron.trim() ? m.cron.trim() : base.cron,
    orphans: { enabled: typeof m?.orphans?.enabled === "boolean" ? m.orphans.enabled : base.orphans.enabled },
    billing: mergeRetention(base.billing, m?.billing),
    tokens: mergeRetention(base.tokens, m?.tokens),
    sessions: {
      idle: mergeRetention(base.sessions.idle, m?.sessions?.idle),
      completed: mergeRetention(base.sessions.completed, m?.sessions?.completed),
    },
    files: {
      input: mergeRetention(base.files.input, m?.files?.input),
      output: mergeRetention(base.files.output, m?.files?.output),
    },
  };
}

export function validateMaintenanceSettings(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null) return "maintenance must be an object";
  const m = raw as any;
  if (m.cron !== undefined) {
    if (typeof m.cron !== "string") return "maintenance.cron must be a string";
    const err = validateCron(m.cron);
    if (err) return `maintenance.cron: ${err}`;
  }
  if (m.orphans?.enabled !== undefined && typeof m.orphans.enabled !== "boolean") {
    return "maintenance.orphans.enabled must be a boolean";
  }
  const rules: [string, any][] = [
    ["billing", m.billing], ["tokens", m.tokens],
    ["sessions.idle", m.sessions?.idle], ["sessions.completed", m.sessions?.completed],
    ["files.input", m.files?.input], ["files.output", m.files?.output],
  ];
  for (const [path, r] of rules) {
    if (r === undefined) continue;
    if (r?.enabled !== undefined && typeof r.enabled !== "boolean") return `maintenance.${path}.enabled must be a boolean`;
    if (r?.keep !== undefined && !(Number.isInteger(r.keep) && r.keep >= 1)) return `maintenance.${path}.keep must be an integer >= 1`;
    if (r?.unit !== undefined && r.unit !== "hours" && r.unit !== "days") return `maintenance.${path}.unit must be hours or days`;
  }
  return null;
}

export function retentionMs(r: Retention): number {
  return r.keep * (r.unit === "hours" ? 3_600_000 : 86_400_000);
}
```

- [ ] **Step 4: Implement the repo methods**

In `src/repo.ts`, next to the existing storage/GC settings block (~line 1570), add (import `defaultMaintenanceSettings`, `mergeMaintenanceSettings`, and types `MaintenanceSettings`, `MaintenanceSummary` from `./maintenance.ts`):

```ts
// ── Maintenance settings (spec 2026-07-17) ───────────────────────────────
async getMaintenanceSettings(): Promise<MaintenanceSettings> {
  const { rows } = await this.pool.query(
    "SELECT data->'maintenance' AS m, data->'storage'->>'gcCron' AS legacy FROM app_settings WHERE id = 'global'");
  return mergeMaintenanceSettings(defaultMaintenanceSettings(rows[0]?.legacy), rows[0]?.m);
}
async putMaintenanceSettings(m: MaintenanceSettings) {
  await this.pool.query(
    `UPDATE app_settings SET data = jsonb_set(data, '{maintenance}', $1::jsonb), updated_at = now() WHERE id = 'global'`,
    [JSON.stringify(m)]);
}
async getMaintenanceLastRun(): Promise<MaintenanceSummary | null> {
  const { rows } = await this.pool.query("SELECT data->'maintenanceLastRun' AS run FROM app_settings WHERE id = 'global'");
  return rows[0]?.run ?? null;
}
async setMaintenanceLastRun(s: MaintenanceSummary) {
  await this.pool.query(
    `UPDATE app_settings SET data = jsonb_set(data, '{maintenanceLastRun}', $1::jsonb), updated_at = now() WHERE id = 'global'`,
    [JSON.stringify(s)]);
}
```

- [ ] **Step 5: Run tests to verify they pass, plus types**

Run: `npm test -- test/maintenance-unit.test.ts test/maintenance.test.ts` and `npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/maintenance.ts control-plane/src/repo.ts control-plane/test/maintenance-unit.test.ts control-plane/test/maintenance.test.ts
git commit -m "feat(maintenance): settings model (default/merge/validate) + repo methods with legacy gcCron fallback"
```

---

### Task 4: Repo retention queries (prune + list-expired)

**Files:**
- Modify: `control-plane/src/repo.ts`
- Test: `control-plane/test/maintenance.test.ts`

**Interfaces:**
- Produces (from `Repo`):
  - `pruneCostEntries(cutoffMs: number): Promise<number>` — deletes `cost_entries` older than cutoff, returns row count
  - `pruneGatewayUsage(cutoffMs: number): Promise<number>` — same for `gateway_usage`
  - `listExpiredSessions(idleCutoffMs: number | null, completedCutoffMs: number | null): Promise<{ id: string; workspace_id: string; status: string }[]>` — `null` cutoff disables that leg; only `active` workspaces
  - `listExpiredFiles(kind: "upload" | "output", cutoffMs: number): Promise<{ id: string; size: number }[]>` — zero `session_files` rows, `session_id IS NULL`, `last_attached_at` older than cutoff

- [ ] **Step 1: Write the failing tests**

Append to `test/maintenance.test.ts`:

```ts
test("pruneCostEntries/pruneGatewayUsage delete only pre-cutoff rows (3650d guard)", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const marker = `t-maint-model-${tag}`;
  try {
    await pool.query(
      `INSERT INTO cost_entries (ts, kind, seconds, deployment)
       VALUES (now() - interval '4000 days', 'pool_pod', 60, $1), (now(), 'pool_pod', 60, $1)`, [marker]);
    await pool.query(
      `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, created_at)
       VALUES ($1, $2, 1, 1, now() - interval '4000 days'), ($1, $2, 1, 1, now())`, [wsId, marker]);

    const ceDeleted = await repo.pruneCostEntries(3650 * 86_400_000);
    const guDeleted = await repo.pruneGatewayUsage(3650 * 86_400_000);
    assert.ok(ceDeleted >= 1);
    assert.ok(guDeleted >= 1);
    const ce = await pool.query("SELECT count(*)::int AS n FROM cost_entries WHERE deployment = $1", [marker]);
    const gu = await pool.query("SELECT count(*)::int AS n FROM gateway_usage WHERE model = $1", [marker]);
    assert.equal(ce.rows[0].n, 1, "fresh cost_entries row survives");
    assert.equal(gu.rows[0].n, 1, "fresh gateway_usage row survives");
  } finally {
    await pool.query("DELETE FROM cost_entries WHERE deployment = $1", [marker]);
    await pool.query("DELETE FROM gateway_usage WHERE model = $1", [marker]);
  }
});

test("listExpiredSessions honors status, age, and workspace status", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const dwsId = `t-maintd-${tag}`;
  const dAgentId = `agent_tmaintd${tag}`;
  const ids = {
    idleOld: `sesn_tmio${tag}`, idleFresh: `sesn_tmif${tag}`, failedOld: `sesn_tmfo${tag}`,
    doneOld: `sesn_tmco${tag}`, doneFresh: `sesn_tmcf${tag}`,
    running: `sesn_tmr${tag}`, queued: `sesn_tmq${tag}`, disabledWs: `sesn_tmd${tag}`,
  };
  try {
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1, $1, 'disabled') ON CONFLICT DO NOTHING", [dwsId]);
    await pool.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $1) ON CONFLICT DO NOTHING", [dAgentId, dwsId]);
    await seedSession(ids.idleOld, "idle", 10);
    await seedSession(ids.idleFresh, "idle", 1);
    await seedSession(ids.failedOld, "failed", 10);
    await seedSession(ids.doneOld, "completed", 1);      // 1 day > 4h cutoff
    await seedSession(ids.doneFresh, "completed", 0);
    await seedSession(ids.running, "running", 10);
    await seedSession(ids.queued, "queued", 10);
    await seedSession(ids.disabledWs, "idle", 10, dwsId, dAgentId);

    const got = await repo.listExpiredSessions(7 * 86_400_000, 4 * 3_600_000);
    const gotIds = new Set(got.map((s) => s.id));
    assert.ok(gotIds.has(ids.idleOld));
    assert.ok(gotIds.has(ids.failedOld));
    assert.ok(gotIds.has(ids.doneOld));
    for (const id of [ids.idleFresh, ids.doneFresh, ids.running, ids.queued, ids.disabledWs]) {
      assert.ok(!gotIds.has(id), `${id} must not be eligible`);
    }
    const row = got.find((s) => s.id === ids.idleOld)!;
    assert.equal(row.workspace_id, wsId);
    assert.equal(row.status, "idle");

    // null cutoff disables a leg
    const idleOnly = await repo.listExpiredSessions(7 * 86_400_000, null);
    assert.ok(!new Set(idleOnly.map((s) => s.id)).has(ids.doneOld));
  } finally {
    for (const id of Object.values(ids)) await pool.query("DELETE FROM sessions WHERE id = $1", [id]);
  }
});

test("listExpiredFiles: detached + aged + kind-scoped only", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const f = {
    upOld: `file_tmuo${tag}`, upFresh: `file_tmuf${tag}`, upAttached: `file_tmua${tag}`,
    outOld: `file_tmoo${tag}`, ckptOld: `file_tmck${tag}`,
  };
  const sesn = `sesn_tmfile${tag}`;
  const mkFile = (id: string, kind: string) => pool.query(
    `INSERT INTO files (id, workspace_id, name, size, sha256, kind, object_key, last_attached_at)
     VALUES ($1, $2, 't.bin', 7, 'x', $3, $1, now() - interval '10 days')`, [id, wsId, kind]);
  try {
    await seedSession(sesn, "idle", 0);
    await mkFile(f.upOld, "upload");
    await mkFile(f.upFresh, "upload");
    await pool.query("UPDATE files SET last_attached_at = now() WHERE id = $1", [f.upFresh]);
    await mkFile(f.upAttached, "upload");
    await pool.query("INSERT INTO session_files (session_id, file_id, role) VALUES ($1, $2, 'input')", [sesn, f.upAttached]);
    await pool.query("UPDATE files SET last_attached_at = now() - interval '10 days' WHERE id = $1", [f.upAttached]); // aged but attached
    await mkFile(f.outOld, "output");
    await mkFile(f.ckptOld, "checkpoint");

    const uploads = new Set((await repo.listExpiredFiles("upload", 4 * 3_600_000)).map((x) => x.id));
    assert.ok(uploads.has(f.upOld));
    assert.ok(!uploads.has(f.upFresh), "fresh upload survives");
    assert.ok(!uploads.has(f.upAttached), "attached upload survives");
    assert.ok(!uploads.has(f.outOld), "kind-scoped: outputs not in upload list");
    assert.ok(!uploads.has(f.ckptOld), "checkpoints never in file cleanup");

    const outputs = new Set((await repo.listExpiredFiles("output", 4 * 3_600_000)).map((x) => x.id));
    assert.ok(outputs.has(f.outOld));
    assert.ok(!outputs.has(f.upOld));
    const size = (await repo.listExpiredFiles("upload", 4 * 3_600_000)).find((x) => x.id === f.upOld)!.size;
    assert.equal(Number(size), 7);
  } finally {
    await pool.query("DELETE FROM sessions WHERE id = $1", [sesn]);
    for (const id of Object.values(f)) await pool.query("DELETE FROM files WHERE id = $1", [id]);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/maintenance.test.ts`
Expected: FAIL — the four methods don't exist.

- [ ] **Step 3: Implement the repo methods**

In `src/repo.ts`, below the maintenance settings block from Task 3:

```ts
// ── Maintenance retention queries (spec 2026-07-17 §3) ───────────────────
async pruneCostEntries(cutoffMs: number): Promise<number> {
  const res = await this.pool.query(
    "DELETE FROM cost_entries WHERE ts < now() - ($1 * interval '1 millisecond')", [cutoffMs]);
  return res.rowCount ?? 0;
}
async pruneGatewayUsage(cutoffMs: number): Promise<number> {
  const res = await this.pool.query(
    "DELETE FROM gateway_usage WHERE created_at < now() - ($1 * interval '1 millisecond')", [cutoffMs]);
  return res.rowCount ?? 0;
}
/** Sessions eligible for retention delete. A null cutoff disables that leg.
 *  Only active workspaces: disabled = read-only, deleting has its own
 *  drainer (workspace-delete.ts) — never race it. */
async listExpiredSessions(idleCutoffMs: number | null, completedCutoffMs: number | null):
    Promise<{ id: string; workspace_id: string; status: string }[]> {
  const { rows } = await this.pool.query(
    `SELECT s.id, s.workspace_id, s.status FROM sessions s
      JOIN workspaces w ON w.id = s.workspace_id AND w.status = 'active'
      WHERE ($1::bigint IS NOT NULL AND s.status IN ('idle','failed')
             AND COALESCE(s.updated_at, s.created_at) < now() - ($1 * interval '1 millisecond'))
         OR ($2::bigint IS NOT NULL AND s.status = 'completed'
             AND COALESCE(s.updated_at, s.created_at) < now() - ($2 * interval '1 millisecond'))`,
    [idleCutoffMs, completedCutoffMs]);
  return rows;
}
/** Files eligible for retention delete: user-facing kinds only, detached
 *  (no session_files rows AND no live producing session), last attached
 *  before the cutoff. */
async listExpiredFiles(kind: "upload" | "output", cutoffMs: number): Promise<{ id: string; size: number }[]> {
  const { rows } = await this.pool.query(
    `SELECT f.id, f.size FROM files f
      WHERE f.kind = $1
        AND f.session_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM session_files sf WHERE sf.file_id = f.id)
        AND COALESCE(f.last_attached_at, f.created_at) < now() - ($2 * interval '1 millisecond')`,
    [kind, cutoffMs]);
  return rows;
}
```

Note: seeded test files leave `session_id` NULL, matching real uploads; outputs of deleted sessions get `session_id` NULL via the FK's `ON DELETE SET NULL`.

- [ ] **Step 4: Run tests to verify they pass, plus types**

Run: `npm test -- test/maintenance.test.ts` and `npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/repo.ts control-plane/test/maintenance.test.ts
git commit -m "feat(maintenance): repo retention queries (prune billing/tokens, list expired sessions/files)"
```

---

### Task 5: `session-delete.ts` helper + route refactor

**Files:**
- Create: `control-plane/src/session-delete.ts`
- Modify: `control-plane/src/agents-api.ts` (DELETE `/v1/sessions/:id`, ~line 817)
- Modify: `control-plane/src/public-api.ts` (DELETE sessions route, ~line 567)
- Test: `control-plane/test/maintenance.test.ts`

**Interfaces:**
- Produces: `deleteSessionFully(deps: { repo: { deleteSession(workspaceId: string, id: string): Promise<string[]> }; orchestrator: { stopSession(id: string): Promise<unknown>; deleteSessionResources(id: string): Promise<unknown> }; files: FileStore }, workspaceId: string, sessionId: string): Promise<void>` — stop pod, delete k8s resources (PVC), delete DB rows, purge returned S3 keys best-effort. Task 6's runner and both DELETE routes consume it.
- The agent-delete cascade loops in both API files keep their current parallel `Promise.allSettled` shape — do NOT refactor them.

- [ ] **Step 1: Write the failing integration test**

Append to `test/maintenance.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localFileStore } from "../src/filestore.ts";
import { deleteSessionFully } from "../src/session-delete.ts";

test("deleteSessionFully: stops pod, deletes rows, purges unshared objects", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const root = mkdtempSync(join(tmpdir(), "maint-del-test-"));
  const files = localFileStore(root);
  const sesn = `sesn_tmdel${tag}`;
  const outFile = `file_tmdel${tag}`;
  const calls: string[] = [];
  const orchestrator = {
    async stopSession(id: string) { calls.push(`stop:${id}`); },
    async deleteSessionResources(id: string) { calls.push(`resources:${id}`); },
  };
  try {
    await seedSession(sesn, "idle", 10);
    const key = `${wsId}/sessions/${sesn}/${outFile}`;
    await files.put(Buffer.from("out"), key);
    await pool.query(
      `INSERT INTO files (id, workspace_id, session_id, name, size, sha256, kind, object_key)
       VALUES ($1, $2, $3, 'o.bin', 3, 'x', 'output', $4)`, [outFile, wsId, sesn, key]);
    await pool.query("INSERT INTO session_files (session_id, file_id, role) VALUES ($1, $2, 'output')", [sesn, outFile]);

    await deleteSessionFully({ repo, orchestrator, files }, wsId, sesn);

    assert.deepEqual(calls, [`stop:${sesn}`, `resources:${sesn}`]);
    const s = await pool.query("SELECT 1 FROM sessions WHERE id = $1", [sesn]);
    assert.equal(s.rows.length, 0, "session row gone");
    const fr = await pool.query("SELECT 1 FROM files WHERE id = $1", [outFile]);
    assert.equal(fr.rows.length, 0, "output file row gone");
    await assert.rejects(async () => files.get(key), "object purged");
  } finally {
    rmSync(root, { recursive: true, force: true });
    await pool.query("DELETE FROM sessions WHERE id = $1", [sesn]);
    await pool.query("DELETE FROM files WHERE id = $1", [outFile]);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/maintenance.test.ts`
Expected: FAIL — module `../src/session-delete.ts` not found.

- [ ] **Step 3: Create the helper**

Create `control-plane/src/session-delete.ts`:

```ts
// Full session teardown, shared by the DELETE routes (agents-api, public-api)
// and the maintenance runner — one definition of "delete a session".
import type { FileStore } from "./filestore.ts";

export type SessionDeleteDeps = {
  repo: { deleteSession(workspaceId: string, id: string): Promise<string[]> };
  orchestrator: {
    stopSession(id: string): Promise<unknown>;
    deleteSessionResources(id: string): Promise<unknown>;
  };
  files: FileStore;
};

export async function deleteSessionFully(deps: SessionDeleteDeps, workspaceId: string, sessionId: string): Promise<void> {
  await deps.orchestrator.stopSession(sessionId);
  await deps.orchestrator.deleteSessionResources(sessionId);
  const keys = await deps.repo.deleteSession(workspaceId, sessionId);
  for (const key of keys) { try { await deps.files.del(key); } catch { /* best effort */ } }
}
```

- [ ] **Step 4: Refactor the two DELETE routes to use it**

In `src/agents-api.ts` (~line 817), replace the body of `app.delete("/v1/sessions/:id", …)`:

```ts
app.delete("/v1/sessions/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  await deleteSessionFully({ repo, orchestrator, files }, ws(req), id);
  return reply.code(204).send();
});
```

In `src/public-api.ts` (~line 567), replace the delete body after its existing 404 pre-check:

```ts
api.delete("/sessions/:id", async (req: any, reply) => {
  const s = await repo.getSession(req.params.id, ws(req));
  if (!s) return reply.code(404).send({ error: "session not found" });
  await deleteSessionFully({ repo, orchestrator, files }, ws(req), req.params.id);
  return reply.code(204).send();
});
```

Add `import { deleteSessionFully } from "./session-delete.ts";` to both files.

- [ ] **Step 5: Run the full suite + types**

Run: `npm test` and `npx tsc --noEmit`
Expected: green — existing session-delete tests exercise the refactored routes.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/session-delete.ts control-plane/src/agents-api.ts control-plane/src/public-api.ts control-plane/test/maintenance.test.ts
git commit -m "refactor(maintenance): shared deleteSessionFully helper for routes + runner"
```

---

### Task 6: `runMaintenance` + scheduler + `main.ts` wiring

**Files:**
- Modify: `control-plane/src/maintenance.ts` (add `MaintenanceRepo`, `MaintenanceDeps`, `runMaintenance`, `startMaintenanceScheduler`; drop `setGcLastRun` from `GcRepo`/`runGc`; delete `startGcScheduler`)
- Modify: `control-plane/src/main.ts` (wire the new scheduler)
- Test: `control-plane/test/maintenance-unit.test.ts`

**Interfaces:**
- Consumes: Task 3 settings model, Task 4 repo queries, Task 5 `deleteSessionFully` (via callback).
- Produces:
  - `interface MaintenanceRepo extends GcRepo { getMaintenanceSettings(): Promise<MaintenanceSettings>; setMaintenanceLastRun(s: MaintenanceSummary): Promise<void>; pruneCostEntries(cutoffMs: number): Promise<number>; pruneGatewayUsage(cutoffMs: number): Promise<number>; listExpiredSessions(idleCutoffMs: number | null, completedCutoffMs: number | null): Promise<{ id: string; workspace_id: string; status: string }[]>; listExpiredFiles(kind: "upload" | "output", cutoffMs: number): Promise<{ id: string; size: number }[]>; }`
  - `type MaintenanceDeps = { repo: MaintenanceRepo; files: FileStore; deleteSession: (workspaceId: string, sessionId: string) => Promise<void> }`
  - `runMaintenance(deps: MaintenanceDeps, opts?: { now?: () => Date }): Promise<MaintenanceSummary>`
  - `startMaintenanceScheduler(deps: MaintenanceDeps): () => void`
  - `GcRepo` LOSES `setGcLastRun`; `runGc` no longer persists anything (the caller persists the combined summary).

- [ ] **Step 1: Write the failing unit tests**

Append to `test/maintenance-unit.test.ts` (uses `localFileStore` + tmpdir already imported at the top of this file):

```ts
import { runMaintenance, type MaintenanceSettings as MS } from "../src/maintenance.ts";

function fakeDeps(settings: MS) {
  const calls = {
    cost: [] as number[], usage: [] as number[],
    deleted: [] as string[], fileRows: [] as string[], persisted: null as any,
  };
  const root = mkdtempSync(join(tmpdir(), "maint-unit-"));
  const files = localFileStore(root);
  const deps = {
    repo: {
      async getMaintenanceSettings() { return settings; },
      async setMaintenanceLastRun(s: any) { calls.persisted = s; },
      async pruneCostEntries(ms: number) { calls.cost.push(ms); return 3; },
      async pruneGatewayUsage(ms: number) { calls.usage.push(ms); return 5; },
      async listExpiredSessions(idleMs: number | null, doneMs: number | null) {
        const out: any[] = [];
        if (idleMs !== null) out.push({ id: "sesn_i", workspace_id: "w", status: "idle" });
        if (doneMs !== null) out.push({ id: "sesn_c", workspace_id: "w", status: "completed" });
        return out;
      },
      async listExpiredFiles(kind: string) { return kind === "upload" ? [{ id: "file_i", size: 10 }] : []; },
      async deleteFileRecordById(id: string) { calls.fileRows.push(id); return null; },
      async listOrphanFileRows() { return []; },
      async objectKeyExists() { return true; },
    },
    files,
    deleteSession: async (_w: string, id: string) => { calls.deleted.push(id); },
  };
  return { deps: deps as any, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("runMaintenance: disabled sections are skipped (ran:false), orphans run by default", async () => {
  const { deps, calls, cleanup } = fakeDeps(defaultMaintenanceSettings());
  try {
    const s = await runMaintenance(deps);
    assert.equal(s.sections.billing.ran, false);
    assert.equal(s.sections.tokens.ran, false);
    assert.equal(s.sections.sessions.ran, false);
    assert.equal(s.sections.files.ran, false);
    assert.equal(s.sections.orphans.ran, true);
    assert.deepEqual(calls.cost, []);
    assert.deepEqual(calls.deleted, []);
    assert.ok(calls.persisted, "summary persisted");
  } finally { cleanup(); }
});

test("runMaintenance: enabled sections run with converted cutoffs and report counts", async () => {
  const all = defaultMaintenanceSettings();
  all.billing = { enabled: true, keep: 2, unit: "days" };
  all.tokens = { enabled: true, keep: 12, unit: "hours" };
  all.sessions.idle = { enabled: true, keep: 7, unit: "days" };
  all.sessions.completed = { enabled: true, keep: 4, unit: "hours" };
  all.files.input = { enabled: true, keep: 4, unit: "hours" };
  // files.output stays disabled → output half must stay undefined
  const { deps, calls, cleanup } = fakeDeps(all);
  try {
    const s = await runMaintenance(deps);
    assert.deepEqual(calls.cost, [2 * 86_400_000]);
    assert.deepEqual(calls.usage, [12 * 3_600_000]);
    assert.equal(s.sections.billing.rows, 3);
    assert.equal(s.sections.tokens.rows, 5);
    assert.deepEqual(calls.deleted, ["sesn_i", "sesn_c"]);
    assert.equal(s.sections.sessions.idle, 1);
    assert.equal(s.sections.sessions.completed, 1);
    assert.equal(s.sections.files.input, 1);
    assert.equal(s.sections.files.output, undefined, "disabled half stays undefined");
    assert.deepEqual(calls.fileRows, ["file_i"]);
  } finally { cleanup(); }
});

test("runMaintenance: a section error is recorded and later sections still run", async () => {
  const all = defaultMaintenanceSettings();
  all.billing = { enabled: true, keep: 1, unit: "days" };
  all.tokens = { enabled: true, keep: 1, unit: "days" };
  const { deps, calls, cleanup } = fakeDeps(all);
  deps.repo.pruneCostEntries = async () => { throw new Error("boom"); };
  try {
    const s = await runMaintenance(deps);
    assert.equal(s.sections.billing.ran, true);
    assert.match(s.sections.billing.error!, /boom/);
    assert.equal(s.sections.tokens.rows, 5, "tokens still ran");
    assert.equal(s.sections.orphans.ran, true, "orphans still ran");
    assert.ok(calls.persisted);
  } finally { cleanup(); }
});
```

Also update the existing `runGc` test in this file: remove `setGcLastRun` from its fake repo and the `lastRun` assertions (`let lastRun` / `assert.ok(lastRun)`), since `runGc` no longer persists.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/maintenance-unit.test.ts`
Expected: FAIL — `runMaintenance` not exported.

- [ ] **Step 3: Implement in `maintenance.ts`**

Remove `setGcLastRun` from `GcRepo` and delete the `await repo.setGcLastRun(summary).catch(() => {});` line in `runGc`. Delete `startGcScheduler` entirely. Add:

```ts
export interface MaintenanceRepo extends GcRepo {
  getMaintenanceSettings(): Promise<MaintenanceSettings>;
  setMaintenanceLastRun(s: MaintenanceSummary): Promise<void>;
  pruneCostEntries(cutoffMs: number): Promise<number>;
  pruneGatewayUsage(cutoffMs: number): Promise<number>;
  listExpiredSessions(idleCutoffMs: number | null, completedCutoffMs: number | null):
    Promise<{ id: string; workspace_id: string; status: string }[]>;
  listExpiredFiles(kind: "upload" | "output", cutoffMs: number): Promise<{ id: string; size: number }[]>;
}

export type MaintenanceDeps = {
  repo: MaintenanceRepo;
  files: FileStore;
  /** Full session teardown (deleteSessionFully bound to the orchestrator). */
  deleteSession: (workspaceId: string, sessionId: string) => Promise<void>;
};

/** Ordered run: billing → tokens → sessions → files → orphans. Sessions free
 *  files (session_files cascade) before file cleanup; the orphan sweep mops
 *  up last. Each section is error-isolated. */
export async function runMaintenance(deps: MaintenanceDeps, opts: { now?: () => Date } = {}): Promise<MaintenanceSummary> {
  const now = opts.now ?? (() => new Date());
  const started = now();
  const m = await deps.repo.getMaintenanceSettings();
  const sections: MaintenanceSummary["sections"] = {
    orphans: { ran: false }, billing: { ran: false }, tokens: { ran: false },
    sessions: { ran: false }, files: { ran: false },
  };
  const guard = async (sec: { ran: boolean; error?: string }, run: () => Promise<void>) => {
    sec.ran = true;
    try { await run(); } catch (err) { sec.error = String((err as Error)?.message ?? err); }
  };

  if (m.billing.enabled) await guard(sections.billing, async () => {
    sections.billing.rows = await deps.repo.pruneCostEntries(retentionMs(m.billing));
  });
  if (m.tokens.enabled) await guard(sections.tokens, async () => {
    sections.tokens.rows = await deps.repo.pruneGatewayUsage(retentionMs(m.tokens));
  });
  if (m.sessions.idle.enabled || m.sessions.completed.enabled) await guard(sections.sessions, async () => {
    const rows = await deps.repo.listExpiredSessions(
      m.sessions.idle.enabled ? retentionMs(m.sessions.idle) : null,
      m.sessions.completed.enabled ? retentionMs(m.sessions.completed) : null);
    let idle = 0, completed = 0;
    for (const s of rows) {
      await deps.deleteSession(s.workspace_id, s.id);
      if (s.status === "completed") completed++; else idle++;
    }
    sections.sessions.idle = idle;
    sections.sessions.completed = completed;
  });
  if (m.files.input.enabled || m.files.output.enabled) await guard(sections.files, async () => {
    let bytes = 0;
    for (const [kind, rule, half] of [
      ["upload", m.files.input, "input"], ["output", m.files.output, "output"],
    ] as const) {
      if (!rule.enabled) continue;
      let count = 0;
      for (const f of await deps.repo.listExpiredFiles(kind, retentionMs(rule))) {
        const key = await deps.repo.deleteFileRecordById(f.id).catch(() => null);
        count++;
        if (key) { await Promise.resolve(deps.files.del(key)).catch(() => {}); bytes += Number(f.size); }
      }
      sections.files[half] = count;
    }
    sections.files.bytes = bytes;
  });
  if (m.orphans.enabled) await guard(sections.orphans, async () => {
    const g = await runGc(deps.repo, deps.files, { now });
    sections.orphans.rows = g.rows;
    sections.orphans.objects = g.objects;
    sections.orphans.bytes = g.bytes;
  });

  const summary: MaintenanceSummary = { at: started.toISOString(), ms: now().getTime() - started.getTime(), sections };
  await deps.repo.setMaintenanceLastRun(summary).catch(() => {});
  return summary;
}

/** Minute tick against the settings cron. Returns a stop function. */
export function startMaintenanceScheduler(deps: MaintenanceDeps): () => void {
  let lastMinute = "";
  let running = false;
  const timer = setInterval(async () => {
    const now = new Date();
    const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}T${now.getHours()}:${now.getMinutes()}`;
    if (minute === lastMinute) return;
    lastMinute = minute;
    if (running) return;
    try {
      const { cron } = await deps.repo.getMaintenanceSettings();
      if (!cronMatches(cron, now)) return;
      running = true;
      const s = await runMaintenance(deps);
      console.log(`maintenance: ${JSON.stringify(s.sections)} in ${s.ms}ms`);
    } catch (err) {
      console.warn("maintenance sweep failed:", err);
    } finally {
      running = false;
    }
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
```

Note on the files section: when a rule is disabled, its half (`sections.files.input`/`output`) stays `undefined` — the console renders that half as "skipped (disabled)". Bytes are only counted for actually-deleted objects (unshared keys), mirroring `runGc`.

- [ ] **Step 4: Wire `main.ts`**

Replace `import { startGcScheduler } from "./gc.ts";` (now `"./maintenance.ts"` after Task 2) with `import { startMaintenanceScheduler } from "./maintenance.ts";`, add `import { deleteSessionFully } from "./session-delete.ts";`, and replace the `startGcScheduler(repo, files);` call (~line 202) with:

```ts
startMaintenanceScheduler({
  repo, files,
  deleteSession: (w, id) => deleteSessionFully({ repo, orchestrator, files }, w, id),
});
```

(`orchestrator` is already in scope in `main.ts` — the reconciler and `interruptChildSessions` use it.)

- [ ] **Step 5: Run tests + types — expect ONE remaining break**

Run: `npx tsc --noEmit`
Expected: errors ONLY in `src/agents-api.ts` (still imports `runGc` for `/v1/gc/run` and repo's `setGcLastRun` typing if referenced). If `agents-api.ts` compiles because `runGc`'s signature still matches, fine. Fix nothing beyond making `tsc` clean — if `/v1/gc/run`'s `runGc(repo, files)` call now type-errors (repo still satisfies `GcRepo` since `setGcLastRun` removal only shrank the interface), it should still compile. Then run `npm test`.
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/maintenance.ts control-plane/src/main.ts control-plane/test/maintenance-unit.test.ts
git commit -m "feat(maintenance): runMaintenance orchestrating ordered cleanups + scheduler wiring"
```

---

### Task 7: API surface — settings GET/PUT + `/v1/maintenance/run`

**Files:**
- Modify: `control-plane/src/agents-api.ts` (settings GET ~900, PUT ~908, `/v1/gc/run` ~954)
- Modify: `control-plane/src/repo.ts` (REMOVE `getStorageSettings`, `putStorageSettings`, `getGcLastRun`, `setGcLastRun`)
- Modify: `control-plane/test/maintenance-settings.test.ts` (rewrite to maintenance shapes)
- Modify: `control-plane/test/agents-api.test.ts` (fake repo: swap storage/gc members for maintenance ones)

**Interfaces:**
- Consumes: Task 3 model/validation, Task 5 helper, Task 6 `runMaintenance`.
- Produces: `GET /v1/settings` → `{ costs, limits, maintenance, appearance, maintenanceLastRun }`; `PUT /v1/settings` accepts `maintenance` (validate-before-persist, merge-when-provided) and no longer accepts `storage`; `POST /v1/maintenance/run` → `MaintenanceSummary`; `POST /v1/gc/run` is GONE.

- [ ] **Step 1: Rewrite `test/maintenance-settings.test.ts` (failing first)**

Replace the file's three tests (keep the bootstrap/build helper; note `build()` passes `{} as Orchestrator` — safe because default settings never enable session cleanup):

```ts
test("GET /v1/settings includes maintenance defaults", { skip: !available }, async () => {
  const { app, cleanup } = await build();
  try {
    const res = await app.inject({ method: "GET", url: "/v1/settings" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.maintenance.cron, DEFAULT_MAINTENANCE_CRON);
    assert.equal(body.maintenance.orphans.enabled, true);
    assert.deepEqual(body.maintenance.billing, { enabled: false, keep: 365, unit: "days" });
    assert.deepEqual(body.maintenance.sessions.completed, { enabled: false, keep: 4, unit: "hours" });
    assert.ok(body.maintenanceLastRun === null || typeof body.maintenanceLastRun === "object");
    assert.equal(body.storage, undefined, "legacy storage block gone");
  } finally { cleanup(); }
});

test("PUT /v1/settings validates and persists maintenance (merge-when-provided)", { skip: !available }, async () => {
  const { app, repo, cleanup } = await build();
  let originalCosts: unknown;
  try {
    const before = await app.inject({ method: "GET", url: "/v1/settings" });
    originalCosts = before.json().costs;
    const flippedCosts = { ...(originalCosts as Record<string, unknown>), enabled: !(originalCosts as { enabled: boolean }).enabled };

    // validate-before-persist: a bad maintenance block must reject BEFORE costs land
    const bad = await app.inject({
      method: "PUT", url: "/v1/settings",
      payload: { costs: flippedCosts, maintenance: { cron: "bad" } },
    });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /cron/);
    const afterBad = await app.inject({ method: "GET", url: "/v1/settings" });
    assert.deepEqual(afterBad.json().costs, originalCosts);

    const bad2 = await app.inject({
      method: "PUT", url: "/v1/settings",
      payload: { costs: {}, maintenance: { billing: { keep: 0 } } },
    });
    assert.equal(bad2.statusCode, 400);
    assert.match(bad2.json().error, /keep/);

    const ok = await app.inject({
      method: "PUT", url: "/v1/settings",
      payload: { costs: {}, maintenance: { cron: "*/30 * * * *", billing: { enabled: true, keep: 30, unit: "days" } } },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().maintenance.cron, "*/30 * * * *");
    assert.equal(ok.json().maintenance.billing.enabled, true);
    assert.equal(ok.json().maintenance.sessions.idle.keep, 7, "unsent sections keep defaults");

    // omitted block leaves stored settings untouched; empty object is a no-op
    const noBlock = await app.inject({ method: "PUT", url: "/v1/settings", payload: { costs: ok.json().costs } });
    assert.equal(noBlock.json().maintenance.cron, "*/30 * * * *");
    const emptyBlock = await app.inject({ method: "PUT", url: "/v1/settings", payload: { costs: ok.json().costs, maintenance: {} } });
    assert.equal(emptyBlock.json().maintenance.cron, "*/30 * * * *");
    assert.equal(emptyBlock.json().maintenance.billing.enabled, true);
  } finally {
    if (originalCosts) await repo.putCostSettings(originalCosts as Parameters<typeof repo.putCostSettings>[0]);
    await pool.query(`UPDATE app_settings SET data = data - 'maintenance' WHERE id = 'global'`); // restore shared dev DB
    cleanup();
  }
});

test("POST /v1/maintenance/run returns per-section summary; GET reflects maintenanceLastRun", { skip: !available }, async () => {
  const { app, cleanup } = await build();
  try {
    const res = await app.inject({ method: "POST", url: "/v1/maintenance/run" });
    assert.equal(res.statusCode, 200);
    const summary = res.json();
    assert.ok(!Number.isNaN(new Date(summary.at).getTime()));
    assert.equal(summary.sections.orphans.ran, true);        // default on
    assert.equal(Number.isInteger(summary.sections.orphans.rows), true);
    assert.equal(summary.sections.billing.ran, false);       // defaults off
    assert.equal(summary.sections.sessions.ran, false);
    assert.equal(summary.sections.files.ran, false);

    const got = await app.inject({ method: "GET", url: "/v1/settings" });
    assert.equal(got.json().maintenanceLastRun.at, summary.at);

    const gone = await app.inject({ method: "POST", url: "/v1/gc/run" });
    assert.equal(gone.statusCode, 404, "old GC endpoint removed");
  } finally { cleanup(); }
});
```

Adjust the file's imports: `DEFAULT_MAINTENANCE_CRON` from `../src/maintenance.ts`; export `pool` usage as in the existing file; DELETE the old `repo.putStorageSettings` restore line.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- test/maintenance-settings.test.ts`
Expected: FAIL — GET body has `storage`, not `maintenance`.

- [ ] **Step 3: Update `agents-api.ts`**

GET (~line 900):

```ts
app.get("/v1/settings", async () => ({
  costs: await repo.getCostSettings(),
  limits: await repo.getLimits(),
  maintenance: await repo.getMaintenanceSettings(),
  appearance: await repo.getAppearance(),
  maintenanceLastRun: await repo.getMaintenanceLastRun(),
}));
```

PUT (~line 908) — replace the `storage` handling (type, validation, persist block) with:

```ts
const b = req.body as { costs?: unknown; limits?: unknown; maintenance?: unknown; appearance?: unknown };
// … costErr / limErr unchanged …
const maintErr = validateMaintenanceSettings(b?.maintenance);
if (maintErr) return reply.code(400).send({ error: maintErr });
// … appErr, costs persist, limits persist unchanged …
// Persist maintenance only when the body carries the block (limits idiom);
// merge-when-provided: absent fields keep their stored values.
let maintenance = await repo.getMaintenanceSettings();
if (b?.maintenance !== undefined) {
  maintenance = mergeMaintenanceSettings(maintenance, b.maintenance);
  await repo.putMaintenanceSettings(maintenance);
}
// … appearance persist unchanged …
return { costs, limits, maintenance, appearance };
```

Replace the `/v1/gc/run` route (~line 954) with:

```ts
// Manual maintenance trigger (console "Run maintenance now"). Synchronous:
// bounded work, the console shows the returned per-section summary.
app.post("/v1/maintenance/run", async () => runMaintenance({
  repo, files,
  deleteSession: (w, id) => deleteSessionFully({ repo, orchestrator, files }, w, id),
}));
```

Update this file's maintenance imports to: `runMaintenance, validateCron, validateMaintenanceSettings, mergeMaintenanceSettings` from `./maintenance.ts` (drop `runGc`).

- [ ] **Step 4: Remove dead repo methods + fix the agents-api test fake**

In `src/repo.ts`: delete `getStorageSettings`, `putStorageSettings`, `getGcLastRun`, `setGcLastRun` (and the now-unused `DEFAULT_MAINTENANCE_CRON`/`GcSummary` imports if nothing else references them — check with `rg`).

In `test/agents-api.test.ts` (~line 197), replace the fake repo's storage/gc members:

```ts
_maintenance: null as any,
async getMaintenanceSettings() { return (this as any)._maintenance ?? defaultMaintenanceSettings(); },
async putMaintenanceSettings(m: any) { (this as any)._maintenance = m; },
_maintenanceLastRun: null as any,
async getMaintenanceLastRun() { return (this as any)._maintenanceLastRun; },
async setMaintenanceLastRun(s: any) { (this as any)._maintenanceLastRun = s; },
```

with `import { defaultMaintenanceSettings } from "../src/maintenance.ts";` added, and delete the old `_storage`/`_gcLastRun` members and any assertions on them (grep the file for `storage`/`gcCron`/`gcLastRun` and update each hit to the maintenance equivalent).

- [ ] **Step 5: Run the full suite + types**

Run: `npm test` and `npx tsc --noEmit`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src control-plane/test
git commit -m "feat(maintenance): settings API maintenance block + POST /v1/maintenance/run (replaces /v1/gc/run)"
```

---

### Task 8: Console — Maintenance panel

**Files:**
- Modify: `console/app/lib/icons.tsx` (add `wrench`)
- Modify: `console/app/settings/page.tsx`
- Modify: `console/app/settings/form.tsx`

**Interfaces:**
- Consumes: Task 7's API shapes.
- Produces: `form.tsx` exports `type MaintenanceSettings` and `type MaintenanceSummary` (types only — no server-callable values from this `"use client"` module); `SettingsForm` props change to `{ initial, initialLimits, initialMaintenance, initialAppearance, lastRun }`.

- [ ] **Step 1: Add the icon**

In `console/app/lib/icons.tsx`, next to `cache:` add (feather "tool" wrench):

```tsx
wrench: () => <S><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></S>,
```

- [ ] **Step 2: Update `page.tsx`**

Replace the file body with:

```tsx
import { wsGet } from "../lib/api";
import type { CostSettings } from "../lib/currency";
import { SettingsForm, type MaintenanceSettings, type MaintenanceSummary } from "./form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const s = await wsGet<{
    costs: CostSettings; limits: { maxWorkGb: number }; maintenance: MaintenanceSettings;
    appearance: { theme: string }; maintenanceLastRun: MaintenanceSummary | null;
  }>("/v1/settings").catch(() => null);
  return (
    <>
      <div className="pagehead"><h1>Settings</h1></div>
      <p className="sub">Platform-wide settings. Cost tracking and billing apply across all workspaces.</p>
      {s ? <SettingsForm initial={s.costs} initialLimits={s.limits} initialMaintenance={s.maintenance}
                         initialAppearance={s.appearance} lastRun={s.maintenanceLastRun} />
         : <div className="empty">Control plane unreachable.</div>}
    </>
  );
}
```

- [ ] **Step 3: Rework `form.tsx`**

Replace the `GcSummary` type, the `initialStorage`/`gcLastRun` props, the `gcCron`/`gcBusy`/`gcMsg` state, `runGcNow`, and the whole `Storage` `<details>` block. New pieces:

Types + helper components (top level of the file, after `Section`):

```tsx
type Unit = "hours" | "days";
export type MaintenanceSettings = {
  cron: string;
  orphans: { enabled: boolean };
  billing: { enabled: boolean; keep: number; unit: Unit };
  tokens: { enabled: boolean; keep: number; unit: Unit };
  sessions: { idle: { enabled: boolean; keep: number; unit: Unit }; completed: { enabled: boolean; keep: number; unit: Unit } };
  files: { input: { enabled: boolean; keep: number; unit: Unit }; output: { enabled: boolean; keep: number; unit: Unit } };
};
export type MaintenanceSummary = {
  at: string; ms: number;
  sections: {
    orphans: { ran: boolean; rows?: number; objects?: number; bytes?: number; error?: string };
    billing: { ran: boolean; rows?: number; error?: string };
    tokens: { ran: boolean; rows?: number; error?: string };
    sessions: { ran: boolean; idle?: number; completed?: number; error?: string };
    files: { ran: boolean; input?: number; output?: number; bytes?: number; error?: string };
  };
};

type RetentionForm = { enabled: boolean; keep: string; unit: Unit };
const toForm = (r: { enabled: boolean; keep: number; unit: Unit }): RetentionForm =>
  ({ enabled: r.enabled, keep: String(r.keep), unit: r.unit });

function RetRow({ label, hint, value, onChange }: {
  label: string; hint: string; value: RetentionForm; onChange: (v: RetentionForm) => void;
}) {
  return (
    <label className="setrow">
      <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
      <span className="setrow-name">{label}</span>
      <span className="setrow-hint" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input value={value.keep} disabled={!value.enabled} style={{ width: 70, flex: "none" }}
               onChange={(e) => onChange({ ...value, keep: e.target.value })} />
        <select value={value.unit} disabled={!value.enabled} style={{ width: 90, flex: "none" }}
                onChange={(e) => onChange({ ...value, unit: e.target.value as Unit })}>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
        {hint}
      </span>
    </label>
  );
}
```

Component state (replacing the gc pieces; props now `initialMaintenance: MaintenanceSettings; lastRun: MaintenanceSummary | null`):

```tsx
const [cron, setCron] = useState(initialMaintenance.cron);
const [orphans, setOrphans] = useState(initialMaintenance.orphans.enabled);
const [billing, setBilling] = useState(toForm(initialMaintenance.billing));
const [tokens, setTokens] = useState(toForm(initialMaintenance.tokens));
const [idleS, setIdleS] = useState(toForm(initialMaintenance.sessions.idle));
const [doneS, setDoneS] = useState(toForm(initialMaintenance.sessions.completed));
const [inFiles, setInFiles] = useState(toForm(initialMaintenance.files.input));
const [outFiles, setOutFiles] = useState(toForm(initialMaintenance.files.output));
const [runBusy, setRunBusy] = useState(false);
const [runMsg, setRunMsg] = useState<string | null>(null);
const [summary, setSummary] = useState<MaintenanceSummary | null>(lastRun);
```

`save()` gains (before `submitJson`; keep the existing maxWorkGb validation):

```tsx
const fromForm = (label: string, r: RetentionForm) => {
  const n = Math.floor(Number(r.keep));
  if (!(n >= 1)) throw new Error(`${label}: retention must be an integer ≥ 1.`);
  return { enabled: r.enabled, keep: n, unit: r.unit };
};
let maintenance: MaintenanceSettings;
try {
  maintenance = {
    cron: cron.trim(),
    orphans: { enabled: orphans },
    billing: fromForm("Billing", billing),
    tokens: fromForm("Token usage", tokens),
    sessions: { idle: fromForm("Idle sessions", idleS), completed: fromForm("Completed sessions", doneS) },
    files: { input: fromForm("Input files", inFiles), output: fromForm("Output files", outFiles) },
  };
} catch (e) { setBusy(false); setMsg((e as Error).message); return; }
```

and the payload becomes `{ costs: c, limits: { maxWorkGb: n }, maintenance, appearance: { theme } }`.

Run-now handler:

```tsx
const runNow = async () => {
  setRunBusy(true); setRunMsg(null);
  try {
    const res = await apiPost("/v1/maintenance/run", {});
    if (!res.ok) { setRunMsg(`Maintenance failed (${res.status})`); return; }
    setSummary(await res.json());
    router.refresh();
  } finally { setRunBusy(false); }
};
```

Result-line builder (top level, next to `RetRow`; move `fmtBytes` to top level too so both can use it):

```tsx
function sectionLines(s: MaintenanceSummary): [string, string][] {
  const sec = s.sections;
  const line = (x: { ran: boolean; error?: string }, ok: () => string) =>
    !x.ran ? "skipped (disabled)" : x.error ? `failed — ${x.error}` : ok();
  const half = (x: typeof sec.files, v: number | undefined, ok: (n: number) => string) =>
    !x.ran || v === undefined ? "skipped (disabled)" : x.error ? `failed — ${x.error}` : ok(v);
  return [
    ["Orphaned data", line(sec.orphans, () => `${sec.orphans.rows ?? 0} rows, ${sec.orphans.objects ?? 0} objects, ${fmtBytes(sec.orphans.bytes ?? 0)} reclaimed`)],
    ["Billing data", line(sec.billing, () => `${sec.billing.rows ?? 0} rows removed`)],
    ["Token usage", line(sec.tokens, () => `${sec.tokens.rows ?? 0} rows removed`)],
    ["Sessions", line(sec.sessions, () => `${sec.sessions.idle ?? 0} idle/failed, ${sec.sessions.completed ?? 0} completed deleted`)],
    ["Input files", half(sec.files, sec.files.input, (n) => `${n} files removed`)],
    ["Output files", half(sec.files, sec.files.output, (n) => `${n} files removed, ${fmtBytes(sec.files.bytes ?? 0)} reclaimed`)],
  ];
}
```

The accordion (replacing the `Storage` details block):

```tsx
<details className="setacc" open>
  <summary><Icon.wrench />Maintenance</summary>
  <div className="setpanel">
    <label className="setrow plain">
      <span />
      <span className="setrow-name">Maintenance schedule</span>
      <span className="setrow-hint" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input value={cron} onChange={(e) => setCron(e.target.value)}
               style={{ width: 130, flex: "none", fontFamily: "var(--mono, monospace)" }} />
        5-field cron, server local time — default 0 1 * * * (daily 1:00)
      </span>
    </label>
    <Row label="Delete orphaned data" checked={orphans}
         hint="reclaims database rows and storage objects that escaped normal deletion — dead checkpoints, unreferenced skill/memory files, unclaimed objects"
         onChange={setOrphans} />
    <RetRow label="Clean up billing data" value={billing} onChange={setBilling}
            hint="removes time-cost ledger entries older than this — cost history charts shrink accordingly" />
    <RetRow label="Clean up token usage" value={tokens} onChange={setTokens}
            hint="removes gateway token metering older than this — Usage page history shrinks; session lifetime totals survive" />
    <RetRow label="Clean up idle & failed sessions" value={idleS} onChange={setIdleS}
            hint="fully deletes sessions (events, checkpoints, work volume) with no activity for this long" />
    <RetRow label="Clean up completed sessions" value={doneS} onChange={setDoneS}
            hint="fully deletes completed sessions this long after their last activity" />
    <RetRow label="Clean up input files" value={inFiles} onChange={setInFiles}
            hint="uploads not attached to any session and last attached longer ago than this" />
    <RetRow label="Clean up output files" value={outFiles} onChange={setOutFiles}
            hint="session outputs not attached to any session and last attached longer ago than this" />
    <label className="setrow plain">
      <span />
      <span className="setrow-name">Run now</span>
      <span className="setrow-hint" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" disabled={runBusy} onClick={runNow} style={{ flex: "none" }}>
          {runBusy ? "Running…" : "Run maintenance now"}
        </button>
        {runMsg ?? (summary
          ? `Last run ${new Date(summary.at).toLocaleString()} — ${Object.values(summary.sections).some((x) => x.error) ? "completed with errors" : "completed successfully"}`
          : "never run")}
      </span>
    </label>
    {summary && sectionLines(summary).map(([label, text]) => (
      <label key={label} className="setrow plain">
        <span />
        <span className="setrow-name" style={{ fontWeight: 400 }}>{label}</span>
        <span className="setrow-hint">{text}</span>
      </label>
    ))}
  </div>
</details>
```

(The `Row` component already exists in this file; note `Row`'s existing signature is used for the orphans checkbox.)

- [ ] **Step 4: Build the console**

Run (in `console/`): `npx next build`
Expected: build succeeds, no type errors.

- [ ] **Step 5: Commit**

```bash
git add console/app/lib/icons.tsx console/app/settings/page.tsx console/app/settings/form.tsx
git commit -m "feat(maintenance): console Maintenance panel (renamed Storage) with retention controls + per-section results"
```

---

### Task 9: Docs + live verification

**Files:**
- Modify: `CLAUDE.md` (repo root — the Files bullet's GC sentence)
- Verify: full suite, tsc, console build, live cluster flow

- [ ] **Step 1: Update `CLAUDE.md`**

In the **Files** bullet, replace the GC sentence (`Safety net: GC sweep (src/gc.ts, cron in app_settings storage.gcCron, console /settings Storage panel + POST /v1/gc/run) reclaims orphan rows/objects with a 1h grace window; upload/output kinds are never GC'd.`) with:

```
Safety net: maintenance sweep (`src/maintenance.ts`, cron in app_settings `maintenance.cron` — legacy `storage.gcCron` honored as fallback, console /settings Maintenance panel + `POST /v1/maintenance/run`) runs ordered cleanups billing→tokens→sessions→files→orphans (spec 2026-07-17-maintenance-design.md): retention prunes of `cost_entries`/`gateway_usage`, full deletes of aged idle/failed/completed sessions (active workspaces only, via shared `deleteSessionFully` in `src/session-delete.ts`), retention deletes of detached upload/output files on `files.last_attached_at` (migration 043: default now(), bumped by the session_files attach trigger), then the orphan sweep (1h grace). All new cleanups default OFF; orphans stays ON. upload/output kinds are still never touched by the ORPHAN sweep — only by the opt-in file cleanup.
```

- [ ] **Step 2: Full backend verification**

Run (in `control-plane/`): `npm test` then `npx tsc --noEmit`
Expected: suite green, tsc clean.

- [ ] **Step 3: Live verification against the cluster**

1. Restart the control plane (`npx tsx src/main.ts` with the usual env from CLAUDE.md) and the console (`npx next build && npx next start -p 7090` — build already done in Task 8).
2. Open `/settings`: the Maintenance accordion renders with the wrench icon, schedule field, 7 checkboxes, retention controls disabled until checked.
3. Save with a changed retention (e.g. tokens 30 days enabled) → reload → value persisted. Then disable it again and save.
4. Click "Run maintenance now" → per-section lines appear (`Orphaned data — N rows, …`, others "skipped (disabled)"); reload the page → "Last run …" and the same lines persist (from `maintenanceLastRun`).
5. Confirm all console pages still 200 (`/`, `/sessions`, `/settings`, `/deployments`, `/routings`, `/usage`).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: maintenance feature — CLAUDE.md notes (storage/GC bullet superseded)"
```

---

## Self-Review Notes (resolved during planning)

- **Shared-dev-DB safety** is a global constraint because prune tests genuinely DELETE across the whole table — the ≥3650-day cutoff rule makes that harmless. Do not "simplify" a test to a small cutoff.
- **`runGc` keeps its name/shape** (minus persistence) as the orphans task — `maintenance-unit.test.ts`'s existing orphan test still covers it.
- **`files.session_id IS NULL`** in `listExpiredFiles` is defense-in-depth on top of the `session_files` NOT EXISTS — both must hold.
- **Merge-when-provided** on PUT replaces the old per-field `gcCron` guard; the empty-object-no-op test pins it (same trap the old storage test pinned).
- The old `/v1/gc/run` returns 404 after Task 7 — the maintenance-settings test asserts this so external callers fail loudly, matching the spec's "endpoint rename" (no alias).
