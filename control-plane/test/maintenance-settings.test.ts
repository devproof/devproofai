// Settings maintenance block + POST /v1/maintenance/run route (Task 7, spec
// 2026-07-17). Route-level: real Repo/DB (skip-if-no-DB, bootstrap mirrors
// costs-settings.test.ts) driving the actual registerAgentRoutes app.
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { registerAgentRoutes, type Orchestrator } from "../src/agents-api.ts";
import { localFileStore } from "../src/filestore.ts";
import { DEFAULT_MAINTENANCE_CRON } from "../src/maintenance.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

async function build() {
  const repo = new Repo(pool);
  const root = mkdtempSync(join(tmpdir(), "gc-settings-test-"));
  const files = localFileStore(root);
  const app = Fastify();
  await registerAgentRoutes(app, repo, {} as unknown as Orchestrator, files);
  return { app, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("GET /v1/settings includes maintenance defaults", { skip: !available }, async () => {
  const { app, cleanup } = await build();
  try {
    // Deterministic base on the shared dev DB: a live CP or prior run may have
    // stored a maintenance key; these assertions expect the served defaults.
    await pool.query(`UPDATE app_settings SET data = data - 'maintenance' WHERE id = 'global'`);
    const res = await app.inject({ method: "GET", url: "/v1/settings" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.maintenance.cron, DEFAULT_MAINTENANCE_CRON);
    assert.equal(body.maintenance.orphans.enabled, true);
    assert.deepEqual(body.maintenance.billing, { enabled: false, keep: 365, unit: "days" });
    assert.deepEqual(body.maintenance.sessions.completed, { enabled: false, keep: 4, unit: "hours" });
    assert.ok(body.maintenanceLastRun === null || typeof body.maintenanceLastRun === "object");
    assert.equal(body.storage, undefined, "legacy storage block gone");
  } finally { cleanup(); }
});

test("PUT /v1/settings validates and persists maintenance (merge-when-provided)", { skip: !available }, async () => {
  const { app, repo, cleanup } = await build();
  let originalCosts: unknown;
  try {
    // Deterministic base: the "unsent sections keep defaults" assertions below
    // require the stored maintenance to start empty, but merge-when-provided
    // merges over whatever the shared dev-DB singleton holds — a live CP or a
    // prior run may have left a maintenance key. Clear it first.
    await pool.query(`UPDATE app_settings SET data = data - 'maintenance' WHERE id = 'global'`);
    const before = await app.inject({ method: "GET", url: "/v1/settings" });
    originalCosts = before.json().costs;
    const flippedCosts = { ...(originalCosts as Record<string, unknown>), enabled: !(originalCosts as { enabled: boolean }).enabled };

    // validate-before-persist: a bad maintenance block must reject BEFORE costs land
    const bad = await app.inject({
      method: "PUT", url: "/v1/settings",
      payload: { costs: flippedCosts, maintenance: { cron: "bad" } },
    });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /cron/);
    const afterBad = await app.inject({ method: "GET", url: "/v1/settings" });
    assert.deepEqual(afterBad.json().costs, originalCosts);

    const bad2 = await app.inject({
      method: "PUT", url: "/v1/settings",
      payload: { costs: {}, maintenance: { billing: { keep: 0 } } },
    });
    assert.equal(bad2.statusCode, 400);
    assert.match(bad2.json().error, /keep/);

    const ok = await app.inject({
      method: "PUT", url: "/v1/settings",
      payload: { costs: {}, maintenance: { cron: "*/30 * * * *", billing: { enabled: true, keep: 30, unit: "days" } } },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().maintenance.cron, "*/30 * * * *");
    assert.equal(ok.json().maintenance.billing.enabled, true);
    assert.equal(ok.json().maintenance.sessions.idle.keep, 7, "unsent sections keep defaults");

    // omitted block leaves stored settings untouched; empty object is a no-op
    const noBlock = await app.inject({ method: "PUT", url: "/v1/settings", payload: { costs: ok.json().costs } });
    assert.equal(noBlock.json().maintenance.cron, "*/30 * * * *");
    const emptyBlock = await app.inject({ method: "PUT", url: "/v1/settings", payload: { costs: ok.json().costs, maintenance: {} } });
    assert.equal(emptyBlock.json().maintenance.cron, "*/30 * * * *");
    assert.equal(emptyBlock.json().maintenance.billing.enabled, true);
  } finally {
    if (originalCosts) await repo.putCostSettings(originalCosts as Parameters<typeof repo.putCostSettings>[0]);
    await pool.query(`UPDATE app_settings SET data = data - 'maintenance' WHERE id = 'global'`); // restore shared dev DB
    cleanup();
  }
});

test("POST /v1/maintenance/run returns per-section summary; GET reflects maintenanceLastRun", { skip: !available }, async () => {
  const { app, cleanup } = await build();
  try {
    const res = await app.inject({ method: "POST", url: "/v1/maintenance/run" });
    assert.equal(res.statusCode, 200);
    const summary = res.json();
    assert.ok(!Number.isNaN(new Date(summary.at).getTime()));
    assert.equal(summary.sections.orphans.ran, true);        // default on
    assert.equal(Number.isInteger(summary.sections.orphans.rows), true);
    assert.equal(summary.sections.billing.ran, false);       // defaults off
    assert.equal(summary.sections.sessions.ran, false);
    assert.equal(summary.sections.files.ran, false);

    const got = await app.inject({ method: "GET", url: "/v1/settings" });
    assert.equal(got.json().maintenanceLastRun.at, summary.at);

    const gone = await app.inject({ method: "POST", url: "/v1/gc/run" });
    assert.equal(gone.statusCode, 404, "old GC endpoint removed");
  } finally { cleanup(); }
});
