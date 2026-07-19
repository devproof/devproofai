// Cost tracking & billing (spec 2026-07-14): settings shape + validation.
// Accrual math (ratePerSecond/computeAccruals) lives here too from Task 4 on.

export interface CostSettings {
  enabled: boolean;
  currency: string;
  trackPoolCosts: boolean;
  trackExternalCosts: boolean;
  trackEnvCosts: boolean;
  billing: {
    enabled: boolean;
    showSessionCosts: boolean;
    billSessionTime: boolean;
    billExternalTokens: boolean;
    billLocalTokens: boolean;
    billDeploymentTime: boolean;
  };
}

export const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY"] as const;

export const DEFAULT_COST_SETTINGS: CostSettings = {
  enabled: false,
  currency: "EUR",
  trackPoolCosts: false,
  trackExternalCosts: false,
  trackEnvCosts: false,
  billing: {
    enabled: false,
    showSessionCosts: false,
    billSessionTime: false,
    billExternalTokens: false,
    billLocalTokens: false,
    billDeploymentTime: false,
  },
};

const asBool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);

/** Merge a stored/submitted partial onto defaults — absent keys read as off. */
export function normalizeCostSettings(raw: unknown): CostSettings {
  const r = (raw ?? {}) as any;
  const b = (r.billing ?? {}) as any;
  const d = DEFAULT_COST_SETTINGS;
  return {
    enabled: asBool(r.enabled, d.enabled),
    currency: CURRENCIES.includes(r.currency) ? r.currency : d.currency,
    trackPoolCosts: asBool(r.trackPoolCosts, d.trackPoolCosts),
    trackExternalCosts: asBool(r.trackExternalCosts, d.trackExternalCosts),
    trackEnvCosts: asBool(r.trackEnvCosts, d.trackEnvCosts),
    billing: {
      enabled: asBool(b.enabled, d.billing.enabled),
      showSessionCosts: asBool(b.showSessionCosts, d.billing.showSessionCosts),
      billSessionTime: asBool(b.billSessionTime, d.billing.billSessionTime),
      billExternalTokens: asBool(b.billExternalTokens, d.billing.billExternalTokens),
      billLocalTokens: asBool(b.billLocalTokens, d.billing.billLocalTokens),
      billDeploymentTime: asBool(b.billDeploymentTime, d.billing.billDeploymentTime),
    },
  };
}

/** PUT validation: error string or null. Strict on types, tolerant on absence. */
export function validateCostSettings(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "costs must be an object";
  const r = raw as any;
  if (r.currency !== undefined && !CURRENCIES.includes(r.currency))
    return `currency must be one of ${CURRENCIES.join(", ")}`;
  const boolKeys = ["enabled", "trackPoolCosts", "trackExternalCosts", "trackEnvCosts"];
  for (const k of boolKeys) if (r[k] !== undefined && typeof r[k] !== "boolean") return `${k} must be a boolean`;
  if (r.billing !== undefined) {
    if (r.billing === null || typeof r.billing !== "object" || Array.isArray(r.billing)) return "billing must be an object";
    const bKeys = ["enabled", "showSessionCosts", "billSessionTime", "billExternalTokens", "billLocalTokens", "billDeploymentTime"];
    for (const k of bKeys) if (r.billing[k] !== undefined && typeof r.billing[k] !== "boolean") return `billing.${k} must be a boolean`;
  }
  return null;
}

export type PriceKind = "pool" | "deployment" | "external" | "environment";
export const PRICE_KINDS: PriceKind[] = ["pool", "deployment", "external", "environment"];
const TIME_UNITS = ["minute", "hour", "day", "month", "year"] as const;

// Which sub-objects each kind may carry (spec §2).
const ALLOWED: Record<PriceKind, { real: string[]; billing: string[] }> = {
  pool:        { real: ["podTime"],  billing: [] },
  deployment:  { real: [],           billing: ["podTime", "tokens"] },
  external:    { real: ["tokens"],   billing: ["tokens"] },
  environment: { real: ["podTime"],  billing: ["sessionTime"] },
};

const timeErr = (p: any, label: string, minuteOk: boolean): string | null => {
  if (p === null || typeof p !== "object") return `${label} must be {amount, per}`;
  if (typeof p.amount !== "number" || !(p.amount >= 0)) return `${label}.amount must be a number >= 0`;
  const units = minuteOk ? TIME_UNITS : TIME_UNITS.filter((u) => u !== "minute");
  if (!units.includes(p.per)) return `${label}.per must be one of ${units.join("|")}`;
  return null;
};
// Token price = amount per configurable token count, per direction (user
// 2026-07-14: denominators differ between input/output and across vendors).
// Shape: { in?: {amount, perTokens}, out?: {amount, perTokens} } — a missing
// direction costs nothing.
const tokErr = (p: any, label: string): string | null => {
  if (p === null || typeof p !== "object") return `${label} must be {in?, out?}`;
  if (p.in === undefined && p.out === undefined) return `${label} needs in and/or out`;
  for (const d of ["in", "out"] as const) {
    if (p[d] === undefined) continue;
    if (p[d] === null || typeof p[d] !== "object") return `${label}.${d} must be {amount, perTokens}`;
    if (typeof p[d].amount !== "number" || !(p[d].amount >= 0)) return `${label}.${d}.amount must be a number >= 0`;
    if (!Number.isInteger(p[d].perTokens) || !(p[d].perTokens >= 1)) return `${label}.${d}.perTokens must be an integer >= 1`;
  }
  return null;
};

/** Validate a prices object for a kind. Empty object = "no prices" (caller deletes the row). */
export function validatePrices(kind: string, raw: unknown): string | null {
  if (!PRICE_KINDS.includes(kind as PriceKind)) return `kind must be one of ${PRICE_KINDS.join("|")}`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "prices must be an object";
  const allowed = ALLOWED[kind as PriceKind];
  for (const [ledger, sub] of Object.entries(raw as Record<string, any>)) {
    if (ledger !== "real" && ledger !== "billing") return `unknown ledger "${ledger}" (real|billing)`;
    if (sub === null || typeof sub !== "object") return `${ledger} must be an object`;
    for (const [key, val] of Object.entries(sub)) {
      if (!allowed[ledger as "real" | "billing"].includes(key))
        return `${kind} does not accept ${ledger}.${key}`;
      // minute unit: session billing and environment real cost (consistency,
      // user 2026-07-14) — both meter session pods, whose lifetimes are
      // minutes, not hours.
      const minuteOk = key === "sessionTime" || (kind === "environment" && key === "podTime");
      const err = key === "tokens" ? tokErr(val, `${ledger}.tokens`)
        : timeErr(val, `${ledger}.${key}`, minuteOk);
      if (err) return err;
    }
  }
  return null;
}

// ── Time-cost accrual (spec §4) — pure; the sampler supplies observations. ──
export const GAP_CAP_SEC = 120;
const PER_SECONDS: Record<string, number> = {
  minute: 60, hour: 3600, day: 86400, month: 2_592_000, year: 31_536_000,
};

export function ratePerSecond(p?: { amount?: number; per?: string } | null): number {
  if (!p || typeof p.amount !== "number" || !(p.amount >= 0)) return 0;
  const s = PER_SECONDS[p.per ?? ""];
  return s ? p.amount / s : 0;
}

export interface DeploymentObs { name: string; pool: string | null; readyReplicas: number }
export interface TurnObs { sessionId: string; workspaceId: string; environmentId: string | null; startedAtMs: number | null }
export interface CostEntryDraft {
  kind: "pool_pod" | "deployment_time" | "env_pod" | "session_time";
  deployment?: string; pool?: string; environmentId?: string; sessionId?: string; workspaceId?: string;
  seconds: number; replicas?: number; realCost: number | null; billedCost: number | null;
  /** Explicit ledger timestamp = span start + billed seconds. This is how the
   *  sub-minute remainder carries: the next watermark starts exactly where the
   *  billed minutes ended, not at "now". */
  tsMs?: number;
}

/** Billing quantum is the MINUTE (user decision 2026-07-14): the price unit
 *  (hour/day/…) only sets the rate. Ticks bill whole elapsed minutes and
 *  carry the remainder via the entry timestamp; a terminal settle rounds the
 *  final partial minute UP (a started minute is billed). */
export type AccrualMode = "tick" | "settle";
const quantizeSec = (rawSec: number, mode: AccrualMode) =>
  mode === "settle" ? Math.ceil(rawSec / 60) * 60 : Math.floor(rawSec / 60) * 60;

/** Span start + raw elapsed seconds since the later of the watermark and the
 *  pod-start anchor (gap-capped). A stale watermark from before an idle gap
 *  must never win over a fresher anchor — that would bill idle time as pod
 *  runtime. fromMs null = first sighting without a start signal. */
function span(nowMs: number, watermarkMs: number | undefined, anchorMs: number | null): { fromMs: number | null; rawSec: number } {
  const from = watermarkMs != null && anchorMs != null
    ? Math.max(watermarkMs, anchorMs)
    : (watermarkMs ?? anchorMs);
  if (from == null) return { fromMs: null, rawSec: 0 };
  return { fromMs: from, rawSec: Math.min(Math.max(0, (nowMs - from) / 1000), GAP_CAP_SEC) };
}

export function computeAccruals(
  nowMs: number,
  settings: CostSettings,
  prices: { kind: string; ref: string; prices: any }[],
  deployments: DeploymentObs[],
  turns: TurnObs[],
  watermarksMs: Map<string, number>,
  mode: AccrualMode = "tick",
): { entries: CostEntryDraft[]; sessionBilled: Map<string, number> } {
  const entries: CostEntryDraft[] = [];
  const sessionBilled = new Map<string, number>();
  const price = (kind: string, ref: string | null) =>
    ref == null ? undefined : prices.find((p) => p.kind === kind && p.ref === ref)?.prices;
  const billing = settings.billing.enabled;

  for (const d of deployments) {
    if (d.readyReplicas <= 0) continue;
    const watermark = watermarksMs.get(`dep:${d.name}`);
    const { fromMs, rawSec } = span(nowMs, watermark, null);
    // Deployments have no terminal settle — always floor + carry (exact over time).
    const sec = quantizeSec(rawSec, "tick");
    const poolP = price("pool", d.pool)?.real?.podTime;
    const depP = price("deployment", d.name)?.billing?.podTime;
    const wantsPool = settings.enabled && settings.trackPoolCosts && !!poolP;
    const wantsDep = billing && settings.billing.billDeploymentTime && !!depP;
    if (fromMs == null || sec <= 0) {
      // No watermark AND no anchor (deployments have none): a deployment that
      // was already Ready before cost tracking was enabled would otherwise
      // never accrue, because the watermark it needs is itself sourced from a
      // prior cost_entries row. Plant a zero-cost row now so the NEXT tick has
      // a `dep:<name>` watermark to accrue whole minutes from — first sighting
      // starts accrual at "now", never retroactively.
      if (watermark === undefined) {
        if (wantsPool) entries.push({ kind: "pool_pod", deployment: d.name, pool: d.pool ?? undefined,
          seconds: 0, replicas: d.readyReplicas, realCost: 0, billedCost: null, tsMs: nowMs });
        if (wantsDep) entries.push({ kind: "deployment_time", deployment: d.name, pool: d.pool ?? undefined,
          seconds: 0, replicas: d.readyReplicas, realCost: null, billedCost: 0, tsMs: nowMs });
      }
      continue;
    }
    const tsMs = fromMs + sec * 1000;
    if (wantsPool) {
      entries.push({ kind: "pool_pod", deployment: d.name, pool: d.pool ?? undefined,
        seconds: sec, replicas: d.readyReplicas,
        realCost: ratePerSecond(poolP) * d.readyReplicas * sec, billedCost: null, tsMs });
    }
    if (wantsDep) {
      entries.push({ kind: "deployment_time", deployment: d.name, pool: d.pool ?? undefined,
        seconds: sec, replicas: d.readyReplicas,
        realCost: null, billedCost: ratePerSecond(depP) * d.readyReplicas * sec, tsMs });
    }
  }

  for (const t of turns) {
    const { fromMs, rawSec } = span(nowMs, watermarksMs.get(`sesn:${t.sessionId}`), t.startedAtMs);
    if (fromMs == null || rawSec <= 0) continue;
    // Ticks bill whole minutes (remainder carries via tsMs); the terminal
    // settle rounds the started minute up. tsMs may land ≤59s in the future —
    // it is the paid-through marker: a follow-up turn starting inside the
    // already-billed minute continues from it instead of double-charging.
    const sec = quantizeSec(rawSec, mode);
    if (sec <= 0) continue;
    const tsMs = fromMs + sec * 1000;
    const envPrices = price("environment", t.environmentId);
    const envP = envPrices?.real?.podTime;
    if (settings.enabled && settings.trackEnvCosts && envP) {
      entries.push({ kind: "env_pod", environmentId: t.environmentId!, sessionId: t.sessionId,
        workspaceId: t.workspaceId, seconds: sec,
        realCost: ratePerSecond(envP) * sec, billedCost: null, tsMs });
    }
    const sesP = envPrices?.billing?.sessionTime;
    if (billing && settings.billing.billSessionTime && sesP) {
      const cost = ratePerSecond(sesP) * sec;
      entries.push({ kind: "session_time", environmentId: t.environmentId!, sessionId: t.sessionId,
        workspaceId: t.workspaceId, seconds: sec, realCost: null, billedCost: cost, tsMs });
      sessionBilled.set(t.sessionId, (sessionBilled.get(t.sessionId) ?? 0) + cost);
    }
  }
  return { entries, sessionBilled };
}

/** Allocate ledger entries (each spans [ts - seconds, ts]) proportionally
 *  across fixed buckets so 60s-grain entries don't spike in 10s charts. */
export function spreadCostEntries(
  entries: { tsMs: number; seconds: number; realCost: number; billedCost: number }[],
  t0Sec: number, bucketSec: number, count: number,
): { real: number[]; billed: number[] } {
  const real = new Array<number>(count).fill(0);
  const billed = new Array<number>(count).fill(0);
  for (const e of entries) {
    const end = e.tsMs / 1000;
    const start = end - Math.max(e.seconds, 0.001);
    const span = end - start;
    const first = Math.max(0, Math.floor((start - t0Sec) / bucketSec));
    const last = Math.min(count - 1, Math.floor((end - t0Sec) / bucketSec));
    for (let i = first; i <= last; i++) {
      const bStart = t0Sec + i * bucketSec;
      const overlap = Math.min(end, bStart + bucketSec) - Math.max(start, bStart);
      if (overlap <= 0) continue;
      const f = overlap / span;
      real[i] += e.realCost * f;
      billed[i] += e.billedCost * f;
    }
  }
  return { real, billed };
}
