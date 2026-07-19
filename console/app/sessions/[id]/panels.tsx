"use client";
// Right slide-over sheets: agent / environment / files / outputs / event detail.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { wsHeader } from "../../lib/client";
import { Lightbox } from "../../lib/lightbox";
import { Markdown, type MdImage } from "../../lib/markdown";
import { useTopEscape } from "../../lib/modal";
import { parseMcpTool, CHIP, type Row } from "./rows";

const fmtSize = (n: number) =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

// `title` is optional: the transcript event sheet carries everything in one
// meta line (badge + counts) — its old headline just repeated the message body.
export function SideSheet({ title, subtitle, onClose, children }: {
  title?: React.ReactNode; subtitle?: React.ReactNode; onClose: () => void; children: React.ReactNode;
}) {
  useTopEscape(onClose);   // stack-aware: a lightbox above the sheet wins Escape
  // Drag the left edge to resize. The width sticks only for the session page
  // it was set on (sessionStorage keyed by path) — a new session opens at the
  // 480px default.
  const wkey = () => `devproof.sheetWidth:${location.pathname}`;
  const [width, setWidth] = useState<number>(() =>
    Number(typeof window !== "undefined" && sessionStorage.getItem(wkey())) || 480);
  const widthRef = useRef(width);
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      const w = Math.round(Math.min(Math.max(window.innerWidth - ev.clientX, 360), window.innerWidth * 0.92));
      widthRef.current = w; setWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      sessionStorage.setItem(wkey(), String(widthRef.current));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
  return (
    <aside className="sheet" style={{ width }}>
      <div className="sheet-resize" title="Drag to resize" onPointerDown={startResize} />
      <div className="sheet-head">
        <div>
          {title && <h2 className="sheet-title">{title}</h2>}
          {subtitle && <div className="sub" style={{ margin: title ? "2px 0 0" : 0 }}>{subtitle}</div>}
        </div>
        <button className="iconbtn" title="Close" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="sheet-body">{children}</div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (<div className="sheet-sec"><h3>{title}</h3>{children}</div>);
}

export function AgentPanel({ resources, onClose }: { resources: any; onClose: () => void }) {
  const a = resources?.agent;
  const mcp = resources?.mcpServers ? Object.keys(resources.mcpServers) : [];
  // Routing min context window (drives session auto-compaction) — fetched
  // lazily when the sheet opens; deleted routing → null → dash.
  const [ctxWindow, setCtxWindow] = useState<number | null>(null);
  useEffect(() => {
    if (!resources?.routing) return;
    let stale = false;
    fetch(`/api/v1/routings/${encodeURIComponent(resources.routing)}`, { headers: wsHeader() })
      .then((r) => (r.ok ? r.json() : null))
      .then((r) => { if (!stale) setCtxWindow(r?.minContextTokens ?? null); })
      .catch(() => { /* dash */ });
    return () => { stale = true; };
  }, [resources?.routing]);
  return (
    <SideSheet onClose={onClose}
      title={<>{a?.name} <span className="chip">v{a?.version}</span></>}
      subtitle={<><code>{a?.id}</code> · <Link className="linkbtn" href={`/agents/${a?.id}`}>Go to agent →</Link></>}>
      <Section title="Routing"><code>{resources?.routing ?? "—"}</code></Section>
      <Section title="System prompt">
        <pre className="block" style={{ maxHeight: 320 }}>{a?.systemPrompt || "—"}</pre>
      </Section>
      <Section title="Limits">
        <div>max turns {a?.maxTurns ?? "—"}</div>
        {ctxWindow != null && <div>ctx {ctxWindow.toLocaleString()} tok</div>}
      </Section>
      <Section title={`Tools (${resources?.tools?.length ?? 0})`}>
        {resources?.tools?.length
          ? resources.tools.map((t: string) => <span key={t} className="tool">{t}</span>)
          : <span className="muted">none</span>}
        {mcp.length > 0 && <div style={{ marginTop: 6 }}>{mcp.map((m) => <span key={m} className="pill">mcp: {m}</span>)}</div>}
      </Section>
      <Section title={`Skills (${resources?.skills?.length ?? 0})`}>
        {resources?.skills?.length
          ? resources.skills.map((s: any) => <span key={s.id} className="tool">{s.name}</span>)
          : <span className="muted">none</span>}
      </Section>
      {resources?.subagents?.length > 0 && (
        <Section title={`Subagents (${resources.subagents.length})`}>
          {resources.subagents.map((s: any) => (
            <div key={s.agentId} style={{ marginBottom: 10 }}>
              <div>
                {s.name}{" "}
                <Link className="linkbtn" href={`/agents/${s.agentId}`}><code>{s.agentId}</code></Link>
              </div>
              <div className="muted">{s.instructions}</div>
            </div>
          ))}
        </Section>
      )}
    </SideSheet>
  );
}

export function EnvPanel({ resources, onClose }: { resources: any; onClose: () => void }) {
  const env = resources?.environment;
  return (
    <SideSheet onClose={onClose} title={env?.name ?? "Default environment"}
      subtitle={env && <><code>{env.id}</code> · <Link className="linkbtn" href="/environments">Go to environments →</Link></>}>
      <Section title="Networking">
        <div className="row"><span className="muted">Type</span><span>{env ? "Limited" : "No environment — all outbound blocked"}</span></div>
        <div className="row"><span className="muted">Packages</span><span>{env?.allow_package_managers ? "Enabled" : "Disabled"}</span></div>
        <div style={{ marginTop: 6 }}>
          {env?.allowed_hosts?.includes("*")
            ? <span className="phase Ready">all allowed</span>
            : env?.allowed_hosts?.length
              ? env.allowed_hosts.map((h: string) => <span key={h} className="chip" style={{ marginRight: 6, marginBottom: 4 }}><code>{h}</code></span>)
              : <span className="muted">all outbound blocked</span>}
        </div>
      </Section>
      <Section title="Credentials">
        {resources?.vault ? <span className="pill">vault: {resources.vault.name}</span> : <span className="muted">no vault</span>}
      </Section>
    </SideSheet>
  );
}

export function FilesPanel({ resources, onClose }: { resources: any; onClose: () => void }) {
  const files = resources?.inputFiles ?? [];
  return (
    <SideSheet onClose={onClose} title={`Input files (${files.length})`}>
      {files.length ? files.map((f: any) => (
        <div key={f.id} className="row">
          <a className="linkbtn" href={`/api/v1/files/${f.id}/content`}>{f.name}</a>
          <span className="muted">{fmtSize(Number(f.size))}</span>
        </div>
      )) : <span className="muted">no input files attached</span>}
    </SideSheet>
  );
}

export function MemoryPanel({ resources, onClose }: { resources: any; onClose: () => void }) {
  const m = resources?.memory;
  return (
    <SideSheet onClose={onClose} title={m ? m.name : "Memory"}
      subtitle={m && <><code>{m.id}</code> · <Link className="linkbtn" href={`/memory-stores/${m.id}`}>Go to memory store →</Link></>}>
      {m ? (
        <Section title="How it works">
          Mounted at /mnt/memory in every session pod. The agent reads it before starting work and writes durable learnings back; only changed files sync when the turn ends.
        </Section>
      ) : (
        <span className="muted">
          No memory store attached — one store can be attached per session when it is created
          (API field <code>memoryStore</code>). Attached stores mount at /mnt/memory and persist
          learnings across sessions.
        </span>
      )}
    </SideSheet>
  );
}

export const isImageName = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);
const contentUrl = (f: any) => `/api/v1/files/${f.id}/content`;

export function OutputsPanel({ resources, onClose }: { resources: any; onClose: () => void }) {
  const files = resources?.outputFiles ?? [];
  const [sel, setSel] = useState<any | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [zoom, setZoom] = useState<any | null>(null);
  async function open(f: any) {
    setSel(f); setPreview(null);
    if (isImageName(f.name)) return;   // the <img> below loads itself
    if (Number(f.size) < 262144) {
      try {
        const res = await fetch(contentUrl(f), { headers: wsHeader() });
        if (res.ok) setPreview(await res.text());
      } catch { /* preview is best-effort */ }
    }
  }
  return (
    <SideSheet onClose={onClose} title={`Output files (${files.length})`}>
      {files.length === 0 && <span className="muted">produced during the run — none yet</span>}
      {files.map((f: any) => (
        <div key={f.id} className="row" style={{ cursor: "pointer" }} onClick={() => open(f)}>
          <span className={sel?.id === f.id ? "linkbtn" : ""}>{f.name}</span>
          <span className="muted">{fmtSize(Number(f.size))}</span>
        </div>
      ))}
      {sel && (
        <Section title={sel.name}>
          <div className="sub" style={{ margin: "0 0 8px" }}>
            {fmtSize(Number(sel.size))} · <a className="linkbtn" href={contentUrl(sel)} download>Download</a>
          </div>
          {isImageName(sel.name)
            ? <img className="md-img" src={contentUrl(sel)} alt={sel.name} onClick={() => setZoom(sel)} />
            : preview != null
              ? sel.name.toLowerCase().endsWith(".md")
                ? <Markdown text={preview} />
                : <pre className="block" style={{ maxHeight: 300 }}>{preview}</pre>
              : <span className="muted">no inline preview (large or binary)</span>}
        </Section>
      )}
      {zoom && <Lightbox src={contentUrl(zoom)} alt={zoom.name} onClose={() => setZoom(null)} />}
    </SideSheet>
  );
}

// One renderable piece of a row: markdown for agent/user text, mono blocks
// for tool inputs/outputs, error-tinted blocks for anything that failed —
// so nothing requires a detour through the Raw tab.
interface Segment { key: number; kind: "md" | "mono" | "error"; label?: React.ReactNode; text: string; }

// MCP tool calls (`mcp__<server>__<tool>`) render as an MCP badge + server +
// tool name instead of the raw SDK string — the raw string stays available
// as a title tooltip.
function toolLabel(toolName: string): React.ReactNode {
  const mcp = parseMcpTool(toolName);
  if (!mcp) return `⚙ ${toolName}`;
  return (
    <span title={toolName}>
      ⚙ <span className="mcp-badge">MCP</span>
      <span className="mcp-server">{mcp.server}</span>
      <span className="mcp-tool">{mcp.tool}</span>
    </span>
  );
}

function segmentsOf(row: Row): Segment[] {
  const out: Segment[] = [];
  for (const e of row.events) {
    const p = e.payload ?? {};
    if (e.type === "tool.call") {
      const input = typeof p.input?.command === "string" ? p.input.command
        : typeof p.input?.file_path === "string" ? p.input.file_path
        : JSON.stringify(p.input ?? {}, null, 2);
      out.push({ key: e.seq, kind: "mono", label: toolLabel(p.tool ?? "tool"), text: input });
    } else if (e.type === "tool.result") {
      const text = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? {});
      if (text) out.push({ key: e.seq, kind: p.is_error ? "error" : "mono", label: "↳ result", text });
    } else if (typeof p.text === "string" && p.text) {
      out.push({ key: e.seq, kind: "md", text: p.text });
    } else if (typeof p.error === "string" && p.error) {
      out.push({ key: e.seq, kind: "error", text: p.error });
    }
  }
  return out;
}

// Deployment(s) a step's gateway calls resolved to (spec 2026-07-16, fix wave
// H). Fetched lazily per turn when a step opens; matched to the step by
// timestamp containment (a usage row overlaps the step's [start-2s, end+2s]
// window), falling back to the whole turn's distinct models labeled "turn".
function StepDeployments({ sessionId, turn, row }: { sessionId: string; turn: number; row: Row }) {
  const [deps, setDeps] = useState<{ model: string; first_ts: string; last_ts: string }[] | null>(null);
  useEffect(() => {
    let stale = false;
    setDeps(null);
    fetch(`/api/v1/sessions/${sessionId}/deployments?turn=${turn}`, { headers: wsHeader() })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!stale) setDeps(j?.deployments ?? []); })
      .catch(() => { if (!stale) setDeps([]); });
    return () => { stale = true; };
  }, [sessionId, turn, row.seq]);
  if (!deps || deps.length === 0) return null;
  const ts = row.events.map((e) => new Date(e.created_at).getTime()).filter((n) => !Number.isNaN(n));
  const start = (ts.length ? Math.min(...ts) : 0) - 2000;
  const end = (ts.length ? Math.max(...ts) : 0) + 2000;
  const overlap = ts.length
    ? deps.filter((d) => new Date(d.last_ts).getTime() >= start && new Date(d.first_ts).getTime() <= end)
    : [];
  const contained = overlap.length > 0;
  const shown = contained ? overlap : deps;
  const models = [...new Set(shown.map((d) => d.model))];
  return (
    <span title={contained ? "resolved during this step" : "models used this turn"}>
      · deployment: {models.join(", ")}
    </span>
  );
}

// Delegate tool results lead with a one-line JSON header {"session","files"}
// (runner contract — survives history/event truncation). First parseable
// header wins; a non-delegate mono block never parses as an object with .session.
function delegateChild(row: Row): string | null {
  for (const e of row.events) {
    if (e.type !== "tool.result" || typeof e.payload?.output !== "string") continue;
    try {
      const header = JSON.parse(e.payload.output.split("\n", 1)[0]);
      if (typeof header?.session === "string") return header.session;
    } catch { /* not a delegate result */ }
  }
  return null;
}

export function EventPanel({ row, outputs, onClose, sessionId, turn }:
  { row: Row; outputs?: any[]; onClose: () => void; sessionId: string; turn: number }) {
  const [view, setView] = useState<"rendered" | "raw">("rendered");
  const segments = segmentsOf(row);
  // Output images become embeddable in agent-message markdown.
  const images: MdImage[] = (outputs ?? [])
    .filter((f) => isImageName(f.name))
    .map((f) => ({ name: f.name, url: contentUrl(f) }));
  const titleMatch = row.title ? /^(.*) (×\d+)$/.exec(row.title) : null;
  const titleMcp = row.kind === "tool" && row.title
    ? parseMcpTool(titleMatch ? titleMatch[1] : row.title) : null;
  // Only TOOL rows keep their name in the meta line: the "×N" rollup (and the
  // mixed-tool summary) is the one thing the body's per-call labels don't
  // carry. Text rows show nothing but the badge — their old headline was the
  // same string the Rendered tab prints right below it.
  const toolName = row.kind === "tool" && row.title ? (
    titleMcp ? (
      <span title={row.title}>
        <span className="mcp-server">{titleMcp.server}</span>
        <span className="mcp-tool">{titleMcp.tool}</span>{titleMatch ? ` ${titleMatch[2]}` : ""}
      </span>
    ) : <span>{row.title}</span>
  ) : null;
  const childId = row.kind === "subagent" ? delegateChild(row) : null;
  return (
    <SideSheet onClose={onClose}
      subtitle={
        <span className="sheet-sub">
          <span className={`trow-chip ${titleMcp ? "mcp" : row.kind}`}>
            {titleMcp ? "MCP" : CHIP[row.kind]}
          </span>
          {toolName}
          <span>{toolName ? "· " : ""}{row.events.length} event{row.events.length === 1 ? "" : "s"} · {(row.durationMs / 1000).toFixed(1)}s</span>
          <StepDeployments sessionId={sessionId} turn={turn} row={row} />
          {childId && <a href={`/sessions/${childId}`}>· session <code>{childId}</code></a>}
        </span>
      }>
      <div className="tabs" style={{ margin: "0 0 10px" }}>
        <button className={view === "rendered" ? "active" : ""} onClick={() => setView("rendered")}>Rendered</button>
        <button className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}>Raw</button>
      </div>
      {view === "rendered"
        ? (segments.length
            ? segments.map((s) => (
                <div key={s.key} style={{ marginBottom: 10 }}>
                  {s.label && <div className="detail-meta">{s.label}</div>}
                  {s.kind === "md"
                    ? <Markdown text={s.text} images={images} />
                    : <pre className={`block${s.kind === "error" ? " block-error" : ""}`}
                        style={{ maxHeight: 300 }}>{s.text}</pre>}
                </div>
              ))
            : <span className="muted">no text content — see Raw</span>)
        : row.events.map((e) => (
            <div key={e.seq} style={{ marginBottom: 10 }}>
              <div className="detail-meta">seq {e.seq} · {e.type}</div>
              <pre className="block" style={{ maxHeight: 260 }}>{JSON.stringify(e.payload, null, 2)}</pre>
            </div>
          ))}
    </SideSheet>
  );
}
