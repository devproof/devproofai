"use client";
// Compact screenshot-style transcript rows + raw Debug list.
import { useEffect, useState } from "react";
import type { LiveEvent } from "./use-session-live";
import { type Row, rowText, offsetLabel, parseMcpTool, CHIP } from "./rows";

export type EventFilter = "all" | "agent" | "thinking" | "tool" | "error";

/** What the session is doing right now (null when not live). `pending` means
 *  a tool call is executing — highlight its row instead of adding one. */
export interface Activity { pending: boolean; label: string; since: string; }

export function filterRows(rows: Row[], filter: EventFilter, search: string): Row[] {
  const q = search.trim().toLowerCase();
  return rows.filter((r) => {
    // System lifecycle rows live in the Debug tab only — except errors,
    // which must never be hidden from the transcript.
    if (r.kind === "system" && !r.error) return false;
    if (filter === "agent" && !(r.kind === "agent" || r.kind === "user")) return false;
    if (filter === "thinking" && r.kind !== "thinking") return false;
    if (filter === "tool" && r.kind !== "tool" && r.kind !== "skill" && r.kind !== "subagent") return false;
    if (filter === "error" && !r.error) return false;
    if (q && !rowText(r).includes(q)) return false;
    return true;
  });
}

/** Live m:ss counter — makes it visible that the current item is still going. */
function Elapsed({ since }: { since: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  return <span className="trow-elapsed">{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}

function ActivityRow({ activity, chip }: { activity: Activity; chip: string }) {
  return (
    <div className="trow activity">
      <span className={`trow-chip ${chip}`}>{chip === "agent" ? "Agent" : "Sys"}</span>
      <span className="trow-title"><span className="muted">{activity.label}</span></span>
      <span className="trow-meta"><Elapsed since={activity.since} /></span>
    </div>
  );
}

// MCP tool rows (`mcp__<server>__<tool>`, optionally " ×N" for a collapsed
// group) swap the generic "Tool" chip for an "MCP" one and show server +
// tool name instead of the raw SDK string (kept as a title tooltip).
function parseMcpTitle(title: string) {
  const m = /^(.*) (×\d+)$/.exec(title);
  const mcp = parseMcpTool(m ? m[1] : title);
  return mcp ? { ...mcp, suffix: m ? ` ${m[2]}` : "" } : null;
}

export function Transcript({ rows, selectedSeq, onSelect, activity }: {
  rows: Row[]; selectedSeq: number | null; onSelect: (seq: number) => void;
  activity: Activity | null;
}) {
  if (!rows.length && !activity) return <div className="empty">Waiting for the first event…</div>;
  return (
    <div className="trows">
      {rows.map((r) => {
        const active = !!activity?.pending && !!r.pending;
        const mcp = r.kind === "tool" && r.title ? parseMcpTitle(r.title) : null;
        return (
          <div key={r.seq} className={`trow ${r.kind} ${active ? "active" : ""} ${selectedSeq === r.seq ? "sel" : ""}`}
               onClick={() => onSelect(r.seq)}>
            <span className={`trow-chip ${mcp ? "mcp" : r.kind}`}>{mcp ? "MCP" : CHIP[r.kind]}</span>
            <span className="trow-title">
              {mcp
                ? <span title={r.title}>
                    <span className="mcp-server">{mcp.server}</span>
                    <span className="mcp-tool">{mcp.tool}</span>{mcp.suffix}
                  </span>
                : r.title || <span className="muted">—</span>}
              {r.preview && <span className="trow-preview"> {r.preview}</span>}
            </span>
            <span className="trow-meta">
              {r.error && <span className="phase bad">Error</span>}
              {(r.tokensIn > 0 || r.tokensOut > 0) && <span>{r.tokensIn.toLocaleString()}/{r.tokensOut.toLocaleString()}</span>}
              {active
                ? <Elapsed since={activity!.since} />
                : r.durationMs > 0 && <span>{(r.durationMs / 1000).toFixed(1)}s</span>}
              <span className="muted">{offsetLabel(r.offsetMs)}</span>
            </span>
          </div>
        );
      })}
      {activity && !activity.pending && <ActivityRow activity={activity} chip="agent" />}
    </div>
  );
}

export function DebugList({ events, search, selectedSeq, onSelect, activity }: {
  events: LiveEvent[]; search: string; selectedSeq: number | null; onSelect: (seq: number) => void;
  activity: Activity | null;
}) {
  const q = search.trim().toLowerCase();
  const list = q
    ? events.filter((e) => (e.type + " " + JSON.stringify(e.payload ?? {})).toLowerCase().includes(q))
    : events;
  return (
    <div className="trows">
      {list.map((e) => (
        <div key={e.seq} className={`trow system ${selectedSeq === e.seq ? "sel" : ""}`} onClick={() => onSelect(e.seq)}>
          <span className="trow-chip system">{e.seq}</span>
          <span className="trow-title"><code>{e.type}</code>
            <span className="trow-preview"> {JSON.stringify(e.payload ?? {}).slice(0, 160)}</span></span>
          <span className="trow-meta"><span className="muted">{offsetLabel(e.duration_ms)}</span></span>
        </div>
      ))}
      {activity && <ActivityRow activity={activity} chip="system" />}
      {list.length === 0 && !activity && <div className="empty">No events match.</div>}
    </div>
  );
}
