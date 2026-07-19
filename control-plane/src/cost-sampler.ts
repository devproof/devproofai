// Time-cost sampler (spec 2026-07-14 §4). 60s tick: observe running engine
// replicas (pool real cost + deployment time billing) and running turn pods
// (env real cost + session time billing), accrue since the per-subject
// watermark (latest cost_entries.ts), gap-capped at GAP_CAP_SEC so a CP
// outage under-counts instead of fabricating. settleSession() runs the final
// watermark→now accrual when a turn ends, making totals exact-to-the-second.
import {
  computeAccruals, type CostEntryDraft, type CostSettings,
  type DeploymentObs, type TurnObs,
} from "./costs.ts";

export interface SamplerDeps {
  repo: {
    getCostSettings(): Promise<CostSettings>;
    listResourcePrices(): Promise<{ kind: string; ref: string; prices: any }[]>;
    listRunningSessionsForBilling(): Promise<{ id: string; workspace_id: string; turns: number; environment_id: string | null }[]>;
    getSessionForBilling(sessionId: string): Promise<{ id: string; workspace_id: string; turns: number; environment_id: string | null } | null>;
    costWatermarks(): Promise<Map<string, number>>;
    insertCostEntries(entries: CostEntryDraft[]): Promise<void>;
    addSessionBilledCost(sessionId: string, amount: number): Promise<void>;
  };
  kube: { list(plural: "modeldeployments"): Promise<any[]> };
  orchestrator: { sessionJobInfo(sessionId: string, turn: number): Promise<{ state: string; startedAt: Date | null }> };
}

// Per-ledger (spec 2026-07-15): real ⇐ enabled, billing ⇐ billing.enabled.
// ANDing `enabled` over the billing terms would make computeAccruals' billing
// paths unreachable whenever cost tracking is off.
const needsTime = (s: CostSettings) =>
  (s.enabled && (s.trackPoolCosts || s.trackEnvCosts)) ||
  (s.billing.enabled && (s.billing.billSessionTime || s.billing.billDeploymentTime));

async function accrue(deps: SamplerDeps, deployments: DeploymentObs[], turns: TurnObs[], nowMs: number,
                      mode: import("./costs.ts").AccrualMode = "tick") {
  const [settings, prices, watermarks] = await Promise.all([
    deps.repo.getCostSettings(), deps.repo.listResourcePrices(), deps.repo.costWatermarks(),
  ]);
  if (!needsTime(settings)) return;
  const { entries, sessionBilled } = computeAccruals(nowMs, settings, prices, deployments, turns, watermarks, mode);
  if (entries.length) await deps.repo.insertCostEntries(entries);
  for (const [id, amount] of sessionBilled) await deps.repo.addSessionBilledCost(id, amount);
}

// Tick and settle share watermark-read → insert; serialize them so a settle
// racing a tick cannot both accrue the same span (double-billing). In-process
// only — a multi-replica CP would need a DB-level lock (not a deployment
// model today).
let accrualChain: Promise<void> = Promise.resolve();
function serialized(fn: () => Promise<void>): Promise<void> {
  const next = accrualChain.then(fn, fn);
  accrualChain = next.catch(() => {});
  return next;
}

export async function costSamplerTick(deps: SamplerDeps, nowMs = Date.now()) {
  const items = await deps.kube.list("modeldeployments").catch((err) => {
    console.warn("cost-sampler: deployment list failed:", err);
    return [] as any[];
  });
  const deployments: DeploymentObs[] = items.map((d: any) => ({
    name: d.metadata?.name ?? "",
    pool: d.spec?.poolRef ?? null,
    readyReplicas: Number(d.status?.readyReplicas ?? 0),
  })).filter((d) => d.name);

  const sessions = await deps.repo.listRunningSessionsForBilling();
  const turns: TurnObs[] = [];
  for (const s of sessions) {
    try {
      const info = await deps.orchestrator.sessionJobInfo(s.id, s.turns);
      if (info.state !== "active") continue;   // pod gone → the settle path owns the tail
      turns.push({ sessionId: s.id, workspaceId: s.workspace_id,
        environmentId: s.environment_id, startedAtMs: info.startedAt?.getTime() ?? null });
    } catch (err) {
      console.warn(`cost-sampler: job info for ${s.id} failed:`, err); // next tick retries
    }
  }
  await serialized(() => accrue(deps, deployments, turns, nowMs));
}

/** Final accrual for one session's turn — called when status leaves running
 *  (runner result, interrupt, zombie fail). The pod may already be gone: the
 *  span ends "now", the observed end of the turn. A turn with neither a
 *  watermark nor a pod-start anchor accrues nothing (unknown span — the gap
 *  cap philosophy says skip, never fabricate). The pod-start anchor is fetched
 *  here too (the Job still exists at result-post time; TTL cleanup is later)
 *  so a resumed turn ending between ticks — or a first turn shorter than the
 *  tick interval — settles against the anchor instead of a stale/absent
 *  watermark. */
export async function settleSession(deps: SamplerDeps, sessionId: string) {
  const s = await deps.repo.getSessionForBilling(sessionId);
  if (!s) return;
  let startedAtMs: number | null = null;
  try {
    const info = await deps.orchestrator.sessionJobInfo(s.id, s.turns);
    startedAtMs = info.startedAt?.getTime() ?? null;
  } catch (err) {
    console.warn(`cost-sampler: settle job info for ${s.id} failed:`, err); // fall back to watermark-only
  }
  const turns: TurnObs[] = [{ sessionId: s.id, workspaceId: s.workspace_id,
    environmentId: s.environment_id, startedAtMs }];
  // Terminal settle: the started minute is billed (rounds the tail UP).
  await serialized(() => accrue(deps, [], turns, Date.now(), "settle"));
}

export function startCostSampler(deps: SamplerDeps) {
  const tick = () => costSamplerTick(deps).catch((err) => console.warn("cost-sampler: tick failed:", err));
  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
