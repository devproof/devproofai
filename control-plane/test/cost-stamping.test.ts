// Trigger 031: costs stamped at insert time per settings+prices; billed cost
// accumulates into sessions.billed_cost. Live dev Postgres; self-skip offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { DEFAULT_COST_SETTINGS } from "../src/costs.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

const insertUsage = (ws: string, model: string, tin: number, tout: number, sesn?: string) =>
  pool.query(
    `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, source, session_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING real_cost, billed_cost`,
    [ws, model, tin, tout, sesn ? "session" : "api", sesn ?? null]);

test("stamping honors settings + prices; NULL when off; 0 tracked-but-free", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const before = await repo.getCostSettings();
  const ws = (await repo.createWorkspace(`t-cost-${Date.now()}`)).id;
  const ext = await repo.createExternalDeployment({
    name: `t-cost-ext-${Date.now()}`, provider: "custom", baseUrl: "http://x/v1", modelId: "m", hasKey: false,
    contextTokens: 128000 });
  const localName = `t-cost-local-${Date.now()}`;
  try {
    // 1. Master off → NULL costs even with prices present.
    // Token prices: amount per configurable token count, per direction (032).
    // in: 5 per 500k (≡ 10/1M), out: 15 per 1M — distinct denominators on purpose.
    await repo.putResourcePrice("external", ext.id, {
      real: { tokens: { in: { amount: 5, perTokens: 500_000 }, out: { amount: 15, perTokens: 1_000_000 } } },
      billing: { tokens: { in: { amount: 10, perTokens: 1_000_000 }, out: { amount: 30, perTokens: 1_000_000 } } } });
    await repo.putCostSettings({ ...DEFAULT_COST_SETTINGS });
    let r = (await insertUsage(ws, ext.name, 1_000_000, 0)).rows[0];
    assert.equal(r.real_cost, null); assert.equal(r.billed_cost, null);

    // 2. Tracking + billing on → both stamped; the 500k denominator doubles the in-rate.
    await repo.putCostSettings({ ...DEFAULT_COST_SETTINGS, enabled: true, trackExternalCosts: true,
      billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: true, billExternalTokens: true } });
    r = (await insertUsage(ws, ext.name, 1_000_000, 2_000_000)).rows[0];
    assert.equal(Number(r.real_cost), 10 + 2 * 15);   // 1M in at 5/500k = 10
    assert.equal(Number(r.billed_cost), 10 + 2 * 30);

    // 3. Local model: real stays NULL (pool time is its real cost); billed via
    // billLocalTokens; a missing direction costs nothing (out omitted → in only).
    await repo.putResourcePrice("deployment", localName, {
      billing: { tokens: { in: { amount: 1, perTokens: 1_000_000 } } } });
    await repo.putCostSettings({ ...DEFAULT_COST_SETTINGS, enabled: true,
      billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: true, billLocalTokens: true } });
    r = (await insertUsage(ws, localName, 500_000, 500_000)).rows[0];
    assert.equal(r.real_cost, null);
    assert.equal(Number(r.billed_cost), 0.5);         // out direction unpriced → 0

    // 4. Tracked-but-free: price 0 stamps 0, not NULL.
    await repo.putResourcePrice("deployment", localName, {
      billing: { tokens: { in: { amount: 0, perTokens: 1_000_000 }, out: { amount: 0, perTokens: 1_000_000 } } } });
    r = (await insertUsage(ws, localName, 9, 9)).rows[0];
    assert.equal(Number(r.billed_cost), 0);

    // 5. Session accumulation: billed_cost rides the 027/031 accumulate.
    await repo.putResourcePrice("deployment", localName, {
      billing: { tokens: { in: { amount: 4, perTokens: 1_000_000 }, out: { amount: 4, perTokens: 1_000_000 } } } });
    const agent = await repo.createAgent(ws, `t-cost-${Date.now()}`, { routing: localName, tools: [] });
    const session = await repo.createSession(ws, agent.id, "hi");
    await insertUsage(ws, localName, 250_000, 250_000, session.id);
    const s = await repo.getSession(session.id);
    assert.equal(Number(s.billed_cost), 2);
  } finally {
    await repo.putCostSettings(before);
    await repo.deleteResourcePrice("external", ext.id);
    await repo.deleteResourcePrice("deployment", localName);
    await repo.deleteExternalDeployment(ext.id);
    await pool.query("DELETE FROM gateway_usage WHERE workspace_id = $1", [ws]);
  }
});

test("031 trigger installed exactly once by the baseline", { skip: !available }, async () => {
  await migrate(pool);
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'gateway_usage_cost_stamp' AND NOT tgisinternal");
  assert.equal(rows[0].n, 1);
});

test("billing-only settings stamp billed_cost with cost tracking off (2026-07-15)", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const before = await repo.getCostSettings();
  const ws = (await repo.createWorkspace(`t-cost-indep-${Date.now()}`)).id;
  const ext = await repo.createExternalDeployment({
    name: `t-cost-indep-ext-${Date.now()}`, provider: "custom", baseUrl: "http://x/v1", modelId: "m", hasKey: false,
    contextTokens: 128000 });
  try {
    await repo.putResourcePrice("external", ext.id, {
      real: { tokens: { in: { amount: 10, perTokens: 1_000_000 }, out: { amount: 10, perTokens: 1_000_000 } } },
      billing: { tokens: { in: { amount: 20, perTokens: 1_000_000 }, out: { amount: 20, perTokens: 1_000_000 } } } });

    // Billing ON, cost tracking OFF → billed stamped, real NULL.
    await repo.putCostSettings({ ...DEFAULT_COST_SETTINGS, enabled: false,
      trackExternalCosts: true, // proves the real ledger obeys `enabled`, not the sub-flag
      billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: true, billExternalTokens: true } });
    let r = (await insertUsage(ws, ext.name, 1_000_000, 0)).rows[0];
    assert.equal(Number(r.billed_cost), 20);
    assert.equal(r.real_cost, null, "real ledger off ⇒ NULL");

    // Cost tracking ON, billing OFF → real stamped, billed NULL.
    await repo.putCostSettings({ ...DEFAULT_COST_SETTINGS, enabled: true, trackExternalCosts: true,
      billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: false, billExternalTokens: true } });
    r = (await insertUsage(ws, ext.name, 1_000_000, 0)).rows[0];
    assert.equal(Number(r.real_cost), 10);
    assert.equal(r.billed_cost, null, "billing ledger off ⇒ NULL");
  } finally {
    await repo.putCostSettings(before);
    await repo.deleteResourcePrice("external", ext.id);
    await repo.deleteExternalDeployment(ext.id);
    await pool.query("DELETE FROM gateway_usage WHERE workspace_id = $1", [ws]);
  }
});
