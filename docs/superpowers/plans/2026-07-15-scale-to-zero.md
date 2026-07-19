# Scale-to-Zero Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** min=0 model deployments sleep after an idle window and wake on the first request — from sessions (launch gate) and raw gateway traffic (hold-until-ready in the LiteLLM pre-call hook).

**Architecture:** Approach A per `docs/superpowers/specs/2026-07-15-scale-to-zero-design.md`. Sleeping deployments keep phase-routed gateway config (new MD phase `Idle`); the gateway hook reads a CP-maintained `model_routing` PG projection and holds requests while NOTIFYing the CP to patch the deployment awake. The operator's cache-bounce sentinel moves from `liveReplicas == 0` to an explicit annotation FIRST — verified live 2026-07-15 that zero replicas currently deletes the model-cache PVC.

**Tech Stack:** Go (operator, kubebuilder-style), Node/TS + Fastify + node:test (control plane), Python-in-YAML (LiteLLM `custom_callbacks.py`), Next.js (console), Postgres.

## Global Constraints

- Everything must scale to hundreds/thousands of pods; dev/test on docker-desktop.
- Go binary lives at `~/sdk/go/bin/go` (not on PATH). Operator tests: `cd operator && ~/sdk/go/bin/go test ./...`.
- CP tests: `cd control-plane && npm test` and `npx tsc --noEmit`.
- Migrations: `sql/NNN_*.sql`, re-run EVERY boot — idempotent DDL only (`IF NOT EXISTS`). Latest is `033`; the new file is **`034_model_routing.sql`** (the spec's original `032` was stale).
- Wake annotation value is the existing `serving.devproof.ai/target-replicas`; new cache-bounce annotation is `serving.devproof.ai/cache-bounce`.
- New MD phase string is exactly `Idle`. `model_routing.state` ∈ `idle|waking|ready`.
- Hook hold: poll every 2 s, cutoff 300 s ⇒ 503 with `Retry-After: 60`. Internal-key traffic (`devproof_internal` metadata) BYPASSES the hold — holding the CP's warmup would deadlock the wake.
- Default idle window 15 minutes; `idleMinutes` valid 1–1440, only with `min: 0`.
- Console: no `prompt()`/`confirm()`/`alert()`; solid button fills; CRLF repo — beware Edit line-deletion collapse (re-check `git diff` after bulk deletes).
- Commit messages end with the Co-Authored-By + Claude-Session trailer (see repo convention in recent `git log`).

---

### Task 1: Operator — cache-bounce annotation sentinel (PVC-protection prerequisite)

**Files:**
- Modify: `operator/internal/controller/modeldeployment_controller.go:100-131` (phase 1/2 of the bounce)
- Test: `operator/internal/controller/bounce_test.go` (new; plain unit test, no envtest — package already has `gatewaysync_test.go`)

**Interfaces:**
- Produces: `cacheBounceAnnotation = "serving.devproof.ai/cache-bounce"` (unexported const, controller package) and pure helper `bounceAction(annotated, placementMoved bool, liveReplicas int64) string` returning `"drain" | "finish" | "none"`. Task 2's Idle-phase override checks `md.Annotations[cacheBounceAnnotation] != "1"`.

- [ ] **Step 1: Write the failing test**

Create `operator/internal/controller/bounce_test.go`:

```go
package controller

import "testing"

// Scale-to-zero (spec 2026-07-15) makes liveReplicas==0 a steady state, so
// the bounce's phase-2 trigger must be the explicit annotation — inferring it
// from zero replicas deleted a sleeping deployment's cache PVC (verified live
// 2026-07-15: qwen-medium re-downloaded its weights).
func TestBounceAction(t *testing.T) {
	cases := []struct {
		name                   string
		annotated, moved       bool
		liveReplicas           int64
		want                   string
	}{
		{"placement move starts a drain", false, true, 1, "drain"},
		{"re-move mid-bounce re-drains with newest placement", true, true, 0, "drain"},
		{"annotated at zero finishes (delete PVC, clear, restore)", true, false, 0, "finish"},
		{"annotated but pods not drained yet keeps waiting via finish", true, false, 0, "finish"},
		{"IDLE deployment at zero without annotation is untouched", false, false, 0, "none"},
		{"steady state", false, false, 2, "none"},
		{"stale annotation with replicas up finishes cleanup", true, false, 1, "finish"},
	}
	for _, c := range cases {
		if got := bounceAction(c.annotated, c.moved, c.liveReplicas); got != c.want {
			t.Errorf("%s: bounceAction(%v,%v,%d) = %q, want %q", c.name, c.annotated, c.moved, c.liveReplicas, got, c.want)
		}
	}
}
```

Note the semantics: `finish` on `annotated && !moved` regardless of liveReplicas — a crash after phase 1's annotation patch but before the drain apply leaves replicas up; finish's pod-wait handles both (it requeues until engine pods are gone, and pods only vanish once the drain applied).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd operator && ~/sdk/go/bin/go test ./internal/controller/ -run TestBounceAction -v`
Expected: FAIL — `undefined: bounceAction`

- [ ] **Step 3: Implement**

In `modeldeployment_controller.go`, add near the top (after `const fieldOwner ...`):

```go
// cacheBounceAnnotation marks a placement-move cache bounce in flight. It is
// the EXPLICIT phase-2 sentinel: liveReplicas==0 alone is ambiguous now that
// Idle (scale-to-zero, spec 2026-07-15) is a steady state — inferring the
// bounce from zero replicas deleted a sleeping deployment's model-cache PVC
// (reproduced live 2026-07-15).
const cacheBounceAnnotation = "serving.devproof.ai/cache-bounce"

// bounceAction decides the cache-bounce step this reconcile: "drain" applies
// the new placement at zero replicas (phase 1), "finish" waits for pods to
// vanish then deletes the cache PVC and clears the annotation (phase 2),
// "none" leaves the bounce machinery alone.
func bounceAction(annotated, placementMoved bool, liveReplicas int64) string {
	if placementMoved {
		return "drain"
	}
	if annotated {
		return "finish"
	}
	_ = liveReplicas // steady zero (Idle) is deliberately NOT a bounce state
	return "none"
}
```

Then rewrite the phase-1/2 block (current lines 100-131). Replace:

```go
	if placementMoved {
		// Phase 1 of the cache bounce: apply the NEW placement at zero
		...
	} else if liveReplicas == 0 {
		// Phase 2: live placement matches and live replicas are 0 — a state
		...
	}
```

with:

```go
	switch bounceAction(md.Annotations[cacheBounceAnnotation] == "1", placementMoved, liveReplicas) {
	case "drain":
		// Phase 1 of the cache bounce: mark the bounce EXPLICITLY, then apply
		// the NEW placement at zero replicas. Deleting pods instead re-arms
		// the race that deadlocked live verification (3/3): the old
		// ReplicaSet recreates its pod first, it schedules on the OLD node
		// and claims the freshly recreated WaitForFirstConsumer cache PVC
		// there, and the new pod can never schedule while RollingUpdate
		// keeps the old one alive. At zero replicas every ReplicaSet drains,
		// so nothing can claim the PVC while phase 2 re-provisions it.
		// Annotation BEFORE the drain apply: a crash between the two leaves
		// a marked, undrained bounce that phase 2's pod-wait completes.
		if md.Annotations[cacheBounceAnnotation] != "1" {
			patch := []byte(fmt.Sprintf(`{"metadata":{"annotations":{%q:"1"}}}`, cacheBounceAnnotation))
			if err := r.Patch(ctx, md, client.RawPatch(types.MergePatchType, patch)); err != nil {
				return ctrl.Result{}, err
			}
		}
		if err := unstructured.SetNestedField(isvc.Object, int64(0), "spec", "replicas"); err != nil {
			return ctrl.Result{}, err
		}
	case "finish":
		// Phase 2: wait until the engine pods are fully gone (Terminating
		// pods still hold the pvc-protection finalizer), then delete the
		// cache PVC, clear the bounce mark, and fall through to the apply,
		// which restores the real replica count; LLMkube recreates the PVC
		// and the new pods bind it on the target placement.
		remain, err := r.enginePodsRemain(ctx, md)
		if err != nil {
			return ctrl.Result{}, err
		}
		if remain {
			return ctrl.Result{RequeueAfter: 3 * time.Second}, nil
		}
		if err := r.deleteModelCachePVC(ctx, md); err != nil {
			return ctrl.Result{}, err
		}
		patch := []byte(fmt.Sprintf(`{"metadata":{"annotations":{%q:null}}}`, cacheBounceAnnotation))
		if err := r.Patch(ctx, md, client.RawPatch(types.MergePatchType, patch)); err != nil {
			return ctrl.Result{}, err
		}
		logger.Info("cache bounce complete — restoring replicas", "modeldeployment", md.Name)
	}
```

Keep the `if placementMoved { logger.Info("placement changed — draining ..."); return ctrl.Result{RequeueAfter: 3 * time.Second}, nil }` block after the apply loop unchanged — it still requeues phase 1.

IMPORTANT — the finish branch's drain apply: on `finish`, the annotation is set but `placementMoved` is false, so the ISVC apply below renders the REAL replica count. That is exactly the restore. A `finish` reached with pods still up (crash-after-annotate) sees `remain == true` and requeues without applying — correct, the drain apply happens on the next `drain` pass... except placementMoved is now false. To cover the crash-after-annotate-before-drain case, the finish branch must ALSO hold replicas at zero until pods are gone. Add as the FIRST line of the `finish` case:

```go
		if err := unstructured.SetNestedField(isvc.Object, int64(0), "spec", "replicas"); err != nil {
			return ctrl.Result{}, err
		}
```

and move the pods-gone check AFTER the object mutation but keep the requeue-early behavior by restructuring: mutate ISVC to zero, check `remain` — if pods remain, apply the zeroed ISVC (so the drain actually progresses) and requeue; if gone, delete PVC, clear annotation, and RE-mutate replicas back to the real count before falling through:

```go
	case "finish":
		remain, err := r.enginePodsRemain(ctx, md)
		if err != nil {
			return ctrl.Result{}, err
		}
		if remain {
			// Hold the drain at zero until every pod (Terminating included —
			// pvc-protection finalizer) is gone; also completes a bounce that
			// crashed after annotating but before draining.
			if err := unstructured.SetNestedField(isvc.Object, int64(0), "spec", "replicas"); err != nil {
				return ctrl.Result{}, err
			}
			for _, obj := range []*unstructured.Unstructured{model, isvc} {
				if err := ctrl.SetControllerReference(md, obj, r.Scheme()); err != nil {
					return ctrl.Result{}, err
				}
				if err := r.Patch(ctx, obj, client.Apply, fieldOwner, client.ForceOwnership); err != nil {
					return ctrl.Result{}, fmt.Errorf("apply %s: %w", obj.GetKind(), err)
				}
			}
			return ctrl.Result{RequeueAfter: 3 * time.Second}, nil
		}
		if err := r.deleteModelCachePVC(ctx, md); err != nil {
			return ctrl.Result{}, err
		}
		patch := []byte(fmt.Sprintf(`{"metadata":{"annotations":{%q:null}}}`, cacheBounceAnnotation))
		if err := r.Patch(ctx, md, client.RawPatch(types.MergePatchType, patch)); err != nil {
			return ctrl.Result{}, err
		}
		logger.Info("cache bounce complete — restoring replicas", "modeldeployment", md.Name)
	}
```

(The final fall-through apply then restores real replicas.)

- [ ] **Step 4: Run tests**

Run: `cd operator && ~/sdk/go/bin/go test ./... `
Expected: PASS (including existing transform/scaler tests)

- [ ] **Step 5: Commit**

```bash
git add operator/internal/controller/modeldeployment_controller.go operator/internal/controller/bounce_test.go
git commit -m "fix(operator): cache-bounce sentinel is an explicit annotation, not replicas==0"
```

---

### Task 2: Operator — `idleMinutes` CRD field, `DesiredReplicas`, `Idle` phase, routingChanged

**Files:**
- Modify: `operator/api/v1alpha1/types.go:68-79` (ReplicaBounds)
- Modify: `operator/internal/transform/transform.go:172-192` (add `DesiredReplicas`; `ClampReplicas` unchanged)
- Modify: `operator/internal/controller/modeldeployment_controller.go:71-78` (replicas calc), `:159-199` (status)
- Modify: `operator/internal/controller/gatewaysync.go:14-23` (routingChanged)
- Test: `operator/internal/transform/transform_test.go`, `operator/internal/controller/gatewaysync_test.go`
- Regen: `operator/config/crd/serving.devproof.ai_modeldeployments.yaml`

**Interfaces:**
- Consumes: `cacheBounceAnnotation` (Task 1).
- Produces: `ReplicaBounds.IdleMinutes int32` (json `idleMinutes,omitempty`); `transform.DesiredReplicas(md *v1alpha1.ModelDeployment, annotation string, ok bool) int32`; MD status phase `"Idle"`. Task 3's scaler and Task 7's API render rely on these exact names.

- [ ] **Step 1: Write failing tests**

Append to `operator/internal/transform/transform_test.go`:

```go
func TestDesiredReplicas(t *testing.T) {
	md, _ := fixtures() // min 2, max 5
	md.Spec.Replicas = v1alpha1.ReplicaBounds{Min: 0, Max: 3}
	cases := []struct {
		name string
		anno string
		ok   bool
		want int32
	}{
		{"explicit zero with min=0 is Idle", "0", true, 0},
		{"missing annotation floors at 1 (fresh deploy warms first)", "", false, 1},
		{"invalid annotation floors at 1", "x", true, 1},
		{"normal value passes through", "2", true, 2},
		{"above max clamps", "9", true, 3},
	}
	for _, c := range cases {
		if got := DesiredReplicas(md, c.anno, c.ok); got != c.want {
			t.Errorf("%s: DesiredReplicas(%q,%v) = %d, want %d", c.name, c.anno, c.ok, got, c.want)
		}
	}
	md.Spec.Replicas = v1alpha1.ReplicaBounds{Min: 2, Max: 5}
	if got := DesiredReplicas(md, "0", true); got != 2 {
		t.Fatalf("explicit zero with min>0 must clamp to min, got %d", got)
	}
}
```

Append to `operator/internal/controller/gatewaysync_test.go` (match its existing style — read it first):

```go
func TestRoutingChangedIdle(t *testing.T) {
	st := func(phase, ep string) v1alpha1.ModelDeploymentStatus {
		return v1alpha1.ModelDeploymentStatus{Phase: phase, Endpoint: ep}
	}
	cases := []struct {
		name     string
		old, new v1alpha1.ModelDeploymentStatus
		want     bool
	}{
		{"Ready→Idle stays routed but CP projection must update", st("Ready", "e"), st("Idle", "e"), true},
		{"Idle→Ready (wake) must trigger warmup path", st("Idle", "e"), st("Ready", "e"), true},
		{"Idle→Failed leaves the routed set", st("Idle", "e"), st("Failed", "e"), true},
		{"Deploying→Idle enters the routed set", st("Deploying", ""), st("Idle", "e"), true},
		{"Idle steady state is quiet", st("Idle", "e"), st("Idle", "e"), false},
		{"Idle endpoint move re-syncs", st("Idle", "e1"), st("Idle", "e2"), true},
	}
	for _, c := range cases {
		if got := routingChanged(c.old, c.new); got != c.want {
			t.Errorf("%s: routingChanged = %v, want %v", c.name, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd operator && ~/sdk/go/bin/go test ./internal/... -run 'TestDesiredReplicas|TestRoutingChangedIdle' -v`
Expected: FAIL — `undefined: DesiredReplicas`; Idle cases fail in routingChanged.

- [ ] **Step 3: Implement**

`types.go` — add to `ReplicaBounds` after `Reserve`:

```go
	// IdleMinutes is the scale-to-zero window (min=0 only): after this many
	// minutes with zero in-flight requests the scaler parks the deployment at
	// zero replicas (phase Idle); it wakes on the first request. 0 = default
	// (15). Spec 2026-07-15.
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=1440
	// +optional
	IdleMinutes int32 `json:"idleMinutes,omitempty"`
```

`transform.go` — add (imports gain `strconv`); update `ClampReplicas`'s comment ("min floored at 1 — scale-to-zero resolves through DesiredReplicas"):

```go
// DesiredReplicas resolves the scaler's target-replicas annotation into the
// replica count to render. Explicit "0" with min=0 means Idle (scale-to-zero,
// spec 2026-07-15); anything else clamps into [max(min,1), max]. A missing or
// invalid annotation floors at 1 so a fresh min=0 deploy warms up first and
// earns its sleep through the idle window.
func DesiredReplicas(md *v1alpha1.ModelDeployment, annotation string, ok bool) int32 {
	if ok {
		if n, err := strconv.ParseInt(annotation, 10, 32); err == nil {
			if n == 0 && md.Spec.Replicas.Min == 0 {
				return 0
			}
			return ClampReplicas(md, n)
		}
	}
	return ClampReplicas(md, int64(md.Spec.Replicas.Min))
}
```

`modeldeployment_controller.go` — replace lines 71-78 with:

```go
	// Replicas are scaler-owned via the target-replicas annotation (single
	// ISVC writer: this reconciler). Explicit "0" (min=0) = Idle (scale-to-
	// zero); missing/invalid = max(min, 1).
	anno, hasAnno := md.Annotations[scaler.TargetReplicasAnnotation]
	replicas := transform.DesiredReplicas(md, anno, hasAnno)
```

(drop the now-unused `strconv` import if nothing else uses it — check first; the file also parses in the scaler section? It doesn't — remove the import if orphaned.)

Status: after the provider-phase `switch` (line ~179) and BEFORE the download-progress block, insert:

```go
	// Scale-to-zero: intended zero (min=0 + explicit "0" annotation) is Idle —
	// a healthy ROUTED state, not Deploying/Failed. Keep the last endpoint:
	// the ClusterIP Service survives at zero and the gateway route must too.
	// A mid-bounce zero (cache-bounce annotation) is NOT Idle.
	if replicas == 0 && md.Annotations[cacheBounceAnnotation] != "1" {
		status.Phase = "Idle"
		if status.Endpoint == "" {
			status.Endpoint = md.Status.Endpoint
		}
	}
```

and change the download-progress guard to `if status.Phase != "Ready" && status.Phase != "Failed" && status.Phase != "Idle" {`.

`gatewaysync.go` — replace `routingChanged`:

```go
// routingChanged reports whether a status transition affects gateway routes
// or the CP's routing-state projection: membership in the routed set (Ready
// or Idle — sleeping deployments STAY routed, spec 2026-07-15), a phase flip
// within the routed set (Ready↔Idle: the CP must update model_routing and
// fire/naturalize warmups promptly), or a routed endpoint move.
func routingChanged(oldStatus, newStatus v1alpha1.ModelDeploymentStatus) bool {
	routed := func(s v1alpha1.ModelDeploymentStatus) bool { return s.Phase == "Ready" || s.Phase == "Idle" }
	if routed(oldStatus) != routed(newStatus) {
		return true
	}
	if routed(newStatus) && oldStatus.Phase != newStatus.Phase {
		return true
	}
	return routed(newStatus) && oldStatus.Endpoint != newStatus.Endpoint
}
```

- [ ] **Step 4: Regen CRDs and deepcopy**

Run: `cd operator && ~/sdk/go/bin/go run sigs.k8s.io/controller-tools/cmd/controller-gen object paths=./api/... && ~/sdk/go/bin/go run sigs.k8s.io/controller-tools/cmd/controller-gen crd paths=./api/... output:crd:artifacts:config=config/crd`
(If controller-tools isn't a module dependency, first: `~/sdk/go/bin/go install sigs.k8s.io/controller-tools/cmd/controller-gen@latest` and use `~/go/bin/controller-gen` with the same args.)
Expected: `config/crd/serving.devproof.ai_modeldeployments.yaml` gains `idleMinutes`; `zz_generated.deepcopy.go` updated.

- [ ] **Step 5: Run all operator tests**

Run: `cd operator && ~/sdk/go/bin/go test ./...`
Expected: PASS (TestClampReplicas at transform_test.go:196 still passes — ClampReplicas semantics unchanged).

- [ ] **Step 6: Commit**

```bash
git add operator/api operator/internal operator/config/crd
git commit -m "feat(operator): Idle phase + idleMinutes CRD field + explicit-zero replica resolution"
```

---

### Task 3: Operator — scaler sleeps min=0 deployments after the idle window

**Files:**
- Modify: `operator/internal/scaler/decide.go`, `operator/internal/scaler/scaler.go:94-117`
- Test: `operator/internal/scaler/decide_test.go`

**Interfaces:**
- Consumes: `transform.DesiredReplicas` (Task 2), `ReplicaBounds.IdleMinutes` (Task 2).
- Produces: `History.IdleFor(inflight int64) int`, `SleepTicks(idleMinutes int32) int`, `DefaultIdleMinutes = 15`. No one downstream consumes these; behavior is the deliverable (annotation `"0"` written after the window).

- [ ] **Step 1: Write failing tests**

Append to `decide_test.go` (match existing test style — read the file first):

```go
func TestIdleForCountsConsecutiveIdleTicks(t *testing.T) {
	h := &History{}
	if got := h.IdleFor(0); got != 1 {
		t.Fatalf("first idle tick = %d, want 1", got)
	}
	if got := h.IdleFor(0); got != 2 {
		t.Fatalf("second idle tick = %d, want 2", got)
	}
	if got := h.IdleFor(3); got != 0 {
		t.Fatalf("traffic must reset the window, got %d", got)
	}
	if got := h.IdleFor(0); got != 1 {
		t.Fatalf("window restarts after traffic, got %d", got)
	}
}

func TestSleepTicks(t *testing.T) {
	if got := SleepTicks(15); got != 60 {
		t.Fatalf("15 min at 15s ticks = %d, want 60", got)
	}
	if got := SleepTicks(0); got != DefaultIdleMinutes*4 {
		t.Fatalf("unset window must default to %d min, got %d ticks", DefaultIdleMinutes, got)
	}
	if got := SleepTicks(1); got != 4 {
		t.Fatalf("1 min = %d ticks, want 4", got)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd operator && ~/sdk/go/bin/go test ./internal/scaler/ -run 'TestIdleFor|TestSleepTicks' -v`
Expected: FAIL — `undefined: SleepTicks`, `h.IdleFor undefined`.

- [ ] **Step 3: Implement**

`decide.go` — add:

```go
// DefaultIdleMinutes is the scale-to-zero window when the spec omits
// idleMinutes (min=0 deployments only) — spec 2026-07-15.
const DefaultIdleMinutes = 15

// SleepTicks converts the idle window into scaler ticks (15s interval).
func SleepTicks(idleMinutes int32) int {
	if idleMinutes < 1 {
		idleMinutes = DefaultIdleMinutes
	}
	return int(idleMinutes) * 4
}

// IdleFor feeds one FULL-scrape tick's inflight sum and returns how many
// consecutive ticks have been fully idle. Callers must not feed partial
// scrapes: not counting them is the never-act-on-partial-sight rule; a reset
// would let one flaky scrape defer sleep indefinitely.
func (h *History) IdleFor(inflight int64) int {
	if inflight > 0 {
		h.idle = 0
		return 0
	}
	h.idle++
	return h.idle
}
```

and add `idle int` to the `History` struct fields.

`scaler.go` `reconcileOne` — replace the `current` computation (lines 94-99) to use the explicit-zero resolver:

```go
	anno, hasAnno := md.Annotations[TargetReplicasAnnotation]
	current := transform.DesiredReplicas(md, anno, hasAnno)
```

and after `next := h.Next(current, desired)` insert:

```go
	// Scale-to-zero (spec 2026-07-15): min=0 deployments sleep after the idle
	// window — consecutive fully-idle FULL scrapes. The window IS the
	// hysteresis for the last step to zero; Desired never proposes 0. Wake is
	// not the scaler's job: at zero pods it is blind (answered==0 early
	// return) and the CP patches the annotation on demand.
	idleTicks := h.IdleFor(inflight)
	if md.Spec.Replicas.Min == 0 && current > 0 && idleTicks >= SleepTicks(md.Spec.Replicas.IdleMinutes) {
		next = 0
	}
```

After a successful patch (inside the existing success path, after `logger.Info("scaled", ...)`), reset the window so a wake starts fresh:

```go
	if next == 0 {
		h.idle = 0
	}
```

Note: the `md.Spec.Replicas.Max <= md.Spec.Replicas.Min` early return at scaler.go:90 keeps fixed-size deployments out — min=0/max=1 passes it (0 < 1). min=0/max=0 is impossible (API enforces max ≥ 1).

- [ ] **Step 4: Run all scaler + operator tests**

Run: `cd operator && ~/sdk/go/bin/go test ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add operator/internal/scaler
git commit -m "feat(operator): scaler sleeps min=0 deployments after the idle window"
```

---

### Task 4: CP — migration 034, repo methods, NotifyHub wake channel, wakeModel

**Files:**
- Create: `control-plane/sql/034_model_routing.sql`
- Create: `control-plane/src/wake.ts`
- Modify: `control-plane/src/repo.ts` (new methods near `addPendingLaunch`, line ~351), `control-plane/src/db.ts:44-70` (NotifyHub)
- Test: `control-plane/test/wake.test.ts` (new), `control-plane/test/repo.test.ts` (extend, matching its existing DB-backed style)

**Interfaces:**
- Produces:
  - Repo: `setModelRouting(model: string, state: "idle"|"waking"|"ready"): Promise<void>`, `deleteModelRouting(model: string): Promise<void>` (also clears wake_requests), `pruneModelRouting(keep: string[]): Promise<void>`, `takeWakeRequests(): Promise<string[]>`, `clearWakeRequest(model: string): Promise<void>`.
  - `wake.ts`: `wakeModel(deps: WakeDeps, model: string): Promise<void>` with `WakeDeps = { kube: { patch(plural: "modelpools"|"modeldeployments", name: string, body: any): Promise<any> }, repo: { setModelRouting(m: string, s: "idle"|"waking"|"ready"): Promise<void>, clearWakeRequest(m: string): Promise<void> } }`.
  - NotifyHub: `onWake(fn: (model: string) => void): void`.
- Tasks 5/6/8 consume all of these by these exact names.

- [ ] **Step 1: Migration**

Create `control-plane/sql/034_model_routing.sql`:

```sql
-- Scale-to-zero routing state (spec 2026-07-15). model_routing: what the
-- gateway pre-call hook reads to hold requests for sleeping models — a CP-
-- maintained PROJECTION of (deployment phase, warmed), event-updated for
-- snappy holds and swept at reconciler cadence for convergence.
-- wake_requests: the hook's wake signal (INSERT + NOTIFY devproof_wake);
-- the CP deletes rows as it patches deployments awake.
CREATE TABLE IF NOT EXISTS model_routing (
  model      TEXT PRIMARY KEY,
  state      TEXT NOT NULL CHECK (state IN ('idle', 'waking', 'ready')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wake_requests (
  model        TEXT PRIMARY KEY,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Write failing tests**

`control-plane/test/wake.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { wakeModel } from "../src/wake.ts";

test("wakeModel patches the deployment awake, marks waking, clears the request", async () => {
  const calls: any[] = [];
  const deps = {
    kube: { patch: async (plural: string, name: string, body: any) => { calls.push(["patch", plural, name, body]); } },
    repo: {
      setModelRouting: async (m: string, s: string) => { calls.push(["state", m, s]); },
      clearWakeRequest: async (m: string) => { calls.push(["clear", m]); },
    },
  };
  await wakeModel(deps as any, "qwen-medium");
  assert.deepEqual(calls[0], ["patch", "modeldeployments", "qwen-medium",
    { metadata: { annotations: { "serving.devproof.ai/target-replicas": "1" } } }]);
  assert.deepEqual(calls[1], ["state", "qwen-medium", "waking"]);
  assert.deepEqual(calls[2], ["clear", "qwen-medium"]);
});

test("wakeModel does not mark waking when the patch fails", async () => {
  const calls: any[] = [];
  const deps = {
    kube: { patch: async () => { throw new Error("apiserver down"); } },
    repo: {
      setModelRouting: async (m: string, s: string) => { calls.push(["state", m, s]); },
      clearWakeRequest: async (m: string) => { calls.push(["clear", m]); },
    },
  };
  await assert.rejects(() => wakeModel(deps as any, "qwen-medium"));
  assert.equal(calls.length, 0); // sweep retries the whole wake
});
```

Extend `control-plane/test/repo.test.ts` with round-trip coverage for the five repo methods, following the file's existing setup pattern (it runs against the dev Postgres on localhost:15432): setModelRouting upsert flips state; takeWakeRequests drains; pruneModelRouting keeps only listed models; deleteModelRouting removes both rows.

- [ ] **Step 3: Run to verify failure**

Run: `cd control-plane && npm test -- --test-name-pattern wakeModel 2>&1 | tail -20` (or `node --test test/wake.test.ts` if the runner takes file args — check package.json scripts)
Expected: FAIL — cannot find module `../src/wake.ts`.

- [ ] **Step 4: Implement**

`control-plane/src/wake.ts`:

```ts
// Scale-to-zero wake (spec 2026-07-15): patch the deployment's target-replicas
// annotation to 1 — the MD-reconciler applies it; the scaler cannot fight
// back while blind at zero pods. Idempotent: every trigger (gateway NOTIFY,
// session gate, reconciler sweep) may call it repeatedly.
export interface WakeDeps {
  kube: { patch(plural: "modelpools" | "modeldeployments", name: string, body: any): Promise<any> };
  repo: {
    setModelRouting(model: string, state: "idle" | "waking" | "ready"): Promise<void>;
    clearWakeRequest(model: string): Promise<void>;
  };
}

export async function wakeModel(deps: WakeDeps, model: string): Promise<void> {
  await deps.kube.patch("modeldeployments", model, {
    metadata: { annotations: { "serving.devproof.ai/target-replicas": "1" } },
  });
  await deps.repo.setModelRouting(model, "waking");
  await deps.repo.clearWakeRequest(model);
}
```

`repo.ts` — add after `listPendingLaunchModels` (line ~381):

```ts
  // ── Scale-to-zero routing state (spec 2026-07-15) ──
  async setModelRouting(model: string, state: "idle" | "waking" | "ready") {
    await this.pool.query(
      `INSERT INTO model_routing (model, state, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (model) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [model, state],
    );
  }

  async deleteModelRouting(model: string) {
    await this.pool.query("DELETE FROM model_routing WHERE model = $1", [model]);
    await this.pool.query("DELETE FROM wake_requests WHERE model = $1", [model]);
  }

  /** Projection hygiene: drop rows for deployments that no longer exist. */
  async pruneModelRouting(keep: string[]) {
    await this.pool.query("DELETE FROM model_routing WHERE NOT (model = ANY($1))", [keep]);
  }

  /** Atomically claim pending wake signals (DELETE … RETURNING — same
   *  pattern as takePendingLaunches, so concurrent sweeps never double-act). */
  async takeWakeRequests(): Promise<string[]> {
    const { rows } = await this.pool.query("DELETE FROM wake_requests RETURNING model");
    return rows.map((r: any) => r.model);
  }

  async clearWakeRequest(model: string) {
    await this.pool.query("DELETE FROM wake_requests WHERE model = $1", [model]);
  }
```

`db.ts` NotifyHub — add a wake-listener set and branch on channel:

```ts
export class NotifyHub {
  private subs = new Map<string, Set<Listener>>();
  private wakeSubs = new Set<(model: string) => void>();
  private client: pg.PoolClient | null = null;
```

in `start()`, replace the notification handler and add the LISTEN:

```ts
    this.client.on("notification", (msg) => {
      const payload = msg.payload ?? "";
      if (msg.channel === "devproof_wake") {
        for (const fn of this.wakeSubs) { try { fn(payload); } catch { /* ignore */ } }
        return;
      }
      for (const fn of this.subs.get(payload) ?? []) { try { fn(); } catch { /* ignore */ } }
    });
```

and after `await this.client.query("LISTEN devproof_session");`:

```ts
    // Scale-to-zero wake signal from the gateway pre-call hook (spec 2026-07-15).
    await this.client.query("LISTEN devproof_wake");
```

add the method:

```ts
  /** Gateway wake signals (scale-to-zero): payload is the model name. */
  onWake(fn: (model: string) => void) {
    this.wakeSubs.add(fn);
  }
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add control-plane/sql/034_model_routing.sql control-plane/src/wake.ts control-plane/src/repo.ts control-plane/src/db.ts control-plane/test/wake.test.ts control-plane/test/repo.test.ts
git commit -m "feat(cp): model_routing/wake_requests tables + wakeModel + devproof_wake channel"
```

---

### Task 5: CP — launch gate wakes Idle models; routing-state projection sweep

**Files:**
- Create: `control-plane/src/routing-state.ts`
- Modify: `control-plane/src/launch-gate.ts:76-100` (sweep signature), `control-plane/src/session-actions.ts:11-49` (SessionDeps + gatedLaunch)
- Test: `control-plane/test/routing-state.test.ts` (new), `control-plane/test/launch-gate.test.ts` (extend)

**Interfaces:**
- Consumes: `wakeModel`-shaped `wake: (model: string) => Promise<void>` callbacks (Task 4 provides the implementation; these modules only take the callback).
- Produces: `routingStateFor(phase: string, warmed: boolean): "ready"|"idle"|"waking"`; `sweepModelRouting(deps: RoutingSweepDeps): Promise<void>` with `RoutingSweepDeps = { listDeployments(): Promise<{name: string; phase: string}[]>, isWarmed(name: string): boolean, setModelRouting(m, s): Promise<void>, pruneModelRouting(keep: string[]): Promise<void>, takeWakeRequests(): Promise<string[]>, wake(model: string): Promise<void> }`; `SessionDeps.wakeModel?: (model: string) => Promise<void>`; `sweepPendingLaunches(repo, orchestrator, modelPhase, wake?)` (4th optional param). Task 6 wires them in main.ts.

- [ ] **Step 1: Write failing tests**

`control-plane/test/routing-state.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { routingStateFor, sweepModelRouting } from "../src/routing-state.ts";

test("routingStateFor projects (phase, warmed)", () => {
  assert.equal(routingStateFor("Ready", true), "ready");
  assert.equal(routingStateFor("Ready", false), "waking"); // Ready-but-unwarmed = not yet routable
  assert.equal(routingStateFor("Idle", false), "idle");
  assert.equal(routingStateFor("Deploying", false), "waking");
  assert.equal(routingStateFor("Failed", false), "waking"); // held requests 503 at cutoff
});

test("sweepModelRouting projects every deployment, prunes strays, heals lost wakes", async () => {
  const calls: any[] = [];
  await sweepModelRouting({
    listDeployments: async () => [
      { name: "warm", phase: "Ready" }, { name: "asleep", phase: "Idle" }, { name: "coming", phase: "Deploying" },
    ],
    isWarmed: (n) => n === "warm",
    setModelRouting: async (m, s) => { calls.push(["set", m, s]); },
    pruneModelRouting: async (keep) => { calls.push(["prune", keep]); },
    takeWakeRequests: async () => ["asleep", "warm", "deleted-model"],
    wake: async (m) => { calls.push(["wake", m]); },
  });
  assert.deepEqual(calls.filter(c => c[0] === "set"),
    [["set", "warm", "ready"], ["set", "asleep", "idle"], ["set", "coming", "waking"]]);
  assert.deepEqual(calls.find(c => c[0] === "prune"), ["prune", ["warm", "asleep", "coming"]]);
  // only the still-Idle model re-wakes; warm and vanished requests just drain
  assert.deepEqual(calls.filter(c => c[0] === "wake"), [["wake", "asleep"]]);
});
```

Extend `control-plane/test/launch-gate.test.ts` (read its fakes first, follow them):

```ts
test("sweep wakes parked Idle models and keeps waiting", async () => {
  // repo fake with one pending launch on model "m"; modelPhase resolves
  // {kind:"local", phase:"Idle"}; a recording wake fn.
  // Assert: wake called with "m"; takePendingLaunches NOT called (session
  // stays parked); no session.failed events.
});
```

Write it concretely against the file's existing fake-repo helpers.

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && npm test 2>&1 | tail -20`
Expected: FAIL — missing module `../src/routing-state.ts`.

- [ ] **Step 3: Implement**

`control-plane/src/routing-state.ts`:

```ts
// Scale-to-zero routing-state projection (spec 2026-07-15). model_routing is
// what the gateway's pre-call hook reads to decide hold-vs-forward. It is a
// PROJECTION of (deployment phase, warmed) — event hooks update it for snappy
// holds; this reconciler-cadence sweep guarantees convergence after CP
// crashes, lost NOTIFYs, or wakes that failed with no session parked.
export type RoutingState = "ready" | "idle" | "waking";

export function routingStateFor(phase: string, warmed: boolean): RoutingState {
  if (phase === "Ready" && warmed) return "ready";
  if (phase === "Idle") return "idle";
  return "waking";
}

export interface RoutingSweepDeps {
  listDeployments(): Promise<{ name: string; phase: string }[]>;
  isWarmed(name: string): boolean;
  setModelRouting(model: string, state: RoutingState): Promise<void>;
  pruneModelRouting(keep: string[]): Promise<void>;
  takeWakeRequests(): Promise<string[]>;
  wake(model: string): Promise<void>;
}

export async function sweepModelRouting(deps: RoutingSweepDeps) {
  const rows = await deps.listDeployments();
  for (const d of rows) {
    await deps.setModelRouting(d.name, routingStateFor(d.phase, deps.isWarmed(d.name)));
  }
  await deps.pruneModelRouting(rows.map((d) => d.name));
  // Lost-NOTIFY heal: wake signals parked in PG whose model is still asleep.
  // takeWakeRequests deletes atomically, so concurrent sweeps never double-act;
  // wake() re-clears harmlessly.
  for (const model of await deps.takeWakeRequests()) {
    const d = rows.find((r) => r.name === model);
    if (d && d.phase === "Idle") await deps.wake(model);
  }
}
```

`session-actions.ts` — add to `SessionDeps`:

```ts
  /** Scale-to-zero: fires when the gate parks a session on an Idle model. */
  wakeModel?: (model: string) => Promise<void>;
```

and in `gatedLaunch`, inside the `decision.action === "wait"` branch, BEFORE `addPendingLaunch`:

```ts
    // Idle model: wake it alongside parking (idempotent; the reconciler
    // sweep re-fires if this trigger is lost — spec 2026-07-15).
    if (resolved?.kind === "local" && resolved.phase === "Idle") {
      await deps.wakeModel?.(model).catch((err: any) =>
        console.warn(`wake of ${model} failed (sweep retries):`, err));
    }
```

(destructure `deps` accordingly — the function currently destructures `{ repo, orchestrator, modelPhase }`; change to also bind `deps` or add `wakeModel` to the destructuring.)

`launch-gate.ts` — extend the sweep:

```ts
export async function sweepPendingLaunches(
  repo: PendingRepo, orchestrator: LaunchOrchestrator,
  modelPhase: (model: string) => Promise<ModelPhase>,
  wake?: (model: string) => Promise<void>,
) {
  for (const model of await repo.listPendingLaunchModels()) {
    try {
      const resolved = await modelPhase(model);
      const decision: GateDecision = resolved === null
        ? { action: "fail", error: `model deployment "${model}" no longer exists` }
        : gateDecision(model, resolved);
      if (decision.action === "wait") {
        // Idle = asleep: re-fire the wake every sweep until it sticks
        // (covers CP restarts and lost NOTIFYs — spec 2026-07-15).
        if (resolved?.kind === "local" && resolved.phase === "Idle") {
          await wake?.(model).catch((err) => console.warn(`launch-gate: wake of ${model} failed:`, err));
        }
        continue;
      }
      ...unchanged...
```

(`gateDecision` itself needs NO change — `Idle` already falls into the wait branch. Add a comment line to its wait return: `// includes Idle (scale-to-zero): callers fire the wake alongside parking.`)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/routing-state.ts control-plane/src/launch-gate.ts control-plane/src/session-actions.ts control-plane/test/routing-state.test.ts control-plane/test/launch-gate.test.ts
git commit -m "feat(cp): launch gate wakes Idle models; model_routing projection sweep"
```

---

### Task 6: CP — gateway config routes Idle; main.ts wiring; delete cleanup

**Files:**
- Modify: `control-plane/src/gateway-config.ts:35-48` (filter), `:109-120` (newlyRouted comment only)
- Modify: `control-plane/src/main.ts:49-127` (wake wiring, onModelRouted, onResourceDeleted, reconciler)
- Modify: `control-plane/src/agents-api.ts:95-99` and `control-plane/src/public-api.ts:42-46` (thread `wakeModel` into sessionDeps)
- Test: `control-plane/test/gateway-config.test.ts` (extend)

**Interfaces:**
- Consumes: everything Tasks 4-5 produced.
- Produces: running wiring; no new exports.

- [ ] **Step 1: Write failing tests**

Extend `control-plane/test/gateway-config.test.ts` (follow its existing fixture style):

```ts
test("Idle deployments stay routed (scale-to-zero)", () => {
  const cfg = buildGatewayConfig([
    { metadata: { name: "asleep", namespace: "s" }, status: { phase: "Idle", endpoint: "http://asleep.s.svc:8080/v1/chat/completions" } },
    { metadata: { name: "down", namespace: "s" }, status: { phase: "Deploying", endpoint: "http://x" } },
  ]);
  assert.match(cfg, /model_name: asleep/);
  assert.doesNotMatch(cfg, /model_name: down/);
});

test("newlyRouted never warms Idle models (CP restart must not wake sleepers)", () => {
  const routed = new Set<string>();
  const fresh = newlyRouted(routed, [
    { metadata: { name: "asleep", namespace: "s" }, status: { phase: "Idle", endpoint: "http://e" } },
    { metadata: { name: "warm", namespace: "s" }, status: { phase: "Ready", endpoint: "http://e" } },
  ]);
  assert.deepEqual(fresh, ["warm"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && npm test 2>&1 | tail -20`
Expected: the Idle-routing test FAILS (Idle filtered out today); the newlyRouted test already PASSES (Ready-only by construction) — keep it as a regression guard.

- [ ] **Step 3: Implement**

`gateway-config.ts` — change the filter (line 36):

```ts
    // Ready AND Idle are routed: sleeping deployments (scale-to-zero, spec
    // 2026-07-15) keep their route so sleep/wake never changes this config —
    // no rolling reload, so requests held by the pre-call hook survive.
    .filter((d) => (d.status?.phase === "Ready" || d.status?.phase === "Idle") && d.status?.endpoint)
```

Update `newlyRouted`'s doc comment: "Ready-phase only BY DESIGN — Idle models are routed-but-not-warm, and a CP restart must not wake them."

`main.ts` — after `const orchestrator = realOrchestrator();` add imports (`wakeModel` from `./wake.ts`, `sweepModelRouting` from `./routing-state.ts`) and:

```ts
const wake = (model: string) => wakeModel({ kube, repo }, model);
```

Wire the NOTIFY listener after `await notify.start();`:

```ts
// Gateway pre-call hook signals wakes for sleeping models (spec 2026-07-15).
notify.onWake((model) => { void wake(model).catch((err) => console.warn(`wake ${model} failed (sweep retries):`, err)); });
```

`onModelRouted` (line 83) — add the routing-state flip before releasing:

```ts
  onModelRouted: (name) => {
    warmedModels.add(name);
    // Release order matters: held gateway requests read model_routing.
    void repo.setModelRouting(name, "ready").catch((err) => console.warn(`model_routing ready for ${name} failed:`, err));
    void releasePendingForModel(repo, orchestrator, name)
      .catch((err) => console.warn(`launch-gate: release for ${name} failed:`, err));
  },
```

`onResourceDeleted` (line 88):

```ts
  onResourceDeleted: (kind, ref) => {
    if (kind === "deployment") void repo.deleteModelRouting(ref).catch(() => {});
    return repo.deleteResourcePrice(kind, ref);
  },
```

Session deps: `registerAgentRoutes`/`registerPublicApi` opts gain `wakeModel: wake` (main.ts lines 115-116), and in `agents-api.ts:95-99` / `public-api.ts:42-46` add `wakeModel?: (model: string) => Promise<void>` to the opts type and `wakeModel: opts?.wakeModel` into the `sessionDeps` object.

Reconciler wiring (line 127):

```ts
startReconciler(repo, orchestrator, async () => {
  await sweepPendingLaunches(repo, orchestrator, modelPhase, wake);
  await sweepModelRouting({
    listDeployments: async () => (await kube.list("modeldeployments"))
      .map((d: any) => ({ name: d.metadata.name, phase: d.status?.phase ?? "Pending" })),
    isWarmed: (n) => warmedModels.has(n),
    setModelRouting: (m, s) => repo.setModelRouting(m, s),
    pruneModelRouting: (k) => repo.pruneModelRouting(k),
    takeWakeRequests: () => repo.takeWakeRequests(),
    wake,
  }).catch((err) => console.warn("model_routing sweep failed:", err));
}, settle);
```

(Verify `kube.list("modeldeployments")` is the correct kubestore call — server.ts:63 uses `store.list("modeldeployments")`; main.ts's `kube` is the same `realKubeStore()`.)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/gateway-config.ts control-plane/src/main.ts control-plane/src/agents-api.ts control-plane/src/public-api.ts control-plane/test/gateway-config.test.ts
git commit -m "feat(cp): route Idle deployments; wire wake NOTIFY, projection sweep, delete cleanup"
```

---

### Task 7: CP — deployments API accepts `replicas.idleMinutes`

**Files:**
- Modify: `control-plane/src/server.ts:218-224` (replicasError), POST spec build (~line 380), PATCH (~line 581)
- Test: `control-plane/test/server.test.ts` (extend, following its existing deployment-route tests)

**Interfaces:**
- Consumes: CRD field `spec.replicas.idleMinutes` (Task 2).
- Produces: API contract `replicas: { min, max, reserve?, idleMinutes? }` — Task 9's console modal sends it; GET already passes `spec.replicas` through verbatim (server.ts:331), so reads need no change.

- [ ] **Step 1: Write failing tests**

Extend `server.test.ts` (reuse its fake-kube deployment fixtures):

```ts
// POST /v1/deployments with replicas {min:0, max:2, idleMinutes:30} → 201 and
// the created CR spec.replicas.idleMinutes === 30.
// POST with {min:1, max:2, idleMinutes:30} → 400 "idleMinutes only applies with min 0".
// POST with {min:0, max:2, idleMinutes:0} → 400 (integer 1–1440).
// PATCH /v1/deployments/:name with replicas {min:0, max:1, idleMinutes:5} → spec carries it.
```

Write them concretely against the file's existing helpers.

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && npm test 2>&1 | tail -20`
Expected: FAIL — 400s not produced / spec lacks idleMinutes.

- [ ] **Step 3: Implement**

`replicasError` (server.ts:218) — add after the reserve check:

```ts
    const idle = r.idleMinutes;
    if (idle != null) {
      if (!Number.isInteger(idle) || idle < 1 || idle > 1440) return "replicas: idleMinutes must be an integer 1-1440";
      if (min !== 0) return "replicas: idleMinutes only applies with min 0";
    }
```

POST spec build and PATCH (line 581) — both render:

```ts
      spec.replicas = {
        min: b.replicas.min, max: b.replicas.max, reserve: b.replicas.reserve ?? 0,
        ...(b.replicas.idleMinutes != null ? { idleMinutes: b.replicas.idleMinutes } : {}),
      };
```

(POST builds the CR inline near line 380 — locate the `replicas:` key in the created spec and apply the same shape.)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat(cp): deployments API accepts replicas.idleMinutes (min=0 only, 1-1440)"
```

---

### Task 8: Gateway — pre-call hook holds requests for sleeping models

**Files:**
- Modify: `deploy/gateway/litellm.yaml` (custom_callbacks.py: module constants + two helpers + hold block at the top of `async_pre_call_hook`, currently line ~284)

No unit test (Python lives inside YAML; the state machine is 30 lines and live verification in Task 10 exercises hold, wake, bypass, and cutoff). Review the diff carefully instead.

**Interfaces:**
- Consumes: `model_routing` / `wake_requests` tables (Task 4); `devproof_internal` auth metadata (existing, set in `user_custom_auth`).
- Produces: request-path hold behavior only.

- [ ] **Step 1: Implement**

In `custom_callbacks.py` (inside litellm.yaml), extend the header comment's responsibility list with: `#  4. Scale-to-zero hold (spec 2026-07-15): requests for Idle models INSERT a wake request + NOTIFY devproof_wake, then hold until model_routing says 'ready' (cutoff 300s -> 503 Retry-After). Internal-key traffic BYPASSES the hold — holding the CP's warmup would deadlock the wake.`

Add after the `MAX_BOUND = 1024` constant block:

```python
    WAKE_HOLD_MAX = 300.0   # seconds a request may hold while its model wakes
    WAKE_POLL = 2.0         # model_routing re-check interval while holding
    ROUTING_TTL = 2.0       # per-process model_routing cache TTL
```

Add `from fastapi import HTTPException` to the import block at the top (fastapi ships with LiteLLM).

Add after the `_db()` helper:

```python
    _routing_cache = {}   # model -> (expires_monotonic, state|None)

    async def _routing_state(model):
        """model_routing row for a local deployment; None = no row (external/
        unknown/deleted model) -> never hold. Small TTL cache keeps the hot
        path at ~zero DB cost."""
        now = time.monotonic()
        hit = _routing_cache.get(model)
        if hit and hit[0] > now:
            return hit[1]
        pool = await _db()
        row = await pool.fetchrow("SELECT state FROM model_routing WHERE model = $1", model)
        state = row["state"] if row else None
        _routing_cache[model] = (now + ROUTING_TTL, state)
        return state

    async def _hold_for_wake(model):
        """Scale-to-zero (spec 2026-07-15): signal the CP to wake the model,
        then hold this request until it is routable. litellm awaits pre-call
        hooks with a bare await (no timeout wrapper, verified 1.91.1) and the
        sleep/wake transition never changes gateway config, so held
        connections survive; the bound is the client's own timeout."""
        pool = await _db()
        await pool.execute(
            "INSERT INTO wake_requests (model) VALUES ($1) ON CONFLICT (model) DO NOTHING", model)
        await pool.execute("SELECT pg_notify('devproof_wake', $1)", model)
        deadline = time.monotonic() + WAKE_HOLD_MAX
        while time.monotonic() < deadline:
            await asyncio.sleep(WAKE_POLL)
            state = await _routing_state(model)
            if state == "ready":
                return
            if state is None:
                break  # deployment deleted while waking
        raise HTTPException(status_code=503,
                            detail=f"model {model} is waking from scale-to-zero - retry shortly",
                            headers={"Retry-After": "60"})
```

At the TOP of `async_pre_call_hook` (before the sanitizer block), insert:

```python
            try:  # scale-to-zero hold — NEVER on internal traffic: holding the
                  # CP's warmup (which flips state to 'ready') would deadlock.
                  # Session pods also ride the internal key and are launch-
                  # gated upstream. Fail OPEN on DB errors: a PG blip must not
                  # take down traffic for every awake model.
                md0 = getattr(user_api_key_dict, "metadata", None) or {}
                model0 = data.get("model")
                if model0 and not md0.get("devproof_internal"):
                    state = await _routing_state(model0)
                    if state in ("idle", "waking"):
                        await _hold_for_wake(model0)
            except HTTPException:
                raise
            except Exception as e:  # noqa: BLE001
                print(f"devproof-wake: hold check failed (open): {e}", flush=True)
```

- [ ] **Step 2: Sanity-check the YAML and the Python**

Run: `python3 -c "import yaml,sys; d=yaml.safe_load_all(open('deploy/gateway/litellm.yaml')); cm=[x for x in d if x and x.get('kind')=='ConfigMap'][0]; compile(cm['data']['custom_callbacks.py'], 'cb.py', 'exec'); print('ok')"`
(or the PowerShell equivalent with the venv python if none on PATH)
Expected: `ok` — the embedded Python compiles.

- [ ] **Step 3: Commit** (cluster apply happens in Task 10)

```bash
git add deploy/gateway/litellm.yaml
git commit -m "feat(gateway): pre-call hook holds requests for sleeping models and signals wake"
```

---

### Task 9: Console — idleMinutes field, Idle badge, autorefresh, detail note

**Files:**
- Modify: `console/app/deployments/deploy-modal.tsx` (state ~line 55, validation ~line 58, payloads lines 114/124, Replicas field ~line 249, EditDeploymentName props ~line 384)
- Modify: `console/app/deployments/page.tsx:19-20` (phaseClass), `:41` (inProgress)
- Modify: `console/app/deployments/[name]/tabs.tsx:12-16` (badge + sleeping note)
- Modify: `console/app/globals.css:133-135` (add `.phase.Idle`)

**Interfaces:**
- Consumes: API `replicas.idleMinutes` (Task 7); MD phase `Idle` (Task 2).

- [ ] **Step 1: Deploy modal**

State (after line 57):

```tsx
  const [idleMin, setIdleMin] = useState(ctx.idleMinutes != null ? String(ctx.idleMinutes) : "15");
  const nIdle = Number(idleMin);
```

Validation (extend line 59-60):

```tsx
  const idleValid = nMin !== 0 || (Number.isInteger(nIdle) && nIdle >= 1 && nIdle <= 1440);
  const replicasValid = Number.isInteger(nMin) && Number.isInteger(nMax) && Number.isInteger(nRes)
    && nMin >= 0 && nMax >= 1 && nMax >= nMin && nRes >= 0 && nRes <= nMax - nMin && idleValid;
```

Payloads (both `deploy-local` line 114 and `edit-local` line 124):

```tsx
        replicas: { min: Number(minR) || 0, max: Number(maxR) || 0, reserve: Number(reserve) || 0,
          ...(Number(minR) === 0 ? { idleMinutes: Number(idleMin) || 15 } : {}) },
```

Field (after the Replicas `Field`, line 256) — visible only when min is 0; update the hint to be truthful:

```tsx
        <Field label="Replicas" hint="min 0 = scale-to-zero: sleeps after the idle window, wakes on the first request (~1-2 min); the scaler adds replicas on queued demand up to max">
          ...existing three inputs unchanged...
        </Field>
        {nMin === 0 && (
          <Field label="Sleep after" hint="minutes with zero in-flight requests before scaling to zero">
            <input style={{ width: 70, flex: "none" }} value={idleMin} onChange={(e) => setIdleMin(e.target.value)} />
            <span className="muted">min idle</span>
          </Field>
        )}
```

Error line (extend line 258 condition/message):

```tsx
        {!replicasValid && (minR || maxR || reserve || idleMin) !== "" && (
          <p className="modal-error" style={{ margin: "0 0 8px" }}>replicas: need 0 ≤ min ≤ max, max ≥ 1, 0 ≤ reserve ≤ max − min; idle window 1–1440 min</p>
        )}
```

Ctx plumbing: add `idleMinutes?: number;` to the `Ctx` interface (~line 29) and in `EditDeploymentName` map `idleMinutes: (props.replicas as any)?.idleMinutes` beside the existing `reserveReplicas` mapping (~line 393). The deployment detail page already passes the full `replicas` object.

- [ ] **Step 2: Badge, autorefresh, CSS, detail note**

`page.tsx:19-20`:

```tsx
const phaseClass = (p: string) =>
  p === "Ready" ? "Ready" : p === "Failed" ? "Failed" : p === "Idle" ? "Idle" : "Deploying";
```

`page.tsx:41` — Idle is a settled state; without this the page would autorefresh forever:

```tsx
  const inProgress = deployments.some((d) => !["Ready", "Failed", "External", "Idle"].includes(d.phase));
```

`globals.css` after line 135:

```css
.phase.Idle { color: var(--muted); border-color: var(--line); background: color-mix(in srgb, var(--muted) 8%, transparent); }
```

`tabs.tsx:12` — add the Idle mapping:

```tsx
  const phase = d.phase === "External" ? "Ready" : d.phase === "Failed" ? "Failed" : d.phase === "Ready" ? "Ready" : d.phase === "Idle" ? "Idle" : "Deploying";
```

and directly after the `<h1>…</h1>` line (16), add:

```tsx
        {d.phase === "Idle" && <p className="sub" style={{ marginTop: 4 }}>sleeping — wakes on the first request (~1–2 min)</p>}
```

(adjust placement to the file's actual JSX structure; keep the `sub` class).

- [ ] **Step 3: Build the console**

Run: `cd console && npx next build`
Expected: build succeeds. (Remember: a running `next start` pins old chunks — restart it in Task 10.)

- [ ] **Step 4: Commit**

```bash
git add console/app/deployments/deploy-modal.tsx console/app/deployments/page.tsx "console/app/deployments/[name]/tabs.tsx" console/app/globals.css
git commit -m "feat(console): scale-to-zero idle-window field + Idle badge"
```

---

### Task 10: Live verification on docker-desktop + docs

**Files:**
- Modify: `CLAUDE.md` (project conventions — add scale-to-zero don't-regress bullet)

The operator runs as the USER's `go run ./cmd` process and the CP/console as user terminals — coordinate restarts with the user before this task (or run them yourself if you own the processes this session).

- [ ] **Step 1: Roll out**

```bash
kubectl apply -f operator/config/crd/serving.devproof.ai_modeldeployments.yaml
kubectl apply -f deploy/gateway/litellm.yaml           # ConfigMap now has stale sample config.yaml
# restart operator (user terminal): Ctrl-C, then: cd operator && go run ./cmd
# restart CP (user terminal or background): runs migration 034 on boot
curl -s -X POST localhost:7080/v1/gateway/sync         # regenerate config.yaml over the stale sample
kubectl rollout restart deploy/gateway -n devproof-gateway && kubectl rollout status deploy/gateway -n devproof-gateway
# console: rebuild already done in Task 9; restart next start
```

Verify boot: `curl -s localhost:7080/healthz` → `{"ok":true}`; CP log shows no migration errors; `kubectl get cm litellm-config -n devproof-gateway -o jsonpath='{.data.config\.yaml}' | grep -c qwen-medium` ≥ 1.

- [ ] **Step 2: Sleep path**

Set qwen-medium to min=0 with a SHORT window for the test: `PATCH /v1/deployments/qwen-medium` body `{"replicas":{"min":0,"max":1,"idleMinutes":1}}` (via console edit modal or curl with the workspace header). Then wait ~90s with no traffic and verify, in order:
1. `kubectl get isvc qwen-medium -n devproof-serving -o jsonpath='{.spec.replicas}'` → `0`
2. `kubectl get modeldeployment qwen-medium -n devproof-serving -o jsonpath='{.status.phase}'` → `Idle`
3. **PVC SURVIVES:** `kubectl get pvc qwen-medium-model-cache -n devproof-serving -o jsonpath='{.metadata.creationTimestamp}'` — unchanged from before the sleep. THE critical regression check.
4. Route survives: `kubectl get cm litellm-config -n devproof-gateway -o yaml | grep qwen-medium` still present; NO gateway rollout occurred (`kubectl get pods -n devproof-gateway` — same pod ages).
5. `model_routing`: `SELECT * FROM model_routing` (psql localhost:15432) → `qwen-medium | idle`.
6. Console: Deployments page shows the Idle badge; deployment detail shows the sleeping note.

- [ ] **Step 3: API wake path (hold-until-ready)**

```bash
time curl -s http://localhost:14000/v1/chat/completions \
  -H "Authorization: Bearer dpk_<console key>" -H "Content-Type: application/json" \
  -d '{"model":"qwen-medium","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```
Expected: blocks (held), returns 200 with a completion in well under 300s (~60-90s: pod schedule + weight load from the SURVIVING PVC — no re-download). Afterward: phase `Ready`, `model_routing` → `ready`, replicas 1, and the PVC creationTimestamp STILL unchanged.

- [ ] **Step 4: Session wake path**

Let it sleep again (~90s idle, verify phase Idle). Start a session against an agent whose model is qwen-medium (console or `POST /v1/sessions`). Verify: response carries `waitingFor: { model: "qwen-medium", phase: "Idle" }`, a `session.waiting` event appears, the deployment wakes, and after warmup the session leaves queued and runs to completion.

- [ ] **Step 5: CP-restart no-wake + cutoff**

With qwen-medium Idle again: restart the CP; wait 3 minutes; verify phase stays `Idle` (no accidental warm-wake — the routedModels/newlyRouted Ready-only semantics). Then `kubectl scale deploy -n devproof-serving qwen-medium --replicas=0` is NOT needed — instead test the 503 path by requesting a model name with a `model_routing` row forced to `waking` (UPDATE the row manually, request, wait 5 min) OR skip if time-boxed and note it.

- [ ] **Step 6: Restore + backend green**

Restore sane settings: `idleMinutes: 15` (keep min=0 if the user wants it live, else back to min=1). Run `cd control-plane && npm test && npx tsc --noEmit` and `cd operator && ~/sdk/go/bin/go test ./...` one final time. Exercise all console pages for 200s.

- [ ] **Step 7: CLAUDE.md + commit**

Add to the repo CLAUDE.md conventions (one bullet, style-matched to its neighbors):

```
- **Scale-to-zero (spec 2026-07-15, don't regress):** min=0 deployments sleep to phase `Idle` after `replicas.idleMinutes` (default 15) and stay GATEWAY-ROUTED (sleep/wake never changes gateway config — no rolling reload, so held requests survive). Wake = anyone patches `serving.devproof.ai/target-replicas: "1"` (CP: `wakeModel`); triggers are the gateway pre-call hook (PG `wake_requests` + NOTIFY `devproof_wake`, holds the request until `model_routing`='ready', 300s cutoff → 503) and the session launch gate (Idle ⇒ park + wake). `model_routing` is a CP-swept PROJECTION of (phase, warmed). THREE don't-break invariants: (1) the cache-bounce PVC delete triggers ONLY on the `serving.devproof.ai/cache-bounce` annotation — inferring it from replicas==0 deletes sleeping deployments' weights (reproduced live); (2) internal-key traffic bypasses the gateway hold or the warmup deadlocks the wake; (3) `newlyRouted`/warmup is Ready-phase-only or CP restarts wake every sleeping model.
```

```bash
git add CLAUDE.md
git commit -m "docs: scale-to-zero conventions + don't-regress invariants"
```

---

## Self-Review Notes (already applied)

- Spec §1-§7 all mapped: Task 1 (bounce fix), 2 (CRD/phase/routing), 3 (sleep), 4 (migration/wake plumbing), 5 (gate+projection), 6 (routes/wiring), 7 (API), 8 (hook), 9 (console), 10 (live verify + docs).
- The spec's migration number (034) and the internal-key hold bypass were corrected in the spec before this plan.
- Type consistency: `wakeModel(deps, model)` (Task 4) vs. `wake: (model) => Promise<void>` closures (Tasks 5/6) — main.ts binds them; `RoutingState` strings match the SQL CHECK constraint; annotation strings match `scaler.TargetReplicasAnnotation`'s literal value.
