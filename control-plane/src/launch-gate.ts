// Wait-for-deployment launch gate (2026-07-12). A turn whose model is a local
// ModelDeployment that is not Ready yet must not start its pod: the gateway
// only routes Ready deployments, so the runner's first API call would 400
// ("Invalid model name") and fail the session within seconds. Instead the
// exact orchestrator.startSession payload is parked in pending_launches and
// replayed when the model becomes routable. Failed deployments fail the
// session immediately with a clear error (user decision 2026-07-12) — failed
// sessions stay resumable.
//
// Release triggers: (1) syncGateway's newly-routed hook the moment the
// operator reports Ready (snappy path), (2) the reconciler's 60s sweep
// (covers CP restarts, missed syncs, and deployments that fail or vanish
// while a session waits).

/** How a session's model name resolves at gate time: a local ModelDeployment
 *  (with its phase and served context window), an external endpoint (always
 *  routed), or nothing. */
export type ModelPhase =
  | { kind: "local"; phase: string; contextTokens?: number | null }
  | { kind: "external" }
  // Routing (spec 2026-07-16): resolution is request-dependent, so sessions
  // never park on a routing — the gateway wake-hold covers Idle targets
  // (the hold applies to internal traffic when routing-resolved).
  | { kind: "routing"; contextTokens?: number | null }
  | null;

export type GateDecision =
  | { action: "launch" }
  | { action: "wait"; phase: string }
  | { action: "fail"; error: string };

export function gateDecision(model: string, resolved: ModelPhase): GateDecision {
  // External endpoints are always routed; unknown names keep today's behavior
  // (launch and let the turn surface the gateway error).
  if (!resolved || resolved.kind === "external" || resolved.kind === "routing") return { action: "launch" };
  const phase = resolved.phase || "Pending";
  if (phase === "Ready") return { action: "launch" };
  if (phase === "Failed") {
    return { action: "fail", error: `model deployment "${model}" is Failed — fix or redeploy it, then send a new message` };
  }
  // includes Idle (scale-to-zero): callers fire the wake alongside parking.
  return { action: "wait", phase };
}

export interface PendingRepo {
  takePendingLaunches(model: string): Promise<{ session_id: string; payload: unknown }[]>;
  listPendingLaunchModels(): Promise<string[]>;
  appendEvents(sessionId: string, events: { type: string; payload?: unknown }[]): Promise<number>;
  setSessionStatus(sessionId: string, status: "failed"): Promise<unknown>;
}

interface LaunchOrchestrator { startSession(session: any): Promise<void> }

async function failWaiting(repo: PendingRepo, sessionId: string, error: string) {
  await repo.appendEvents(sessionId, [{ type: "session.failed", payload: { error } }]);
  await repo.setSessionStatus(sessionId, "failed");
}

/** Launch everything parked on a model that just became routable. The rows are
 *  taken (deleted) atomically first, so two concurrent triggers never double-
 *  launch; a crash between take and launch is healed by the zombie reconciler
 *  (queued + no Job + no pending row ⇒ failed, which is resumable). */
export async function releasePendingForModel(
  repo: PendingRepo, orchestrator: LaunchOrchestrator, model: string,
): Promise<number> {
  const rows = await repo.takePendingLaunches(model);
  for (const r of rows) {
    try {
      await orchestrator.startSession(r.payload);
    } catch (err: any) {
      console.warn(`launch-gate: deferred launch of ${r.session_id} failed:`, err);
      await failWaiting(repo, r.session_id, `deferred launch failed: ${err?.message ?? err}`);
    }
  }
  if (rows.length) console.log(`launch-gate: released ${rows.length} session(s) waiting for ${model}`);
  return rows.length;
}

/** Periodic safety net (reconciler cadence): release models that turned Ready,
 *  fail sessions whose model failed or was deleted while they waited. */
export async function sweepPendingLaunches(
  repo: PendingRepo, orchestrator: LaunchOrchestrator,
  modelPhase: (model: string) => Promise<ModelPhase>,
  wake?: (model: string) => Promise<void>,
) {
  for (const model of await repo.listPendingLaunchModels()) {
    try {
      const resolved = await modelPhase(model);
      // At gate time only LOCAL deployments park a session, so an unresolvable
      // name here means the deployment was deleted while the session waited.
      const decision: GateDecision = resolved === null
        ? { action: "fail", error: `model deployment "${model}" no longer exists` }
        : gateDecision(model, resolved);
      if (decision.action === "wait") {
        // Idle = asleep: re-fire the wake every sweep until it sticks
        // (covers CP restarts and lost NOTIFYs — spec 2026-07-15).
        if (resolved?.kind === "local" && resolved.phase === "Idle") {
          await wake?.(model).catch((err) => console.warn(`launch-gate: wake of ${model} failed:`, err));
        }
        continue;
      }
      if (decision.action === "launch") {
        await releasePendingForModel(repo, orchestrator, model);
        continue;
      }
      for (const r of await repo.takePendingLaunches(model)) {
        await failWaiting(repo, r.session_id, decision.error);
      }
    } catch (err) {
      console.warn(`launch-gate: sweep of model ${model} failed:`, err); // next sweep retries
    }
  }
}
