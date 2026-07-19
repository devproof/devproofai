# Scaling-up / Scaling-down badges on the Deployments page — design (2026-07-15)

## Problem

A deployment that has already served — weights downloaded, model cache PVC
bound — shows **Deploying** every time it starts a pod. Waking a sleeping
min=0 deployment (spec 2026-07-15, scale-to-zero) is the worst case: nothing
is being deployed, a cached pod is starting, but the badge says otherwise.
Reproduced live on `qwen-medium` (see Verified facts 2): a wake reads
`Deploying` for its full ~16 s.

Replica movement is invisible generally: growing 1→3 under load, shrinking
3→2, and replica-bounds edits all keep a flat **Ready** badge, because the
provider's `Progressing` phase is deliberately collapsed to `Ready` so the
gateway doesn't drop the route (`modeldeployment_controller.go:214-221`).

Goal: two new badges — **Scaling up** and **Scaling down** — that cover every
replica transition, while **Deploying** narrows to what it actually means:
first-time provisioning.

## Decisions (user, 2026-07-15)

- **Scaling up** = waking from Idle **and** any replica increase (1→3).
- **Scaling down** = draining to sleep **and** any replica decrease (3→2).
- Badge colour: reuse the existing orange `--accent` (`.phase.Deploying`).
  No new palette token; the label carries the distinction.
- Both are **display states, not CRD phases** (see Approach, below).
- Detail-page auto-refresh is in scope.
- The wake route-drop (Verified facts 4) is a follow-up, not this spec.

## Verified facts (live cluster + source, 2026-07-15)

1. **`status.phase` is load-bearing for five consumers**, none of them
   cosmetic: `gatewaysync.go:19-28` `routed()` (`Ready||Idle`),
   `gateway-config.ts:39` (routes `Ready||Idle`), `routing-state.ts:8-12`
   (`Ready && warmed → ready`, else `waking` ⇒ the gateway *holds* traffic),
   `main.ts:53-70` `warmedModels` (cleared on any non-`Ready` phase), and
   `launch-gate.ts:18-39` (`Ready → launch`, else park the session). Adding
   real phases would make a healthy 1→3 autoscale drop its route, hold its
   traffic, and park new sessions.
2. **A wake renders as `Deploying`** (measured, `qwen-medium`):
   `Idle → Deploying (ready=0, ISVC.phase="Creating") → Ready` in ~16 s. At
   zero replicas the provider ISVC reports `phase: "Stopped"`,
   `modelReady: true`; the LLMkube Model reports `phase: "Ready"`, so the
   download-progress override (`:238-253`) correctly does not fire. The
   `qwen-medium-model-cache` PVC stayed `Bound`, 9 h old, across the sleep.
3. **`setStatus` (`:290-306`) rebuilds status from scratch** each reconcile
   and compares by struct equality; only `QueueDepth` is explicitly carried
   forward (`:203`). Any sticky field must do the same or it is wiped every
   reconcile. `routingChanged` reads **only** `Phase` and `Endpoint`.
4. **The wake drops the gateway route** (measured, follow-up — not this
   spec): sleeping keeps `qwen-medium` in the gateway config (3 entries at
   `Idle`), but the wake's `Idle → Deploying` transition trips
   `routingChanged` ⇒ sync ⇒ `buildGatewayConfig` filters out the non-`Ready`
   model ⇒ **0 entries for ~16 s**, then back to 3 at `Ready`. Requests held
   by the pre-call hook eat a config rewrite + rolling reload exactly when
   spec 2026-07-15 promises they won't.
5. `GET /v1/deployments/:name` (`server.ts:375-379`) has no serializer of its
   own — it filters `listDeployments()`. One field addition covers the list
   page and the detail page.
6. `transform.ClampReplicas` (`transform.go:190-209`) re-clamps into
   `[max(min,1), max]` from the **current** spec on every reconcile, so
   `DesiredReplicas` tracks bounds edits immediately, regardless of a stale
   annotation.

## Approach

Rejected: **real CRD phases** (`status.phase = "ScalingUp"`). Matches the
literal ask but requires correctly editing all five consumers in Verified
fact 1 — the four don't-regress invariants of spec 2026-07-15, every one of
them earned from a live bug.

Rejected: **derive in the console** from `desiredReplicas` + `provisioned`.
Same zero blast radius, but duplicates the rule across `page.tsx` and
`tabs.tsx` in untested TS.

Chosen: **derive in the operator, publish as a display-only overlay.**
`status.phase` and every consumer of it are untouched. The derivation is a
pure Go function, unit-testable beside `decide_test.go`, and the console
renders `activity || phase`.

## Design

### 1. Operator: `Activity` + `Provisioned`

Two new `ModelDeploymentStatus` fields (`operator/api/v1alpha1/types.go`).
Both are comparable, so `setStatus`'s struct equality still works:

```go
// Activity is a DISPLAY-ONLY overlay on Phase. Never routed on: Phase stays
// authoritative for the gateway, launch gate and model_routing projection.
// +kubebuilder:validation:Enum=ScalingUp;ScalingDown
// +optional
Activity string `json:"activity,omitempty"`
// Provisioned goes true once the deployment has served, and stays true: its
// weights are cached, so later pod starts are scale-ups, not deployments.
// +optional
Provisioned bool `json:"provisioned,omitempty"`
```

`omitempty` keeps `Activity: ""` out of the JSON entirely, so the enum never
rejects it — the failure mode that stuck `Idle` at a stale `Ready` (spec
2026-07-15, invariant 4). Regenerate with `controller-gen object+crd`.

**Sticky `Provisioned`** — carried forward explicitly in the fresh status
struct, exactly as `QueueDepth` is (Verified fact 3), via its own pure
helper:

```go
func provisionedNow(prev bool, phase string) bool {
	return prev || phase == "Ready" || phase == "Idle"
}
```

Seeding on `Idle` too handles the upgrade case: `qwen-medium` is asleep now
and has never had `Provisioned` written, and `Idle` is only reachable after a
deployment has served (the scaler sleeps only from `current > 0`).

**Derivation** — a pure function; `desired` is the `replicas` value from
`transform.DesiredReplicas` (`:95-97`), `ready` is from the live ISVC
(`:200`). Both are already in hand at that point:

```go
func activityFor(phase string, provisioned bool, desired, ready int32) string {
	if !provisioned { return "" }
	switch phase {
	case "Failed", "Downloading", "Copying", "Pending": return ""   // these win
	}
	switch {
	case desired > ready: return "ScalingUp"
	case desired < ready: return "ScalingDown"
	}
	return ""
}
```

Taking `desired` from `DesiredReplicas` rather than the raw annotation is
what makes bounds edits work (Verified fact 6).

**Assignment order** — both lines go **after the download-progress block**,
which mutates `status.Phase` to `Downloading`/`Copying`/`Pending`. Assigning
earlier would compute `Activity` from the pre-override phase and emit
`Downloading` + `ScalingUp` together on a placement move, defeating the
precedence rule above. That block currently returns early (`:250`); it
instead sets a `requeue` variable and falls through to a single
`setStatus` return, preserving its 3 s poll exactly. `Provisioned` must come
first because `Activity` reads it:

```go
status.Provisioned = provisionedNow(md.Status.Provisioned, status.Phase)
status.Activity = activityFor(status.Phase, status.Provisioned, replicas, int32(ready))
```

A first deploy of a `min: 3` deployment therefore reads `Downloading →
Deploying → Scaling up → Ready`: the first pod flips `Provisioned`, and the
remaining two are honestly a scale-up.

Because `routingChanged` reads only `Phase` and `Endpoint` (Verified fact 3),
`Activity` churn never triggers a gateway sync. Status updates re-trigger a
reconcile via the MD watch and converge on `setStatus`'s equality early-return.

### 2. Behaviour

| Scenario | phase | desired/ready | badge |
|---|---|---|---|
| First deploy | Downloading → Deploying → Ready | 1/0 | Downloading → **Deploying** (unchanged) |
| Sleep | Ready → Idle | 0/1 → 0/0 | **Scaling down** → Idle |
| Wake | Idle → Deploying → Ready | 1/0 → 1/1 | **Scaling up** → Ready |
| Load-driven grow 1→3 | Ready | 3/1 | **Scaling up** → Ready |
| Load-driven shrink 3→2 (after 3-min hysteresis) | Ready | 2/3 | **Scaling down** → Ready |
| Edit min 1→2 | Ready | 2/1 | **Scaling up** → Ready |
| Edit max 2→1 | Ready | 1/2 | **Scaling down** → Ready |
| Edit min 0→2 while Idle | Idle → Deploying | 2/0 | **Scaling up** → Ready |
| Placement move | Downloading (PVC deleted) | 1/0 | **Downloading** (precedence) |

The sleep drain is `phase: Idle` + `activity: ScalingDown` (the Idle override
at `:228` fires on `replicas == 0`, while pods are still terminating), landing
on plain `Idle` once `ready` reaches 0. Nothing about the Idle override
changes.

### 3. Control plane

One line in the local-deployment serializer (`server.ts:346-350`):

```ts
activity: d.status?.activity ?? null,
```

plus `activity: null` in the external branch (`:362`) to keep the shape
uniform. Per Verified fact 5 this covers the detail page too. Nothing else in
the CP reads it: not `modelPhase`, not `launch-gate`, not `routing-state`,
not `buildGatewayConfig`. `Activity` exists only to be rendered.

### 4. Console

New **plain module** `app/deployments/phase.ts` — no `"use client"`
directive, because `page.tsx` is a server component and `tabs.tsx` is
`"use client"`, and only a directive-free module is importable by both (the
inverse of the `offsetOf` rule that keeps server-callable helpers out of
client modules):

```ts
export function phaseBadge(phase: string, activity?: string | null) {
  if (phase === "External") return { label: "External", cls: "Ready" };
  if (activity === "ScalingUp") return { label: "Scaling up", cls: "Deploying" };
  if (activity === "ScalingDown") return { label: "Scaling down", cls: "Deploying" };
  const cls = phase === "Ready" ? "Ready" : phase === "Failed" ? "Failed"
            : phase === "Idle" ? "Idle" : "Deploying";
  return { label: phase, cls };
}

export const isSettled = (d: { phase: string; activity?: string | null }) =>
  ["Ready", "Failed", "External", "Idle"].includes(d.phase) && !d.activity;
```

`cls` stays `"Deploying"` for both new states — the existing orange
`--accent` badge. **`globals.css` needs no change.**

- `page.tsx`: add `activity?: string | null` to the `Deployment` interface
  (`:9-15`); `PhaseCell` keeps its `Downloading`/`Copying` progress-bar
  branch untouched (the operator's precedence guarantees `activity` is empty
  there) and falls through to `phaseBadge`; replace the local `phaseClass`
  (`:19-20`).
- `page.tsx:41`: `const inProgress = deployments.some((d) => !isSettled(d));`
  The `activity` term is load-bearing — a load-driven grow is
  `Ready + ScalingUp` and a sleep drain is `Idle + ScalingDown`, both in
  today's terminal set, so without it the new badges freeze on screen until a
  manual refresh.
- `[name]/tabs.tsx:12,16`: drop the duplicated inline mapping for
  `phaseBadge`. Its `d` is `any`, so no type change.
- `[name]/tabs.tsx:26`: gate the Idle sub-line on `d.phase === "Idle" &&
  !d.activity` — otherwise a drain reads "Scaling down" beside "sleeping —
  wakes on the first request".
- `[name]/page.tsx`: add `<AutoRefresh active={!isSettled(d)} />` beside
  `<DeploymentTabs/>`; the detail page has none today, so its badge is stale
  until a manual refresh (a wake shows a stale `Deploying` there now).
  `router.refresh()` preserves client state, so the selected tab and the
  Trace tab's SSE connection survive it. Refreshing only while unsettled
  keeps it bounded (~16 s for a wake) and quiet afterwards.

## Edge cases

- **Config edit (context size, reasoning budget)** rolls the engine pods on a
  provisioned deployment: `ready` dips below `desired`, so it reads **Scaling
  up**, not Deploying. Accepted — the weights are cached; it is a pod start.
- **Bounds edits beat the scale-down hysteresis.** `DownTicks` (3 min) lives
  in the scaler's `History.Next`, which compares against `current` — itself
  `DesiredReplicas` (`scaler.go:94-95`), already clamped to the new max. So a
  `max 2→1` edit leaves `desired == current`, the scaler patches nothing, the
  annotation stays stale at `"2"`, and the drain is immediate. Harmless: every
  reader, `Activity` included, resolves through `DesiredReplicas`.
- **Scaler blind at zero replicas** (`answered == 0` ⇒ early return): it
  cannot fight a wake, and it never writes `Activity` — the reconciler is the
  sole writer.
- **Fixed-size deployments** (`max <= min`): the scaler never patches the
  annotation; `DesiredReplicas` floors to `min`, and `Activity` still tracks
  pod rolls.
- **Manual `"0"` annotation on a never-served deployment**: `Idle` seeds
  `Provisioned`, but the wake re-downloads ⇒ Model phase `Downloading` ⇒
  precedence shows **Downloading**, not Scaling up.
- **Badge flicker** on brief `ready` transitions is accepted; the states are
  short-lived by nature.

## Testing

- `activity_test.go` (beside `decide_test.go`): every Behaviour row — the
  `!provisioned` first-deploy case, `Failed`/`Downloading`/`Copying`/`Pending`
  precedence, the three bounds edits through `DesiredReplicas`+`ClampReplicas`,
  and `desired == ready` ⇒ `""`.
- The carry-forward rule is its own pure function, `provisionedNow(prev bool,
  phase string) bool`, table-tested: seeded by `Ready` and by `Idle` (the
  upgrade case), sticky through `Deploying`/`Failed`/`Downloading`, and never
  set by a first deploy. `setStatus` itself cannot lose the field — it writes
  what it is handed (Verified fact 3) — so the end-to-end carry-forward is
  covered by live verification rather than a fake-client round-trip.
- **Regression guard:** `routingChanged` returns false when only `Activity`
  differs. This is the property protecting all five consumers in Verified
  fact 1.
- CRD regen: `Activity`'s enum lands with `omitempty` so `""` is dropped, not
  rejected.
- `cd control-plane && npm test && npx tsc --noEmit`.
- Live (docker-desktop), CP + console restarted: `qwen-medium` is
  `min=0/max=1`, so wake/sleep is exercisable by patching
  `serving.devproof.ai/target-replicas`. Expect **Idle → Scaling up → Ready**
  and **Ready → Scaling down → Idle**, the cache PVC surviving (`kubectl get
  pvc` age), and both list and detail tracking it without a manual refresh.
  The multi-replica cases (`min 1→2`, `max 2→1`) need a temporary `max` bump
  to be **measured rather than inferred** — they are the only rows in the
  Behaviour table derived from source alone.

## Out of scope

- **Follow-up: the wake route-drop (Verified fact 4).** A real, pre-existing
  bug in shipped scale-to-zero — measured, not theorised. `Provisioned` is
  exactly the signal a fix needs: `provisioned && phase == "Deploying"` is a
  deployment whose endpoint still exists and whose pod is coming back, so
  `routed()` and `buildGatewayConfig` could keep it routed across the wake and
  stop trading a rolling reload against the requests the pre-call hook is
  holding. Deliberately not bundled: it changes routing, this spec does not.
- A new yellow palette token (reuse `--accent`; user decision).
- Surfacing `desiredReplicas` in the API or a "1 → 3" Replicas column.
- Scaling states for external endpoints (nothing to scale).
