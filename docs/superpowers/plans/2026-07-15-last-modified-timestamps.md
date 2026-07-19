# Last-Modified Timestamps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the console's "Created" column with a real last-modified time on the six resources whose rows can change, and surface it in the detail-page crumbs.

**Architecture:** One new migration (`sql/035_updated_at.sql`) adds an `updated_at` column to six tables, backfills it from the best signal available, and installs statement-level transition-table triggers that touch a parent row when its children change. Write paths that mutate a row directly bump the column in `repo.ts`. The console reads the new field; almost every query already selects it via `SELECT *`.

**Tech Stack:** Postgres (plpgsql triggers), Node/TypeScript (Fastify, `pg`), Next.js console. Tests: `node:test` integration tests against the live dev Postgres.

**Spec:** `docs/superpowers/specs/2026-07-15-last-modified-timestamps-design.md` (commit `8e56ee5`).

## Global Constraints

- **Branch:** `feat/last-modified-timestamps` (already exists, spec committed).
- **`migrate()` re-runs EVERY sql file on every boot.** There is no tracking table. Every backfill MUST be guarded `WHERE updated_at IS NULL` or each restart resets every row to boot time.
- **Migration column order is mandatory:** add nullable → guarded backfill → `SET DEFAULT now()` → `SET NOT NULL`. `ADD COLUMN ... NOT NULL` without a default fails on a non-empty table.
- **Never touch the migration 027 `gateway_usage` trigger.** It is the sole writer of `sessions.tokens_in/out`. Token ticks must NOT move `sessions.updated_at`.
- **Files are excluded.** No `updated_at` on `files`. They are immutable.
- **`npm test` keeps `--test-concurrency=1`.** Do not remove it. The 44 test files share one dev database; parallel runs deadlock on migration DDL.
- **Test command:** `cd control-plane && npm test`. Single file: `node --import tsx --test test/updated-at.test.ts`.
- **Console builds are production builds:** `cd console && npx next build && npx next start -p 7090`. Dev mode is too slow.
- **CRLF repo gotcha:** when deleting whole lines with Edit, a leading-`\n` in `old_string` joins adjacent lines. Re-check `git diff` after any line deletion.
- Copy strings verbatim: table headers are exactly `Updated`, `Last activity`, `Created`. Crumb suffixes are exactly `· updated `, `· last activity `, `· created `.

## File Structure

**Create:**
- `control-plane/sql/035_updated_at.sql` — columns, guarded backfill, triggers. All schema work in one file.
- `control-plane/test/updated-at.test.ts` — every test in this plan. One file: they share the live-Postgres skip guard and all concern one feature.

**Modify:**
- `control-plane/src/repo.ts` — 6 write-path bumps + 1 SELECT list.
- `control-plane/src/agents-api.ts` — add `GET /v1/memory-stores/:id`.
- `console/app/{agents,skills,environments,vaults,memory-stores,sessions}/page.tsx` — table headers.
- `console/app/agents/[id]/tabs.tsx` — sessions table header.
- `console/app/{agents,sessions,vaults,skills,memory-stores,files}/[id]/page.tsx` — crumbs.
- `CLAUDE.md` — the `last_activity` naming-collision note.

**Spec delta (approved deviation):** the spec says the memory-stores crumb "needs a new fetch" but assumed an endpoint existed. It does not — there is no `GET /v1/memory-stores/:id`, only `/tree`, `/content`, `/entries`, and the list. Task 4 adds it, modelled on `GET /v1/vaults/:id` (`agents-api.ts:445`).

---

### Task 1: Migration — columns and guarded backfill

**Files:**
- Create: `control-plane/sql/035_updated_at.sql`
- Create: `control-plane/test/updated-at.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: an `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()` column on `agents`, `skills`, `sessions`, `environments`, `vaults`, `memory_stores`. Every later task depends on this column existing.

- [ ] **Step 1: Write the failing tests**

Create `control-plane/test/updated-at.test.ts`:

```ts
// Migration 035: updated_at columns, guarded backfill, and the child->parent
// touch triggers. Integration tests against the live dev Postgres; self-skip
// when unreachable (same pattern as session-usage-trigger.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";

const pool = createPool();
let available = true;
try {
  await pool.query("SELECT 1");
  await migrate(pool);
} catch {
  available = false;
}

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const stampOf = async (table: string, id: string) => {
  const { rows } = await pool.query(`SELECT updated_at FROM ${table} WHERE id = $1`, [id]);
  return rows[0].updated_at as Date;
};

test("every mutable table has updated_at NOT NULL; files does not", { skip: !available }, async () => {
  const { rows } = await pool.query(
    `SELECT table_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'updated_at'
        AND table_name IN ('agents','skills','sessions','environments','vaults','memory_stores','files')
      ORDER BY table_name`);
  const got = Object.fromEntries(rows.map((r: any) => [r.table_name, r.is_nullable]));
  for (const t of ["agents", "skills", "sessions", "environments", "vaults", "memory_stores"]) {
    assert.equal(got[t], "NO", `${t}.updated_at must exist and be NOT NULL`);
  }
  assert.equal(got.files, undefined, "files must NOT get updated_at — files are immutable");
});

test("backfill survives migrate() re-runs (the every-boot guard)", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-upd-${uniq()}`)).id;
  const agent = await repo.createAgent(ws, `t-upd-${uniq()}`, { model: "qwen05b-dp", tools: [] });

  // Pin to a known past value, then re-run every migration file twice.
  const pinned = new Date(Date.now() - 86_400_000);
  await pool.query("UPDATE agents SET updated_at = $2 WHERE id = $1", [agent.id, pinned]);
  await migrate(pool);
  await migrate(pool);

  assert.equal(+(await stampOf("agents", agent.id)), +pinned,
    "migrate() re-run stomped updated_at — the WHERE updated_at IS NULL guard is missing");
});

test("backfill seeds from the child signal, not now()", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-seed-${uniq()}`)).id;
  const agent = await repo.createAgent(ws, `t-seed-${uniq()}`, { model: "qwen05b-dp", tools: [] });

  // Age the agent 10 days and its only version 3 days.
  const tenDays = new Date(Date.now() - 10 * 86_400_000);
  const threeDays = new Date(Date.now() - 3 * 86_400_000);
  await pool.query("UPDATE agents SET created_at = $2 WHERE id = $1", [agent.id, tenDays]);
  await pool.query("UPDATE agent_versions SET created_at = $2 WHERE agent_id = $1", [agent.id, threeDays]);

  // Force this row back through the backfill. migrate() restores NOT NULL at the end.
  await pool.query("ALTER TABLE agents ALTER COLUMN updated_at DROP NOT NULL");
  await pool.query("UPDATE agents SET updated_at = NULL WHERE id = $1", [agent.id]);
  await migrate(pool);

  const got = await stampOf("agents", agent.id);
  assert.equal(+got, +threeDays, "expected GREATEST(created_at, max(version.created_at)), got something else");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd control-plane && node --import tsx --test test/updated-at.test.ts`
Expected: FAIL — `column "updated_at" does not exist`, and the first test fails on `got[t] === undefined`.

`sql/035_updated_at.sql` must NOT exist yet. `migrate()` runs at test import, so the moment the file exists these tests go green — writing it first would mean never seeing red.

- [ ] **Step 3: Write the migration**

Create `control-plane/sql/035_updated_at.sql`:

```sql
-- Last-modified timestamps for the six mutable resources (spec 2026-07-15).
--
-- `files` is excluded on purpose: files are immutable (no UPDATE path exists in
-- the control plane; sha256 and object_key are stamped at insert), so an
-- updated_at would equal created_at on every row forever.
--
-- migrate() re-runs EVERY sql file on every boot (no tracking table). The
-- `WHERE updated_at IS NULL` guards below are load-bearing: without them each
-- restart would reset every row to boot time.
--
-- Order per table: add nullable -> guarded backfill -> SET DEFAULT -> SET NOT
-- NULL. `ADD COLUMN ... NOT NULL` without a default fails on a non-empty
-- table; `SET NOT NULL` short-circuits when already set, so re-runs are free.

ALTER TABLE agents        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE skills        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE sessions      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE environments  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE vaults        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE memory_stores ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Backfill from the best signal available, never now().
UPDATE agents a SET updated_at = GREATEST(a.created_at, COALESCE(
         (SELECT max(v.created_at) FROM agent_versions v WHERE v.agent_id = a.id),
         a.created_at))
 WHERE a.updated_at IS NULL;

UPDATE vaults v SET updated_at = GREATEST(v.created_at, COALESCE(
         (SELECT max(c.created_at) FROM vault_credentials c WHERE c.vault_id = v.id),
         v.created_at))
 WHERE v.updated_at IS NULL;

UPDATE memory_stores m SET updated_at = GREATEST(m.created_at, COALESCE(
         (SELECT max(e.updated_at) FROM memory_entries e WHERE e.store_id = m.id),
         m.created_at))
 WHERE m.updated_at IS NULL;

UPDATE sessions s SET updated_at = GREATEST(s.created_at, COALESCE(s.completed_at, s.created_at))
 WHERE s.updated_at IS NULL;

-- skills.created_at has been the modify time all along (createSkill's UPDATE
-- stomped it, repo.ts:866) — it is the best seed available.
UPDATE skills       SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE environments SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE agents        ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE skills        ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE sessions      ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE environments  ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE vaults        ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE memory_stores ALTER COLUMN updated_at SET DEFAULT now();

ALTER TABLE agents        ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE skills        ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE sessions      ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE environments  ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE vaults        ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE memory_stores ALTER COLUMN updated_at SET NOT NULL;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd control-plane && node --import tsx --test test/updated-at.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Verify the guard by hand**

Run: `cd control-plane && node --import tsx --test test/updated-at.test.ts` a second time.
Expected: PASS again. A backfill missing its `WHERE updated_at IS NULL` guard passes once and fails on re-run.

- [ ] **Step 6: Commit**

```bash
git add control-plane/sql/035_updated_at.sql control-plane/test/updated-at.test.ts
git commit -m "feat(db): add guarded updated_at columns to the six mutable tables

Backfilled from the best signal available (child rows where they exist),
never now(). The WHERE updated_at IS NULL guards are load-bearing: migrate()
re-runs every sql file on each boot, so an unguarded backfill would reset
every row to boot time on every restart.

Files is excluded on purpose — it is immutable."
```

---

### Task 2: Migration — statement-level touch triggers

**Files:**
- Modify: `control-plane/sql/035_updated_at.sql` (append)
- Modify: `control-plane/test/updated-at.test.ts` (append)

**Interfaces:**
- Consumes: the `updated_at` columns from Task 1.
- Produces: `touch_memory_store_new()`, `touch_memory_store_old()`, `touch_vault_new()`, `touch_vault_old()`, `touch_agent_new()` — plpgsql trigger functions returning `NULL` (AFTER STATEMENT). No TypeScript surface.

- [ ] **Step 1: Write the failing tests**

Append to `control-plane/test/updated-at.test.ts`:

```ts
const fid = () => `file_${Math.random().toString(36).slice(2, 14).padEnd(12, "0")}`;

async function memFixture(repo: Repo) {
  const ws = (await repo.createWorkspace(`t-mem-${uniq()}`)).id;
  const store = await repo.createMemoryStore(ws, `store-${uniq()}`);
  const f = fid();
  await repo.createFileRecord({
    id: f, name: "notes.md", size: 1, sha256: "x",
    objectKey: `${ws}/memory/${store.id}/notes.md`, kind: "memory", workspaceId: ws,
  });
  return { ws, store, f };
}

test("memory_entries insert/update/delete each bump memory_stores.updated_at", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const { store, f, ws } = await memFixture(repo);

  const t0 = await stampOf("memory_stores", store.id);
  await repo.upsertMemoryEntries(store.id, [{ path: "notes.md", fileId: f }]);
  const t1 = await stampOf("memory_stores", store.id);
  assert.ok(+t1 > +t0, "insert must bump the store");

  // A different file id at the same path => real UPDATE.
  const f2 = fid();
  await repo.createFileRecord({
    id: f2, name: "notes.md", size: 2, sha256: "y",
    objectKey: `${ws}/memory/${store.id}/notes.md`, kind: "memory", workspaceId: ws,
  });
  await repo.upsertMemoryEntries(store.id, [{ path: "notes.md", fileId: f2 }]);
  const t2 = await stampOf("memory_stores", store.id);
  assert.ok(+t2 > +t1, "update must bump the store");

  await pool.query("DELETE FROM memory_entries WHERE store_id = $1 AND path = 'notes.md'", [store.id]);
  const t3 = await stampOf("memory_stores", store.id);
  assert.ok(+t3 > +t2, "delete must bump the store — this is what a derived max() would miss");
});

test("no-op memory upsert (same file_id) does not bump the store", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const { store, f } = await memFixture(repo);
  await repo.upsertMemoryEntries(store.id, [{ path: "notes.md", fileId: f }]);
  const t0 = await stampOf("memory_stores", store.id);

  // upsertMemoryEntries guards its ON CONFLICT with `WHERE file_id <> EXCLUDED.file_id`
  // (repo.ts:833), so re-syncing identical content writes nothing at all.
  await repo.upsertMemoryEntries(store.id, [{ path: "notes.md", fileId: f }]);
  assert.equal(+(await stampOf("memory_stores", store.id)), +t0, "a no-op re-sync must not bump");
});

test("cascade delete of a store with entries raises no error", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const { store, f } = await memFixture(repo);
  await repo.upsertMemoryEntries(store.id, [{ path: "notes.md", fileId: f }]);
  await pool.query("DELETE FROM memory_stores WHERE id = $1", [store.id]);
  const { rows } = await pool.query("SELECT count(*)::int n FROM memory_entries WHERE store_id = $1", [store.id]);
  assert.equal(rows[0].n, 0);
});

test("vault_credentials add/rotate/remove bump vaults.updated_at", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-vlt-${uniq()}`)).id;
  const vault = await repo.createVault(ws, `vault-${uniq()}`);

  const t0 = await stampOf("vaults", vault.id);
  await repo.addVaultCredential(vault.id, "API_KEY");
  const t1 = await stampOf("vaults", vault.id);
  assert.ok(+t1 > +t0, "add must bump the vault");

  await repo.addVaultCredential(vault.id, "API_KEY"); // same name => rotate (ON CONFLICT DO UPDATE)
  const t2 = await stampOf("vaults", vault.id);
  assert.ok(+t2 > +t1, "rotate must bump the vault");

  await repo.removeVaultCredential(vault.id, "API_KEY");
  const t3 = await stampOf("vaults", vault.id);
  assert.ok(+t3 > +t2, "remove must bump the vault");
});

test("a new agent version bumps agents.updated_at", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-ver-${uniq()}`)).id;
  const agent = await repo.createAgent(ws, `t-ver-${uniq()}`, { model: "qwen05b-dp", tools: [] });

  await pool.query("UPDATE agents SET updated_at = now() - interval '1 day' WHERE id = $1", [agent.id]);
  const t0 = await stampOf("agents", agent.id);
  await repo.newAgentVersion(ws, agent.id, { model: "qwen05b-dp", tools: [], systemPrompt: "v2" });
  assert.ok(+(await stampOf("agents", agent.id)) > +t0, "a version save must bump the agent");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd control-plane && node --import tsx --test test/updated-at.test.ts`
Expected: FAIL — the bump assertions fail ("insert must bump the store") because no trigger exists yet. The cascade and no-op tests may pass trivially.

Do not append the triggers before seeing this. `migrate()` runs at test import, so the moment they exist the bump assertions go green and prove nothing.

- [ ] **Step 3: Append the triggers to the migration**

Append to `control-plane/sql/035_updated_at.sql`:

```sql
-- Child-driven touches: a vault's "update" is a credential being added/rotated/
-- removed; a memory store's is a session writing an entry; an agent's is a new
-- version row. Triggers cannot drift when a future write path forgets, and they
-- catch DELETE — which a derived max() over child rows cannot see at all.
--
-- STATEMENT-level with transition tables, NOT row-level. Row-level fires once
-- per child, turning a bulk write into N sequential UPDATEs of the SAME parent
-- row. Measured on 2000 children: row-level insert 115ms / delete 56ms / parent
-- heap 168kB, vs statement-level 38ms / 3ms / 8kB (baseline 35ms / 3ms / 8kB).
-- memory_entries is written by every session every turn and bulk-deleted by
-- store-delete and the GC sweep, so that churn would be continuous autovacuum
-- pressure on a small hot table.
--
-- Transition tables force one trigger per event: NEW TABLE is invalid for
-- DELETE, OLD TABLE for INSERT. Hence the _new/_old function pairs.
--
-- On cascade delete the parent row is already gone when the child trigger
-- fires, so the touch matches zero rows — verified, no error.

CREATE OR REPLACE FUNCTION touch_memory_store_new() RETURNS TRIGGER AS $$
BEGIN
  UPDATE memory_stores s SET updated_at = now() WHERE s.id IN (SELECT store_id FROM newtab);
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION touch_memory_store_old() RETURNS TRIGGER AS $$
BEGIN
  UPDATE memory_stores s SET updated_at = now() WHERE s.id IN (SELECT store_id FROM oldtab);
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_memory_store_ins ON memory_entries;
CREATE TRIGGER trg_touch_memory_store_ins AFTER INSERT ON memory_entries
  REFERENCING NEW TABLE AS newtab
  FOR EACH STATEMENT EXECUTE FUNCTION touch_memory_store_new();

DROP TRIGGER IF EXISTS trg_touch_memory_store_upd ON memory_entries;
CREATE TRIGGER trg_touch_memory_store_upd AFTER UPDATE ON memory_entries
  REFERENCING NEW TABLE AS newtab
  FOR EACH STATEMENT EXECUTE FUNCTION touch_memory_store_new();

DROP TRIGGER IF EXISTS trg_touch_memory_store_del ON memory_entries;
CREATE TRIGGER trg_touch_memory_store_del AFTER DELETE ON memory_entries
  REFERENCING OLD TABLE AS oldtab
  FOR EACH STATEMENT EXECUTE FUNCTION touch_memory_store_old();

CREATE OR REPLACE FUNCTION touch_vault_new() RETURNS TRIGGER AS $$
BEGIN
  UPDATE vaults v SET updated_at = now() WHERE v.id IN (SELECT vault_id FROM newtab);
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION touch_vault_old() RETURNS TRIGGER AS $$
BEGIN
  UPDATE vaults v SET updated_at = now() WHERE v.id IN (SELECT vault_id FROM oldtab);
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_vault_ins ON vault_credentials;
CREATE TRIGGER trg_touch_vault_ins AFTER INSERT ON vault_credentials
  REFERENCING NEW TABLE AS newtab
  FOR EACH STATEMENT EXECUTE FUNCTION touch_vault_new();

DROP TRIGGER IF EXISTS trg_touch_vault_upd ON vault_credentials;
CREATE TRIGGER trg_touch_vault_upd AFTER UPDATE ON vault_credentials
  REFERENCING NEW TABLE AS newtab
  FOR EACH STATEMENT EXECUTE FUNCTION touch_vault_new();

DROP TRIGGER IF EXISTS trg_touch_vault_del ON vault_credentials;
CREATE TRIGGER trg_touch_vault_del AFTER DELETE ON vault_credentials
  REFERENCING OLD TABLE AS oldtab
  FOR EACH STATEMENT EXECUTE FUNCTION touch_vault_old();

-- agent_versions rows are append-only: each save is a new row, and they are
-- only removed by the agents cascade. INSERT is the only event that matters.
CREATE OR REPLACE FUNCTION touch_agent_new() RETURNS TRIGGER AS $$
BEGIN
  UPDATE agents a SET updated_at = now() WHERE a.id IN (SELECT agent_id FROM newtab);
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_agent_ins ON agent_versions;
CREATE TRIGGER trg_touch_agent_ins AFTER INSERT ON agent_versions
  REFERENCING NEW TABLE AS newtab
  FOR EACH STATEMENT EXECUTE FUNCTION touch_agent_new();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd control-plane && node --import tsx --test test/updated-at.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Confirm the triggers are statement-level**

Run:
```bash
cd control-plane && node --import tsx -e "
import { createPool } from './src/db.ts';
const p = createPool();
const { rows } = await p.query(\`SELECT tgname, tgtype FROM pg_trigger WHERE tgname LIKE 'trg_touch_%' ORDER BY tgname\`);
// tgtype bit 0 (value 1) = ROW-level. It must be 0 on every one of these.
for (const r of rows) console.log(r.tgname, (r.tgtype & 1) ? 'ROW <-- WRONG' : 'STATEMENT');
await p.end();
"
```
Expected: seven triggers, every one printing `STATEMENT`.

- [ ] **Step 6: Commit**

```bash
git add control-plane/sql/035_updated_at.sql control-plane/test/updated-at.test.ts
git commit -m "feat(db): touch parent updated_at from child writes via statement triggers

memory_entries -> memory_stores, vault_credentials -> vaults, agent_versions
-> agents. Statement-level with transition tables rather than row-level:
row-level fires once per child, so a bulk write becomes N sequential UPDATEs
of the same parent row (measured 3-18x slower, 21x parent heap bloat on 2000
rows). Triggers also catch DELETE, which a derived max() cannot see."
```

---

### Task 3: repo.ts — write-path bumps and the listAgents SELECT

**Files:**
- Modify: `control-plane/src/repo.ts:159` (listAgents SELECT), `:179` (setAgentStatus), `:188` (renameAgent), `:264` + `:299` + `:320` (session status), `:866` (createSkill), `:996` (updateEnvironment)
- Modify: `control-plane/test/updated-at.test.ts` (append)

**Interfaces:**
- Consumes: the `updated_at` columns from Task 1.
- Produces: `listAgents(workspaceId, limit?, offset?)` rows now carry `updated_at: Date`. All other signatures unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `control-plane/test/updated-at.test.ts`:

```ts
test("agent status toggle and rename bump updated_at", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-ag-${uniq()}`)).id;
  const agent = await repo.createAgent(ws, `t-ag-${uniq()}`, { model: "qwen05b-dp", tools: [] });

  await pool.query("UPDATE agents SET updated_at = now() - interval '1 day' WHERE id = $1", [agent.id]);
  const t0 = await stampOf("agents", agent.id);
  await repo.setAgentStatus(ws, agent.id, "disabled");
  const t1 = await stampOf("agents", agent.id);
  assert.ok(+t1 > +t0, "status toggle must bump");

  await repo.renameAgent(ws, agent.id, `renamed-${uniq()}`);
  assert.ok(+(await stampOf("agents", agent.id)) > +t1, "rename must bump");
});

test("listAgents returns updated_at", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-la-${uniq()}`)).id;
  await repo.createAgent(ws, `t-la-${uniq()}`, { model: "qwen05b-dp", tools: [] });
  const { rows } = await repo.listAgents(ws);
  assert.ok(rows[0].updated_at instanceof Date, "listAgents must select updated_at — its SELECT is an explicit list");
});

test("updateEnvironment bumps updated_at", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-env-${uniq()}`)).id;
  const env = await repo.createEnvironment(ws, `env-${uniq()}`);

  await pool.query("UPDATE environments SET updated_at = now() - interval '1 day' WHERE id = $1", [env.id]);
  const t0 = await stampOf("environments", env.id);
  await repo.updateEnvironment(ws, env.id, { name: `env-${uniq()}` });
  assert.ok(+(await stampOf("environments", env.id)) > +t0, "env edit must bump");
});

test("re-uploading a skill bumps updated_at and leaves created_at alone", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-sk-${uniq()}`)).id;
  const name = `skill-${uniq()}`;
  const a = fid(), b = fid();
  await repo.createFileRecord({ id: a, name: "SKILL.md", size: 1, sha256: "x", objectKey: `${ws}/skills/${name}/a`, kind: "skill", workspaceId: ws });
  await repo.createFileRecord({ id: b, name: "SKILL.md", size: 2, sha256: "y", objectKey: `${ws}/skills/${name}/b`, kind: "skill", workspaceId: ws });

  const created = await repo.createSkill(ws, name, [{ path: "SKILL.md", fileId: a }]);
  const before = await pool.query("SELECT created_at, updated_at FROM skills WHERE id = $1", [created.id]);

  await repo.createSkill(ws, name, [{ path: "SKILL.md", fileId: b }]); // same name => version bump in place
  const after = await pool.query("SELECT created_at, updated_at FROM skills WHERE id = $1", [created.id]);

  assert.equal(+after.rows[0].created_at, +before.rows[0].created_at,
    "the skills UPDATE must no longer stomp created_at");
  assert.ok(+after.rows[0].updated_at > +before.rows[0].updated_at, "re-upload must bump updated_at");
});

test("session status flips bump updated_at; a token tick does NOT", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-ses-${uniq()}`)).id;
  const agent = await repo.createAgent(ws, `t-ses-${uniq()}`, { model: "qwen05b-dp", tools: [] });
  const session = await repo.createSession(ws, agent.id, "hello");

  await pool.query("UPDATE sessions SET updated_at = now() - interval '1 day' WHERE id = $1", [session.id]);
  const t0 = await stampOf("sessions", session.id);
  await repo.setSessionStatus(session.id, "idle");
  const t1 = await stampOf("sessions", session.id);
  assert.ok(+t1 > +t0, "a status flip must bump");

  // The migration 027 trigger is the sole writer of tokens_in/out and must not
  // touch updated_at — "Last activity" is status-only by design.
  await pool.query(
    `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, source, session_id)
     VALUES ($1, 'qwen05b-dp', 1000, 50, 'session', $2)`, [ws, session.id]);
  const s = await repo.getSession(session.id);
  assert.equal(Number(s.tokens_in), 1000, "the 027 trigger must still accumulate tokens");
  assert.equal(+(await stampOf("sessions", session.id)), +t1, "a token tick must NOT move Last activity");
});
```

Note: `setSessionStatus(sessionId, status, extras?, reportedTurn?)` is at `repo.ts:279` and wraps the `UPDATE sessions SET status = $2` at `:299`. `status` is typed `"completed" | "failed" | "running" | "idle"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd control-plane && node --import tsx --test test/updated-at.test.ts`
Expected: FAIL — "status toggle must bump", "listAgents must select updated_at", "env edit must bump", "the skills UPDATE must no longer stomp created_at", "a status flip must bump".

- [ ] **Step 3: Add `updated_at` to the listAgents SELECT**

In `control-plane/src/repo.ts:159`, change:

```ts
      `SELECT a.id, a.name, a.status, a.created_at, v.version, v.model
```
to:
```ts
      `SELECT a.id, a.name, a.status, a.created_at, a.updated_at, v.version, v.model
```

This is the only SELECT in the codebase that needs it. Everything else reads `SELECT *` / `m.*` / `s.*` and the route handlers pass repo rows through unfiltered. Do NOT touch `repo.ts:173` (`getAgent`) — it also has an explicit list, but it is consumed only by `session-actions.ts:66,122` for the disabled-check and is never rendered.

- [ ] **Step 4: Bump the agent write paths**

`control-plane/src/repo.ts:179`, in `setAgentStatus`:
```ts
      "UPDATE agents SET status = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2", [id, workspaceId, status]);
```

`control-plane/src/repo.ts:188`, in `renameAgent`:
```ts
        "UPDATE agents SET name = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2", [id, workspaceId, name]);
```

- [ ] **Step 5: Bump the session status paths**

`control-plane/src/repo.ts:264` (inside `appendEvents`) — the `AND status = 'queued'` means this fires only on the real transition, never per event:
```ts
          "UPDATE sessions SET status = 'running', updated_at = now() WHERE id = $1 AND status = 'queued'",
```

`control-plane/src/repo.ts:299`:
```ts
      `UPDATE sessions SET status = $2,
         sdk_session_id = COALESCE($3, sdk_session_id),
         checkpoint_file_id = COALESCE($4, checkpoint_file_id),
         completed_at = CASE WHEN $2 IN ('completed','failed','idle') THEN now() ELSE completed_at END,
         updated_at = now()
       WHERE id = $1 AND ($5::int IS NULL OR turns <= $5::int)`,
```

`control-plane/src/repo.ts:320` (inside `startTurn`):
```ts
      "UPDATE sessions SET turns = turns + 1, status = 'queued', updated_at = now() WHERE id = $1 RETURNING turns",
```

Do NOT add `updated_at` to `repo.ts:1451` (`billed_cost`) or to the migration 027 trigger.

- [ ] **Step 6: Fix the skills stomp**

`control-plane/src/repo.ts:866` — replace `created_at = now()` with `updated_at = now()`:
```ts
        "UPDATE skills SET file_id = $3, files = $4, version = $5, updated_at = now() WHERE id = $1 AND workspace_id = $2",
```

- [ ] **Step 7: Bump environments**

`control-plane/src/repo.ts:996` — the `sets` array is built from a patch, so append the bump to the SQL rather than the array (the array's indices are tied to `params`):
```ts
    const { rows } = await this.pool.query(
      `UPDATE environments SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND workspace_id = $2 RETURNING *`, params);
```

The early-return above it (`if (!sets.length)`) is a pure read and must stay untouched — an empty patch is not a modification.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd control-plane && node --import tsx --test test/updated-at.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 9: Typecheck and run the full suite**

Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: no type errors; all 45 test files pass. Takes ~2 minutes (`--test-concurrency=1` is deliberate — do not remove it).

- [ ] **Step 10: Commit**

```bash
git add control-plane/src/repo.ts control-plane/test/updated-at.test.ts
git commit -m "feat(cp): bump updated_at on the self-mutating write paths

Agent status/rename, session status flips, environment edits, and skill
re-uploads. The skills UPDATE no longer stomps created_at, which is why the
Skills 'Created' column has been showing modify time all along.

Session Last activity is status-only: the migration 027 gateway_usage trigger
is untouched and token ticks do not move it. listAgents gains updated_at --
the only explicit SELECT list that needed it."
```

---

### Task 4: API — `GET /v1/memory-stores/:id`

**Files:**
- Modify: `control-plane/src/agents-api.ts` (add route next to the other memory-store routes, around `:566`)
- Modify: `control-plane/test/updated-at.test.ts` (append)

**Interfaces:**
- Consumes: `repo.getMemoryStore(storeId, workspaceId?)` (exists, `repo.ts:801`).
- Produces: `GET /v1/memory-stores/:id` → `200 { store: { id, name, workspace_id, created_at, updated_at } }` or `404 { error: "memory store not found" }`. Task 6's crumb consumes this.

**Why:** the memory-store detail page currently fetches only `/tree` and has no way to read the store row. There is no `GET /v1/memory-stores/:id` today — only `/tree`, `/content`, `/entries`, and the list. Modelled on `GET /v1/vaults/:id` (`agents-api.ts:445`).

- [ ] **Step 1: Write the failing test**

The test must exercise the ROUTE, not `repo.getMemoryStore` — that method already exists and already passes, so asserting it would prove nothing about the deliverable. Drive it through Fastify's `inject`, and cover the two branches most likely to be wrong: the 404 and the workspace scoping.

Append to `control-plane/test/updated-at.test.ts`:

```ts
import Fastify from "fastify";
import { registerAgentRoutes } from "../src/agents-api.ts";

test("GET /v1/memory-stores/:id returns the store row, 404s, and is workspace-scoped", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-api-${uniq()}`)).id;
  const other = (await repo.createWorkspace(`t-api-other-${uniq()}`)).id;
  const store = await repo.createMemoryStore(ws, `store-${uniq()}`);

  const app = Fastify();
  await registerAgentRoutes(app, repo as any, {} as any, {} as any);

  const ok = await app.inject({
    method: "GET", url: `/v1/memory-stores/${store.id}`,
    headers: { "X-Devproof-Workspace": ws },
  });
  assert.equal(ok.statusCode, 200);
  const body = ok.json();
  assert.equal(body.store.id, store.id);
  assert.ok(body.store.updated_at, "the store row must carry updated_at");

  const missing = await app.inject({
    method: "GET", url: `/v1/memory-stores/memstore_nope`,
    headers: { "X-Devproof-Workspace": ws },
  });
  assert.equal(missing.statusCode, 404);

  // Another workspace must not see this store — do not copy the unscoped
  // lookup that public-api.ts:355 warns about.
  const wrongWs = await app.inject({
    method: "GET", url: `/v1/memory-stores/${store.id}`,
    headers: { "X-Devproof-Workspace": other },
  });
  assert.equal(wrongWs.statusCode, 404, "the route must be workspace-scoped");

  await app.close();
});
```

If `registerAgentRoutes`'s real signature needs more than the stubs above, match how `test/vault-credentials.test.ts` builds its app and pass what it passes. The route under test touches only `repo`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && node --import tsx --test test/updated-at.test.ts`
Expected: FAIL — the first inject returns 404 (Fastify has no such route registered yet), so the `statusCode === 200` assertion fails.

- [ ] **Step 3: Add the route**

In `control-plane/src/agents-api.ts`, immediately above the existing `app.get("/v1/memory-stores/:id/tree", ...)` handler (around line 566):

```ts
  app.get("/v1/memory-stores/:id", async (req, reply) => {
    const store = await repo.getMemoryStore((req.params as any).id, ws(req));
    if (!store) return reply.code(404).send({ error: "memory store not found" });
    return { store };
  });
```

Workspace-scoped on purpose, matching `GET /v1/vaults/:id` — and note the security comment at `public-api.ts:355` about the existing unscoped `/tree` handler. Do not copy that hole into a new route.

Register it BEFORE `/v1/memory-stores/:id/tree` for readability; Fastify's router is not order-sensitive for these two, but keeping the row route first matches how vaults reads.

Do NOT add this to `public-api.ts` — that surface is a separate encapsulated plugin at prefix `/api` behind `apiKeyAuth`, and nothing there needs the store row.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd control-plane && node --import tsx --test test/updated-at.test.ts`
Expected: PASS — the 200, the 404, and the wrong-workspace 404 all hold.

- [ ] **Step 5: Verify the route by hand**

With the control plane running (see Task 7 Step 1):
```bash
curl -s -H "X-Devproof-Workspace: wrkspc_default" http://localhost:7080/v1/memory-stores | head -c 300
# take an id from that, then:
curl -s -H "X-Devproof-Workspace: wrkspc_default" http://localhost:7080/v1/memory-stores/<id>
```
Expected: `{"store":{"id":"memstore_...","name":"...","updated_at":"2026-07-15T..."}}`. A bogus id returns 404 with `{"error":"memory store not found"}`.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/test/updated-at.test.ts
git commit -m "feat(api): add workspace-scoped GET /v1/memory-stores/:id

The memory-store detail page fetches only /tree and has no way to read the
store row -- there was no route for it. Modelled on GET /v1/vaults/:id, and
scoped by workspace rather than copying the unscoped /tree lookup."
```

---

### Task 5: Console — table headers

**Files:**
- Modify: `console/app/agents/page.tsx:27`, `console/app/skills/page.tsx:20`, `console/app/environments/page.tsx:16`, `console/app/vaults/page.tsx:17`, `console/app/memory-stores/page.tsx:17`, `console/app/sessions/page.tsx:49`, `console/app/agents/[id]/tabs.tsx:76`

**Interfaces:**
- Consumes: `updated_at` on every list payload (Tasks 1 and 3).
- Produces: no code surface — UI only.

For each file: change the `<th>` text AND the matching `<td>` to read `updated_at`. Changing only the header would silently keep showing the creation time — the worst possible outcome, since it looks right.

- [ ] **Step 1: Agents table**

`console/app/agents/page.tsx:27` — header `<th>Created</th>` → `<th>Updated</th>`:
```tsx
        <thead><tr><th>ID</th><th>Name</th><th>Model</th><th>Version</th><th>Status</th><th>Updated</th><th></th></tr></thead>
```
And the cell (line 36):
```tsx
              <td>{new Date(a.updated_at).toLocaleString()}</td>
```

- [ ] **Step 2: Sessions table → "Last activity"**

`console/app/sessions/page.tsx:49`:
```tsx
          <tr><th>ID</th><th>Name</th><th>Agent</th><th>Status</th><th>Tokens in / out</th>{showBilled && <th>Billed</th>}<th>Last activity</th><th></th></tr>
```
And the cell (line 60):
```tsx
              <td>{new Date(s.updated_at).toLocaleString()}</td>
```

- [ ] **Step 3: Memory stores table**

`console/app/memory-stores/page.tsx:17`:
```tsx
        <thead><tr><th>ID</th><th>Name</th><th>Files</th><th>Updated</th><th></th></tr></thead>
```
And the cell (line 24):
```tsx
              <td>{new Date(s.updated_at).toLocaleString()}</td>
```

- [ ] **Step 4: Skills, environments, vaults tables**

`console/app/skills/page.tsx:20` — `<th>Created</th>` → `<th>Updated</th>`; its `created_at` cell → `updated_at`.
`console/app/environments/page.tsx:16` — same.
`console/app/vaults/page.tsx:17` — same.

Each is a single header swap plus the one `new Date(x.created_at)` → `new Date(x.updated_at)` in the matching `<td>`.

- [ ] **Step 5: Sessions table inside agent detail**

`console/app/agents/[id]/tabs.tsx:76` — this is a sessions list, so it gets the same label as the main one:
```tsx
          <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Version</th><th>Tokens in / out</th><th>Last activity</th></tr></thead>
```
And its `created_at` cell → `updated_at`.

- [ ] **Step 6: Build and verify**

```bash
cd console && npx next build
```
Expected: build succeeds, no type errors.

Then check every changed cell renders a real date, not `Invalid Date` (which is what you get if the API is not returning the field):
```bash
curl -s -H "X-Devproof-Workspace: wrkspc_default" http://localhost:7080/v1/agents | head -c 200
```
Expected: each agent object contains `"updated_at":"2026-...`.

- [ ] **Step 7: Commit**

```bash
git add console/app/agents/page.tsx console/app/skills/page.tsx console/app/environments/page.tsx \
        console/app/vaults/page.tsx console/app/memory-stores/page.tsx console/app/sessions/page.tsx \
        console/app/agents/[id]/tabs.tsx
git commit -m "feat(console): show Updated / Last activity instead of Created

Six list tables plus the sessions table on agent detail. Files keeps Created --
files are immutable, so a modify time would repeat the creation time forever."
```

---

### Task 6: Console — crumbs

**Files:**
- Modify: `console/app/agents/[id]/page.tsx:26`, `console/app/sessions/[id]/page.tsx:20`, `console/app/vaults/[id]/page.tsx:15`, `console/app/skills/[id]/page.tsx:16`, `console/app/memory-stores/[id]/page.tsx:13`, `console/app/files/[id]/page.tsx:18` and `:31`

**Interfaces:**
- Consumes: `updated_at` on detail payloads (Tasks 1, 3) and `GET /v1/memory-stores/:id` (Task 4).
- Produces: no code surface — UI only.

- [ ] **Step 1: Agents crumb — replace created with updated**

`console/app/agents/[id]/page.tsx:26`:
```tsx
      <div className="crumbs"><Link href="/agents">Agents</Link> / <CopyId id={agent.id} /> · updated {new Date(agent.updated_at).toLocaleString()}</div>
```
This is served by `getAgentWithVersions` (`repo.ts:214`, a `SELECT *`), so the field is already present — no API change needed. Note this removes an agent's creation time from the UI entirely; that was requested explicitly.

- [ ] **Step 2: Sessions crumb — replace created with last activity**

`console/app/sessions/[id]/page.tsx:20`:
```tsx
      <div className="crumbs"><Link href="/sessions">Sessions</Link> / <CopyId id={session.id} /> · last activity {new Date(session.updated_at).toLocaleString()}</div>
```

- [ ] **Step 3: Vaults and skills crumbs — add updated**

`console/app/vaults/[id]/page.tsx:15`:
```tsx
      <div className="crumbs"><Link href="/vaults">Vaults</Link> / <CopyId id={vault.id} /> · updated {new Date(vault.updated_at).toLocaleString()}</div>
```

`console/app/skills/[id]/page.tsx:16`:
```tsx
      <div className="crumbs"><Link href="/skills">Skills</Link> / <CopyId id={skill.id} /> · updated {new Date(skill.updated_at).toLocaleString()}</div>
```

- [ ] **Step 4: Memory-stores crumb — needs the new fetch**

`console/app/memory-stores/[id]/page.tsx` currently loads only `/tree`. Add the store fetch and use it in the crumb. Replace the body of the component:

```tsx
export default async function MemoryStoreDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ entries }, storeRes] = await Promise.all([
    wsGet<{ entries: any[] }>(`/v1/memory-stores/${id}/tree`),
    wsGet<{ store: any }>(`/v1/memory-stores/${id}`).catch(() => null),
  ]);
  const store = storeRes?.store;
  return (
    <>
      <div className="crumbs"><Link href="/memory-stores">Memory stores</Link> / <CopyId id={id} />
        {store && <> · updated {new Date(store.updated_at).toLocaleString()}</>}</div>
      <h1>Memory store</h1>
      <p className="sub">{entries.length} file(s)</p>
      <MemoryBrowser storeId={id} entries={entries} />
    </>
  );
}
```

Leave the hardcoded `<h1>Memory store</h1>` alone. Showing `store.name` there would be an improvement but is not in scope.

- [ ] **Step 5: Files crumb — add created, remove the duplicate panel row**

`console/app/files/[id]/page.tsx:18` — add the crumb:
```tsx
      <div className="crumbs"><Link href="/files">Files</Link> / <CopyId id={f.id} /> · created {new Date(f.created_at).toLocaleString()}</div>
```

Then delete the now-duplicate row at `:31`:
```tsx
          <div className="row"><span className="muted">Created</span><span>{new Date(f.created_at).toLocaleString()}</span></div>
```

**CRLF gotcha:** this repo is CRLF. Deleting a whole line via Edit with a leading `\n` in `old_string` joins the adjacent lines. Match the line's own text without a leading newline, then run `git diff console/app/files/[id]/page.tsx` and confirm the surrounding `<div className="row">` lines are still intact and separate.

Files keeps `Created` — files are immutable, so there is nothing else to show.

- [ ] **Step 6: Build and verify every crumb**

```bash
cd console && npx next build && npx next start -p 7090
```

Then confirm each detail page renders and its crumb shows a real date:
```bash
for p in agents sessions vaults skills memory-stores files; do
  echo "--- $p"; curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:7090/$p"
done
```
Expected: `200` for all six. Then open one detail page of each type in a browser and read the crumb — `Invalid Date` means the field is missing from that payload.

**Restart gotcha:** `next build` under a running `next start` pins old chunk hashes and throws a client-side exception while content-curls still pass. Stop the server before rebuilding, then start it again.

- [ ] **Step 7: Commit**

```bash
git add console/app/agents/\[id\]/page.tsx console/app/sessions/\[id\]/page.tsx \
        console/app/vaults/\[id\]/page.tsx console/app/skills/\[id\]/page.tsx \
        console/app/memory-stores/\[id\]/page.tsx console/app/files/\[id\]/page.tsx
git commit -m "feat(console): put the modify time in every detail crumb

Agents and sessions swap created for updated/last activity; vaults, skills and
memory stores gain it. Files shows created (immutable) and loses its duplicate
Created panel row now that the crumb carries it."
```

---

### Task 7: End-to-end verification and CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Restart the control plane and console against the live cluster**

```bash
cd control-plane && DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev27 \
  DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files \
  npx tsx src/main.ts
```
(Not `npm run dev` — it exits under tool backgrounding.) In a second shell:
```bash
cd console && npx next build && npx next start -p 7090
```
Expected: the CP boots clean. Watch for migration errors — a failure in `035_updated_at.sql` surfaces here.

- [ ] **Step 2: Confirm the boot did not stomp the data**

Restart the control plane once more, then:
```bash
cd control-plane && node --import tsx -e "
import { createPool } from './src/db.ts';
const p = createPool();
for (const t of ['agents','skills','sessions','environments','vaults','memory_stores']) {
  const { rows } = await p.query(\`SELECT count(*)::int n, count(*) FILTER (WHERE updated_at > now() - interval '2 minutes')::int fresh FROM \${t}\`);
  console.log(t.padEnd(14), 'rows', rows[0].n, '| touched in last 2min:', rows[0].fresh);
}
await p.end();
"
```
Expected: `touched in last 2min` is 0 for tables you did not just write to. Anything else means a backfill guard is missing and the restart reset the rows.

- [ ] **Step 3: Confirm all pages 200**

```bash
for p in agents sessions skills environments vaults memory-stores files; do
  printf "%-15s %s\n" "$p" "$(curl -s -o /dev/null -w "%{http_code}" http://localhost:7090/$p)"
done
```
Expected: `200` for all seven.

- [ ] **Step 4: Exercise the touched flows in the browser**

Against `http://localhost:7090`, confirm the Updated value actually moves:

1. **Agents** — edit an agent (save = new version): Updated jumps to now. Rename it: jumps again. Toggle Disable/Enable: jumps again.
2. **Environments** — edit an environment, save: Updated jumps.
3. **Vaults** — add a credential, then rotate it, then remove it: Updated jumps each time.
4. **Memory stores** — run a session that writes to a store: Updated jumps when the session writes. This is the requirement that motivated the trigger.
5. **Sessions** — start a session: Last activity moves on queued → running and again on idle/completed. It must NOT tick every few seconds while tokens stream.
6. **Files** — still says Created; the detail crumb shows it and the panel no longer repeats it.

- [ ] **Step 5: Add the naming-collision note to CLAUDE.md**

In `CLAUDE.md`, append to the **Session lifecycle** bullet:

```
Session **Last activity** (`sessions.updated_at`, migration 035) moves on status
flips only — queued/running/idle/completed/failed, so every turn boundary — and
NOT on token ticks (the 027 trigger stays the sole writer of tokens_in/out).
Do not confuse it with the `last_activity` alias in `listStuckSessions`
(`repo.ts:337`), which is `GREATEST(created_at, max(session_events.created_at))`
and feeds the zombie reconciler — same name, different definition.
```

And append to the **Conventions & gotchas** list:

```
- **Last-modified (migration 035):** `updated_at` on agents/skills/sessions/
  environments/vaults/memory_stores — NOT files (immutable). Child changes touch
  the parent via STATEMENT-level transition-table triggers (memory_entries→
  memory_stores, vault_credentials→vaults, agent_versions→agents); row-level
  triggers were measured 3–18× slower with 21× parent heap bloat on bulk writes.
  Self-mutating rows bump in `repo.ts`. The backfill guards (`WHERE updated_at
  IS NULL`) are load-bearing — `migrate()` re-runs every file each boot, so an
  unguarded backfill resets every row to boot time on every restart.
```

- [ ] **Step 6: Full suite and typecheck**

```bash
cd control-plane && npx tsc --noEmit && npm test
```
Expected: no type errors; all 45 test files pass (~2 min).

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note the updated_at conventions and the last_activity collision

Records why the triggers are statement-level, why the backfill guards are
load-bearing, and that sessions.updated_at (status-only) is a different thing
from the last_activity alias the zombie reconciler computes."
```

- [ ] **Step 8: Finish the branch**

Use the superpowers:finishing-a-development-branch skill to decide how to integrate `feat/last-modified-timestamps`.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Six tables get `updated_at`; files excluded | 1 |
| Guarded backfill, add-nullable → backfill → default → NOT NULL | 1 |
| Backfill seeds from `GREATEST(created_at, max(child))` | 1 |
| Statement-level triggers, three parent relationships | 2 |
| Cascade-delete safety | 2 |
| App-code bumps (agents ×2, sessions ×3, skills, environments) | 3 |
| Skills stops stomping `created_at` | 3 |
| 027 trigger untouched; token ticks do not move Last activity | 3 |
| `listAgents` is the only SELECT needing a change | 3 |
| Memory-store crumb "needs a new fetch" | 4 (route) + 6 (page) |
| Six table headers + `tabs.tsx:76` | 5 |
| Six crumbs; files panel-row removal | 6 |
| Test list from the spec | 1, 2, 3 |
| Live-cluster verification | 7 |
| `last_activity` naming collision noted | 7 |

**Deviation from spec:** the spec assumed a `GET /v1/memory-stores/:id` existed. It does not; Task 4 adds it. This is the only new API surface in the plan.

**Not implemented (spec "Future", correctly out of scope):** sortable `Updated` indexes; renaming the vault-credential `Added` column.

**Placeholder scan:** clean — every code step carries real code, every command an expected output.

**Type consistency:** `updated_at` is the column everywhere; `stampOf(table, id)`, `uniq()`, `fid()`, and `memFixture(repo)` are defined once in Task 1/2 and reused with matching signatures. `getMemoryStore(storeId, workspaceId?)`, `newAgentVersion(workspaceId, agentId, config)`, `upsertMemoryEntries(storeId, entries, deletes?)`, `addVaultCredential(vaultId, name, type?)`, `createFileRecord({ id, name, size, sha256, objectKey, kind?, workspaceId? })`, `updateEnvironment(workspaceId, id, patch)`, `removeVaultCredential(vaultId, name)`, and `setSessionStatus(sessionId, status, extras?, reportedTurn?)` all verified against `repo.ts`. No open items.
