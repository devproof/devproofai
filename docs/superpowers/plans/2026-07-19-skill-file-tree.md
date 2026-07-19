# Skill File Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the skills detail page the wiki browser's collapsible +/− folder tree and markdown viewing, by extracting the wiki's tree/markdown helpers into a shared lib.

**Architecture:** New `console/app/lib/file-tree.tsx` holds the pure pieces (path→tree builder with caller-supplied pin rank, a `FileTree` component with internal expand state, frontmatter splitter, relative-href resolver). The wiki browser is refactored to consume it (behavior unchanged); the skills viewer adopts it with SKILL.md pinned/auto-loaded, a frontmatter header + Rendered/Raw toggle for `.md` files, and in-pane relative-link navigation. Memory stores untouched.

**Tech Stack:** Next.js console (React client components), existing `Markdown` component (react-markdown), global CSS in `console/app/globals.css` (no CSS changes).

Spec: `docs/superpowers/specs/2026-07-19-skill-file-tree-design.md`.

## Global Constraints

- Console-only change: no control-plane, migration, or gateway edits.
- Reuse the existing global CSS classes unchanged: `.tree`, `.tree-folder`, `.tree-toggle`, `.tree-file`, `.sel`, `.entry`, `.md-scroll`, `.wiki-meta`, `.block`, `.split` (`console/app/globals.css:233-257`). Do NOT add or edit CSS.
- The console has no unit-test suite; verification per repo convention = `npx next build` (includes typecheck) after each task + a live click-through at the end. The console must run as a production build (`npx next build && npx next start -p 7090`), never dev mode.
- After a `next build` the running `next start` must be restarted, or the browser throws client-side chunk exceptions (stale chunk hashes).
- No browser `prompt()`/`confirm()`/`alert()`; no transparent text buttons (`ghost` = solid panel fill is fine).
- This repo is CRLF: after any Edit that deletes whole lines, re-check `git diff` for accidental line joins.
- Wiki page behavior must not change (same DOM, classes, folders expanded by default, index.md/log.md pinned).

---

### Task 1: Shared file-tree lib

**Files:**
- Create: `console/app/lib/file-tree.tsx`

**Interfaces:**
- Consumes: nothing project-specific (React only).
- Produces (Tasks 2 and 3 import exactly these):
  - `type TreeNode = { name: string; path: string; isFile: boolean; children: TreeNode[] }`
  - `buildTree(paths: string[], rank: (n: TreeNode) => number): TreeNode[]`
  - `FileTree({ nodes, selected, onSelect, fileLabel?, fileClass? })` — `selected: string | null`, `onSelect: (path: string) => void`, `fileLabel?: (n: TreeNode) => ReactNode` (default `n.name`), `fileClass?: (n: TreeNode) => string` (extra class merged with `sel`; the skills page passes `entry` for SKILL.md)
  - `splitFrontmatter(text: string): { meta: [string, string][]; body: string }`
  - `resolveRelativeHref(current: string | null, href: string): string`

- [ ] **Step 1: Write the file**

The code is the wiki browser's `buildTree`/`renderNode`/`collectFolders`/`splitFrontmatter`/`resolveWikiHref` (`console/app/wikis/[id]/browser.tsx:11-72,101-119,209-214`) generalized: nodes carry no wiki `Entry` (that field was write-only), the sort rank is a parameter, and the file-button label/class are hooks.

```tsx
"use client";
// Shared collapsible file tree + markdown-page helpers, extracted from the
// wiki browser (spec 2026-07-19-skill-file-tree) so the skills viewer renders
// the same +/− folder tree.
import { useState, type CSSProperties, type ReactNode } from "react";

export type TreeNode = {
  name: string; path: string; isFile: boolean; children: TreeNode[];
};

/** Build a nested folder tree from flat "a/b/c.md" paths. Per-level order is
 *  rank(node) then alphabetical — callers pin their entry points via rank. */
export function buildTree(paths: string[], rank: (n: TreeNode) => number): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isFile: false, children: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === part && c.isFile === isFile);
      if (!child) { child = { name: part, path, isFile, children: [] }; node.children.push(child); }
      node = child;
    });
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function collectFolders(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: TreeNode[]) => ns.forEach((n) => { if (!n.isFile) { out.push(n.path); walk(n.children); } });
  walk(nodes);
  return out;
}

export function FileTree({ nodes, selected, onSelect, fileLabel, fileClass }: {
  nodes: TreeNode[]; selected: string | null; onSelect: (path: string) => void;
  fileLabel?: (n: TreeNode) => ReactNode; fileClass?: (n: TreeNode) => string;
}) {
  // Folders expanded by default so a fresh tree is browsable without clicking.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(collectFolders(nodes)));
  const toggle = (p: string) => setExpanded((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });

  const render = (n: TreeNode, depth: number): ReactNode => {
    const pad = { paddingLeft: 8 + depth * 14 } as CSSProperties;
    if (n.isFile) {
      const cls = [fileClass?.(n), selected === n.path ? "sel" : ""].filter(Boolean).join(" ");
      return (
        <button key={n.path} style={pad} className={cls} onClick={() => onSelect(n.path)}>
          <span className="tree-file">{fileLabel ? fileLabel(n) : n.name}</span>
        </button>
      );
    }
    const open = expanded.has(n.path);
    return (
      <div key={n.path}>
        <button style={pad} className="tree-folder" onClick={() => toggle(n.path)}>
          <span className="tree-toggle" aria-hidden>{open ? "−" : "+"}</span>{n.name}
        </button>
        {open && n.children.map((c) => render(c, depth + 1))}
      </div>
    );
  };

  return <div className="tree">{nodes.map((n) => render(n, 0))}</div>;
}

/** Resolve a markdown link href against the current page's path (relative
 *  `./x.md`/`../x.md` or bundle-absolute `/x.md`) into a tree entry path. */
export function resolveRelativeHref(current: string | null, href: string): string {
  const h = href.split(/[?#]/)[0];
  if (!h) return current ?? "";
  if (h.startsWith("/")) return h.replace(/^\/+/, "");
  const dir = current && current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : "";
  const stack: string[] = dir ? dir.split("/") : [];
  for (const p of h.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") stack.pop();
    else stack.push(p);
  }
  return stack.join("/");
}

/** Split a leading YAML frontmatter block from the markdown body so the
 *  renderer shows fields as a header, not <hr>+text noise. */
export function splitFrontmatter(text: string): { meta: [string, string][]; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: [], body: text };
  const meta: [string, string][] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return { meta, body: text.slice(m[0].length) };
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `cd console && npx next build`
Expected: build succeeds (the new file is compiled but not yet imported anywhere).

- [ ] **Step 3: Commit**

```bash
git add console/app/lib/file-tree.tsx
git commit -m "feat(console): shared collapsible file-tree lib extracted from the wiki browser"
```

---

### Task 2: Wiki browser consumes the shared lib (behavior unchanged)

**Files:**
- Modify: `console/app/wikis/[id]/browser.tsx`

**Interfaces:**
- Consumes from Task 1: `buildTree`, `FileTree`, `splitFrontmatter`, `resolveRelativeHref`, `type TreeNode`.
- Produces: nothing new — pure refactor.

- [ ] **Step 1: Swap the local helpers for imports**

In `console/app/wikis/[id]/browser.tsx`:

1. Replace the top of the file (imports through the old `splitFrontmatter`) with the following — `useRef` stays (upload input), `useMemo`/`useState`/`CSSProperties` stay (still used by the component body):

```tsx
"use client";

import { useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { wsHeader } from "../../lib/client";
import { Modal, Field, ConfirmDialog } from "../../lib/modal";
import { Markdown } from "../../lib/markdown";
import { buildTree, FileTree, splitFrontmatter, resolveRelativeHref, type TreeNode } from "../../lib/file-tree";

type Entry = { path: string; file_id: string; updated_at: string };

// Order per level: index.md, then log.md (OKF entry points), then folders,
// then the remaining files — each group sorted alphabetically.
const wikiRank = (n: TreeNode) => {
  if (!n.isFile) return 2;
  const nm = n.name.toLowerCase();
  return nm === "index.md" ? 0 : nm === "log.md" ? 1 : 3;
};
```

2. DELETE the local `TreeNode` type, `buildTree`, `resolveWikiHref`, `splitFrontmatter` (lines 11-72 of the current file) and the trailing `collectFolders` (lines 209-214).

3. In `WikiBrowser`, replace the tree construction + expand state + renderer:

```tsx
  const tree = useMemo(() => buildTree(entries.map((e) => e.path), wikiRank), [entries]);
```

DELETE the `const [expanded, setExpanded] = ...` line, the `const toggle = ...` line, and the whole `function renderNode(...) {...}` (current lines 80, 92, 101-119).

4. Replace the sidebar JSX (current line 133)

```tsx
          <div className="tree">{tree.map((n) => renderNode(n, 0))}</div>
```

with

```tsx
          <FileTree nodes={tree} selected={selected} onSelect={load} />
```

5. In the `Markdown` `onNavigate` callback (current line 169), rename the call `resolveWikiHref(loaded, href)` → `resolveRelativeHref(loaded, href)`.

- [ ] **Step 2: Check the diff for CRLF line-join damage**

Run: `git diff console/app/wikis/[id]/browser.tsx`
Expected: only the described deletions/replacements; no adjacent lines merged.

- [ ] **Step 3: Build**

Run: `cd console && npx next build`
Expected: build succeeds, no unused-import warnings for the wiki page.

- [ ] **Step 4: Commit**

```bash
git add console/app/wikis/[id]/browser.tsx
git commit -m "refactor(console): wiki browser uses the shared file-tree lib"
```

---

### Task 3: Skills viewer — tree + markdown view

**Files:**
- Modify: `console/app/skills/[id]/viewer.tsx`

**Interfaces:**
- Consumes from Task 1: `buildTree`, `FileTree`, `splitFrontmatter`, `resolveRelativeHref`, `type TreeNode`; plus existing `Markdown` (`../../lib/markdown`).
- Produces: `SkillFiles({ files: { path: string; fileId: string }[] })` — same export signature as today (`page.tsx` needs no change). `UpdateSkillButton` untouched.

- [ ] **Step 1: Rewrite `SkillFiles`**

Replace the file's header + `SkillFiles` (current lines 1-52) with the following; keep `UpdateSkillButton` exactly as is below it.

```tsx
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
```

Notes for the implementer:
- `isEntry` tests the full `path` (not the basename), so only the top-level `SKILL.md` is pinned/highlighted — a nested `references/skill.md` is an ordinary file. This matches the current viewer.
- `useRouter`, `Icon`, `Modal`, `useRef` are still used by `UpdateSkillButton` in the same file — keep those imports.
- The old flat list showed full paths as labels; the tree shows basenames with folder rows above — that's the point of the change.

- [ ] **Step 2: Check the diff for CRLF line-join damage**

Run: `git diff console/app/skills/[id]/viewer.tsx`
Expected: `UpdateSkillButton` untouched; no merged lines.

- [ ] **Step 3: Build**

Run: `cd console && npx next build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add console/app/skills/[id]/viewer.tsx
git commit -m "feat(console): skills detail gets the wiki-style folder tree + markdown view"
```

---

### Task 4: Live verification

**Files:** none (verification only).

- [ ] **Step 1: Restart the console on the fresh build**

Kill the running `next start` (if any), then:
Run: `cd console && npx next build && npx next start -p 7090`
(Requires the control plane running on :7080 — start it per CLAUDE.md "Running" if it isn't.)

- [ ] **Step 2: Skills page click-through**

On `http://localhost:7090/skills`, open a skill that has folders (e.g. one with `references/`; if none exists, upload a zip skill package with a `references/` dir via "+ Add skill"). Verify:
1. Sidebar is a tree: folder rows with `+`/`−` toggles that collapse/expand; SKILL.md pinned first, highlighted (`entry` styling) with the `●` marker, and auto-loaded.
2. SKILL.md renders: frontmatter as a header row (name/description fields), body as markdown; "Raw" toggles to the plain text and back.
3. A relative link in SKILL.md to a bundled file (e.g. `references/x.md`) navigates in-pane; an external `https://` link opens a new tab.
4. A non-`.md` file (e.g. a script) shows the raw `<pre>` with no Rendered/Raw button.

- [ ] **Step 3: Wiki regression check**

Open an existing wiki at `/wikis/<id>`: tree renders with folders expanded, `index.md`/`log.md` pinned on top, page renders markdown with frontmatter header, Rendered/Raw toggles, in-pane link navigation works, add-page and delete-page still work.

- [ ] **Step 4: Memory-store untouched check**

Open a memory store at `/memory-stores/<id>`: still the flat path list, load/delete work.

- [ ] **Step 5: Confirm all pages 200**

Spot-check the main nav pages (Dashboard, Sessions, Agents, Skills, Wikis, Memory stores, Deployments) return 200 / render without client-side exceptions (watch the browser console — a chunk exception means the server wasn't restarted after the build).
