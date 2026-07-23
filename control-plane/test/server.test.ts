import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "../src/catalog.ts";
import { buildServer } from "../src/server.ts";
import type { KubeStore } from "../src/kubestore.ts";

const catalog = loadCatalog(fileURLToPath(new URL("../../catalog/models.yaml", import.meta.url)));

function fakeStore() {
  const objects: Record<string, any[]> = { modelpools: [], modeldeployments: [] };
  let gatewayConfig = "";
  const providerKeys: Record<string, string> = {};
  const store: KubeStore = {
    async list(plural) { return objects[plural]; },
    async get(plural, name) { return objects[plural].find((o) => o.metadata.name === name) ?? null; },
    async create(plural, body) {
      if (objects[plural].some((o) => o.metadata.name === body.metadata.name)) {
        throw Object.assign(new Error(`${plural} "${body.metadata.name}" already exists`), { statusCode: 409 });
      }
      objects[plural].push(body);
      return body;
    },
    async delete(plural, name) {
      objects[plural] = objects[plural].filter((o) => o.metadata.name !== name);
    },
    async listCachedModels() {
      return [{
        metadata: { name: "qwen05b", creationTimestamp: "2026-07-07T16:00:00Z" },
        spec: { source: "https://huggingface.co/x.gguf" },
        status: { size: "468.6 MiB", phase: "Ready" },
      }];
    },
    async deleteCachedModel() {},
    async listServingPods() { return []; },
    async execInPod() { return ""; },
    async writeGatewayConfig(cfg) {
      const changed = cfg !== gatewayConfig;
      gatewayConfig = cfg;
      return changed;
    },
    async awaitGatewayRollout() { return true; },
    async patch(plural, name, body) {
      const obj = objects[plural].find((o) => o.metadata.name === name);
      if (!obj) throw Object.assign(new Error("not found"), { code: 404 });
      const prevSelector = obj.spec?.nodeSelector;
      // shallow-merge spec like a JSON merge patch (sufficient for tests)
      obj.spec = { ...obj.spec, ...body.spec, model: { ...obj.spec?.model, ...body.spec?.model },
        ...(body.spec?.resources ? { resources: { ...obj.spec?.resources, ...body.spec.resources } } : {}) };
      // RFC 7386: a null value at the spec level deletes the key (the real
      // kubestore is a JSON merge-patch; reasoning clear relies on this).
      for (const [k, v] of Object.entries(body.spec ?? {})) if (v === null) delete obj.spec[k];
      // RFC 7386 for maps: keys merge, null values delete (pool nodeSelector replacement relies on this)
      if (body.spec?.nodeSelector) {
        const merged: Record<string, any> = { ...prevSelector, ...body.spec.nodeSelector };
        obj.spec.nodeSelector = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null));
      }
      return obj;
    },
    async writeProviderKey(k, v) { providerKeys[k] = v; },
    async deleteProviderKey(k) { delete providerKeys[k]; },
  };
  return { store, objects, getGatewayConfig: () => gatewayConfig, providerKeys };
}

test("GET /v1/catalog returns seed entries", async () => {
  const { store } = fakeStore();
  const app = buildServer(catalog, store);
  const res = await app.inject({ method: "GET", url: "/v1/catalog" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().models[0].id, "qwen2.5-0.5b-instruct-q4");
});

test("GET /v1/cache lists downloaded model artifacts", async () => {
  const app = buildServer(catalog, fakeStore().store);
  const res = await app.inject({ method: "GET", url: "/v1/cache" });
  assert.equal(res.statusCode, 200);
  const { cache } = res.json();
  assert.equal(cache[0].name, "qwen05b");
  assert.equal(cache[0].size, "468.6 MiB");
  assert.equal(cache[0].phase, "Ready");
});

test("POST /v1/pools validates DNS-1035 name and writes a typed spec", async () => {
  const { store, objects } = fakeStore();
  const app = buildServer(catalog, store);
  assert.equal((await app.inject({ method: "POST", url: "/v1/pools", payload: { name: "My Pool" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/v1/pools",
    payload: { name: "ok", tolerations: [{ key: "x", operator: "Sometimes" }] } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/v1/pools",
    payload: { name: "ok", tolerations: [{ key: "x", effect: "Never" }] } })).statusCode, 400);
  const res = await app.inject({ method: "POST", url: "/v1/pools", payload: {
    name: "gpu-a100", nodeSelector: { "devproof.ai/pool": "gpu-a100" },
    gpuType: "nvidia-a100", gpusPerNode: 4, maxNodes: 8,
    tolerations: [{ key: "gpu", operator: "Equal", value: "true", effect: "NoSchedule" }],
  } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(objects.modelpools[0].spec, {
    nodeSelector: { "devproof.ai/pool": "gpu-a100" },
    gpuType: "nvidia-a100", gpusPerNode: 4, maxNodes: 8,
    tolerations: [{ key: "gpu", operator: "Equal", value: "true", effect: "NoSchedule" }],
  });
});

test("GET /v1/pools reports committed max replicas per pool", async () => {
  const { store, objects } = fakeStore();
  objects.modelpools.push({ metadata: { name: "p1" }, spec: { maxNodes: 5 } });
  objects.modeldeployments.push(
    { metadata: { name: "d1" }, spec: { poolRef: "p1", replicas: { min: 1, max: 2 } }, status: {} },
    { metadata: { name: "d2" }, spec: { poolRef: "p1", replicas: { min: 0, max: 3 } }, status: {} },
  );
  const app = buildServer(catalog, store);
  const res = await app.inject({ method: "GET", url: "/v1/pools" });
  assert.equal(res.json().pools[0].committedMaxReplicas, 5);
});

test("PATCH /v1/pools/:name rejects lowering maxNodes below the committed sum", async () => {
  const { store, objects } = fakeStore();
  objects.modelpools.push({ metadata: { name: "p1" }, spec: { maxNodes: 5 } });
  objects.modeldeployments.push(
    { metadata: { name: "d1" }, spec: { poolRef: "p1", replicas: { min: 1, max: 4 } }, status: {} });
  const app = buildServer(catalog, store);
  const bad = await app.inject({ method: "PATCH", url: "/v1/pools/p1", payload: { maxNodes: 3 } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, "pool p1: committed max replicas 4 exceeds new budget 3");
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/pools/p1", payload: { maxNodes: 4 } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/pools/p1", payload: { maxNodes: 0 } })).statusCode, 200); // 0 = unlimited
});

test("PATCH /v1/pools/:name fully replaces nodeSelector and merges capacity fields", async () => {
  const { store, objects } = fakeStore();
  objects.modelpools.push({ metadata: { name: "p1", namespace: "devproof-serving" },
    spec: { nodeSelector: { a: "1", b: "2" }, gpuType: "cpu", maxNodes: 2 } });
  const app = buildServer(catalog, store);
  const res = await app.inject({ method: "PATCH", url: "/v1/pools/p1",
    payload: { nodeSelector: { a: "9" }, maxNodes: 3 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(objects.modelpools[0].spec.nodeSelector, { a: "9" });  // b removed
  assert.equal(objects.modelpools[0].spec.maxNodes, 3);
  assert.equal(objects.modelpools[0].spec.gpuType, "cpu");                 // untouched
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/pools/nope", payload: {} })).statusCode, 404);
});

test("DELETE /v1/pools/:name is guarded by referencing deployments", async () => {
  const { store, objects } = fakeStore();
  objects.modelpools.push({ metadata: { name: "p1", namespace: "devproof-serving" }, spec: {} });
  objects.modeldeployments.push({ metadata: { name: "dep1", namespace: "devproof-serving" },
    spec: { poolRef: "p1" }, status: {} });
  const app = buildServer(catalog, store);
  const blocked = await app.inject({ method: "DELETE", url: "/v1/pools/p1" });
  assert.equal(blocked.statusCode, 409);
  assert.match(blocked.json().error, /dep1/);
  objects.modeldeployments.length = 0;
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/pools/p1" })).statusCode, 204);
  assert.equal(objects.modelpools.length, 0);
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/pools/p1" })).statusCode, 404);
});

test("GET /v1/deployments surfaces the served (capped) context window", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push({
    metadata: { name: "big-ctx" },
    spec: { poolRef: "p1", model: { contextTokens: 262144 } },
    status: { phase: "Ready", effectiveContextTokens: 32768 },
  });
  const app = buildServer(catalog, store);
  const d = (await app.inject({ method: "GET", url: "/v1/deployments" })).json().deployments[0];
  assert.equal(d.contextTokens, 262144);
  assert.equal(d.effectiveContextTokens, 32768);
});

test("POST /v1/deployments resolves catalog and creates CR", async () => {
  const { store, objects } = fakeStore();
  const app = buildServer(catalog, store);
  const res = await app.inject({
    method: "POST",
    url: "/v1/deployments",
    payload: { name: "qwen05b-api", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "cpu-default" },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(objects.modeldeployments.length, 1);
  assert.match(objects.modeldeployments[0].spec.model.source, /huggingface/);
});

test("POST /v1/deployments with unknown catalogId → 400", async () => {
  const app = buildServer(catalog, fakeStore().store);
  const res = await app.inject({
    method: "POST",
    url: "/v1/deployments",
    payload: { name: "x", catalogId: "nope", poolRef: "p" },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /v1/deployments with duplicate local name → 409", async () => {
  const { store } = fakeStore();
  const app = buildServer(catalog, store);
  const payload = { name: "qwen05b-api", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "cpu-default" };
  const first = await app.inject({ method: "POST", url: "/v1/deployments", payload });
  assert.equal(first.statusCode, 201);
  const second = await app.inject({ method: "POST", url: "/v1/deployments", payload });
  assert.equal(second.statusCode, 409);
  assert.match(second.json().error, /already exists/);
});

test("POST /v1/deployments rejects unknown engine, accepts sglang", async () => {
  const { store } = fakeStore();
  const app = buildServer(catalog, store);
  const bad = await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "d-bad", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "p", engine: "tgi" } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "d-sg", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "p", engine: "sglang" } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().spec.engine, "sglang");
});

test("PATCH /v1/deployments/:name accepts engine sglang", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push({ metadata: { name: "d-sg", namespace: "devproof-serving" },
    spec: { poolRef: "p", replicas: { min: 1, max: 1 }, engine: "auto" }, status: {} });
  const app = buildServer(catalog, store);
  const res = await app.inject({ method: "PATCH", url: "/v1/deployments/d-sg", payload: { engine: "sglang" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().spec.engine, "sglang");
});

test("PATCH /v1/deployments/:name engine auto overwrites previous sglang value", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push({ metadata: { name: "d-sg-clear", namespace: "devproof-serving" },
    spec: { poolRef: "p", replicas: { min: 1, max: 1 }, engine: "sglang" }, status: {} });
  const app = buildServer(catalog, store);
  const res = await app.inject({ method: "PATCH", url: "/v1/deployments/d-sg-clear", payload: { engine: "auto" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().spec.engine, "auto");
});

test("POST /v1/gateway/sync writes config with Ready deployments only", async () => {
  const { store, objects, getGatewayConfig } = fakeStore();
  objects.modeldeployments.push(
    { metadata: { name: "ready1", namespace: "devproof-serving" }, spec: {},
      status: { phase: "Ready", endpoint: "http://ready1.devproof-serving.svc.cluster.local:8080/v1/chat/completions" } },
    { metadata: { name: "pending1", namespace: "devproof-serving" }, spec: {}, status: { phase: "Deploying" } },
  );
  const app = buildServer(catalog, store);
  const res = await app.inject({ method: "POST", url: "/v1/gateway/sync" });
  assert.equal(res.json().routedModels, 1);
  assert.match(getGatewayConfig(), /model_name: ready1/);
  assert.doesNotMatch(getGatewayConfig(), /pending1/);
});

test("POST /v1/gateway/sync reports changed:false when config is identical", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push(
    { metadata: { name: "ready1", namespace: "devproof-serving" }, spec: {},
      status: { phase: "Ready", endpoint: "http://ready1.devproof-serving.svc.cluster.local:8080/v1/chat/completions" } },
  );
  const app = buildServer(catalog, store);
  const first = await app.inject({ method: "POST", url: "/v1/gateway/sync" });
  assert.equal(first.json().changed, true);
  const second = await app.inject({ method: "POST", url: "/v1/gateway/sync" });
  assert.equal(second.json().changed, false);
});

test("gateway sync releases a model only after the gateway rollout completes", async (t) => {
  // Live-bug 2026-07-12 (sesn_9c2w9st9bgby): one successful warmup through the
  // Service is not "routable" — during a rolling gateway reload, stale
  // replicas without the route stay in rotation for minutes, and a released
  // session's first request can round-robin onto one and 400. The warmup (and
  // the onModelRouted release) must wait for rollout completion.
  const { createServer } = await import("node:http");
  let warmHits = 0;
  const gw = createServer((_req, res) => {
    warmHits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", () => r()));
  process.env.DEVPROOF_GATEWAY_LOCAL_URL = `http://127.0.0.1:${(gw.address() as any).port}`;
  t.after(() => { delete process.env.DEVPROOF_GATEWAY_LOCAL_URL; gw.close(); });

  const { store, objects } = fakeStore();
  let finishRollout!: () => void;
  const rollout = new Promise<boolean>((r) => { finishRollout = () => r(true); });
  store.awaitGatewayRollout = () => rollout;
  objects.modeldeployments.push(
    { metadata: { name: "ready1", namespace: "devproof-serving" }, spec: {},
      status: { phase: "Ready", endpoint: "http://ready1.devproof-serving.svc.cluster.local:8080/v1/chat/completions" } },
  );
  const routed: string[] = [];
  const app = buildServer(catalog, store, undefined, undefined, { onModelRouted: (n) => routed.push(n) });
  await app.inject({ method: "POST", url: "/v1/gateway/sync" });

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(warmHits, 0);      // rollout still in flight → no warmup fired
  assert.deepEqual(routed, []);   // → and nothing released
  finishRollout();
  for (let i = 0; i < 200 && routed.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(routed, ["ready1"]);
  assert.ok(warmHits >= 1, "warmup completion ran after the rollout finished");
});

function fakeExternals() {
  const rows: any[] = [];
  let seq = 0;
  const externals = {
    async create(d: any) {
      const row = { id: `mdep_t${seq++}`, name: d.name, provider: d.provider,
        base_url: d.baseUrl ?? null, model_id: d.modelId, key_version: 1, has_key: d.hasKey,
        reasoning_effort: d.reasoningEffort ?? null, context_tokens: d.contextTokens };
      rows.push(row); return row;
    },
    async list() { return rows; },
    async get(id: string) { return rows.find((r) => r.id === id) ?? null; },
    async getByName(name: string) { return rows.find((r) => r.name === name) ?? null; },
    async update(id: string, p: any) {
      const r = rows.find((x) => x.id === id);
      if (!r) return null;
      if (p.baseUrl !== undefined) r.base_url = p.baseUrl;
      if (p.modelId !== undefined) r.model_id = p.modelId;
      if (p.reasoningEffort !== undefined) r.reasoning_effort = p.reasoningEffort;
      if (p.contextTokens !== undefined) r.context_tokens = p.contextTokens;
      if (p.rotateKey) { r.key_version++; r.has_key = true; }
      return r;
    },
    async delete(id: string) {
      const i = rows.findIndex((x) => x.id === id);
      return i >= 0 ? rows.splice(i, 1)[0] : null;
    },
  };
  return { externals, rows };
}

test("external deployment lifecycle: create routes gateway, delete unroutes", async () => {
  const { store, getGatewayConfig, providerKeys } = fakeStore();
  const { externals } = fakeExternals();
  const app = buildServer(catalog, store, undefined, externals);
  const res = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "gpt4o", provider: "openai", modelId: "gpt-4o", apiKey: "sk-secret", contextTokens: 128000 } });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.apiKey, undefined);              // never echoed
  assert.ok(providerKeys[`DEVPROOF_EP_${body.id.replace(/[^A-Za-z0-9_]/g, "_")}`]); // secret written
  assert.match(getGatewayConfig(), /gpt4o/);          // sync ran
  assert.match(getGatewayConfig(), /os\.environ\/DEVPROOF_EP_/);

  const del = await app.inject({ method: "DELETE", url: `/v1/deployments/external/${body.id}` });
  assert.equal(del.statusCode, 204);
  assert.doesNotMatch(getGatewayConfig(), /gpt4o/);   // re-synced
  assert.equal(Object.keys(providerKeys).length, 0);  // secret entry removed

  // Unconditional cleanup heals the PATCH first-key-add window: a Secret entry can be
  // staged for a row while has_key is still false. DELETE must still remove it.
  const created = (await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "noKeyYet", provider: "openai", modelId: "gpt-4o", contextTokens: 128000 } })).json();
  assert.equal(created.has_key, false);
  await store.writeProviderKey("DEVPROOF_EP_" + created.id.replace(/[^A-Za-z0-9_]/g, "_"), "sk-orphan");
  const del2 = await app.inject({ method: "DELETE", url: `/v1/deployments/external/${created.id}` });
  assert.equal(del2.statusCode, 204);
  assert.equal(Object.keys(providerKeys).length, 0);
});

test("external create validates: custom needs baseUrl, name collisions 409", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push({ metadata: { name: "taken", namespace: "devproof-serving" }, spec: {}, status: {} });
  const { externals } = fakeExternals();
  const app = buildServer(catalog, store, undefined, externals);
  const noUrl = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "x", provider: "custom", modelId: "m" } });
  assert.equal(noUrl.statusCode, 400);
  const collide = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "taken", provider: "openai", modelId: "gpt-4o", contextTokens: 128000 } });
  assert.equal(collide.statusCode, 409);
  const badProvider = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "y", provider: "bedrock", modelId: "m" } });
  assert.equal(badProvider.statusCode, 400);
});

test("external contextTokens is mandatory (fix wave L): missing/out-of-range 400, valid 201 and stored", async () => {
  const { store } = fakeStore();
  const { externals } = fakeExternals();
  const app = buildServer(catalog, store, undefined, externals);
  const missing = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "ctx-missing", provider: "openai", modelId: "gpt-4o" } });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.json().error, /contextTokens/);
  const tooSmall = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "ctx-small", provider: "openai", modelId: "gpt-4o", contextTokens: 1023 } });
  assert.equal(tooSmall.statusCode, 400);
  const tooBig = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "ctx-big", provider: "openai", modelId: "gpt-4o", contextTokens: 2000001 } });
  assert.equal(tooBig.statusCode, 400);
  const notInt = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "ctx-float", provider: "openai", modelId: "gpt-4o", contextTokens: 1024.5 } });
  assert.equal(notInt.statusCode, 400);
  const ok = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "ctx-ok", provider: "openai", modelId: "gpt-4o", contextTokens: 200000 } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().context_tokens, 200000);
  const list = (await app.inject({ method: "GET", url: "/v1/deployments" })).json();
  assert.equal(list.deployments.find((d: any) => d.name === "ctx-ok").contextTokens, 200000);
  // PATCH: valid value updates; out-of-range 400
  const upd = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${ok.json().id}`,
    payload: { contextTokens: 300000 } });
  assert.equal(upd.statusCode, 200);
  assert.equal(upd.json().context_tokens, 300000);
  const badUpd = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${ok.json().id}`,
    payload: { contextTokens: 500 } });
  assert.equal(badUpd.statusCode, 400);
});

test("external reasoningEffort: free text with sanity check; custom allowed; trim; PATCH semantics", async () => {
  const { store } = fakeStore();
  const { externals } = fakeExternals();
  const app = buildServer(catalog, store, undefined, externals);
  // sanity rejections: whitespace inside, overlong, non-string
  for (const bad of ["very high", "x\thigh", "a".repeat(33), 42]) {
    const res = await app.inject({ method: "POST", url: "/v1/deployments/external",
      payload: { name: "rr-bad", provider: "openai", modelId: "gpt-5.1", reasoningEffort: bad } });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.match(res.json().error, /reasoningEffort/);
  }
  // vendor vocab passes: xhigh; value is trimmed before storing
  const ok = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "rr1", provider: "openai", modelId: "gpt-5.1", reasoningEffort: " xhigh ", contextTokens: 128000 } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().reasoning_effort, "xhigh");
  const id = ok.json().id;
  // merged view exposes camelCase
  const list = (await app.inject({ method: "GET", url: "/v1/deployments" })).json();
  assert.equal(list.deployments.find((d: any) => d.name === "rr1").reasoningEffort, "xhigh");
  // custom provider now accepts a value (extra_body path applies it at the gateway)
  const cust = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "rr2", provider: "custom", baseUrl: "http://h:1/v1", modelId: "m", reasoningEffort: "none", contextTokens: 128000 } });
  assert.equal(cust.statusCode, 201);
  assert.equal(cust.json().reasoning_effort, "none");
  // PATCH: set, omitted-noop, null-clears, sanity 400
  const upd = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${id}`,
    payload: { reasoningEffort: "max" } });
  assert.equal(upd.json().reasoning_effort, "max");
  const noop = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${id}`,
    payload: { modelId: "gpt-5.2" } });
  assert.equal(noop.json().reasoning_effort, "max");
  const clear = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${id}`,
    payload: { reasoningEffort: null } });
  assert.equal(clear.json().reasoning_effort, null);
  const badPatch = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${id}`,
    payload: { reasoningEffort: "two words" } });
  assert.equal(badPatch.statusCode, 400);
});

test("local deployment create 409s on external name collision and rejects reserved name", async () => {
  const { store } = fakeStore();
  const { externals } = fakeExternals();
  await externals.create({ name: "shared", provider: "openai", modelId: "gpt-4o", hasKey: false });
  const app = buildServer(catalog, store, undefined, externals);
  const collide = await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "shared", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "cpu-default" } });
  assert.equal(collide.statusCode, 409);
  const reservedLocal = await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "external", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "cpu-default" } });
  assert.equal(reservedLocal.statusCode, 400);
  const reserved = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "external", provider: "openai", modelId: "gpt-4o" } });
  assert.equal(reserved.statusCode, 400);
});

test("GET /v1/deployments merges external rows with kind tags", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push({ metadata: { name: "local1", namespace: "devproof-serving" }, spec: { poolRef: "p" },
    status: { phase: "Ready", endpoint: "http://local1.devproof-serving.svc.cluster.local:8080/v1/chat/completions" } });
  const { externals } = fakeExternals();
  await externals.create({ name: "ext1", provider: "anthropic", modelId: "claude-sonnet-5", hasKey: true });
  const app = buildServer(catalog, store, undefined, externals);
  const res = await app.inject({ method: "GET", url: "/v1/deployments" });
  const { deployments, count } = res.json();
  assert.equal(count, 2);
  const ext1 = deployments.find((d: any) => d.name === "ext1");
  assert.equal(ext1.kind, "external");
  assert.equal(ext1.phase, "External");
  assert.equal(ext1.provider, "anthropic");
  assert.equal(deployments.find((d: any) => d.name === "local1").kind, "local");
});

test("PATCH /v1/deployments/:name whitelists operational fields", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push({ metadata: { name: "local1", namespace: "devproof-serving" },
    spec: { poolRef: "p", replicas: { min: 1, max: 2 }, model: { source: "s", format: "gguf", contextTokens: 8192 } }, status: {} });
  const app = buildServer(catalog, store, undefined, fakeExternals().externals);
  const ok = await app.inject({ method: "PATCH", url: "/v1/deployments/local1",
    payload: { replicas: { min: 2, max: 4 }, contextTokens: 16384 } });
  assert.equal(ok.statusCode, 200);
  const cr = objects.modeldeployments[0];
  assert.equal(cr.spec.replicas.max, 4);
  assert.equal(cr.spec.model.contextTokens, 16384);
  assert.equal(cr.spec.model.source, "s"); // merge preserved siblings

  const bad = await app.inject({ method: "PATCH", url: "/v1/deployments/local1",
    payload: { poolRef: "gpu" } });
  assert.equal(bad.statusCode, 400);
  const missing = await app.inject({ method: "PATCH", url: "/v1/deployments/nope", payload: { contextTokens: 1 } });
  assert.equal(missing.statusCode, 404);
});

test("PATCH /v1/deployments/:name allows poolRef when the target pool exists", async () => {
  const { store, objects } = fakeStore();
  objects.modelpools.push({ metadata: { name: "p2", namespace: "devproof-serving" }, spec: {} });
  objects.modeldeployments.push({ metadata: { name: "local1", namespace: "devproof-serving" },
    spec: { poolRef: "p" }, status: {} });
  const app = buildServer(catalog, store, undefined, fakeExternals().externals);

  const ok = await app.inject({ method: "PATCH", url: "/v1/deployments/local1", payload: { poolRef: "p2" } });
  assert.equal(ok.statusCode, 200);
  const cr = objects.modeldeployments[0];
  assert.equal(cr.spec.poolRef, "p2");

  const bad = await app.inject({ method: "PATCH", url: "/v1/deployments/local1", payload: { poolRef: "nope" } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /unknown pool/);
});

test("PATCH external updates fields, rotates keys two-phase, 404s unknown ids", async () => {
  const { store, providerKeys } = fakeStore();
  const { externals } = fakeExternals();
  const app = buildServer(catalog, store, undefined, externals);
  const created = (await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "r1", provider: "openai", modelId: "gpt-4o", contextTokens: 128000 } })).json();

  const upd = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${created.id}`,
    payload: { modelId: "gpt-4o-mini", apiKey: "sk-new" } });
  assert.equal(upd.statusCode, 200);
  assert.equal(upd.json().model_id, "gpt-4o-mini");
  assert.equal(upd.json().key_version, 2);
  assert.equal(providerKeys[`DEVPROOF_EP_${created.id.replace(/[^A-Za-z0-9_]/g, "_")}`], "sk-new");

  const missing = await app.inject({ method: "PATCH", url: "/v1/deployments/external/mdep_nope",
    payload: { modelId: "x" } });
  assert.equal(missing.statusCode, 404);
});

test("rotation secret failure leaves the row un-rotated", async () => {
  const { store, providerKeys } = fakeStore();
  const { externals, rows } = fakeExternals();
  (store as any).writeProviderKey = async () => { throw new Error("k8s down"); };
  const app = buildServer(catalog, store, undefined, externals);
  const created = (await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "r2", provider: "openai", modelId: "gpt-4o", contextTokens: 128000 } })).json();  // no key at create → no secret write
  const res = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${created.id}`,
    payload: { apiKey: "sk-boom" } });
  assert.equal(res.statusCode, 500);
  const row = rows.find((r: any) => r.id === created.id)!;
  assert.equal(row.key_version, 1);
  assert.equal(row.has_key, false);
  assert.equal(Object.keys(providerKeys).length, 0);
});

test("create rolls back the row when the secret write fails", async () => {
  const { store, providerKeys } = fakeStore();
  const { externals } = fakeExternals();
  (store as any).writeProviderKey = async () => { throw new Error("k8s down"); };
  const app = buildServer(catalog, store, undefined, externals);
  const res = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "rb", provider: "openai", modelId: "gpt-4o", apiKey: "sk-x", contextTokens: 128000 } });
  assert.equal(res.statusCode, 500);
  assert.equal(await externals.getByName("rb"), null);   // row rolled back
  assert.equal(Object.keys(providerKeys).length, 0);     // no orphaned credential
});

test("deployment replicas validation: reserve bounds and integer checks", async () => {
  const { store, objects } = fakeStore();
  objects.modelpools.push({ metadata: { name: "cpu-default" }, spec: {} });
  const app = buildServer(catalog, store);
  const post = (replicas: any) => app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: `r${Math.random().toString(36).slice(2, 8)}`, catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "cpu-default", replicas } });
  assert.equal((await post({ min: 2, max: 1 })).statusCode, 400);
  assert.equal((await post({ min: 0, max: 0 })).statusCode, 400);
  assert.equal((await post({ min: 1, max: 3, reserve: 3 })).statusCode, 400); // > max - min
  assert.equal((await post({ min: 1, max: 1, reserve: 1 })).statusCode, 400); // fixed size => reserve 0
  assert.equal((await post({ min: 1.5, max: 3 })).statusCode, 400);
  const ok = await post({ min: 1, max: 3, reserve: 2 });
  assert.equal(ok.statusCode, 201);
  assert.deepEqual(ok.json().spec.replicas, { min: 1, max: 3, reserve: 2 });
});

test("deployment replicas validation: idleMinutes only with min 0, integer 1-1440", async () => {
  const { store, objects } = fakeStore();
  objects.modelpools.push({ metadata: { name: "cpu-default" }, spec: {} });
  const app = buildServer(catalog, store);
  const post = (replicas: any) => app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: `r${Math.random().toString(36).slice(2, 8)}`, catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "cpu-default", replicas } });
  const ok = await post({ min: 0, max: 2, idleMinutes: 30 });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().spec.replicas.idleMinutes, 30);
  const wrongMin = await post({ min: 1, max: 2, idleMinutes: 30 });
  assert.equal(wrongMin.statusCode, 400);
  assert.equal(wrongMin.json().error, "replicas: idleMinutes only applies with min 0");
  const outOfRange = await post({ min: 0, max: 2, idleMinutes: 0 });
  assert.equal(outOfRange.statusCode, 400);
  assert.equal(outOfRange.json().error, "replicas: idleMinutes must be an integer 1-1440");
});

test("PATCH /v1/deployments/:name carries idleMinutes into spec.replicas", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push({ metadata: { name: "d-idle", namespace: "devproof-serving" },
    spec: { poolRef: "p", replicas: { min: 1, max: 1 } }, status: {} });
  const app = buildServer(catalog, store);
  const res = await app.inject({ method: "PATCH", url: "/v1/deployments/d-idle",
    payload: { replicas: { min: 0, max: 1, idleMinutes: 5 } } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().spec.replicas, { min: 0, max: 1, reserve: 0, idleMinutes: 5 });
});

test("pool budget blocks over-committing deploys and edits", async () => {
  const { store, objects } = fakeStore();
  objects.modelpools.push({ metadata: { name: "small" }, spec: { maxNodes: 3 } });
  objects.modeldeployments.push({ metadata: { name: "d1" },
    spec: { poolRef: "small", replicas: { min: 1, max: 2 } }, status: {} });
  const app = buildServer(catalog, store);
  const blocked = await app.inject({ method: "POST", url: "/v1/deployments", payload: {
    name: "d2", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "small", replicas: { min: 1, max: 2 } } });
  assert.equal(blocked.statusCode, 400);
  assert.equal(blocked.json().error, "pool small: committed max replicas 2 + requested 2 exceeds budget 3");
  assert.equal((await app.inject({ method: "POST", url: "/v1/deployments", payload: {
    name: "d2", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "small", replicas: { min: 1, max: 1 } } })).statusCode, 201);
  // raising d1's max to 3 would make 3 + 1 > 3
  const editUp = await app.inject({ method: "PATCH", url: "/v1/deployments/d1",
    payload: { replicas: { min: 1, max: 3 } } });
  assert.equal(editUp.statusCode, 400);
  assert.equal(editUp.json().error, "pool small: committed max replicas 1 + requested 3 exceeds budget 3");
  // same max stays fine (own committed excluded)
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/deployments/d1",
    payload: { replicas: { min: 1, max: 2 } } })).statusCode, 200);
});

test("deployments expose queueDepth from CR status (-1/missing => null, 0 is a value)", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push(
    { metadata: { name: "a" }, spec: {}, status: { queueDepth: 0 } },
    { metadata: { name: "b" }, spec: {}, status: { queueDepth: -1 } },
    { metadata: { name: "c" }, spec: {}, status: {} },
  );
  const app = buildServer(catalog, store);
  const rows = (await app.inject({ method: "GET", url: "/v1/deployments" })).json().deployments;
  assert.equal(rows.find((d: any) => d.name === "a").queueDepth, 0);
  assert.equal(rows.find((d: any) => d.name === "b").queueDepth, null);
  assert.equal(rows.find((d: any) => d.name === "c").queueDepth, null);
});

test("GET /v1/deployments exposes contextTokens on local rows", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push(
    { metadata: { name: "d-ctx" }, spec: { poolRef: "p1", model: { contextTokens: 8192 } }, status: {} },
    { metadata: { name: "d-noctx" }, spec: { poolRef: "p1", model: {} }, status: {} },
  );
  const app = buildServer(catalog, store);
  const res = await app.inject({ method: "GET", url: "/v1/deployments" });
  const rows = res.json().deployments;
  assert.equal(rows.find((d: any) => d.name === "d-ctx").contextTokens, 8192);
  assert.equal(rows.find((d: any) => d.name === "d-noctx").contextTokens, null);
});

test("deployment resources: POST validates + overrides, PATCH merges without dropping gpu", async () => {
  const { store, objects } = fakeStore();
  objects.modelpools.push({ metadata: { name: "p1" }, spec: {} });
  const app = buildServer(catalog, store);
  const bad = await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "d1", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "p1", resources: { cpu: "two" } } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /resources\.cpu/);
  const created = await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "d1", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "p1", resources: { memory: "6Gi" } } });
  assert.equal(created.statusCode, 201);
  // catalog cpu ("2") + request memory override
  assert.deepEqual(objects.modeldeployments[0].spec.resources, { cpu: "2", memory: "6Gi" });

  // Simulate a GPU deployment: gpu must survive a cpu/memory PATCH (merge-patch).
  objects.modeldeployments[0].spec.resources = { gpu: "1", cpu: "2", memory: "6Gi" };
  const patched = await app.inject({ method: "PATCH", url: "/v1/deployments/d1",
    payload: { resources: { cpu: "3", memory: "8Gi" } } });
  assert.equal(patched.statusCode, 200);
  assert.deepEqual(objects.modeldeployments[0].spec.resources, { gpu: "1", cpu: "3", memory: "8Gi" });

  const badPatch = await app.inject({ method: "PATCH", url: "/v1/deployments/d1",
    payload: { resources: { memory: "8GB" } } });
  assert.equal(badPatch.statusCode, 400);

  // Projection: the edit modal prefills from the deployment's ACTUAL values.
  const rows = (await app.inject({ method: "GET", url: "/v1/deployments" })).json().deployments;
  assert.deepEqual(rows.find((d: any) => d.name === "d1").resources, { gpu: "1", cpu: "3", memory: "8Gi" });
});

function fakeCustom() {
  const rows: any[] = [];
  return {
    async list() { return [...rows]; },
    // Mirrors repo.ts createCatalogModel: INSERT … ON CONFLICT (id) DO UPDATE (an upsert).
    async create(e: any) {
      const i = rows.findIndex((r) => r.id === e.id);
      if (i >= 0) rows[i] = e; else rows.push(e);
      return e;
    },
    async delete(id: string) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
  };
}

test("PATCH /v1/catalog/:id updates a custom model in place", async () => {
  const app = buildServer(catalog, fakeStore().store, fakeCustom());
  await app.inject({ method: "POST", url: "/v1/catalog",
    payload: { id: "my-model-custom", displayName: "My Model", source: "https://hf.co/x.gguf", format: "gguf", resources: { cpu: "1", memory: "2Gi" } } });
  const res = await app.inject({ method: "PATCH", url: "/v1/catalog/my-model-custom",
    payload: { displayName: "My Model v2", contextTokens: 8192 } });
  assert.equal(res.statusCode, 200);
  const { models } = (await app.inject({ method: "GET", url: "/v1/catalog" })).json();
  const m = models.find((x: any) => x.id === "my-model-custom");
  assert.equal(m.displayName, "My Model v2");
  assert.equal(m.contextTokens, 8192);
  assert.equal(m.custom, true);
  assert.equal(!!m.overridden, false);
  assert.equal(m.source, "https://hf.co/x.gguf"); // untouched fields preserved
});

test("catalog releaseDate is validated as YYYY-MM-DD", async () => {
  const app = buildServer(catalog, fakeStore().store, fakeCustom());
  for (const bad of ["garbage", "2026-13-40", "07/12/2026", 20260712]) {
    const res = await app.inject({ method: "PATCH", url: "/v1/catalog/qwen2.5-0.5b-instruct-q4",
      payload: { releaseDate: bad } });
    assert.equal(res.statusCode, 400, `accepted ${JSON.stringify(bad)}`);
    assert.match(res.json().error, /releaseDate/);
  }
  const post = await app.inject({ method: "POST", url: "/v1/catalog",
    payload: { id: "rd-custom", displayName: "RD", source: "https://hf.co/x.gguf", format: "gguf", releaseDate: "not-a-date", resources: { cpu: "1", memory: "2Gi" } } });
  assert.equal(post.statusCode, 400);
  const ok = await app.inject({ method: "PATCH", url: "/v1/catalog/qwen2.5-0.5b-instruct-q4",
    payload: { releaseDate: "2026-07-12" } });
  assert.equal(ok.statusCode, 200);
  const { models } = (await app.inject({ method: "GET", url: "/v1/catalog" })).json();
  assert.equal(models.find((x: any) => x.id === "qwen2.5-0.5b-instruct-q4").releaseDate, "2026-07-12");
});

test("PATCH bundled id creates a DB override; DELETE resets to YAML", async () => {
  const id = "qwen2.5-0.5b-instruct-q4";
  const orig = catalog.find((e) => e.id === id)!;
  const app = buildServer(catalog, fakeStore().store, fakeCustom());
  const res = await app.inject({ method: "PATCH", url: `/v1/catalog/${id}`,
    payload: { displayName: "Qwen (site override)", capacityProfiles: [
      { gpuType: "nvidia-a100", instanceType: "p4d.24xlarge", gpusPerReplica: 1, vramGB: 40, estTokensPerSec: 90, costPerHourUSD: 4.1 },
    ] } });
  assert.equal(res.statusCode, 200);
  let { models } = (await app.inject({ method: "GET", url: "/v1/catalog" })).json();
  let m = models.find((x: any) => x.id === id);
  assert.equal(m.displayName, "Qwen (site override)");
  assert.equal(m.overridden, true);
  assert.equal(m.custom, false);                       // bundled origin, not user-added
  assert.equal(m.source, orig.source);                 // unpatched fields come from YAML
  assert.equal(m.capacityProfiles[0].gpuType, "nvidia-a100");

  const del = await app.inject({ method: "DELETE", url: `/v1/catalog/${id}` });
  assert.equal(del.statusCode, 204);
  ({ models } = (await app.inject({ method: "GET", url: "/v1/catalog" })).json());
  m = models.find((x: any) => x.id === id);
  assert.equal(m.displayName, orig.displayName);       // YAML entry reappears
  assert.equal(!!m.overridden, false);
});

test("PATCH /v1/catalog validation: 404 unknown, 400 immutable id, 501 without custom store", async () => {
  const app = buildServer(catalog, fakeStore().store, fakeCustom());
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/catalog/nope", payload: { displayName: "x" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/catalog/qwen2.5-0.5b-instruct-q4", payload: { id: "new-id" } })).statusCode, 400);
  const noCustom = buildServer(catalog, fakeStore().store);
  assert.equal((await noCustom.inject({ method: "PATCH", url: "/v1/catalog/qwen2.5-0.5b-instruct-q4", payload: { displayName: "x" } })).statusCode, 501);
});

test("GET /v1/deployments/:name returns the single merged entry, 404 otherwise", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push({
    metadata: { name: "dep-one", namespace: "devproof-serving" },
    spec: { catalogId: "qwen2.5-0.5b-instruct-q4", replicas: { min: 1, max: 2 } },
    status: { phase: "Ready", endpoint: "http://dep-one.devproof-serving.svc:8080/v1/chat/completions", readyReplicas: 1 },
  });
  const app = buildServer(catalog, store);
  const hit = await app.inject({ method: "GET", url: "/v1/deployments/dep-one" });
  assert.equal(hit.statusCode, 200);
  assert.equal(hit.json().name, "dep-one");
  assert.equal(hit.json().kind, "local");
  assert.equal(hit.json().replicas.max, 2);
  const miss = await app.inject({ method: "GET", url: "/v1/deployments/nope-missing" });
  assert.equal(miss.statusCode, 404);
});

test("external test probe sends reasoning in the provider-native slot", async (t) => {
  const { createServer } = await import("node:http");
  const seen: { path: string | undefined; body: any }[] = [];
  let status = 200;
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? JSON.stringify({ ok: true })
                             : JSON.stringify({ error: { message: "Invalid value: 'hgih'" } }));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const { store } = fakeStore();
  const app = buildServer(catalog, store, undefined, fakeExternals().externals);

  // custom → flat reasoning_effort on /chat/completions
  const custom = await app.inject({ method: "POST", url: "/v1/deployments/external/test",
    payload: { provider: "custom", baseUrl: base, modelId: "m1", reasoningEffort: "high" } });
  assert.equal(custom.json().ok, true);
  assert.match(custom.json().detail, /reasoning accepted/);
  assert.equal(seen[0].path, "/chat/completions");
  assert.equal(seen[0].body.reasoning_effort, "high");
  assert.equal(seen[0].body.max_tokens, 16);

  // openrouter → nested reasoning.effort, no flat param
  const router = await app.inject({ method: "POST", url: "/v1/deployments/external/test",
    payload: { provider: "openrouter", baseUrl: base, modelId: "m1", reasoningEffort: "xhigh" } });
  assert.equal(router.json().ok, true);
  assert.deepEqual(seen[1].body.reasoning, { effort: "xhigh" });
  assert.equal(seen[1].body.reasoning_effort, undefined);

  // anthropic → /v1/messages with output_config.effort
  const ant = await app.inject({ method: "POST", url: "/v1/deployments/external/test",
    payload: { provider: "anthropic", baseUrl: base, modelId: "claude-x", apiKey: "sk-a", reasoningEffort: "max" } });
  assert.equal(ant.json().ok, true);
  assert.equal(seen[2].path, "/v1/messages");
  assert.deepEqual(seen[2].body.output_config, { effort: "max" });

  // provider rejection surfaces status + body text
  status = 400;
  const bad = await app.inject({ method: "POST", url: "/v1/deployments/external/test",
    payload: { provider: "custom", baseUrl: base, modelId: "m1", reasoningEffort: "hgih" } });
  assert.equal(bad.json().ok, false);
  assert.match(bad.json().detail, /HTTP 400/);
  assert.match(bad.json().detail, /Invalid value/);

  // save-path sanity rule applies to the probe too
  const insane = await app.inject({ method: "POST", url: "/v1/deployments/external/test",
    payload: { provider: "custom", baseUrl: base, modelId: "m1", reasoningEffort: "very high" } });
  assert.equal(insane.json().ok, false);
  assert.match(insane.json().detail, /whitespace/);

  // reasoning set but no model id → reachability probe + hint
  status = 200;
  const noModel = await app.inject({ method: "POST", url: "/v1/deployments/external/test",
    payload: { provider: "custom", baseUrl: base, reasoningEffort: "high" } });
  assert.equal(noModel.json().ok, true);
  assert.match(noModel.json().detail, /enter a model id to validate reasoning/);
  assert.equal(seen[seen.length - 1].path, "/models");
});

test("POST /v1/deployments resolves reasoningEffort; GET exposes reasoning + options", async () => {
  const { store, objects } = fakeStore();
  const app = buildServer(catalog, store);
  const bad = await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "r-bad", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "p", reasoningEffort: "low" } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /does not support configurable reasoning/);
  const res = await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "r-ok", catalogId: "qwen3-4b-q4", poolRef: "p", reasoningEffort: "medium" } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(objects.modeldeployments[0].spec.reasoning, { effort: "medium", budgetTokens: 4096 });
  const list = (await app.inject({ method: "GET", url: "/v1/deployments" })).json().deployments;
  const row = list.find((d: any) => d.name === "r-ok");
  assert.deepEqual(row.reasoning, { effort: "medium", budgetTokens: 4096 });
  assert.deepEqual(row.reasoningOptions, { off: 0, low: 1024, medium: 4096, high: 16384 });
  // Non-reasoning deployment: both null.
  await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "r-plain", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "p" } });
  const plain = (await app.inject({ method: "GET", url: "/v1/deployments" })).json()
    .deployments.find((d: any) => d.name === "r-plain");
  assert.equal(plain.reasoning, null);
  assert.equal(plain.reasoningOptions, null);
});

test("PATCH /v1/deployments/:name sets, validates, and clears reasoningEffort", async () => {
  const { store, objects } = fakeStore();
  const app = buildServer(catalog, store);
  await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "r-edit", catalogId: "qwen3-4b-q4", poolRef: "p" } });
  const set = await app.inject({ method: "PATCH", url: "/v1/deployments/r-edit",
    payload: { reasoningEffort: "off" } });
  assert.equal(set.statusCode, 200);
  assert.deepEqual(set.json().spec.reasoning, { effort: "off", budgetTokens: 0 });
  const unknown = await app.inject({ method: "PATCH", url: "/v1/deployments/r-edit",
    payload: { reasoningEffort: "turbo" } });
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.json().error, /unknown reasoning effort/);
  const wrongEngine = await app.inject({ method: "PATCH", url: "/v1/deployments/r-edit",
    payload: { engine: "sglang", reasoningEffort: "low" } });
  assert.equal(wrongEngine.statusCode, 400);
  assert.match(wrongEngine.json().error, /llama\.cpp-only/);
  const clear = await app.inject({ method: "PATCH", url: "/v1/deployments/r-edit",
    payload: { reasoningEffort: null } });
  assert.equal(clear.statusCode, 200);
  assert.equal(objects.modeldeployments[0].spec.reasoning, undefined);
});

test("PATCH /v1/deployments/:name to a non-llama.cpp engine drops stale reasoning", async () => {
  const { store, objects } = fakeStore();
  const app = buildServer(catalog, store);
  await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "r-sg", catalogId: "qwen3-4b-q4", poolRef: "p", reasoningEffort: "low" } });
  const res = await app.inject({ method: "PATCH", url: "/v1/deployments/r-sg", payload: { engine: "sglang" } });
  assert.equal(res.statusCode, 200);
  assert.equal(objects.modeldeployments[0].spec.reasoning, undefined,
    "switching to sglang must clear the llama.cpp-only reasoning budget");
});

test("custom catalog validates the reasoning shape", async () => {
  const { store } = fakeStore();
  const app = buildServer(catalog, store, fakeCustom());
  const base = { id: "my-thinker", displayName: "My Thinker", source: "https://example.com/m.gguf", format: "gguf", resources: { cpu: "1", memory: "2Gi" } };
  for (const bad of [
    { efforts: {} },                          // empty
    { efforts: { low: -1 } },                 // negative
    { efforts: { low: 1.5 } },                // non-integer
    { efforts: { "": 5 } },                   // empty name
    { efforts: { ["x".repeat(17)]: 5 } },     // name too long
    { efforts: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9 } }, // > 8
    ["low"],                                  // not an object
  ]) {
    const res = await app.inject({ method: "POST", url: "/v1/catalog", payload: { ...base, reasoning: bad } });
    assert.equal(res.statusCode, 400, `should reject ${JSON.stringify(bad)}`);
  }
  const ok = await app.inject({ method: "POST", url: "/v1/catalog",
    payload: { ...base, reasoning: { efforts: { off: 0, deep: 20000 } } } });
  assert.equal(ok.statusCode, 201);
  assert.deepEqual(ok.json().reasoning, { efforts: { off: 0, deep: 20000 } });
  const patched = await app.inject({ method: "PATCH", url: "/v1/catalog/my-thinker",
    payload: { reasoning: { efforts: { low: 512 } } } });
  assert.equal(patched.statusCode, 200);
  assert.deepEqual(patched.json().reasoning, { efforts: { low: 512 } });
});

test("POST /v1/catalog requires valid resources", async () => {
  const app = buildServer(catalog, fakeStore().store, fakeCustom());
  const base = { id: "res-custom", displayName: "R", source: "https://hf.co/x.gguf", format: "gguf" };
  const missing = await app.inject({ method: "POST", url: "/v1/catalog", payload: base });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.json().error, /resources/);
  for (const bad of [
    { cpu: "2 cores", memory: "3Gi" }, { cpu: "2", memory: "3GB" },
    { cpu: "-1", memory: "3Gi" }, { cpu: "2" }, { cpu: "2", memory: "3Gi", gpu: "1" },
  ]) {
    const res = await app.inject({ method: "POST", url: "/v1/catalog", payload: { ...base, resources: bad } });
    assert.equal(res.statusCode, 400, `accepted ${JSON.stringify(bad)}`);
    assert.match(res.json().error, /resources/);
  }
  const ok = await app.inject({ method: "POST", url: "/v1/catalog",
    payload: { ...base, resources: { cpu: "500m", memory: "3Gi" } } });
  assert.equal(ok.statusCode, 201);
  assert.deepEqual(ok.json().resources, { cpu: "500m", memory: "3Gi" });
});

test("PATCH /v1/catalog validates resources when sent", async () => {
  const app = buildServer(catalog, fakeStore().store, fakeCustom());
  const bad = await app.inject({ method: "PATCH", url: "/v1/catalog/qwen2.5-0.5b-instruct-q4",
    payload: { resources: { cpu: "2", memory: "3GB" } } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: "PATCH", url: "/v1/catalog/qwen2.5-0.5b-instruct-q4",
    payload: { resources: { cpu: "3", memory: "4Gi" } } });
  assert.equal(ok.statusCode, 200);
  const { models } = (await app.inject({ method: "GET", url: "/v1/catalog" })).json();
  assert.deepEqual(models.find((x: any) => x.id === "qwen2.5-0.5b-instruct-q4").resources,
    { cpu: "3", memory: "4Gi" });
});
