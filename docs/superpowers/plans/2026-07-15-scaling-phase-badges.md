# Scaling up / Scaling down deployment badges — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show **Scaling up** / **Scaling down** badges on the Deployments list and detail pages for every replica transition, so **Deploying** means only first-time provisioning.

**Architecture:** The operator derives a display-only overlay into two new `ModelDeploymentStatus` fields — `Activity` (`ScalingUp|ScalingDown|""`) and a sticky `Provisioned` bool — from `desired` (`transform.DesiredReplicas`) vs `ready` (live ISVC). `status.phase` and all five of its consumers are untouched. The control plane passes `activity` through in one serializer line; the console renders `activity || phase` through one shared helper.

**Tech Stack:** Go 1.x + controller-runtime v0.24.1 + controller-gen v0.21.0 (operator), Node/TS + Fastify (control plane), Next.js server + client components (console), kubectl against docker-desktop.

Spec: `docs/superpowers/specs/2026-07-15-scaling-phase-badges-design.md` (commit `5bed7ba`, plus the assignment-order correction).

## Global Constraints

- **Go is not on PATH.** Every Go command must be preceded by `export PATH="$HOME/sdk/go/bin:$PATH"` in the same shell invocation.
- **controller-gen** is `~/go/bin/controller-gen.exe` (v0.21.0). There is no Makefile.
- **CRD regen writes LF; this repo is CRLF.** After regen, `git status` may flag `config/crd/*.yaml` as modified with a **content-empty** diff. Verify with `git diff --numstat`; if it reports no content change, `git checkout` the file. (Verified 2026-07-15: the committed CRD is already in sync with `types.go`.)
- **CRLF editing hazard:** deleting whole lines via an edit whose `old_string` starts with `\n` can join adjacent lines in this repo. Re-check `git diff` after any multi-line deletion.
- **Never add a palette token.** Both new badges reuse the existing `.phase.Deploying` orange (`--accent`). `console/app/globals.css` must not change.
- **`app/deployments/phase.ts` must NOT carry a `"use client"` directive** — it is imported by both a server component (`page.tsx`) and a client component (`tabs.tsx`).
- **Do not touch** (the five `status.phase` consumers, protected by design): `gatewaysync.go` `routed()`, `gateway-config.ts` `buildGatewayConfig`, `routing-state.ts`, `main.ts` `warmedModels`/`modelPhase`, `launch-gate.ts`.
- **Out of scope — do not implement:** the wake route-drop fix, a yellow palette token, `desiredReplicas` in the API.
- **Console is always a production build:** `npx next build && npx next start -p 7090`. A rebuild under a running `next start` pins stale chunk hashes — always restart `next start` after a build.

## File Structure

| File | Responsibility |
|---|---|
| `operator/api/v1alpha1/types.go` | Modify: add `Activity` + `Provisioned` to `ModelDeploymentStatus` |
| `operator/api/v1alpha1/zz_generated.deepcopy.go` | Regenerated (controller-gen) |
| `operator/config/crd/serving.devproof.ai_modeldeployments.yaml` | Regenerated — **must be `kubectl apply`d or the apiserver prunes the new fields** |
| `operator/internal/controller/modeldeployment_controller.go` | Modify: add `activityFor()` + `provisionedNow()` helpers; assign them after the download block |
| `operator/internal/controller/activity_test.go` | Create: table tests for both helpers |
| `operator/internal/controller/gatewaysync_test.go` | Modify: regression guard that `Activity` never moves the route |
| `control-plane/src/server.ts` | Modify: `activity` in the `listDeployments` serializer (covers list + detail) |
| `console/app/deployments/phase.ts` | Create: `phaseBadge()` + `isSettled()` — the single source of badge truth |
| `console/app/deployments/page.tsx` | Modify: interface, `PhaseCell`, drop local `phaseClass`, polling predicate |
| `console/app/deployments/[name]/tabs.tsx` | Modify: use `phaseBadge`, gate the Idle sub-line |
| `console/app/deployments/[name]/page.tsx` | Modify: add `<AutoRefresh>` |

Helper functions live in `modeldeployment_controller.go` with topic-named `_test.go` files beside them — matching the existing `bounceAction`/`bounce_test.go` and `downloadPercent`/`download_test.go` convention.

---

### Task 1: Operator — the pure derivation logic

Pure functions only, no wiring. A reviewer can accept or reject this logic independently of how it is called.

**Files:**
- Modify: `operator/internal/controller/modeldeployment_controller.go` (append two funcs near `downloadPercent`, ~`:257`)
- Test: `operator/internal/controller/activity_test.go` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `activityFor(phase string, provisioned bool, desired, ready int32) string` returning `"ScalingUp"`, `"ScalingDown"`, or `""`; and `provisionedNow(prev bool, phase string) bool`. Task 2 calls both.

- [ ] **Step 1: Write the failing test**

Create `operator/internal/controller/activity_test.go`:

```go
package controller

import "testing"

// Activity is the display-only overlay on Phase (spec 2026-07-15 badges).
func TestActivity(t *testing.T) {
	cases := []struct {
		name           string
		phase          string
		provisioned    bool
		desired, ready int32
		want           string
	}{
		// Never served yet: no overlay, so Downloading/Deploying stand.
		{"first deploy pending", "Pending", false, 1, 0, ""},
		{"first deploy downloading", "Downloading", false, 1, 0, ""},
		{"first deploy deploying", "Deploying", false, 1, 0, ""},
		// Provisioned and moving.
		{"wake from idle", "Deploying", true, 1, 0, "ScalingUp"},
		{"grow under load 1->3", "Ready", true, 3, 1, "ScalingUp"},
		{"shrink under load 3->2", "Ready", true, 2, 3, "ScalingDown"},
		{"drain to sleep", "Idle", true, 0, 1, "ScalingDown"},
		{"asleep", "Idle", true, 0, 0, ""},
		{"steady", "Ready", true, 2, 2, ""},
		// Bounds edits: desired comes from DesiredReplicas, which re-clamps to
		// the current spec, so an edit moves desired immediately.
		{"edit min 1->2", "Ready", true, 2, 1, "ScalingUp"},
		{"edit max 2->1", "Ready", true, 1, 2, "ScalingDown"},
		{"edit min 0->2 while idle", "Deploying", true, 2, 0, "ScalingUp"},
		// Precedence: these phases win over any replica delta.
		{"failed wins", "Failed", true, 1, 0, ""},
		{"downloading wins (placement move re-download)", "Downloading", true, 1, 0, ""},
		{"copying wins", "Copying", true, 1, 0, ""},
		{"pending wins", "Pending", true, 1, 0, ""},
	}
	for _, c := range cases {
		if got := activityFor(c.phase, c.provisioned, c.desired, c.ready); got != c.want {
			t.Errorf("%s: activityFor(%q,%v,%d,%d) = %q, want %q",
				c.name, c.phase, c.provisioned, c.desired, c.ready, got, c.want)
		}
	}
}

// Provisioned is sticky: it marks "weights are cached", so later pod starts
// are scale-ups, not deployments.
func TestProvisioned(t *testing.T) {
	cases := []struct {
		name  string
		prev  bool
		phase string
		want  bool
	}{
		{"first deploy not yet", false, "Deploying", false},
		{"downloading not yet", false, "Downloading", false},
		{"pending not yet", false, "Pending", false},
		{"ready seeds it", false, "Ready", true},
		{"idle seeds it (upgrade: already-sleeping deployment)", false, "Idle", true},
		{"sticky through deploying (wake)", true, "Deploying", true},
		{"sticky through failed", true, "Failed", true},
		{"sticky through downloading (placement move)", true, "Downloading", true},
	}
	for _, c := range cases {
		if got := provisionedNow(c.prev, c.phase); got != c.want {
			t.Errorf("%s: provisionedNow(%v,%q) = %v, want %v", c.name, c.prev, c.phase, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd operator && export PATH="$HOME/sdk/go/bin:$PATH" && go test ./internal/controller/ -run 'TestActivity|TestProvisioned' -v
```

Expected: FAIL — `undefined: Activity` and `undefined: provisioned` (compile error).

- [ ] **Step 3: Write minimal implementation**

In `operator/internal/controller/modeldeployment_controller.go`, immediately after the `downloadPercent` function (before `parseHumanBytes`):

```go
// Activity is a DISPLAY-ONLY overlay on Phase: the deployment is moving
// between replica counts. Nothing routes on it — Phase stays authoritative
// for the gateway, the launch gate and the model_routing projection, because
// new phase values there would drop routes and park sessions during a healthy
// autoscale (spec 2026-07-15 badges). Empty means "no overlay: show Phase".
func activityFor(phase string, provisioned bool, desired, ready int32) string {
	if !provisioned {
		return "" // first deploy: Downloading/Copying/Deploying are the truth
	}
	switch phase {
	case "Failed", "Downloading", "Copying", "Pending":
		return "" // a real (re-)provision outranks any replica delta
	}
	switch {
	case desired > ready:
		return "ScalingUp"
	case desired < ready:
		return "ScalingDown"
	}
	return ""
}

// provisioned is sticky once the deployment has served: its weights are
// cached, so later pod starts are scale-ups rather than deployments. Idle
// seeds it too — Idle is only reachable after serving (the scaler sleeps only
// from current > 0), which also covers deployments already asleep at upgrade.
func provisionedNow(prev bool, phase string) bool {
	return prev || phase == "Ready" || phase == "Idle"
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd operator && export PATH="$HOME/sdk/go/bin:$PATH" && go test ./internal/controller/ -run 'TestActivity|TestProvisioned' -v
```

Expected: PASS — `--- PASS: TestActivity`, `--- PASS: TestProvisioned`, `ok`.

- [ ] **Step 5: Commit**

```bash
git add operator/internal/controller/modeldeployment_controller.go operator/internal/controller/activity_test.go
git commit -m "feat(operator): Activity/provisioned derivation for scaling badges"
```

---

### Task 2: Operator — status fields, wiring, CRD

**Files:**
- Modify: `operator/api/v1alpha1/types.go:110-129` (`ModelDeploymentStatus`)
- Modify: `operator/internal/controller/modeldeployment_controller.go:235-254` (download block + assignment)
- Modify: `operator/internal/controller/gatewaysync_test.go` (append regression guard)
- Regenerated: `operator/api/v1alpha1/zz_generated.deepcopy.go`, `operator/config/crd/serving.devproof.ai_modeldeployments.yaml`

**Interfaces:**
- Consumes: `activityFor(phase string, provisioned bool, desired, ready int32) string` and `provisionedNow(prev bool, phase string) bool` from Task 1.
- Produces: `ModelDeploymentStatus.Activity string` (JSON `activity`) and `.Provisioned bool` (JSON `provisioned`). Task 3 reads `status.activity`.

- [ ] **Step 1: Write the failing regression guard**

Append to `operator/internal/controller/gatewaysync_test.go`:

```go
// Activity is display-only: it must NEVER move the gateway route. If it did,
// a healthy 1->3 autoscale would trip routingChanged -> gateway sync ->
// buildGatewayConfig drops the non-Ready model -> rolling reload. This is the
// property that lets the badges exist without touching routing at all.
func TestRoutingChangedIgnoresActivity(t *testing.T) {
	ready := func(activity string) v1alpha1.ModelDeploymentStatus {
		return v1alpha1.ModelDeploymentStatus{Phase: "Ready", Endpoint: "http://a/v1", Activity: activity}
	}
	if routingChanged(ready(""), ready("ScalingUp")) {
		t.Error("Ready + Activity change must not trigger a gateway sync")
	}
	idle := func(activity string) v1alpha1.ModelDeploymentStatus {
		return v1alpha1.ModelDeploymentStatus{Phase: "Idle", Endpoint: "http://a/v1", Activity: activity}
	}
	if routingChanged(idle("ScalingDown"), idle("")) {
		t.Error("Idle drain finishing must not trigger a gateway sync")
	}
	// NOT named `provisioned` — that would shadow the package-level helper.
	withProvisioned := func(p bool) v1alpha1.ModelDeploymentStatus {
		return v1alpha1.ModelDeploymentStatus{Phase: "Ready", Endpoint: "http://a/v1", Provisioned: p}
	}
	if routingChanged(withProvisioned(false), withProvisioned(true)) {
		t.Error("Provisioned change must not trigger a gateway sync")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd operator && export PATH="$HOME/sdk/go/bin:$PATH" && go test ./internal/controller/ -run TestRoutingChangedIgnoresActivity -v
```

Expected: FAIL — `unknown field Activity in struct literal` (compile error).

- [ ] **Step 3: Add the status fields**

In `operator/api/v1alpha1/types.go`, inside `ModelDeploymentStatus`, immediately after the `EffectiveContextTokens` field (`:128`) and before the closing `}`:

```go
	// Activity is a DISPLAY-ONLY overlay on Phase: the deployment is moving
	// between replica counts (spec 2026-07-15 badges). Nothing routes on it.
	// Empty (omitted) means "no overlay: show Phase" — omitempty matters, or
	// the enum below would reject the empty string.
	// +kubebuilder:validation:Enum=ScalingUp;ScalingDown
	// +optional
	Activity string `json:"activity,omitempty"`
	// Provisioned goes true once the deployment has served and stays true: its
	// weights are cached, so later pod starts are scale-ups, not deployments.
	// +optional
	Provisioned bool `json:"provisioned,omitempty"`
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd operator && export PATH="$HOME/sdk/go/bin:$PATH" && go test ./internal/controller/ -run TestRoutingChangedIgnoresActivity -v
```

Expected: PASS. (`routingChanged` reads only `Phase` and `Endpoint`, so this passes without changing it — that is the point of the guard.)

- [ ] **Step 5: Wire the assignment into the reconciler**

In `operator/internal/controller/modeldeployment_controller.go`, replace the download-progress block and final return (`:235-254`) — the whole span from the `// Until the model is serving` comment through `return r.setStatus(ctx, md, status, 0)`:

```go
	// Until the model is serving, surface the weight-download progress from the
	// LLMkube Model (phases Pending → Downloading → Copying → Ready). This is
	// the long pole for large models, so it gets its own phase + percent.
	requeue := time.Duration(0)
	if status.Phase != "Ready" && status.Phase != "Failed" && status.Phase != "Idle" {
		model := &unstructured.Unstructured{}
		model.SetGroupVersionKind(modelGVK)
		if err := r.Get(ctx, req.NamespacedName, model); err == nil {
			mphase, _, _ := unstructured.NestedString(model.Object, "status", "phase")
			switch mphase {
			case "Downloading", "Copying", "Pending":
				status.Phase = mphase
				total, _, _ := unstructured.NestedInt64(model.Object, "status", "sourceContentLength")
				sizeStr, _, _ := unstructured.NestedString(model.Object, "status", "size")
				status.DownloadPercent = downloadPercent(sizeStr, total)
				// Poll while downloading — the Model status has no watch wired.
				requeue = 3 * time.Second
			}
		}
	}

	// Display overlay, LAST: the block above mutates Phase, and Activity's
	// precedence reads the final Phase (assigning earlier would emit
	// Downloading + ScalingUp together on a placement move). Provisioned first
	// — Activity reads it. Carried forward explicitly from the previous status
	// because this struct is rebuilt every reconcile, exactly like QueueDepth.
	status.Provisioned = provisionedNow(md.Status.Provisioned, status.Phase)
	status.Activity = activityFor(status.Phase, status.Provisioned, replicas, int32(ready))
	return r.setStatus(ctx, md, status, requeue)
```

This preserves the original 3-second download poll and the zero requeue otherwise; the only behavioural change is that the download branch falls through instead of returning early.

- [ ] **Step 6: Regenerate deepcopy + CRD**

```bash
cd operator && export PATH="$HOME/sdk/go/bin:$PATH" && ~/go/bin/controller-gen.exe object paths=./api/v1alpha1/... crd paths=./api/v1alpha1/... output:crd:dir=config/crd
```

Expected: exit 0, no output.

Confirm the enum and fields landed:

```bash
grep -A4 'activity:' config/crd/serving.devproof.ai_modeldeployments.yaml
grep -n 'provisioned:' config/crd/serving.devproof.ai_modeldeployments.yaml
```

Expected: an `activity:` property with `enum: [ScalingUp, ScalingDown]` and `type: string`, plus a `provisioned:` property of `type: boolean`. Neither may appear in a `required:` list.

- [ ] **Step 7: Run the full operator suite**

```bash
cd operator && export PATH="$HOME/sdk/go/bin:$PATH" && go build ./... && go test ./...
```

Expected: `ok` for `internal/controller`, `internal/scaler`, `internal/transform`; no failures.

- [ ] **Step 8: Commit**

Check the CRD for EOL-only churn first (see Global Constraints); if `git diff --numstat` shows no content change for a regenerated file, `git checkout` it rather than committing noise.

```bash
git add operator/api/v1alpha1/types.go operator/api/v1alpha1/zz_generated.deepcopy.go \
        operator/config/crd/serving.devproof.ai_modeldeployments.yaml \
        operator/internal/controller/modeldeployment_controller.go \
        operator/internal/controller/gatewaysync_test.go
git commit -m "feat(operator): publish Activity/Provisioned status overlay"
```

---

### Task 3: Control plane — pass `activity` through

**Files:**
- Modify: `control-plane/src/server.ts:346` (local serializer), `:362` (external branch)

**Interfaces:**
- Consumes: `status.activity` from Task 2.
- Produces: `activity: string | null` on every object returned by `GET /v1/deployments` and `GET /v1/deployments/:name`. Task 4 reads it.

- [ ] **Step 1: Add the field to the local serializer**

In `control-plane/src/server.ts`, in `listDeployments`, directly after the `phase:` line (`:346`):

```ts
      phase: d.status?.phase ?? "Pending",
      // Display-only overlay on phase (spec 2026-07-15 badges): ScalingUp |
      // ScalingDown | null. Nothing here routes on it — the console renders
      // `activity || phase`.
      activity: d.status?.activity ?? null,
```

- [ ] **Step 2: Keep the external shape uniform**

In the external push (`:362-363`), add `activity: null`:

```ts
        phase: "External", activity: null, downloadPercent: null, readyReplicas: 0,
        tokensPerSec: null, queueDepth: null,
```

No change is needed for `GET /v1/deployments/:name` — it filters `listDeployments()` (`:375-379`), so it inherits the field.

- [ ] **Step 3: Typecheck and test**

```bash
cd control-plane && npx tsc --noEmit && npm test
```

Expected: `tsc` prints nothing (exit 0); `npm test` reports all tests passing with no failures.

- [ ] **Step 4: Commit**

```bash
git add control-plane/src/server.ts
git commit -m "feat(cp): expose deployment status.activity"
```

---

### Task 4: Console — badges, polling, detail auto-refresh

**Files:**
- Create: `console/app/deployments/phase.ts`
- Modify: `console/app/deployments/page.tsx:9-15, 19-36, 41`
- Modify: `console/app/deployments/[name]/tabs.tsx:12, 16, 26`
- Modify: `console/app/deployments/[name]/page.tsx`

**Interfaces:**
- Consumes: `activity: string | null` from Task 3.
- Produces: `phaseBadge(phase: string, activity?: string | null): { label: string; cls: string }` and `isSettled(d: { phase: string; activity?: string | null }): boolean`.

- [ ] **Step 1: Create the shared helper**

Create `console/app/deployments/phase.ts` — **no `"use client"` directive**, because both a server component (`page.tsx`) and a client component (`tabs.tsx`) import it:

```ts
// Deployment badge mapping (spec 2026-07-15 badges). Plain module — imported
// by the server list page AND the client detail tabs, so it must stay free of
// a "use client" directive.

/** Badge label + CSS class. `activity` overlays `phase`; both scaling states
 *  reuse the existing orange `.phase.Deploying` styling. */
export function phaseBadge(phase: string, activity?: string | null) {
  if (phase === "External") return { label: "External", cls: "Ready" };
  if (activity === "ScalingUp") return { label: "Scaling up", cls: "Deploying" };
  if (activity === "ScalingDown") return { label: "Scaling down", cls: "Deploying" };
  const cls = phase === "Ready" ? "Ready" : phase === "Failed" ? "Failed"
            : phase === "Idle" ? "Idle" : "Deploying";
  return { label: phase, cls };
}

/** True when nothing is moving, so the page can stop auto-refreshing. The
 *  `activity` term is load-bearing: a grow is Ready+ScalingUp and a drain is
 *  Idle+ScalingDown, both otherwise-terminal phases. */
export const isSettled = (d: { phase: string; activity?: string | null }) =>
  ["Ready", "Failed", "External", "Idle"].includes(d.phase) && !d.activity;
```

- [ ] **Step 2: Update the list page**

In `console/app/deployments/page.tsx`:

Add to the imports (after `import { DeleteButton } from "../lib/delete";`):

```tsx
import { phaseBadge, isSettled } from "./phase";
```

Add `activity` to the `Deployment` interface (`:11`, after `phase: string;`):

```tsx
  phase: string; activity?: string | null; downloadPercent: number | null; endpoint?: string; readyReplicas: number;
```

Delete the local `phaseClass` (`:19-20`) and replace `PhaseCell`'s final return (`:35`) so the whole block reads:

```tsx
function PhaseCell({ d }: { d: Deployment }) {
  if (d.phase === "External") return <span className="phase Ready">External</span>;
  if (d.phase === "Downloading" || d.phase === "Copying") {
    const pct = d.downloadPercent != null && d.downloadPercent >= 0 ? d.downloadPercent : null;
    return (
      <div style={{ minWidth: 120 }}>
        <div style={{ fontSize: 11.5, color: "var(--accent)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>
          {d.phase === "Copying" ? "Copying" : "Downloading"} {pct != null ? `${pct}%` : "…"}
        </div>
        <div className="dlbar"><div className="dlbar-fill" style={{ width: `${pct ?? 15}%`, opacity: pct != null ? 1 : .5 }} /></div>
      </div>
    );
  }
  const { label, cls } = phaseBadge(d.phase, d.activity);
  return <span className={`phase ${cls}`}>{label}</span>;
}
```

Replace the polling predicate (`:41`):

```tsx
  const inProgress = deployments.some((d) => !isSettled(d));
```

- [ ] **Step 3: Update the detail tabs**

In `console/app/deployments/[name]/tabs.tsx`, add to the imports:

```tsx
import { phaseBadge } from "../phase";
```

Replace the inline mapping (`:12`):

```tsx
  const { label: phaseLabel, cls: phaseCls } = phaseBadge(d.phase, d.activity);
```

Replace the heading badge (`:16`):

```tsx
        <h1>{d.name} <span className={`phase ${phaseCls}`} style={{ marginLeft: 10, verticalAlign: "middle" }}>{phaseLabel}</span></h1>
```

Gate the Idle sub-line (`:26`) so a drain doesn't claim to be asleep while its pod is still terminating:

```tsx
      {d.phase === "Idle" && !d.activity && <p className="sub" style={{ marginTop: 4 }}>sleeping — wakes on the first request (~1–2 min)</p>}
```

- [ ] **Step 4: Add auto-refresh to the detail page**

In `console/app/deployments/[name]/page.tsx`, add the imports:

```tsx
import { AutoRefresh } from "../autorefresh";
import { isSettled } from "../phase";
```

and replace the final return:

```tsx
  return (
    <>
      <AutoRefresh active={!isSettled(d)} />
      <DeploymentTabs d={d} keys={keys.keys} agents={agents.agents} gatewayUrl={gatewayUrl} />
    </>
  );
```

`router.refresh()` re-renders the server tree while preserving client state, so the selected tab and the Trace tab's SSE connection survive; refreshing only while unsettled keeps it bounded (~16 s for a wake) and quiet afterwards.

- [ ] **Step 5: Build**

```bash
cd console && npx next build
```

Expected: `✓ Compiled successfully`, no type errors. A `"use client"` mistake in `phase.ts` surfaces here as an import error from the server component.

- [ ] **Step 6: Commit**

```bash
git add console/app/deployments/phase.ts console/app/deployments/page.tsx \
        console/app/deployments/\[name\]/tabs.tsx console/app/deployments/\[name\]/page.tsx
git commit -m "feat(console): Scaling up/down badges + detail auto-refresh"
```

---

### Task 5: Live verification on docker-desktop

Nothing here is optional: the apiserver **prunes status fields absent from the CRD**, so skipping Step 1 makes `activity` silently vanish — the same class of failure as the `Idle`-missing-from-enum live bug.

**Files:** none (verification only).

- [ ] **Step 1: Apply the regenerated CRD**

```bash
cd operator && kubectl apply -f config/crd/serving.devproof.ai_modeldeployments.yaml
```

Expected: `customresourcedefinition.apiextensions.k8s.io/modeldeployments.serving.devproof.ai configured`.

- [ ] **Step 2: Restart the operator, control plane, and console**

Three shells. Operator:

```bash
cd operator && export PATH="$HOME/sdk/go/bin:$PATH" && go run ./cmd
```

Control plane:

```bash
cd control-plane && DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev27 \
DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files \
npx tsx src/main.ts
```

Console (restart `next start` — a rebuild under a running server pins stale chunk hashes):

```bash
cd console && npx next start -p 7090
```

- [ ] **Step 3: Confirm the fields are not pruned**

```bash
kubectl -n devproof-serving get modeldeployment qwen-medium -o jsonpath='{.status.provisioned}{"\n"}{.status.phase}{"\n"}'
curl -s localhost:7080/v1/deployments -H 'X-Devproof-Workspace: wrkspc_default' | head -c 400
```

Expected: `true` then the phase; the API response contains an `"activity"` key. If `provisioned` is empty, the CRD was not applied — go back to Step 1.

- [ ] **Step 4: Verify the sleep drain**

`qwen-medium` is `min=0/max=1`. With `/deployments` open in a browser:

```bash
kubectl -n devproof-serving annotate modeldeployment qwen-medium serving.devproof.ai/target-replicas=0 --overwrite
for i in $(seq 1 10); do
  kubectl -n devproof-serving get modeldeployment qwen-medium \
    -o jsonpath='{.status.phase}{" activity="}{.status.activity}{" ready="}{.status.readyReplicas}{"\n"}'
  sleep 3
done
```

Expected: `Idle activity=ScalingDown ready=1` while the pod terminates, settling to `Idle activity= ready=` (0). The browser must show **Scaling down** → **Idle** *without a manual refresh*, and the detail page (`/deployments/qwen-medium`) must track it too — and must not show "sleeping — wakes on the first request" while the badge says Scaling down.

- [ ] **Step 5: Verify the wake, and that the cache survived**

```bash
kubectl -n devproof-serving get pvc qwen-medium-model-cache   # note AGE — must NOT reset
kubectl -n devproof-serving annotate modeldeployment qwen-medium serving.devproof.ai/target-replicas=1 --overwrite
for i in $(seq 1 10); do
  kubectl -n devproof-serving get modeldeployment qwen-medium \
    -o jsonpath='{.status.phase}{" activity="}{.status.activity}{" ready="}{.status.readyReplicas}{"\n"}'
  sleep 3
done
```

Expected: `Deploying activity=ScalingUp ready=0` for ~15 s, then `Ready activity= ready=1`. The badge must read **Scaling up** (never "Deploying"), and the PVC AGE must keep climbing — a reset means the cache-bounce sentinel regressed and the weights re-downloaded.

- [ ] **Step 6: Measure the multi-replica cases**

These are the only behaviour-table rows derived from source rather than measured, so they get measured here. Temporarily widen the bounds (single-node docker-desktop; the RWO cache PVC permits two pods on the same node):

```bash
kubectl -n devproof-serving patch modeldeployment qwen-medium --type=merge \
  -p '{"spec":{"replicas":{"min":2,"max":2}}}'
for i in $(seq 1 10); do
  kubectl -n devproof-serving get modeldeployment qwen-medium \
    -o jsonpath='{.status.phase}{" activity="}{.status.activity}{" ready="}{.status.readyReplicas}{"\n"}'
  sleep 3
done
```

Expected (`min 1→2`): `Ready activity=ScalingUp ready=1` while the second pod starts. If the second pod cannot schedule for resources, `ScalingUp` simply persists — that still measures the badge; confirm with `kubectl -n devproof-serving get pods`.

Then the shrink (`max 2→1`), which should be immediate — the 3-minute hysteresis does not apply to a bounds edit:

```bash
kubectl -n devproof-serving patch modeldeployment qwen-medium --type=merge \
  -p '{"spec":{"replicas":{"min":1,"max":1}}}'
for i in $(seq 1 10); do
  kubectl -n devproof-serving get modeldeployment qwen-medium \
    -o jsonpath='{.status.phase}{" activity="}{.status.activity}{" ready="}{.status.readyReplicas}{"\n"}'
  sleep 3
done
```

Expected (`max 2→1`): `Ready activity=ScalingDown ready=2` while a pod drains, settling to `Ready activity= ready=1`.

- [ ] **Step 7: Confirm the route never moved**

While the grow/shrink above was in flight, `Activity` must not have touched gateway config:

```bash
kubectl -n devproof-gateway get cm litellm-config -o jsonpath='{.data.config\.yaml}' | grep -c 'qwen-medium'
```

Expected: `3` throughout (the count only legitimately drops during the known, out-of-scope `Idle → Deploying` wake window).

- [ ] **Step 8: Restore the deployment's bounds**

```bash
kubectl -n devproof-serving patch modeldeployment qwen-medium --type=merge \
  -p '{"spec":{"replicas":{"min":0,"max":1}}}'
kubectl -n devproof-serving get modeldeployment qwen-medium \
  -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,MIN:.spec.replicas.min,MAX:.spec.replicas.max'
```

Expected: `min=0, max=1` — back to the pre-verification state. It re-sleeps on its own after the idle window.

- [ ] **Step 9: Confirm every page still 200s**

```bash
for p in / /deployments /deployments/qwen-medium /pools /catalog /sessions /agents /usage /settings; do
  printf '%s -> ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:7090$p"
done
```

Expected: `200` for every path.

---

## Done when

- `go test ./...` (operator), `npm test` + `npx tsc --noEmit` (control plane), and `npx next build` (console) all pass.
- A wake reads **Scaling up**, a drain reads **Scaling down**, a first deploy still reads **Downloading → Deploying**, and both were observed in the browser without a manual refresh.
- `min 1→2` and `max 2→1` were **measured**, not inferred.
- The `qwen-medium-model-cache` PVC age never reset.
- `qwen-medium` is back to `min=0/max=1`.
