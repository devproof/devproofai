"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal, Field, submitJson } from "../lib/modal";

export function CreateStore() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    const err = await submitJson("POST", "/v1/memory-stores", { name });
    setBusy(false);
    if (err) setError(err); else { setOpen(false); setName(""); router.refresh(); }
  };

  return (<>
    <button onClick={() => setOpen(true)}>+ Create memory store</button>
    {open && (
      <Modal title="Create memory store" width="sm" onClose={() => setOpen(false)} busy={busy} error={error}
        footer={<>
          <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button disabled={busy || !name.trim()} onClick={submit}>{busy ? "Creating…" : "Create store"}</button>
        </>}>
        <Field label="Name" required hint="e.g. a ticket id — sessions mount it at /mnt/memory">
          <input value={name} onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && submit()} />
        </Field>
      </Modal>
    )}
  </>);
}
