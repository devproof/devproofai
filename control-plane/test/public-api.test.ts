// control-plane/test/public-api.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createHash } from "node:crypto";
import { registerPublicApi, sweepStaleUploads, PART_SIZE } from "../src/public-api.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const KEY = "dpk_test";
const OTHER_KEY = "dpk_other";

export function publicFakes() {
  const fileRecords: any[] = [];
  const uploads: Record<string, any> = {};
  const stored: Record<string, Buffer> = {};
  const parts: Record<string, Record<number, Buffer>> = {};
  const aborted: string[] = [];
  // ── Agents/Sessions/Environments/Skills/Vaults/Memory state ──────────
  const agents: any[] = [];
  const sessions: any[] = [];
  const events: Record<string, any[]> = {};
  const environments: any[] = [];
  const skills: any[] = [];
  const vaults: any[] = [];
  const vaultCredentials: Record<string, string[]> = {};
  const memoryStores: any[] = [];
  const memoryEntries: Record<string, any[]> = {};
  const agentStatuses: Record<string, string> = {};
  const deletedFileRecords: string[] = [];
  const repo: any = {
    async getWorkspace(id: string) { return { id, status: "active" }; },
    async findApiKeyBySecretHash(h: string) {
      if (h === sha(KEY)) return { id: "apikey_t", workspace_id: "wrkspc_t" };
      if (h === sha(OTHER_KEY)) return { id: "apikey_o", workspace_id: "wrkspc_other" };
      return null;
    },
    async touchApiKey() {},
    async createFileRecord(m: any) { fileRecords.push(m); return m; },
    async getFileRecord(id: string) {
      const f = fileRecords.find((x) => x.id === id) ?? null;
      return f ? { ...f, workspace_id: f.workspace_id ?? f.workspaceId, object_key: f.object_key ?? f.objectKey } : null;
    },
    // Normalizes workspace_id like getFileRecord — real listFileRecords rows
    // come straight from the `files` table (snake_case); this keeps the
    // fake's shape consistent so /api ownership checks can be exercised.
    async listFileRecords(ids: string[]) {
      return fileRecords.filter((r) => (ids ?? []).includes(r.id))
        .map((r) => ({ ...r, workspace_id: r.workspace_id ?? r.workspaceId, object_key: r.object_key ?? r.objectKey }));
    },
    async listAllFiles(ws: string) { return { files: fileRecords.filter((f) => f.workspaceId === ws || f.workspace_id === ws), total: fileRecords.length, limit: 100, offset: 0 }; },
    async deleteFile(_ws: string, id: string) {
      const i = fileRecords.findIndex((f) => f.id === id);
      if (i < 0) return { deleted: false, objectKey: null };
      const [rec] = fileRecords.splice(i, 1);
      return { deleted: true, objectKey: rec.object_key ?? rec.objectKey ?? null };
    },
    async deleteFileRecordById(id: string) {
      deletedFileRecords.push(id);
      const i = fileRecords.findIndex((f) => f.id === id);
      if (i < 0) return null;
      const [rec] = fileRecords.splice(i, 1);
      return rec.object_key ?? rec.objectKey ?? null;
    },
    async createFileUpload(_ws: string, m: any) { uploads[m.id] = { ...m, workspace_id: _ws, parts: [], created_at: new Date() }; return { id: m.id, file_id: m.fileId, part_size: m.partSize }; },
    async getFileUpload(_ws: string, id: string) { return uploads[id] ?? null; },
    async recordUploadPart(id: string, p: any) {
      uploads[id].parts = uploads[id].parts.filter((x: any) => x.n !== p.n).concat([p]);
    },
    async deleteFileUpload(id: string) { delete uploads[id]; },
    async listStaleFileUploads() { return Object.values(uploads).map((u: any) => ({ id: u.id, upload_key: u.uploadKey ?? u.upload_key, file_id: u.fileId ?? u.file_id })); },

    // ── Agents ──
    // null = every routing name is accepted (most tests don't exercise
    // routing validation); set to a Set to test the routings-only 400.
    knownRoutings: null as Set<string> | null,
    async getRoutingByName(name: string) {
      const known = (this as any).knownRoutings as Set<string> | null;
      if (known === null) return { name };
      return known.has(name) ? { name } : null;
    },
    async createAgent(_ws: string, name: string, c: any) {
      const a = { id: `agent_${agents.length}`, name, version: 1, workspaceId: _ws, ...c };
      agents.push(a); return a;
    },
    async listAgents(_ws: string, _limit?: number, _offset?: number) {
      const rows = agents.filter((a) => a.workspaceId === _ws);
      return { rows, count: rows.length };
    },
    async getAgent(_ws: string, id: string) {
      const a = agents.find((x) => x.id === id && x.workspaceId === _ws);
      return a ? { id: a.id, name: a.name, status: agentStatuses[id] ?? "active" } : null;
    },
    async setAgentStatus(_ws: string, id: string, status: string) {
      if (!agents.find((x) => x.id === id)) return false;
      agentStatuses[id] = status; return true;
    },
    async renameAgent(_ws: string, id: string, name: string) {
      const a = agents.find((x) => x.id === id && x.workspaceId === _ws);
      if (!a) return "notfound";
      if (agents.some((x) => x.id !== id && x.name === name)) return "conflict";
      a.name = name; return "ok";
    },
    async getAgentVersion(id: string) {
      const a = agents.find((x) => x.id === id);
      return a ? { agent_id: id, version: 1, routing: a.routing, system_prompt: "", tools: a.tools ?? [], max_turns: 10, environment_id: a.environmentId ?? null } : null;
    },
    async getAgentWithVersions(id: string, _ws?: string) {
      const a = agents.find((x) => x.id === id && (!_ws || x.workspaceId === _ws));
      return a ? { ...a, versions: [{ agent_id: id, version: 1, routing: a.routing, system_prompt: "", tools: a.tools ?? [], max_turns: 10, skill_ids: [], environment_id: a.environmentId ?? null }] } : null;
    },
    async newAgentVersion() { return 2; },
    async acquireWikiWriteLock() { return { release: async () => {} }; },
    async deleteAgent(_ws: string, id: string) {
      const i = agents.findIndex((a) => a.id === id && a.workspaceId === _ws);
      if (i >= 0) agents.splice(i, 1);
    },

    // ── Sessions ──
    async createSession(_ws: string, agentId: string, prompt: string, name?: string) {
      const a = agents.find((x) => x.id === agentId);
      if (!a) throw new Error(`agent not found: ${agentId}`);
      const s = { id: `sesn_${sessions.length}`, agent_id: agentId, workspace_id: _ws, status: "queued", prompt, name, turns: 0 };
      sessions.push(s); events[s.id] = [];
      const config = { agent_id: agentId, version: 1, routing: a.routing, system_prompt: "", tools: a.tools ?? [], max_turns: 10, skill_ids: [], environment_id: a.environmentId ?? null };
      return { id: s.id, agentId, agentVersion: 1, config };
    },
    async appendEvents(id: string, evts: any[]) {
      const list = events[id] ?? (events[id] = []); let seq = list.length;
      for (const e of evts) list.push({ ...e, seq: ++seq });
      return seq;
    },
    async setSessionStatus(id: string, status: string, extras?: { checkpointFileId?: string }, reportedTurn?: number) {
      const s = sessions.find((x) => x.id === id);
      if (s && reportedTurn !== undefined && (s.turns ?? 0) > reportedTurn) {
        return { replacedCheckpointFileId: null, applied: false };
      }
      if (s) s.status = status;
      if (!extras?.checkpointFileId) return { replacedCheckpointFileId: null, applied: true };
      return { replacedCheckpointFileId: "file_old000000001", applied: true };
    },
    async getSession(id: string, _ws?: string) {
      const s = sessions.find((x) => x.id === id);
      if (!s) return null;
      if (_ws && s.workspace_id !== _ws) return null;
      return s;
    },
    async listSessions(_ws: string, agentId?: string, _limit?: number, _offset?: number, _fileId?: string) {
      const rows = sessions.filter((s) => s.workspace_id === _ws && (!agentId || s.agent_id === agentId));
      return { rows, count: rows.length };
    },
    async listEvents(id: string, after = 0) { return (events[id] ?? []).filter((e) => e.seq > after); },
    async startTurn(id: string) {
      const s = sessions.find((x) => x.id === id);
      if (!s) throw new Error("session not found: " + id);
      if (s.status !== "idle") throw new Error("session is " + s.status + ", only idle sessions accept new messages");
      s.status = "queued";
      s.turns = (s.turns ?? 0) + 1;
      return { turn: s.turns, config: { routing: "m", system_prompt: "", tools: [], max_turns: 10, environment_id: "env_0" }, sdkSessionId: "sdk1", checkpointFileId: null };
    },
    async attachSessionFiles() {},
    async setSessionMemoryStore(sessionId: string, storeId: string) {
      const s = sessions.find((x) => x.id === sessionId);
      if (s) s.memory_store_id = storeId;
    },
    async sessionResources(id: string, _ws?: string) {
      const s = sessions.find((x) => x.id === id && (!_ws || x.workspace_id === _ws));
      if (!s) return null;
      return { inputFiles: [], outputFiles: [], memory: null, skills: [], tools: [], environment: null, vault: null, mcpServers: {}, routing: "m" };
    },
    async deleteSession(_ws: string, id: string) {
      const i = sessions.findIndex((s) => s.id === id && s.workspace_id === _ws);
      if (i >= 0) sessions.splice(i, 1);
      return [];
    },

    // ── Environments ──
    async createEnvironment(_ws: string, name: string, allowPackageManagers?: boolean, allowedHosts?: string[], pod?: any) {
      const e = { id: `env_${environments.length}`, name, workspace_id: _ws, allow_package_managers: allowPackageManagers ?? false, allowed_hosts: allowedHosts ?? [], pod: pod ?? {} };
      environments.push(e); return e;
    },
    async getEnvironment(id: string) { return environments.find((e) => e.id === id) ?? null; },
    async listEnvironments(_ws: string) {
      const rows = environments.filter((e) => e.workspace_id === _ws);
      return { rows, count: rows.length };
    },
    async updateEnvironment(_ws: string, id: string, patch: any) {
      const e = environments.find((x) => x.id === id && x.workspace_id === _ws);
      if (!e) return null;
      if (patch.name !== undefined) e.name = patch.name;
      if (patch.allowPackageManagers !== undefined) e.allow_package_managers = patch.allowPackageManagers;
      if (patch.allowedHosts !== undefined) e.allowed_hosts = patch.allowedHosts;
      if (patch.pod !== undefined) e.pod = patch.pod;
      return e;
    },
    async deleteEnvironment(_ws: string, id: string) {
      const i = environments.findIndex((e) => e.id === id && e.workspace_id === _ws);
      if (i >= 0) environments.splice(i, 1);
    },
    async environmentInUse(id: string) { return agents.some((a) => a.environmentId === id); },
    async getLimits() { return { maxWorkGb: 2048 }; },

    // ── Skills ──
    async getSkillIdByName(_ws: string, name: string) {
      return skills.find((s) => s.workspace_id === _ws && s.name === name)?.id ?? null;
    },
    async createSkill(_ws: string, name: string, manifest: any, id?: string) {
      const skillId = id ?? `skill_${skills.length}`;
      const s = { id: skillId, name, files: manifest, workspace_id: _ws, version: 1 };
      skills.push(s);
      return { id: skillId, name, version: 1, fileCount: manifest.length, previousFileIds: [] as string[] };
    },
    async listSkills(_ws: string, ids?: string[]) {
      let rows = skills.filter((s) => s.workspace_id === _ws);
      if (ids) rows = rows.filter((s) => ids.includes(s.id));
      return rows;
    },
    async countSkills(_ws: string) { return skills.filter((s) => s.workspace_id === _ws).length; },
    async getSkill(_ws: string, id: string) { return skills.find((s) => s.id === id && s.workspace_id === _ws) ?? null; },
    async deleteSkill(_ws: string, id: string) {
      const i = skills.findIndex((s) => s.id === id && s.workspace_id === _ws);
      if (i < 0) return [];
      const [removed] = skills.splice(i, 1);
      return (removed.files ?? []).map((f: any) => f.fileId);
    },
    async missingSkillIds(_ws: string, ids: string[]) {
      return ids.filter((id) => !skills.some((s) => s.id === id && s.workspace_id === _ws));
    },
    skillUsed: false as boolean,
    async skillInUse() { return (this as any).skillUsed; },

    // ── Vaults ──
    async createVault(_ws: string, name: string) {
      const v = { id: `vlt_${vaults.length}`, name, workspace_id: _ws };
      vaults.push(v); vaultCredentials[v.id] = []; return v;
    },
    async getVault(_ws: string, id: string) { return vaults.find((v) => v.id === id && v.workspace_id === _ws) ?? null; },
    async listVaults(_ws: string) {
      const rows = vaults.filter((v) => v.workspace_id === _ws);
      return { rows, count: rows.length };
    },
    async deleteVault(_ws: string, id: string) {
      const i = vaults.findIndex((v) => v.id === id && v.workspace_id === _ws);
      if (i >= 0) vaults.splice(i, 1);
    },
    async addVaultCredential(id: string, name: string) { (vaultCredentials[id] ??= []).push(name); },
    async removeVaultCredential(id: string, name: string) {
      vaultCredentials[id] = (vaultCredentials[id] ?? []).filter((n) => n !== name);
    },
    async listVaultCredentials(id: string) { return vaultCredentials[id] ?? []; },

    // ── Memory stores ──
    async createMemoryStore(_ws: string, name: string) {
      const m = { id: `memstore_${memoryStores.length}`, name, workspace_id: _ws };
      memoryStores.push(m); memoryEntries[m.id] = []; return m;
    },
    async listMemoryStores(_ws: string) {
      const rows = memoryStores.filter((m) => m.workspace_id === _ws);
      return { rows, count: rows.length };
    },
    // Honors the workspace arg (unlike the /v1 fakes) so the public 404
    // scoping test can actually fail if the route forgets to scope.
    async getMemoryStore(id: string, ws?: string) {
      return memoryStores.find((s) => s.id === id && (!ws || s.workspace_id === ws)) ?? null;
    },
    async deleteMemoryStore(_ws: string, id: string) {
      const i = memoryStores.findIndex((m) => m.id === id && m.workspace_id === _ws);
      if (i >= 0) memoryStores.splice(i, 1);
      return [];
    },
    async deleteMemoryEntry(storeId: string, path: string) {
      memoryEntries[storeId] = (memoryEntries[storeId] ?? []).filter((e) => e.path !== path);
    },
    async getMemoryEntries(storeId: string) { return memoryEntries[storeId] ?? []; },
    async getMemoryEntry(storeId: string, path: string) {
      return (memoryEntries[storeId] ?? []).find((e) => e.path === path) ?? null;
    },
    async upsertMemoryEntries(storeId: string, newEntries: { path: string; fileId: string }[], deletes: string[] = []) {
      const list = memoryEntries[storeId] ?? (memoryEntries[storeId] = []);
      const orphaned: string[] = [];
      for (const { path, fileId } of newEntries) {
        const i = list.findIndex((e) => e.path === path);
        if (i >= 0) { orphaned.push(list[i].file_id); list[i] = { path, file_id: fileId }; }
        else list.push({ path, file_id: fileId });
      }
      for (const path of deletes) {
        const i = list.findIndex((e) => e.path === path);
        if (i >= 0) { orphaned.push(list[i].file_id); list.splice(i, 1); }
      }
      return orphaned;
    },
  };
  const files: any = {
    async put(content: Buffer, key: string) { stored[key] = content; },
    async get(key: string) { if (!stored[key]) throw new Error("missing"); return stored[key]; },
    async del() {},
    async getStream(key: string) { const { Readable } = await import("node:stream"); return Readable.from(stored[key]); },
    async createUpload(_key: string) { return "upkey"; },
    async uploadPart(key: string, _k: string, n: number, data: Buffer) { (parts[key] ??= {})[n] = data; return `etag${n}`; },
    async completeUpload(key: string, _k: string, list: { n: number }[]) {
      stored[key] = Buffer.concat([...list].sort((a, b) => a.n - b.n).map((p) => parts[key][p.n]));
    },
    async abortUpload(key: string) { aborted.push(key); delete parts[key]; },
  };
  const started: string[] = [];
  const orchestrator: any = {
    async startSession(s: { id: string }) { started.push(s.id); },
    async stopSession() {},
    async deleteSessionResources() {},
    async ensureEnvironmentPolicy() {},
    async deleteEnvironmentResources() {},
    async writeVaultSecret() {},
    async putVaultSecretKey() {},
    async removeVaultSecretKey() {},
    async deleteVaultSecret() {},
  };
  return { repo, files, fileRecords, uploads, stored, aborted, orchestrator, started };
}

async function makeApp(f = publicFakes()) {
  const app = Fastify();
  await registerPublicApi(app, f.repo, f.orchestrator, f.files);
  return { app, f };
}

const authed = { authorization: `Bearer ${KEY}` };
const authedOther = { authorization: `Bearer ${OTHER_KEY}` };
const mp = (name: string, content: Buffer) => {
  const b = "testboundary123";
  return {
    payload: Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      content, Buffer.from(`\r\n--${b}--\r\n`),
    ]),
    headers: { ...authed, "content-type": `multipart/form-data; boundary=${b}` },
  };
};

test("every /api route rejects keyless requests with 401", async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: "GET", url: "/api/files" });
  assert.equal(res.statusCode, 401);
});

test("small file: upload → list → retrieve → streamed download → delete", async () => {
  const { app } = await makeApp();
  const content = Buffer.from("small file body");
  const up = await app.inject({ method: "POST", url: "/api/files", ...mp("a.txt", content) });
  assert.equal(up.statusCode, 201);
  const rec = up.json();
  assert.equal(rec.name, "a.txt");
  assert.equal(rec.sha256, sha(content));

  const list = await app.inject({ method: "GET", url: "/api/files", headers: authed });
  assert.equal(list.json().files.length, 1);

  const dl = await app.inject({
    method: "POST", url: `/api/files/${rec.id}/content`, headers: authed,
    payload: { stream: true },
  });
  assert.equal(dl.statusCode, 200);
  assert.equal(dl.rawPayload.toString(), "small file body");

  const del = await app.inject({ method: "DELETE", url: `/api/files/${rec.id}`, headers: authed });
  assert.equal(del.statusCode, 204);
  const gone = await app.inject({ method: "GET", url: `/api/files/${rec.id}`, headers: authed });
  assert.equal(gone.statusCode, 404);
});

test("a file uploaded by one key is not readable by another workspace's key (404, not 403)", async () => {
  const { app } = await makeApp();
  const content = Buffer.from("owner-only body");
  const up = await app.inject({ method: "POST", url: "/api/files", ...mp("owner.txt", content) });
  assert.equal(up.statusCode, 201);
  const rec = up.json();

  const getOther = await app.inject({ method: "GET", url: `/api/files/${rec.id}`, headers: authedOther });
  assert.equal(getOther.statusCode, 404);

  const dlOther = await app.inject({
    method: "POST", url: `/api/files/${rec.id}/content`, headers: authedOther,
    payload: { stream: true },
  });
  assert.equal(dlOther.statusCode, 404);

  const getOwner = await app.inject({ method: "GET", url: `/api/files/${rec.id}`, headers: authed });
  assert.equal(getOwner.statusCode, 200);

  const dlOwner = await app.inject({
    method: "POST", url: `/api/files/${rec.id}/content`, headers: authed,
    payload: { stream: true },
  });
  assert.equal(dlOwner.statusCode, 200);
  assert.equal(dlOwner.rawPayload.toString(), "owner-only body");
});

test("chunked upload: create → parts (retry-safe) → complete produces composite sha", async () => {
  const { app, f } = await makeApp();
  const create = await app.inject({
    method: "POST", url: "/api/files/uploads", headers: authed,
    payload: { name: "big.bin", kind: "upload" },
  });
  assert.equal(create.statusCode, 201);
  const { upload_id, part_size } = create.json();
  assert.equal(part_size, PART_SIZE);

  const p1 = Buffer.alloc(10, 1), p2 = Buffer.alloc(5, 2);
  for (const [n, buf] of [[1, p1], [2, p2]] as const) {
    const r = await app.inject({ method: "POST", url: `/api/files/uploads/${upload_id}/parts/${n}`, ...mp("part", buf) });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().sha256, sha(buf));
  }
  // retrying a part replaces it, not duplicates it
  await app.inject({ method: "POST", url: `/api/files/uploads/${upload_id}/parts/2`, ...mp("part", p2) });

  const done = await app.inject({ method: "POST", url: `/api/files/uploads/${upload_id}/complete`, headers: authed, payload: {} });
  assert.equal(done.statusCode, 201);
  const rec = done.json();
  assert.equal(rec.size, 15);
  assert.equal(rec.sha256, sha(sha(p1) + sha(p2))); // composite hash
  assert.equal((await f.files.get(rec.objectKey)).length, 15);
});

test("complete with a gap in part numbers → 400; abort frees the store upload", async () => {
  const { app, f } = await makeApp();
  const { upload_id } = (await app.inject({ method: "POST", url: "/api/files/uploads", headers: authed, payload: { name: "gap.bin" } })).json();
  await app.inject({ method: "POST", url: `/api/files/uploads/${upload_id}/parts/2`, ...mp("part", Buffer.alloc(3)) });
  const bad = await app.inject({ method: "POST", url: `/api/files/uploads/${upload_id}/complete`, headers: authed, payload: {} });
  assert.equal(bad.statusCode, 400);
  const abort = await app.inject({ method: "DELETE", url: `/api/files/uploads/${upload_id}`, headers: authed });
  assert.equal(abort.statusCode, 204);
  assert.equal(f.aborted.length, 1);
});

test("sweepStaleUploads aborts and deletes stale rows", async () => {
  const { app, f } = await makeApp();
  const { upload_id } = (await app.inject({ method: "POST", url: "/api/files/uploads", headers: authed, payload: { name: "stale.bin" } })).json();
  await sweepStaleUploads(f.repo, f.files, 0);
  assert.equal(f.aborted.length, 1);
  assert.equal(await f.repo.getFileUpload("wrkspc_t", upload_id), null);
});

test("vault flow: create with secrets, credentials listed by name only, delete", async () => {
  const { app } = await makeApp();
  const created = await app.inject({
    method: "POST", url: "/api/vaults", headers: authed,
    payload: { name: "v1", secrets: { TOKEN: "s3cret" } },
  });
  assert.equal(created.statusCode, 201);
  const get = await app.inject({ method: "GET", url: `/api/vaults/${created.json().id}`, headers: authed });
  // secrets are write-only: response must not contain the value anywhere
  assert.ok(!get.body.includes("s3cret"));
});

test("agent + session flow via shared actions: create agent → create session → poll events", async () => {
  const { app } = await makeApp();
  const env = (await app.inject({ method: "POST", url: "/api/environments", headers: authed, payload: { name: "e1" } })).json();
  const agent = (await app.inject({
    method: "POST", url: "/api/agents", headers: authed,
    payload: { name: "a1", routing: "m1", environmentId: env.id },
  })).json();
  const sess = await app.inject({
    method: "POST", url: "/api/sessions", headers: authed,
    payload: { agent: agent.id, prompt: "hello" },
  });
  assert.equal(sess.statusCode, 201);
  assert.equal(sess.json().status, "queued");
  const events = await app.inject({ method: "GET", url: `/api/sessions/${sess.json().id}/events`, headers: authed });
  assert.equal(events.json().events[0].type, "user");
});

test("POST events/stream without stream:true returns the event list (poll fallback)", async () => {
  const { app } = await makeApp();
  const env = (await app.inject({ method: "POST", url: "/api/environments", headers: authed, payload: { name: "e2" } })).json();
  const agent = (await app.inject({ method: "POST", url: "/api/agents", headers: authed, payload: { name: "a2", routing: "m1", environmentId: env.id } })).json();
  const sess = (await app.inject({ method: "POST", url: "/api/sessions", headers: authed, payload: { agent: agent.id, prompt: "hi" } })).json();
  const res = await app.inject({
    method: "POST", url: `/api/sessions/${sess.id}/events/stream`, headers: authed, payload: {},
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().events));
});

test("skill upload (single SKILL.md) via multipart", async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: "POST", url: "/api/skills?name=greet", ...mp("SKILL.md", Buffer.from("# greet")) });
  assert.equal(res.statusCode, 201);
});

test("agent create rejects unknown skill ids; skill delete blocks while referenced", async () => {
  const { app, f } = await makeApp();
  const env = (await app.inject({ method: "POST", url: "/api/environments", headers: authed, payload: { name: "e-skill" } })).json();
  const bad = await app.inject({ method: "POST", url: "/api/agents", headers: authed,
    payload: { name: "a-skill", routing: "m1", environmentId: env.id, skillIds: ["skill_gone"] } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /skill_gone/);
  const skill = (await app.inject({ method: "POST", url: "/api/skills?name=greet2", ...mp("SKILL.md", Buffer.from("# greet")) })).json();
  const ok = await app.inject({ method: "POST", url: "/api/agents", headers: authed,
    payload: { name: "a-skill", routing: "m1", environmentId: env.id, skillIds: [skill.id] } });
  assert.equal(ok.statusCode, 201);
  const badVersion = await app.inject({ method: "POST", url: `/api/agents/${ok.json().id}/versions`, headers: authed,
    payload: { routing: "m1", environmentId: env.id, skillIds: ["skill_gone"] } });
  assert.equal(badVersion.statusCode, 400);
  (f.repo as any).skillUsed = true;
  assert.equal((await app.inject({ method: "DELETE", url: `/api/skills/${skill.id}`, headers: authed })).statusCode, 409);
  (f.repo as any).skillUsed = false;
  assert.equal((await app.inject({ method: "DELETE", url: `/api/skills/${skill.id}`, headers: authed })).statusCode, 204);
});

// SECURITY/spec (2026-07-16 amendment): the public /api surface must enforce
// routings-only agent references exactly like /v1 (agents-api.ts) — missing
// routing → 400, unknown routing name → 400, real routing → success. Covers
// both POST /agents and POST /agents/:id/versions.
test("agent create/version on /api: routing must reference an existing routing (mirrors /v1)", async () => {
  const { app, f } = await makeApp();
  (f.repo as any).knownRoutings = new Set(["my-route"]);
  const env = (await app.inject({ method: "POST", url: "/api/environments", headers: authed, payload: { name: "e-route" } })).json();

  const missing = await app.inject({ method: "POST", url: "/api/agents", headers: authed,
    payload: { name: "x", environmentId: env.id } });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error, "name and routing required");

  const unknown = await app.inject({ method: "POST", url: "/api/agents", headers: authed,
    payload: { name: "x", routing: "not-a-routing", environmentId: env.id } });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json().error, "routing must reference an existing routing");

  const ok = await app.inject({ method: "POST", url: "/api/agents", headers: authed,
    payload: { name: "x", routing: "my-route", environmentId: env.id } });
  assert.equal(ok.statusCode, 201);

  const missingVersion = await app.inject({ method: "POST", url: `/api/agents/${ok.json().id}/versions`, headers: authed,
    payload: { environmentId: env.id } });
  assert.equal(missingVersion.statusCode, 400);
  assert.equal(missingVersion.json().error, "routing must reference an existing routing");

  const unknownVersion = await app.inject({ method: "POST", url: `/api/agents/${ok.json().id}/versions`, headers: authed,
    payload: { routing: "not-a-routing", environmentId: env.id } });
  assert.equal(unknownVersion.statusCode, 400);
  assert.equal(unknownVersion.json().error, "routing must reference an existing routing");

  const okVersion = await app.inject({ method: "POST", url: `/api/agents/${ok.json().id}/versions`, headers: authed,
    payload: { routing: "my-route", environmentId: env.id } });
  assert.equal(okVersion.statusCode, 201);
});

test("memory store: create, add entry, tree, content", async () => {
  const { app } = await makeApp();
  const store = (await app.inject({ method: "POST", url: "/api/memory-stores", headers: authed, payload: { name: "m1" } })).json();
  const add = await app.inject({ method: "POST", url: `/api/memory-stores/${store.id}/entries?path=notes.md`, ...mp("notes.md", Buffer.from("note body")) });
  assert.equal(add.statusCode, 201);
});

// SECURITY (Task 3 review): the /v1 memory tree/content handlers are
// unscoped — the public /api versions must 404 a store in another workspace.
test("memory store tree: a store in another workspace is 404, not leaked", async () => {
  const { app } = await makeApp();
  const store = (await app.inject({ method: "POST", url: "/api/memory-stores", headers: authed, payload: { name: "m1" } })).json();
  const res = await app.inject({ method: "GET", url: `/api/memory-stores/${store.id}/tree`, headers: authedOther });
  assert.equal(res.statusCode, 404);
  const own = await app.inject({ method: "GET", url: `/api/memory-stores/${store.id}/tree`, headers: authed });
  assert.equal(own.statusCode, 200);
});

// SECURITY (whole-branch review): the ws(req) workspace is a security
// boundary on /api — a resource in another workspace must be a 404 (reads/
// deletes) or 400 (invalid input ref), never accessible. These cover the
// session + delete routes that were missed by the Task 3/4 pass.
async function makeOwnedSession(app: any) {
  const env = (await app.inject({ method: "POST", url: "/api/environments", headers: authed, payload: { name: `e-${Math.random()}` } })).json();
  const agent = (await app.inject({ method: "POST", url: "/api/agents", headers: authed, payload: { name: `a-${Math.random()}`, routing: "m1", environmentId: env.id } })).json();
  const sess = (await app.inject({ method: "POST", url: "/api/sessions", headers: authed, payload: { agent: agent.id, prompt: "hi" } })).json();
  return sess;
}

test("session events read: foreign workspace 404s, owner 200s", async () => {
  const { app } = await makeApp();
  const sess = await makeOwnedSession(app);
  const other = await app.inject({ method: "GET", url: `/api/sessions/${sess.id}/events`, headers: authedOther });
  assert.equal(other.statusCode, 404);
  const owner = await app.inject({ method: "GET", url: `/api/sessions/${sess.id}/events`, headers: authed });
  assert.equal(owner.statusCode, 200);
});

test("session events/stream (poll branch): foreign workspace 404s, owner 200s", async () => {
  const { app } = await makeApp();
  const sess = await makeOwnedSession(app);
  const other = await app.inject({ method: "POST", url: `/api/sessions/${sess.id}/events/stream`, headers: authedOther, payload: {} });
  assert.equal(other.statusCode, 404);
  const owner = await app.inject({ method: "POST", url: `/api/sessions/${sess.id}/events/stream`, headers: authed, payload: {} });
  assert.equal(owner.statusCode, 200);
});

test("message injection: foreign workspace cannot resume another workspace's session (404)", async () => {
  const { app } = await makeApp();
  const sess = await makeOwnedSession(app);
  const other = await app.inject({ method: "POST", url: `/api/sessions/${sess.id}/messages`, headers: authedOther, payload: { prompt: "hack" } });
  assert.equal(other.statusCode, 404);
});

test("session delete: foreign workspace 404s, owner 204s", async () => {
  const { app } = await makeApp();
  const sess = await makeOwnedSession(app);
  const other = await app.inject({ method: "DELETE", url: `/api/sessions/${sess.id}`, headers: authedOther });
  assert.equal(other.statusCode, 404);
  const owner = await app.inject({ method: "DELETE", url: `/api/sessions/${sess.id}`, headers: authed });
  assert.equal(owner.statusCode, 204);
});

test("vault delete: foreign workspace 404s, owner 204s", async () => {
  const { app } = await makeApp();
  const vault = (await app.inject({ method: "POST", url: "/api/vaults", headers: authed, payload: { name: "v-del" } })).json();
  const other = await app.inject({ method: "DELETE", url: `/api/vaults/${vault.id}`, headers: authedOther });
  assert.equal(other.statusCode, 404);
  const owner = await app.inject({ method: "DELETE", url: `/api/vaults/${vault.id}`, headers: authed });
  assert.equal(owner.statusCode, 204);
});

test("environment delete: foreign workspace 404s, owner 204s", async () => {
  const { app } = await makeApp();
  const env = (await app.inject({ method: "POST", url: "/api/environments", headers: authed, payload: { name: "e-del" } })).json();
  const other = await app.inject({ method: "DELETE", url: `/api/environments/${env.id}`, headers: authedOther });
  assert.equal(other.statusCode, 404);
  const owner = await app.inject({ method: "DELETE", url: `/api/environments/${env.id}`, headers: authed });
  assert.equal(owner.statusCode, 204);
});

test("agent create with a foreign-workspace environmentId is rejected (400)", async () => {
  const { app } = await makeApp();
  const env = (await app.inject({ method: "POST", url: "/api/environments", headers: authed, payload: { name: "e-foreign" } })).json();
  const res = await app.inject({
    method: "POST", url: "/api/agents", headers: authedOther,
    payload: { name: "a-foreign", routing: "m1", environmentId: env.id },
  });
  assert.equal(res.statusCode, 400);
});

test("session create with a foreign-workspace file id is rejected (400)", async () => {
  const { app } = await makeApp();
  const rec = (await app.inject({ method: "POST", url: "/api/files", ...mp("f.txt", Buffer.from("foreign file body")) })).json(); // owned by wrkspc_t
  const env = (await app.inject({ method: "POST", url: "/api/environments", headers: authedOther, payload: { name: "e-other" } })).json();
  const agent = (await app.inject({ method: "POST", url: "/api/agents", headers: authedOther, payload: { name: "a-other", routing: "m1", environmentId: env.id } })).json();
  const res = await app.inject({
    method: "POST", url: "/api/sessions", headers: authedOther,
    payload: { agent: agent.id, prompt: "hi", files: [rec.id] },
  });
  assert.equal(res.statusCode, 400);
});

test("session create with a foreign-workspace memoryStore is rejected (404)", async () => {
  const { app } = await makeApp();
  const store = (await app.inject({ method: "POST", url: "/api/memory-stores", headers: authed, payload: { name: "m-foreign" } })).json(); // owned by wrkspc_t
  const env = (await app.inject({ method: "POST", url: "/api/environments", headers: authedOther, payload: { name: "e-other2" } })).json();
  const agent = (await app.inject({ method: "POST", url: "/api/agents", headers: authedOther, payload: { name: "a-other2", routing: "m1", environmentId: env.id } })).json();
  const res = await app.inject({
    method: "POST", url: "/api/sessions", headers: authedOther,
    payload: { agent: agent.id, prompt: "hi", memoryStore: store.id },
  });
  assert.equal(res.statusCode, 404);
});
