# Skill file tree — design

Date: 2026-07-19. Console-only change: the skills detail page gets the same
collapsible folder tree (+/− expand) and markdown viewing as the LLM-wiki
browser. No server, migration, or gateway changes. Memory stores stay flat
(explicit user decision — skills only).

## Problem

`console/app/skills/[id]/viewer.tsx` (`SkillFiles`) renders skill package
files as a flat list of full-path buttons (`references/codex-tools.md` as one
long label) and shows every file as a raw `<pre>`. Multi-folder skill packages
are hard to scan, and SKILL.md's frontmatter renders as `---` noise. The wiki
browser (`console/app/wikis/[id]/browser.tsx`) already solved both: nested
folder tree with `+`/`−` toggles, frontmatter shown as a header, Rendered/Raw
toggle, and in-pane relative-link navigation.

## Approach (chosen: A — extract shared pure pieces)

Rejected: (B) copy the tree logic into `viewer.tsx` — ~80 duplicated lines
that would drift; (C) one shared "package browser" component — the wiki pane's
upload/delete/endpoint specifics make that abstraction leaky.

### New `console/app/lib/file-tree.tsx` ("use client")

Extracted from the wiki browser, generalized:

- `buildTree(entries, rank)` — nested `TreeNode[]` from flat `a/b/c.md`
  paths. The per-level sort is `rank(node)` then alphabetical; `rank` is a
  caller-supplied `(node: TreeNode) => number` so each page pins its entry
  points (wiki: `index.md` 0, `log.md` 1, folders 2, files 3; skills:
  `SKILL.md` 0, folders 1, files 2).
- `FileTree` component — props `{ nodes, selected, onSelect }` plus optional
  `fileLabel?: (node) => ReactNode` (default: the file name) and
  `fileClass?: (node) => string` (merged with `sel`) so the skills page can
  render SKILL.md's `●` marker and its `.entry` highlight class; owns the `expanded`
  set internally (all folders expanded initially, via the existing
  `collectFolders` walk), renders the existing `.tree` / `.tree-folder` /
  `.tree-toggle` / `.sel` CSS classes unchanged. `onSelect` receives the
  file node's `path`.
- `splitFrontmatter(text)` — unchanged extraction.
- `resolveRelativeHref(current, href)` — the wiki's `resolveWikiHref`,
  renamed (it is path math, nothing wiki-specific).

Generic tree nodes carry no wiki `Entry`; `FileTree` deals in paths only and
each page maps path → its own record (`file_id` / `fileId`) at the call site.

### `console/app/skills/[id]/viewer.tsx`

`SkillFiles` keeps its data flow (content via
`GET /api/v1/files/:fileId/content`, no upload/delete) and gains:

- Tree sidebar via `buildTree` + `FileTree` with the SKILL.md-first rank;
  SKILL.md keeps its `●` entry marker and stays auto-loaded on mount.
- Content pane for `.md` files: frontmatter header (`splitFrontmatter` +
  the wiki's `wiki-meta` styling) above the shared `Markdown` renderer, with
  a Rendered/Raw ghost-button toggle (raw = current `<pre>`). Non-`.md`
  files keep the raw `<pre>` with no toggle.
- In-pane link navigation: `Markdown`'s `onNavigate` resolves the href with
  `resolveRelativeHref(loadedPath, href)` and loads it iff it matches a skill
  file path (e.g. SKILL.md → `references/x.md`), same guard as the wiki.

### `console/app/wikis/[id]/browser.tsx`

Mechanical refactor: delete the local `buildTree`/`renderNode`/
`collectFolders`/`splitFrontmatter`/`resolveWikiHref`, import from
`app/lib/file-tree` instead, pass the wiki rank function. Behavior unchanged
(same DOM, same CSS classes, folders expanded by default).

## Error handling

Unchanged from today: content-fetch failures render `error <status>` /
the thrown error string in the pane; a navigated link that doesn't resolve to
a known file is a no-op.

## Verification

Console-only: `npx next build` (includes tsc) + restart `next start`, then
live:
1. Skill with folders (e.g. one with `references/`) → tree shows folders
   collapsible with `+`/`−`, SKILL.md pinned first with `●` and auto-loaded,
   frontmatter as header, Rendered/Raw toggles, relative link in SKILL.md
   navigates in-pane.
2. Non-`.md` skill file → raw `<pre>`, no toggle.
3. Wiki detail page → unchanged behavior (tree, pinned index/log, markdown,
   link nav, add/delete page).
4. Memory-store detail page → untouched (flat list).
