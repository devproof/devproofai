"use client";
// Cost tracking & billing settings (spec 2026-07-14, amended 2026-07-15).
// Explicit Save — toggles gate BOTH accrual and cost UI platform-wide. Real
// costs and Billing are SIBLING sections, each with its own switch; Currency
// spans both. Every toggle row is [checkbox | name | hint] on one shared grid.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { submitJson } from "../lib/modal";
import { apiPost } from "../lib/client";
import { Icon } from "../lib/icons";
import { CURRENCY_LABELS, type CostSettings } from "../lib/currency";

function Row({ label, hint, checked, onChange }: {
  label: string; hint: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="setrow">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="setrow-name">{label}</span>
      <span className="setrow-hint">{hint}</span>
    </label>
  );
}

function Section({ title, note }: { title: string; note: string }) {
  return (
    <div className="setsection">
      <h3>{title}</h3>
      <p>{note}</p>
    </div>
  );
}

const fmtBytes = (b: number) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`;

type Unit = "hours" | "days";
export type MaintenanceSettings = {
  cron: string;
  orphans: { enabled: boolean };
  billing: { enabled: boolean; keep: number; unit: Unit };
  tokens: { enabled: boolean; keep: number; unit: Unit };
  sessions: { idle: { enabled: boolean; keep: number; unit: Unit }; completed: { enabled: boolean; keep: number; unit: Unit } };
  files: { input: { enabled: boolean; keep: number; unit: Unit }; output: { enabled: boolean; keep: number; unit: Unit } };
};
export type MaintenanceSummary = {
  at: string; ms: number;
  sections: {
    orphans: { ran: boolean; rows?: number; objects?: number; bytes?: number; error?: string };
    billing: { ran: boolean; rows?: number; error?: string };
    tokens: { ran: boolean; rows?: number; error?: string };
    sessions: { ran: boolean; idle?: number; completed?: number; error?: string };
    files: { ran: boolean; input?: number; output?: number; bytes?: number; error?: string };
  };
};

type RetentionForm = { enabled: boolean; keep: string; unit: Unit };
const toForm = (r: { enabled: boolean; keep: number; unit: Unit }): RetentionForm =>
  ({ enabled: r.enabled, keep: String(r.keep), unit: r.unit });

function RetRow({ label, hint, value, onChange }: {
  label: string; hint: string; value: RetentionForm; onChange: (v: RetentionForm) => void;
}) {
  // Only the checkbox + name live inside the <label> (display:contents keeps
  // them as grid items). The number/select must stay OUTSIDE it, or clicking
  // them toggles the label's checkbox and disables the row mid-edit.
  return (
    <div className="setrow">
      <label style={{ display: "contents" }}>
        <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
        <span className="setrow-name">{label}</span>
      </label>
      <span className="setrow-hint" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input value={value.keep} disabled={!value.enabled} style={{ width: 70, flex: "none" }}
               onChange={(e) => onChange({ ...value, keep: e.target.value })} />
        <select value={value.unit} disabled={!value.enabled} style={{ width: 90, flex: "none" }}
                onChange={(e) => onChange({ ...value, unit: e.target.value as Unit })}>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
        {hint}
      </span>
    </div>
  );
}

function sectionLines(s: MaintenanceSummary): [string, string][] {
  const sec = s.sections;
  const line = (x: { ran: boolean; error?: string }, ok: () => string) =>
    !x.ran ? "skipped (disabled)" : x.error ? `failed — ${x.error}` : ok();
  const half = (x: typeof sec.files, v: number | undefined, ok: (n: number) => string) =>
    x.error ? `failed — ${x.error}` : !x.ran || v === undefined ? "skipped (disabled)" : ok(v);
  return [
    ["Orphaned data", line(sec.orphans, () => `${sec.orphans.rows ?? 0} rows, ${sec.orphans.objects ?? 0} objects, ${fmtBytes(sec.orphans.bytes ?? 0)} reclaimed`)],
    ["Billing data", line(sec.billing, () => `${sec.billing.rows ?? 0} rows removed`)],
    ["Token usage", line(sec.tokens, () => `${sec.tokens.rows ?? 0} rows removed`)],
    ["Sessions", line(sec.sessions, () => `${sec.sessions.idle ?? 0} idle/failed, ${sec.sessions.completed ?? 0} completed deleted`)],
    ["Input files", half(sec.files, sec.files.input, (n) => `${n} files removed`)],
    ["Output files", half(sec.files, sec.files.output, (n) => `${n} files removed, ${fmtBytes(sec.files.bytes ?? 0)} reclaimed`)],
  ];
}

export function SettingsForm({ initial, initialLimits, initialMaintenance, initialAppearance, lastRun }: {
  initial: CostSettings; initialLimits: { maxWorkGb: number };
  initialMaintenance: MaintenanceSettings; initialAppearance: { theme: string };
  lastRun: MaintenanceSummary | null;
}) {
  const router = useRouter();
  const [c, setC] = useState<CostSettings>(initial);
  const [maxWorkGb, setMaxWorkGb] = useState(String(initialLimits?.maxWorkGb ?? 2048));
  const [theme, setTheme] = useState(initialAppearance?.theme ?? "system");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [cron, setCron] = useState(initialMaintenance.cron);
  const [orphans, setOrphans] = useState(initialMaintenance.orphans.enabled);
  const [billing, setBilling] = useState(toForm(initialMaintenance.billing));
  const [tokens, setTokens] = useState(toForm(initialMaintenance.tokens));
  const [idleS, setIdleS] = useState(toForm(initialMaintenance.sessions.idle));
  const [doneS, setDoneS] = useState(toForm(initialMaintenance.sessions.completed));
  const [inFiles, setInFiles] = useState(toForm(initialMaintenance.files.input));
  const [outFiles, setOutFiles] = useState(toForm(initialMaintenance.files.output));
  const [runBusy, setRunBusy] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [summary, setSummary] = useState<MaintenanceSummary | null>(lastRun);
  // Last-persisted maintenance config. "Run maintenance now" executes the
  // SAVED config (server-side), so the Run button is gated on this matching
  // the form — it re-enables only after a successful Save updates the baseline.
  const [savedMaint, setSavedMaint] = useState<MaintenanceSettings>(initialMaintenance);
  const set = (patch: Partial<CostSettings>) => setC({ ...c, ...patch });
  const setB = (patch: Partial<CostSettings["billing"]>) => setC({ ...c, billing: { ...c.billing, ...patch } });

  const retDirty = (r: RetentionForm, s: { enabled: boolean; keep: number; unit: Unit }) =>
    r.enabled !== s.enabled || r.unit !== s.unit || (Math.floor(Number(r.keep)) || 0) !== s.keep;
  const maintDirty =
    cron.trim() !== savedMaint.cron.trim() ||
    orphans !== savedMaint.orphans.enabled ||
    retDirty(billing, savedMaint.billing) ||
    retDirty(tokens, savedMaint.tokens) ||
    retDirty(idleS, savedMaint.sessions.idle) ||
    retDirty(doneS, savedMaint.sessions.completed) ||
    retDirty(inFiles, savedMaint.files.input) ||
    retDirty(outFiles, savedMaint.files.output);

  const save = async () => {
    setBusy(true); setMsg(null);
    const n = Math.floor(Number(maxWorkGb));
    if (!(n >= 1)) { setBusy(false); setMsg("Max session disk must be an integer ≥ 1."); return; }
    const fromForm = (label: string, r: RetentionForm) => {
      const k = Math.floor(Number(r.keep));
      // Only block the save on a bad value for a row that's actually enabled;
      // a disabled row's keep is inert, so coerce it to a valid 1 rather than
      // trap the user behind a per-row error for a cleanup they turned off.
      if (r.enabled && !(k >= 1)) throw new Error(`${label}: retention must be an integer ≥ 1.`);
      return { enabled: r.enabled, keep: k >= 1 ? k : 1, unit: r.unit };
    };
    let maintenance: MaintenanceSettings;
    try {
      maintenance = {
        cron: cron.trim(),
        orphans: { enabled: orphans },
        billing: fromForm("Billing", billing),
        tokens: fromForm("Token usage", tokens),
        sessions: { idle: fromForm("Idle sessions", idleS), completed: fromForm("Completed sessions", doneS) },
        files: { input: fromForm("Input files", inFiles), output: fromForm("Output files", outFiles) },
      };
    } catch (e) { setBusy(false); setMsg((e as Error).message); return; }
    const err = await submitJson("PUT", "/v1/settings", {
      costs: c, limits: { maxWorkGb: n }, maintenance, appearance: { theme },
    });
    setBusy(false);
    setMsg(err ?? "Saved.");
    if (!err) { setSavedMaint(maintenance); router.refresh(); }
  };

  const runNow = async () => {
    setRunBusy(true); setRunMsg(null);
    try {
      const res = await apiPost("/v1/maintenance/run", {});
      if (!res.ok) { setRunMsg(`Maintenance failed (${res.status})`); return; }
      setSummary(await res.json());
      router.refresh();
    } finally { setRunBusy(false); }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="setacc-group">
      <details className="setacc" open>
        <summary><Icon.coin />Cost tracking</summary>
        <div className="setpanel">
        <label className="setrow plain">
          <span />
          <span className="setrow-name">Currency</span>
          <span className="setrow-hint" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <select value={c.currency} onChange={(e) => set({ currency: e.target.value })}
                    style={{ width: 130, flex: "none" }}>
              {CURRENCY_LABELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            display label only — never converts amounts
          </span>
        </label>

        <Section title="Real costs" note="What the platform costs you — infrastructure and external tokens." />
        <Row label="Enable cost tracking" checked={c.enabled}
             hint="tracks what the platform costs you — off means no real cost accrues or is shown"
             onChange={(v) => set({ enabled: v })} />
        {c.enabled && (<>
          <Row label="Pool cost tracking" checked={c.trackPoolCosts}
               hint="price per running engine replica, set on each pool"
               onChange={(v) => set({ trackPoolCosts: v })} />
          <Row label="External deployment cost tracking" checked={c.trackExternalCosts}
               hint="provider token prices, set on each external deployment"
               onChange={(v) => set({ trackExternalCosts: v })} />
          <Row label="Environment cost tracking" checked={c.trackEnvCosts}
               hint="price per running session pod, set on each environment"
               onChange={(v) => set({ trackEnvCosts: v })} />
        </>)}

        <Section title="Billing" note="What consumers are charged — may exceed real costs." />
        <Row label="Enable billing" checked={c.billing.enabled}
             hint="master switch for all billing below"
             onChange={(v) => setB({ enabled: v })} />
        {c.billing.enabled && (<>
          <Row label="Show real-time costs in sessions" checked={c.billing.showSessionCosts}
               hint="billed-cost chip next to the token chip in the session header"
               onChange={(v) => setB({ showSessionCosts: v })} />
          <Row label="Session billing" checked={c.billing.billSessionTime}
               hint="time price on environments; turn-pod runtime, billed per started minute"
               onChange={(v) => setB({ billSessionTime: v })} />
          <Row label="External token billing" checked={c.billing.billExternalTokens}
               hint="token prices on external deployments"
               onChange={(v) => setB({ billExternalTokens: v })} />
          <Row label="Local token billing" checked={c.billing.billLocalTokens}
               hint="token prices on local deployments"
               onChange={(v) => setB({ billLocalTokens: v })} />
          <Row label="Time-based deployment billing" checked={c.billing.billDeploymentTime}
               hint="price per running replica on local deployments; sums with local token billing"
               onChange={(v) => setB({ billDeploymentTime: v })} />
        </>)}
        </div>
      </details>

      <details className="setacc" open>
        <summary><Icon.gauge />Limits</summary>
        <div className="setpanel">
          <label className="setrow plain">
            <span />
            <span className="setrow-name">Max session disk (GiB)</span>
            <span className="setrow-hint" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input value={maxWorkGb} onChange={(e) => setMaxWorkGb(e.target.value)}
                     style={{ width: 110, flex: "none" }} />
              ceiling for an environment&apos;s durable /work volume — default 2048
            </span>
          </label>
        </div>
      </details>

      <details className="setacc" open>
        <summary><Icon.wrench />Maintenance</summary>
        <div className="setpanel">
          <Section title="Schedule & cleanups" note="Configure what runs and when. Changes take effect only after you press “Save settings” at the bottom of the page." />
          <label className="setrow plain">
            <span />
            <span className="setrow-name">Maintenance schedule</span>
            <span className="setrow-hint" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input value={cron} onChange={(e) => setCron(e.target.value)}
                     style={{ width: 130, flex: "none", fontFamily: "var(--mono, monospace)" }} />
              5-field cron, server local time — default 0 1 * * * (daily 1:00)
            </span>
          </label>
          <Row label="Delete orphaned data" checked={orphans}
               hint="reclaims database rows and storage objects that escaped normal deletion — dead checkpoints, unreferenced skill/memory files, unclaimed objects"
               onChange={setOrphans} />
          <RetRow label="Clean up billing data" value={billing} onChange={setBilling}
                  hint="removes time-cost ledger entries older than this — cost history charts shrink accordingly" />
          <RetRow label="Clean up token usage" value={tokens} onChange={setTokens}
                  hint="removes gateway token metering older than this — Usage page history shrinks; session lifetime totals survive" />
          <RetRow label="Clean up idle & failed sessions" value={idleS} onChange={setIdleS}
                  hint="fully deletes sessions (events, checkpoints, work volume) with no activity for this long" />
          <RetRow label="Clean up completed sessions" value={doneS} onChange={setDoneS}
                  hint="fully deletes completed sessions this long after their last activity" />
          <RetRow label="Clean up input files" value={inFiles} onChange={setInFiles}
                  hint="uploads not attached to any session and last attached longer ago than this" />
          <RetRow label="Clean up output files" value={outFiles} onChange={setOutFiles}
                  hint="session outputs not attached to any session and last attached longer ago than this" />
          <Section title="Run" note="Runs the SAVED configuration above — not your unsaved edits. Press “Save settings” first, or the run uses the previously saved settings." />
          <label className="setrow plain">
            <span />
            <span className="setrow-name">Run now</span>
            <span className="setrow-hint" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" disabled={runBusy || maintDirty} onClick={runNow} style={{ flex: "none" }}>
                {runBusy ? "Running…" : "Run maintenance now"}
              </button>
              {maintDirty
                ? <span style={{ color: "var(--bad)" }}>⚠ Unsaved changes — press “Save settings” first.</span>
                : (runMsg ?? (summary
                  ? `Last run ${new Date(summary.at).toLocaleString()} — ${Object.values(summary.sections).some((x) => x.error) ? "completed with errors" : "completed successfully"}`
                  : "never run"))}
            </span>
          </label>
          {summary && sectionLines(summary).map(([label, text]) => (
            <label key={label} className="setrow plain">
              <span />
              <span className="setrow-name" style={{ fontWeight: 400 }}>{label}</span>
              <span className="setrow-hint">{text}</span>
            </label>
          ))}
        </div>
      </details>

      <details className="setacc" open>
        <summary><Icon.theme />Appearance</summary>
        <div className="setpanel">
          <label className="setrow plain">
            <span />
            <span className="setrow-name">Theme</span>
            <span className="setrow-hint" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <select value={theme} onChange={(e) => setTheme(e.target.value)}
                      style={{ width: 130, flex: "none" }}>
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
              System follows each viewer&apos;s operating system setting — applies to everyone using this console
            </span>
          </label>
        </div>
      </details>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 4 }}>
        <button disabled={busy} onClick={save}>{busy ? "Saving…" : "Save settings"}</button>
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>
    </div>
  );
}
