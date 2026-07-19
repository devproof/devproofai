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

test("agent create → version → session → events roundtrip", { skip: !available }, async () => {
  const repo = new Repo(pool);
  // Isolated workspace + cascade delete at the end: this suite runs against
  // the live dev DB, and debris agents/sessions in wrkspc_default show up in
  // the console (19 stuck-"queued" sessions accumulated before this guard).
  const ws = (await repo.createWorkspace(`t-ws-${Date.now()}`)).id;
  const name = `t-${Date.now()}`;
  const agent = await repo.createAgent(ws, name, { routing: "qwen05b-dp", tools: ["Bash"] });
  assert.equal(agent.version, 1);

  const v2 = await repo.newAgentVersion(ws, agent.id, { routing: "qwen05b-dp", systemPrompt: "v2" });
  assert.equal(v2, 2);
  const latest = await repo.getAgentVersion(agent.id);
  assert.equal(latest.version, 2);
  assert.equal(latest.system_prompt, "v2");

  const session = await repo.createSession(ws, agent.id, "do something", "ZD-1");
  assert.equal(session.agentVersion, 2);

  const seq = await repo.appendEvents(session.id, [
    { type: "session.created", payload: {} },
    { type: "agent.message", payload: { text: "hi" }, tokensIn: 100, tokensOut: 5, durationMs: 900 },
  ]);
  assert.equal(seq, 2);

  const s = await repo.getSession(session.id);
  assert.equal(s.status, "running");
  // Event tokens are display-only since migration 027 — session totals are
  // written ONLY by the gateway_usage trigger (see session-usage-trigger.test.ts).
  assert.equal(Number(s.tokens_in), 0);

  await repo.setSessionStatus(session.id, "completed");
  const events = await repo.listEvents(session.id);
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "agent.message");
  assert.ok((await repo.getSession(session.id)).completed_at);

  await repo.deleteAgent(ws, agent.id); // FK cascade removes the session + events
});

test("user-event appends do not flip queued → running; runner events do", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-flip-${Date.now()}`)).id;
  const agent = await repo.createAgent(ws, `t-flip-${Date.now()}`, { routing: "qwen05b-dp", tools: [] });
  const session = await repo.createSession(ws, agent.id, "hello");

  // The route appends the user prompt event before the pod exists (agents-api.ts:434/467).
  // That append must NOT flip the status — "running" means the runner reported in.
  await repo.appendEvents(session.id, [{ type: "user", payload: { text: "hello", turn: 0 } }]);
  assert.equal((await repo.getSession(session.id)).status, "queued");

  // A gate park (session.waiting) is a CP event, not the runner reporting in —
  // the parked session must STAY queued, else a writer-queued session shows
  // "running" while its pod hasn't started (bug 2026-07-18).
  await repo.appendEvents(session.id, [{ type: "session.waiting", payload: { writerAgent: agent.id, turn: 0 } }]);
  assert.equal((await repo.getSession(session.id)).status, "queued");

  // First runner event flips it (documented lifecycle: queued → running on first runner event).
  await repo.appendEvents(session.id, [{ type: "session.created", payload: {} }]);
  assert.equal((await repo.getSession(session.id)).status, "running");

  await repo.deleteAgent(ws, agent.id); // FK cascade removes the session + events
});

test("appendEvents dedupes on uid — a retried at-least-once batch inserts nothing new", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-idem-${Date.now()}`)).id;
  const agent = await repo.createAgent(ws, `t-idem-${Date.now()}`, { routing: "qwen05b-dp", tools: [] });
  const session = await repo.createSession(ws, agent.id, "hello");

  const batch = [
    { type: "agent.message", payload: { text: "once" }, uid: "u-1" },
    { type: "tool.call", payload: { tool: "Bash" }, uid: "u-2" },
  ];
  await repo.appendEvents(session.id, batch);
  // The at-least-once retry case: identical batch delivered again.
  await repo.appendEvents(session.id, batch);
  // uid-less events (user prompts, old runners) still insert unconditionally.
  await repo.appendEvents(session.id, [{ type: "agent.message", payload: { text: "no uid" } }]);

  const events = await repo.listEvents(session.id);
  assert.deepEqual(events.map((e: any) => e.type),
    ["agent.message", "tool.call", "agent.message"]);
  assert.deepEqual(events.map((e: any) => e.seq), [1, 2, 3]);

  await repo.deleteAgent(ws, agent.id);
});

test("gatewayUsage aggregates buckets, totals, and filters", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = await repo.createWorkspace(`wsu-${Date.now()}`); // isolated workspace so reruns don't accumulate
  const key = await repo.createApiKey(ws.id, "usage-test-key");
  await pool.query(
    `INSERT INTO gateway_usage (workspace_id, api_key_id, model, tokens_in, tokens_out, created_at) VALUES
     ($1, $2, 'dep-a', 100, 10, now()),
     ($1, $2, 'dep-b', 200, 20, now()),
     ($1, NULL, 'dep-a', 50, 5, now()),                         -- deleted-key row
     ($1, $2, 'dep-a', 999, 99, now() - interval '30 days')`,   // outside 7d window
    [ws.id, key.id],
  );

  const all = await repo.gatewayUsage(ws.id, { range: "7d" });
  assert.equal(all.bucket, "day");
  assert.equal(all.totals.tokens_in, 350);
  assert.equal(all.totals.tokens_out, 35);
  assert.equal(all.totals.requests, 3);
  assert.equal(all.buckets.length, 7); // zero-filled: one bucket per day of the window
  assert.equal(all.buckets.at(-1)!.tokens_in, 350); // all three rows land in today's bucket
  assert.ok(all.buckets.slice(0, -1).every((b: any) => b.tokens_in === 0));
  assert.equal(all.byDeployment.find((d: any) => d.model === "dep-a")!.tokens_in, 150);
  const deleted = all.byKey.find((k: any) => k.api_key_id === null)!;
  assert.equal(deleted.name, null);
  assert.equal(deleted.tokens_in, 50);
  assert.equal(all.byKey.find((k: any) => k.api_key_id === key.id)!.name, "usage-test-key");

  const depOnly = await repo.gatewayUsage(ws.id, { range: "7d", deployment: "dep-b" });
  assert.equal(depOnly.totals.tokens_in, 200);

  const keyOnly = await repo.gatewayUsage(ws.id, { range: "7d", apiKeyId: key.id });
  assert.equal(keyOnly.totals.tokens_in, 300);

  const sixMonths = await repo.gatewayUsage(ws.id, { range: "6m" });
  assert.equal(sixMonths.bucket, "week");
  assert.equal(sixMonths.totals.tokens_in, 350 + 999);

  const deletedOnly = await repo.gatewayUsage(ws.id, { range: "7d", apiKeyId: "__deleted__" });
  assert.equal(deletedOnly.totals.tokens_in, 50);
  assert.equal(deletedOnly.totals.requests, 1);
});

test("sessionResources returns the agent block", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`res-ws-${Date.now()}`)).id; // isolated: see roundtrip test
  const agent = await repo.createAgent(ws, `res-agent-${Date.now()}`, { routing: "m1", systemPrompt: "SP", maxTurns: 7, tools: [] });
  const s = await repo.createSession(ws, agent.id, "hello");
  const r = await repo.sessionResources(s.id, ws);
  assert.equal(r!.agent.name, agent.name);
  assert.equal(r!.agent.version, 1);
  assert.equal(r!.agent.systemPrompt, "SP");
  assert.equal(r!.agent.maxTurns, 7);
  await repo.deleteAgent(ws, agent.id); // FK cascade removes the session
});

test("external deployments CRUD roundtrip (global, not workspace-scoped)", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const name = `ext-${Date.now()}`;
  const created = await repo.createExternalDeployment({
    name, provider: "openrouter", modelId: "meta-llama/llama-3.1-8b-instruct", hasKey: true,
    contextTokens: 128000,
  });
  assert.match(created.id, /^mdep_/);
  assert.equal(created.key_version, 1);
  assert.equal(created.has_key, true);
  assert.equal(created.base_url, null);
  assert.equal(created.context_tokens, 128000);

  assert.equal((await repo.getExternalDeploymentByName(name))!.id, created.id);
  assert.equal(await repo.getExternalDeploymentByName("nope-" + name), null);

  const listed = await repo.listExternalDeployments();
  assert.ok(listed.some((r: any) => r.id === created.id));

  const rotated = await repo.updateExternalDeployment(created.id, { rotateKey: true, modelId: "openai/gpt-4o" });
  assert.equal(rotated!.key_version, 2);
  assert.equal(rotated!.model_id, "openai/gpt-4o");

  const gone = await repo.deleteExternalDeployment(created.id);
  assert.equal(gone!.id, created.id);
  assert.equal(await repo.getExternalDeploymentByName(name), null);
});

test("external deployments accept every API-level provider (DB check constraint, migration 040)", { skip: !available }, async () => {
  const repo = new Repo(pool);
  for (const provider of ["openai", "anthropic", "openrouter", "ollama", "custom"]) {
    const created = await repo.createExternalDeployment({
      name: `ext-${provider}-${Date.now()}`, provider, modelId: "m", hasKey: false,
      contextTokens: 128000,
    });
    await repo.deleteExternalDeployment(created.id);
  }
});


test("gatewayUsage counts only source='api' rows", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = await repo.createWorkspace(`src-${Date.now()}`);
  const key = await repo.createApiKey(ws.id, "src-key");
  await pool.query(
    `INSERT INTO gateway_usage (workspace_id, api_key_id, model, tokens_in, tokens_out, source, agent_id) VALUES
     ($1, $2, 'dep-src', 100, 10, 'api', NULL),
     ($1, NULL, 'dep-src', 700, 70, 'session', 'agent_x')`,
    [ws.id, key.id]);
  const u = await repo.gatewayUsage(ws.id, { range: "7d" });
  assert.equal(u.totals.tokens_in, 100);   // session row invisible to billing views
  assert.equal(u.totals.requests, 1);
});

test("deploymentStats: zero-filled buckets, totals, filters", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const model = `dep-stats-${Date.now()}`;
  try {
    await pool.query(
      `INSERT INTO gateway_usage (workspace_id, api_key_id, model, tokens_in, tokens_out, source, agent_id, session_id, created_at) VALUES
       ('wrkspc_default', NULL, $1, 10, 1, 'session', 'agent_a', 'sesn_1', now() - interval '5 seconds'),
       ('wrkspc_default', NULL, $1, 20, 2, 'session', 'agent_b', 'sesn_2', now() - interval '5 seconds'),
       ('wrkspc_default', NULL, $1, 40, 4, 'api',     NULL,      NULL,     now() - interval '200 seconds')`,
      [model]);
    const s = await repo.deploymentStats(model, { windowSec: 60, bucketSec: 2 });
    assert.equal(s.buckets.length, 30);                       // 60s / 2s, zero-filled
    assert.equal(s.totals.tokens_in, 30);                     // 200s-old row outside window
    assert.equal(s.totals.requests, 2);
    assert.equal(s.buckets.reduce((a, b) => a + b.tokens_in, 0), 30);
    assert.ok(s.buckets.every((b, i) => i === 0 || b.t === s.buckets[i - 1].t + 2)); // ascending, contiguous
    const agents = await repo.deploymentStats(model, { windowSec: 60, bucketSec: 2, agentId: "agent_a" });
    assert.equal(agents.totals.tokens_in, 10);
    const sess = await repo.deploymentStats(model, { windowSec: 300, bucketSec: 10, sessionOnly: true });
    assert.equal(sess.totals.tokens_in, 30);
  } finally {
    // These rows live in wrkspc_default (the workspace-hygiene sweep never
    // touches it) — 259 leaked dep-stats models once polluted the usage pages.
    await pool.query("DELETE FROM gateway_usage WHERE model = $1", [model]);
  }
});

test("createApiKey mints dpk_ + 33 base62 chars with a matching hint", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = await repo.createWorkspace(`t-key-${Date.now()}`);
  const key = await repo.createApiKey(ws.id, "fmt-test-key");
  assert.match(key.key, /^dpk_[0-9A-Za-z]{33}$/);
  assert.equal(key.partial_hint, `dpk_…${key.key.slice(-4)}`);
});

test("trace subscriptions: upsert refreshes TTL, delete removes", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const id = `tsub-${Date.now()}`;
  await repo.upsertTraceSubscription(id, { deployment: "dep-x" }, "http://cp:7080");
  const { rows: [r1] } = await pool.query("SELECT * FROM trace_subscriptions WHERE id = $1", [id]);
  assert.equal(r1.deployment, "dep-x");
  assert.ok(new Date(r1.expires_at).getTime() > Date.now() + 5_000);
  await repo.upsertTraceSubscription(id, { deployment: "dep-x" }, "http://cp:7080"); // heartbeat: no PK error
  await repo.deleteTraceSubscription(id);
  const { rows } = await pool.query("SELECT 1 FROM trace_subscriptions WHERE id = $1", [id]);
  assert.equal(rows.length, 0);
});

test("setApiKeyStatus: 'deleted' is terminal, cannot be resurrected", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = await repo.createWorkspace(`resurrect-${Date.now()}`);
  const key = await repo.createApiKey(ws.id, "resurrect-test-key");

  await repo.deleteApiKey(ws.id, key.id);
  let { rows } = await pool.query("SELECT status FROM api_keys WHERE id = $1", [key.id]);
  assert.equal(rows[0].status, "deleted");

  await repo.setApiKeyStatus(ws.id, key.id, "active");
  ({ rows } = await pool.query("SELECT status FROM api_keys WHERE id = $1", [key.id]));
  assert.equal(rows[0].status, "deleted"); // resurrection blocked
});

test("startTurn resumes failed sessions and keeps the checkpoint", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`resume-ws-${Date.now()}`)).id;
  const agent = await repo.createAgent(ws, `resume-agent-${Date.now()}`, { routing: "m1" });
  const s = await repo.createSession(ws, agent.id, "hi");
  await repo.setSessionStatus(s.id, "idle", { sdkSessionId: "sdk-1", checkpointFileId: "file_ckpt1" });

  await repo.setSessionStatus(s.id, "failed"); // reconciler-style failure — must not wipe resume state
  const turn = await repo.startTurn(s.id);
  assert.equal(turn.turn, 1);
  assert.equal(turn.sdkSessionId, "sdk-1");
  assert.equal(turn.checkpointFileId, "file_ckpt1");
  assert.equal((await repo.getSession(s.id)).status, "queued");

  await repo.setSessionStatus(s.id, "running");
  await assert.rejects(() => repo.startTurn(s.id)); // running still rejects

  await repo.deleteAgent(ws, agent.id); // FK cascade removes the session
});

test("createFileRecord: identical metadata twice creates two independent rows", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const a = { id: `file_${Math.random().toString(36).slice(2, 14)}`, name: "dup.txt", size: 3, sha256: "abc" };
  const b = { id: `file_${Math.random().toString(36).slice(2, 14)}`, name: "dup.txt", size: 3, sha256: "abc" };
  await repo.createFileRecord({ ...a, objectKey: `wrkspc_default/files/${a.id}` });
  await repo.createFileRecord({ ...b, objectKey: `wrkspc_default/files/${b.id}` });
  const { rows } = await pool.query("SELECT id FROM files WHERE sha256 = 'abc' AND name = 'dup.txt'");
  assert.ok(rows.length >= 2);
  await pool.query("DELETE FROM files WHERE id = ANY($1)", [[a.id, b.id]]);
});

test("createFileRecord: same id twice now raises (dedup removed)", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const id = `file_${Math.random().toString(36).slice(2, 14)}`;
  const m = { id, name: "x", size: 1, sha256: "zz", objectKey: `wrkspc_default/files/${id}` };
  await repo.createFileRecord(m);
  await assert.rejects(() => repo.createFileRecord(m));
  await pool.query("DELETE FROM files WHERE id = $1", [m.id]);
});

test("stale-turn status post is ignored atomically; current-turn post applies", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-stale-${Date.now()}`)).id;
  const agent = await repo.createAgent(ws, `t-stale-${Date.now()}`, { routing: "qwen05b-dp", tools: [] });
  const session = await repo.createSession(ws, agent.id, "hello"); // turns = 0, status queued

  // Turn 0's pod finishes normally: reportedTurn 0 vs turns 0 — applies.
  const first = await repo.setSessionStatus(session.id, "idle", { checkpointFileId: "file_turn0ckpt" }, 0);
  assert.equal(first.applied, true);
  assert.equal((await repo.getSession(session.id)).status, "idle");

  // Follow-up message: turns -> 1, status queued.
  await repo.startTurn(session.id);

  // The interrupted/stale turn-0 pod reports late: must be ignored ENTIRELY.
  const stale = await repo.setSessionStatus(session.id, "idle", { checkpointFileId: "file_stale00001" }, 0);
  assert.equal(stale.applied, false);
  assert.equal(stale.replacedCheckpointFileId, null); // caller must not delete anything
  const s = await repo.getSession(session.id);
  assert.equal(s.status, "queued");                        // not clobbered
  assert.equal(s.checkpoint_file_id, "file_turn0ckpt");    // not replaced

  // Turn 1's own pod reports: applies and replaces the checkpoint.
  const current = await repo.setSessionStatus(session.id, "idle", { checkpointFileId: "file_turn1ckpt" }, 1);
  assert.equal(current.applied, true);
  assert.equal(current.replacedCheckpointFileId, "file_turn0ckpt");
  assert.equal((await repo.getSession(session.id)).checkpoint_file_id, "file_turn1ckpt");

  // No reportedTurn (old runner image / non-runner callers): applies as today.
  const legacy = await repo.setSessionStatus(session.id, "failed");
  assert.equal(legacy.applied, true);
  assert.equal((await repo.getSession(session.id)).status, "failed");

  await repo.deleteAgent(ws, agent.id); // FK cascade removes the session + events
});

test("pending launches: park, hide from zombie sweep, take atomically", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-ws-${Date.now()}`)).id;
  const agent = await repo.createAgent(ws, `t-${Date.now()}`, { routing: "m-deploying", tools: [] });
  const session = await repo.createSession(ws, agent.id, "hi");

  await repo.addPendingLaunch(session.id, "m-deploying", { id: session.id, prompt: "hi" });
  assert.deepEqual(await repo.listPendingLaunchModels(), ["m-deploying"]);

  // A parked session must be invisible to the zombie reconciler no matter how
  // old it gets — it deliberately has no Job while the model downloads.
  const stuck = await repo.listStuckSessions();
  assert.ok(!stuck.some((s: any) => s.id === session.id), "waiting session must not be swept as zombie");

  // Upsert: re-parking the same session replaces, not duplicates.
  await repo.addPendingLaunch(session.id, "m-deploying", { id: session.id, prompt: "hi2" });
  const taken = await repo.takePendingLaunches("m-deploying");
  assert.equal(taken.length, 1);
  assert.equal((taken[0].payload as any).prompt, "hi2");
  // Take is destructive: second take finds nothing, session is sweepable again.
  assert.equal((await repo.takePendingLaunches("m-deploying")).length, 0);
  assert.ok((await repo.listStuckSessions()).some((s: any) => s.id === session.id));

  // takePendingLaunch (single, for interrupt) removes the row.
  await repo.addPendingLaunch(session.id, "m-deploying", { id: session.id });
  assert.ok(await repo.takePendingLaunch(session.id));
  assert.equal(await repo.takePendingLaunch(session.id), null);

  await repo.deleteAgent(ws, agent.id); // cascade: session + pending row
});

test("typed vault credentials roundtrip + env MCP query", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-ws-mcp-${Date.now()}`)).id;
  const vault = await repo.createVault(ws, `t-vlt-${Date.now()}`);

  await repo.addVaultCredential(vault.id, "context7", "bearer_token", "https://mcp.context7.com/mcp", "Context7");
  const cred = await repo.getVaultCredential(vault.id, "context7");
  assert.equal(cred.type, "bearer_token");
  assert.equal(cred.mcp_server_url, "https://mcp.context7.com/mcp");
  // rotate: same name+type+server upserts (ON CONFLICT DO UPDATE), not insert-ignore
  await repo.addVaultCredential(vault.id, "context7", "bearer_token", "https://mcp.context7.com/mcp", "Context7-rotated");
  assert.equal((await repo.getVaultCredential(vault.id, "context7")).mcp_server_name, "Context7-rotated");
  // legacy call shape still works and defaults to environment_variable
  await repo.addVaultCredential(vault.id, "MY_KEY");
  assert.equal((await repo.getVaultCredential(vault.id, "MY_KEY")).type, "environment_variable");
  assert.equal((await repo.listVaultCredentials(vault.id)).length, 2);

  const env = await repo.createEnvironment(ws, `t-env-${Date.now()}`, false, [], {}, true);
  assert.equal(env.allowMcpServers, true);
  const agent = await repo.createAgent(ws, `t-mcp-${Date.now()}`, {
    routing: "qwen05b-dp", environmentId: env.id,
    mcpServers: { context7: { type: "http", url: "https://mcp.context7.com/mcp" } },
  });
  const servers = await repo.mcpServersForEnvironment(env.id);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].context7.url, "https://mcp.context7.com/mcp");
  // a NEW version pointing elsewhere removes the agent from this env's set
  const env2 = await repo.createEnvironment(ws, `t-env2-${Date.now()}`);
  await repo.newAgentVersion(ws, agent.id, { routing: "qwen05b-dp", environmentId: env2.id });
  assert.equal((await repo.mcpServersForEnvironment(env.id)).length, 0);

  // workspaces.id has no ON DELETE CASCADE from agents/vaults/environments
  // (a plain REFERENCES, per the pre-consolidation 010_workspaces.sql history)
  // — clean up explicitly rather than relying on a workspace delete to cascade.
  await repo.deleteAgent(ws, agent.id);
  await repo.deleteEnvironment(ws, env.id);
  await repo.deleteEnvironment(ws, env2.id);
  await repo.deleteVault(ws, vault.id);
  await pool.query("DELETE FROM workspaces WHERE id = $1", [ws]);
});

test("model routing + wake requests roundtrip", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const m1 = `t-model-${Date.now()}-a`;
  const m2 = `t-model-${Date.now()}-b`;

  // setModelRouting upsert flips state
  await repo.setModelRouting(m1, "idle");
  let rows = (await pool.query("SELECT state FROM model_routing WHERE model = $1", [m1])).rows;
  assert.equal(rows[0].state, "idle");
  await repo.setModelRouting(m1, "waking");
  rows = (await pool.query("SELECT state FROM model_routing WHERE model = $1", [m1])).rows;
  assert.equal(rows[0].state, "waking");

  await repo.setModelRouting(m2, "ready");

  // takeWakeRequests drains
  await pool.query("INSERT INTO wake_requests (model) VALUES ($1), ($2)", [m1, m2]);
  const taken = await repo.takeWakeRequests();
  assert.ok(taken.includes(m1));
  assert.ok(taken.includes(m2));
  assert.equal((await pool.query("SELECT * FROM wake_requests")).rowCount, 0);

  // clearWakeRequest removes a single row
  await pool.query("INSERT INTO wake_requests (model) VALUES ($1)", [m1]);
  await repo.clearWakeRequest(m1);
  assert.equal((await pool.query("SELECT * FROM wake_requests WHERE model = $1", [m1])).rowCount, 0);

  // pruneModelRouting keeps only listed models
  await repo.pruneModelRouting([m2]);
  assert.equal((await pool.query("SELECT * FROM model_routing WHERE model = $1", [m1])).rowCount, 0);
  assert.equal((await pool.query("SELECT * FROM model_routing WHERE model = $1", [m2])).rowCount, 1);

  // deleteModelRouting removes both rows
  await pool.query("INSERT INTO wake_requests (model) VALUES ($1)", [m2]);
  await repo.deleteModelRouting(m2);
  assert.equal((await pool.query("SELECT * FROM model_routing WHERE model = $1", [m2])).rowCount, 0);
  assert.equal((await pool.query("SELECT * FROM wake_requests WHERE model = $1", [m2])).rowCount, 0);
});

test.after(async () => { await pool.end(); });
