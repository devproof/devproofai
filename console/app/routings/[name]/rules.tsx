"use client";
// Rule editor (spec 2026-07-16). Local draft -> single PATCH on Save; rule
// edits apply live at the gateway (no restart), so no confirm dialog.
import { useState, type InputHTMLAttributes } from "react";
import { useRouter } from "next/navigation";
import { submitJson } from "../../lib/modal";

type Cond = any;
type Rule = { conditions: Cond[]; target: string };

const COND_DEFAULTS: Record<string, () => Cond> = {
  cost: () => ({ type: "cost", ledger: "billed", scope: "key", op: ">=", threshold: 50, window: { kind: "month" } }),
  tokens: () => ({ type: "tokens", scope: "key", op: ">=", threshold: 1000000, window: { kind: "month" } }),
  context: () => ({ type: "context", op: ">", tokens: 30000 }),
  available: () => ({ type: "available" }),
  time: () => ({ type: "time", from: "09:00", to: "18:00", tz: "Europe/Berlin" }),
  split: () => ({ type: "split", percent: 10 }),
  classify: () => ({ type: "classify", deployment: "", labels: { yes: "the request is about programming", no: "anything else" }, match: ["yes"] }),
};

// Consistent column widths so rows line up regardless of condition type
// (spec: fixed-width type select in column 1, shared widths per field kind).
const W = { type: 130, ledger: 100, scope: 150, op: 115, num: 90, window: 120, hours: 70,
  time: 64, tz: 130, days: 180, dep: 160, labels: 220, match: 140 };

// Every place a deployment/external endpoint target is picked on this page
// (a rule's "Route to" and the terminal's "route to a model") shares this
// width AND is pinned to the right edge of its card (marginLeft: auto in a
// `.row`) so both selects line up on the same column regardless of the
// label/action-select text before them.
const TARGET_STYLE = { width: 220, flex: "0 0 auto" as const };

// Muted context-window hint shown beside a target select (fix wave L
// addendum) — outside the fixed-width select so column alignment holds.
// Unknown target (deleted, or no known window) renders nothing.
function TargetWindow({ name, windowByTarget }: { name: string; windowByTarget: Record<string, number> }) {
  const w = windowByTarget[name];
  if (!w) return null;
  return <span className="muted" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>context window {w.toLocaleString()} tok</span>;
}

// Inputs whose value is re-derived from PARSED state (labels/match/days) eat
// typed spaces: every space is trailing the moment it's typed, the parser
// trims it, and the controlled re-render drops it. Keep the raw text as a
// draft while the field is focused; normalize back to the parsed form on blur.
function ParsedInput({ value, onText, ...rest }: { value: string; onText: (raw: string) => void }
  & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onBlur">) {
  const [draft, setDraft] = useState<string | null>(null);
  return <input {...rest} value={draft ?? value}
    onChange={(e) => { setDraft(e.target.value); onText(e.target.value); }}
    onBlur={() => setDraft(null)} />;
}

// A shared this-month/today/rolling window picker (cost + tokens conditions).
function WindowPicker({ c, set }: { c: Cond; set: (k: string, v: any) => void }) {
  return (<>
    <select value={c.window.kind} style={{ width: W.window }} onChange={(e) => set("window",
      e.target.value === "rolling" ? { kind: "rolling", hours: 24 } : { kind: e.target.value })}>
      <option value="month">this month</option><option value="day">today</option><option value="rolling">rolling</option>
    </select>
    {c.window.kind === "rolling" && <>
      <input type="number" style={{ width: W.hours }} value={c.window.hours}
        onChange={(e) => set("window", { kind: "rolling", hours: Number(e.target.value) })} />
      <span className="muted">hours</span>
    </>}
  </>);
}

function ScopeSelect({ c, set }: { c: Cond; set: (k: string, v: any) => void }) {
  return (
    <select value={c.scope} style={{ width: W.scope }} onChange={(e) => set("scope", e.target.value)}>
      <option value="key">api key</option>
      <option value="workspace">workspace</option>
      <option value="agent">agent</option>
      <option value="routing">routing</option>
      <option value="target">target deployment</option>
    </select>
  );
}

function CondEditor({ c, targets, cost, windowByTarget, onChange, onRemove }: {
  c: Cond; targets: string[]; cost: { enabled: boolean; billing: boolean }; windowByTarget: Record<string, number>;
  onChange: (c: Cond) => void; onRemove: () => void;
}) {
  const set = (k: string, v: any) => onChange({ ...c, [k]: v });
  // Type options gate on settings: "cost" is offered only when at least one
  // cost ledger is enabled — but an ALREADY-persisted cost condition keeps its
  // "cost" option so a disabled-ledger row still renders as itself, not the
  // first option (spec G2: don't hide data).
  const costAllowed = cost.enabled || cost.billing;
  const typeOpts = Object.keys(COND_DEFAULTS).filter((t) => t !== "cost" || costAllowed || c.type === "cost");
  // Ledger options within a cost row: only enabled ledgers, plus the row's own
  // current value so a disabled-ledger condition still shows its real ledger.
  const enabledLedgers = [cost.billing && "billed", cost.enabled && "real"].filter(Boolean) as string[];
  const ledgerOpts = c.type === "cost" && !enabledLedgers.includes(c.ledger)
    ? [c.ledger, ...enabledLedgers] : enabledLedgers;
  const ledgerDisabled = c.type === "cost"
    && ((c.ledger === "billed" && !cost.billing) || (c.ledger === "real" && !cost.enabled));
  return (
    <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <select value={c.type} style={{ width: W.type }} onChange={(e) => onChange(COND_DEFAULTS[e.target.value]())}>
        {typeOpts.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      {c.type === "cost" && <>
        <select value={c.ledger} style={{ width: W.ledger }} onChange={(e) => set("ledger", e.target.value)}>
          {ledgerOpts.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <ScopeSelect c={c} set={set} />
        <select value={c.op} style={{ width: W.op }} onChange={(e) => set("op", e.target.value)}>
          <option value=">=">spent ≥</option><option value="<">spent &lt;</option>
        </select>
        <input type="number" style={{ width: W.num }} value={c.threshold}
          onChange={(e) => set("threshold", Number(e.target.value))} />
        <WindowPicker c={c} set={set} />
        {ledgerDisabled && <span style={{ color: "var(--bad)", fontSize: 12 }}>
          {c.ledger === "billed" ? "billing disabled — this condition never matches"
            : "cost tracking disabled — this condition never matches"}
        </span>}
      </>}
      {c.type === "tokens" && <>
        <ScopeSelect c={c} set={set} />
        <select value={c.op} style={{ width: W.op }} onChange={(e) => set("op", e.target.value)}>
          <option value=">=">used ≥</option><option value="<">used &lt;</option>
        </select>
        <input type="number" style={{ width: W.num }} value={c.threshold}
          onChange={(e) => set("threshold", Number(e.target.value))} />
        <span className="muted">tokens</span>
        <WindowPicker c={c} set={set} />
      </>}
      {c.type === "context" && <>
        <select value={c.op} style={{ width: W.op }} onChange={(e) => set("op", e.target.value)}>
          <option value=">">prompt &gt;</option><option value="<=">prompt ≤</option>
        </select>
        <input type="number" style={{ width: W.num }} value={c.tokens} onChange={(e) => set("tokens", Number(e.target.value))} />
        <span className="muted">est. tokens</span>
      </>}
      {c.type === "available" && <span className="muted">the rule's deployment is servable (Ready/Idle or external endpoint)</span>}
      {c.type === "time" && <>
        <input style={{ width: W.time }} value={c.from} onChange={(e) => set("from", e.target.value)} placeholder="09:00" />
        <span className="muted">–</span>
        <input style={{ width: W.time }} value={c.to} onChange={(e) => set("to", e.target.value)} placeholder="18:00" />
        <input style={{ width: W.tz }} value={c.tz} onChange={(e) => set("tz", e.target.value)} placeholder="Europe/Berlin" />
        <ParsedInput style={{ width: W.days }} value={(c.days ?? []).join(",")} placeholder="days e.g. mon,tue (empty = all)"
          onText={(raw) => set("days", raw ? raw.split(",").map((s) => s.trim()) : undefined)} />
      </>}
      {c.type === "split" && <>
        <input type="number" style={{ width: W.num }} value={c.percent} onChange={(e) => set("percent", Number(e.target.value))} />
        <span className="muted">% of requests</span>
      </>}
      {c.type === "classify" && <>
        <TargetWindow name={c.deployment} windowByTarget={windowByTarget} />
        <select value={c.deployment} style={{ width: W.dep }} onChange={(e) => set("deployment", e.target.value)}>
          <option value="">classifier…</option>
          {targets.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <ParsedInput style={{ width: W.labels }} value={Object.entries(c.labels).map(([k, v]) => `${k}=${v}`).join("; ")}
          placeholder="label=description; label=description"
          onText={(raw) => set("labels", Object.fromEntries(raw.split(";")
            .map((p) => p.split("=")).filter((p) => p[0]?.trim())
            .map(([k, ...v]) => [k.trim(), v.join("=").trim()])))} />
        <ParsedInput style={{ width: W.match }} value={(c.match ?? []).join(",")} placeholder="match labels"
          onText={(raw) => set("match", raw.split(",").map((s) => s.trim()).filter(Boolean))} />
      </>}
      <button className="iconbtn" style={{ marginLeft: "auto" }} title="Remove condition" aria-label="Remove condition" onClick={onRemove}>✕</button>
    </div>
  );
}

export function RulesTab({ routing, targets, cost, windowByTarget, minContextTokens }: {
  routing: any; targets: string[]; cost: { enabled: boolean; billing: boolean };
  windowByTarget: Record<string, number>; minContextTokens: number | null;
}) {
  const router = useRouter();
  const [rules, setRules] = useState<Rule[]>(routing.rules ?? []);
  const [terminal, setTerminal] = useState<any>(routing.terminal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const setRule = (i: number, r: Rule) => setRules(rules.map((x, j) => (j === i ? r : x)));
  // A rule/terminal may still reference a deployment or external endpoint
  // that's since been deleted (spec: deletion is allowed, the target just
  // evaluates as unavailable) — without this, a <select> whose value has no
  // matching <option> silently falls back to displaying the FIRST option,
  // showing a different, wrong target than what's actually stored (the bug
  // reported live: list page and this selector disagreed on the same routing).
  const optionsFor = (current: string) => (current && !targets.includes(current) ? [current, ...targets] : targets);
  const move = (i: number, d: number) => {
    const next = [...rules];
    const [r] = next.splice(i, 1);
    next.splice(i + d, 0, r);
    setRules(next);
  };
  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    const err = await submitJson("PATCH", `/v1/routings/${encodeURIComponent(routing.name)}`, { rules, terminal });
    setBusy(false);
    if (err) return setError(err);
    setSaved(true);
    router.refresh();
  };
  // Live min over the DRAFT's route targets (rules + route terminal) —
  // mirrors the server's minContextTokens but updates as dropdowns change,
  // before saving. Falls back to the server value when nothing is known.
  const draftWindows = [...rules.map((r) => r.target),
    ...(terminal?.action === "route" ? [terminal.target] : [])]
    .map((t) => windowByTarget[t]).filter((w): w is number => !!w);
  const liveMinWindow = draftWindows.length ? Math.min(...draftWindows) : minContextTokens;
  return (
    <>
      <p className="sub" style={{ marginTop: 0 }}>
        Rules are evaluated top-down; the first rule whose conditions ALL match routes the request.
        Classifier hint: prefer a small non-reasoning deployment — reasoning models think for seconds
        before answering the label.
      </p>
      {liveMinWindow != null && (
        <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>
          min context window: {liveMinWindow.toLocaleString()} tokens — drives session auto-compaction
        </p>
      )}
      {rules.map((r, i) => (
        <div key={i} className="card" style={{ marginBottom: 10 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3>Rule {i + 1}</h3>
            <span>
              <button className="iconbtn" title="Move up" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button className="iconbtn" title="Move down" aria-label="Move down" disabled={i === rules.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button className="iconbtn" title="Remove rule" aria-label="Remove rule" onClick={() => setRules(rules.filter((_, j) => j !== i))}>✕</button>
            </span>
          </div>
          {r.conditions.map((c, j) => (
            <div key={j}>
              {j > 0 && <div className="muted" style={{ paddingLeft: 8, fontSize: 11, margin: "2px 0" }}>AND</div>}
              <CondEditor c={c} targets={targets} cost={cost} windowByTarget={windowByTarget}
                onChange={(nc) => setRule(i, { ...r, conditions: r.conditions.map((x, k) => (k === j ? nc : x)) })}
                onRemove={() => setRule(i, { ...r, conditions: r.conditions.filter((_, k) => k !== j) })} />
            </div>
          ))}
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            <button className="ghost" onClick={() => setRule(i, { ...r, conditions: [...r.conditions, COND_DEFAULTS.context()] })}>
              + condition
            </button>
            {r.conditions.length === 0 && <span className="muted">no conditions — always matches</span>}
            {r.conditions.length > 1 && <span className="muted">all conditions must match</span>}
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="field-label">Route to<em> *</em></span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
              <TargetWindow name={r.target} windowByTarget={windowByTarget} />
              <select value={r.target} style={TARGET_STYLE} onChange={(e) => setRule(i, { ...r, target: e.target.value })}>
                {optionsFor(r.target).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </span>
          </div>
        </div>
      ))}
      <button className="ghost" style={{ marginBottom: 14 }}
        onClick={() => setRules([...rules, { conditions: [], target: targets[0] ?? "" }])}>+ Add rule</button>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>No match</h3>
        <div className="row" style={{ gap: 8 }}>
          <select value={terminal?.action} onChange={(e) => setTerminal(
            e.target.value === "route" ? { action: "route", target: targets[0] ?? "" } : { action: "reject" })}>
            <option value="route">route to a model</option>
            <option value="reject">reject (403)</option>
          </select>
          {terminal?.action === "route" && (
            <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
              <TargetWindow name={terminal.target} windowByTarget={windowByTarget} />
              <select value={terminal.target} style={TARGET_STYLE} onChange={(e) => setTerminal({ action: "route", target: e.target.value })}>
                {optionsFor(terminal.target).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </span>
          )}
        </div>
      </div>
      {error && <div className="modal-error" role="alert">{error}</div>}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button disabled={busy} onClick={save}>{busy ? <span className="spin" /> : "Save rules"}</button>
        {saved && <span className="muted" style={{ fontSize: 12 }}>saved — live at the gateway within ~2s</span>}
      </div>
    </>
  );
}
