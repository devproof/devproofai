"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "../lib/icons";
import { Modal, Field, submitJson } from "../lib/modal";

export function EditMemoryStoreButton({ store }: { store: { id: string; name: string } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(store.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    const err = await submitJson("PATCH", `/v1/memory-stores/${store.id}`, { name });
    setBusy(false);
    if (err) setError(err);
    else { setOpen(false); router.refresh(); }
  };

  return (<>
    <button onClick={() => { setName(store.name); setError(null); setOpen(true); }}>
      <Icon.edit /> Edit store
    </button>
    {open && (
      <Modal title={`Edit ${store.name}`} width="md" onClose={() => setOpen(false)} busy={busy} error={error}
        footer={<>
          <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button disabled={busy || !name.trim()} onClick={submit}>{busy ? "Saving…" : "Save"}</button>
        </>}>
        <Field label="Name" required>
          <input value={name} onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && submit()} />
        </Field>
      </Modal>
    )}
  </>);
}
