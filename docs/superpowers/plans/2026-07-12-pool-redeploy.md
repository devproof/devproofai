# Pool/Deployment Redeploy Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pool placement edits (node selector/tolerations) automatically roll the engine pods of every deployment on the pool, with a console confirm dialog before any restart; the pools list shows counts instead of chip noise.

**Architecture:** The operator's ModelDeployment reconciler gains a Watch on ModelPool (map function enqueues every MD whose `spec.poolRef` matches), and `transform.Build` additionally renders the pool's nodeSelector as ISVC `affinity.nodeAffinity` — LLMkube 0.9.4 applies affinity to the pod template unconditionally but drops `nodeSelector`/`tolerations` for non-GPU workloads (`deployment_builder.go` gates them behind `gpuCount > 0`). The console adds ConfirmDialog gates on pool-edit and local-deployment-edit saves that change restart-relevant fields. One control-plane read-path addition (`contextTokens` in the deployments list) enables the deployment-edit diff.

**Tech Stack:** Go 1.26 + controller-runtime v0.24.1 (operator), Fastify/TS + Node test runner (control plane), Next.js (console).

**Spec:** `docs/superpowers/specs/2026-07-12-pool-redeploy-design.md`

## Global Constraints

- Go is NOT on PATH. Prefix Go commands: `export PATH="$HOME/sdk/go/bin:$PATH"` (Git Bash).
- Console builds are ALWAYS production builds: `cd console && npx next build`.
- `matchExpressions` MUST be sorted by key — random Go map order would churn the SSA-applied ISVC every reconcile and roll pods forever.
- ConfirmDialog verb is exactly `Restart` for both dialogs.
- Pool dialog message (exact): `Placement changed — this restarts the engine pods of N deployment(s): <names>. Pods may stay Pending on new nodes until model weights are available there.` (N and names interpolated; "deployment"/"deployments" by count).
- Deployment dialog message (exact): `This restarts <name>'s engine pods.`
- Node-selector hint (exact): `key=value node labels this pool's pods must land on; no rows = any node. Saving rolls this pool's engine pods onto matching nodes.`
- Tolerations hint (exact): `let this pool's pods run on tainted nodes — taint the nodes themselves with kubectl. Currently applied to GPU pools only.`
- No new HTTP endpoints. No browser `prompt()`/`confirm()`/`alert()` (console-wide ban).
- Confirm dialogs render INSTEAD OF the parent form (conditional return), never stacked over it; cancel returns to the form with the draft intact.
- Git: stage ONLY the files you touched by name — NEVER `git add -A` or `git add .`. Commit messages end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_018jG2NiYKGURjee1g6RWhyb`

## File Structure

- `operator/internal/transform/transform.go` — add nodeSelector→nodeAffinity rendering (Task 1)
- `operator/internal/transform/transform_test.go` — affinity tests (Task 1)
- `operator/internal/controller/modeldeployment_controller.go` — pool watch + map function (Task 2)
- `operator/internal/controller/modeldeployment_controller_test.go` — NEW, map-function test (Task 2)
- `control-plane/src/server.ts` — `contextTokens` in `listDeployments` (Task 3)
- `control-plane/test/server.test.ts` — list assertion (Task 3)
- `console/app/pools/page.tsx` — count cells + pass deployment names to the edit modal (Tasks 4, 5)
- `console/app/pools/pool-modal.tsx` — restart confirm + hint copy (Task 5)
- `console/app/deployments/deploy-modal.tsx` — restart confirm + contextTokens diff (Task 6)
- `console/app/deployments/[name]/tabs.tsx` — pass `contextTokens` to EditDeploymentName (Task 6)
- `CLAUDE.md` — LLMkube limitation + pool-watch note (Task 7)

---

### Task 1: Transform — render pool nodeSelector as ISVC nodeAffinity

**Files:**
- Modify: `operator/internal/transform/transform.go` (after the tolerations block, ~line 98)
- Test: `operator/internal/transform/transform_test.go`

**Interfaces:**
- Consumes: existing `Build(md, pool, replicas)`; `pool.Spec.NodeSelector map[string]string`.
- Produces: ISVC `spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions` — one `{key, operator: "In", values: [v]}` per selector entry, sorted by key. Task 7 verifies this live.

- [ ] **Step 1: Write the failing tests**

Append to `operator/internal/transform/transform_test.go`:

```go
func TestBuildAffinityFromNodeSelector(t *testing.T) {
	md, pool := fixtures()
	pool.Spec.NodeSelector = map[string]string{"zone": "a", "disk": "ssd"} // unsorted on purpose
	_, isvc := Build(md, pool, 1)

	terms, found, err := unstructured.NestedSlice(isvc.Object, "spec", "affinity", "nodeAffinity",
		"requiredDuringSchedulingIgnoredDuringExecution", "nodeSelectorTerms")
	if err != nil || !found || len(terms) != 1 {
		t.Fatalf("expected exactly one nodeSelectorTerm, found=%v len=%d err=%v", found, len(terms), err)
	}
	exprs := terms[0].(map[string]interface{})["matchExpressions"].([]interface{})
	if len(exprs) != 2 {
		t.Fatalf("expected 2 matchExpressions, got %d", len(exprs))
	}
	// Sorted by key — random map order would churn the SSA apply and roll pods.
	first := exprs[0].(map[string]interface{})
	second := exprs[1].(map[string]interface{})
	if first["key"] != "disk" || second["key"] != "zone" {
		t.Fatalf("matchExpressions must be key-sorted, got %v then %v", first["key"], second["key"])
	}
	if first["operator"] != "In" {
		t.Fatalf("operator must be In, got %v", first["operator"])
	}
	vals := first["values"].([]interface{})
	if len(vals) != 1 || vals[0] != "ssd" {
		t.Fatalf("values must be the single selector value, got %v", vals)
	}
}

func TestBuildOmitsAffinityWhenNoSelector(t *testing.T) {
	md, pool := fixtures()
	pool.Spec.NodeSelector = nil
	_, isvc := Build(md, pool, 1)
	if _, found, _ := unstructured.NestedMap(isvc.Object, "spec", "affinity"); found {
		t.Fatal("affinity must be omitted when the pool has no nodeSelector")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="$HOME/sdk/go/bin:$PATH" && cd operator && go test ./internal/transform/`
Expected: FAIL — `TestBuildAffinityFromNodeSelector` ("expected exactly one nodeSelectorTerm").

- [ ] **Step 3: Implement the affinity rendering**

In `operator/internal/transform/transform.go`, add `"sort"` to the imports, then insert after the tolerations block (after `isvcSpec["tolerations"] = tols` closes, before the `isvc := ...` literal):

```go
	// LLMkube 0.9.4 renders ISVC nodeSelector/tolerations into the engine pod
	// template only for GPU/DRA workloads (deployment_builder.go gates them
	// behind gpuCount > 0) — CPU pods silently ignore them. Affinity is applied
	// unconditionally, so the selector is additionally expressed as a required
	// node affinity. Keys are sorted: a random map order would change the
	// applied ISVC every reconcile and roll pods forever.
	if len(pool.Spec.NodeSelector) > 0 {
		keys := make([]string, 0, len(pool.Spec.NodeSelector))
		for k := range pool.Spec.NodeSelector {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		exprs := make([]interface{}, 0, len(keys))
		for _, k := range keys {
			exprs = append(exprs, map[string]interface{}{
				"key": k, "operator": "In", "values": []interface{}{pool.Spec.NodeSelector[k]},
			})
		}
		isvcSpec["affinity"] = map[string]interface{}{
			"nodeAffinity": map[string]interface{}{
				"requiredDuringSchedulingIgnoredDuringExecution": map[string]interface{}{
					"nodeSelectorTerms": []interface{}{
						map[string]interface{}{"matchExpressions": exprs},
					},
				},
			},
		}
	}
```

- [ ] **Step 4: Run the full operator test suite**

Run: `cd operator && go test ./...`
Expected: PASS (all packages).

- [ ] **Step 5: Commit**

```bash
git add operator/internal/transform/transform.go operator/internal/transform/transform_test.go
git commit -m "feat(operator): render pool nodeSelector as ISVC nodeAffinity (LLMkube CPU gap)"
```

---

### Task 2: Operator — watch ModelPools, reconcile their deployments

**Files:**
- Modify: `operator/internal/controller/modeldeployment_controller.go`
- Create: `operator/internal/controller/modeldeployment_controller_test.go`

**Interfaces:**
- Consumes: `ModelDeploymentReconciler` (embeds `client.Client`); `v1alpha1.ModelDeploymentList`; `v1alpha1.AddToScheme`.
- Produces: method `deploymentsForPool(ctx context.Context, obj client.Object) []reconcile.Request` on the reconciler; the `Watches(&v1alpha1.ModelPool{}, ...)` wiring in `SetupWithManager`.

- [ ] **Step 1: Write the failing test**

Create `operator/internal/controller/modeldeployment_controller_test.go`:

```go
package controller

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	v1alpha1 "github.com/devproof/devproof/operator/api/v1alpha1"
)

// A pool event must enqueue exactly the deployments that reference it —
// same namespace, matching poolRef — and nothing else.
func TestDeploymentsForPool(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := v1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	mk := func(name, ns, poolRef string) *v1alpha1.ModelDeployment {
		return &v1alpha1.ModelDeployment{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
			Spec: v1alpha1.ModelDeploymentSpec{
				PoolRef: poolRef,
				Model:   v1alpha1.ModelSource{Source: "https://x/m.gguf", Format: "gguf"},
			},
		}
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(
		mk("d1", "devproof-serving", "cpu-default"),
		mk("d2", "devproof-serving", "cpu-default"),
		mk("d3", "devproof-serving", "other-pool"),
		mk("d4", "elsewhere", "cpu-default"), // other namespace — not enqueued
	).Build()
	r := &ModelDeploymentReconciler{Client: c}
	pool := &v1alpha1.ModelPool{ObjectMeta: metav1.ObjectMeta{Name: "cpu-default", Namespace: "devproof-serving"}}

	reqs := r.deploymentsForPool(context.Background(), pool)

	names := map[string]bool{}
	for _, q := range reqs {
		if q.Namespace != "devproof-serving" {
			t.Fatalf("unexpected namespace in request: %v", q)
		}
		names[q.Name] = true
	}
	if len(reqs) != 2 || !names["d1"] || !names["d2"] {
		t.Fatalf("expected exactly d1+d2, got %v", reqs)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd operator && go test ./internal/controller/`
Expected: COMPILE ERROR — `r.deploymentsForPool undefined`.

- [ ] **Step 3: Implement the map function and wire the watch**

In `operator/internal/controller/modeldeployment_controller.go`:

Add `"sigs.k8s.io/controller-runtime/pkg/reconcile"` to the imports.

Add the method (below `setStatus`, above `SetupWithManager`):

```go
// deploymentsForPool maps a ModelPool event to reconcile requests for every
// ModelDeployment that references it, so pool placement edits (node selector,
// tolerations) propagate to the engine pods without touching each deployment.
func (r *ModelDeploymentReconciler) deploymentsForPool(ctx context.Context, obj client.Object) []reconcile.Request {
	mds := &v1alpha1.ModelDeploymentList{}
	if err := r.List(ctx, mds, client.InNamespace(obj.GetNamespace())); err != nil {
		return nil
	}
	var reqs []reconcile.Request
	for _, md := range mds.Items {
		if md.Spec.PoolRef == obj.GetName() {
			reqs = append(reqs, reconcile.Request{
				NamespacedName: types.NamespacedName{Namespace: md.Namespace, Name: md.Name},
			})
		}
	}
	return reqs
}
```

In `SetupWithManager`, add the pool watch to the builder chain (between `For(...)` and the existing `Watches(ownedISVC, ...)`):

```go
	return ctrl.NewControllerManagedBy(mgr).
		For(&v1alpha1.ModelDeployment{}).
		Watches(&v1alpha1.ModelPool{}, handler.EnqueueRequestsFromMapFunc(r.deploymentsForPool)).
		Watches(ownedISVC, handler.EnqueueRequestForOwner(mgr.GetScheme(), mgr.GetRESTMapper(),
			&v1alpha1.ModelDeployment{}, handler.OnlyControllerOwner())).
		Complete(r)
```

- [ ] **Step 4: Run the full operator suite**

Run: `cd operator && go test ./... && go vet ./...`
Expected: PASS, no vet findings.

- [ ] **Step 5: Commit**

```bash
git add operator/internal/controller/modeldeployment_controller.go operator/internal/controller/modeldeployment_controller_test.go
git commit -m "feat(operator): pool watch — placement edits reconcile the pool's deployments"
```

---

### Task 3: Control plane — expose contextTokens on local deployment rows

**Files:**
- Modify: `control-plane/src/server.ts` (the `listDeployments` local mapping, ~line 271)
- Test: `control-plane/test/server.test.ts`

**Interfaces:**
- Consumes: `d.spec.model.contextTokens` from the ModelDeployment CR (written by POST/PATCH `/v1/deployments`).
- Produces: `contextTokens: number | null` on every `kind: "local"` row of `GET /v1/deployments`. Task 6's edit modal diffs against it.

- [ ] **Step 1: Write the failing test**

Append to `control-plane/test/server.test.ts` (same fixture style as the neighboring tests):

```ts
test("GET /v1/deployments exposes contextTokens on local rows", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push(
    { metadata: { name: "d-ctx" }, spec: { poolRef: "p1", model: { contextTokens: 8192 } }, status: {} },
    { metadata: { name: "d-noctx" }, spec: { poolRef: "p1", model: {} }, status: {} },
  );
  const app = buildServer(catalog, store);
  const res = await app.inject({ method: "GET", url: "/v1/deployments" });
  const rows = res.json().deployments;
  assert.equal(rows.find((d: any) => d.name === "d-ctx").contextTokens, 8192);
  assert.equal(rows.find((d: any) => d.name === "d-noctx").contextTokens, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npm test`
Expected: FAIL — `contextTokens` is `undefined`, not `8192`.

- [ ] **Step 3: Add the field**

In `control-plane/src/server.ts`, inside the `locals = items.map(...)` literal, after `engine: d.spec?.engine,`:

```ts
      contextTokens: d.spec?.model?.contextTokens ?? null,
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat(cp): expose contextTokens on local deployment rows"
```

---

### Task 4: Console — pools list shows counts, not chips

**Files:**
- Modify: `console/app/pools/page.tsx` (the selector/tolerations `<td>` cells, lines 31-39)

**Interfaces:**
- Consumes: `p.spec.nodeSelector` / `p.spec.tolerations` (unchanged data).
- Produces: cells rendering `N selector(s)` / `N toleration(s)` or muted `none`.

- [ ] **Step 1: Replace the two cells**

In `console/app/pools/page.tsx`, replace the selector and tolerations `<td>`s:

```tsx
                <td>{sel.length
                  ? `${sel.length} selector${sel.length === 1 ? "" : "s"}`
                  : <span className="muted">none</span>}</td>
                <td>{(p.spec?.tolerations ?? []).length
                  ? `${p.spec.tolerations.length} toleration${p.spec.tolerations.length === 1 ? "" : "s"}`
                  : <span className="muted">none</span>}</td>
```

(The `sel` const stays — the count uses it.)

- [ ] **Step 2: Build**

Run: `cd console && npx next build`
Expected: clean build, no type errors.

- [ ] **Step 3: Commit**

```bash
git add console/app/pools/page.tsx
git commit -m "feat(console): pools list shows selector/toleration counts"
```

---

### Task 5: Console — pool save confirms before restarting deployments

**Files:**
- Modify: `console/app/pools/pool-modal.tsx`
- Modify: `console/app/pools/page.tsx` (pass affected deployment names)

**Interfaces:**
- Consumes: `ConfirmDialog` from `../lib/modal` (props: `title, message, verb, onConfirm: () => Promise<string | null>, onClose`); deployment rows (`name`, `poolRef`) the pools page already fetches.
- Produces: `PoolModal`/`EditPoolName` accept `deployments: string[]` (names of deployments on this pool).

- [ ] **Step 1: Pass affected deployment names from the page**

In `console/app/pools/page.tsx`, replace the `inUse` helper with a names helper and pass it down:

```tsx
  const users = (name: string) =>
    deployments.filter((d: any) => d.poolRef === name).map((d: any) => d.name as string);
```

In the row, change the name cell and the In-use cell:

```tsx
                <td><EditPoolName pool={p} deployments={users(p.metadata.name)} /></td>
```

```tsx
                <td>{users(p.metadata.name).length} deployment(s)</td>
```

- [ ] **Step 2: Add the confirm gate to the modal**

In `console/app/pools/pool-modal.tsx`:

Import `ConfirmDialog`:

```tsx
import { Modal, Field, submitJson, ConfirmDialog } from "../lib/modal";
```

Change the component signatures:

```tsx
export function PoolModal({ pool, deployments = [], onClose }:
  { pool?: any; deployments?: string[]; onClose: () => void }) {
```

```tsx
export function EditPoolName({ pool, deployments }: { pool: any; deployments: string[] }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button className="namebtn" title="Edit pool" onClick={() => setOpen(true)}>{pool.metadata.name}</button>
    {open && <PoolModal pool={pool} deployments={deployments} onClose={() => setOpen(false)} />}
  </>);
}
```

Replace the `submit` const with a body builder, a placement diff, and a confirm gate (everything between `const set = ...` helpers and the `return (` stays as-is except `submit`):

```tsx
  const [pendingBody, setPendingBody] = useState<any | null>(null);

  const buildBody = () => {
    const nodeSelector = Object.fromEntries(
      d.selector.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]));
    const tolerations = d.tolerations
      .filter((t) => t.key.trim() || t.operator === "Exists")
      .map((t) => ({
        ...(t.key.trim() ? { key: t.key.trim() } : {}),
        operator: t.operator,
        ...(t.operator === "Equal" && t.value ? { value: t.value } : {}),
        ...(t.effect ? { effect: t.effect } : {}),
      }));
    return { nodeSelector, gpuType: d.gpuType || undefined,
      gpusPerNode: Number(d.gpusPerNode) || 0, maxNodes: Number(d.maxNodes) || 0, tolerations };
  };

  // Key order is irrelevant for the selector; toleration rows are user-ordered,
  // so an order change counts as a change (harmless: one extra rollout).
  const normSel = (o: Record<string, unknown> | undefined) =>
    JSON.stringify(Object.entries(o ?? {}).map(([k, v]) => [k, String(v)])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const normTols = (ts: any[] | undefined) =>
    JSON.stringify((ts ?? []).map((t) => [t.key ?? "", t.operator ?? "", t.value ?? "", t.effect ?? ""]));
  const placementChanged = (body: any) =>
    normSel(body.nodeSelector) !== normSel(pool?.spec?.nodeSelector) ||
    normTols(body.tolerations) !== normTols(pool?.spec?.tolerations);

  const send = async (body: any) => {
    const err = isEdit
      ? await submitJson("PATCH", `/v1/pools/${pool.metadata.name}`, body)
      : await submitJson("POST", "/v1/pools", { name: d.name, ...body });
    if (!err) { onClose(); router.refresh(); }
    return err;
  };

  const submit = async () => {
    const body = buildBody();
    if (isEdit && deployments.length > 0 && placementChanged(body)) { setPendingBody(body); return; }
    setBusy(true); setError(null);
    const err = await send(body);
    setBusy(false);
    if (err) setError(err);
  };
```

Add the confirm rendering as an early return, directly before the `return (` of the form modal:

```tsx
  if (pendingBody) {
    return <ConfirmDialog title="Restart engine pods?" verb="Restart"
      message={`Placement changed — this restarts the engine pods of ${deployments.length} deployment${deployments.length === 1 ? "" : "s"}: ${deployments.join(", ")}. Pods may stay Pending on new nodes until model weights are available there.`}
      onConfirm={() => send(pendingBody)} onClose={() => setPendingBody(null)} />;
  }
```

(Cancel sets `pendingBody` back to null — the form re-renders with all draft state intact because the component never unmounted.)

- [ ] **Step 3: Update the two hints**

Node selector `Field` hint (replace the whole hint string):

```
key=value node labels this pool's pods must land on; no rows = any node. Saving rolls this pool's engine pods onto matching nodes.
```

Tolerations `Field` hint:

```
let this pool's pods run on tainted nodes — taint the nodes themselves with kubectl. Currently applied to GPU pools only.
```

- [ ] **Step 4: Build**

Run: `cd console && npx next build`
Expected: clean build. (`CreatePoolButton` needs no change — `deployments` defaults to `[]` and create never confirms.)

- [ ] **Step 5: Commit**

```bash
git add console/app/pools/pool-modal.tsx console/app/pools/page.tsx
git commit -m "feat(console): confirm dialog before pool placement edits restart deployments"
```

---

### Task 6: Console — deployment edit confirms before restarting pods

**Files:**
- Modify: `console/app/deployments/deploy-modal.tsx`
- Modify: `console/app/deployments/[name]/tabs.tsx`

**Interfaces:**
- Consumes: `contextTokens` on local rows of `GET /v1/deployments` (Task 3); `ConfirmDialog` from `../lib/modal`.
- Produces: `EditDeploymentName` local variant accepts `contextTokens?: number | null`; restart-relevant diff = `contextTokens` (vs `ctx.contextTokens`), `poolRef` (vs `ctx.poolRef`), `engine` (vs `ctx.engine ?? "auto"`) — exactly the fields the PATCH body already diffs.

- [ ] **Step 1: Plumb contextTokens into the edit modal**

In `console/app/deployments/deploy-modal.tsx`:

Import `ConfirmDialog`:

```tsx
import { Modal, Field, submitJson, ConfirmDialog } from "../lib/modal";
```

Update the `Ctx` comment for `contextTokens` (the field already exists):

```tsx
  contextTokens?: number;      // deploy-local: catalog default for the placeholder; edit-local: current value (restart diff + placeholder)
```

In `EditDeploymentName`, extend the local props union and ctx:

```tsx
  | { kind: "local"; name: string; poolRef?: string; replicas?: { min: number; max: number }; engine?: string;
      contextTokens?: number | null; asButton?: boolean }
```

```tsx
    ? { name: props.name, poolRef: props.poolRef, minReplicas: props.replicas?.min, maxReplicas: props.replicas?.max,
        reserveReplicas: (props.replicas as any)?.reserve, engine: props.engine,
        contextTokens: props.contextTokens ?? undefined }
```

In `console/app/deployments/[name]/tabs.tsx`, add the prop to the local branch:

```tsx
          : <EditDeploymentName asButton kind="local" name={d.name} poolRef={d.poolRef}
              replicas={d.replicas ?? undefined} engine={d.engine}
              contextTokens={d.contextTokens ?? undefined} />}
```

- [ ] **Step 2: Add the restart diff and confirm gate**

In `DeployModal`, add state next to the other `useState` calls:

```tsx
  const [confirmRestart, setConfirmRestart] = useState(false);
```

Restructure `submit` so the four-way `submitJson` expression moves into `doSubmit` (the expression itself is copied verbatim from the current code):

```tsx
  const doSubmit = async (): Promise<string | null> => {
    const err =
      mode === "deploy-local" ? await submitJson("POST", "/v1/deployments", {
        name, catalogId: catalogId || ctx.catalogId, poolRef,
        replicas: { min: Number(minR) || 0, max: Number(maxR) || 0, reserve: Number(reserve) || 0 },
        ...(ctxTokens && !Number.isNaN(Number(ctxTokens)) ? { contextTokens: Number(ctxTokens) } : {}),
        ...(engine !== "auto" ? { engine } : {}),
      })
      : mode === "deploy-remote" ? await submitJson("POST", "/v1/deployments/external", {
        name, provider, baseUrl: baseUrl || undefined, modelId, apiKey: apiKey || undefined,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      })
      : mode === "edit-local" ? await submitJson("PATCH", `/v1/deployments/${ctx.name}`, {
        replicas: { min: Number(minR) || 0, max: Number(maxR) || 0, reserve: Number(reserve) || 0 },
        ...(ctxTokens && !Number.isNaN(Number(ctxTokens)) ? { contextTokens: Number(ctxTokens) } : {}),
        ...(poolRef && poolRef !== ctx.poolRef ? { poolRef } : {}),
        ...(engine !== (ctx.engine ?? "auto") ? { engine } : {}),
      })
      : await submitJson("PATCH", `/v1/deployments/external/${ctx.externalId}`, {
        modelId: modelId || undefined, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined,
        reasoningEffort: reasoningEffort || null,
      });
    if (!err) { onClose(); router.refresh(); }
    return err;
  };

  // Restart-relevant diff — mirrors exactly what the PATCH body sends: an
  // unchanged contextTokens is not sent and must not warn.
  const ctxNum = ctxTokens && !Number.isNaN(Number(ctxTokens)) ? Number(ctxTokens) : undefined;
  const restartChanged = mode === "edit-local" && (
    (ctxNum !== undefined && ctxNum !== ctx.contextTokens) ||
    (!!poolRef && poolRef !== ctx.poolRef) ||
    engine !== (ctx.engine ?? "auto"));

  const submit = async () => {
    if (restartChanged) { setConfirmRestart(true); return; }
    setBusy(true); setError(null);
    const err = await doSubmit();
    setBusy(false);
    if (err) setError(err);
  };
```

Add the confirm rendering as an early return directly before the main `return (`:

```tsx
  if (confirmRestart) {
    return <ConfirmDialog title="Restart engine pods?" verb="Restart"
      message={`This restarts ${ctx.name}'s engine pods.`}
      onConfirm={doSubmit} onClose={() => setConfirmRestart(false)} />;
  }
```

- [ ] **Step 3: Accurate context placeholder in edit mode (side benefit)**

Replace the Context `input` placeholder expression:

```tsx
                 placeholder={mode === "edit-local"
                   ? (ctx.contextTokens ? `${ctx.contextTokens} (current)` : "unchanged")
                   : ctxDefault ? `${ctxDefault} (catalog default)` : "engine default"} />
```

- [ ] **Step 4: Build**

Run: `cd console && npx next build`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add console/app/deployments/deploy-modal.tsx "console/app/deployments/[name]/tabs.tsx"
git commit -m "feat(console): confirm dialog before deployment edits restart engine pods"
```

---

### Task 7: Docs + live verification on docker-desktop

**Files:**
- Modify: `CLAUDE.md` (the Pools bullet)

**Interfaces:**
- Consumes: everything above, deployed to the dev cluster.
- Produces: the spec's definition of done, verified live.

- [ ] **Step 1: Update CLAUDE.md**

In the root `CLAUDE.md`, extend the **Pools** bullet (`- **Pools:** maxNodes is an enforced replica budget …`) with:

```
Pool placement edits propagate: the operator watches ModelPools and reconciles the pool's deployments; the pool nodeSelector is additionally rendered as ISVC nodeAffinity because LLMkube 0.9.4 applies ISVC nodeSelector/tolerations to GPU/DRA pods only (CPU pods ignore them — tolerations are GPU-only until fixed upstream). Console confirms before placement/config saves that restart pods.
```

- [ ] **Step 2: Fix the stored pool selector BEFORE running the new operator**

The pool `cpu-default` carries a stale `kubernetes.io/hostname: desktop-worker2` selector that never took effect. The moment the new operator starts, it WILL take effect and strand both qwen deployments Pending (their model-weight PVs are node-local to desktop-worker3). Point it at worker3 first:

```bash
kubectl -n devproof-serving patch modelpool cpu-default --type=merge -p '{"spec":{"nodeSelector":{"kubernetes.io/hostname":"desktop-worker3"}}}'
```

- [ ] **Step 3: Restart the dev processes with the new code**

- Operator: kill the running `go run ./cmd` if any, then `cd operator && go run ./cmd` (background).
- Control plane: restart `npx tsx src/main.ts` with the usual env (see CLAUDE.md run block).
- Console: `cd console && npx next build && npx next start -p 7090` (background).

- [ ] **Step 4: Verify propagation end-to-end**

```bash
# ISVC gained the affinity translation (operator startup reconcile):
kubectl -n devproof-serving get isvc qwen05b-dp -o jsonpath='{.spec.affinity}'
# → nodeAffinity … kubernetes.io/hostname In [desktop-worker3]

# Engine Deployment pod template carries it, pods rolled and are Running on worker3:
kubectl -n devproof-serving get deploy qwen05b-dp -o jsonpath='{.spec.template.spec.affinity}'
kubectl -n devproof-serving get pods -o wide | grep qwen
```

Expected: both qwen deployments' pods Running on desktop-worker3, deployments back to Ready.

- [ ] **Step 5: Verify the console flows (browser, http://localhost:7090/pools)**

1. Pools list shows `1 selector` / `none` counts — no chips.
2. Edit `cpu-default`, change the selector VALUE to `desktop-worker2`, Save → confirm dialog lists BOTH qwen deployments with the Pending warning → Restart → pods roll and go Pending (PV pinned to worker3), old pods keep serving, phase Deploying, gateway route stays up.
3. Edit again, set the value back to `desktop-worker3`, Save → confirm → pods return to Running on worker3.
4. Edit and change ONLY Max nodes → saves immediately, no dialog, no rollout.
5. Deployment detail → Edit deployment: Context placeholder shows the current value; change Context to a new value, Save → single-name confirm dialog → Restart → pod rolls (`kubectl -n devproof-serving get pods -w`); confirm the new `--ctx-size` in the pod args. Then edit changing only Replicas max → no dialog.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: pool placement propagation + LLMkube CPU-pod limitation"
```
