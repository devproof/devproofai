# Scale-to-zero for local model deployments — design (2026-07-15)

## Problem

`min: 0` is accepted by the deploy/edit modal (which even advertises "min 0
allows scale-to-zero") and by the CRD, but the operator floors replicas at 1
(`transform.ClampReplicas`, `scaler.Desired`) — deliberately, because true
scale-to-zero needs wake-on-request and was never wired. There is no k8s HPA
on models; the floor is entirely our own code. Idle deployments therefore burn
pod time (and billed time cost) forever.

Goal: a min=0 deployment scales to zero after an idle window and wakes on the
first request — from **both** managed-agent sessions and raw gateway API
traffic (e.g. external coding-agent CLI clients). API requests that arrive while
the model wakes are **held** at the gateway and forwarded when the model is
routable (Knative/Lambda-style cold start), with a bounded-hold 503 backstop.

## Decisions (user, 2026-07-15)

- Wake scope: sessions AND raw API requests.
- Cold-start UX: hold the request until ready; cutoff ⇒ retriable 503.
- Idle window: per-deployment field, default 15 minutes.
- Approach A: sleeping models stay routed in the gateway; wake changes no
  gateway config (no rolling reload ⇒ held connections survive).

## Verified facts (live cluster + deployed source, 2026-07-15)

1. LLMkube accepts and acts on ISVC `spec.replicas: 0` (pod actually
   terminated; no admission/defaulting floor). The ClusterIP Service survives
   at zero (endpoints empty), so an always-present gateway route is sound.
2. No per-model HPA exists (only the gateway's own CPU HPA, min 2).
3. **Cache-bounce hazard is real:** the MD-reconciler infers "phase 2 of a
   placement move" from `liveReplicas == 0` and then DELETES the model-cache
   PVC. Reproduced live: scaling qwen-medium's ISVC to 0 destroyed
   `qwen-medium-model-cache`; the replacement pod re-downloaded the full
   weights (~2 min to Ready). Making zero a steady state REQUIRES moving that
   sentinel to an explicit annotation first.
4. litellm 1.91.1 (deployed) awaits `async_pre_call_hook` with a bare `await`
   — no timeout wrapper (`litellm/proxy/utils.py:1427`); uvicorn does not kill
   active requests. Holding for minutes is safe; the bound is the client's own
   timeout (Anthropic SDK default 600 s).
5. The gateway hook already holds an asyncpg pool to the app Postgres
   (`deploy/gateway/litellm.yaml`, `DEVPROOF_DATABASE_URL`) — the wake/hold
   channel needs no new plumbing.

## Design

### 1. Operator: Idle phase + sleep/wake mechanics

**CRD.** `ReplicaBounds` gains optional `IdleMinutes int32` (validation
Minimum=1, default 15 applied in code; meaningful only when `Min == 0`). New
ModelDeployment status phase **`Idle`**.

**Cache-bounce sentinel fix (prerequisite).** Phase 1 of a placement move sets
annotation `serving.devproof.ai/cache-bounce: "1"` on the MD when it drains
the ISVC to zero; phase 2 triggers on that annotation (not on
`liveReplicas == 0`), deletes the cache PVC once engine pods are gone, clears
the annotation, and restores replicas. Idle never sets the annotation ⇒
sleeping never deletes the weights PVC. Placement edit while Idle: the bounce
runs at zero replicas (pods already gone), deletes the PVC, clears the
annotation; the PVC re-provisions lazily on the next wake
(WaitForFirstConsumer) on the new placement.

**Sleep (scaler).** For min=0 deployments at ≥1 replica: count consecutive
full-scrape ticks (`answered == ready > 0`) with `inflight == 0`; after
`IdleMinutes × 4` ticks (15 s tick), write `target-replicas: "0"`. Partial or
blind scrapes neither count nor reset — same never-act-on-partial-sight rule
as today (a reset would let one flaky scrape defer sleep indefinitely; not
counting is enough). Normal DownTicks hysteresis continues to govern N→M
scale-down above zero; the idle window governs only the last step to 0.

**Explicit-zero clamp.** `ClampReplicas`/`Desired` permit 0 **only** when
`Min == 0` AND the target-replicas annotation is explicitly `"0"`. A missing
or invalid annotation still floors at 1 — a fresh min=0 deploy comes up warm
first, then earns its sleep.

**Phase.** Intended-zero (min=0 + explicit zero annotation) ⇒ status
`Phase: Idle` regardless of provider phase (same override pattern as the
existing Progressing→Ready mapping). `readyReplicas: 0` means the cost
sampler stops accruing time cost with no billing changes. The operator
triggers a gateway sync on transitions into and out of Idle (diff-aware on
the CP side; `routingChanged` treats Idle as routed, so this is an explicit
extra trigger, not a routing change).

**Wake.** The CP patches `target-replicas: "1"`; the MD-reconciler applies it
as usual. The scaler cannot fight back while blind (zero pods ⇒ early return)
and takes over normally once a pod is Ready. The CP becomes a second writer
of the annotation; both writers are idempotent patches and the reconciler
remains the sole ISVC writer.

### 2. Gateway: always routed; hold-and-wake in the pre-call hook

`buildGatewayConfig` routes local deployments with phase ∈ {Ready, **Idle**}.
Sleep/wake transitions therefore change nothing in gateway config — no config
sync, no rolling reload, held connections survive (the point of Approach A).

New PG table `model_routing (model TEXT PRIMARY KEY, state TEXT CHECK
(state IN ('idle','waking','ready')), updated_at timestamptz)` — CP-written,
gateway-read. Pre-call hook logic (`custom_callbacks.py`):

- Look up the request's model in `model_routing` (per-process cache, ~2 s
  TTL). No row (external/unknown model) or `ready` ⇒ proceed — zero added
  latency on the hot path.
- `idle` ⇒ `INSERT ... ON CONFLICT DO NOTHING` into `wake_requests(model,
  requested_at)` + `NOTIFY devproof_wake, '<model>'`; then fall into the hold.
- `idle|waking` ⇒ poll `model_routing` every ~2 s until `ready` (proceed) or
  the row disappears / 5-minute cutoff ⇒ raise 503 with `Retry-After: 60`.

**Internal-key traffic bypasses the hold** (`devproof_internal` in the auth
metadata): the CP's warmup request must reach the engine while state is still
`waking` — holding it would deadlock the wake (`ready` is only set after the
warmup answers). Session pods also carry the internal key and are launch-gated
upstream, so nothing legitimate loses protection.

### 3. Control plane: wake trigger, launch gate, warm tracking

**Wake trigger.** CP LISTENs on `devproof_wake` (NotifyHub) ⇒ patch the MD's
`target-replicas: "1"` and set `model_routing.state = 'waking'`; delete the
`wake_requests` row. The same `wakeModel(name)` helper is called directly
when a session gate resolves to Idle. Idempotent throughout.

**Launch gate.** `gateDecision`: phase `Idle` ⇒ `{action: "wait"}`, and the
callers (session start / follow-up / sweep) fire `wakeModel` alongside
parking. The 60 s sweep re-fires the wake for parked models still Idle —
self-healing across CP restarts (a lost NOTIFY or dropped patch is retried at
sweep cadence). Follow-up messages to idle sessions whose model slept are
covered twice: the gate parks the turn, and any raced runner request is held
at the gateway.

**Warm tracking.** `routedModels`/`newlyRouted` semantics change from "in
gateway config" to "in **Ready** phase". Idle models are routed-but-not-warm:
no warmup fires at them (a CP restart must NOT wake sleeping models). Wake
path: Idle → Deploying → Ready ⇒ model appears newly-Ready ⇒ existing
`awaitGatewayRollout` (settles immediately — config unchanged) + warmup +
`onModelRouted` ⇒ CP sets `model_routing = 'ready'` (releases held gateway
requests) and `releasePendingForModel` (releases parked sessions).
Transition into Idle ⇒ CP sets `model_routing = 'idle'`; `warmedModels`
already self-heals on any non-Ready phase. Deployment deleted ⇒ existing
delete path also deletes the `model_routing`/`wake_requests` rows (held
requests then 503 at cutoff; the pending-launch sweep already fails parked
sessions of vanished models).

**State projection sweep.** `model_routing` is a projection, not a ledger:
the reconciler-cadence sweep recomputes it for every local deployment —
Ready + warmed ⇒ `ready`; Idle ⇒ `idle`; anything else (Deploying, Failed,
Warming) ⇒ `waking`; missing deployment ⇒ row deleted. Event hooks (wake
trigger, onModelRouted, Idle transition) update it immediately for snappy
holds; the sweep guarantees convergence after crashes, lost NOTIFYs, or
wakes that fail with no session parked.

**modelPhase.** Reports `Idle` verbatim (with contextTokens) so the gate and
console see it; the Warming substitution stays Ready-only.

### 4. Console

- Deploy/edit modal: when min = 0, show "Sleep after N min idle" (default 15).
  The existing "min 0 allows scale-to-zero" hint finally becomes true; extend
  it with "…the deployment sleeps after the idle window and wakes on the first
  request (~1–2 min)".
- Deployments list + detail: `Idle` badge styled as a healthy state (distinct
  from Deploying/Failed); detail shows "sleeping — wakes on first request".
- No Connect-tab changes: the endpoint keeps working, first request is slow.

### 5. Migrations & API

- Migration `034_model_routing.sql`: `model_routing` + `wake_requests`
  (idempotent DDL per repo migration rules; nothing earlier recreates them).
- `POST/PATCH /v1/deployments` accept `replicas.idleMinutes` (integer 1–1440,
  only valid with `min: 0`); rendered into the CR.
- No new public endpoints: wake is internal (PG NOTIFY + launch gate).

### 6. Edge cases

- **Failed while waking:** parked sessions fail fast (existing sweep); held
  API requests hit the 5-min cutoff 503. The projection sweep keeps the row
  at `waking` while Failed (an operator fix/redeploy resolves it to `ready`
  or the delete path removes the row).
- **Min edited 0→N while Idle:** `ClampReplicas` floors the stale "0"
  annotation to the new min ⇒ wakes. Min edited N→0: sleeps only after the
  idle window elapses.
- **max ≥ 1 stays enforced** (UI + API): min=0/max=0 is impossible.
- **Scaler blind spots:** requests held at the gateway are invisible to
  engine metrics; that cannot re-trigger sleep because the scaler is blind at
  zero pods, and after wake the idle window restarts from zero.
- **Pool maxNodes budget:** unchanged — the budget checks spec.max, not live
  replicas; a sleeping deployment still reserves its max.

### 7. Testing

- `scaler/decide_test.go`: idle-tick accounting, partial-scrape immunity,
  explicit-zero vs missing-annotation clamp, min>0 never sleeps.
- Transform/controller tests: cache-bounce via annotation (set, honored,
  cleared; Idle never triggers PVC deletion), Idle phase derivation.
- `launch-gate` tests: Idle ⇒ wait; sweep re-wake; Failed-while-waking.
- `gateway-config` tests: Idle deployments routed; routedModels = Ready-only.
- Hook: pure-python unit test for the hold/wake state machine (mirroring the
  existing runner-image test pattern) if practical; otherwise covered live.
- Live verification (docker-desktop): deploy min=0 → observe warm-then-sleep
  (PVC must survive — `kubectl get pvc` age check) → `curl` a completion →
  held request answers after wake; session start against Idle model parks and
  releases; CP restart does NOT wake sleeping models.

## Out of scope

- Manual Stop/Start buttons (first request or a session is the wake path).
- Scale-to-zero for external deployments (nothing to scale).
- Knative-style activator component (rejected: new moving part; the hook
  hold delivers the same UX).
- Multi-replica wake bursts (wake always targets 1; the scaler grows it
  afterward from real queue depth).
