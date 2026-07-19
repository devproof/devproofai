# Agent Lifecycle + ID Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents can be disabled/re-enabled (409 on new sessions AND follow-ups); all new entity IDs become 12-char lowercase base36; files drop content-addressing (with growth guards for checkpoints/memory); Managed Agents tables show the full ID as the clickable element; detail pages get a copy-ID button.

**Architecture:** Control plane is Fastify/TS (`control-plane/`), console is Next.js App Router (`console/`). IDs are opaque TEXT everywhere, so the format change needs no migration — old and new coexist. Spec: `docs/superpowers/specs/2026-07-10-agent-lifecycle-and-id-overhaul-design.md`.

**Tech Stack:** Node 22 + tsx + Fastify + pg (Node test runner; `test/repo.test.ts` runs against the live dev Postgres on `localhost:15432`), Next.js 15, MinIO/S3 via `@aws-sdk/client-s3`.

## Global Constraints

- New ID format: `prefix_` + exactly 12 chars of `a-z0-9` (~62 bits from `randomBytes(16)`); existing long hex IDs stay valid — both formats coexist; no data migration.
- Disabled agents: `POST /v1/sessions` and `POST /v1/sessions/:id/messages` return **409 `{error: "agent disabled"}`**; running turns are never interrupted.
- Files: duplicates are fine (user decision) — `createFileRecord` is a plain INSERT; S3 object key = the file id, with a legacy fallback read for old `file_<sha256>` ids.
- Growth guards: replacing a session checkpoint or a memory entry's file deletes the previous file row + stored object (best effort — failures logged, never surfacing to the caller).
- Click convention (Managed Agents ONLY — Catalog/Pools/Deployments untouched): full ID (never truncated) is the clickable element; names are plain text.
- Console rules: production build only; shared `Modal`/`Field`/`ConfirmDialog`; no `prompt()`/`confirm()`/`alert()`; no transparent text buttons (quiet row icon-buttons are an allowed exception — the copy button is one).
- Migrations run every boot — `020_agent_status.sql` must be idempotent (`IF NOT EXISTS`).
- Backend gate: `cd control-plane && npm test && npx tsc --noEmit`; console gate: `cd console && npx next build`.
- The controller (main session) runs all live-cluster/browser gates and server restarts — subagents must NOT start/restart services, and must NOT commit `TODO.txt` (user's uncommitted edit).

---

### Task 1: `shortId()` — base36 12-char IDs for every `rid()` caller

**Files:**
- Create: `control-plane/src/id.ts`
- Create: `control-plane/test/id.test.ts`
- Modify: `control-plane/src/repo.ts:4-8` (import + `rid`)

**Interfaces:**
- Produces: `export function shortId(): string` (12 chars `a-z0-9`). Task 2 uses it for file ids; `rid(prefix)` keeps its signature `(prefix: string) => string`.

- [ ] **Step 1: Write the failing test**

Create `control-plane/test/id.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { shortId } from "../src/id.ts";

test("shortId is exactly 12 chars of a-z0-9", () => {
  for (let i = 0; i < 1000; i++) assert.match(shortId(), /^[a-z0-9]{12}$/);
});

test("shortId does not collide over a large sample", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100_000; i++) seen.add(shortId());
  assert.equal(seen.size, 100_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npx tsx --test test/id.test.ts`
Expected: FAIL — `Cannot find module '../src/id.ts'`

- [ ] **Step 3: Implement**

Create `control-plane/src/id.ts`:

```ts
import { randomBytes } from "node:crypto";

/** Short entity id: 12 chars of base36 (a-z0-9), ~62 bits of randomness.
 *  Derived from 128 random bits, so the low 12 base36 digits are uniform to
 *  within negligible bias. Legacy 24-char hex ids coexist — IDs are opaque
 *  TEXT everywhere, so no migration is needed. */
export function shortId(): string {
  return BigInt("0x" + randomBytes(16).toString("hex"))
    .toString(36)
    .slice(-12)
    .padStart(12, "0");
}
```

In `control-plane/src/repo.ts`, add `import { shortId } from "./id.ts";` next to the existing imports and change line 8:

```ts
const rid = (prefix: string) => `${prefix}_${shortId()}`;
```

(`randomBytes` stays imported in repo.ts — `createApiKey` still uses it for the key secret.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npx tsx --test test/id.test.ts` → PASS (2/2).
Then the full gate: `npm test && npx tsc --noEmit` → all green.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/id.ts control-plane/test/id.test.ts control-plane/src/repo.ts
git commit -m "feat(cp): 12-char base36 shortId for all new entity ids"
```

---

### Task 2: Files drop content-addressing

**Files:**
- Modify: `control-plane/src/filestore.ts` (both stores)
- Modify: `control-plane/src/repo.ts` (`createFileRecord`, ~line 573)
- Test: `control-plane/test/repo.test.ts` (live-DB duplicate-rows test — mirror the file's existing setup conventions, e.g. the key-resurrection test)

**Interfaces:**
- Consumes: `shortId()` from Task 1.
- Produces: `FileStore.put` unchanged signature `{id, sha256, size}` — id is now `file_<12 base36>`; `get(id)` resolves BOTH new ids and legacy `file_<sha256>` ids.

- [ ] **Step 1: Write the failing test**

In `control-plane/test/repo.test.ts` (read the file first; reuse its pool/workspace setup pattern):

```ts
test("createFileRecord: identical metadata twice creates two independent rows", async () => {
  const a = { id: `file_${Math.random().toString(36).slice(2, 14)}`, name: "dup.txt", size: 3, sha256: "abc" };
  const b = { id: `file_${Math.random().toString(36).slice(2, 14)}`, name: "dup.txt", size: 3, sha256: "abc" };
  await repo.createFileRecord(a);
  await repo.createFileRecord(b);
  const { rows } = await pool.query("SELECT id FROM files WHERE sha256 = 'abc' AND name = 'dup.txt'");
  assert.ok(rows.length >= 2);
  await pool.query("DELETE FROM files WHERE id = ANY($1)", [[a.id, b.id]]);
});
```

(Adapt variable names to the file's conventions; the essential assertion: two INSERTs with the same sha256 both persist as separate rows.)

- [ ] **Step 2: Run to verify current behavior**

Run: `cd control-plane && npx tsx --test test/repo.test.ts`
Expected: the new test PASSES already for distinct ids — the dedup being removed keys on `id`. To pin the actual change, ALSO assert `createFileRecord` rejects a duplicate **id** loudly now (was silent no-op):

```ts
test("createFileRecord: same id twice now raises (dedup removed)", async () => {
  const m = { id: `file_${Math.random().toString(36).slice(2, 14)}`, name: "x", size: 1, sha256: "zz" };
  await repo.createFileRecord(m);
  await assert.rejects(() => repo.createFileRecord(m));
  await pool.query("DELETE FROM files WHERE id = $1", [m.id]);
});
```

This second test FAILS before the change (no rejection) — that is the red step.

- [ ] **Step 3: Implement**

`control-plane/src/repo.ts` — `createFileRecord` (~line 571): replace the comment block and the query:

```ts
  // ── Files ────────────────────────────────────────────────────────────────
  // Plain insert: ids are unique per upload; duplicate bytes create duplicate
  // rows by design (content-addressing removed 2026-07-10 — sha256 is kept as
  // an informational column only).
  async createFileRecord(meta: { id: string; name: string; size: number; sha256: string; sessionId?: string; kind?: string; workspaceId?: string }) {
    await this.pool.query(
      "INSERT INTO files (id, workspace_id, session_id, name, size, sha256, kind) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [meta.id, meta.workspaceId ?? DEFAULT_WORKSPACE, meta.sessionId ?? null, meta.name, meta.size, meta.sha256, meta.kind ?? "upload"],
    );
    return meta;
  }
```

`control-plane/src/filestore.ts`:
1. Add `import { shortId } from "./id.ts";` and drop `randomBytes` from the crypto import (keep `createHash`).
2. `localFileStore`: id becomes `` `file_${shortId()}` ``; both regexes become `/^file_[a-z0-9]+$/` (hex ⊂ a-z0-9, so legacy local ids keep working).
3. `s3FileStore`: replace the doc comment (lines 35-41) with:

```ts
/**
 * S3-compatible (MinIO) object store — the scalable file backend. Objects are
 * keyed by file id (content-addressing removed 2026-07-10: duplicates are
 * fine; sha256 is informational). Legacy ids embed their hash, so reads fall
 * back to the old hash key. Any number of control-plane replicas and session
 * pods share one bucket.
 */
```

and the methods:

```ts
    async put(content: Buffer) {
      const id = `file_${shortId()}`;
      await client.send(new PutObjectCommand({ Bucket: opts.bucket, Key: id, Body: content }));
      return { id, sha256: createHash("sha256").update(content).digest("hex"), size: content.length };
    },
    async get(id: string) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: id }));
        return streamToBuffer(res.Body);
      } catch (err: any) {
        if (err?.name !== "NoSuchKey") throw err;
        // Legacy content-addressed object: the id embeds its sha256 key.
        const res = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: id.replace(/^file_/, "") }));
        return streamToBuffer(res.Body);
      }
    },
    async del(id: string) {
      // Best effort on both key generations; deleting a missing key is a no-op in S3.
      try { await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: id })); } catch { /* ignore */ }
      try { await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: id.replace(/^file_/, "") })); } catch { /* ignore */ }
    },
```

CAUTION: legacy dedup meant one object could back MANY file rows; the old `del` comment said "only unref". With duplicates allowed, new objects are 1:1 with rows, so deleting by id is safe; the legacy-key delete only fires for old rows (acceptable: deleting a legacy file may orphan sibling rows' bytes — same behavior as today's del, do not "improve" this).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npm test && npx tsc --noEmit` → all green (both new repo tests pass).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/filestore.ts control-plane/src/repo.ts control-plane/test/repo.test.ts
git commit -m "feat(files): drop content-addressing — short ids, plain inserts, legacy-key read fallback"
```

---

### Task 3: Growth guards — checkpoint + memory replacement deletes the old file

**Files:**
- Modify: `control-plane/src/repo.ts` (`setSessionStatus` ~line 168, `upsertMemoryEntries` ~line 462; add `deleteFileRecordById`)
- Modify: `control-plane/src/agents-api.ts` (`POST /v1/sessions/:id/status` ~line 566, `POST /v1/sessions/:id/memory` ~line 350)
- Test: `control-plane/test/agents-api.test.ts`

**Interfaces:**
- Produces: `setSessionStatus(sessionId, status, extras?) → Promise<{ replacedCheckpointFileId: string | null }>`; `upsertMemoryEntries(storeId, entries, deletes?) → Promise<string[]>` (replaced/removed file ids); `deleteFileRecordById(id: string): Promise<void>` (no workspace scope — runner-callback path, same trust model as `createFileRecord` there).

- [ ] **Step 1: Write the failing route tests**

In `control-plane/test/agents-api.test.ts`, extend the fakes: the fake `files` store gains `delCalls: [] as string[]` and `async del(id: string) { this.delCalls.push(id); }`; the fake repo gains:

```ts
    async deleteFileRecordById(id: string) { (this as any).deletedFileRecords.push(id); },
    deletedFileRecords: [] as string[],
```

and make the fake `setSessionStatus` return `{ replacedCheckpointFileId: "file_old000000001" }` when `extras?.checkpointFileId` is set (else `{ replacedCheckpointFileId: null }`); the fake `upsertMemoryEntries` returns `["file_old000000002"]`.

Tests:

```ts
test("checkpoint replacement deletes the previous file row + object", async () => {
  const { app, repo, files } = await build();   // adapt to the file's builder
  await app.inject({ method: "POST", url: "/v1/sessions/sesn_x/status",
    payload: { status: "idle", checkpointFileId: "file_new000000001" } });
  assert.deepEqual(repo.deletedFileRecords, ["file_old000000001"]);
  assert.deepEqual(files.delCalls, ["file_old000000001"]);
});

test("memory upsert deletes replaced file rows + objects", async () => {
  const { app, repo, files } = await build();
  await app.inject({ method: "POST", url: "/v1/sessions/sesn_mem/status", ... });
  // Use the memory route: requires a fake session with memory_store_id — extend the fake getSession accordingly.
  await app.inject({ method: "POST", url: "/v1/sessions/sesn_mem/memory",
    payload: { entries: [{ path: "notes.md", fileId: "file_new000000002" }] } });
  assert.ok(repo.deletedFileRecords.includes("file_old000000002"));
  assert.ok(files.delCalls.includes("file_old000000002"));
});
```

(Adapt the second test to the fake `getSession` — it must return a session whose `memory_store_id` is set; read how existing memory tests do it, or extend the session fixture.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd control-plane && npm test`
Expected: FAIL — routes never call `deleteFileRecordById`/`files.del`.

- [ ] **Step 3: Implement repo changes**

`repo.ts` — `setSessionStatus` becomes (keep the notify):

```ts
  async setSessionStatus(sessionId: string, status: string, extras?: { sdkSessionId?: string; checkpointFileId?: string }) {
    // Growth guard: report the checkpoint file this update replaces so the
    // caller can delete it (dedup used to make replacements free).
    let replacedCheckpointFileId: string | null = null;
    if (extras?.checkpointFileId) {
      const { rows } = await this.pool.query("SELECT checkpoint_file_id FROM sessions WHERE id = $1", [sessionId]);
      const prev = rows[0]?.checkpoint_file_id ?? null;
      if (prev && prev !== extras.checkpointFileId) replacedCheckpointFileId = prev;
    }
    await this.pool.query(
      `UPDATE sessions SET status = $2,
         sdk_session_id = COALESCE($3, sdk_session_id),
         checkpoint_file_id = COALESCE($4, checkpoint_file_id),
         completed_at = CASE WHEN $2 IN ('completed','failed','idle') THEN now() ELSE completed_at END
       WHERE id = $1`,
      [sessionId, status, extras?.sdkSessionId ?? null, extras?.checkpointFileId ?? null],
    );
    await this.pool.query("SELECT pg_notify('devproof_session', $1)", [sessionId]);
    return { replacedCheckpointFileId };
  }
```

`upsertMemoryEntries` becomes:

```ts
  /** Diff-aware upsert: only touches paths whose file_id changed; supports
   *  deletes. Returns the file ids this call orphaned (replaced or removed)
   *  so the caller can delete their rows + objects — growth guard now that
   *  duplicate uploads are distinct files. */
  async upsertMemoryEntries(storeId: string, entries: { path: string; fileId: string }[], deletes: string[] = []) {
    const orphaned: string[] = [];
    for (const e of entries) {
      const { rows } = await this.pool.query(
        "SELECT file_id FROM memory_entries WHERE store_id = $1 AND path = $2", [storeId, e.path]);
      const prev = rows[0]?.file_id;
      if (prev && prev !== e.fileId) orphaned.push(prev);
      await this.pool.query(
        `INSERT INTO memory_entries (store_id, path, file_id, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (store_id, path) DO UPDATE SET file_id = EXCLUDED.file_id, updated_at = now()
         WHERE memory_entries.file_id <> EXCLUDED.file_id`,
        [storeId, e.path, e.fileId],
      );
    }
    if (deletes.length) {
      const { rows } = await this.pool.query(
        "SELECT file_id FROM memory_entries WHERE store_id = $1 AND path = ANY($2)", [storeId, deletes]);
      orphaned.push(...rows.map((r: any) => r.file_id));
      await this.pool.query("DELETE FROM memory_entries WHERE store_id = $1 AND path = ANY($2)", [storeId, deletes]);
    }
    return orphaned;
  }
```

Add near `deleteFile`:

```ts
  /** Unscoped delete for platform-managed rows (checkpoints, memory) on the
   *  runner-callback path — same trust model as createFileRecord there. */
  async deleteFileRecordById(id: string) {
    await this.pool.query("DELETE FROM files WHERE id = $1", [id]);
  }
```

- [ ] **Step 4: Wire the routes**

`agents-api.ts` — status route (~566):

```ts
  app.post("/v1/sessions/:id/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { status: "completed" | "failed" | "idle"; sdkSessionId?: string; checkpointFileId?: string };
    if (!["completed", "failed", "idle"].includes(b?.status)) return reply.code(400).send({ error: "bad status" });
    const { replacedCheckpointFileId } = await repo.setSessionStatus(id, b.status, b);
    if (replacedCheckpointFileId) {
      // Best effort — a stale checkpoint must never fail the status update.
      repo.deleteFileRecordById(replacedCheckpointFileId).catch(() => {});
      Promise.resolve(files.del?.(replacedCheckpointFileId)).catch(() => {});
    }
    deliverWebhooks(repo, id, b.status).catch(() => {}); // fire-and-forget
    return { ok: true };
  });
```

Memory route (~350):

```ts
  app.post("/v1/sessions/:id/memory", async (req, reply) => {
    const session = await repo.getSession((req.params as any).id);
    if (!session?.memory_store_id) return reply.code(400).send({ error: "session has no memory store" });
    const b = req.body as { entries: { path: string; fileId: string }[]; deletes?: string[] };
    const orphaned = await repo.upsertMemoryEntries(session.memory_store_id, b?.entries ?? [], b?.deletes ?? []);
    for (const fid of orphaned) {
      repo.deleteFileRecordById(fid).catch(() => {});
      Promise.resolve(files.del?.(fid)).catch(() => {});
    }
    return { ok: true };
  });
```

NOTE (test sync): if the route tests from Step 1 asserted synchronously, the fire-and-forget deletes may not have recorded yet — the fakes are synchronous-resolving so one microtask suffices; if flaky, `await new Promise((r) => setImmediate(r))` before asserting.

- [ ] **Step 5: Run tests + full gate**

Run: `cd control-plane && npm test && npx tsc --noEmit` → all green (fix any pre-existing fake `setSessionStatus`/`upsertMemoryEntries` return-shape mismatches surfaced by tsc).

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/repo.ts control-plane/src/agents-api.ts control-plane/test/agents-api.test.ts
git commit -m "feat(files): growth guards — replaced checkpoints and memory files are deleted"
```

---

### Task 4: Agent enable/disable (CP)

**Files:**
- Create: `control-plane/sql/020_agent_status.sql`
- Modify: `control-plane/src/repo.ts` (add `getAgent`, `setAgentStatus`; ensure `listAgents`/`getAgentWithVersions` expose `status`)
- Modify: `control-plane/src/agents-api.ts` (status route; 409 checks in `POST /v1/sessions` ~line 380 and `POST /v1/sessions/:id/messages` ~line 417)
- Test: `control-plane/test/agents-api.test.ts`

**Interfaces:**
- Produces: `repo.getAgent(workspaceId, id) → { id, name, status, created_at } | null`; `repo.setAgentStatus(workspaceId, id, status) → boolean` (false = not found); `POST /v1/agents/:id/status {status: "active"|"disabled"}` → 400/404/`{ok:true}`. Task 5 relies on `status` being present in `GET /v1/agents` rows and `GET /v1/agents/:id`.

- [ ] **Step 1: Migration**

Create `control-plane/sql/020_agent_status.sql`:

```sql
-- Agent lifecycle (spec 2026-07-10): disabled agents reject NEW sessions and
-- follow-up messages (409); running turns always finish. Reruns every boot.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
```

- [ ] **Step 2: Write the failing tests**

In `control-plane/test/agents-api.test.ts` — extend the fake repo:

```ts
    agentStatuses: {} as Record<string, string>,
    async getAgent(_ws: string, id: string) {
      const a = agents.find((x) => x.id === id);
      return a ? { id: a.id, name: a.name, status: (this as any).agentStatuses[id] ?? "active" } : null;
    },
    async setAgentStatus(_ws: string, id: string, status: string) {
      if (!agents.find((x) => x.id === id)) return false;
      (this as any).agentStatuses[id] = status; return true;
    },
```

Tests (create an agent via the existing fixture first; disable it via the route):

```ts
test("disabled agent: new sessions and follow-ups are 409, status route validates", async () => {
  const { app, repo } = await build();
  const created = await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "d1", model: "m" } });
  const agentId = created.json().id;
  const s = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: agentId, prompt: "hi" } });
  assert.equal(s.statusCode, 201);
  const sessionId = s.json().id;

  assert.equal((await app.inject({ method: "POST", url: `/v1/agents/${agentId}/status`, payload: { status: "nope" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/v1/agents/agent_missing/status", payload: { status: "disabled" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: `/v1/agents/${agentId}/status`, payload: { status: "disabled" } })).statusCode, 200);

  const s2 = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: agentId, prompt: "hi again" } });
  assert.equal(s2.statusCode, 409);
  assert.equal(s2.json().error, "agent disabled");

  // follow-up on the existing session also 409s (make the fake session idle first if needed)
  const m = await app.inject({ method: "POST", url: `/v1/sessions/${sessionId}/messages`, payload: { prompt: "more" } });
  assert.equal(m.statusCode, 409);

  await app.inject({ method: "POST", url: `/v1/agents/${agentId}/status`, payload: { status: "active" } });
  const s3 = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: agentId, prompt: "back" } });
  assert.equal(s3.statusCode, 201);
});
```

(Adapt fixture calls to the file's conventions — e.g. the fake session may need `status: "idle"` for the messages route; read the existing messages-route test.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd control-plane && npm test`
Expected: FAIL — the status route doesn't exist (404) and session creation succeeds while "disabled".

- [ ] **Step 4: Implement repo methods**

`repo.ts` (near the other agent methods):

```ts
  async getAgent(workspaceId: string, id: string) {
    const { rows } = await this.pool.query(
      "SELECT id, name, status, created_at FROM agents WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
    return rows[0] ?? null;
  }
  async setAgentStatus(workspaceId: string, id: string, status: string) {
    const { rowCount } = await this.pool.query(
      "UPDATE agents SET status = $3 WHERE id = $1 AND workspace_id = $2", [id, workspaceId, status]);
    return (rowCount ?? 0) > 0;
  }
```

Read `listAgents` and `getAgentWithVersions` in repo.ts: if they select explicit column lists that omit `status`, add it; if they use `a.*`, no change. (`GET /v1/agents` rows and the detail payload MUST carry `status` for Task 5.)

- [ ] **Step 5: Implement routes**

`agents-api.ts` — after the `POST /v1/agents/:id/versions` route:

```ts
  app.post("/v1/agents/:id/status", async (req, reply) => {
    const { status } = (req.body ?? {}) as { status?: string };
    if (!["active", "disabled"].includes(status ?? "")) return reply.code(400).send({ error: "bad status" });
    const ok = await repo.setAgentStatus(ws(req), (req.params as any).id, status!);
    if (!ok) return reply.code(404).send({ error: "agent not found" });
    return { ok: true };
  });
```

`POST /v1/sessions` (~line 380) — after the body validation line, before `listFileRecords`:

```ts
    const agent = await repo.getAgent(ws(req), b.agent);
    if (agent?.status === "disabled") return reply.code(409).send({ error: "agent disabled" });
```

(Unknown agent stays a 404 via `createSession`'s existing throw — do not change that path.)

`POST /v1/sessions/:id/messages` (~line 417) — read the route; right after the session is loaded (or load it first via `repo.getSession(id)` if the route currently relies on `startTurn` to do it), insert:

```ts
    const owner = session ? await repo.getAgent(ws(req), session.agent_id) : null;
    if (owner?.status === "disabled") return reply.code(409).send({ error: "agent disabled" });
```

(Keep the existing not-found/not-idle error paths exactly as they are; the 409 check comes BEFORE `startTurn` so an idle session is never flipped to queued.)

- [ ] **Step 6: Run tests + full gate**

Run: `cd control-plane && npm test && npx tsc --noEmit` → all green.

- [ ] **Step 7: Commit**

```bash
git add control-plane/sql/020_agent_status.sql control-plane/src/repo.ts control-plane/src/agents-api.ts control-plane/test/agents-api.test.ts
git commit -m "feat(agents): enable/disable — 409 on new sessions and follow-ups while disabled"
```

---

### Task 5: Agent status in the console (real badge + toggle)

**Files:**
- Create: `console/app/agents/status-toggle.tsx`
- Modify: `console/app/agents/page.tsx:35` (badge)
- Modify: `console/app/agents/[id]/page.tsx` (badge + toggle + hide Create session)
- Modify: `console/app/sessions/page.tsx` and `console/app/sessions/create.tsx` consumers (exclude disabled agents from the dropdown)

**Interfaces:**
- Consumes: `GET /v1/agents` rows and `GET /v1/agents/:id` carrying `status` (Task 4); `POST /v1/agents/:id/status`.
- Produces: `StatusToggle({ agent })` client component.

- [ ] **Step 1: The toggle component**

Create `console/app/agents/status-toggle.tsx`:

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { wsHeader } from "../lib/client";
import { ConfirmDialog } from "../lib/modal";

export function StatusToggle({ agent }: { agent: { id: string; status?: string } }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const disabled = agent.status === "disabled";

  const setStatus = async (status: "active" | "disabled") => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/agents/${agent.id}/status`, {
        method: "POST", headers: { "Content-Type": "application/json", ...wsHeader() },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) return `HTTP ${res.status}`;
      router.refresh(); return null;
    } catch (err) { return String(err); } finally { setBusy(false); }
  };

  return (<>
    {disabled
      ? <button className="ghost" disabled={busy} onClick={() => setStatus("active")}>{busy ? "Enabling…" : "Enable"}</button>
      : <button className="ghost" disabled={busy} onClick={() => setConfirming(true)}>Disable</button>}
    {confirming && <ConfirmDialog title="Disable agent" verb="Disable"
      message="New sessions and follow-up messages will be rejected; running turns finish."
      onClose={() => setConfirming(false)}
      onConfirm={() => setStatus("disabled")} />}
  </>);
}
```

(Read `console/app/lib/modal.tsx` for `ConfirmDialog`'s exact prop contract — `onConfirm` returning a string displays it as an error; match that.)

- [ ] **Step 2: Real badges + placement**

`console/app/agents/page.tsx` line 35:

```tsx
              <td><span className={`phase ${a.status === "disabled" ? "bad" : "Ready"}`}>{a.status === "disabled" ? "Disabled" : "Active"}</span></td>
```

`console/app/agents/[id]/page.tsx` — the header becomes:

```tsx
      <div className="pagehead">
        <h1>{agent.name} <span className={`phase ${agent.status === "disabled" ? "bad" : "Ready"}`} style={{ verticalAlign: "middle" }}>
          {agent.status === "disabled" ? "Disabled" : "Active"}</span></h1>
        <div style={{ display: "flex", gap: 10 }}>
          <StatusToggle agent={agent} />
          {agent.status !== "disabled" && (
            <CreateSession ghost agents={[{ id: agent.id, name: agent.name }]}
                           memoryStores={stores.map((s: any) => ({ id: s.id, name: s.name }))} />
          )}
          <EditAgentButton agent={agent} environments={environments} skills={skills} vaults={vaults}
                           models={deployments.map((d: any) => d.name)} />
        </div>
      </div>
```

with `import { StatusToggle } from "../status-toggle";` added.

- [ ] **Step 3: Exclude disabled agents from create-session dropdowns**

`console/app/sessions/page.tsx` — where `agents` is passed to `CreateSession`:

```tsx
      <CreateSession agents={agents.filter((a: any) => a.status !== "disabled")} memoryStores={...} />
```

(Match the existing call exactly, only adding the filter. `create.tsx` itself is unchanged.)

- [ ] **Step 4: Build + commit**

Run: `cd console && npx next build` → green.

```bash
git add console/app/agents/status-toggle.tsx console/app/agents/page.tsx "console/app/agents/[id]/page.tsx" console/app/sessions/page.tsx
git commit -m "feat(console): real agent status badge, disable/enable toggle, dropdown exclusion"
```

---

### Task 6: Full-ID clickable convention across Managed Agents tables

**Files:**
- Modify: `console/app/agents/page.tsx` (rows 31-32)
- Modify: `console/app/sessions/page.tsx` (rows 48-49)
- Modify: `console/app/memory-stores/page.tsx` (rows 21-22)
- Modify: `console/app/skills/page.tsx` (add ID column)
- Modify: `console/app/vaults/page.tsx` (add ID column)
- Modify: `console/app/files/table.tsx` (add ID column, click = download)
- Modify: `console/app/environments/page.tsx` (ID opens edit modal; name plain)
- Modify: `console/app/environments/create.tsx` (`EditEnvironmentName` renders the id)

**Interfaces:**
- Consumes: existing detail routes. No backend changes.

- [ ] **Step 1: Flip the simple lists**

`agents/page.tsx` rows:

```tsx
              <td><Link href={`/agents/${a.id}`}><code>{a.id}</code></Link></td>
              <td>{a.name}</td>
```

`sessions/page.tsx` rows:

```tsx
              <td><Link href={`/sessions/${s.id}`}><code>{s.id}</code></Link></td>
              <td>{s.name ?? "—"}</td>
```

`memory-stores/page.tsx` rows:

```tsx
              <td><Link href={`/memory-stores/${s.id}`}><code>{s.id}</code></Link></td>
              <td>{s.name}</td>
```

- [ ] **Step 2: Add ID columns**

`skills/page.tsx` — header `<th>ID</th><th>Name</th>…`, row:

```tsx
              <td><Link href={`/skills/${s.id}`}><code>{s.id}</code></Link></td>
              <td>{s.name}</td>
```

empty-row `colSpan` 5 → 6.

`vaults/page.tsx` — header `<th>ID</th><th>Name</th>…`, row:

```tsx
              <td><Link href={`/vaults/${v.id}`}><code>{v.id}</code></Link></td>
              <td>{v.name}</td>
```

empty-row `colSpan` 4 → 5.

`files/table.tsx` — header gains leading `<th>ID</th>`; row gains (before the Name cell):

```tsx
              <td><a href={`/api/v1/files/${f.id}/content`}><code>{f.id}</code></a></td>
```

(the content route sets `Content-Disposition`, so the click downloads; raster images open inline — both acceptable). Empty-row `colSpan` 7 → 8. The checkbox column stays first.

- [ ] **Step 3: Environments — ID opens the edit modal**

`environments/create.tsx` — `EditEnvironmentName` becomes:

```tsx
export function EditEnvironmentName({ env }: { env: any }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button className="namebtn" title="Edit environment" style={{ fontFamily: "var(--font-mono)" }}
            onClick={() => setOpen(true)}>{env.id}</button>
    {open && <EnvironmentModal env={env} onClose={() => setOpen(false)} />}
  </>);
}
```

`environments/page.tsx` — the ID/Name cells become:

```tsx
              <td><EditEnvironmentName env={e} /></td>
              <td>{e.name}</td>
```

(the plain `<code>{e.id.slice(0, 18)}…</code>` cell is REPLACED by the modal opener; headers stay `ID | Name | …`).

- [ ] **Step 4: Build + commit**

Run: `cd console && npx next build` → green. Verify with a grep that no Managed-Agents list still truncates: `grep -rn "slice(0" console/app/{agents,sessions,skills,vaults,files,memory-stores,environments} --include=page.tsx --include=table.tsx` — remaining hits must be non-ID slices only.

```bash
git add console/app/agents/page.tsx console/app/sessions/page.tsx console/app/memory-stores/page.tsx console/app/skills/page.tsx console/app/vaults/page.tsx console/app/files/table.tsx console/app/environments/page.tsx console/app/environments/create.tsx
git commit -m "feat(console): full-ID clickable convention across Managed Agents tables"
```

---

### Task 7: CopyId component on detail pages

**Files:**
- Create: `console/app/lib/copy-id.tsx`
- Modify: `console/app/agents/[id]/page.tsx:27` (sub line)
- Modify: `console/app/sessions/[id]/page.tsx:16` (crumbs)
- Modify: `console/app/skills/[id]/page.tsx` (sub line)
- Modify: `console/app/memory-stores/[id]/page.tsx` (sub line)
- Modify: `console/app/vaults/[id]/page.tsx` (add sub id line)
- Modify: `console/app/environments/create.tsx` (modal shows CopyId when editing)

**Interfaces:**
- Produces: `CopyId({ id }: { id: string })` client component — `<code>` + quiet icon button, clipboard copy, ~1.5s "copied" check state.

- [ ] **Step 1: The component**

Create `console/app/lib/copy-id.tsx`:

```tsx
"use client";
// Full entity id + one-click copy (spec 2026-07-10: id always displayed on
// top of detail pages). Quiet icon button — allowed exception to the
// no-transparent-buttons rule, like other row icon-buttons.
import { useState } from "react";

export function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <code>{id}</code>
      <button className="iconbtn" title={copied ? "Copied!" : "Copy id"} aria-label="Copy id"
        onClick={async () => {
          try { await navigator.clipboard.writeText(id); } catch { return; }
          setCopied(true); setTimeout(() => setCopied(false), 1500);
        }}>
        {copied
          ? <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 8.5 6 12.5 14 3.5" /></svg>
          : <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5" y="5" width="9" height="9" rx="1.5" /><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" /></svg>}
      </button>
    </span>
  );
}
```

Check `console/app/globals.css` for an existing `.iconbtn` class (quiet row icon-buttons are an established exception). If none exists, add:

```css
.iconbtn { background: transparent; border: 0; padding: 2px 4px; color: var(--muted); cursor: pointer; line-height: 0; box-shadow: none; }
.iconbtn:hover { color: var(--blue); background: transparent; }
```

(If a similarly-styled class already exists under another name, use that instead of adding a duplicate.)

- [ ] **Step 2: Placements**

- `agents/[id]/page.tsx` line 27: `<p className="sub"><CopyId id={agent.id} /> · created {new Date(agent.created_at).toLocaleString()}</p>` (+ import).
- `sessions/[id]/page.tsx` line 16: `<div className="crumbs"><Link href="/sessions">Sessions</Link> / <CopyId id={session.id} /></div>` (+ import).
- `skills/[id]/page.tsx` — the sub line becomes:

```tsx
      <p className="sub">
        <CopyId id={skill.id} /> · <span className="phase">v{skill.version ?? 1}</span> · {files.length} file{files.length === 1 ? "" : "s"} ·{" "}
        <code>SKILL.md</code> is the entry (●). Update skill publishes the next version in place.
      </p>
```

- `memory-stores/[id]/page.tsx` — crumbs keep the short form; the sub line becomes `<p className="sub"><CopyId id={id} /> · {entries.length} file(s)</p>`.
- `vaults/[id]/page.tsx` — insert directly under the pagehead: `<p className="sub" style={{ marginTop: 0 }}><CopyId id={vault.id} /></p>` (keep the existing descriptive sub paragraph after it).
- `environments/create.tsx` — in `EnvironmentModal`, when editing show the id at the top of the body: as the FIRST child inside the Modal add `{env && <p className="sub" style={{ marginTop: 0 }}><CopyId id={env.id} /></p>}` (+ import). Do NOT pass it as `subtitle` unless you first verify `Modal`'s subtitle prop accepts ReactNode — read `console/app/lib/modal.tsx`; if subtitle is typed as ReactNode, prefer `subtitle={env ? <CopyId id={env.id} /> : undefined}`.

- [ ] **Step 3: Build + commit**

Run: `cd console && npx next build` → green.

```bash
git add console/app/lib/copy-id.tsx "console/app/agents/[id]/page.tsx" "console/app/sessions/[id]/page.tsx" "console/app/skills/[id]/page.tsx" "console/app/memory-stores/[id]/page.tsx" "console/app/vaults/[id]/page.tsx" console/app/environments/create.tsx console/app/globals.css
git commit -m "feat(console): CopyId on all managed detail pages + environment modal"
```

---

### Task 8: Live gates + docs (CONTROLLER runs this — no subagent)

**Files:**
- Modify: `CLAUDE.md`

**Steps (live docker-desktop cluster; CP + console restarted on the branch):**

- [ ] 1. Restart CP + console; all pages 200; migration 020 applied (`\d agents` shows status).
- [ ] 2. New-entity ids: create an environment + api key + agent → ids match `/^[a-z]+_[a-z0-9]{12}$/`; old entities (e.g. the `test` agent) still resolve everywhere.
- [ ] 3. Disable flow: disable `test` via the UI toggle (confirm dialog) → badge flips on list + detail; `POST /v1/sessions` via curl → 409 `agent disabled`; follow-up message to its idle session → 409; dropdown on /sessions excludes it; re-enable → all restored. If feasible, start a session BEFORE disabling and confirm the running turn completes.
- [ ] 4. Files: upload the same bytes twice → two rows with distinct short ids, both download via the new ID link; a legacy `file_<sha256>` row (if any left) still downloads (fallback read).
- [ ] 5. Growth guards: run a session with a memory store; overwrite one memory file across two turns → the replaced file row is gone (`SELECT count(*) FROM files WHERE kind='memory'` stable); session checkpoint replacement leaves exactly one checkpoint row per session.
- [ ] 6. Browser pass: all seven Managed Agents lists show full IDs as links (names plain); environments ID opens the edit modal; files ID downloads; copy buttons work on all five detail pages + env modal (clipboard contains the full id).
- [ ] 7. `cd control-plane && npm test && npx tsc --noEmit`; console production build; all pages 200 after restart.
- [ ] 8. CLAUDE.md updates: IDs bullet ("mirror Anthropic" line gains: new ids are `prefix_` + 12-char base36; legacy 24-hex coexist); REMOVE the file-dedup known-limitation bullet (replaced by: files are plain rows, duplicates allowed, checkpoint/memory replacements are GC'd); Dialogs bullet's click rule updated (Managed Agents: full ID is the link; edit opens from the ID for environments); add agent-status semantics to the conventions. Commit docs.

```bash
git add CLAUDE.md
git commit -m "docs: id convention, agent status semantics, file dedup removal"
```

---

## Self-Review Notes

- **Spec coverage:** A→Tasks 4+5; B→Task 1; C→Task 2 (+ guards Task 3); D→Task 6; E→Task 7; verification→per-task tests + Task 8. CLAUDE.md → Task 8.
- **Type consistency:** `shortId(): string` (T1) used by filestore (T2); `setSessionStatus` returns `{replacedCheckpointFileId}` (T3 repo + route agree); `upsertMemoryEntries` returns `string[]` (T3); `getAgent`/`setAgentStatus` (T4) consumed by routes and, via `status` on list rows, by T5; `StatusToggle({agent})` (T5); `CopyId({id})` (T7).
- **Known risks flagged in-task:** fire-and-forget delete timing in T3 tests (setImmediate note); `Modal` subtitle prop type in T7 (read before use); fake return-shape drift surfaced by tsc in T3 Step 5.
- **Deliberate scope cuts:** no GC for pre-existing orphaned rows; legacy S3 delete may orphan shared bytes (same as today, noted in T2); deployments/catalog/pools untouched.
