# Model-cache download progress, honest rollout badges, rollout-safe sessions

**Date:** 2026-07-23 · **Status:** issues 1-2 approved in session; issue 3 added
after live reproduction, pending review

Three defects observed live on 2026-07-22 while deploying `gemma-4-12b-it-q4`
(6.6 GiB GGUF, GPU): two console surfaces lie while a model deployment is
moving, and a running session dies when its model rolls.

## Issue 1 — /cache says "Ready" during the download

### Problem

The Model Cache page mirrors the LLMkube `Model` CR's `status.phase`. That CR
reports `Ready` as soon as the **source is resolved** (its own condition says
"the InferenceService Pod's init container will fetch the model … at startup").
The actual download runs minutes later in the engine pod's `model-downloader`
init container — during which the cache page shows a completed-looking `Ready`
row. Observed: page said Ready while curl was at 42% of 6.63 GiB.

### Design

**Control plane** (`/v1/cache`, `server.ts` + `kubestore.ts`):

- `kubestore` gains:
  - `listServingPods(labelSelector)` — core pod list in `SERVING_NAMESPACE`
    (first core-pod read in kubestore; CRs and Jobs exist already).
  - `execInPod(pod, container, command)` — one-shot exec via
    `@kubernetes/client-node`'s `Exec` (websocket), returning stdout.
- Row building moves into a **pure helper** `cacheRows(models, pods)`
  (own module, unit-tested): a model whose pod — matched by label
  `inference.llmkube.dev/model=<name>` — has init container `model-downloader`
  in state `running` gets `phase: "Downloading"`, overriding the CR phase.
  All other rows pass through unchanged.
- For downloading rows ONLY, the route execs
  `sh -c 'wc -c < "$MODEL_PATH"'` in that init container ($MODEL_PATH is in
  the container env) and adds
  `progress = floor(bytes / model.status.sourceContentLength * 100)` (0-100).
  Any exec/parse failure or missing `sourceContentLength` degrades to
  `progress: null` — never an error, never a blocked row.
- Scale: one pod-list call per request; execs only for models mid-download
  (typically 0-1). Hundreds of cached models stay one list + zero execs.
- Mechanics spike-verified 2026-07-23 with the CP's own `@kubernetes/client-node`
  (v1.3) against the live cluster: list-by-label, init-container state read, and
  websocket `Exec` returning the exact on-disk byte count. Two hard-won details:
  exec ONLY pods in phase `Running` (exec into a Failed pod is a websocket 500),
  and the chart's CP Role needs `pods/exec` create (+ `pods` list) in the
  serving namespace — new RBAC.

**Console** (`app/cache/page.tsx`):

- Converts to a client component (dashboard polling pattern): fetch
  `/v1/cache` every 3 s **while any row is Downloading**, no interval
  otherwise. Settings gate (local serving disabled), pager, and Evict stay
  as they are.
- Phase cell renders `Downloading 42%` (badge keeps the orange Deploying
  styling); `Downloading` without a number when `progress` is null. Size
  column keeps the total.

### Not in scope

- No progress persistence, no history — point-in-time only.
- No change to the LLMkube Model CR or operator for this issue.

## Issue 2 — /deployments says "Scaling up" during a rollout

### Problem

`activityFor` (operator, `modeldeployment_controller.go`) overlays
`ScalingUp` whenever a **provisioned** deployment has `ready < desired`. A
spec-change rollout (engine image, resources) keeps `desired == min == 1`
while ready dips to 0 — the badge claims "Scaling up" for a deployment whose
replica count never moved (user read it as "scaling up from 0 replicas with
min=1"). A crashed replica shows the same phantom scale-up.

### Design

Track the last **settled** desired count in MD status, mirroring how
`Provisioned` is carried forward:

- `status.settledReplicas` (int32, new field): updated to `desired` whenever
  `ready == desired` at reconcile time. Carried forward otherwise (the status
  struct is rebuilt every reconcile, like `Provisioned`/`QueueDepth`).
- `activityFor` compares `desired` vs `settledReplicas` instead of `ready`:
  - `desired > settled` → `ScalingUp` (wake 0→1, grow 1→3: unchanged)
  - `desired < settled` → `ScalingDown` (drain: unchanged)
  - `desired == settled` → no overlay — a rollout or crashed pod shows the
    honest phase (`Deploying` badge / `Ready`), not a phantom scale event.
- Ordering matters and is fixed: settle FIRST (`ready == desired` ⇒
  `settled = desired`), THEN compute activity against the updated value —
  this is what clears the overlay in the same reconcile that ready catches
  up. Design validated 2026-07-23 by a sequence spike (11 flows: first
  deploy, rollout, crash, wake, grow, drain, sleep-to-zero, both upgrade
  paths, re-provision precedence, placement-move two-phase) — all pass,
  including the two bug cases and all preserved behaviors.
- Pre-existing MDs have no `settledReplicas` (0): first reconcile of an
  already-Ready deployment settles it immediately (`ready == desired`), so
  no migration concern. A deployment upgraded mid-move may show one wrong
  badge cycle — cosmetic, self-heals on settle.
- CRD: add the optional status field + regenerate (`controller-gen
  object+crd`); chart CRD copy updated in the same change.
- Console: no changes — `phaseBadge` already renders `activity || phase`.

### Tests

- Issue 1: unit tests on `cacheRows` (override, percentage math, pod-less
  passthrough, null-degradation). `npx tsc --noEmit`, console build.
- Issue 2: extend `activity_test.go` — rollout case (`desired==settled==1`,
  ready 0 → no overlay), crash case (desired 3, settled 3, ready 2 → no
  overlay), wake/grow/drain cases keep passing with settled seeded.
- Live: watch a fresh model download show `Downloading N%` on /cache, and an
  engine-image rollout show `Deploying` (not `Scaling up`) on /deployments.

## Issue 3 — a running session dies when its model rolls (it MUST wait)

### Problem

Session `sesn_o0roa4kwnots` failed mid-turn with
`400 Invalid model name passed in model=gemma-4-12b-it-q4` while the engine
deployment rolled to a new image; a manual "try again" two minutes later
succeeded. The launch gate only protects turn STARTS — a turn already running
has no protection when its model becomes temporarily unavailable.

### Root cause (reproduced live, 2026-07-23 experiment repro2.log)

A controlled 6-minute outage (engine pod deleted, replacement unschedulable)
with continuous gateway probes proved the mechanism:

- `model_routing` flips to `waking` within ~4s of the outage (projection is
  NOT stale) and the wake-hold engages correctly — a short bounce (≤300s) is
  already survivable (probe held 13s/300s as designed).
- The kill window is CONFIG CONVERGENCE, not state: `ready` is set in the DB
  (post-warmup `onModelRouted`) ~30s BEFORE the gateway's rolling config
  reload reaches every replica. In that window the hold is open, and any
  request landing on a replica still serving the route-less config gets
  LiteLLM's validation `400 Invalid model name` (observed as a 200/400
  interleave across mixed-config replicas — probes #8-#19). The symmetric
  window exists on the route-DROP side of a rollout.
- Secondary modes observed: an in-flight request killed by its gateway
  replica terminating during the config roll (curl code 000 after 57s), and
  the hold's 300s cap 503ing outages longer than ~5 min.

### Design — two layers, mechanism-agnostic

**Layer 1 — gateway hook (`custom_callbacks.py`): a known local model never
400s.** After routing resolution (and again after a hold release): if the
resolved model has a `model_routing` row (i.e., the platform knows it) but is
absent from THIS replica's loaded router model list (stale config mid-reload),
raise `503 Retry-After: 5` instead of falling through to LiteLLM validation.
Models with no `model_routing` row (external/unknown/deleted) keep today's
400. Hold behavior itself is unchanged (`idle`/`waking`, 300s cap, wake
signal only for `idle`).

**Layer 2 — runner loop: patient retry instead of failing the turn.** The
`/v1/messages` client treats as PATIENT (time-bounded by
`DEVPROOF_SDK_PATIENT_RETRY`, default 1800s — the pod's turn deadline still
caps everything): (a) **any HTTP 503** — delay = min(Retry-After, 30s) when
the header is present, else 5s, plus jitter; (b) connect-level transport
errors where NO response was received (ConnectError/ConnectTimeout/
RemoteProtocolError — the killed-replica mode; nothing was consumed, safe to
resend). Other retryable statuses (408/429/5xx besides 503) keep the original
MAX_ATTEMPTS budget — held in an INDEPENDENT counter, so a patient stretch
never starves it (live-review finding). Non-retryables (400) fail fast.

**Amendment (2026-07-23, live-verified):** the original design gated patience
on the `Retry-After` header, but LiteLLM's `/v1/messages` bridge DROPS custom
response headers (present on `/chat/completions`, absent on the Anthropic
surface — probed at the wire; same dual-surface trap as the metadata
channels). Bare 503 is therefore the patient trigger: on this platform every
hook-raised 503 (wake-hold cap, rollout guard, routing-unavailable,
resolution-failure) is by construction a transient "retry shortly". The
routing-unavailable 503 also gained the Retry-After header it was missing —
it still serves `/chat/completions` clients.

Result: a mid-turn session first holds at the gateway (≤300s), then retries
politely for as long as the turn deadline allows — surviving both rollout
config windows and outages that outlive the hold cap.

### Tests (issue 3)

- Hook: unit-style test of the membership-check helper if the hook gains one
  (the hook file is rendered config — primary verification is live).
- Runner: `session-runner/tests` — client retries on 503+Retry-After (mock
  transport), retries on connection-reset-before-response, does NOT retry a
  plain 400/500, respects the deadline bound.
- Live: rerun the repro2 experiment against the patched gateway — expect
  zero 400s (503s + holds only) and a probe loop with layer-2-style retries
  to complete across the full outage; then a real session mid-turn across an
  engine rollout completes instead of failing.

### Verification before done

CP + console restart, /cache and /deployments 200, backend `npm test` +
`tsc --noEmit`, operator `go test ./...`, session-runner unittest suite,
gateway ConfigMap re-rendered + rolled, and the issue-3 live checks above.
