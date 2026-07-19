// Maintenance DB-backed tests (spec 2026-07-17-maintenance-design.md):
// migration 043, retention repo methods, session/file cleanup integration.
// Shared dev DB — seeds use the swept t- workspace prefix; prune tests use
// ≥3650-day cutoffs so they can never touch real data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { DEFAULT_MAINTENANCE_CRON } from "../src/maintenance.ts";

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

test("repo maintenance settings: legacy storage.gcCron fallback + roundtrip", { skip: !available }, async () => {
  const repo = new Repo(pool);
  // Snapshot the whole singleton so we restore its EXACT prior state — this
  // row is shared dev-DB state we didn't seed, and other settings tests read
  // storage/maintenance/costs; deleting keys would discard admin config.
  const { rows: snap } = await pool.query("SELECT data FROM app_settings WHERE id = 'global'");
  const original = snap[0].data;
  try {
    await pool.query(`UPDATE app_settings SET data = (data - 'maintenance') || '{"storage":{"gcCron":"*/10 * * * *"}}'::jsonb WHERE id = 'global'`);
    const m = await repo.getMaintenanceSettings();
    assert.equal(m.cron, "*/10 * * * *");           // legacy fallback
    assert.equal(m.billing.enabled, false);          // defaults elsewhere

    const next = { ...m, cron: "0 2 * * *", tokens: { enabled: true, keep: 30, unit: "days" as const } };
    await repo.putMaintenanceSettings(next);
    assert.deepEqual(await repo.getMaintenanceSettings(), next);
  } finally {
    await pool.query("UPDATE app_settings SET data = $1::jsonb WHERE id = 'global'", [JSON.stringify(original)]);
  }
});

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
