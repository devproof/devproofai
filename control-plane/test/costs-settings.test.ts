// Settings singleton (spec 2026-07-14): defaults off, PUT round-trip, validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { DEFAULT_COST_SETTINGS, normalizeCostSettings, validateCostSettings } from "../src/costs.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

test("normalize: absent keys read as defaults; unknown currency falls back", () => {
  assert.deepEqual(normalizeCostSettings(undefined), DEFAULT_COST_SETTINGS);
  assert.equal(normalizeCostSettings({ currency: "XXX" }).currency, "EUR");
  assert.equal(normalizeCostSettings({ enabled: true, billing: { enabled: true } }).billing.enabled, true);
});

test("validate: type errors are named", () => {
  assert.equal(validateCostSettings({ enabled: true }), null);
  assert.match(validateCostSettings({ enabled: "yes" })!, /enabled/);
  assert.match(validateCostSettings({ currency: "DOGE" })!, /currency/);
  assert.match(validateCostSettings({ billing: { billSessionTime: 1 } })!, /billSessionTime/);
  assert.match(validateCostSettings([])!, /object/);
});

test("settings round-trip via repo", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const before = await repo.getCostSettings(); // whatever the dev DB holds
  try {
    const next = { ...DEFAULT_COST_SETTINGS, enabled: true, currency: "USD" as const,
      billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: true, billLocalTokens: true } };
    await repo.putCostSettings(next);
    assert.deepEqual(await repo.getCostSettings(), next);
  } finally {
    await repo.putCostSettings(before); // restore — the dev DB is shared
  }
});
