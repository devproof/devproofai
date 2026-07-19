# Object storage layout + garbage collection — design

**Date:** 2026-07-14
**Status:** approved

## Problem

Three issues with file storage in MinIO:

1. Objects are keyed by opaque ids (`file_<shortId>`, legacy bare sha256) — browsing
   the bucket tells you nothing about what an object is or who owns it.
2. Orphaned data accumulates. Live audit (2026-07-14): 260 `files` rows vs 169
   objects; 126 checkpoint rows with `session_id = NULL` (46 MB) and 85 of 108
   `skill` rows unreferenced by any skill manifest. Root causes, verified in code:
   - `DELETE /v1/sessions/:id` deletes the session row and the S3 objects but never
     the `files` rows — the FK `files_session_id_fkey` is `ON DELETE SET NULL`
     (`repo.ts deleteSession`, route `agents-api.ts` / `public-api.ts`).
   - Skill re-upload (`createSkill` update branch) overwrites the `files` manifest
     with new file ids; the previous version's file rows + objects are never purged.
     `deleteSkill` deletes only the `skills` row.
3. No safety net: deletes span Postgres + S3 with no transaction across both, so
   best-effort deletes will occasionally leak again (crash mid-delete, kubectl
   bypass).

## Decisions (from brainstorming, 2026-07-14)

- **No migration.** App is in development: one-time wipe of all dev data, then the
  new key scheme is the only scheme that ever exists. Legacy sha256 read-fallback
  code is deleted.
- Hierarchical keys `<workspace>/<resource-type>/<resource-id>[/<path>]`; skill and
  memory leaves use the real manifest/entry path (option A — bucket mirrors the
  actual package layout).
- Recurring GC sweep, cron-configurable in settings (default `0 1 * * *`), plus a
  "Run GC now" button on the console `/settings` page.

## 1. One-time dev wipe (before the new code ships)

Delete, in FK-safe order:

- **Sessions** via `DELETE /v1/sessions/:id` (existing path cleans K8s Jobs,
  `<sesn>-work` PVCs, and objects).
- **Agents, skills, memory stores** via their delete APIs; any remaining `files`
  rows via SQL; then empty the bucket entirely (`mc rm --recursive --force`) —
  every object belongs to a wiped type.
- **Non-default workspaces**: hard delete (dependents first, then the row). No
  tombstones — dev data, no usage attribution worth keeping.
- **Untouched:** environments, vaults + credentials, API keys, webhooks,
  `gateway_usage` / cost ledgers, settings, everything under Serving. None of
  these store data in MinIO.

## 2. Key scheme + FileStore change

Migration `032`: `files.object_key TEXT NOT NULL` + non-unique index (old + new
checkpoint rows share a key for an instant during replacement, so no unique
constraint). The key is **stored at insert, never derived on read**.

| Kind | Key |
|---|---|
| upload / output | `<ws>/files/<file_id>` |
| checkpoint | `<ws>/sessions/<sesn_id>/<file_id>` — replacement deletes the old key (see below) |
| memory | `<ws>/memory/<memstore_id>/<entry path>` |
| skill | `<ws>/skills/<skill_id>/<manifest path>` (e.g. `.../skill_u2j.../scripts/analyze.py`) |

**Checkpoint keys carry the file id (amended during planning):** a single fixed
key per session (`<ws>/sessions/<sesn_id>`, replacement = overwrite PUT) is
unsafe — a stale pod that outlived an interrupt uploads its salvage checkpoint
BEFORE its status post is rejected by the stale-turn guard, so the PUT would
clobber the current turn's checkpoint object. With the file id as leaf, every
checkpoint upload writes a fresh key and replacement deletes the old key, as
today; a stale upload can never touch the live object (its rejected row+object
are reclaimed by the existing guard, or by GC).

- `FileStore` becomes a dumb key-value store: `put(content, key)`, `get(key)`,
  `del(key)`, `getStream(key)`, multipart (`createUpload`/`uploadPart`/
  `completeUpload`/`abortUpload`) keyed the same way. File-id generation moves
  out of `FileStore.put` (which mints `file_<shortId>` today) into the callers,
  which need the id up front to build the key and the `createFileRecord` row.
- Key construction is a pure helper `objectKey(...)` (unit-testable).
- `localFileStore` maps `/` in keys to subdirectories (`mkdir -p` on write).
- The legacy sha256 read-fallback in `filestore.ts` is deleted.
- Skill uploads resolve the skill id **before** storing entries: existing skill by
  name, else pre-generate the id and pass it to `createSkill`.
- Manifest path validation: no duplicate paths, no `..` segments, no leading `/`,
  sane charset. Memory entry paths validated the same way.

## 3. Delete-path fixes (stop leaks at the source)

- `deleteSession` deletes the session's `files` **rows** (not just returns ids);
  the route deletes objects by stored key, as today.
- Skill re-upload: after the manifest swap, delete the previous version's file
  rows + any object keys absent from the new manifest (matching paths were
  overwritten in place by the new PUTs).
- `deleteSkill` and memory-store delete purge their file rows + objects.
- **Shared-key rule** everywhere: delete an object only if no surviving `files`
  row references the same `object_key`.

## 4. GC sweep (safety net, not the primary mechanism)

`src/gc.ts`: pure decision logic + a runner wired like the reconciler. One sweep:

1. **Orphan rows** — checkpoint rows with null/dead session, skill rows in no
   skill manifest, memory rows not in `memory_entries` → delete row, then object
   (shared-key rule).
2. **Orphan objects** — bucket keys matching no `files.object_key`, older than a
   **1-hour grace** (never race an in-flight upload) → delete.
3. **Stale multipart uploads** older than 24 h → abort.

Scheduling: 5-field cron expression in `app_settings` (default `0 1 * * *`),
evaluated by a small pure `cronMatches(expr, date)` on a 60 s timer — no new
dependency. Standard 5-field semantics (min hour dom mon dow; `*`, lists, ranges,
steps). Sweep summary `{rows, objects, bytes, multiparts, at}` stored in
`app_settings` as last-run info.

`POST /v1/gc/run` runs a sweep synchronously and returns the summary (global
admin op, same surface as `/v1/settings`; not workspace-guarded — GC is global).

## 5. Console (`/settings` page)

New accordion panel **"Storage"** in the existing settings accordion:

- Cron field (validated 5-field expression; default `0 1 * * *` shown).
- **"Run GC now"** button next to it → `POST /v1/gc/run`, shows the returned
  summary.
- Last-run line, e.g. "Last run 2026-07-14 01:00 — 3 rows, 3 objects, 1.2 MB
  reclaimed".

## 6. Testing / verification

- Unit (Node test runner): `objectKey`, `cronMatches`, GC decision logic (orphan
  classification, grace period, shared-key rule), manifest path validation.
- Integration against the live cluster: skill re-upload, session delete, memory
  entry replace; confirm the bucket lists only hierarchical keys; run GC via the
  console button; `npm test` + `npx tsc --noEmit`; console pages 200.

## Out of scope

- Any migration of existing objects (wiped instead).
- Workspace-delete drain changes (already purges files correctly).
- Retention/versioning of checkpoints or skill versions (single live version
  stays the model).
