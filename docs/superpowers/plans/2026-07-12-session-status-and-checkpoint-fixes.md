# Session Status Flip + CLI Config Checkpoint Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two verified session bugs: (1) follow-up turns show "starting…" for the whole turn because the control plane flips a session to `running` when it appends the user prompt event; (2) every resumed turn logs the CLI's "configuration file not found" warning because the CLI's config file (of the legacy CLI runtime) is not in the runner's checkpoint paths.

**Architecture:** Fix 1 gates the `queued → running` flip in `Repo.appendEvents` on the batch containing a non-`user` event, so only runner-posted events flip the status (restores the documented lifecycle; no console change needed). Fix 2 adds the CLI's config file to `CHECKPOINT_PATHS` in the session runner and ships it as image tag `dev21`.

**Tech Stack:** Node/TypeScript (Fastify control plane, Node test runner against live dev Postgres on `localhost:15432`), Python session runner, Docker image build, docker-desktop Kubernetes.

**Spec:** `docs/superpowers/specs/2026-07-12-session-status-and-checkpoint-fixes-design.md`

## Global Constraints

- Runner image changes REQUIRE a tag bump (`dev20` → `dev21`) — nodes cache same-tag rebuilds. Update every `dev20` reference in `CLAUDE.md`.
- The repo test suite runs against the live dev Postgres (`localhost:15432` via `deploy/dev/localhost-lb.yaml`); tests must create their own isolated workspace and cascade-delete it (debris shows in the console).
- Control plane in dev runs out-of-cluster: `npx tsx src/main.ts` with `DEVPROOF_RUNNER_IMAGE`, `DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000`, `DEVPROOF_S3_BUCKET=devproof-files` (NOT `npm run dev` — it exits under tool backgrounding).
- Do not touch the runner's model-identity pieces (`patch_cli_identity.py`, settings.json, platform prompt).
- Verification before claiming done: `cd control-plane && npm test` and `npx tsc --noEmit`, plus the live-cluster flow exercise from Task 3.

---

### Task 1: Gate the `queued → running` flip on runner events

**Files:**
- Modify: `control-plane/src/repo.ts:143-178` (`appendEvents`)
- Test: `control-plane/test/repo.test.ts`

**Interfaces:**
- Consumes: existing `Repo` methods — `createWorkspace(name) → {id}`, `createAgent(ws, name, config) → {id, version}`, `createSession(ws, agentId, prompt, name?) → {id}`, `appendEvents(sessionId, events) → seq`, `getSession(id)`, `deleteAgent(ws, id)`.
- Produces: `appendEvents(sessionId, events)` keeps its signature; behavior change only — a batch whose events are ALL `type: "user"` no longer changes session status. Callers (`agents-api.ts:434/467/518/598`, `reconciler.ts:49`) need no changes.

- [ ] **Step 1: Write the failing test**

Append to `control-plane/test/repo.test.ts` (after the first roundtrip test, same style — isolated workspace, cascade cleanup):

```ts
test("user-event appends do not flip queued → running; runner events do", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-flip-${Date.now()}`)).id;
  const agent = await repo.createAgent(ws, `t-flip-${Date.now()}`, { model: "qwen05b-dp", tools: [] });
  const session = await repo.createSession(ws, agent.id, "hello");

  // The route appends the user prompt event before the pod exists (agents-api.ts:434/467).
  // That append must NOT flip the status — "running" means the runner reported in.
  await repo.appendEvents(session.id, [{ type: "user", payload: { text: "hello", turn: 0 } }]);
  assert.equal((await repo.getSession(session.id)).status, "queued");

  // First runner event flips it (documented lifecycle: queued → running on first runner event).
  await repo.appendEvents(session.id, [{ type: "session.created", payload: {} }]);
  assert.equal((await repo.getSession(session.id)).status, "running");

  await repo.deleteAgent(ws, agent.id); // FK cascade removes the session + events
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npm test`
Expected: the new test FAILS with `'running' !== 'queued'` on the first assertion (the user-event append currently flips the status). All pre-existing tests still pass.

- [ ] **Step 3: Implement the gated flip**

In `control-plane/src/repo.ts`, `appendEvents`, replace the status UPDATE:

```ts
      // "running" means the RUNNER reported in — the route's own user-prompt
      // append must not flip a queued session while the pod is still starting.
      const fromRunner = events.some((e) => e.type !== "user");
      await client.query(
        "UPDATE sessions SET tokens_in = tokens_in + $2, tokens_out = tokens_out + $3, status = CASE WHEN $4::boolean AND status = 'queued' THEN 'running' ELSE status END WHERE id = $1",
        [sessionId, tin, tout, fromRunner],
      );
```

(The surrounding transaction, NOTIFY, and return value are unchanged.)

- [ ] **Step 4: Run tests and typecheck to verify they pass**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: all tests PASS (including the existing roundtrip test, whose `session.created`+`agent.message` batch still flips to `running`); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/repo.ts control-plane/test/repo.test.ts
git commit -m "fix(cp): only runner events flip a session queued -> running

The messages route appends the user prompt event before the pod exists;
that append flipped the session to 'running', the SSE delivered it before
the 202, and the console's optimistic 'queued' then hid 'generating...'
for the whole turn (and turn 1 showed a false 'generating...' during pod
scheduling)."
```

---

### Task 2: Checkpoint the CLI's config file and ship runner image dev21

**Files:**
- Modify: `session-runner/runner.py:26`
- Modify: `CLAUDE.md` (both `dev20` references: the run command block and the session-runner-image bullet)

**Interfaces:**
- Consumes: nothing from Task 1 (independent).
- Produces: image `devproof/session-runner:dev21` on the local Docker daemon; Task 3 starts the CP with `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev21`.

- [ ] **Step 1: Add the CLI config file to the checkpoint set**

In `session-runner/runner.py` replace line 26:

```python
CHECKPOINT_PATHS = [os.path.expanduser("<cli-state-dir>"), os.path.expanduser("<cli-config-file>"), "/work"]  # historical: the legacy CLI runtime's state dir + config file
```

(`save_checkpoint` already guards with `os.path.exists`; `restore_checkpoint` extracts at `/`, so the file lands back at its home-directory path.)

- [ ] **Step 2: Build the image with the bumped tag**

Run: `docker build -t devproof/session-runner:dev21 session-runner/`
Expected: build succeeds, INCLUDING the `patch_cli_identity.py` step (it fails the build loudly if the legacy CLI's identity strings moved — do not bypass it).

- [ ] **Step 3: Update CLAUDE.md tag references**

In `CLAUDE.md`: change `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev20` to `...:dev21` in the run block, and in the "Session runner image" bullet change `(current dev20; ...` to `(current dev21; ...`.

- [ ] **Step 4: Commit**

```bash
git add session-runner/runner.py CLAUDE.md
git commit -m "fix(runner): checkpoint the CLI's config file so resumed turns keep the CLI config (dev21)

The CLI's config file is a sibling of the CLI's state dir, not inside
it; the checkpoint kept the backups dir but dropped the file, so every
resumed turn logged the CLI's 'configuration file not found' warning
and regenerated state."
```

---

### Task 3: Live verification of both fixes

**Files:**
- Create: none (uses the existing repro script pattern; write throwaway scripts to the session scratchpad, not the repo)

**Interfaces:**
- Consumes: image `devproof/session-runner:dev21` (Task 2); fixed control plane (Task 1).
- Produces: verification evidence; no code.

- [ ] **Step 1: Restart the control plane on the new image**

Stop the currently running dev CP process (it holds port 7080), then from `control-plane/`:

```bash
DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev21 \
DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files \
npx tsx src/main.ts
```

(Run backgrounded. Wait for `curl -s http://localhost:7080/healthz` → `{"ok":true}`.)

- [ ] **Step 2: Exercise a 2-turn session with a timestamped SSE watch**

Reuse the repro script pattern (SSE reader thread + timestamped log): create a NEW session on an active agent that uses model `qwen05b-dp` via `POST /v1/sessions`, wait for `idle`, then open the SSE stream and POST a follow-up message (`"Reply with only the word OK. Do not use any tools."`) to `/v1/sessions/:id/messages`.

Expected stream ordering (the fix's contract):
- `STATUS -> queued` arrives around the 202 (either order is fine — both say `queued`, so no clobber is possible),
- `STATUS -> running` arrives only LATER, once the pod's first runner event lands (seconds after the 202, not milliseconds before it),
- `STATUS -> idle` at turn end, nothing stuck in between.

- [ ] **Step 3: Check the resumed turn's pod logs for the warning**

Run: `kubectl get pods -n devproof-agents | grep <session-short-id>` then `kubectl logs -n devproof-agents <turn-2-pod>`
Expected: NO CLI "configuration file not found" lines (turn 2 restored the CLI's config file from the turn-1 checkpoint). Turn 1's pod may still create the file fresh — that's normal and silent.

- [ ] **Step 4: Confirm the console shows the fix**

With the console running (`cd console && npx next build && npx next start -p 7090` if not already up), open the session's detail page during a third turn (send another follow-up): the activity row must read "starting…" only until the pod reports, then "generating…" while the model produces output. Also confirm the main pages (Dashboard, Sessions, Deployments) return 200.

- [ ] **Step 5: Mark the TODO item resolved**

In `TODO.txt`, remove the "follow up message in session shows always 'starting'" line and its pasted error block (lines 33-46), since both are now fixed and verified.

```bash
git add TODO.txt
git commit -m "chore: drop fixed session-status/checkpoint items from TODO"
```
