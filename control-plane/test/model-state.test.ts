import { test } from "node:test";
import assert from "node:assert/strict";
import { modelStateFor } from "../src/session-sse.ts";

// modelStateFor resolves the session's serving target to a model_routing
// state for the console's activity label (spec follow-up 2026-07-23):
// last_model (the actually-resolved target) wins; before a first call the
// agent's routing terminal is the best guess; externals/unknowns are null
// (model_routing only holds LOCAL deployments) so the console keeps its
// default labels for them.
const repo = (over: Record<string, any> = {}) => ({
  getAgentVersion: async () => ({ routing: "gemma4" }),
  getRoutingByName: async (n: string) =>
    n === "gemma4" ? { name: "gemma4", terminal: { action: "route", target: "gemma-local" } } : null,
  getModelRoutingState: async (m: string) => (m === "gemma-local" ? "waking" : null),
  ...over,
});

test("last_model wins and resolves its state", async () => {
  assert.equal(await modelStateFor({ last_model: "gemma-local" }, repo()), "waking");
});

test("no last_model: falls back to the routing terminal target", async () => {
  assert.equal(
    await modelStateFor({ last_model: null, agent_id: "a", agent_version: 1 }, repo()),
    "waking");
});

test("external / unknown target has no model_routing row -> null", async () => {
  assert.equal(await modelStateFor({ last_model: "gpt-endpoint" }, repo()), null);
});

test("reject terminal or deleted routing -> null", async () => {
  const r = repo({ getRoutingByName: async () => ({ terminal: { action: "reject" } }) });
  assert.equal(await modelStateFor({ last_model: null, agent_id: "a", agent_version: 1 }, r), null);
  const r2 = repo({ getRoutingByName: async () => null });
  assert.equal(await modelStateFor({ last_model: null, agent_id: "a", agent_version: 1 }, r2), null);
});

test("resolution errors fail open to null", async () => {
  const r = repo({ getModelRoutingState: async () => { throw new Error("db down"); } });
  assert.equal(await modelStateFor({ last_model: "gemma-local" }, r), null);
});
