"use client";
// Registry-backed MCP server picker (spec 2026-07-13, amended 2026-07-13: a
// left-aligned dropdown with per-server logo tiles instead of an inline
// list). Search the bundled registry or enter a custom URL. Used by the
// credential dialog + agent form.
import { useEffect, useRef, useState } from "react";
import { apiGet } from "./client";

export interface McpServerPick { name: string; url: string }
interface RegistryEntry { name: string; label: string; url: string; description?: string; auth: string }

// Deterministic string hash -> hue, so the same server always gets the same tile color.
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function ServerLogo({ name, custom }: { name?: string; custom?: boolean }) {
  if (custom) return <span className="mcp-logo mcp-logo-custom" aria-hidden>🌐</span>;
  return (
    <span className="mcp-logo" aria-hidden style={{ background: `hsl(${hashHue(name ?? "")}, 45%, 38%)` }}>
      {(name || "?").charAt(0).toUpperCase()}
    </span>
  );
}

export function McpServerPicker({ value, onChange, disabled }: {
  value: McpServerPick | null; onChange: (v: McpServerPick | null) => void; disabled?: boolean;
}) {
  const [registry, setRegistry] = useState<RegistryEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [custom, setCustom] = useState(false);
  const [customUrl, setCustomUrl] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiGet<{ servers: RegistryEntry[] }>("/v1/mcp-registry")
      .then((r) => setRegistry(r.servers)).catch(() => setRegistry([]));
  }, []);

  const close = () => { setOpen(false); setCustom(false); setQ(""); setCustomUrl(""); };

  // Click-outside closes the panel. Only registered while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (value) {
    return (
      <span style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
        <ServerLogo name={value.name} />
        <span style={{ flex: 1 }}><strong>{value.name}</strong>{" "}
          <span className="muted" style={{ fontSize: 12 }}>{value.url}</span></span>
        {!disabled && <button className="iconbtn danger" title="Clear server" aria-label="Clear server"
          onClick={() => onChange(null)}>✕</button>}
      </span>
    );
  }

  const hits = registry.filter((r) =>
    !q.trim() || `${r.label} ${r.name} ${r.url}`.toLowerCase().includes(q.trim().toLowerCase()));

  const panel = open && (
    <div className="mcp-panel">
      {custom ? (
        <div className="mcp-custom-form">
          <input autoFocus placeholder="https://mcp.example.com/mcp" value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)} />
          <span style={{ display: "flex", gap: 8 }}>
            <button className="ghost" disabled={!/^https?:\/\/.+/.test(customUrl)} onClick={() => {
              try { onChange({ name: new URL(customUrl).hostname, url: customUrl }); close(); } catch { /* disabled */ }
            }}>Use</button>
            <button className="ghost" onClick={() => setCustom(false)}>Back</button>
          </span>
        </div>
      ) : (<>
        <input className="mcp-search" autoFocus placeholder="Search the MCP registry…" value={q}
          onChange={(e) => setQ(e.target.value)} />
        <span className="mcp-options">
          {hits.map((r) => (
            <button key={r.name} type="button" className="mcp-option"
              onClick={() => { onChange({ name: r.name, url: r.url }); close(); }}>
              <ServerLogo name={r.name} />
              <span className="mcp-option-text">
                <strong>{r.label}</strong>
                <span className="mcp-option-url muted">{r.url}</span>
                {r.description && <span className="mcp-option-desc muted">{r.description}</span>}
              </span>
            </button>
          ))}
          <button type="button" className="mcp-option" onClick={() => setCustom(true)}>
            <ServerLogo custom />
            <span className="mcp-option-text">
              <strong>Custom server…</strong>
              <span className="mcp-option-url muted">enter a URL</span>
            </span>
          </button>
        </span>
      </>)}
    </div>
  );

  return (
    // Local Escape handling only — never hijacks the modal's Escape stack (useTopEscape).
    <div className="mcp-picker" ref={wrapRef}
         onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); close(); } }}>
      <button type="button" className="mcp-picker-btn" disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <span>Select MCP server…</span>
        <span className="mcp-picker-chevron">▾</span>
      </button>
      {panel}
    </div>
  );
}
