# Placement-Change Cache Re-provision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A placement change (pool selector/tolerations, or a deployment's pool) deletes the model's per-service cache PVC and bounces its engine pods so the cache re-provisions on the target nodes — plus the LLMkube switch to perService cache mode that makes multi-node placement possible at all.

**Architecture:** The MD reconciler fetches the live ISVC before its SSA apply and compares scheduling fields via a new pure `transform.PlacementChanged`; on change (after a successful apply) it deletes `<name>-model-cache` and `DeleteAllOf`s the pods labeled `inference.llmkube.dev/service=<name>`. LLMkube's `ensureModelCachePVC` recreates the PVC on its next reconcile (verified in 0.9.4 source); WaitForFirstConsumer binds it on the new node. Infra: `deploy/llmkube/values.yaml` sets `modelCache.mode: perService` (helm upgrade, chart pinned 0.9.4). Console: dialog copy tells the truth about re-downloads.

**Tech Stack:** Go 1.26 + controller-runtime v0.24.1 (fake client for tests), Helm 3, Next.js console.

**Spec:** `docs/superpowers/specs/2026-07-12-placement-cache-reprovision-design.md`

## Global Constraints

- Go is NOT on PATH: `export PATH="$HOME/sdk/go/bin:$PATH"` (Git Bash).
- Console builds are ALWAYS production builds: `cd console && npx next build`.
- The PVC delete targets EXACTLY `<md.Name>-model-cache` — never the shared `llmkube-model-cache`.
- Pod bounce selector is EXACTLY the label `inference.llmkube.dev/service: <md.Name>`, namespace-scoped.
- Pool dialog message (exact): `Placement changed — this restarts the engine pods of N deployment(s): <names>. Their model caches re-provision on the target nodes (weights re-download; brief serving gap).`
- Deployment dialog appended sentence when poolRef changed (exact, note the leading space): ` Moving pools re-provisions the model cache on the new nodes (weights re-download).`
- Git: stage ONLY named files — NEVER `git add -A`/`git add .`. TODO.txt has an uncommitted user edit — never stage or revert it. Commit trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_018jG2NiYKGURjee1g6RWhyb`

## File Structure

- `operator/internal/transform/transform.go` — `PlacementChanged` (Task 1)
- `operator/internal/transform/transform_test.go` — its tests (Task 1)
- `operator/internal/controller/modeldeployment_controller.go` — live-Get diff, `reprovisionCache`, RBAC markers (Task 2)
- `operator/internal/controller/modeldeployment_controller_test.go` — `reprovisionCache` test (Task 2)
- `console/app/pools/pool-modal.tsx` — dialog copy (Task 3)
- `console/app/deployments/deploy-modal.tsx` — conditional copy (Task 3)
- `deploy/llmkube/values.yaml` — perService mode (Task 4)
- `CLAUDE.md` — Pools bullet update (Task 4)

---

### Task 1: `transform.PlacementChanged`

**Files:**
- Modify: `operator/internal/transform/transform.go`
- Test: `operator/internal/transform/transform_test.go`

**Interfaces:**
- Produces: `func PlacementChanged(live, desired *unstructured.Unstructured) bool` — true iff any of the spec fields `nodeSelector`, `affinity`, `tolerations` differ (semantic deep-equal; absent ≡ nil). Task 2 calls it.

- [ ] **Step 1: Write the failing tests**

Append to `operator/internal/transform/transform_test.go`:

```go
func isvcWithSpec(spec map[string]interface{}) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{"spec": spec}}
}

func TestPlacementChanged(t *testing.T) {
	base := func() map[string]interface{} {
		return map[string]interface{}{
			"modelRef": "m", "replicas": int64(1),
			"nodeSelector": map[string]interface{}{"a": "1"},
		}
	}

	if PlacementChanged(isvcWithSpec(base()), isvcWithSpec(base())) {
		t.Fatal("identical specs must not report a change")
	}

	repl := base()
	repl["replicas"] = int64(4)
	if PlacementChanged(isvcWithSpec(base()), isvcWithSpec(repl)) {
		t.Fatal("a replicas-only diff is not a placement change")
	}

	sel := base()
	sel["nodeSelector"] = map[string]interface{}{"a": "2"}
	if !PlacementChanged(isvcWithSpec(base()), isvcWithSpec(sel)) {
		t.Fatal("a nodeSelector value change must be reported")
	}

	aff := base()
	aff["affinity"] = map[string]interface{}{"nodeAffinity": map[string]interface{}{}}
	if !PlacementChanged(isvcWithSpec(base()), isvcWithSpec(aff)) {
		t.Fatal("adding affinity must be reported")
	}

	tol := base()
	tol["tolerations"] = []interface{}{map[string]interface{}{"operator": "Exists"}}
	if !PlacementChanged(isvcWithSpec(base()), isvcWithSpec(tol)) {
		t.Fatal("adding tolerations must be reported")
	}

	bare := map[string]interface{}{"modelRef": "m"}
	if PlacementChanged(isvcWithSpec(bare), isvcWithSpec(map[string]interface{}{"modelRef": "m"})) {
		t.Fatal("both sides absent must not report a change")
	}
}

// Build is deterministic (sorted affinity keys), so re-rendering the same
// pool must never look like a placement change — the no-churn guarantee.
func TestPlacementChangedStableAcrossRebuilds(t *testing.T) {
	md, pool := fixtures()
	pool.Spec.NodeSelector = map[string]string{"b": "2", "a": "1"}
	_, first := Build(md, pool, 1)
	_, second := Build(md, pool, 3) // replicas differ; placement must not
	if PlacementChanged(first, second) {
		t.Fatal("identical pool rendering must not report a placement change")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="$HOME/sdk/go/bin:$PATH" && cd operator && go test ./internal/transform/`
Expected: COMPILE ERROR — `PlacementChanged` undefined.

- [ ] **Step 3: Implement**

In `operator/internal/transform/transform.go`, add to the import block:

```go
	apiequality "k8s.io/apimachinery/pkg/api/equality"
```

Append after `ClampReplicas`:

```go
// PlacementChanged reports whether the scheduling-relevant ISVC spec fields —
// nodeSelector, affinity, tolerations — differ between the live object and
// the desired rendering. Used by the reconciler to detect placement moves
// that strand the engine pods on the old node's cache PVC (node-local
// storage): those require deleting the per-service cache PVC and bouncing
// the pods. Absent fields compare as nil, and Build renders deterministically
// (sorted affinity keys), so identical placement never reports a change.
func PlacementChanged(live, desired *unstructured.Unstructured) bool {
	for _, field := range []string{"nodeSelector", "affinity", "tolerations"} {
		a, _, _ := unstructured.NestedFieldNoCopy(live.Object, "spec", field)
		b, _, _ := unstructured.NestedFieldNoCopy(desired.Object, "spec", field)
		if !apiequality.Semantic.DeepEqual(a, b) {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: Run the full operator suite**

Run: `cd operator && go test ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add operator/internal/transform/transform.go operator/internal/transform/transform_test.go
git commit -m "feat(operator): PlacementChanged — detect ISVC scheduling-field diffs"
```

---

### Task 2: Reconciler — bounce cache PVC + pods on placement change

**Files:**
- Modify: `operator/internal/controller/modeldeployment_controller.go`
- Test: `operator/internal/controller/modeldeployment_controller_test.go`

**Interfaces:**
- Consumes: `transform.PlacementChanged(live, desired)` (Task 1).
- Produces: method `reprovisionCache(ctx context.Context, md *v1alpha1.ModelDeployment) error`; the live-Get + diff wiring inside `Reconcile`.

- [ ] **Step 1: Write the failing test**

Append to `operator/internal/controller/modeldeployment_controller_test.go`:

```go
func TestReprovisionCache(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := v1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	ns := "devproof-serving"
	pod := func(name, service, namespace string) *corev1.Pod {
		p := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace}}
		if service != "" {
			p.Labels = map[string]string{"inference.llmkube.dev/service": service}
		}
		return p
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(
		&corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "qwen-model-cache", Namespace: ns}},
		&corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "llmkube-model-cache", Namespace: ns}},
		pod("qwen-a", "qwen", ns),
		pod("qwen-b", "qwen", ns),
		pod("other-a", "other", ns),
		pod("qwen-elsewhere", "qwen", "elsewhere"),
	).Build()
	r := &ModelDeploymentReconciler{Client: c}
	md := &v1alpha1.ModelDeployment{ObjectMeta: metav1.ObjectMeta{Name: "qwen", Namespace: ns}}

	if err := r.reprovisionCache(context.Background(), md); err != nil {
		t.Fatalf("reprovisionCache: %v", err)
	}

	pvc := &corev1.PersistentVolumeClaim{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "qwen-model-cache", Namespace: ns}, pvc); !errors.IsNotFound(err) {
		t.Fatalf("per-service cache PVC must be deleted, got err=%v", err)
	}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "llmkube-model-cache", Namespace: ns}, pvc); err != nil {
		t.Fatalf("shared cache PVC must be untouched: %v", err)
	}
	for name, wantGone := range map[string]bool{"qwen-a": true, "qwen-b": true, "other-a": false} {
		p := &corev1.Pod{}
		err := c.Get(context.Background(), types.NamespacedName{Name: name, Namespace: ns}, p)
		if wantGone && !errors.IsNotFound(err) {
			t.Fatalf("pod %s must be deleted, got err=%v", name, err)
		}
		if !wantGone && err != nil {
			t.Fatalf("pod %s must survive: %v", name, err)
		}
	}
	p := &corev1.Pod{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "qwen-elsewhere", Namespace: "elsewhere"}, p); err != nil {
		t.Fatalf("pod in another namespace must survive: %v", err)
	}

	// Second call: PVC already gone — must be a NotFound no-op, not an error.
	if err := r.reprovisionCache(context.Background(), md); err != nil {
		t.Fatalf("reprovisionCache must tolerate a missing PVC: %v", err)
	}
}
```

Add to the test file's import block (keeping the existing imports):

```go
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/sdk/go/bin:$PATH" && cd operator && go test ./internal/controller/`
Expected: COMPILE ERROR — `r.reprovisionCache undefined`.

- [ ] **Step 3: Implement the method and wire it into Reconcile**

In `operator/internal/controller/modeldeployment_controller.go`:

Add to the import block:

```go
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
```

Add RBAC markers directly above `func (r *ModelDeploymentReconciler) Reconcile(`:

```go
// +kubebuilder:rbac:groups=core,resources=persistentvolumeclaims,verbs=get;delete
// +kubebuilder:rbac:groups=core,resources=pods,verbs=get;list;delete;deletecollection
```

Inside `Reconcile`, replace the single line `model, isvc := transform.Build(md, pool, replicas)` with:

```go
	model, isvc := transform.Build(md, pool, replicas)

	// Placement diff against the live ISVC BEFORE the apply. A placement move
	// strands the engine pods: with node-local storage the model-cache PVC is
	// bound to the old node, the old pod holds the RWO claim, and the
	// replacement can never become Ready on the new node. Detect it here so
	// the cache can be re-provisioned after the apply (LLMkube recreates a
	// missing per-service cache PVC on its next reconcile).
	placementMoved := false
	liveISVC := &unstructured.Unstructured{}
	liveISVC.SetGroupVersionKind(isvcGVK)
	if err := r.Get(ctx, req.NamespacedName, liveISVC); err == nil {
		placementMoved = transform.PlacementChanged(liveISVC, isvc)
	} else if !errors.IsNotFound(err) {
		return ctrl.Result{}, err
	}
```

Directly after the apply loop (after the `logger.V(1).Info("applied provider resources", ...)` line), insert:

```go
	if placementMoved {
		logger.Info("placement changed — re-provisioning model cache",
			"modeldeployment", md.Name)
		if err := r.reprovisionCache(ctx, md); err != nil {
			return ctrl.Result{}, err
		}
	}
```

Add the method below `deploymentsForPool`:

```go
// reprovisionCache deletes the deployment's per-service model-cache PVC and
// bounces its engine pods after a placement move. The old pod's pvc-protection
// finalizer parks the PVC in Terminating until the bounce releases it; LLMkube
// then recreates the PVC (ensureModelCachePVC, every ISVC reconcile) and
// WaitForFirstConsumer binds it on the node the new pod schedules to — at the
// cost of a weight re-download. The name targets ONLY the perService-mode PVC
// ("<name>-model-cache"): in shared cache mode it does not exist and the
// delete is a NotFound no-op, so the shared cache can never be destroyed here.
func (r *ModelDeploymentReconciler) reprovisionCache(ctx context.Context, md *v1alpha1.ModelDeployment) error {
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{
		Name: md.Name + "-model-cache", Namespace: md.Namespace}}
	if err := r.Delete(ctx, pvc); err != nil && !errors.IsNotFound(err) {
		return fmt.Errorf("delete model cache PVC: %w", err)
	}
	if err := r.DeleteAllOf(ctx, &corev1.Pod{}, client.InNamespace(md.Namespace),
		client.MatchingLabels{"inference.llmkube.dev/service": md.Name}); err != nil {
		return fmt.Errorf("bounce engine pods: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Run the full operator suite**

Run: `cd operator && go test ./... && go vet ./...`
Expected: PASS, no vet findings.

- [ ] **Step 5: Commit**

```bash
git add operator/internal/controller/modeldeployment_controller.go operator/internal/controller/modeldeployment_controller_test.go
git commit -m "feat(operator): placement change deletes the model-cache PVC and bounces engine pods"
```

---

### Task 3: Console — truthful re-provision copy

**Files:**
- Modify: `console/app/pools/pool-modal.tsx`
- Modify: `console/app/deployments/deploy-modal.tsx`

**Interfaces:**
- Consumes: the ConfirmDialog `message` props added by the previous feature.

- [ ] **Step 1: Update the pool dialog message**

In `console/app/pools/pool-modal.tsx`, in the `ConfirmDialog` early return, replace the `message` template literal with (exact):

```tsx
      message={`Placement changed — this restarts the engine pods of ${deployments.length} deployment${deployments.length === 1 ? "" : "s"}: ${deployments.join(", ")}. Their model caches re-provision on the target nodes (weights re-download; brief serving gap).`}
```

- [ ] **Step 2: Update the deployment dialog message**

In `console/app/deployments/deploy-modal.tsx`, in the `ConfirmDialog` early return, replace the `message` prop with (exact):

```tsx
      message={`This restarts ${ctx.name}'s engine pods.${poolRef && poolRef !== ctx.poolRef ? " Moving pools re-provisions the model cache on the new nodes (weights re-download)." : ""}`}
```

- [ ] **Step 3: Build**

Run: `cd console && npx next build`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add console/app/pools/pool-modal.tsx console/app/deployments/deploy-modal.tsx
git commit -m "feat(console): restart dialogs state cache re-provision + weight re-download"
```

---

### Task 4: Infra switch, docs, live verification

**Files:**
- Modify: `deploy/llmkube/values.yaml`
- Modify: `CLAUDE.md` (Pools bullet)

**Interfaces:**
- Consumes: everything above, deployed to the dev cluster (operator restart required — it runs `go run ./cmd` out-of-cluster).

- [ ] **Step 1: Set perService mode in the values file**

Replace the `{}` line in `deploy/llmkube/values.yaml` with:

```yaml
# perService: each InferenceService gets its own RWO WaitForFirstConsumer
# "<name>-model-cache" PVC that binds on the serving node — required for pool
# placement on this multi-node cluster (no RWX class; the shared-mode PVC
# would pin every model to one node). See spec 2026-07-12-placement-cache-reprovision.
modelCache:
  mode: perService
```

- [ ] **Step 2: Apply the helm upgrade**

```bash
helm upgrade llmkube llmkube/llmkube -n llmkube-system --version 0.9.4 -f deploy/llmkube/values.yaml
kubectl -n llmkube-system rollout status deploy/llmkube-controller-manager --timeout=120s
kubectl -n llmkube-system get deploy llmkube-controller-manager -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -o 'model-cache-mode=perService'
```

Expected: rollout complete; the arg shows `model-cache-mode=perService`.

- [ ] **Step 3: Restart the devproof operator on the new code**

Kill the running `go run ./cmd` (find it: PowerShell `Get-Process go | Select Id`; kill the go process AND its child from `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq <goPid> }`). Restart as a background task:
`export PATH="$HOME/sdk/go/bin:$PATH" && cd /c/Users/carst/Desktop/devproofai/operator && go run ./cmd`

Also restart the console if its running build predates Task 3 (`cd console && npx next build && npx next start -p 7090`). The control plane is unchanged by this plan — leave it running.

- [ ] **Step 4: Migration settles + cleanup**

Watch both models re-provision onto per-service caches (LLMkube's reconcile changes the pod template volume → pods roll → init containers re-download):

```bash
kubectl -n devproof-serving get pvc
# expect: qwen05b-dp-model-cache and qwen3-5-4b-q4-model-cache Bound; pods Running
kubectl -n devproof-serving get pods -o wide
```

If the two experiment-stranded Pending pods (from the user's earlier taint/selector test) still exist, they resolve with this rollout; if the pool still carries the experimental selector/taints that caused them, reset the pool via the console to `kubernetes.io/hostname: desktop-worker3`, no tolerations.

Then delete the now-unused shared cache and any Released local-path PVs:

```bash
kubectl -n devproof-serving delete pvc llmkube-model-cache
kubectl get pv | grep llmkube-model-cache   # any Released leftovers:
# kubectl delete pv <name> for each Released one
```

Expected: both deployments Ready; only per-service cache PVCs remain.

- [ ] **Step 5: Live verification of the bounce flow**

1. Console → Pools → edit `cpu-default`: change the selector value to `desktop-worker2`. Confirm dialog shows the NEW copy (cache re-provision sentence) listing both deployments. Restart.
2. Watch: `kubectl -n devproof-serving get pvc,pods -o wide -w` — the per-service PVCs get deleted/recreated, pods bounce, new pods schedule on desktop-worker2, init containers re-download, both deployments return Ready on worker2. This is the step that could NOT work before this plan.
3. Gateway still serves: `curl -s http://localhost:14000/v1/models -H "Authorization: Bearer $KEY" | head -c 200` with a console-managed key, or verify via the console deployment page phase Ready.
4. Flip the selector back to `desktop-worker3` → same flow in reverse → Ready on worker3.
5. Edit only Max nodes on the pool → no dialog; record `kubectl -n devproof-serving get pvc qwen05b-dp-model-cache -o jsonpath='{.metadata.uid}'` before/after → UID unchanged (no bounce without a placement change).

- [ ] **Step 6: Update CLAUDE.md**

Extend the Pools bullet's placement sentence (added by the previous feature) with (append to that sentence's end):

```
Model cache runs in LLMkube perService mode (deploy/llmkube/values.yaml): each ISVC gets its own RWO WaitForFirstConsumer "<name>-model-cache" PVC; on a placement change the operator deletes that PVC and bounces the engine pods so the cache re-provisions on the target nodes (weights re-download, brief serving gap).
```

- [ ] **Step 7: Commit**

```bash
git add deploy/llmkube/values.yaml CLAUDE.md
git commit -m "feat(deploy): perService model cache + docs for placement-change re-provision"
```

---

### Task 5: Scale-to-zero bounce (deadlock fix, spec amendment 2026-07-12)

**Files:**
- Modify: `operator/internal/controller/modeldeployment_controller.go`
- Test: `operator/internal/controller/modeldeployment_controller_test.go`

**Interfaces:**
- Consumes: `transform.PlacementChanged` (Task 1); the Task-2 wiring this task reworks.
- Produces: methods `deleteModelCachePVC(ctx, md) error` and `enginePodsRemain(ctx, md) (bool, error)`; `reprovisionCache` is REMOVED (its pod deletion caused the deadlock).

- [ ] **Step 1: Rewrite the tests**

In `operator/internal/controller/modeldeployment_controller_test.go`, DELETE the whole `TestReprovisionCache` function and add in its place:

```go
func bounceScheme(t *testing.T) *runtime.Scheme {
	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := v1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	return scheme
}

func TestDeleteModelCachePVC(t *testing.T) {
	ns := "devproof-serving"
	c := fake.NewClientBuilder().WithScheme(bounceScheme(t)).WithObjects(
		&corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "qwen-model-cache", Namespace: ns}},
		&corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "llmkube-model-cache", Namespace: ns}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "qwen-a", Namespace: ns,
			Labels: map[string]string{"inference.llmkube.dev/service": "qwen"}}},
	).Build()
	r := &ModelDeploymentReconciler{Client: c}
	md := &v1alpha1.ModelDeployment{ObjectMeta: metav1.ObjectMeta{Name: "qwen", Namespace: ns}}

	if err := r.deleteModelCachePVC(context.Background(), md); err != nil {
		t.Fatalf("deleteModelCachePVC: %v", err)
	}
	pvc := &corev1.PersistentVolumeClaim{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "qwen-model-cache", Namespace: ns}, pvc); !errors.IsNotFound(err) {
		t.Fatalf("per-service cache PVC must be deleted, got err=%v", err)
	}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "llmkube-model-cache", Namespace: ns}, pvc); err != nil {
		t.Fatalf("shared cache PVC must be untouched: %v", err)
	}
	pod := &corev1.Pod{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "qwen-a", Namespace: ns}, pod); err != nil {
		t.Fatalf("the helper must not touch pods (the drain does that): %v", err)
	}
	// Second call: PVC already gone — NotFound no-op, not an error.
	if err := r.deleteModelCachePVC(context.Background(), md); err != nil {
		t.Fatalf("deleteModelCachePVC must tolerate a missing PVC: %v", err)
	}
}

func TestEnginePodsRemain(t *testing.T) {
	ns := "devproof-serving"
	pod := func(name, service, namespace string) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace,
			Labels: map[string]string{"inference.llmkube.dev/service": service}}}
	}
	c := fake.NewClientBuilder().WithScheme(bounceScheme(t)).WithObjects(
		pod("qwen-a", "qwen", ns),
		pod("other-a", "other", ns),
		pod("qwen-elsewhere", "qwen", "elsewhere"),
	).Build()
	r := &ModelDeploymentReconciler{Client: c}
	md := func(name string) *v1alpha1.ModelDeployment {
		return &v1alpha1.ModelDeployment{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}}
	}

	remain, err := r.enginePodsRemain(context.Background(), md("qwen"))
	if err != nil || !remain {
		t.Fatalf("qwen pod exists — want remain=true, got %v err=%v", remain, err)
	}
	// Only the labeled pod in the MD's namespace counts.
	remain, err = r.enginePodsRemain(context.Background(), md("nobody"))
	if err != nil || remain {
		t.Fatalf("no pods for 'nobody' — want remain=false, got %v err=%v", remain, err)
	}
	if err := c.Delete(context.Background(), pod("qwen-a", "qwen", ns)); err != nil {
		t.Fatal(err)
	}
	remain, err = r.enginePodsRemain(context.Background(), md("qwen"))
	if err != nil || remain {
		t.Fatalf("qwen pod deleted (other-label/other-ns pods must not count) — want remain=false, got %v err=%v", remain, err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="$HOME/sdk/go/bin:$PATH" && cd operator && go test ./internal/controller/`
Expected: COMPILE ERROR — `deleteModelCachePVC`/`enginePodsRemain` undefined.

- [ ] **Step 3: Rework the reconciler**

In `operator/internal/controller/modeldeployment_controller.go`:

(a) Update the pods RBAC marker (deletecollection/delete no longer used):

```go
// +kubebuilder:rbac:groups=core,resources=pods,verbs=get;list
```

(b) Replace the placement-detection block (added by Task 2) so it also reads the live replica count:

```go
	placementMoved := false
	liveReplicas := int64(-1)
	liveISVC := &unstructured.Unstructured{}
	liveISVC.SetGroupVersionKind(isvcGVK)
	if err := r.Get(ctx, req.NamespacedName, liveISVC); err == nil {
		placementMoved = transform.PlacementChanged(liveISVC, isvc)
		if v, found, _ := unstructured.NestedInt64(liveISVC.Object, "spec", "replicas"); found {
			liveReplicas = v
		}
	} else if !errors.IsNotFound(err) {
		return ctrl.Result{}, err
	}
```

(c) Directly AFTER that block (still before the apply loop), insert the two-phase drain:

```go
	if placementMoved {
		// Phase 1 of the cache bounce: apply the NEW placement at zero
		// replicas. Deleting pods instead re-arms the race that deadlocked
		// live verification (3/3): the old ReplicaSet recreates its pod
		// first, it schedules on the OLD node and claims the freshly
		// recreated WaitForFirstConsumer cache PVC there, and the new pod
		// can never schedule while RollingUpdate keeps the old one alive.
		// At zero replicas every ReplicaSet drains, so nothing can claim
		// the PVC while phase 2 re-provisions it.
		if err := unstructured.SetNestedField(isvc.Object, int64(0), "spec", "replicas"); err != nil {
			return ctrl.Result{}, err
		}
	} else if liveReplicas == 0 {
		// Phase 2: live placement matches and live replicas are 0 — a state
		// only phase 1 produces (ClampReplicas floors desired at 1). Wait
		// until the engine pods are fully gone (Terminating pods still hold
		// the pvc-protection finalizer), then delete the cache PVC and fall
		// through to the apply, which restores the real replica count;
		// LLMkube recreates the PVC and the new pods bind it on the target
		// placement.
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
		logger.Info("cache bounce complete — restoring replicas", "modeldeployment", md.Name)
	}
```

(d) Replace the post-apply block `if placementMoved { ... r.reprovisionCache(...) }` with:

```go
	if placementMoved {
		logger.Info("placement changed — draining engine pods to re-provision the model cache",
			"modeldeployment", md.Name)
		return ctrl.Result{RequeueAfter: 3 * time.Second}, nil
	}
```

(e) DELETE the `reprovisionCache` method and add these two in its place:

```go
// enginePodsRemain reports whether any engine pods for the deployment still
// exist — Terminating included, since the PVC's pvc-protection finalizer
// holds until they are fully gone.
func (r *ModelDeploymentReconciler) enginePodsRemain(ctx context.Context, md *v1alpha1.ModelDeployment) (bool, error) {
	pods := &corev1.PodList{}
	if err := r.List(ctx, pods, client.InNamespace(md.Namespace),
		client.MatchingLabels{"inference.llmkube.dev/service": md.Name}); err != nil {
		return false, fmt.Errorf("list engine pods: %w", err)
	}
	return len(pods.Items) > 0, nil
}

// deleteModelCachePVC deletes the deployment's per-service model-cache PVC so
// LLMkube re-provisions it (ensureModelCachePVC, every ISVC reconcile) and
// WaitForFirstConsumer binds it on the new placement. Targets ONLY the
// perService-mode name "<name>-model-cache": in shared cache mode it does not
// exist and the delete is a NotFound no-op, so the shared cache can never be
// destroyed here.
func (r *ModelDeploymentReconciler) deleteModelCachePVC(ctx context.Context, md *v1alpha1.ModelDeployment) error {
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{
		Name: md.Name + "-model-cache", Namespace: md.Namespace}}
	if err := r.Delete(ctx, pvc); err != nil && !errors.IsNotFound(err) {
		return fmt.Errorf("delete model cache PVC: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Run the full suite**

Run: `cd operator && go test ./... && go vet ./...`
Expected: PASS, vet clean.

- [ ] **Step 5: Commit**

```bash
git add operator/internal/controller/modeldeployment_controller.go operator/internal/controller/modeldeployment_controller_test.go
git commit -m "fix(operator): scale-to-zero cache bounce — placement moves converge without intervention"
```

---

### Task 6: Live verification of the hands-off bounce + docs

**Files:**
- Modify: `CLAUDE.md` (Pools bullet wording)

- [ ] **Step 1: Restart the devproof operator on the new code**

Kill the running `go run ./cmd` (go process + its cmd.exe child, PowerShell), restart as a background task:
`export PATH="$HOME/sdk/go/bin:$PATH" && cd /c/Users/carst/Desktop/devproofai/operator && go run ./cmd`

- [ ] **Step 2: Hands-off placement move — the definition of done**

Via the console (http://localhost:7090/pools), edit `cpu-default`: selector value `desktop-worker3` → `desktop-worker2`, confirm the Restart dialog. Then ONLY OBSERVE — poll `kubectl -n devproof-serving get pvc,pods -o wide`. NO kubectl mutations of any kind. Expected sequence per deployment: replicas drain to 0 → cache PVC deleted (operator log "cache bounce complete — restoring replicas") → PVC recreated by LLMkube → new pod schedules on desktop-worker2 → weights re-download → deployment Ready on worker2. Both models must converge with zero intervention.

- [ ] **Step 3: Flip back**

Same flow, selector back to `desktop-worker3`. Same hands-off convergence expected. Confirm both ModelDeployments Ready, pods Running on worker3, per-service PVCs Bound, no leftover Pending pods or stray PVCs/PVs.

- [ ] **Step 4: Update CLAUDE.md**

In the Pools bullet, replace the phrase `on a placement change the operator deletes that PVC and bounces the engine pods so the cache re-provisions on the target nodes (weights re-download, brief serving gap)` with:

```
on a placement change the operator drains the deployment to zero replicas, deletes that PVC once the pods are gone, then restores replicas (stateless two-phase reconcile) so the cache re-provisions on the target nodes (weights re-download, brief serving gap)
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: scale-to-zero cache bounce wording"
```
