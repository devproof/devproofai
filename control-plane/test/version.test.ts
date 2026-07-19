// GET /v1/version: env-driven build version, "dev" fallback out-of-cluster
// (reproducible-builds spec 2026-07-18).
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { registerAgentRoutes, type Orchestrator } from "../src/agents-api.ts";
import { localFileStore } from "../src/filestore.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

async function build() {
  const repo = new Repo(pool);
  const root = mkdtempSync(join(tmpdir(), "version-test-"));
  const files = localFileStore(root);
  const app = Fastify();
  await registerAgentRoutes(app, repo, {} as unknown as Orchestrator, files);
  return { app, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("GET /v1/version returns the baked env version", async () => {
  process.env.DEVPROOF_VERSION = "v9.9.9-test";
  const { app, cleanup } = await build();
  try {
    const res = await app.inject({ method: "GET", url: "/v1/version" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { version: "v9.9.9-test" });
  } finally {
    delete process.env.DEVPROOF_VERSION;
    await app.close();
    cleanup();
  }
});

test("GET /v1/version falls back to dev without the env", async () => {
  delete process.env.DEVPROOF_VERSION;
  const { app, cleanup } = await build();
  try {
    const res = await app.inject({ method: "GET", url: "/v1/version" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { version: "dev" });
  } finally {
    await app.close();
    cleanup();
  }
});
