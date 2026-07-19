"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { wsHeader } from "../lib/client";
import { Icon } from "../lib/icons";
import { Modal, Field } from "../lib/modal";

export function CreateSkill() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!file) return;
    setBusy(true); setError(null);
    const body = new FormData();
    body.append("file", file);
    try {
      const res = await fetch(`/api/v1/skills?name=${encodeURIComponent(name)}`, { method: "POST", headers: wsHeader(), body });
      if (res.ok) { setFile(null); router.refresh(); }
      else setError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    } catch (err) { setError(String(err)); }
    setBusy(false);
  };

  return (<>
    <input ref={input} type="file" accept=".md,.zip" style={{ display: "none" }} onChange={(e) => {
      const f = e.target.files?.[0];
      if (f) { setFile(f); setName(f.name.replace(/\.(md|zip)$/i, "")); setError(null); }
      e.target.value = "";
    }} />
    <button onClick={() => input.current?.click()}><Icon.upload /> Upload skill</button>
    {file && (
      <Modal title="Upload skill" width="sm" onClose={() => setFile(null)} busy={busy} error={error}
        subtitle={`Uploading ${file.name} (${(file.size / 1024).toFixed(1)} KB). Re-uploading an existing name bumps its version.`}
        footer={<>
          <button className="ghost" disabled={busy} onClick={() => setFile(null)}>Cancel</button>
          <button disabled={busy || !name.trim()} onClick={submit}>{busy ? "Uploading…" : "Upload skill"}</button>
        </>}>
        <Field label="Name" required hint="kebab-case — staged into .claude/skills/<name>/ in sessions">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </Modal>
    )}
  </>);
}
