import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileDecision, sweepZombieSessions, RECONCILE_GRACE_MS } from "../src/reconciler.ts";

const NOW = 1_800_000_000_000;
const OLD = NOW - RECONCILE_GRACE_MS - 1;
const FRESH = NOW - 1_000;

test("reconcileDecision: terminal statuses are never touched", () => {
  for (const status of ["idle", "completed", "failed"]) {
    assert.equal(reconcileDecision({ status, lastActivityMs: OLD }, "missing", NOW), "keep");
  }
});

test("reconcileDecision: a live job keeps the session regardless of age", () => {
  assert.equal(reconcileDecision({ status: "running", lastActivityMs: OLD }, "active", NOW), "keep");
  assert.equal(reconcileDecision({ status: "queued", lastActivityMs: OLD }, "active", NOW), "keep");
});

test("reconcileDecision: recent activity is spared (job may not exist yet / result in flight)", () => {
  assert.equal(reconcileDecision({ status: "queued", lastActivityMs: FRESH }, "missing", NOW), "keep");
  assert.equal(reconcileDecision({ status: "running", lastActivityMs: FRESH }, "finished", NOW), "keep");
});

test("reconcileDecision: stale in-flight session with a dead or vanished job fails", () => {
  assert.equal(reconcileDecision({ status: "running", lastActivityMs: OLD }, "missing", NOW), "fail");
  assert.equal(reconcileDecision({ status: "running", lastActivityMs: OLD }, "finished", NOW), "fail");
  assert.equal(reconcileDecision({ status: "queued", lastActivityMs: OLD }, "missing", NOW), "fail");
});

test("sweepZombieSessions: fails zombies, appends session.failed first, spares live ones", async () => {
  const events: { id: string; type: string }[] = [];
  const statuses: { id: string; status: string }[] = [];
  const old = new Date(Date.now() - RECONCILE_GRACE_MS - 60_000);
  const repo = {
    async listStuckSessions() {
      return [
        { id: "sesn_zombie", status: "running", turns: 0, last_activity: old },
        { id: "sesn_alive", status: "running", turns: 2, last_activity: old },
        { id: "sesn_fresh", status: "queued", turns: 0, last_activity: new Date() },
      ];
    },
    async appendEvents(id: string, evs: { type: string }[]) { events.push({ id, type: evs[0].type }); return 1; },
    async setSessionStatus(id: string, status: "failed") { statuses.push({ id, status }); return {}; },
  };
  const orchestrator = {
    async sessionJobState(id: string) { return id === "sesn_alive" ? "active" as const : "missing" as const; },
  };
  await sweepZombieSessions(repo, orchestrator);
  assert.deepEqual(events, [{ id: "sesn_zombie", type: "session.failed" }]);
  assert.deepEqual(statuses, [{ id: "sesn_zombie", status: "failed" }]);
});

test("sweepZombieSessions: one broken session does not stop the sweep", async () => {
  const statuses: string[] = [];
  const old = new Date(Date.now() - RECONCILE_GRACE_MS - 60_000);
  const repo = {
    async listStuckSessions() {
      return [
        { id: "sesn_boom", status: "running", turns: 0, last_activity: old },
        { id: "sesn_next", status: "running", turns: 0, last_activity: old },
      ];
    },
    async appendEvents() { return 1; },
    async setSessionStatus(id: string) { statuses.push(id); return {}; },
  };
  const orchestrator = {
    async sessionJobState(id: string): Promise<"missing"> {
      if (id === "sesn_boom") throw new Error("k8s hiccup");
      return "missing";
    },
  };
  await sweepZombieSessions(repo, orchestrator);
  assert.deepEqual(statuses, ["sesn_next"]);
});
