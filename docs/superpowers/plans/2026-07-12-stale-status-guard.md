# Stale-Turn Status Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A late `POST /v1/sessions/:id/status` from an interrupted turn's pod (which survives its SIGTERM window) must not clobber the follow-up turn's state — today it unconditionally overwrites session status (can flip `queued`/`running` back to `idle`, briefly allowing two concurrent pods on one session) and replaces+deletes the checkpoint the follow-up's Job references (interrupt race #2, found by the 2026-07-12 final review of the checkpoint-retry fix).

**Architecture:** Turn-attributed status posts. `startTurn` already increments `sessions.turns` atomically (`repo.ts:216-219`), so the row carries the current turn number. The orchestrator passes the pod its turn as `DEVPROOF_TURN` (the value is already in scope at `orchestrator.ts:193`); the runner echoes it in its `/status` body; `setSessionStatus` gains an optional `reportedTurn` enforced INSIDE the SQL `WHERE` (`turns <= $5`), so the check cannot race a concurrent `startTurn`. A stale post is ignored entirely: no status change, no checkpoint replacement (hence no growth-guard deletion), no webhooks. Backward compatible both directions: a post without `turn` (older runner image) applies as today; the runner sends `turn` only when the env var is present (older CP).

**Semantics change (intended):** in the raced case (interrupt + follow-up already started), the interrupted turn's salvage checkpoint is dropped and the follow-up resumes from the last completed turn's checkpoint — matching the documented resume semantic ("mid-turn progress is lost"). Non-raced interrupts (no follow-up yet: reported turn == `turns`) keep full salvage. This also removes the checkpoint-deletion race at its source; the dev22 404-retry remains as defense-in-depth.

**Tech Stack:** Node/TypeScript (Fastify control plane; Node test runner — fake-repo `app.inject` tests in `test/agents-api.test.ts`, live-Postgres tests in `test/repo.test.ts`), Python session runner, Docker image build, docker-desktop Kubernetes.

## Global Constraints

- Runner image changes REQUIRE a tag bump (`dev22` → `dev23`) — nodes cache same-tag rebuilds. Update every `dev22` reference in `CLAUDE.md`.
- Do not touch the runner's model-identity pieces (`patch_cli_identity.py`, the settings.json contents written in main(), the platform prompt).
- Control plane in dev runs out-of-cluster: `npx tsx src/main.ts` with `DEVPROOF_RUNNER_IMAGE`, `DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000`, `DEVPROOF_S3_BUCKET=devproof-files` (NOT `npm run dev`).
- Never `git add -A` (untracked `operator/devproof-operator-dev.exe`; the user edits `TODO.txt` live — do NOT stage TODO.txt).
- The repo test suite runs against the live dev Postgres (`localhost:15432`); DB-backed tests create their own isolated workspace and cascade-delete it.
- Verification before claiming done: `cd control-plane && npm test` and `npx tsc --noEmit`, plus the live repro in Task 3.
- Non-runner callers of `setSessionStatus` (interrupt route, zombie reconciler) pass no `reportedTurn` and must behave exactly as today.

---

### Task 1: Control plane — atomic stale-turn guard

**Files:**
- Modify: `control-plane/src/repo.ts:183-206` (`setSessionStatus`)
- Modify: `control-plane/src/agents-api.ts:602-614` (`POST /v1/sessions/:id/status` route)
- Modify: `control-plane/src/orchestrator.ts:261` (env list — add `DEVPROOF_TURN` after `DEVPROOF_CHECKPOINT`)
- Test: `control-plane/test/repo.test.ts` (live-DB guard test), `control-plane/test/agents-api.test.ts` (route test + fake-repo update)

**Interfaces:**
- Consumes: existing `sessions.turns` column (incremented by `startTurn`); `session.resume?.turn` already computed as `const turn = session.resume?.turn ?? 0;` at `orchestrator.ts:193` (in scope where the env array is built).
- Produces: `setSessionStatus(sessionId, status, extras?, reportedTurn?)` returning `{ replacedCheckpointFileId: string | null, applied: boolean }` — `replacedCheckpointFileId` is `null` whenever `applied` is false, so the route's existing deletion block needs no extra condition. `POST /v1/sessions/:id/status` accepts optional numeric `turn` in the body and returns `{ ok: true, applied }`. Pods get env `DEVPROOF_TURN` = the turn number as a string (`"0"` for the create turn). Task 2's runner echoes it.

- [x] **Step 1: Write the failing live-DB test**

Append to `control-plane/test/repo.test.ts` (same style as the existing tests — isolated workspace, cascade cleanup, `{ skip: !available }`):

```ts
test("stale-turn status post is ignored atomically; current-turn post applies", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-stale-${Date.now()}`)).id;
  const agent = await repo.createAgent(ws, `t-stale-${Date.now()}`, { model: "qwen05b-dp", tools: [] });
  const session = await repo.createSession(ws, agent.id, "hello"); // turns = 0, status queued

  // Turn 0's pod finishes normally: reportedTurn 0 vs turns 0 — applies.
  const first = await repo.setSessionStatus(session.id, "idle", { checkpointFileId: "file_turn0ckpt" }, 0);
  assert.equal(first.applied, true);
  assert.equal((await repo.getSession(session.id)).status, "idle");

  // Follow-up message: turns -> 1, status queued.
  await repo.startTurn(session.id);

  // The interrupted/stale turn-0 pod reports late: must be ignored ENTIRELY.
  const stale = await repo.setSessionStatus(session.id, "idle", { checkpointFileId: "file_stale00001" }, 0);
  assert.equal(stale.applied, false);
  assert.equal(stale.replacedCheckpointFileId, null); // caller must not delete anything
  const s = await repo.getSession(session.id);
  assert.equal(s.status, "queued");                        // not clobbered
  assert.equal(s.checkpoint_file_id, "file_turn0ckpt");    // not replaced

  // Turn 1's own pod reports: applies and replaces the checkpoint.
  const current = await repo.setSessionStatus(session.id, "idle", { checkpointFileId: "file_turn1ckpt" }, 1);
  assert.equal(current.applied, true);
  assert.equal(current.replacedCheckpointFileId, "file_turn0ckpt");
  assert.equal((await repo.getSession(session.id)).checkpoint_file_id, "file_turn1ckpt");

  // No reportedTurn (old runner image / non-runner callers): applies as today.
  const legacy = await repo.setSessionStatus(session.id, "failed");
  assert.equal(legacy.applied, true);
  assert.equal((await repo.getSession(session.id)).status, "failed");

  await repo.deleteAgent(ws, agent.id); // FK cascade removes the session + events
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npm test`
Expected: the new test FAILS — first at the `stale.applied` assertion (`undefined !== false`) or at `s.status` (`'idle' !== 'queued'`), because today's `setSessionStatus` has no guard and no `applied` in its return. All pre-existing tests still pass.

- [x] **Step 3: Implement the guard in `setSessionStatus`**

In `control-plane/src/repo.ts`, replace the whole `setSessionStatus` method (lines 183-206) with:

```ts
  async setSessionStatus(
    sessionId: string,
    status: "completed" | "failed" | "running" | "idle",
    extras?: { sdkSessionId?: string; checkpointFileId?: string },
    reportedTurn?: number,
  ) {
    // Growth guard: report the checkpoint file this update replaces so the
    // caller can delete it (dedup used to make replacements free).
    let replacedCheckpointFileId: string | null = null;
    if (extras?.checkpointFileId) {
      const { rows } = await this.pool.query("SELECT checkpoint_file_id FROM sessions WHERE id = $1", [sessionId]);
      const prev = rows[0]?.checkpoint_file_id ?? null;
      if (prev && prev !== extras.checkpointFileId) replacedCheckpointFileId = prev;
    }
    // Stale-turn guard: a runner pod that outlived an interrupt must not
    // clobber the follow-up turn's state (status, checkpoint, sdk id). The
    // check lives in the WHERE so it cannot race a concurrent startTurn
    // (turns + 1). reportedTurn undefined — non-runner callers and pods from
    // pre-dev23 images — applies unconditionally, exactly as before.
    const result = await this.pool.query(
      `UPDATE sessions SET status = $2,
         sdk_session_id = COALESCE($3, sdk_session_id),
         checkpoint_file_id = COALESCE($4, checkpoint_file_id),
         completed_at = CASE WHEN $2 IN ('completed','failed','idle') THEN now() ELSE completed_at END
       WHERE id = $1 AND ($5::int IS NULL OR turns <= $5::int)`,
      [sessionId, status, extras?.sdkSessionId ?? null, extras?.checkpointFileId ?? null, reportedTurn ?? null],
    );
    const applied = (result.rowCount ?? 0) > 0;
    if (applied) await this.pool.query("SELECT pg_notify('devproof_session', $1)", [sessionId]);
    return { replacedCheckpointFileId: applied ? replacedCheckpointFileId : null, applied };
  }
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd control-plane && npm test`
Expected: the new repo test PASSES. (agents-api tests unaffected so far — the fake repo's looser return shape is updated in Step 5.)

- [x] **Step 5: Write the failing route test (and update the fake repo)**

In `control-plane/test/agents-api.test.ts`:

(a) In `fakes()`, make `createSession` also set `turns: 0` on the session object it pushes (add `turns: 0` to the object literal at the `const s = {...}` line).

(b) Make the fake `startTurn` increment turns: inside the existing `startTurn` after `s.status = "queued";` add `s.turns = (s.turns ?? 0) + 1;` and return that value as `turn` (`return { turn: s.turns, ... }` instead of the hardcoded `turn: 1`).

(c) Replace the fake `setSessionStatus` with a turn-aware version that mirrors the real semantics (keeping the existing legacy-id quirks for the tests that rely on them):

```ts
    async setSessionStatus(id: string, status: string, extras?: { checkpointFileId?: string }, reportedTurn?: number) {
      const s = sessions.find((x) => x.id === id);
      if (s && reportedTurn !== undefined && (s.turns ?? 0) > reportedTurn) {
        return { replacedCheckpointFileId: null, applied: false }; // stale post: no mutation
      }
      if (s) s.status = status;
      if (!extras?.checkpointFileId) return { replacedCheckpointFileId: null, applied: true };
      // "file_trigger_legacy" simulates a checkpoint replacing a pre-overhaul,
      // content-addressed id (file_<sha256>) rather than a new short id.
      const replaced = extras.checkpointFileId === "file_trigger_legacy" ? "file_" + "a".repeat(64) : "file_old000000001";
      return { replacedCheckpointFileId: replaced, applied: true };
    },
```

(d) Append the route test:

```ts
test("stale-turn runner status post does not clobber a follow-up turn", async () => {
  const { app, files } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "stale", model: "m" } })).json();
  const s = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "first" } })).json();

  // Turn 0 finishes (turn attributed, matches turns=0): applies.
  const t0 = await app.inject({ method: "POST", url: `/v1/sessions/${s.id}/status`, payload: { status: "idle", turn: 0 } });
  assert.equal(t0.json().applied, true);

  // Follow-up: turns -> 1, status queued.
  const fu = await app.inject({ method: "POST", url: `/v1/sessions/${s.id}/messages`, payload: { prompt: "again" } });
  assert.equal(fu.statusCode, 202);

  // The interrupted turn-0 pod reports late with a checkpoint: ignored, no deletion.
  const delsBefore = files.delCalls.length;
  const stale = await app.inject({
    method: "POST",
    url: `/v1/sessions/${s.id}/status`,
    payload: { status: "idle", turn: 0, checkpointFileId: "file_stalecp001" },
  });
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.json().applied, false);
  assert.equal(files.delCalls.length, delsBefore); // growth-guard deletion NOT triggered
  const detail = (await app.inject({ method: "GET", url: `/v1/sessions/${s.id}` })).json();
  assert.equal(detail.status, "queued"); // not clobbered back to idle

  // A post WITHOUT turn (pre-dev23 pod) still applies — backward compatible.
  const legacy = await app.inject({ method: "POST", url: `/v1/sessions/${s.id}/status`, payload: { status: "idle" } });
  assert.equal(legacy.json().applied, true);
});
```

Run: `cd control-plane && npm test`
Expected: the new route test FAILS at `stale.json().applied` (route does not pass `turn` through yet — the fake's guard never sees a `reportedTurn`). Pre-existing tests all still pass (the fake now returns `applied: true` on all previously-existing paths).

- [x] **Step 6: Implement the route change and the orchestrator env**

In `control-plane/src/agents-api.ts`, replace the `POST /v1/sessions/:id/status` route (lines 602-614) with:

```ts
  app.post("/v1/sessions/:id/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { status: "completed" | "failed" | "idle"; sdkSessionId?: string; checkpointFileId?: string; turn?: number };
    if (!["completed", "failed", "idle"].includes(b?.status)) return reply.code(400).send({ error: "bad status" });
    // Stale-turn guard: a pod that outlived an interrupt reports a turn lower
    // than the session's current one — ignore the whole post (status,
    // checkpoint, webhooks). Posts without a turn (pre-dev23 images) apply.
    const reportedTurn = typeof b.turn === "number" ? b.turn : undefined;
    const { replacedCheckpointFileId, applied } = await repo.setSessionStatus(id, b.status, b, reportedTurn);
    if (replacedCheckpointFileId && guardDeletable(replacedCheckpointFileId)) {
      // Best effort — a stale checkpoint must never fail the status update.
      repo.deleteFileRecordById(replacedCheckpointFileId).catch(() => {});
      Promise.resolve(files.del?.(replacedCheckpointFileId)).catch(() => {});
    }
    if (applied) deliverWebhooks(repo, id, b.status).catch(() => {}); // fire-and-forget
    return { ok: true, applied };
  });
```

In `control-plane/src/orchestrator.ts`, directly after the `DEVPROOF_CHECKPOINT` env entry (line 261), add:

```ts
                      { name: "DEVPROOF_TURN", value: String(turn) },
```

(`turn` is the local computed at line 193: `const turn = session.resume?.turn ?? 0;` — the same value used in the Job name.)

- [x] **Step 7: Run tests and typecheck to verify they pass**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: all tests PASS (both new tests and all pre-existing ones); tsc clean.

- [x] **Step 8: Commit**

```bash
git add control-plane/src/repo.ts control-plane/src/agents-api.ts control-plane/src/orchestrator.ts control-plane/test/repo.test.ts control-plane/test/agents-api.test.ts
git commit -m "fix(cp): stale-turn guard — a late runner status post cannot clobber a follow-up turn

An interrupted turn's pod survives its SIGTERM window and posts
/status late; that post unconditionally overwrote session status
(clobbering the follow-up's queued/running back to idle, briefly
allowing two concurrent pods) and replaced+deleted the checkpoint the
follow-up's Job references (interrupt race #2, 2026-07-12 review).
Pods now receive DEVPROOF_TURN and echo it; setSessionStatus enforces
turns <= reportedTurn inside the UPDATE's WHERE (atomic vs concurrent
startTurn) and reports applied=false, skipping checkpoint deletion
and webhooks. Posts without a turn (pre-dev23 pods, interrupt route,
reconciler) apply unconditionally as before."
```

---

### Task 2: Runner echoes its turn; ship image dev23

**Files:**
- Modify: `session-runner/runner.py` (env read near the other env constants; both `post("/status", ...)` call sites)
- Modify: `CLAUDE.md` (both `dev22` references: the run command block and the "Session runner image" bullet)

**Interfaces:**
- Consumes: env `DEVPROOF_TURN` (Task 1's orchestrator change; may be ABSENT under an older control plane — then no `turn` is sent and the CP applies the post as today).
- Produces: image `devproof/session-runner:dev23`; `/status` bodies carry `"turn": <int>` when `DEVPROOF_TURN` is set. Task 3 starts the CP with `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev23`.

- [x] **Step 1: Read the env and include it in both status posts**

In `session-runner/runner.py`, after the `CHECKPOINT_ID = os.environ.get("DEVPROOF_CHECKPOINT", "")` line, add:

```python
TURN = os.environ.get("DEVPROOF_TURN")  # None under a pre-guard control plane
```

Add a small helper next to `post()` (after the `post` function definition):

```python
def post_status(body: dict) -> None:
    """Status posts carry this pod's turn so the CP can drop stale reports
    from a pod that outlived an interrupt (guard is CP-side; absent TURN —
    older control plane — omits the field and the post applies as before)."""
    if TURN is not None:
        body["turn"] = int(TURN)
    post("/status", body)
```

Replace BOTH existing `/status` call sites with `post_status`:

1. The end-of-turn post (currently at the bottom of `main()`):
```python
    post_status({"status": "failed" if (crash or result_error) else "idle",
                 "sdkSessionId": sdk_session_id, "checkpointFileId": checkpoint_id})
```
2. The crash-path post in the `__main__` handler:
```python
            post_status({"status": "failed"})
```

Verify: `python -m py_compile session-runner/runner.py` passes, and `grep -n 'post("/status"' session-runner/runner.py` returns nothing (both sites converted).

- [x] **Step 2: Build the image with the bumped tag**

Run: `docker build -t devproof/session-runner:dev23 session-runner/` (from the repo root)
Expected: build succeeds, INCLUDING the `patch_cli_identity.py` step (cached is fine; a loud failure there means an SDK change — report BLOCKED, do not bypass).

- [x] **Step 3: Update CLAUDE.md tag references**

In `CLAUDE.md`: change `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev22` to `...:dev23` in the run block, and in the "Session runner image" bullet change `(current dev22; ...` to `(current dev23; ...`. `grep -n dev22 CLAUDE.md` must return nothing afterwards.

- [x] **Step 4: Commit**

```bash
git add session-runner/runner.py CLAUDE.md
git commit -m "fix(runner): status posts carry the pod's turn for the CP stale-turn guard (dev23)"
```

---

### Task 3: Live verification (deterministic stale-post injection)

**Files:**
- Create: none in the repo (throwaway scripts go to the session scratchpad)

**Interfaces:**
- Consumes: image `devproof/session-runner:dev23` (Task 2); CP with the guard (Task 1).
- Produces: verification evidence; no code. Updates the checkboxes in this plan.

The repro injects the stale post deterministically: after POSTing a follow-up message (turns is now 1), it immediately posts a turn-0 status report — exactly what a surviving interrupted pod does — during the ~10s pod-scheduling window.

- [x] **Step 1: Restart the control plane on dev23**

Stop the dev CP process on port 7080, then from `control-plane/` (backgrounded):

```bash
DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev23 \
DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files \
npx tsx src/main.ts
```

Wait for `curl -s http://localhost:7080/healthz` → `{"ok":true}`.

- [x] **Step 2: Run the stale-post repro**

Scripted (scratchpad, against `http://localhost:7080`, header `X-Devproof-Workspace: wrkspc_default` on non-runner calls):

1. Create an agent (`qwen05b-dp`, tools `[]`), create a session (prompt "Reply with only the word OK."), wait for `idle` (≤180s). Record `checkpoint_file_id` as `CKPT0` — it must be non-null (proves the turn-0 pod's turn-attributed final post APPLIED).
2. `POST /v1/sessions/:id/messages` `{"prompt": "Reply with only the word DONE."}` → 202.
3. IMMEDIATELY (no sleep): `POST /v1/sessions/:id/status` with `{"status":"idle","turn":0,"checkpointFileId":"file_fakestale01"}` → expect `200 {"ok":true,"applied":false}`.
4. Right after: `GET /v1/sessions/:id` → status MUST be `queued` (or `running` if the pod already reported), NOT `idle`; `checkpoint_file_id` MUST still be `CKPT0`.
5. Wait for the turn to finish (≤180s): final status `idle`.

- [x] **Step 3: Verify the contract**

All of the following:

1. Step 2.3 returned `applied: false` and Step 2.4 showed no clobber (status not `idle`, checkpoint still `CKPT0`).
2. The follow-up turn completed normally: events show a final `session.result` with `"is_error": false` after the follow-up prompt, session `idle`.
3. NO `session.checkpoint_replaced` event and NO `session.failed` event anywhere — the stale post no longer triggers the checkpoint-deletion race, so the dev22 retry path stays dormant.
4. The turn-1 Job's pod spec carries the env: `kubectl get job -n devproof-agents <sesn...-t1> -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="DEVPROOF_TURN")].value}'` → `1`.
5. Regression: one more follow-up ("Reply with only the word THIRD.") with no interference completes to `idle`, and its final turn-attributed status post applied (session reaches `idle` — the guard does not block a pod's own report).

- [x] **Step 4: Clean up and close out**

Delete the test agent (cascades the session); confirm it is gone from the agent list. Mark all checkboxes in this plan, commit the plan update:

```bash
git add docs/superpowers/plans/2026-07-12-stale-status-guard.md
git commit -m "docs: stale-status-guard plan executed and verified"
```
