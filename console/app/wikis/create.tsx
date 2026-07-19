"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal, Field, submitJson } from "../lib/modal";

export function CreateWiki() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    const err = await submitJson("POST", "/v1/wikis", { name, description });
    setBusy(false);
    if (err) setError(err);
    else { setOpen(false); setName(""); setDescription(""); router.refresh(); }
  };

  return (<>
    <button onClick={() => setOpen(true)}>+ Create wiki</button>
    {open && (
      <Modal title="Create LLM wiki" width="md" onClose={() => setOpen(false)} busy={busy} error={error}
        footer={<>
          <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button disabled={busy || !name.trim()} onClick={submit}>{busy ? "Creating…" : "Create wiki"}</button>
        </>}>
        <Field label="Name" required hint="agents mount it at /mnt/wiki/<name>">
          <input value={name} onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && submit()} />
        </Field>
        <Field label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="what this wiki covers" />
        </Field>
        <p className="sub" style={{ marginTop: 4 }}>Every wiki follows a fixed structure (index.md catalog, one page per entity, log.md history) — the maintainer and reader agents are instructed on it automatically.</p>
      </Modal>
    )}
  </>);
}
