# Real-time Session Token Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Session token totals update live after every model API call (including turns that later fail), with a blink on the header token chip on each update.

**Architecture:** A Postgres trigger on `gateway_usage` (the gateway's per-request metering table, already session-attributed) accumulates into `sessions.tokens_in/out` and NOTIFYs the existing `devproof_session` channel; `appendEvents` stops accumulating event tokens so nothing double-counts; the SSE loop re-sends the totals frame when tokens change; the console chip blinks via a keyed one-shot CSS animation. **No runner/image change** — spec: `docs/superpowers/specs/2026-07-13-realtime-token-usage-design.md`.

**Tech Stack:** Postgres (plpgsql trigger), Node/TS Fastify control plane (node:test), Next.js console.

## Global Constraints

- Migrations re-run EVERY boot (no tracking table) — `027_session_usage_trigger.sql` must be idempotent (`CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`).
- The trigger becomes the SOLE writer of `sessions.tokens_in/out`; `appendEvents` must stop accumulating (old dev26 runners still send `session.result` usage — it must stay display-only).
- Backend tests: `cd control-plane && npm test` (live dev Postgres on `localhost:15432`; tests self-skip if unreachable) and `npx tsc --noEmit`.
- Console is ALWAYS a production build: `cd console && npx next build && npx next start -p 7090`.
- Console UI: no `prompt()`/`confirm()`/`alert()`; respect `prefers-reduced-motion` (existing rule at `globals.css:189`).
- Stop the running control plane before `npm test` (contends on the shared dev Postgres).

---

### Task 1: Migration 027 — gateway_usage → sessions trigger

**Files:**
- Create: `control-plane/sql/027_session_usage_trigger.sql`
- Test: `control-plane/test/session-usage-trigger.test.ts`

**Interfaces:**
- Consumes: `gateway_usage` columns `session_id/tokens_in/tokens_out` (migrations 016+019); `sessions.tokens_in/tokens_out`; NOTIFY channel `devproof_session` (listened by `NotifyHub`, `src/db.ts:43`).
- Produces: trigger `session_usage_accumulate` on `gateway_usage` — later tasks rely on session totals being maintained here and on the NOTIFY waking SSE viewers.

- [ ] **Step 1: Write the failing test**

Create `control-plane/test/session-usage-trigger.test.ts`:

```ts
// Trigger (migration 027): gateway_usage inserts with session_id accumulate
// into sessions.tokens_in/out and NOTIFY devproof_session (live-update push).
// Integration tests against the live dev Postgres; self-skip when unreachable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";

const pool = createPool();
let available = true;
try {
  await pool.query("SELECT 1");
  await migrate(pool);
} catch {
  available = false;
}

test("gateway_usage insert with session_id bumps session totals and notifies", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-trig-${Date.now()}`)).id;
  const agent = await repo.createAgent(ws, `t-trig-${Date.now()}`, { model: "qwen05b-dp", tools: [] });
  const session = await repo.createSession(ws, agent.id, "hello");

  // LISTEN before the insert so the trigger's NOTIFY is observable.
  const listener = await pool.connect();
  const notified = new Promise<string>((resolve) => {
    listener.on("notification", (msg) => { if (msg.payload === session.id) resolve(msg.payload!); });
  });
  await listener.query("LISTEN devproof_session");

  try {
    await pool.query(
      `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, source, session_id)
       VALUES ($1, 'qwen05b-dp', 1000, 50, 'session', $2)`, [ws, session.id]);
    await pool.query(
      `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, source, session_id)
       VALUES ($1, 'qwen05b-dp', 2000, 70, 'session', $2)`, [ws, session.id]);

    const s = await repo.getSession(session.id);
    assert.equal(Number(s.tokens_in), 3000);
    assert.equal(Number(s.tokens_out), 120);
    const raced = await Promise.race([
      notified,
      new Promise<string>((r) => setTimeout(() => r("timeout"), 3000)),
    ]);
    assert.equal(raced, session.id);

    // Unattributed traffic (source='api', no session_id) is a no-op.
    await pool.query(
      `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, source)
       VALUES ($1, 'qwen05b-dp', 5, 5, 'api')`, [ws]);
    assert.equal(Number((await repo.getSession(session.id)).tokens_in), 3000);

    // A session_id that no longer exists must not error (no FK; deletes race inserts).
    await pool.query(
      `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, source, session_id)
       VALUES ($1, 'qwen05b-dp', 7, 7, 'session', 'sesn_gone')`, [ws]);
  } finally {
    listener.removeAllListeners("notification");
    await listener.query("UNLISTEN devproof_session").catch(() => {});
    listener.release();
    await pool.query("DELETE FROM gateway_usage WHERE workspace_id = $1", [ws]);
    await repo.deleteAgent(ws, agent.id); // FK cascade removes session + events
  }
});

test("migration 027 is idempotent — re-running migrate keeps exactly one trigger", { skip: !available }, async () => {
  await migrate(pool); // second run (first was at file load)
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'session_usage_accumulate' AND NOT tgisinternal");
  assert.equal(rows[0].n, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npx tsx --test test/session-usage-trigger.test.ts`
Expected: FAIL — first test asserts `3000` but gets `0` (no trigger yet); the idempotency test also fails (`0` triggers).

- [ ] **Step 3: Write the migration**

Create `control-plane/sql/027_session_usage_trigger.sql`:

```sql
-- Real-time session token totals (spec 2026-07-13-realtime-token-usage):
-- the gateway meters every API call into gateway_usage; session-attributed
-- rows accumulate into the session's totals here, making this trigger the
-- SOLE writer of sessions.tokens_in/out (appendEvents no longer accumulates —
-- the old runner's session.result usage stays display-only, never counted).
-- NOTIFY wakes the session SSE loop so the console header updates live.
-- Idempotent: migrate() re-runs every file each boot.
CREATE OR REPLACE FUNCTION session_usage_accumulate() RETURNS trigger AS $$
BEGIN
  -- No FK on session_id: a deleted session makes this a harmless no-op.
  UPDATE sessions
     SET tokens_in  = tokens_in  + NEW.tokens_in,
         tokens_out = tokens_out + NEW.tokens_out
   WHERE id = NEW.session_id;
  PERFORM pg_notify('devproof_session', NEW.session_id);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS session_usage_accumulate ON gateway_usage;
CREATE TRIGGER session_usage_accumulate
  AFTER INSERT ON gateway_usage
  FOR EACH ROW WHEN (NEW.session_id IS NOT NULL)
  EXECUTE FUNCTION session_usage_accumulate();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd control-plane && npx tsx --test test/session-usage-trigger.test.ts`
Expected: PASS (2 tests). If the dev Postgres is unreachable, tests skip — that is NOT a pass; bring up the cluster first.

- [ ] **Step 5: Commit**

```bash
git add control-plane/sql/027_session_usage_trigger.sql control-plane/test/session-usage-trigger.test.ts
git commit -m "feat(cp): accumulate session token totals from gateway_usage via trigger"
```

---

### Task 2: appendEvents stops accumulating event tokens

**Files:**
- Modify: `control-plane/src/repo.ts:157-195` (`appendEvents`)
- Modify: `control-plane/test/repo.test.ts:36-45` (roundtrip test's totals assertion)

**Interfaces:**
- Consumes: trigger from Task 1 (now the sole totals writer).
- Produces: `appendEvents(sessionId, events)` — same signature and return (final `seq` number); still inserts per-event token columns, still flips `queued → running` on runner events, still NOTIFYs. Only the `sessions.tokens_in/out` accumulation is removed.

- [ ] **Step 1: Update the existing test to the new contract**

In `control-plane/test/repo.test.ts`, the first test ("agent create → version → session → events roundtrip") currently asserts event tokens roll up (line 44). Replace:

```ts
  const s = await repo.getSession(session.id);
  assert.equal(s.status, "running");
  assert.equal(Number(s.tokens_in), 100);
```

with:

```ts
  const s = await repo.getSession(session.id);
  assert.equal(s.status, "running");
  // Event tokens are display-only since migration 027 — session totals are
  // written ONLY by the gateway_usage trigger (see session-usage-trigger.test.ts).
  assert.equal(Number(s.tokens_in), 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npx tsx --test test/repo.test.ts`
Expected: FAIL — roundtrip test gets `100`, expects `0` (appendEvents still accumulates). Other tests in the file pass.

- [ ] **Step 3: Remove the accumulation from appendEvents**

In `control-plane/src/repo.ts`, inside `appendEvents`, delete the `tin/tout` accumulation and replace the combined UPDATE. Before (lines 166-185):

```ts
      let seq = Number(rows[0].s);
      let tin = 0, tout = 0;
      for (const e of events) {
        seq += 1;
        tin += e.tokensIn ?? 0;
        tout += e.tokensOut ?? 0;
        await client.query(
          `INSERT INTO session_events (session_id, seq, type, payload, tokens_in, tokens_out, duration_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [sessionId, seq, e.type, JSON.stringify(e.payload ?? {}),
           e.tokensIn ?? 0, e.tokensOut ?? 0, e.durationMs ?? 0],
        );
      }
      // "running" means the RUNNER reported in — the route's own user-prompt
      // append must not flip a queued session while the pod is still starting.
      const fromRunner = events.some((e) => e.type !== "user");
      await client.query(
        "UPDATE sessions SET tokens_in = tokens_in + $2, tokens_out = tokens_out + $3, status = CASE WHEN $4::boolean AND status = 'queued' THEN 'running' ELSE status END WHERE id = $1",
        [sessionId, tin, tout, fromRunner],
      );
```

After:

```ts
      let seq = Number(rows[0].s);
      for (const e of events) {
        seq += 1;
        await client.query(
          `INSERT INTO session_events (session_id, seq, type, payload, tokens_in, tokens_out, duration_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [sessionId, seq, e.type, JSON.stringify(e.payload ?? {}),
           e.tokensIn ?? 0, e.tokensOut ?? 0, e.durationMs ?? 0],
        );
      }
      // "running" means the RUNNER reported in — the route's own user-prompt
      // append must not flip a queued session while the pod is still starting.
      // Session totals are NOT accumulated here: the gateway_usage trigger
      // (migration 027) is the sole writer of sessions.tokens_in/out; event
      // tokens (e.g. the old runner's session.result usage) are display-only.
      const fromRunner = events.some((e) => e.type !== "user");
      if (fromRunner) {
        await client.query(
          "UPDATE sessions SET status = 'running' WHERE id = $1 AND status = 'queued'",
          [sessionId],
        );
      }
```

(The `SELECT pg_notify(...)` and COMMIT below stay unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npx tsx --test test/repo.test.ts test/session-usage-trigger.test.ts`
Expected: PASS — roundtrip totals now `0`; status-flip test still passes; trigger tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/repo.ts control-plane/test/repo.test.ts
git commit -m "feat(cp): make the gateway_usage trigger the sole writer of session totals"
```

---

### Task 3: SSE re-sends the totals frame when tokens change

**Files:**
- Modify: `control-plane/src/session-sse.ts:28-47`
- Test: `control-plane/test/session-sse.test.ts` (new)

**Interfaces:**
- Consumes: `streamSessionEvents(req, reply, repo, notify, id, after)` (existing export); `repo.getSession` rows with `status/tokens_in/tokens_out/turns`.
- Produces: same SSE frame shape (`event: status` with `{status, tokens_in, tokens_out, turns}`) — now emitted on token changes too. No client protocol change.

- [ ] **Step 1: Write the failing test**

Create `control-plane/test/session-sse.test.ts`:

```ts
// Unit test with fakes — no DB. Scripted getSession results drive the loop;
// the fake notify hub's captured wake fn substitutes for pg NOTIFY.
// NOTE: the loop's 5s heartbeat setTimeout stays armed after the test
// resolves, so the process lingers ~5s at suite end — harmless.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { streamSessionEvents } from "../src/session-sse.ts";

function harness(sessions: any[]) {
  let call = 0;
  const repo = {
    async listEvents() { return []; },
    async getSession() { return sessions[Math.min(call++, sessions.length - 1)]; },
  };
  const chunks: string[] = [];
  const reply = { raw: { writeHead() {}, write(c: any) { chunks.push(String(c)); return true; }, end() {} } };
  const req = { raw: new EventEmitter() };
  let wakeSub: (() => void) | undefined;
  const notify = { subscribe(_id: string, fn: () => void) { wakeSub = fn; return () => {}; } };
  return { repo, reply, req, notify, chunks, wake: () => wakeSub?.() };
}

test("totals frame re-sent when tokens change without a status flip", async () => {
  const h = harness([
    { status: "running", tokens_in: 0, tokens_out: 0, turns: 1 },
    { status: "running", tokens_in: 500, tokens_out: 20, turns: 1 },   // tokens moved, status did not
    { status: "completed", tokens_in: 500, tokens_out: 20, turns: 1 },
  ]);
  const tick = setInterval(h.wake, 5); // stand-in for the trigger's NOTIFY
  try {
    await streamSessionEvents(h.req, h.reply, h.repo, h.notify, "sesn_test", 0);
  } finally {
    clearInterval(tick);
  }
  const frames = h.chunks.filter((c) => c.startsWith("event: status"));
  assert.equal(frames.length, 3);
  assert.match(frames[1], /"status":"running"/);
  assert.match(frames[1], /"tokens_in":500/);
  assert.ok(h.chunks.some((c) => c.startsWith("event: end")));
});

test("unchanged status AND tokens sends no duplicate frame", async () => {
  const h = harness([
    { status: "running", tokens_in: 10, tokens_out: 1, turns: 1 },
    { status: "running", tokens_in: 10, tokens_out: 1, turns: 1 },     // nothing changed
    { status: "completed", tokens_in: 10, tokens_out: 1, turns: 1 },
  ]);
  const tick = setInterval(h.wake, 5);
  try {
    await streamSessionEvents(h.req, h.reply, h.repo, h.notify, "sesn_test", 0);
  } finally {
    clearInterval(tick);
  }
  assert.equal(h.chunks.filter((c) => c.startsWith("event: status")).length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npx tsx --test test/session-sse.test.ts`
Expected: first test FAILS — 2 status frames, not 3 (frame only sent on status change today). Second test passes already.

- [ ] **Step 3: Implement totals-change detection**

In `control-plane/src/session-sse.ts`, replace (lines 28 and 40-47):

```ts
  let lastStatus = "";
```
```ts
      if (s.status !== lastStatus) {
        lastStatus = s.status;
```

with:

```ts
  let lastStatus = "";
  let lastTokens = "";
```
```ts
      // Re-send on token movement too (trigger-driven live totals, spec
      // 2026-07-13) — not just on status flips.
      const tokens = `${Number(s.tokens_in ?? 0)}/${Number(s.tokens_out ?? 0)}`;
      if (s.status !== lastStatus || tokens !== lastTokens) {
        lastStatus = s.status;
        lastTokens = tokens;
```

(The `reply.raw.write(...)` frame body inside the block is unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd control-plane && npx tsx --test test/session-sse.test.ts`
Expected: PASS (2 tests; suite may linger ~5s on armed heartbeat timers).

- [ ] **Step 5: Run the full backend gate**

Run: `cd control-plane && npm test` then `npx tsc --noEmit`
Expected: all tests pass (live-DB tests need the cluster up and the dev CP stopped), tsc clean.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/session-sse.ts control-plane/test/session-sse.test.ts
git commit -m "feat(cp): push session totals over SSE when tokens change"
```

---

### Task 4: Console — blink the header token chip on update

**Files:**
- Modify: `console/app/sessions/[id]/header.tsx:47`
- Modify: `console/app/globals.css` (after the `.pulse` block, lines 186-189)

**Interfaces:**
- Consumes: `totals: Totals` prop (`{tokensIn, tokensOut, turns}`, from `use-session-live.ts`) and `live: boolean` — both already passed to `SessionHeader`.
- Produces: visual only; no exported API.

- [ ] **Step 1: Add the one-shot blink animation to globals.css**

After the `.pulse` block, add (and extend the existing reduced-motion rule at line 189):

```css
/* One-shot blink when the session header token counter updates (keyed remount) */
.chip.tok-tick { animation: tok-blink .6s ease-out; }
@keyframes tok-blink {
  0% { background: color-mix(in srgb, var(--blue) 28%, var(--paper));
       border-color: var(--blue); color: var(--blue); }
}
```

Replace the reduced-motion line:

```css
@media (prefers-reduced-motion: reduce) { .pulse { animation: none; opacity: .8; } a.card:hover { transform: none; } }
```

with:

```css
@media (prefers-reduced-motion: reduce) { .pulse, .chip.tok-tick { animation: none; } .pulse { opacity: .8; } a.card:hover { transform: none; } }
```

- [ ] **Step 2: Key the chip so React remounts it on every totals change**

In `console/app/sessions/[id]/header.tsx`, replace line 47:

```tsx
        <span className="chip">{totals.tokensIn.toLocaleString()} / {totals.tokensOut.toLocaleString()} tok</span>
```

with:

```tsx
        {/* keyed remount restarts the one-shot blink on every totals change;
            static renders of finished sessions must not blink on load */}
        <span className={live ? "chip tok-tick" : "chip"} key={`${totals.tokensIn}/${totals.tokensOut}`}>
          {totals.tokensIn.toLocaleString()} / {totals.tokensOut.toLocaleString()} tok
        </span>
```

- [ ] **Step 3: Production build**

Run: `cd console && npx next build`
Expected: build succeeds, no type errors. (Restart `next start` afterwards — a build under a running server pins old chunk hashes.)

- [ ] **Step 4: Commit**

```bash
git add console/app/sessions/[id]/header.tsx console/app/globals.css
git commit -m "feat(console): blink the session token chip on live updates"
```

---

### Task 5: Live end-to-end verification (per CLAUDE.md "Verify before claiming done")

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything above, deployed against the live docker-desktop cluster.

- [ ] **Step 1: Restart the control plane** (from `control-plane/`; migration 027 applies at boot)

```
DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev26 \
DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files \
npx tsx src/main.ts
```

Expected: boots clean; migration log shows 027 applied without error.

- [ ] **Step 2: Restart the console** (`cd console && npx next start -p 7090` — after Task 4's build) and confirm the touched pages return 200: `/`, `/sessions`, one session detail, `/usage`.

- [ ] **Step 3: Live totals tick + blink.** Start a session on a local-model agent (qwen-medium) with a multi-step prompt (e.g. "Run `echo a`, then `echo b`, then summarize"). Watch the session header: the token chip must update after each model API call (not stay "0 / 0 tok" until idle) and blink on each update. Trace result row still shows its turn total.

- [ ] **Step 4: Failure coverage.** Start a session and interrupt it mid-turn (or let one fail). Expected: the failed/idle session's totals reflect the calls made before the interruption (non-zero), unlike sesn_9c2w9st9bgby.

- [ ] **Step 5: Cross-check against gateway metering.** `kubectl exec -n devproof-system deploy/postgres -- psql -U devproof -d devproof -c "SELECT session_id, sum(tokens_in), sum(tokens_out) FROM gateway_usage WHERE session_id = '<sesn from step 3>' GROUP BY session_id"` — must equal the session header totals exactly.

- [ ] **Step 6: Commit any fixes; report results with evidence** (per superpowers:verification-before-completion).
