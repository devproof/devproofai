import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForPostgres } from "../src/db.ts";

// Stub pool: fails with the given codes in order, then succeeds forever.
const stubPool = (codes: string[]) => {
  let calls = 0;
  return {
    calls: () => calls,
    query: async () => {
      calls++;
      const code = codes.shift();
      if (code) throw Object.assign(new Error(`stub ${code}`), { code });
      return { rows: [] };
    },
  };
};
const instant = { delayMs: 1, sleep: async () => {} };

test("retries ECONNREFUSED until postgres answers", async () => {
  const pool = stubPool(["ECONNREFUSED", "ECONNREFUSED", "ECONNREFUSED"]);
  await waitForPostgres(pool, { budgetMs: 10_000, ...instant });
  assert.equal(pool.calls(), 4, "three failures + one success");
});

test("57P03 (starting up) is retryable", async () => {
  const pool = stubPool(["57P03", "57P03"]);
  await waitForPostgres(pool, { budgetMs: 10_000, ...instant });
  assert.equal(pool.calls(), 3);
});

test("budget exhaustion rethrows the last error", async () => {
  const pool = stubPool(Array(1000).fill("ECONNREFUSED"));
  let t = 0;
  await assert.rejects(
    () => waitForPostgres(pool, { budgetMs: 25, delayMs: 10, sleep: async (ms) => { t += ms; }, now: () => t }),
    (err: any) => err.code === "ECONNREFUSED",
  );
  assert.equal(pool.calls(), 3, "attempts at t=0,10,20; the deadline blocks a 4th");
});

test("non-retryable code fails immediately (bad password)", async () => {
  const pool = stubPool(["28P01"]);
  await assert.rejects(
    () => waitForPostgres(pool, { budgetMs: 10_000, ...instant }),
    (err: any) => err.code === "28P01",
  );
  assert.equal(pool.calls(), 1, "no retry on misconfiguration");
});

test("zero budget fails on the first retryable error", async () => {
  const pool = stubPool(["ECONNREFUSED"]);
  await assert.rejects(
    () => waitForPostgres(pool, { budgetMs: 0, ...instant }),
    (err: any) => err.code === "ECONNREFUSED",
  );
  assert.equal(pool.calls(), 1);
});
