# Session status flip + CLI config checkpoint — design

Date: 2026-07-12. Status: approved.

Two independent, live-verified session bugs, each fixed at the root with a
minimal diff.

## Bug 1 — follow-up turns show "starting…" instead of "generating…"

### Root cause (verified live, timestamped)

The trace UI keys its activity label on session status (`trace.tsx:89`):
`queued` → "starting…", `running` → "generating…". The status is wrong for
the whole turn because of a race the control plane itself creates:

1. `POST /v1/sessions/:id/messages` calls `startTurn` (status → `queued`,
   `repo.ts:214`), then appends the **user prompt event**
   (`agents-api.ts:467`).
2. `appendEvents` flips `queued → running` on ANY event append
   (`repo.ts:166`) and fires NOTIFY — so the session is `running` in the DB
   **before the pod exists**.
3. The already-open SSE stream delivers `status: running` to the browser
   milliseconds later — measured 3 ms **before** the route's 202 returns
   (Job creation happens between the append and the 202).
4. On the 202 the console runs `setStatus("queued")` (`trace.tsx:116`),
   clobbering the fresher `running`.
5. The SSE only emits status **on change** (`agents-api.ts:567`) and the DB
   stays `running` all turn, so the client never hears `running` again.
   Measured stream: `idle → running` at 3.086 s, 202 at 3.089 s, then
   silence until `idle` at 10.065 s — "starting…" through the entire
   generation.

This also breaks the documented lifecycle ("queued → running on first
**runner** event", CLAUDE.md): turn 1 shows a false "generating…" while the
pod is still scheduling.

### Fix

In `appendEvents` (`control-plane/src/repo.ts`), gate the flip on the batch
containing a non-`user` event:

```ts
const fromRunner = events.some((e) => e.type !== "user");
// UPDATE … status = CASE WHEN $4 AND status = 'queued' THEN 'running' ELSE status END
```

Token accumulation and NOTIFY are unchanged. No console change: the
optimistic `setStatus("queued")` now matches the server, and the genuine
`queued → running` transition arrives mid-turn via SSE when the runner posts
its first event (`session.created`).

### Call-site audit (all five `appendEvents` callers)

| Site | Event type | Effect under fix |
|---|---|---|
| `agents-api.ts:434` (create) | `user` | no flip — turn 1 stays `queued` until the runner reports (correct) |
| `agents-api.ts:467` (follow-up) | `user` | no flip — the bug's source, fixed |
| `agents-api.ts:518` (interrupt) | `session.interrupted` | status is already `idle`; CASE inapplicable |
| `agents-api.ts:598` (runner callback) | runner events | the intended flip source |
| `reconciler.ts:49` (zombie) | `session.failed` | may transiently flip a `queued` zombie before `setSessionStatus('failed')` — identical to today; terminal state wins |

Consumers that see `queued` for longer: the zombie reconciler keeps a
starting turn alive (the Job still exists during image pull; its filter
already includes `queued`); the console treats `queued` as live (interrupt
available, activity row ticking).

## Bug 2 — CLI config-file warning on every resumed turn

### Root cause (verified live)

`CHECKPOINT_PATHS` covered only the CLI's state dir + `/work`
(`session-runner/runner.py:26`; paths of the legacy CLI runtime).
The CLI's main config is a **file** — a sibling of the CLI's state
**directory** — while its backups go inside that directory under
`backups/`. Every
turn the CLI recreates the file and backs it up; the checkpoint preserves
the backup (inside the state dir) but drops the file, so every resumed turn
starts with the CLI's "configuration file not found … a backup exists"
warning (twice,
CLI startup). Confirmed: turn 4 of `sesn_xedkuhbu86xb` showed the warning
with a fresh backup timestamp. Harmless to the turn (CLI regenerates
defaults; SDK resume uses the state dir's `projects/` subdir, which is
checkpointed) but
noisy and state-lossy.

### Fix

```python
# historical — the CLI runtime's state dir + config file + /work
CHECKPOINT_PATHS = [os.path.expanduser(<cli state dir>), os.path.expanduser(<cli config file>), "/work"]
```

`save_checkpoint` already skips missing paths; `restore_checkpoint`
extracts at `/`. Rebuild the runner image as
`devproof/session-runner:dev21` (same-tag rebuilds are cached by nodes) and
update the CLAUDE.md run note / dev `DEVPROOF_RUNNER_IMAGE`.

## Testing & verification

- **TDD (fix 1):** new `repo.test.ts` integration test (live dev Postgres):
  user-only append on a `queued` session keeps it `queued`; a runner-type
  append then flips it to `running`. Existing roundtrip test (asserts
  `running` after `session.created`) must keep passing. `npm test` +
  `npx tsc --noEmit`.
- **Live (both):** rebuild dev21, restart the CP with the new image, re-run
  the timestamped SSE repro on a 2-turn session — expect
  `queued → running → idle` on the stream with `running` arriving only
  after the pod's first event, and the turn-2 pod log free of the CLI
  config-file warning.

## Out of scope

Batching/cancel lifecycle, SSE payload changes, console changes, and the
reconciler's transient flip (pre-existing, invisible).
