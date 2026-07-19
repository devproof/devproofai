"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal, Field } from "../lib/modal";
import { apiPost } from "../lib/client";

export function CreateVault() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  // Credentials are added on the vault detail page after creation, so on
  // success we land there instead of refreshing the list.
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await apiPost("/v1/vaults", { name });
      if (res.ok) { const vault = await res.json(); router.push(`/vaults/${vault.id}`); return; }
      setError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    } catch (err) { setError(String(err)); }
    setBusy(false);
  };

  return (<>
    <button onClick={() => setOpen(true)}>+ Create vault</button>
    {open && (
      <Modal title="Create vault" width="md" onClose={() => setOpen(false)} busy={busy} error={error}
        footer={<>
          <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button disabled={busy || !name} onClick={submit}>{busy ? "Creating…" : "Create vault"}</button>
        </>}>
        <Field label="Name" required hint="credentials are added on the vault page after creation">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </Modal>
    )}
  </>);
}
