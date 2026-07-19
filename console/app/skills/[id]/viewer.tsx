"use client";
// Inline skill-package browser (wiki-style folder tree + markdown viewing)
// and the update-skill action (same-name upload publishes the next version).
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { wsHeader } from "../../lib/client";
import { Icon } from "../../lib/icons";
import { Modal } from "../../lib/modal";
import { Markdown } from "../../lib/markdown";
import { buildTree, FileTree, splitFrontmatter, resolveRelativeHref, type TreeNode } from "../../lib/file-tree";

const isEntry = (path: string) => path.toLowerCase() === "skill.md";
// SKILL.md first, then folders, then the remaining files.
const skillRank = (n: TreeNode) => (n.isFile ? (isEntry(n.path) ? 0 : 2) : 1);

export function SkillFiles({ files }: { files: { path: string; fileId: string }[] }) {
  const entry = files.find((f) => isEntry(f.path)) ?? files[0];
  const tree = useMemo(() => buildTree(files.map((f) => f.path), skillRank), [files]);
  const [selected, setSelected] = useState<string | null>(entry?.path ?? null);
  const [content, setContent] = useState<string>("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const isMd = (p: string | null) => !!p && p.toLowerCase().endsWith(".md");

  async function load(path: string) {
    const file = files.find((f) => f.path === path);
    if (!file) return;
    setSelected(path);
    try {
      const res = await fetch(`/api/v1/files/${file.fileId}/content`, { headers: wsHeader() });
      setContent(res.ok ? await res.text() : `error ${res.status}`);
    } catch (err) {
      setContent(String(err));
    }
    setLoaded(path);
  }

  useEffect(() => { if (entry) load(entry.path); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!files.length) return <div className="empty">No files recorded for this skill.</div>;
  return (
    <div className="split">
      <FileTree nodes={tree} selected={selected} onSelect={load}
        fileClass={(n) => (isEntry(n.path) ? "entry" : "")}
        fileLabel={(n) => (isEntry(n.path) ? `${n.name}  ●` : n.name)} />
      <div>
        {loaded ? (
          <>
            <div className="formrow" style={{ justifyContent: "space-between" }}>
              <p className="sub" style={{ margin: 0 }}><code>{loaded}</code></p>
              {isMd(loaded) && (
                <button className="ghost" onClick={() => setRaw((r) => !r)}>{raw ? "Rendered" : "Raw"}</button>
              )}
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
                        if (files.some((f) => f.path === target)) { setRaw(false); load(target); }
                      }} />
                    </div>
                  );
                })()
              : <pre className="block">{content}</pre>}
          </>
        ) : <div className="empty">Select a file to view its contents.</div>}
      </div>
    </div>
  );
}

export function UpdateSkillButton({ name, version }: { name: string; version: number }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
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
      if (f) { setFile(f); setError(null); }
      e.target.value = "";
    }} />
    <button onClick={() => input.current?.click()}><Icon.upload /> Update skill</button>
    {file && (
      <Modal title="Update skill" width="sm" onClose={() => setFile(null)} busy={busy} error={error}
        subtitle={`Publishes v${version + 1} of "${name}" from ${file.name} (${(file.size / 1024).toFixed(1)} KB). Existing agents keep referencing this skill by id.`}
        footer={<>
          <button className="ghost" disabled={busy} onClick={() => setFile(null)}>Cancel</button>
          <button disabled={busy} onClick={submit}>{busy ? "Uploading…" : `Publish v${version + 1}`}</button>
        </>}>
        <p className="modal-msg">The uploaded package fully replaces the current file set.</p>
      </Modal>
    )}
  </>);
}
