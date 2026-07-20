import Link from "next/link";
import { notFound } from "next/navigation";
import { wsGet } from "../../lib/api";
import { CopyId } from "../../lib/copy-id";
import { DeleteButton, DownloadButton } from "../../lib/delete";
import { DateTime } from "../../lib/datetime";

export const dynamic = "force-dynamic";

const fmtSize = (n: number) =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(2)} KB` : `${n} B`;

export default async function FileDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const f = await wsGet<any>(`/v1/files/${id}`).catch(() => null);
  if (!f?.id) notFound();
  return (
    <>
      <div className="crumbs"><Link href="/files">Files</Link> / <CopyId id={f.id} /> · created <DateTime iso={f.created_at} /></div>
      <div className="pagehead">
        <h1>{f.name}</h1>
        <div className="formrow" style={{ margin: 0 }}>
          <DownloadButton path={`/v1/files/${f.id}/content`} name={f.name} />
          <DeleteButton path={`/v1/files/${f.id}`} redirect="/files" confirmText={`Delete file "${f.name}"?`} label="Delete file" />
        </div>
      </div>
      <div className="cards">
        <div className="card"><h3>File</h3>
          <div className="row"><span className="muted">Type</span>
            <span className={`phase ${f.kind === "output" ? "warn" : "ok"}`}>{f.kind === "output" ? "output" : f.kind ?? "input"}</span></div>
          <div className="row"><span className="muted">Size</span><span>{fmtSize(Number(f.size))}</span></div>
        </div>
        <div className="card"><h3>Integrity</h3>
          <div className="row"><span className="muted">sha256</span></div>
          <code style={{ fontSize: 11, wordBreak: "break-all" }}>{f.sha256 ?? "—"}</code>
        </div>
        <div className="card"><h3>Usage</h3>
          <div className="row"><span className="muted">Sessions</span>
            <span><Link href={`/sessions?file=${encodeURIComponent(f.id)}`}>view sessions using this file →</Link></span></div>
        </div>
      </div>
    </>
  );
}
