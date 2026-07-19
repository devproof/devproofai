// Lite deployments (spec 2026-07-19): local serving disabled ⇒ local-only
// routes 404 and mixed surfaces never touch the serving kubestore.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "../src/catalog.ts";
import { buildServer } from "../src/server.ts";
import { localServingEnabled } from "../src/serving-mode.ts";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { registerAgentRoutes, type Orchestrator } from "../src/agents-api.ts";
import { localFileStore } from "../src/filestore.ts";

const catalog = loadCatalog(fileURLToPath(new URL("../../catalog/models.yaml", import.meta.url)));

// Kubestore whose serving methods throw — proves lite mode never touches them.
// Gateway-config/provider-key writes stay functional (externals need them).
function throwingStore(): any {
  const boom = (m: string) => () => { throw new Error(`kubestore touched: ${m}`); };
  return {
    list: boom("list"), get: boom("get"), create: boom("create"),
    patch: boom("patch"), delete: boom("delete"),
    listCachedModels: boom("listCachedModels"), deleteCachedModel: boom("deleteCachedModel"),
    writeGatewayConfig: async () => false,
    awaitGatewayRollout: async () => true,
    writeProviderKey: async () => {}, deleteProviderKey: async () => {},
  };
}

const externalRows: any[] = [{ id: "ext_1", name: "ext-a", provider: "openai", model_id: "gpt-x",
  base_url: null, reasoning_effort: null, context_tokens: 200000 }];
const externals: any = {
  create: async (d: any) => { const row = { id: `ext_${externalRows.length + 1}`, model_id: d.modelId, base_url: d.baseUrl ?? null, context_tokens: d.contextTokens, ...d }; externalRows.push(row); return row; },
  list: async () => externalRows,
  get: async (id: string) => externalRows.find((e) => e.id === id) ?? null,
  getByName: async (n: string) => externalRows.find((e) => e.name === n) ?? null,
  update: async () => null, delete: async () => null,
};
const routings = new Map<string, any>();
const routingStore: any = {
  list: async () => [...routings.values()],
  get: async (n: string) => routings.get(n) ?? null,
  create: async (n: string, rules: any, terminal: any) => { const r = { name: n, rules, terminal }; routings.set(n, r); return r; },
  update: async () => null, delete: async () => null,
};

const app = buildServer(catalog, throwingStore(), undefined, externals, undefined, routingStore,
  { localServing: false });

test("serving-mode: default on, off only on explicit false", () => {
  delete process.env.DEVPROOF_LOCAL_SERVING;
  assert.equal(localServingEnabled(), true);
  process.env.DEVPROOF_LOCAL_SERVING = "true";
  assert.equal(localServingEnabled(), true);
  process.env.DEVPROOF_LOCAL_SERVING = "false";
  assert.equal(localServingEnabled(), false);
  delete process.env.DEVPROOF_LOCAL_SERVING;
});

test("local-only routes 404 with a clear error", async () => {
  const gated = [
    ["GET", "/v1/catalog"], ["POST", "/v1/catalog"], ["PATCH", "/v1/catalog/x"], ["DELETE", "/v1/catalog/x"],
    ["GET", "/v1/cache"], ["DELETE", "/v1/cache/x"],
    ["GET", "/v1/pools"], ["POST", "/v1/pools"], ["PATCH", "/v1/pools/x"], ["DELETE", "/v1/pools/x"],
    ["POST", "/v1/deployments"], ["PATCH", "/v1/deployments/x"], ["DELETE", "/v1/deployments/x"],
  ] as const;
  for (const [method, url] of gated) {
    const res = await app.inject({ method, url,
      ...(method === "POST" || method === "PATCH" ? { payload: {} } : {}) });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
    assert.equal(res.json().error, "local serving disabled", `${method} ${url}`);
  }
});

test("GET /v1/deployments lists externals without touching the kubestore", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/deployments" });
  assert.equal(res.statusCode, 200);
  const { deployments } = res.json();
  assert.equal(deployments.length >= 1, true);
  assert.equal(deployments.every((d: any) => d.kind === "external"), true);
  const one = await app.inject({ method: "GET", url: "/v1/deployments/ext-a" });
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().kind, "external");
});

test("POST /v1/gateway/sync builds external-only config", async () => {
  const res = await app.inject({ method: "POST", url: "/v1/gateway/sync" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().synced, true);
});

test("POST /v1/deployments/external skips the local-name collision check", async () => {
  const res = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "ext-b", provider: "openai", modelId: "gpt-y", contextTokens: 128000 } });
  assert.equal(res.statusCode, 201); // would 500 "kubestore touched: get" without the gate
});

test("routing create validates targets against externals only", async () => {
  const ok = await app.inject({ method: "POST", url: "/v1/routings",
    payload: { name: "t-lite-route", terminal: { action: "route", target: "ext-a" } } });
  assert.equal(ok.statusCode, 201); // would 500 "kubestore touched: list" without the gate
  const bad = await app.inject({ method: "POST", url: "/v1/routings",
    payload: { name: "t-lite-bad", terminal: { action: "route", target: "no-such-model" } } });
  assert.equal(bad.statusCode, 400);
});

test("GET /v1/routings/:name computes min context without touching the kubestore", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/routings/t-lite-route" });
  assert.equal(res.statusCode, 200); // would 500 "kubestore touched: get" if the locals loop ran
  assert.equal(res.json().minContextTokens, 200000); // ext-a's context_tokens
});

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

test("GET /v1/settings exposes computed serving.localEnabled", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const root = mkdtempSync(join(tmpdir(), "serving-mode-test-"));
  const api = Fastify();
  await registerAgentRoutes(api, repo, {} as unknown as Orchestrator, localFileStore(root));
  try {
    process.env.DEVPROOF_LOCAL_SERVING = "false";
    assert.equal((await api.inject({ method: "GET", url: "/v1/settings" })).json().serving.localEnabled, false);
    delete process.env.DEVPROOF_LOCAL_SERVING;
    assert.equal((await api.inject({ method: "GET", url: "/v1/settings" })).json().serving.localEnabled, true);
  } finally {
    delete process.env.DEVPROOF_LOCAL_SERVING;
    await api.close();
    rmSync(root, { recursive: true, force: true });
  }
});
after(async () => { await pool.end().catch(() => {}); });
