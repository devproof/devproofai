// Sampler glue (spec §4): observation mapping, active-turn filter, settle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { costSamplerTick, settleSession, type SamplerDeps } from "../src/cost-sampler.ts";
import { DEFAULT_COST_SETTINGS, type CostEntryDraft } from "../src/costs.ts";

const ON = { ...DEFAULT_COST_SETTINGS, enabled: true, trackPoolCosts: true, trackEnvCosts: true,
  billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: true, billSessionTime: true } };

function fakeDeps(overrides: {
  orchestrator?: SamplerDeps["orchestrator"]; watermarks?: Map<string, number>;
  settings?: typeof ON;
} = {}) {
  const inserted: CostEntryDraft[] = [];
  const billed: [string, number][] = [];
  const deps: SamplerDeps = {
    repo: {
      getCostSettings: async () => overrides.settings ?? ON,
      listResourcePrices: async () => [
        { kind: "pool", ref: "p", prices: { real: { podTime: { amount: 3600, per: "hour" } } } },
        { kind: "environment", ref: "env_1", prices: {
          real: { podTime: { amount: 3600, per: "hour" } },
          billing: { sessionTime: { amount: 3600, per: "hour" } } } },
      ],
      listRunningSessionsForBilling: async () => [
        { id: "sesn_a", workspace_id: "w", turns: 2, environment_id: "env_1" }],
      getSessionForBilling: async (id: string) =>
        id === "sesn_a" ? { id, workspace_id: "w", turns: 2, environment_id: "env_1" } : null,
      // 61s, not 60: the ms between the tick's `now` capture and this lazy
      // Date.now() would push an exactly-60s span under the minute floor.
      costWatermarks: async () => overrides.watermarks ??
        new Map([["dep:d", Date.now() - 61_000], ["sesn:sesn_a", Date.now() - 61_000]]),
      insertCostEntries: async (e) => { inserted.push(...e); },
      addSessionBilledCost: async (id, amount) => { billed.push([id, amount]); },
    },
    kube: { list: async () => [
      { metadata: { name: "d" }, spec: { poolRef: "p" }, status: { readyReplicas: 2 } },
      { metadata: { name: "zero" }, spec: { poolRef: "p" }, status: { readyReplicas: 0 } },
    ] },
    orchestrator: overrides.orchestrator ?? {
      sessionJobInfo: async () => ({ state: "active", startedAt: new Date(Date.now() - 90_000) }) },
  };
  return { deps, inserted, billed };
}

test("tick: replicas>0 accrue; zero-replica deployments skipped; active turn accrues both kinds", async () => {
  const { deps, inserted, billed } = fakeDeps();
  await costSamplerTick(deps);
  assert.equal(inserted.some((e) => e.kind === "pool_pod" && e.deployment === "d" && e.replicas === 2), true);
  assert.equal(inserted.some((e) => e.deployment === "zero"), false);
  assert.equal(inserted.some((e) => e.kind === "env_pod" && e.sessionId === "sesn_a"), true);
  assert.equal(billed.length, 1);
  assert.equal(billed[0][0], "sesn_a");
  assert.ok(Math.abs(billed[0][1] - 60) < 1.5); // ~60s at 1/s (watermark 60s ago)
});

test("tick: finished/missing turn pods accrue nothing (settle path owns the tail)", async () => {
  const { deps, inserted } = fakeDeps({
    orchestrator: { sessionJobInfo: async () => ({ state: "finished", startedAt: null }) } });
  await costSamplerTick(deps);
  assert.equal(inserted.some((e) => e.sessionId === "sesn_a"), false);
});

test("settle: accrues watermark→now for a known session; unknown session no-ops", async () => {
  const { deps, inserted } = fakeDeps();
  await settleSession(deps, "sesn_a");
  assert.equal(inserted.some((e) => e.kind === "session_time" && e.sessionId === "sesn_a"), true);
  const before = inserted.length;
  await settleSession(deps, "sesn_nope");
  assert.equal(inserted.length, before);
});

test("settle: short first turn (no session watermark) bills one started minute off the anchor, not 0", async () => {
  const { deps, inserted } = fakeDeps({
    orchestrator: { sessionJobInfo: async () => ({ state: "finished", startedAt: new Date(Date.now() - 25_000) }) },
    watermarks: new Map(), // no watermark at all for sesn_a
  });
  await settleSession(deps, "sesn_a");
  const st = inserted.find((e) => e.kind === "session_time" && e.sessionId === "sesn_a")!;
  assert.ok(st, "expected a session_time entry");
  assert.equal(st.seconds, 60); // 25s runtime → 1 started minute (per-minute quantum, rounded up)
});

test("settle: resumed turn after idle gap bills against the anchor, not the stale watermark", async () => {
  const { deps, inserted } = fakeDeps({
    orchestrator: { sessionJobInfo: async () => ({ state: "finished", startedAt: new Date(Date.now() - 25_000) }) },
    watermarks: new Map([["sesn:sesn_a", Date.now() - 7_200_000]]), // 2h-old watermark
  });
  await settleSession(deps, "sesn_a");
  const st = inserted.find((e) => e.kind === "session_time" && e.sessionId === "sesn_a")!;
  assert.ok(st, "expected a session_time entry");
  assert.equal(st.seconds, 60); // 1 started minute off the ANCHOR — the stale watermark would give 120 (gap cap)
});

test("tick + settle racing on the same session accrue the span once, not twice", async () => {
  const inserted: CostEntryDraft[] = [];
  const billed: [string, number][] = [];
  let sesnWatermark = Date.now() - 61_000; // 61s: stays over the minute floor despite call-time drift

  // Barrier: tick and settle reach costWatermarks() at slightly different
  // microtask depths (tick does kube.list + listRunningSessionsForBilling +
  // sessionJobInfo first). Pair up two concurrent callers so they read the
  // SAME pre-insert watermark together, like two real concurrent DB queries
  // would; a lone caller (the serialized/fixed case, where only one accrue()
  // runs at a time) falls back after a short timeout instead of hanging.
  let waiters: Array<() => void> = [];
  function barrier(): Promise<void> {
    return new Promise((resolve) => {
      waiters.push(resolve);
      if (waiters.length >= 2) { waiters.forEach((r) => r()); waiters = []; }
      else setTimeout(() => { const i = waiters.indexOf(resolve); if (i >= 0) { waiters.splice(i, 1); resolve(); } }, 50);
    });
  }

  const deps: SamplerDeps = {
    repo: {
      getCostSettings: async () => ON,
      listResourcePrices: async () => [
        { kind: "environment", ref: "env_1", prices: {
          billing: { sessionTime: { amount: 3600, per: "hour" } } } },
      ],
      listRunningSessionsForBilling: async () => [
        { id: "sesn_a", workspace_id: "w", turns: 2, environment_id: "env_1" }],
      getSessionForBilling: async (id: string) =>
        id === "sesn_a" ? { id, workspace_id: "w", turns: 2, environment_id: "env_1" } : null,
      // Mirrors the real repo: costWatermarks reads MAX(ts) from cost_entries,
      // so once insertCostEntries "writes" a row the watermark advances to the
      // entry's explicit tsMs (span start + billed seconds — the carry marker).
      costWatermarks: async () => {
        await barrier();
        return new Map([["sesn:sesn_a", sesnWatermark]]);
      },
      insertCostEntries: async (e) => {
        inserted.push(...e);
        for (const x of e) if (x.tsMs) sesnWatermark = Math.max(sesnWatermark, x.tsMs);
      },
      addSessionBilledCost: async (id, amount) => { billed.push([id, amount]); },
    },
    kube: { list: async () => [] },
    orchestrator: {
      sessionJobInfo: async () => ({ state: "active", startedAt: new Date(Date.now() - 90_000) }) },
  };

  await Promise.all([costSamplerTick(deps), settleSession(deps, "sesn_a")]);

  const totalSec = inserted
    .filter((e) => e.kind === "session_time" && e.sessionId === "sesn_a")
    .reduce((sum, e) => sum + e.seconds, 0);
  // Per-minute quantum: serialized, the loser continues from the winner's
  // advanced tsMs marker — total 60s (loser's residual was 0ms, same-ms edge)
  // or 120s (any residual rounds up a started minute; or settle-first bills
  // 120 and the tick sees the paid-through marker). UNserialized, both bill
  // off the same stale watermark: 60 + 120 = 180s — the double-billing this
  // test guards against.
  assert.ok(totalSec === 60 || totalSec === 120, `expected 60 or 120s total accrued, got ${totalSec}`);
  const totalBilled = billed.filter(([id]) => id === "sesn_a").reduce((s, [, a]) => s + a, 0);
  assert.ok(Math.abs(totalBilled - totalSec) < 0.5); // rate is 1/s in this fixture
});

test("billing-only settings still tick: needsTime no longer short-circuits on costs.enabled", async () => {
  const { deps, inserted, billed } = fakeDeps({ settings: { ...ON, enabled: false } });
  await costSamplerTick(deps);
  assert.equal(inserted.some((e) => e.kind === "session_time" && e.sessionId === "sesn_a"), true,
    "billing ledger must accrue with cost tracking off");
  assert.equal(inserted.some((e) => e.kind === "env_pod" || e.kind === "pool_pod"), false,
    "real ledger stays off");
  assert.equal(billed.length, 1);
});

test("both ledgers off: the sampler accrues nothing", async () => {
  const { deps, inserted } = fakeDeps({ settings: { ...DEFAULT_COST_SETTINGS } });
  await costSamplerTick(deps);
  assert.equal(inserted.length, 0);
});
