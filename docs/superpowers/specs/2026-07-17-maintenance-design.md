# Maintenance — design (2026-07-17)

Generalize the GC "Storage" feature into a **Maintenance** panel: the existing
orphan sweep plus five new retention-based cleanups (billing, tokens, sessions
×2, files ×2), one schedule, one run-now button, per-section result reporting.

Supersedes the storage/GC portions of `2026-07-14-object-storage-layout-and-gc-design.md`
(the orphan sweep itself is unchanged; its settings/UI/endpoint surface moves).

## Decisions (user-confirmed)

- Billing/token pruning hard-deletes history. Accepted consequences: Usage
  page / deployment / routing stats lose data beyond retention; session
  lifetime token totals (accumulated on the session row) survive and will no
  longer match the Usage page for old sessions; `cost`/`tokens` routing rules
  with windows longer than retention under-count. No validation coupling
  retention to routing windows.
- Billing and tokens are **separate** sections: billing = `cost_entries`,
  tokens = `gateway_usage`. Both default 365 days.
- Session cleanup: `failed` is treated like `idle` (one knob — both are
  resumable). Age = `sessions.updated_at`. Cleanup is a FULL delete identical
  to the manual DELETE route. `queued`/`running` never touched.
- File cleanup pipeline: session cleanup detaches (cascade on
  `session_files`); file cleanup then catches unattached files. An output file
  stays protected while its producing session exists.
- All five retention inputs share one control: integer + `hours|days` dropdown.
- All new cleanups default **off**; the orphan sweep stays on (existing
  behavior). Runner architecture: ONE runner with ordered tasks (approach A),
  orphan sweep last.

## 1. Settings shape & API

`app_settings.data.maintenance` (JSONB key — no migration) replaces `storage`:

```jsonc
"maintenance": {
  "cron": "0 1 * * *",                       // was storage.gcCron
  "orphans":   { "enabled": true },
  "billing":   { "enabled": false, "keep": 365, "unit": "days" },  // cost_entries
  "tokens":    { "enabled": false, "keep": 365, "unit": "days" },  // gateway_usage
  "sessions": {
    "idle":      { "enabled": false, "keep": 7, "unit": "days" },  // idle + failed
    "completed": { "enabled": false, "keep": 4, "unit": "hours" }
  },
  "files": {
    "input":  { "enabled": false, "keep": 4, "unit": "hours" },    // kind=upload
    "output": { "enabled": false, "keep": 4, "unit": "hours" }     // kind=output
  }
}
```

- `getMaintenanceSettings()` (repo) falls back to legacy `storage.gcCron` for
  the cron when `maintenance` is absent — existing installs keep their
  schedule. `PUT /v1/settings` accepts `maintenance` (cron via `validateCron`,
  `keep` integer ≥ 1, `unit` ∈ `hours|days`, booleans) and stops accepting
  `storage`.
- `POST /v1/gc/run` → `POST /v1/maintenance/run`; last-run summary persists
  under `data.maintenanceLastRun`; `gcLastRun` is no longer read.
- Settings-page payload (`agents-api.ts` settings GET for the console) swaps
  `storage`/`gcLastRun` for `maintenance`/`maintenanceLastRun`.

## 2. DB changes — migration `043_file_last_attached.sql`

```sql
ALTER TABLE files ADD COLUMN IF NOT EXISTS last_attached_at TIMESTAMPTZ;
ALTER TABLE files ALTER COLUMN last_attached_at SET DEFAULT now();   -- future inserts
-- Guard is load-bearing: migrate() re-runs every file each boot.
UPDATE files SET last_attached_at = created_at WHERE last_attached_at IS NULL;

CREATE OR REPLACE FUNCTION touch_file_last_attached() RETURNS trigger AS $$
BEGIN
  UPDATE files SET last_attached_at = now()
   WHERE id IN (SELECT DISTINCT file_id FROM new_rows);
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_session_files_touch ON session_files;
CREATE TRIGGER trg_session_files_touch
  AFTER INSERT ON session_files
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION touch_file_last_attached();
```

Semantics: stamped at insert (default), bumped on every attach (statement-level
trigger, 035 idiom — covers all present and future attach paths; the single
current attach site is `repo.ts` `INSERT INTO session_files … ON CONFLICT DO
NOTHING`, where a conflict inserts zero transition rows ⇒ no bump, harmless
since an attached file is ineligible anyway). No bump on detach — eligibility
is "no `session_files` rows AND `last_attached_at` older than cutoff", so a
freed file ages from its last attach.

No other schema: sessions use `status` + `updated_at` (035), billing uses
`cost_entries.ts`, tokens use `gateway_usage.created_at` (016; no
leading-created_at index — the retention delete is a scan, fine at current
scale, no new index).

## 3. Runner — `src/maintenance.ts` (from `gc.ts`)

Cron parse/validate/schedule logic unchanged (minute tick, `running`
re-entrancy guard), reads `maintenance.cron`. Deps grow from `(repo, files)`
to include the orchestrator (for `deleteSessionResources`), wired in
`main.ts`.

`runMaintenance(deps, settings)` executes enabled tasks in a fixed order —
**billing → tokens → sessions → files → orphans** — so a single run detaches
files before file cleanup and the orphan sweep mops up last. Each task is
wrapped per-section: an error is caught, logged, and recorded on that
section's summary (`error` string) without aborting later sections.

1. **Billing** — `DELETE FROM cost_entries WHERE ts < cutoff`; count rows.
2. **Tokens** — `DELETE FROM gateway_usage WHERE created_at < cutoff`; count rows.
3. **Sessions** — eligible: (`status IN ('idle','failed')` AND `updated_at` <
   idle-cutoff) OR (`status='completed'` AND `updated_at` < completed-cutoff),
   restricted to workspaces with `status='active'` (disabled = read-only;
   `deleting` has its own drainer — don't race it). Each deletion goes through
   a helper factored from the existing session DELETE route body
   (`orchestrator.deleteSessionResources` → `repo.deleteSession` → purge
   returned S3 keys), used by both the routes and maintenance. Child sessions
   are governed by their own status/retention (mirrors manual delete).
4. **Files** — eligible: `kind IN ('upload','output')` (per checkbox), zero
   `session_files` rows, `last_attached_at < cutoff`. Delete via
   `deleteFileRecordById` (returns object key only when unshared) +
   `files.del`; sum bytes. Checkpoint/skill/memory kinds remain exclusively
   the orphan sweep's business. `files.session_id` is `ON DELETE SET NULL`,
   so outputs of deleted sessions become eligible naturally.
5. **Orphans** — today's `runGc` body unchanged, incl. its 1h in-flight grace.

Summary (persisted + returned by `POST /v1/maintenance/run`):

```jsonc
{ "at": "…", "ms": 1234, "sections": {
    "orphans":  { "ran": true, "rows": 0, "objects": 0, "bytes": 0 },
    "billing":  { "ran": true, "rows": 0 },
    "tokens":   { "ran": false },                     // ran:false = disabled
    "sessions": { "ran": true, "idle": 2, "completed": 5 },
    "files":    { "ran": true, "input": 1, "output": 0, "bytes": 52428800 }
} }
```

(`error?: string` may appear on any section.)

## 4. Console UI (`console/app/settings/form.tsx`)

The `Storage` accordion becomes **Maintenance** with a new `Icon.wrench`
(added to `app/lib/icons.tsx`). Existing `setrow` grid; saving rides the
page's single "Save settings" button.

Rows, top to bottom:

1. **Maintenance schedule** — the cron input, relabeled; hint unchanged.
2. **Delete orphaned data** — checkbox; hint: "reclaims database rows and
   storage objects that escaped normal deletion — dead checkpoints,
   unreferenced skill/memory files, unclaimed objects".
3. **Clean up billing data** — checkbox + number/unit (365 days); hint:
   "removes time-cost ledger entries older than this — cost history charts
   shrink accordingly".
4. **Clean up token usage** — checkbox + number/unit (365 days); hint:
   "removes gateway token metering older than this — Usage page history
   shrinks; session lifetime totals survive".
5. **Clean up idle & failed sessions** — checkbox + number/unit (7 days);
   hint: "fully deletes sessions (events, checkpoints, work volume) with no
   activity for this long".
6. **Clean up completed sessions** — checkbox + number/unit (4 hours).
7. **Clean up input files** — checkbox + number/unit (4 hours); hint:
   "uploads not attached to any session and last attached longer ago than
   this".
8. **Clean up output files** — checkbox + number/unit (4 hours); same rule
   for session outputs.
9. **Run now** — button **"Run maintenance now"** ("Running…" while busy).
   Status line from `maintenanceLastRun`: `Last run <locale datetime> —
   completed successfully` ("completed with errors" if any section carries
   `error`; "never run" otherwise). Below it, one line per section from the
   latest summary (fresh run response or persisted), e.g.
   `Orphaned data — 0 rows, 0 objects, 0 B reclaimed` ·
   `Billing data — 12 rows removed` · `Token usage — skipped (disabled)` ·
   `Sessions — 2 idle/failed, 5 completed deleted` ·
   `Input files — 1 file, 50.0 MB reclaimed`.

The number+unit control is one small shared component in the form (input +
`hours|days` select, rendered in the hint column like the cron input);
disabled/greyed when the row's checkbox is off. Client-side validation:
integer ≥ 1.

## 5. Testing & verification

Rename/update `test/gc.test.ts`, `test/gc-settings.test.ts`, and the settings
assertions in `agents-api.test.ts` to the maintenance shapes (cron logic tests
untouched). New `test/maintenance.test.ts` (throwaway workspaces use the swept
`t-…` prefix):

- Billing/tokens: old + fresh rows seeded; enabled ⇒ only pre-cutoff rows
  deleted; disabled ⇒ untouched, summary `ran:false`.
- Sessions: idle/failed/completed/queued/running + one disabled-workspace
  session seeded with aged `updated_at`; exactly the eligible ones deleted
  (fake orchestrator records `deleteSessionResources`), cascades + S3 purge
  verified; queued/running/non-active-workspace untouched.
- Files: attached vs. detached uploads/outputs with aged `last_attached_at`;
  only detached-and-old `upload`/`output` kinds go; checkpoint/skill/memory
  never touched by this task.
- Trigger: attaching a file bumps `last_attached_at`; migration idempotency
  exercised by `migrate()` re-running each test boot.
- Settings API: bad `keep`/`unit`/cron ⇒ 400; legacy `storage.gcCron`
  fallback honored.
- Summary: run persists `maintenanceLastRun`; a section error doesn't abort
  later sections.

Verify per project rules: `cd control-plane && npm test` + `npx tsc
--noEmit`; console production build + restart; live check of `/settings`
(panel renders/saves, "Run maintenance now" shows per-section lines, persisted
last-run survives reload).
