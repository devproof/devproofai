// Scale-to-zero routing-state projection (spec 2026-07-15). model_routing is
// what the gateway's pre-call hook reads to decide hold-vs-forward. It is a
// PROJECTION of (deployment phase, warmed) — event hooks update it for snappy
// holds; this reconciler-cadence sweep guarantees convergence after CP
// crashes, lost NOTIFYs, or wakes that failed with no session parked.
export type RoutingState = "ready" | "idle" | "waking";

export function routingStateFor(phase: string, warmed: boolean): RoutingState {
  if (phase === "Ready" && warmed) return "ready";
  if (phase === "Idle") return "idle";
  return "waking";
}

export interface RoutingSweepDeps {
  listDeployments(): Promise<{ name: string; phase: string }[]>;
  isWarmed(name: string): boolean;
  setModelRouting(model: string, state: RoutingState, phase: string): Promise<void>;
  pruneModelRouting(keep: string[]): Promise<void>;
  takeWakeRequests(): Promise<string[]>;
  wake(model: string): Promise<void>;
}

export async function sweepModelRouting(deps: RoutingSweepDeps) {
  const rows = await deps.listDeployments();
  for (const d of rows) {
    await deps.setModelRouting(d.name, routingStateFor(d.phase, deps.isWarmed(d.name)), d.phase);
  }
  await deps.pruneModelRouting(rows.map((d) => d.name));
  // Lost-NOTIFY heal: wake signals parked in PG whose model is still asleep.
  // takeWakeRequests deletes atomically, so concurrent sweeps never double-act;
  // wake() re-clears harmlessly.
  for (const model of await deps.takeWakeRequests()) {
    const d = rows.find((r) => r.name === model);
    if (d && d.phase === "Idle") {
      await deps.wake(model).catch((err) => console.warn(`routing-state: heal wake of ${model} failed:`, err));
    }
  }
}
