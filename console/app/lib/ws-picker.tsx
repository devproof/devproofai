"use client";
// Workspace switcher (spec 2026-07-13): MCP-picker-style dropdown — colored
// initial tile + name, workspace id in small gray mono beneath.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { WorkspaceModal } from "./workspace-modal";

export interface WsEntry { id: string; name: string; status: string }

// Deterministic id -> hue (same trick as the MCP picker's logo tiles).
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function Stripe({ w }: { w: WsEntry }) {
  return <span className="ws-stripe" aria-hidden style={{ background: `hsl(${hashHue(w.id)}, 45%, 38%)` }} />;
}

export function WorkspacePicker({ workspaces, current }: { workspaces: WsEntry[]; current: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [create, setCreate] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // deleting workspaces are mid-teardown — never offered (spec 2026-07-13);
  // deleted ones are already excluded by the API.
  const visible = workspaces.filter((w) => w.status !== "deleting");
  const cur = visible.find((w) => w.id === current) ?? visible[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const switchTo = (id: string) => {
    document.cookie = `devproof_ws=${encodeURIComponent(id)}; path=/; max-age=31536000`;
    setOpen(false);
    router.refresh();
  };

  return (
    <div className="ws-picker" ref={wrapRef}>
      <button className="ws-current" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
              title={cur.status === "disabled" ? "Workspace disabled — read-only" : undefined}>
        <Stripe w={cur} />
        <span className="ws-text"><strong>{cur.name}</strong><span className="ws-id">{cur.id}</span></span>
        {cur.status === "disabled" && <span className="ws-flag">disabled</span>}
        <span className="ws-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="ws-panel" role="listbox">
          {visible.map((w) => (
            <button key={w.id} role="option" aria-selected={w.id === current}
                    className={`ws-option${w.id === current ? " active" : ""}`} onClick={() => switchTo(w.id)}>
              <Stripe w={w} />
              <span className="ws-text"><strong>{w.name}</strong><span className="ws-id">{w.id}</span></span>
              {w.status === "disabled" && <span className="ws-flag">disabled</span>}
            </button>
          ))}
          <button className="ws-option ws-new" onClick={() => { setOpen(false); setCreate(true); }}>
            + New workspace…
          </button>
        </div>
      )}
      {create && <WorkspaceModal onClose={() => setCreate(false)}
                                 onCreated={(id) => { setCreate(false); switchTo(id); }} />}
    </div>
  );
}
