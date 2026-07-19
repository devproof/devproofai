# Configurable Reasoning for Local Models — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catalog-defined reasoning-effort→token-budget options for local llama.cpp deployments, flowing catalog → deploy modal → ModelDeployment CRD → LLMkube ISVC `reasoningBudget` → `--reasoning-budget`.

**Architecture:** The catalog is the source of truth (`reasoning.efforts` map per thinking-capable GGUF entry; absent = no reasoning UI). The control plane resolves the chosen effort to a token budget at save time (snapshot semantics) into `spec.reasoning {effort, budgetTokens}` on the CRD. The operator maps that to ISVC `reasoningBudget` plus a wrap-up `reasoningBudgetMessage`. No gateway or DB changes (custom catalog entries are whole-entry JSONB — `reasoning` passes through).

**Tech Stack:** Go (operator, `~/sdk/go/bin`, controller-gen), Node/TS Fastify (control plane, node test runner), Next.js (console), YAML catalog.

Spec: `docs/superpowers/specs/2026-07-12-local-reasoning-budget-design.md` (all mechanism claims verified live 2026-07-12).

## Global Constraints

- Effort tiers: hybrid `{ off: 0, low: 1024, medium: 4096, high: 16384 }`; dedicated reasoner `{ low: 2048, medium: 8192, high: 32768 }` (no `off`).
- Reasoning blocks go on `format: gguf` entries ONLY.
- Wrap-up message constant (exact): `Thinking budget reached — concluding and answering now.` Set only when `budgetTokens > 0`.
- Reasoning is llama.cpp-engine-only: valid engines for an effort are `auto` and `llama.cpp`; `vllm`/`sglang` reject/hide it.
- `budgetTokens: 0` is valid (thinking off) — never treat 0 as "unset".
- Console: shared `Modal`/`Field` primitives; no `prompt()`/`confirm()`; console always production-built (`npx next build`).
- Go commands need `PATH="$HOME/sdk/go/bin:$HOME/go/bin:$PATH"` (Go + controller-gen not on PATH).
- Commit after every task; message style `feat(scope): …` matching repo history.

---

### Task 1: Operator — ReasoningSpec on the CRD, transform mapping, CRD regen + apply

**Files:**
- Modify: `operator/api/v1alpha1/types.go` (after `ModelSource`, ~line 54)
- Modify: `operator/internal/transform/transform.go` (~line 56, after the contextSize block)
- Test: `operator/internal/transform/transform_test.go`
- Generated: `operator/api/v1alpha1/zz_generated.deepcopy.go`, `operator/config/crd/serving.devproof.ai_modeldeployments.yaml`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ModelDeploymentSpec.Reasoning *ReasoningSpec` with `Effort string` + `BudgetTokens int32`; CR JSON shape `spec.reasoning: {effort: "medium", budgetTokens: 4096}` (what Task 2/4 write); ISVC fields `reasoningBudget` (int64) and `reasoningBudgetMessage` (string); exported const `ReasoningWrapUp`.

- [ ] **Step 1: Write the failing tests** — append to `operator/internal/transform/transform_test.go`:

```go
func TestBuildReasoningBudget(t *testing.T) {
	md, pool := fixtures()
	md.Spec.Reasoning = &v1alpha1.ReasoningSpec{Effort: "medium", BudgetTokens: 4096}
	_, isvc := Build(md, pool, 1)
	budget, found, _ := unstructuredInt(isvc, "spec", "reasoningBudget")
	if !found || budget != 4096 {
		t.Fatalf("reasoningBudget must be 4096, found=%v got %d", found, budget)
	}
	msg, _, _ := unstructuredString(isvc, "spec", "reasoningBudgetMessage")
	if msg != ReasoningWrapUp {
		t.Fatalf("wrap-up message must be set for budget > 0, got %q", msg)
	}
}

func TestBuildReasoningOffHasNoMessage(t *testing.T) {
	md, pool := fixtures()
	md.Spec.Reasoning = &v1alpha1.ReasoningSpec{Effort: "off", BudgetTokens: 0}
	_, isvc := Build(md, pool, 1)
	budget, found, _ := unstructuredInt(isvc, "spec", "reasoningBudget")
	if !found || budget != 0 {
		t.Fatalf("budget 0 (thinking off) must be rendered, found=%v got %d", found, budget)
	}
	if _, found, _ := unstructuredString(isvc, "spec", "reasoningBudgetMessage"); found {
		t.Fatal("budget 0 must not set a wrap-up message (nothing to wrap up)")
	}
}

func TestBuildOmitsReasoningWhenUnset(t *testing.T) {
	md, pool := fixtures()
	_, isvc := Build(md, pool, 1)
	if _, found, _ := unstructuredInt(isvc, "spec", "reasoningBudget"); found {
		t.Fatal("reasoningBudget must be omitted when spec.reasoning is nil (engine default -1)")
	}
	if _, found, _ := unstructuredString(isvc, "spec", "reasoningBudgetMessage"); found {
		t.Fatal("reasoningBudgetMessage must be omitted when spec.reasoning is nil")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd operator && PATH="$HOME/sdk/go/bin:$HOME/go/bin:$PATH" go test ./internal/transform/`
Expected: compile error `undefined: v1alpha1.ReasoningSpec` (and `ReasoningWrapUp`).

- [ ] **Step 3: Add the type** — in `operator/api/v1alpha1/types.go`, insert after the `ModelSource` struct (line 54):

```go
// ReasoningSpec caps the model's thinking output. The control plane resolves
// a catalog-defined effort label into a token budget at deploy time
// (snapshot semantics — later catalog edits don't retune existing
// deployments). llama.cpp runtimes only.
type ReasoningSpec struct {
	// Effort is the catalog effort label this budget was resolved from (display).
	Effort string `json:"effort,omitempty"`
	// BudgetTokens caps reasoning tokens per response; 0 disables thinking.
	// +kubebuilder:validation:Minimum=0
	BudgetTokens int32 `json:"budgetTokens"`
}
```

and in `ModelDeploymentSpec` (after the `Resources` field):

```go
	// Reasoning caps the model's thinking output (llama.cpp runtimes only).
	// +optional
	Reasoning *ReasoningSpec `json:"reasoning,omitempty"`
```

- [ ] **Step 4: Map it in transform** — in `operator/internal/transform/transform.go`, add the const next to `OwnedByLabel`:

```go
// ReasoningWrapUp is injected by llama.cpp before the end-of-thinking tag
// when the reasoning budget runs out — without it the model continues
// thinking-style prose in the visible answer (verified live 2026-07-12).
const ReasoningWrapUp = "Thinking budget reached — concluding and answering now."
```

and in `Build`, directly after the contextSize block (line 56):

```go
	// Reasoning budget (llama.cpp --reasoning-budget): 0 disables thinking,
	// N>0 caps it; omitted = engine default (-1, unrestricted).
	if md.Spec.Reasoning != nil {
		isvcSpec["reasoningBudget"] = int64(md.Spec.Reasoning.BudgetTokens)
		if md.Spec.Reasoning.BudgetTokens > 0 {
			isvcSpec["reasoningBudgetMessage"] = ReasoningWrapUp
		}
	}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd operator && PATH="$HOME/sdk/go/bin:$HOME/go/bin:$PATH" go test ./...`
Expected: all PASS.

- [ ] **Step 6: Regenerate deepcopy + CRD and apply to the cluster**

```bash
cd operator
PATH="$HOME/sdk/go/bin:$HOME/go/bin:$PATH" controller-gen object paths=./api/...
PATH="$HOME/sdk/go/bin:$HOME/go/bin:$PATH" controller-gen crd paths=./api/... output:crd:artifacts:config=config/crd
kubectl apply -f config/crd/serving.devproof.ai_modeldeployments.yaml
```

Expected: `zz_generated.deepcopy.go` gains `ReasoningSpec.DeepCopy`; the CRD YAML gains `reasoning` under spec properties; kubectl says `configured`. The apply is REQUIRED before Task 4's live use — without it the apiserver's structural schema silently prunes `spec.reasoning`.

- [ ] **Step 7: Commit**

```bash
git add operator/api/v1alpha1/ operator/internal/transform/ operator/config/crd/
git commit -m "feat(operator): reasoning budget on ModelDeployment → ISVC reasoningBudget + wrap-up message"
```

---

### Task 2: Control plane — catalog types + resolveDeployment

**Files:**
- Modify: `control-plane/src/catalog.ts`
- Test: `control-plane/test/catalog.test.ts`

**Interfaces:**
- Consumes: CR shape `spec.reasoning {effort, budgetTokens}` from Task 1.
- Produces: `CatalogEntry.reasoning?: { efforts: Record<string, number> }`; `DeploymentRequest.reasoningEffort?: string`; `resolveDeployment` emits `spec.reasoning` or throws `Error` with messages `does not support configurable reasoning`, `unknown reasoning effort`, `reasoning is llama.cpp-only`. Tasks 4/5 rely on these exact fields and messages.

- [ ] **Step 1: Write the failing tests** — append to `control-plane/test/catalog.test.ts`. Use a synthetic catalog (the seed gains reasoning blocks only in Task 3):

```ts
const synth: any[] = [
  { id: "think-model", family: "t", displayName: "T", parameters: "4B", format: "gguf",
    source: "https://example.com/t.gguf", recommendedEngine: "llama.cpp", contextTokens: 32768,
    reasoning: { efforts: { off: 0, low: 1024, medium: 4096, high: 16384 } } },
  { id: "plain-model", family: "p", displayName: "P", parameters: "1B", format: "gguf",
    source: "https://example.com/p.gguf", recommendedEngine: "llama.cpp", contextTokens: 8192 },
];

test("resolveDeployment resolves a reasoning effort to a budget snapshot", () => {
  const spec = resolveDeployment(synth, {
    name: "t1", catalogId: "think-model", poolRef: "p", reasoningEffort: "medium",
  });
  assert.deepEqual(spec.spec.reasoning, { effort: "medium", budgetTokens: 4096 });
  // "off" resolves to budget 0 — 0 is a value, not unset.
  const off = resolveDeployment(synth, {
    name: "t2", catalogId: "think-model", poolRef: "p", reasoningEffort: "off",
  });
  assert.deepEqual(off.spec.reasoning, { effort: "off", budgetTokens: 0 });
});

test("resolveDeployment omits spec.reasoning when no effort requested", () => {
  const spec = resolveDeployment(synth, { name: "t3", catalogId: "think-model", poolRef: "p" });
  assert.equal(spec.spec.reasoning, undefined);
});

test("resolveDeployment rejects efforts the catalog does not define", () => {
  assert.throws(
    () => resolveDeployment(synth, { name: "x", catalogId: "plain-model", poolRef: "p", reasoningEffort: "low" }),
    /does not support configurable reasoning/,
  );
  assert.throws(
    () => resolveDeployment(synth, { name: "x", catalogId: "think-model", poolRef: "p", reasoningEffort: "max" }),
    /unknown reasoning effort "max" — valid: off, low, medium, high/,
  );
});

test("resolveDeployment rejects reasoning on non-llama.cpp engines", () => {
  for (const engine of ["sglang", "vllm"]) {
    assert.throws(
      () => resolveDeployment(synth, { name: "x", catalogId: "think-model", poolRef: "p", engine, reasoningEffort: "low" }),
      /reasoning is llama\.cpp-only/,
    );
  }
  // auto and llama.cpp are fine
  for (const engine of [undefined, "auto", "llama.cpp"]) {
    const s = resolveDeployment(synth, { name: "x", catalogId: "think-model", poolRef: "p", engine, reasoningEffort: "low" });
    assert.equal(s.spec.reasoning.budgetTokens, 1024);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd control-plane && npm test -- --test-name-pattern reasoning` (or `npm test`)
Expected: the 4 new tests FAIL (`spec.reasoning` undefined / no throw).

- [ ] **Step 3: Implement** — in `control-plane/src/catalog.ts`:

Add to `CatalogEntry` (after `capacityProfiles`):

```ts
  /** Thinking-capable models: effort label → reasoning token budget (0 = off).
   *  Absent = the model cannot reason; no Reasoning UI is offered. */
  reasoning?: { efforts: Record<string, number> };
```

Add to `DeploymentRequest` (after `engine`):

```ts
  reasoningEffort?: string;
```

In `resolveDeployment`, after the `entry` lookup:

```ts
  // Effort → budget resolved NOW (snapshot semantics, like bundled-override
  // snapshots): later catalog edits don't retune existing deployments.
  let reasoning: { effort: string; budgetTokens: number } | undefined;
  if (req.reasoningEffort) {
    const efforts = entry.reasoning?.efforts;
    if (!efforts) throw new Error(`model ${entry.id} does not support configurable reasoning`);
    const budgetTokens = efforts[req.reasoningEffort];
    if (typeof budgetTokens !== "number")
      throw new Error(`unknown reasoning effort "${req.reasoningEffort}" — valid: ${Object.keys(efforts).join(", ")}`);
    const engine = req.engine ?? "auto";
    if (engine !== "auto" && engine !== "llama.cpp")
      throw new Error(`reasoning is llama.cpp-only (engine: ${engine})`);
    reasoning = { effort: req.reasoningEffort, budgetTokens };
  }
```

and in the returned `spec` (after `resources`):

```ts
      ...(reasoning ? { reasoning } : {}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/catalog.ts control-plane/test/catalog.test.ts
git commit -m "feat(cp): catalog reasoning efforts + effort→budget resolution in resolveDeployment"
```

---

### Task 3: Catalog YAML — reasoning blocks on all thinking-capable GGUF entries

**Files:**
- Modify: `catalog/models.yaml` (72 entries)
- Test: `control-plane/test/catalog.test.ts`
- Scratch: `<scratchpad>/add-reasoning.cjs` (throwaway edit script — NOT committed)

**Interfaces:**
- Consumes: `CatalogEntry.reasoning` shape from Task 2.
- Produces: seed entries with `reasoning.efforts` that Task 4's server tests reference by id (`qwen3-4b-q4` hybrid, `deepseek-r1-distill-qwen-7b-q4` dedicated).

- [ ] **Step 1: Write the failing seed test** — append to `control-plane/test/catalog.test.ts`:

```ts
test("seed catalog reasoning blocks follow the classification", () => {
  const entries = loadCatalog(seedPath);
  const byId = new Map(entries.map((e) => [e.id, e]));
  // Hybrid: off + standard tiers.
  assert.deepEqual(byId.get("qwen3-4b-q4")!.reasoning,
    { efforts: { off: 0, low: 1024, medium: 4096, high: 16384 } });
  assert.deepEqual(byId.get("glm-5.2-q4")!.reasoning,
    { efforts: { off: 0, low: 1024, medium: 4096, high: 16384 } });
  // Dedicated reasoner: no off, heavier tiers.
  assert.deepEqual(byId.get("deepseek-r1-distill-qwen-7b-q4")!.reasoning,
    { efforts: { low: 2048, medium: 8192, high: 32768 } });
  assert.deepEqual(byId.get("gpt-oss-20b-q4")!.reasoning,
    { efforts: { low: 2048, medium: 8192, high: 32768 } });
  // Non-thinking models have no block.
  assert.equal(byId.get("qwen2.5-0.5b-instruct-q4")!.reasoning, undefined);
  assert.equal(byId.get("qwen3-4b-instruct-2507-q4")!.reasoning, undefined);
  // gguf-only rule: the safetensors R1 twins are excluded.
  assert.equal(byId.get("deepseek-r1-distill-qwen-7b")!.reasoning, undefined);
  assert.equal(byId.get("deepseek-r1-distill-llama-70b")!.reasoning, undefined);
  // Structural rules across the whole catalog.
  let blocks = 0;
  for (const e of entries) {
    if (!e.reasoning) continue;
    blocks++;
    assert.equal(e.format, "gguf", `${e.id}: reasoning on a non-gguf entry`);
    const efforts = Object.entries(e.reasoning.efforts);
    assert.ok(efforts.length >= 3, `${e.id}: too few efforts`);
    for (const [k, v] of efforts) {
      assert.ok(typeof k === "string" && k.length > 0 && k !== "false", `${e.id}: bad effort key ${k} (YAML 1.1 boolean leak?)`);
      assert.ok(Number.isInteger(v) && v >= 0, `${e.id}.${k}: budget must be an int ≥ 0`);
    }
  }
  assert.equal(blocks, 72, "expected exactly 72 reasoning blocks (39 hybrid + 33 dedicated)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npm test`
Expected: FAIL — `qwen3-4b-q4` has no reasoning.

- [ ] **Step 3: Apply the blocks with a deterministic script.** Write `<scratchpad>/add-reasoning.cjs`:

```js
// Inserts reasoning blocks after each target entry's contextTokens line.
const fs = require("fs");
const HYBRID = [
  // Qwen3 base (hybrid thinking)
  "qwen3-0.6b-q4", "qwen3-1.7b-q4", "qwen3-4b-q4", "qwen3-8b-q4", "qwen3-14b-q4",
  "qwen3-32b-q4", "qwen3-30b-a3b-q4", "qwen3-235b-a22b-q4",
  // Qwen3.5 / 3.6 (family precedent)
  "qwen3.5-0.8b-q4", "qwen3.5-2b-q4", "qwen3.5-4b-q4", "qwen3.5-9b-q4", "qwen3.5-27b-q4",
  "qwen3.5-35b-a3b-q4", "qwen3.5-122b-a10b-q4", "qwen3.5-397b-a17b-q4",
  "qwen3.6-27b-q4", "qwen3.6-35b-a3b-q4",
  // GLM ≥ 4.5 (hybrid thinking mode)
  "glm-4.5-air-q4", "glm-4.5-q4", "glm-4.6-q4", "glm-4.7-q4", "glm-4.7-flash-q4",
  "glm-5-q4", "glm-5.1-q4", "glm-5.2-q4",
  // DeepSeek hybrids
  "deepseek-v3.1-q4", "deepseek-v3.1-terminus-q4", "deepseek-v3.2-q4", "deepseek-v4-flash-q4",
  // Others with vendor-supported non-thinking mode
  "smollm3-3b-q4", "hunyuan-a13b-instruct-q4",
  "nvidia-nemotron-3-nano-4b-q4", "nemotron-3-nano-30b-a3b-q4",
  "nvidia-nemotron-3-super-120b-a12b-q4", "nvidia-nemotron-3-ultra-550b-a55b-q4",
  "kimi-k2.5-q4", "kimi-k2.6-q4", "kimi-k2.7-code-q4",
];
const DEDICATED = [
  // Qwen thinking-only variants
  "qwen3-4b-thinking-2507-q4", "qwen3-30b-a3b-thinking-2507-q4",
  "qwen3-235b-a22b-thinking-2507-q4", "qwen3-next-80b-a3b-thinking-q4", "qwq-32b-q4",
  // DeepSeek R1 family (GGUF only)
  "deepseek-r1-distill-qwen-1.5b-q4", "deepseek-r1-distill-qwen-7b-q4",
  "deepseek-r1-distill-llama-8b-q4", "deepseek-r1-0528-qwen3-8b-q4",
  "deepseek-r1-distill-qwen-14b-q4", "deepseek-r1-distill-qwen-32b-q4",
  "deepseek-r1-distill-llama-70b-q4", "deepseek-r1-zero-q4", "deepseek-r1-q4", "deepseek-r1-0528-q4",
  // Mistral reasoners
  "magistral-small-2506-q4", "magistral-small-2507-q4", "magistral-small-2509-q4",
  "ministral-3-3b-reasoning-2512-q4", "ministral-3-8b-reasoning-2512-q4", "ministral-3-14b-reasoning-2512-q4",
  // Phi reasoners
  "phi-4-mini-reasoning-q4", "phi-4-reasoning-q4", "phi-4-reasoning-plus-q4",
  // Others
  "kimi-k2-thinking-q4",
  "minimax-m2-q4", "minimax-m2.1-q4", "minimax-m2.5-q4", "minimax-m2.7-q4", "minimax-m3-q4",
  "gpt-oss-20b-q4", "gpt-oss-120b-q4", "ernie-4.5-21b-a3b-thinking-q4",
];
const H = ["    reasoning:", "      efforts: { off: 0, low: 1024, medium: 4096, high: 16384 }"];
const D = ["    reasoning:", "      efforts: { low: 2048, medium: 8192, high: 32768 }"];
const lines = fs.readFileSync("catalog/models.yaml", "utf8").split("\n");
const out = []; let cur = null, inserted = 0;
for (const l of lines) {
  const m = l.match(/^  - id: (\S+)/);
  if (m) cur = m[1];
  out.push(l);
  if (/^    contextTokens:/.test(l) && cur) {
    if (HYBRID.includes(cur)) { out.push(...H); inserted++; }
    else if (DEDICATED.includes(cur)) { out.push(...D); inserted++; }
    cur = null; // one insertion per entry
  }
}
if (inserted !== HYBRID.length + DEDICATED.length)
  throw new Error(`inserted ${inserted}, expected ${HYBRID.length + DEDICATED.length} — an id is missing/misspelled`);
fs.writeFileSync("catalog/models.yaml", out.join("\n"));
console.log(`inserted ${inserted} reasoning blocks`);
```

Run from the repo root: `node <scratchpad>/add-reasoning.cjs`
Expected: `inserted 72 reasoning blocks`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npm test`
Expected: all PASS, including the new classification test (72 blocks, structural rules hold).

- [ ] **Step 5: Spot-check the YAML diff** — `git diff catalog/models.yaml | head -50`: blocks sit inside their entry (indented 4 spaces, after `contextTokens`), inline flow style. Verify one hybrid (`qwen3-4b-q4`) and one dedicated (`qwq-32b-q4`) by eye.

- [ ] **Step 6: Commit**

```bash
git add catalog/models.yaml control-plane/test/catalog.test.ts
git commit -m "feat(catalog): reasoning effort→budget blocks for 72 thinking-capable GGUF models"
```

---

### Task 4: Control plane — deployment routes, projections, custom-catalog validation

**Files:**
- Modify: `control-plane/src/server.ts` (listDeployments ~line 270; PATCH /v1/deployments/:name ~line 486; POST/PATCH /v1/catalog ~lines 103–145)
- Test: `control-plane/test/server.test.ts`

**Interfaces:**
- Consumes: `resolveDeployment` + error messages (Task 2); seed ids with reasoning (Task 3): `qwen3-4b-q4`.
- Produces (console relies on these exact names): local deployment rows gain `reasoning: {effort: string, budgetTokens: number} | null` and `reasoningOptions: Record<string, number> | null`; `PATCH /v1/deployments/:name` accepts `reasoningEffort: string | null`; `POST/PATCH /v1/catalog` accept a validated `reasoning` field. `GET /v1/catalog` already spreads the full entry (`...m`) — `reasoning` flows through with NO change there.

- [ ] **Step 1: Write the failing tests** — append to `control-plane/test/server.test.ts`:

```ts
test("POST /v1/deployments resolves reasoningEffort; GET exposes reasoning + options", async () => {
  const { store, objects } = fakeStore();
  const app = buildServer(catalog, store);
  const bad = await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "r-bad", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "p", reasoningEffort: "low" } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /does not support configurable reasoning/);
  const res = await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "r-ok", catalogId: "qwen3-4b-q4", poolRef: "p", reasoningEffort: "medium" } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(objects.modeldeployments[0].spec.reasoning, { effort: "medium", budgetTokens: 4096 });
  const list = (await app.inject({ method: "GET", url: "/v1/deployments" })).json().deployments;
  const row = list.find((d: any) => d.name === "r-ok");
  assert.deepEqual(row.reasoning, { effort: "medium", budgetTokens: 4096 });
  assert.deepEqual(row.reasoningOptions, { off: 0, low: 1024, medium: 4096, high: 16384 });
  // Non-reasoning deployment: both null.
  await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "r-plain", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "p" } });
  const plain = (await app.inject({ method: "GET", url: "/v1/deployments" })).json()
    .deployments.find((d: any) => d.name === "r-plain");
  assert.equal(plain.reasoning, null);
  assert.equal(plain.reasoningOptions, null);
});

test("PATCH /v1/deployments/:name sets, validates, and clears reasoningEffort", async () => {
  const { store, objects } = fakeStore();
  const app = buildServer(catalog, store);
  await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "r-edit", catalogId: "qwen3-4b-q4", poolRef: "p" } });
  const set = await app.inject({ method: "PATCH", url: "/v1/deployments/r-edit",
    payload: { reasoningEffort: "off" } });
  assert.equal(set.statusCode, 200);
  assert.deepEqual(set.json().spec.reasoning, { effort: "off", budgetTokens: 0 });
  const unknown = await app.inject({ method: "PATCH", url: "/v1/deployments/r-edit",
    payload: { reasoningEffort: "turbo" } });
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.json().error, /unknown reasoning effort/);
  const wrongEngine = await app.inject({ method: "PATCH", url: "/v1/deployments/r-edit",
    payload: { engine: "sglang", reasoningEffort: "low" } });
  assert.equal(wrongEngine.statusCode, 400);
  assert.match(wrongEngine.json().error, /llama\.cpp-only/);
  const clear = await app.inject({ method: "PATCH", url: "/v1/deployments/r-edit",
    payload: { reasoningEffort: null } });
  assert.equal(clear.statusCode, 200);
  assert.equal(objects.modeldeployments[0].spec.reasoning, undefined);
});

test("PATCH /v1/deployments/:name to a non-llama.cpp engine drops stale reasoning", async () => {
  const { store, objects } = fakeStore();
  const app = buildServer(catalog, store);
  await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "r-sg", catalogId: "qwen3-4b-q4", poolRef: "p", reasoningEffort: "low" } });
  const res = await app.inject({ method: "PATCH", url: "/v1/deployments/r-sg", payload: { engine: "sglang" } });
  assert.equal(res.statusCode, 200);
  assert.equal(objects.modeldeployments[0].spec.reasoning, undefined,
    "switching to sglang must clear the llama.cpp-only reasoning budget");
});

function fakeCustom() {
  const rows: any[] = [];
  return {
    rows,
    async list() { return rows; },
    async create(entry: any) {
      const i = rows.findIndex((r) => r.id === entry.id);
      if (i >= 0) rows[i] = entry; else rows.push(entry);
      return entry;
    },
    async delete(id: string) { rows.splice(0, rows.length, ...rows.filter((r) => r.id !== id)); },
  } as any;
}

test("custom catalog validates the reasoning shape", async () => {
  const { store } = fakeStore();
  const app = buildServer(catalog, store, fakeCustom());
  const base = { id: "my-thinker", displayName: "My Thinker", source: "https://example.com/m.gguf", format: "gguf" };
  for (const bad of [
    { efforts: {} },                          // empty
    { efforts: { low: -1 } },                 // negative
    { efforts: { low: 1.5 } },                // non-integer
    { efforts: { "": 5 } },                   // empty name
    { efforts: { ["x".repeat(17)]: 5 } },     // name too long
    { efforts: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9 } }, // > 8
    ["low"],                                  // not an object
  ]) {
    const res = await app.inject({ method: "POST", url: "/v1/catalog", payload: { ...base, reasoning: bad } });
    assert.equal(res.statusCode, 400, `should reject ${JSON.stringify(bad)}`);
  }
  const ok = await app.inject({ method: "POST", url: "/v1/catalog",
    payload: { ...base, reasoning: { efforts: { off: 0, deep: 20000 } } } });
  assert.equal(ok.statusCode, 201);
  assert.deepEqual(ok.json().reasoning, { efforts: { off: 0, deep: 20000 } });
  const patched = await app.inject({ method: "PATCH", url: "/v1/catalog/my-thinker",
    payload: { reasoning: { efforts: { low: 512 } } } });
  assert.equal(patched.statusCode, 200);
  assert.deepEqual(patched.json().reasoning, { efforts: { low: 512 } });
});
```

Check `buildServer`'s third parameter really is the custom repo (`buildServer(catalog, store, custom?, externals?)`) — `server.test.ts:278` passes `undefined` there for externals tests; mirror that signature.

- [ ] **Step 2: Make the fakeStore honor RFC 7386 null-deletes** — in `fakeStore().patch` (server.test.ts ~line 45), after the spec merge line add:

```ts
      // RFC 7386: a null value at the spec level deletes the key (the real
      // kubestore is a JSON merge-patch; reasoning clear relies on this).
      for (const [k, v] of Object.entries(body.spec ?? {})) if (v === null) delete obj.spec[k];
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd control-plane && npm test`
Expected: the new tests FAIL (reasoningEffort not in PATCH allowed set → 400 `only … are editable`; projections missing; catalog accepts bad shapes silently / strips reasoning).

- [ ] **Step 4: Implement in `server.ts`**

**(a) Projection** — `listDeployments` (~line 270): fetch the catalog once and add two fields to the `locals` mapping:

```ts
  const listDeployments = async (): Promise<any[]> => {
    const items = await store.list("modeldeployments");
    const { tokens } = await fetchServingMetrics();
    const { entries: cat } = await fullCatalog();
    const locals = items.map((d: any) => ({
      // …existing fields unchanged…
      reasoning: d.spec?.reasoning ?? null,
      // Efforts the deployment's catalog entry offers NOW (renders the edit
      // select); null when the entry is gone or has no reasoning.
      reasoningOptions: cat.find((e) => e.id === d.spec?.catalogId)?.reasoning?.efforts ?? null,
```

**(b) PATCH /v1/deployments/:name** (~line 486): add `"reasoningEffort"` to the `allowed` set. After the pool-budget check, before building `spec`:

```ts
    // Reasoning: string = re-resolve via the entry's CURRENT catalog mapping;
    // null = clear (merge-patch deletes the key); omitted = untouched.
    if (b.reasoningEffort !== undefined && b.reasoningEffort !== null) {
      const entry = (await fullCatalog()).entries.find((e) => e.id === current.spec?.catalogId);
      const efforts = entry?.reasoning?.efforts;
      if (!efforts) return reply.code(400).send({ error: `model does not support configurable reasoning` });
      const budgetTokens = efforts[b.reasoningEffort];
      if (typeof budgetTokens !== "number")
        return reply.code(400).send({ error: `unknown reasoning effort "${b.reasoningEffort}" — valid: ${Object.keys(efforts).join(", ")}` });
      const engine = b.engine ?? current.spec?.engine ?? "auto";
      if (engine !== "auto" && engine !== "llama.cpp")
        return reply.code(400).send({ error: `reasoning is llama.cpp-only (engine: ${engine})` });
    }
```

and in the `spec` assembly (after the `poolRef` line):

```ts
    if (b.reasoningEffort === null) spec.reasoning = null;
    else if (b.reasoningEffort !== undefined) {
      const efforts = (await fullCatalog()).entries.find((e) => e.id === current.spec?.catalogId)!.reasoning!.efforts;
      spec.reasoning = { effort: b.reasoningEffort, budgetTokens: efforts[b.reasoningEffort] };
    } else if (b.engine && b.engine !== "auto" && b.engine !== "llama.cpp" && current.spec?.reasoning) {
      spec.reasoning = null; // engine left llama.cpp — the budget flag no longer applies
    }
```

(Implementation may hoist the `fullCatalog()` lookup into one call — both blocks shown separately for clarity; a single `let resolvedReasoning` computed in the validation block and reused is the cleaner shape.)

**(c) Custom catalog** — add next to `badReleaseDate` (~line 100):

```ts
  // Custom-model reasoning: same shape the bundled YAML uses (spec 2026-07-12).
  const reasoningShapeError = (r: unknown): string | null => {
    if (r == null) return null;
    const efforts = (r as any)?.efforts;
    if (typeof r !== "object" || Array.isArray(r) || !efforts || typeof efforts !== "object" || Array.isArray(efforts))
      return "reasoning must be { efforts: { <name>: <tokenBudget> } }";
    const keys = Object.keys(efforts);
    if (!keys.length || keys.length > 8) return "reasoning.efforts needs 1–8 entries";
    for (const k of keys) {
      if (!k || k.length > 16) return "reasoning effort names must be 1–16 chars";
      if (!Number.isInteger(efforts[k]) || efforts[k] < 0 || efforts[k] > 131072)
        return "reasoning budgets must be integers 0–131072";
    }
    return null;
  };
```

In `POST /v1/catalog`: validate + carry the field:

```ts
    const reErr = reasoningShapeError(b.reasoning);
    if (reErr) return reply.code(400).send({ error: reErr });
```

and in the normalized `entry`: `...(b.reasoning ? { reasoning: b.reasoning } : {}),`

In `PATCH /v1/catalog/:id`: add `"reasoning"` to the `allowed` set and the same `reasoningShapeError` check before the merge (the existing `{ ...current, ...b }` merge then carries/overrides it).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat(cp): reasoningEffort on local deployment create/edit + projections + custom-catalog validation"
```

---

### Task 5: Console — deploy/edit modal select, detail row, catalog line

**Files:**
- Modify: `console/app/deployments/deploy-modal.tsx`
- Modify: `console/app/deployments/[name]/tabs.tsx`
- Modify: `console/app/catalog/page.tsx`

**Interfaces:**
- Consumes (Task 4): deployment rows' `reasoning {effort, budgetTokens} | null` + `reasoningOptions Record<string,number> | null`; catalog models' `reasoning?: { efforts }`; POST body `reasoningEffort?: string`; PATCH body `reasoningEffort: string | null`.
- Produces: UI only.

- [ ] **Step 1: deploy-modal.tsx.** All edits:

**(a)** `Ctx` — extend `catalogPick` and add local reasoning context; `reasoningEffort` is already there (shared with edit-remote):

```ts
  catalogPick?: { id: string; displayName: string; contextTokens?: number;
    reasoning?: { efforts: Record<string, number> } | null }[];
  reasoningOptions?: Record<string, number> | null; // deploy-local (preselected model) / edit-local: the entry's efforts
  reasoningEffort?: string | null; // edit-remote free text / edit-local current effort (already present — reuse)
```

**(b)** State — next to `ctxDefault` (line 48):

```ts
  const [reasonOpts, setReasonOpts] = useState<Record<string, number> | null>(ctx.reasoningOptions ?? null);
```

(The existing `reasoningEffort` state at line 63 doubles as the local select value — modes are exclusive.)

**(c)** Model-pick `onChange` (line 173): after `setCtxDefault(m?.contextTokens);` add:

```ts
              setReasonOpts(m?.reasoning?.efforts ?? null);
              setReasoningEffort("");
```

**(d)** Engine select `onChange` (line 216): replace with

```ts
            <select value={engine} onChange={(e) => { setEngine(e.target.value); if (e.target.value === "sglang") setReasoningEffort(""); }} style={{ width: 190, flex: "none" }}>
```

**(e)** Render the field — insert after the Engine `Field` (line 220), still inside the local branch:

```tsx
        {reasonOpts && ["auto", "llama.cpp"].includes(engine) && (
          <Field label="Reasoning" hint={mode === "edit-local"
              ? "caps the model's thinking tokens — changing it restarts the engine pods"
              : "caps the model's thinking tokens; default = unlimited"}>
            <select value={reasoningEffort} onChange={(e) => setReasoningEffort(e.target.value)} style={{ width: 240, flex: "none" }}>
              <option value="">Model default (unlimited)</option>
              {Object.entries(reasonOpts).sort((a, b) => a[1] - b[1]).map(([k, v]) =>
                <option key={k} value={k}>{k} — {v === 0 ? "thinking off" : `${v} tokens`}</option>)}
            </select>
          </Field>
        )}
```

**(f)** Submit bodies — `deploy-local` POST (line 90 block) gains:

```ts
        ...(reasoningEffort ? { reasoningEffort } : {}),
```

`edit-local` PATCH (line 98 block) gains:

```ts
        ...(reasoningEffort !== (ctx.reasoningEffort ?? "") ? { reasoningEffort: reasoningEffort || null } : {}),
```

**(g)** Restart diff (line 114) gains a fourth clause:

```ts
    reasoningEffort !== (ctx.reasoningEffort ?? "") ||
```

(inside the existing `mode === "edit-local" && (…)` expression, alongside the engine clause.)

**(h)** `DeployLocalButton` — accept and forward the preselected model's efforts, and map picks:

```ts
export function DeployLocalButton({ catalogId, defaultName, contextTokens, reasoning, small }:
  { catalogId: string; defaultName: string; contextTokens?: number;
    reasoning?: Record<string, number> | null; small?: boolean }) {
```

ctx gains `reasoningOptions: reasoning ?? null,` and both `catalogPick` mappings (here and in `DeployModelButton`) gain `reasoning: m.reasoning ?? null,`.

**(i)** `EditDeploymentName` local props union gains
`reasoningOptions?: Record<string, number> | null; reasoningEffort?: string | null;`
and the local `ctx` mapping gains
`reasoningOptions: props.reasoningOptions ?? null, reasoningEffort: props.reasoningEffort ?? null,`.

- [ ] **Step 2: tabs.tsx.** The local `EditDeploymentName` call (line 21) gains:

```tsx
              reasoningOptions={d.reasoningOptions ?? null} reasoningEffort={d.reasoning?.effort ?? null}
```

In the Serving card's local block (after the Engine row, line 60):

```tsx
              {(d.reasoning || d.reasoningOptions) && (
                <div className="row"><span className="muted">Reasoning</span>
                  <span>{d.reasoning
                    ? `${d.reasoning.effort} · ${d.reasoning.budgetTokens === 0 ? "thinking off" : `${d.reasoning.budgetTokens} tokens`}`
                    : "model default"}</span></div>
              )}
```

- [ ] **Step 3: catalog/page.tsx.** `CatalogEntry` interface gains
`reasoning?: { efforts: Record<string, number> } | null;`.
The muted second line (line 68) gains a reasoning suffix:

```tsx
                    {m.family} · {m.license ?? "—"}{m.requirements?.diskGB ? ` · ~${m.requirements.diskGB} GB` : ""}
                    {m.reasoning ? ` · reasoning: ${Object.entries(m.reasoning.efforts).sort((a, b) => a[1] - b[1]).map(([k]) => k).join("/")}` : ""}
```

And the row's `DeployLocalButton` (line 78) gains `reasoning={m.reasoning?.efforts ?? null}`.

- [ ] **Step 4: Build to verify**

Run: `cd console && npx tsc --noEmit && npx next build`
Expected: clean build, no type errors.

- [ ] **Step 5: Commit**

```bash
git add console/app/deployments/deploy-modal.tsx console/app/deployments/[name]/tabs.tsx console/app/catalog/page.tsx
git commit -m "feat(console): reasoning select on local deploy/edit + detail row + catalog efforts line"
```

---

### Task 6: Live verification + docs

**Files:**
- Modify: `CLAUDE.md` (conventions section), `TODO.txt`

**Interfaces:** none — this exercises Tasks 1–5 end-to-end on the cluster.

- [ ] **Step 1: Start the stack** (each in its own background shell, from the repo root):

```bash
# operator (reconciles spec.reasoning → ISVC; CRD was applied in Task 1)
cd operator && PATH="$HOME/sdk/go/bin:$HOME/go/bin:$PATH" go run ./cmd
# control plane (NOT npm run dev)
cd control-plane && DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev25 \
  DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files npx tsx src/main.ts
# console — production build
cd console && npx next build && npx next start -p 7090
```

- [ ] **Step 2: Set an effort on the live qwen3.5 deployment via the API**

```bash
curl -s -X PATCH localhost:7080/v1/deployments/qwen3-5-4b-q4 -H 'Content-Type: application/json' \
  -d '{"reasoningEffort":"medium"}'
kubectl get modeldeployment qwen3-5-4b-q4 -n devproof-serving -o jsonpath='{.spec.reasoning}'
```

Expected: `{"budgetTokens":4096,"effort":"medium"}` — if `reasoning` is missing here, the CRD apply from Task 1 Step 6 didn't happen (structural pruning).

- [ ] **Step 3: Confirm the operator rendered the flags** (wait ~15s for reconcile + rollout):

```bash
kubectl get isvc qwen3-5-4b-q4 -n devproof-serving -o jsonpath='{.spec.reasoningBudget} {.spec.reasoningBudgetMessage}'
kubectl rollout status deploy/qwen3-5-4b-q4 -n devproof-serving --timeout=300s
kubectl get deploy qwen3-5-4b-q4 -n devproof-serving -o jsonpath='{.spec.template.spec.containers[0].args}'
```

Expected: ISVC shows `4096 Thinking budget reached — concluding and answering now.`; args contain `--reasoning-budget 4096` and `--reasoning-budget-message`.

- [ ] **Step 4: Completion through the gateway shows capped thinking** (use an active dpk_ key from the API Keys page):

```bash
curl -s localhost:14000/v1/chat/completions -H "Authorization: Bearer $DPK" -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-5-4b-q4","max_tokens":300,"messages":[{"role":"user","content":"How many primes below 50?"}]}'
```

Expected: 200; response usable; `reasoning_content` present but bounded (≤ ~4096 tokens).

- [ ] **Step 5: `off` and clear round-trip**

```bash
curl -s -X PATCH localhost:7080/v1/deployments/qwen3-5-4b-q4 -H 'Content-Type: application/json' -d '{"reasoningEffort":"off"}'
# after rollout: args contain --reasoning-budget 0 and NO --reasoning-budget-message
curl -s -X PATCH localhost:7080/v1/deployments/qwen3-5-4b-q4 -H 'Content-Type: application/json' -d '{"reasoningEffort":null}'
# after rollout: neither flag present (back to the original args)
```

Verify args after each with the Step 3 `kubectl get deploy … args` command.

- [ ] **Step 6: Console checks** (browser or chrome-devtools MCP against `localhost:7090`):
  - `/deployments`, `/catalog`, `/deployments/qwen3-5-4b-q4` all 200.
  - Catalog: qwen3.5-4b row's muted line shows `reasoning: off/low/medium/high`; qwen2.5 rows don't.
  - Deploy modal for Qwen3.5 4B shows the Reasoning select (options `off — thinking off`, `low — 1024 tokens`, …); picking a qwen2.5 model hides it; engine SGLang hides it.
  - Edit dialog on the qwen3-5-4b detail page prefills the current effort; changing it raises the "Restart engine pods?" confirm.
  - qwen05b-dp detail shows no Reasoning row; qwen3-5-4b shows `model default` (after Step 5's clear).

- [ ] **Step 7: Docs.** In `CLAUDE.md` conventions, add after the external-endpoints bullet:

```markdown
- **Local reasoning** (spec 2026-07-12): thinking-capable **GGUF** catalog entries carry `reasoning.efforts` (label→token budget; hybrids include `off: 0`, dedicated reasoners don't). Deploy/edit picks an effort; the CP resolves it AT SAVE TIME into CR `spec.reasoning {effort, budgetTokens}` (snapshot — later catalog edits don't retune existing deployments) and the operator renders ISVC `reasoningBudget` + a wrap-up `reasoningBudgetMessage` (llama.cpp `--reasoning-budget`; changes roll engine pods). llama.cpp engines only (`auto`/`llama.cpp`; switching to sglang clears it); no `reasoning` block = no Reasoning UI. Custom catalog API accepts a validated `reasoning` field (no form UI yet).
```

In `TODO.txt`, delete the line `- Reasoning configurable local models.`

- [ ] **Step 8: Full test sweep**

```bash
cd control-plane && npm test && npx tsc --noEmit
cd ../operator && PATH="$HOME/sdk/go/bin:$HOME/go/bin:$PATH" go test ./...
```

Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add CLAUDE.md TODO.txt
git commit -m "docs: local reasoning conventions; TODO — configurable reasoning shipped"
```
