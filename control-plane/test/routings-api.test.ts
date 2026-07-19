// Exercises CRUD + collision + validation against the dev DB and a fake kube
// store (same pattern as other API tests: buildServer with stubs).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { buildServer } from "../src/server.ts";

const pool = createPool();
await migrate(pool);
const repo = new Repo(pool);
const NAME = `t-route-${Date.now().toString(36)}`;

// Minimal kube stub: one Ready local deployment "t-local-dep".
const kube: any = {
  list: async (plural: string) => plural === "modeldeployments"
    ? [{ metadata: { name: "t-local-dep", namespace: "devproof-serving" },
         spec: {}, status: { phase: "Ready", endpoint: "http://t-local-dep.devproof-serving.svc.cluster.local:8080/v1/chat/completions", effectiveContextTokens: 32768 } }]
    : [],
  get: async (plural: string, name: string) =>
    plural === "modeldeployments" && name === "t-local-dep"
      ? { metadata: { name }, spec: {}, status: { phase: "Ready", effectiveContextTokens: 32768 } } : null,
  writeGatewayConfig: async () => false,
  awaitGatewayRollout: async () => true,
  listCachedModels: async () => [],
};
const routingStore = {
  list: () => repo.listRoutings(), get: (n: string) => repo.getRoutingByName(n),
  create: (n: string, r: unknown, t: unknown) => repo.createRouting(n, r, t),
  update: (n: string, p: any) => repo.updateRouting(n, p), delete: (n: string) => repo.deleteRouting(n),
  agentsReferencing: (n: string) => repo.agentsReferencingRouting(n),
};
// Backed by the real repo (not an inert stub) so a test can create a real
// external row and have it participate in minContextTokens (fix wave L).
const externalStore = {
  create: (d: any) => repo.createExternalDeployment(d),
  list: () => repo.listExternalDeployments(),
  get: (id: string) => repo.getExternalDeployment(id),
  getByName: (n: string) => repo.getExternalDeploymentByName(n),
  update: (id: string, p: any) => repo.updateExternalDeployment(id, p),
  delete: (id: string) => repo.deleteExternalDeployment(id),
};
const app = buildServer([], kube, undefined, externalStore, undefined, routingStore);

const extIds: string[] = [];
after(async () => {
  await repo.deleteRouting(NAME);
  for (const id of extIds) await repo.deleteExternalDeployment(id);
  await pool.end(); await app.close();
});

test("create minimal routing (terminal route, zero rules)", async () => {
  const res = await app.inject({ method: "POST", url: "/v1/routings",
    payload: { name: NAME, terminal: { action: "route", target: "t-local-dep" } } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().name, NAME);
});

test("duplicate routing rejected; deployment name may be shadowed (201)", async () => {
  const dup = await app.inject({ method: "POST", url: "/v1/routings",
    payload: { name: NAME, terminal: { action: "reject" } } });
  assert.equal(dup.statusCode, 409);
  // A routing MAY shadow a deployment of the same name (spec 2026-07-16).
  const shadow = await app.inject({ method: "POST", url: "/v1/routings",
    payload: { name: "t-local-dep", terminal: { action: "reject" } } });
  assert.equal(shadow.statusCode, 201);
  await repo.deleteRouting("t-local-dep");
});

test("deploy no longer collides with a routing name (passes the routing check)", async () => {
  // Same-named deployment must clear the routings check now; it fails later on
  // the bogus catalogId (400), never on a routing 409.
  const res = await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: NAME, catalogId: "x", poolRef: "p" } });
  assert.notEqual(res.statusCode, 409);
  if (res.statusCode >= 400) assert.doesNotMatch(res.json().error ?? "", /taken by a routing/);
});

test("PATCH validates rules against live targets; bad rules 400", async () => {
  const bad = await app.inject({ method: "PATCH", url: `/v1/routings/${NAME}`,
    payload: { rules: [{ conditions: [], target: "missing-model" }] } });
  assert.equal(bad.statusCode, 400);
  const good = await app.inject({ method: "PATCH", url: `/v1/routings/${NAME}`,
    payload: { rules: [{ conditions: [{ type: "context", op: "<=", tokens: 30000 }], target: "t-local-dep" }] } });
  assert.equal(good.statusCode, 200);
  assert.equal(good.json().rules.length, 1);
});

test("GET detail carries minContextTokens from reachable local targets", async () => {
  const res = await app.inject({ method: "GET", url: `/v1/routings/${NAME}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().minContextTokens, 32768);
});

test("GET detail: an external terminal target's context_tokens joins the min (fix wave L)", async () => {
  const gname = `t-extmin-${Date.now().toString(36)}`;
  const ext = await repo.createExternalDeployment({
    name: `t-ext-${Date.now().toString(36)}`, provider: "openai", modelId: "gpt-4o",
    hasKey: false, contextTokens: 8192,
  });
  extIds.push(ext.id);
  await repo.createRouting(gname, [], { action: "route", target: ext.name });
  const res = await app.inject({ method: "GET", url: `/v1/routings/${gname}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().minContextTokens, 8192);
  // reachableTargets stays locals-only (console backward compat) — empty here.
  assert.deepEqual(res.json().reachableTargets, []);
  await repo.deleteRouting(gname);
});

test("list is paged and shows ruleCount", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/routings" });
  const row = res.json().routings.find((r: any) => r.name === NAME);
  assert.equal(row.ruleCount, 1);
  assert.ok("count" in res.json() && "offset" in res.json());
});

test("DELETE 409 while an agent references the routing; 204 once it's gone", async () => {
  const gname = `t-guard-${Date.now().toString(36)}`;
  const ws = (await repo.createWorkspace(`t-guardws-${Date.now().toString(36)}`)).id;
  await repo.createRouting(gname, [], { action: "route", target: "t-local-dep" });
  const env = await repo.createEnvironment(ws, "e", false, [], {}, false);
  const agent = await repo.createAgent(ws, `t-guard-agent-${Date.now().toString(36)}`,
    { routing: gname, environmentId: env.id } as any);

  const blocked = await app.inject({ method: "DELETE", url: `/v1/routings/${gname}` });
  assert.equal(blocked.statusCode, 409);
  assert.match(blocked.json().error, /referenced by agent/);

  await repo.deleteAgent(ws, agent.id);
  const ok = await app.inject({ method: "DELETE", url: `/v1/routings/${gname}` });
  assert.equal(ok.statusCode, 204);

  await repo.deleteEnvironment(ws, env.id);
});

test("DELETE removes and 404s after", async () => {
  assert.equal((await app.inject({ method: "DELETE", url: `/v1/routings/${NAME}` })).statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: `/v1/routings/${NAME}` })).statusCode, 404);
});
