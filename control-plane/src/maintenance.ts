// Maintenance runner (spec 2026-07-17): orphan sweep + retention cleanups.
// delete paths (crash between the Postgres write and the S3 delete, kubectl
// bypass). Primary hygiene lives in the routes; this reconciles the rest.
// Scheduling: 5-field cron (LOCAL server time) from app_settings, checked
// once a minute — no dependency, standard syntax incl. vixie dom/dow OR-rule.
import type { FileStore } from "./filestore.ts";

export const DEFAULT_MAINTENANCE_CRON = "0 1 * * *";
const GRACE_MS = 3_600_000; // never touch anything younger than 1h (in-flight uploads)

export type GcSummary = { rows: number; objects: number; bytes: number; at: string; ms: number };

export type RetentionUnit = "hours" | "days";
export type Retention = { enabled: boolean; keep: number; unit: RetentionUnit };
export type MaintenanceSettings = {
  cron: string;
  orphans: { enabled: boolean };
  billing: Retention;
  tokens: Retention;
  sessions: { idle: Retention; completed: Retention };
  files: { input: Retention; output: Retention };
  rejects: Retention;
  prices: { enabled: boolean };
  k8s: { enabled: boolean };
};
export type MaintenanceSummary = {
  at: string; ms: number;
  sections: {
    orphans:  { ran: boolean; rows?: number; objects?: number; bytes?: number; error?: string };
    billing:  { ran: boolean; rows?: number; error?: string };
    tokens:   { ran: boolean; rows?: number; error?: string };
    sessions: { ran: boolean; idle?: number; completed?: number; error?: string };
    files:    { ran: boolean; input?: number; output?: number; bytes?: number; error?: string };
    rejects:  { ran: boolean; rows?: number; error?: string };
    prices:   { ran: boolean; rows?: number; error?: string };
    k8s:      { ran: boolean; secrets?: number; egress?: number; policies?: number; pvcs?: number; error?: string };
  };
};

export function defaultMaintenanceSettings(legacyCron?: string | null): MaintenanceSettings {
  return {
    cron: typeof legacyCron === "string" && legacyCron.trim() ? legacyCron.trim() : DEFAULT_MAINTENANCE_CRON,
    orphans: { enabled: true },
    billing: { enabled: false, keep: 365, unit: "days" },
    tokens: { enabled: false, keep: 365, unit: "days" },
    sessions: {
      idle: { enabled: false, keep: 7, unit: "days" },
      completed: { enabled: false, keep: 4, unit: "hours" },
    },
    files: {
      input: { enabled: false, keep: 4, unit: "hours" },
      output: { enabled: false, keep: 4, unit: "hours" },
    },
    rejects: { enabled: true, keep: 30, unit: "days" },
    prices: { enabled: true },
    k8s: { enabled: true },
  };
}

function mergeRetention(base: Retention, raw: any): Retention {
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : base.enabled,
    keep: Number.isInteger(raw?.keep) && raw.keep >= 1 ? raw.keep : base.keep,
    unit: raw?.unit === "hours" || raw?.unit === "days" ? raw.unit : base.unit,
  };
}

/** Per-field merge: any absent/invalid field keeps the base value, so a
 *  partial PUT body never resets sibling settings (limits/storage idiom). */
export function mergeMaintenanceSettings(base: MaintenanceSettings, raw: unknown): MaintenanceSettings {
  const m = raw as any;
  return {
    cron: typeof m?.cron === "string" && m.cron.trim() ? m.cron.trim() : base.cron,
    orphans: { enabled: typeof m?.orphans?.enabled === "boolean" ? m.orphans.enabled : base.orphans.enabled },
    billing: mergeRetention(base.billing, m?.billing),
    tokens: mergeRetention(base.tokens, m?.tokens),
    sessions: {
      idle: mergeRetention(base.sessions.idle, m?.sessions?.idle),
      completed: mergeRetention(base.sessions.completed, m?.sessions?.completed),
    },
    files: {
      input: mergeRetention(base.files.input, m?.files?.input),
      output: mergeRetention(base.files.output, m?.files?.output),
    },
    rejects: mergeRetention(base.rejects, m?.rejects),
    prices: { enabled: typeof m?.prices?.enabled === "boolean" ? m.prices.enabled : base.prices.enabled },
    k8s: { enabled: typeof m?.k8s?.enabled === "boolean" ? m.k8s.enabled : base.k8s.enabled },
  };
}

export function validateMaintenanceSettings(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null) return "maintenance must be an object";
  const m = raw as any;
  if (m.cron !== undefined) {
    if (typeof m.cron !== "string") return "maintenance.cron must be a string";
    const err = validateCron(m.cron);
    if (err) return `maintenance.cron: ${err}`;
  }
  if (m.orphans?.enabled !== undefined && typeof m.orphans.enabled !== "boolean") {
    return "maintenance.orphans.enabled must be a boolean";
  }
  if (m.prices?.enabled !== undefined && typeof m.prices.enabled !== "boolean") {
    return "maintenance.prices.enabled must be a boolean";
  }
  if (m.k8s?.enabled !== undefined && typeof m.k8s.enabled !== "boolean") {
    return "maintenance.k8s.enabled must be a boolean";
  }
  const rules: [string, any][] = [
    ["billing", m.billing], ["tokens", m.tokens],
    ["rejects", m.rejects],
    ["sessions.idle", m.sessions?.idle], ["sessions.completed", m.sessions?.completed],
    ["files.input", m.files?.input], ["files.output", m.files?.output],
  ];
  for (const [path, r] of rules) {
    if (r === undefined) continue;
    if (r?.enabled !== undefined && typeof r.enabled !== "boolean") return `maintenance.${path}.enabled must be a boolean`;
    if (r?.keep !== undefined && !(Number.isInteger(r.keep) && r.keep >= 1)) return `maintenance.${path}.keep must be an integer >= 1`;
    if (r?.unit !== undefined && r.unit !== "hours" && r.unit !== "days") return `maintenance.${path}.unit must be hours or days`;
  }
  return null;
}

export function retentionMs(r: Retention): number {
  return r.keep * (r.unit === "hours" ? 3_600_000 : 86_400_000);
}

export interface GcRepo {
  listOrphanFileRows(graceMs: number): Promise<{ id: string }[]>;
  deleteFileRecordById(id: string): Promise<string | null>;
  objectKeyExists(key: string): Promise<boolean>;
}

const BOUNDS: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((part) => {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    let lo: number, hi: number;
    if (range === "*") { lo = min; hi = max; }
    else if (range.includes("-")) { [lo, hi] = range.split("-").map(Number); }
    else if (stepStr) { lo = Number(range); hi = max; }
    else return value === Number(range);
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

export function validateCron(expr: string): string | null {
  const fields = (expr ?? "").trim().split(/\s+/);
  if (fields.length !== 5) return "cron needs 5 fields: minute hour day month weekday";
  const names = ["minute", "hour", "day", "month", "weekday"];
  for (let i = 0; i < 5; i++) {
    const [min, max] = BOUNDS[i];
    for (const part of fields[i].split(",")) {
      const m = /^(\*|(\d+)(-(\d+))?)(\/(\d+))?$/.exec(part);
      if (!m) return `bad ${names[i]} field: ${part}`;
      if (m[6] !== undefined && Number(m[6]) < 1) return `bad step in ${names[i]}: ${part}`;
      for (const n of [m[2], m[4]]) {
        if (n !== undefined && (Number(n) < min || Number(n) > max)) return `${names[i]} out of range: ${part}`;
      }
      if (m[2] !== undefined && m[4] !== undefined && Number(m[2]) > Number(m[4])) return `inverted range in ${names[i]}: ${part}`;
    }
  }
  return null;
}

export function cronMatches(expr: string, d: Date): boolean {
  if (validateCron(expr)) return false;
  const [m, h, dom, mon, dow] = expr.trim().split(/\s+/);
  const minHourMon = fieldMatches(m, d.getMinutes(), 0, 59)
    && fieldMatches(h, d.getHours(), 0, 23)
    && fieldMatches(mon, d.getMonth() + 1, 1, 12);
  if (!minHourMon) return false;
  const domOk = fieldMatches(dom, d.getDate(), 1, 31);
  const dowOk = fieldMatches(dow, d.getDay(), 0, 7) || (d.getDay() === 0 && fieldMatches(dow, 7, 0, 7));
  // vixie rule: when BOTH day fields are restricted, either may match.
  return dom !== "*" && dow !== "*" ? domOk || dowOk : domOk && dowOk;
}

export async function runGc(repo: GcRepo, files: FileStore, opts: { graceMs?: number; now?: () => Date } = {}): Promise<GcSummary> {
  const graceMs = opts.graceMs ?? GRACE_MS;
  const now = opts.now ?? (() => new Date());
  const started = now();
  let rows = 0, objects = 0, bytes = 0;
  // 1. Orphan rows (dead/replaced checkpoints, unreferenced skill/memory
  //    files) → row always, object only when unshared.
  for (const r of await repo.listOrphanFileRows(graceMs)) {
    const key = await repo.deleteFileRecordById(r.id).catch(() => null);
    rows++;
    if (key) {
      await Promise.resolve(files.del(key)).catch(() => {});
      objects++;
    }
  }
  // 2. Orphan objects: no files row claims the key, older than grace.
  for await (const obj of files.list()) {
    if (now().getTime() - obj.lastModified.getTime() < graceMs) continue;
    if (await repo.objectKeyExists(obj.key)) continue;
    await Promise.resolve(files.del(obj.key)).catch(() => {});
    objects++;
    bytes += obj.size;
  }
  const summary: GcSummary = { rows, objects, bytes, at: started.toISOString(), ms: now().getTime() - started.getTime() };
  return summary;
}

export interface MaintenanceRepo extends GcRepo {
  getMaintenanceSettings(): Promise<MaintenanceSettings>;
  setMaintenanceLastRun(s: MaintenanceSummary): Promise<void>;
  pruneCostEntries(cutoffMs: number): Promise<number>;
  pruneGatewayUsage(cutoffMs: number): Promise<number>;
  listExpiredSessions(idleCutoffMs: number | null, completedCutoffMs: number | null):
    Promise<{ id: string; workspace_id: string; status: string }[]>;
  listExpiredFiles(kind: "upload" | "output", cutoffMs: number): Promise<{ id: string; size: number }[]>;
  pruneRoutingRejects(cutoffMs: number): Promise<number>;
  pruneOrphanResourcePrices(
    kind: "pool" | "deployment" | "external" | "environment", liveRefs: string[]): Promise<number>;
  listAllIds(table: "vaults" | "environments" | "sessions" | "external_deployments"): Promise<string[]>;
}

export type MaintenanceDeps = {
  repo: MaintenanceRepo;
  files: FileStore;
  /** Full session teardown (deleteSessionFully bound to the orchestrator). */
  deleteSession: (workspaceId: string, sessionId: string) => Promise<void>;
  /** Live pool/deployment CR names (kubestore) for the prices sweep. Absent ⇒
   *  the pool/deployment legs fail closed. */
  listServing?: () => Promise<{ pools: string[]; deployments: string[] }>;
  /** Orphaned-k8s sweep (orchestrator.sweepOrphanedK8s). Absent ⇒ the k8s
   *  section reports an error instead of silently claiming success. */
  sweepK8s?: (input: { vaultIds: string[]; environmentIds: string[]; sessionIds: string[]; graceMs: number }) =>
    Promise<{ secrets?: number; egress?: number; policies?: number; pvcs?: number; errors: string[] }>;
};

/** Ordered run: billing → tokens → rejects → sessions → files → prices →
 *  k8s → orphans. Sessions free files (session_files cascade) before file cleanup;
 *  the orphan sweep mops up last. Each section is error-isolated. */
export async function runMaintenance(deps: MaintenanceDeps, opts: { now?: () => Date } = {}): Promise<MaintenanceSummary> {
  const now = opts.now ?? (() => new Date());
  const started = now();
  const m = await deps.repo.getMaintenanceSettings();
  const sections: MaintenanceSummary["sections"] = {
    orphans: { ran: false }, billing: { ran: false }, tokens: { ran: false },
    sessions: { ran: false }, files: { ran: false },
    rejects: { ran: false }, prices: { ran: false }, k8s: { ran: false },
  };
  const guard = async (sec: { ran: boolean; error?: string }, run: () => Promise<void>) => {
    sec.ran = true;
    try { await run(); } catch (err) { sec.error = String((err as Error)?.message ?? err); }
  };

  if (m.billing.enabled) await guard(sections.billing, async () => {
    sections.billing.rows = await deps.repo.pruneCostEntries(retentionMs(m.billing));
  });
  if (m.tokens.enabled) await guard(sections.tokens, async () => {
    sections.tokens.rows = await deps.repo.pruneGatewayUsage(retentionMs(m.tokens));
  });
  if (m.rejects.enabled) await guard(sections.rejects, async () => {
    sections.rejects.rows = await deps.repo.pruneRoutingRejects(retentionMs(m.rejects));
  });
  if (m.sessions.idle.enabled || m.sessions.completed.enabled) await guard(sections.sessions, async () => {
    const rows = await deps.repo.listExpiredSessions(
      m.sessions.idle.enabled ? retentionMs(m.sessions.idle) : null,
      m.sessions.completed.enabled ? retentionMs(m.sessions.completed) : null);
    let idle = 0, completed = 0;
    for (const s of rows) {
      await deps.deleteSession(s.workspace_id, s.id);
      if (s.status === "completed") completed++; else idle++;
    }
    sections.sessions.idle = idle;
    sections.sessions.completed = completed;
  });
  if (m.files.input.enabled || m.files.output.enabled) await guard(sections.files, async () => {
    let bytes = 0;
    for (const [kind, rule, half] of [
      ["upload", m.files.input, "input"], ["output", m.files.output, "output"],
    ] as const) {
      if (!rule.enabled) continue;
      let count = 0;
      for (const f of await deps.repo.listExpiredFiles(kind, retentionMs(rule))) {
        const key = await deps.repo.deleteFileRecordById(f.id).catch(() => null);
        count++;
        if (key) { await Promise.resolve(deps.files.del(key)).catch(() => {}); bytes += Number(f.size); }
      }
      sections.files[half] = count;
    }
    sections.files.bytes = bytes;
  });
  // Prices: per-kind fail-closed — a failed lister skips that kind only; an
  // empty-but-successful list is valid (zero live resources ⇒ all orphaned).
  if (m.prices.enabled) await guard(sections.prices, async () => {
    let rows = 0;
    const errs: string[] = [];
    const leg = async (kind: "pool" | "deployment" | "external" | "environment", refs: () => Promise<string[]>) => {
      try { rows += await deps.repo.pruneOrphanResourcePrices(kind, await refs()); }
      catch (err) { errs.push(`${kind}: ${String((err as Error)?.message ?? err)}`); }
    };
    if (deps.listServing) {
      let serving: { pools: string[]; deployments: string[] } | null = null;
      try { serving = await deps.listServing(); }
      catch (err) { errs.push(`serving: ${String((err as Error)?.message ?? err)}`); }
      if (serving) {
        await leg("pool", async () => serving.pools);
        await leg("deployment", async () => serving.deployments);
      }
    } else errs.push("serving: no kubestore access");
    await leg("external", () => deps.repo.listAllIds("external_deployments"));
    await leg("environment", () => deps.repo.listAllIds("environments"));
    sections.prices.rows = rows;
    if (errs.length) sections.prices.error = errs.join("; ");
  });
  // k8s sweep: DB ids load FIRST and any failure aborts before a single
  // delete (fail-closed — spec 2026-07-24 G3 safety rails).
  if (m.k8s.enabled) await guard(sections.k8s, async () => {
    if (!deps.sweepK8s) throw new Error("no k8s access");
    const [vaultIds, environmentIds, sessionIds] = await Promise.all([
      deps.repo.listAllIds("vaults"),
      deps.repo.listAllIds("environments"),
      deps.repo.listAllIds("sessions"),
    ]);
    const r = await deps.sweepK8s({ vaultIds, environmentIds, sessionIds, graceMs: GRACE_MS });
    sections.k8s.secrets = r.secrets;
    sections.k8s.egress = r.egress;
    sections.k8s.policies = r.policies;
    sections.k8s.pvcs = r.pvcs;
    if (r.errors.length) sections.k8s.error = r.errors.join("; ");
  });
  if (m.orphans.enabled) await guard(sections.orphans, async () => {
    const g = await runGc(deps.repo, deps.files, { now });
    sections.orphans.rows = g.rows;
    sections.orphans.objects = g.objects;
    sections.orphans.bytes = g.bytes;
  });

  const summary: MaintenanceSummary = { at: started.toISOString(), ms: now().getTime() - started.getTime(), sections };
  await deps.repo.setMaintenanceLastRun(summary).catch(() => {});
  return summary;
}

/** Minute tick against the settings cron. Returns a stop function. */
export function startMaintenanceScheduler(deps: MaintenanceDeps): () => void {
  let lastMinute = "";
  let running = false;
  const timer = setInterval(async () => {
    const now = new Date();
    const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}T${now.getHours()}:${now.getMinutes()}`;
    if (minute === lastMinute) return;
    lastMinute = minute;
    if (running) return;
    try {
      const { cron } = await deps.repo.getMaintenanceSettings();
      if (!cronMatches(cron, now)) return;
      running = true;
      const s = await runMaintenance(deps);
      console.log(`maintenance: ${JSON.stringify(s.sections)} in ${s.ms}ms`);
    } catch (err) {
      console.warn("maintenance sweep failed:", err);
    } finally {
      running = false;
    }
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
