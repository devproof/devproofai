// Pure accrual math (spec 2026-07-14 §4): rate normalization, replica
// multiplication, gap cap, toggle gating, pod-start anchoring, and the
// per-minute billing quantum (user decision 2026-07-14): the price unit only
// sets the rate; ticks bill whole minutes (remainder carries via tsMs) and a
// terminal settle rounds the started minute UP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ratePerSecond, computeAccruals, GAP_CAP_SEC, DEFAULT_COST_SETTINGS } from "../src/costs.ts";

const ON = { ...DEFAULT_COST_SETTINGS, enabled: true, trackPoolCosts: true, trackEnvCosts: true,
  billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: true, billSessionTime: true, billDeploymentTime: true } };
const NOW = 1_800_000_000_000;

test("ratePerSecond normalizes all units; garbage = 0", () => {
  assert.equal(ratePerSecond({ amount: 3600, per: "hour" }), 1);
  assert.equal(ratePerSecond({ amount: 60, per: "minute" }), 1);
  assert.equal(ratePerSecond({ amount: 86400, per: "day" }), 1);
  assert.equal(ratePerSecond({ amount: 2592000, per: "month" }), 1);
  assert.equal(ratePerSecond({ amount: 31536000, per: "year" }), 1);
  assert.equal(ratePerSecond(null), 0);
  assert.equal(ratePerSecond({ amount: -5, per: "hour" }), 0);
  assert.equal(ratePerSecond({ amount: 5, per: "fortnight" }), 0);
});

test("deployment accrual: replicas x rate x whole minutes; tsMs = span start + billed seconds", () => {
  const prices = [
    { kind: "pool", ref: "cpu-default", prices: { real: { podTime: { amount: 3600, per: "hour" } } } },
    { kind: "deployment", ref: "qwen", prices: { billing: { podTime: { amount: 7200, per: "hour" } } } },
  ];
  const wm = new Map([["dep:qwen", NOW - 60_000]]);
  const { entries } = computeAccruals(NOW, ON, prices,
    [{ name: "qwen", pool: "cpu-default", readyReplicas: 2 }], [], wm);
  const pool = entries.find((e) => e.kind === "pool_pod")!;
  assert.equal(pool.seconds, 60); assert.equal(pool.replicas, 2);
  assert.equal(pool.realCost, 120);          // 1/s x 2 replicas x 60s
  assert.equal(pool.tsMs, NOW);              // watermark + billed seconds
  assert.equal(pool.deployment, "qwen"); assert.equal(pool.pool, "cpu-default");
  const bill = entries.find((e) => e.kind === "deployment_time")!;
  assert.equal(bill.billedCost, 240);        // 2/s x 2 x 60
});

test("tick floors to whole minutes; the remainder carries via tsMs", () => {
  const prices = [{ kind: "pool", ref: "p", prices: { real: { podTime: { amount: 3600, per: "hour" } } } }];
  const wm = new Map([["dep:d", NOW - 90_000]]); // 90s elapsed
  const { entries } = computeAccruals(NOW, ON, prices,
    [{ name: "d", pool: "p", readyReplicas: 1 }], [], wm);
  const pool = entries.find((e) => e.kind === "pool_pod")!;
  assert.equal(pool.seconds, 60);                    // floor(90/60) minutes
  assert.equal(pool.tsMs, NOW - 30_000);             // 30s remainder stays unbilled, carried
});

test("sub-minute tick span bills nothing (no entry, remainder carries)", () => {
  const prices = [{ kind: "pool", ref: "p", prices: { real: { podTime: { amount: 3600, per: "hour" } } } }];
  const wm = new Map([["dep:d", NOW - 45_000]]);
  const { entries } = computeAccruals(NOW, ON, prices,
    [{ name: "d", pool: "p", readyReplicas: 1 }], [], wm);
  assert.equal(entries.length, 0);
});

test("gap cap: watermark older than GAP_CAP_SEC accrues only the cap", () => {
  const prices = [{ kind: "pool", ref: "p", prices: { real: { podTime: { amount: 3600, per: "hour" } } } }];
  const wm = new Map([["dep:d", NOW - 3_600_000]]); // 1h gap
  const { entries } = computeAccruals(NOW, ON, prices,
    [{ name: "d", pool: "p", readyReplicas: 1 }], [], wm);
  assert.equal(entries[0].seconds, GAP_CAP_SEC);     // 120s = exactly 2 minutes
});

test("first sighting: deployment w/o watermark bootstraps zero-cost entries; sub-minute turn waits for settle", () => {
  const prices = [
    { kind: "pool", ref: "p", prices: { real: { podTime: { amount: 3600, per: "hour" } } } },
    { kind: "deployment", ref: "d", prices: { billing: { podTime: { amount: 7200, per: "hour" } } } },
    { kind: "environment", ref: "env_1", prices: {
      real: { podTime: { amount: 3600, per: "hour" } },
      billing: { sessionTime: { amount: 60, per: "minute" } } } },
  ];
  const turns = [{ sessionId: "sesn_a", workspaceId: "wrkspc_default", environmentId: "env_1", startedAtMs: NOW - 30_000 }];
  const { entries } = computeAccruals(NOW, ON, prices,
    [{ name: "d", pool: "p", readyReplicas: 2 }], turns, new Map());
  // No watermark + no anchor: bootstrap plants a zero-cost row per applicable
  // kind instead of skipping, so the ledger has a watermark for the next tick.
  const pool = entries.find((e) => e.kind === "pool_pod")!;
  assert.equal(pool.seconds, 0); assert.equal(pool.realCost, 0); assert.equal(pool.billedCost, null);
  assert.equal(pool.replicas, 2); assert.equal(pool.deployment, "d"); assert.equal(pool.tsMs, NOW);
  const dep = entries.find((e) => e.kind === "deployment_time")!;
  assert.equal(dep.seconds, 0); assert.equal(dep.billedCost, 0); assert.equal(dep.realCost, null);
  // A 30s-old turn bills nothing at TICK (floor) — the settle owns the tail.
  assert.equal(entries.some((e) => e.kind === "env_pod" || e.kind === "session_time"), false);

  // Settle: the started minute is billed (rounds UP to one full minute).
  const settled = computeAccruals(NOW, ON, prices, [], turns, new Map(), "settle");
  const st = settled.entries.find((e) => e.kind === "session_time")!;
  assert.equal(st.seconds, 60); assert.equal(st.billedCost, 60);
  assert.equal(st.tsMs, NOW - 30_000 + 60_000);      // paid-through marker, 30s past "now"
  assert.equal(settled.sessionBilled.get("sesn_a"), 60);
  const env = settled.entries.find((e) => e.kind === "env_pod")!;
  assert.equal(env.seconds, 60); assert.equal(env.realCost, 60);
});

test("settle on an exact minute boundary does not round up an extra minute", () => {
  const prices = [{ kind: "environment", ref: "e", prices: { billing: { sessionTime: { amount: 3600, per: "hour" } } } }];
  const turns = [{ sessionId: "s", workspaceId: "w", environmentId: "e", startedAtMs: NOW - 120_000 }];
  const { entries } = computeAccruals(NOW, ON, prices, [], turns, new Map(), "settle");
  assert.equal(entries.find((e) => e.kind === "session_time")!.seconds, 120);
});

test("two-tick bootstrap: tick 1 plants a zero-cost watermark, tick 2 accrues whole minutes", () => {
  const prices = [{ kind: "pool", ref: "p", prices: { real: { podTime: { amount: 3600, per: "hour" } } } }];
  const deps = [{ name: "d", pool: "p", readyReplicas: 1 }];

  const tick1 = computeAccruals(NOW, ON, prices, deps, [], new Map());
  const pool1 = tick1.entries.find((e) => e.kind === "pool_pod")!;
  assert.equal(pool1.seconds, 0); assert.equal(pool1.realCost, 0);

  // Rebuild the watermark map the way the real sampler does: MAX(cost_entries.ts)
  // for the deployment, which is now the bootstrap row's timestamp (tick 1's `now`).
  const wm2 = new Map([["dep:d", NOW]]);
  const tick2 = computeAccruals(NOW + 60_000, ON, prices, deps, [], wm2);
  const pool2 = tick2.entries.find((e) => e.kind === "pool_pod")!;
  assert.equal(pool2.seconds, 60);
  assert.equal(pool2.realCost, 60); // 1/s x 1 replica x 60s
});

test("bootstrap only fires when a price actually applies; readyReplicas 0 accrues nothing", () => {
  const deps = [
    { name: "unpriced", pool: "p", readyReplicas: 1 },
    { name: "zero-replica", pool: "p", readyReplicas: 0 },
  ];
  const { entries } = computeAccruals(NOW, ON, [], deps, [], new Map());
  assert.equal(entries.length, 0);
});

test("toggles gate each ledger independently; real and billing are siblings", () => {
  const prices = [
    { kind: "pool", ref: "p", prices: { real: { podTime: { amount: 1, per: "hour" } } } },
    { kind: "deployment", ref: "d", prices: { billing: { podTime: { amount: 1, per: "hour" } } } },
    { kind: "environment", ref: "e", prices: {
      real: { podTime: { amount: 1, per: "hour" } },
      billing: { sessionTime: { amount: 1, per: "hour" } } } },
  ];
  const deps = [{ name: "d", pool: "p", readyReplicas: 1 }];
  const turns = [{ sessionId: "s", workspaceId: "w", environmentId: "e", startedAtMs: NOW - 60_000 }];
  const wm = new Map([["dep:d", NOW - 60_000], ["sesn:s", NOW - 60_000]]);
  const kinds = (s: any) => computeAccruals(NOW, s, prices, deps, turns, wm).entries.map((e) => e.kind).sort();

  // Both ledgers on: all four kinds accrue.
  assert.deepEqual(kinds(ON), ["deployment_time", "env_pod", "pool_pod", "session_time"]);
  // Billing only (cost tracking OFF) — the 2026-07-15 independence change:
  // `enabled` no longer masters the billing ledger.
  assert.deepEqual(kinds({ ...ON, enabled: false }), ["deployment_time", "session_time"]);
  // Real only (billing off).
  assert.deepEqual(kinds({ ...ON, billing: { ...ON.billing, enabled: false } }), ["env_pod", "pool_pod"]);
  // Both off: nothing accrues.
  assert.deepEqual(kinds({ ...ON, enabled: false, billing: { ...ON.billing, enabled: false } }), []);
  // Sub-flags still gate their own kind within an enabled ledger.
  assert.equal(kinds({ ...ON, trackPoolCosts: false }).includes("pool_pod"), false);
  assert.equal(kinds({ ...ON, billing: { ...ON.billing, billSessionTime: false } }).includes("session_time"), false);
});

test("span start prefers the anchor over a stale watermark (resumed turn after idle gap)", () => {
  const prices = [{ kind: "environment", ref: "e", prices: { billing: { sessionTime: { amount: 3600, per: "hour" } } } }];
  const turns = [{ sessionId: "s", workspaceId: "w", environmentId: "e", startedAtMs: NOW - 30_000 }]; // pod started 30s ago
  const wm = new Map([["sesn:s", NOW - 7_200_000]]); // watermark 2h old (idle gap since last turn)
  const { entries } = computeAccruals(NOW, ON, prices, [], turns, wm, "settle");
  const st = entries.find((e) => e.kind === "session_time")!;
  assert.equal(st.seconds, 60); // one started minute from the ANCHOR — not the 120s gap cap off the stale watermark
});

test("span start prefers the watermark over an older anchor (mid-turn tick)", () => {
  const prices = [{ kind: "environment", ref: "e", prices: { billing: { sessionTime: { amount: 3600, per: "hour" } } } }];
  const turns = [{ sessionId: "s", workspaceId: "w", environmentId: "e", startedAtMs: NOW - 90_000 }]; // pod started 90s ago
  const wm = new Map([["sesn:s", NOW - 60_000]]); // watermark from last tick, 60s ago
  const { entries } = computeAccruals(NOW, ON, prices, [], turns, wm);
  const st = entries.find((e) => e.kind === "session_time")!;
  assert.equal(st.seconds, 60); // watermark wins — proves max() picks correctly both ways
});

test("no price object = no entry (nothing to multiply)", () => {
  const { entries } = computeAccruals(NOW, ON, [],
    [{ name: "d", pool: "p", readyReplicas: 3 }],
    [{ sessionId: "s", workspaceId: "w", environmentId: "e", startedAtMs: NOW - 65_000 }],
    new Map([["dep:d", NOW - 65_000], ["sesn:s", NOW - 65_000]]));
  assert.equal(entries.length, 0);
});
