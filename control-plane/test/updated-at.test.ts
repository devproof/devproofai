// updated_at columns and the child->parent touch triggers (baseline schema).
// Integration tests against the live dev Postgres; self-skip when unreachable
// (same pattern as session-usage-trigger.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { registerAgentRoutes } from "../src/agents-api.ts";

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
  const agent = await repo.createAgent(ws, `t-ver-${uniq()}`, { routing: "qwen05b-dp", tools: [] });

  await pool.query("UPDATE agents SET updated_at = now() - interval '1 day' WHERE id = $1", [agent.id]);
  const t0 = await stampOf("agents", agent.id);
  await repo.newAgentVersion(ws, agent.id, { routing: "qwen05b-dp", tools: [], systemPrompt: "v2" });
  assert.ok(+(await stampOf("agents", agent.id)) > +t0, "a version save must bump the agent");
});

test("agent status toggle and rename bump updated_at", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-ag-${uniq()}`)).id;
  const agent = await repo.createAgent(ws, `t-ag-${uniq()}`, { routing: "qwen05b-dp", tools: [] });

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
  await repo.createAgent(ws, `t-la-${uniq()}`, { routing: "qwen05b-dp", tools: [] });
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
  const agent = await repo.createAgent(ws, `t-ses-${uniq()}`, { routing: "qwen05b-dp", tools: [] });
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

test("listAgents orders by updated_at DESC, not created_at", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-ord-ag-${uniq()}`)).id;
  const older = await repo.createAgent(ws, `t-ord-ag-older-${uniq()}`, { routing: "qwen05b-dp", tools: [] });
  const newer = await repo.createAgent(ws, `t-ord-ag-newer-${uniq()}`, { routing: "qwen05b-dp", tools: [] });

  // Bump the OLDER agent so it is now the most-recently-modified.
  await repo.renameAgent(ws, older.id, `t-ord-ag-older-renamed-${uniq()}`);

  const { rows } = await repo.listAgents(ws);
  assert.equal(rows[0].id, older.id,
    "the just-renamed (older-created) agent must sort first when ordering by updated_at");
  assert.equal(rows[1].id, newer.id);
});

test("listSkills orders by updated_at DESC, not created_at", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-ord-sk-${uniq()}`)).id;
  const nameOlder = `t-ord-sk-older-${uniq()}`;
  const nameNewer = `t-ord-sk-newer-${uniq()}`;
  const a = fid(), b = fid(), c = fid();
  await repo.createFileRecord({ id: a, name: "SKILL.md", size: 1, sha256: "x", objectKey: `${ws}/skills/${nameOlder}/a`, kind: "skill", workspaceId: ws });
  await repo.createFileRecord({ id: b, name: "SKILL.md", size: 1, sha256: "y", objectKey: `${ws}/skills/${nameNewer}/a`, kind: "skill", workspaceId: ws });
  await repo.createFileRecord({ id: c, name: "SKILL.md", size: 2, sha256: "z", objectKey: `${ws}/skills/${nameOlder}/b`, kind: "skill", workspaceId: ws });

  const older = await repo.createSkill(ws, nameOlder, [{ path: "SKILL.md", fileId: a }]);
  const newer = await repo.createSkill(ws, nameNewer, [{ path: "SKILL.md", fileId: b }]);

  // Re-upload the OLDER skill — this used to jump it to the top via the
  // created_at stomp; the same behaviour must now come from updated_at.
  await repo.createSkill(ws, nameOlder, [{ path: "SKILL.md", fileId: c }]);

  const rows = await repo.listSkills(ws);
  assert.equal(rows[0].id, older.id,
    "the just-reuploaded (older-created) skill must sort first when ordering by updated_at");
  assert.equal(rows[1].id, newer.id);
});

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

test("PATCH /v1/memory-stores/:id renames the store, 404s, and is workspace-scoped", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-api-${uniq()}`)).id;
  const other = (await repo.createWorkspace(`t-api-other-${uniq()}`)).id;
  const store = await repo.createMemoryStore(ws, `store-${uniq()}`);

  const app = Fastify();
  await registerAgentRoutes(app, repo as any, {} as any, {} as any);

  const renamed = await app.inject({
    method: "PATCH", url: `/v1/memory-stores/${store.id}`,
    headers: { "X-Devproof-Workspace": ws, "content-type": "application/json" },
    payload: { name: "renamed-store" },
  });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().store.name, "renamed-store");

  const missing = await app.inject({
    method: "PATCH", url: `/v1/memory-stores/memstore_nope`,
    headers: { "X-Devproof-Workspace": ws, "content-type": "application/json" },
    payload: { name: "x" },
  });
  assert.equal(missing.statusCode, 404);

  const wrongWs = await app.inject({
    method: "PATCH", url: `/v1/memory-stores/${store.id}`,
    headers: { "X-Devproof-Workspace": other, "content-type": "application/json" },
    payload: { name: "stolen" },
  });
  assert.equal(wrongWs.statusCode, 404, "the route must be workspace-scoped");
  assert.equal((await repo.getMemoryStore(store.id, ws)).name, "renamed-store");

  await app.close();
});
