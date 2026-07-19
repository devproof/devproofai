// Usage queries with costs (spec §6): gatewayUsage cost sums + allWorkspaces,
// sessionUsage basis + timeCosts, realtime cross-deployment stats. (The old
// /v1/usage/summary rollup was removed 2026-07-14 — the dashboard replicates
// the deployment-Stats realtime surface instead.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { DEFAULT_COST_SETTINGS } from "../src/costs.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

test("usage queries aggregate stamped costs and ledger entries", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const before = await repo.getCostSettings();
  const ws = (await repo.createWorkspace(`t-uc-${Date.now()}`)).id;
  const model = `t-uc-dep-${Date.now()}`;
  // The cross-deployment realtime view includes GLOBAL infra ledger rows
  // (pool_pod/deployment_time) by design, and the dev cluster's sampler
  // live-accrues them for other deployments — baseline-delta the no-model
  // totals with a tolerance for a tick landing mid-test.
  const rtBase = await repo.deploymentStats(null, {
    windowSec: 3600, bucketSec: 60, workspaceId: ws, costs: { includeTime: true } });
  try {
    await repo.putResourcePrice("deployment", model, {
      billing: { tokens: { in: { amount: 10, perTokens: 1_000_000 }, out: { amount: 10, perTokens: 1_000_000 } } } });
    await repo.putCostSettings({ ...DEFAULT_COST_SETTINGS, enabled: true,
      billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: true, billLocalTokens: true } });
    // API row (stamped by the 031 trigger) + session row + a ledger entry.
    const key = await repo.createApiKey(ws, `t-uc-${Date.now()}`);
    await pool.query(
      `INSERT INTO gateway_usage (workspace_id, api_key_id, model, tokens_in, tokens_out, source)
       VALUES ($1, $2, $3, 1000000, 0, 'api')`, [ws, key.id, model]);
    await pool.query(
      `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, source, session_id)
       VALUES ($1, $2, 0, 1000000, 'session', 'sesn_uc')`, [ws, model]);
    await repo.insertCostEntries([{ kind: "session_time", environmentId: "env_x", sessionId: "sesn_uc",
      workspaceId: ws, seconds: 60, realCost: null, billedCost: 2 }]);

    const gw = await repo.gatewayUsage(ws, { range: "1d" });
    assert.equal(gw.totals.billed_cost, 10);            // api row only
    assert.equal(gw.totals.requests, 1);
    const gwAll = await repo.gatewayUsage("wrkspc_other", { range: "1d", allWorkspaces: true });
    assert.ok(gwAll.totals.requests >= 1);              // scope dropped

    const su = await repo.sessionUsage(ws, { range: "1d" });
    assert.equal(su.totals.billed_cost, 10);            // session token row
    assert.equal(su.byDeployment[0].model, model);
    assert.equal(su.byDeployment[0].sessions, 1);
    assert.equal(su.timeCosts!.billed, 2);              // ledger entry
    assert.equal(su.timeCostBuckets!.length, 1);        // per-day infra-cost series
    assert.equal(su.timeCostBuckets![0].billed, 2);
    const suDep = await repo.sessionUsage(ws, { range: "1d", deployment: model });
    assert.equal(suDep.timeCosts, null);                // deployment filter ⇒ tokens only
    assert.equal(suDep.timeCostBuckets, null);

    // Realtime cross-deployment stats (dashboard): workspace-scoped tokens
    // + this workspace's env/session ledger entries; the fresh workspace
    // isolates the totals from live global accrual on other deployments'
    // token rows, and env/session ledger rows are workspace-scoped too.
    // (Global infra rows of OTHER deployments do leak into the no-model
    // ledger view only when unscoped — the workspace scope keeps this exact.)
    const rt = await repo.deploymentStats(null, {
      windowSec: 3600, bucketSec: 60, workspaceId: ws, costs: { includeTime: true } });
    assert.equal(rt.totals.requests - rtBase.totals.requests, 2);   // both token rows, workspace-scoped
    assert.ok(Math.abs((rt.totals.billed_cost - rtBase.totals.billed_cost) - 22) < 0.5,  // 10 api + 10 session + 2 ledger
      `expected ~22, got ${rt.totals.billed_cost - rtBase.totals.billed_cost}`);
    const rtDep = await repo.deploymentStats(model, {
      windowSec: 3600, bucketSec: 60, costs: { includeTime: true } });
    assert.equal(rtDep.totals.billed_cost, 20);         // per-deployment view: token rows only (no infra rows for it)
    const rtKey = await repo.deploymentStats(null, {
      windowSec: 3600, bucketSec: 60, workspaceId: ws, apiKeyId: key.id });
    assert.equal(rtKey.totals.billed_cost, 10);         // key filter ⇒ token costs only
  } finally {
    await repo.putCostSettings(before);
    await repo.deleteResourcePrice("deployment", model);
    await pool.query("DELETE FROM gateway_usage WHERE workspace_id = $1", [ws]);
    await pool.query("DELETE FROM cost_entries WHERE workspace_id = $1", [ws]);
  }
});
