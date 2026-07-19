# LLMkube 0.9.4 upgrade + minimal SGLang runtime passthrough — design

Date: 2026-07-12. Status: approved (approach A of three considered).

Upgrade the pinned LLMkube from 0.9.1 to 0.9.4 with zero behavior change for
existing deployments, then expose the new SGLang runtime as a deployable
option through one optional `runtime` field flowing catalog → control plane →
ModelDeployment → InferenceService.

## Upstream facts (researched 2026-07-12, verified against tag diffs)

- CRD changes 0.9.1 → 0.9.4 are **additive only**: `InferenceService`
  `spec.runtime` enum (`llamacpp` default | `generic` | `personaplex` |
  `vllm` | `tgi` | `sglang`) gains `sglang`, plus a new optional
  `spec.sglangConfig` object. `Model` and `ModelRouter` CRDs are
  byte-identical. Nothing Devproof consumes was renamed or removed.
- Helm chart `values.yaml` is byte-identical; CRDs live in
  `charts/llmkube/templates/crds/` (gated by `crds.install`, default true),
  so a plain `helm upgrade` re-applies them — no manual `kubectl apply`.
- **Not fixed upstream:** the 0.9.1 custom-metric HPA (dotted selector
  labels) and the InferenceService phase-flap to `Progressing` during scale
  events. The Devproof scaler (queue-depth annotation) and the operator's
  Ready-stickiness workaround remain required and untouched.
- v0.9.3's vLLM `--enable-metrics` fix and v0.9.2's operator-metrics cleanup
  do not affect the llama.cpp path or the `llamacpp:*` series the scaler
  scrapes.

## Phase 1 — version bump

- `helm upgrade llmkube llmkube/llmkube -n llmkube-system --version 0.9.4 -f deploy/llmkube/values.yaml`
  (values stay `{}`).
- Update pin comments in `deploy/llmkube/values.yaml` (0.9.1 → 0.9.4) and
  the LLMkube section of `deploy/README.md`: new version, CRDs-upgrade-via-
  helm note, and that the 0.9.1 dead-ends (HPA selector labels, phase flap)
  were re-verified as still present on 0.9.4.
- Verification: `inferenceservices` CRD contains the `sglang` enum;
  `qwen05b-dp` and `qwen3-5-4b-q4` stay Ready with intact gateway routes;
  one live session turn E2E. Rollback: `helm rollback llmkube -n llmkube-system`.

## Phase 2 — SGLang passthrough (reuse `spec.engine`)

Scope decisions (user-confirmed): expose runtime selection only — **no
`sglangConfig`** (LLMkube defaults apply; config knobs wait for real GPU
use). Verification is wire + unit tests only: the dev cluster is CPU-only,
so no live SGLang pod is expected to run.

**Amended 2026-07-12 (user-approved):** instead of a new
`spec.model.runtime` field, reuse the pre-existing, currently-unwired
`ModelDeployment.spec.engine` (enum `auto;llama.cpp;vllm`, already in the
PATCH whitelist). No DB migration, no catalog column — the runtime is
chosen per deployment in the deploy/edit dialog.

- **Operator** (`operator/api/v1alpha1/types.go`): extend the `Engine`
  kubebuilder enum to `auto;llama.cpp;vllm;sglang`. Regenerate CRDs
  (controller-gen object+crd) and re-apply. `transform.Build` sets
  `isvcSpec["runtime"] = "sglang"` only when `spec.engine == "sglang"`;
  every other value (`auto`, `llama.cpp`, `vllm`, empty) omits the field —
  the LLMkube default (`llamacpp`) applies and existing ISVCs do not churn.
  `vllm` stays accepted-but-unmapped exactly as today. Unit tests: default
  omits `runtime`; `sglang` emits it.
- **Control plane:** `DeploymentRequest` gains optional `engine`;
  `resolveDeployment` uses `req.engine ?? "auto"` (today hardcoded
  `"auto"`). POST `/v1/deployments` validates it; the PATCH whitelist
  already contains `engine` — its validation list gains `sglang`. Serving
  is global — no workspace scoping, no migration.
- **Console:** the shared local deploy/edit modal gains an "Engine" select
  (`auto (llama.cpp)` default / `SGLang`), local deployments only (external
  endpoints unaffected); the deployment detail page displays the engine.
  Shared `Modal`/`Field` components; no new UI primitives.
- **Gateway:** untouched. SGLang serves an OpenAI-compatible endpoint and
  routes like any local model. The schema sanitizer applies to all
  `devproof_local` entries including SGLang-backed ones; its transforms
  yield valid schemas, so this is harmless.

## Error handling

An SGLang deployment on the CPU-only cluster fails at the pod level; that
surfaces through the existing ISVC-status → ModelDeployment-status →
console path (`Progressing`/`Failed`). No special casing.

## Testing & verification

- Operator: `go test ./...` (new transform cases). Go lives at `~/sdk/go/bin`.
- Control plane: `npm test` + `npx tsc --noEmit`.
- Console: production build (`npx next build`).
- Live: Phase 1 checks above; then create an SGLang deployment from the
  console, confirm the generated ISVC carries `runtime: sglang`
  (`kubectl get inferenceservices -n devproof-serving <name> -o yaml`),
  confirm the console shows its (non-Ready) status sanely, delete it.

## Out of scope

`sglangConfig` knobs, vLLM/TGI/generic/personaplex runtimes, GPU node
provisioning, autoscaling changes (scaler stays), model-cache TODO items,
gateway changes.
