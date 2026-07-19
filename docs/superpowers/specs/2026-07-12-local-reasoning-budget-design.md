# Configurable reasoning for local models — design

Date: 2026-07-12. Status: approved (chat). Companion to
`2026-07-12-reasoning-effort-freetext-design.md`, which shipped configurable
reasoning for external endpoints and explicitly deferred local models.

## Goal

Local (in-cluster llama.cpp) deployments get configurable reasoning via
**catalog-defined effort→token-budget options**. The catalog is the source of
truth: a model without a `reasoning` block cannot reason, and no Reasoning
field appears anywhere for it. A deployment picks one effort; the control
plane resolves it to a token budget at save time and the operator renders it
as the engine's `--reasoning-budget` flag.

## Verified live (2026-07-12, docker-desktop cluster)

| Claim | Evidence |
|---|---|
| llama.cpp (deployed `ghcr.io/ggml-org/llama.cpp:server`) supports `--reasoning-budget N` with arbitrary N (−1 unrestricted, 0 immediate end, N>0 cap) and `--reasoning-budget-message` | `llama-server --help` inside the running qwen3-5-4b pod |
| LLMkube ISVC `spec.reasoningBudget` renders into engine pod args | patched live ISVC with `reasoningBudget: 4096` → Deployment args gained `--reasoning-budget 4096` |
| The budget actually caps thinking | budget 48 → completion's `reasoning_content` cut at the budget, answer continued in `content` |
| An abrupt cap leaks thinking-style text into visible content | observed in the budget-48 test → we set `reasoningBudgetMessage` (below) |
| `off` as a YAML key parses as the **string** `"off"` with our parser | `yaml` npm package (YAML 1.2 core) — verified with the exact snippet; the boolean gotcha is YAML 1.1 only |

## Design

### 1. Catalog schema (`catalog/models.yaml` + `CatalogEntry`)

Thinking-capable entries gain one optional block, inline-flow style matching
the existing `requirements` convention:

```yaml
reasoning:
  efforts: { off: 0, low: 1024, medium: 4096, high: 16384 }
```

- Absent block ⇒ model cannot reason ⇒ no Reasoning UI, deploy-time 400 if an
  effort is submitted anyway.
- Effort names are catalog-author-defined free keys; the UI renders them
  sorted by budget ascending. Values are token budgets (int ≥ 0); `0` means
  thinking disabled.
- `CatalogEntry` gains `reasoning?: { efforts: Record<string, number> }`.

**Classification rules for the bundled catalog** (~170 entries; only
`format: gguf` entries get blocks — safetensors entries resolve to vLLM,
which is out of scope):

| Class | Efforts | Rule / entries |
|---|---|---|
| **Hybrid** (vendor-supported non-thinking mode) | `{ off: 0, low: 1024, medium: 4096, high: 16384 }` | Qwen3 base (`qwen3-{0.6b,1.7b,4b,8b,14b,32b}`, `qwen3-30b-a3b`, `qwen3-235b-a22b`), all `qwen3.5-*`/`qwen3.6-*`, GLM ≥4.5 (`glm-4.5*`, `glm-4.6`, `glm-4.7*`, `glm-5*`), DeepSeek `v3.1*`/`v3.2`/`v4-flash`, `smollm3-3b`, `hunyuan-a13b-instruct`, Nemotron-3 (`nano`/`super`/`ultra`), Kimi `k2.5`/`k2.6`/`k2.7-code` |
| **Dedicated reasoner** (always thinks; no `off` — forcing 0 lobotomizes it) | `{ low: 2048, medium: 8192, high: 32768 }` | `qwen3-*-thinking-*`, `qwen3-next-80b-a3b-thinking`, `qwq-32b`, all `deepseek-r1*` (incl. distills, zero, 0528), `magistral-small-*`, `ministral-3-*-reasoning-*`, `phi-4-mini-reasoning`, `phi-4-reasoning`, `phi-4-reasoning-plus`, `kimi-k2-thinking`, `minimax-m2*`/`m3`, `gpt-oss-20b`/`gpt-oss-120b`, `ernie-4.5-21b-a3b-thinking` |
| **Non-thinking** (no block) | — | everything else: `qwen2.5*`, `qwen3-*-instruct-2507`, `qwen3-coder-*`, `qwen3-next-*-instruct`, all Llama, all Gemma (incl. 3/3n/4, medgemma, functiongemma), Mistral instruct/nemo/small/medium/large, `devstral*`, Phi-4 base + `mini-instruct`, `glm-4-9b-chat`, `kimi-k2-instruct*`, DeepSeek `v3`/`v3-0324`, all Granite, `smollm2*`, `grok-2` |

The gguf-only rule wins over the class lists: the two safetensors R1 entries
(`deepseek-r1-distill-qwen-7b`, `deepseek-r1-distill-llama-70b`, vLLM) get
**no** block despite matching the dedicated-reasoner pattern (their `-q4`
GGUF twins do get one).

Post-knowledge-cutoff families (Qwen3.5/3.6, GLM-5.x, Kimi K2.5+, MiniMax
M2.5+, DeepSeek V4, Nemotron-3, Ministral-3, …) are classified by naming
convention and family precedent — reviewable in the catalog diff.

### 2. Control plane

- `DeploymentRequest` gains `reasoningEffort?: string`.
- `resolveDeployment` (`catalog.ts`): when set, look up
  `entry.reasoning.efforts[effort]` and emit
  `spec.reasoning = { effort, budgetTokens }`. Errors (thrown, surfaced as
  400 like `unknown catalog entry`): entry has no `reasoning` block
  ("model does not support configurable reasoning"); unknown effort (message
  lists valid ones); engine not llama.cpp-backed (only `auto` and
  `llama.cpp` allowed — vLLM/SGLang out of scope). Empty/absent effort ⇒ no
  `spec.reasoning` ⇒ engine default (unrestricted).
- **Snapshot semantics** (same philosophy as decision 3.11): the budget is
  resolved at save time and stored in the CRD; later catalog edits don't
  retune existing deployments.
- `PATCH /v1/deployments/:name`: `reasoningEffort` joins the allowed set.
  String ⇒ re-resolve against the entry's current catalog mapping (validated
  as above); `null` ⇒ clear (`spec.reasoning = null` in the merge patch
  removes the field). Omitted ⇒ untouched.
- `listDeployments` projection: local rows gain
  `reasoning: d.spec?.reasoning ?? null` (`{effort, budgetTokens}`).
- `GET /v1/catalog` projection gains `reasoning` so the console can render
  options.
- Custom catalog (`POST/PATCH /v1/catalog`): `reasoning` joins the allowed
  field set with shape validation (`efforts`: non-empty object, ≤8 keys, keys
  non-empty strings ≤16 chars, values integers 0..131072). No console form UI
  for defining efforts (follow-up); the existing bundled-override snapshot
  (`{...current, ...b}`) carries `reasoning` through unrelated edits.

### 3. Operator

`ModelDeploymentSpec` gains:

```go
// Reasoning caps the model's thinking output (llama.cpp runtimes only).
// +optional
Reasoning *ReasoningSpec `json:"reasoning,omitempty"`

// ReasoningSpec is an effort label resolved to a token budget by the
// control plane at deploy time (catalog-defined mapping, snapshot semantics).
type ReasoningSpec struct {
    // Effort is the catalog effort label this budget was resolved from (display).
    Effort string `json:"effort,omitempty"`
    // BudgetTokens caps reasoning tokens per response; 0 disables thinking.
    // +kubebuilder:validation:Minimum=0
    BudgetTokens int32 `json:"budgetTokens"`
}
```

`transform.Build`: when `Reasoning != nil`, set ISVC
`reasoningBudget = int64(BudgetTokens)`; when `BudgetTokens > 0`, also set
`reasoningBudgetMessage` to the constant
`"Thinking budget reached — concluding and answering now."` (the live test
showed an abrupt cap makes the model continue thinking-style text in the
visible answer; the message forces a clean conclusion; llama.cpp injects it
before the end-of-thinking tag). Budget 0 gets no message (nothing to wrap
up). Field absent ⇒ flags omitted ⇒ engine default (−1, unrestricted).

Regen CRDs (`controller-gen object+crd`, Go at `~/sdk/go/bin`) and re-apply.
Changing the budget rolls the engine pods via LLMkube (same as any ISVC spec
change); `PlacementChanged` is unaffected (reasoning is not a placement
field).

### 4. Console

- **Deploy/edit modal** (`deploy-modal.tsx`, local sections): a "Reasoning"
  `Field` with a `<select>`: `Model default (unlimited)` + one option per
  effort, labeled `<name> — <budget> tokens` (e.g. `medium — 4096 tokens`),
  sorted by budget. Rendered only when the selected catalog model has
  `reasoning` **and** engine is `auto`/`llama.cpp` (switching engine to
  vllm/sglang hides it and clears the selection). Edit mode prefills the
  current effort; a change joins the restart-confirm diff. POST sends
  `reasoningEffort` only when set; PATCH sends the new value or `null` when
  changed, omits when untouched. `catalogPick` entries and the modal `ctx`
  carry `reasoning` through.
- **Deployment detail** (`tabs.tsx`): local deployments get a Reasoning row —
  `medium · 4096 tokens`, or `model default`.
- **Catalog detail**: a Reasoning line listing the entry's efforts (e.g.
  `off / low / medium / high`) when present.
- Remote endpoints keep their existing free-text Reasoning field untouched —
  the shared modal renders select-for-local vs text-for-remote.

### 5. Untouched

Gateway config/hooks (the flag is engine-side; no request rewriting), warmup,
sanitizer, usage metering, session runner.

### 6. Tests

- `operator/internal/transform/transform_test.go`: reasoning set ⇒ ISVC
  `reasoningBudget` + message; budget 0 ⇒ no message; nil ⇒ both absent.
- CP (`node test`): `resolveDeployment` with valid effort ⇒ `spec.reasoning`
  resolved; unknown effort / non-reasoning model / vllm+sglang engine ⇒ 400;
  PATCH set + clear (`null` removes); catalog YAML round-trip parses `off` as
  a string key; custom-catalog `reasoning` shape validation (bad shapes ⇒
  400, valid ⇒ persisted).
- Console: `npx tsc --noEmit` + production build.

### 7. Live verification (definition of done)

1. Restart CP + console; all pages 200.
2. Deploy (or edit) Qwen3.5-4B with `medium` ⇒ engine pod args contain
   `--reasoning-budget 4096` and `--reasoning-budget-message …`; a completion
   through the gateway shows capped thinking with a clean conclusion.
3. Edit the deployment to `off` ⇒ args show `--reasoning-budget 0` and no
   message flag; completion has no `reasoning_content`.
4. Clear back to model default ⇒ flags gone.
5. qwen05b (non-thinking Qwen 2.5) shows no Reasoning field in deploy modal,
   detail page, or catalog detail.
6. `cd control-plane && npm test && npx tsc --noEmit`; `go test ./...` in
   `operator/`; `cd console && npx next build`.

## Out of scope (documented)

- vLLM/SGLang runtimes (LLMkube `reasoningBudget` is llama.cpp-only).
- Per-agent/session reasoning override (would need request-level injection;
  the engine flag is per-deployment).
- Console form UI for defining `reasoning` on custom catalog models (API
  accepts it; UI is a follow-up).
- gpt-oss native template-level effort words (`Reasoning: low/medium/high`
  system-prompt convention) — the generic token cap works meanwhile.
- Surfacing "thinking capped" in session traces / usage.
