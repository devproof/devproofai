"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { wsHeader } from "../lib/client";
import { Modal, Field } from "../lib/modal";
import { Icon } from "../lib/icons";

export function CreateApiKey({ label = "+ Create key", ghost = false, icon = false }:
  { label?: string; ghost?: boolean; icon?: boolean } = {}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/v1/api-keys", {
        method: "POST", headers: { "Content-Type": "application/json", ...wsHeader() },
        body: JSON.stringify({ name }),
      });
      if (res.ok) { setCreated(await res.json()); setOpen(false); setName(""); router.refresh(); }
      else setError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    } catch (err) { setError(String(err)); }
    setBusy(false);
  };

  return (<>
    <button className={ghost ? "ghost" : undefined} onClick={() => { setOpen(true); setError(null); }}>
      {icon && <Icon.key />}{label}
    </button>
    {open && (
      <Modal title="Create API key" width="sm" onClose={() => setOpen(false)} busy={busy} error={error}
        footer={<>
          <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button disabled={busy || !name.trim()} onClick={submit}>{busy ? "Creating…" : "Create key"}</button>
        </>}>
        <Field label="Name" required hint="what will use this key, e.g. claude-code-laptop">
          <input value={name} onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && submit()} />
        </Field>
      </Modal>
    )}
    {created && (
      // Deliberately NOT dismissible: the key is shown exactly once.
      <Modal title="Copy your API key" width="sm" dismissible={false} onClose={() => {}}
        subtitle={`This is the only time ${created.name}'s full key is shown. Store it securely.`}
        footer={<>
          <button className="ghost" onClick={async () => {
            try { await navigator.clipboard.writeText(created.key); setCopied(true); }
            catch { setCopied(false); setCopyFailed(true); }
          }}>{copied ? "Copied ✓" : copyFailed ? "Copy failed — select the text above" : "Copy to clipboard"}</button>
          <button onClick={() => { setCreated(null); setCopied(false); setCopyFailed(false); }}>Done</button>
        </>}>
        <pre className="block" style={{ userSelect: "all" }}>{created.key}</pre>
      </Modal>
    )}
  </>);
}
