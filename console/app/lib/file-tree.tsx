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
        <button key={`${n.isFile}:${n.path}`} style={pad} className={cls} onClick={() => onSelect(n.path)}>
          <span className="tree-file">{fileLabel ? fileLabel(n) : n.name}</span>
        </button>
      );
    }
    const open = expanded.has(n.path);
    return (
      <div key={`${n.isFile}:${n.path}`}>
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
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      // YAML block scalar ('>' folded / '|' literal, optional '+'/'-' chomping):
      // consume the indented (or blank) continuation lines as the value.
      if (/^[>|][+-]?$/.test(value)) {
        const block: string[] = [];
        let j = i + 1;
        while (j < lines.length && (lines[j].trim() === "" || /^\s/.test(lines[j]))) {
          block.push(lines[j].trim());
          j++;
        }
        meta.push([key, block.filter(Boolean).join(" ").trim()]);
        i = j;
        continue;
      }
      meta.push([key, value]);
    }
    i++;
  }
  return { meta, body: text.slice(m[0].length) };
}
