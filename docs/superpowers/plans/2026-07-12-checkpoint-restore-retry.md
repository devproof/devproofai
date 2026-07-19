# Checkpoint Restore 404 Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A turn pod whose checkpoint file was deleted between Job creation and pod start (interrupt + instant follow-up race, verified on `sesn_awd1vdmtk649`) re-fetches the session's CURRENT checkpoint id and retries once, instead of dying with `session.failed: HTTPError: HTTP Error 404: Not Found`.

**Architecture:** The Job env snapshots `DEVPROOF_CHECKPOINT` at creation (`orchestrator.ts:261`); an interrupted turn's pod can survive its SIGTERM window, post a new checkpoint, and the CP's growth guard (`agents-api.ts:607`) deletes the replaced file the new pod was told to restore. Fix at the consumer: a new runner-facing route `GET /v1/sessions/:id/resume` returns the current checkpoint id, and `restore_checkpoint()` in the runner catches the 404, re-fetches, and retries once (restoring the NEWER checkpoint — the salvaged state — which is semantically better than the stale snapshot). No deletion bookkeeping; the growth guard stays.

**Tech Stack:** Node/TypeScript (Fastify control plane, Node test runner with fake-repo `app.inject` tests), Python session runner (stdlib urllib), Docker image build, docker-desktop Kubernetes.

**Design decision record:** no separate spec — approach agreed in conversation 2026-07-12 (retry-with-fresh-id chosen over deferred deletion [leak-prone bookkeeping, restores stale state] and hard pod kills [loses the salvage path]).

## Global Constraints

- Runner image changes REQUIRE a tag bump (`dev21` → `dev22`) — nodes cache same-tag rebuilds. Update every `dev21` reference in `CLAUDE.md`.
- Do not touch the runner's model-identity pieces (`patch_cli_identity.py`, settings.json contents, platform prompt).
- Control plane in dev runs out-of-cluster: `npx tsx src/main.ts` with `DEVPROOF_RUNNER_IMAGE`, `DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000`, `DEVPROOF_S3_BUCKET=devproof-files` (NOT `npm run dev` — it exits under tool backgrounding).
- Never `git add -A` (untracked `operator/devproof-operator-dev.exe`; the user edits `TODO.txt` live).
- Verification before claiming done: `cd control-plane && npm test` and `npx tsc --noEmit`, plus the live-cluster repro in Task 3.
- Runner-facing CP routes are unauthenticated by design (phase 1 posture, matches the existing `/events`, `/status`, `/outputs` callbacks).

---

### Task 1: Runner-facing `GET /v1/sessions/:id/resume` route

**Files:**
- Modify: `control-plane/src/agents-api.ts` (insert after the `/outputs` route, around line 508)
- Test: `control-plane/test/agents-api.test.ts`

**Interfaces:**
- Consumes: existing `repo.getSession(id)` — the one-arg form is NOT workspace-scoped (`repo.ts:243-250`), which is what a runner callback needs (the runner sends no workspace header).
- Produces: `GET /v1/sessions/:id/resume` → `200 {"checkpointFileId": string | null}` or `404 {"error": "session not found"}`. Task 2's runner calls this as `{EVENTS_URL}/resume` (`EVENTS_URL` is `{CALLBACK_URL}/v1/sessions/{id}`, `orchestrator.ts:257`).

- [x] **Step 1: Write the failing tests**

Append to `control-plane/test/agents-api.test.ts` (uses the existing `build()`/`fakes()` harness; the fake repo's `getSession` returns the raw session object and the fixture exposes the `sessions` array for direct mutation):

```ts
test("GET /v1/sessions/:id/resume returns the CURRENT checkpoint id for runner retry", async () => {
  const { app, sessions } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "ckpt", model: "m" } })).json();
  const s = (await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "p" } })).json();

  // Before any checkpoint exists the field is null, not absent — the runner
  // distinguishes "no checkpoint" from "session gone".
  const empty = await app.inject({ method: "GET", url: `/v1/sessions/${s.id}/resume` });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.json().checkpointFileId, null);

  // Simulate a completed turn having replaced the checkpoint.
  sessions.find((x: any) => x.id === s.id).checkpoint_file_id = "file_current00001";
  const res = await app.inject({ method: "GET", url: `/v1/sessions/${s.id}/resume` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().checkpointFileId, "file_current00001");
});

test("GET /v1/sessions/:id/resume 404s for an unknown session", async () => {
  const { app } = await build();
  const res = await app.inject({ method: "GET", url: "/v1/sessions/sesn_missing/resume" });
  assert.equal(res.statusCode, 404);
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cd control-plane && npm test`
Expected: both new tests FAIL (route not registered → Fastify default 404 body `{"message":"Route GET:/v1/sessions/.../resume not found",...}` — the first test fails its 200 assertion, the second fails on the body shape only if asserted; the plan asserts only the status code, so the second may pass — that is fine, the first MUST fail). All pre-existing tests still pass.

- [x] **Step 3: Implement the route**

In `control-plane/src/agents-api.ts`, directly after the `POST /v1/sessions/:id/outputs` route (ends ~line 508) and before the interrupt route, insert:

```ts
  // Runner callback: the Job env snapshots the checkpoint id at creation
  // (orchestrator DEVPROOF_CHECKPOINT); an interrupted turn's pod can replace
  // (and delete) that checkpoint before the next pod starts. This lets the
  // runner re-fetch the CURRENT id on a 404 and retry (see runner.py
  // restore_checkpoint). Unauthenticated like the other runner callbacks.
  app.get("/v1/sessions/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await repo.getSession(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    return { checkpointFileId: session.checkpoint_file_id ?? null };
  });
```

- [x] **Step 4: Run tests and typecheck to verify they pass**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: all tests PASS; tsc clean.

- [x] **Step 5: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/test/agents-api.test.ts
git commit -m "feat(cp): runner-facing GET /v1/sessions/:id/resume returns current checkpoint id

The Job env snapshots the checkpoint id at creation; an interrupted
turn's pod can replace (and delete) that file before the next pod
starts (verified race on sesn_awd1vdmtk649). This route lets the
runner re-fetch the current id and retry instead of failing the turn."
```

---

### Task 2: Runner retries checkpoint restore with the fresh id; ship image dev22

**Files:**
- Modify: `session-runner/runner.py:30-40` (`restore_checkpoint`)
- Modify: `CLAUDE.md` (both `dev21` references: the run command block and the "Session runner image" bullet)

**Interfaces:**
- Consumes: `GET {EVENTS_URL}/resume` → `{"checkpointFileId": string | null}` (Task 1). `EVENTS_URL` already points at `{CALLBACK_URL}/v1/sessions/{SESSION_ID}` (runner.py:19). The existing `emit()` helper posts events.
- Produces: image `devproof/session-runner:dev22` on the local Docker daemon; a new event type `session.checkpoint_replaced` with payload `{"stale": <old id>, "current": <new id>}` (informational; the console renders unknown `session.*` types as system rows). Task 3 starts the CP with `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev22`.

- [x] **Step 1: Replace `restore_checkpoint` with the retrying version**

In `session-runner/runner.py`, replace the whole `restore_checkpoint` function (lines 30-40) with:

```python
def _download(file_id: str, dest: str) -> None:
    with urllib.request.urlopen(f"{FILES_URL}/{file_id}/content", timeout=300) as res:
        with open(dest, "wb") as out:
            out.write(res.read())


def restore_checkpoint() -> None:
    """Restore SDK session state + workspace from the previous turn.

    The Job env snapshots the checkpoint id at creation; an interrupted
    turn's pod can replace (and delete) that checkpoint before this pod
    starts. On a 404, re-fetch the session's CURRENT id and retry once —
    the newer checkpoint is the salvaged state, strictly better to resume
    from. Any other failure (or a second 404) propagates: main's crash
    handler turns it into session.failed, same as before."""
    import tarfile
    import urllib.error
    if not CHECKPOINT_ID:
        return
    dest = "/tmp/checkpoint.tar.gz"
    try:
        _download(CHECKPOINT_ID, dest)
    except urllib.error.HTTPError as err:
        if err.code != 404:
            raise
        with urllib.request.urlopen(f"{EVENTS_URL}/resume", timeout=30) as res:
            current = json.loads(res.read()).get("checkpointFileId") or ""
        if not current or current == CHECKPOINT_ID:
            raise
        emit("session.checkpoint_replaced", {"stale": CHECKPOINT_ID, "current": current})
        _download(current, dest)
    with tarfile.open(dest) as tar:
        tar.extractall("/", filter="data")
```

Note: `emit` and `post` are defined later in the module (lines ~190-205) — fine at call time, Python resolves module globals at call, and `restore_checkpoint()` is only called from `main()`. Do not move them.

- [x] **Step 2: Build the image with the bumped tag**

Run: `docker build -t devproof/session-runner:dev22 session-runner/`
Expected: build succeeds, INCLUDING the `patch_cli_identity.py` step (it fails the build loudly if the legacy CLI's identity strings moved — do not bypass it).

- [x] **Step 3: Update CLAUDE.md tag references**

In `CLAUDE.md`: change `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev21` to `...:dev22` in the run block, and in the "Session runner image" bullet change `(current dev21; ...` to `(current dev22; ...`.

- [x] **Step 4: Commit**

```bash
git add session-runner/runner.py CLAUDE.md
git commit -m "fix(runner): retry checkpoint restore with the session's current id on 404 (dev22)

Interrupt + instant follow-up: the interrupted pod survives its
SIGTERM window, posts a new checkpoint, and the CP growth guard
deletes the replaced file the already-created Job references. The
pod now re-fetches the current id via GET :id/resume and restores
the newer (salvaged) checkpoint instead of failing the turn."
```

---

### Task 3: Live verification (deterministic race repro)

**Files:**
- Create: none in the repo (throwaway scripts go to the session scratchpad)

**Interfaces:**
- Consumes: image `devproof/session-runner:dev22` (Task 2); CP with the `/resume` route (Task 1).
- Produces: verification evidence; no code. Updates the checkboxes in this plan.

The repro injects the race deterministically instead of racing a real interrupt: after POSTing a follow-up message (which bakes the current checkpoint id into the new Job), it immediately uploads a REPLACEMENT checkpoint and posts it via the runner status callback — the CP then deletes the old file exactly as the interrupted pod did, while the new pod is still scheduling (~10s window).

- [x] **Step 1: Restart the control plane on dev22**

Stop the currently running dev CP process (it holds port 7080), then from `control-plane/` (backgrounded):

```bash
DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev22 \
DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files \
npx tsx src/main.ts
```

Wait for `curl -s http://localhost:7080/healthz` → `{"ok":true}`.

- [x] **Step 2: Obtain a valid replacement checkpoint tarball**

Use a byte-copy of the session's OWN current checkpoint (downloaded in Step 3 once the id is known). A synthetic tarball does NOT work — first execution tried `work/marker.txt` only, and the resumed CLI correctly refused with "No conversation found with session ID" because the replacement lacked the CLI's state dir / config file (the transcript of the legacy CLI runtime). The replacement must be a complete checkpoint; the session's own current one is identical, fully valid state.

- [x] **Step 3: Run the race repro**

Scripted (scratchpad, bash against `http://localhost:7080`, header `X-Devproof-Workspace: wrkspc_default` on non-runner calls):

1. Create an agent on model `qwen05b-dp` with tools `[]`, create a session (`POST /v1/sessions`, prompt "Reply with only the word OK."), wait for status `idle` (poll `GET /v1/sessions/:id`, ≤120s — first turn includes pod start).
2. Record `checkpoint_file_id` as `OLD` from the session detail, and download its content NOW (before the follow-up): `curl -s -o replacement.tar.gz -H "X-Devproof-Workspace: wrkspc_default" http://localhost:7080/v1/files/<OLD>/content` — verify it is a non-empty gzip.
3. `POST /v1/sessions/:id/messages` with `{"prompt": "Reply with only the word DONE."}` → 202. The new Job now references `OLD`.
4. IMMEDIATELY (same script, no sleep):
   `curl -s -X POST --data-binary @replacement.tar.gz -H "Content-Type: application/octet-stream" "http://localhost:7080/v1/files/raw?name=checkpoint-<sid>.tar.gz&session=<sid>&kind=checkpoint"` → capture `NEW` id from the JSON;
   `curl -s -X POST -H "Content-Type: application/json" -d "{\"status\":\"idle\",\"checkpointFileId\":\"<NEW>\"}" http://localhost:7080/v1/sessions/<sid>/status`.
   This replaces the checkpoint and deletes `OLD` — the exact growth-guard path from the incident.
5. Wait for the turn to finish (poll status until `idle`, ≤120s).

- [x] **Step 4: Verify the fix's contract**

All of the following, from `GET /v1/sessions/:id/events` and the turn-2 pod:

- Events contain `session.checkpoint_replaced` with `stale` = `OLD` and `current` = `NEW`.
- NO `session.failed` event with `HTTPError: HTTP Error 404` (the incident signature).
- The turn completed: a final `session.result` with `"is_error": false` after the follow-up, session status back to `idle`.
- `kubectl logs -n devproof-agents <turn-2-pod>` shows no traceback.

If the timing window was missed (no 404 would have occurred — i.e. the replacement landed after the pod already downloaded `OLD`), the `session.checkpoint_replaced` event will be absent while everything else passes: re-run Step 3 (the window is ~10s of pod scheduling; landing inside it on the first try is expected).

- [x] **Step 5: Confirm no regression on the normal path**

Send one more follow-up (`POST /v1/sessions/:id/messages`, "Reply with only the word THIRD.") with no interference: it must complete to `idle` with no `session.checkpoint_replaced` and no warnings — the retry path is dormant when the checkpoint id is fresh.

- [x] **Step 6: Update the plan checkboxes and close out**

Mark all tasks complete in this plan file; commit any checkbox updates:

```bash
git add docs/superpowers/plans/2026-07-12-checkpoint-restore-retry.md
git commit -m "docs: checkpoint-restore-retry plan executed and verified"
```
