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

test("workspace drain helpers: counts, batch ids, bulk deletes", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-wsdrain-${Date.now()}`)).id;
  const env = await repo.createEnvironment(ws, `t-env-${Date.now()}`);
  const agent = await repo.createAgent(ws, `t-agent-${Date.now()}`, { routing: "m", environmentId: env.id });
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
