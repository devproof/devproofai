"use client";

import { useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { wsHeader } from "../../lib/client";
import { Modal, Field, ConfirmDialog } from "../../lib/modal";
import { Markdown } from "../../lib/markdown";
import { buildTree, FileTree, splitFrontmatter, resolveRelativeHref, type TreeNode } from "../../lib/file-tree";
import { DateTime } from "../../lib/datetime";

type Entry = { path: string; file_id: string; updated_at: string };

// Order per level: index.md, then log.md (OKF entry points), then folders,
// then the remaining files — each group sorted alphabetically.
const wikiRank = (n: TreeNode) => {
  if (!n.isFile) return 2;
  const nm = n.name.toLowerCase();
  return nm === "index.md" ? 0 : nm === "log.md" ? 1 : 3;
};

export function WikiBrowser({ wikiId, entries }:
  { wikiId: string; entries: Entry[] }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const tree = useMemo(() => buildTree(entries.map((e) => e.path), wikiRank), [entries]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<File | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [raw, setRaw] = useState(false);
  const isMd = (p: string | null) => !!p && p.toLowerCase().endsWith(".md");

  async function load(p: string) {
    setSelected(p);
    const res = await fetch(`/api/v1/wikis/${wikiId}/content?path=${encodeURIComponent(p)}`, { headers: wsHeader() });
    setContent(res.ok ? await res.text() : `error ${res.status}`);
    setLoaded(p);
  }

  return (
    <>
      <div className="formrow" style={{ marginBottom: 14 }}>
        <input ref={input} type="file" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) { setPending(f); setPath(f.name); setError(null); } e.target.value = ""; }} />
        <button disabled={busy} onClick={() => input.current?.click()}>{busy ? "Adding…" : "+ Add page"}</button>
        <span className="sub" style={{ margin: 0 }}>The writer agent also edits here at <code>/mnt/wiki</code> during sessions.</span>
      </div>

      {entries.length === 0 ? (
        <div className="empty">This wiki is empty — add a page above (start with <code>index.md</code>), or let the writer agent populate it.</div>
      ) : (
        <div className="split" style={{ "--split-offset": "260px" } as CSSProperties}>
          <FileTree nodes={tree} selected={selected} onSelect={load} />
          <div>
            {loaded ? (
              <>
                <div className="formrow" style={{ justifyContent: "space-between" }}>
                  <p className="sub" style={{ margin: 0 }}>/{loaded} · updated{" "}
                    <DateTime iso={entries.find((e) => e.path === loaded)!.updated_at} /></p>
                  <span className="formrow" style={{ margin: 0, gap: 8 }}>
                    {isMd(loaded) && (
                      <button className="ghost" onClick={() => setRaw((r) => !r)}>{raw ? "Rendered" : "Raw"}</button>
                    )}
                    <button className="ghost danger" onClick={() => setDeleting(true)}>Delete</button>
                  </span>
                  {deleting && loaded && <ConfirmDialog title="Delete page" verb="Delete"
                    message={`Delete "${loaded}" from this wiki?`}
                    onClose={() => setDeleting(false)}
                    onConfirm={async () => {
                      try {
                        const res = await fetch(`/api/v1/wikis/${wikiId}/entries?path=${encodeURIComponent(loaded)}`,
                          { method: "DELETE", headers: wsHeader() });
                        if (!res.ok) return `Delete failed: ${res.status}`;
                      } catch (err) { return String(err); }
                      setLoaded(null); setSelected(null); router.refresh(); return null;
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
            ) : <div className="empty">Select a page to view its content.</div>}
          </div>
        </div>
      )}

      {pending && (
        <Modal title="Add wiki page" width="sm" onClose={() => setPending(null)} busy={busy} error={error}
          subtitle={`Uploading ${pending.name} (${(pending.size / 1024).toFixed(1)} KB).`}
          footer={<>
            <button className="ghost" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
            <button disabled={busy || !path.trim()} onClick={async () => {
              setBusy(true); setError(null);
              try {
                const body = new FormData();
                body.append("file", pending);
                const res = await fetch(`/api/v1/wikis/${wikiId}/entries?path=${encodeURIComponent(path)}`, {
                  method: "POST", headers: wsHeader(), body,
                });
                if (res.ok) { setPending(null); router.refresh(); }
                else setError(`Add failed: ${res.status}`);
              } catch (err) { setError(String(err)); } finally { setBusy(false); }
            }}>{busy ? "Adding…" : "Add page"}</button>
          </>}>
          <Field label="Page path" required hint="wiki-relative, folders allowed — e.g. services/auth.md">
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="index.md" />
          </Field>
        </Modal>
      )}
    </>
  );
}
