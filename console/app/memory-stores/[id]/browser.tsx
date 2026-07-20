"use client";

import { useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { wsHeader } from "../../lib/client";
import { Modal, Field, ConfirmDialog } from "../../lib/modal";
import { Markdown } from "../../lib/markdown";
import { splitFrontmatter, resolveRelativeHref } from "../../lib/file-tree";

export function MemoryBrowser({ storeId, entries }:
  { storeId: string; entries: { path: string; file_id: string; updated_at: string }[] }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string | null>(entries[0]?.path ?? null);
  const [content, setContent] = useState<string>("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<File | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [raw, setRaw] = useState(false);
  const isMd = (p: string | null) => !!p && p.toLowerCase().endsWith(".md");

  async function load(path: string) {
    setSelected(path);
    const res = await fetch(`/api/v1/memory-stores/${storeId}/content?path=${encodeURIComponent(path)}`, { headers: wsHeader() });
    setContent(res.ok ? await res.text() : `error ${res.status}`);
    setLoaded(path);
  }

  return (
    <>
      <div className="formrow" style={{ marginBottom: 14 }}>
        <input ref={input} type="file" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) { setPending(f); setPath(f.name); setError(null); } e.target.value = ""; }} />
        <button disabled={busy} onClick={() => input.current?.click()}>{busy ? "Adding…" : "+ Add memory"}</button>
        <span className="sub" style={{ margin: 0 }}>Agents also write here at <code>/mnt/memory</code> during sessions.</span>
      </div>
      {entries.length === 0 ? (
        <div className="empty">This store is empty — add a file above, or let an agent write to it.</div>
      ) : (
        <div className="split" style={{ "--split-offset": "225px" } as CSSProperties}>
          <div className="tree">
            {entries.map((e) => (
              <button key={e.path} className={selected === e.path ? "sel" : ""} onClick={() => load(e.path)}>{e.path}</button>
            ))}
          </div>
          <div>
            {loaded ? (
              <>
                <div className="formrow" style={{ justifyContent: "space-between" }}>
                  <p className="sub" style={{ margin: 0 }}>/{loaded} · updated{" "}
                    {new Date(entries.find((e) => e.path === loaded)!.updated_at).toLocaleString()}</p>
                  <span className="formrow" style={{ margin: 0, gap: 8 }}>
                    {isMd(loaded) && (
                      <button className="ghost" onClick={() => setRaw((r) => !r)}>{raw ? "Rendered" : "Raw"}</button>
                    )}
                    <button className="ghost danger" onClick={() => setDeleting(true)}>Delete</button>
                  </span>
                  {deleting && loaded && <ConfirmDialog title="Delete memory" verb="Delete"
                    message={`Delete "${loaded}" from this store?`}
                    onClose={() => setDeleting(false)}
                    onConfirm={async () => {
                      try {
                        const res = await fetch(`/api/v1/memory-stores/${storeId}/entries?path=${encodeURIComponent(loaded)}`,
                          { method: "DELETE", headers: wsHeader() });
                        if (!res.ok) return `Delete failed: ${res.status}`;
                      } catch (err) {
                        return String(err);
                      }
                      setLoaded(null); router.refresh(); return null;
                    }} />}
                </div>
                {isMd(loaded) && !raw
                  ? (() => {
                      const { meta, body } = splitFrontmatter(content);
                      return (
                        <div className="block md-scroll">
                          {meta.length > 0 && (
                            <div className="wiki-meta">
                              {meta.map(([k, v]) => <span key={k}><b>{k}:</b> {v}</span>)}
                            </div>
                          )}
                          <Markdown text={body} onNavigate={(href) => {
                            const target = resolveRelativeHref(loaded, href);
                            if (entries.some((e) => e.path === target)) { setRaw(false); load(target); }
                          }} />
                        </div>
                      );
                    })()
                  : <pre className="block">{content}</pre>}
              </>
            ) : <div className="empty">Select a file to view its content.</div>}
          </div>
        </div>
      )}
      {pending && (
        <Modal title="Add memory" width="sm" onClose={() => setPending(null)} busy={busy} error={error}
          subtitle={`Uploading ${pending.name} (${(pending.size / 1024).toFixed(1)} KB).`}
          footer={<>
            <button className="ghost" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
            <button disabled={busy || !path.trim()} onClick={async () => {
              setBusy(true); setError(null);
              try {
                const body = new FormData();
                body.append("file", pending);
                const res = await fetch(`/api/v1/memory-stores/${storeId}/entries?path=${encodeURIComponent(path)}`, {
                  method: "POST", headers: wsHeader(), body,
                });
                if (res.ok) { setPending(null); router.refresh(); }
                else setError(`Add failed: ${res.status}`);
              } catch (err) {
                setError(String(err));
              } finally {
                setBusy(false);
              }
            }}>{busy ? "Adding…" : "Add memory"}</button>
          </>}>
          <Field label="Memory path" required hint="where agents see it under /mnt/memory">
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="index/notes.json" />
          </Field>
        </Modal>
      )}
    </>
  );
}
