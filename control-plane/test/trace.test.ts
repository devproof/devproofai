import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { TraceHub, registerTraceRoutes } from "../src/trace.ts";

const fakeRepo = () => {
  const calls: { upserts: any[]; deletes: string[] } = { upserts: [], deletes: [] };
  return {
    calls,
    async upsertTraceSubscription(id: string, target: { deployment?: string; routing?: string }, url: string) { calls.upserts.push({ id, ...target, url }); },
    async deleteTraceSubscription(id: string) { calls.deletes.push(id); },
  };
};

test("TraceHub fans out per deployment and unsubscribes cleanly", () => {
  const hub = new TraceHub();
  const got: any[] = [];
  const un = hub.subscribe("dep-a", (e) => got.push(e));
  hub.publish({ deployment: "dep-a", kind: "request" });
  hub.publish({ deployment: "dep-b", kind: "request" });   // other deployment: not delivered
  assert.equal(got.length, 1);
  un();
  hub.publish({ deployment: "dep-a", kind: "response" });
  assert.equal(got.length, 1);                              // after unsubscribe: not delivered
});

test("TraceHub: one event carrying both keys reaches each subscriber exactly once", () => {
  // Locks the dual-delivery contract: the gateway emits ONE post per event to
  // the union of the deployment+routing subscriber URLs (F2), and publish() is
  // the ONLY place that fans that single post out to both windows. So a
  // deployment-trace and routing-trace window open at once each see the event
  // exactly once — never twice.
  const hub = new TraceHub();
  const dep: any[] = [];
  const rt: any[] = [];
  hub.subscribe("dep-a", (e) => dep.push(e));
  hub.subscribe("route-x", (e) => rt.push(e));
  hub.publish({ deployment: "dep-a", routing: "route-x", kind: "request" });
  assert.equal(dep.length, 1);   // deployment window: exactly once
  assert.equal(rt.length, 1);    // routing window: exactly once
});

test("POST /internal/trace-events: auth enforced when key set, publishes to hub", async (t) => {
  process.env.DEVPROOF_INTERNAL_KEY = "test-internal";
  t.after(() => { delete process.env.DEVPROOF_INTERNAL_KEY; });
  const app = Fastify();
  const hub = new TraceHub();
  registerTraceRoutes(app as any, fakeRepo() as any, hub);
  const got: any[] = [];
  hub.subscribe("dep-a", (e) => got.push(e));

  const noAuth = await app.inject({ method: "POST", url: "/internal/trace-events",
    payload: { events: [{ deployment: "dep-a", kind: "request" }] } });
  assert.equal(noAuth.statusCode, 401);

  const ok = await app.inject({ method: "POST", url: "/internal/trace-events",
    headers: { authorization: "Bearer test-internal" },
    payload: { events: [{ deployment: "dep-a", kind: "request" }, { deployment: "dep-a", kind: "response" }] } });
  assert.equal(ok.statusCode, 202);
  assert.equal(got.length, 2);
});
