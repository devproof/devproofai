// Scale-to-zero wake (spec 2026-07-15): patch the deployment's target-replicas
// annotation to 1 — the MD-reconciler applies it; the scaler cannot fight
// back while blind at zero pods. Idempotent: every trigger (gateway NOTIFY,
// session gate, reconciler sweep) may call it repeatedly.
export interface WakeDeps {
  kube: { patch(plural: "modelpools" | "modeldeployments", name: string, body: any): Promise<any> };
  repo: {
    setModelRouting(model: string, state: "idle" | "waking" | "ready"): Promise<void>;
    clearWakeRequest(model: string): Promise<void>;
  };
}

export async function wakeModel(deps: WakeDeps, model: string): Promise<void> {
  await deps.kube.patch("modeldeployments", model, {
    metadata: { annotations: { "serving.devproof.ai/target-replicas": "1" } },
  });
  await deps.repo.setModelRouting(model, "waking");
  await deps.repo.clearWakeRequest(model);
}

// CP-restart stomp guard (I1, final review): after a CP restart warmedModels
// is empty, so every Ready model briefly projects as 'waking' and a normal
// request's NOTIFY would otherwise reach here. Patching "1" unconditionally
// would stomp the scaler's higher target-replicas annotation (e.g. "4") on a
// busy min>0 deployment. Only wake when the CRD itself says Idle — mirrors
// the phase guards in session-actions.ts (gatedLaunch) and routing-state.ts
// (sweep heal). Missing/unreadable deployment -> no writes, just resolve.
export async function wakeIfIdle(
  deps: WakeDeps & { kube: { get(plural: "modeldeployments", name: string): Promise<any> } },
  model: string,
): Promise<void> {
  let d: any = null;
  try {
    d = await deps.kube.get("modeldeployments", model);
  } catch {
    return;
  }
  if (d?.status?.phase !== "Idle") return;
  await wakeModel(deps, model);
}
