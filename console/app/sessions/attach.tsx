"use client";
// Shared file-attachment control (spec 2026-07-10): removable chips + a
// picker modal over existing workspace uploads, with inline multipart upload.
import { useEffect, useRef, useState } from "react";
import { wsHeader } from "../lib/client";
import { Icon } from "../lib/icons";
import { Modal } from "../lib/modal";

export interface AttachedFile { id: string; name: string; }

const fmtSize = (n: number) =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

export function AttachFiles({ value, onChange, compact }: {
  value: AttachedFile[]; onChange: (files: AttachedFile[]) => void; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="attach">
      <button type="button" className={compact ? "iconbtn" : "ghost"}
        title="Attach files" aria-label="Attach files" onClick={() => setOpen(true)}>
        <Icon.clip />{!compact && <> Attach files</>}
      </button>
      {value.map((f) => (
        <span key={f.id} className="chip">
          {f.name}
          <button type="button" className="chip-x" aria-label={`Remove ${f.name}`}
            onClick={() => onChange(value.filter((v) => v.id !== f.id))}>✕</button>
        </span>
      ))}
      {open && <FilePicker selected={value} onClose={() => setOpen(false)}
        onAttach={(files) => { onChange(files); setOpen(false); }} />}
    </div>
  );
}

function FilePicker({ selected, onClose, onAttach }: {
  selected: AttachedFile[]; onClose: () => void; onAttach: (files: AttachedFile[]) => void;
}) {
  const [files, setFiles] = useState<any[]>([]);
  const [sel, setSel] = useState<Map<string, string>>(new Map(selected.map((f) => [f.id, f.name])));
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/v1/files?kind=upload&limit=100", { headers: wsHeader() });
      if (res.ok) setFiles((await res.json()).files);
      else setError(`Could not load files: ${res.status}`);
    } catch (err) { setError(String(err)); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (f: any) => setSel((m) => {
    const n = new Map(m);
    if (n.has(f.id)) n.delete(f.id); else n.set(f.id, f.name);
    return n;
  });

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true); setError(null);
    try {
      for (const file of Array.from(list)) {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch("/api/v1/files", { method: "POST", headers: wsHeader(), body });
        if (!res.ok) { setError(`Upload failed for ${file.name}: ${res.status}`); continue; }
        const rec = await res.json();
        setSel((m) => new Map(m).set(rec.id, rec.name));
      }
      await load();          // freshly uploaded files appear in the list, pre-checked
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  };

  const q = search.trim().toLowerCase();
  const visible = q ? files.filter((f) => String(f.name).toLowerCase().includes(q)) : files;
  return (
    <Modal title="Attach files" width="sm" onClose={onClose} busy={busy} error={error}
      subtitle="Attached files are mounted at /mnt/session/uploads for the agent."
      footer={<>
        <input ref={fileInput} type="file" multiple style={{ display: "none" }}
          onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
        <button className="ghost" disabled={busy} style={{ marginRight: "auto" }}
          onClick={() => fileInput.current?.click()}>Upload new…</button>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy} onClick={() => onAttach([...sel].map(([id, name]) => ({ id, name })))}>
          Attach {sel.size} file{sel.size === 1 ? "" : "s"}
        </button>
      </>}>
      <input type="search" placeholder="Search files…" value={search}
        onChange={(e) => setSearch(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
      <div className="checklist" style={{ maxHeight: 260, gridTemplateColumns: "1fr" }}>
        {visible.map((f) => (
          <label key={f.id}>
            <input type="checkbox" checked={sel.has(f.id)} onChange={() => toggle(f)} />
            <span>{f.name} <span className="muted">{fmtSize(Number(f.size))}</span></span>
          </label>
        ))}
        {visible.length === 0 && <span className="muted">{q ? "no files match" : "no uploaded files yet"}</span>}
      </div>
    </Modal>
  );
}
