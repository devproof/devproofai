import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createHash } from "node:crypto";
import { apiKeyAuth } from "../src/public-auth.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function makeRepo() {
  const keys: Record<string, { id: string; workspace_id: string }> = {
    [sha("dpk_good")]: { id: "apikey_1", workspace_id: "wrkspc_a" },
  };
  return {
    lookups: 0,
    touched: [] as string[],
    async findApiKeyBySecretHash(h: string) { this.lookups++; return keys[h] ?? null; },
    async touchApiKey(id: string) { this.touched.push(id); },
  };
}

async function makeApp(repo: any) {
  const app = Fastify();
  app.addHook("preHandler", apiKeyAuth(repo));
  app.get("/x", async (req) => ({ ws: (req as any).apiKey.workspaceId, key: (req as any).apiKey.id }));
  return app;
}

test("valid Bearer key attaches workspace from the key row", async () => {
  const app = await makeApp(makeRepo());
  const res = await app.inject({ method: "GET", url: "/x", headers: { authorization: "Bearer dpk_good" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ws: "wrkspc_a", key: "apikey_1" });
});

test("x-api-key header also accepted", async () => {
  const app = await makeApp(makeRepo());
  const res = await app.inject({ method: "GET", url: "/x", headers: { "x-api-key": "dpk_good" } });
  assert.equal(res.statusCode, 200);
});

test("missing / malformed / unknown key → 401", async () => {
  const app = await makeApp(makeRepo());
  for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: "Bearer dpk_bad" }] as any[]) {
    const res = await app.inject({ method: "GET", url: "/x", headers });
    assert.equal(res.statusCode, 401, JSON.stringify(headers));
    assert.deepEqual(res.json(), { error: "invalid API key" });
  }
});

// SECURITY (whole-branch review): duplicate headers arrive as string[] in
// Node/Fastify — .startsWith on an array threw a 500 instead of a normal 401.
test("duplicate authorization / x-api-key headers (string[]) yield 401, not 500", async () => {
  const app = await makeApp(makeRepo());
  const dupAuth = await app.inject({ method: "GET", url: "/x", headers: { authorization: ["Bearer dpk_bad", "Bearer dpk_bad2"] as any } });
  assert.equal(dupAuth.statusCode, 401);
  const dupApiKey = await app.inject({ method: "GET", url: "/x", headers: { "x-api-key": ["dpk_bad", "dpk_bad2"] as any } });
  assert.equal(dupApiKey.statusCode, 401);
  const good = await app.inject({ method: "GET", url: "/x", headers: { authorization: ["Bearer dpk_good"] as any } });
  assert.equal(good.statusCode, 200);
});

test("positive lookups are cached within TTL; touch is throttled", async () => {
  const repo = makeRepo();
  const app = await makeApp(repo);
  for (let i = 0; i < 3; i++) {
    await app.inject({ method: "GET", url: "/x", headers: { authorization: "Bearer dpk_good" } });
  }
  assert.equal(repo.lookups, 1);       // 2nd + 3rd hit the cache
  assert.equal(repo.touched.length, 1); // last_used_at throttled
});
