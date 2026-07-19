# LLMkube 0.9.4 Upgrade + SGLang Engine Passthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the pinned LLMkube from 0.9.1 to 0.9.4 with zero behavior change for existing deployments, then expose the new SGLang runtime via the existing `ModelDeployment.spec.engine` field flowing deploy dialog → control plane → operator transform → InferenceService `spec.runtime`.

**Architecture:** Phase 1 is a helm chart upgrade plus doc pins (CRDs are chart templates, re-applied automatically). Phase 2 threads one enum value (`sglang`) through three layers, each independently testable: operator (enum + transform mapping, TDD), control plane (request passthrough + validation, TDD), console (select in the shared deploy/edit modal). LLMkube's `spec.runtime` defaults to `llamacpp` when omitted, so every existing deployment is untouched.

**Tech Stack:** Helm v4.2.2, Go 1.26 (`~/sdk/go/bin/go`, controller-gen), Node/TypeScript (Fastify, Node test runner), Next.js console.

**Spec:** `docs/superpowers/specs/2026-07-12-llmkube-094-upgrade-design.md`

## Global Constraints

- kubectl context is `docker-desktop`; LLMkube lives in namespace `llmkube-system`; Devproof serving in `devproof-serving`.
- Go is NOT on PATH: use `$HOME/sdk/go/bin/go` (Git Bash). controller-gen was installed via `go install` (binary in `$HOME/go/bin`); if missing, reinstall with `$HOME/sdk/go/bin/go install sigs.k8s.io/controller-tools/cmd/controller-gen@latest`.
- The dev cluster is CPU-only: an SGLang pod is NOT expected to run. Verification for SGLang is wire-level (generated ISVC carries `runtime: sglang`) + unit tests only.
- The 0.9.1 workarounds stay: the Devproof scaler (queue-depth annotation) and the operator's Ready-stickiness are NOT touched — upstream did not fix the custom-metric HPA or the phase flap.
- Verification before claiming done: operator `$HOME/sdk/go/bin/go test ./...`, control plane `npm test` + `npx tsc --noEmit`, console `npx next build`, plus each task's live checks.
- Working tree has an unrelated untracked file (`operator/devproof-operator-dev.exe`) — never `git add -A`; stage only named files.
- LLMkube ISVC `spec.runtime` enum (upstream 0.9.4): `llamacpp` (default) | `generic` | `personaplex` | `vllm` | `tgi` | `sglang`. Devproof exposes ONLY `sglang` beyond the default.

---

### Task 1: Helm upgrade to 0.9.4 + doc pins

**Files:**
- Modify: `deploy/llmkube/values.yaml` (comment lines 1-2)
- Modify: `deploy/README.md` (LLMkube section, lines 16-19; autoscaling dead-ends note, lines 30-34)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: cluster runs LLMkube 0.9.4 with the `sglang`-capable InferenceService CRD; Task 2 re-applies the Devproof CRDs against this cluster; Task 5 creates an SGLang ISVC against it.

- [ ] **Step 1: Upgrade the chart**

```bash
helm upgrade llmkube llmkube/llmkube -n llmkube-system --version 0.9.4 -f deploy/llmkube/values.yaml
```

Expected: `STATUS: deployed`, `REVISION` incremented. (The repo is already added and updated; a `--dry-run` of exactly this command succeeded on 2026-07-12.)

- [ ] **Step 2: Verify the upgrade took**

```bash
helm list -n llmkube-system
kubectl get crd inferenceservices.inference.llmkube.dev -o yaml | grep -c sglang
kubectl get pods -n llmkube-system
kubectl get modeldeployments -A
```

Expected: chart/app version 0.9.4; grep count ≥ 1 (the new enum value is live); llmkube controller pod(s) Running; both `qwen05b-dp` and `qwen3-5-4b-q4` still `Ready` with endpoints. If the deployments flap, wait up to 2 minutes for reconcile; if still broken, `helm rollback llmkube -n llmkube-system` and report BLOCKED.

- [ ] **Step 3: Live session E2E against the upgraded serving plane**

The control plane and console are already running (ports 7080/7090). Create a session on an active agent with model `qwen05b-dp` (`GET /v1/agents` with header `X-Devproof-Workspace: wrkspc_default` to find one), prompt "Reply with only the word OK. Do not use any tools.", wait for `idle`:

```bash
curl -s -X POST -H "X-Devproof-Workspace: wrkspc_default" -H "Content-Type: application/json" \
  -d '{"agent":"<agent_id>","prompt":"Reply with only the word OK. Do not use any tools."}' \
  http://localhost:7080/v1/sessions
# poll: curl -s -H "X-Devproof-Workspace: wrkspc_default" http://localhost:7080/v1/sessions/<id>
```

Expected: session reaches `idle` (model generated through the gateway on the upgraded LLMkube). Delete the test session afterwards (`DELETE /v1/sessions/<id>`).

- [ ] **Step 4: Update the doc pins**

`deploy/llmkube/values.yaml` lines 1-2 — replace both `0.9.1` mentions:

```yaml
# LLMkube operator install — pinned chart/app version 0.9.4 (repo: https://defilantech.github.io/LLMKube)
# Installed: helm install llmkube llmkube/llmkube -n llmkube-system --create-namespace --version 0.9.4 -f this-file
# Upgrades: helm upgrade llmkube llmkube/llmkube -n llmkube-system --version <v> -f this-file
#   (CRDs are chart templates under templates/crds/, gated by crds.install=true — helm upgrade re-applies them; no manual kubectl apply.)
```

`deploy/README.md` line 17: `- Chart + app version **0.9.4** (pinned, upgraded from 0.9.1 on 2026-07-12), namespace `llmkube-system`,`
Append to the "Dead ends verified on LLMkube 0.9.1" bullet (line ~30): `Re-checked against 0.9.4 (2026-07-12): neither the HPA selector-label bug nor the Progressing phase-flap was fixed upstream — the Devproof scaler and Ready-stickiness workarounds remain required.`

- [ ] **Step 5: Commit**

```bash
git add deploy/llmkube/values.yaml deploy/README.md
git commit -m "chore(serving): upgrade LLMkube 0.9.1 -> 0.9.4 (additive CRDs only; scaler workarounds still required)"
```

---

### Task 2: Operator — `sglang` engine value + transform mapping (TDD)

**Files:**
- Modify: `operator/api/v1alpha1/types.go:76-78` (Engine enum comment)
- Modify: `operator/internal/transform/transform.go` (Build: runtime mapping)
- Modify: `operator/config/crd/serving.devproof.ai_modeldeployments.yaml` (regenerated)
- Test: `operator/internal/transform/transform_test.go`

**Interfaces:**
- Consumes: `v1alpha1.ModelDeployment.Spec.Engine` (existing string field).
- Produces: `transform.Build` emits `isvcSpec["runtime"] = "sglang"` iff `Spec.Engine == "sglang"` (field absent otherwise). Task 3's control plane writes `spec.engine` values; Task 5 observes the resulting ISVC.

- [ ] **Step 1: Write the failing tests**

Add to `operator/internal/transform/transform_test.go` (match the existing test style — build an `md`/`pool`, call `Build`, assert on the unstructured maps):

```go
func TestBuildEngineSGLangSetsRuntime(t *testing.T) {
	md := &v1alpha1.ModelDeployment{}
	md.Name = "sg-test"
	md.Namespace = "devproof-serving"
	md.Spec.Model.Source = "https://example.com/m.safetensors"
	md.Spec.Model.Format = "safetensors"
	md.Spec.Engine = "sglang"
	pool := &v1alpha1.ModelPool{}
	_, isvc := Build(md, pool, 1)
	spec := isvc.Object["spec"].(map[string]interface{})
	if spec["runtime"] != "sglang" {
		t.Fatalf("engine sglang must map to isvc runtime sglang, got %v", spec["runtime"])
	}
}

func TestBuildDefaultEngineOmitsRuntime(t *testing.T) {
	for _, engine := range []string{"", "auto", "llama.cpp", "vllm"} {
		md := &v1alpha1.ModelDeployment{}
		md.Name = "def-test"
		md.Namespace = "devproof-serving"
		md.Spec.Model.Source = "https://example.com/m.gguf"
		md.Spec.Model.Format = "gguf"
		md.Spec.Engine = engine
		pool := &v1alpha1.ModelPool{}
		_, isvc := Build(md, pool, 1)
		spec := isvc.Object["spec"].(map[string]interface{})
		if _, ok := spec["runtime"]; ok {
			t.Fatalf("engine %q must not set isvc runtime (llamacpp default applies)", engine)
		}
	}
}
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd operator && $HOME/sdk/go/bin/go test ./internal/transform/`
Expected: `TestBuildEngineSGLangSetsRuntime` FAILS (`got <nil>`); `TestBuildDefaultEngineOmitsRuntime` passes (nothing sets runtime today); existing tests pass.

- [ ] **Step 3: Implement**

`operator/api/v1alpha1/types.go` — replace the Engine enum marker (line 77):

```go
	// Engine selects the inference engine. "sglang" maps to the LLMkube
	// SGLang runtime; auto/llama.cpp/vllm keep the provider default engine.
	// +kubebuilder:validation:Enum=auto;llama.cpp;vllm;sglang
	Engine   string        `json:"engine,omitempty"`
```

`operator/internal/transform/transform.go` — after the `contextSize` block (line 53), before the replicas comment:

```go
	// Engine "sglang" selects LLMkube's SGLang runtime (ISVC spec.runtime,
	// 0.9.4+). Every other value omits the field so the provider default
	// (llamacpp) applies — vllm stays accepted-but-unmapped, as before.
	if md.Spec.Engine == "sglang" {
		isvcSpec["runtime"] = "sglang"
	}
```

- [ ] **Step 4: Regenerate and apply the CRD**

```bash
cd operator
$HOME/go/bin/controller-gen object paths=./api/...
$HOME/go/bin/controller-gen crd paths=./api/... output:crd:dir=config/crd
$HOME/sdk/go/bin/go test ./...
kubectl apply -f config/crd/serving.devproof.ai_modeldeployments.yaml
```

Expected: generated `serving.devproof.ai_modeldeployments.yaml` diff shows the enum gaining `sglang` (and nothing else); all Go tests pass; `kubectl apply` says `configured`. If `controller-gen` is missing: `$HOME/sdk/go/bin/go install sigs.k8s.io/controller-tools/cmd/controller-gen@latest` first.

- [ ] **Step 5: Restart the dev operator**

The operator runs out-of-cluster (`go run ./cmd`). If a dev operator process is running, restart it so the new transform is live (find/kill the `go run`/`devproof-operator` process, then from `operator/`: `$HOME/sdk/go/bin/go run ./cmd` backgrounded). If none is running, note that in the report — Task 5 needs it running.

- [ ] **Step 6: Commit**

```bash
git add operator/api/v1alpha1/types.go operator/internal/transform/transform.go operator/internal/transform/transform_test.go operator/config/crd/serving.devproof.ai_modeldeployments.yaml
git commit -m "feat(operator): engine=sglang maps to LLMkube ISVC runtime sglang (0.9.4)"
```

---

### Task 3: Control plane — engine passthrough + validation (TDD)

**Files:**
- Modify: `control-plane/src/catalog.ts` (DeploymentRequest, resolveDeployment)
- Modify: `control-plane/src/server.ts` (POST /v1/deployments validation ~line 308; PATCH engine list line 486)
- Test: `control-plane/test/catalog.test.ts`, `control-plane/test/server.test.ts`

**Interfaces:**
- Consumes: nothing from Task 2 at build time (the CRD enum validates server-side on write; the CP just passes the string).
- Produces: `POST /v1/deployments` accepts optional `engine: "auto" | "llama.cpp" | "vllm" | "sglang"` (default `"auto"`) and writes it to `spec.engine`; `PATCH /v1/deployments/:name` accepts `engine: "sglang"`. Task 4's console sends these values.

- [ ] **Step 1: Write the failing tests**

Add to `control-plane/test/catalog.test.ts` (follow its existing style — it tests `resolveDeployment` with a stub catalog entry):

```ts
test("resolveDeployment passes engine through, defaulting to auto", () => {
  const catalog = [{ id: "m1", family: "f", displayName: "M1", parameters: "1B",
    format: "gguf", source: "https://x/m.gguf", recommendedEngine: "llama.cpp" } as any];
  const withEngine = resolveDeployment(catalog, { name: "d1", catalogId: "m1", poolRef: "p", engine: "sglang" } as any);
  assert.equal(withEngine.spec.engine, "sglang");
  const without = resolveDeployment(catalog, { name: "d2", catalogId: "m1", poolRef: "p" } as any);
  assert.equal(without.spec.engine, "auto");
});
```

Add to `control-plane/test/server.test.ts` (follow its existing route-test style — it builds the Fastify app with fake stores; locate the existing POST /v1/deployments and PATCH tests and mirror their setup):

```ts
test("POST /v1/deployments rejects unknown engine, accepts sglang", async (t) => {
  // mirror the existing deployments-route test setup (fake store + catalog with one entry "m1")
  const bad = await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "d-bad", catalogId: "m1", poolRef: "p", engine: "tgi" } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "d-sg", catalogId: "m1", poolRef: "p", engine: "sglang" } });
  assert.equal(ok.statusCode, 201);
  assert.equal(JSON.parse(ok.body).spec.engine, "sglang");
});

test("PATCH /v1/deployments/:name accepts engine sglang", async (t) => {
  const res = await app.inject({ method: "PATCH", url: "/v1/deployments/d-sg",
    payload: { engine: "sglang" } });
  assert.equal(res.statusCode, 200);
});
```

(Adapt fixture names to the file's actual helpers — the assertions are the requirement; if `server.test.ts` has no deployments fixture to mirror, put both route tests in whichever existing describe-block covers `/v1/deployments`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd control-plane && npm test`
Expected: the catalog test FAILS (`spec.engine` is `"auto"` for both — passthrough missing... specifically `withEngine.spec.engine` is `"auto"` not `"sglang"`); the POST test FAILS (engine:"tgi" returns 201, no validation; or sglang case passes engine through as undefined). Existing tests pass.

- [ ] **Step 3: Implement**

`control-plane/src/catalog.ts` — `DeploymentRequest` gains:

```ts
export interface DeploymentRequest {
  name: string;
  catalogId: string;
  poolRef: string;
  replicas?: { min: number; max: number; reserve?: number };
  contextTokens?: number;
  engine?: string;
}
```

and in `resolveDeployment`'s returned spec, replace `engine: "auto",` with:

```ts
      engine: req.engine ?? "auto",
```

`control-plane/src/server.ts` — in POST `/v1/deployments` (after the reserved-name check, ~line 312):

```ts
    if (b.engine && !["auto", "llama.cpp", "vllm", "sglang"].includes(b.engine))
      return reply.code(400).send({ error: "bad engine" });
```

and in PATCH (line 486) extend the list:

```ts
    if (b.engine && !["auto", "llama.cpp", "vllm", "sglang"].includes(b.engine)) return reply.code(400).send({ error: "bad engine" });
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: all PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/catalog.ts control-plane/src/server.ts control-plane/test/catalog.test.ts control-plane/test/server.test.ts
git commit -m "feat(cp): deployments accept engine (auto|llama.cpp|vllm|sglang), passed to spec.engine"
```

---

### Task 4: Console — Engine select in the deploy/edit modal + detail display

**Files:**
- Modify: `console/app/deployments/deploy-modal.tsx` (Ctx, state, submit payloads, Field)
- Modify: `console/app/deployments/[name]/tabs.tsx` (pass engine into EditDeploymentName; display engine)

**Interfaces:**
- Consumes: Task 3's API contract (`engine` on POST and PATCH `/v1/deployments`).
- Produces: UI for choosing `auto` vs `sglang`. No other component consumes this.

- [ ] **Step 1: Extend the modal**

In `console/app/deployments/deploy-modal.tsx`:

Add to the `Ctx` interface (after `reserveReplicas`):

```ts
  engine?: string;             // edit-local (prefill)
```

Add state next to the other local fields (after `ctxTokens`, line ~54):

```ts
  const [engine, setEngine] = useState(ctx.engine ?? "auto");
```

In the `deploy-local` submit payload (line ~85-89) add:

```ts
        ...(engine !== "auto" ? { engine } : {}),
```

In the `edit-local` submit payload (line ~94-98) add:

```ts
        ...(engine !== (ctx.engine ?? "auto") ? { engine } : {}),
```

Add the Field in the local branch, after the Context field (line ~187):

```tsx
        <Field label="Engine" hint="SGLang requires a safetensors model and GPU nodes — pods will not start on the CPU-only dev cluster">
          <select value={engine} onChange={(e) => setEngine(e.target.value)} style={{ width: 190, flex: "none" }}>
            <option value="auto">auto (llama.cpp)</option>
            <option value="sglang">SGLang</option>
          </select>
        </Field>
```

In `EditDeploymentName`, extend the local props union and ctx:

```ts
  | { kind: "local"; name: string; poolRef?: string; replicas?: { min: number; max: number }; engine?: string; asButton?: boolean }
```

and in the local `ctx` construction add `engine: props.engine,`.

- [ ] **Step 2: Wire the detail page**

In `console/app/deployments/[name]/tabs.tsx`: the local `EditDeploymentName` call (line ~20) gains `engine={d.engine}` — check how `d` is built in that file/its server component parent (`page.tsx` in the same directory) and thread `spec.engine` into it the same way `poolRef` flows. In the detail facts card (same file, near the pool/endpoint rows), add an "Engine" row showing `d.engine ?? "auto"`.

- [ ] **Step 3: Build and eyeball**

```bash
cd console && npx next build
```

Expected: build succeeds. Then with the console running (`npx next start -p 7090` if not already), open `/deployments`, click "Deploy model": the Engine select shows `auto (llama.cpp)` default; open an existing local deployment's edit dialog: select prefilled from the deployment.

- [ ] **Step 4: Commit**

```bash
git add console/app/deployments/deploy-modal.tsx console/app/deployments/[name]/tabs.tsx console/app/deployments/[name]/page.tsx
git commit -m "feat(console): engine select (auto | SGLang) on local deploy/edit; detail shows engine"
```

(Include `page.tsx` only if Step 2 actually modified it.)

---

### Task 5: Live wire verification + spec/plan closeout

**Files:**
- Create: none (throwaway API calls; scripts in the session scratchpad if needed)

**Interfaces:**
- Consumes: everything from Tasks 1-4 running live (upgraded chart, restarted operator, restarted CP if its code changed, rebuilt console).

- [ ] **Step 1: Restart the dev control plane**

Task 3 changed CP code; restart the dev process (kill the listener on :7080, then from `control-plane/`, backgrounded):

```bash
DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev21 \
DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files \
npx tsx src/main.ts
```

Wait for `curl -s http://localhost:7080/healthz` → `{"ok":true}`. Confirm the operator from Task 2 Step 5 is running.

- [ ] **Step 2: Create an SGLang deployment and verify the wire**

Pick any catalog model (llama.cpp models are fine — the pod is expected to fail; the wire is what's tested):

```bash
curl -s -X POST -H "X-Devproof-Workspace: wrkspc_default" -H "Content-Type: application/json" \
  -d '{"name":"sglang-wire-test","catalogId":"<any catalog id>","poolRef":"cpu-default","engine":"sglang","replicas":{"min":1,"max":1}}' \
  http://localhost:7080/v1/deployments
kubectl get modeldeployment sglang-wire-test -n devproof-serving -o jsonpath='{.spec.engine}{"\n"}'
sleep 15
kubectl get inferenceservice sglang-wire-test -n devproof-serving -o jsonpath='{.spec.runtime}{"\n"}'
```

Expected: POST returns 201 with `spec.engine: "sglang"`; the ModelDeployment carries `engine: sglang`; the operator-generated InferenceService carries `runtime: sglang`. **This is the core acceptance check of the whole project.**

- [ ] **Step 3: Confirm the console shows it sanely and existing serving is untouched**

Open `http://localhost:7090/deployments`: `sglang-wire-test` appears with a non-Ready phase (Deploying/Progressing/Failed — any is acceptable on CPU); its detail page shows Engine: SGLang; `qwen05b-dp` and `qwen3-5-4b-q4` still show Ready. Console pages `/`, `/deployments`, `/catalog` return 200.

- [ ] **Step 4: Clean up the wire-test deployment**

```bash
curl -s -X DELETE http://localhost:7080/v1/deployments/sglang-wire-test
kubectl get inferenceservice -n devproof-serving
```

Expected: 204; the ISVC and ModelDeployment are gone; the two qwen deployments remain.

- [ ] **Step 5: Final suites + TODO closeout**

```bash
cd control-plane && npm test && npx tsc --noEmit
cd ../operator && $HOME/sdk/go/bin/go test ./...
```

Expected: all pass. Then remove the line `- Upgrade LLMkube to 0.9.3` from `TODO.txt` (the item is done, at 0.9.4):

```bash
git add TODO.txt
git commit -m "chore: LLMkube upgraded to 0.9.4 - drop TODO item"
```
