// control-plane/src/session-actions.ts
// Session create / follow-up logic shared by the /v1 (console) and /api
// (public) routes — extracted 2026-07-12 so both contracts stay identical.
import type { Orchestrator } from "./agents-api.ts";
import { gateDecision, type ModelPhase } from "./launch-gate.ts";
import { renderMcpServers } from "./mcp.ts";
import { hasWriteRef, resolveWikiMounts } from "./wiki-refs.ts";
import type { PodConfig } from "./pod-config.ts";

type EnvRow = { id: string; pod: PodConfig | null; allow_package_managers?: boolean };

/** Appended to every delegated child's prompt (spec amendment 2026-07-17):
 *  children sometimes end their turn by narrating planned work instead of
 *  delivering (live: 32 tool-turns of analysis, then "let me write the
 *  document" + end_turn, nothing delivered). The contract rides the USER
 *  prompt — visible in the child's transcript, unlike the system prompt. */
export const DELEGATED_PROMPT_CONTRACT =
  "\n\n(Delegated task contract: this conversation has exactly one turn — your FINAL message must contain the complete result of the task, not a plan or a status update. Write any file deliverables to the outputs directory BEFORE your final message. Never end by describing what you are about to do.)";

// A7: bound how many child sessions one parent can spawn via Delegate.
const MAX_DELEGATE_TOTAL = 200;       // total children over the parent's life
const MAX_DELEGATE_CONCURRENT = 20;   // in-flight (queued|running) at once

/** Resolve the version's subagent refs to launch-payload entries (current
 *  target NAMES — the runner's tool enum + prompt block). A session that
 *  itself has a parent gets none: delegation is one level deep, enforced
 *  structurally (the child pod never has the tool). Deleted targets are
 *  skipped — the call would fail at delegate time anyway. */
async function resolveSubagents(
  repo: any, workspaceId: string, config: any, parentSessionId?: string | null,
): Promise<{ name: string; agentId: string; instructions: string }[]> {
  if (parentSessionId) return [];
  const out: { name: string; agentId: string; instructions: string }[] = [];
  for (const s of (config?.subagents ?? []) as { agentId: string; instructions: string }[]) {
    const target = await repo.getAgent(workspaceId, s.agentId);
    if (target) out.push({ name: target.name, agentId: s.agentId, instructions: s.instructions });
  }
  return out;
}

export interface SessionDeps {
  repo: any;
  orchestrator: Orchestrator;
  /** Resolves a model name to its deployment state (launch gate). Absent —
   *  minimal test setups — means every launch proceeds immediately. */
  modelPhase?: (model: string) => Promise<ModelPhase>;
  /** Scale-to-zero: fires when the gate parks a session on an Idle model. */
  wakeModel?: (model: string) => Promise<void>;
}

/** Launch now, park until the model deployment is Ready, or fail fast on a
 *  Failed deployment. Returns the extra response fields for the wait case,
 *  or the error for the fail case. */
async function gatedLaunch(
  deps: SessionDeps, sessionId: string, turn: number,
  launch: Parameters<Orchestrator["startSession"]>[0],
): Promise<{ waitingFor?: { model?: string; phase?: string; writerAgent?: string }; error?: string }> {
  const { repo, orchestrator, modelPhase } = deps;
  // Writer-slot gate (spec 2026-07-18): a writer agent runs one session at a
  // time so wiki writes never race. If another session of this agent holds the
  // slot, park this launch; it's released FIFO when the slot frees (status hook
  // + reconciler sweep). This precedes the model gate — writer agents reference
  // routings, which always pass the model gate anyway.
  if (hasWriteRef((launch.config as any).wiki_refs)) {
    const owner = await repo.getSession(sessionId);
    const agentId = owner?.agent_id;
    if (agentId && await repo.writerSlotHeld(agentId, sessionId)) {
      await repo.addPendingLaunch(sessionId, `wq:${agentId}`, launch);
      await repo.appendEvents(sessionId, [{ type: "session.waiting", payload: { writerAgent: agentId, turn } }]);
      return { waitingFor: { writerAgent: agentId } };
    }
  }
  // The agent's reference is now `config.routing`; downstream this resolves to a
  // model/deployment name on the serving side, so the local var stays `model`.
  const model = launch.config.routing;
  const resolved = modelPhase ? await modelPhase(model) : null;
  // Local models serve a bounded window (operator-capped); the runner needs
  // it so the CLI auto-compacts instead of overflowing the context mid-turn.
  // Set before parking so a deferred payload replays with it too.
  if ((resolved?.kind === "local" || resolved?.kind === "routing") && resolved.contextTokens) {
    launch.contextWindow = resolved.contextTokens;
  }
  const decision = gateDecision(model, resolved);
  if (decision.action === "fail") {
    await repo.appendEvents(sessionId, [{ type: "session.failed", payload: { error: decision.error, turn } }]);
    await repo.setSessionStatus(sessionId, "failed");
    return { error: decision.error };
  }
  if (decision.action === "wait") {
    // Local-model park path: agents reference routings only since 2026-07-16
    // (routing-kind always launches — the gateway wake-hold covers Idle
    // targets), so this branch is now reachable only via legacy agent rows
    // whose `routing` value is still a bare deployment name. Candidate for
    // removal once those legacy rows are gone.
    // Idle model: wake it alongside parking (idempotent; the reconciler
    // sweep re-fires if this trigger is lost — spec 2026-07-15).
    if (resolved?.kind === "local" && resolved.phase === "Idle") {
      await deps.wakeModel?.(model).catch((err: any) =>
        console.warn(`wake of ${model} failed (sweep retries):`, err));
    }
    await repo.addPendingLaunch(sessionId, model, launch);
    await repo.appendEvents(sessionId, [{
      type: "session.waiting", payload: { model, phase: decision.phase, turn },
    }]);
    return { waitingFor: { model, phase: decision.phase } };
  }
  await orchestrator.startSession(launch);
  return {};
}

export async function createSessionAction(
  deps: SessionDeps, workspaceId: string,
  b: { agent: string; prompt: string; name?: string; files?: string[]; memoryStore?: string; parentSessionId?: string },
): Promise<{ code: number; body: any }> {
  const { repo } = deps;
  if (!b?.agent || !b?.prompt) return { code: 400, body: { error: "agent and prompt required" } };
  const agent = await repo.getAgent(workspaceId, b.agent);
  if (agent?.status === "disabled") return { code: 409, body: { error: "agent disabled" } };
  // v is looked up by id only (unscoped, like the real repo) so an unknown
  // agent id still falls through to createSession's 404 below, instead of
  // this 400 masking it.
  const v = await repo.getAgentVersion(b.agent);
  const environment: EnvRow | null = v?.environment_id ? await repo.getEnvironment(v.environment_id) : null;
  if (v && !environment) return { code: 400, body: { error: "agent has no environment; edit the agent and assign one" } };
  // Wiki writer serialization is handled at launch (gatedLaunch parks extra
  // writer sessions in a FIFO queue instead of rejecting them).
  // Attach only files owned by the caller's workspace — a foreign file id is
  // dropped by the filter and then fails the count check below, so another
  // tenant's file content can't be staged into this session's pod.
  const attachments = (await repo.listFileRecords(b.files ?? []))
    .filter((f: any) => f.workspace_id === workspaceId)
    .map((f: any) => ({ id: f.id, name: f.name }));
  if ((b.files?.length ?? 0) !== attachments.length) {
    return { code: 400, body: { error: "unknown file id in files[]" } };
  }
  // parentSessionId is meant to be stamped only by the delegate endpoint (a
  // later task), but this field is reachable from public routes (req.body
  // passed straight through) and sessions.parent_session_id has no FK — so
  // validate it here: the parent must exist and be in the same workspace.
  if (b.parentSessionId) {
    const parent = await repo.getSession(b.parentSessionId);
    if (!parent || parent.workspace_id !== workspaceId) {
      return { code: 400, body: { error: "unknown parent session" } };
    }
  }
  // Memory store must belong to the caller's workspace — otherwise another
  // tenant's memory entries would be staged into this session's pod.
  if (b.memoryStore && !(await repo.getMemoryStore(b.memoryStore, workspaceId))) {
    return { code: 400, body: { error: "unknown memory store" } };
  }
  let session;
  try {
    session = await repo.createSession(workspaceId, b.agent, b.prompt, b.name, b.parentSessionId);
  } catch (err: any) {
    return { code: 404, body: { error: err.message } };
  }
  // The prompt is part of the transcript: first event of turn 0.
  await repo.appendEvents(session.id, [{ type: "user", payload: { text: b.prompt, turn: 0 } }]);
  let memory: { path: string; fileId: string }[] = [];
  if (b.memoryStore) {
    await repo.setSessionMemoryStore(session.id, b.memoryStore);
    memory = (await repo.getMemoryEntries(b.memoryStore)).map((e: any) => ({ path: e.path, fileId: e.file_id }));
  }
  // Record input-file attachments (a file may be attached to many sessions).
  if (attachments.length) await repo.attachSessionFiles(session.id, attachments.map((a: any) => a.id), "input");
  const skills = (await repo.listSkills(workspaceId, (session.config as any).skill_ids ?? [])).map((s: any) => ({
    name: s.name, files: s.files ?? [{ path: "SKILL.md", fileId: s.file_id }],
  }));
  // Vault credentials matched to the agent's MCP servers by URL → placeholder
  // Authorization headers (values stay in the vault Secret / pod env).
  const credentials = (session.config as any).vault_id
    ? await repo.listVaultCredentials((session.config as any).vault_id) : [];
  const mcpServers = renderMcpServers((session.config as any).mcp_servers ?? {}, credentials);
  const subagents = await resolveSubagents(repo, workspaceId, session.config, b.parentSessionId);
  const wikis = await resolveWikiMounts(repo, workspaceId, (session.config as any).wiki_refs);
  const gated = await gatedLaunch(deps, session.id, 0, {
    id: session.id, prompt: b.prompt, config: session.config, attachments, skills, memory, workspace: workspaceId,
    environment: { id: environment!.id, pod: environment!.pod ?? {},
                   allowPackageManagers: environment!.allow_package_managers ?? false }, mcpServers, subagents, wikis,
  });
  if (gated.error) return { code: 409, body: { error: gated.error, id: session.id } };
  return { code: 201, body: {
    id: session.id, agent: b.agent, version: session.agentVersion, status: "queued",
    ...(gated.waitingFor ? { waitingFor: gated.waitingFor } : {}),
  } };
}

// Multi-turn: send a new message to an idle session (resume).
export async function sendMessageAction(
  deps: SessionDeps, workspaceId: string, id: string,
  b: { prompt: string; files?: string[] },
): Promise<{ code: number; body: any }> {
  const { repo } = deps;
  if (!b?.prompt) return { code: 400, body: { error: "prompt required" } };
  const session = await repo.getSession(id);
  const owner = session ? await repo.getAgent(session.workspace_id, session.agent_id) : null;
  if (owner?.status === "disabled") return { code: 409, body: { error: "agent disabled" } };
  let environment: EnvRow | null = null;
  if (session) {
    const v = await repo.getAgentVersion(session.agent_id, session.agent_version);
    environment = v?.environment_id ? await repo.getEnvironment(v.environment_id) : null;
    if (!environment) return { code: 400, body: { error: "agent has no environment; edit the agent and assign one" } };
    // Writer serialization handled at launch (gatedLaunch queues extra turns).
  }
  // Only attach files owned by the session's workspace (foreign ids drop out
  // and fail the count check) — same guard as session create.
  const attachments = (await repo.listFileRecords(b.files ?? []))
    .filter((f: any) => f.workspace_id === session?.workspace_id)
    .map((f: any) => ({ id: f.id, name: f.name }));
  if ((b.files?.length ?? 0) !== attachments.length) {
    return { code: 400, body: { error: "unknown file id in files[]" } };
  }
  let turn;
  try {
    turn = await repo.startTurn(id);
  } catch (err: any) {
    return { code: 409, body: { error: err.message } };
  }
  await repo.appendEvents(id, [{ type: "user", payload: { text: b.prompt, turn: turn.turn } }]);
  // Record follow-up attachments as input files (mirrors POST /v1/sessions).
  if (attachments.length) await repo.attachSessionFiles(id, attachments.map((a: any) => a.id), "input");
  // Follow-up turns run in a FRESH pod, and /mnt/session/uploads is not
  // checkpointed (only /work + the SDK home are) — so staging only this
  // turn's newly attached files would make every prior turn's uploads
  // vanish from the mount, even though the platform prompt tells the model
  // those paths are stable. Stage the session's FULL input-file list
  // instead. Sort deterministically by (name, id): the runner's basename-
  // dedupe assigns -2/-3 suffixes in staging order, so an unstable order
  // would swap which same-named file gets which suffix between turns.
  const sessionFiles = await repo.listSessionFiles(id);
  const byNameThenId = (a: any, b: any) =>
    (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const launchAttachments = sessionFiles
    .filter((f: any) => f.role === "input")
    .map((f: any) => ({ id: f.id, name: f.name }))
    .sort(byNameThenId);
  // Files the model published in EARLIER turns (live gap sesn_vbgmchnl4m03): a
  // follow-up turn's pod otherwise starts with an empty outputs dir, so the
  // model can't see (and regenerates) work it already delivered. Staged
  // read-only by the runner — never merged into launchAttachments.
  const priorOutputs = sessionFiles
    .filter((f: any) => f.role === "output")
    .map((f: any) => ({ id: f.id, name: f.name }))
    .sort(byNameThenId);
  const skills = (await repo.listSkills(workspaceId, (turn.config as any).skill_ids ?? [])).map((s: any) => ({
    name: s.name, files: s.files ?? [{ path: "SKILL.md", fileId: s.file_id }],
  }));
  const credentials = (turn.config as any).vault_id
    ? await repo.listVaultCredentials((turn.config as any).vault_id) : [];
  const mcpServers = renderMcpServers((turn.config as any).mcp_servers ?? {}, credentials);
  const subagents = await resolveSubagents(repo, workspaceId, turn.config, session?.parent_session_id);
  const wikis = await resolveWikiMounts(repo, workspaceId, (turn.config as any).wiki_refs);
  const gated = await gatedLaunch(deps, id, turn.turn, {
    id, prompt: b.prompt, config: turn.config, attachments: launchAttachments, priorOutputs, skills,
    resume: { turn: turn.turn, sdkSessionId: turn.sdkSessionId, checkpointFileId: turn.checkpointFileId },
    workspace: workspaceId,
    environment: { id: environment!.id, pod: environment!.pod ?? {},
                   allowPackageManagers: environment!.allow_package_managers ?? false }, mcpServers, subagents, wikis,
  });
  if (gated.error) return { code: 409, body: { error: gated.error, id } };
  return { code: 202, body: {
    id, turn: turn.turn, status: "queued",
    ...(gated.waitingFor ? { waitingFor: gated.waitingFor } : {}),
  } };
}

/** Runner-facing: spawn a child session for a configured subagent, or
 *  continue a previously returned child of this parent (spec 2026-07-17,
 *  amendment 2026-07-17b). The workspace guard can't scope runner callbacks
 *  (no workspace header), so the workspace status check lives here. */
export async function delegateAction(
  deps: SessionDeps, id: string,
  b: { turn?: number; agent_id: string; prompt: string; files?: string[]; session?: string },
): Promise<{ code: number; body: any }> {
  const { repo } = deps;
  if (!b?.agent_id || !b?.prompt) return { code: 400, body: { error: "agent_id and prompt required" } };
  const session = await repo.getSession(id);
  if (!session) return { code: 404, body: { error: "session not found" } };
  // Stale-turn guard (dev23 convention): a pod that outlived an interrupt
  // must not spawn/continue children for a turn that is no longer current.
  if (typeof b.turn === "number" && Number.isInteger(b.turn) && Number(session.turns) > b.turn) {
    return { code: 409, body: { error: "stale turn" } };
  }
  // TOCTOU: an interrupt landing between this check and the child insert
  // below leaves a bounded orphan child (nobody polls it, but it still runs
  // its turn and idles normally) — accepted, not worth a lock for.
  if (!["queued", "running"].includes(session.status)) {
    return { code: 409, body: { error: `session is ${session.status}, not in-flight` } };
  }
  if (session.parent_session_id) {
    return { code: 409, body: { error: "delegation is one level deep — this session was itself started by delegation" } };
  }
  const workspace = await repo.getWorkspace(session.workspace_id);
  if (workspace && workspace.status !== "active") {
    return { code: 409, body: { error: "workspace is read-only — cannot start new sessions" } };
  }
  // The SESSION's pinned version (what the pod's tool enum was built from).
  const v = await repo.getAgentVersion(session.agent_id, session.agent_version);
  const configured = ((v?.subagents ?? []) as { agentId: string }[]).some((s) => s.agentId === b.agent_id);
  if (!configured) return { code: 403, body: { error: "agent is not a configured subagent of this session's agent" } };

  if (b.session) {
    const child = await repo.getSession(b.session);
    if (!child || child.parent_session_id !== id) return { code: 404, body: { error: "no such child session" } };
    if (child.agent_id !== b.agent_id) return { code: 400, body: { error: "session does not belong to that subagent" } };
    if (["queued", "running"].includes(child.status)) return { code: 409, body: { error: "child still running" } };
    if (child.status === "completed") return { code: 409, body: { error: "child completed (locked)" } };
    const r = await sendMessageAction(deps, session.workspace_id, b.session, {
      prompt: b.prompt + DELEGATED_PROMPT_CONTRACT, files: b.files,
    });
    if (r.code !== 202) return r; // 409 agent disabled / failed deployment; 400 bad files
    return { code: 201, body: { session: b.session } };
  }

  // Bound fan-out: a looping/adversarial agent must not spawn unbounded child
  // pods (only writer agents are otherwise serialized).
  const { total, inFlight } = await repo.childSessionCounts(id);
  if (total >= MAX_DELEGATE_TOTAL) {
    return { code: 429, body: { error: `delegate fan-out limit reached (${MAX_DELEGATE_TOTAL} children per session)` } };
  }
  if (inFlight >= MAX_DELEGATE_CONCURRENT) {
    return { code: 429, body: { error: `too many concurrent delegated children (${MAX_DELEGATE_CONCURRENT}) — wait for some to finish` } };
  }
  const r = await createSessionAction(deps, session.workspace_id, {
    agent: b.agent_id, prompt: b.prompt + DELEGATED_PROMPT_CONTRACT, files: b.files,
    name: `delegated by ${id}`, parentSessionId: id,
  });
  if (r.code !== 201) return r; // 409 agent disabled / failed deployment; 400 bad files; 404 agent gone
  return { code: 201, body: { session: r.body.id } };
}

/** Runner-facing: lock a child of this parent to `completed` — terminal, no
 *  further continuation (spec amendment 2026-07-17b). Idempotent when the
 *  child is already completed. Shares the parent-side guards with
 *  delegateAction (existence, stale-turn, in-flight, one-level). */
export async function delegateCompleteAction(
  deps: SessionDeps, id: string, childId: string, b: { turn?: number },
): Promise<{ code: number; body: any; locked?: boolean }> {
  const { repo } = deps;
  const session = await repo.getSession(id);
  if (!session) return { code: 404, body: { error: "session not found" } };
  if (typeof b?.turn === "number" && Number.isInteger(b.turn) && Number(session.turns) > b.turn) {
    return { code: 409, body: { error: "stale turn" } };
  }
  if (!["queued", "running"].includes(session.status)) {
    return { code: 409, body: { error: `session is ${session.status}, not in-flight` } };
  }
  if (session.parent_session_id) {
    return { code: 409, body: { error: "delegation is one level deep — this session was itself started by delegation" } };
  }
  const child = await repo.getSession(childId);
  if (!child || child.parent_session_id !== id) return { code: 404, body: { error: "no such child session" } };
  if (["queued", "running"].includes(child.status)) return { code: 409, body: { error: "child still running" } };
  if (child.status === "completed") return { code: 200, body: { ok: true, status: "completed" } };
  await repo.setSessionStatus(childId, "completed");
  return { code: 200, body: { ok: true, status: "completed" }, locked: true };
}

/** Runner-facing poll: child status; result text + output files once terminal. */
export async function delegateStatusAction(
  deps: SessionDeps, id: string, childId: string,
): Promise<{ code: number; body: any }> {
  const { repo } = deps;
  const child = await repo.getSession(childId);
  if (!child || child.parent_session_id !== id) return { code: 404, body: { error: "no such child session" } };
  const body: any = { status: child.status };
  if (["idle", "completed", "failed"].includes(child.status)) {
    body.resultText = await repo.lastAgentMessage(childId);
    body.outputs = (await repo.listSessionFiles(childId))
      .filter((f: any) => f.role === "output").map((f: any) => ({ id: f.id, name: f.name }));
    if (child.status === "failed") body.failureDetail = await repo.lastFailureDetail(childId);
    // A child interrupted directly (e.g. from the console) lands back on
    // `idle` — indistinguishable from a clean finish unless we also check
    // whether its last lifecycle signal was an interruption.
    if (await repo.wasInterrupted(childId)) body.interrupted = true;
  }
  return { code: 200, body };
}
