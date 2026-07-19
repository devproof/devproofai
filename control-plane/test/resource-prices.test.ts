// Price rows (spec 2026-07-14 §2): validation per kind, upsert/rotate, delete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { validatePrices } from "../src/costs.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

test("validatePrices enforces per-kind shape", () => {
  assert.equal(validatePrices("pool", { real: { podTime: { amount: 1.5, per: "hour" } } }), null);
  assert.match(validatePrices("pool", { billing: { podTime: { amount: 1, per: "hour" } } })!, /does not accept/);
  assert.match(validatePrices("pool", { real: { podTime: { amount: 1, per: "minute" } } })!, /per must be/); // pools stay hour+
  assert.equal(validatePrices("environment", { billing: { sessionTime: { amount: 2, per: "minute" } } }), null);
  assert.equal(validatePrices("environment", { real: { podTime: { amount: 0.1, per: "minute" } } }), null); // env real cost: minute allowed (consistency 2026-07-14)
  assert.match(validatePrices("deployment", { billing: { podTime: { amount: 1, per: "minute" } } })!, /per must be/); // deployment time billing stays hour+
  assert.equal(validatePrices("external", {
    real: { tokens: { in: { amount: 5, perTokens: 500_000 }, out: { amount: 15, perTokens: 1_000_000 } } },
    billing: { tokens: { out: { amount: 30, perTokens: 1_000_000 } } },   // one direction is enough
  }), null);
  assert.match(validatePrices("external", { real: { tokens: { in: { amount: -1, perTokens: 1_000_000 } } } })!, /in\.amount/);
  assert.match(validatePrices("external", { real: { tokens: { in: { amount: 1, perTokens: 0 } } } })!, /perTokens/);
  assert.match(validatePrices("external", { real: { tokens: {} } })!, /in and\/or out/);
  assert.equal(validatePrices("deployment", { billing: { podTime: { amount: 3, per: "day" },
    tokens: { in: { amount: 1, perTokens: 1_000_000 }, out: { amount: 2, perTokens: 1_000_000 } } } }), null);
  assert.match(validatePrices("nope", {})!, /kind/);
});

test("upsert, rotate, delete", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ref = `t-price-${Date.now()}`;
  try {
    await repo.putResourcePrice("pool", ref, { real: { podTime: { amount: 1, per: "hour" } } });
    assert.equal((await repo.getResourcePrice("pool", ref)).real.podTime.amount, 1);
    await repo.putResourcePrice("pool", ref, { real: { podTime: { amount: 2, per: "day" } } });
    assert.equal((await repo.getResourcePrice("pool", ref)).real.podTime.per, "day");
    assert.equal((await repo.listResourcePrices()).some((p) => p.ref === ref), true);
  } finally {
    await repo.deleteResourcePrice("pool", ref);
  }
  assert.equal(await repo.getResourcePrice("pool", ref), null);
});
