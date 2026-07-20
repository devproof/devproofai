"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { wsHeader } from "../lib/client";
import { ConfirmDialog } from "../lib/modal";
import { DownloadButton, RowActions } from "../lib/delete";
import { Pager } from "../lib/pager";
import { DateTime } from "../lib/datetime";

interface FileRow {
  id: string; name: string; size: number; kind: string;
  session_count: number; created_at: string;
}
const fmtSize = (n: number) =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(2)} KB` : `${n} B`;

export function FilesTable({ files, total }:
  { files: FileRow[]; total: number; limit?: number; offset?: number }) {
  const router = useRouter();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allChecked = files.length > 0 && files.every((f) => sel.has(f.id));

  return (
    <>
      {sel.size > 0 && (
        <div className="formrow" style={{ marginBottom: 12 }}>
          <button className="danger-solid" onClick={() => setConfirmOpen(true)}>
            {`Delete ${sel.size} selected`}
          </button>
          <button className="ghost" onClick={() => setSel(new Set())}>Clear selection</button>
        </div>
      )}
      {confirmOpen && <ConfirmDialog title="Delete files" verb={`Delete ${sel.size}`}
        message={`Delete ${sel.size} file(s)? This cannot be undone.`}
        onClose={() => setConfirmOpen(false)}
        onConfirm={async () => {
          const ids = [...sel];
          const results = await Promise.all(ids.map((id) =>
            fetch(`/api/v1/files/${id}`, { method: "DELETE", headers: wsHeader() })
              .then((r) => r.ok).catch(() => false)));
          const failed = ids.filter((_, i) => !results[i]);
          setSel(new Set(failed)); router.refresh();
          return failed.length
            ? `${failed.length} of ${ids.length} deletes failed — the failed files stay selected`
            : null;
        }} />}
      <div className="tablewrap"><table>
        <thead>
          <tr>
            <th style={{ width: 34 }}>
              <input type="checkbox" checked={allChecked}
                onChange={(e) => setSel(e.target.checked ? new Set(files.map((f) => f.id)) : new Set())} />
            </th>
            <th>ID</th><th>Name</th><th>Type</th><th>Size</th><th>Sessions</th><th>Created</th><th></th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.id} style={{ background: sel.has(f.id) ? "var(--hover)" : undefined }}>
              <td><input type="checkbox" checked={sel.has(f.id)} onChange={() => toggle(f.id)} /></td>
              <td><Link href={`/files/${f.id}`}><code>{f.id}</code></Link></td>
              <td>{f.name}</td>
              <td><span className={`phase ${f.kind === "output" ? "warn" : "ok"}`}>{f.kind === "output" ? "output" : "input"}</span></td>
              <td>{fmtSize(Number(f.size))}</td>
              <td>{f.session_count > 0
                ? <Link href={`/sessions?file=${encodeURIComponent(f.id)}`}>{f.session_count}</Link>
                : f.session_count}</td>
              <td><DateTime iso={f.created_at} /></td>
              <td><RowActions><DownloadButton path={`/v1/files/${f.id}/content`} name={f.name} /></RowActions></td>
            </tr>
          ))}
          {files.length === 0 && <tr><td colSpan={8} className="empty">No files yet.</td></tr>}
        </tbody>
      </table></div>
      <Pager count={total} />
    </>
  );
}
