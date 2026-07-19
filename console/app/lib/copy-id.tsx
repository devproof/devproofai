"use client";
// Full entity id + one-click copy (spec 2026-07-10: id always displayed on
// top of detail pages). Quiet icon button — allowed exception to the
// no-transparent-buttons rule, like other row icon-buttons.
import { useState } from "react";

export function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <code>{id}</code>
      <button className="iconbtn" title={copied ? "Copied!" : "Copy id"} aria-label="Copy id"
        onClick={async () => {
          try { await navigator.clipboard.writeText(id); } catch { return; }
          setCopied(true); setTimeout(() => setCopied(false), 1500);
        }}>
        {copied
          ? <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 8.5 6 12.5 14 3.5" /></svg>
          : <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5" y="5" width="9" height="9" rx="1.5" /><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" /></svg>}
      </button>
    </span>
  );
}
