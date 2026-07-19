import { test } from "node:test";
import assert from "node:assert/strict";
import { routingStateFor, sweepModelRouting } from "../src/routing-state.ts";

test("routingStateFor projects (phase, warmed)", () => {
  assert.equal(routingStateFor("Ready", true), "ready");
  assert.equal(routingStateFor("Ready", false), "waking"); // Ready-but-unwarmed = not yet routable
  assert.equal(routingStateFor("Idle", false), "idle");
  assert.equal(routingStateFor("Deploying", false), "waking");
  assert.equal(routingStateFor("Failed", false), "waking"); // held requests 503 at cutoff
});

test("sweepModelRouting projects every deployment, prunes strays, heals lost wakes", async () => {
  const calls: any[] = [];
  await sweepModelRouting({
    listDeployments: async () => [
      { name: "warm", phase: "Ready" }, { name: "asleep", phase: "Idle" }, { name: "coming", phase: "Deploying" },
    ],
    isWarmed: (n) => n === "warm",
    setModelRouting: async (m, s) => { calls.push(["set", m, s]); },
    pruneModelRouting: async (keep) => { calls.push(["prune", keep]); },
    takeWakeRequests: async () => ["asleep", "warm", "deleted-model"],
    wake: async (m) => { calls.push(["wake", m]); },
  });
  assert.deepEqual(calls.filter(c => c[0] === "set"),
    [["set", "warm", "ready"], ["set", "asleep", "idle"], ["set", "coming", "waking"]]);
  assert.deepEqual(calls.find(c => c[0] === "prune"), ["prune", ["warm", "asleep", "coming"]]);
  // only the still-Idle model re-wakes; warm and vanished requests just drain
  assert.deepEqual(calls.filter(c => c[0] === "wake"), [["wake", "asleep"]]);
});

test("sweepModelRouting heal loop survives a wake rejection and still wakes the rest", async () => {
  const calls: any[] = [];
  await sweepModelRouting({
    listDeployments: async () => [
      { name: "first", phase: "Idle" }, { name: "second", phase: "Idle" },
    ],
    isWarmed: () => false,
    setModelRouting: async (m, s) => { calls.push(["set", m, s]); },
    pruneModelRouting: async () => {},
    takeWakeRequests: async () => ["first", "second"],
    wake: async (m) => {
      calls.push(["wake", m]);
      if (m === "first") throw new Error("wake boom");
    },
  });
  assert.deepEqual(calls.filter(c => c[0] === "wake"), [["wake", "first"], ["wake", "second"]]);
});
