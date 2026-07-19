# Public API (dpk_-authenticated managed-agents surface) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the full managed-agents surface (files incl. 4 GB chunked uploads, skills, memory stores, vaults, environments, agents, sessions) under a new `dpk_`-authenticated `/api/*` namespace in the control plane, reachable through the gateway via a LiteLLM pass-through, with an Anthropic-SDK-styled Python library and five example scripts.

**Architecture:** Two route namespaces in the CP — existing `/v1/*` (UI + runner callbacks, untouched) and new `/api/*` (public contract, API-key auth, workspace derived from the key). The gateway forwards `/api/*` blindly (`pass_through_endpoints`, config-only change); the CP validates keys. Session create/message logic and the SSE loop are extracted into shared modules so both namespaces use identical behavior with zero duplication.

**Tech Stack:** Fastify + `@fastify/multipart` (CP), `@aws-sdk/client-s3` multipart upload (MinIO), node:test, LiteLLM `pass_through_endpoints`, Python 3.10+ with `httpx`.

**Spec:** `docs/superpowers/specs/2026-07-12-public-api-design.md` — read it first; the "Verified transport facts" section lists load-bearing constraints.

## Global Constraints

- Public prefix is `/api/<resource>` — **never** put a `/v1` segment after `/api` (LiteLLM built-in route collision, verified).
- All public upload endpoints are **multipart** (raw octet-stream bodies are destroyed by the pass-through, verified).
- Streaming responses (SSE, file downloads) must be **POST with `{"stream": true}`** in a JSON body (plain GET responses are buffered by the pass-through, verified).
- Workspace on `/api/*` comes from the API key row; the `X-Devproof-Workspace` header is ignored there.
- `/v1/*` routes must not change behavior (console + runner depend on them); the only `/v1` edits allowed are the mechanical extraction refactors in Task 4 (existing tests must pass unchanged).
- Chunk size for chunked uploads: **32 MiB** (`33554432` bytes).
- `custom_callbacks.py` (gateway ConfigMap) is **not modified**.
- Node tests: `cd control-plane && npm test`; types: `npx tsc --noEmit`.
- Commit after every task (steps include the commands).

## File Map

| File | Responsibility |
|---|---|
| `control-plane/src/public-auth.ts` (new) | dpk_ key extraction, sha256 lookup, TTL cache, preHandler |
| `control-plane/src/public-api.ts` (new) | every `/api/*` route |
| `control-plane/src/session-actions.ts` (new) | shared create-session / send-message logic (used by `/v1` and `/api`) |
| `control-plane/src/session-sse.ts` (new) | shared SSE poll-follow loop (used by `/v1` and `/api`) |
| `control-plane/src/filestore.ts` (modify) | `getStream` + multipart upload ops on both stores |
| `control-plane/src/repo.ts` (modify) | key lookup, `touchApiKey`, file-upload CRUD |
| `control-plane/sql/026_file_uploads.sql` (new) | chunked-upload state table |
| `control-plane/src/agents-api.ts` (modify) | delegate to session-actions/session-sse (no behavior change) |
| `control-plane/src/main.ts` (modify) | register public API, start upload sweep |
| `control-plane/src/gateway-config.ts` + `src/server.ts` (modify) | pass-through block in generated config |
| `clients/python/devproof/{__init__,errors,_http,resources}.py` (rewrite) | Python client |
| `examples/api/*` (new) | five example scripts + shared helper + README |

---

### Task 1: API-key auth for the control plane

**Files:**
- Create: `control-plane/src/public-auth.ts`
- Modify: `control-plane/src/repo.ts` (append two methods near `createApiKey`, ~line 756)
- Test: `control-plane/test/public-auth.test.ts`

**Interfaces:**
- Consumes: `api_keys` table (011_keys_batches.sql: `id`, `workspace_id`, `secret_hash`, `status`).
- Produces: `Repo.findApiKeyBySecretHash(hash: string): Promise<{ id: string; workspace_id: string } | null>`; `Repo.touchApiKey(id: string): Promise<void>`; `apiKeyAuth(repo, ttlMs?): preHandler` which on success sets `(req as any).apiKey = { id, workspaceId }` and on failure replies 401 `{ error: "invalid API key" }`. Task 2+ call `wsOf(req) = (req as any).apiKey.workspaceId`.

- [ ] **Step 1: Write the failing test**

```ts
// control-plane/test/public-auth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createHash } from "node:crypto";
import { apiKeyAuth } from "../src/public-auth.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function makeRepo() {
  const keys: Record<string, { id: string; workspace_id: string }> = {
    [sha("dpk_good")]: { id: "apikey_1", workspace_id: "wrkspc_a" },
  };
  return {
    lookups: 0,
    touched: [] as string[],
    async findApiKeyBySecretHash(h: string) { this.lookups++; return keys[h] ?? null; },
    async touchApiKey(id: string) { this.touched.push(id); },
  };
}

async function makeApp(repo: any) {
  const app = Fastify();
  app.addHook("preHandler", apiKeyAuth(repo));
  app.get("/x", async (req) => ({ ws: (req as any).apiKey.workspaceId, key: (req as any).apiKey.id }));
  return app;
}

test("valid Bearer key attaches workspace from the key row", async () => {
  const app = await makeApp(makeRepo());
  const res = await app.inject({ method: "GET", url: "/x", headers: { authorization: "Bearer dpk_good" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ws: "wrkspc_a", key: "apikey_1" });
});

test("x-api-key header also accepted", async () => {
  const app = await makeApp(makeRepo());
  const res = await app.inject({ method: "GET", url: "/x", headers: { "x-api-key": "dpk_good" } });
  assert.equal(res.statusCode, 200);
});

test("missing / malformed / unknown key → 401", async () => {
  const app = await makeApp(makeRepo());
  for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: "Bearer dpk_bad" }] as any[]) {
    const res = await app.inject({ method: "GET", url: "/x", headers });
    assert.equal(res.statusCode, 401, JSON.stringify(headers));
    assert.deepEqual(res.json(), { error: "invalid API key" });
  }
});

test("positive lookups are cached within TTL; touch is throttled", async () => {
  const repo = makeRepo();
  const app = await makeApp(repo);
  for (let i = 0; i < 3; i++) {
    await app.inject({ method: "GET", url: "/x", headers: { authorization: "Bearer dpk_good" } });
  }
  assert.equal(repo.lookups, 1);       // 2nd + 3rd hit the cache
  assert.equal(repo.touched.length, 1); // last_used_at throttled
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --test test/public-auth.test.ts`
Expected: FAIL — `Cannot find module '../src/public-auth.ts'`

- [ ] **Step 3: Implement `public-auth.ts` and the repo methods**

```ts
// control-plane/src/public-auth.ts
// dpk_ API-key auth for the public /api namespace (spec 2026-07-12).
// The gateway's custom_auth also validates pass-through requests (defense in
// depth); this check is the authoritative one. Workspace comes from the key.
import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface ApiKeyRepo {
  findApiKeyBySecretHash(hash: string): Promise<{ id: string; workspace_id: string } | null>;
  touchApiKey(id: string): Promise<void>;
}

const TOUCH_INTERVAL_MS = 60_000;

export function apiKeyAuth(repo: ApiKeyRepo, ttlMs = 30_000) {
  const cache = new Map<string, { id: string; workspaceId: string; expires: number }>();
  const lastTouch = new Map<string, number>();
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = (req.headers.authorization as string | undefined) ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : (req.headers["x-api-key"] as string | undefined) ?? "";
    if (!key.startsWith("dpk_")) return reply.code(401).send({ error: "invalid API key" });
    const hash = createHash("sha256").update(key).digest("hex");
    let hit = cache.get(hash);
    if (!hit || hit.expires < Date.now()) {
      const row = await repo.findApiKeyBySecretHash(hash);
      if (!row) return reply.code(401).send({ error: "invalid API key" });
      hit = { id: row.id, workspaceId: row.workspace_id, expires: Date.now() + ttlMs };
      cache.set(hash, hit);
    }
    if ((lastTouch.get(hit.id) ?? 0) + TOUCH_INTERVAL_MS < Date.now()) {
      lastTouch.set(hit.id, Date.now());
      repo.touchApiKey(hit.id).catch(() => {}); // fire-and-forget
    }
    (req as any).apiKey = { id: hit.id, workspaceId: hit.workspaceId };
  };
}
```

Append to `control-plane/src/repo.ts` directly after `setApiKeyStatus` (~line 783):

```ts
  /** Public-API auth: active-key lookup by sha256(secret). */
  async findApiKeyBySecretHash(hash: string): Promise<{ id: string; workspace_id: string } | null> {
    const { rows } = await this.pool.query(
      "SELECT id, workspace_id FROM api_keys WHERE secret_hash = $1 AND status = 'active'", [hash]);
    return rows[0] ?? null;
  }
  async touchApiKey(id: string) {
    await this.pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [id]);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd control-plane && node --test test/public-auth.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
cd control-plane && npx tsc --noEmit
git add control-plane/src/public-auth.ts control-plane/src/repo.ts control-plane/test/public-auth.test.ts
git commit -m "feat(cp): dpk_ API-key auth preHandler for the public API"
```

---

### Task 2: FileStore streaming get + multipart upload operations

**Files:**
- Modify: `control-plane/src/filestore.ts`
- Test: `control-plane/test/filestore.test.ts` (new)

**Interfaces:**
- Produces (added to `FileStore`, all optional so existing fakes stay valid):
  - `getStream?(id: string): Promise<NodeJS.ReadableStream>`
  - `createUpload?(id: string): Promise<string>` — returns opaque `uploadKey`
  - `uploadPart?(id: string, uploadKey: string, partNumber: number, data: Buffer): Promise<string>` — returns `etag`
  - `completeUpload?(id: string, uploadKey: string, parts: { n: number; etag: string }[]): Promise<void>`
  - `abortUpload?(id: string, uploadKey: string): Promise<void>`
- Task 3's routes call these; Task 3's fake filestore mirrors these signatures.

- [ ] **Step 1: Write the failing test (local store — S3 is structurally identical and verified live in Task 9)**

```ts
// control-plane/test/filestore.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localFileStore } from "../src/filestore.ts";

test("local store: multipart upload assembles parts in order; getStream reads back", async () => {
  const store = localFileStore(mkdtempSync(join(tmpdir(), "dpfs-")));
  const id = "file_uploadtest1";
  const key = await store.createUpload!(id);
  const p1 = Buffer.from("hello ");
  const p2 = Buffer.from("world");
  const e2 = await store.uploadPart!(id, key, 2, p2); // out-of-order arrival is fine
  const e1 = await store.uploadPart!(id, key, 1, p1);
  await store.completeUpload!(id, key, [{ n: 1, etag: e1 }, { n: 2, etag: e2 }]);
  assert.equal((await store.get(id)).toString(), "hello world");
  const chunks: Buffer[] = [];
  for await (const c of await store.getStream!(id)) chunks.push(Buffer.from(c));
  assert.equal(Buffer.concat(chunks).toString(), "hello world");
});

test("local store: abort removes staged parts", async () => {
  const store = localFileStore(mkdtempSync(join(tmpdir(), "dpfs-")));
  const id = "file_uploadtest2";
  const key = await store.createUpload!(id);
  await store.uploadPart!(id, key, 1, Buffer.from("x"));
  await store.abortUpload!(id, key);
  assert.throws(() => store.get(id)); // never assembled
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --test test/filestore.test.ts`
Expected: FAIL — `store.createUpload is not a function`

- [ ] **Step 3: Implement**

Extend the interface in `filestore.ts`:

```ts
export interface FileStore {
  put(content: Buffer): Promise<{ id: string; sha256: string; size: number }> | { id: string; sha256: string; size: number };
  get(id: string): Promise<Buffer> | Buffer;
  del?(id: string): Promise<void> | void;
  /** Streaming read for large objects (public-API downloads). */
  getStream?(id: string): Promise<NodeJS.ReadableStream>;
  // Chunked uploads (public API, 4 GB files). id is the final object id,
  // reserved by the caller; uploadKey is store-opaque (S3 UploadId).
  createUpload?(id: string): Promise<string>;
  uploadPart?(id: string, uploadKey: string, partNumber: number, data: Buffer): Promise<string>;
  completeUpload?(id: string, uploadKey: string, parts: { n: number; etag: string }[]): Promise<void>;
  abortUpload?(id: string, uploadKey: string): Promise<void>;
}
```

Add to the object returned by `localFileStore` (parts staged as sibling files):

```ts
    async getStream(id: string) {
      if (!/^file_[a-z0-9]+$/.test(id)) throw new Error("bad file id");
      const { createReadStream } = await import("node:fs");
      return createReadStream(join(root, id));
    },
    async createUpload(id: string) {
      if (!/^file_[a-z0-9]+$/.test(id)) throw new Error("bad file id");
      return "local";
    },
    async uploadPart(id: string, _key: string, n: number, data: Buffer) {
      writeFileSync(join(root, `${id}.part${n}`), data);
      return createHash("sha256").update(data).digest("hex").slice(0, 16);
    },
    async completeUpload(id: string, _key: string, parts: { n: number; etag: string }[]) {
      const { createWriteStream, createReadStream } = await import("node:fs");
      const { pipeline } = await import("node:stream/promises");
      const out = createWriteStream(join(root, id));
      for (const p of [...parts].sort((a, b) => a.n - b.n)) {
        await pipeline(createReadStream(join(root, `${id}.part${p.n}`)), out, { end: false });
      }
      out.end();
      await new Promise((r, j) => { out.on("close", r); out.on("error", j); });
      for (const p of parts) { try { rmSync(join(root, `${id}.part${p.n}`)); } catch { /* gone */ } }
    },
    async abortUpload(id: string, _key: string) {
      const { readdirSync } = await import("node:fs");
      for (const f of readdirSync(root)) {
        if (f.startsWith(`${id}.part`)) { try { rmSync(join(root, f)); } catch { /* gone */ } }
      }
    },
```

Add to the object returned by `s3FileStore` (destructure the extra commands from the same `require("@aws-sdk/client-s3")` call: `CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`):

```ts
    async getStream(id: string) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: id }));
        return res.Body as NodeJS.ReadableStream;
      } catch (err: any) {
        if (err?.name !== "NoSuchKey") throw err;
        const res = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: id.replace(/^file_/, "") }));
        return res.Body as NodeJS.ReadableStream;
      }
    },
    async createUpload(id: string) {
      const res = await client.send(new CreateMultipartUploadCommand({ Bucket: opts.bucket, Key: id }));
      return res.UploadId as string;
    },
    async uploadPart(id: string, uploadKey: string, partNumber: number, data: Buffer) {
      const res = await client.send(new UploadPartCommand({
        Bucket: opts.bucket, Key: id, UploadId: uploadKey, PartNumber: partNumber, Body: data,
      }));
      return res.ETag as string;
    },
    async completeUpload(id: string, uploadKey: string, parts: { n: number; etag: string }[]) {
      await client.send(new CompleteMultipartUploadCommand({
        Bucket: opts.bucket, Key: id, UploadId: uploadKey,
        MultipartUpload: { Parts: [...parts].sort((a, b) => a.n - b.n).map((p) => ({ PartNumber: p.n, ETag: p.etag })) },
      }));
    },
    async abortUpload(id: string, uploadKey: string) {
      try {
        await client.send(new AbortMultipartUploadCommand({ Bucket: opts.bucket, Key: id, UploadId: uploadKey }));
      } catch { /* already gone */ }
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd control-plane && node --test test/filestore.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
cd control-plane && npx tsc --noEmit
git add control-plane/src/filestore.ts control-plane/test/filestore.test.ts
git commit -m "feat(cp): filestore streaming reads + S3 multipart upload ops"
```

---

### Task 3: Public API — files (single-shot, chunked uploads, streamed download) + registration

**Files:**
- Create: `control-plane/src/public-api.ts`
- Create: `control-plane/sql/026_file_uploads.sql`
- Modify: `control-plane/src/repo.ts` (file-upload CRUD)
- Modify: `control-plane/src/main.ts` (register + sweep)
- Test: `control-plane/test/public-api.test.ts`

**Interfaces:**
- Consumes: `apiKeyAuth` (Task 1), FileStore multipart ops (Task 2), `repo.createFileRecord/getFileRecord/listAllFiles/deleteFile`, `rid`/`shortId` pattern.
- Produces:
  - `registerPublicApi(app, repo, orchestrator, files, notify?): Promise<void>` — everything under prefix `/api`.
  - `sweepStaleUploads(repo, files, olderThanMs?): Promise<void>` (exported for main.ts + tests).
  - Repo methods: `createFileUpload(ws, m: {id, fileId, uploadKey, name, kind, partSize})`, `getFileUpload(ws, id)`, `recordUploadPart(id, part: {n, etag, sha256, size})`, `deleteFileUpload(id)`, `listStaleFileUploads(olderThanMs): Promise<{id, upload_key, file_id}[]>`.
  - Route contract (files portion): see code below. Chunk size constant `PART_SIZE = 33554432`. Chunked-file `sha256` is the **composite** `sha256(part1Hex + part2Hex + ...)` — the Python lib (Task 7) computes the same composite for verification.

- [ ] **Step 1: Write the migration**

```sql
-- control-plane/sql/026_file_uploads.sql — chunked public-API uploads (spec 2026-07-12).
-- In-flight multipart uploads; completed/aborted rows are deleted. parts is
-- [{n, etag, sha256, size}]. file_id is the reserved final files.id.
CREATE TABLE IF NOT EXISTS file_uploads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  upload_key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'upload',
  part_size BIGINT NOT NULL,
  parts JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Add repo methods** (append near `createFileRecord`, ~line 691 of `repo.ts`)

```ts
  // ── Chunked public-API uploads (spec 2026-07-12) ─────────────────────────
  async createFileUpload(workspaceId: string, m: { id: string; fileId: string; uploadKey: string; name: string; kind: string; partSize: number }) {
    await this.pool.query(
      "INSERT INTO file_uploads (id, workspace_id, file_id, upload_key, name, kind, part_size) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [m.id, workspaceId, m.fileId, m.uploadKey, m.name, m.kind, m.partSize]);
    return { id: m.id, file_id: m.fileId, part_size: m.partSize };
  }
  async getFileUpload(workspaceId: string, id: string) {
    const { rows } = await this.pool.query(
      "SELECT * FROM file_uploads WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
    return rows[0] ?? null;
  }
  /** Record (or replace, for retries) one uploaded part. */
  async recordUploadPart(id: string, part: { n: number; etag: string; sha256: string; size: number }) {
    await this.pool.query(
      `UPDATE file_uploads SET parts =
         (SELECT COALESCE(jsonb_agg(p), '[]'::jsonb) FROM jsonb_array_elements(parts) p WHERE (p->>'n')::int <> $2)
         || $3::jsonb
       WHERE id = $1`,
      [id, part.n, JSON.stringify([part])]);
  }
  async deleteFileUpload(id: string) {
    await this.pool.query("DELETE FROM file_uploads WHERE id = $1", [id]);
  }
  async listStaleFileUploads(olderThanMs: number) {
    const { rows } = await this.pool.query(
      "SELECT id, upload_key, file_id FROM file_uploads WHERE created_at < now() - make_interval(secs => $1)",
      [olderThanMs / 1000]);
    return rows;
  }
```

- [ ] **Step 3: Write the failing route tests**

```ts
// control-plane/test/public-api.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createHash } from "node:crypto";
import { registerPublicApi, sweepStaleUploads, PART_SIZE } from "../src/public-api.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const KEY = "dpk_test";

export function publicFakes() {
  const fileRecords: any[] = [];
  const uploads: Record<string, any> = {};
  const stored: Record<string, Buffer> = {};
  const parts: Record<string, Record<number, Buffer>> = {};
  const aborted: string[] = [];
  const repo: any = {
    async findApiKeyBySecretHash(h: string) {
      return h === sha(KEY) ? { id: "apikey_t", workspace_id: "wrkspc_t" } : null;
    },
    async touchApiKey() {},
    async createFileRecord(m: any) { fileRecords.push(m); return m; },
    async getFileRecord(id: string) { return fileRecords.find((f) => f.id === id) ?? null; },
    async listAllFiles(ws: string) { return { files: fileRecords.filter((f) => f.workspaceId === ws || f.workspace_id === ws), total: fileRecords.length, limit: 100, offset: 0 }; },
    async deleteFile(_ws: string, id: string) {
      const i = fileRecords.findIndex((f) => f.id === id);
      if (i < 0) return false;
      fileRecords.splice(i, 1); return true;
    },
    async createFileUpload(_ws: string, m: any) { uploads[m.id] = { ...m, workspace_id: _ws, parts: [], created_at: new Date() }; return { id: m.id, file_id: m.fileId, part_size: m.partSize }; },
    async getFileUpload(_ws: string, id: string) { return uploads[id] ?? null; },
    async recordUploadPart(id: string, p: any) {
      uploads[id].parts = uploads[id].parts.filter((x: any) => x.n !== p.n).concat([p]);
    },
    async deleteFileUpload(id: string) { delete uploads[id]; },
    async listStaleFileUploads() { return Object.values(uploads).map((u: any) => ({ id: u.id, upload_key: u.uploadKey ?? u.upload_key, file_id: u.fileId ?? u.file_id })); },
  };
  const files: any = {
    async put(content: Buffer) { const id = `file_p${Object.keys(stored).length}`; stored[id] = content; return { id, sha256: sha(content), size: content.length }; },
    async get(id: string) { if (!stored[id]) throw new Error("missing"); return stored[id]; },
    async del() {},
    async getStream(id: string) { const { Readable } = await import("node:stream"); return Readable.from(stored[id]); },
    async createUpload(_id: string) { return "upkey"; },
    async uploadPart(id: string, _k: string, n: number, data: Buffer) { (parts[id] ??= {})[n] = data; return `etag${n}`; },
    async completeUpload(id: string, _k: string, list: { n: number }[]) {
      stored[id] = Buffer.concat([...list].sort((a, b) => a.n - b.n).map((p) => parts[id][p.n]));
    },
    async abortUpload(id: string) { aborted.push(id); delete parts[id]; },
  };
  return { repo, files, fileRecords, uploads, stored, aborted, orchestrator: {} as any };
}

async function makeApp(f = publicFakes()) {
  const app = Fastify();
  await registerPublicApi(app, f.repo, f.orchestrator, f.files);
  return { app, f };
}

const authed = { authorization: `Bearer ${KEY}` };
const mp = (name: string, content: Buffer) => {
  const b = "testboundary123";
  return {
    payload: Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      content, Buffer.from(`\r\n--${b}--\r\n`),
    ]),
    headers: { ...authed, "content-type": `multipart/form-data; boundary=${b}` },
  };
};

test("every /api route rejects keyless requests with 401", async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: "GET", url: "/api/files" });
  assert.equal(res.statusCode, 401);
});

test("small file: upload → list → retrieve → streamed download → delete", async () => {
  const { app } = await makeApp();
  const content = Buffer.from("small file body");
  const up = await app.inject({ method: "POST", url: "/api/files", ...mp("a.txt", content) });
  assert.equal(up.statusCode, 201);
  const rec = up.json();
  assert.equal(rec.name, "a.txt");
  assert.equal(rec.sha256, sha(content));

  const list = await app.inject({ method: "GET", url: "/api/files", headers: authed });
  assert.equal(list.json().files.length, 1);

  const dl = await app.inject({
    method: "POST", url: `/api/files/${rec.id}/content`, headers: authed,
    payload: { stream: true },
  });
  assert.equal(dl.statusCode, 200);
  assert.equal(dl.rawPayload.toString(), "small file body");

  const del = await app.inject({ method: "DELETE", url: `/api/files/${rec.id}`, headers: authed });
  assert.equal(del.statusCode, 204);
  const gone = await app.inject({ method: "GET", url: `/api/files/${rec.id}`, headers: authed });
  assert.equal(gone.statusCode, 404);
});

test("chunked upload: create → parts (retry-safe) → complete produces composite sha", async () => {
  const { app, f } = await makeApp();
  const create = await app.inject({
    method: "POST", url: "/api/files/uploads", headers: authed,
    payload: { name: "big.bin", kind: "upload" },
  });
  assert.equal(create.statusCode, 201);
  const { upload_id, part_size } = create.json();
  assert.equal(part_size, PART_SIZE);

  const p1 = Buffer.alloc(10, 1), p2 = Buffer.alloc(5, 2);
  for (const [n, buf] of [[1, p1], [2, p2]] as const) {
    const r = await app.inject({ method: "POST", url: `/api/files/uploads/${upload_id}/parts/${n}`, ...mp("part", buf) });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().sha256, sha(buf));
  }
  // retrying a part replaces it, not duplicates it
  await app.inject({ method: "POST", url: `/api/files/uploads/${upload_id}/parts/2`, ...mp("part", p2) });

  const done = await app.inject({ method: "POST", url: `/api/files/uploads/${upload_id}/complete`, headers: authed, payload: {} });
  assert.equal(done.statusCode, 201);
  const rec = done.json();
  assert.equal(rec.size, 15);
  assert.equal(rec.sha256, sha(sha(p1) + sha(p2))); // composite hash
  assert.equal((await f.files.get(rec.id)).length, 15);
});

test("complete with a gap in part numbers → 400; abort frees the store upload", async () => {
  const { app, f } = await makeApp();
  const { upload_id } = (await app.inject({ method: "POST", url: "/api/files/uploads", headers: authed, payload: { name: "gap.bin" } })).json();
  await app.inject({ method: "POST", url: `/api/files/uploads/${upload_id}/parts/2`, ...mp("part", Buffer.alloc(3)) });
  const bad = await app.inject({ method: "POST", url: `/api/files/uploads/${upload_id}/complete`, headers: authed, payload: {} });
  assert.equal(bad.statusCode, 400);
  const abort = await app.inject({ method: "DELETE", url: `/api/files/uploads/${upload_id}`, headers: authed });
  assert.equal(abort.statusCode, 204);
  assert.equal(f.aborted.length, 1);
});

test("sweepStaleUploads aborts and deletes stale rows", async () => {
  const { app, f } = await makeApp();
  const { upload_id } = (await app.inject({ method: "POST", url: "/api/files/uploads", headers: authed, payload: { name: "stale.bin" } })).json();
  await sweepStaleUploads(f.repo, f.files, 0);
  assert.equal(f.aborted.length, 1);
  assert.equal(await f.repo.getFileUpload("wrkspc_t", upload_id), null);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd control-plane && node --test test/public-api.test.ts`
Expected: FAIL — `Cannot find module '../src/public-api.ts'`

- [ ] **Step 5: Implement `public-api.ts` (files portion + skeleton)**

```ts
// control-plane/src/public-api.ts
// Public /api namespace: dpk_-authenticated managed-agents surface reached
// through the gateway pass-through (spec 2026-07-12-public-api-design.md).
// Contract rules: no /v1 segment after /api; uploads are multipart; streamed
// responses are POST {"stream": true}. Handlers wrap the same repo/filestore
// functions as the /v1 UI routes — separation is contract-level only.
import multipart from "@fastify/multipart";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { FileStore } from "./filestore.ts";
import { apiKeyAuth } from "./public-auth.ts";
import type { Orchestrator } from "./agents-api.ts";
import { shortId } from "./id.ts";

export const PART_SIZE = 32 * 1024 * 1024; // 33554432 — verified through the pass-through

const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/** Abort chunked uploads that never completed (frees MinIO parts). */
export async function sweepStaleUploads(repo: any, files: FileStore, olderThanMs = STALE_UPLOAD_MS) {
  for (const u of await repo.listStaleFileUploads(olderThanMs)) {
    try {
      await files.abortUpload?.(u.file_id, u.upload_key);
      await repo.deleteFileUpload(u.id);
    } catch (err) {
      console.warn(`upload sweep: ${u.id} failed:`, err); // next sweep retries
    }
  }
}

export async function registerPublicApi(
  app: FastifyInstance, repo: any, orchestrator: Orchestrator, files: FileStore,
  notify?: { subscribe(sessionId: string, fn: () => void): () => void },
) {
  // agents-api registers multipart in production; register here only when
  // running standalone (unit tests, future split deployments).
  if (!app.hasContentTypeParser("multipart/form-data")) {
    await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  }

  await app.register(async (api) => {
    api.addHook("preHandler", apiKeyAuth(repo));
    const ws = (req: any): string => req.apiKey.workspaceId;
    const pg = (req: any): { limit: number; offset: number } => {
      const q = (req.query ?? {}) as { offset?: string; limit?: string };
      return {
        limit: Math.min(1000, Math.max(1, Number(q.limit) || 100)),
        offset: Math.max(0, Number(q.offset) || 0),
      };
    };

    // ── Files ────────────────────────────────────────────────────────────
    api.post("/files", async (req: any, reply) => {
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: "multipart file field required" });
      const content = await part.toBuffer();
      const stored = await files.put(content);
      const record = await repo.createFileRecord({
        ...stored, name: part.filename ?? stored.id, kind: (req.query as any).kind ?? "upload", workspaceId: ws(req),
      });
      return reply.code(201).send(record);
    });

    api.get("/files", async (req: any) => {
      const { limit, offset } = pg(req);
      return repo.listAllFiles(ws(req), { kind: (req.query as any).kind, limit, offset });
    });

    api.get("/files/:id", async (req: any, reply) => {
      const record = await repo.getFileRecord(req.params.id);
      if (!record) return reply.code(404).send({ error: "file not found" });
      return record;
    });

    // Download: POST {"stream": true} streams through the gateway pass-through
    // (plain GET responses are buffered by LiteLLM — verified 2026-07-12).
    api.post("/files/:id/content", async (req: any, reply) => {
      const record = await repo.getFileRecord(req.params.id);
      if (!record) return reply.code(404).send({ error: "file not found" });
      reply.header("Content-Disposition", `attachment; filename="${record.name}"`);
      reply.type("application/octet-stream");
      if (files.getStream) return reply.send(await files.getStream(record.id));
      return reply.send(await files.get(record.id));
    });

    api.delete("/files/:id", async (req: any, reply) => {
      const ok = await repo.deleteFile(ws(req), req.params.id);
      if (!ok) return reply.code(404).send({ error: "file not found" });
      try { await files.del?.(req.params.id); } catch { /* best effort */ }
      return reply.code(204).send();
    });

    // ── Chunked uploads (files > PART_SIZE, up to 4 GB+) ────────────────
    api.post("/files/uploads", async (req: any, reply) => {
      const b = (req.body ?? {}) as { name?: string; kind?: string };
      if (!b.name) return reply.code(400).send({ error: "name required" });
      if (!files.createUpload) return reply.code(501).send({ error: "chunked uploads unavailable on this file store" });
      const fileId = `file_${shortId()}`;
      const uploadKey = await files.createUpload(fileId);
      const id = `upl_${shortId()}`;
      await repo.createFileUpload(ws(req), { id, fileId, uploadKey, name: b.name, kind: b.kind ?? "upload", partSize: PART_SIZE });
      return reply.code(201).send({ upload_id: id, file_id: fileId, part_size: PART_SIZE });
    });

    api.post("/files/uploads/:id/parts/:n", async (req: any, reply) => {
      const up = await repo.getFileUpload(ws(req), req.params.id);
      if (!up) return reply.code(404).send({ error: "upload not found" });
      const n = Number(req.params.n);
      if (!Number.isInteger(n) || n < 1 || n > 10000) return reply.code(400).send({ error: "part number must be 1..10000" });
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: "multipart file field required" });
      const data = await part.toBuffer();
      const etag = await files.uploadPart!(up.file_id, up.upload_key, n, data);
      const partSha = createHash("sha256").update(data).digest("hex");
      await repo.recordUploadPart(up.id, { n, etag, sha256: partSha, size: data.length });
      return { n, etag, sha256: partSha };
    });

    api.post("/files/uploads/:id/complete", async (req: any, reply) => {
      const up = await repo.getFileUpload(ws(req), req.params.id);
      if (!up) return reply.code(404).send({ error: "upload not found" });
      const parts = ([...(up.parts ?? [])] as { n: number; etag: string; sha256: string; size: number }[])
        .sort((a, b) => a.n - b.n);
      if (!parts.length || parts.some((p, i) => p.n !== i + 1)) {
        return reply.code(400).send({ error: "parts must be contiguous starting at 1" });
      }
      await files.completeUpload!(up.file_id, up.upload_key, parts.map((p) => ({ n: p.n, etag: p.etag })));
      // Composite hash: sha256 over the concatenated per-part sha256 hex
      // strings. files.sha256 is informational (content addressing removed
      // 2026-07-10); the Python lib computes the same composite to verify.
      const composite = createHash("sha256").update(parts.map((p) => p.sha256).join("")).digest("hex");
      const size = parts.reduce((s, p) => s + Number(p.size), 0);
      const record = await repo.createFileRecord({
        id: up.file_id, name: up.name, size, sha256: composite, kind: up.kind, workspaceId: ws(req),
      });
      await repo.deleteFileUpload(up.id);
      return reply.code(201).send(record);
    });

    api.delete("/files/uploads/:id", async (req: any, reply) => {
      const up = await repo.getFileUpload(ws(req), req.params.id);
      if (!up) return reply.code(404).send({ error: "upload not found" });
      await files.abortUpload?.(up.file_id, up.upload_key);
      await repo.deleteFileUpload(up.id);
      return reply.code(204).send();
    });

    // Remaining resources are added in Task 5 (skills, memory, vaults,
    // environments, agents, sessions) — keep this comment until then.
  }, { prefix: "/api" });
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd control-plane && node --test test/public-api.test.ts test/public-auth.test.ts test/filestore.test.ts`
Expected: PASS (all)

- [ ] **Step 7: Wire into `main.ts`**

In `control-plane/src/main.ts`, after `registerAgentRoutes(...)` (line 61) add:

```ts
import { registerPublicApi, sweepStaleUploads } from "./public-api.ts";
```

```ts
await registerPublicApi(app, repo, orchestrator, files, notify);
// Chunked uploads that never complete leak MinIO parts — hourly abort sweep.
sweepStaleUploads(repo, files).catch((err) => console.warn("upload sweep failed:", err));
setInterval(() => sweepStaleUploads(repo, files).catch((err) => console.warn("upload sweep failed:", err)), 3_600_000).unref();
```

(Deviation from spec noted: the spec says the sweep "piggybacks on the 60 s reconciler tick"; a dedicated hourly unref'd timer is used instead because the reconciler is session-scoped and doesn't hold a FileStore — same effect, less coupling.)

- [ ] **Step 8: Full test run, typecheck, commit**

```bash
cd control-plane && npm test && npx tsc --noEmit
git add control-plane/src/public-api.ts control-plane/src/repo.ts control-plane/src/main.ts control-plane/sql/026_file_uploads.sql control-plane/test/public-api.test.ts
git commit -m "feat(cp): public /api files surface — dpk_ auth, chunked 4GB uploads, streamed downloads"
```

---

### Task 4: Extract shared session actions + SSE loop (no behavior change on /v1)

**Files:**
- Create: `control-plane/src/session-actions.ts`
- Create: `control-plane/src/session-sse.ts`
- Modify: `control-plane/src/agents-api.ts` (POST `/v1/sessions` ~line 452, POST `/v1/sessions/:id/messages` ~line 495, GET `/v1/sessions/:id/events` SSE branch ~line 601-656)

**Interfaces:**
- Produces:
  - `createSessionAction(deps: { repo: any; orchestrator: Orchestrator }, workspaceId: string, body: { agent: string; prompt: string; name?: string; files?: string[]; memoryStore?: string }): Promise<{ code: number; body: any }>`
  - `sendMessageAction(deps, workspaceId: string, sessionId: string, body: { prompt: string; files?: string[] }): Promise<{ code: number; body: any }>`
  - `streamSessionEvents(req: any, reply: any, repo: any, notify: { subscribe(id: string, fn: () => void): () => void } | undefined, sessionId: string, after: number): Promise<any>` — writes the SSE response and resolves when the stream ends (returns `reply`).
- The **existing `test/agents-api.test.ts` suite is the test** for this task: it must pass unchanged.

- [ ] **Step 1: Create `session-actions.ts`** — move the two handler bodies verbatim (only mechanical renames: `ws(req)` → `workspaceId` parameter, `req.body` → `body` parameter, `reply.code(x).send(y)` → `return { code: x, body: y }`):

```ts
// control-plane/src/session-actions.ts
// Session create / follow-up logic shared by the /v1 (console) and /api
// (public) routes — extracted 2026-07-12 so both contracts stay identical.
import type { Orchestrator } from "./agents-api.ts";

export interface SessionDeps { repo: any; orchestrator: Orchestrator }

export async function createSessionAction(
  { repo, orchestrator }: SessionDeps, workspaceId: string,
  b: { agent: string; prompt: string; name?: string; files?: string[]; memoryStore?: string },
): Promise<{ code: number; body: any }> {
  if (!b?.agent || !b?.prompt) return { code: 400, body: { error: "agent and prompt required" } };
  const agent = await repo.getAgent(workspaceId, b.agent);
  if (agent?.status === "disabled") return { code: 409, body: { error: "agent disabled" } };
  const v = await repo.getAgentVersion(b.agent);
  const environment: any = v?.environment_id ? await repo.getEnvironment(v.environment_id) : null;
  if (v && !environment) return { code: 400, body: { error: "agent has no environment; edit the agent and assign one" } };
  const attachments = (await repo.listFileRecords(b.files ?? [])).map((f: any) => ({ id: f.id, name: f.name }));
  if ((b.files?.length ?? 0) !== attachments.length) {
    return { code: 400, body: { error: "unknown file id in files[]" } };
  }
  let session;
  try {
    session = await repo.createSession(workspaceId, b.agent, b.prompt, b.name);
  } catch (err: any) {
    return { code: 404, body: { error: err.message } };
  }
  await repo.appendEvents(session.id, [{ type: "user", payload: { text: b.prompt, turn: 0 } }]);
  let memory: { path: string; fileId: string }[] = [];
  if (b.memoryStore) {
    await repo.setSessionMemoryStore(session.id, b.memoryStore);
    memory = (await repo.getMemoryEntries(b.memoryStore)).map((e: any) => ({ path: e.path, fileId: e.file_id }));
  }
  if (attachments.length) await repo.attachSessionFiles(session.id, attachments.map((a: any) => a.id), "input");
  const skills = (await repo.listSkills(workspaceId, (session.config as any).skill_ids ?? [])).map((s: any) => ({
    name: s.name, files: s.files ?? [{ path: "SKILL.md", fileId: s.file_id }],
  }));
  await orchestrator.startSession({
    id: session.id, prompt: b.prompt, config: session.config, attachments, skills, memory, workspace: workspaceId,
    environment: { id: environment.id, pod: environment.pod ?? {} },
  });
  return { code: 201, body: { id: session.id, agent: b.agent, version: session.agentVersion, status: "queued" } };
}

export async function sendMessageAction(
  { repo, orchestrator }: SessionDeps, workspaceId: string, id: string,
  b: { prompt: string; files?: string[] },
): Promise<{ code: number; body: any }> {
  if (!b?.prompt) return { code: 400, body: { error: "prompt required" } };
  const session = await repo.getSession(id);
  const owner = session ? await repo.getAgent(session.workspace_id, session.agent_id) : null;
  if (owner?.status === "disabled") return { code: 409, body: { error: "agent disabled" } };
  let environment: any = null;
  if (session) {
    const v = await repo.getAgentVersion(session.agent_id, session.agent_version);
    environment = v?.environment_id ? await repo.getEnvironment(v.environment_id) : null;
    if (!environment) return { code: 400, body: { error: "agent has no environment; edit the agent and assign one" } };
  }
  const attachments = (await repo.listFileRecords(b.files ?? [])).map((f: any) => ({ id: f.id, name: f.name }));
  if ((b.files?.length ?? 0) !== attachments.length) {
    return { code: 400, body: { error: "unknown file id in files[]" } };
  }
  let turn;
  try {
    turn = await repo.startTurn(id);
  } catch (err: any) {
    return { code: 409, body: { error: err.message } };
  }
  await repo.appendEvents(id, [{ type: "user", payload: { text: b.prompt, turn: turn.turn } }]);
  if (attachments.length) await repo.attachSessionFiles(id, attachments.map((a: any) => a.id), "input");
  const skills = (await repo.listSkills(workspaceId, (turn.config as any).skill_ids ?? [])).map((s: any) => ({
    name: s.name, files: s.files ?? [{ path: "SKILL.md", fileId: s.file_id }],
  }));
  await orchestrator.startSession({
    id, prompt: b.prompt, config: turn.config, attachments, skills,
    resume: { turn: turn.turn, sdkSessionId: turn.sdkSessionId, checkpointFileId: turn.checkpointFileId },
    workspace: workspaceId,
    environment: { id: environment.id, pod: environment.pod ?? {} },
  });
  return { code: 202, body: { id, turn: turn.turn, status: "queued" } };
}
```

- [ ] **Step 2: Create `session-sse.ts`** — move the SSE branch of GET `/v1/sessions/:id/events` (agents-api.ts lines 601-656) verbatim into:

```ts
// control-plane/src/session-sse.ts
// SSE poll-follow loop shared by GET /v1/sessions/:id/events?stream=1 and
// POST /api/sessions/:id/events/stream (extracted 2026-07-12).
export async function streamSessionEvents(
  req: any, reply: any, repo: any,
  notify: { subscribe(sessionId: string, fn: () => void): () => void } | undefined,
  id: string, after: number,
) {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Content-Encoding": "identity",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  let seq = after;
  let open = true;
  req.raw.on("close", () => { open = false; wake(); });
  let wake: () => void = () => {};
  let pending = false;
  const unsub = notify?.subscribe(id, () => { pending = true; wake(); }) ?? (() => {});
  let lastStatus = "";
  let terminal = false;
  try {
    while (open) {
      pending = false;
      const events = await repo.listEvents(id, seq);
      for (const e of events) {
        seq = e.seq;
        reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
      }
      const s = await repo.getSession(id);
      if (!s) { terminal = true; break; }
      if (s.status !== lastStatus) {
        lastStatus = s.status;
        reply.raw.write(`event: status\ndata: ${JSON.stringify({
          status: s.status,
          tokens_in: Number(s.tokens_in ?? 0), tokens_out: Number(s.tokens_out ?? 0),
          turns: Number(s.turns ?? 0),
        })}\n\n`);
      }
      if (["completed", "failed"].includes(s.status)) { terminal = true; break; }
      if (pending) continue;
      reply.raw.write(": ka\n\n");
      const heartbeat = s.status === "idle" ? 15000 : 5000;
      await new Promise<void>((r) => { wake = r; setTimeout(r, heartbeat); });
    }
  } finally {
    unsub();
  }
  if (terminal) reply.raw.write("event: end\ndata: {}\n\n");
  reply.raw.end();
  return reply;
}
```

- [ ] **Step 3: Rewire `agents-api.ts`** — replace the moved bodies with delegation (imports at top: `import { createSessionAction, sendMessageAction } from "./session-actions.ts";` and `import { streamSessionEvents } from "./session-sse.ts";`):

```ts
  app.post("/v1/sessions", async (req, reply) => {
    const r = await createSessionAction({ repo, orchestrator }, ws(req), req.body as any);
    return reply.code(r.code).send(r.body);
  });

  app.post("/v1/sessions/:id/messages", async (req, reply) => {
    const r = await sendMessageAction({ repo, orchestrator }, ws(req), (req.params as any).id, req.body as any);
    return reply.code(r.code).send(r.body);
  });

  app.get("/v1/sessions/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { stream, after } = req.query as { stream?: string; after?: string };
    if (stream !== "1") {
      return { events: await repo.listEvents(id, Number(after ?? 0)) };
    }
    return streamSessionEvents(req, reply, repo, notify, id, Number(after ?? 0));
  });
```

Delete the moved code from agents-api.ts. Keep the explanatory comments with the moved code (they travel to the new modules).

- [ ] **Step 4: Run the FULL existing suite — it must pass unchanged**

Run: `cd control-plane && npm test`
Expected: PASS, zero test-file edits in this task.

- [ ] **Step 5: Typecheck and commit**

```bash
cd control-plane && npx tsc --noEmit
git add control-plane/src/session-actions.ts control-plane/src/session-sse.ts control-plane/src/agents-api.ts
git commit -m "refactor(cp): extract session actions + SSE loop for reuse by the public API"
```

---

### Task 5: Public API — remaining resources + contract snapshot test

**Files:**
- Modify: `control-plane/src/public-api.ts` (replace the "Remaining resources" comment)
- Test: extend `control-plane/test/public-api.test.ts`; create `control-plane/test/public-api-contract.test.ts`

**Interfaces:**
- Consumes: `createSessionAction` / `sendMessageAction` / `streamSessionEvents` (Task 4), repo methods exactly as used by the `/v1` equivalents in `agents-api.ts` (same names/signatures — see agents-api.ts lines 162-345, 402-593).
- Produces: the full public route table (the contract snapshot below is the authoritative list).

- [ ] **Step 1: Write failing tests** — append to `test/public-api.test.ts`. Extend `publicFakes()` with the fakes the new routes need (copy the relevant fakes verbatim from `test/agents-api.test.ts` `fakes()` — `createAgent`, `listAgents`, `getAgent`, `getAgentVersion`, `getAgentWithVersions`, `newAgentVersion`, `renameAgent`, `setAgentStatus`, `deleteAgent`, `createSession`, `getSession`, `listSessions`, `startTurn`, `appendEvents`, `listEvents`, `setSessionStatus`, `attachSessionFiles`, `setSessionMemoryStore`, `getMemoryEntries`, `createEnvironment`, `getEnvironment`, `listEnvironments`, `updateEnvironment`, `deleteEnvironment`, `environmentInUse`, `createSkill`, `listSkills`, `countSkills`, `getSkill`, `deleteSkill`, `createMemoryStore`, `listMemoryStores`, `getMemoryStore`, `deleteMemoryStore`, `deleteMemoryEntry`, `getMemoryEntry`, `upsertMemoryEntries`, `createVault`, `getVault`, `listVaults`, `deleteVault`, `addVaultCredential`, `removeVaultCredential`, `listVaultCredentials`, `sessionResources`, `deleteSession`, `deleteFileRecordById`; orchestrator fakes: `startSession`, `stopSession`, `deleteSessionResources`, `ensureEnvironmentPolicy`, `deleteEnvironmentResources`, `writeVaultSecret`, `putVaultSecretKey`, `removeVaultSecretKey`, `deleteVaultSecret`). Then add:

```ts
test("vault flow: create with secrets, credentials listed by name only, delete", async () => {
  const { app } = await makeApp();
  const created = await app.inject({
    method: "POST", url: "/api/vaults", headers: authed,
    payload: { name: "v1", secrets: { TOKEN: "s3cret" } },
  });
  assert.equal(created.statusCode, 201);
  const get = await app.inject({ method: "GET", url: `/api/vaults/${created.json().id}`, headers: authed });
  // secrets are write-only: response must not contain the value anywhere
  assert.ok(!get.body.includes("s3cret"));
});

test("agent + session flow via shared actions: create agent → create session → poll events", async () => {
  const { app } = await makeApp();
  const env = (await app.inject({ method: "POST", url: "/api/environments", headers: authed, payload: { name: "e1" } })).json();
  const agent = (await app.inject({
    method: "POST", url: "/api/agents", headers: authed,
    payload: { name: "a1", model: "m1", environmentId: env.id },
  })).json();
  const sess = await app.inject({
    method: "POST", url: "/api/sessions", headers: authed,
    payload: { agent: agent.id, prompt: "hello" },
  });
  assert.equal(sess.statusCode, 201);
  assert.equal(sess.json().status, "queued");
  const events = await app.inject({ method: "GET", url: `/api/sessions/${sess.json().id}/events`, headers: authed });
  assert.equal(events.json().events[0].type, "user");
});

test("POST events/stream without stream:true returns the event list (poll fallback)", async () => {
  const { app } = await makeApp();
  const env = (await app.inject({ method: "POST", url: "/api/environments", headers: authed, payload: { name: "e2" } })).json();
  const agent = (await app.inject({ method: "POST", url: "/api/agents", headers: authed, payload: { name: "a2", model: "m1", environmentId: env.id } })).json();
  const sess = (await app.inject({ method: "POST", url: "/api/sessions", headers: authed, payload: { agent: agent.id, prompt: "hi" } })).json();
  const res = await app.inject({
    method: "POST", url: `/api/sessions/${sess.id}/events/stream`, headers: authed, payload: {},
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().events));
});

test("skill upload (single SKILL.md) via multipart", async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: "POST", url: "/api/skills?name=greet", ...mp("SKILL.md", Buffer.from("# greet")) });
  assert.equal(res.statusCode, 201);
});

test("memory store: create, add entry, tree, content", async () => {
  const { app } = await makeApp();
  const store = (await app.inject({ method: "POST", url: "/api/memory-stores", headers: authed, payload: { name: "m1" } })).json();
  const add = await app.inject({ method: "POST", url: `/api/memory-stores/${store.id}/entries?path=notes.md`, ...mp("notes.md", Buffer.from("note body")) });
  assert.equal(add.statusCode, 201);
});
```

Contract snapshot test:

```ts
// control-plane/test/public-api-contract.test.ts
// The public /api route table is a STABLE CONTRACT (spec 2026-07-12).
// A failure here means a breaking change to external clients — additions
// belong in the snapshot; removals/renames need /api/v2.
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerPublicApi } from "../src/public-api.ts";
import { publicFakes } from "./public-api.test.ts";

const SNAPSHOT = [
  "DELETE /api/agents/:id",
  "DELETE /api/environments/:id",
  "DELETE /api/files/:id",
  "DELETE /api/files/uploads/:id",
  "DELETE /api/memory-stores/:id",
  "DELETE /api/memory-stores/:id/entries",
  "DELETE /api/sessions/:id",
  "DELETE /api/skills/:id",
  "DELETE /api/vaults/:id",
  "DELETE /api/vaults/:id/credentials/:name",
  "GET /api/agents",
  "GET /api/agents/:id",
  "GET /api/environments",
  "GET /api/files",
  "GET /api/files/:id",
  "GET /api/memory-stores",
  "GET /api/memory-stores/:id/content",
  "GET /api/memory-stores/:id/tree",
  "GET /api/sessions",
  "GET /api/sessions/:id",
  "GET /api/sessions/:id/events",
  "GET /api/sessions/:id/resources",
  "GET /api/skills",
  "GET /api/skills/:id",
  "GET /api/vaults",
  "GET /api/vaults/:id",
  "PATCH /api/agents/:id",
  "PATCH /api/environments/:id",
  "POST /api/agents",
  "POST /api/agents/:id/status",
  "POST /api/agents/:id/versions",
  "POST /api/environments",
  "POST /api/files",
  "POST /api/files/:id/content",
  "POST /api/files/uploads",
  "POST /api/files/uploads/:id/complete",
  "POST /api/files/uploads/:id/parts/:n",
  "POST /api/memory-stores",
  "POST /api/memory-stores/:id/entries",
  "POST /api/sessions",
  "POST /api/sessions/:id/events/stream",
  "POST /api/sessions/:id/interrupt",
  "POST /api/sessions/:id/messages",
  "POST /api/skills",
  "POST /api/vaults",
  "POST /api/vaults/:id/credentials",
];

test("public /api route table matches the contract snapshot", async () => {
  const routes: string[] = [];
  const app = Fastify();
  app.addHook("onRoute", (r) => {
    if (!r.url.startsWith("/api")) return;
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) if (m !== "HEAD" && m !== "OPTIONS") routes.push(`${m} ${r.url}`);
  });
  const f = publicFakes();
  await registerPublicApi(app, f.repo, f.orchestrator, f.files);
  assert.deepEqual([...new Set(routes)].sort(), SNAPSHOT);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd control-plane && node --test test/public-api.test.ts test/public-api-contract.test.ts`
Expected: FAIL — 404s on unregistered routes / snapshot mismatch.

- [ ] **Step 3: Implement the remaining routes** — replace the "Remaining resources" comment in `public-api.ts` with ports of the `/v1` handlers (same repo/orchestrator calls, `ws(req)` from the API key). Follow the `/v1` handlers in `agents-api.ts` line-for-line, with these deltas only:

```ts
    // ── Skills (port of agents-api.ts:230-275) ───────────────────────────
    // identical handler bodies, paths /skills, /skills/:id

    // ── Vaults (port of agents-api.ts:279-323) ───────────────────────────
    // identical handler bodies, paths /vaults, /vaults/:id, /vaults/:id/credentials[...]

    // ── Memory stores (port of agents-api.ts:325-386) ────────────────────
    // identical handler bodies, paths /memory-stores[...]
    // (the guardDeletable helper is copied — same regex /^file_[a-z0-9]{12}$/)

    // ── Environments (port of agents-api.ts:162-204) ─────────────────────
    // identical handler bodies, paths /environments[...]

    // ── Agents (port of agents-api.ts:153-160, 402-450) ─────────────────
    // identical handler bodies, paths /agents[...]

    // ── Sessions — via the shared actions (Task 4) ──────────────────────
    api.post("/sessions", async (req: any, reply) => {
      const r = await createSessionAction({ repo, orchestrator }, ws(req), req.body ?? {});
      return reply.code(r.code).send(r.body);
    });
    api.post("/sessions/:id/messages", async (req: any, reply) => {
      const r = await sendMessageAction({ repo, orchestrator }, ws(req), req.params.id, req.body ?? {});
      return reply.code(r.code).send(r.body);
    });
    api.get("/sessions", async (req: any) => {
      const { limit, offset } = pg(req);
      const { rows, count } = await repo.listSessions(ws(req), req.query.agent, limit, offset, req.query.file);
      return { sessions: rows, count, offset };
    });
    api.get("/sessions/:id", async (req: any, reply) => {
      const session = await repo.getSession(req.params.id, ws(req));
      if (!session) return reply.code(404).send({ error: "session not found" });
      return session;
    });
    api.get("/sessions/:id/resources", async (req: any, reply) => {
      const r = await repo.sessionResources(req.params.id, ws(req));
      if (!r) return reply.code(404).send({ error: "session not found" });
      return r;
    });
    api.post("/sessions/:id/interrupt", async (req: any, reply) => {
      const session = await repo.getSession(req.params.id, ws(req));
      if (!session) return reply.code(404).send({ error: "session not found" });
      await orchestrator.stopSession(req.params.id);
      await repo.setSessionStatus(req.params.id, "idle");
      await repo.appendEvents(req.params.id, [{ type: "session.interrupted", payload: { by: "api" } }]);
      return { ok: true, status: "idle" };
    });
    api.delete("/sessions/:id", async (req: any, reply) => {
      await orchestrator.stopSession(req.params.id);
      await orchestrator.deleteSessionResources(req.params.id);
      const fileIds = await repo.deleteSession(ws(req), req.params.id);
      for (const fid of fileIds) { try { await files.del?.(fid); } catch { /* best effort */ } }
      return reply.code(204).send();
    });
    api.get("/sessions/:id/events", async (req: any) => ({
      events: await repo.listEvents(req.params.id, Number(req.query.after ?? 0)),
    }));
    // Streamed events: POST {"stream": true} (pass-through requirement).
    // Without stream:true this degrades to the poll shape (lib fallback).
    api.post("/sessions/:id/events/stream", async (req: any, reply) => {
      const b = (req.body ?? {}) as { stream?: boolean; after?: number };
      if (!b.stream) return { events: await repo.listEvents(req.params.id, Number(b.after ?? 0)) };
      return streamSessionEvents(req, reply, repo, notify, req.params.id, Number(b.after ?? 0));
    });
```

Imports to add at the top of `public-api.ts`: `import { createSessionAction, sendMessageAction } from "./session-actions.ts";`, `import { streamSessionEvents } from "./session-sse.ts";` and (for skills) `AdmZip` is dynamically imported inside the handler exactly as in agents-api.ts.

Also export `publicFakes` from `test/public-api.test.ts` (add `export` keyword — node:test files are importable modules).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npm test`
Expected: PASS (full suite, including the contract snapshot)

- [ ] **Step 5: Typecheck and commit**

```bash
cd control-plane && npx tsc --noEmit
git add control-plane/src/public-api.ts control-plane/test/public-api.test.ts control-plane/test/public-api-contract.test.ts
git commit -m "feat(cp): full public /api surface — skills, memory, vaults, environments, agents, sessions"
```

---

### Task 6: Gateway pass-through config

**Files:**
- Modify: `control-plane/src/gateway-config.ts` (`buildGatewayConfig`, line 31)
- Modify: `control-plane/src/server.ts` (`syncGateway`, line 52-58)
- Test: extend `control-plane/test/gateway-config.test.ts`

**Interfaces:**
- Produces: `buildGatewayConfig(deployments, externals = [], opts: { publicApiTarget?: string } = {})`. When `publicApiTarget` is set, `general_settings.pass_through_endpoints` is emitted (shape below). `server.ts` passes `process.env.DEVPROOF_PUBLIC_API_TARGET ?? "http://host.docker.internal:7080/api"`.

- [ ] **Step 1: Write the failing test** (append to `test/gateway-config.test.ts`, following its existing style):

```ts
test("publicApiTarget emits the /api pass-through block", () => {
  const yaml = buildGatewayConfig([], [], { publicApiTarget: "http://host.docker.internal:7080/api" });
  const cfg = parse(yaml); // the file already imports { parse } from "yaml"
  assert.deepEqual(cfg.general_settings.pass_through_endpoints, [{
    path: "/api",
    target: "http://host.docker.internal:7080/api",
    include_subpath: true,
    forward_headers: true,
    auth: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  }]);
  // custom_auth must survive — it also gates pass-through requests (verified)
  assert.equal(cfg.general_settings.custom_auth, "custom_callbacks.user_custom_auth");
});

test("no publicApiTarget → no pass_through_endpoints key (backward compatible)", () => {
  const cfg = parse(buildGatewayConfig([], []));
  assert.equal(cfg.general_settings.pass_through_endpoints, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --test test/gateway-config.test.ts`
Expected: FAIL — unexpected third argument / missing block.

- [ ] **Step 3: Implement** — change the signature and `general_settings` in `gateway-config.ts`:

```ts
export function buildGatewayConfig(
  deployments: DeploymentLike[], externals: ExternalLike[] = [],
  opts: { publicApiTarget?: string } = {},
): string {
```

```ts
    general_settings: {
      // API-key enforcement against the api_keys table (custom_callbacks.py).
      custom_auth: "custom_callbacks.user_custom_auth",
      // Public /api pass-through → control plane (spec 2026-07-12). The CP
      // re-validates the dpk_ key; custom_auth above also fires (verified).
      ...(opts.publicApiTarget ? {
        pass_through_endpoints: [{
          path: "/api",
          target: opts.publicApiTarget,
          include_subpath: true,
          forward_headers: true,
          auth: false,
          methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        }],
      } : {}),
    },
```

In `server.ts` `syncGateway` (line 54):

```ts
    const config = buildGatewayConfig(deployments, externals ? await externals.list() : [], {
      publicApiTarget: process.env.DEVPROOF_PUBLIC_API_TARGET ?? "http://host.docker.internal:7080/api",
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npm test`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
cd control-plane && npx tsc --noEmit
git add control-plane/src/gateway-config.ts control-plane/src/server.ts control-plane/test/gateway-config.test.ts
git commit -m "feat(gateway): /api pass-through to the control plane public API"
```

---

### Task 7: Python library rewrite (`clients/python/devproof`)

**Files:**
- Create: `clients/python/devproof/errors.py`
- Create: `clients/python/devproof/_http.py`
- Create: `clients/python/devproof/resources.py`
- Rewrite: `clients/python/devproof/__init__.py`
- Modify: `examples/demo_agent.py` (update to the new client — mechanical: constructor gains `api_key`, `sessions.events(...)` becomes `sessions.events.stream(...)`, method names per the table in the spec)

No pytest infra exists in this repo — the example scripts (Task 8) are the executable tests, run live in Task 9. Static gate for this task: `python -m py_compile` on every module.

- [ ] **Step 1: `errors.py`**

```python
"""Typed exceptions, mirroring the Anthropic SDK's error design."""
from __future__ import annotations

from typing import Any


class DevproofError(Exception):
    """Base for all devproof client errors."""


class APIConnectionError(DevproofError):
    """Network-level failure before an HTTP response arrived."""


class APIStatusError(DevproofError):
    """Non-2xx HTTP response."""

    def __init__(self, status_code: int, body: Any):
        self.status_code = status_code
        self.body = body
        message = body.get("error") if isinstance(body, dict) else str(body)
        super().__init__(f"HTTP {status_code}: {message}")


class AuthenticationError(APIStatusError):
    """401 — missing/invalid dpk_ API key."""


class NotFoundError(APIStatusError):
    """404 — no such resource."""


class ConflictError(APIStatusError):
    """409 — e.g. agent disabled, session not idle, environment in use."""


class RateLimitError(APIStatusError):
    """429 — retried automatically before this is raised."""


ERROR_BY_STATUS = {401: AuthenticationError, 404: NotFoundError, 409: ConflictError, 429: RateLimitError}
```

- [ ] **Step 2: `_http.py`**

```python
"""HTTP transport: auth header, retries with backoff, pagination, SSE."""
from __future__ import annotations

import json
import os
import random
import time
from contextlib import contextmanager
from typing import Any, Iterator

import httpx

from .errors import APIConnectionError, APIStatusError, ERROR_BY_STATUS

RETRY_STATUSES = {429, 500, 502, 503, 504}
PAGE_SIZE = 100


class HttpClient:
    def __init__(self, base_url: str, api_key: str, timeout: float = 60.0, max_retries: int = 2):
        self.max_retries = max_retries
        self._c = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            headers={"Authorization": f"Bearer {api_key}"},
        )

    def request(self, method: str, path: str, **kw: Any) -> httpx.Response:
        last: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                resp = self._c.request(method, path, **kw)
            except httpx.TransportError as err:
                last = APIConnectionError(str(err))
            else:
                if resp.status_code < 400:
                    return resp
                body = _safe_json(resp)
                err_cls = ERROR_BY_STATUS.get(resp.status_code, APIStatusError)
                last = err_cls(resp.status_code, body)
                if resp.status_code not in RETRY_STATUSES:
                    raise last
            if attempt < self.max_retries:
                time.sleep(0.5 * 2**attempt + random.uniform(0, 0.25))
        raise last  # type: ignore[misc]

    def json(self, method: str, path: str, **kw: Any) -> Any:
        return self.request(method, path, **kw).json()

    def paginate(self, path: str, key: str, params: dict | None = None) -> Iterator[dict]:
        """Iterate every item across {key: [...], count/total, offset} pages."""
        offset = 0
        while True:
            page = self.json("GET", path, params={**(params or {}), "offset": offset, "limit": PAGE_SIZE})
            items = page.get(key) or page.get("rows") or []
            yield from items
            offset += len(items)
            total = page.get("count", page.get("total", 0))
            if not items or offset >= total:
                return

    @contextmanager
    def stream(self, method: str, path: str, **kw: Any):
        """Streaming request; raises typed errors on non-2xx before yielding."""
        with self._c.stream(method, path, **kw) as resp:
            if resp.status_code >= 400:
                resp.read()
                err_cls = ERROR_BY_STATUS.get(resp.status_code, APIStatusError)
                raise err_cls(resp.status_code, _safe_json(resp))
            yield resp

    def sse(self, path: str, body: dict) -> Iterator[tuple[str, dict]]:
        """POST {"stream": true, ...}; yield (event_name, data) pairs until 'end'."""
        with self.stream("POST", path, json={**body, "stream": True}, timeout=None) as resp:
            event_name = "message"
            for line in resp.iter_lines():
                if line.startswith("event:"):
                    event_name = line.split(":", 1)[1].strip()
                elif line.startswith("data:"):
                    if event_name == "end":
                        return
                    yield event_name, json.loads(line.split(":", 1)[1])
                    event_name = "message"


def _safe_json(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except Exception:
        return {"error": resp.text[:500]}


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None:
        raise RuntimeError(f"{name} environment variable is required")
    return value
```

- [ ] **Step 3: `resources.py`**

```python
"""Resource namespaces over the Devproof public API (/api/*)."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any, Callable, Iterator

from ._http import HttpClient

CHUNK_THRESHOLD = 32 * 1024 * 1024  # server PART_SIZE — files above this go chunked

Progress = Callable[[int, int], None]  # (bytes_done, bytes_total)


class Files:
    def __init__(self, http: HttpClient):
        self._h = http

    def upload(self, path: str | Path, *, kind: str | None = None, on_progress: Progress | None = None) -> dict:
        path = Path(path)
        size = path.stat().st_size
        if size <= CHUNK_THRESHOLD:
            with path.open("rb") as f:
                params = {"kind": kind} if kind else {}
                rec = self._h.json("POST", "/api/files", params=params, files={"file": (path.name, f)})
            if on_progress:
                on_progress(size, size)
            return rec
        return self._upload_chunked(path, size, kind=kind, on_progress=on_progress)

    def _upload_chunked(self, path: Path, size: int, *, kind: str | None, on_progress: Progress | None) -> dict:
        up = self._h.json("POST", "/api/files/uploads", json={"name": path.name, **({"kind": kind} if kind else {})})
        part_size = up["part_size"]
        part_hashes: list[str] = []
        done = 0
        with path.open("rb") as f:
            n = 0
            while chunk := f.read(part_size):
                n += 1
                self._h.json("POST", f"/api/files/uploads/{up['upload_id']}/parts/{n}",
                             files={"file": (f"part{n}", chunk)})
                part_hashes.append(hashlib.sha256(chunk).hexdigest())
                done += len(chunk)
                if on_progress:
                    on_progress(done, size)
        rec = self._h.json("POST", f"/api/files/uploads/{up['upload_id']}/complete", json={})
        composite = hashlib.sha256("".join(part_hashes).encode()).hexdigest()
        if rec["sha256"] != composite:
            raise RuntimeError(f"composite hash mismatch: server {rec['sha256']} != client {composite}")
        return rec

    def list(self, *, kind: str | None = None) -> Iterator[dict]:
        return self._h.paginate("/api/files", "files", {"kind": kind} if kind else None)

    def retrieve(self, file_id: str) -> dict:
        return self._h.json("GET", f"/api/files/{file_id}")

    def download(self, file_id: str, dest: str | Path, *, on_progress: Progress | None = None) -> Path:
        dest = Path(dest)
        total = int(self.retrieve(file_id).get("size") or 0)
        done = 0
        with self._h.stream("POST", f"/api/files/{file_id}/content", json={"stream": True}, timeout=None) as resp:
            with dest.open("wb") as f:
                for chunk in resp.iter_bytes():
                    f.write(chunk)
                    done += len(chunk)
                    if on_progress:
                        on_progress(done, total)
        return dest

    def delete(self, file_id: str) -> None:
        self._h.request("DELETE", f"/api/files/{file_id}")


class Skills:
    def __init__(self, http: HttpClient):
        self._h = http

    def upload(self, path: str | Path, *, name: str | None = None) -> dict:
        path = Path(path)
        with path.open("rb") as f:
            params = {"name": name} if name else {}
            return self._h.json("POST", "/api/skills", params=params, files={"file": (path.name, f)})

    def list(self) -> Iterator[dict]:
        return self._h.paginate("/api/skills", "skills")

    def retrieve(self, skill_id: str) -> dict:
        return self._h.json("GET", f"/api/skills/{skill_id}")["skill"]

    def delete(self, skill_id: str) -> None:
        self._h.request("DELETE", f"/api/skills/{skill_id}")


class _MemoryEntries:
    def __init__(self, http: HttpClient):
        self._h = http

    def add(self, store_id: str, path: str, content: bytes) -> dict:
        return self._h.json("POST", f"/api/memory-stores/{store_id}/entries",
                            params={"path": path}, files={"file": (os.path.basename(path) or "entry", content)})

    def delete(self, store_id: str, path: str) -> None:
        self._h.request("DELETE", f"/api/memory-stores/{store_id}/entries", params={"path": path})


class MemoryStores:
    def __init__(self, http: HttpClient):
        self._h = http
        self.entries = _MemoryEntries(http)

    def create(self, *, name: str) -> dict:
        return self._h.json("POST", "/api/memory-stores", json={"name": name})

    def list(self) -> Iterator[dict]:
        return self._h.paginate("/api/memory-stores", "stores")

    def tree(self, store_id: str) -> list[dict]:
        return self._h.json("GET", f"/api/memory-stores/{store_id}/tree")["entries"]

    def content(self, store_id: str, path: str) -> bytes:
        return self._h.request("GET", f"/api/memory-stores/{store_id}/content", params={"path": path}).content

    def delete(self, store_id: str) -> None:
        self._h.request("DELETE", f"/api/memory-stores/{store_id}")


class _VaultCredentials:
    def __init__(self, http: HttpClient):
        self._h = http

    def create(self, vault_id: str, *, name: str, value: str) -> dict:
        return self._h.json("POST", f"/api/vaults/{vault_id}/credentials", json={"name": name, "value": value})

    def delete(self, vault_id: str, name: str) -> None:
        self._h.request("DELETE", f"/api/vaults/{vault_id}/credentials/{name}")


class Vaults:
    def __init__(self, http: HttpClient):
        self._h = http
        self.credentials = _VaultCredentials(http)

    def create(self, *, name: str, secrets: dict[str, str] | None = None) -> dict:
        return self._h.json("POST", "/api/vaults", json={"name": name, **({"secrets": secrets} if secrets else {})})

    def list(self) -> Iterator[dict]:
        return self._h.paginate("/api/vaults", "vaults")

    def retrieve(self, vault_id: str) -> dict:
        return self._h.json("GET", f"/api/vaults/{vault_id}")

    def delete(self, vault_id: str) -> None:
        self._h.request("DELETE", f"/api/vaults/{vault_id}")


class Environments:
    def __init__(self, http: HttpClient):
        self._h = http

    def create(self, *, name: str, allowed_hosts: list[str] | None = None,
               allow_package_managers: bool = False, pod: dict | None = None) -> dict:
        return self._h.json("POST", "/api/environments", json={
            "name": name, "allowedHosts": allowed_hosts or [],
            "allowPackageManagers": allow_package_managers, **({"pod": pod} if pod else {}),
        })

    def list(self) -> Iterator[dict]:
        return self._h.paginate("/api/environments", "environments")

    def update(self, environment_id: str, **fields: Any) -> dict:
        return self._h.json("PATCH", f"/api/environments/{environment_id}", json=fields)

    def delete(self, environment_id: str) -> None:
        self._h.request("DELETE", f"/api/environments/{environment_id}")


class Agents:
    def __init__(self, http: HttpClient):
        self._h = http

    def create(self, *, name: str, model: str, environment_id: str, system_prompt: str = "",
               tools: list[str] | None = None, max_turns: int = 10, skill_ids: list[str] | None = None,
               vault_id: str | None = None, memory_store: str | None = None, **extra: Any) -> dict:
        return self._h.json("POST", "/api/agents", json={
            "name": name, "model": model, "environmentId": environment_id,
            "systemPrompt": system_prompt, "tools": tools or [], "maxTurns": max_turns,
            **({"skillIds": skill_ids} if skill_ids else {}),
            **({"vaultId": vault_id} if vault_id else {}), **extra,
        })

    def list(self) -> Iterator[dict]:
        return self._h.paginate("/api/agents", "agents")

    def retrieve(self, agent_id: str) -> dict:
        return self._h.json("GET", f"/api/agents/{agent_id}")

    def update(self, agent_id: str, **config: Any) -> dict:
        """Creates a new agent version (POST :id/versions)."""
        return self._h.json("POST", f"/api/agents/{agent_id}/versions", json=config)

    def set_status(self, agent_id: str, status: str) -> dict:
        return self._h.json("POST", f"/api/agents/{agent_id}/status", json={"status": status})

    def delete(self, agent_id: str) -> None:
        self._h.request("DELETE", f"/api/agents/{agent_id}")


class _SessionEvents:
    def __init__(self, http: HttpClient):
        self._h = http

    def list(self, session_id: str, *, after: int = 0) -> list[dict]:
        return self._h.json("GET", f"/api/sessions/{session_id}/events", params={"after": after})["events"]

    def stream(self, session_id: str, *, after: int = 0) -> Iterator[dict]:
        """Yield events (and {'type': 'status', ...} markers) until terminal."""
        for name, data in self._h.sse(f"/api/sessions/{session_id}/events/stream", {"after": after}):
            if name == "status":
                yield {"type": "status", "payload": data}
            else:
                yield data


class Sessions:
    def __init__(self, http: HttpClient):
        self._h = http
        self.events = _SessionEvents(http)

    def create(self, *, agent: str, prompt: str, name: str | None = None,
               files: list[str] | None = None, memory_store: str | None = None) -> dict:
        return self._h.json("POST", "/api/sessions", json={
            "agent": agent, "prompt": prompt, "name": name,
            **({"files": files} if files else {}), **({"memoryStore": memory_store} if memory_store else {}),
        })

    def send_message(self, session_id: str, *, prompt: str, files: list[str] | None = None) -> dict:
        return self._h.json("POST", f"/api/sessions/{session_id}/messages",
                            json={"prompt": prompt, **({"files": files} if files else {})})

    def list(self, *, agent: str | None = None) -> Iterator[dict]:
        return self._h.paginate("/api/sessions", "sessions", {"agent": agent} if agent else None)

    def retrieve(self, session_id: str) -> dict:
        return self._h.json("GET", f"/api/sessions/{session_id}")

    def resources(self, session_id: str) -> dict:
        return self._h.json("GET", f"/api/sessions/{session_id}/resources")

    def interrupt(self, session_id: str) -> dict:
        return self._h.json("POST", f"/api/sessions/{session_id}/interrupt", json={})

    def delete(self, session_id: str) -> None:
        self._h.request("DELETE", f"/api/sessions/{session_id}")
```

- [ ] **Step 4: `__init__.py`**

```python
"""Devproof AI Python client — public API (/api/*) through the gateway.

Mirrors the Anthropic SDK's design (resource namespaces, env-var fallbacks,
typed errors) over Devproof-native wire shapes. Model inference is NOT here:
point the official `anthropic` package at the same base URL
(ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN=dpk_...).

Usage:
    from devproof import Devproof
    client = Devproof()  # DEVPROOF_BASE_URL, DEVPROOF_API_KEY
    rec = client.files.upload("report.pdf")
    for event in client.sessions.events.stream(session["id"]):
        print(event["type"])
"""
from __future__ import annotations

import os

from ._http import HttpClient
from .errors import (APIConnectionError, APIStatusError, AuthenticationError,
                     ConflictError, DevproofError, NotFoundError, RateLimitError)
from .resources import Agents, Environments, Files, MemoryStores, Sessions, Skills, Vaults

__all__ = [
    "Devproof", "DevproofError", "APIConnectionError", "APIStatusError",
    "AuthenticationError", "NotFoundError", "ConflictError", "RateLimitError",
]


class Devproof:
    def __init__(self, base_url: str | None = None, api_key: str | None = None,
                 timeout: float = 60.0, max_retries: int = 2):
        base_url = base_url or os.environ.get("DEVPROOF_BASE_URL", "http://localhost:14000")
        api_key = api_key or os.environ.get("DEVPROOF_API_KEY")
        if not api_key:
            raise DevproofError("api_key required (or set DEVPROOF_API_KEY)")
        http = HttpClient(base_url, api_key, timeout=timeout, max_retries=max_retries)
        self.files = Files(http)
        self.skills = Skills(http)
        self.memory_stores = MemoryStores(http)
        self.vaults = Vaults(http)
        self.environments = Environments(http)
        self.agents = Agents(http)
        self.sessions = Sessions(http)
```

- [ ] **Step 5: Update `examples/demo_agent.py`** — replace the old client calls with the new surface (`Devproof(base_url=..., api_key=...)`; `client.sessions.events.stream(sid)` instead of `client.sessions.events(sid)`; `client.environments.create(...)` + `environment_id=` on agent create, since environments are mandatory).

- [ ] **Step 6: Compile-check**

Run: `python -m py_compile clients/python/devproof/__init__.py clients/python/devproof/_http.py clients/python/devproof/errors.py clients/python/devproof/resources.py examples/demo_agent.py`
Expected: exit 0, no output.

- [ ] **Step 7: Commit**

```bash
git add clients/python/devproof examples/demo_agent.py
git commit -m "feat(python): devproof client rewrite — Anthropic-SDK-styled surface over the public API"
```

---

### Task 8: Example scripts (`examples/api/`)

**Files:**
- Create: `examples/api/_common.py`, `examples/api/test_files.py`, `examples/api/test_skills.py`, `examples/api/test_memory.py`, `examples/api/test_vault.py`, `examples/api/test_tools.py`, `examples/api/README.md`

**Interfaces:**
- Consumes: the Task 7 client exactly as defined (`client.files.upload(...)` etc.).
- Every script: prints steps, asserts outcomes, exits non-zero on failure, cleans up in `finally`.

- [ ] **Step 1: `_common.py`**

```python
"""Shared setup for the public-API example scripts."""
from __future__ import annotations

import sys
from pathlib import Path

# Allow running straight from the repo without pip-installing the client.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "clients" / "python"))

from devproof import Devproof  # noqa: E402


def client() -> Devproof:
    return Devproof()  # DEVPROOF_BASE_URL (default http://localhost:14000), DEVPROOF_API_KEY


def step(msg: str) -> None:
    print(f"==> {msg}", flush=True)


def check(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        raise SystemExit(1)
    print(f"    ok: {msg}")
```

- [ ] **Step 2: `test_files.py`**

```python
"""Files: small upload round trip + big file through the chunked path."""
from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

from _common import check, client, step
from devproof import NotFoundError

BIG_MB = int(os.environ.get("DEVPROOF_TEST_BIG_MB", "100"))


def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    c = client()
    tmp = Path(tempfile.mkdtemp(prefix="dp-files-"))
    uploaded: list[str] = []
    try:
        step("small file: upload → retrieve → download → compare")
        small = tmp / "small.txt"
        small.write_bytes(b"devproof public api small file\n" * 100)
        rec = c.files.upload(small)
        uploaded.append(rec["id"])
        check(rec["sha256"] == sha(small), "small upload sha matches")
        got = c.files.download(rec["id"], tmp / "small.out")
        check(sha(got) == sha(small), "small download bytes identical")

        step(f"big file ({BIG_MB} MB): chunked upload → streamed download → compare")
        big = tmp / "big.bin"
        with big.open("wb") as f:
            for _ in range(BIG_MB):
                f.write(os.urandom(1 << 20))
        rec = c.files.upload(big, on_progress=lambda d, t: print(f"    up {d >> 20}/{t >> 20} MB", end="\r"))
        print()
        uploaded.append(rec["id"])
        check(rec["size"] == big.stat().st_size, "size recorded")
        got = c.files.download(rec["id"], tmp / "big.out", on_progress=lambda d, t: print(f"    down {d >> 20}/{t >> 20} MB", end="\r"))
        print()
        check(sha(got) == sha(big), "big download bytes identical")

        step("list contains both; delete → 404")
        ids = {f["id"] for f in c.files.list()}
        check(all(u in ids for u in uploaded), "uploads listed")
        for u in list(uploaded):
            c.files.delete(u)
            uploaded.remove(u)
        try:
            c.files.retrieve(rec["id"])
            check(False, "deleted file must 404")
        except NotFoundError:
            check(True, "deleted file 404s")
        print("PASS test_files")
    finally:
        for u in uploaded:
            try: c.files.delete(u)
            except Exception: pass


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: `test_skills.py`**

```python
"""Skills: build a zip in-memory, upload, verify manifest, delete."""
from __future__ import annotations

import io
import tempfile
import zipfile
from pathlib import Path

from _common import check, client, step


def main() -> None:
    c = client()
    skill_id = None
    try:
        step("build skill zip (SKILL.md + helper) and upload")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("SKILL.md", "# Greeting skill\nAlways greet in pirate speak.\n")
            z.writestr("scripts/greet.sh", "#!/bin/sh\necho 'Ahoy!'\n")
        path = Path(tempfile.mkdtemp(prefix="dp-skill-")) / "pirate-greeting.zip"
        path.write_bytes(buf.getvalue())
        skill = c.skills.upload(path)
        skill_id = skill["id"]
        check(skill["name"] == "pirate-greeting", "skill named from filename")

        step("retrieve manifest")
        got = c.skills.retrieve(skill_id)
        paths = {f["path"] for f in got.get("files", [])}
        check("SKILL.md" in paths, "manifest contains SKILL.md")
        check("scripts/greet.sh" in paths, "manifest contains helper script")

        step("listed, then delete")
        check(any(s["id"] == skill_id for s in c.skills.list()), "skill listed")
        c.skills.delete(skill_id)
        skill_id = None
        print("PASS test_skills")
    finally:
        if skill_id:
            try: c.skills.delete(skill_id)
            except Exception: pass


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: `test_memory.py`**

```python
"""Memory stores: create, add entries, tree + content round trip, delete."""
from __future__ import annotations

from _common import check, client, step


def main() -> None:
    c = client()
    store_id = None
    try:
        step("create store + entries")
        store = c.memory_stores.create(name="api-example-memory")
        store_id = store["id"]
        c.memory_stores.entries.add(store_id, "facts/user.md", b"Prefers dark mode.\n")
        c.memory_stores.entries.add(store_id, "facts/project.md", b"Ships on Fridays.\n")

        step("tree + content round trip")
        paths = {e["path"] for e in c.memory_stores.tree(store_id)}
        check(paths == {"facts/user.md", "facts/project.md"}, f"tree lists both entries ({paths})")
        body = c.memory_stores.content(store_id, "facts/user.md")
        check(body == b"Prefers dark mode.\n", "entry content round-trips")

        step("delete entry, then store")
        c.memory_stores.entries.delete(store_id, "facts/project.md")
        paths = {e["path"] for e in c.memory_stores.tree(store_id)}
        check(paths == {"facts/user.md"}, "entry removed from tree")
        c.memory_stores.delete(store_id)
        store_id = None
        print("PASS test_memory")
    finally:
        if store_id:
            try: c.memory_stores.delete(store_id)
            except Exception: pass


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: `test_vault.py`**

```python
"""Credentials vault: create, add credential, secrets never echoed, delete."""
from __future__ import annotations

import json

from _common import check, client, step

SECRET = "super-secret-value-1234"


def main() -> None:
    c = client()
    vault_id = None
    try:
        step("create vault with an initial secret")
        vault = c.vaults.create(name="api-example-vault", secrets={"API_TOKEN": SECRET})
        vault_id = vault["id"]

        step("add a second credential")
        c.vaults.credentials.create(vault_id, name="DB_PASSWORD", value=SECRET)

        step("read back: names visible, values never echoed")
        got = c.vaults.retrieve(vault_id)
        names = {cred["name"] for cred in got["credentials"]}
        check(names == {"API_TOKEN", "DB_PASSWORD"}, f"credential names listed ({names})")
        check(SECRET not in json.dumps(got), "secret value never appears in any response")

        step("delete credential, then vault")
        c.vaults.credentials.delete(vault_id, "DB_PASSWORD")
        got = c.vaults.retrieve(vault_id)
        check({cr["name"] for cr in got["credentials"]} == {"API_TOKEN"}, "credential removed")
        c.vaults.delete(vault_id)
        vault_id = None
        print("PASS test_vault")
    finally:
        if vault_id:
            try: c.vaults.delete(vault_id)
            except Exception: pass


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: `test_tools.py`**

```python
"""Tools end-to-end: managed agent session that must use its tools.

Requires a tool-capable deployed model (DEVPROOF_TEST_MODEL) — tiny models
like qwen0.5b cannot follow tool-use instructions reliably.
"""
from __future__ import annotations

import os

from _common import check, client, step

MODEL = os.environ.get("DEVPROOF_TEST_MODEL", "qwen3-5-4b-q4")
PROMPT = ("Create a file /work/hello.txt containing exactly the text 'devproof tools test', "
          "then read the file back and tell me its contents.")


def main() -> None:
    c = client()
    env_id = agent_id = None
    try:
        step("create environment + agent")
        env = c.environments.create(name="api-example-env")
        env_id = env["id"]
        agent = c.agents.create(name="api-example-agent", model=MODEL, environment_id=env_id,
                                system_prompt="You are a careful assistant. Use your tools.",
                                max_turns=6)
        agent_id = agent["id"]

        step("start session and stream events until terminal")
        session = c.sessions.create(agent=agent_id, prompt=PROMPT, name="tools-example")
        tool_events = 0
        final_status = ""
        for event in c.sessions.events.stream(session["id"]):
            etype = event.get("type", "")
            if etype == "status":
                final_status = event["payload"]["status"]
                print(f"    status: {final_status}")
            elif "tool" in etype.lower():
                tool_events += 1
                print(f"    tool event: {etype}")
        check(tool_events > 0, f"agent used tools ({tool_events} tool events)")
        check(final_status in ("idle", "completed"), f"session finished cleanly (status={final_status})")

        step("verify transcript mentions the file content")
        events = c.sessions.events.list(session["id"])
        transcript = str(events)
        check("hello.txt" in transcript, "transcript references the created file")
        print("PASS test_tools")
    finally:
        step("teardown")
        if agent_id:
            try: c.agents.delete(agent_id)   # cascades sessions
            except Exception: pass
        if env_id:
            try: c.environments.delete(env_id)
            except Exception: pass


if __name__ == "__main__":
    main()
```

- [ ] **Step 7: `README.md`**

```markdown
# Public API example scripts

Executable documentation for the Devproof public API — each script asserts
real outcomes and cleans up after itself (they double as an end-to-end suite).

## Setup

1. Create an API key on the console's **API Keys** page (copy the `dpk_...`
   secret — it is shown once).
2. Environment:

   ```
   export DEVPROOF_API_KEY=dpk_...
   export DEVPROOF_BASE_URL=http://localhost:14000   # the gateway (default)
   ```

3. `pip install httpx` (the only dependency).

## Scripts

| Script | Exercises |
|---|---|
| `test_files.py` | Upload/download round trip incl. a big file through the chunked path (`DEVPROOF_TEST_BIG_MB`, default 100) |
| `test_skills.py` | Skill zip upload + manifest |
| `test_memory.py` | Memory store entries, tree, content |
| `test_vault.py` | Vault + credentials (write-only secrets) |
| `test_tools.py` | Full managed-agent session with tool use (`DEVPROOF_TEST_MODEL`, needs a tool-capable model) |

Run: `python examples/api/test_files.py` (any order; each is standalone).

Model inference itself uses the official `anthropic` package against the same
gateway: `ANTHROPIC_BASE_URL=http://localhost:14000 ANTHROPIC_AUTH_TOKEN=dpk_...`.
```

- [ ] **Step 8: Compile-check and commit**

```bash
python -m py_compile examples/api/_common.py examples/api/test_files.py examples/api/test_skills.py examples/api/test_memory.py examples/api/test_vault.py examples/api/test_tools.py
git add examples/api
git commit -m "feat(examples): public-API example scripts — files, skills, memory, vault, tools"
```

---

### Task 9: Live verification on the cluster

No new code — this is the project's "verify before claiming done" gate plus the spec's open items (32 MB chunks under load, big-file gateway memory).

- [ ] **Step 1: Start the control plane** (per CLAUDE.md — NOT `npm run dev`):

```bash
cd control-plane
DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev25 \
DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files \
npx tsx src/main.ts
```

Expected: boots, migration 026 applies (`file_uploads` table exists).

- [ ] **Step 2: Sync the gateway** — trigger a gateway sync (console Serving page → Sync, or `curl -X POST http://127.0.0.1:7080/v1/gateway/sync` if exposed; check `server.ts` for the exact route). Then confirm the ConfigMap contains the pass-through block:

```bash
kubectl get configmap litellm-config -n devproof-gateway -o jsonpath="{.data.config\.yaml}" | grep -A6 pass_through
```

Expected: the `/api` block with `include_subpath: true`. Wait for gateway rollout if the sync restarts pods.

- [ ] **Step 3: Create a key and run all five scripts through the gateway**

```bash
# console → API Keys → create "public-api-test", copy the dpk_ secret
export DEVPROOF_API_KEY=dpk_...
export DEVPROOF_BASE_URL=http://localhost:14000
python examples/api/test_files.py      # includes the 100 MB chunked path
python examples/api/test_skills.py
python examples/api/test_memory.py
python examples/api/test_vault.py
DEVPROOF_TEST_MODEL=qwen3-5-4b-q4 python examples/api/test_tools.py
```

Expected: all five print `PASS`. While `test_files.py` runs, watch gateway memory: `kubectl top pods -n devproof-gateway` — per-pod usage must stay bounded (chunks are 32 MB).

- [ ] **Step 4: Regression checks**

```bash
# UI path untouched: start console, click through pages
cd console && npx next build && npx next start -p 7090
# → all pages 200; files uploaded by the scripts visible on the Files page

# External coding-agent CLI inference flow still works after the config change:
# ANTHROPIC_BASE_URL=http://localhost:14000 ANTHROPIC_AUTH_TOKEN=dpk_... <agent-cli> -p "say hi" --model qwen3-5-4b-q4 --strict-mcp-config --mcp-config empty.json
```

Expected: console 200s; inference through the gateway unaffected.

- [ ] **Step 5: Invalid-key spot check through the real gateway**

```bash
curl -s http://localhost:14000/api/files -H "Authorization: Bearer dpk_bogus"
# → 401 (from the gateway custom_auth or the CP — either is correct, fail-closed)
curl -s http://localhost:14000/api/files
# → 401
```

- [ ] **Step 6: Final commit (fixups found during verification) + TODO update**

Remove the implemented item from `TODO.txt` ("API keys must work with file and skill uploads ..." block), then:

```bash
git add -A
git commit -m "chore: public API verified live — TODO updated"
```

---

## Self-review notes

- Spec coverage: architecture (T3/T5/T6), auth (T1), verified transport constraints (encoded as Global Constraints + route shapes), 4 GB chunked uploads + sweep + streamed download (T2/T3), contract guard (T5), Python lib (T7), five scripts (T8), live verification incl. open items (T9). Sweep implementation deviates from the spec's "reconciler piggyback" wording — dedicated hourly timer, noted inline in Task 3 Step 7.
- Type consistency: `PART_SIZE` exported from `public-api.ts` and asserted in tests; FileStore optional methods used with `!` only after `createUpload` presence check (501 otherwise); `publicFakes` exported for the contract test; Python `client.files.upload/download/list/retrieve/delete` match the resources.py definitions used in scripts.
