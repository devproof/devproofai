# LLM Wiki — design (2026-07-18)

## Motivation

An **LLM wiki** is a persistent, compounding knowledge artifact: a hierarchical
corpus of markdown files that agents read by mounting it on their filesystem and
reading `index.md` first (karpathy's "LLM wiki" pattern; structure conventions
from Google's **OKF** — Open Knowledge Format). Unlike a memory store (per-session,
always read-write, flat), a wiki is:

- **workspace-scoped** and attachable to **many agents** (like skills), not bound
  to one session;
- **read-only by default**; exactly **one** agent may attach it **read-write**;
- **hierarchical** (folders), browsed as a collapsible tree in the console;
- kept correct through the **existing Delegate/subagents** feature: a read-only
  agent lists the writer agent as a subagent and **delegates corrections** to it.
  The writer is a **single-session** agent, so corrections serialize — no write
  concurrency, no fan-out of wiki-modifying sub-sessions.

The platform stays a **dumb file store** on S3/FileStore (OKF: "consumers MUST
tolerate broken links / missing fields"). OKF/karpathy conventions (`index.md`,
`log.md`, YAML frontmatter, one page per entity, progressive disclosure) are
**content guidance** carried in an editable per-wiki **structure guide** injected
into the writer's prompt — not schema the platform validates.

## Locked decisions

- **Storage = S3/FileStore** (rows → objects, like memory stores/skills/files —
  scales to thousands of pods; the console browser already reads S3 rows). Not a
  git server. **Git-style conventions adopted:** diff-based write-back (only
  changed files upload, as `sync_memory_back` already does) + a `log.md` the
  writer maintains for history. A git-bundle-in-S3 variant is possible future
  work and does not change this design.
- **Write lock:** a wiki has **at most one writer agent** (enforced at agent save
  time, across the latest version of every agent in the workspace). Any agent
  whose latest version holds a **write** wiki ref is a **single-session agent**:
  `createSession` / `startTurn` / delegate-create 409 while another of its
  sessions is queued|running. Read refs are unlimited and impose no lock.
- **Correction flow = Delegate + subagents (existing features, no new tables or
  tools).** A reader agent references the writer agent in its `subagents`; when it
  finds a mistake it delegates a correction. The writer's single-session lock
  serializes writes: a delegate to a busy writer 409s ("writer busy") and the
  reader retries. **New session per correction** (Delegate's normal create-child
  path); the writer can still be followed up via Delegate `session=` continuation.
- **Structure spec = HARDCODED platform convention** (`WIKI_STRUCTURE` in the
  runner), always injected into BOTH the writer's and readers' prompts (OKF/
  karpathy: `index.md` catalog, one page per entity, YAML frontmatter, `log.md`
  history). NOT a user-configurable field — users don't manage wiki structure
  (decision 2026-07-18). Readers also get "navigate via index.md / report errors
  via Delegate"; the writer gets "you are the sole maintainer".

## Data model — migration `044_wikis.sql`

```
wikis
  id           TEXT PK            -- wiki_<shortId>
  workspace_id TEXT NOT NULL
  name         TEXT NOT NULL      -- UNIQUE(workspace_id, name)
  description  TEXT NOT NULL DEFAULT ''
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  -- NO structure_guide: the wiki structure spec is hardcoded in the runner.

wiki_entries                          -- one row per file; content in FileStore
  wiki_id    TEXT NOT NULL REFERENCES wikis(id) ON DELETE CASCADE
  path       TEXT NOT NULL
  file_id    TEXT NOT NULL REFERENCES files(id)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  PRIMARY KEY (wiki_id, path)

agent_versions.wiki_refs  JSONB NOT NULL DEFAULT '[]'
  -- [{ "wikiId": "wiki_..", "mode": "read" | "write" }]
```

- **updated_at trigger:** statement-level transition-table trigger
  `wiki_entries → wikis` (mirrors `memory_entries → memory_stores`, migration
  035). `structure_guide`/`name`/`description` edits bump `updated_at` in `repo`.
  Backfill guarded by `WHERE updated_at IS NULL` (migrate() re-runs every boot).
- **object key** (`object-key.ts`): new kind `wiki` → `<ws>/wiki/<wikiId>/<path>`,
  reusing `validEntryPath`.
- **Drain:** add `wikis` to `DRAIN_TABLES` (`repo.ts`) and to
  `workspace-delete.ts` (FK order: after `memory_stores`, before `files` —
  `wiki_entries.file_id → files`).

## Attachment & write-lock (`src/wiki-refs.ts`, new)

`AgentConfig` gains `wikiRefs?: { wikiId: string; mode: "read" | "write" }[]`.

- `validateWikiRefs(repo, ws, agentId, wikiRefs)`:
  - each `wikiId` exists in the workspace; `mode ∈ {read, write}`; no duplicate
    wikiId in the list;
  - **single-writer:** for each `write` ref, no *other* agent's latest version
    references the same wiki as `write` → else 409
    `"wiki <name> already has a writer agent"`.
- `hasWriteRef(wikiRefs)` = any `mode === "write"` → the agent is single-session.
- No-concurrency: `session-actions` calls `repo.agentHasActiveSession(agentId,
  exceptId?)` (statuses queued|running) before `createSession`/`startTurn`/
  delegate-create when the agent is single-session → 409 `"writer agent allows
  only one active session at a time"`. Applied in the shared path so direct and
  delegated starts are both covered.

## Mount (orchestrator + runner)

**Launch payload** (`session-actions.ts` → `Orchestrator.startSession`): resolve
the pinned agent version's `wiki_refs` into:

```
wikis: [{
  id, name, mode,                 // mode: "read" | "write"
  entries: [{ path, fileId }]
}]
```

**Orchestrator** (`buildTurnJob`): add env `DEVPROOF_WIKIS` = JSON (alongside
`DEVPROOF_MEMORY`).

**Runner** (`runner.py`, image **dev47**):
- `WIKI_DIR = "/mnt/wiki"`. `stage_wikis()` writes each wiki's entries under
  `/mnt/wiki/<name>/`. For the **write** wiki, record a write-back baseline.
- `sync_wiki_back()` (write wiki only): diff vs baseline (like
  `sync_memory_back`); POST `/wiki` callback `{wikiId, entries, deletes}`. Read
  wikis are never written back.
- **Prompt block (`wiki_prompt_block`):** always prepends the HARDCODED
  `WIKI_STRUCTURE` spec (OKF/karpathy conventions), then readers → "navigate via
  `index.md`; do not edit; report errors via Delegate"; writer → "you are the
  sole maintainer of `/mnt/wiki/<name>`; keep `index.md`/`log.md` current." No
  per-wiki config and no new correction tools — corrections arrive as delegated
  turns via the existing Delegate machinery.

## API — `agents-api.ts` (/v1) + `public-api.ts` (/api mirror)

Console/admin (workspace-guarded; add `/v1/wikis` to `workspace-guard` prefixes):
`POST /v1/wikis`, `GET /v1/wikis`, `GET /v1/wikis/:id`, `PATCH /v1/wikis/:id`
(name/description), `DELETE /v1/wikis/:id`,
`GET /v1/wikis/:id/tree`, `GET /v1/wikis/:id/content?path=`,
`POST /v1/wikis/:id/entries` (multipart), `DELETE /v1/wikis/:id/entries?path=`.

Runner callback (session-scoped, CONSOLE_RULES-exempt like `/memory`):
`POST /v1/sessions/:id/wiki` (write-back — validate the session's agent holds a
**write** ref to `wikiId`).

## Console

- `nav.tsx`: `["LLM wikis", "/wikis", "wiki"]` right after Memory stores. New
  `wiki` book icon in `icons.tsx`.
- `/wikis` list + create modal (name, description) — mirrors memory-stores. No
  structure field (the spec is hardcoded).
- `/wikis/[id]`: **collapsible tree browser** (folders built from flat entry
  paths, `+`/`−` to expand) + content pane + add/delete file.
- `agents/agent-form.tsx`: new **Wikis** section — each workspace wiki with a
  mode select (`none` / `read` / `write`); write shows the single-writer note.
  Persisted as `wikiRefs`. `agents/page.tsx` + `agents/[id]/page.tsx` fetch the
  wiki list for the form. (Corrections use the existing **Subagents** section:
  reader agents add the writer agent there.)

## Tests

- `control-plane/test/wikis.test.ts`: CRUD + entries + `validateWikiRefs`
  single-writer 409 + no-concurrency 409. Throwaway workspace prefix
  (`t-wiki-<ts>`), swept by `run-tests.mjs`.
- `session-runner/tests`: `stage_wikis` + `sync_wiki_back` diff behaviour.

## Out of scope (YAGNI)

Git server / native repo, OKF conformance validation, index/log auto-generation,
cross-link graph, per-page history beyond `log.md`, wiki-to-wiki links,
RAG/embeddings, a dedicated suggestion inbox (corrections reuse Delegate).
