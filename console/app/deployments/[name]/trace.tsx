"use client";
// Live trace window (spec 2026-07-10): ephemeral — capture exists only while
// this component is mounted (the SSE connection maintains the gateway-side
// subscription). Nothing is stored; refresh = empty window.
import { useEffect, useRef, useState } from "react";
import { presetLocale } from "../../lib/datetime";

interface TraceEvent {
  id: string; kind: "request" | "response" | "error"; deployment: string; ts: string;
  source: "api" | "session"; api_key_id?: string; agent_id?: string; session_id?: string;
  messages?: { role: string; preview: string; length: number }[];
  system?: { preview: string; length: number };
  tool_count?: number; tool_names?: string[]; tokens_in?: number; tokens_out?: number; duration_ms?: number;
  preview?: string; length?: number; error?: string; seq?: number;
  routing?: string; target?: string; rule?: number;
  rejected?: boolean; unavailable?: boolean;
  evaluation?: { rule: number; target: string; verdict: string;
    conditions: { type: string; value: unknown; ok: boolean; cond?: any }[] }[];
}

// Evaluated condition value -> dense text: strings quoted, null shown as ∅.
const fmtVal = (v: unknown) =>
  v === null || v === undefined ? "∅" : typeof v === "string" ? `"${v}"` : String(v);

// D3a precedent: "key" cost scope displays as "api key" everywhere.
const scopeLabel = (s: string) => (s === "key" ? "api key" : s);

// A disabled-ledger cost condition evaluates to a "skipped: <why>" string
// (fix wave G). Rendering it behind "spent" reads wrong ("spent skipped:
// billing disabled") — show just the reason, muted, with no metric prefix.
const skipText = (v: unknown): string | null =>
  typeof v === "string" && v.startsWith("skipped:") ? v.replace(/^skipped:\s*/, "") : null;

// Full configured condition + evaluated value -> one readable line. Falls
// back to the bare type/value/ok when `cond` is missing (older events,
// captured before the gateway started including it).
function condLine(c: { type: string; value: unknown; ok: boolean; cond?: any }): React.ReactNode {
  const mark = c.ok ? "✓" : "✗";
  const cond = c.cond;
  if (!cond) return `${c.type} ${fmtVal(c.value)} ${mark}`;
  const skip = skipText(c.value);
  switch (c.type) {
    case "cost": {
      const op = cond.op === ">=" ? "≥" : cond.op;
      const win = cond.window?.kind === "rolling" ? `rolling ${cond.window.hours}h`
        : cond.window?.kind === "day" ? "today" : "this month";
      const head = `cost · ${cond.ledger} · ${scopeLabel(cond.scope)} · ${op} ${cond.threshold} (${win})`;
      return skip
        ? <>{head} — <span className="muted">{skip}</span> {mark}</>
        : `${head} — spent ${fmtVal(c.value)} ${mark}`;
    }
    case "tokens": {
      const op = cond.op === ">=" ? "≥" : cond.op;
      const win = cond.window?.kind === "rolling" ? `rolling ${cond.window.hours}h`
        : cond.window?.kind === "day" ? "today" : "this month";
      const head = `tokens · ${scopeLabel(cond.scope)} · ${op} ${cond.threshold} (${win})`;
      return skip
        ? <>{head} — <span className="muted">{skip}</span> {mark}</>
        : `${head} — used ${fmtVal(c.value)} ${mark}`;
    }
    case "context": {
      const op = cond.op === "<=" ? "≤" : cond.op;
      return `context · ${op} ${cond.tokens} — est. ${fmtVal(c.value)} ${mark}`;
    }
    case "available":
      return `available — ${fmtVal(c.value)} ${mark}`;
    case "time": {
      const days = cond.days?.length ? ` ${cond.days.join(",")}` : "";
      return `time · ${cond.from}–${cond.to} ${cond.tz}${days} — ${fmtVal(c.value)} ${mark}`;
    }
    case "split":
      return `split · ${cond.percent}% — rolled ${fmtVal(c.value)} ${mark}`;
    case "classify":
      return `classify via ${cond.deployment} · match [${(cond.match ?? []).join(",")}] — got ${fmtVal(c.value)} ${mark}`;
    default:
      return `${c.type} ${fmtVal(c.value)} ${mark}`;
  }
}

// SDK MCP naming: mcp__<server>__<tool>. Group those per server; everything
// else is a built-in/platform tool.
function groupTools(names: string[]) {
  const builtin: string[] = [];
  const mcp = new Map<string, string[]>();
  for (const n of names) {
    if (n.startsWith("mcp__")) {
      const rest = n.slice(5);
      const i = rest.indexOf("__");
      const server = i === -1 ? rest : rest.slice(0, i);
      const tool = i === -1 ? rest : rest.slice(i + 2);
      if (!mcp.has(server)) mcp.set(server, []);
      mcp.get(server)!.push(tool);
    } else builtin.push(n);
  }
  return { builtin, mcp };
}

const CAP = 200;   // newest-first, oldest dropped

export function TraceTab({ name, keys, agents, basePath = "/v1/deployments" }:
  { name: string; keys: { id: string; name: string }[]; agents: { id: string; name: string }[]; basePath?: string }) {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [live, setLive] = useState(false);
  const [filter, setFilter] = useState("");
  const [buffered, setBuffered] = useState(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const bufferRef = useRef<TraceEvent[]>([]);
  const seqRef = useRef(0);
  const [evalOpen, setEvalOpen] = useState<Set<number>>(new Set());
  const toggleEval = (seq: number) => setEvalOpen((prev) => {
    const next = new Set(prev);
    if (next.has(seq)) next.delete(seq); else next.add(seq);
    return next;
  });
  const [toolsOpen, setToolsOpen] = useState<Set<number>>(new Set());
  const toggleTools = (seq: number) => setToolsOpen((prev) => {
    const next = new Set(prev);
    if (next.has(seq)) next.delete(seq); else next.add(seq);
    return next;
  });

  useEffect(() => {
    const es = new EventSource(`/api${basePath}/${encodeURIComponent(name)}/trace/stream`);
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);   // EventSource auto-reconnects
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as TraceEvent;
        e.seq = ++seqRef.current;
        if (pausedRef.current) { bufferRef.current.push(e); setBuffered(bufferRef.current.length); return; }
        setEvents((prev) => [e, ...prev].slice(0, CAP));
      } catch { /* keep-alive or malformed frame */ }
    };
    return () => { es.close(); setLive(false); };
  }, [name, basePath]);

  function resume() {
    // Capture before enqueueing: the setEvents updater runs at render time,
    // after this handler has already reset the buffer.
    const flushed = [...bufferRef.current].reverse();
    bufferRef.current = [];
    setPaused(false);
    setBuffered(0);
    setEvents((prev) => [...flushed, ...prev].slice(0, CAP));
  }
  const who = (e: TraceEvent) =>
    e.source === "session"
      ? `agent: ${agents.find((a) => a.id === e.agent_id)?.name ?? e.agent_id ?? "session"}`
      : `api key: ${keys.find((k) => k.id === e.api_key_id)?.name ?? e.api_key_id ?? "api"}`;
  const visible = filter
    ? events.filter((e) => JSON.stringify(e).toLowerCase().includes(filter.toLowerCase()))
    : events;

  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <span className={`livedot ${live ? "on" : ""}`} title={live ? "capturing" : "reconnecting…"} />
        <span className="muted" style={{ fontSize: 12 }}>
          Capturing while this tab is open — nothing is stored.
        </span>
        <input type="search" placeholder="Filter…" value={filter}
          onChange={(e) => setFilter(e.target.value)} style={{ width: 180, marginLeft: "auto" }} />
        {paused
          ? <button onClick={resume}>Resume ({buffered})</button>
          : <button className="ghost" onClick={() => setPaused(true)}>Pause</button>}
        <button className="ghost" onClick={() => { setEvents([]); bufferRef.current = []; setBuffered(0); }}>Clear</button>
      </div>

      {visible.length === 0 && <div className="empty">Waiting for traffic to {name}…</div>}
      {visible.map((e) => (
        <div key={e.seq} className={`trace-card${e.kind === "error" ? " err" : ""}`}>
          <div className="trace-head">
            <span className={`chip ${e.kind}`}>{e.kind}</span>
            <span className="chip">{who(e)}</span>
            {e.kind === "response" && <span className="chip">{e.tokens_in}/{e.tokens_out} tok · {((e.duration_ms ?? 0) / 1000).toFixed(1)}s</span>}
            {e.kind === "request" && ((e.tool_names?.length ?? 0) > 0
              ? <button type="button" className="chip" style={{ cursor: "pointer" }}
                  aria-expanded={toolsOpen.has(e.seq!)}
                  onClick={() => toggleTools(e.seq!)}>
                  {e.messages?.length ?? 0} msg · {e.tool_count} tools
                </button>
              : <span className="chip">{e.messages?.length ?? 0} msg · {e.tool_count} tools</span>)}
            {e.kind === "request" && e.rejected && <span className="chip error">rejected</span>}
            {e.kind === "request" && e.unavailable && <span className="chip error">unavailable</span>}
            {e.kind === "request" && e.target && (
              <button type="button" className="chip" style={{ cursor: "pointer" }}
                aria-expanded={evalOpen.has(e.seq!)}
                onClick={() => toggleEval(e.seq!)}>
                {e.target}{typeof e.rule === "number" && e.rule >= 0 ? ` · rule ${e.rule + 1}` : e.rule === -1 ? " · default" : ""}
              </button>
            )}
            <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>{new Date(e.ts).toLocaleTimeString(presetLocale())}</span>
          </div>
          {e.kind === "request" && (e.tool_names?.length ?? 0) > 0 && toolsOpen.has(e.seq!) && (() => {
            const { builtin, mcp } = groupTools(e.tool_names!);
            return (
              <div className="trace-msg">
                <pre className="block" style={{ maxHeight: 260, whiteSpace: "normal" }}>
                  {builtin.length > 0 && (
                    <div style={{ marginBottom: 5 }}>
                      Tools ({builtin.length})
                      {builtin.map((t, k) => <span key={k} className="chip" style={{ marginLeft: 6 }}>{t}</span>)}
                    </div>
                  )}
                  {[...mcp.entries()].map(([server, tools]) => (
                    <div key={server} style={{ marginBottom: 5 }}>
                      MCP {server} ({tools.length})
                      {tools.map((t, k) => <span key={k} className="chip" style={{ marginLeft: 6 }}>{t}</span>)}
                    </div>
                  ))}
                </pre>
              </div>
            );
          })()}
          {/* Routed chip case: render whenever open, even with an empty rule
              table (rules deleted since) — the terminal line still explains
              the verdict; a click must never silently do nothing. */}
          {e.kind === "request" && e.evaluation && (
            e.target ? (
              evalOpen.has(e.seq!) && (
                <div className="trace-msg">
                  <pre className="block" style={{ maxHeight: 260, whiteSpace: "normal" }}>
                    {e.evaluation.map((rv, j) => (
                      <div key={j} style={{ marginBottom: 5 }}>
                        Rule {rv.rule + 1} → {rv.target} — {rv.verdict}
                        {rv.conditions.map((c, k) => (
                          <span key={k} className="chip" style={{ marginLeft: 6 }}>
                            {condLine(c)}
                          </span>
                        ))}
                      </div>
                    ))}
                    {e.rule === -1 && (
                      <div className="muted">terminal → {e.target ?? "reject"}</div>
                    )}
                  </pre>
                </div>
              )
            ) : (
              e.evaluation.length > 0 &&
              <details className="trace-msg">
                <summary><code>rule evaluation</code> <span className="muted">· {e.evaluation.length} rule{e.evaluation.length === 1 ? "" : "s"} visited</span></summary>
                <pre className="block" style={{ maxHeight: 260, whiteSpace: "normal" }}>
                  {e.evaluation.map((rv, j) => (
                    <div key={j} style={{ marginBottom: 5 }}>
                      Rule {rv.rule + 1} → {rv.target} — {rv.verdict}
                      {rv.conditions.map((c, k) => (
                        <span key={k} className="chip" style={{ marginLeft: 6 }}>
                          {condLine(c)}
                        </span>
                      ))}
                    </div>
                  ))}
                  {e.rule === -1 && (
                    <div className="muted">terminal → {e.target ?? "reject"}</div>
                  )}
                </pre>
              </details>
            )
          )}
          {e.kind === "request" && e.system && (
            <details className="trace-msg">
              <summary><code>system</code> <span className="muted">{e.system.length.toLocaleString()} chars{e.system.length > e.system.preview.length ? " (truncated)" : ""}</span></summary>
              <pre className="block" style={{ maxHeight: 260 }}>{e.system.preview}</pre>
            </details>
          )}
          {e.kind === "request" && e.messages?.map((m, j) => (
            <details key={j} className="trace-msg">
              <summary><code>{m.role}</code> <span className="muted">{m.length.toLocaleString()} chars{m.length > m.preview.length ? " (truncated)" : ""}</span></summary>
              <pre className="block" style={{ maxHeight: 260 }}>{m.preview}</pre>
            </details>
          ))}
          {e.kind === "response" && (
            <details className="trace-msg" open={(e.length ?? 0) < 600}>
              <summary><code>assistant</code> <span className="muted">{(e.length ?? 0).toLocaleString()} chars{(e.length ?? 0) > (e.preview?.length ?? 0) ? " (truncated)" : ""}</span></summary>
              <pre className="block" style={{ maxHeight: 260 }}>{e.preview}</pre>
            </details>
          )}
          {e.kind === "error" && <pre className="block block-error" style={{ maxHeight: 200 }}>{e.error}</pre>}
        </div>
      ))}
    </>
  );
}
