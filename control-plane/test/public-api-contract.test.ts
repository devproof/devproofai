// control-plane/test/public-api-contract.test.ts
// The public /api route table is a STABLE CONTRACT (spec 2026-07-12).
// A failure here means a breaking change to external clients — additions
// belong in the snapshot; removals/renames need /api/v2.
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerPublicApi } from "../src/public-api.ts";
import { publicFakes } from "./public-api.test.ts";

const SNAPSHOT = [
  "DELETE /api/agents/:id",
  "DELETE /api/environments/:id",
  "DELETE /api/files/:id",
  "DELETE /api/files/uploads/:id",
  "DELETE /api/memory-stores/:id",
  "DELETE /api/memory-stores/:id/entries",
  "DELETE /api/sessions/:id",
  "DELETE /api/skills/:id",
  "DELETE /api/vaults/:id",
  "DELETE /api/vaults/:id/credentials/:name",
  "DELETE /api/wikis/:id",
  "DELETE /api/wikis/:id/entries",
  "GET /api/agents",
  "GET /api/agents/:id",
  "GET /api/environments",
  "GET /api/files",
  "GET /api/files/:id",
  "GET /api/mcp-registry",
  "GET /api/memory-stores",
  "GET /api/memory-stores/:id/content",
  "GET /api/memory-stores/:id/tree",
  "GET /api/sessions",
  "GET /api/sessions/:id",
  "GET /api/sessions/:id/events",
  "GET /api/sessions/:id/resources",
  "GET /api/skills",
  "GET /api/skills/:id",
  "GET /api/vaults",
  "GET /api/vaults/:id",
  "GET /api/wikis",
  "GET /api/wikis/:id",
  "GET /api/wikis/:id/content",
  "GET /api/wikis/:id/tree",
  "PATCH /api/agents/:id",
  "PATCH /api/environments/:id",
  "PATCH /api/wikis/:id",
  "POST /api/agents",
  "POST /api/agents/:id/status",
  "POST /api/agents/:id/versions",
  "POST /api/environments",
  "POST /api/files",
  "POST /api/files/:id/content",
  "POST /api/files/uploads",
  "POST /api/files/uploads/:id/complete",
  "POST /api/files/uploads/:id/parts/:n",
  "POST /api/memory-stores",
  "POST /api/memory-stores/:id/entries",
  "POST /api/sessions",
  "POST /api/sessions/:id/events/stream",
  "POST /api/sessions/:id/interrupt",
  "POST /api/sessions/:id/messages",
  "POST /api/skills",
  "POST /api/vaults",
  "POST /api/vaults/:id/credentials",
  "POST /api/wikis",
  "POST /api/wikis/:id/entries",
];

test("public /api route table matches the contract snapshot", async () => {
  const routes: string[] = [];
  const app = Fastify();
  app.addHook("onRoute", (r) => {
    if (!r.url.startsWith("/api")) return;
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) if (m !== "HEAD" && m !== "OPTIONS") routes.push(`${m} ${r.url}`);
  });
  const f = publicFakes();
  await registerPublicApi(app, f.repo, f.orchestrator, f.files);
  assert.deepEqual([...new Set(routes)].sort(), SNAPSHOT);
});
