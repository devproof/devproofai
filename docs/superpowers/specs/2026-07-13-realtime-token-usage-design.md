# Real-time session token usage — design

**Date:** 2026-07-13 · **Status:** approved (option B, push-upgraded; supersedes the
initially-approved option A after live probes invalidated it)

## Problem

Session token usage is only recorded when a turn ends: the runner attaches
usage solely to the final `session.result` event, taken from the runtime's
turn-cumulative `ResultMessage.usage`. Consequences:

- During a running turn the session header shows **"0 / 0 tok"** until the
  turn completes (observed: sesn_543c2c0j8nl3).
- A turn that **fails mid-way records zero usage** — `session.result` never
  arrives (observed: sesn_9c2w9st9bgby).

Goal: the header total ticks up after every model step, live, including
turns that later fail.

## Investigation (live probes, 2026-07-13)

Ran the legacy runtime from the dev26 runner image against the live gateway
(`usage_probe.py`, one tool-using turn per model):

1. **`AssistantMessage.usage` is all zeros on BOTH paths** — local
   qwen-medium (llama.cpp via the chat/completions bridge) and the remote
   glm-5.2 endpoint. Only `ResultMessage.usage` carries real numbers
   (e.g. 1206 in / 156 out). The CLI accumulates usage internally but does
   not populate it on per-message stream-json output; the field exists in
   the runtime's dataclass but is dead on the wire. **Option A (runner emits
   per-step usage from `AssistantMessage.usage`) is unimplementable**
   without patching the CLI, which we only do for identity strings.
2. **The gateway already meters every API call per-request, in real time,
   with real numbers**: one `gateway_usage` row per model call, landing
   ~1s after call completion (glm probe: 3 calls → 3 rows; qwen: 2 → 2),
   and session traffic carries `session_id` attribution via
   `X-Devproof-Session` (verified rows for sesn_i67b0ysirdvj). Attribution
   headers are trusted only on the internal key — not spoofable.

So the reliable real-time per-step source already exists: `gateway_usage`.

## Decision

**Session token totals become gateway-metered, pushed live.** A Postgres
trigger on `gateway_usage` accumulates into `sessions.tokens_in/out` and
notifies the existing session SSE channel. The runner is untouched (no
image bump); `appendEvents` stops accumulating event tokens so nothing
double-counts.

Rejected:

- **A — runner per-step from `AssistantMessage.usage`**: dead on the wire
  (probe 1). Would require CLI patching.
- **C — hybrid A + reconciliation**: moot; B alone is already billing-grade
  (same source as the Usage page).

## Design

### 1. Migration `027_session_usage_trigger.sql`

Trigger on `gateway_usage`, written idempotently (migrations re-run every
boot — `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` + `CREATE
TRIGGER`):

```sql
AFTER INSERT ON gateway_usage FOR EACH ROW WHEN (NEW.session_id IS NOT NULL)
```

The function adds `NEW.tokens_in/out` to the session's totals
(`UPDATE sessions … WHERE id = NEW.session_id` — a no-op if the session was
deleted; `gateway_usage` has no FK to sessions) and fires
`pg_notify('devproof_session', NEW.session_id)` — the channel the
`NotifyHub`/SSE loop already subscribes to.

Scale posture: one indexed row UPDATE + NOTIFY per model call, inside the
gateway's existing insert transaction — no new queries on the read path.

No backfill: pre-existing sessions keep their event-accumulated totals
(same order of magnitude; cosmetic divergence only). A session running
across the deploy gets old-source totals for past turns + trigger
increments for new calls — monotonic, never double-counted.

### 2. Control plane — `appendEvents` (`src/repo.ts`)

Remove the accumulation of event tokens into `sessions.tokens_in/out`
(the `UPDATE sessions SET tokens_in = tokens_in + …` arm). The trigger is
now the **sole writer** of session totals — this is what makes the old
runner's `session.result` usage (still sent by dev26) harmless rather than
double-counted. Everything else stays: per-event token columns on
`session_events` (the result event still displays its turn total in the
trace), the queued→running status flip, the notify.

Agent observability and dashboard queries source from `sessions` totals —
they stay correct via the trigger.

### 3. Control plane — SSE (`src/session-sse.ts`)

The totals frame (`event: status`) is currently re-sent only when the
status *string* changes. Track last-sent totals alongside `lastStatus` and
resend whenever **status OR tokens** changed. Frame shape unchanged — no
client protocol change. (The trigger's NOTIFY already wakes the loop.)

### 4. Console — token-chip blink (`app/sessions/[id]/header.tsx`, `globals.css`)

Every time the header token chip ("44,475 / 17,137 tok") updates, it pulses
once:

- `globals.css`: one-shot `@keyframes` blink (brief highlight fading back,
  ~0.6 s ease-out) via a chip modifier class. Extend the existing
  `prefers-reduced-motion: reduce` rule (which currently targets `.pulse`)
  to disable this animation too.
- `header.tsx`: re-trigger by React-keying the chip on the totals value
  (`key={tokensIn + "/" + tokensOut}` — remount restarts the animation).
  Modifier class applies only while the session is `live`, so static
  renders of completed/failed sessions don't blink on load.

### 5. Explicitly unchanged

- **Runner / image** — dev26 stays; `session.result` keeps its usage for
  per-turn display in the trace.
- Gateway metering hook (`custom_callbacks.py`) — already writes the rows
  we need.
- External API traffic (`source='api'`, no `session_id`) — trigger skips it.
- Usage page — same `gateway_usage` source as before; session totals and
  the Usage page now agree by construction.

Known limitation (accepted): individual trace rows don't get per-step token
chips — there is no request→event mapping. The header updates per API call;
each turn's result row shows the turn total, as today.

## Failure semantics

Totals accumulate as each API call completes, gateway-side — independent of
the runner surviving to report. A crashed, interrupted, or hard-killed turn
keeps everything metered up to and including its last completed call; even
a stale pod racing an interrupt has its genuine consumption counted (its
*events* are dropped by the turn guard; its tokens were really spent).

## Testing / verification

1. **CP tests** (`npm test`, live-DB harness): trigger fires on a
   `gateway_usage` insert with `session_id` → session totals bump + NOTIFY
   observed; insert without `session_id` → no-op; `appendEvents` no longer
   mutates session totals; migration idempotent across a double `migrate()`.
2. `npx tsc --noEmit`.
3. **Live** (per CLAUDE.md): restart CP + console, run a multi-step session
   — header ticks up after each model call with a blink; trace result rows
   unchanged. Interrupt/fail a turn mid-way — accumulated usage survives on
   the failed session. Usage page totals match the session's.
