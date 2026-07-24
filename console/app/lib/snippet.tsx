"use client";
// Copy-paste snippet block with a copy button — shared by the routing
// Connect tab and the agent Webhooks tab. Client components only: nothing
// server-callable may be exported from this module.
import { useState } from "react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="iconbtn" title={copied ? "Copied!" : "Copy"} aria-label="Copy snippet"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); } catch { return; }
        setCopied(true); setTimeout(() => setCopied(false), 1500);
      }}>
      {copied
        ? <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 8.5 6 12.5 14 3.5" /></svg>
        : <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5" y="5" width="9" height="9" rx="1.5" /><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" /></svg>}
    </button>
  );
}

export function Snippet({ label, text }: { label?: string; text: string }) {
  return (
    <>
      {label && <div className="hint" style={{ marginTop: 8 }}>{label}</div>}
      <div style={{ position: "relative", marginTop: 6 }}>
        <pre className="block" style={{ margin: 0 }}>{text}</pre>
        <div style={{ position: "absolute", top: 6, right: 6 }}><CopyButton text={text} /></div>
      </div>
    </>
  );
}
