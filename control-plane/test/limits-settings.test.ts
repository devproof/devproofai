// Disk-cap limit setting: defaults, validation, repo round-trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { DEFAULT_LIMITS, normalizeLimits, validateLimits } from "../src/limits.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

test("normalize: absent/invalid maxWorkGb reads as the 2048 default", () => {
  assert.deepEqual(normalizeLimits(undefined), DEFAULT_LIMITS);
  assert.equal(normalizeLimits({}).maxWorkGb, 2048);
  assert.equal(normalizeLimits({ maxWorkGb: 0 }).maxWorkGb, 2048);
  assert.equal(normalizeLimits({ maxWorkGb: 1.5 }).maxWorkGb, 2048);
  assert.equal(normalizeLimits({ maxWorkGb: 500 }).maxWorkGb, 500);
});

test("validate: type errors are named, valid passes", () => {
  assert.equal(validateLimits(undefined), null);
  assert.equal(validateLimits({ maxWorkGb: 500 }), null);
  assert.match(validateLimits({ maxWorkGb: 0 })!, /maxWorkGb/);
  assert.match(validateLimits({ maxWorkGb: 1.5 })!, /maxWorkGb/);
  assert.match(validateLimits([])!, /object/);
});

test("limits round-trip via repo", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const before = await repo.getLimits();
  try {
    await repo.putLimits({ maxWorkGb: 777 });
    assert.deepEqual(await repo.getLimits(), { maxWorkGb: 777 });
  } finally {
    await repo.putLimits(before); // restore — the dev DB is shared
  }
});
