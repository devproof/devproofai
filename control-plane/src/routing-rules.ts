// Pure validation + static analysis for Routings (spec 2026-07-16). The
// runtime evaluator lives in the gateway hook (custom_callbacks.py, tested
// by deploy/gateway/test_custom_callbacks.py) — this module guarantees only
// well-formed tables ever reach it.
export type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Condition =
  | { type: "cost"; ledger: "billed" | "real"; scope: "key" | "workspace" | "agent" | "routing" | "target";
      op: "<" | ">="; threshold: number; window: { kind: "month" | "day" | "rolling"; hours?: number } }
  | { type: "tokens"; scope: "key" | "workspace" | "agent" | "routing" | "target";
      op: "<" | ">="; threshold: number; window: { kind: "month" | "day" | "rolling"; hours?: number } }
  | { type: "context"; op: "<=" | ">"; tokens: number }
  | { type: "available" }
  | { type: "time"; days?: Day[]; from: string; to: string; tz: string }
  | { type: "split"; percent: number }
  | { type: "classify"; deployment: string; labels: Record<string, string>; match: string[] };
export interface RoutingRule { conditions: Condition[]; target: string }
export type Terminal = { action: "route"; target: string } | { action: "reject" };
export interface RoutingSpec { rules: RoutingRule[]; terminal: Terminal }
export interface TargetCtx { localNames: Set<string>; externalNames: Set<string> }

export const ROUTING_NAME = /^[a-z]([-a-z0-9]*[a-z0-9])?$/; // DNS-1035, like deployments

const DAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const validTz = (tz: unknown): boolean => {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
};

const targetError = (t: unknown, ctx: TargetCtx, what: string): string | null =>
  typeof t === "string" && (ctx.localNames.has(t) || ctx.externalNames.has(t))
    ? null : `${what}: unknown target "${t}" (must be a deployment or external endpoint name)`;

function conditionError(c: any, ctx: TargetCtx): string | null {
  if (!c || typeof c !== "object") return "condition must be an object";
  switch (c.type) {
    case "cost": {
      if (!["billed", "real"].includes(c.ledger)) return "cost: ledger must be billed|real";
      if (!["key", "workspace", "agent", "routing", "target"].includes(c.scope))
        return "cost: scope must be key|workspace|agent|routing|target";
      if (!["<", ">="].includes(c.op)) return "cost: op must be < or >=";
      if (typeof c.threshold !== "number" || !Number.isFinite(c.threshold) || c.threshold < 0)
        return "cost: threshold must be a number >= 0";
      const w = c.window;
      if (!w || !["month", "day", "rolling"].includes(w.kind)) return "cost: window.kind must be month|day|rolling";
      if (w.kind === "rolling" && !(Number.isInteger(w.hours) && w.hours >= 1 && w.hours <= 8760))
        return "cost: rolling window needs integer hours 1-8760";
      return null;
    }
    case "tokens": {
      // Like cost, minus the ledger — tokens are always metered (independent
      // of cost/billing settings). Threshold is an integer token count.
      if (!["key", "workspace", "agent", "routing", "target"].includes(c.scope))
        return "tokens: scope must be key|workspace|agent|routing|target";
      if (!["<", ">="].includes(c.op)) return "tokens: op must be < or >=";
      if (!Number.isInteger(c.threshold) || c.threshold < 0)
        return "tokens: threshold must be an integer >= 0";
      const w = c.window;
      if (!w || !["month", "day", "rolling"].includes(w.kind)) return "tokens: window.kind must be month|day|rolling";
      if (w.kind === "rolling" && !(Number.isInteger(w.hours) && w.hours >= 1 && w.hours <= 8760))
        return "tokens: rolling window needs integer hours 1-8760";
      return null;
    }
    case "context":
      if (!["<=", ">"].includes(c.op)) return "context: op must be <= or >";
      if (!Number.isInteger(c.tokens) || c.tokens < 1) return "context: tokens must be a positive integer";
      return null;
    case "available":
      return null;
    case "time": {
      if (c.days !== undefined) {
        if (!Array.isArray(c.days) || !c.days.length || c.days.some((d: any) => !DAYS.has(d)))
          return "time: days must be a non-empty subset of mon..sun";
      }
      if (!HHMM.test(c.from ?? "") || !HHMM.test(c.to ?? "")) return "time: from/to must be HH:MM (00:00-23:59)";
      if (!validTz(c.tz)) return "time: unknown timezone";
      return null;
    }
    case "split":
      if (typeof c.percent !== "number" || c.percent <= 0 || c.percent > 100)
        return "split: percent must be > 0 and <= 100";
      return null;
    case "classify": {
      if (typeof c.deployment !== "string" || !(ctx.localNames.has(c.deployment) || ctx.externalNames.has(c.deployment)))
        return `classify: "${c.deployment}" must be a deployment or external endpoint name`;
      const labels = c.labels;
      if (!labels || typeof labels !== "object" || Array.isArray(labels)) return "classify: labels must be an object";
      const keys = Object.keys(labels);
      if (!keys.length || keys.length > 8) return "classify: labels needs 1-8 entries";
      for (const k of keys) {
        if (!k || k.length > 32 || typeof labels[k] !== "string") return "classify: labels are name -> description strings";
      }
      if (!Array.isArray(c.match) || !c.match.length || c.match.some((m: any) => !keys.includes(m)))
        return "classify: match must be a non-empty subset of the label names";
      return null;
    }
    default:
      return `unknown condition type "${c.type}"`;
  }
}

export function validateRouting(spec: RoutingSpec, ctx: TargetCtx): string | null {
  const rules = (spec as any)?.rules;
  if (!Array.isArray(rules)) return "rules must be an array";
  if (rules.length > 50) return "at most 50 rules";
  for (let i = 0; i < rules.length; i++) {
    const r: any = rules[i];
    const tErr = targetError(r?.target, ctx, `rule ${i + 1}`);
    if (tErr) return tErr;
    if (!Array.isArray(r.conditions)) return `rule ${i + 1}: conditions must be an array`;
    if (r.conditions.length > 10) return `rule ${i + 1}: at most 10 conditions`;
    for (const c of r.conditions) {
      const err = conditionError(c, ctx);
      if (err) return `rule ${i + 1}: ${err}`;
    }
  }
  const t: any = (spec as any)?.terminal;
  if (t?.action === "reject") return null;
  if (t?.action === "route") return targetError(t.target, ctx, "terminal");
  return "terminal must be { action: \"route\", target } or { action: \"reject\" }";
}

/** Local deployments a request through this routing can land on — feeds the
 *  session auto-compact window (min served context) and the Connect warning. */
export function reachableLocalTargets(spec: RoutingSpec, localNames: Set<string>): string[] {
  const names = new Set<string>();
  for (const r of spec.rules ?? []) if (localNames.has(r.target)) names.add(r.target);
  if (spec.terminal?.action === "route" && localNames.has(spec.terminal.target)) names.add(spec.terminal.target);
  return [...names];
}

/** All targets (local or external, deduped) a request through this routing
 *  can land on — rule targets + a route terminal's target. Unlike
 *  reachableLocalTargets, no filtering by kind: used to fold external
 *  endpoints' context_tokens into the min-window calculation (fix wave L). */
export function reachableTargets(spec: RoutingSpec): string[] {
  const names = new Set<string>();
  for (const r of spec.rules ?? []) if (r.target) names.add(r.target);
  if (spec.terminal?.action === "route") names.add(spec.terminal.target);
  return [...names];
}
