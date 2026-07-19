import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerAgentRoutes, type Orchestrator } from "../src/agents-api.ts";
import type { Repo } from "../src/repo.ts";
import { DEFAULT_COST_SETTINGS } from "../src/costs.ts";
import { defaultMaintenanceSettings } from "../src/maintenance.ts";

function fakes() {
  const agents: any[] = [];
  const sessions: any[] = [];
  const events: Record<string, any[]> = {};
  const started: string[] = [];
  const startSpecs: any[] = [];
  const fileRecords: any[] = [];
  const attachCalls: { sessionId: string; fileIds: string[]; kind: string }[] = [];
  const repo = {
    async getWorkspace(id: string) { return { id, status: "active" }; },
    async listWorkspaces() { return [{ id: "wrkspc_default", name: "Default workspace" }]; },
    async createWorkspace(name: string) { return { id: "wrkspc_1", name }; },
    async createAgent(_ws: string, name: string, c: any) { const a = { id: `agent_${agents.length}`, name, version: 1, workspaceId: _ws, ...c }; agents.push(a); return a; },
    // null = every model name is accepted (most tests don't exercise routing
    // validation); set to a Set to test the routings-only 400.
    knownRoutings: null as Set<string> | null,
    async getRoutingByName(name: string) {
      const known = (this as any).knownRoutings as Set<string> | null;
      if (known === null) return { name };
      return known.has(name) ? { name } : null;
    },
    agentListCalls: [] as any[],
    async listAgents(_ws: string, limit?: number, offset?: number) {
      (this as any).agentListCalls.push({ limit, offset });
      return { rows: agents, count: agents.length };
    },
    agentStatuses: {} as Record<string, string>,
    envInUse: false as boolean,
    async environmentInUse() { return (this as any).envInUse; },
    knownSkillIds: [] as string[],
    async missingSkillIds(_ws: string, ids: string[]) { return ids.filter((id) => !(this as any).knownSkillIds.includes(id)); },
    skillUsed: false as boolean,
    async skillInUse() { return (this as any).skillUsed; },
    async deleteSkill() { return []; },
    async getAgent(_ws: string, id: string) {
      // Mirrors the real repo's workspace scoping: an agent is only visible
      // to a getAgent() call made with its own workspace.
      const a = agents.find((x) => x.id === id && x.workspaceId === _ws);
      return a ? { id: a.id, name: a.name, status: (this as any).agentStatuses[id] ?? "active" } : null;
    },
    async setAgentStatus(_ws: string, id: string, status: string) {
      if (!agents.find((x) => x.id === id)) return false;
      (this as any).agentStatuses[id] = status; return true;
    },
    async renameAgent(_ws: string, id: string, name: string) {
      const a = agents.find((x) => x.id === id && x.workspaceId === _ws);
      if (!a) return "notfound";
      // Mirrors agents.name UNIQUE (global, migration 001).
      if (agents.some((x) => x.id !== id && x.name === name)) return "conflict";
      a.name = name; return "ok";
    },
    envForVersion: true as boolean,
    async getAgentVersion(id: string) {
      const a = agents.find((x) => x.id === id);
      return a ? { agent_id: id, version: 1, routing: a.routing, system_prompt: "", tools: a.tools ?? [], max_turns: 10, environment_id: (this as any).envForVersion ? (a.environmentId ?? null) : null } : null;
    },
    async getAgentWithVersions(id: string) {
      const a = agents.find((x) => x.id === id);
      return a ? { ...a, versions: [{ agent_id: id, version: 1, routing: a.routing, system_prompt: "", tools: a.tools ?? [], max_turns: 10, skill_ids: [], environment_id: (this as any).envForVersion ? (a.environmentId ?? null) : null }] } : null;
    },
    async newAgentVersion() { return 2; },
    async acquireWikiWriteLock() { return { release: async () => {} }; },
    async createSession(_ws: string, agentId: string, prompt: string, name?: string) {
      const a = agents.find((x) => x.id === agentId);
      if (!a) throw new Error(`agent not found: ${agentId}`);
      const s = { id: `sesn_${sessions.length}`, agent_id: agentId, workspace_id: _ws, status: "queued", prompt, name, turns: 0 };
      sessions.push(s); events[s.id] = [];
      const config = { agent_id: agentId, version: 1, routing: a.routing, system_prompt: "", tools: a.tools ?? [], max_turns: 10, skill_ids: [], environment_id: (this as any).envForVersion ? (a.environmentId ?? null) : null };
      return { id: s.id, agentId, agentVersion: 1, config };
    },
    async appendEvents(id: string, evts: any[]) {
      const list = events[id]; let seq = list.length;
      for (const e of evts) list.push({ ...e, seq: ++seq });
      return seq;
    },
    async setSessionStatus(id: string, status: string, extras?: { checkpointFileId?: string }, reportedTurn?: number) {
      const s = sessions.find((x) => x.id === id);
      if (s && reportedTurn !== undefined && (s.turns ?? 0) > reportedTurn) {
        return { replacedCheckpointFileId: null, applied: false }; // stale post: no mutation
      }
      if (s) s.status = status;
      if (!extras?.checkpointFileId) return { replacedCheckpointFileId: null, applied: true };
      const replaced = "file_old000000001";
      return { replacedCheckpointFileId: replaced, applied: true };
    },
    async getSession(id: string) { return sessions.find((x) => x.id === id) ?? null; },
    sessionListCalls: [] as any[],
    async listSessions(_ws: string, agentId?: string, _limit?: number, _offset?: number, fileId?: string) {
      (this as any).sessionListCalls.push({ agentId, fileId });
      return { rows: sessions, count: sessions.length };
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
    async createFileRecord(m: any) { fileRecords.push({ ...m, workspace_id: m.workspaceId ?? "wrkspc_default" }); return m; },
    async createSkill(_ws: string, name: string, fileId: string) { return { id: "skill_0", name, fileId }; },
    async listSkills() { return []; },
    async countSkills() { return 0; },
    async createMemoryStore(_ws: string, name: string) { return { id: "memstore_0", name }; },
    async listMemoryStores() { return { rows: [], count: 0 }; },
    async getMemoryStore() { return { id: "memstore_0" }; },
    memoryEntries: [] as any[],
    async getMemoryEntries() { return (this as any).memoryEntries; },
    async upsertMemoryEntries() { return ["file_old000000002"]; },
    async setSessionMemoryStore() {},
    async createVault(_ws: string, name: string) { return { id: "vlt_0", name }; },
    async listVaults() { return { rows: [], count: 0 }; },
    async getVault(_ws: string, id: string) { return { id, name: "v" }; },
    async listVaultCredentials() { return []; },
    async addVaultCredential() {},
    async removeVaultCredential() {},
    async getSkill(_ws: string, id: string) { return { id, name: "s", version: 1, files: [] }; },
    async createWebhook(_ws: string, url: string) { return { id: "whk_0", url }; },
    async listWebhooks() { return []; },
    async agentObservability() { return { sessions: 0 }; },
    async gatewayUsage(ws: string, opts: any) {
      return { calledWith: { ws, ...opts }, bucket: "day", buckets: [], totals: { tokens_in: 0, tokens_out: 0, requests: 0 }, byDeployment: [], byKey: [] };
    },
    async sessionUsage(ws: string | null, opts: any) {
      return { calledWith: { ws, ...opts }, bucket: "day", buckets: [], totals: { tokens_in: 0, tokens_out: 0, requests: 0 }, byDeployment: [], sessionsCount: 0, timeCosts: null };
    },
    async listAllApiKeys() { return []; },
    async deploymentStats(model: string, opts: any) {
      return { calledWith: { model, ...opts }, buckets: [], totals: { tokens_in: 0, tokens_out: 0, requests: 0 } };
    },
    async getCostSettings() { return { ...DEFAULT_COST_SETTINGS }; },
    async putCostSettings(costs: any) {},
    async createEnvironment(_ws: string, name: string, _pkg?: boolean, _hosts?: string[], pod?: any) {
      return { id: "env_0", name, allowPackageManagers: false, pod: pod ?? {} };
    },
    async getEnvironment(id: string) { return id === "env_0" ? { id, name: "e", allowed_hosts: [], allow_package_managers: false, pod: {} } : null; },
    async listEnvironments() { return { rows: [], count: 0 }; },
    async updateEnvironment(_ws: string, id: string, patch: any) {
      return id === "env_0" ? { id, name: patch.name ?? "e", allow_package_managers: patch.allowPackageManagers ?? false, allowed_hosts: patch.allowedHosts ?? [], pod: patch.pod ?? {} } : null;
    },
    async getFileRecord() { return null; },
    async listFileRecords(ids: string[]) { return fileRecords.filter((r) => (ids ?? []).includes(r.id)); },
    async listAllFiles() { return { files: [], total: 0, limit: 25, offset: 0 }; },
    async attachSessionFiles(sessionId: string, fileIds: string[], kind: string) { attachCalls.push({ sessionId, fileIds, kind }); },
    async listSessionFiles() { return []; },
    async sessionResources() { return { inputFiles: [], outputFiles: [], memory: null, skills: [], tools: [], environment: null, vault: null, mcpServers: {}, routing: "m" }; },
    async deleteSession() { return []; },
    async deleteFile() { return { deleted: true, objectKey: null }; },
    async deleteFileRecordById(id: string) { (this as any).deletedFileRecords.push(id); return id; },
    deletedFileRecords: [] as string[],
    async deleteMemoryStore() { return []; },
    async deleteMemoryEntry() {},
    async deleteAgent() {},
    async deleteApiKey() {},
    async deleteVault() {},
    async deleteEnvironment() {},
    async deleteResourcePrice() {},
    apiKeyCalls: [] as any[],
    async listApiKeys(_ws: string, _limit: number, _offset: number, includeDeleted = false) {
      (this as any).apiKeyCalls.push({ includeDeleted });
      return { rows: [], count: 0 };
    },
    pendingLaunches: [] as { session_id: string; model: string; payload: any }[],
    async addPendingLaunch(sessionId: string, model: string, payload: any) {
      const rows = (this as any).pendingLaunches;
      const i = rows.findIndex((r: any) => r.session_id === sessionId);
      const row = { session_id: sessionId, model, payload };
      if (i >= 0) rows[i] = row; else rows.push(row);
    },
    async takePendingLaunches(model: string) {
      const rows = (this as any).pendingLaunches;
      const taken = rows.filter((r: any) => r.model === model);
      (this as any).pendingLaunches = rows.filter((r: any) => r.model !== model);
      return taken;
    },
    async takePendingLaunch(sessionId: string) {
      const rows = (this as any).pendingLaunches;
      const i = rows.findIndex((r: any) => r.session_id === sessionId);
      return i >= 0 ? rows.splice(i, 1)[0] : null;
    },
    async listPendingLaunchModels() {
      return [...new Set(((this as any).pendingLaunches as any[]).map((r) => r.model))];
    },
    async listChildSessions(parentId: string) {
      return sessions.filter((s: any) => s.parent_session_id === parentId && (s.status === "queued" || s.status === "running"));
    },
    _limits: { maxWorkGb: 2048 },
    async getLimits() { return (this as any)._limits; },
    async putLimits(l: any) { (this as any)._limits = l; },
    _maintenance: null as any,
    async getMaintenanceSettings() { return (this as any)._maintenance ?? defaultMaintenanceSettings(); },
    async putMaintenanceSettings(m: any) { (this as any)._maintenance = m; },
    _appearance: { theme: "system" },
    async getAppearance() { return (this as any)._appearance; },
    async putAppearance(a: any) { (this as any)._appearance = a; },
    _maintenanceLastRun: null as any,
    async getMaintenanceLastRun() { return (this as any)._maintenanceLastRun; },
    async setMaintenanceLastRun(s: any) { (this as any)._maintenanceLastRun = s; },
  } as unknown as Repo;
  const envPolicies: any[] = [];
  const deletedEnvironmentResources: string[] = [];
  const orchestrator: Orchestrator & { envPolicies: any[]; deletedEnvironmentResources: string[]; deletedSessionResources: string[] } = {
    envPolicies,
    deletedEnvironmentResources,
    async startSession(s) { started.push(s.id); startSpecs.push(s); },
    async ensureEnvironmentPolicy(env) { envPolicies.push(env); },
    deletedSessionResources: [] as string[],
    async deleteSessionResources(id: string) { (this as any).deletedSessionResources.push(id); },
    async writeVaultSecret() {}, async stopSession() {}, async deleteVaultSecret() {},
    async deleteEnvironmentResources(id) { deletedEnvironmentResources.push(id); }, async putVaultSecretKey() {}, async removeVaultSecretKey() {},
    async sessionJobState() { return "active" as const; },
    async sessionJobInfo() { return { state: "active" as const, startedAt: null }; },
    async listStorageClasses() { return [{ name: "standard", provisioner: "rancher.io/local-path", isDefault: true }]; },
    async listNodeScheduling() {
      return {
        labels: { "topology.kubernetes.io/zone": ["a", "b"], role: ["gpu"] },
        taints: [{ key: "nvidia.com/gpu", value: "true", effect: "NoSchedule" }],
      };
    },
  };
  return { repo, orchestrator, started, startSpecs, sessions, events, fileRecords, attachCalls };
}

const fakeFiles = {
  store: {} as Record<string, Buffer>,
  put(content: Buffer, key: string) {
    this.store[key] = content;
  },
  get(key: string) { return this.store[key]; },
  delCalls: [] as string[],
  async del(key: string) { this.delCalls.push(key); },
  async *list() { /* GC scan unused by these tests */ },
};

async function build(f = fakes()) {
  const app = Fastify();
  await registerAgentRoutes(app, f.repo, f.orchestrator, fakeFiles);
  return { app, files: fakeFiles, ...f };
}

test("launch gate: session for a deploying model parks instead of launching", async () => {
  const f = fakes();
  const app = Fastify();
  await registerAgentRoutes(app, f.repo, f.orchestrator, fakeFiles, undefined,
    { modelPhase: async () => ({ kind: "local" as const, phase: "Deploying" }) });
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "w1", routing: "m-slow", environmentId: "env_0" } })).json();
  const s = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "go" } });
  assert.equal(s.statusCode, 201);
  assert.equal(s.json().status, "queued");
  assert.deepEqual(s.json().waitingFor, { model: "m-slow", phase: "Deploying" });
  assert.deepEqual(f.started, [], "no Job while the model deploys");
  const pending = (f.repo as any).pendingLaunches;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].model, "m-slow");
  assert.equal(pending[0].payload.id, s.json().id);
  assert.equal(pending[0].payload.prompt, "go", "payload is the replayable startSession argument");
  const evts = f.events[s.json().id];
  assert.ok(evts.some((e: any) => e.type === "session.waiting" && e.payload.model === "m-slow" && e.payload.phase === "Deploying"));
});

test("launch gate: Failed deployment fails the session fast with a clear error", async () => {
  const f = fakes();
  const app = Fastify();
  await registerAgentRoutes(app, f.repo, f.orchestrator, fakeFiles, undefined,
    { modelPhase: async () => ({ kind: "local" as const, phase: "Failed" }) });
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "w2", routing: "m-broken", environmentId: "env_0" } })).json();
  const s = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "go" } });
  assert.equal(s.statusCode, 409);
  assert.match(s.json().error, /m-broken.*Failed/);
  const id = s.json().id;
  assert.ok(id, "the created session id is returned so the failure is inspectable");
  assert.equal(f.sessions.find((x: any) => x.id === id)!.status, "failed");
  assert.ok(f.events[id].some((e: any) => e.type === "session.failed"));
  assert.deepEqual(f.started, []);
  assert.equal((f.repo as any).pendingLaunches.length, 0);
});

test("launch gate: Ready and external models launch immediately", async () => {
  for (const resolved of [{ kind: "local" as const, phase: "Ready" }, { kind: "external" as const }, null]) {
    const f = fakes();
    const app = Fastify();
    await registerAgentRoutes(app, f.repo, f.orchestrator, fakeFiles, undefined, { modelPhase: async () => resolved });
    const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "w3", routing: "m", environmentId: "env_0" } })).json();
    const s = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "go" } });
    assert.equal(s.statusCode, 201);
    assert.deepEqual(f.started, [s.json().id]);
    assert.equal((f.repo as any).pendingLaunches.length, 0);
  }
});

test("launch gate: the local model's served context rides the launch payload", async () => {
  const f = fakes();
  const app = Fastify();
  await registerAgentRoutes(app, f.repo, f.orchestrator, fakeFiles, undefined,
    { modelPhase: async () => ({ kind: "local" as const, phase: "Ready", contextTokens: 32768 }) });
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "w6", routing: "m-32k", environmentId: "env_0" } })).json();
  const s = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "go" } });
  assert.equal(s.statusCode, 201);
  assert.equal(f.startSpecs[0].contextWindow, 32768, "runner needs the real window for auto-compaction");
});

test("launch gate: a parked payload carries the served context too", async () => {
  const f = fakes();
  const app = Fastify();
  await registerAgentRoutes(app, f.repo, f.orchestrator, fakeFiles, undefined,
    { modelPhase: async () => ({ kind: "local" as const, phase: "Deploying", contextTokens: 16384 }) });
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "w6b", routing: "m-16k", environmentId: "env_0" } })).json();
  await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "go" } });
  assert.equal((f.repo as any).pendingLaunches[0].payload.contextWindow, 16384);
});

test("launch gate: follow-up message parks on a deploying model too", async () => {
  const f = fakes();
  const app = Fastify();
  await registerAgentRoutes(app, f.repo, f.orchestrator, fakeFiles, undefined,
    { modelPhase: async () => ({ kind: "local" as const, phase: "Downloading" }) });
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "w4", routing: "m-dl", environmentId: "env_0" } })).json();
  // Seed an idle session directly (fake startTurn requires idle).
  f.sessions.push({ id: "sesn_idle", agent_id: a.id, workspace_id: "wrkspc_default", status: "idle", turns: 0 });
  f.events["sesn_idle"] = [];
  const r = await app.inject({ method: "POST", url: "/v1/sessions/sesn_idle/messages", payload: { prompt: "again" } });
  assert.equal(r.statusCode, 202);
  assert.deepEqual(r.json().waitingFor, { model: "m", phase: "Downloading" });
  assert.deepEqual(f.started, []);
  const pending = (f.repo as any).pendingLaunches;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.resume.turn, 1, "parked payload keeps the resume state");
});

test("launch gate: interrupting a waiting session clears its pending launch", async () => {
  const f = fakes();
  const app = Fastify();
  await registerAgentRoutes(app, f.repo, f.orchestrator, fakeFiles, undefined,
    { modelPhase: async () => ({ kind: "local" as const, phase: "Deploying" }) });
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "w5", routing: "m-slow", environmentId: "env_0" } })).json();
  const s = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "go" } })).json();
  assert.equal((f.repo as any).pendingLaunches.length, 1);
  const i = await app.inject({ method: "POST", url: `/v1/sessions/${s.id}/interrupt` });
  assert.equal(i.statusCode, 200);
  assert.equal((f.repo as any).pendingLaunches.length, 0, "interrupt un-parks the launch");
  assert.equal(f.sessions.find((x: any) => x.id === s.id)!.status, "idle");
});

test("agent create → session create starts workload", async () => {
  const { app, started } = await build();
  const a = await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "triage", routing: "qwen05b-dp", tools: ["Bash"], environmentId: "env_0" } });
  assert.equal(a.statusCode, 201);
  const s = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.json().id, prompt: "go", name: "ZD-1" } });
  assert.equal(s.statusCode, 201);
  assert.deepEqual(started, [s.json().id]);
});

test("session for unknown agent → 404", async () => {
  const { app } = await build();
  const s = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: "agent_missing", prompt: "go" } });
  assert.equal(s.statusCode, 404);
});

test("runner callback appends events and terminal status", async () => {
  const { app } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "x", routing: "m", environmentId: "env_0" } })).json();
  const s = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "p" } })).json();

  const post = await app.inject({
    method: "POST", url: `/v1/sessions/${s.id}/events`,
    payload: { events: [{ type: "agent.message", payload: { text: "hi" }, tokensOut: 5 }] },
  });
  assert.equal(post.statusCode, 202);

  await app.inject({ method: "POST", url: `/v1/sessions/${s.id}/status`, payload: { status: "completed" } });
  const detail = (await app.inject({ method: "GET", url: `/v1/sessions/${s.id}` })).json();
  assert.equal(detail.status, "completed");
  const events = (await app.inject({ method: "GET", url: `/v1/sessions/${s.id}/events` })).json().events;
  assert.equal(events[0].type, "user");
  assert.equal(events[1].type, "agent.message");
});

test("runner callback reframes a routing-reject session.failed error before storing it", async () => {
  const { app } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "reframe", routing: "m", environmentId: "env_0" } })).json();
  const s = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "p" } })).json();

  const post = await app.inject({
    method: "POST", url: `/v1/sessions/${s.id}/events`,
    payload: { events: [{ type: "session.failed", payload: {
      error: "Failed to authenticate. API Error: 403 403: {'error': 'no routing rule matched', 'routing': 'test'}",
    } }] },
  });
  assert.equal(post.statusCode, 202);

  const events = (await app.inject({ method: "GET", url: `/v1/sessions/${s.id}/events` })).json().events;
  const failed = events.find((e: any) => e.type === "session.failed");
  assert.equal(
    failed.payload.error,
    "routing 'test' rejected the request (no rule matched — check the routing's Trace tab). "
      + "API Error: 403 403: {'error': 'no routing rule matched', 'routing': 'test'}",
  );
});

test("POST /v1/files/raw attributes a session checkpoint to the session's workspace", async () => {
  const { app, fileRecords } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "wsraw", routing: "m", environmentId: "env_0" } })).json();
  const s = (await app.inject({
    method: "POST", url: "/v1/sessions",
    headers: { "x-devproof-workspace": "wrkspc_test" },
    payload: { agent: a.id, prompt: "go" },
  })).json();

  const res = await app.inject({
    method: "POST",
    url: `/v1/files/raw?name=checkpoint.tar&session=${s.id}&kind=checkpoint`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from("hello"),
  });
  assert.equal(res.statusCode, 201);
  const rec = fileRecords.find((r) => r.sessionId === s.id);
  assert.equal(rec.workspaceId, "wrkspc_test");
});

test("POST /v1/files/raw without a session keeps default-workspace behavior", async () => {
  const { app, fileRecords } = await build();
  const res = await app.inject({
    method: "POST",
    url: "/v1/files/raw?name=standalone.bin",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from("hello"),
  });
  assert.equal(res.statusCode, 201);
  const rec = fileRecords.find((r) => r.name === "standalone.bin");
  assert.equal(rec.workspaceId, undefined);
});

test("GET /v1/usage/gateway forwards workspace and filters to repo", async () => {
  const { app } = await build();
  const res = await app.inject({
    method: "GET",
    url: "/v1/usage/gateway?range=3m&deployment=dep-a&api_key=apikey_1",
    headers: { "x-devproof-workspace": "wrkspc_test" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.calledWith, { ws: "wrkspc_test", range: "3m", deployment: "dep-a", apiKeyId: "apikey_1" });
});

test("messages to non-idle session -> 409; idle session resumes", async () => {
  const { app, started } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "mt", routing: "m", environmentId: "env_0" } })).json();
  const s = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "p" } })).json();

  const early = await app.inject({ method: "POST", url: `/v1/sessions/${s.id}/messages`, payload: { prompt: "again" } });
  assert.equal(early.statusCode, 409);

  await app.inject({ method: "POST", url: `/v1/sessions/${s.id}/status`, payload: { status: "idle", sdkSessionId: "sdk1" } });
  const ok = await app.inject({ method: "POST", url: `/v1/sessions/${s.id}/messages`, payload: { prompt: "again" } });
  assert.equal(ok.statusCode, 202);
  assert.equal(started.length, 2);
});

test("POST /v1/sessions records the prompt as the first user event", async () => {
  const { app } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "u1", routing: "m", environmentId: "env_0" } })).json();
  const res = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "do the thing" } });
  assert.equal(res.statusCode, 201);
  const { id } = res.json();
  const evs = (await app.inject({ method: "GET", url: `/v1/sessions/${id}/events` })).json().events;
  assert.equal(evs[0].type, "user");
  assert.equal(evs[0].payload.text, "do the thing");
  assert.equal(evs[0].payload.turn, 0);
});

test("POST /v1/sessions with unknown file id -> 400, no phantom session row", async () => {
  const { app, started, sessions } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "f1", routing: "m", environmentId: "env_0" } })).json();
  const res = await app.inject({
    method: "POST", url: "/v1/sessions",
    payload: { agent: a.id, prompt: "do the thing", files: ["file_nope"] },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(started.length, 0);
  assert.equal(sessions.length, 0); // validated before createSession -> no phantom queued row
});

test("POST /v1/sessions/:id/messages records a user event with the turn number", async () => {
  const { app } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "u2", routing: "m", environmentId: "env_0" } })).json();
  const { id } = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "first" } })).json();
  await app.inject({ method: "POST", url: `/v1/sessions/${id}/status`, payload: { status: "idle" } });
  const res = await app.inject({ method: "POST", url: `/v1/sessions/${id}/messages`, payload: { prompt: "follow up" } });
  assert.equal(res.statusCode, 202);
  const evs = (await app.inject({ method: "GET", url: `/v1/sessions/${id}/events` })).json().events;
  const user = evs.filter((e: any) => e.type === "user");
  assert.equal(user.length, 2);
  assert.equal(user[1].payload.text, "follow up");
  assert.equal(user[1].payload.turn, 1);
});

test("POST /v1/sessions/:id/messages records follow-up attachments as input files", async () => {
  const { app, repo, attachCalls } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "fu", routing: "m", environmentId: "env_0" } })).json();
  const { id } = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "first" } })).json();
  await app.inject({ method: "POST", url: `/v1/sessions/${id}/status`, payload: { status: "idle" } });
  await repo.createFileRecord({ id: "file_x", name: "x.txt", sha256: "x", size: 1, objectKey: "wrkspc_default/files/file_x" });

  const res = await app.inject({
    method: "POST", url: `/v1/sessions/${id}/messages`,
    payload: { prompt: "follow up", files: ["file_x"] },
  });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(attachCalls, [{ sessionId: id, fileIds: ["file_x"], kind: "input" }]);
});

test("POST /v1/sessions/:id/messages with unknown file id -> 400 before the user event is appended", async () => {
  const { app, events, attachCalls, sessions } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "fu2", routing: "m", environmentId: "env_0" } })).json();
  const { id } = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "first" } })).json();
  await app.inject({ method: "POST", url: `/v1/sessions/${id}/status`, payload: { status: "idle" } });

  const res = await app.inject({
    method: "POST", url: `/v1/sessions/${id}/messages`,
    payload: { prompt: "follow up", files: ["file_nope"] },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(events[id].filter((e: any) => e.type === "user").length, 1); // only the original prompt event
  assert.deepEqual(attachCalls, []);
  // validated before startTurn -> session is not wedged, still idle, turn not consumed
  assert.equal(sessions.find((s: any) => s.id === id).status, "idle");

  const retry = await app.inject({ method: "POST", url: `/v1/sessions/${id}/messages`, payload: { prompt: "follow up ok" } });
  assert.equal(retry.statusCode, 202);
});

test("GET /v1/deployments/:name/stats maps windows and filters", async () => {
  const { app } = await build();
  const res = await app.inject({ method: "GET", url: "/v1/deployments/dep-a/stats?window=5m&agent=agent_1" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.window, "5m");
  assert.equal(body.bucketSeconds, 10);
  assert.deepEqual(body.calledWith, { model: "dep-a", windowSec: 300, bucketSec: 10, agentId: "agent_1" });
});

test("GET stats: __internal__ key maps to sessionOnly; bad window -> 400", async () => {
  const { app } = await build();
  const internal = await app.inject({ method: "GET", url: "/v1/deployments/dep-a/stats?window=1m&api_key=__internal__" });
  assert.deepEqual(internal.json().calledWith, { model: "dep-a", windowSec: 60, bucketSec: 2, sessionOnly: true });
  const bad = await app.inject({ method: "GET", url: "/v1/deployments/dep-a/stats?window=2d" });
  assert.equal(bad.statusCode, 400);
});

test("PATCH /v1/environments/:id updates and re-syncs the egress policy", async () => {
  const { app, orchestrator } = await build();
  const res = await app.inject({
    method: "PATCH", url: "/v1/environments/env_0",
    payload: { name: "renamed", allowedHosts: ["*.dremio.com"], allowPackageManagers: true },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().name, "renamed");
  const last = (orchestrator as any).envPolicies.at(-1);
  assert.deepEqual(last, { id: "env_0", allowedHosts: ["*.dremio.com"], allowPackageManagers: true, mcpHosts: [] });
});

test("PATCH /v1/environments/:id → 404 for unknown id", async () => {
  const { app } = await build();
  const res = await app.inject({ method: "PATCH", url: "/v1/environments/env_missing", payload: { name: "x" } });
  assert.equal(res.statusCode, 404);
});

test("startSession receives the workspace for attribution headers", async () => {
  const { app, startSpecs } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "attr", routing: "m", environmentId: "env_0" } })).json();
  await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "p" },
    headers: { "x-devproof-workspace": "wrkspc_attr" } });
  assert.equal(startSpecs[0].workspace, "wrkspc_attr");
});

test("GET /v1/api-keys excludes deleted by default, includes with ?include=deleted", async (t) => {
  const { app, repo } = await build();
  await app.inject({ method: "GET", url: "/v1/api-keys" });
  await app.inject({ method: "GET", url: "/v1/api-keys?include=deleted" });
  assert.deepEqual((repo as any).apiKeyCalls.map((c: any) => c.includeDeleted), [false, true]);
});

test("GET /v1/sessions?file= passes the file filter to the repo", async () => {
  const { app, repo } = await build();
  await app.inject({ method: "GET", url: "/v1/sessions?file=file_abc" });
  assert.equal((repo as any).sessionListCalls.at(-1).fileId, "file_abc");
});

test("GET /v1/files/:id returns 404 for unknown file", async () => {
  const { app } = await build();
  const res = await app.inject({ method: "GET", url: "/v1/files/file_missing" });
  assert.equal(res.statusCode, 404);
});

test("list endpoints honor ?limit= capped at 1000", async () => {
  const { app, repo } = await build();
  await app.inject({ method: "GET", url: "/v1/agents" });
  await app.inject({ method: "GET", url: "/v1/agents?limit=1000" });
  await app.inject({ method: "GET", url: "/v1/agents?limit=99999" });
  assert.deepEqual((repo as any).agentListCalls.map((c: any) => c.limit), [100, 1000, 1000]);
});

test("checkpoint replacement deletes the previous file row + object", async () => {
  const { app, repo, files } = await build();
  await app.inject({
    method: "POST", url: "/v1/sessions/sesn_x/status",
    payload: { status: "idle", checkpointFileId: "file_new000000001" },
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual((repo as any).deletedFileRecords, ["file_old000000001"]);
  assert.deepEqual(files.delCalls, ["file_old000000001"]);
});

test("memory upsert deletes replaced file rows + objects", async () => {
  const { app, repo, files, sessions } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "mem", routing: "m", environmentId: "env_0" } })).json();
  const { id } = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "p" } })).json();
  sessions.find((s: any) => s.id === id).memory_store_id = "memstore_1";

  await app.inject({
    method: "POST", url: `/v1/sessions/${id}/memory`,
    payload: { entries: [{ path: "notes.md", fileId: "file_new000000002" }] },
  });
  await new Promise((r) => setImmediate(r));
  assert.ok((repo as any).deletedFileRecords.includes("file_old000000002"));
  assert.ok(files.delCalls.includes("file_old000000002"));
});

test("disabled agent: new sessions and follow-ups are 409, status route validates", async () => {
  const { app } = await build();
  const created = await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "d1", routing: "m", environmentId: "env_0" } });
  const agentId = created.json().id;
  const s = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: agentId, prompt: "hi" } });
  assert.equal(s.statusCode, 201);
  const sessionId = s.json().id;

  assert.equal((await app.inject({ method: "POST", url: `/v1/agents/${agentId}/status`, payload: { status: "nope" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/v1/agents/agent_missing/status", payload: { status: "disabled" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: `/v1/agents/${agentId}/status`, payload: { status: "disabled" } })).statusCode, 200);

  const s2 = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: agentId, prompt: "hi again" } });
  assert.equal(s2.statusCode, 409);
  assert.equal(s2.json().error, "agent disabled");

  // follow-up on the existing session also 409s (agent-disabled check fires before the idle check)
  await app.inject({ method: "POST", url: `/v1/sessions/${sessionId}/status`, payload: { status: "idle" } });
  const m = await app.inject({ method: "POST", url: `/v1/sessions/${sessionId}/messages`, payload: { prompt: "more" } });
  assert.equal(m.statusCode, 409);
  assert.equal(m.json().error, "agent disabled");

  // header-independent: a wrong X-Devproof-Workspace header must not bypass
  // the disabled check — the owner lookup uses the SESSION's own workspace.
  const mOther = await app.inject({
    method: "POST", url: `/v1/sessions/${sessionId}/messages`, payload: { prompt: "more" },
    headers: { "x-devproof-workspace": "wrkspc_other" },
  });
  assert.equal(mOther.statusCode, 409);
  assert.equal(mOther.json().error, "agent disabled");

  await app.inject({ method: "POST", url: `/v1/agents/${agentId}/status`, payload: { status: "active" } });
  const s3 = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: agentId, prompt: "back" } });
  assert.equal(s3.statusCode, 201);
});

test("DELETE /v1/memory-stores/:id/entries deletes orphaned file rows + objects", async () => {
  const { app, repo, files } = await build();
  (repo as any).memoryEntries = [{ path: "test.md", file_id: "file_old000000003", updated_at: "2026-07-10" }];

  const res = await app.inject({
    method: "DELETE", url: "/v1/memory-stores/memstore_0/entries?path=test.md",
  });
  assert.equal(res.statusCode, 204);
  await new Promise((r) => setImmediate(r));
  assert.ok((repo as any).deletedFileRecords.includes("file_old000000003"));
  assert.ok(files.delCalls.includes("file_old000000003"));
});

test("GET /v1/sessions/:id/resume returns the CURRENT checkpoint id for runner retry", async () => {
  const { app, sessions } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "ckpt", routing: "m", environmentId: "env_0" } })).json();
  const s = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "p" } })).json();

  // Before any checkpoint exists the field is null, not absent — the runner
  // distinguishes "no checkpoint" from "session gone".
  const empty = await app.inject({ method: "GET", url: `/v1/sessions/${s.id}/resume` });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.json().checkpointFileId, null);

  // Simulate a completed turn having replaced the checkpoint.
  sessions.find((x: any) => x.id === s.id).checkpoint_file_id = "file_current00001";
  const res = await app.inject({ method: "GET", url: `/v1/sessions/${s.id}/resume` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().checkpointFileId, "file_current00001");
});

test("GET /v1/sessions/:id/resume 404s for an unknown session", async () => {
  const { app } = await build();
  const res = await app.inject({ method: "GET", url: "/v1/sessions/sesn_missing/resume" });
  assert.equal(res.statusCode, 404);
});

test("stale-turn runner status post does not clobber a follow-up turn", async () => {
  const { app, files } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "stale", routing: "m", environmentId: "env_0" } })).json();
  const s = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "first" } })).json();

  // Turn 0 finishes (turn attributed, matches turns=0): applies.
  const t0 = await app.inject({ method: "POST", url: `/v1/sessions/${s.id}/status`, payload: { status: "idle", turn: 0 } });
  assert.equal(t0.json().applied, true);

  // Follow-up: turns -> 1, status queued.
  const fu = await app.inject({ method: "POST", url: `/v1/sessions/${s.id}/messages`, payload: { prompt: "again" } });
  assert.equal(fu.statusCode, 202);

  // The interrupted turn-0 pod reports late with a checkpoint: ignored — the
  // session's checkpoint is NOT replaced/deleted, and the rejected salvage
  // tarball itself is reclaimed (referenced nowhere once the post is refused).
  const delsBefore = files.delCalls.length;
  const stale = await app.inject({
    method: "POST",
    url: `/v1/sessions/${s.id}/status`,
    payload: { status: "idle", turn: 0, checkpointFileId: "file_stalecp00001" },
  });
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.json().applied, false);
  assert.deepEqual(files.delCalls.slice(delsBefore), ["file_stalecp00001"]); // reclaim only the rejected salvage
  const detail = (await app.inject({ method: "GET", url: `/v1/sessions/${s.id}` })).json();
  assert.equal(detail.status, "queued"); // not clobbered back to idle

  // A post WITHOUT turn (pre-dev23 pod) still applies — backward compatible.
  const legacy = await app.inject({ method: "POST", url: `/v1/sessions/${s.id}/status`, payload: { status: "idle" } });
  assert.equal(legacy.json().applied, true);
});

// Webhook delivery is fire-and-forget — capture the payload via a fetch stub
// and poll briefly for it (there's no handle to await).
async function withWebhookCapture(fn: (delivered: any[]) => Promise<void>) {
  const delivered: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    delivered.push(JSON.parse(init.body));
    return { ok: true };
  }) as any;
  try { await fn(delivered); } finally { globalThis.fetch = realFetch; }
}
const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

test("runner idle status for a delegated child (parent_session_id set) stays idle — completion is an explicit parent action, not auto-substituted", async () => {
  const f = await build();
  const { app, sessions } = f;
  (f.repo as any).listWebhooks = async () => [
    { url: "http://hook.test/x", events: ["session.completed", "session.idle"] }];
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "child-a", routing: "m", environmentId: "env_0" } })).json();
  const s = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "go" } })).json();
  sessions.find((x: any) => x.id === s.id).parent_session_id = "sesn_parent";

  await withWebhookCapture(async (delivered) => {
    const res = await app.inject({ method: "POST", url: `/v1/sessions/${s.id}/status`, payload: { status: "idle", turn: 0 } });
    assert.equal(res.json().applied, true);
    const detail = (await app.inject({ method: "GET", url: `/v1/sessions/${s.id}` })).json();
    assert.equal(detail.status, "idle");
    // A child idle post is a normal session.idle event, same as any session.
    await waitFor(() => delivered.length > 0);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].event, "session.idle");
  });
});

test("runner idle status for a parentless session stays idle", async () => {
  const f = await build();
  const { app } = f;
  (f.repo as any).listWebhooks = async () => [
    { url: "http://hook.test/x", events: ["session.completed", "session.idle"] }];
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "no-parent", routing: "m", environmentId: "env_0" } })).json();
  const s = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "go" } })).json();

  await withWebhookCapture(async (delivered) => {
    const res = await app.inject({ method: "POST", url: `/v1/sessions/${s.id}/status`, payload: { status: "idle", turn: 0 } });
    assert.equal(res.json().applied, true);
    const detail = (await app.inject({ method: "GET", url: `/v1/sessions/${s.id}` })).json();
    assert.equal(detail.status, "idle");
    await waitFor(() => delivered.length > 0);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].event, "session.idle");
  });
});

test("runner failed status for a delegated child stays failed (not substituted to completed)", async () => {
  const { app, sessions } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "child-fail", routing: "m", environmentId: "env_0" } })).json();
  const s = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "go" } })).json();
  sessions.find((x: any) => x.id === s.id).parent_session_id = "sesn_parent";

  const res = await app.inject({ method: "POST", url: `/v1/sessions/${s.id}/status`, payload: { status: "failed", turn: 0 } });
  assert.equal(res.json().applied, true);
  const detail = (await app.inject({ method: "GET", url: `/v1/sessions/${s.id}` })).json();
  assert.equal(detail.status, "failed");
});

test("stale-turn idle status post for a delegated child is still rejected — status untouched", async () => {
  const { app, sessions } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "child-stale", routing: "m", environmentId: "env_0" } })).json();
  const s = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "go" } })).json();
  const childSession = sessions.find((x: any) => x.id === s.id);
  childSession.parent_session_id = "sesn_parent";
  // Simulate a follow-up having already advanced the turn (as the stale-turn
  // guard test above does), so this turn-0 post is now stale.
  childSession.turns = 1;
  childSession.status = "queued";

  const res = await app.inject({ method: "POST", url: `/v1/sessions/${s.id}/status`, payload: { status: "idle", turn: 0 } });
  assert.equal(res.json().applied, false);
  const detail = (await app.inject({ method: "GET", url: `/v1/sessions/${s.id}` })).json();
  assert.equal(detail.status, "queued");
});

test("environment create accepts a pod config and passes it to the repo", async () => {
  const { app } = await build();
  const res = await app.inject({ method: "POST", url: "/v1/environments", payload: {
    name: "big", pod: { requests: { cpu: "500m" }, disk: { type: "pvc", storageClass: "standard", sizeGb: 128 } },
  } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().pod.disk.sizeGb, 128);
});

test("environment create/patch rejects invalid pod configs with 400", async () => {
  const { app } = await build();
  for (const pod of [
    { requests: { cpu: "lots" } },
    { disk: { type: "hostPath" } },
    { disk: { type: "pvc", sizeGb: 64 } },
  ]) {
    const res = await app.inject({ method: "POST", url: "/v1/environments", payload: { name: "bad", pod } });
    assert.equal(res.statusCode, 400, JSON.stringify(pod));
  }
  const patch = await app.inject({ method: "PATCH", url: "/v1/environments/env_0", payload: { pod: { limits: { memory: "1 GB" } } } });
  assert.equal(patch.statusCode, 400);
});

test("GET /v1/storage-classes returns the cluster's classes", async () => {
  const { app } = await build();
  const res = await app.inject({ method: "GET", url: "/v1/storage-classes" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { storageClasses: [{ name: "standard", provisioner: "rancher.io/local-path", isDefault: true }] });
});

test("agent create without environment → 400; unknown environment → 400", async () => {
  const { app } = await build();
  const missing = await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "x", routing: "m" } });
  assert.equal(missing.statusCode, 400);
  const unknown = await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "x", routing: "m", environmentId: "env_nope" } });
  assert.equal(unknown.statusCode, 400);
});

test("agent create/version: routing must reference an existing routing (spec 2026-07-16 amendment)", async () => {
  const f = fakes();
  (f.repo as any).knownRoutings = new Set(["my-route"]);
  const { app } = await build(f);
  const bad = await app.inject({ method: "POST", url: "/v1/agents",
    payload: { name: "x", routing: "not-a-routing", environmentId: "env_0" } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, "routing must reference an existing routing");
  const ok = await app.inject({ method: "POST", url: "/v1/agents",
    payload: { name: "x", routing: "my-route", environmentId: "env_0" } });
  assert.equal(ok.statusCode, 201);
  const badVersion = await app.inject({ method: "POST", url: `/v1/agents/${ok.json().id}/versions`,
    payload: { routing: "not-a-routing", environmentId: "env_0" } });
  assert.equal(badVersion.statusCode, 400);
  assert.equal(badVersion.json().error, "routing must reference an existing routing");
  const okVersion = await app.inject({ method: "POST", url: `/v1/agents/${ok.json().id}/versions`,
    payload: { routing: "my-route", environmentId: "env_0" } });
  assert.equal(okVersion.statusCode, 201);
});

test("agent version without environment → 400", async () => {
  const { app } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "x", routing: "m", environmentId: "env_0" } })).json();
  const res = await app.inject({ method: "POST", url: `/v1/agents/${a.id}/versions`, payload: { routing: "m" } });
  assert.equal(res.statusCode, 400);
});

test("session start passes the resolved environment to the orchestrator", async () => {
  const { app, startSpecs } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "x", routing: "m", environmentId: "env_0" } })).json();
  const s = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "p" } });
  assert.equal(s.statusCode, 201);
  assert.deepEqual(startSpecs[0].environment, { id: "env_0", pod: {}, allowPackageManagers: false });
});

test("session start when the agent version has no environment → 400", async () => {
  const f = fakes();
  (f.repo as any).envForVersion = false;
  const { app } = await build(f);
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "x", routing: "m", environmentId: "env_0" } })).json();
  const res = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "p" } });
  assert.equal(res.statusCode, 400);
});

test("agent create/version reject unknown skill ids; known ids pass", async () => {
  const f = fakes();
  (f.repo as any).knownSkillIds = ["skill_ok"];
  const { app } = await build(f);
  const bad = await app.inject({ method: "POST", url: "/v1/agents",
    payload: { name: "x", routing: "m", environmentId: "env_0", skillIds: ["skill_ok", "skill_gone"] } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /skill_gone/);
  const ok = await app.inject({ method: "POST", url: "/v1/agents",
    payload: { name: "x", routing: "m", environmentId: "env_0", skillIds: ["skill_ok"] } });
  assert.equal(ok.statusCode, 201);
  const badVersion = await app.inject({ method: "POST", url: `/v1/agents/${ok.json().id}/versions`,
    payload: { routing: "m", environmentId: "env_0", skillIds: ["skill_gone"] } });
  assert.equal(badVersion.statusCode, 400);
});

test("DELETE /v1/skills/:id → 409 when referenced by an agent version; 204 when unused", async () => {
  const f = fakes();
  (f.repo as any).skillUsed = true;
  const { app } = await build(f);
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/skills/skill_0" })).statusCode, 409);
  (f.repo as any).skillUsed = false;
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/skills/skill_0" })).statusCode, 204);
});

test("DELETE /v1/environments/:id → 409 when referenced by an agent; 204 and teardown when unused", async () => {
  const f = fakes();
  (f.repo as any).envInUse = true;
  const { app } = await build(f);
  const blocked = await app.inject({ method: "DELETE", url: "/v1/environments/env_0" });
  assert.equal(blocked.statusCode, 409);
  assert.deepEqual(f.orchestrator.deletedEnvironmentResources, []);
  (f.repo as any).envInUse = false;
  const ok = await app.inject({ method: "DELETE", url: "/v1/environments/env_0" });
  assert.equal(ok.statusCode, 204);
  assert.deepEqual(f.orchestrator.deletedEnvironmentResources, ["env_0"]);
});

test("PATCH /v1/environments/:id accepts a valid pod and passes it through", async () => {
  const { app } = await build();
  const res = await app.inject({ method: "PATCH", url: "/v1/environments/env_0", payload: {
    pod: { limits: { memory: "2Gi" }, disk: { type: "emptyDir" } },
  } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().pod, { limits: { memory: "2Gi" }, disk: { type: "emptyDir" } });
});

test("POST /v1/environments rejects a disk sizeGb above the settings cap", async () => {
  const { app } = await build();
  // Lower the platform cap below validatePodConfig's 2048 default, so a 500 GiB
  // disk (fine under the default) can only be rejected if the route reads the
  // cap from settings — this proves the wiring, not just the default.
  const settings = (await app.inject({ method: "GET", url: "/v1/settings" })).json();
  await app.inject({ method: "PUT", url: "/v1/settings", payload: { costs: settings.costs, limits: { maxWorkGb: 100 } } });
  const res = await app.inject({
    method: "POST", url: "/v1/environments",
    payload: { name: "big", pod: { disk: { type: "pvc", storageClass: "standard", sizeGb: 500 } } },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /sizeGb/);
});

test("DELETE /v1/sessions/:id tears down the session's k8s resources (durable /work PVC)", async () => {
  const f = fakes();
  const { app } = await build(f);
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "x", routing: "m", environmentId: "env_0" } })).json();
  const s = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "p" } })).json();
  const res = await app.inject({ method: "DELETE", url: `/v1/sessions/${s.id}` });
  assert.equal(res.statusCode, 204);
  assert.deepEqual((f.orchestrator as any).deletedSessionResources, [s.id]);
});

test("PATCH /v1/agents/:id renames; empty name 400; duplicate 409; unknown 404", async () => {
  const { app } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "one", routing: "m", environmentId: "env_0" } })).json();
  await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "two", routing: "m", environmentId: "env_0" } });
  const ok = await app.inject({ method: "PATCH", url: `/v1/agents/${a.id}`, payload: { name: "renamed" } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/v1/agents/${a.id}` })).json().name, "renamed");
  assert.equal((await app.inject({ method: "PATCH", url: `/v1/agents/${a.id}`, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: `/v1/agents/${a.id}`, payload: { name: "two" } })).statusCode, 409);
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/agents/agent_missing", payload: { name: "x" } })).statusCode, 404);
});

test("GET /v1/settings returns costs and limits; PUT persists limits", async () => {
  const { app } = await build();
  const got = await app.inject({ method: "GET", url: "/v1/settings" });
  assert.equal(got.statusCode, 200);
  const body = got.json();
  assert.ok(body.costs, "costs present");
  assert.equal(body.limits.maxWorkGb, 2048);

  const put = await app.inject({
    method: "PUT", url: "/v1/settings",
    payload: { costs: body.costs, limits: { maxWorkGb: 999 } },
  });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().limits.maxWorkGb, 999);

  // A body omitting `limits` echoes the stored cap, not the 2048 default.
  const omitted = await app.inject({
    method: "PUT", url: "/v1/settings",
    payload: { costs: body.costs },
  });
  assert.equal(omitted.statusCode, 200);
  assert.equal(omitted.json().limits.maxWorkGb, 999);

  // An empty `limits` object is a no-op, not a reset to 2048.
  const empty = await app.inject({
    method: "PUT", url: "/v1/settings",
    payload: { costs: body.costs, limits: {} },
  });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.json().limits.maxWorkGb, 999);

  const bad = await app.inject({
    method: "PUT", url: "/v1/settings",
    payload: { costs: body.costs, limits: { maxWorkGb: 0 } },
  });
  assert.equal(bad.statusCode, 400);
});

test("GET /v1/node-scheduling returns labels and taints", async () => {
  const { app } = await build();
  const res = await app.inject({ method: "GET", url: "/v1/node-scheduling" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.labels["role"], ["gpu"]);
  assert.equal(body.taints[0].key, "nvidia.com/gpu");
});

test("usage costs meta carries per-ledger visibility (2026-07-15)", async () => {
  const settingsFor = (enabled: boolean, billing: boolean) => ({
    ...DEFAULT_COST_SETTINGS, enabled,
    billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: billing },
  });
  const costsFor = async (enabled: boolean, billing: boolean, url: string) => {
    const f = fakes();
    f.repo.getCostSettings = async () => settingsFor(enabled, billing);
    const { app } = await build(f);
    return (await app.inject({ method: "GET", url })).json().costs;
  };

  // tokensOnly rides only on the two realtime/stats surfaces; /v1/usage and
  // /v1/usage/gateway return the bare meta.
  for (const url of ["/v1/usage/gateway", "/v1/usage", "/v1/usage/realtime"]) {
    const withTokensOnly = url === "/v1/usage/realtime";
    assert.equal(await costsFor(false, false, url), null, `${url}: both off ⇒ null`);
    assert.deepEqual(
      await costsFor(true, false, url),
      { currency: "EUR", real: true, billed: false, ...(withTokensOnly ? { tokensOnly: false } : {}) },
      `${url}: real only`);
    const billedOnly = await costsFor(false, true, url);
    assert.equal(billedOnly.real, false, `${url}: billing-only ⇒ real false`);
    assert.equal(billedOnly.billed, true, `${url}: billing-only ⇒ billed true`);
  }
});
