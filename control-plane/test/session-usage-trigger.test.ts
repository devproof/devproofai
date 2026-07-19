// Trigger (migration 027): gateway_usage inserts with session_id accumulate
// into sessions.tokens_in/out and NOTIFY devproof_session (live-update push).
// Integration tests against the live dev Postgres; self-skip when unreachable.
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

test("gateway_usage insert with session_id bumps session totals and notifies", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-trig-${Date.now()}`)).id;
  const agent = await repo.createAgent(ws, `t-trig-${Date.now()}`, { routing: "qwen05b-dp", tools: [] });
  const session = await repo.createSession(ws, agent.id, "hello");

  // LISTEN before the insert so the trigger's NOTIFY is observable.
  const listener = await pool.connect();
  const notified = new Promise<string>((resolve) => {
    listener.on("notification", (msg) => { if (msg.payload === session.id) resolve(msg.payload!); });
  });
  await listener.query("LISTEN devproof_session");

  try {
    await pool.query(
      `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, source, session_id)
       VALUES ($1, 'qwen05b-dp', 1000, 50, 'session', $2)`, [ws, session.id]);
    await pool.query(
      `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, source, session_id)
       VALUES ($1, 'qwen05b-dp', 2000, 70, 'session', $2)`, [ws, session.id]);

    const s = await repo.getSession(session.id);
    assert.equal(Number(s.tokens_in), 3000);
    assert.equal(Number(s.tokens_out), 120);
    // migration 038: the same accumulate stamps last_model = the metered model.
    assert.equal(s.last_model, "qwen05b-dp");
    const raced = await Promise.race([
      notified,
      new Promise<string>((r) => setTimeout(() => r("timeout"), 3000)),
    ]);
    assert.equal(raced, session.id);

    // Unattributed traffic (source='api', no session_id) is a no-op.
    await pool.query(
      `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, source)
       VALUES ($1, 'qwen05b-dp', 5, 5, 'api')`, [ws]);
    assert.equal(Number((await repo.getSession(session.id)).tokens_in), 3000);

    // A session_id that no longer exists must not error (no FK; deletes race inserts).
    await pool.query(
      `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, source, session_id)
       VALUES ($1, 'qwen05b-dp', 7, 7, 'session', 'sesn_gone')`, [ws]);
  } finally {
    listener.removeAllListeners("notification");
    await listener.query("UNLISTEN devproof_session").catch(() => {});
    listener.release();
    await pool.query("DELETE FROM gateway_usage WHERE workspace_id = $1", [ws]);
    await repo.deleteAgent(ws, agent.id); // FK cascade removes session + events
  }
});

test("migration 027 trigger installed exactly once by the baseline", { skip: !available }, async () => {
  await migrate(pool); // no-op: already applied at file load
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'session_usage_accumulate' AND NOT tgisinternal");
  assert.equal(rows[0].n, 1);
});
