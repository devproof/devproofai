"use client";
// Shared "New workspace" dialog — used by the nav switcher and /workspaces.
import { useState } from "react";
import { Modal, Field } from "./modal";

export function WorkspaceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/v1/workspaces", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      if (res.ok) { onCreated((await res.json()).id); return; }
      setError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    } catch (err) { setError(String(err)); }
    setBusy(false);
  };
  return (
    <Modal title="New workspace" width="sm" onClose={onClose} busy={busy} error={error}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || !name.trim()} onClick={submit}>{busy ? "Creating…" : "Create workspace"}</button>
      </>}>
      <Field label="Name" required hint="every resource is scoped to a workspace">
        <input value={name} onChange={(e) => setName(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && submit()} placeholder="team-research" />
      </Field>
    </Modal>
  );
}
