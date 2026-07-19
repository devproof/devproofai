# Workspace Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workspaces become first-class managed resources: a `Manage → Workspaces` console page with rename/disable/delete (tracked deletion progress), read-only enforcement for disabled workspaces, and an MCP-picker-style workspace switcher.

**Architecture:** `workspaces.status` lifecycle column (`active|disabled|deleting|deleted`); a `workspaceGuard` Fastify preHandler blocks writes on both API surfaces; deletion is an in-process, batched, idempotent runner (`workspace-delete.ts`) resumed by a boot sweep; the deleted row survives as a tombstone so `gateway_usage` keeps name+id attribution. Spec: `docs/superpowers/specs/2026-07-13-workspace-management-design.md`.

**Tech Stack:** Node/TS + Fastify + pg (control plane), node:test, Next.js console, one Python edit in the litellm gateway ConfigMap.

## Global Constraints

- Everything must scale to hundreds–thousands of pods: deletion drains in batches of 100, never one giant transaction/request.
- Migrations re-run EVERY boot — all DDL idempotent; never touch migration 010.
- `wrkspc_default` can never be renamed, disabled, or deleted.
- Disabled = read-only; **exempt:** session interrupt, runner callback routes, `/v1/workspaces` management, Serving routes (global).
- `gateway_usage` rows are NEVER touched by deletion (no FK exists; tombstone keeps id+name).
- Legacy content-addressed S3 objects (`file_<sha256>`) may be shared across workspaces — delete rows, but only new-format (`/^file_[a-z0-9]{12}$/`) objects.
- Console: no browser dialogs (shared `Modal`/`ConfirmDialog`); no transparent text buttons; table links regular weight; full id is the clickable element in lists; production build only (`npx next build && npx next start -p 7090`).
- Backend verify: `cd control-plane && npm test` and `npx tsc --noEmit`. Repo tests run against live dev Postgres (localhost:15432 via localhost-lb) and self-skip when unreachable.
- Commit format: `feat(cp): …` / `feat(console): …` etc., with the Co-Authored-By/Claude-Session footer.

---

### Task 1: Migration 029 + workspace lifecycle repo methods

**Files:**
- Create: `control-plane/sql/029_workspace_status.sql`
- Modify: `control-plane/src/repo.ts` (workspaces section, lines ~39-49)
- Test: `control-plane/test/workspace-repo.test.ts` (new)

**Interfaces:**
- Consumes: existing `Repo` class, `createPool`/`migrate` from `src/db.ts`.
- Produces (later tasks call these exact signatures):
  - `getWorkspace(id: string): Promise<{ id: string; name: string; status: string; delete_totals: any } | null>`
  - `listWorkspaces(includeDeleted = false): Promise<Row[]>` (rows now carry `status`)
  - `renameWorkspace(id: string, name: string): Promise<"ok" | "notfound" | "conflict">`
  - `setWorkspaceStatus(id: string, status: string): Promise<boolean>`
  - `beginWorkspaceDelete(id: string, totals: Record<string, number>): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `control-plane/test/workspace-repo.test.ts`:

```ts
// Integration tests against the live dev Postgres (port-forward 15432).
// Skipped automatically when the database is unreachable.
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

test("workspace lifecycle: status column, rename, tombstone name reuse", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const name = `t-wsmgmt-${Date.now()}`;
  const ws = await repo.createWorkspace(name);

  // New rows are active; getWorkspace round-trips.
  const row = await repo.getWorkspace(ws.id);
  assert.equal(row.status, "active");

  // Rename works; renaming to a live name conflicts.
  const other = await repo.createWorkspace(`${name}-b`);
  assert.equal(await repo.renameWorkspace(ws.id, `${name}-b`), "conflict");
  assert.equal(await repo.renameWorkspace(ws.id, `${name}-c`), "ok");
  assert.equal(await repo.renameWorkspace("wrkspc_nope", "x"), "notfound");

  // Status flips; listWorkspaces hides deleted by default.
  assert.equal(await repo.setWorkspaceStatus(ws.id, "disabled"), true);
  assert.equal((await repo.getWorkspace(ws.id)).status, "disabled");
  await repo.beginWorkspaceDelete(ws.id, { sessions: 2 });
  const started = await repo.getWorkspace(ws.id);
  assert.equal(started.status, "deleting");
  assert.equal(started.delete_totals.sessions, 2);
  await repo.setWorkspaceStatus(ws.id, "deleted");
  assert.ok(!(await repo.listWorkspaces()).some((w: any) => w.id === ws.id));
  assert.ok((await repo.listWorkspaces(true)).some((w: any) => w.id === ws.id));

  // Tombstone keeps its name but does not block reuse (partial unique index).
  const reused = await repo.createWorkspace(`${name}-c`);
  assert.equal((await repo.getWorkspace(ws.id)).name, `${name}-c`); // tombstone unchanged

  // Cleanup live debris (tombstones are permanent by design).
  await pool.query("DELETE FROM workspaces WHERE id = ANY($1)", [[other.id, reused.id]]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --test test/workspace-repo.test.ts`
Expected: FAIL with `TypeError: repo.getWorkspace is not a function` (or, if only the migration is missing, a column error). If it reports `skipped`, Postgres is down — start the cluster/localhost-lb first; do not proceed on a skip.

- [ ] **Step 3: Write the migration**

Create `control-plane/sql/029_workspace_status.sql`:

```sql
-- Workspace management (spec 2026-07-13): status lifecycle + deletion progress.
-- status: active | disabled | deleting | deleted. A deleted workspace is a
-- TOMBSTONE: the row (id + name) survives forever so gateway_usage stays
-- attributable; all resources are drained by workspace-delete.ts.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS delete_totals JSONB;

-- Tombstones keep their name without blocking reuse: uniqueness applies to
-- live rows only. (Fresh setups create the plain UNIQUE in 010; dropped here.)
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_live_name ON workspaces(name) WHERE status <> 'deleted';
```

- [ ] **Step 4: Extend the repo's Workspaces section**

In `control-plane/src/repo.ts`, replace the existing `listWorkspaces` (lines 40-43) and add methods after `createWorkspace`:

```ts
  async listWorkspaces(includeDeleted = false) {
    const { rows } = await this.pool.query(
      includeDeleted
        ? "SELECT * FROM workspaces ORDER BY created_at"
        : "SELECT * FROM workspaces WHERE status <> 'deleted' ORDER BY created_at");
    return rows;
  }

  async getWorkspace(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM workspaces WHERE id = $1", [id]);
    return rows[0] ?? null;
  }

  async renameWorkspace(id: string, name: string): Promise<"ok" | "notfound" | "conflict"> {
    try {
      const { rowCount } = await this.pool.query(
        "UPDATE workspaces SET name = $2 WHERE id = $1 AND status <> 'deleted'", [id, name]);
      return (rowCount ?? 0) > 0 ? "ok" : "notfound";
    } catch (err: any) {
      if (err?.code === "23505") return "conflict"; // uq_workspaces_live_name
      throw err;
    }
  }

  async setWorkspaceStatus(id: string, status: string) {
    const { rowCount } = await this.pool.query(
      "UPDATE workspaces SET status = $2 WHERE id = $1", [id, status]);
    return (rowCount ?? 0) > 0;
  }

  /** Flip to 'deleting' + snapshot the progress denominator. No-op if already
   *  deleting/deleted (repeat DELETE is idempotent). */
  async beginWorkspaceDelete(id: string, totals: Record<string, number>) {
    await this.pool.query(
      "UPDATE workspaces SET status = 'deleting', delete_totals = $2 WHERE id = $1 AND status NOT IN ('deleting','deleted')",
      [id, JSON.stringify(totals)]);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd control-plane && node --test test/workspace-repo.test.ts`
Expected: PASS (1 test). Also run `npx tsc --noEmit` — clean.

- [ ] **Step 6: Commit**

```bash
git add control-plane/sql/029_workspace_status.sql control-plane/src/repo.ts control-plane/test/workspace-repo.test.ts
git commit -m "feat(cp): workspace status lifecycle + tombstone-aware naming (migration 029)"
```

---

### Task 2: Repo drain helpers (counts, batch ids, bulk deletes)

**Files:**
- Modify: `control-plane/src/repo.ts`
- Test: `control-plane/test/workspace-repo.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 methods; existing `deleteSession/deleteSkill/deleteMemoryStore/deleteFile/deleteEnvironment/deleteVault/deleteAgent/deleteFileUpload` (all already in repo.ts).
- Produces:
  - `workspaceResourceCounts(id: string): Promise<Record<string, number>>` — keys: `sessions, skills, memory_stores, files, environments, vaults, agents, webhooks, api_keys, file_uploads`
  - `workspaceRowIds(table: string, workspaceId: string, limit = 100): Promise<string[]>` (allowlisted tables only)
  - `deleteWorkspaceWebhooks(workspaceId: string): Promise<void>`
  - `softDeleteWorkspaceApiKeys(workspaceId: string): Promise<void>`
  - `listWorkspaceFileUploads(workspaceId: string): Promise<{ id: string; upload_key: string; file_id: string }[]>`

- [ ] **Step 1: Append the failing test**

Append to `control-plane/test/workspace-repo.test.ts`:

```ts
test("workspace drain helpers: counts, batch ids, bulk deletes", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-wsdrain-${Date.now()}`)).id;
  const env = await repo.createEnvironment(ws, `t-env-${Date.now()}`);
  const agent = await repo.createAgent(ws, `t-agent-${Date.now()}`, { model: "m", environmentId: env.id });
  await repo.createSession(ws, agent.id, "p");
  await repo.createWebhook(ws, "http://example.invalid/hook");
  const key = await repo.createApiKey(ws, "t-key");

  const counts = await repo.workspaceResourceCounts(ws);
  assert.equal(counts.agents, 1);
  assert.equal(counts.sessions, 1);
  assert.equal(counts.environments, 1);
  assert.equal(counts.webhooks, 1);
  assert.equal(counts.api_keys, 1);

  const ids = await repo.workspaceRowIds("agents", ws, 100);
  assert.deepEqual(ids, [agent.id]);
  await assert.rejects(() => repo.workspaceRowIds("workspaces; DROP TABLE x", ws), /not drainable/);

  await repo.deleteWorkspaceWebhooks(ws);
  await repo.softDeleteWorkspaceApiKeys(ws);
  const after = await repo.workspaceResourceCounts(ws);
  assert.equal(after.webhooks, 0);
  assert.equal(after.api_keys, 0); // soft-deleted keys drop out of the count
  const { rows } = await pool.query("SELECT status FROM api_keys WHERE id = $1", [key.id]);
  assert.equal(rows[0].status, "deleted"); // ...but the row survives

  assert.deepEqual(await repo.listWorkspaceFileUploads(ws), []);

  // Cleanup (deleteAgent cascades the session).
  await repo.deleteAgent(ws, agent.id);
  await repo.deleteEnvironment(ws, env.id);
  await pool.query("DELETE FROM api_keys WHERE workspace_id = $1", [ws]);
  await pool.query("DELETE FROM workspaces WHERE id = $1", [ws]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --test test/workspace-repo.test.ts`
Expected: first test PASS, second FAIL with `TypeError: repo.workspaceResourceCounts is not a function`.

- [ ] **Step 3: Implement the helpers**

Add to `control-plane/src/repo.ts` (after `beginWorkspaceDelete`). The table names are interpolated, so both methods gate on a module-level allowlist:

```ts
/** Tables the deletion runner drains / the progress endpoint counts.
 *  Names are interpolated into SQL — NEVER extend without the allowlist. */
const DRAIN_TABLES = ["sessions", "skills", "memory_stores", "files",
                      "environments", "vaults", "agents", "webhooks", "file_uploads"] as const;
```

```ts
  /** Live per-resource-type counts: delete-confirm dialog, delete_totals
   *  snapshot, and deletion progress all read this. api_keys counts only
   *  non-deleted rows so a drained workspace reaches 0 everywhere. */
  async workspaceResourceCounts(id: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const t of DRAIN_TABLES) counts[t] = await this.count(t, id);
    const { rows } = await this.pool.query(
      "SELECT count(*)::int AS n FROM api_keys WHERE workspace_id = $1 AND status <> 'deleted'", [id]);
    counts.api_keys = rows[0].n;
    return counts;
  }

  /** First `limit` ids of a drainable table — the runner's batch cursor. */
  async workspaceRowIds(table: string, workspaceId: string, limit = 100): Promise<string[]> {
    if (!(DRAIN_TABLES as readonly string[]).includes(table)) throw new Error(`not drainable: ${table}`);
    const { rows } = await this.pool.query(
      `SELECT id FROM ${table} WHERE workspace_id = $1 LIMIT $2`, [workspaceId, limit]);
    return rows.map((r: any) => r.id);
  }

  async deleteWorkspaceWebhooks(workspaceId: string) {
    await this.pool.query("DELETE FROM webhooks WHERE workspace_id = $1", [workspaceId]);
  }

  /** Soft-delete (existing api-key convention): names survive for Usage attribution. */
  async softDeleteWorkspaceApiKeys(workspaceId: string) {
    await this.pool.query("UPDATE api_keys SET status = 'deleted' WHERE workspace_id = $1", [workspaceId]);
  }

  async listWorkspaceFileUploads(workspaceId: string) {
    const { rows } = await this.pool.query(
      "SELECT id, upload_key, file_id FROM file_uploads WHERE workspace_id = $1", [workspaceId]);
    return rows;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd control-plane && node --test test/workspace-repo.test.ts`
Expected: PASS (2 tests). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/repo.ts control-plane/test/workspace-repo.test.ts
git commit -m "feat(cp): workspace drain helpers — resource counts, batch cursors, bulk deletes"
```

---

### Task 3: workspaceGuard preHandler

**Files:**
- Create: `control-plane/src/workspace-guard.ts`
- Test: `control-plane/test/workspace-guard.test.ts`

**Interfaces:**
- Consumes: `repo.getWorkspace(id)` (Task 1).
- Produces:
  - `workspaceGuard(repo, resolve: (req) => string | null, rules: GuardRules, ttlMs = 10_000)` → Fastify preHandler
  - `CONSOLE_RULES: GuardRules` (for agents-api), `PUBLIC_RULES: GuardRules` (for public-api)
  - `interface GuardRules { guarded(url: string): boolean; exempt(url: string): boolean }`

- [ ] **Step 1: Write the failing test**

Create `control-plane/test/workspace-guard.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { workspaceGuard, CONSOLE_RULES, PUBLIC_RULES } from "../src/workspace-guard.ts";

function makeApp(status: string | null, rules = CONSOLE_RULES) {
  const repo = {
    calls: 0,
    async getWorkspace(_id: string) { this.calls++; return status === null ? null : { id: "wrkspc_x", status }; },
  };
  const app = Fastify();
  // ttl 0 => every request re-reads status (deterministic tests).
  app.addHook("preHandler", workspaceGuard(repo, (req: any) => (req.headers["x-devproof-workspace"] as string) || "wrkspc_default", rules, 0));
  const ok = async () => ({ ok: true });
  app.get("/v1/agents", ok);
  app.post("/v1/agents", ok);
  app.post("/v1/sessions/:id/interrupt", ok);
  app.post("/v1/sessions/:id/events", ok);   // runner callback
  app.post("/v1/pools", ok);                  // serving — not in guarded prefixes
  app.post("/v1/workspaces/:id/status", ok);  // management — not in guarded prefixes
  return { app, repo };
}

test("disabled workspace: writes 409, reads + interrupt + runner callbacks + serving pass", async () => {
  const { app } = makeApp("disabled");
  const h = { "x-devproof-workspace": "wrkspc_x" };
  assert.equal((await app.inject({ method: "GET", url: "/v1/agents", headers: h })).statusCode, 200);
  const blocked = await app.inject({ method: "POST", url: "/v1/agents", headers: h, payload: {} });
  assert.equal(blocked.statusCode, 409);
  assert.equal(JSON.parse(blocked.body).error, "workspace disabled");
  assert.equal((await app.inject({ method: "POST", url: "/v1/sessions/s1/interrupt", headers: h, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/v1/sessions/s1/events", headers: h, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/v1/pools", headers: h, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/v1/workspaces/wrkspc_x/status", headers: h, payload: {} })).statusCode, 200);
});

test("deleting blocks writes; deleted/unknown 404; active passes", async () => {
  const h = { "x-devproof-workspace": "wrkspc_x" };
  assert.equal((await makeApp("deleting").app.inject({ method: "POST", url: "/v1/agents", headers: h, payload: {} })).statusCode, 409);
  assert.equal((await makeApp("deleted").app.inject({ method: "POST", url: "/v1/agents", headers: h, payload: {} })).statusCode, 404);
  assert.equal((await makeApp(null).app.inject({ method: "POST", url: "/v1/agents", headers: h, payload: {} })).statusCode, 404);
  assert.equal((await makeApp("active").app.inject({ method: "POST", url: "/v1/agents", headers: h, payload: {} })).statusCode, 200);
});

test("status cache respects TTL", async () => {
  const repo = { calls: 0, async getWorkspace() { this.calls++; return { id: "w", status: "active" }; } };
  const app = Fastify();
  app.addHook("preHandler", workspaceGuard(repo, () => "w", CONSOLE_RULES, 60_000));
  app.post("/v1/agents", async () => ({ ok: true }));
  await app.inject({ method: "POST", url: "/v1/agents", payload: {} });
  await app.inject({ method: "POST", url: "/v1/agents", payload: {} });
  assert.equal(repo.calls, 1); // second hit served from cache
});

test("PUBLIC_RULES: everything guarded except interrupt and events/stream", async () => {
  const repo = { async getWorkspace() { return { id: "w", status: "disabled" }; } };
  const app = Fastify();
  app.addHook("preHandler", workspaceGuard(repo, () => "w", PUBLIC_RULES, 0));
  const ok = async () => ({ ok: true });
  app.post("/agents", ok);
  app.post("/sessions/:id/interrupt", ok);
  app.post("/sessions/:id/events/stream", ok); // POST-as-read (public contract)
  assert.equal((await app.inject({ method: "POST", url: "/agents", payload: {} })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/sessions/s/interrupt", payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/sessions/s/events/stream", payload: {} })).statusCode, 200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --test test/workspace-guard.test.ts`
Expected: FAIL — `Cannot find module '../src/workspace-guard.ts'`.

- [ ] **Step 3: Implement the guard**

Create `control-plane/src/workspace-guard.ts`:

```ts
// Read-only enforcement for disabled workspaces (spec 2026-07-13).
// One TTL-cached status lookup per (workspace, ttl window); GET/HEAD/OPTIONS
// always pass. Rules are POSITIVE prefix lists — routes outside them (Serving,
// /internal, workspace management itself) are never touched, so the guard
// cannot break global surfaces regardless of hook registration order.
import type { FastifyReply, FastifyRequest } from "fastify";

export interface WorkspaceStatusRepo {
  getWorkspace(id: string): Promise<{ id: string; status?: string } | null>;
}

export interface GuardRules {
  /** Only route urls matching this are status-checked. */
  guarded(url: string): boolean;
  /** Escape hatch inside the guarded set. */
  exempt(url: string): boolean;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export function workspaceGuard(
  repo: WorkspaceStatusRepo,
  resolve: (req: any) => string | null,
  rules: GuardRules,
  ttlMs = 10_000,
) {
  const cache = new Map<string, { status: string | null; expires: number }>();
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (SAFE.has(req.method)) return;
    // routeOptions.url is the route PATTERN ("/v1/sessions/:id/interrupt").
    const url: string = (req as any).routeOptions?.url ?? req.url;
    if (!rules.guarded(url) || rules.exempt(url)) return;
    const wsId = resolve(req);
    if (!wsId) return;
    let hit = cache.get(wsId);
    if (!hit || hit.expires < Date.now()) {
      const row = await repo.getWorkspace(wsId);
      hit = { status: row ? (row.status ?? "active") : null, expires: Date.now() + ttlMs };
      cache.set(wsId, hit);
    }
    if (hit.status === null || hit.status === "deleted")
      return reply.code(404).send({ error: "workspace not found" });
    if (hit.status !== "active")
      return reply.code(409).send({ error: "workspace disabled" });
  };
}

const CONSOLE_PREFIXES = ["/v1/agents", "/v1/sessions", "/v1/files", "/v1/skills", "/v1/vaults",
                          "/v1/memory-stores", "/v1/environments", "/v1/webhooks", "/v1/api-keys"];
const CONSOLE_EXEMPT = new Set([
  "/v1/sessions/:id/interrupt", // emergency brake stays available while disabled
  "/v1/sessions/:id/events",    // ↓ runner callbacks: running turns must
  "/v1/sessions/:id/status",    //   complete, checkpoint, and sync memory
  "/v1/sessions/:id/outputs",   //   on a disabled workspace
  "/v1/sessions/:id/memory",
  "/v1/files/raw",              // runner checkpoint upload
]);

/** agents-api (/v1 console surface): workspace-scoped prefixes only. */
export const CONSOLE_RULES: GuardRules = {
  guarded: (url) => CONSOLE_PREFIXES.some((p) => url === p || url.startsWith(p + "/")),
  exempt: (url) => CONSOLE_EXEMPT.has(url),
};

/** public-api (dpk keys): every route is workspace-scoped; streamed reads are POST. */
export const PUBLIC_RULES: GuardRules = {
  guarded: () => true,
  exempt: (url) => url.endsWith("/interrupt") || url.endsWith("/events/stream"),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd control-plane && node --test test/workspace-guard.test.ts`
Expected: PASS (4 tests). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/workspace-guard.ts control-plane/test/workspace-guard.test.ts
git commit -m "feat(cp): workspaceGuard — read-only enforcement for disabled workspaces"
```

---

### Task 4: Deletion runner (workspace-delete.ts) + boot sweep

**Files:**
- Create: `control-plane/src/workspace-delete.ts`
- Test: `control-plane/test/workspace-delete.test.ts`

**Interfaces:**
- Consumes: repo drain helpers (Task 2) + existing `deleteSession(ws, id) → Promise<string[]>` (orphan file ids), `deleteSkill(ws, id)`, `deleteMemoryStore(ws, id)`, `deleteFile(ws, id)`, `deleteEnvironment(ws, id)`, `deleteVault(ws, id)`, `deleteAgent(ws, id)`, `deleteFileUpload(id)`, `setWorkspaceStatus(id, status)`, `listWorkspaces(true)`; orchestrator `stopSession`, `deleteSessionResources`, `deleteEnvironmentResources`, `deleteVaultSecret`; `files.del?.(id)`, `files.abortUpload?.(fileId, key)`.
- Produces:
  - `runWorkspaceDelete(repo, orchestrator, files, wsId: string): Promise<void>`
  - `sweepDeletingWorkspaces(repo, orchestrator, files): Promise<void>`

Type note: import `Orchestrator` from `./agents-api.ts` and `FileStore` from `./filestore.ts` with `import type` only — agents-api will import `runWorkspaceDelete` at runtime (Task 5), and type-only imports keep that cycle-free.

- [ ] **Step 1: Write the failing test**

Create `control-plane/test/workspace-delete.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkspaceDelete, sweepDeletingWorkspaces } from "../src/workspace-delete.ts";

// In-memory workspace with one of everything. Tables map id -> row.
function fixtures() {
  const ws = "wrkspc_t";
  const calls: string[] = [];
  const tables: Record<string, Map<string, any>> = {
    sessions: new Map([["sesn_1", {}], ["sesn_2", {}]]),
    skills: new Map([["skill_1", {}]]),
    memory_stores: new Map([["memstore_1", {}]]),
    files: new Map([["file_abc123def456", {}], ["file_" + "a".repeat(64), {}]]), // new-format + legacy
    environments: new Map([["env_1", {}]]),
    vaults: new Map([["vlt_1", {}]]),
    agents: new Map([["agent_1", {}]]),
    webhooks: new Map([["whk_1", {}]]),
    file_uploads: new Map([["uplj_1", { id: "uplj_1", upload_key: "k", file_id: "file_up1" }]]),
  };
  let status = "deleting";
  const repo = {
    async workspaceRowIds(table: string, _ws: string, limit = 100) {
      return [...tables[table].keys()].slice(0, limit);
    },
    async deleteSession(_ws: string, id: string) { calls.push(`deleteSession:${id}`); tables.sessions.delete(id); return ["file_abc123def456"]; },
    async deleteSkill(_ws: string, id: string) { calls.push(`deleteSkill:${id}`); tables.skills.delete(id); },
    async deleteMemoryStore(_ws: string, id: string) { calls.push(`deleteMemoryStore:${id}`); tables.memory_stores.delete(id); },
    async deleteFile(_ws: string, id: string) { calls.push(`deleteFile:${id}`); tables.files.delete(id); return true; },
    async deleteEnvironment(_ws: string, id: string) { calls.push(`deleteEnvironment:${id}`); tables.environments.delete(id); },
    async deleteVault(_ws: string, id: string) { calls.push(`deleteVault:${id}`); tables.vaults.delete(id); },
    async deleteAgent(_ws: string, id: string) { calls.push(`deleteAgent:${id}`); tables.agents.delete(id); },
    async deleteWorkspaceWebhooks(_ws: string) { calls.push("deleteWebhooks"); tables.webhooks.clear(); },
    async softDeleteWorkspaceApiKeys(_ws: string) { calls.push("softDeleteKeys"); },
    async listWorkspaceFileUploads(_ws: string) { return [...tables.file_uploads.values()]; },
    async deleteFileUpload(id: string) { calls.push(`deleteFileUpload:${id}`); tables.file_uploads.delete(id); },
    async setWorkspaceStatus(_id: string, s: string) { calls.push(`status:${s}`); status = s; return true; },
    async listWorkspaces(_all: boolean) { return [{ id: ws, status }]; },
  };
  const orchestrator = {
    async stopSession(id: string) { calls.push(`stopSession:${id}`); },
    async deleteSessionResources(id: string) { calls.push(`deletePvc:${id}`); },
    async deleteEnvironmentResources(id: string) { calls.push(`deleteEgress:${id}`); },
    async deleteVaultSecret(id: string) { calls.push(`deleteSecret:${id}`); },
  } as any;
  const files = {
    async del(id: string) { calls.push(`s3del:${id}`); },
    async abortUpload(fileId: string, key: string) { calls.push(`abort:${fileId}:${key}`); },
  } as any;
  return { ws, repo, orchestrator, files, calls, tables, get status() { return status; } };
}

test("drains everything in FK order and tombstones the row", async () => {
  const f = fixtures();
  await runWorkspaceDelete(f.repo, f.orchestrator, f.files, f.ws);

  // All tables empty; workspace tombstoned.
  for (const [name, t] of Object.entries(f.tables)) assert.equal(t.size, 0, `${name} drained`);
  assert.equal(f.status, "deleted");

  // Sessions: pods stopped + PVCs deleted before the row goes.
  assert.ok(f.calls.indexOf("stopSession:sesn_1") < f.calls.indexOf("deleteSession:sesn_1"));
  assert.ok(f.calls.indexOf("deletePvc:sesn_1") < f.calls.indexOf("deleteSession:sesn_1"));
  // FK order: skills and memory stores drain before files.
  assert.ok(f.calls.indexOf("deleteSkill:skill_1") < f.calls.indexOf("deleteFile:file_abc123def456"));
  assert.ok(f.calls.indexOf("deleteMemoryStore:memstore_1") < f.calls.indexOf("deleteFile:file_abc123def456"));
  // Sessions before agents (agents→sessions is CASCADE; must not skip k8s cleanup).
  assert.ok(f.calls.indexOf("deleteSession:sesn_2") < f.calls.indexOf("deleteAgent:agent_1"));
  // K8s teardown per env/vault.
  assert.ok(f.calls.includes("deleteEgress:env_1"));
  assert.ok(f.calls.includes("deleteSecret:vlt_1"));
  // Keys soft-deleted; uploads aborted; tombstone LAST.
  assert.ok(f.calls.includes("softDeleteKeys"));
  assert.ok(f.calls.includes("abort:file_up1:k"));
  assert.equal(f.calls.at(-1), "status:deleted");

  // S3 objects: new-format ids deleted, legacy content-addressed ids leaked
  // (may be shared across workspaces from the dedup era).
  assert.ok(f.calls.includes("s3del:file_abc123def456"));
  assert.ok(!f.calls.some((c) => c === "s3del:file_" + "a".repeat(64)));
});

test("idempotent: a second run over a drained workspace is a no-op + tombstone", async () => {
  const f = fixtures();
  await runWorkspaceDelete(f.repo, f.orchestrator, f.files, f.ws);
  const before = f.calls.length;
  await runWorkspaceDelete(f.repo, f.orchestrator, f.files, f.ws);
  // Second run: only the constant-cost steps (webhooks, keys, tombstone) repeat.
  assert.ok(f.calls.length - before <= 4);
  assert.equal(f.status, "deleted");
});

test("s3 delete failure does not abort the drain", async () => {
  const f = fixtures();
  f.files.del = async () => { throw new Error("minio down"); };
  await runWorkspaceDelete(f.repo, f.orchestrator, f.files, f.ws);
  assert.equal(f.status, "deleted");
});

test("sweep resumes 'deleting' workspaces only", async () => {
  const f = fixtures();
  await sweepDeletingWorkspaces(f.repo, f.orchestrator, f.files);
  assert.equal(f.status, "deleted"); // was 'deleting' → drained
  const g = fixtures();
  (g.repo as any).listWorkspaces = async () => [{ id: g.ws, status: "active" }];
  await sweepDeletingWorkspaces(g.repo, g.orchestrator, g.files);
  assert.equal(g.tables.sessions.size, 2); // untouched
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --test test/workspace-delete.test.ts`
Expected: FAIL — `Cannot find module '../src/workspace-delete.ts'`.

- [ ] **Step 3: Implement the runner**

Create `control-plane/src/workspace-delete.ts`:

```ts
// Workspace deletion runner (spec 2026-07-13). Drains all resources of a
// 'deleting' workspace batch-wise in FK-safe order, then tombstones the row
// (status='deleted'; id+name survive so gateway_usage stays attributable —
// gateway_usage itself is NEVER touched). Every step deletes-if-exists, so
// the runner is resumable: sweepDeletingWorkspaces (boot) re-runs half-done
// drains after a CP restart. Progress needs no bookkeeping — the deletion
// endpoint compares live row counts against the delete_totals snapshot.
import type { Orchestrator } from "./agents-api.ts";
import type { FileStore } from "./filestore.ts";

const BATCH = 100;
// Legacy content-addressed objects (file_<sha256>) may be shared across
// workspaces from the dedup era — delete rows, leak those objects (same rule
// as guardDeletable in agents-api.ts).
const objDeletable = (id: string) => /^file_[a-z0-9]{12}$/.test(id);

async function drain(repo: any, table: string, wsId: string, each: (id: string) => Promise<void>) {
  for (;;) {
    const ids: string[] = await repo.workspaceRowIds(table, wsId, BATCH);
    if (!ids.length) return;
    for (const id of ids) await each(id);
  }
}

export async function runWorkspaceDelete(repo: any, orchestrator: Orchestrator, files: FileStore, wsId: string) {
  const delObj = async (fid: string) => {
    if (objDeletable(fid)) await Promise.resolve(files.del?.(fid)).catch(() => {});
  };
  // 1. Sessions: stop pods + drop /work PVCs BEFORE the row (the agents→
  //    sessions CASCADE can't do k8s cleanup — same pattern as agent delete).
  await drain(repo, "sessions", wsId, async (id) => {
    await Promise.allSettled([orchestrator.stopSession(id), orchestrator.deleteSessionResources(id)]);
    for (const fid of await repo.deleteSession(wsId, id)) await delObj(fid);
  });
  // 2+3. Skills and memory stores before files: their file_id FKs are
  //      RESTRICT (migrations 005/006). Entry rows cascade with the store;
  //      the file rows they referenced fall to step 4.
  await drain(repo, "skills", wsId, (id) => repo.deleteSkill(wsId, id));
  await drain(repo, "memory_stores", wsId, (id) => repo.deleteMemoryStore(wsId, id));
  // 4. Remaining files (uploads, outputs, checkpoints, skill/memory blobs).
  await drain(repo, "files", wsId, async (id) => {
    await repo.deleteFile(wsId, id);
    await delObj(id);
  });
  // 5. Environments: egress proxy + NetworkPolicy per env, then rows
  //    (agent_versions.environment_id is SET NULL).
  await drain(repo, "environments", wsId, async (id) => {
    await orchestrator.deleteEnvironmentResources(id);
    await repo.deleteEnvironment(wsId, id);
  });
  // 6. Vaults: k8s Secret per vault; credential rows cascade.
  await drain(repo, "vaults", wsId, async (id) => {
    await orchestrator.deleteVaultSecret(id);
    await repo.deleteVault(wsId, id);
  });
  // 7. Agents (versions cascade; sessions already gone) + 8. webhooks.
  await drain(repo, "agents", wsId, (id) => repo.deleteAgent(wsId, id));
  await repo.deleteWorkspaceWebhooks(wsId);
  // 9. API keys: SOFT delete — names survive for Usage attribution.
  await repo.softDeleteWorkspaceApiKeys(wsId);
  // 10. Chunked uploads: abort multipart parts, then rows. (Their workspace
  //     CASCADE never fires — the tombstone row survives.)
  for (const u of await repo.listWorkspaceFileUploads(wsId)) {
    await Promise.resolve(files.abortUpload?.(u.file_id, u.upload_key)).catch(() => {});
    await repo.deleteFileUpload(u.id);
  }
  // 11. Tombstone.
  await repo.setWorkspaceStatus(wsId, "deleted");
}

/** Boot sweep: resume drains interrupted by a CP restart. */
export async function sweepDeletingWorkspaces(repo: any, orchestrator: Orchestrator, files: FileStore) {
  for (const w of await repo.listWorkspaces(true)) {
    if (w.status !== "deleting") continue;
    await runWorkspaceDelete(repo, orchestrator, files, w.id)
      .catch((err: unknown) => console.warn(`workspace delete resume ${w.id} failed:`, err));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd control-plane && node --test test/workspace-delete.test.ts`
Expected: PASS (4 tests). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/workspace-delete.ts control-plane/test/workspace-delete.test.ts
git commit -m "feat(cp): resumable batched workspace deletion runner"
```

---

### Task 5: Management routes + guard wiring + boot sweep

**Files:**
- Modify: `control-plane/src/agents-api.ts` (workspace routes at lines 106-111; hook near the `ws` helper at line 92)
- Modify: `control-plane/src/public-api.ts` (add hook after `apiKeyAuth` at line 50)
- Modify: `control-plane/src/main.ts` (boot sweep after `registerPublicApi`, line ~109)
- Test: `control-plane/test/workspace-api.test.ts`

**Interfaces:**
- Consumes: `workspaceGuard/CONSOLE_RULES/PUBLIC_RULES` (Task 3), `runWorkspaceDelete/sweepDeletingWorkspaces` (Task 4), repo methods (Tasks 1-2), `DEFAULT_WORKSPACE` from `./repo.ts`.
- Produces HTTP contract (console Tasks 7-8 call these):
  - `GET /v1/workspaces[?include=deleted]` → `{ workspaces: [{ id, name, status, created_at, ... }] }`
  - `PATCH /v1/workspaces/:id` body `{name}` → 200 `{ok}` | 400 | 404 | 409
  - `POST /v1/workspaces/:id/status` body `{status}` → 200 `{ok}` | 400 | 404 | 409
  - `GET /v1/workspaces/:id/resources` → `{ counts: Record<string, number> }`
  - `DELETE /v1/workspaces/:id` → 202 `{ok, status: "deleting"}` | 400 | 404
  - `GET /v1/workspaces/:id/deletion` → `{ status, resources: { [type]: { total, remaining, state: "done"|"draining" } } }`

- [ ] **Step 1: Write the failing test**

Create `control-plane/test/workspace-api.test.ts`. The fake repo tracks one workspace map plus the drain-helper surface the runner needs (empty workspace → runner completes instantly):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerAgentRoutes } from "../src/agents-api.ts";

function fakes() {
  const workspaces = new Map<string, any>([
    ["wrkspc_default", { id: "wrkspc_default", name: "Default workspace", status: "active", delete_totals: null }],
    ["wrkspc_a", { id: "wrkspc_a", name: "team-a", status: "active", delete_totals: null }],
  ]);
  const repo = {
    async listWorkspaces(all = false) {
      return [...workspaces.values()].filter((w) => all || w.status !== "deleted");
    },
    async createWorkspace(name: string) {
      const w = { id: `wrkspc_${workspaces.size}`, name, status: "active", delete_totals: null };
      workspaces.set(w.id, w); return { id: w.id, name };
    },
    async getWorkspace(id: string) { return workspaces.get(id) ?? null; },
    async renameWorkspace(id: string, name: string) {
      const w = workspaces.get(id);
      if (!w || w.status === "deleted") return "notfound";
      if ([...workspaces.values()].some((x) => x.id !== id && x.status !== "deleted" && x.name === name)) return "conflict";
      w.name = name; return "ok";
    },
    async setWorkspaceStatus(id: string, status: string) {
      const w = workspaces.get(id); if (!w) return false; w.status = status; return true;
    },
    async beginWorkspaceDelete(id: string, totals: any) {
      const w = workspaces.get(id);
      if (w && !["deleting", "deleted"].includes(w.status)) { w.status = "deleting"; w.delete_totals = totals; }
    },
    counts: { sessions: 3, agents: 1 } as Record<string, number>,
    async workspaceResourceCounts() { return { ...(this as any).counts }; },
    // Drain surface — empty workspace, runner no-ops through it.
    async workspaceRowIds() { return []; },
    async deleteWorkspaceWebhooks() {},
    async softDeleteWorkspaceApiKeys() {},
    async listWorkspaceFileUploads() { return []; },
    async listWebhooks() { return []; },
  } as any;
  const orchestrator = {
    async stopSession() {}, async deleteSessionResources() {},
    async deleteEnvironmentResources() {}, async deleteVaultSecret() {},
  } as any;
  const files = { async del() {} } as any;
  return { repo, orchestrator, files, workspaces };
}

async function makeApp(f = fakes()) {
  const app = Fastify();
  await registerAgentRoutes(app, f.repo, f.orchestrator, f.files);
  return { app, ...f };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), "condition not reached");
};

test("rename: ok / default-protected / conflict / notfound", async () => {
  const { app } = await makeApp();
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/workspaces/wrkspc_a", payload: { name: "team-b" } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/workspaces/wrkspc_default", payload: { name: "x" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/workspaces/wrkspc_a", payload: { name: "Default workspace" } })).statusCode, 409);
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/workspaces/wrkspc_nope", payload: { name: "x" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/workspaces/wrkspc_a", payload: {} })).statusCode, 400);
});

test("status: disable/enable, default protected, deleting locked", async () => {
  const { app, workspaces } = await makeApp();
  assert.equal((await app.inject({ method: "POST", url: "/v1/workspaces/wrkspc_a/status", payload: { status: "disabled" } })).statusCode, 200);
  assert.equal(workspaces.get("wrkspc_a").status, "disabled");
  assert.equal((await app.inject({ method: "POST", url: "/v1/workspaces/wrkspc_a/status", payload: { status: "bogus" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/v1/workspaces/wrkspc_default/status", payload: { status: "disabled" } })).statusCode, 400);
  workspaces.get("wrkspc_a").status = "deleting";
  assert.equal((await app.inject({ method: "POST", url: "/v1/workspaces/wrkspc_a/status", payload: { status: "active" } })).statusCode, 409);
});

test("resources endpoint returns counts", async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: "GET", url: "/v1/workspaces/wrkspc_a/resources" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).counts, { sessions: 3, agents: 1 });
});

test("delete: 202, snapshots totals, runner tombstones; repeat 202; default 400", async () => {
  const { app, workspaces } = await makeApp();
  const res = await app.inject({ method: "DELETE", url: "/v1/workspaces/wrkspc_a" });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(workspaces.get("wrkspc_a").delete_totals, { sessions: 3, agents: 1 });
  await until(() => workspaces.get("wrkspc_a").status === "deleted"); // empty ws drains instantly
  // Tombstone: repeat delete → 404 (already deleted); default → 400.
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/workspaces/wrkspc_a" })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/workspaces/wrkspc_default" })).statusCode, 400);
});

test("deletion progress: draining vs done states, deleted → all done", async () => {
  const f = fakes();
  const { app, workspaces, repo } = await makeApp(f);
  workspaces.get("wrkspc_a").status = "deleting";
  workspaces.get("wrkspc_a").delete_totals = { sessions: 3, agents: 1 };
  repo.counts = { sessions: 1, agents: 0 };
  const res = await app.inject({ method: "GET", url: "/v1/workspaces/wrkspc_a/deletion" });
  const body = JSON.parse(res.body);
  assert.equal(body.status, "deleting");
  assert.deepEqual(body.resources.sessions, { total: 3, remaining: 1, state: "draining" });
  assert.deepEqual(body.resources.agents, { total: 1, remaining: 0, state: "done" });
  // Repeat DELETE while deleting: idempotent 202, no second runner kick
  // (status stays 'deleting'; the route skips beginWorkspaceDelete/runner).
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/workspaces/wrkspc_a" })).statusCode, 202);
  assert.equal(workspaces.get("wrkspc_a").status, "deleting");
  workspaces.get("wrkspc_a").status = "deleted";
  const done = JSON.parse((await app.inject({ method: "GET", url: "/v1/workspaces/wrkspc_a/deletion" })).body);
  assert.equal(done.status, "deleted");
  assert.deepEqual(done.resources.sessions, { total: 3, remaining: 0, state: "done" });
});

test("list: excludes deleted by default, include=deleted shows tombstones, rows carry status", async () => {
  const { app, workspaces } = await makeApp();
  workspaces.get("wrkspc_a").status = "deleted";
  const live = JSON.parse((await app.inject({ method: "GET", url: "/v1/workspaces" })).body).workspaces;
  assert.ok(!live.some((w: any) => w.id === "wrkspc_a"));
  assert.equal(live[0].status, "active");
  const all = JSON.parse((await app.inject({ method: "GET", url: "/v1/workspaces?include=deleted" })).body).workspaces;
  assert.ok(all.some((w: any) => w.id === "wrkspc_a"));
});

test("guard wired: write to disabled workspace 409s, interrupt-style exemption intact", async () => {
  const { app, workspaces } = await makeApp();
  workspaces.get("wrkspc_a").status = "disabled";
  const h = { "x-devproof-workspace": "wrkspc_a" };
  const blocked = await app.inject({ method: "POST", url: "/v1/agents", headers: h, payload: { name: "x", model: "m" } });
  assert.equal(blocked.statusCode, 409);
  assert.equal(JSON.parse(blocked.body).error, "workspace disabled");
  // Management routes stay usable while disabled (re-enable path).
  assert.equal((await app.inject({ method: "POST", url: "/v1/workspaces/wrkspc_a/status", headers: h, payload: { status: "active" } })).statusCode, 200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --test test/workspace-api.test.ts`
Expected: rename/status/resources/delete/deletion tests FAIL with 404s (routes don't exist); guard test FAILs (no hook → agent create hits deeper repo methods and 500s or 409 is missing).

- [ ] **Step 3: Implement routes + guard in agents-api.ts**

In `control-plane/src/agents-api.ts`:

(a) Add imports at the top:

```ts
import { DEFAULT_WORKSPACE } from "./repo.ts";
import { workspaceGuard, CONSOLE_RULES } from "./workspace-guard.ts";
import { runWorkspaceDelete } from "./workspace-delete.ts";
```

(b) Directly after the `ws` helper (line 92), register the guard. It must be added BEFORE route registrations (Fastify hooks only apply to routes registered after them):

```ts
  // Disabled/deleting workspaces are read-only (spec 2026-07-13): writes to
  // workspace-scoped routes 409; interrupt + runner callbacks stay open
  // (CONSOLE_RULES). Registered before routes — hooks don't apply retroactively.
  app.addHook("preHandler", workspaceGuard(repo, ws, CONSOLE_RULES));
```

(c) Replace the `GET /v1/workspaces` route (line 106) and add the management routes after `POST /v1/workspaces` (line 111):

```ts
  app.get("/v1/workspaces", async (req) => ({
    workspaces: await repo.listWorkspaces((req.query as any)?.include === "deleted") }));

  app.patch("/v1/workspaces/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name?.trim()) return reply.code(400).send({ error: "name required" });
    if (id === DEFAULT_WORKSPACE) return reply.code(400).send({ error: "the default workspace cannot be renamed" });
    const r = await repo.renameWorkspace(id, name.trim());
    if (r === "conflict") return reply.code(409).send({ error: "a workspace with that name already exists" });
    if (r === "notfound") return reply.code(404).send({ error: "workspace not found" });
    return { ok: true };
  });

  app.post("/v1/workspaces/:id/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status } = (req.body ?? {}) as { status?: string };
    if (!["active", "disabled"].includes(status ?? "")) return reply.code(400).send({ error: "bad status" });
    if (id === DEFAULT_WORKSPACE) return reply.code(400).send({ error: "the default workspace cannot be disabled" });
    const w = await repo.getWorkspace(id);
    if (!w || w.status === "deleted") return reply.code(404).send({ error: "workspace not found" });
    if (w.status === "deleting") return reply.code(409).send({ error: "workspace is being deleted" });
    await repo.setWorkspaceStatus(id, status!);
    return { ok: true };
  });

  app.get("/v1/workspaces/:id/resources", async (req, reply) => {
    const w = await repo.getWorkspace((req.params as any).id);
    if (!w || w.status === "deleted") return reply.code(404).send({ error: "workspace not found" });
    return { counts: await repo.workspaceResourceCounts(w.id) };
  });

  app.delete("/v1/workspaces/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === DEFAULT_WORKSPACE) return reply.code(400).send({ error: "the default workspace cannot be deleted" });
    const w = await repo.getWorkspace(id);
    if (!w || w.status === "deleted") return reply.code(404).send({ error: "workspace not found" });
    if (w.status !== "deleting") {
      await repo.beginWorkspaceDelete(id, await repo.workspaceResourceCounts(id));
      // Fire-and-forget: 202 now, progress via GET /deletion; a crash mid-
      // drain is resumed by the boot sweep (main.ts).
      void runWorkspaceDelete(repo, orchestrator, files, id)
        .catch((err) => console.warn(`workspace delete ${id} failed (boot sweep resumes):`, err));
    }
    return reply.code(202).send({ ok: true, status: "deleting" });
  });

  app.get("/v1/workspaces/:id/deletion", async (req, reply) => {
    const w = await repo.getWorkspace((req.params as any).id);
    if (!w) return reply.code(404).send({ error: "workspace not found" });
    const totals: Record<string, number> = w.delete_totals ?? {};
    const remaining = w.status === "deleted" ? {} : await repo.workspaceResourceCounts(w.id);
    const resources = Object.fromEntries(Object.entries(totals).map(([k, total]) => {
      const rem = (remaining as Record<string, number>)[k] ?? 0;
      return [k, { total, remaining: rem, state: rem === 0 ? "done" : "draining" }];
    }));
    return { status: w.status, resources };
  });
```

Type note: `repo` is typed as `Repo` in `registerAgentRoutes` — the new repo methods exist from Tasks 1-2, so this typechecks.

(d) In `control-plane/src/public-api.ts`, inside the `app.register(async (api) => {` block, directly after `api.addHook("preHandler", apiKeyAuth(repo));` (line 50):

```ts
    // Disabled workspaces are read-only on the public surface too. The dpk
    // key resolves the workspace; interrupt + POST-stream reads stay open.
    api.addHook("preHandler", workspaceGuard(repo, (req: any) => req.apiKey?.workspaceId ?? null, PUBLIC_RULES));
```

with the import at the top of public-api.ts:

```ts
import { workspaceGuard, PUBLIC_RULES } from "./workspace-guard.ts";
```

(e) In `control-plane/src/main.ts`, after the `sweepStaleUploads` lines (~112), add:

```ts
// Resume workspace drains interrupted by a restart (runner is idempotent).
sweepDeletingWorkspaces(repo, orchestrator, files).catch((err) => console.warn("workspace delete sweep failed:", err));
```

with the import:

```ts
import { sweepDeletingWorkspaces } from "./workspace-delete.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && node --test test/workspace-api.test.ts`
Expected: PASS (7 tests).
Then the full suite + types: `npm test && npx tsc --noEmit`
Expected: the guard WILL break existing fake-repo suites — their fakes lack `getWorkspace`, so every guarded write now 500s with `repo.getWorkspace is not a function`. Fix by adding one line to each affected fake repo (at minimum the `fakes()` in `test/agents-api.test.ts:15` and the public-api test fakes; run the suite to find any others):

```ts
    async getWorkspace(id: string) { return { id, status: "active" }; },
```

Re-run until all green. Do NOT weaken the guard to tolerate a missing method — a real repo always has it.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/src/public-api.ts control-plane/src/main.ts control-plane/test/workspace-api.test.ts
git commit -m "feat(cp): workspace management API + read-only guard on both surfaces"
```

---

### Task 6: Gateway auth rejects keys of non-active workspaces

**Files:**
- Modify: `deploy/gateway/litellm.yaml` (custom_callbacks.py, `user_custom_auth`, line ~266)

**Interfaces:**
- Consumes: `workspaces.status` (Task 1 migration).
- Produces: dpk keys of disabled/deleting/deleted workspaces fail gateway auth within the 30s cache TTL. Internal session-pod key path (line 245) is untouched — running sessions keep completing.

- [ ] **Step 1: Edit the auth query**

In `deploy/gateway/litellm.yaml` custom_callbacks.py, replace:

```python
            row = await pool.fetchrow(
                "SELECT id, workspace_id FROM api_keys WHERE secret_hash = $1 AND status = 'active'", h)
```

with:

```python
            # Key AND its workspace must be active (workspace disable = read-only,
            # spec 2026-07-13). Internal session-pod key bypasses above.
            row = await pool.fetchrow(
                """SELECT k.id, k.workspace_id FROM api_keys k
                   JOIN workspaces w ON w.id = k.workspace_id AND w.status = 'active'
                   WHERE k.secret_hash = $1 AND k.status = 'active'""", h)
```

- [ ] **Step 2: Apply + restart the gateway**

```bash
kubectl apply -f deploy/gateway/litellm.yaml
kubectl -n devproof-gateway rollout restart deploy/gateway
kubectl -n devproof-gateway rollout status deploy/gateway --timeout=180s
```

Expected: rollout completes; `kubectl -n devproof-gateway logs deploy/gateway --tail=20` shows no Python syntax errors.

- [ ] **Step 3: Live check**

With a key from an ACTIVE workspace (create one on the API Keys page if needed):

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:14000/v1/models -H "Authorization: Bearer dpk_<active-ws-key>"
```

Expected: `200`. Full disabled-workspace check happens in Task 9 (needs the console toggle).

- [ ] **Step 4: Commit**

```bash
git add deploy/gateway/litellm.yaml
git commit -m "feat(gateway): auth requires the key's workspace to be active"
```

---

### Task 7: Console — shared create-modal, workspace picker, nav/layout

**Files:**
- Create: `console/app/lib/workspace-modal.tsx` (extracted from nav.tsx)
- Create: `console/app/lib/ws-picker.tsx`
- Modify: `console/app/nav.tsx`, `console/app/layout.tsx`, `console/app/lib/icons.tsx`, `console/app/globals.css`

**Interfaces:**
- Consumes: `GET /v1/workspaces` rows now carry `status` (Task 5); existing `Modal`/`Field` (`lib/modal.tsx`), `hashHue` pattern (`lib/mcp-picker.tsx`), CSS vars (`--panel/--edge/--hover/--muted/--ink/--line/--f-mono`).
- Produces:
  - `WorkspaceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void })` in `lib/workspace-modal.tsx`
  - `WorkspacePicker({ workspaces, current }: { workspaces: WsEntry[]; current: string })` with `WsEntry = { id: string; name: string; status: string }` in `lib/ws-picker.tsx`
  - `Icon.workspace` icon; `Nav` props become `workspaces: WsEntry[]`

- [ ] **Step 1: Extract WorkspaceModal**

Create `console/app/lib/workspace-modal.tsx` — move the `WorkspaceModal` function from `nav.tsx:72-99` verbatim, adding `"use client";`, the imports, and `export`:

```tsx
"use client";
// Shared "New workspace" dialog — used by the nav switcher and /workspaces.
import { useState } from "react";
import { Modal, Field } from "./modal";

export function WorkspaceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/v1/workspaces", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      if (res.ok) { onCreated((await res.json()).id); return; }
      setError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    } catch (err) { setError(String(err)); }
    setBusy(false);
  };
  return (
    <Modal title="New workspace" width="sm" onClose={onClose} busy={busy} error={error}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || !name.trim()} onClick={submit}>{busy ? "Creating…" : "Create workspace"}</button>
      </>}>
      <Field label="Name" required hint="every resource is scoped to a workspace">
        <input value={name} onChange={(e) => setName(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && submit()} placeholder="team-research" />
      </Field>
    </Modal>
  );
}
```

- [ ] **Step 2: Create the picker**

Create `console/app/lib/ws-picker.tsx`:

```tsx
"use client";
// Workspace switcher (spec 2026-07-13): MCP-picker-style dropdown — colored
// initial tile + name, workspace id in small gray mono beneath.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { WorkspaceModal } from "./workspace-modal";

export interface WsEntry { id: string; name: string; status: string }

// Deterministic id -> hue (same trick as the MCP picker's logo tiles).
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function Tile({ w }: { w: WsEntry }) {
  return (
    <span className="ws-tile" aria-hidden style={{ background: `hsl(${hashHue(w.id)}, 45%, 38%)` }}>
      {w.name.charAt(0).toUpperCase()}
    </span>
  );
}

export function WorkspacePicker({ workspaces, current }: { workspaces: WsEntry[]; current: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [create, setCreate] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cur = workspaces.find((w) => w.id === current) ?? workspaces[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const switchTo = (id: string) => {
    document.cookie = `devproof_ws=${encodeURIComponent(id)}; path=/; max-age=31536000`;
    setOpen(false);
    router.refresh();
  };

  return (
    <div className="ws-picker" ref={wrapRef}>
      <button className="ws-current" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <Tile w={cur} />
        <span className="ws-text"><strong>{cur.name}</strong><span className="ws-id">{cur.id}</span></span>
        <span className="ws-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="ws-panel" role="listbox">
          {workspaces.map((w) => (
            <button key={w.id} role="option" aria-selected={w.id === current}
                    className={`ws-option${w.id === current ? " active" : ""}`} onClick={() => switchTo(w.id)}>
              <Tile w={w} />
              <span className="ws-text"><strong>{w.name}</strong><span className="ws-id">{w.id}</span></span>
              {w.status === "disabled" && <span className="ws-flag">disabled</span>}
            </button>
          ))}
          <button className="ws-option ws-new" onClick={() => { setOpen(false); setCreate(true); }}>
            + New workspace…
          </button>
        </div>
      )}
      {create && <WorkspaceModal onClose={() => setCreate(false)}
                                 onCreated={(id) => { setCreate(false); switchTo(id); }} />}
    </div>
  );
}
```

- [ ] **Step 3: Rewire nav.tsx and layout.tsx**

`console/app/nav.tsx`:
- Delete the local `WorkspaceModal` function (lines 72-99), the `wsModal` state, `switchWorkspace`, and the `Modal, Field` import.
- Replace the `<div className="ws">…</div>` block (lines 46-52) with:

```tsx
      <div className="ws">
        <label>Workspace</label>
        <WorkspacePicker workspaces={workspaces} current={current} />
        {workspaces.find((w) => w.id === current)?.status === "disabled" &&
          <div className="ws-banner">Workspace disabled — read-only</div>}
      </div>
```

- Change the props type: `workspaces: { id: string; name: string; status: string }[]`, import `WorkspacePicker` from `./lib/ws-picker`.
- Add Workspaces to the Manage group (line 26):

```ts
  { title: "Manage", items: [["API keys", "/api-keys", "key"], ["Workspaces", "/workspaces", "workspace"]] },
```

`console/app/layout.tsx` — deleted/unknown-cookie fallback (replace lines 15-20):

```tsx
  let workspaces = [{ id: "wrkspc_default", name: "Default workspace", status: "active" }];
  try {
    const r = await wsGet<{ workspaces: any[] }>("/v1/workspaces");
    if (r?.workspaces?.length) workspaces = r.workspaces;
  } catch { /* control plane may be down; show default */ }
  const cookie = await currentWorkspace();
  // Cookie may point at a deleting/deleted workspace — fall back to default.
  const current = workspaces.some((w) => w.id === cookie) ? cookie : "wrkspc_default";
```

`console/app/lib/icons.tsx` — add after `key:` (a briefcase, Lucide-style):

```tsx
  workspace: () => <S><rect x="2" y="7" width="20" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M2 13h20" /></S>,
```

- [ ] **Step 4: Add CSS**

Append to `console/app/globals.css` (patterned on the `.mcp-picker` block at ~line 509; the panel is absolutely positioned because the sidebar has no room to expand inline):

```css
/* Workspace switcher (spec 2026-07-13): MCP-picker-style dropdown in the nav */
.ws-picker { position: relative; }
.ws-current { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  font-family: inherit; background: var(--panel); color: var(--ink);
  border: 1px solid var(--edge); border-radius: 4px; padding: 5px 8px; font-size: 13px; cursor: pointer; }
.ws-current:hover { background: var(--hover); border-color: var(--blue); }
.ws-tile { flex: 0 0 auto; width: 24px; height: 24px; border-radius: 4px; display: flex;
  align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 12px; }
.ws-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.ws-text strong { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-id { font-family: var(--font-mono); font-size: 10px; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-caret { color: var(--muted); }
.ws-panel { position: absolute; z-index: 40; left: 0; right: 0; margin-top: 4px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .25); display: flex; flex-direction: column; gap: 2px;
  max-height: 320px; overflow-y: auto; }
.ws-option { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  font-family: inherit; background: var(--panel); color: var(--ink);
  border: 1px solid transparent; border-radius: 4px; padding: 5px 6px; font-size: 13px; cursor: pointer; }
.ws-option:hover { border-color: var(--accent); background: var(--hover); }
.ws-option.active { border-color: var(--blue); }
.ws-flag { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--bad); }
.ws-new { color: var(--muted); justify-content: center; }
.ws-banner { margin-top: 6px; padding: 4px 8px; font-size: 11px; border: 1px solid var(--edge);
  border-radius: 4px; color: var(--muted); background: var(--thead); }
```

- [ ] **Step 5: Build + verify + commit**

```bash
cd console && npx next build
```
Expected: build succeeds. Restart `npx next start -p 7090` (a running `next start` pins old chunk hashes — always restart after build), then in the browser: the switcher shows tile + name + gray id, dropdown lists workspaces, "+ New workspace…" opens the modal, switching refreshes data.

```bash
git add console/app/lib/workspace-modal.tsx console/app/lib/ws-picker.tsx console/app/nav.tsx console/app/layout.tsx console/app/lib/icons.tsx console/app/globals.css
git commit -m "feat(console): workspace picker dropdown + shared create modal + nav entry"
```

---

### Task 8: Console — /workspaces management page

**Files:**
- Create: `console/app/workspaces/page.tsx`
- Create: `console/app/workspaces/actions.tsx`
- Modify: `console/app/globals.css` (progress-panel styles)

**Interfaces:**
- Consumes: Task 5 HTTP contract; `Modal/Field/ConfirmDialog/submitJson` (`lib/modal.tsx`), `apiGet` (`lib/client.ts`), `Pager` (`lib/pager.tsx`), `wsGet` (`lib/api.ts`), `WorkspaceModal` (Task 7).
- Produces: `/workspaces` page. Conventions: the full id is the clickable element (opens the edit/rename modal — environments pattern); names are plain text; status badge reuses the `phase` classes from api-keys.

- [ ] **Step 1: Server page**

Create `console/app/workspaces/page.tsx`:

```tsx
import { wsGet } from "../lib/api";
import { WorkspaceRowActions, WorkspaceIdButton, NewWorkspaceButton, DeletionCell } from "./actions";

export const dynamic = "force-dynamic";

export default async function WorkspacesPage() {
  const { workspaces } = await wsGet<{ workspaces: any[] }>("/v1/workspaces")
    .catch(() => ({ workspaces: [] as any[] }));
  return (
    <>
      <div className="pagehead"><h1>Workspaces</h1><NewWorkspaceButton /></div>
      <p className="sub">
        Every resource is scoped to a workspace. Disabling makes a workspace read-only (running
        sessions still complete); deleting removes all its resources — usage history stays
        attributed to the workspace name and id.
      </p>
      <div className="tablewrap"><table>
        <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Created</th><th></th></tr></thead>
        <tbody>
          {workspaces.map((w: any) => (
            <tr key={w.id}>
              <td><WorkspaceIdButton ws={w} /></td>
              <td>{w.name}</td>
              <td>
                <span className={`phase ${w.status === "active" ? "Ready" : "bad"}`}>{w.status}</span>
                {w.status === "deleting" && <DeletionCell id={w.id} />}
              </td>
              <td>{new Date(w.created_at).toLocaleString()}</td>
              <td><WorkspaceRowActions ws={w} /></td>
            </tr>
          ))}
          {workspaces.length === 0 && <tr><td colSpan={5} className="empty">No workspaces.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
```

(No `Pager`: `GET /v1/workspaces` is unpaginated — the switcher needs the full list anyway and workspace counts are tiny. If that changes, paginate API + page together.)

- [ ] **Step 2: Client actions**

Create `console/app/workspaces/actions.tsx`:

```tsx
"use client";
// Row actions for /workspaces: rename (opened from the id — environments
// convention), enable/disable, delete with typed-name confirm + live
// deletion progress. Default workspace shows no actions.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Field, submitJson } from "../lib/modal";
import { apiGet } from "../lib/client";
import { Icon } from "../lib/icons";
import { WorkspaceModal } from "../lib/workspace-modal";

const DEFAULT_WS = "wrkspc_default";
const LABELS: Record<string, string> = {
  sessions: "sessions", skills: "skills", memory_stores: "memory stores", files: "files",
  environments: "environments", vaults: "vaults", agents: "agents", webhooks: "webhooks",
  api_keys: "API keys", file_uploads: "pending uploads",
};

export function NewWorkspaceButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}>New workspace</button>
    {open && <WorkspaceModal onClose={() => setOpen(false)}
                             onCreated={() => { setOpen(false); router.refresh(); }} />}
  </>);
}

/** Full id as the clickable element — opens the rename modal (env convention). */
export function WorkspaceIdButton({ ws }: { ws: { id: string; name: string; status: string } }) {
  const [open, setOpen] = useState(false);
  const immutable = ws.id === DEFAULT_WS || ws.status === "deleting";
  if (immutable) return <code>{ws.id}</code>;
  return (<>
    <button className="linklike" onClick={() => setOpen(true)}><code>{ws.id}</code></button>
    {open && <RenameDialog ws={ws} onClose={() => setOpen(false)} />}
  </>);
}

function RenameDialog({ ws, onClose }: { ws: { id: string; name: string }; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(ws.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    const err = await submitJson("PATCH", `/v1/workspaces/${ws.id}`, { name: name.trim() });
    setBusy(false);
    if (err) return setError(err);
    onClose(); router.refresh();
  };
  return (
    <Modal title="Edit workspace" subtitle={ws.id} width="sm" onClose={onClose} busy={busy} error={error}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || !name.trim() || name.trim() === ws.name} onClick={submit}>
          {busy ? "Saving…" : "Save"}</button>
      </>}>
      <Field label="Name" required>
        <input value={name} onChange={(e) => setName(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && submit()} />
      </Field>
    </Modal>
  );
}

export function WorkspaceRowActions({ ws }: { ws: { id: string; name: string; status: string } }) {
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (ws.id === DEFAULT_WS || ws.status === "deleting") return null;
  const toggle = async () => {
    const err = await submitJson("POST", `/v1/workspaces/${ws.id}/status`,
      { status: ws.status === "active" ? "disabled" : "active" });
    if (!err) router.refresh();
  };
  return (
    <div className="rowactions">
      <button className="iconbtn" title={ws.status === "active" ? "Disable (read-only)" : "Enable"}
              aria-label={ws.status === "active" ? "Disable" : "Enable"} onClick={toggle}>
        {ws.status === "active" ? <Icon.pause /> : <Icon.play />}
      </button>
      <button className="iconbtn danger" title="Delete" aria-label="Delete" onClick={() => setConfirmDelete(true)}>
        <Icon.trash />
      </button>
      {confirmDelete && <DeleteDialog ws={ws} onClose={() => setConfirmDelete(false)} />}
    </div>
  );
}

/** Destructive confirm: shows what will be destroyed, requires the name typed back. */
function DeleteDialog({ ws, onClose }: { ws: { id: string; name: string }; onClose: () => void }) {
  const router = useRouter();
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiGet<{ counts: Record<string, number> }>(`/v1/workspaces/${ws.id}/resources`)
      .then((r) => setCounts(r.counts)).catch(() => setCounts({}));
  }, [ws.id]);
  const submit = async () => {
    setBusy(true); setError(null);
    const err = await submitJson("DELETE", `/v1/workspaces/${ws.id}`);
    setBusy(false);
    if (err) return setError(err);
    onClose(); router.refresh(); // row flips to "deleting" with a progress cell
  };
  const doomed = counts ? Object.entries(counts).filter(([, n]) => n > 0) : [];
  return (
    <Modal title="Delete workspace" subtitle={ws.id} width="sm" onClose={onClose} busy={busy} error={error}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="danger-solid" disabled={busy || typed !== ws.name} onClick={submit}>
          {busy ? <span className="spin" /> : "Delete everything"}</button>
      </>}>
      <p className="modal-msg">
        Deletes <strong>{ws.name}</strong> and all its resources. Usage history stays attributed
        to the workspace name and id. This cannot be undone.
      </p>
      {counts === null ? <p className="modal-msg">Counting resources…</p> : (
        <ul className="ws-doomed">
          {doomed.length === 0 && <li>No resources — the workspace is empty.</li>}
          {doomed.map(([k, n]) => <li key={k}><strong>{n}</strong> {LABELS[k] ?? k}</li>)}
        </ul>
      )}
      <Field label="Type the workspace name to confirm" required>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={ws.name} />
      </Field>
    </Modal>
  );
}

/** Inline progress for a deleting row: polls until the tombstone appears. */
export function DeletionCell({ id }: { id: string }) {
  const router = useRouter();
  const [prog, setProg] = useState<{ status: string; resources: Record<string, { total: number; remaining: number; state: string }> } | null>(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await apiGet<NonNullable<typeof prog>>(`/v1/workspaces/${id}/deletion`);
        if (stop) return;
        setProg(r);
        if (r.status === "deleted") { router.refresh(); return; } // row leaves the list
      } catch { /* transient; retry */ }
      if (!stop) setTimeout(tick, 1500);
    };
    tick();
    return () => { stop = true; };
  }, [id, router]);
  if (!prog) return <span className="ws-progress"><span className="spin" /></span>;
  return (
    <ul className="ws-progress">
      {Object.entries(prog.resources).map(([k, r]) => (
        <li key={k} className={r.state === "done" ? "done" : ""}>
          {r.state === "done" ? "✓" : <span className="spin" />} {LABELS[k] ?? k}
          {r.state !== "done" && <> · {r.total - r.remaining}/{r.total}</>}
        </li>
      ))}
    </ul>
  );
}
```

Note on `className="linklike"`: check globals.css for an existing link-styled button class before adding one (grep `linklike`). If none exists, add:

```css
.linklike { background: none; border: 0; padding: 0; font: inherit; color: var(--blue); cursor: pointer; }
.linklike:hover { text-decoration: underline; }
.linklike code { color: inherit; }
```

(A link-styled button is a navigation affordance like table links — not a text button — so this doesn't violate the no-transparent-buttons rule; if a review disagrees, style it as `ghost` instead.)

- [ ] **Step 3: Progress CSS**

Append to `console/app/globals.css`:

```css
/* Workspace deletion progress (inline, in the status cell) */
.ws-progress { list-style: none; margin: 6px 0 0; padding: 0; font-size: 11.5px; color: var(--muted); }
.ws-progress li { display: flex; align-items: center; gap: 5px; }
.ws-progress li.done { color: var(--good); }
.ws-doomed { margin: 8px 0; padding-left: 18px; font-size: 13px; }
```

- [ ] **Step 4: Build + verify + commit**

```bash
cd console && npx next build
```
Expected: build succeeds. Restart `next start`, open `/workspaces`: list renders, id click opens rename (not on default/deleting), pause/play toggles status, delete requires the typed name and shows counts, a deleted workspace's row shows draining progress then disappears.

```bash
git add console/app/workspaces/ console/app/globals.css
git commit -m "feat(console): workspaces management page — rename, disable, delete with live progress"
```

---

### Task 9: Docs + full live verification

**Files:**
- Modify: `CLAUDE.md` (Conventions & gotchas)

**Interfaces:** none — verification only.

- [ ] **Step 1: CLAUDE.md convention entry**

Add a bullet to "Conventions & gotchas" after the Multi-tenancy bullet:

```markdown
- **Workspace lifecycle (spec 2026-07-13):** `workspaces.status` = `active|disabled|deleting|deleted` (migration 029; name uniqueness is a partial index over non-deleted rows). `wrkspc_default` is immutable (no rename/disable/delete). Disabled ⇒ read-only: `workspace-guard.ts` 409s workspace-scoped writes on BOTH API surfaces (exempt: interrupt, runner callbacks, `/v1/workspaces` mgmt; Serving is global and never guarded) and gateway auth JOINs `workspaces.status='active'` (≤30s cache lag); running sessions use the internal key and finish. Delete ⇒ 202 + `workspace-delete.ts` drains batch-wise in FK order (sessions→skills→memory→files→envs→vaults→agents→webhooks→keys-SOFT-deleted→uploads), resumable via boot sweep; the row survives as a TOMBSTONE (id+name keep `gateway_usage` attribution — usage rows are never touched). Progress = live row counts vs the `delete_totals` snapshot (`GET /v1/workspaces/:id/deletion`, polled by the console).
```

- [ ] **Step 2: Full backend check**

```bash
cd control-plane && npm test && npx tsc --noEmit
```
Expected: entire suite green.

- [ ] **Step 3: Live verification (repo convention: restart CP + console, exercise the flow)**

1. Restart the control plane (`npx tsx src/main.ts` with the env vars from CLAUDE.md) — migration 029 applies; boot log clean.
2. Rebuild + restart the console; confirm all pages 200.
3. Create workspace `ws-verify` via the switcher; create an environment, an agent, an API key, and start a short session in it.
4. **Disable** it on /workspaces: banner appears; agent/env/skill creation and session follow-ups 409 with "workspace disabled"; lists still load; a running session finishes and checkpoints; interrupt works on a running session.
5. Gateway: `curl http://localhost:14000/v1/models -H "Authorization: Bearer dpk_<ws-verify-key>"` → 401 within ~30s of disabling; a default-workspace key still works.
6. **Enable** again — writes work.
7. **Delete**: confirm dialog shows correct counts and requires the typed name; row flips to deleting with per-type progress; when done the row disappears; switcher no longer offers it; if it was the selected workspace, the console falls back to Default.
8. Confirm cleanup: `kubectl -n devproof-agents get jobs,pvc,secrets | grep <ids>` empty; MinIO objects gone (spot-check one file id); `SELECT status, name FROM workspaces WHERE id='<ws-id>'` → deleted tombstone with name; `SELECT count(*) FROM gateway_usage WHERE workspace_id='<ws-id>'` unchanged; API-key rows still present with status deleted.
9. Create a new workspace reusing the name `ws-verify` — succeeds (partial unique index).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: workspace lifecycle conventions (status guard, tombstone deletion)"
```
