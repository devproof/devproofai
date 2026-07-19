# Last-modified timestamps in console tables and crumbs — design

**Date:** 2026-07-15
**Status:** approved

## Goal

Console tables show **Created**. For most resources that is the least
interesting timestamp: an agent edited five minutes ago and one edited last
March both sort and read by their creation date. Replace it with a
last-modified time on the six resources where the row can actually change, and
surface the same value in the detail-page crumbs.

Requested by the operator, 2026-07-15.

## Scope and labels

| Resource | Table header | Crumb | Source |
|---|---|---|---|
| Agents | `Last modified` | `· last modified …` (replaces `created`) | `agents.updated_at` |
| Skills | `Last modified` | `· last modified …` (new) | `skills.updated_at` |
| Sessions | `Last activity` | `· last activity …` (replaces `created`) | `sessions.updated_at` |
| Environments | `Last modified` | — (no detail page) | `environments.updated_at` |
| Credentials Vault | `Last modified` | `· last modified …` (new) | `vaults.updated_at` |
| Memory Stores | `Last modified` | `· last modified …` (new) | `memory_stores.updated_at` |
| Files | `Created` *(unchanged)* | `· created …` (new) | `files.created_at` |

(The operator disliked "Updated" after seeing it live and asked for "Last
modified" instead — same column, same value, relabeled post-ship.)

Format stays `toLocaleString()` — what the crumbs already use. No relative
("2 min ago") times: the lists are server-rendered (`force-dynamic` + `wsGet`),
so relative stamps would need client components and would go stale in place.
Not asked for.

### Why Files keeps "Created"

Files are immutable. There is no `UPDATE files` anywhere in the control plane —
`sha256` and `object_key` are stamped at insert (migration 033, and the
object-key rule in CLAUDE.md is "NEVER derived on read"). A `Last modified`
column would show the creation time on every row forever, i.e. a label
promising something the data cannot deliver. Files still gains a crumb, showing
`created`.

### Why Environments has no crumb

Environments has no detail page — its id opens an edit modal, per the console
convention ("environments open their edit modal from the id"). It gets the
table column only. Building a detail page for one timestamp was rejected as
scope creep.

### Sessions: "Last activity", status changes only

A session's stamp moves on status writes only — **not** on token ticks. This
still captures every meaningful boundary, because `startTurn` flips status back
to `queued` (`repo.ts:320`): turn start, run start, and terminal
idle/completed/failed all move it. A 20-minute streaming turn shows the time
the turn started, which is the intended reading.

Critically, this means **migration 027's `gateway_usage` trigger is not
touched**. That trigger stays the sole writer of `sessions.tokens_in/out`, per
the don't-regress note in CLAUDE.md.

## Two pre-existing lies this fixes (or documents)

1. **Skills.** `repo.ts:866` is
   `UPDATE skills SET file_id = $3, files = $4, version = $5, created_at = now()`.
   The Skills "Created" column has been showing last-modified all along.
   Renaming the header *fixes* a mislabel rather than adding a feature. This
   spec replaces `created_at = now()` with `updated_at = now()`, restoring
   `created_at` to meaning "created".

   **Unrecoverable:** existing skill rows already have `created_at` stomped to
   their last edit. That history is gone and cannot be reconstructed. Nothing
   displays skills' `created_at` after this change, so the loss is inert.

2. **Vault credentials.** `repo.ts:779` does `ON CONFLICT … SET created_at = now()`
   on rotate, so the vault-detail credential list's `Added` column shows the
   rotation time. **Left as-is and documented** — the /vaults list was the
   requested scope, and the credential list is a different table. It does not
   affect correctness here: the statement-level UPDATE trigger fires on the
   rotate regardless, so `vaults.updated_at` is right either way.

## Schema — `sql/035_updated_at.sql`

Six tables: `agents`, `skills`, `sessions`, `environments`, `vaults`,
`memory_stores`. Not `files`.

Three ordered steps per table:

```sql
ALTER TABLE agents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;      -- nullable
UPDATE agents a SET updated_at = GREATEST(a.created_at, COALESCE(
  (SELECT max(v.created_at) FROM agent_versions v WHERE v.agent_id = a.id),
  a.created_at)) WHERE a.updated_at IS NULL;                             -- guarded backfill
ALTER TABLE agents ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE agents ALTER COLUMN updated_at SET NOT NULL;
```

**The `WHERE updated_at IS NULL` guard is load-bearing.** `migrate()` re-runs
every SQL file on every boot (no tracking table). An unguarded backfill would
reset every row to boot time on every restart — silently destroying the very
data this spec adds. Verified: the value survives three consecutive `migrate()`
passes unchanged.

Order matters too: `ADD COLUMN … NOT NULL` without a default fails on a
non-empty table, hence nullable-first. `SET NOT NULL` short-circuits when
already set, so re-runs cost no table scan.

Backfills seed from the best available signal rather than `now()`:

| Table | Seed |
|---|---|
| `agents` | `GREATEST(created_at, max(agent_versions.created_at))` |
| `vaults` | `GREATEST(created_at, max(vault_credentials.created_at))` |
| `memory_stores` | `GREATEST(created_at, max(memory_entries.updated_at))` |
| `sessions` | `GREATEST(created_at, completed_at)` |
| `skills` | `created_at` (already the modify time — see above) |
| `environments` | `created_at` |

## Bump mechanism

Split by what actually changes:

**Statement-level triggers for child-driven changes.** A vault's "update" is a
credential being added/rotated/removed; a memory store's is a session writing an
entry; an agent's is a new version row. Triggers can't drift when a future write
path forgets, and they catch `DELETE` — which a derived `max()` over child rows
cannot see at all (`DELETE FROM memory_entries`, `repo.ts:535`, leaves no
trace). Follows the migration 027 precedent of a trigger as sole writer.

- `memory_entries` INSERT/UPDATE/DELETE → touch `memory_stores`. This is the
  "last modified when the session wrote to the store" requirement, and it comes
  free from the existing diff-sync at `repo.ts:831`.
- `vault_credentials` INSERT/UPDATE/DELETE → touch `vaults` (add, rotate, remove).
- `agent_versions` INSERT → touch `agents` ("each save = new version").

**Statement-level, not row-level — this was decided on measurement, not taste.**
Against the dev database, 2000 child rows:

| | insert 2000 | delete 2000 | parent heap |
|---|---|---|---|
| no trigger | 35ms | 3ms | 8kB |
| **row-level** | 115ms | 56ms | **168kB** |
| **statement-level** | 38ms | 3ms | 8kB |

Row-level fires once per child, so a bulk write becomes N sequential UPDATEs of
the *same* parent row: 3–18× slower and 21× parent-table heap bloat from dead
tuples. On `memory_entries`, the win is on the bulk-delete side: the store-delete
cascade and the `deletes` array in `upsertMemoryEntries` (`repo.ts:842`) would
otherwise fire one parent UPDATE per row — continuous autovacuum pressure on a
small hot table. (`src/gc.ts` does not delete `memory_entries` itself — it only
references them in a `NOT EXISTS`, `repo.ts:1366`.) The insert path doesn't get
the same win today: `upsertMemoryEntries` (`repo.ts:824-837`) writes one row per
`pool.query` in a loop, so a 50-file sync still fires the trigger 50 times
regardless of level — statement-level is never worse, it just isn't better
there yet. Batching that loop into one multi-row `INSERT ... ON CONFLICT` would
collapse it to one UPDATE per sync (future work, not done here). Against the
standing "scale to hundreds, maybe thousands of pods" constraint, statement-
level is still the right default and costs nothing (38ms vs 35ms is noise).

Transition tables force one trigger per event (`NEW TABLE` is invalid for
DELETE, `OLD TABLE` for INSERT), so this is ~7 triggers rather than 3. All
mechanical, all in one migration file:

```sql
CREATE OR REPLACE FUNCTION touch_memory_store_new() RETURNS TRIGGER AS $$
BEGIN
  UPDATE memory_stores s SET updated_at = now()
   WHERE s.id IN (SELECT store_id FROM newtab);
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_memory_store_ins ON memory_entries;
CREATE TRIGGER trg_touch_memory_store_ins AFTER INSERT ON memory_entries
  REFERENCING NEW TABLE AS newtab
  FOR EACH STATEMENT EXECUTE FUNCTION touch_memory_store_new();
-- + UPDATE (NEW TABLE) and DELETE (OLD TABLE, touch_memory_store_old) variants
```

`CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS`/`CREATE TRIGGER` keeps
the file idempotent across boots.

**App-code bumps for rows that mutate themselves:**

| Site | Change |
|---|---|
| `repo.ts:179` | agent status → add `updated_at = now()` |
| `repo.ts:188` | agent rename → add `updated_at = now()` |
| `repo.ts:866` | skills → **replace** `created_at = now()` with `updated_at = now()` |
| `repo.ts:996` | environments → add `updated_at = now()` to the `sets` list |
| `repo.ts:264`, `:299`, `:320` | session status writes → add `updated_at = now()` |

## API — exactly one query changes

Audited exhaustively (`FROM`/`INTO`/`UPDATE` across all six tables). The route
handlers pass repo rows straight through (`return { agents: rows, count, offset }`,
`agents-api.ts:595`) with no field-picking, so `repo.ts` is the only gate.
Almost every read is `SELECT *` / `m.*` / `s.*` and carries the new column for
free.

**`repo.ts:159` (`listAgents`) is the only site needing an edit** — it selects
`a.id, a.name, a.status, a.created_at, v.version, v.model`; add `a.updated_at`.

Explicitly *not* needing a change: `repo.ts:173` (`getAgent`) also has an
explicit list, but it is consumed only by `session-actions.ts:66,122` for the
disabled-check and is never rendered. The agent detail crumb is served by
`getAgentWithVersions` (`repo.ts:214`), a `SELECT *`.

## Console

Six `<th>` swaps, reading `updated_at` instead of `created_at`:
`agents/page.tsx:27`, `skills/page.tsx:20`, `environments/page.tsx:16`,
`vaults/page.tsx:17`, `memory-stores/page.tsx:17`, and `sessions/page.tsx:49`
(→ `Last activity`).

Plus `agents/[id]/tabs.tsx:76` — the sessions list *inside* agent detail — also
becomes `Last activity`, since it is a sessions table with the same semantics.

Crumbs on the six detail pages:

- `agents/[id]/page.tsx:26` — `· created` → `· updated`
- `sessions/[id]/page.tsx:20` — `· created` → `· last activity`
- `vaults/[id]/page.tsx:15`, `skills/[id]/page.tsx:16` — add `· updated`
- `memory-stores/[id]/page.tsx:13` — add `· updated`. **Needs a new fetch:** the
  page currently loads only `/tree` and never reads the store row (its `<h1>` is
  a hardcoded "Memory store").
- `files/[id]/page.tsx:18` — add `· created`, and **remove the now-duplicate
  `Created` row** at `files/[id]/page.tsx:31`, so the crumb carries it exactly
  as on agents and sessions.

Removing `created` from the agent crumb drops an agent's creation time from the
UI entirely — that crumb is its only appearance. Requested explicitly.

## Testing

Node tests (`cd control-plane && npm test`, `--test-concurrency=1` — see
CLAUDE.md, do not parallelise):

- backfill is idempotent: two `migrate()` calls leave a modified value untouched
- backfill seeds from the child signal, not `now()`
- each trigger fires on insert, update, **and** delete
- a session token tick does **not** move `updated_at`; a status flip does
- the skills update no longer moves `created_at`
- cascade delete of a parent with children raises no error

Then `npx tsc --noEmit`, restart CP + console, confirm all pages 200, and
exercise: edit an agent (version save bumps), rename it, toggle status, write to
a memory store from a session, rotate and remove a credential.

## Verified against the dev database

Probed on `postgres://…@127.0.0.1:15432/devproof` before writing this spec:

- backfill seeds from child/created correctly (3.0 and 7.0 days, not `now()`)
- value survives three `migrate()` re-runs
- statement-level triggers bump on insert, update, and delete
- they work under per-row loop inserts (the diff-sync shape), `ON CONFLICT DO
  UPDATE` upserts, zero-row statements (empty transition table, no error), and
  multi-parent fan-out in one statement
- cascade delete of a parent with 300 children: no error, no orphans. The
  parent row is already gone when the child trigger fires, so the touch matches
  zero rows
- explicit children-then-parent delete: no error
- the row-vs-statement cost table above

## Sort decision (post-ship, 2026-07-15)

The review flagged that all six lists still ordered `created_at DESC` while the
column now displayed is `updated_at` — sort and label disagreed. Decision:
lists now `ORDER BY updated_at DESC` on all six tables (`repo.ts`: `listAgents`,
`listSessions`, `listVaults`, `listMemoryStores`, `listSkills`,
`listEnvironments`), including Sessions.

Two new indexes back the tables that grow: `idx_agents_ws_updated` and
`idx_sessions_ws_updated`, both `(workspace_id, updated_at DESC)`
(`sql/035_updated_at.sql`), added alongside — not replacing — the existing
`(workspace_id, created_at DESC)` indexes, which still serve other queries.
Vaults, skills, environments, and memory_stores have no workspace index today,
so no new index was added for them.

**This restores the Skills "re-upload jumps to top" behaviour.** Before this
branch, `createSkill`'s re-upload path stomped `created_at = now()`
(`repo.ts:866`, see "Two pre-existing lies" above), which incidentally kept a
re-uploaded skill first in a `created_at`-ordered list. Fixing that mislabel by
switching the UPDATE to `updated_at = now()` would have *silently* dropped that
behaviour — a re-uploaded skill would sort by its original creation date and
stop floating to the top. Switching `listSkills`' `ORDER BY` to `updated_at`
restores exactly that behaviour, for the right reason this time (a genuine
last-modified sort, not a stomped `created_at`).

## Naming collision to note

`repo.ts:337` (`listStuckSessions`) already computes an alias named
`last_activity`, defined as `GREATEST(created_at, max(session_events.created_at))`
— a **different** definition from the status-only one chosen here. There is no
schema collision (the column is `updated_at`; that alias is local to the
zombie-reconciler query), but two things now read as "last activity" with
different meanings. Add a CLAUDE.md line when this ships.

## Rejected

- **Derive on read** (`max()` over child rows, no new columns). Least code, and
  the memory-store case would come free — but it silently misses deletions:
  removing a credential or a memory file would not move the timestamp.
- **All bumps in app code, no triggers.** Traceable by reading `repo.ts`, but a
  future write path that forgets drifts silently, and every delete path must
  remember too.
- **Row-level triggers.** See the measurement above.
- **Relative timestamps** ("2 min ago"). Needs client components on
  server-rendered lists; not asked for.
- **An environments detail page.** Breaks the modal-edit convention for one
  timestamp.
- **Making files mutable.** Changes file semantics, not a label.

## Future

- Vault credential `Added` → `Last modified`, if the rotate-stomps-created_at
  mislabel is worth fixing.
- Batch `upsertMemoryEntries` into one multi-row `INSERT ... ON CONFLICT` so
  the statement-level trigger also wins on the insert path (see "Bump
  mechanism" above).
