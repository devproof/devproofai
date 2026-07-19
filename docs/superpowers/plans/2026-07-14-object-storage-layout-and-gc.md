# Object Storage Layout + GC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hierarchical, browsable MinIO object keys (`<ws>/<type>/<id>[/<path>]`), leak-free delete paths, a cron-scheduled GC sweep with a console Storage panel + "Run GC now" button, and a one-time dev wipe.

**Architecture:** `files.object_key` (migration 033) stores each object's key at insert — never derived on read. `FileStore` becomes a dumb key-value store (`put(content, key)` / `get(key)` / `del(key)` / `list()`); id minting moves to routes. All delete paths purge rows AND objects via a shared-key-aware repo helper. `src/gc.ts` holds pure cron matching + the sweep, scheduled from `main.ts` and exposed as `POST /v1/gc/run`.

**Tech Stack:** Node/TS (Fastify), Postgres, MinIO via `@aws-sdk/client-s3`, Next.js console, Node test runner.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-14-object-storage-layout-and-gc-design.md` (checkpoint keys are `<ws>/sessions/<sesn_id>/<file_id>` — amended §2, NOT the bare session id).
- New migration file is `control-plane/sql/033_object_keys.sql` (031 AND 032 exist). `migrate()` re-runs every file each boot — everything must be idempotent (`IF NOT EXISTS`).
- No new npm dependencies. No runner (`session-runner/`) changes — runner talks to CP routes by file id; no image tag bump.
- Tests: `cd control-plane && npm test` (Node test runner; DB-backed tests skip when Postgres is unreachable — dev Postgres is at `localhost:15432` via localhost-lb) and `npx tsc --noEmit`.
- Console: production build only (`cd console && npx next build`); no browser `prompt()`/`confirm()`/`alert()`; no transparent text buttons.
- The one-time wipe (Task 10) runs AFTER all code tasks, against the live cluster; the bucket ends empty, so no legacy-key compatibility code anywhere.
- Commit after every task (small, descriptive commits).
- Go is not involved; nothing in `operator/` changes.

---

### Task 1: `objectKey` helper + migration 033

**Files:**
- Create: `control-plane/src/object-key.ts`
- Create: `control-plane/sql/033_object_keys.sql`
- Test: `control-plane/test/object-key.test.ts`

**Interfaces:**
- Produces: `objectKey(ref: ObjectRef): string`, `validEntryPath(path: string): boolean`, `type ObjectRef` — used by every route task and by repo tests.

- [ ] **Step 1: Write the failing test**

```ts
// control-plane/test/object-key.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { objectKey, validEntryPath } from "../src/object-key.ts";

test("objectKey builds hierarchical keys per kind", () => {
  assert.equal(
    objectKey({ kind: "upload", workspaceId: "wrkspc_default", fileId: "file_abc123def456" }),
    "wrkspc_default/files/file_abc123def456");
  assert.equal(
    objectKey({ kind: "output", workspaceId: "wrkspc_default", fileId: "file_abc123def456" }),
    "wrkspc_default/files/file_abc123def456");
  assert.equal(
    objectKey({ kind: "checkpoint", workspaceId: "wrkspc_default", sessionId: "sesn_2ef86a4c", fileId: "file_abc123def456" }),
    "wrkspc_default/sessions/sesn_2ef86a4c/file_abc123def456");
  assert.equal(
    objectKey({ kind: "memory", workspaceId: "wrkspc_default", storeId: "memstore_x1", path: "notes/a.md" }),
    "wrkspc_default/memory/memstore_x1/notes/a.md");
  assert.equal(
    objectKey({ kind: "skill", workspaceId: "wrkspc_default", skillId: "skill_u2j", path: "scripts/analyze.py" }),
    "wrkspc_default/skills/skill_u2j/scripts/analyze.py");
});

test("objectKey rejects invalid entry paths", () => {
  for (const path of ["", "/abs", "a//b", "../up", "a/../b", "a\\b", "a\x00b"]) {
    assert.throws(() => objectKey({ kind: "skill", workspaceId: "w", skillId: "s", path }), /path/);
  }
});

test("validEntryPath", () => {
  assert.equal(validEntryPath("SKILL.md"), true);
  assert.equal(validEntryPath("scripts/analyze-v2.py"), true);
  assert.equal(validEntryPath("My Notes.md"), true); // spaces are fine — real zips have them
  assert.equal(validEntryPath("../etc/passwd"), false);
  assert.equal(validEntryPath("a/./b"), false);
  assert.equal(validEntryPath("/leading"), false);
  assert.equal(validEntryPath(""), false);
  assert.equal(validEntryPath("x".repeat(513)), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --test test/object-key.test.ts`
Expected: FAIL — cannot find module `../src/object-key.ts`

- [ ] **Step 3: Write the implementation**

```ts
// control-plane/src/object-key.ts
// Hierarchical MinIO/S3 object keys (spec 2026-07-14 §2):
//   <workspace>/<resource-type>/<resource-id>[/<path>]
// The key is computed ONCE at insert and stored in files.object_key — reads
// never derive it. Checkpoint keys carry the file id as leaf (spec amendment):
// a fixed per-session key could be clobbered by a stale pod's salvage upload.

export type ObjectRef =
  | { kind: "upload" | "output"; workspaceId: string; fileId: string }
  | { kind: "checkpoint"; workspaceId: string; sessionId: string; fileId: string }
  | { kind: "memory"; workspaceId: string; storeId: string; path: string }
  | { kind: "skill"; workspaceId: string; skillId: string; path: string };

/** Relative path usable as a key suffix: no traversal, no empty/duplicate
 *  segments, printable, bounded. Shared by skill manifests + memory entries. */
export function validEntryPath(path: string): boolean {
  if (!path || path.length > 512) return false;
  if (path.includes("\\") || /[\x00-\x1f]/.test(path)) return false;
  const segments = path.split("/");
  return segments.every((s) => s.length > 0 && s !== "." && s !== "..");
}

export function objectKey(ref: ObjectRef): string {
  switch (ref.kind) {
    case "upload":
    case "output":
      return `${ref.workspaceId}/files/${ref.fileId}`;
    case "checkpoint":
      return `${ref.workspaceId}/sessions/${ref.sessionId}/${ref.fileId}`;
    case "memory":
      if (!validEntryPath(ref.path)) throw new Error(`bad entry path: ${ref.path}`);
      return `${ref.workspaceId}/memory/${ref.storeId}/${ref.path}`;
    case "skill":
      if (!validEntryPath(ref.path)) throw new Error(`bad entry path: ${ref.path}`);
      return `${ref.workspaceId}/skills/${ref.skillId}/${ref.path}`;
  }
}
```

```sql
-- control-plane/sql/033_object_keys.sql
-- Hierarchical object keys (spec 2026-07-14). The key is stamped at insert
-- (see src/object-key.ts) and stored — reads never derive it. Non-unique:
-- memory/skill path overwrites briefly share a key between the old and new
-- row (the shared-key delete rule in repo.ts handles it). DEFAULT '' only
-- satisfies re-runs on pre-wipe rows; post-wipe every insert sets it.
ALTER TABLE files ADD COLUMN IF NOT EXISTS object_key TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS files_object_key ON files (object_key);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd control-plane && node --test test/object-key.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/object-key.ts control-plane/sql/033_object_keys.sql control-plane/test/object-key.test.ts
git commit -m "feat(cp): hierarchical object-key helper + files.object_key migration"
```

---

### Task 2: Key-based FileStore (local + S3) with `list()`

**Files:**
- Modify: `control-plane/src/filestore.ts` (full rewrite of the interface + both impls)
- Test: `control-plane/test/filestore.test.ts` (rewrite to key-based API)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by ALL later tasks):

```ts
export interface FileStore {
  put(content: Buffer, key: string): Promise<void> | void;
  get(key: string): Promise<Buffer> | Buffer;
  del(key: string): Promise<void> | void;
  getStream?(key: string): Promise<NodeJS.ReadableStream>;
  /** Full store walk for GC. */
  list(): AsyncIterable<{ key: string; size: number; lastModified: Date }>;
  createUpload?(key: string): Promise<string>;
  uploadPart?(key: string, uploadKey: string, partNumber: number, data: Buffer): Promise<string>;
  completeUpload?(key: string, uploadKey: string, parts: { n: number; etag: string }[]): Promise<void>;
  abortUpload?(key: string, uploadKey: string): Promise<void>;
}
```

Note: `put` returns void (no more id/sha minting — callers compute those), `del` is required, `list` is new, and the legacy sha256 read-fallback is DELETED.

- [ ] **Step 1: Rewrite the test file for the key-based API**

Replace `control-plane/test/filestore.test.ts` entirely:

```ts
// control-plane/test/filestore.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localFileStore } from "../src/filestore.ts";

function tmpStore() {
  const root = mkdtempSync(join(tmpdir(), "fs-test-"));
  return { store: localFileStore(root), root };
}

test("put/get/del roundtrip with hierarchical keys", async () => {
  const { store, root } = tmpStore();
  try {
    const key = "wrkspc_default/skills/skill_x/scripts/run.py";
    await store.put(Buffer.from("hello"), key);
    assert.equal((await store.get(key)).toString(), "hello");
    await store.del(key);
    await assert.rejects(async () => store.get(key));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("put overwrites an existing key in place", async () => {
  const { store, root } = tmpStore();
  try {
    await store.put(Buffer.from("v1"), "w/memory/m/notes.md");
    await store.put(Buffer.from("v2"), "w/memory/m/notes.md");
    assert.equal((await store.get("w/memory/m/notes.md")).toString(), "v2");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("list walks all keys with size + mtime", async () => {
  const { store, root } = tmpStore();
  try {
    await store.put(Buffer.from("a"), "w/files/file_1");
    await store.put(Buffer.from("bb"), "w/sessions/sesn_1/file_2");
    const seen: Record<string, number> = {};
    for await (const o of store.list()) {
      seen[o.key] = o.size;
      assert.ok(o.lastModified instanceof Date);
    }
    assert.deepEqual(seen, { "w/files/file_1": 1, "w/sessions/sesn_1/file_2": 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("keys with traversal segments are rejected", async () => {
  const { store, root } = tmpStore();
  try {
    await assert.rejects(async () => store.put(Buffer.from("x"), "w/../../etc/passwd"));
    await assert.rejects(async () => store.get("w/../secret"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("del on a missing key is a no-op", async () => {
  const { store, root } = tmpStore();
  try { await store.del("w/files/file_gone"); } finally { rmSync(root, { recursive: true, force: true }); }
});

test("chunked upload assembles parts in order", async () => {
  const { store, root } = tmpStore();
  try {
    const key = "w/files/file_big";
    const up = await store.createUpload!(key);
    const e2 = await store.uploadPart!(key, up, 2, Buffer.from("world"));
    const e1 = await store.uploadPart!(key, up, 1, Buffer.from("hello "));
    await store.completeUpload!(key, up, [{ n: 2, etag: e2 }, { n: 1, etag: e1 }]);
    assert.equal((await store.get(key)).toString(), "hello world");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && node --test test/filestore.test.ts`
Expected: FAIL (compile errors — old signatures)

- [ ] **Step 3: Rewrite `control-plane/src/filestore.ts`**

Keep the file header comment style. Full replacement:

```ts
// FileStore: dumb key-value content storage (concept §6.1 File entity).
// Keys are hierarchical (src/object-key.ts) and stored in files.object_key —
// this layer never derives, mints, or hashes anything. Dev impl = local
// directory (keys map to subdirectories); S3/MinIO impl for real runs.
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export interface FileStore {
  put(content: Buffer, key: string): Promise<void> | void;
  get(key: string): Promise<Buffer> | Buffer;
  del(key: string): Promise<void> | void;
  /** Streaming read for large objects (public-API downloads). */
  getStream?(key: string): Promise<NodeJS.ReadableStream>;
  /** Full store walk (GC orphan-object scan). */
  list(): AsyncIterable<{ key: string; size: number; lastModified: Date }>;
  // Chunked uploads (public API, 4 GB files). key is the final object key;
  // uploadKey is store-opaque (S3 UploadId).
  createUpload?(key: string): Promise<string>;
  uploadPart?(key: string, uploadKey: string, partNumber: number, data: Buffer): Promise<string>;
  completeUpload?(key: string, uploadKey: string, parts: { n: number; etag: string }[]): Promise<void>;
  abortUpload?(key: string, uploadKey: string): Promise<void>;
}

/** Keys come from objectKey() so this is defense-in-depth, not the validator. */
function safeKey(key: string): string {
  if (!key || key.split("/").some((s) => !s || s === "." || s === "..")) throw new Error(`bad object key: ${key}`);
  return key;
}

export function localFileStore(root = process.env.DEVPROOF_FILES_DIR ?? ".devproof/files"): FileStore {
  mkdirSync(root, { recursive: true });
  const p = (key: string) => join(root, ...safeKey(key).split("/"));
  return {
    put(content: Buffer, key: string) {
      mkdirSync(dirname(p(key)), { recursive: true });
      writeFileSync(p(key), content);
    },
    get(key: string) { return readFileSync(p(key)); },
    del(key: string) { try { rmSync(p(key)); } catch { /* already gone */ } },
    async getStream(key: string) {
      const { createReadStream } = await import("node:fs");
      return createReadStream(p(key));
    },
    async *list() {
      for (const ent of readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (!ent.isFile()) continue;
        const full = join(ent.parentPath, ent.name);
        const rel = full.slice(root.length + 1).replaceAll("\\", "/");
        if (/\.part\d+$/.test(rel)) continue; // in-flight chunked-upload parts
        const st = statSync(full);
        yield { key: rel, size: st.size, lastModified: st.mtime };
      }
    },
    async createUpload(key: string) { safeKey(key); return "local"; },
    async uploadPart(key: string, _up: string, n: number, data: Buffer) {
      mkdirSync(dirname(p(key)), { recursive: true });
      writeFileSync(`${p(key)}.part${n}`, data);
      return String(n);
    },
    async completeUpload(key: string, _up: string, parts: { n: number; etag: string }[]) {
      const { createWriteStream, createReadStream } = await import("node:fs");
      const { pipeline } = await import("node:stream/promises");
      const out = createWriteStream(p(key));
      try {
        for (const part of [...parts].sort((a, b) => a.n - b.n)) {
          await pipeline(createReadStream(`${p(key)}.part${part.n}`), out, { end: false });
        }
      } catch (err) {
        out.destroy();
        try { rmSync(p(key)); } catch { /* gone */ }
        throw err;
      }
      out.end();
      await new Promise<void>((r, j) => { out.on("close", () => r()); out.on("error", (err) => j(err)); });
      for (const part of parts) { try { rmSync(`${p(key)}.part${part.n}`); } catch { /* gone */ } }
    },
    async abortUpload(key: string, _up: string) {
      const dir = dirname(p(key));
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { return; }
      const base = p(key).slice(dir.length + 1);
      for (const f of names) {
        if (f.startsWith(`${base}.part`)) { try { rmSync(join(dir, f)); } catch { /* gone */ } }
      }
    },
  };
}

/**
 * S3-compatible (MinIO) object store — the scalable file backend. Objects are
 * keyed by files.object_key (hierarchical, spec 2026-07-14). Any number of
 * control-plane replicas and session pods share one bucket.
 */
export function s3FileStore(opts: {
  endpoint: string; accessKey: string; secretKey: string; bucket: string;
}): FileStore {
  // Lazy import so the dep is only needed when S3 is selected.
  const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = require("@aws-sdk/client-s3");
  const client = new S3Client({
    endpoint: opts.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: opts.accessKey, secretAccessKey: opts.secretKey },
  });
  const streamToBuffer = async (stream: any): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  };
  return {
    async put(content: Buffer, key: string) {
      await client.send(new PutObjectCommand({ Bucket: opts.bucket, Key: safeKey(key), Body: content }));
    },
    async get(key: string) {
      const res = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: safeKey(key) }));
      return streamToBuffer(res.Body);
    },
    async del(key: string) {
      // Deleting a missing key is a no-op in S3.
      try { await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: safeKey(key) })); } catch { /* ignore */ }
    },
    async getStream(key: string) {
      const res = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: safeKey(key) }));
      return res.Body as NodeJS.ReadableStream;
    },
    async *list() {
      let token: string | undefined;
      do {
        const res = await client.send(new ListObjectsV2Command({ Bucket: opts.bucket, ContinuationToken: token }));
        for (const o of res.Contents ?? []) {
          yield { key: o.Key as string, size: Number(o.Size ?? 0), lastModified: o.LastModified as Date };
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
    },
    async createUpload(key: string) {
      const res = await client.send(new CreateMultipartUploadCommand({ Bucket: opts.bucket, Key: safeKey(key) }));
      return res.UploadId as string;
    },
    async uploadPart(key: string, uploadKey: string, partNumber: number, data: Buffer) {
      const res = await client.send(new UploadPartCommand({
        Bucket: opts.bucket, Key: safeKey(key), UploadId: uploadKey, PartNumber: partNumber, Body: data,
      }));
      return res.ETag as string;
    },
    async completeUpload(key: string, uploadKey: string, parts: { n: number; etag: string }[]) {
      await client.send(new CompleteMultipartUploadCommand({
        Bucket: opts.bucket, Key: safeKey(key), UploadId: uploadKey,
        MultipartUpload: { Parts: [...parts].sort((a, b) => a.n - b.n).map((p) => ({ PartNumber: p.n, ETag: p.etag })) },
      }));
    },
    async abortUpload(key: string, uploadKey: string) {
      try {
        await client.send(new AbortMultipartUploadCommand({ Bucket: opts.bucket, Key: safeKey(key), UploadId: uploadKey }));
      } catch (err: any) {
        if (err?.name !== "NoSuchUpload") throw err;
      }
    },
  };
}
```

Notes for the implementer:
- `ent.parentPath` requires Node ≥ 20.12 (this repo runs tsx on current Node; `parentPath` is available — if TS complains, use `(ent as any).parentPath ?? (ent as any).path`).
- The old `createHash`/`shortId` imports are gone from this file — remove them.
- Compilation of the REST of the codebase will now fail (callers still use the old API). That is expected until Tasks 3–5 land; verify only this test file in this task.

- [ ] **Step 4: Run to verify it passes**

Run: `cd control-plane && node --test test/filestore.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/filestore.ts control-plane/test/filestore.test.ts
git commit -m "feat(cp): key-based FileStore with list(); drop legacy sha256 fallback"
```

---

### Task 3: Repo file layer — object_key column + shared-key deletes + session-delete row purge

**Files:**
- Modify: `control-plane/src/repo.ts` (createFileRecord ~:953, deleteSession ~:455, deleteFile ~:462, deleteFileRecordById ~:470, deleteMemoryStore ~:474, createSkill ~:790, deleteSkill ~:814)
- Test: `control-plane/test/repo-object-keys.test.ts` (new)

**Interfaces:**
- Consumes: `objectKey` from Task 1 (tests only).
- Produces (route tasks depend on these EXACT signatures):
  - `createFileRecord(meta: { id: string; name: string; size: number; sha256: string; objectKey: string; sessionId?: string; kind?: string; workspaceId?: string })`
  - `deleteFileRecordById(id: string): Promise<string | null>` — deletes the row; returns its `object_key` when NO surviving row still references that key (shared-key rule), else null.
  - `deleteFile(workspaceId: string, id: string): Promise<{ deleted: boolean; objectKey: string | null }>`
  - `deleteSession(workspaceId: string, id: string): Promise<string[]>` — now DELETES the session's file rows (the 126-orphan leak fix) and returns the unshared object KEYS to purge.
  - `deleteMemoryStore(workspaceId: string, id: string): Promise<string[]>` — returns the store's entry file IDS (caller purges via `deleteFileRecordById`).
  - `getSkillIdByName(workspaceId: string, name: string): Promise<string | null>`
  - `createSkill(workspaceId: string, name: string, files: { path: string; fileId: string }[], id?: string): Promise<{ id; name; version; fileCount; previousFileIds: string[] }>` — `id` is used on the INSERT branch (caller resolved it up front to build keys); update branch returns the replaced version's file ids.
  - `deleteSkill(workspaceId: string, id: string): Promise<string[]>` — returns the skill's file ids.

- [ ] **Step 1: Write the failing test**

```ts
// control-plane/test/repo-object-keys.test.ts
// Integration tests against the live dev Postgres (localhost:15432 via
// localhost-lb). Skipped automatically when the database is unreachable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

const fid = () => `file_${Math.random().toString(36).slice(2, 14).padEnd(12, "0")}`;

test("createFileRecord stores object_key; shared-key delete rule", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-key-${Date.now()}`)).id;
  const key = `${ws}/memory/memstore_t/notes.md`;
  const a = fid(), b = fid();
  await repo.createFileRecord({ id: a, name: "mem/notes.md", size: 1, sha256: "x", objectKey: key, kind: "memory", workspaceId: ws });
  await repo.createFileRecord({ id: b, name: "mem/notes.md", size: 2, sha256: "y", objectKey: key, kind: "memory", workspaceId: ws });
  assert.equal((await repo.getFileRecord(a)).object_key, key);
  // Row `b` still references the key → not returned for object deletion.
  assert.equal(await repo.deleteFileRecordById(a), null);
  // Last referent → key returned.
  assert.equal(await repo.deleteFileRecordById(b), key);
  assert.equal(await repo.deleteFileRecordById(b), null); // idempotent on gone rows
});

test("deleteSession purges file rows and returns unshared keys", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-sdel-${Date.now()}`)).id;
  const agent = await repo.createAgent(ws, `t-sdel-${Date.now()}`, { model: "qwen05b-dp", tools: [] });
  const session = await repo.createSession(ws, agent.id, "hi");
  const cp = fid();
  const cpKey = `${ws}/sessions/${session.id}/${cp}`;
  await repo.createFileRecord({ id: cp, name: "checkpoint.tar.gz", size: 3, sha256: "z", objectKey: cpKey, sessionId: session.id, kind: "checkpoint", workspaceId: ws });
  const keys = await repo.deleteSession(ws, session.id);
  assert.deepEqual(keys, [cpKey]);
  assert.equal(await repo.getFileRecord(cp), null); // row GONE (the leak fix)
  assert.equal(await repo.getSession(session.id), null);
  await repo.deleteAgent(ws, agent.id);
});

test("createSkill update returns previousFileIds; deleteSkill returns file ids", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-skl-${Date.now()}`)).id;
  const name = `t-skl-${Date.now()}`;
  const f1 = fid(), f2 = fid(), f3 = fid();
  for (const [id, path] of [[f1, "SKILL.md"], [f2, "scripts/a.py"]] as const) {
    await repo.createFileRecord({ id, name: `skill/${name}/${path}`, size: 1, sha256: "s", objectKey: `${ws}/skills/skill_pre/${path}`, kind: "skill", workspaceId: ws });
  }
  const v1 = await repo.createSkill(ws, name, [{ path: "SKILL.md", fileId: f1 }, { path: "scripts/a.py", fileId: f2 }], "skill_pre");
  assert.equal(v1.id, "skill_pre");
  assert.equal(v1.version, 1);
  assert.deepEqual(v1.previousFileIds, []);
  assert.equal(await repo.getSkillIdByName(ws, name), "skill_pre");

  await repo.createFileRecord({ id: f3, name: `skill/${name}/SKILL.md`, size: 1, sha256: "s2", objectKey: `${ws}/skills/skill_pre/SKILL.md`, kind: "skill", workspaceId: ws });
  const v2 = await repo.createSkill(ws, name, [{ path: "SKILL.md", fileId: f3 }]);
  assert.equal(v2.version, 2);
  assert.deepEqual([...v2.previousFileIds].sort(), [f1, f2].sort());

  const ids = await repo.deleteSkill(ws, "skill_pre");
  assert.deepEqual(ids, [f3]);
});

test("deleteMemoryStore returns entry file ids", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-mem-${Date.now()}`)).id;
  const store = await repo.createMemoryStore(ws, `t-mem-${Date.now()}`);
  const f1 = fid();
  await repo.createFileRecord({ id: f1, name: "mem/a.md", size: 1, sha256: "m", objectKey: `${ws}/memory/${store.id}/a.md`, kind: "memory", workspaceId: ws });
  await repo.upsertMemoryEntries(store.id, [{ path: "a.md", fileId: f1 }]);
  const ids = await repo.deleteMemoryStore(ws, store.id);
  assert.deepEqual(ids, [f1]);
});
```

(If `createMemoryStore`'s actual signature differs — check `repo.ts` — adapt the call, not the assertion.)

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && node --test test/repo-object-keys.test.ts`
Expected: FAIL (objectKey param unknown / return-shape mismatches)

- [ ] **Step 3: Implement the repo changes**

In `control-plane/src/repo.ts`:

**createFileRecord** (~line 953) — add `objectKey`:

```ts
async createFileRecord(meta: { id: string; name: string; size: number; sha256: string; objectKey: string; sessionId?: string; kind?: string; workspaceId?: string }) {
  await this.pool.query(
    "INSERT INTO files (id, workspace_id, session_id, name, size, sha256, kind, object_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [meta.id, meta.workspaceId ?? DEFAULT_WORKSPACE, meta.sessionId ?? null, meta.name, meta.size, meta.sha256, meta.kind ?? "upload", meta.objectKey],
  );
  return meta;
}
```

**deleteFileRecordById** (~line 470) — shared-key rule. IMPORTANT Postgres subtlety: the outer query of a data-modifying CTE sees the PRE-delete table state, so a plain `NOT EXISTS` would always find the just-deleted row itself; exclude it by id:

```ts
/** Unscoped delete for platform-managed rows (checkpoints, memory, skill
 *  files). Returns the row's object_key when no OTHER row references the
 *  same key (safe to delete the object), else null. The outer SELECT of a
 *  data-modifying CTE sees pre-delete state — hence the f.id <> d.id guard. */
async deleteFileRecordById(id: string): Promise<string | null> {
  const { rows } = await this.pool.query(
    `WITH del AS (DELETE FROM files WHERE id = $1 RETURNING id, object_key)
     SELECT d.object_key FROM del d
     WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.object_key = d.object_key AND f.id <> d.id)`,
    [id]);
  return rows[0]?.object_key ?? null;
}
```

**deleteFile** (~line 462) — same rule, workspace-scoped. (Not a single CTE: its `rowCount` would count the OUTER select, not the delete, so `deleted` would be wrong for shared keys.)

```ts
async deleteFile(workspaceId: string, id: string): Promise<{ deleted: boolean; objectKey: string | null }> {
  const { rows: owned } = await this.pool.query(
    "SELECT 1 FROM files WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  if (!owned.length) return { deleted: false, objectKey: null };
  return { deleted: true, objectKey: await this.deleteFileRecordById(id) };
}
```

Use this two-step form (clearer and the race window is closed by the DELETE inside `deleteFileRecordById`).

**deleteSession** (~line 455) — delete file rows (leak fix), return unshared keys:

```ts
/** Delete a session (events cascade) AND its file rows (checkpoints/outputs —
 *  the pre-033 leak: ON DELETE SET NULL orphaned them). Returns the object
 *  keys safe to purge (shared-key rule; see deleteFileRecordById). */
async deleteSession(workspaceId: string, id: string): Promise<string[]> {
  const { rows } = await this.pool.query(
    `WITH del AS (DELETE FROM files WHERE session_id = $1 AND workspace_id = $2 RETURNING id, object_key)
     SELECT DISTINCT d.object_key FROM del d
     WHERE NOT EXISTS (
       SELECT 1 FROM files f WHERE f.object_key = d.object_key AND f.id NOT IN (SELECT id FROM del))`,
    [id, workspaceId]);
  await this.pool.query("DELETE FROM sessions WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  return rows.map((r: any) => r.object_key);
}
```

**deleteMemoryStore** (~line 474) — return entry file ids:

```ts
async deleteMemoryStore(workspaceId: string, id: string): Promise<string[]> {
  const { rows } = await this.pool.query(
    `SELECT me.file_id FROM memory_entries me
     JOIN memory_stores ms ON ms.id = me.store_id
     WHERE me.store_id = $1 AND ms.workspace_id = $2`, [id, workspaceId]);
  await this.pool.query("DELETE FROM memory_stores WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  return rows.map((r: any) => r.file_id);
}
```

**getSkillIdByName** (new, next to createSkill ~line 790):

```ts
async getSkillIdByName(workspaceId: string, name: string): Promise<string | null> {
  const { rows } = await this.pool.query(
    "SELECT id FROM skills WHERE workspace_id = $1 AND name = $2", [workspaceId, name]);
  return rows[0]?.id ?? null;
}
```

**createSkill** (~line 790) — optional explicit id + previousFileIds:

```ts
/** files = manifest [{path, fileId}]; the SKILL.md entry seeds file_id.
 *  `id` is honored on the INSERT branch (the route resolves it up front to
 *  build object keys). Re-upload bumps the version and returns the replaced
 *  manifest's file ids so the route can purge them (rows + dropped keys). */
async createSkill(workspaceId: string, name: string, files: { path: string; fileId: string }[], id?: string) {
  const skillMd = files.find((f) => f.path.toLowerCase() === "skill.md") ?? files[0];
  const { rows: existing } = await this.pool.query(
    "SELECT id, version, file_id, files FROM skills WHERE workspace_id = $1 AND name = $2", [workspaceId, name]);
  if (existing[0]) {
    const version = existing[0].version + 1;
    const prev: { path: string; fileId: string }[] = existing[0].files ?? [];
    const previousFileIds = [...new Set([...prev.map((f) => f.fileId), existing[0].file_id].filter(Boolean))];
    await this.pool.query(
      "UPDATE skills SET file_id = $3, files = $4, version = $5, created_at = now() WHERE id = $1 AND workspace_id = $2",
      [existing[0].id, workspaceId, skillMd?.fileId ?? null, JSON.stringify(files), version]);
    return { id: existing[0].id, name, version, fileCount: files.length, previousFileIds };
  }
  const skillId = id ?? rid("skill");
  await this.pool.query(
    "INSERT INTO skills (id, workspace_id, name, file_id, files) VALUES ($1, $2, $3, $4, $5)",
    [skillId, workspaceId, name, skillMd?.fileId ?? null, JSON.stringify(files)],
  );
  return { id: skillId, name, version: 1, fileCount: files.length, previousFileIds: [] as string[] };
}
```

**deleteSkill** (~line 814) — return file ids:

```ts
async deleteSkill(workspaceId: string, id: string): Promise<string[]> {
  const { rows } = await this.pool.query(
    "SELECT file_id, files FROM skills WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  if (!rows[0]) return [];
  const ids = [...new Set([...(rows[0].files ?? []).map((f: any) => f.fileId), rows[0].file_id].filter(Boolean))];
  await this.pool.query("DELETE FROM skills WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  return ids;
}
```

(Skill/memory file rows have RESTRICT FKs from `skills.file_id`/`memory_entries.file_id` — deleting the skills/store row FIRST, as above, releases them.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd control-plane && node --test test/repo-object-keys.test.ts`
Expected: PASS (4 tests). (`npx tsc --noEmit` still fails — routes not yet migrated; that's Tasks 4–5.)

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/repo.ts control-plane/test/repo-object-keys.test.ts
git commit -m "feat(cp): object_key on files; shared-key deletes; session delete purges file rows"
```

---

### Task 4: Shared skill-package helper

**Files:**
- Create: `control-plane/src/skill-upload.ts`
- Test: `control-plane/test/skill-upload.test.ts`

The zip-extract + store + manifest logic is duplicated verbatim in `agents-api.ts:375-404` and `public-api.ts:176-205` — extract ONE helper both routes call (DRY), now with id-first key building, path validation, and old-version purge.

**Interfaces:**
- Consumes: `objectKey`, `validEntryPath` (Task 1); repo methods from Task 3; `FileStore` (Task 2).
- Produces: `storeSkillPackage(deps, workspaceId, name, filename, buf)` where `deps = { repo, files }`:

```ts
export async function storeSkillPackage(
  deps: { repo: SkillRepo; files: FileStore },
  workspaceId: string, name: string, filename: string, buf: Buffer,
): Promise<{ error: string } | { skill: { id: string; name: string; version: number; fileCount: number } }>
```

with `SkillRepo` a structural interface of the five repo methods used (`getSkillIdByName`, `createSkill`, `createFileRecord`, `deleteFileRecordById`, plus nothing else).

- [ ] **Step 1: Write the failing test**

```ts
// control-plane/test/skill-upload.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { localFileStore } from "../src/filestore.ts";
import { storeSkillPackage } from "../src/skill-upload.ts";

// In-memory fake of the 4 repo methods the helper touches.
function fakeRepo() {
  const rows = new Map<string, { objectKey: string }>();
  let skill: { id: string; name: string; version: number; manifest: { path: string; fileId: string }[] } | null = null;
  return {
    rows, get skill() { return skill; },
    async getSkillIdByName(_ws: string, name: string) { return skill?.name === name ? skill.id : null; },
    async createFileRecord(meta: any) { rows.set(meta.id, { objectKey: meta.objectKey }); return meta; },
    async deleteFileRecordById(id: string) {
      const key = rows.get(id)?.objectKey ?? null;
      rows.delete(id);
      if (key && [...rows.values()].some((r) => r.objectKey === key)) return null;
      return key;
    },
    async createSkill(_ws: string, name: string, manifest: any[], id?: string) {
      const previousFileIds = skill ? skill.manifest.map((m) => m.fileId) : [];
      skill = { id: skill?.id ?? id!, name, version: (skill?.version ?? 0) + 1, manifest };
      return { id: skill.id, name, version: skill.version, fileCount: manifest.length, previousFileIds };
    },
  };
}

function zipOf(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(entries)) zip.addFile(path, Buffer.from(content));
  return zip.toBuffer();
}

test("zip upload stores under skill-id keys and re-upload purges dropped paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-test-"));
  const files = localFileStore(root);
  const repo = fakeRepo();
  try {
    const r1 = await storeSkillPackage({ repo: repo as any, files }, "wsA", "demo", "demo.zip",
      zipOf({ "SKILL.md": "v1", "scripts/a.py": "print(1)" }));
    assert.ok("skill" in r1);
    const skillId = r1.skill.id;
    assert.equal((await files.get(`wsA/skills/${skillId}/SKILL.md`)).toString(), "v1");
    assert.equal((await files.get(`wsA/skills/${skillId}/scripts/a.py`)).toString(), "print(1)");

    // v2 drops scripts/a.py and rewrites SKILL.md in place.
    const r2 = await storeSkillPackage({ repo: repo as any, files }, "wsA", "demo", "demo.zip",
      zipOf({ "SKILL.md": "v2" }));
    assert.ok("skill" in r2 && r2.skill.version === 2);
    assert.equal((await files.get(`wsA/skills/${skillId}/SKILL.md`)).toString(), "v2");
    await assert.rejects(async () => files.get(`wsA/skills/${skillId}/scripts/a.py`)); // dropped path purged
    assert.equal(repo.rows.size, 1); // old rows purged too
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("single markdown upload becomes a 1-file package", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-test-"));
  const files = localFileStore(root);
  const repo = fakeRepo();
  try {
    const r = await storeSkillPackage({ repo: repo as any, files }, "wsA", "solo", "solo.md", Buffer.from("# hi"));
    assert.ok("skill" in r && r.skill.fileCount === 1);
    assert.equal((await files.get(`wsA/skills/${r.skill.id}/SKILL.md`)).toString(), "# hi");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects zips without root SKILL.md, traversal paths, and duplicate paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-test-"));
  const files = localFileStore(root);
  try {
    const noMd = await storeSkillPackage({ repo: fakeRepo() as any, files }, "w", "x", "x.zip", zipOf({ "readme.txt": "no" }));
    assert.ok("error" in noMd && /SKILL\.md/.test(noMd.error));
    const bad = await storeSkillPackage({ repo: fakeRepo() as any, files }, "w", "x", "x.zip",
      zipOf({ "SKILL.md": "ok", "../evil.sh": "boom" }));
    assert.ok("error" in bad && /path/.test(bad.error));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && node --test test/skill-upload.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// control-plane/src/skill-upload.ts
// Shared skill-package storage (spec 2026-07-14 §2) — one implementation for
// both API surfaces (was duplicated in agents-api.ts/public-api.ts). Resolves
// the skill id BEFORE storing so objects land under <ws>/skills/<skill_id>/…;
// same-path re-uploads overwrite in place, and the replaced version's rows +
// dropped-path objects are purged via the shared-key delete rule.
import { createHash } from "node:crypto";
import type { FileStore } from "./filestore.ts";
import { objectKey, validEntryPath } from "./object-key.ts";
import { shortId } from "./id.ts";

export interface SkillRepo {
  getSkillIdByName(workspaceId: string, name: string): Promise<string | null>;
  createFileRecord(meta: { id: string; name: string; size: number; sha256: string; objectKey: string; kind?: string; workspaceId?: string }): Promise<unknown>;
  deleteFileRecordById(id: string): Promise<string | null>;
  createSkill(workspaceId: string, name: string, files: { path: string; fileId: string }[], id?: string):
    Promise<{ id: string; name: string; version: number; fileCount: number; previousFileIds: string[] }>;
}

export async function storeSkillPackage(
  deps: { repo: SkillRepo; files: FileStore },
  workspaceId: string, name: string, filename: string, buf: Buffer,
): Promise<{ error: string } | { skill: { id: string; name: string; version: number; fileCount: number } }> {
  const { repo, files } = deps;
  // Entries as {path, content}; zip paths get the wrapper-folder strip as before.
  let entries: { path: string; content: Buffer }[];
  if (/\.zip$/i.test(filename)) {
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(buf);
    entries = zip.getEntries().filter((e: any) => !e.isDirectory).map((e: any) => ({
      path: e.entryName.replace(/^[^/]+\//, "").replace(/^\/+/, ""),
      content: e.getData(),
    })).filter((e: { path: string }) => e.path);
    if (!entries.some((e) => e.path.toLowerCase() === "skill.md")) {
      return { error: "zip must contain a SKILL.md at its root" };
    }
  } else {
    entries = [{ path: "SKILL.md", content: buf }];
  }
  const bad = entries.find((e) => !validEntryPath(e.path));
  if (bad) return { error: `bad entry path: ${bad.path}` };
  if (new Set(entries.map((e) => e.path)).size !== entries.length) {
    return { error: "duplicate paths in skill package" };
  }

  const skillId = (await repo.getSkillIdByName(workspaceId, name)) ?? `skill_${shortId()}`;
  const manifest: { path: string; fileId: string }[] = [];
  for (const e of entries) {
    const id = `file_${shortId()}`;
    const key = objectKey({ kind: "skill", workspaceId, skillId, path: e.path });
    await files.put(e.content, key);
    await repo.createFileRecord({
      id, name: `skill/${name}/${e.path}`, size: e.content.length,
      sha256: createHash("sha256").update(e.content).digest("hex"),
      objectKey: key, kind: "skill", workspaceId,
    });
    manifest.push({ path: e.path, fileId: id });
  }
  const skill = await repo.createSkill(workspaceId, name, manifest, skillId);
  // Purge the replaced version: rows always; objects only when the key has no
  // surviving referent (an overwritten path's key is now owned by the new row).
  for (const fid of skill.previousFileIds) {
    const key = await repo.deleteFileRecordById(fid).catch(() => null);
    if (key) await Promise.resolve(files.del(key)).catch(() => {});
  }
  return { skill: { id: skill.id, name: skill.name, version: skill.version, fileCount: skill.fileCount } };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd control-plane && node --test test/skill-upload.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/skill-upload.ts control-plane/test/skill-upload.test.ts
git commit -m "feat(cp): shared skill-package helper with id-first keys + old-version purge"
```

---

### Task 5: Migrate all routes + workspace-delete to key-based storage

**Files:**
- Modify: `control-plane/src/agents-api.ts` (files routes :187-240, skill route :375-404, memory routes :508-571, checkpoint replace :727-750, session delete :701-708)
- Modify: `control-plane/src/public-api.ts` (files :78-116, chunked uploads :119-171, skills :176-226, memory ~:300-370, session delete ~:500-560, `sweepStaleUploads` :26-35)
- Modify: `control-plane/src/workspace-delete.ts` (delObj :45-47, drains :51-64)
- Modify: `control-plane/src/orchestrator.ts` / `control-plane/src/session-actions.ts` ONLY if `tsc` flags them (they pass file IDS around — should be untouched).

No new unit test file — this task is mechanical call-site migration verified by `npx tsc --noEmit` + the full existing suite + live verification in Task 11. Existing tests (`server.test.ts`, `agents-api.test.ts`, `public-api.test.ts`, `workspace-delete.test.ts`) exercise these routes; update their fake FileStore stubs to the new signatures where they compile-fail.

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: no new exports; behavior contract for Task 11 verification.

- [ ] **Step 1: agents-api.ts — imports + simple uploads**

Add imports at top: `import { createHash } from "node:crypto";`, `import { objectKey, validEntryPath } from "./object-key.ts";`, `import { storeSkillPackage } from "./skill-upload.ts";` (and `shortId` is already imported — check; if not add `import { shortId } from "./id.ts";`).

`POST /v1/files` (:187):

```ts
app.post("/v1/files", async (req, reply) => {
  const part = await (req as any).file();
  if (!part) return reply.code(400).send({ error: "multipart file field required" });
  const content = await part.toBuffer();
  const id = `file_${shortId()}`;
  const key = objectKey({ kind: "upload", workspaceId: ws(req), fileId: id });
  await files.put(content, key);
  const record = await repo.createFileRecord({
    id, name: part.filename ?? id, size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    objectKey: key, workspaceId: ws(req),
  });
  return reply.code(201).send(record);
});
```

`POST /v1/files/raw` (:197) — kind-based keys (checkpoint under the session, memory under the store):

```ts
app.post("/v1/files/raw", async (req, reply) => {
  const { name, session, kind } = req.query as { name?: string; session?: string; kind?: string };
  const content = req.body as Buffer;
  if (!name || !Buffer.isBuffer(content)) return reply.code(400).send({ error: "name query + binary body required" });
  // Runner callbacks carry no workspace header — attribute to the SESSION's
  // workspace (unscoped lookup) so checkpoints don't leak into wrkspc_default.
  const sess = session ? await repo.getSession(session) : null;
  // Same default createFileRecord applies — non-session raw uploads keep the
  // prior default-workspace attribution.
  const workspaceId = sess?.workspace_id ?? "wrkspc_default";
  const id = `file_${shortId()}`;
  let key: string;
  if (kind === "checkpoint" && sess) {
    key = objectKey({ kind: "checkpoint", workspaceId, sessionId: sess.id, fileId: id });
  } else if (kind === "memory" && sess?.memory_store_id) {
    if (!validEntryPath(name)) return reply.code(400).send({ error: "bad memory path" });
    key = objectKey({ kind: "memory", workspaceId, storeId: sess.memory_store_id, path: name });
  } else {
    key = objectKey({ kind: kind === "output" ? "output" : "upload", workspaceId, fileId: id });
  }
  await files.put(content, key);
  const record = await repo.createFileRecord({
    id, name, size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    objectKey: key, sessionId: sess?.id, kind: kind ?? "upload", workspaceId: sess?.workspace_id,
  });
  return reply.code(201).send(record);
});
```

Note: the record call keeps `workspaceId: sess?.workspace_id` (possibly undefined, `createFileRecord` defaults it to `wrkspc_default`) so row attribution behaves exactly as before; only the KEY needs the resolved workspace up front. If `DEFAULT_WORKSPACE` is exported from repo.ts, prefer importing it over the string literal.

`GET /v1/files/:id/content` (:227): change last line to

```ts
return reply.type(mime ?? "application/octet-stream").send(await files.get(record.object_key));
```

`DELETE /v1/files/:id` (:235):

```ts
app.delete("/v1/files/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const { deleted, objectKey: key } = await repo.deleteFile(ws(req), id);
  if (!deleted) return reply.code(404).send({ error: "file not found" });
  if (key) { try { await files.del(key); } catch { /* best effort */ } }
  return reply.code(204).send();
});
```

- [ ] **Step 2: agents-api.ts — skill route via the shared helper**

Replace the body of `POST /v1/skills` (:375-404) with:

```ts
app.post("/v1/skills", async (req, reply) => {
  const part = await (req as any).file();
  const fname: string = part?.filename ?? "";
  const name = (req.query as any).name ?? fname.replace(/\.(md|zip)$/i, "");
  if (!part || !name) return reply.code(400).send({ error: "multipart file + name required" });
  const result = await storeSkillPackage({ repo, files }, ws(req), name, fname, await part.toBuffer());
  if ("error" in result) return reply.code(400).send({ error: result.error });
  return reply.code(201).send(result.skill);
});
```

`DELETE /v1/skills/:id` (:417-425) — purge rows + objects:

```ts
app.delete("/v1/skills/:id", async (req, reply) => {
  // Sessions resolve skills by id at launch: deleting a referenced skill
  // would silently launch skill-less sessions (mirrors the environment 409).
  if (await repo.skillInUse((req.params as any).id)) {
    return reply.code(409).send({ error: "skill is in use by one or more agents" });
  }
  for (const fid of await repo.deleteSkill(ws(req), (req.params as any).id)) {
    const key = await repo.deleteFileRecordById(fid).catch(() => null);
    if (key) await Promise.resolve(files.del(key)).catch(() => {});
  }
  return reply.code(204).send();
});
```

- [ ] **Step 3: agents-api.ts — memory + checkpoint + session-delete call sites**

`DELETE /v1/memory-stores/:id` (:508-511):

```ts
app.delete("/v1/memory-stores/:id", async (req, reply) => {
  for (const fid of await repo.deleteMemoryStore(ws(req), (req.params as any).id)) {
    if (!guardDeletable(fid)) continue;
    const key = await repo.deleteFileRecordById(fid).catch(() => null);
    if (key) await Promise.resolve(files.del(key)).catch(() => {});
  }
  return reply.code(204).send();
});
```

Every existing `repo.deleteFileRecordById(fid).catch(...); Promise.resolve(files.del?.(fid)).catch(...)` pair (lines ~521-523, ~540-542, ~565-568, ~737-739, ~743-745) becomes the sequenced form:

```ts
const key = await repo.deleteFileRecordById(fid).catch(() => null);
if (key) await Promise.resolve(files.del(key)).catch(() => {});
```

(For the status route :736-745 keep it fire-and-forget so a stale checkpoint never fails the status update — wrap the two lines in an IIFE: `(async () => { const key = await repo.deleteFileRecordById(fid); if (key) await files.del(key); })().catch(() => {});`)

`POST /v1/memory-stores/:id/entries` (:529-545) — hierarchical key + path validation:

```ts
app.post("/v1/memory-stores/:id/entries", async (req, reply) => {
  const storeId = (req.params as any).id;
  const store = await repo.getMemoryStore(storeId, ws(req));
  if (!store) return reply.code(404).send({ error: "memory store not found" });
  const part = await (req as any).file();
  const path = ((req.query as any).path ?? part?.filename ?? "").replace(/^\/+/, "");
  if (!part || !path) return reply.code(400).send({ error: "multipart file + path required" });
  if (!validEntryPath(path)) return reply.code(400).send({ error: "bad entry path" });
  const content = await part.toBuffer();
  const id = `file_${shortId()}`;
  const key = objectKey({ kind: "memory", workspaceId: ws(req), storeId, path });
  await files.put(content, key);
  await repo.createFileRecord({
    id, name: `mem/${path}`, size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    objectKey: key, kind: "memory", workspaceId: ws(req),
  });
  const orphaned = await repo.upsertMemoryEntries(storeId, [{ path, fileId: id }]);
  for (const fid of orphaned) {
    if (!guardDeletable(fid)) continue;
    const okey = await repo.deleteFileRecordById(fid).catch(() => null);
    if (okey) await Promise.resolve(files.del(okey)).catch(() => {});
  }
  return reply.code(201).send({ path, fileId: id });
});
```

(The replaced entry's row shares the same path key as the new row → `deleteFileRecordById` returns null → object survives, holding the new content. That is the shared-key rule doing its job.)

`GET /v1/memory-stores/:id/content` (:551-557): fetch the entry's file record for its key:

```ts
const entry = await repo.getMemoryEntry((req.params as any).id, path);
if (!entry) return reply.code(404).send({ error: "no such memory entry" });
const rec = await repo.getFileRecord(entry.file_id);
if (!rec) return reply.code(404).send({ error: "memory content missing" });
return reply.type("text/plain").send(await files.get(rec.object_key));
```

Runner memory-diff callback `POST /v1/sessions/:id/memory` (:560-571): same sequenced-purge form for `orphaned`.

`DELETE /v1/sessions/:id` (:701-708) — `fileIds` are now KEYS:

```ts
app.delete("/v1/sessions/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  await orchestrator.stopSession(id);
  await orchestrator.deleteSessionResources(id);
  const keys = await repo.deleteSession(ws(req), id);
  for (const key of keys) { try { await files.del(key); } catch { /* best effort */ } }
  return reply.code(204).send();
});
```

Also the agent-delete cascade at :629 — read the surrounding code; it calls `repo.deleteSession` per session the same way; apply the same keys loop there.

- [ ] **Step 4: public-api.ts — mirror everything**

Same transformations for the public surface:
- `POST /files` (:78-87) → like Step 1's `POST /v1/files` (note this route accepts `?kind=` — use `objectKey({ kind: q.kind === "output" ? "output" : "upload", ... })`).
- `POST /files/:id/content` (:102-109) → `files.getStream(record.object_key)` / `files.get(record.object_key)`.
- `DELETE /files/:id` (:111-116) → the `{deleted, objectKey}` form.
- Chunked uploads (:119-171): key is computed once at reserve time and recomputed identically later (deterministic):

```ts
api.post("/files/uploads", async (req: any, reply) => {
  const b = (req.body ?? {}) as { name?: string; kind?: string };
  if (!b.name) return reply.code(400).send({ error: "name required" });
  if (!files.createUpload) return reply.code(501).send({ error: "chunked uploads unavailable on this file store" });
  const fileId = `file_${shortId()}`;
  const key = objectKey({ kind: "upload", workspaceId: ws(req), fileId });
  const uploadKey = await files.createUpload(key);
  const id = `upl_${shortId()}`;
  await repo.createFileUpload(ws(req), { id, fileId, uploadKey, name: b.name, kind: b.kind ?? "upload", partSize: PART_SIZE });
  return reply.code(201).send({ upload_id: id, file_id: fileId, part_size: PART_SIZE });
});
```

In parts/complete/abort handlers, derive the same key from the stored row: `const key = objectKey({ kind: "upload", workspaceId: up.workspace_id, fileId: up.file_id });` — then `files.uploadPart!(key, up.upload_key, n, data)` etc. The complete handler's `createFileRecord` gains `objectKey: key`. (`file_uploads` rows carry `workspace_id` — see repo.ts:989-998.)
- `sweepStaleUploads` (:26-35): same key derivation per stale row:

```ts
export async function sweepStaleUploads(repo: any, files: FileStore, olderThanMs = STALE_UPLOAD_MS) {
  for (const u of await repo.listStaleFileUploads(olderThanMs)) {
    try {
      await files.abortUpload?.(objectKey({ kind: "upload", workspaceId: u.workspace_id, fileId: u.file_id }), u.upload_key);
      await repo.deleteFileUpload(u.id);
    } catch (err) {
      console.warn(`upload sweep: ${u.id} failed:`, err); // next sweep retries
    }
  }
}
```

(Verify `listStaleFileUploads` selects `workspace_id`; add it to the SELECT if missing.)
- Skills `POST /skills` (:176-205) → `storeSkillPackage` (identical to Step 2), `DELETE /skills/:id` (:218+) → identical purge loop.
- Memory routes (~:313-370) → mirror Step 3 (entry delete :325, entry upload :340, content read :367, runner diff route if present on this surface).
- Session delete (~:553-554) + workspace session drain (:502) → keys loop.

- [ ] **Step 5: workspace-delete.ts**

Replace `delObj` and the drains that touch files (:45-64):

```ts
export async function runWorkspaceDelete(repo: WorkspaceDeleteRepo, orchestrator: Orchestrator, files: FileStore, wsId: string) {
  const delKey = async (key: string | null) => {
    if (key) await Promise.resolve(files.del(key)).catch(() => {});
  };
  async function drainAll() {
    // 1. Sessions: stop pods + drop /work PVCs BEFORE the row (the agents→
    //    sessions CASCADE can't do k8s cleanup — same pattern as agent delete).
    await drain(repo, "sessions", wsId, async (id) => {
      await Promise.allSettled([orchestrator.stopSession(id), orchestrator.deleteSessionResources(id)]);
      for (const key of await repo.deleteSession(wsId, id)) await delKey(key);
    });
    // 2+3. Skills and memory stores before files: their file_id FKs are
    //      RESTRICT (migrations 005/006). Entry rows cascade with the store;
    //      the file rows they referenced fall to step 4.
    await drain(repo, "skills", wsId, async (id) => { await repo.deleteSkill(wsId, id); });
    await drain(repo, "memory_stores", wsId, async (id) => { await repo.deleteMemoryStore(wsId, id); });
    // 4. Remaining files (uploads, outputs, checkpoints, skill/memory blobs).
    await drain(repo, "files", wsId, async (id) => {
      const { objectKey } = await repo.deleteFile(wsId, id);
      await delKey(objectKey);
    });
    ...
```

Update the `WorkspaceDeleteRepo` interface (:14-34) to the new return types (`deleteSession → Promise<string[]>` keys, `deleteFile → Promise<{deleted: boolean; objectKey: string | null}>`, `deleteSkill/deleteMemoryStore → Promise<string[]>`). Remove the now-unused `objDeletable` helper and its import/definition (~:13-15,:46) — the shared-key rule replaced the id-format guard here. Fix `test/workspace-delete.test.ts` fakes to the new signatures.

- [ ] **Step 6: Full typecheck + suite**

Run: `cd control-plane && npx tsc --noEmit`
Expected: clean. Fix every remaining caller tsc flags (there should be none outside the files touched above — `orchestrator.ts`/`session-actions.ts` pass file ids, not store calls).

Run: `cd control-plane && npm test`
Expected: PASS (DB-backed suites need dev Postgres up; fix any fake-FileStore stubs in `server.test.ts`/`agents-api.test.ts`/`public-api.test.ts` that still use `put(content)` → `put(content, key)` etc.)

- [ ] **Step 7: Commit**

```bash
git add control-plane/src control-plane/test
git commit -m "feat(cp): route file storage through hierarchical object keys; purge on every delete path"
```

---

### Task 6: GC engine — cron matcher + sweep

**Files:**
- Create: `control-plane/src/gc.ts`
- Modify: `control-plane/src/repo.ts` (add `listOrphanFileRows`, `objectKeyExists`, `getStorageSettings`, `putStorageSettings`, `getGcLastRun`, `setGcLastRun`)
- Test: `control-plane/test/gc.test.ts`

**Interfaces:**
- Consumes: `FileStore` (Task 2), `deleteFileRecordById` (Task 3).
- Produces:
  - `cronMatches(expr: string, d: Date): boolean` (5-field, local time, vixie dom/dow OR-rule)
  - `validateCron(expr: string): string | null`
  - `DEFAULT_GC_CRON = "0 1 * * *"`
  - `type GcSummary = { rows: number; objects: number; bytes: number; at: string; ms: number }`
  - `runGc(repo: GcRepo, files: FileStore, opts?: { graceMs?: number; now?: () => Date }): Promise<GcSummary>`
  - `startGcScheduler(repo: GcRepo & { getStorageSettings(): Promise<{ gcCron: string }> }, files: FileStore): () => void`
  - Repo: `getStorageSettings(): Promise<{ gcCron: string }>`, `putStorageSettings(s: { gcCron: string }): Promise<void>`, `getGcLastRun(): Promise<GcSummary | null>`, `setGcLastRun(s: GcSummary): Promise<void>`, `listOrphanFileRows(graceMs: number): Promise<{ id: string }[]>`, `objectKeyExists(key: string): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

```ts
// control-plane/test/gc.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cronMatches, validateCron, runGc, DEFAULT_GC_CRON } from "../src/gc.ts";
import { localFileStore } from "../src/filestore.ts";

test("cronMatches: default daily 1am", () => {
  assert.equal(validateCron(DEFAULT_GC_CRON), null);
  assert.equal(cronMatches("0 1 * * *", new Date(2026, 6, 14, 1, 0)), true);
  assert.equal(cronMatches("0 1 * * *", new Date(2026, 6, 14, 1, 1)), false);
  assert.equal(cronMatches("0 1 * * *", new Date(2026, 6, 14, 2, 0)), false);
});

test("cronMatches: steps, ranges, lists, weekday", () => {
  assert.equal(cronMatches("*/15 * * * *", new Date(2026, 6, 14, 9, 30)), true);
  assert.equal(cronMatches("*/15 * * * *", new Date(2026, 6, 14, 9, 31)), false);
  assert.equal(cronMatches("0 9-17 * * *", new Date(2026, 6, 14, 12, 0)), true);
  assert.equal(cronMatches("0 0 * * 1,3", new Date(2026, 6, 13, 0, 0)), true);  // 2026-07-13 is a Monday
  assert.equal(cronMatches("0 0 * * 1,3", new Date(2026, 6, 14, 0, 0)), false); // Tuesday
  assert.equal(cronMatches("0 0 * * 7", new Date(2026, 6, 19, 0, 0)), true);    // Sunday as 7
  // vixie rule: dom OR dow when both are restricted
  assert.equal(cronMatches("0 0 13 * 2", new Date(2026, 6, 13, 0, 0)), true);   // dom matches, dow (Tue) doesn't
});

test("validateCron rejects malformed expressions", () => {
  for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "a * * * *", "*/0 * * * *", "1-70 * * * *"]) {
    assert.notEqual(validateCron(bad), null, bad);
  }
  assert.equal(validateCron("*/5 9-17 1,15 * 1-5"), null);
});

test("runGc deletes orphan rows+objects and old unreferenced objects, honors grace", async () => {
  const root = mkdtempSync(join(tmpdir(), "gc-test-"));
  const files = localFileStore(root);
  try {
    await files.put(Buffer.from("orphan-row-content"), "w/sessions/sesn_dead/file_a");
    await files.put(Buffer.from("live"), "w/files/file_live");
    await files.put(Buffer.from("stray-old"), "w/files/file_stray");
    await files.put(Buffer.from("stray-new"), "w/files/file_fresh");
    // Age the stray + orphan objects past the grace window (mtime -2h).
    const old = (Date.now() - 2 * 3600_000) / 1000;
    utimesSync(join(root, "w", "files", "file_stray"), old, old);

    const deletedRows: string[] = [];
    let lastRun: unknown = null;
    const repo = {
      async listOrphanFileRows(_grace: number) { return [{ id: "file_a" }]; },
      async deleteFileRecordById(id: string) { deletedRows.push(id); return "w/sessions/sesn_dead/file_a"; },
      async objectKeyExists(key: string) { return key === "w/files/file_live" || key === "w/files/file_fresh"; },
      async setGcLastRun(s: unknown) { lastRun = s; },
    };
    const summary = await runGc(repo, files, { graceMs: 3600_000 });
    assert.deepEqual(deletedRows, ["file_a"]);
    assert.equal(summary.rows, 1);
    assert.equal(summary.objects, 2); // the orphan row's object + the old stray
    assert.ok(summary.bytes >= "stray-old".length);
    assert.ok(lastRun);
    await assert.rejects(async () => files.get("w/sessions/sesn_dead/file_a"));
    await assert.rejects(async () => files.get("w/files/file_stray"));
    assert.equal((await files.get("w/files/file_fresh")).toString(), "stray-new"); // grace kept it
    assert.equal((await files.get("w/files/file_live")).toString(), "live");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && node --test test/gc.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `control-plane/src/gc.ts`**

```ts
// GC sweep (spec 2026-07-14 §4): safety net for rows/objects that escaped the
// delete paths (crash between the Postgres write and the S3 delete, kubectl
// bypass). Primary hygiene lives in the routes; this reconciles the rest.
// Scheduling: 5-field cron (LOCAL server time) from app_settings, checked
// once a minute — no dependency, standard syntax incl. vixie dom/dow OR-rule.
import type { FileStore } from "./filestore.ts";

export const DEFAULT_GC_CRON = "0 1 * * *";
const GRACE_MS = 3_600_000; // never touch anything younger than 1h (in-flight uploads)

export type GcSummary = { rows: number; objects: number; bytes: number; at: string; ms: number };

export interface GcRepo {
  listOrphanFileRows(graceMs: number): Promise<{ id: string }[]>;
  deleteFileRecordById(id: string): Promise<string | null>;
  objectKeyExists(key: string): Promise<boolean>;
  setGcLastRun(s: GcSummary): Promise<void>;
}

const BOUNDS: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((part) => {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    let lo: number, hi: number;
    if (range === "*") { lo = min; hi = max; }
    else if (range.includes("-")) { [lo, hi] = range.split("-").map(Number); }
    else if (stepStr) { lo = Number(range); hi = max; }
    else return value === Number(range);
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

export function validateCron(expr: string): string | null {
  const fields = (expr ?? "").trim().split(/\s+/);
  if (fields.length !== 5) return "cron needs 5 fields: minute hour day month weekday";
  const names = ["minute", "hour", "day", "month", "weekday"];
  for (let i = 0; i < 5; i++) {
    const [min, max] = BOUNDS[i];
    for (const part of fields[i].split(",")) {
      const m = /^(\*|(\d+)(-(\d+))?)(\/(\d+))?$/.exec(part);
      if (!m) return `bad ${names[i]} field: ${part}`;
      if (m[6] !== undefined && Number(m[6]) < 1) return `bad step in ${names[i]}: ${part}`;
      for (const n of [m[2], m[4]]) {
        if (n !== undefined && (Number(n) < min || Number(n) > max)) return `${names[i]} out of range: ${part}`;
      }
      if (m[2] !== undefined && m[4] !== undefined && Number(m[2]) > Number(m[4])) return `inverted range in ${names[i]}: ${part}`;
    }
  }
  return null;
}

export function cronMatches(expr: string, d: Date): boolean {
  if (validateCron(expr)) return false;
  const [m, h, dom, mon, dow] = expr.trim().split(/\s+/);
  const minHourMon = fieldMatches(m, d.getMinutes(), 0, 59)
    && fieldMatches(h, d.getHours(), 0, 23)
    && fieldMatches(mon, d.getMonth() + 1, 1, 12);
  if (!minHourMon) return false;
  const domOk = fieldMatches(dom, d.getDate(), 1, 31);
  const dowOk = fieldMatches(dow, d.getDay(), 0, 7) || (d.getDay() === 0 && fieldMatches(dow, 7, 0, 7));
  // vixie rule: when BOTH day fields are restricted, either may match.
  return dom !== "*" && dow !== "*" ? domOk || dowOk : domOk && dowOk;
}

export async function runGc(repo: GcRepo, files: FileStore, opts: { graceMs?: number; now?: () => Date } = {}): Promise<GcSummary> {
  const graceMs = opts.graceMs ?? GRACE_MS;
  const now = opts.now ?? (() => new Date());
  const started = now();
  let rows = 0, objects = 0, bytes = 0;
  // 1. Orphan rows (dead/replaced checkpoints, unreferenced skill/memory
  //    files) → row always, object only when unshared.
  for (const r of await repo.listOrphanFileRows(graceMs)) {
    const key = await repo.deleteFileRecordById(r.id).catch(() => null);
    rows++;
    if (key) {
      await Promise.resolve(files.del(key)).catch(() => {});
      objects++;
    }
  }
  // 2. Orphan objects: no files row claims the key, older than grace.
  for await (const obj of files.list()) {
    if (now().getTime() - obj.lastModified.getTime() < graceMs) continue;
    if (await repo.objectKeyExists(obj.key)) continue;
    await Promise.resolve(files.del(obj.key)).catch(() => {});
    objects++;
    bytes += obj.size;
  }
  const summary: GcSummary = { rows, objects, bytes, at: started.toISOString(), ms: now().getTime() - started.getTime() };
  await repo.setGcLastRun(summary).catch(() => {});
  return summary;
}

/** Minute tick against the settings cron. Returns a stop function. */
export function startGcScheduler(repo: GcRepo & { getStorageSettings(): Promise<{ gcCron: string }> }, files: FileStore): () => void {
  let lastMinute = "";
  let running = false;
  const timer = setInterval(async () => {
    const now = new Date();
    const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}T${now.getHours()}:${now.getMinutes()}`;
    if (minute === lastMinute) return;
    lastMinute = minute;
    if (running) return;
    try {
      const { gcCron } = await repo.getStorageSettings();
      if (!cronMatches(gcCron, now)) return;
      running = true;
      const s = await runGc(repo, files);
      console.log(`gc: ${s.rows} rows, ${s.objects} objects, ${s.bytes} bytes in ${s.ms}ms`);
    } catch (err) {
      console.warn("gc sweep failed:", err);
    } finally {
      running = false;
    }
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Add the repo methods**

In `control-plane/src/repo.ts`, next to `getCostSettings` (~line 1222), following the same jsonb pattern:

```ts
// ── Storage / GC settings (spec 2026-07-14) ──────────────────────────────
async getStorageSettings(): Promise<{ gcCron: string }> {
  const { rows } = await this.pool.query("SELECT data->'storage' AS storage FROM app_settings WHERE id = 'global'");
  const gcCron = rows[0]?.storage?.gcCron;
  return { gcCron: typeof gcCron === "string" && gcCron.trim() ? gcCron : DEFAULT_GC_CRON };
}
async putStorageSettings(s: { gcCron: string }) {
  await this.pool.query(
    `UPDATE app_settings SET data = jsonb_set(data, '{storage}', $1::jsonb), updated_at = now() WHERE id = 'global'`,
    [JSON.stringify(s)]);
}
async getGcLastRun(): Promise<GcSummary | null> {
  const { rows } = await this.pool.query("SELECT data->'gcLastRun' AS run FROM app_settings WHERE id = 'global'");
  return rows[0]?.run ?? null;
}
async setGcLastRun(s: GcSummary) {
  await this.pool.query(
    `UPDATE app_settings SET data = jsonb_set(data, '{gcLastRun}', $1::jsonb), updated_at = now() WHERE id = 'global'`,
    [JSON.stringify(s)]);
}

/** GC step 1 input: rows whose owner is gone or that nothing references.
 *  upload/output rows are user-managed — never GC'd. Grace excludes rows
 *  younger than graceMs (turn-end replacement in flight). */
async listOrphanFileRows(graceMs: number): Promise<{ id: string }[]> {
  const { rows } = await this.pool.query(
    `SELECT f.id FROM files f
     WHERE f.created_at < now() - ($1 * interval '1 millisecond') AND (
       (f.kind = 'checkpoint' AND (
          f.session_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = f.session_id)
          OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = f.session_id AND s.checkpoint_file_id IS DISTINCT FROM f.id)))
       OR (f.kind = 'skill' AND NOT EXISTS (
          SELECT 1 FROM skills sk WHERE sk.file_id = f.id
            OR sk.files @> jsonb_build_array(jsonb_build_object('fileId', f.id))))
       OR (f.kind = 'memory' AND NOT EXISTS (
          SELECT 1 FROM memory_entries me WHERE me.file_id = f.id)))`,
    [graceMs]);
  return rows;
}
async objectKeyExists(key: string): Promise<boolean> {
  const { rows } = await this.pool.query("SELECT 1 FROM files WHERE object_key = $1 LIMIT 1", [key]);
  return rows.length > 0;
}
```

Add imports to repo.ts: `import { DEFAULT_GC_CRON, type GcSummary } from "./gc.ts";` (check for import cycles: gc.ts imports only filestore types — none).

Also add an integration test to `test/repo-object-keys.test.ts` (same file as Task 3):

```ts
test("listOrphanFileRows classifies dead-session checkpoints and unreferenced skill/memory files", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-gcq-${Date.now()}`)).id;
  const orphanCp = fid(), freshCp = fid();
  // Dead-session checkpoint, aged out of grace:
  await repo.createFileRecord({ id: orphanCp, name: "cp", size: 1, sha256: "a", objectKey: `${ws}/sessions/sesn_gone/${orphanCp}`, kind: "checkpoint", workspaceId: ws });
  await pool.query("UPDATE files SET session_id = NULL, created_at = now() - interval '2 hours' WHERE id = $1", [orphanCp]);
  // Same shape but FRESH — grace must exclude it:
  await repo.createFileRecord({ id: freshCp, name: "cp", size: 1, sha256: "b", objectKey: `${ws}/sessions/sesn_gone/${freshCp}`, kind: "checkpoint", workspaceId: ws });
  await pool.query("UPDATE files SET session_id = NULL WHERE id = $1", [freshCp]);
  const ids = (await repo.listOrphanFileRows(3_600_000)).map((r) => r.id);
  assert.ok(ids.includes(orphanCp));
  assert.ok(!ids.includes(freshCp));
  assert.equal(await repo.objectKeyExists(`${ws}/sessions/sesn_gone/${orphanCp}`), true);
  await repo.deleteFileRecordById(orphanCp);
  await repo.deleteFileRecordById(freshCp);
  assert.equal(await repo.objectKeyExists(`${ws}/sessions/sesn_gone/${orphanCp}`), false);
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd control-plane && node --test test/gc.test.ts test/repo-object-keys.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/gc.ts control-plane/src/repo.ts control-plane/test/gc.test.ts control-plane/test/repo-object-keys.test.ts
git commit -m "feat(cp): GC sweep engine — cron matcher, orphan classification, grace window"
```

---

### Task 7: Settings + `POST /v1/gc/run` routes, scheduler wiring

**Files:**
- Modify: `control-plane/src/agents-api.ts` (GET/PUT `/v1/settings` :765-790; new `/v1/gc/run` route next to them)
- Modify: `control-plane/src/main.ts` (:126 area — start scheduler)
- Test: `control-plane/test/gc-settings.test.ts` (route-level, following `costs-settings.test.ts` style — read that file first and mirror its server-bootstrap pattern)

**Interfaces:**
- Consumes: Task 6 exports.
- Produces (console depends on these shapes):
  - `GET /v1/settings` → `{ costs, limits, storage: { gcCron: string }, gcLastRun: GcSummary | null }`
  - `PUT /v1/settings` body may carry `storage: { gcCron: string }` — validated with `validateCron`, persisted only when provided (mirrors the limits persist-when-provided rule); response echoes the stored value.
  - `POST /v1/gc/run` → `GcSummary` (synchronous sweep; global, not workspace-guarded — same surface as `/v1/settings`).

- [ ] **Step 1: Write the failing test** — mirror the bootstrap of `test/costs-settings.test.ts` (build the Fastify app the same way it does; skip-if-no-DB). Cases:

```ts
// control-plane/test/gc-settings.test.ts — bootstrap copied from costs-settings.test.ts
test("GET /v1/settings includes storage defaults", ...) 
// → res.storage.gcCron === "0 1 * * *", res.gcLastRun === null (fresh DB) or an object
test("PUT /v1/settings validates gcCron", ...)
// → PUT { storage: { gcCron: "bad" } } → 400 with error mentioning cron
// → PUT { storage: { gcCron: "*/30 * * * *" } } → 200; GET echoes "*/30 * * * *"
// → PUT { costs: {...} } WITHOUT storage → 200; GET still echoes "*/30 * * * *" (persist-when-provided)
test("POST /v1/gc/run returns a summary", ...)
// → res has integer rows/objects/bytes and an ISO `at`; GET /v1/settings gcLastRun.at === res.at
```

Write these as real tests against the same app-construction helper `costs-settings.test.ts` uses (it exists — copy its exact setup; if it spins the full `registerAgentRoutes`, pass a `localFileStore(mkdtemp…)` as `files`).

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && node --test test/gc-settings.test.ts`
Expected: FAIL (storage absent from GET; /v1/gc/run 404)

- [ ] **Step 3: Implement the routes**

In `agents-api.ts`, extend GET (:765):

```ts
app.get("/v1/settings", async () => ({
  costs: await repo.getCostSettings(),
  limits: await repo.getLimits(),
  storage: await repo.getStorageSettings(),
  gcLastRun: await repo.getGcLastRun(),
}));
```

In the PUT handler (:770-790), after the limits handling, add (mirroring its persist-when-provided comment style):

```ts
// Persist storage only when the body carries an explicit gcCron (same
// convention as limits): an omitted block leaves the stored cron untouched.
let storage = await repo.getStorageSettings();
const sb = (b as { storage?: { gcCron?: unknown } }).storage;
if (sb?.gcCron !== undefined) {
  if (typeof sb.gcCron !== "string") return reply.code(400).send({ error: "gcCron must be a string" });
  const cronErr = validateCron(sb.gcCron);
  if (cronErr) return reply.code(400).send({ error: `gcCron: ${cronErr}` });
  storage = { gcCron: sb.gcCron.trim() };
  await repo.putStorageSettings(storage);
}
```

and include `storage` in the PUT response object (read the current return statement and add the field). Import `validateCron, runGc` from `./gc.ts`.

New route right below:

```ts
// Manual GC trigger (console "Run GC now"). Synchronous: the sweep is
// row-count bounded and the console shows the returned summary.
app.post("/v1/gc/run", async () => runGc(repo, files));
```

In `main.ts`, after `startReconciler(...)` (:126):

```ts
startGcScheduler(repo, files);
```

with `import { startGcScheduler } from "./gc.ts";` at the top.

- [ ] **Step 4: Run to verify it passes**

Run: `cd control-plane && node --test test/gc-settings.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/src/main.ts control-plane/test/gc-settings.test.ts
git commit -m "feat(cp): storage settings (gcCron) + POST /v1/gc/run + scheduler wiring"
```

---

### Task 8: Console — Storage panel on /settings

**Files:**
- Modify: `console/app/settings/page.tsx`
- Modify: `console/app/settings/form.tsx`

**Interfaces:**
- Consumes: `GET /v1/settings` → `{ costs, limits, storage: { gcCron }, gcLastRun }`; `PUT /v1/settings` with `storage: { gcCron }`; `POST /v1/gc/run` → `GcSummary`. Client helpers: `apiPost` from `app/lib/client.ts` (returns raw `Response`), `submitJson` from `app/lib/modal.tsx` (already used by the form).

No component test infra exists for the console — verification is the production build + live click-through (Task 11).

- [ ] **Step 1: page.tsx — pass the new fields**

```tsx
import { wsGet } from "../lib/api";
import type { CostSettings } from "../lib/currency";
import { SettingsForm } from "./form";

export const dynamic = "force-dynamic";

type GcSummary = { rows: number; objects: number; bytes: number; at: string; ms: number };

export default async function SettingsPage() {
  const s = await wsGet<{ costs: CostSettings; limits: { maxWorkGb: number }; storage: { gcCron: string }; gcLastRun: GcSummary | null }>("/v1/settings").catch(() => null);
  return (
    <>
      <div className="pagehead"><h1>Settings</h1></div>
      <p className="sub">Platform-wide settings. Cost tracking and billing apply across all workspaces.</p>
      {s ? <SettingsForm initial={s.costs} initialLimits={s.limits} initialStorage={s.storage} gcLastRun={s.gcLastRun} />
         : <div className="empty">Control plane unreachable.</div>}
    </>
  );
}
```

- [ ] **Step 2: form.tsx — Storage accordion panel**

Extend the props + state (matching the existing style exactly):

```tsx
type GcSummary = { rows: number; objects: number; bytes: number; at: string; ms: number };

export function SettingsForm({ initial, initialLimits, initialStorage, gcLastRun }: {
  initial: CostSettings; initialLimits: { maxWorkGb: number };
  initialStorage: { gcCron: string }; gcLastRun: GcSummary | null;
}) {
  ...
  const [gcCron, setGcCron] = useState(initialStorage?.gcCron ?? "0 1 * * *");
  const [gcBusy, setGcBusy] = useState(false);
  const [gcMsg, setGcMsg] = useState<string | null>(null);
```

Extend `save` to include storage:

```tsx
const err = await submitJson("PUT", "/v1/settings", { costs: c, limits: { maxWorkGb: n }, storage: { gcCron: gcCron.trim() } });
```

Add `runGcNow` (uses the existing `apiPost` client helper — import it: `import { apiPost } from "../lib/client";`):

```tsx
const fmtBytes = (b: number) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`;

const runGcNow = async () => {
  setGcBusy(true); setGcMsg(null);
  try {
    const res = await apiPost("/v1/gc/run", {});
    if (!res.ok) { setGcMsg(`GC failed (${res.status})`); return; }
    const s: GcSummary = await res.json();
    setGcMsg(`Done — ${s.rows} rows, ${s.objects} objects, ${fmtBytes(s.bytes)} reclaimed.`);
    router.refresh();
  } finally { setGcBusy(false); }
};
```

New accordion panel between the Limits `</details>` and the closing `</div>` of `setacc-group` (reuse the `cache` icon — the database cylinder, `Icon.cache` in `app/lib/icons.tsx:23`):

```tsx
<details className="setacc" open>
  <summary><Icon.cache />Storage</summary>
  <div className="setpanel">
    <label className="setrow plain">
      <span />
      <span className="setrow-name">Garbage collection schedule</span>
      <span className="setrow-hint" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input value={gcCron} onChange={(e) => setGcCron(e.target.value)}
               style={{ width: 130, flex: "none", fontFamily: "var(--mono, monospace)" }} />
        5-field cron, server local time — default 0 1 * * * (daily 1:00)
      </span>
    </label>
    <label className="setrow plain">
      <span />
      <span className="setrow-name">Run now</span>
      <span className="setrow-hint" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" disabled={gcBusy} onClick={runGcNow} style={{ flex: "none" }}>
          {gcBusy ? "Sweeping…" : "Run GC now"}
        </button>
        {gcMsg ?? (gcLastRun
          ? `Last run ${new Date(gcLastRun.at).toLocaleString()} — ${gcLastRun.rows} rows, ${gcLastRun.objects} objects, ${fmtBytes(gcLastRun.bytes)} reclaimed`
          : "never run")}
      </span>
    </label>
  </div>
</details>
```

(Buttons default to solid fills in this design system — do NOT add a ghost/transparent style.)

- [ ] **Step 3: Build**

Run: `cd console && npx next build`
Expected: build succeeds, `/settings` compiles.

- [ ] **Step 4: Commit**

```bash
git add console/app/settings
git commit -m "feat(console): Storage settings panel — GC cron + Run now button + last-run summary"
```

---

### Task 9: Update project docs (CLAUDE.md)

**Files:**
- Modify: `CLAUDE.md` (repo root)

- [ ] **Step 1: Amend the Files bullet** in `## Conventions & gotchas` — replace the existing `**Files**` bullet with:

```markdown
- **Files** scale via MinIO/S3 (`s3FileStore`), keyed hierarchically `<ws>/<type>/<id>[/<path>]` (spec 2026-07-14: `<ws>/files/<file_id>`, `<ws>/sessions/<sesn>/<file_id>` checkpoints, `<ws>/memory/<store>/<path>`, `<ws>/skills/<skill>/<path>`); the key is stamped at insert into `files.object_key` (migration 033) — NEVER derived on read. FileStore is a dumb KV store; ids/sha256 are minted by routes. Every delete path purges rows+objects via the shared-key rule (`deleteFileRecordById` returns the key only when unshared). Safety net: GC sweep (`src/gc.ts`, cron in app_settings `storage.gcCron`, default `0 1 * * *`, console /settings Storage panel + `POST /v1/gc/run`) reclaims orphan rows/objects with a 1h grace window; upload/output kinds are never GC'd.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: object-key storage layout + GC in project notes"
```

---

### Task 10: One-time dev wipe (live cluster operation)

**Files:** none (operational task). Run AFTER Tasks 1–9 are committed and the CP is restarted on the new code (migration 033 must have applied).

Prereqs: CP running on :7080; kubectl context = docker-desktop. Pod names below were live on 2026-07-14 — re-resolve with `kubectl get pods -n devproof-system -l app=postgres` / `-n devproof-storage -l app=devproof-minio` if they rotated.

- [ ] **Step 1: Restart the CP on the new code** (out-of-cluster, per CLAUDE.md run notes) and confirm migration applied:

```bash
kubectl -n devproof-system exec deploy/postgres -- psql -U devproof -d devproof -At -c "SELECT count(*) FROM information_schema.columns WHERE table_name='files' AND column_name='object_key';"
```
Expected: `1`

- [ ] **Step 2: Delete every session via the API** (cleans K8s Jobs + `-work` PVCs):

```bash
kubectl -n devproof-system exec deploy/postgres -- psql -U devproof -d devproof -At -c "SELECT id || '|' || workspace_id FROM sessions;" |
while IFS='|' read -r sid wsid; do
  curl -s -o /dev/null -w "%{http_code} $sid\n" -X DELETE -H "X-Devproof-Workspace: $wsid" "http://localhost:7080/v1/sessions/$sid"
done
```
Expected: `204` per line.

- [ ] **Step 3: Drain + hard-delete the 36 non-default workspaces** via the existing workspace-delete machinery (proper K8s cleanup for their envs/vaults), then drop the tombstones:

```bash
for wsid in $(kubectl -n devproof-system exec deploy/postgres -- psql -U devproof -d devproof -At -c "SELECT id FROM workspaces WHERE id <> 'wrkspc_default' AND status <> 'deleted';"); do
  curl -s -o /dev/null -w "%{http_code} $wsid\n" -X DELETE "http://localhost:7080/v1/workspaces/$wsid"
done
# Poll until every drain reports done (repeat until 0):
kubectl -n devproof-system exec deploy/postgres -- psql -U devproof -d devproof -At -c "SELECT count(*) FROM workspaces WHERE status = 'deleting';"
# Then drop tombstones (gateway_usage has NO workspace FK — verified 2026-07-14):
kubectl -n devproof-system exec deploy/postgres -- psql -U devproof -d devproof -c "DELETE FROM workspaces WHERE id <> 'wrkspc_default';"
```

- [ ] **Step 4: Wipe the remaining default-workspace data** (agents/skills/memory/files; envs, vaults, keys, webhooks, usage/cost ledgers, Serving all SURVIVE):

```bash
kubectl -n devproof-system exec deploy/postgres -- psql -U devproof -d devproof -c "
BEGIN;
DELETE FROM skills;
DELETE FROM memory_stores;   -- entries cascade
DELETE FROM agents;          -- versions cascade; sessions already gone
DELETE FROM files;
DELETE FROM file_uploads;
DELETE FROM pending_launches;
COMMIT;"
```
(If `pending_launches` has an FK error because it's already empty via session cascade, that's fine — the statement is still valid.)

- [ ] **Step 5: Empty the bucket:**

```bash
kubectl -n devproof-storage exec deploy/minio -- sh -c '
mc alias set loc http://127.0.0.1:9000 devproof devproof-dev-secret >/dev/null 2>&1
mc rm --recursive --force loc/devproof-files/
mc ls --recursive loc/devproof-files | wc -l'
```
Expected: final count `0`.

- [ ] **Step 6: Verify zero state:**

```bash
kubectl -n devproof-system exec deploy/postgres -- psql -U devproof -d devproof -At -c "
SELECT 'sessions', count(*) FROM sessions UNION ALL
SELECT 'files', count(*) FROM files UNION ALL
SELECT 'skills', count(*) FROM skills UNION ALL
SELECT 'memory_stores', count(*) FROM memory_stores UNION ALL
SELECT 'agents', count(*) FROM agents UNION ALL
SELECT 'workspaces', count(*) FROM workspaces;"
```
Expected: all `0` except `workspaces|1`. Also verify environments/vaults/api_keys still have their rows (`SELECT count(*) FROM environments;` etc. — non-zero as before minus the deleted workspaces').

No commit (nothing in the repo changed).

---

### Task 11: End-to-end verification

**Files:** none new; fixes only if verification finds bugs.

- [ ] **Step 1: Full test suite + typecheck**

```bash
cd control-plane && npm test && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 2: Restart console** (`cd console && npx next build && npx next start -p 7090` — build BEFORE start, never under a running server) and confirm all pages 200 (dashboard, sessions, agents, skills, memory, files, settings, deployments, pools, catalog, usage, workspaces).

- [ ] **Step 3: Exercise the hierarchical keys live**

1. Upload a skill zip on the Skills page (or `curl -F "file=@x.zip" "localhost:7080/v1/skills?name=demo"`).
2. Upload a plain file on the Files page.
3. Create an agent + run a short session so a checkpoint lands (existing env + local model).
4. Inspect the bucket:

```bash
kubectl -n devproof-storage exec deploy/minio -- sh -c '
mc alias set loc http://127.0.0.1:9000 devproof devproof-dev-secret >/dev/null 2>&1
mc ls --recursive loc/devproof-files'
```
Expected: ONLY keys shaped `wrkspc_default/files/file_…`, `wrkspc_default/skills/skill_…/SKILL.md`, `wrkspc_default/sessions/sesn_…/file_…`. Nothing flat.

5. Re-upload the same skill zip with one file removed → confirm the dropped path's object disappears and version bumps.
6. Delete the session in the console → confirm its `sessions/sesn_…/` prefix is gone from the bucket AND `SELECT count(*) FROM files WHERE session_id IS NULL` stays `0`.

- [ ] **Step 4: Exercise GC end-to-end**

Plant an artificial leak (aged orphan row + object), then use the console button:

```bash
kubectl -n devproof-storage exec deploy/minio -- sh -c '
mc alias set loc http://127.0.0.1:9000 devproof devproof-dev-secret >/dev/null 2>&1
echo leak | mc pipe loc/devproof-files/wrkspc_default/sessions/sesn_fake/file_leakleak0001'
kubectl -n devproof-system exec deploy/postgres -- psql -U devproof -d devproof -c "
INSERT INTO files (id, workspace_id, name, size, sha256, kind, object_key, created_at)
VALUES ('file_leakleak0001', 'wrkspc_default', 'cp', 5, 'x', 'checkpoint', 'wrkspc_default/sessions/sesn_fake/file_leakleak0001', now() - interval '2 hours');"
```

On `/settings` → Storage → **Run GC now**. Expected message: `Done — 1 rows, 1 objects, 5 B reclaimed.` Verify the row and object are gone. Confirm the last-run line renders after a page reload.

- [ ] **Step 5: Settings persistence** — change the cron to `*/30 * * * *`, Save, reload → field shows `*/30 * * * *`; set it to garbage (`banana`) → Save shows the 400 error message; restore `0 1 * * *`, Save.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A && git commit -m "fix: verification fallout for object-key storage + GC"
```
(Skip if nothing changed.)

---

## Self-Review Notes (already applied)

- **Spec §2 checkpoint key**: plan uses `<ws>/sessions/<sesn_id>/<file_id>` per the spec AMENDMENT (stale-pod clobber) — not the original bare-session-id key.
- **Spec §4 multipart abort**: already implemented pre-plan as `sweepStaleUploads` (public-api.ts:26, hourly in main.ts:117-118) — Task 5 re-keys it; GC does not duplicate it.
- **Type consistency**: `deleteFileRecordById → string | null`; `deleteFile → {deleted, objectKey}`; `deleteSession → string[]` (KEYS); `deleteSkill`/`deleteMemoryStore → string[]` (IDS, purged via `deleteFileRecordById`). Routes never call `files.del` with an id.
- **`gcLastRun.at` vs summary time**: summary stamps sweep START (`started.toISOString()`).
