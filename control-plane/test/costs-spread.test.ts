import { test } from "node:test";
import assert from "node:assert/strict";
import { spreadCostEntries } from "../src/costs.ts";

test("60s entry spreads evenly across six 10s buckets", () => {
  const t0 = 1000;
  const { real } = spreadCostEntries(
    [{ tsMs: (t0 + 60) * 1000, seconds: 60, realCost: 6, billedCost: 0 }], t0, 10, 6);
  for (const v of real) assert.ok(Math.abs(v - 1) < 1e-9);
});

test("entry partially outside the window allocates only the overlap", () => {
  const t0 = 1000;
  const { billed } = spreadCostEntries(
    [{ tsMs: (t0 + 30) * 1000, seconds: 60, realCost: 0, billedCost: 6 }], t0, 10, 6);
  // span [t0-30, t0+30): only [t0, t0+30) is inside → 3 of 6 allocated.
  assert.ok(Math.abs(billed.reduce((a, b) => a + b, 0) - 3) < 1e-9);
});
