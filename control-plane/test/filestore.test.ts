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
