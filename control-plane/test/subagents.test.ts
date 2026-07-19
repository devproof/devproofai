// control-plane/test/subagents.test.ts
// Validation + delegate/interrupt actions for agent delegation (spec 2026-07-17).
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSubagents } from "../src/subagents.ts";

// Fake repo: agents visible only in their own workspace (mirrors repo.getAgent).
// name defaults to id — distinct per id, so these fakes never collide on the
// duplicate-target-name check (that's covered by a dedicated fake below).
const agentRepo = (ids: string[]) => ({
  async getAgent(_ws: string, id: string) { return ids.includes(id) ? { id, name: id, status: "active" } : null; },
});

test("validateSubagents: accepts undefined/null/empty", async () => {
  const repo = agentRepo([]);
  assert.equal(await validateSubagents(repo, "ws", null, undefined), null);
  assert.equal(await validateSubagents(repo, "ws", null, null), null);
  assert.equal(await validateSubagents(repo, "ws", null, []), null);
});

test("validateSubagents: shape errors", async () => {
  const repo = agentRepo(["agent_b"]);
  assert.match((await validateSubagents(repo, "ws", null, {}))!, /must be an array/);
  assert.match((await validateSubagents(repo, "ws", null, [{ instructions: "x" }]))!, /agentId required/);
  assert.match((await validateSubagents(repo, "ws", null, [{ agentId: "agent_b" }]))!, /instructions required/);
  assert.match((await validateSubagents(repo, "ws", null,
    [{ agentId: "agent_b", instructions: "  " }]))!, /instructions required/);
  assert.match((await validateSubagents(repo, "ws", null,
    [{ agentId: "agent_b", instructions: "x".repeat(2001) }]))!, /too long/);
});

test("validateSubagents: self, duplicate, unknown, cross-workspace", async () => {
  const repo = agentRepo(["agent_b"]);
  assert.match((await validateSubagents(repo, "ws", "agent_self",
    [{ agentId: "agent_self", instructions: "x" }]))!, /itself/);
  assert.match((await validateSubagents(repo, "ws", null, [
    { agentId: "agent_b", instructions: "x" },
    { agentId: "agent_b", instructions: "y" }]))!, /duplicate/);
  assert.match((await validateSubagents(repo, "ws", null,
    [{ agentId: "agent_missing", instructions: "x" }]))!, /unknown agent/);
  assert.equal(await validateSubagents(repo, "ws", null,
    [{ agentId: "agent_b", instructions: "use for code review" }]), null);
});

test("validateSubagents: two different agent ids sharing a name ⇒ duplicate target name", async () => {
  // Names aren't unique — a fake repo where agent_b and agent_c both resolve
  // to "reviewer" mirrors two same-named agent rows in the same workspace.
  const repo = {
    async getAgent(_ws: string, id: string) {
      const byId: Record<string, { name: string }> = {
        agent_b: { name: "reviewer" }, agent_c: { name: "reviewer" },
      };
      return byId[id] ?? null;
    },
  };
  const err = await validateSubagents(repo, "ws", null, [
    { agentId: "agent_b", instructions: "x" },
    { agentId: "agent_c", instructions: "y" },
  ]);
  assert.match(err!, /duplicate target name/);
  assert.match(err!, /reviewer/);
});

import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";

const pool = createPool();
let dbAvailable = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { dbAvailable = false; }
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test("subagents round-trip through agent_versions; sessions get parent_session_id", { skip: !dbAvailable }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-sub-${uniq()}`)).id;
  const target = await repo.createAgent(ws, `t-sub-t-${uniq()}`, { routing: "r", tools: [] });
  const parent = await repo.createAgent(ws, `t-sub-p-${uniq()}`, {
    routing: "r", tools: [], subagents: [{ agentId: target.id, instructions: "reviews code" }],
  });
  const v = await repo.getAgentVersion(parent.id);
  assert.deepEqual(v.subagents, [{ agentId: target.id, instructions: "reviews code" }]);
  const { rows } = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'parent_session_id'");
  assert.equal(rows.length, 1);

  // The pinned version's subagents surface in sessionResources, resolved to
  // the target's current name — the "when to use" instructions otherwise
  // only ride the launch-time system prompt with no UI surface confirming
  // them (spec: post-merge-review fix, 2026-07-17).
  const session = await repo.createSession(ws, parent.id, "go");
  const resources = await repo.sessionResources(session.id, ws);
  assert.deepEqual(resources!.subagents, [
    { agentId: target.id, name: target.name, instructions: "reviews code" },
  ]);
});

test("repo.wasInterrupted: true only when session.interrupted is the newer of the two signals", { skip: !dbAvailable }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-sub-${uniq()}`)).id;
  const agent = await repo.createAgent(ws, `t-sub-wi-${uniq()}`, { routing: "r", tools: [] });
  const noEvents = await repo.createSession(ws, agent.id, "go");
  assert.equal(await repo.wasInterrupted(noEvents.id), false);

  const resultOnly = await repo.createSession(ws, agent.id, "go");
  await repo.appendEvents(resultOnly.id, [{ type: "session.result", payload: {} }]);
  assert.equal(await repo.wasInterrupted(resultOnly.id), false);

  const interruptedOnly = await repo.createSession(ws, agent.id, "go");
  await repo.appendEvents(interruptedOnly.id, [{ type: "session.interrupted", payload: { by: "user" } }]);
  assert.equal(await repo.wasInterrupted(interruptedOnly.id), true);

  const resultThenInterrupted = await repo.createSession(ws, agent.id, "go");
  await repo.appendEvents(resultThenInterrupted.id, [{ type: "session.result", payload: {} }]);
  await repo.appendEvents(resultThenInterrupted.id, [{ type: "session.interrupted", payload: { by: "user" } }]);
  assert.equal(await repo.wasInterrupted(resultThenInterrupted.id), true);

  const interruptedThenResult = await repo.createSession(ws, agent.id, "go");
  await repo.appendEvents(interruptedThenResult.id, [{ type: "session.interrupted", payload: { by: "user" } }]);
  await repo.appendEvents(interruptedThenResult.id, [{ type: "session.result", payload: {} }]);
  assert.equal(await repo.wasInterrupted(interruptedThenResult.id), false);
});

import { createSessionAction } from "../src/session-actions.ts";

// Minimal fakes for the action layer (subset of test/agents-api.test.ts fakes()).
function actionFakes(opts: { subagents?: any[]; targetStatus?: string } = {}) {
  const started: any[] = [];
  const repo = {
    agents: [
      { id: "agent_p", name: "parent", status: "active" },
      { id: "agent_t", name: "reviewer", status: opts.targetStatus ?? "active" },
    ],
    async getAgent(_ws: string, id: string) {
      return (this as any).agents.find((a: any) => a.id === id) ?? null;
    },
    async getAgentVersion(id: string) {
      return { agent_id: id, version: 1, routing: "r", system_prompt: "", tools: [],
               max_turns: 10, environment_id: "env_0", subagents: opts.subagents ?? [] };
    },
    async getEnvironment(id: string) { return { id, pod: {} }; },
    async listFileRecords(ids: string[]) { return ids.map((id) => ({ id, name: id })); },
    sessions: [] as any[],
    async createSession(_ws: string, agentId: string, prompt: string, name?: string, parentSessionId?: string) {
      const s = { id: `sesn_${(this as any).sessions.length}`, agent_id: agentId, workspace_id: _ws,
                  status: "queued", turns: 0, parent_session_id: parentSessionId ?? null, prompt };
      (this as any).sessions.push(s);
      return { id: s.id, agentId, agentVersion: 1,
               config: await (this as any).getAgentVersion(agentId) };
    },
    async appendEvents() { return 1; },
    async attachSessionFiles() {},
    async listSkills() { return []; },
    async listVaultCredentials() { return []; },
    async getSession(id: string) { return (this as any).sessions.find((s: any) => s.id === id) ?? null; },
    async childSessionCounts() { return { total: 0, inFlight: 0 }; },
  };
  const orchestrator = { async startSession(launch: any) { started.push(launch); } } as any;
  return { repo, orchestrator, started };
}

test("createSessionAction: resolves subagents (name + id + instructions) into the launch", async () => {
  const f = actionFakes({ subagents: [{ agentId: "agent_t", instructions: "reviews code" }] });
  const r = await createSessionAction({ repo: f.repo, orchestrator: f.orchestrator }, "ws", {
    agent: "agent_p", prompt: "go" });
  assert.equal(r.code, 201);
  assert.deepEqual(f.started[0].subagents,
    [{ name: "reviewer", agentId: "agent_t", instructions: "reviews code" }]);
});

test("createSessionAction: a child session (parentSessionId set) gets NO subagents — one level only", async () => {
  const f = actionFakes({ subagents: [{ agentId: "agent_t", instructions: "reviews code" }] });
  (f.repo as any).sessions.push({ id: "sesn_parent", workspace_id: "ws", status: "running" });
  const r = await createSessionAction({ repo: f.repo, orchestrator: f.orchestrator }, "ws", {
    agent: "agent_p", prompt: "go", parentSessionId: "sesn_parent" });
  assert.equal(r.code, 201);
  assert.deepEqual(f.started[0].subagents, []);
  const child = (f.repo as any).sessions.find((s: any) => s.agent_id === "agent_p");
  assert.equal(child.parent_session_id, "sesn_parent");
});

test("createSessionAction: unknown or cross-workspace parentSessionId ⇒ 400", async () => {
  const f = actionFakes();
  const rMissing = await createSessionAction({ repo: f.repo, orchestrator: f.orchestrator }, "ws", {
    agent: "agent_p", prompt: "go", parentSessionId: "sesn_missing" });
  assert.equal(rMissing.code, 400);

  (f.repo as any).sessions.push({ id: "sesn_other_ws", workspace_id: "other", status: "running" });
  const rCrossWs = await createSessionAction({ repo: f.repo, orchestrator: f.orchestrator }, "ws", {
    agent: "agent_p", prompt: "go", parentSessionId: "sesn_other_ws" });
  assert.equal(rCrossWs.code, 400);
});

test("createSessionAction: a configured subagent whose row was deleted is skipped, not fatal", async () => {
  const f = actionFakes({ subagents: [{ agentId: "agent_gone", instructions: "x" }] });
  const r = await createSessionAction({ repo: f.repo, orchestrator: f.orchestrator }, "ws", {
    agent: "agent_p", prompt: "go" });
  assert.equal(r.code, 201);
  assert.deepEqual(f.started[0].subagents, []);
});

import { delegateAction, delegateStatusAction, DELEGATED_PROMPT_CONTRACT } from "../src/session-actions.ts";

function delegateFakes(opts: {
  parentStatus?: string; parentTurns?: number; parentOfParent?: string | null;
  subagents?: any[]; targetStatus?: string; workspaceStatus?: string; interrupted?: boolean;
} = {}) {
  const f = actionFakes({ subagents: [], targetStatus: opts.targetStatus });
  const repo: any = f.repo;
  repo.sessions.push({
    id: "sesn_parent", agent_id: "agent_p", agent_version: 1, workspace_id: "ws",
    status: opts.parentStatus ?? "running", turns: opts.parentTurns ?? 0,
    parent_session_id: opts.parentOfParent ?? null,
  });
  repo.getAgentVersion = async (id: string, _v?: number) => ({
    agent_id: id, version: 1, routing: "r", system_prompt: "", tools: [], max_turns: 10,
    environment_id: "env_0",
    subagents: opts.subagents ?? [{ agentId: "agent_t", instructions: "reviews code" }],
  });
  repo.getWorkspace = async (id: string) => ({ id, status: opts.workspaceStatus ?? "active" });
  repo.events = {} as Record<string, any[]>;
  repo.listEvents = async () => [];
  repo.lastAgentMessage = async () => "the answer";
  repo.lastFailureDetail = async () => "boom";
  repo.wasInterrupted = async () => opts.interrupted ?? false;
  repo.listSessionFiles = async () => [
    { role: "output", id: "file_1", name: "report.md" },
    { role: "input", id: "file_0", name: "in.csv" }];
  repo.setSessionStatus = async (sid: string, status: string) => {
    const s = repo.sessions.find((x: any) => x.id === sid);
    if (s) s.status = status;
    return { applied: true };
  };
  repo.startTurn = async (sid: string) => {
    const s = repo.sessions.find((x: any) => x.id === sid);
    s.turns = (s.turns ?? 0) + 1;
    s.status = "queued";
    return { turn: s.turns, config: await repo.getAgentVersion(s.agent_id, s.agent_version),
             sdkSessionId: null, checkpointFileId: null };
  };
  return { ...f, repo };
}

test("delegateAction: happy path creates a linked child session", async () => {
  const f = delegateFakes();
  const r = await delegateAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent",
    { turn: 0, agent_id: "agent_t", prompt: "review this" });
  assert.equal(r.code, 201);
  const child = f.repo.sessions.find((s: any) => s.id === r.body.session);
  assert.equal(child.parent_session_id, "sesn_parent");
  assert.equal(child.agent_id, "agent_t");
  assert.ok(child.prompt.endsWith(DELEGATED_PROMPT_CONTRACT));
});

test("delegateAction: one level only — a child cannot delegate", async () => {
  const f = delegateFakes({ parentOfParent: "sesn_grandparent" });
  const r = await delegateAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent",
    { agent_id: "agent_t", prompt: "x" });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /one level/);
});

test("delegateAction: target not in the version's subagents ⇒ 403", async () => {
  const f = delegateFakes({ subagents: [] });
  const r = await delegateAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent",
    { agent_id: "agent_t", prompt: "x" });
  assert.equal(r.code, 403);
});

test("delegateAction: stale turn ⇒ 409; disabled target agent ⇒ 409; read-only workspace ⇒ 409; not in-flight ⇒ 409", async () => {
  const stale = delegateFakes({ parentTurns: 3 });
  assert.equal((await delegateAction({ repo: stale.repo, orchestrator: stale.orchestrator },
    "sesn_parent", { turn: 1, agent_id: "agent_t", prompt: "x" })).code, 409);
  const disabled = delegateFakes({ targetStatus: "disabled" });
  assert.equal((await delegateAction({ repo: disabled.repo, orchestrator: disabled.orchestrator },
    "sesn_parent", { agent_id: "agent_t", prompt: "x" })).code, 409);
  const ro = delegateFakes({ workspaceStatus: "disabled" });
  assert.equal((await delegateAction({ repo: ro.repo, orchestrator: ro.orchestrator },
    "sesn_parent", { agent_id: "agent_t", prompt: "x" })).code, 409);
  const idle = delegateFakes({ parentStatus: "idle" });
  assert.equal((await delegateAction({ repo: idle.repo, orchestrator: idle.orchestrator },
    "sesn_parent", { agent_id: "agent_t", prompt: "x" })).code, 409);
});

test("delegateStatusAction: terminal child returns result text + outputs; wrong parent 404s", async () => {
  const f = delegateFakes();
  f.repo.sessions.push({ id: "sesn_child", parent_session_id: "sesn_parent", status: "idle" });
  const r = await delegateStatusAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent", "sesn_child");
  assert.equal(r.code, 200);
  assert.equal(r.body.status, "idle");
  assert.equal(r.body.resultText, "the answer");
  assert.deepEqual(r.body.outputs, [{ id: "file_1", name: "report.md" }]);
  const wrong = await delegateStatusAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_other", "sesn_child");
  assert.equal(wrong.code, 404);
});

test("delegateStatusAction: idle child interrupted by the console reports interrupted:true; unset when not interrupted", async () => {
  const f = delegateFakes({ interrupted: true });
  f.repo.sessions.push({ id: "sesn_child", parent_session_id: "sesn_parent", status: "idle" });
  const r = await delegateStatusAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent", "sesn_child");
  assert.equal(r.body.interrupted, true);

  const notInterrupted = delegateFakes({ interrupted: false });
  notInterrupted.repo.sessions.push({ id: "sesn_child2", parent_session_id: "sesn_parent", status: "idle" });
  const r2 = await delegateStatusAction(
    { repo: notInterrupted.repo, orchestrator: notInterrupted.orchestrator }, "sesn_parent", "sesn_child2");
  assert.equal(r2.body.interrupted, undefined);
});

import { sendMessageAction } from "../src/session-actions.ts";

test("sendMessageAction: re-stages ALL prior session input files (sorted by name,id), not just this turn's new files", async () => {
  // A follow-up turn runs in a fresh pod: /mnt/session/uploads isn't
  // checkpointed, so a turn's launch attachments must be the session's FULL
  // input-file list (from repo.listSessionFiles), not just b.files.
  const f = delegateFakes(); // gives us a session ("sesn_parent") + listSessionFiles fake
  const repo: any = f.repo;
  const session = repo.sessions.find((s: any) => s.id === "sesn_parent");
  session.status = "idle";
  repo.startTurn = async (id: string) => {
    const s = repo.sessions.find((x: any) => x.id === id);
    s.turns = (s.turns ?? 0) + 1;
    s.status = "queued";
    return { turn: s.turns, config: await repo.getAgentVersion(s.agent_id, s.agent_version), sdkSessionId: null, checkpointFileId: null };
  };
  // Two input files (out of name/id order on purpose) + one output file —
  // the output file must be excluded from launch attachments.
  repo.listSessionFiles = async () => [
    { role: "output", id: "file_out", name: "z-report.md" },
    { role: "input", id: "file_b", name: "b.csv" },
    { role: "input", id: "file_a", name: "a.csv" },
  ];
  const r = await sendMessageAction({ repo, orchestrator: f.orchestrator }, "ws", "sesn_parent", { prompt: "use the files" });
  assert.equal(r.code, 202);
  assert.deepEqual(f.started[0].attachments, [
    { id: "file_a", name: "a.csv" },
    { id: "file_b", name: "b.csv" },
  ]);
});

test("sendMessageAction: passes prior output-role files as priorOutputs (sorted by name,id); createSessionAction passes none", async () => {
  // Live gap (sesn_vbgmchnl4m03): a follow-up turn's pod starts with an empty
  // outputs dir — the model can't see files it published in earlier turns.
  const f = delegateFakes();
  const repo: any = f.repo;
  const session = repo.sessions.find((s: any) => s.id === "sesn_parent");
  session.status = "idle";
  repo.startTurn = async (id: string) => {
    const s = repo.sessions.find((x: any) => x.id === id);
    s.turns = (s.turns ?? 0) + 1;
    s.status = "queued";
    return { turn: s.turns, config: await repo.getAgentVersion(s.agent_id, s.agent_version), sdkSessionId: null, checkpointFileId: null };
  };
  repo.listSessionFiles = async () => [
    { role: "output", id: "file_z", name: "z-report.md" },
    { role: "output", id: "file_a", name: "a-chart.png" },
    { role: "input", id: "file_in", name: "in.csv" },
  ];
  const r = await sendMessageAction({ repo, orchestrator: f.orchestrator }, "ws", "sesn_parent", { prompt: "use the files" });
  assert.equal(r.code, 202);
  assert.deepEqual(f.started[0].priorOutputs, [
    { id: "file_a", name: "a-chart.png" },
    { id: "file_z", name: "z-report.md" },
  ]);
  assert.deepEqual(f.started[0].attachments, [{ id: "file_in", name: "in.csv" }]);

  // Turn 0 (createSessionAction) has no prior turns — nothing to pass.
  const created = await createSessionAction({ repo: f.repo, orchestrator: f.orchestrator }, "ws", {
    agent: "agent_p", prompt: "go" });
  assert.equal(created.code, 201);
  assert.deepEqual(f.started[f.started.length - 1].priorOutputs, undefined);
});

test("delegateStatusAction: running child returns status only; failed child carries failureDetail", async () => {
  const f = delegateFakes();
  f.repo.sessions.push({ id: "sesn_run", parent_session_id: "sesn_parent", status: "running" });
  f.repo.sessions.push({ id: "sesn_fail", parent_session_id: "sesn_parent", status: "failed" });
  const run = await delegateStatusAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent", "sesn_run");
  assert.equal(run.body.resultText, undefined);
  const fail = await delegateStatusAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent", "sesn_fail");
  assert.equal(fail.body.failureDetail, "boom");
});

test("delegateAction: continuation (session=) happy path on an idle child — starts a follow-up turn, contract appended exactly once", async () => {
  const f = delegateFakes();
  f.repo.sessions.push({ id: "sesn_child", agent_id: "agent_t", parent_session_id: "sesn_parent", status: "idle", turns: 0 });
  const r = await delegateAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent",
    { turn: 0, agent_id: "agent_t", session: "sesn_child", prompt: "keep going" });
  assert.equal(r.code, 201);
  assert.equal(r.body.session, "sesn_child");
  assert.equal(f.started.length, 1); // sendMessageAction's follow-up path reached gatedLaunch -> startSession
  const prompt = f.started[0].prompt as string;
  assert.ok(prompt.startsWith("keep going"));
  assert.equal(prompt.split(DELEGATED_PROMPT_CONTRACT).length - 1, 1); // appended exactly once
  const child = f.repo.sessions.find((s: any) => s.id === "sesn_child");
  assert.equal(child.status, "queued");
  assert.equal(child.turns, 1);
});

test("delegateAction: continuation of a completed child ⇒ 409 locked", async () => {
  const f = delegateFakes();
  f.repo.sessions.push({ id: "sesn_child", agent_id: "agent_t", parent_session_id: "sesn_parent", status: "completed", turns: 1 });
  const r = await delegateAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent",
    { turn: 0, agent_id: "agent_t", session: "sesn_child", prompt: "keep going" });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /locked/);
});

test("delegateAction: continuation of a running child ⇒ 409", async () => {
  const f = delegateFakes();
  f.repo.sessions.push({ id: "sesn_child", agent_id: "agent_t", parent_session_id: "sesn_parent", status: "running", turns: 1 });
  const r = await delegateAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent",
    { turn: 0, agent_id: "agent_t", session: "sesn_child", prompt: "keep going" });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /still running/);
});

test("delegateAction: continuation naming a session that isn't this parent's child ⇒ 404", async () => {
  const f = delegateFakes();
  f.repo.sessions.push({ id: "sesn_child", agent_id: "agent_t", parent_session_id: "sesn_other_parent", status: "idle", turns: 0 });
  const r = await delegateAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent",
    { turn: 0, agent_id: "agent_t", session: "sesn_child", prompt: "keep going" });
  assert.equal(r.code, 404);
});

test("delegateAction: continuation naming a child of a DIFFERENT subagent ⇒ 400", async () => {
  const f = delegateFakes();
  f.repo.sessions.push({ id: "sesn_child", agent_id: "agent_other", parent_session_id: "sesn_parent", status: "idle", turns: 0 });
  const r = await delegateAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent",
    { turn: 0, agent_id: "agent_t", session: "sesn_child", prompt: "keep going" });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /does not belong/);
});

import { delegateCompleteAction } from "../src/session-actions.ts";

test("delegateCompleteAction: locks an idle child, is idempotent once completed, 409s a running child, and honors the stale-turn guard", async () => {
  const f = delegateFakes();
  f.repo.sessions.push({ id: "sesn_child", agent_id: "agent_t", parent_session_id: "sesn_parent", status: "idle", turns: 1 });
  const r1 = await delegateCompleteAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent", "sesn_child", { turn: 0 });
  assert.equal(r1.code, 200);
  assert.equal(r1.body.status, "completed");
  assert.equal(r1.locked, true);
  assert.equal(f.repo.sessions.find((s: any) => s.id === "sesn_child").status, "completed");

  // Idempotent replay: already completed, no re-lock.
  const r2 = await delegateCompleteAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent", "sesn_child", { turn: 0 });
  assert.equal(r2.code, 200);
  assert.equal(r2.body.status, "completed");
  assert.equal(r2.locked, undefined);

  const running = delegateFakes();
  running.repo.sessions.push({ id: "sesn_running", agent_id: "agent_t", parent_session_id: "sesn_parent", status: "running", turns: 1 });
  const r3 = await delegateCompleteAction({ repo: running.repo, orchestrator: running.orchestrator }, "sesn_parent", "sesn_running", { turn: 0 });
  assert.equal(r3.code, 409);
  assert.match(r3.body.error, /still running/);

  const stale = delegateFakes({ parentTurns: 3 });
  stale.repo.sessions.push({ id: "sesn_stale_child", agent_id: "agent_t", parent_session_id: "sesn_parent", status: "idle", turns: 1 });
  const r4 = await delegateCompleteAction({ repo: stale.repo, orchestrator: stale.orchestrator }, "sesn_parent", "sesn_stale_child", { turn: 1 });
  assert.equal(r4.code, 409);
  assert.match(r4.body.error, /stale turn/);
});

import { interruptChildSessions } from "../src/subagents.ts";

test("interruptChildSessions: stops, un-parks, idles, and events every in-flight child", async () => {
  const stopped: string[] = []; const unparked: string[] = [];
  const statuses: Record<string, string> = {}; const events: Record<string, any[]> = {};
  const repo = {
    async listChildSessions(pid: string) {
      return pid === "sesn_parent" ? [{ id: "sesn_c1", status: "running" }, { id: "sesn_c2", status: "queued" }] : [];
    },
    async takePendingLaunch(id: string) { unparked.push(id); return null; },
    async setSessionStatus(id: string, status: string) { statuses[id] = status; return { applied: true }; },
    async appendEvents(id: string, evts: any[]) { (events[id] ??= []).push(...evts); return 1; },
  };
  const orchestrator = { async stopSession(id: string) { stopped.push(id); } };
  const settled: string[] = [];
  await interruptChildSessions({ repo, orchestrator } as any, "sesn_parent", async (id) => { settled.push(id); });
  assert.deepEqual(stopped, ["sesn_c1", "sesn_c2"]);
  assert.deepEqual(unparked, ["sesn_c1", "sesn_c2"]);
  assert.deepEqual(statuses, { sesn_c1: "idle", sesn_c2: "idle" });
  assert.deepEqual(settled, ["sesn_c1", "sesn_c2"]);
  assert.equal(events.sesn_c1[0].type, "session.interrupted");
  assert.equal(events.sesn_c1[0].payload.by, "parent");
});

test("interruptChildSessions: one failing child does not block the rest", async () => {
  const statuses: Record<string, string> = {};
  const repo = {
    async listChildSessions() { return [{ id: "sesn_bad", status: "running" }, { id: "sesn_ok", status: "running" }]; },
    async takePendingLaunch() { return null; },
    async setSessionStatus(id: string, status: string) { statuses[id] = status; return { applied: true }; },
    async appendEvents() { return 1; },
  };
  const orchestrator = { async stopSession(id: string) { if (id === "sesn_bad") throw new Error("k8s down"); } };
  await interruptChildSessions({ repo, orchestrator } as any, "sesn_parent");
  assert.equal(statuses.sesn_ok, "idle");
});
