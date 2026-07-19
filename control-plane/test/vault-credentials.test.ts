import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerAgentRoutes, type Orchestrator } from "../src/agents-api.ts";

function fixture() {
  const creds: Record<string, any> = {};
  const secretPuts: [string, string][] = [];   // [key, value]
  const secretRemoves: string[] = [];
  const repo: any = {
    async getWorkspace(id: string) { return { id, status: "active" }; },
    async getVault(_ws: string, id: string) { return id === "vlt_1" ? { id, name: "v" } : null; },
    async getVaultCredential(_v: string, name: string) { return creds[name] ?? null; },
    async addVaultCredential(_v: string, name: string, type = "environment_variable", url?: string, label?: string) {
      creds[name] = { name, type, mcp_server_url: url ?? null, mcp_server_name: label ?? null };
    },
    async removeVaultCredential(_v: string, name: string) { delete creds[name]; },
    async listVaultCredentials() { return Object.values(creds); },
  };
  const orchestrator = {
    async putVaultSecretKey(_v: string, key: string, value: string) { secretPuts.push([key, value]); },
    async removeVaultSecretKey(_v: string, key: string) { secretRemoves.push(key); },
  } as unknown as Orchestrator;
  return { repo, orchestrator, creds, secretPuts, secretRemoves };
}

async function server(f: ReturnType<typeof fixture>) {
  const app = Fastify();
  await registerAgentRoutes(app, f.repo, f.orchestrator, {} as any);
  return app;
}

test("bearer credential: derived key written, typed row stored", async () => {
  const f = fixture(); const app = await server(f);
  const res = await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { type: "bearer_token", mcpServerUrl: "https://mcp.context7.com/mcp", mcpServerName: "Context7", token: "tok" } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json(), { name: "Context7", type: "bearer_token" });
  assert.deepEqual(f.secretPuts, [["DEVPROOF_CRED_CONTEXT7_TOKEN", "tok"]]);
  assert.equal(f.creds.Context7.mcp_server_url, "https://mcp.context7.com/mcp");
});

test("legacy env-var body still works", async () => {
  const f = fixture(); const app = await server(f);
  const res = await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { name: "MY_KEY", value: "s" } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(f.secretPuts, [["MY_KEY", "s"]]);
  assert.equal(f.creds.MY_KEY.type, "environment_variable");
});

test("rotate: same name+type+server upserts; different type 409s", async () => {
  const f = fixture(); const app = await server(f);
  const body = { type: "bearer_token", mcpServerUrl: "https://a.com/mcp", name: "c", token: "t1" };
  assert.equal((await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials", payload: body })).statusCode, 201);
  assert.equal((await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { ...body, token: "t2" } })).statusCode, 201); // rotate
  const conflict = await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { name: "c", value: "x" } }); // same name, env-var type
  assert.equal(conflict.statusCode, 409);
  const moved = await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { ...body, mcpServerUrl: "https://other.com/mcp" } }); // same name, different server
  assert.equal(moved.statusCode, 409);
});

test("sanitized-name collision -> 409", async () => {
  const f = fixture(); const app = await server(f);
  const first = await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { type: "bearer_token", mcpServerUrl: "https://a.com/mcp", mcpServerName: "context7", token: "t1" } });
  assert.equal(first.statusCode, 201);
  const collide = await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { type: "bearer_token", mcpServerUrl: "https://b.com/mcp", mcpServerName: "Context7", token: "t2" } });
  assert.equal(collide.statusCode, 409);
  assert.match(collide.json().error, /collide/);
});

test("env-var literally named like a derived key collides with the credential that would derive it -> 409", async () => {
  const f = fixture(); const app = await server(f);
  const env = await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { name: "DEVPROOF_CRED_GH_TOKEN", value: "v" } });
  assert.equal(env.statusCode, 201);
  const oauth = await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { type: "mcp_oauth", mcpServerUrl: "https://a.com/mcp", name: "gh", accessToken: "at" } });
  assert.equal(oauth.statusCode, 409);
  assert.match(oauth.json().error, /collide/);
});

test("rotate of the same name is not treated as a self-collision", async () => {
  const f = fixture(); const app = await server(f);
  const body = { type: "bearer_token", mcpServerUrl: "https://a.com/mcp", name: "c", token: "t1" };
  assert.equal((await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials", payload: body })).statusCode, 201);
  const rotate = await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { ...body, token: "t2" } });
  assert.equal(rotate.statusCode, 201);
});

test("validation 400s: unknown type, bad env name, missing token", async () => {
  const f = fixture(); const app = await server(f);
  for (const payload of [
    { type: "wat", name: "x", value: "v" },
    { name: "2bad", value: "v" },
    { type: "mcp_oauth", mcpServerUrl: "https://a.com/mcp" },
  ]) {
    const res = await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials", payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

test("delete removes every derived key for the credential's type", async () => {
  const f = fixture(); const app = await server(f);
  await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { type: "mcp_oauth", mcpServerUrl: "https://a.com/mcp", name: "gh", accessToken: "t" } });
  const res = await app.inject({ method: "DELETE", url: "/v1/vaults/vlt_1/credentials/gh" });
  assert.equal(res.statusCode, 204);
  assert.deepEqual(f.secretRemoves,
    ["DEVPROOF_CRED_GH_TOKEN", "DEVPROOF_CRED_GH_CLIENT_ID", "DEVPROOF_CRED_GH_CLIENT_SECRET"]);
  assert.equal(f.creds.gh, undefined);
});

test("env-var delete removes the plain key (back-compat)", async () => {
  const f = fixture(); const app = await server(f);
  await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials", payload: { name: "MY_KEY", value: "s" } });
  await app.inject({ method: "DELETE", url: "/v1/vaults/vlt_1/credentials/MY_KEY" });
  assert.deepEqual(f.secretRemoves, ["MY_KEY"]);
});

test("agent create 400s on malformed mcpServers and re-syncs env policy on success", async () => {
  const f = fixture();
  const policySyncs: any[] = [];
  Object.assign(f.repo, {
    async getEnvironment(id: string) {
      return { id, allowed_hosts: ["a.com"], allow_package_managers: false, allow_mcp_servers: true };
    },
    async createAgent(_ws: string, name: string, c: any) { return { id: "agent_1", name, version: 1, ...c }; },
    async acquireWikiWriteLock() { return { release: async () => {} }; },
    async getRoutingByName(name: string) { return { name }; },
    async mcpServersForEnvironment() { return [{ c7: { type: "http", url: "https://mcp.context7.com/mcp" } }]; },
    async missingSkillIds() { return []; },
  });
  (f.orchestrator as any).ensureEnvironmentPolicy = async (env: any) => { policySyncs.push(env); };
  const app = await server(f);

  const bad = await app.inject({ method: "POST", url: "/v1/agents",
    payload: { name: "a", routing: "m", environmentId: "env_1", mcpServers: { c7: { url: "ftp://x" } } } });
  assert.equal(bad.statusCode, 400);

  const ok = await app.inject({ method: "POST", url: "/v1/agents",
    payload: { name: "a", routing: "m", environmentId: "env_1",
      mcpServers: { c7: { type: "http", url: "https://mcp.context7.com/mcp" } } } });
  assert.equal(ok.statusCode, 201);
  assert.equal(policySyncs.length, 1);
  assert.deepEqual(policySyncs[0].mcpHosts, ["mcp.context7.com"]);
});
