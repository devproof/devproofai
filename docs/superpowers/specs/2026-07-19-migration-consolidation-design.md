# Migration consolidation + tracked migrations (Postgrator) — design

**Date:** 2026-07-19
**Status:** Approved

## Problem

`control-plane/sql/` holds 44 accreted migration files (~963 lines) that `migrate()`
re-runs in full on every boot with no tracking table. Known pain points (documented
in CLAUDE.md): later migrations sometimes require editing earlier files, backfills
need `WHERE` guards or they re-run every boot, and every file must stay idempotent
forever. The application has not been released, so there is no installed base to
migrate — this is the last cheap moment to consolidate to a clean baseline and
switch to a tracked, run-once migration model. The baseline doubles as the
init script for fresh local installations (the CP still migrates at boot).

## Decisions (from brainstorm)

1. **Tracked migrations** via the `postgrator` library (not hand-rolled tracking,
   not the keep-re-running model).
2. **No compat path for existing DBs**: the dev DB is dropped and recreated. No
   baseline-detection logic.
3. **Baseline is hand-curated but pg_dump-seeded**: content is generated from
   `pg_dump --schema-only` of the fully-migrated dev DB (so it originates from the
   true end-state schema), then curated for readability. A mechanical schema diff
   proves the curated file equivalent to the legacy 44-file chain before those are
   deleted.
4. **Forward-only**: no `undo` migration files.

## File layout

- `control-plane/sql/001.do.baseline.sql` — the entire schema. Postgrator naming:
  `[version].do.[description].sql`; versions are numeric and unique (the legacy
  duplicate `026_*` pair would be illegal now — that's a feature).
- Future migrations: `002.do.<description>.sql`, `003.do.<description>.sql`, …
  Plain SQL, run exactly once, **no idempotency guards, no backfill guards, plain
  `ALTER TABLE`**. An applied file is immutable — Postgrator stores an MD5 per
  applied file and **fails the boot if an applied file is later edited**
  (`validateChecksums: true`).
- All 44 legacy `NNN_*.sql` files are deleted (git history keeps them).
- `.gitattributes` gains `control-plane/sql/*.sql text eol=lf` (checksums are
  computed over file bytes; belt-and-braces with the `newline: "LF"` option below
  so Windows/Linux checkouts agree).

## `migrate()` rewrite (`control-plane/src/db.ts`)

Same exported signature `migrate(pool)`, still called at boot by `main.ts` and at
import by ~20 test files — **no caller changes**. New body:

- Keep the existing session-level advisory lock
  (`pg_advisory_lock(hashtext('devproof_migrate'))`) on a dedicated client;
  Postgrator does no locking of its own, so the lock remains what serializes
  concurrent booting replicas and parallel test files.
- Inside the lock, run Postgrator programmatically on that same client:

  ```ts
  const postgrator = new Postgrator({
    migrationPattern: <sqlDir> + "/*",
    driver: "pg",
    database: <db name>,
    schemaTable: "schema_migrations",
    validateChecksums: true,
    newline: "LF",            // normalize CRLF before MD5 (Windows checkouts)
    execQuery: (q) => client.query(q),
  });
  await postgrator.migrate();  // applies pending, validates checksums of applied
  ```

- `schema_migrations` is maintained entirely by the library (version, name, md5,
  run_at).
- Each migration file executes as one multi-statement simple query = one implicit
  transaction (same atomicity as today); on failure the boot fails with the
  offending version in the error.
- Already-migrated boots reduce to a SELECT + checksum validation — this also
  removes the migrate-DDL vs. test-row-lock deadlock class (`40P01`) that forced
  awareness in the test runner.
- New dependency: `postgrator` (^8.x) in `control-plane/package.json`. No other
  new deps (it drives our existing `pg` client via `execQuery`).

## Baseline authoring (`001.do.baseline.sql`)

1. **Generate**: with the current dev DB fully migrated (all 44 files applied),
   `pg_dump --schema-only` it. This is the content source — not a hand-reading of
   44 files.
2. **Curate**: strip dump noise (`SET` preamble, ownership, `COMMENT ON` dump
   artifacts), reorder by domain (workspaces → agents/sessions → files → serving →
   usage/billing → routing → wikis …), and carry forward the load-bearing comments
   from the legacy files (e.g. why `uq_session_events_uid` is a partial unique
   index; the 027-trigger sole-writer rule).
3. **Seeds**: `pg_dump --schema-only` excludes rows, so append the two seed
   inserts manually, both `ON CONFLICT DO NOTHING`:
   - `workspaces`: `('wrkspc_default', 'Default workspace')`
   - `app_settings`: `('global')`
4. **Final trigger/function bodies only**: `session_usage_accumulate` (038's
   body), `gateway_usage_cost_stamp` (032's body), the 035/043/044 touch
   triggers — one definition each.

## Verification (before deleting the legacy files)

A throwaway script (scratchpad, not committed):

1. Create scratch DBs `verify_legacy` and `verify_baseline` on the dev Postgres
   (`localhost:15432`).
2. Apply the 44 legacy files (sorted, as old `migrate()` did) to `verify_legacy`;
   apply `001.do.baseline.sql` to `verify_baseline`.
3. Diff normalized `pg_dump --schema-only` of both (strip `SET`/comment lines and
   ownership; pg_dump ordering is name-stable). **The diff must be empty.** If
   auto-generated constraint names differ (inline vs. ALTER-added `CHECK`s), fix
   the baseline (or name the constraint explicitly) until the diff is empty — do
   not widen the normalizer to hide real differences.
4. Diff seed rows of `workspaces` and `app_settings` between the two DBs.
5. Drop the scratch DBs.

Only after step 3+4 pass are the legacy files deleted.

## Dev environment reset (accepted data loss)

- Drop and recreate the dev database (or `DROP SCHEMA public CASCADE; CREATE
  SCHEMA public;`), then boot the CP — baseline applies fresh.
- Known, accepted consequences:
  - All dev rows are gone (sessions, agents, usage, settings — settings reseed to
    defaults).
  - MinIO objects become unreferenced; left to the existing orphan/GC sweeps.
  - Any per-session `<sesn>-work` PVCs in the cluster lose their DB rows —
    enumerate (`kubectl get pvc -n devproof`) and delete leftovers manually.

## Testing / done criteria

- `cd control-plane && npm test` green; `npx tsc --noEmit` clean.
- New test (`test/migrate.test.ts`): on a scratch schema, `migrate()` applies the
  baseline; a second `migrate()` call is a no-op (`schema_migrations` row count
  unchanged); editing an applied file's bytes makes `migrate()` throw a checksum
  error.
- Verification diff (above) empty before legacy deletion.
- CP + console boot against the reset dev DB; all console pages 200; a touched
  flow exercised live (create workspace-scoped entity, run a session if a model
  is deployed).
- CLAUDE.md updated: migration model section rewritten (tracked/run-once/immutable
  files, Postgrator, checksum rule, "editing an applied file fails the boot" —
  the loud opposite of the old "later migrations may require editing earlier
  files" note). `scripts/run-tests.mjs` note re-checked: `--test-concurrency=1`
  stays (the `app_settings` singleton race is unaffected by this change).

## Out of scope

- Undo/down migrations.
- Any compat/baseline-detection for previously-migrated databases.
- Changing when migrations run (still at CP boot) or the advisory-lock strategy.
- Schema changes themselves — the baseline must be semantically identical to the
  legacy chain's end state.
