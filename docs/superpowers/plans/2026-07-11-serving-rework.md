# Serving Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 2026-07-11 serving rework spec: console polish, global external endpoints, enforced pool replica budgets + tolerations, reserve replicas, an operator-built queue-depth autoscaler replacing the CPU HPA, and a gateway HPA.

**Architecture:** The Go operator gains a scaler loop that scrapes llama.cpp `/metrics` via the apiserver pod proxy and writes InferenceService `spec.replicas` (the path LLMkube enforces); the MD-reconciler treats that field as scaler-owned. The control plane validates replica bounds + pool budgets and serves queue depth from CR status instead of Prometheus. The console gets reorganized dialogs, renamed columns, and new deploy entry points.

**Tech Stack:** Go (controller-runtime, client-go), Node/TS (Fastify, node:test), Next.js (prod builds only), Postgres, LLMkube 0.9.1 on docker-desktop.

**Spec:** `docs/superpowers/specs/2026-07-11-serving-rework-design.md` — read it if a requirement here seems ambiguous.

## Global Constraints

- Console is ALWAYS verified with a production build: `cd console && npx next build` (dev mode banned as too slow). No `prompt()`/`confirm()`/`alert()` — shared `Modal`/`Field`/`ConfirmDialog` from `console/app/lib/modal.tsx` only.
- Go toolchain lives at `~/sdk/go/bin` (not on PATH). Prefix Go commands: `export PATH="$PATH:$HOME/sdk/go/bin"` in each shell.
- CP tests: `cd control-plane && npm test` and `npx tsc --noEmit`. Operator tests: `cd operator && go test ./...`.
- Replica validation (exact): `0 ≤ min ≤ max`, `max ≥ 1`, `0 ≤ reserve ≤ max − min`. `min == max` legal (fixed size ⇒ reserve must be 0).
- Pool budget rule (exact): Σ(replicas.max) of deployments with `poolRef = pool` ≤ `pool.spec.maxNodes`; `maxNodes` 0/unset = unlimited.
- Budget error formats (exact):
  - deploy/edit: `pool <name>: committed max replicas <c> + requested <r> exceeds budget <b>`
  - pool lower: `pool <name>: committed max replicas <c> exceeds new budget <b>`
- Scaler constants (exact): tick 15s; `desired = clamp(inflight + reserve, max(min,1), max)`; scale up immediately; scale down only after 12 consecutive lower ticks (3 min), then to the window's max; `status.queueDepth = -1` means unknown.
- Latest SQL migration is `021_turn_deadline.sql` — this plan adds `022`.
- Deployment/pool names, CR shapes, and namespaces: ModelDeployments and ModelPools live in `devproof-serving`; engine pods carry label `app=<deployment name>` and serve metrics on port 8080 at `/metrics` (verified live).
- Commit after every task; messages in the repo's `feat(scope):` / `fix(scope):` style.

## File Structure

| File | Change |
|---|---|
| `control-plane/sql/022_external_global.sql` | create — drop workspace column |
| `control-plane/src/repo.ts` | externals go global |
| `control-plane/src/main.ts` | externals wiring loses ws |
| `control-plane/src/server.ts` | ExternalStore, pool tolerations, budget + replica validation, committedMaxReplicas, queueDepth from status |
| `control-plane/src/catalog.ts` | drop costPerHourUSD; reserve in DeploymentRequest |
| `control-plane/src/metrics.ts` | drop queue queries + mergeMetrics |
| `catalog/models.yaml` | strip costPerHourUSD |
| `operator/api/v1alpha1/types.go` | −ScalingMode, +Tolerations, +Reserve, +QueueDepth |
| `operator/internal/transform/transform.go` | Build(md, pool, replicas), tolerations, no autoscaling, ClampReplicas |
| `operator/internal/controller/modeldeployment_controller.go` | replicas scaler-owned, queueDepth preserved |
| `operator/internal/scaler/decide.go` | create — pure decision logic |
| `operator/internal/scaler/scaler.go` | create — scrape + scale loop |
| `operator/cmd/main.go` | register scaler |
| `operator/config/crd/*` | regenerated |
| `console/app/catalog/model-modal.tsx` | grouped sections, no $/hr |
| `console/app/catalog/page.tsx` | columns, subtitle, footer, contextTokens prop |
| `console/app/pools/pool-modal.tsx` | −scaling field, +tolerations, maxNodes hint |
| `console/app/pools/page.tsx` | −Scaling col, +Committed col |
| `console/app/deployments/deploy-modal.tsx` | reserve, budget check, context placeholder, model dropdown |
| `console/app/deployments/page.tsx` | columns, Deploy model button, access blurb |
| `console/app/deployments/[name]/tabs.tsx` | Target endpoint card, Req queue label |
| `console/app/globals.css` | `.modal-section`, profile grid columns |
| `deploy/gateway/litellm.yaml` | HPA, remove fixed replicas |
| `CLAUDE.md` | doc updates |

Task order: CP externals (1) → CP catalog price removal (2) → operator CRD (3) → transform (4) → reconciler (5) → scaler decide (6) → scaler loop (7) → CP pools API (8) → CP deployments API (9) → console catalog (10) → console pools (11) → console deploy modal (12) → console deployments pages (13) → gateway HPA (14) → docs + final verify (15). Tasks 1–2 are independent of 3–7; 8–9 depend on 3 (field names) but not on the scaler; 10–13 depend on 8–9.

---

### Task 1: External deployments become global

**Files:**
- Create: `control-plane/sql/022_external_global.sql`
- Modify: `control-plane/src/repo.ts:748-795`, `control-plane/src/server.ts:15-22,213-238,283-347`, `control-plane/src/main.ts:31-38`
- Test: `control-plane/test/server.test.ts:183-209` (fakeExternals) + external tests

**Interfaces:**
- Consumes: existing `external_deployments` table, `rid("mdep")` from `src/id.ts`.
- Produces: `ExternalStore` (server.ts) with NO workspace args: `create(d)`, `list()`, `getByName(name)`, `update(id, patch)`, `delete(id)`. Repo methods: `createExternalDeployment(d)`, `listExternalDeployments()` (global), `updateExternalDeployment(id, patch)`, `deleteExternalDeployment(id)`; `listAllExternalDeployments` is DELETED. Later tasks (9) rely on `externals.list()` being global.

- [ ] **Step 1: Write the migration**

```sql
-- 022: external deployments are global (site-wide), not workspace-scoped
-- (spec 2026-07-11 §2). Gateway routing was already global; this aligns
-- management visibility.
ALTER TABLE external_deployments DROP COLUMN IF EXISTS workspace_id;
```

Save as `control-plane/sql/022_external_global.sql`. `migrate()` in `db.ts` picks it up on CP boot — no registration needed.

- [ ] **Step 2: Update the failing tests first**

In `control-plane/test/server.test.ts`, replace the `fakeExternals` factory (lines 183–209) with the global shape:

```ts
function fakeExternals() {
  const rows: any[] = [];
  let seq = 0;
  const externals = {
    async create(d: any) {
      const row = { id: `mdep_t${seq++}`, name: d.name, provider: d.provider,
        base_url: d.baseUrl ?? null, model_id: d.modelId, key_version: 1, has_key: d.hasKey };
      rows.push(row); return row;
    },
    async list() { return rows; },
    async getByName(name: string) { return rows.find((r) => r.name === name) ?? null; },
    async update(id: string, p: any) {
      const r = rows.find((x) => x.id === id);
      if (!r) return null;
      if (p.baseUrl !== undefined) r.base_url = p.baseUrl;
      if (p.modelId !== undefined) r.model_id = p.modelId;
      if (p.rotateKey) { r.key_version++; r.has_key = true; }
      return r;
    },
    async delete(id: string) {
      const i = rows.findIndex((x) => x.id === id);
      return i >= 0 ? rows.splice(i, 1)[0] : null;
    },
  };
  return { externals, rows };
}
```

Then fix the one direct call site: the test at line ~256 calls
`externals.create("wrkspc_default", {...})` — drop the first argument:
`await externals.create({ name: "shared", provider: "openai", modelId: "gpt-4o", hasKey: false });`
(same for the `ext1` create at line ~277).

- [ ] **Step 3: Run tests to see them fail against the old server**

Run: `cd control-plane && npx tsc --noEmit`
Expected: type errors — `buildServer`'s `ExternalStore` still demands `ws` params.

- [ ] **Step 4: Update server.ts, repo.ts, main.ts**

`server.ts` — replace the `ExternalStore` interface (lines 15–22):

```ts
export interface ExternalStore {
  create(d: { name: string; provider: string; baseUrl?: string; modelId: string; hasKey: boolean }): Promise<any>;
  list(): Promise<any[]>;
  getByName(name: string): Promise<any | null>;
  update(id: string, patch: { baseUrl?: string; modelId?: string; rotateKey?: boolean }): Promise<any | null>;
  delete(id: string): Promise<any | null>;
}
```

Then, throughout `server.ts`:
- `syncGateway` (line 53): `externals ? await externals.list() : []`.
- `listDeployments` (line 229): `for (const e of externals ? await externals.list() : []) {`. Drop the now-unused `req` parameter of `listDeployments` and its call sites (`listDeployments()`), and delete the `ws` helper (line 27) — nothing else uses it.
- `POST /v1/gateway/sync` (line 287): `(await externals.list()).length`.
- `POST /v1/deployments/external` (line 310): `externals.create({...})`; rollback (line 315): `await externals.delete(row.id)`.
- `PATCH /v1/deployments/external/:id` (lines 326, 333): `externals.update(id, {...})`.
- `DELETE /v1/deployments/external/:id` (line 341): `externals.delete((req.params as any).id)`.

`repo.ts` (lines 748–795): remove `workspaceId` params and the column from the INSERT/WHERE clauses; delete `listAllExternalDeployments`:

```ts
  // ── External deployments (provider endpoints routed by the gateway) ──────
  // Global (site-wide) since migration 022 — like local deployments and pools.
  async createExternalDeployment(
    d: { name: string; provider: string; baseUrl?: string; modelId: string; hasKey: boolean },
  ) {
    const id = rid("mdep");
    const { rows } = await this.pool.query(
      `INSERT INTO external_deployments (id, name, provider, base_url, model_id, has_key)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, d.name, d.provider, d.baseUrl ?? null, d.modelId, d.hasKey],
    );
    return rows[0];
  }
  async listExternalDeployments() {
    const { rows } = await this.pool.query("SELECT * FROM external_deployments ORDER BY name");
    return rows;
  }
  async getExternalDeploymentByName(name: string) {
    const { rows } = await this.pool.query("SELECT * FROM external_deployments WHERE name = $1", [name]);
    return rows[0] ?? null;
  }
  async updateExternalDeployment(
    id: string,
    patch: { baseUrl?: string; modelId?: string; rotateKey?: boolean },
  ) {
    const { rows } = await this.pool.query(
      `UPDATE external_deployments SET
         base_url    = COALESCE($2, base_url),
         model_id    = COALESCE($3, model_id),
         key_version = key_version + CASE WHEN $4 THEN 1 ELSE 0 END,
         has_key     = has_key OR $4,
         updated_at  = now()
       WHERE id = $1 RETURNING *`,
      [id, patch.baseUrl ?? null, patch.modelId ?? null, patch.rotateKey === true],
    );
    return rows[0] ?? null;
  }
  async deleteExternalDeployment(id: string) {
    const { rows } = await this.pool.query(
      "DELETE FROM external_deployments WHERE id = $1 RETURNING *", [id]);
    return rows[0] ?? null;
  }
```

`main.ts` (lines 31–38):

```ts
}, {
  create: (d) => repo.createExternalDeployment(d),
  list: () => repo.listExternalDeployments(),
  getByName: (n) => repo.getExternalDeploymentByName(n),
  update: (id, p) => repo.updateExternalDeployment(id, p),
  delete: (id) => repo.deleteExternalDeployment(id),
});
```

- [ ] **Step 5: Run tests**

Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: PASS (repo.test.ts runs against live dev Postgres — the CP must have booted once with migration 022 applied; if repo external tests exist and fail on a missing column, boot the CP once: see CLAUDE.md run snippet).

- [ ] **Step 6: Commit**

```bash
git add control-plane/sql/022_external_global.sql control-plane/src/repo.ts control-plane/src/server.ts control-plane/src/main.ts control-plane/test/server.test.ts
git commit -m "feat(cp): external deployments are global, not workspace-scoped (migration 022)"
```

---

### Task 2: Remove costPerHourUSD from catalog (CP + YAML)

**Files:**
- Modify: `control-plane/src/catalog.ts:6-15`, `control-plane/src/server.ts:112-114`, `catalog/models.yaml`
- Test: existing `control-plane/test/catalog.test.ts`, `server.test.ts`

**Interfaces:**
- Produces: `CapacityProfile` WITHOUT `costPerHourUSD`. API stays tolerant: unknown keys inside submitted `capacityProfiles` items are stored as-is (no 400) — old clients keep working.

- [ ] **Step 1: Strip the type and the default profile**

`catalog.ts` — `CapacityProfile` becomes:

```ts
export interface CapacityProfile {
  gpuType: string;
  /** Cloud instance type this profile maps to (e.g. g5.xlarge, cpu-4vcpu). */
  instanceType: string;
  gpusPerReplica: number;
  vramGB: number;
  estTokensPerSec: number;
}
```

`server.ts` POST `/v1/catalog` default profile (line ~113):

```ts
      capacityProfiles: b.capacityProfiles ?? [
        { gpuType: "cpu", instanceType: "cpu-4vcpu", gpusPerReplica: 0, vramGB: 0, estTokensPerSec: 15 },
      ],
```

- [ ] **Step 2: Strip models.yaml**

Remove every `costPerHourUSD: <n>` (and the preceding `, ` inside the inline maps) from `catalog/models.yaml`, e.g.:

```yaml
      - { gpuType: cpu, instanceType: cpu-4vcpu, gpusPerReplica: 0, vramGB: 0, estTokensPerSec: 20 }
```

Also update the SCHEMA comment (line 15) to end at `estTokensPerSec`, and delete the "INSTANCE / COST REFERENCE" price column (keep the instance→hardware mapping lines, drop the `~$…` amounts) — or delete the block; either is fine as long as no `$` prices remain.

Verify: `grep -c costPerHourUSD catalog/models.yaml` → `0`.

- [ ] **Step 3: Run tests**

Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: PASS. If `catalog.test.ts` or `server.test.ts` asserts a profile object containing `costPerHourUSD`, update that assertion to the stripped shape.

- [ ] **Step 4: Commit**

```bash
git add control-plane/src/catalog.ts control-plane/src/server.ts catalog/models.yaml control-plane/test
git commit -m "feat(catalog): drop costPerHourUSD from the model entity (spec §1.5)"
```

---

### Task 3: Operator CRD fields

**Files:**
- Modify: `operator/api/v1alpha1/types.go`, `operator/internal/transform/transform_test.go:27` (fixture), `operator/api/v1alpha1/zz_generated.deepcopy.go` (regenerated), `operator/config/crd/*` (regenerated)

**Interfaces:**
- Produces: `ModelPoolSpec.Tolerations []corev1.Toleration`; `ModelPoolSpec` WITHOUT `ScalingMode`; `ReplicaBounds.Reserve int32`; `ModelDeploymentStatus.QueueDepth int32` (−1 = unknown). Tasks 4–9 use exactly these names.

- [ ] **Step 1: Edit types.go**

Add the import:

```go
import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)
```

`ModelPoolSpec` — remove the `ScalingMode` field entirely; change the `MaxNodes` comment; add `Tolerations`:

```go
// ModelPoolSpec declares homogeneous compute capacity; it never deploys anything.
type ModelPoolSpec struct {
	// NodeSelector maps the logical pool to physical nodes.
	NodeSelector map[string]string `json:"nodeSelector,omitempty"`
	// Tolerations let this pool's pods run on tainted nodes (the taints are
	// set on the nodes themselves, outside Devproof).
	Tolerations []corev1.Toleration `json:"tolerations,omitempty"`
	// GPUType is the accelerator class ("cpu" allowed). Informational + capacity math.
	GPUType string `json:"gpuType,omitempty"`
	// GPUsPerNode is the accelerator count per node.
	GPUsPerNode int32 `json:"gpusPerNode,omitempty"`
	// MaxNodes is the pool's replica budget: the summed replicas.max of the
	// deployments on this pool must not exceed it (0 = unlimited). Enforced
	// by the control plane, not in-cluster.
	MaxNodes int32 `json:"maxNodes,omitempty"`
}
```

`ReplicaBounds`:

```go
// ReplicaBounds bounds autoscaling.
type ReplicaBounds struct {
	// +kubebuilder:validation:Minimum=0
	Min int32 `json:"min"`
	// +kubebuilder:validation:Minimum=0
	Max int32 `json:"max"`
	// Reserve keeps this many warm replicas above current demand so bursts
	// don't wait for scale-up (scaler input; 0 = scale on demand only).
	// +kubebuilder:validation:Minimum=0
	// +optional
	Reserve int32 `json:"reserve,omitempty"`
}
```

`ModelDeploymentStatus` — add after `DownloadPercent`:

```go
	// QueueDepth is requests processing+deferred summed across replicas,
	// published by the operator's scaler; -1 = unknown (no replica reachable).
	// +optional
	QueueDepth int32 `json:"queueDepth"`
```

(No `omitempty`: a real 0 must serialize — the console shows 0 as a value.)

- [ ] **Step 2: Fix the transform test fixture**

`transform_test.go` line 27: delete `ScalingMode:  "static",` from the pool fixture (field no longer exists; nothing else in the fixture changes in this task).

- [ ] **Step 3: Regenerate deepcopy + CRDs**

```bash
export PATH="$PATH:$HOME/sdk/go/bin:$HOME/go/bin"
cd operator
controller-gen object paths=./api/...
controller-gen crd paths=./api/... output:crd:artifacts:config=config/crd
```

If `controller-gen` is missing: `go install sigs.k8s.io/controller-tools/cmd/controller-gen@v0.16.5` (then it's in `~/go/bin`).

Expected: `config/crd/serving.devproof.ai_modelpools.yaml` gains `tolerations`, loses `scalingMode`; `..._modeldeployments.yaml` gains `reserve` and `status.queueDepth`.

- [ ] **Step 4: Build + test compile**

Run: `cd operator && go build ./... && go test ./...`
Expected: PASS (transform tests still green — Build untouched so far).

- [ ] **Step 5: Apply CRDs to the cluster**

```bash
kubectl apply -f operator/config/crd/
```

Expected: `modelpools... configured`, `modeldeployments... configured`. Existing pool CRs silently lose `scalingMode` — intended.

- [ ] **Step 6: Commit**

```bash
git add operator/api operator/config/crd operator/internal/transform/transform_test.go
git commit -m "feat(operator): CRD fields for tolerations, reserve, queueDepth; drop scalingMode"
```

---

### Task 4: transform.Build — replicas param, tolerations, no HPA

**Files:**
- Modify: `operator/internal/transform/transform.go`
- Test: `operator/internal/transform/transform_test.go`

**Interfaces:**
- Consumes: Task 3's fields.
- Produces: `Build(md *v1alpha1.ModelDeployment, pool *v1alpha1.ModelPool, replicas int32) (*unstructured.Unstructured, *unstructured.Unstructured)` and `ClampReplicas(md *v1alpha1.ModelDeployment, current int64) int32`. `minElastic` is deleted. Task 5 and 7 call both.

- [ ] **Step 1: Write the failing tests**

Replace `TestBuildInferenceService`'s autoscaling assertions and the three autoscaling tests (`TestBuildStaticWhenMinEqualsMax`, `TestBuildElasticFloorsMinAtOne`, `TestBuildElasticUsesResourceCPUMetric`) with:

```go
func TestBuildUsesGivenReplicas(t *testing.T) {
	md, pool := fixtures()
	_, isvc := Build(md, pool, 4)
	replicas, _, _ := unstructuredInt(isvc, "spec", "replicas")
	if replicas != 4 {
		t.Fatalf("replicas must be the given count, got %d", replicas)
	}
	if _, found, _ := unstructured.NestedMap(isvc.Object, "spec", "autoscaling"); found {
		t.Fatal("autoscaling must never be set — the devproof scaler owns replicas")
	}
}

func TestBuildTolerations(t *testing.T) {
	md, pool := fixtures()
	pool.Spec.Tolerations = []corev1.Toleration{
		{Key: "gpu", Operator: corev1.TolerationOpEqual, Value: "true", Effect: corev1.TaintEffectNoSchedule},
		{Operator: corev1.TolerationOpExists},
	}
	_, isvc := Build(md, pool, 1)
	tols, _, _ := unstructured.NestedSlice(isvc.Object, "spec", "tolerations")
	if len(tols) != 2 {
		t.Fatalf("expected 2 tolerations, got %d", len(tols))
	}
	first := tols[0].(map[string]interface{})
	if first["key"] != "gpu" || first["operator"] != "Equal" || first["value"] != "true" || first["effect"] != "NoSchedule" {
		t.Fatalf("toleration not propagated: %v", first)
	}
	second := tols[1].(map[string]interface{})
	if second["operator"] != "Exists" || second["key"] != nil {
		t.Fatalf("empty fields must be omitted: %v", second)
	}
}

func TestBuildOmitsEmptyTolerations(t *testing.T) {
	md, pool := fixtures()
	_, isvc := Build(md, pool, 1)
	if _, found, _ := unstructured.NestedSlice(isvc.Object, "spec", "tolerations"); found {
		t.Fatal("tolerations must be omitted when pool has none")
	}
}

func TestClampReplicas(t *testing.T) {
	md, _ := fixtures() // min 2, max 5
	cases := []struct{ current int64; want int32 }{
		{0, 2}, {2, 2}, {4, 4}, {5, 5}, {9, 5},
	}
	for _, c := range cases {
		if got := ClampReplicas(md, c.current); got != c.want {
			t.Fatalf("ClampReplicas(%d) = %d, want %d", c.current, got, c.want)
		}
	}
	md.Spec.Replicas = v1alpha1.ReplicaBounds{Min: 0, Max: 3}
	if got := ClampReplicas(md, 0); got != 1 {
		t.Fatalf("min must floor at 1 (no scale-to-zero), got %d", got)
	}
}
```

Update the two surviving Build call sites in tests (`TestBuildModel`, `TestBuildInferenceService`, `TestBuildOmitsEmptyNodeSelector`) to `Build(md, pool, 2)` and change `TestBuildInferenceService`'s replicas assertion comment to "replicas must be the given count". Add `corev1 "k8s.io/api/core/v1"` to the test imports.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd operator && go test ./internal/transform/`
Expected: FAIL — `Build` has 2 params, `ClampReplicas` undefined.

- [ ] **Step 3: Implement**

In `transform.go`:
- Signature: `func Build(md *v1alpha1.ModelDeployment, pool *v1alpha1.ModelPool, replicas int32) (...)`.
- `"replicas": int64(md.Spec.Replicas.Min)` → `"replicas": int64(replicas)`.
- Delete the whole autoscaling block (lines 54–74) and `minElastic` (lines 104–111). Replace the comment with:

```go
	// Replicas are written by the devproof scaler (queue-depth based, see
	// internal/scaler) and enforced by LLMkube onto the engine Deployment.
	// LLMkube's own autoscaling block is never set: its 0.9.1 custom-metric
	// HPA is broken (dotted selector labels) and CPU utilization is a poor
	// signal for GPU inference.
```

- After the nodeSelector block, add:

```go
	if len(pool.Spec.Tolerations) > 0 {
		tols := make([]interface{}, 0, len(pool.Spec.Tolerations))
		for _, t := range pool.Spec.Tolerations {
			m := map[string]interface{}{}
			if t.Key != "" {
				m["key"] = t.Key
			}
			if t.Operator != "" {
				m["operator"] = string(t.Operator)
			}
			if t.Value != "" {
				m["value"] = t.Value
			}
			if t.Effect != "" {
				m["effect"] = string(t.Effect)
			}
			tols = append(tols, m)
		}
		isvcSpec["tolerations"] = tols
	}
```

- Add at the bottom (replacing minElastic):

```go
// ClampReplicas bounds a live replica count into the deployment's [min, max]
// window, min floored at 1 — true scale-to-zero needs wake-on-request and is
// not wired.
func ClampReplicas(md *v1alpha1.ModelDeployment, current int64) int32 {
	lo := md.Spec.Replicas.Min
	if lo < 1 {
		lo = 1
	}
	hi := md.Spec.Replicas.Max
	if hi < lo {
		hi = lo
	}
	switch {
	case current < int64(lo):
		return lo
	case current > int64(hi):
		return hi
	default:
		return int32(current)
	}
}
```

This breaks the controller build (`Build` call site) — expected; Task 5 fixes it. To keep THIS task's tests runnable, do Task 5's one-line call-site change here if `go test ./...` is the goal, or scope the run to `./internal/transform/`.

- [ ] **Step 4: Run tests**

Run: `cd operator && go test ./internal/transform/`
Expected: PASS.

- [ ] **Step 5: Commit** (combined with Task 5 if the controller edit was needed to compile — otherwise commit now)

```bash
git add operator/internal/transform
git commit -m "feat(operator): transform takes explicit replicas, passes tolerations, drops HPA"
```

---

### Task 5: Reconciler — replicas are scaler-owned

**Files:**
- Modify: `operator/internal/controller/modeldeployment_controller.go:62,83`

**Interfaces:**
- Consumes: `transform.Build(md, pool, replicas)`, `transform.ClampReplicas`.
- Produces: reconciler behavior later tasks and the scaler rely on: live ISVC `spec.replicas` survives reconciles (clamped); `status.queueDepth` survives reconciles.

- [ ] **Step 1: Implement the ownership rule**

Replace line 62 (`model, isvc := transform.Build(md, pool)`) with:

```go
	// spec.replicas on the ISVC is scaler-owned (internal/scaler): preserve
	// the live count (clamped to the current bounds) instead of resetting to
	// min on every reconcile. First reconcile / missing ISVC starts at min.
	replicas := transform.ClampReplicas(md, int64(md.Spec.Replicas.Min))
	live := &unstructured.Unstructured{}
	live.SetGroupVersionKind(isvcGVK)
	if err := r.Get(ctx, req.NamespacedName, live); err == nil {
		if cur, found, _ := unstructured.NestedInt64(live.Object, "spec", "replicas"); found {
			replicas = transform.ClampReplicas(md, cur)
		}
	}
	model, isvc := transform.Build(md, pool, replicas)
```

Replace line 83 (status construction) to carry the scaler's field through full-status writes:

```go
	status := v1alpha1.ModelDeploymentStatus{ReadyReplicas: int32(ready), Endpoint: endpoint,
		QueueDepth: md.Status.QueueDepth} // scaler-owned; preserved across reconciles
```

- [ ] **Step 2: Build + full test run**

Run: `cd operator && go build ./... && go test ./...`
Expected: PASS.

- [ ] **Step 3: Live smoke — replicas survive a reconcile**

With the operator running (`cd operator && go run ./cmd`):

```bash
kubectl -n devproof-serving patch inferenceservice qwen05b-dp --type merge -p '{"spec":{"replicas":2}}'
kubectl -n devproof-serving annotate modeldeployment qwen05b-dp devproof.ai/poke=$RANDOM --overwrite   # force a reconcile
sleep 5; kubectl -n devproof-serving get inferenceservice qwen05b-dp -o jsonpath='{.spec.replicas}'
```

Expected: `2` (not reset to 1) — as long as the deployment's max ≥ 2 (`deploy/models/qwen05b-devproof.yaml` has max 2). Reset afterwards: patch replicas back to 1.

- [ ] **Step 4: Commit**

```bash
git add operator/internal/controller/modeldeployment_controller.go
git commit -m "feat(operator): ISVC replicas + queueDepth are scaler-owned across reconciles"
```

---

### Task 6: Scaler decision logic (pure)

**Files:**
- Create: `operator/internal/scaler/decide.go`
- Test: `operator/internal/scaler/decide_test.go`

**Interfaces:**
- Produces (Task 7 consumes): `Desired(inflight int64, min, max, reserve int32) int32`; `type History struct{...}` with method `Next(current, desired int32) int32`; `const DownTicks = 12`; `ParseQueueMetrics(text string) (int64, bool)`.

- [ ] **Step 1: Write the failing tests**

`operator/internal/scaler/decide_test.go`:

```go
package scaler

import "testing"

func TestDesired(t *testing.T) {
	cases := []struct {
		name              string
		inflight          int64
		min, max, reserve int32
		want              int32
	}{
		{"idle stays at min", 0, 1, 5, 0, 1},
		{"demand adds up", 3, 1, 5, 0, 3},
		{"reserve rides on demand", 3, 1, 5, 1, 4},
		{"clamped to max", 9, 1, 5, 2, 5},
		{"min floors at 1", 0, 0, 3, 0, 1},
		{"idle with reserve still >= min", 0, 2, 5, 1, 2},
		{"reserve alone lifts above min", 0, 1, 5, 2, 2},
	}
	for _, c := range cases {
		if got := Desired(c.inflight, c.min, c.max, c.reserve); got != c.want {
			t.Fatalf("%s: Desired(%d,%d,%d,%d) = %d, want %d",
				c.name, c.inflight, c.min, c.max, c.reserve, got, c.want)
		}
	}
}

func TestHistoryScaleUpIsImmediate(t *testing.T) {
	h := &History{}
	if got := h.Next(1, 3); got != 3 {
		t.Fatalf("scale up must be immediate, got %d", got)
	}
}

func TestHistoryScaleDownWaitsFullWindow(t *testing.T) {
	h := &History{}
	for i := 0; i < DownTicks-1; i++ {
		if got := h.Next(5, 2); got != 5 {
			t.Fatalf("tick %d: must hold at 5 during the window, got %d", i, got)
		}
	}
	if got := h.Next(5, 2); got != 2 {
		t.Fatalf("tick %d must scale down, got %d", DownTicks, got)
	}
}

func TestHistoryScaleDownUsesWindowMax(t *testing.T) {
	h := &History{}
	h.Next(5, 2)
	h.Next(5, 4) // a burst mid-window raises the floor
	for i := 2; i < DownTicks-1; i++ {
		h.Next(5, 2)
	}
	if got := h.Next(5, 2); got != 4 {
		t.Fatalf("scale down must go to the window max (4), got %d", got)
	}
}

func TestHistoryUpResetsWindow(t *testing.T) {
	h := &History{}
	for i := 0; i < DownTicks-1; i++ {
		h.Next(5, 2)
	}
	h.Next(5, 5) // demand back — window resets
	for i := 0; i < DownTicks-1; i++ {
		if got := h.Next(5, 2); got != 5 {
			t.Fatalf("window must restart after an up/hold tick, got %d", got)
		}
	}
}

func TestParseQueueMetrics(t *testing.T) {
	text := "# HELP llamacpp:requests_processing Number of requests processing.\n" +
		"# TYPE llamacpp:requests_processing gauge\n" +
		"llamacpp:requests_processing 2\n" +
		"# TYPE llamacpp:requests_deferred gauge\n" +
		"llamacpp:requests_deferred 3\n"
	n, ok := ParseQueueMetrics(text)
	if !ok || n != 5 {
		t.Fatalf("want 5/true, got %d/%v", n, ok)
	}
	if _, ok := ParseQueueMetrics("unrelated 1\n"); ok {
		t.Fatal("missing metrics must report not-found")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd operator && go test ./internal/scaler/`
Expected: FAIL — package doesn't exist.

- [ ] **Step 3: Implement `decide.go`**

```go
// Package scaler scales ModelDeployments on engine queue depth
// (llamacpp requests processing+deferred) — spec 2026-07-11 §4.
package scaler

import (
	"strconv"
	"strings"
)

// DownTicks is the scale-down hysteresis window: desired must stay below
// current for this many consecutive ticks (12 × 15s = 3 minutes).
const DownTicks = 12

// Desired is the raw target: demand + reserve clamped into [max(min,1), max].
func Desired(inflight int64, min, max, reserve int32) int32 {
	lo := min
	if lo < 1 {
		lo = 1
	}
	if max < lo {
		return lo
	}
	d := inflight + int64(reserve)
	switch {
	case d < int64(lo):
		return lo
	case d > int64(max):
		return max
	default:
		return int32(d)
	}
}

// History carries one deployment's scale-down window between ticks.
// Scale-up (or hold) applies immediately and resets the window; scale-down
// happens only after DownTicks consecutive lower ticks, to the window's max
// desired (a mid-window burst raises the landing point).
type History struct {
	below int
	peak  int32
}

// Next feeds one tick and returns the replica count to write (== current
// means no change).
func (h *History) Next(current, desired int32) int32 {
	if desired >= current {
		h.below, h.peak = 0, 0
		return desired
	}
	h.below++
	if desired > h.peak {
		h.peak = desired
	}
	if h.below < DownTicks {
		return current
	}
	out := h.peak
	h.below, h.peak = 0, 0
	return out
}

// ParseQueueMetrics sums llamacpp:requests_processing and
// llamacpp:requests_deferred from a Prometheus text exposition. ok is false
// when neither metric is present (not a llama.cpp /metrics payload).
func ParseQueueMetrics(text string) (int64, bool) {
	var sum int64
	found := false
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "#") {
			continue
		}
		name, rest, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok || (name != "llamacpp:requests_processing" && name != "llamacpp:requests_deferred") {
			continue
		}
		v, err := strconv.ParseFloat(strings.TrimSpace(rest), 64)
		if err != nil {
			continue
		}
		sum += int64(v)
		found = true
	}
	return sum, found
}
```

- [ ] **Step 4: Run tests**

Run: `cd operator && go test ./internal/scaler/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add operator/internal/scaler
git commit -m "feat(operator): pure queue-depth scaling decision (desired + hysteresis)"
```

---

### Task 7: Scaler loop + wiring

**Files:**
- Create: `operator/internal/scaler/scaler.go`
- Modify: `operator/cmd/main.go`

**Interfaces:**
- Consumes: Task 6's `Desired`/`History`/`ParseQueueMetrics`; Task 4's `transform.ClampReplicas`; label `app=<deployment name>`; metric port 8080 path `/metrics`.
- Produces: `Scaler{Client client.Client, Clientset kubernetes.Interface, Interval time.Duration}` implementing `manager.Runnable` via `Start(ctx)`. Writes `md.status.queueDepth` and ISVC `spec.replicas`.

- [ ] **Step 1: Implement `scaler.go`**

```go
package scaler

import (
	"context"
	"fmt"
	"time"

	"github.com/go-logr/logr"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	v1alpha1 "github.com/devproof/devproof/operator/api/v1alpha1"
	"github.com/devproof/devproof/operator/internal/transform"
)

var isvcGVK = schema.GroupVersionKind{
	Group: "inference.llmkube.dev", Version: "v1alpha1", Kind: "InferenceService",
}

// Scaler scrapes each deployment's engine pods and adjusts ISVC replicas.
// Scrapes go through the apiserver pod proxy so the loop works both
// in-cluster and in the out-of-cluster dev topology (pod IPs are not
// routable from the host).
type Scaler struct {
	Client    client.Client
	Clientset kubernetes.Interface
	Interval  time.Duration
	hist      map[string]*History
}

func (s *Scaler) Start(ctx context.Context) error {
	logger := ctrl.Log.WithName("scaler")
	s.hist = map[string]*History{}
	ticker := time.NewTicker(s.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			s.tick(ctx, logger)
		}
	}
}

func (s *Scaler) tick(ctx context.Context, logger logr.Logger) {
	mds := &v1alpha1.ModelDeploymentList{}
	if err := s.Client.List(ctx, mds); err != nil {
		logger.Error(err, "list modeldeployments")
		return
	}
	seen := map[string]bool{}
	for i := range mds.Items {
		md := &mds.Items[i]
		seen[md.Namespace+"/"+md.Name] = true
		s.reconcileOne(ctx, logger, md)
	}
	for k := range s.hist { // drop windows of deleted deployments
		if !seen[k] {
			delete(s.hist, k)
		}
	}
}

func (s *Scaler) reconcileOne(ctx context.Context, logger logr.Logger, md *v1alpha1.ModelDeployment) {
	inflight, reachable := s.scrape(ctx, md)

	// Publish queue depth on every tick (fixed-size deployments too) so the
	// console column is live; -1 = unknown.
	depth := int32(-1)
	if reachable {
		depth = int32(inflight)
	}
	if md.Status.QueueDepth != depth {
		md.Status.QueueDepth = depth
		if err := s.Client.Status().Update(ctx, md); err != nil {
			logger.V(1).Info("queueDepth update skipped (conflict, next tick retries)", "md", md.Name)
		}
	}

	if md.Spec.Replicas.Max <= md.Spec.Replicas.Min || !reachable {
		return // fixed size, or blind this tick — never scale blind
	}

	isvc := &unstructured.Unstructured{}
	isvc.SetGroupVersionKind(isvcGVK)
	if err := s.Client.Get(ctx, types.NamespacedName{Namespace: md.Namespace, Name: md.Name}, isvc); err != nil {
		return
	}
	cur, found, _ := unstructured.NestedInt64(isvc.Object, "spec", "replicas")
	if !found {
		return
	}
	current := transform.ClampReplicas(md, cur)

	key := md.Namespace + "/" + md.Name
	h := s.hist[key]
	if h == nil {
		h = &History{}
		s.hist[key] = h
	}
	desired := Desired(inflight, md.Spec.Replicas.Min, md.Spec.Replicas.Max, md.Spec.Replicas.Reserve)
	next := h.Next(current, desired)
	if next == current {
		return
	}
	patch := []byte(fmt.Sprintf(`{"spec":{"replicas":%d}}`, next))
	if err := s.Client.Patch(ctx, isvc, client.RawPatch(types.MergePatchType, patch)); err != nil {
		logger.Error(err, "scale", "md", md.Name, "to", next)
		return
	}
	logger.Info("scaled", "md", md.Name, "from", current, "to", next, "inflight", inflight, "reserve", md.Spec.Replicas.Reserve)
}

// scrape sums queue depth over the deployment's running engine pods via the
// apiserver pod proxy. reachable is false when no pod answered.
func (s *Scaler) scrape(ctx context.Context, md *v1alpha1.ModelDeployment) (int64, bool) {
	pods, err := s.Clientset.CoreV1().Pods(md.Namespace).List(ctx,
		listOptions("app=" + md.Name))
	if err != nil {
		return 0, false
	}
	var sum int64
	reached := false
	for _, p := range pods.Items {
		if p.Status.Phase != "Running" {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		raw, err := s.Clientset.CoreV1().Pods(md.Namespace).
			ProxyGet("http", p.Name, "8080", "metrics", nil).DoRaw(cctx)
		cancel()
		if err != nil {
			continue
		}
		if n, ok := ParseQueueMetrics(string(raw)); ok {
			sum += n
			reached = true
		}
	}
	return sum, reached
}
```

One helper this snippet references, defined at the bottom of the same file:

```go
func listOptions(selector string) metav1.ListOptions {
	return metav1.ListOptions{LabelSelector: selector}
}
```

Run `go mod tidy` if `go-logr` isn't already a direct dependency (controller-runtime brings it).

- [ ] **Step 2: Wire into main.go**

In `operator/cmd/main.go`, add imports `"time"`, `"k8s.io/client-go/kubernetes"`, `"github.com/devproof/devproof/operator/internal/scaler"`; after the controller setup (line 43):

```go
	clientset, err := kubernetes.NewForConfig(mgr.GetConfig())
	if err != nil {
		setupLog.Error(err, "create clientset")
		os.Exit(1)
	}
	if err := mgr.Add(&scaler.Scaler{
		Client: mgr.GetClient(), Clientset: clientset, Interval: 15 * time.Second,
	}); err != nil {
		setupLog.Error(err, "add scaler")
		os.Exit(1)
	}
```

- [ ] **Step 3: Build + unit tests**

Run: `cd operator && go build ./... && go test ./...`
Expected: PASS.

- [ ] **Step 4: Live verification (docker-desktop, out-of-cluster operator)**

Terminal A: `cd operator && go run ./cmd`. Within ~30s the qwen deployment's status should carry a real queue depth:

```bash
kubectl -n devproof-serving get modeldeployment qwen05b-dp -o jsonpath='{.status.queueDepth}'
```

Expected: `0` (idle). Then generate load — qwen05b-dp has replicas min 1 / max 2; fire 4 parallel completions through the gateway (model `qwen05b-dp`, any dpk_ key) and watch:

```bash
for i in 1 2 3 4; do curl -s http://localhost:14000/v1/chat/completions \
  -H "Authorization: Bearer $DPK" -H 'Content-Type: application/json' \
  -d '{"model":"qwen05b-dp","messages":[{"role":"user","content":"count to 200"}],"max_tokens":400}' >/dev/null & done
kubectl -n devproof-serving get inferenceservice qwen05b-dp -o jsonpath='{.spec.replicas}'; echo
```

Expected: queueDepth rises above 0 and within one or two ticks `spec.replicas` becomes `2` (clamped by max), a second engine pod starts; ~3 minutes after the load ends it scales back to 1. Operator log lines `scaled ... from 1 to 2 ...` confirm.

- [ ] **Step 5: Commit**

```bash
git add operator/internal/scaler operator/cmd/main.go
git commit -m "feat(operator): queue-depth scaler loop (pod-proxy scrape, ISVC replica writes)"
```

---

### Task 8: CP pools API — tolerations, committed, budget guard, no scalingMode

**Files:**
- Modify: `control-plane/src/server.ts:152-211`
- Test: `control-plane/test/server.test.ts` pool tests

**Interfaces:**
- Produces: `GET /v1/pools` → `{ pools: [{ ...poolCR, committedMaxReplicas: number }] }`; `PoolBody` accepts `tolerations?: {key?, operator?, value?, effect?}[]`; `PATCH /v1/pools/:name` 400s on budget violation (exact message from Global Constraints). Console tasks 11–12 consume this shape.

- [ ] **Step 1: Update the failing tests**

In `server.test.ts`, the POST test (line ~77) currently sends and asserts `scalingMode` — replace both pool tests and add three:

```ts
test("POST /v1/pools validates DNS-1035 name and writes a typed spec", async () => {
  const { store, objects } = fakeStore();
  const app = buildServer(catalog, store);
  assert.equal((await app.inject({ method: "POST", url: "/v1/pools", payload: { name: "My Pool" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/v1/pools",
    payload: { name: "ok", tolerations: [{ key: "x", operator: "Sometimes" }] } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/v1/pools",
    payload: { name: "ok", tolerations: [{ key: "x", effect: "Never" }] } })).statusCode, 400);
  const res = await app.inject({ method: "POST", url: "/v1/pools", payload: {
    name: "gpu-a100", nodeSelector: { "devproof.ai/pool": "gpu-a100" },
    gpuType: "nvidia-a100", gpusPerNode: 4, maxNodes: 8,
    tolerations: [{ key: "gpu", operator: "Equal", value: "true", effect: "NoSchedule" }],
  } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(objects.modelpools[0].spec, {
    nodeSelector: { "devproof.ai/pool": "gpu-a100" },
    gpuType: "nvidia-a100", gpusPerNode: 4, maxNodes: 8,
    tolerations: [{ key: "gpu", operator: "Equal", value: "true", effect: "NoSchedule" }],
  });
});

test("GET /v1/pools reports committed max replicas per pool", async () => {
  const { store, objects } = fakeStore();
  objects.modelpools.push({ metadata: { name: "p1" }, spec: { maxNodes: 5 } });
  objects.modeldeployments.push(
    { metadata: { name: "d1" }, spec: { poolRef: "p1", replicas: { min: 1, max: 2 } }, status: {} },
    { metadata: { name: "d2" }, spec: { poolRef: "p1", replicas: { min: 0, max: 3 } }, status: {} },
  );
  const app = buildServer(catalog, store);
  const res = await app.inject({ method: "GET", url: "/v1/pools" });
  assert.equal(res.json().pools[0].committedMaxReplicas, 5);
});

test("PATCH /v1/pools/:name rejects lowering maxNodes below the committed sum", async () => {
  const { store, objects } = fakeStore();
  objects.modelpools.push({ metadata: { name: "p1" }, spec: { maxNodes: 5 } });
  objects.modeldeployments.push(
    { metadata: { name: "d1" }, spec: { poolRef: "p1", replicas: { min: 1, max: 4 } }, status: {} });
  const app = buildServer(catalog, store);
  const bad = await app.inject({ method: "PATCH", url: "/v1/pools/p1", payload: { maxNodes: 3 } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, "pool p1: committed max replicas 4 exceeds new budget 3");
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/pools/p1", payload: { maxNodes: 4 } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/pools/p1", payload: { maxNodes: 0 } })).statusCode, 200); // 0 = unlimited
});
```

Keep the existing PATCH-nodeSelector-replacement and DELETE-guard tests; in the PATCH test drop any `scalingMode` remnants.

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && npm test`
Expected: the new tests FAIL (tolerations rejected silently, no committedMaxReplicas, no budget guard).

- [ ] **Step 3: Implement**

Replace lines 152–169 of `server.ts`:

```ts
  // Committed = sum of max replicas of the deployments on a pool; maxNodes is
  // the budget it must stay under (0/unset = unlimited). Spec 2026-07-11 §3.2.
  const committedByPool = async (): Promise<Record<string, number>> => {
    const committed: Record<string, number> = {};
    for (const d of await store.list("modeldeployments")) {
      const p = d.spec?.poolRef;
      if (p) committed[p] = (committed[p] ?? 0) + (d.spec?.replicas?.max ?? 0);
    }
    return committed;
  };

  app.get("/v1/pools", async () => {
    const [pools, committed] = await Promise.all([store.list("modelpools"), committedByPool()]);
    return { pools: pools.map((p: any) => ({ ...p, committedMaxReplicas: committed[p.metadata.name] ?? 0 })) };
  });

  const DNS1035 = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
  type Toleration = { key?: string; operator?: string; value?: string; effect?: string };
  type PoolBody = { nodeSelector?: Record<string, string>; gpuType?: string;
                    gpusPerNode?: number; maxNodes?: number; tolerations?: Toleration[] };
  const poolSpecOf = (b: PoolBody, reply: any): Record<string, unknown> | null => {
    for (const t of b.tolerations ?? []) {
      if (t.operator && !["Exists", "Equal"].includes(t.operator)) {
        reply.code(400).send({ error: "toleration operator must be Exists or Equal" });
        return null;
      }
      if (t.effect && !["NoSchedule", "PreferNoSchedule", "NoExecute"].includes(t.effect)) {
        reply.code(400).send({ error: "toleration effect must be NoSchedule, PreferNoSchedule or NoExecute" });
        return null;
      }
    }
    const spec: Record<string, unknown> = {};
    if (b.nodeSelector !== undefined) spec.nodeSelector = b.nodeSelector;
    if (b.gpuType !== undefined) spec.gpuType = b.gpuType;
    if (typeof b.gpusPerNode === "number") spec.gpusPerNode = b.gpusPerNode;
    if (typeof b.maxNodes === "number") spec.maxNodes = b.maxNodes;
    if (b.tolerations !== undefined) spec.tolerations = b.tolerations;
    return spec;
  };
```

In `PATCH /v1/pools/:name`, after `if (!spec) return;` insert:

```ts
    if (typeof spec.maxNodes === "number" && spec.maxNodes > 0) {
      const committed = (await committedByPool())[name] ?? 0;
      if (committed > spec.maxNodes)
        return reply.code(400).send({ error: `pool ${name}: committed max replicas ${committed} exceeds new budget ${spec.maxNodes}` });
    }
```

(Arrays under JSON merge patch replace wholesale, so `tolerations` needs no null-out dance like `nodeSelector`.)

- [ ] **Step 4: Run tests**

Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat(cp): pool tolerations, committed-replica reporting, maxNodes budget guard"
```

---

### Task 9: CP deployments API — reserve validation, budget, queueDepth from status

**Files:**
- Modify: `control-plane/src/server.ts:213-238,251-271,370-392`, `control-plane/src/catalog.ts:33-39,69`, `control-plane/src/metrics.ts:22-32,65-83`
- Test: `control-plane/test/server.test.ts`, `control-plane/test/metrics.test.ts`

**Interfaces:**
- Consumes: Task 8's `committedByPool`.
- Produces: `DeploymentRequest.replicas?: { min: number; max: number; reserve?: number }`; deployments rows expose `queueDepth: number|null` (from `status.queueDepth`, −1/missing → null) and `replicas` incl. `reserve`; `fetchServingMetrics()` returns `{ tokens }` only; `mergeMetrics` deleted. Error strings exactly as in Global Constraints. Console tasks 12–13 rely on all of this.

- [ ] **Step 1: Write the failing tests**

Append to `server.test.ts`:

```ts
test("deployment replicas validation: reserve bounds and integer checks", async () => {
  const { store, objects } = fakeStore();
  objects.modelpools.push({ metadata: { name: "cpu-default" }, spec: {} });
  const app = buildServer(catalog, store);
  const post = (replicas: any) => app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: `r${Math.random().toString(36).slice(2, 8)}`, catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "cpu-default", replicas } });
  assert.equal((await post({ min: 2, max: 1 })).statusCode, 400);
  assert.equal((await post({ min: 0, max: 0 })).statusCode, 400);
  assert.equal((await post({ min: 1, max: 3, reserve: 3 })).statusCode, 400); // > max - min
  assert.equal((await post({ min: 1, max: 1, reserve: 1 })).statusCode, 400); // fixed size => reserve 0
  assert.equal((await post({ min: 1.5, max: 3 })).statusCode, 400);
  const ok = await post({ min: 1, max: 3, reserve: 2 });
  assert.equal(ok.statusCode, 201);
  assert.deepEqual(ok.json().spec.replicas, { min: 1, max: 3, reserve: 2 });
});

test("pool budget blocks over-committing deploys and edits", async () => {
  const { store, objects } = fakeStore();
  objects.modelpools.push({ metadata: { name: "small" }, spec: { maxNodes: 3 } });
  objects.modeldeployments.push({ metadata: { name: "d1" },
    spec: { poolRef: "small", replicas: { min: 1, max: 2 } }, status: {} });
  const app = buildServer(catalog, store);
  const blocked = await app.inject({ method: "POST", url: "/v1/deployments", payload: {
    name: "d2", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "small", replicas: { min: 1, max: 2 } } });
  assert.equal(blocked.statusCode, 400);
  assert.equal(blocked.json().error, "pool small: committed max replicas 2 + requested 2 exceeds budget 3");
  assert.equal((await app.inject({ method: "POST", url: "/v1/deployments", payload: {
    name: "d2", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "small", replicas: { min: 1, max: 1 } } })).statusCode, 201);
  // raising d1's max to 3 would make 3 + 1 > 3
  const editUp = await app.inject({ method: "PATCH", url: "/v1/deployments/d1",
    payload: { replicas: { min: 1, max: 3 } } });
  assert.equal(editUp.statusCode, 400);
  assert.equal(editUp.json().error, "pool small: committed max replicas 1 + requested 3 exceeds budget 3");
  // same max stays fine (own committed excluded)
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/deployments/d1",
    payload: { replicas: { min: 1, max: 2 } } })).statusCode, 200);
});

test("deployments expose queueDepth from CR status (-1/missing => null, 0 is a value)", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push(
    { metadata: { name: "a" }, spec: {}, status: { queueDepth: 0 } },
    { metadata: { name: "b" }, spec: {}, status: { queueDepth: -1 } },
    { metadata: { name: "c" }, spec: {}, status: {} },
  );
  const app = buildServer(catalog, store);
  const rows = (await app.inject({ method: "GET", url: "/v1/deployments" })).json().deployments;
  assert.equal(rows.find((d: any) => d.name === "a").queueDepth, 0);
  assert.equal(rows.find((d: any) => d.name === "b").queueDepth, null);
  assert.equal(rows.find((d: any) => d.name === "c").queueDepth, null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && npm test`
Expected: new tests FAIL.

- [ ] **Step 3: Implement**

`catalog.ts` — `DeploymentRequest.replicas` gains reserve, and resolve passes it through:

```ts
  replicas?: { min: number; max: number; reserve?: number };
```

and in `resolveDeployment` (line 69): `replicas: req.replicas ?? { min: 1, max: 1 },` (unchanged line — passthrough already covers reserve since the object is used as-is; just confirm nothing strips it).

`server.ts` — add helpers next to `committedByPool`:

```ts
  // Spec 2026-07-11 §4.2: 0 ≤ min ≤ max, max ≥ 1, 0 ≤ reserve ≤ max − min.
  const replicasError = (r: any): string | null => {
    const { min, max } = r ?? {};
    const reserve = r?.reserve ?? 0;
    if (![min, max, reserve].every(Number.isInteger)) return "replicas needs integer min and max (reserve optional)";
    if (min < 0 || max < 1 || max < min) return "replicas: need 0 <= min <= max and max >= 1";
    if (reserve < 0 || reserve > max - min) return `replicas: reserve must be between 0 and max - min (${max - min})`;
    return null;
  };
  // §3.2: budget check against the target pool, excluding the deployment's own row on edits.
  const poolBudgetError = async (poolName: string, requestedMax: number, exclude?: string): Promise<string | null> => {
    const pool = await store.get("modelpools", poolName);
    const budget = pool?.spec?.maxNodes ?? 0;
    if (!budget) return null;
    const committed = (await store.list("modeldeployments"))
      .filter((d: any) => d.spec?.poolRef === poolName && d.metadata.name !== exclude)
      .reduce((s: number, d: any) => s + (d.spec?.replicas?.max ?? 0), 0);
    return committed + requestedMax > budget
      ? `pool ${poolName}: committed max replicas ${committed} + requested ${requestedMax} exceeds budget ${budget}`
      : null;
  };
```

`POST /v1/deployments` — after the reserved-name/collision checks, before `resolveDeployment`:

```ts
    if (b.replicas) {
      const err = replicasError(b.replicas);
      if (err) return reply.code(400).send({ error: err });
    }
    const budgetErr = await poolBudgetError(b.poolRef, b.replicas?.max ?? 1);
    if (budgetErr) return reply.code(400).send({ error: budgetErr });
```

`PATCH /v1/deployments/:name` — replace the numeric min/max check (lines 377–378) with `replicasError`, and add the budget check after the 404 check:

```ts
    if (b.replicas) {
      const err = replicasError(b.replicas);
      if (err) return reply.code(400).send({ error: err });
    }
    const current = await store.get("modeldeployments", name);
    if (!current) return reply.code(404).send({ error: "not found" });
    const targetPool = b.poolRef ?? current.spec?.poolRef;
    const newMax = b.replicas?.max ?? current.spec?.replicas?.max ?? 1;
    if (b.replicas || b.poolRef) {
      const budgetErr = await poolBudgetError(targetPool, newMax, name);
      if (budgetErr) return reply.code(400).send({ error: budgetErr });
    }
```

and write reserve explicitly (RFC 7386 merges nested objects — omitting reserve would keep a stale value):

```ts
    if (b.replicas) spec.replicas = { min: b.replicas.min, max: b.replicas.max, reserve: b.replicas.reserve ?? 0 };
```

`listDeployments` — queue from status, Prometheus only for tokens:

```ts
  const listDeployments = async (): Promise<any[]> => {
    const items = await store.list("modeldeployments");
    const { tokens } = await fetchServingMetrics();
    const locals = items.map((d: any) => ({
      kind: "local",
      name: d.metadata.name,
      catalogId: d.spec?.catalogId,
      poolRef: d.spec?.poolRef,
      replicas: d.spec?.replicas ?? null,
      phase: d.status?.phase ?? "Pending",
      downloadPercent: d.status?.downloadPercent ?? null,
      endpoint: d.status?.endpoint,
      readyReplicas: d.status?.readyReplicas ?? 0,
      tokensPerSec: tokens[d.metadata.name] ?? null,
      // Scaler-published (spec §4.3): -1/missing = unknown => null; 0 is a value.
      queueDepth: (d.status?.queueDepth ?? -1) >= 0 ? d.status.queueDepth : null,
    }));
    for (const e of externals ? await externals.list() : []) {
      locals.push({
        kind: "external", id: e.id, name: e.name, provider: e.provider, modelId: e.model_id,
        baseUrl: e.base_url, phase: "External", downloadPercent: null, readyReplicas: 0,
        tokensPerSec: null, queueDepth: null,
      } as any);
    }
    locals.sort((a, b) => a.name.localeCompare(b.name));
    return locals;
  };
```

Drop `mergeMetrics` from the import at the top. `metrics.ts`: delete `mergeMetrics` (lines 22–32) and shrink `fetchServingMetrics` to tokens only:

```ts
export async function fetchServingMetrics(baseUrl = PROMETHEUS_URL) {
  const q = async (metric: string) => {
    try {
      const url = `${baseUrl}/api/v1/query?query=${encodeURIComponent(servingMetricsQuery(metric))}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return parseVector(await res.json());
    } catch {
      return {}; // metrics are best-effort decoration
    }
  };
  // Queue depth is NOT fetched here anymore — the operator's scaler publishes
  // it in ModelDeployment status (works without Prometheus).
  return { tokens: await q("llamacpp:predicted_tokens_seconds") };
}
```

Update `metrics.test.ts`: delete `mergeMetrics` tests; keep `parseVector`/`observedByCatalogId`/`servingMetricsQuery` tests.

- [ ] **Step 4: Run tests**

Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: PASS. (The pre-existing `GET /v1/deployments merges external rows` test still passes — external rows keep `queueDepth: null`.)

- [ ] **Step 5: Commit**

```bash
git add control-plane/src control-plane/test
git commit -m "feat(cp): reserve validation, pool budget enforcement, queueDepth from CR status"
```

---

### Task 10: Console — model dialog regroup + catalog page columns

**Files:**
- Modify: `console/app/catalog/model-modal.tsx`, `console/app/catalog/page.tsx`, `console/app/globals.css`

**Interfaces:**
- Consumes: Task 2's stripped profiles.
- Produces: `.modal-section` CSS class (Task 11 may reuse). No API changes.

- [ ] **Step 1: Add the section-header style**

In `globals.css`, next to the existing modal styles, add:

```css
.modal-section {
  margin: 16px 0 10px; padding-bottom: 4px;
  font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
  color: var(--muted); border-bottom: 1px solid var(--line);
}
.modal-section:first-child { margin-top: 0; }
```

(If `--line` isn't a defined variable, use the border color the other tables/cards use — grep `border: 1px solid` in the file and match.)

Also find the `.profile-head`/`.profile-row` grid rule and remove one column from `grid-template-columns` (the $/hr column is gone; e.g. 6 tracks + button → 5 tracks + button).

- [ ] **Step 2: Regroup model-modal.tsx**

Remove `costPerHourUSD` from `ProfileDraft`, `EMPTY_PROFILE`, `toDraft`, `toBody`. Then reorder the modal body into the approved layout (all `Field` components already exist — this is reordering plus four `<div className="modal-section">` headers):

```tsx
      <div className="modal-section">Identity</div>
      <Field label="Display name" required>
        <input value={d.displayName} onChange={(e) => set("displayName", e.target.value)} placeholder="My Qwen 1.5B" />
      </Field>
      <Field label="Family / params">
        <input style={{ width: 130, flex: "none" }} value={d.family} onChange={(e) => set("family", e.target.value)} />
        <input style={{ width: 90, flex: "none" }} value={d.parameters} onChange={(e) => set("parameters", e.target.value)} placeholder="1.5B" />
      </Field>
      <Field label="License">
        <input style={{ width: 160, flex: "none" }} value={d.license} onChange={(e) => set("license", e.target.value)} placeholder="apache-2.0" />
      </Field>

      <div className="modal-section">Artifact</div>
      <Field label="Source" required stack hint="HF resolve URL for GGUF, or repo id for safetensors">
        <input value={d.source} onChange={(e) => set("source", e.target.value)}
               placeholder="https://huggingface.co/…/resolve/main/model-Q4_K_M.gguf" />
      </Field>
      <Field label="Format">
        <select value={d.format} onChange={(e) => set("format", e.target.value)} style={{ flex: "none", width: 190 }}>
          <option value="gguf">GGUF (llama.cpp)</option>
          <option value="safetensors">safetensors (vLLM)</option>
        </select>
        {d.format === "gguf" && (<>
          <span className="muted">quant</span>
          <input style={{ width: 110, flex: "none" }} value={d.quantization} onChange={(e) => set("quantization", e.target.value)} />
        </>)}
      </Field>
      <Field label="Context">
        <input style={{ width: 110, flex: "none" }} value={d.contextTokens} onChange={(e) => set("contextTokens", e.target.value)} placeholder="tokens" />
        <span className="muted">tokens</span>
      </Field>

      <div className="modal-section">Capability</div>
      <Field label="Tool calling" hint="how well the model drives agent tools">
        <select value={d.toolCalling} onChange={(e) => set("toolCalling", e.target.value)} style={{ flex: "none", width: 130 }}>
          <option value="strong">strong</option><option value="basic">basic</option><option value="none">none</option>
        </select>
      </Field>
      <Field label="Requirements" hint="per replica: GPU count, VRAM, disk for weights">
        <span className="muted">GPUs</span>
        <input style={{ width: 60, flex: "none" }} value={d.gpus} onChange={(e) => set("gpus", e.target.value)} />
        <span className="muted">VRAM GB</span>
        <input style={{ width: 70, flex: "none" }} value={d.vramGB} onChange={(e) => set("vramGB", e.target.value)} />
        <span className="muted">disk GB</span>
        <input style={{ width: 70, flex: "none" }} value={d.diskGB} onChange={(e) => set("diskGB", e.target.value)} />
      </Field>

      <div className="modal-section">Capacity profiles</div>
      <Field label="Profiles" stack hint="hardware options this model can deploy on">
        <div className="kvrows">
          <div className="profile-head">
            <span>GPU type</span><span>Instance</span><span>GPUs</span><span>VRAM</span><span>tok/s</span><span />
          </div>
          {d.profiles.map((p, i) => (
            <div className="profile-row" key={i}>
              <input value={p.gpuType} onChange={(e) => setP(i, "gpuType", e.target.value)} />
              <input value={p.instanceType} onChange={(e) => setP(i, "instanceType", e.target.value)} />
              <input value={p.gpusPerReplica} onChange={(e) => setP(i, "gpusPerReplica", e.target.value)} />
              <input value={p.vramGB} onChange={(e) => setP(i, "vramGB", e.target.value)} />
              <input value={p.estTokensPerSec} onChange={(e) => setP(i, "estTokensPerSec", e.target.value)} />
              <button className="iconbtn danger" title="Remove profile" aria-label="Remove profile"
                      disabled={d.profiles.length <= 1}
                      onClick={() => set("profiles", d.profiles.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button className="ghost" onClick={() => set("profiles", [...d.profiles, { ...EMPTY_PROFILE }])}>+ Add profile</button></div>
        </div>
      </Field>
```

- [ ] **Step 3: Catalog page columns + texts**

`catalog/page.tsx`:
- `CapacityProfile` interface: remove `costPerHourUSD`.
- Cheapest→first profile: `const p = (m.capacityProfiles ?? [])[0];` (remove the sort).
- `<thead>` row: drop `<th>Cheapest hardware</th>` and `<th>Est. $/hr</th>`; body: drop the two matching `<td>`s (instance/GPU-type cell and price cell). Keep "GPU RAM" and "~tok/s".
- Subtitle: replace the block with

```tsx
      <p className="sub">
        {count} models. Click a model's name to edit it — bundled models keep their
        YAML defaults and get a site override.
      </p>
```

  (`families` becomes unused — remove it.)
- Footer: replace with

```tsx
      <p className="sub" style={{ marginTop: 14 }}>
        <b>tok/s</b> and <b>GPU RAM</b> come from the model's first capacity profile;
        bold tok/s = measured live on this cluster via the learning loop.
      </p>
```

- [ ] **Step 4: Build**

Run: `cd console && npx next build`
Expected: build succeeds, no type errors.

- [ ] **Step 5: Commit**

```bash
git add console/app/catalog console/app/globals.css
git commit -m "feat(console): grouped model dialog, catalog drops hardware/price columns"
```

---

### Task 11: Console — pools UI (tolerations, budget column, no scaling field)

**Files:**
- Modify: `console/app/pools/pool-modal.tsx`, `console/app/pools/page.tsx`

**Interfaces:**
- Consumes: Task 8's API (`tolerations` in PoolBody, `committedMaxReplicas` on GET).

- [ ] **Step 1: Rework pool-modal.tsx**

Replace `Draft`, the state init, and the two fields (Scaling + Nodes) — full new shape:

```tsx
interface TolDraft { key: string; operator: string; value: string; effect: string }
interface Draft { name: string; gpuType: string; gpusPerNode: string; maxNodes: string;
                  selector: { k: string; v: string }[]; tolerations: TolDraft[]; }
```

state init: drop `scalingMode`, add

```tsx
    tolerations: (pool?.spec?.tolerations ?? []).map((t: any) => ({
      key: t.key ?? "", operator: t.operator ?? "Equal", value: t.value ?? "", effect: t.effect ?? "",
    })),
```

submit body: drop `scalingMode`, add

```tsx
    const tolerations = d.tolerations
      .filter((t) => t.key.trim() || t.operator === "Exists")
      .map((t) => ({
        ...(t.key.trim() ? { key: t.key.trim() } : {}),
        operator: t.operator,
        ...(t.operator === "Equal" && t.value ? { value: t.value } : {}),
        ...(t.effect ? { effect: t.effect } : {}),
      }));
    const body = { nodeSelector, gpuType: d.gpuType || undefined,
      gpusPerNode: Number(d.gpusPerNode) || 0, maxNodes: Number(d.maxNodes) || 0, tolerations };
```

Replace the Scaling `<Field>` and the Nodes/Max-nodes `<Field>` with:

```tsx
      <Field label="Max nodes"
             hint="replica budget — the summed max replicas of this pool's deployments cannot exceed it (0 = unlimited)">
        <input style={{ width: 90, flex: "none" }} value={d.maxNodes} onChange={(e) => set("maxNodes", e.target.value)} />
      </Field>
      <Field label="Tolerations" stack
             hint="let this pool's pods run on tainted nodes — taint the nodes themselves with kubectl">
        <div className="kvrows">
          {d.tolerations.map((t, i) => (
            <div className="kvrow" key={i}>
              <input value={t.key} placeholder="nvidia.com/gpu"
                     onChange={(e) => setTol(i, "key", e.target.value)} />
              <select value={t.operator} style={{ flex: "none", width: 90 }}
                      onChange={(e) => setTol(i, "operator", e.target.value)}>
                <option value="Equal">Equal</option><option value="Exists">Exists</option>
              </select>
              {t.operator === "Equal" && (
                <input value={t.value} placeholder="value" style={{ width: 110, flex: "none" }}
                       onChange={(e) => setTol(i, "value", e.target.value)} />
              )}
              <select value={t.effect} style={{ flex: "none", width: 150 }}
                      onChange={(e) => setTol(i, "effect", e.target.value)}>
                <option value="">any effect</option>
                <option value="NoSchedule">NoSchedule</option>
                <option value="PreferNoSchedule">PreferNoSchedule</option>
                <option value="NoExecute">NoExecute</option>
              </select>
              <button className="iconbtn danger" title="Remove toleration" aria-label="Remove toleration"
                      onClick={() => set("tolerations", d.tolerations.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button className="ghost" onClick={() =>
            set("tolerations", [...d.tolerations, { key: "", operator: "Equal", value: "", effect: "" }])}>+ Add toleration</button></div>
        </div>
      </Field>
```

with the row-setter helper next to `setRow`:

```tsx
  const setTol = (i: number, k: keyof TolDraft, v: string) =>
    set("tolerations", d.tolerations.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
```

- [ ] **Step 2: Pools page columns**

`pools/page.tsx` — header row becomes:

```tsx
        <thead><tr>
          <th>Name</th><th>Node selector</th><th>Tolerations</th><th>GPU type</th><th>GPUs/node</th>
          <th>Max nodes</th><th>Committed</th><th>In use</th><th></th>
        </tr></thead>
```

body cells (replacing the Nodes + Scaling cells, adding tolerations + committed):

```tsx
                <td>{(p.spec?.tolerations ?? []).length
                  ? p.spec.tolerations.map((t: any, i: number) => (
                      <span className="chip" key={i} style={{ marginRight: 6 }}>
                        <code>{t.key ?? "*"}{t.operator === "Exists" ? "" : `=${t.value ?? ""}`}{t.effect ? `:${t.effect}` : ""}</code>
                      </span>))
                  : <span className="muted">none</span>}</td>
                <td>{p.spec?.gpuType ?? "—"}</td>
                <td>{p.spec?.gpusPerNode ?? "—"}</td>
                <td>{p.spec?.maxNodes ? p.spec.maxNodes : "—"}</td>
                <td>{p.spec?.maxNodes ? `${p.committedMaxReplicas ?? 0} / ${p.spec.maxNodes}` : `${p.committedMaxReplicas ?? 0} / ∞`}</td>
```

and bump the empty-row `colSpan` from 8 to 9.

- [ ] **Step 3: Build + live check**

Run: `cd console && npx next build`
Expected: success. Then with CP + console running: create a pool with a toleration, verify the chip renders and `kubectl get modelpool <name> -o yaml` shows `tolerations`.

- [ ] **Step 4: Commit**

```bash
git add console/app/pools
git commit -m "feat(console): pool tolerations editor, committed/budget column, drop scaling field"
```

---

### Task 12: Console — deploy modal (reserve, budget, context placeholder, model dropdown)

**Files:**
- Modify: `console/app/deployments/deploy-modal.tsx`, `console/app/catalog/page.tsx` (one prop)

**Interfaces:**
- Consumes: Task 8 pools shape, Task 9 validation/errors.
- Produces: `DeployLocalButton({ catalogId, defaultName, contextTokens?, small })`; new export `DeployModelButton()` (Task 13 places it); `EditDeploymentName` local variant passes `replicas: {min,max,reserve?}` (already spread from the API row — verify only).

- [ ] **Step 1: Extend Ctx + state**

```tsx
interface Ctx {
  catalogId?: string;
  defaultName?: string;
  contextTokens?: number;      // deploy-local: catalog default for the placeholder
  catalogPick?: { id: string; displayName: string; contextTokens?: number }[]; // deploy-local from /deployments: model dropdown
  name?: string;
  poolRef?: string;
  minReplicas?: number; maxReplicas?: number; reserveReplicas?: number;
  externalId?: string;
  provider?: string;
  baseUrl?: string | null;
  modelId?: string;
}
```

State additions inside `DeployModal`:

```tsx
  const [catalogId, setCatalogId] = useState(ctx.catalogId ?? "");
  const [ctxDefault, setCtxDefault] = useState<number | undefined>(ctx.contextTokens);
  const [reserve, setReserve] = useState(ctx.reserveReplicas != null ? String(ctx.reserveReplicas) : "0");
  const nRes = Number(reserve) || 0;
  const replicasValid = Number.isInteger(nMin) && Number.isInteger(nMax) && Number.isInteger(nRes)
    && nMin >= 0 && nMax >= 1 && nMax >= nMin && nRes >= 0 && nRes <= nMax - nMin;
```

Pools fetch keeps objects (replace the names mapping):

```tsx
  const [pools, setPools] = useState<{ name: string; maxNodes: number; committed: number }[]>([]);
  // in the effect:
      .then((d) => {
        const rows = (d.pools ?? []).map((p: any) => ({
          name: p.metadata?.name, maxNodes: p.spec?.maxNodes ?? 0,
          committed: p.committedMaxReplicas ?? 0,
        })).filter((p: any) => p.name);
        setPools(rows);
        if (rows.length && !poolRef) setPoolRef(rows[0].name);
      }).catch(() => setPools([]));
```

Budget check (mirrors the server message so the user sees the same text):

```tsx
  const pool = pools.find((p) => p.name === poolRef);
  // On a same-pool edit the deployment's own max is already inside committed.
  const committed = (pool?.committed ?? 0) - (mode === "edit-local" && poolRef === ctx.poolRef ? (ctx.maxReplicas ?? 0) : 0);
  const budgetError = pool && pool.maxNodes > 0 && replicasValid && committed + nMax > pool.maxNodes
    ? `pool ${pool.name}: committed max replicas ${committed} + requested ${nMax} exceeds budget ${pool.maxNodes}`
    : null;
```

`canSubmit`: add `&& !budgetError` to both branches, and for deploy-local require a model: `!!(ctx.catalogId ?? catalogId)`.

- [ ] **Step 2: Fields**

Model dropdown (first field in local mode, only when `ctx.catalogPick` is set) — inserting before the Pool field:

```tsx
        {ctx.catalogPick && (
          <Field label="Model" required>
            <select value={catalogId} onChange={(e) => {
              const m = ctx.catalogPick!.find((x) => x.id === e.target.value);
              setCatalogId(e.target.value);
              setCtxDefault(m?.contextTokens);
              setName(e.target.value.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, ""));
            }}>
              <option value="">— pick a model —</option>
              {ctx.catalogPick.map((m) => <option key={m.id} value={m.id}>{m.displayName} ({m.id})</option>)}
            </select>
          </Field>
        )}
```

Replicas field gains reserve:

```tsx
        <Field label="Replicas" hint="min 0 allows scale-to-zero; the scaler adds replicas on queued demand up to max">
          <span className="muted">min</span>
          <input style={{ width: 70, flex: "none" }} value={minR} onChange={(e) => setMinR(e.target.value)} />
          <span className="muted">max</span>
          <input style={{ width: 70, flex: "none" }} value={maxR} onChange={(e) => setMaxR(e.target.value)} />
          <span className="muted">reserve</span>
          <input style={{ width: 70, flex: "none" }} value={reserve} onChange={(e) => setReserve(e.target.value)} />
        </Field>
        {!replicasValid && (minR || maxR || reserve) !== "" && (
          <p className="modal-error" style={{ margin: "0 0 8px" }}>replicas: need 0 ≤ min ≤ max, max ≥ 1, 0 ≤ reserve ≤ max − min</p>
        )}
        {budgetError && <p className="modal-error" style={{ margin: "0 0 8px" }}>{budgetError}</p>}
```

(Reserve hint lives on the field: change the hint to
`"reserve = warm replicas kept idle above current demand so bursts don't wait — 0 = scale on demand only"` if the one-line hint above gets too long; keep ONE hint, not two.)

Context placeholder:

```tsx
        <Field label="Context" hint={mode === "edit-local"
            ? "tokens — leave empty to keep the current value"
            : "tokens — leave empty for the catalog default"}>
          <input style={{ width: 170, flex: "none" }} value={ctxTokens}
                 onChange={(e) => setCtxTokens(e.target.value)}
                 placeholder={mode === "edit-local" ? "unchanged"
                   : ctxDefault ? `${ctxDefault} (catalog default)` : "engine default"} />
        </Field>
```

Submit bodies: deploy-local uses `catalogId: ctx.catalogId ?? catalogId` and `replicas: { min: Number(minR) || 0, max: Number(maxR) || 0, reserve: Number(reserve) || 0 }`; edit-local sends the same replicas object.

- [ ] **Step 3: Buttons + prefills**

```tsx
export function DeployLocalButton({ catalogId, defaultName, contextTokens, small }:
  { catalogId: string; defaultName: string; contextTokens?: number; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const slug = defaultName.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return (<>
    <button className={small ? "deploy-sm" : ""} onClick={() => setOpen(true)}><Icon.deploy /> Deploy</button>
    {open && <DeployModal mode="deploy-local" ctx={{ catalogId, defaultName: slug, contextTokens }} onClose={() => setOpen(false)} />}
  </>);
}

export function DeployModelButton() {
  const [models, setModels] = useState<any[] | null>(null);
  const openIt = async () => {
    try {
      const r = await fetch("/api/v1/catalog?limit=1000", { headers: wsHeader() });
      const j = await r.json();
      setModels(j.models ?? []);
    } catch { setModels([]); }
  };
  return (<>
    <button onClick={openIt}><Icon.deploy /> Deploy model</button>
    {models && <DeployModal mode="deploy-local"
      ctx={{ catalogPick: models.map((m: any) => ({ id: m.id, displayName: m.displayName, contextTokens: m.contextTokens })) }}
      onClose={() => setModels(null)} />}
  </>);
}
```

`EditDeploymentName` local props: add `reserveReplicas` to the ctx mapping: `{ ..., minReplicas: props.replicas?.min, maxReplicas: props.replicas?.max, reserveReplicas: (props.replicas as any)?.reserve }`.

`catalog/page.tsx`: pass the default — `<DeployLocalButton catalogId={m.id} defaultName={m.id} contextTokens={m.contextTokens} small />`.

- [ ] **Step 4: Build + live check**

Run: `cd console && npx next build`
Expected: success. Live: open Deploy from the catalog — Context placeholder reads `32768 (catalog default)` for the qwen entry; set min 1 / max 3 / reserve 3 → inline error + disabled button; pick a pool with a low budget → budget error matches the server's wording.

- [ ] **Step 5: Commit**

```bash
git add console/app/deployments/deploy-modal.tsx console/app/catalog/page.tsx
git commit -m "feat(console): deploy modal reserve+budget validation, context default, model dropdown"
```

---

### Task 13: Console — deployments list & detail

**Files:**
- Modify: `console/app/deployments/page.tsx`, `console/app/deployments/[name]/tabs.tsx`

**Interfaces:**
- Consumes: Task 9's `queueDepth`, Task 12's `DeployModelButton`.
- Produces: env var contract `DEVPROOF_GATEWAY_PUBLIC_URL` (default `http://localhost:14000`), read server-side.

- [ ] **Step 1: List page**

`deployments/page.tsx`:
- Import `DeployModelButton` alongside `AddEndpointButton`.
- Header row: `<AddEndpointButton /><DeployModelButton /><SyncButton /><RefreshButton />`.
- Below the existing subtitle add the access blurb:

```tsx
      {(() => { const gw = process.env.DEVPROOF_GATEWAY_PUBLIC_URL ?? "http://localhost:14000"; return (
        <p className="sub" style={{ marginTop: -6 }}>
          Access any deployment — local or remote — through the gateway:{" "}
          <code style={{ fontSize: 11.5 }}>{`curl ${gw}/v1/chat/completions -H "Authorization: Bearer dpk_…" -d '{"model": "<name>", "messages": […]}'`}</code>
          {" "}— create keys on the API Keys page.
        </p>
      ); })()}
```

- Table head: `<th>Name</th><th>Catalog</th><th>Pool</th><th>Phase</th><th>Replicas</th><th>Tok/s</th><th>Req Queue</th><th></th>` (Endpoint removed).
- Body cells: drop the endpoint `<td>`; replicas + queue become:

```tsx
              <td>{d.kind === "external" ? "—" : d.readyReplicas}</td>
              <td>{d.tokensPerSec != null ? d.tokensPerSec.toFixed(1) : "—"}</td>
              <td>{d.kind === "external" ? "—" : d.queueDepth != null ? d.queueDepth : "—"}</td>
```

- Empty-row `colSpan` 9 → 8. Remove `endpoint`/`baseUrl` from the row rendering (interface fields can stay — the detail page uses them).

- [ ] **Step 2: Detail page cards**

`[name]/tabs.tsx`:
- "Queue depth" row label → "Req queue" (same value logic — `d.queueDepth != null ? d.queueDepth : "—"` already shows 0).
- Endpoint card differentiates target vs engine:

```tsx
          <div className="card"><h3>{d.kind === "external" ? "Target endpoint" : "Engine endpoint"}</h3>
            <code style={{ fontSize: 11.5, wordBreak: "break-all" }}>
              {d.kind === "external" ? (d.baseUrl ?? "provider default") : (d.endpoint ?? "—")}
            </code>
            <div className="hint" style={{ marginTop: 6 }}>
              {d.kind === "external"
                ? "where the gateway forwards this model's requests"
                : "cluster-internal engine service — clients call the gateway instead"}
            </div>
          </div>
```

(If the `hint` class isn't styled outside forms, use `<div style={{ color: "var(--muted)", fontSize: 12, marginTop: 6 }}>`.)

- [ ] **Step 3: Build + live check**

Run: `cd console && npx next build`
Expected: success. Live on `/deployments`: no Endpoint column; qwen row shows Replicas `1` and Req Queue `0` (0, not dash — requires the Task 7 scaler running); the external row (if any) shows `—`/`—`; "Deploy model" opens the dropdown modal; blurb shows `http://localhost:14000`.

- [ ] **Step 4: Commit**

```bash
git add console/app/deployments
git commit -m "feat(console): deployments columns (Replicas/Req Queue), deploy-model entry, gateway access blurb"
```

---

### Task 14: Gateway HPA

**Files:**
- Modify: `deploy/gateway/litellm.yaml:362-363,402+`

- [ ] **Step 1: Manifest**

In the gateway `Deployment`, DELETE the `replicas: 1` line (an HPA-managed Deployment must not pin replicas in the manifest — `kubectl apply` would reset the scale on every deploy). The container already has `requests: { cpu: "250m", memory: "1Gi" }` — the HPA precondition; leave as is.

Append at the end of the file:

```yaml
---
# Gateway HPA (spec 2026-07-11 §5): LiteLLM pods are stateless (ConfigMap +
# Secret + Postgres), so a plain CPU HPA covers load; min 2 also removes the
# gateway as a single point of failure.
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: gateway, namespace: devproof-gateway }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: gateway }
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 75 } }
```

- [ ] **Step 2: Apply + verify**

```bash
kubectl apply -f deploy/gateway/litellm.yaml
kubectl -n devproof-gateway get hpa,deploy,pods
```

Expected: within ~1 min the HPA scales the Deployment to 2, both pods become Ready (readiness probe passes; the pip-install startup takes ~30–60s). Then verify the gateway still answers through both:

```bash
curl -s http://localhost:14000/health/readiness
```

Expected: HTTP 200 repeatedly.

- [ ] **Step 3: Commit**

```bash
git add deploy/gateway/litellm.yaml
git commit -m "feat(gateway): CPU HPA (min 2 / max 10) — scalable, no single point of failure"
```

---

### Task 15: Docs + full verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md updates** (surgical, keep bullet style)

- "Autoscaling" bullet → `- **Autoscaling:** the operator's scaler (internal/scaler, 15s tick) scrapes engine pods' llama.cpp /metrics via the apiserver pod proxy and writes ISVC spec.replicas — desired = queue(processing+deferred) + reserve, clamped min..max; scale-down waits 3 min. No k8s HPA on models (LLMkube 0.9.1 custom-metric HPA is broken; CPU is a bad GPU signal). The gateway has its own CPU HPA (min 2/max 10). status.queueDepth (-1 = unknown) feeds the console's Req Queue column — no Prometheus needed.`
- "Deployment detail Trace/Stats" / workspace note: update the sentence that says external_deployments are workspace-scoped → external deployments are global since migration 022; everything under Serving is global.
- "External model endpoints" bullet: add "global (not workspace-scoped, migration 022)".
- Latest migration reference `021` → `022`.
- Add to the pools/deployments notes: `- **Pools:** maxNodes is an enforced replica budget (Σ max replicas ≤ maxNodes, all CP write paths + dialogs); tolerations pass through to engine pods; scalingMode is gone. $/hr is gone from the catalog entity.`

- [ ] **Step 2: Full test + build sweep**

```bash
cd control-plane && npx tsc --noEmit && npm test
cd ../operator && go build ./... && go test ./...
cd ../console && npx next build
```

Expected: all PASS.

- [ ] **Step 3: Live exercise (CLAUDE.md "verify before claiming done")**

Restart CP (tsx) + operator (go run) + console (next start). Then:
1. All pages 200: `/catalog`, `/deployments`, `/pools`, one deployment detail.
2. `/catalog`: no hardware/price columns; edit dialog shows grouped sections.
3. `/deployments`: Deploy model → pick qwen entry → context placeholder shows the catalog default; deploy to a pool.
4. Budget: set the pool's Max nodes to 1 with 2 max replicas committed → 400 with the exact message; deploy dialog shows the same error and disables Deploy.
5. Req Queue shows `0` for the idle local model; external rows show `—` in Replicas and Req Queue.
6. Load test from Task 7 step 4 still scales 1→2→1.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: serving rework — scaler, global externals, pool budgets (spec 2026-07-11)"
```
