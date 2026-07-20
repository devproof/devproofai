"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "../lib/icons";
import { Modal, Field, submitJson } from "../lib/modal";

export function EditWikiButton({ wiki }: { wiki: { id: string; name: string; description?: string } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(wiki.name);
  const [description, setDescription] = useState(wiki.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    const err = await submitJson("PATCH", `/v1/wikis/${wiki.id}`, { name, description });
    setBusy(false);
    if (err) setError(err);
    else { setOpen(false); router.refresh(); }
  };

  return (<>
    <button onClick={() => { setName(wiki.name); setDescription(wiki.description ?? ""); setError(null); setOpen(true); }}>
      <Icon.edit /> Edit wiki
    </button>
    {open && (
      <Modal title={`Edit ${wiki.name}`} width="md" onClose={() => setOpen(false)} busy={busy} error={error}
        footer={<>
          <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button disabled={busy || !name.trim()} onClick={submit}>{busy ? "Saving…" : "Save"}</button>
        </>}>
        <Field label="Name" required hint="agents mount it at /mnt/wiki/<name>">
          <input value={name} onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && submit()} />
        </Field>
        <Field label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="what this wiki covers" />
        </Field>
      </Modal>
    )}
  </>);
}
