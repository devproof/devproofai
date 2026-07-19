import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { workspaceGuard, CONSOLE_RULES, PUBLIC_RULES } from "../src/workspace-guard.ts";

function makeApp(status: string | null, rules = CONSOLE_RULES) {
  const repo = {
    calls: 0,
    async getWorkspace(_id: string) { this.calls++; return status === null ? null : { id: "wrkspc_x", status }; },
  };
  const app = Fastify();
  // ttl 0 => every request re-reads status (deterministic tests).
  app.addHook("preHandler", workspaceGuard(repo, (req: any) => (req.headers["x-devproof-workspace"] as string) || "wrkspc_default", rules, 0));
  const ok = async () => ({ ok: true });
  app.get("/v1/agents", ok);
  app.post("/v1/agents", ok);
  app.post("/v1/sessions/:id/interrupt", ok);
  app.post("/v1/sessions/:id/events", ok);   // runner callback
  app.post("/v1/pools", ok);                  // serving — not in guarded prefixes
  app.post("/v1/workspaces/:id/status", ok);  // management — not in guarded prefixes
  return { app, repo };
}

test("disabled workspace: writes 409, reads + interrupt + runner callbacks + serving pass", async () => {
  const { app } = makeApp("disabled");
  const h = { "x-devproof-workspace": "wrkspc_x" };
  assert.equal((await app.inject({ method: "GET", url: "/v1/agents", headers: h })).statusCode, 200);
  const blocked = await app.inject({ method: "POST", url: "/v1/agents", headers: h, payload: {} });
  assert.equal(blocked.statusCode, 409);
  assert.equal(JSON.parse(blocked.body).error, "workspace disabled");
  assert.equal((await app.inject({ method: "POST", url: "/v1/sessions/s1/interrupt", headers: h, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/v1/sessions/s1/events", headers: h, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/v1/pools", headers: h, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/v1/workspaces/wrkspc_x/status", headers: h, payload: {} })).statusCode, 200);
});

test("deleting blocks writes; deleted/unknown 404; active passes", async () => {
  const h = { "x-devproof-workspace": "wrkspc_x" };
  const deleting = await makeApp("deleting").app.inject({ method: "POST", url: "/v1/agents", headers: h, payload: {} });
  assert.equal(deleting.statusCode, 409);
  assert.equal(JSON.parse(deleting.body).error, "workspace is being deleted");
  assert.equal((await makeApp("deleted").app.inject({ method: "POST", url: "/v1/agents", headers: h, payload: {} })).statusCode, 404);
  assert.equal((await makeApp(null).app.inject({ method: "POST", url: "/v1/agents", headers: h, payload: {} })).statusCode, 404);
  assert.equal((await makeApp("active").app.inject({ method: "POST", url: "/v1/agents", headers: h, payload: {} })).statusCode, 200);
});

test("status cache respects TTL", async () => {
  const repo = { calls: 0, async getWorkspace() { this.calls++; return { id: "w", status: "active" }; } };
  const app = Fastify();
  app.addHook("preHandler", workspaceGuard(repo, () => "w", CONSOLE_RULES, 60_000));
  app.post("/v1/agents", async () => ({ ok: true }));
  await app.inject({ method: "POST", url: "/v1/agents", payload: {} });
  await app.inject({ method: "POST", url: "/v1/agents", payload: {} });
  assert.equal(repo.calls, 1); // second hit served from cache
});

test("PUBLIC_RULES: everything guarded except interrupt, events/stream, and file content", async () => {
  const repo = { async getWorkspace() { return { id: "w", status: "disabled" }; } };
  const app = Fastify();
  app.addHook("preHandler", workspaceGuard(repo, () => "w", PUBLIC_RULES, 0));
  const ok = async () => ({ ok: true });
  app.post("/agents", ok);
  app.post("/files", ok);
  app.post("/files/:id/content", ok); // POST-as-read (public contract): file download
  app.post("/sessions/:id/interrupt", ok);
  app.post("/sessions/:id/events/stream", ok); // POST-as-read (public contract)
  assert.equal((await app.inject({ method: "POST", url: "/agents", payload: {} })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/files", payload: {} })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/files/f1/content", payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/sessions/s/interrupt", payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/sessions/s/events/stream", payload: {} })).statusCode, 200);
});
