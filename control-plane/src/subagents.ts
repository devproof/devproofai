// control-plane/src/subagents.ts
// Agent delegation (spec 2026-07-17). Pure-ish helpers shared by the /v1 and
// /api surfaces: config validation here; launch resolution and the delegate
// actions live in session-actions.ts (they need the full SessionDeps).
const MAX_INSTRUCTIONS = 2000;
const MAX_SUBAGENTS = 20;

export interface SubagentRef { agentId: string; instructions: string; }

/** Version-config `subagents` field guard (routes 400 on the returned message).
 *  selfAgentId is null on agent create (no id exists yet to self-reference). */
export async function validateSubagents(
  repo: { getAgent(ws: string, id: string): Promise<{ name: string } | null> },
  workspaceId: string, selfAgentId: string | null, value: unknown,
): Promise<string | null> {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return "subagents must be an array";
  if (value.length > MAX_SUBAGENTS) return `subagents: at most ${MAX_SUBAGENTS} entries`;
  const seen = new Set<string>();
  const seenNames = new Set<string>();
  for (const [i, s] of (value as any[]).entries()) {
    if (typeof s !== "object" || s === null || Array.isArray(s)) return `subagents[${i}]: must be an object`;
    if (typeof s.agentId !== "string" || !s.agentId) return `subagents[${i}]: agentId required`;
    if (typeof s.instructions !== "string" || !s.instructions.trim()) return `subagents[${i}]: instructions required`;
    if (s.instructions.length > MAX_INSTRUCTIONS) return `subagents[${i}]: instructions too long (max ${MAX_INSTRUCTIONS})`;
    if (s.agentId === selfAgentId) return `subagents[${i}]: an agent cannot delegate to itself`;
    if (seen.has(s.agentId)) return `subagents[${i}]: duplicate agent ${s.agentId}`;
    seen.add(s.agentId);
    const target = await repo.getAgent(workspaceId, s.agentId);
    if (!target) return `subagents[${i}]: unknown agent ${s.agentId}`;
    // Names aren't unique — two different agent ids resolving to the same
    // name would silently misroute the Delegate tool (its enum is names).
    if (seenNames.has(target.name)) return `subagents[${i}]: duplicate target name "${target.name}"`;
    seenNames.add(target.name);
  }
  return null;
}

/** Interrupting (or zombie-failing) a parent also interrupts its in-flight
 *  children — a delegated session has nobody left to collect its result.
 *  One level deep ⇒ no recursion. Mirrors the /v1 interrupt sequence:
 *  stop Job, un-park, idle (resumable), settle costs, event. Per-child
 *  failures are logged and skipped — the next child still gets stopped. */
export async function interruptChildSessions(
  deps: {
    repo: {
      listChildSessions(parentId: string): Promise<{ id: string }[]>;
      takePendingLaunch(id: string): Promise<unknown>;
      setSessionStatus(id: string, status: string): Promise<unknown>;
      appendEvents(id: string, events: { type: string; payload?: unknown }[]): Promise<unknown>;
    };
    orchestrator: { stopSession(id: string): Promise<void> };
  },
  parentId: string, settle?: (id: string) => Promise<void>,
): Promise<void> {
  for (const child of await deps.repo.listChildSessions(parentId)) {
    try {
      await deps.orchestrator.stopSession(child.id);
      await deps.repo.takePendingLaunch(child.id);
      await deps.repo.setSessionStatus(child.id, "idle");
      await settle?.(child.id).catch(() => {});
      await deps.repo.appendEvents(child.id, [{ type: "session.interrupted", payload: { by: "parent" } }]);
    } catch (err) {
      console.warn(`child interrupt of ${child.id} failed:`, err);
    }
  }
}
