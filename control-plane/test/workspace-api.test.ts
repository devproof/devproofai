import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerAgentRoutes } from "../src/agents-api.ts";

function fakes() {
  const workspaces = new Map<string, any>([
    ["wrkspc_default", { id: "wrkspc_default", name: "Default workspace", status: "active", delete_totals: null }],
    ["wrkspc_a", { id: "wrkspc_a", name: "team-a", status: "active", delete_totals: null }],
  ]);
  const repo = {
    async listWorkspaces(all = false) {
      return [...workspaces.values()].filter((w) => all || w.status !== "deleted");
    },
    async createWorkspace(name: string) {
      const w = { id: `wrkspc_${workspaces.size}`, name, status: "active", delete_totals: null };
      workspaces.set(w.id, w); return { id: w.id, name };
    },
    async getWorkspace(id: string) { return workspaces.get(id) ?? null; },
    async renameWorkspace(id: string, name: string) {
      const w = workspaces.get(id);
      if (!w || w.status === "deleted") return "notfound";
      if ([...workspaces.values()].some((x) => x.id !== id && x.status !== "deleted" && x.name === name)) return "conflict";
      w.name = name; return "ok";
    },
    async setWorkspaceStatus(id: string, status: string) {
      const w = workspaces.get(id); if (!w) return false; w.status = status; return true;
    },
    async beginWorkspaceDelete(id: string, totals: any) {
      const w = workspaces.get(id);
      if (w && !["deleting", "deleted"].includes(w.status)) { w.status = "deleting"; w.delete_totals = totals; return true; }
      return false;
    },
    counts: { sessions: 3, agents: 1 } as Record<string, number>,
    // Self-clearing: the first read (snapshot / progress) sees the seeded
    // counts, later reads see a drained workspace — so the runner's re-check
    // loop converges on pass 1 instead of exhausting its 3 passes and warning.
    async workspaceResourceCounts() {
      const c = { ...(this as any).counts };
      (this as any).counts = {};
      return c;
    },
    // Drain surface — empty workspace, runner no-ops through it.
    async workspaceRowIds() { return []; },
    async deleteWorkspaceWebhooks() {},
    async softDeleteWorkspaceApiKeys() {},
    async listWorkspaceFileUploads() { return []; },
    async listWebhooks() { return []; },
  } as any;
  const orchestrator = {
    async stopSession() {}, async deleteSessionResources() {},
    async deleteEnvironmentResources() {}, async deleteVaultSecret() {},
  } as any;
  const files = { async del() {} } as any;
  return { repo, orchestrator, files, workspaces };
}

async function makeApp(f = fakes()) {
  const app = Fastify();
  await registerAgentRoutes(app, f.repo, f.orchestrator, f.files);
  return { app, ...f };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), "condition not reached");
};

test("rename: ok / default-protected / conflict / notfound", async () => {
  const { app } = await makeApp();
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/workspaces/wrkspc_a", payload: { name: "team-b" } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/workspaces/wrkspc_default", payload: { name: "x" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/workspaces/wrkspc_a", payload: { name: "Default workspace" } })).statusCode, 409);
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/workspaces/wrkspc_nope", payload: { name: "x" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/workspaces/wrkspc_a", payload: {} })).statusCode, 400);
});

test("status: disable/enable, default protected, deleting locked", async () => {
  const { app, workspaces } = await makeApp();
  assert.equal((await app.inject({ method: "POST", url: "/v1/workspaces/wrkspc_a/status", payload: { status: "disabled" } })).statusCode, 200);
  assert.equal(workspaces.get("wrkspc_a").status, "disabled");
  assert.equal((await app.inject({ method: "POST", url: "/v1/workspaces/wrkspc_a/status", payload: { status: "bogus" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/v1/workspaces/wrkspc_default/status", payload: { status: "disabled" } })).statusCode, 400);
  workspaces.get("wrkspc_a").status = "deleting";
  assert.equal((await app.inject({ method: "POST", url: "/v1/workspaces/wrkspc_a/status", payload: { status: "active" } })).statusCode, 409);
});

test("resources endpoint returns counts", async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: "GET", url: "/v1/workspaces/wrkspc_a/resources" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).counts, { sessions: 3, agents: 1 });
});

test("delete: 202, snapshots totals, runner tombstones; repeat 202; default 400", async () => {
  const { app, workspaces } = await makeApp();
  const res = await app.inject({ method: "DELETE", url: "/v1/workspaces/wrkspc_a" });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(workspaces.get("wrkspc_a").delete_totals, { sessions: 3, agents: 1 });
  await until(() => workspaces.get("wrkspc_a").status === "deleted"); // empty ws drains instantly
  // Tombstone: repeat delete → 404 (already deleted); default → 400.
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/workspaces/wrkspc_a" })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/workspaces/wrkspc_default" })).statusCode, 400);
});

test("deletion progress: draining vs done states, deleted → all done", async () => {
  const f = fakes();
  const { app, workspaces, repo } = await makeApp(f);
  workspaces.get("wrkspc_a").status = "deleting";
  workspaces.get("wrkspc_a").delete_totals = { sessions: 3, agents: 1 };
  repo.counts = { sessions: 1, agents: 0 };
  const res = await app.inject({ method: "GET", url: "/v1/workspaces/wrkspc_a/deletion" });
  const body = JSON.parse(res.body);
  assert.equal(body.status, "deleting");
  assert.deepEqual(body.resources.sessions, { total: 3, remaining: 1, state: "draining" });
  assert.deepEqual(body.resources.agents, { total: 1, remaining: 0, state: "done" });
  // Repeat DELETE while deleting: idempotent 202, no second runner kick
  // (beginWorkspaceDelete's WHERE clause is already 'deleting' — no flip, so
  // it returns false and the route doesn't re-kick the runner).
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/workspaces/wrkspc_a" })).statusCode, 202);
  assert.equal(workspaces.get("wrkspc_a").status, "deleting");
  workspaces.get("wrkspc_a").status = "deleted";
  const done = JSON.parse((await app.inject({ method: "GET", url: "/v1/workspaces/wrkspc_a/deletion" })).body);
  assert.equal(done.status, "deleted");
  assert.deepEqual(done.resources.sessions, { total: 3, remaining: 0, state: "done" });
});

test("list: excludes deleted by default, include=deleted shows tombstones, rows carry status", async () => {
  const { app, workspaces } = await makeApp();
  workspaces.get("wrkspc_a").status = "deleted";
  const live = JSON.parse((await app.inject({ method: "GET", url: "/v1/workspaces" })).body).workspaces;
  assert.ok(!live.some((w: any) => w.id === "wrkspc_a"));
  assert.equal(live[0].status, "active");
  const all = JSON.parse((await app.inject({ method: "GET", url: "/v1/workspaces?include=deleted" })).body).workspaces;
  assert.ok(all.some((w: any) => w.id === "wrkspc_a"));
});

test("guard wired: write to disabled workspace 409s, interrupt-style exemption intact", async () => {
  const { app, workspaces } = await makeApp();
  workspaces.get("wrkspc_a").status = "disabled";
  const h = { "x-devproof-workspace": "wrkspc_a" };
  const blocked = await app.inject({ method: "POST", url: "/v1/agents", headers: h, payload: { name: "x", routing: "m" } });
  assert.equal(blocked.statusCode, 409);
  assert.equal(JSON.parse(blocked.body).error, "workspace disabled");
  // Management routes stay usable while disabled (re-enable path).
  assert.equal((await app.inject({ method: "POST", url: "/v1/workspaces/wrkspc_a/status", headers: h, payload: { status: "active" } })).statusCode, 200);
});
