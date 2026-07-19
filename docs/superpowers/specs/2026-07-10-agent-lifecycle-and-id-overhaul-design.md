# Agent lifecycle + ID overhaul — design

Date: 2026-07-10. Status: approved by Carsten (follow-ups to disabled agents
blocked too; base36 12-char IDs; files drop content-addressing entirely —
duplicates are fine; click-reversal scoped to Managed Agents; file-ID click =
download; checkpoint/memory replacement deletes the old file).

Five improvements: agents can be disabled/re-enabled; every entity gets a
short lowercase ID; files stop being content-addressed; Managed Agents tables
show the full ID as the clickable element; detail pages get a copy-ID button.

## A. Agent enable/disable

- Migration `020_agent_status.sql`:
  `ALTER TABLE agents ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';`
- `repo.setAgentStatus(workspaceId, id, status)` → UPDATE, returns row count
  (0 = unknown id). `repo.getAgent`/list rows now carry `status`.
- Route `POST /v1/agents/:id/status { status: "active" | "disabled" }`:
  400 on bad status, 404 on unknown id, `{ok: true}` otherwise.
- Enforcement (both return **409 `{error: "agent disabled"}`**):
  - `POST /v1/sessions` — checked before `createSession`.
  - `POST /v1/sessions/:id/messages` — checked before `startTurn` (a RUNNING
    turn is never interrupted; only new work is refused).
- Console:
  - The hardcoded "Active" badge becomes real on the agents list and the
    agent detail header: `phase Ready`/"Active" vs `phase bad`/"Disabled".
  - Agent detail header gains a ghost toggle button next to Create session:
    **Disable** (with ConfirmDialog: "New sessions and follow-up messages
    will be rejected; running turns finish.") when active, **Enable**
    (no confirm) when disabled.
  - Create-session dropdowns (sessions page + agent detail) exclude disabled
    agents; the agent-detail Create-session button is hidden while disabled.

## B. Short IDs (new entities only)

- `rid(prefix)` in `repo.ts` → `prefix_` + 12 chars of base36 (`a-z0-9`),
  derived from `randomBytes(16)` via BigInt → `.toString(36)` → take 12 chars
  (pad with a random-safe fallback if shorter): ~62 bits of randomness.
- Applies automatically to every `rid()` caller (agents, versions, sessions,
  skills, vaults, environments, memory stores, webhooks, api keys, …).
- Existing long hex IDs remain valid and unchanged; both formats coexist.
  No migration, no route changes (IDs are opaque TEXT everywhere).
- `gateway-secret.ts` internal key and `wrkspc_default` are untouched.

## C. Files: no more content-addressing

- `s3FileStore.put(content)` → id = `file_<rid-style 12 base36>`, S3 object
  key = the id (was: sha256). `sha256` still computed and returned/stored as
  an informational column. `localFileStore` already uses random ids — align
  its id length/charset. `get`/`del` key by id (strip `file_` prefix rule
  replaced by full-id keys; keep backward compat: objects stored under the
  OLD sha256 keys must stay retrievable — `get` falls back to the legacy
  `id.replace(/^file_/, "")` key when the new-style key is absent, which is
  exactly the current behavior since legacy ids embed their hash).
- `repo.createFileRecord` → plain INSERT (drop `ON CONFLICT (id) DO
  NOTHING`). Every upload = its own row: duplicates are fine (user decision).
  This removes the documented cross-workspace metadata-shadowing limitation
  and the skill-republish dedup quirk — delete the CLAUDE.md bullet.
- **Growth guards** (dedup used to mask these):
  - Checkpoints: when a session's `checkpoint_file_id` is replaced, delete
    the previous file row + stored object (best effort).
  - Memory sync: when `upsertMemoryEntries` replaces an entry's `file_id`,
    delete the replaced file row + object (best effort).
  - Uploads/outputs/skills are user-visible and accumulate normally.

## D. Full IDs, clickable — Managed Agents tables

Convention reversal (supersedes the name-click rule from the 2026-07-10
platform-improvements batch, Managed Agents scope only): **the full ID
(never truncated) is the clickable element; names are plain text.**

- Agents: ID cell = full id, Link → detail. Name plain.
- Sessions: ID cell = full id, Link → detail. Name plain (drop the name-link
  fallback added last batch).
- Memory stores: ID = Link → detail. Name plain.
- Skills: NEW leading ID column = Link → detail. Name plain.
- Vaults: NEW leading ID column = Link → detail. Name plain.
- Files: NEW leading ID column; clicking the ID downloads the file (same
  action as the row's download button — files have no detail page). Name
  plain; the Sessions-count link stays.
- Environments: ID (full) becomes the edit-modal opener (namebtn styling on
  the id, `font-mono`); name plain.
- Serving (Catalog/Pools/Deployments) untouched — keyed by name.
- Legacy 30-char ids display in full too (they are the widest realistic
  cell; tables already scroll inside `.tablewrap`).

## E. Copy-ID button on detail pages

- Shared client component `console/app/lib/copy-id.tsx`:
  `CopyId({ id })` — renders `<code>{id}</code>` + a small icon button
  (clipboard glyph, quiet row-icon style) calling
  `navigator.clipboard.writeText`, flipping to a check/"copied" state for
  ~1.5s. No browser alert.
- Placement (ID always displayed at the top): agent detail, session detail,
  skill detail, memory-store detail, vault detail — in the existing
  `<p className="sub">` header line, replacing the bare `<code>{id}</code>`.
- Environment edit modal: subtitle shows `CopyId` (environments have no
  detail page).

## Failure & scale posture

- Status check adds one indexed PK lookup per session-create/message — noise.
- Base36 12-char ids: collision probability negligible below ~10^7 entities
  per type; PK violation would surface loudly if ever hit.
- Dropping byte dedup: storage grows with actual duplicate uploads — accepted
  (user decision); checkpoint/memory guards prevent the two unbounded loops.

## Verification

- CP tests: status route (400/404/ok); 409 on session create + follow-up for
  disabled agent, success after re-enable; `rid` format
  `/^[a-z0-9]{12}$/` and uniqueness over a large sample; duplicate upload →
  two distinct rows; checkpoint replacement deletes the old file row; memory
  upsert replacement deletes the old file row.
- `npm test` + `npx tsc --noEmit` + console production build.
- Live gates: disable the `test` agent → API session-create 409 + follow-up
  409, running turn completes, re-enable restores; upload the same file twice
  → two rows, both downloadable; browser pass over all seven managed lists
  (full-ID links, plain names) + copy buttons on all five detail pages +
  environment modal; new entities show 12-char base36 ids; old ids still
  resolve.
- CLAUDE.md: ID convention (base36-12, legacy hex coexists), remove the
  file-dedup known-limitation bullet, agent-status semantics, click-rule
  update in the Dialogs bullet.
