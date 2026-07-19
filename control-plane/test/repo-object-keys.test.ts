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
  const agent = await repo.createAgent(ws, `t-sdel-${Date.now()}`, { routing: "qwen05b-dp", tools: [] });
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

test("deleteSession leaves memory-store files intact", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-sdelmem-${Date.now()}`)).id;
  const agent = await repo.createAgent(ws, `t-sdelmem-${Date.now()}`, { routing: "qwen05b-dp", tools: [] });
  const session = await repo.createSession(ws, agent.id, "hi");
  const store = await repo.createMemoryStore(ws, `t-sdelmem-${Date.now()}`);

  // Runner path: memory file uploaded via /v1/files/raw carries the session id.
  const memId = fid();
  const memKey = `${ws}/memory/${store.id}/notes.md`;
  await repo.createFileRecord({ id: memId, name: "notes.md", size: 4, sha256: "m", objectKey: memKey, sessionId: session.id, kind: "memory", workspaceId: ws });
  await repo.upsertMemoryEntries(store.id, [{ path: "notes.md", fileId: memId }]);

  const cp = fid();
  const cpKey = `${ws}/sessions/${session.id}/${cp}`;
  await repo.createFileRecord({ id: cp, name: "checkpoint.tar.gz", size: 3, sha256: "z", objectKey: cpKey, sessionId: session.id, kind: "checkpoint", workspaceId: ws });

  const keys = await repo.deleteSession(ws, session.id);
  assert.deepEqual(keys, [cpKey]);
  assert.equal(await repo.getFileRecord(cp), null); // checkpoint row gone
  assert.ok(await repo.getFileRecord(memId)); // memory row survives
  assert.equal((await repo.getMemoryEntry(store.id, "notes.md")).file_id, memId); // still referenced
  assert.equal(await repo.getSession(session.id), null);

  await repo.deleteMemoryStore(ws, store.id);
  await repo.deleteAgent(ws, agent.id);
});

test("deleteSession DISTINCTs a shared checkpoint key and returns a distinct key once each", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-sdelshr-${Date.now()}`)).id;
  const agent = await repo.createAgent(ws, `t-sdelshr-${Date.now()}`, { routing: "qwen05b-dp", tools: [] });
  const session = await repo.createSession(ws, agent.id, "hi");

  const sharedKey = `${ws}/sessions/${session.id}/shared.tar.gz`;
  const distinctKey = `${ws}/sessions/${session.id}/distinct.tar.gz`;
  const a = fid(), b = fid(), c = fid();
  await repo.createFileRecord({ id: a, name: "checkpoint.tar.gz", size: 1, sha256: "a", objectKey: sharedKey, sessionId: session.id, kind: "checkpoint", workspaceId: ws });
  await repo.createFileRecord({ id: b, name: "checkpoint.tar.gz", size: 1, sha256: "b", objectKey: sharedKey, sessionId: session.id, kind: "checkpoint", workspaceId: ws });
  await repo.createFileRecord({ id: c, name: "checkpoint.tar.gz", size: 1, sha256: "c", objectKey: distinctKey, sessionId: session.id, kind: "checkpoint", workspaceId: ws });

  const keys = await repo.deleteSession(ws, session.id);
  assert.deepEqual([...keys].sort(), [distinctKey, sharedKey].sort());

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
