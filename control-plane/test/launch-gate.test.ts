import { test } from "node:test";
import assert from "node:assert/strict";
import { gateDecision, releasePendingForModel, sweepPendingLaunches } from "../src/launch-gate.ts";

test("gateDecision launches for Ready, external, and unknown models", () => {
  assert.deepEqual(gateDecision("m", { kind: "local", phase: "Ready" }), { action: "launch" });
  assert.deepEqual(gateDecision("m", { kind: "external" }), { action: "launch" });
  assert.deepEqual(gateDecision("m", null), { action: "launch" });
});

test("gateDecision waits while a local deployment is not Ready", () => {
  // "Warming" = CRD Ready but the gateway route/warmup isn't confirmed yet
  // (main.ts maps that state): still a wait — releasing on CRD-Ready alone
  // re-races the exact gateway 400 this gate exists to prevent.
  for (const phase of ["Pending", "Downloading", "Copying", "Deploying", "Warming"]) {
    assert.deepEqual(gateDecision("m", { kind: "local", phase }), { action: "wait", phase });
  }
  // missing phase counts as Pending
  assert.deepEqual(gateDecision("m", { kind: "local", phase: "" }), { action: "wait", phase: "Pending" });
});

test("gateDecision fails fast on a Failed deployment", () => {
  const d = gateDecision("qwen3-medium", { kind: "local", phase: "Failed" });
  assert.equal(d.action, "fail");
  assert.match((d as any).error, /qwen3-medium.*Failed/);
});

function fakePending() {
  const rows: { session_id: string; model: string; payload: any }[] = [];
  const events: Record<string, any[]> = {};
  const statuses: Record<string, string> = {};
  const repo = {
    rows, events, statuses,
    async addPendingLaunch(id: string, model: string, payload: any) { rows.push({ session_id: id, model, payload }); },
    async takePendingLaunches(model: string) {
      const taken = rows.filter((r) => r.model === model);
      for (const t of taken) rows.splice(rows.indexOf(t), 1);
      return taken;
    },
    async listPendingLaunchModels() { return [...new Set(rows.map((r) => r.model))]; },
    async appendEvents(id: string, evts: any[]) { (events[id] ??= []).push(...evts); return evts.length; },
    async setSessionStatus(id: string, status: string) { statuses[id] = status; return { applied: true, replacedCheckpointFileId: null }; },
  };
  return repo;
}

test("releasePendingForModel launches every waiting session and clears the rows", async () => {
  const repo = fakePending();
  await repo.addPendingLaunch("sesn_a", "m1", { id: "sesn_a", prompt: "p" });
  await repo.addPendingLaunch("sesn_b", "m1", { id: "sesn_b", prompt: "q" });
  await repo.addPendingLaunch("sesn_c", "m2", { id: "sesn_c", prompt: "r" });
  const started: string[] = [];
  await releasePendingForModel(repo as any, { startSession: async (s: any) => { started.push(s.id); } } as any, "m1");
  assert.deepEqual(started.sort(), ["sesn_a", "sesn_b"]);
  assert.deepEqual(repo.rows.map((r) => r.session_id), ["sesn_c"]);
});

test("releasePendingForModel marks a session failed when the launch throws", async () => {
  const repo = fakePending();
  await repo.addPendingLaunch("sesn_bad", "m1", { id: "sesn_bad" });
  await releasePendingForModel(repo as any, { startSession: async () => { throw new Error("boom"); } } as any, "m1");
  assert.equal(repo.statuses["sesn_bad"], "failed");
  assert.match(repo.events["sesn_bad"][0].payload.error, /boom/);
});

test("sweepPendingLaunches releases Ready models, keeps waiting ones, fails Failed and deleted ones", async () => {
  const repo = fakePending();
  await repo.addPendingLaunch("sesn_ready", "m-ready", { id: "sesn_ready" });
  await repo.addPendingLaunch("sesn_wait", "m-slow", { id: "sesn_wait" });
  await repo.addPendingLaunch("sesn_fail", "m-broken", { id: "sesn_fail" });
  await repo.addPendingLaunch("sesn_gone", "m-deleted", { id: "sesn_gone" });
  const phases: Record<string, any> = {
    "m-ready": { kind: "local", phase: "Ready" },
    "m-slow": { kind: "local", phase: "Downloading" },
    "m-broken": { kind: "local", phase: "Failed" },
    "m-deleted": null,
  };
  const started: string[] = [];
  await sweepPendingLaunches(repo as any, { startSession: async (s: any) => { started.push(s.id); } } as any,
    async (model: string) => phases[model]);
  assert.deepEqual(started, ["sesn_ready"]);
  assert.deepEqual(repo.rows.map((r) => r.session_id), ["sesn_wait"], "still-deploying model keeps its row");
  assert.equal(repo.statuses["sesn_fail"], "failed");
  assert.match(repo.events["sesn_fail"][0].payload.error, /Failed/);
  assert.equal(repo.statuses["sesn_gone"], "failed");
  assert.match(repo.events["sesn_gone"][0].payload.error, /no longer exists/);
  assert.equal(repo.statuses["sesn_ready"], undefined, "released session keeps its queued status");
});

test("routing kind launches while it has a live target", () => {
  assert.deepEqual(gateDecision("my-route", { kind: "routing", contextTokens: 32768 }), { action: "launch" });
  assert.deepEqual(gateDecision("my-route", { kind: "routing", contextTokens: null }), { action: "launch" });
});

test("routing kind fails fast when its target model was deleted (no wait loop)", () => {
  // The gateway 503s "routing target unavailable" for a deleted terminal-route
  // target, which the runner patiently retries for 30 min. Failing here means
  // the pod never launches — a clear error instead of a silent wait.
  const d = gateDecision("my-route", { kind: "routing", contextTokens: null, deadTargets: ["qwen3-medium"] });
  assert.equal(d.action, "fail");
  assert.match((d as any).error, /my-route/);
  assert.match((d as any).error, /qwen3-medium/);
  // plural form lists every dead target
  const d2 = gateDecision("r", { kind: "routing", contextTokens: null, deadTargets: ["a", "b"] });
  assert.equal(d2.action, "fail");
  assert.match((d2 as any).error, /"a", "b"/);
});

// NOTE (fix wave I): the resolver that produces the ModelPhase gateDecision
// consumes — main.ts's `modelPhase` — must check routings BEFORE deployments.
// A routing can shadow a deployment of the same name; deployment-first
// resolution would silently return `{ kind: "local", ... }` for a shadowing
// routing name, giving the wrong contextWindow (deployment's own instead of
// the routing's min across reachable targets) and wrong launch gating (parks
// on the deployment's phase instead of always launching via the routing
// branch). modelPhase is a closure local to main.ts (not exported), so this
// can't be unit-tested here — covered live: a session on a shadowing routing
// name must launch immediately with no session.waiting event.

test("sweep wakes parked Idle models and keeps waiting", async () => {
  const repo = fakePending();
  await repo.addPendingLaunch("sesn_asleep", "m", { id: "sesn_asleep" });
  const woken: string[] = [];
  await sweepPendingLaunches(repo as any, { startSession: async () => {} } as any,
    async (model: string) => ({ kind: "local", phase: "Idle" }),
    async (model: string) => { woken.push(model); });
  assert.deepEqual(woken, ["m"]);
  assert.deepEqual(repo.rows.map((r) => r.session_id), ["sesn_asleep"], "session stays parked");
  assert.equal(repo.statuses["sesn_asleep"], undefined, "no session.failed");
  assert.deepEqual(repo.events["sesn_asleep"], undefined);
});
