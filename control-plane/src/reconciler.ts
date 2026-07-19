// Zombie-session reconciler (2026-07-11). A runner pod can die without ever
// reporting a result — turn deadline (Job activeDeadlineSeconds), OOM, node
// restart, or the control plane being down when the runner posts its final
// event. Nothing else moves such a session out of queued/running, so it would
// stay "running" forever and reject follow-up messages. Sweep on boot and
// periodically: any in-flight session whose Job is gone or finished, with no
// sign of life inside the grace window, is marked failed (which is resumable —
// startTurn accepts failed and picks up from the last completed checkpoint).

export type JobState = "active" | "finished" | "missing";

/** Sign-of-life grace: covers scheduling + image pull before the first event,
 *  and the in-flight window between a Job finishing and its result landing. */
export const RECONCILE_GRACE_MS = 120_000;
export const RECONCILE_INTERVAL_MS = 60_000;

export function reconcileDecision(
  session: { status: string; lastActivityMs: number },
  job: JobState,
  nowMs: number,
  graceMs: number = RECONCILE_GRACE_MS,
): "fail" | "keep" {
  if (session.status !== "queued" && session.status !== "running") return "keep";
  if (job === "active") return "keep";
  if (nowMs - session.lastActivityMs < graceMs) return "keep";
  return "fail";
}

interface ReconcilerRepo {
  listStuckSessions(): Promise<{ id: string; status: string; turns: number | string; last_activity: Date | string }[]>;
  appendEvents(sessionId: string, events: { type: string; payload?: unknown }[]): Promise<number>;
  setSessionStatus(sessionId: string, status: "failed"): Promise<unknown>;
}

interface ReconcilerOrchestrator {
  sessionJobState(sessionId: string, turn: number): Promise<JobState>;
}

export async function sweepZombieSessions(
  repo: ReconcilerRepo, orchestrator: ReconcilerOrchestrator,
  onSessionFailed?: (id: string) => Promise<void>,
) {
  const stuck = await repo.listStuckSessions();
  for (const s of stuck) {
    try {
      const job = await orchestrator.sessionJobState(s.id, Number(s.turns));
      const decision = reconcileDecision(
        { status: s.status, lastActivityMs: new Date(s.last_activity).getTime() },
        job, Date.now(),
      );
      if (decision !== "fail") continue;
      await repo.appendEvents(s.id, [{
        type: "session.failed",
        payload: { error: `runner lost (job ${job}: turn deadline exceeded, pod evicted, or result never delivered)` },
      }]);
      await repo.setSessionStatus(s.id, "failed");
      await onSessionFailed?.(s.id).catch(() => {}); // cost settle — advisory, never blocks the sweep
      console.warn(`reconciler: ${s.id} marked failed (was ${s.status}, job ${job})`);
    } catch (err) {
      console.warn(`reconciler: sweep of ${s.id} failed:`, err); // next sweep retries
    }
  }
}

/** Boot-time + periodic sweep; the timer never keeps the process alive.
 *  pendingSweep (launch gate): releases sessions parked on models that turned
 *  Ready and fails ones whose model failed/vanished — same cadence, so a
 *  missed newly-routed hook delays a waiting session by ≤60s. */
export function startReconciler(
  repo: ReconcilerRepo, orchestrator: ReconcilerOrchestrator,
  pendingSweep?: () => Promise<void>,
  onSessionFailed?: (id: string) => Promise<void>,
) {
  const sweep = () => {
    sweepZombieSessions(repo, orchestrator, onSessionFailed).catch((err) => console.warn("reconciler: sweep failed:", err));
    pendingSweep?.().catch((err) => console.warn("reconciler: pending-launch sweep failed:", err));
  };
  sweep();
  const timer = setInterval(sweep, RECONCILE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
