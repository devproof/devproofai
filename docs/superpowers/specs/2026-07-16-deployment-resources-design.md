# Per-deployment CPU/memory requests — design (2026-07-16)

Approved section-by-section in brainstorming. Model deployments get
user-visible per-replica CPU/memory **requests**, carried by the catalog and
prefilled into the deploy/edit modal. Today `resolveDeployment`
(`control-plane/src/catalog.ts:73`) hardcodes `cpu: "2"`, `memory: "2Gi"` for
every deployment; there is no API or console field to change them.

## Motivation

- The plumbing already exists end-to-end for requests: `ModelDeploymentSpec.Resources`
  (`operator/api/v1alpha1/types.go:101`, flat map `cpu`/`memory`/`gpu`) is copied
  verbatim into the LLMkube InferenceService (`transform.go:77`) and rendered as
  pod **requests** (verified live on qwen-medium and against the LLMkube ISVC
  CRD schema). Only the values are hardcoded.
- Models differ wildly (0.27B CPU models to 480B multi-GPU MoEs); one default
  cannot fit, and requests drive scheduling correctness.

## Decisions (user-confirmed)

- **Requests only. No limits anywhere** — LLMkube's ISVC schema has no limits
  concept, and carrying inert limit fields would confuse. (Limits were
  considered and explicitly dropped 2026-07-16.)
- **Catalog-driven and mandatory.** Every catalog entry carries
  `resources: { cpu, memory }`. **No legacy fallback** — the app is not rolled
  out yet; an old DB row without the field fails deployment with a clear 400
  until re-saved through the catalog modal.
- **Entry-level, not per-profile.** The deploy flow has no capacity-profile
  picker (`resolveDeployment` voids `capacityProfiles[0]`), so per-profile
  values could not prefill deterministically. Entry values are bounded by the
  *smallest* profile so the pod schedules on every listed hardware option.
- **Deploy AND edit modals** expose the fields; editing rolls the engine pods
  behind the existing "Restart engine pods?" confirm.
- **Snapshot semantics** (like reasoning): values resolve at deploy/save time;
  later catalog edits don't retune existing deployments.
- **No CRD or operator change.** `spec.resources` already exists; `gpu` stays
  sourced from `requirements.gpus`.

## 1. Data model & catalog values

### Schema

`CatalogEntry` (`catalog.ts`) gains a **required** field, placed in each YAML
entry directly above `capacityProfiles`:

```yaml
resources: { cpu: "2", memory: "3Gi" }   # per-replica k8s requests
```

Values are k8s quantity strings. The schema comment block at the top of
`catalog/models.yaml` documents the field and the assignment rule below.

### Assignment rule for the bundled entries (all values verified, 2026-07-16)

**CPU models** (`requirements.gpus: 0`): `cpu: "2"`,
`memory: (diskGB + 2)Gi` — weights are mmapped into pod memory; +2Gi covers the
32k-capped KV cache and runtime. Grounded in the live qwen0.5b footprint.

**GPU models**: per capacity profile compute
*usable-node × gpusPerReplica ÷ GPUs-per-node*, floor each key **after** the
multiplication (so multi-GPU pods don't compound per-GPU rounding), then take
the **minimum across the entry's profiles**. Usable node capacity is the worst
case across EKS, GKE and AKS reservation formulas (GKE tiered kube-reserved
memory + AKS pre-1.29 750Mi eviction threshold + AKS CPU table, +10m/core
extrapolated past 64 cores), minus a **500m CPU / 1 GiB DaemonSet allowance**
per node:

| Profile instance | Node (verified) | Worst-case usable node | Per-GPU share (pre-rounding) |
|---|---|---|---|
| g4dn.xlarge / g5.xlarge | 4 vCPU / 16 GiB / 1 GPU | 3.36 vCPU / 11.67 GiB | 3.36 / 11.67 → **3 / 11Gi** |
| g5.2xlarge | 8 / 32 / 1 | 7.32 / 26.71 | 7.32 / 26.71 → **7 / 26Gi** |
| g6e.xlarge | 4 / 32 / 1 | 3.36 / 26.71 | 3.36 / 26.71 → **3 / 26Gi** |
| a100-80gb (p4de.24xlarge) | 96 / 1152 / 8 | 94.44 / 1120.5 | 11.8 / 140.1 → **11 / 140Gi** |
| h100-80gb (p5.48xlarge) | 192 / 2048 / 8 | 189.48 / 1998.5 | 23.7 / 249.8 → **23 / 249Gi** |

Resulting examples: Qwen 7B / Llama 8B → `3`/`11Gi` · Phi-4 14B, Mistral Small
24B, Qwen3-30B family → `3`/`26Gi` · Qwen 32B (a100×1) → `11`/`140Gi` ·
Llama 70B (a100×2 bounds it: 23.61/280.1) → `23`/`280Gi` · Qwen 235B (a100×4:
47.2/560.2) → `47`/`560Gi` · Qwen3 Coder 480B (h100×8, whole node) →
`189`/`1998Gi`.

Cross-check: the 1-GPU numbers bracket the vLLM production-stack chart
(6 CPU / 16Gi per 1-GPU pod) and NVIDIA NIM (4 CPU / 16Gi requests) — ours are
bounded by the small xlarge nodes those charts don't target.

Flagged assumptions (auditable):
1. AKS publishes its CPU table only to 64 cores; the 96/192-core values
   extrapolate its +10m/core pattern (consistent from 8→64 cores). Sub-node
   pods (×1/×2/×4 on 8-GPU nodes) keep multiple vCPUs of rounding slack; a
   whole-node pod (h100×8) keeps the 500m DaemonSet allowance plus ~0.5 vCPU
   rounding as buffer — if AKS's real reserve beyond 64 cores exceeds the
   pattern by more than that, the h100 value needs a bump down.
2. The 500m/1Gi DaemonSet allowance is site-specific by nature (the one input
   not derivable from vendor docs) — tunable, revisit if the target clusters
   run heavy monitoring DaemonSets.

Sources: AWS Batch/EKS reservation formula, GKE node-sizing docs, AKS
node-resource-reservations doc, EKS AMI ENI data (maxPods), vantage.sh
instance specs, vLLM production-stack helm values, NVIDIA NIM helm docs.

## 2. Control plane

- **Types.** `CatalogEntry.resources: { cpu: string; memory: string }`
  (required). `DeploymentRequest.resources?: { cpu?: string; memory?: string }`
  (optional — API callers may omit and get the catalog value; the console
  always sends explicit values).
- **Resolution** (`resolveDeployment`): per key, explicit request value wins,
  else the catalog entry's value; entry without `resources` ⇒ throw (→ 400).
  `gpu` from `requirements.gpus` as today. Resolved values land in the CR's
  existing `spec.resources`.
- **Validation.** Shared sanity helper: cpu `^\d+(\.\d+)?$|^\d+m$`, memory
  `^\d+(Ki|Mi|Gi|Ti)$`. Applied to `POST /v1/catalog` (field required, 400
  without it), `PATCH /v1/catalog/:id` (validated when present; joins the
  `allowed` set), `POST /v1/deployments` and `PATCH /v1/deployments/:name`
  (validated when present, partial keys allowed).
- **Deployment edit.** `resources` joins the PATCH `allowed` set
  (`server.ts:564`), applied as `spec.resources = { cpu, memory }`.
  `store.patch` is JSON merge-patch (verified, `kubestore.ts:57-60`); RFC 7386
  merges nested objects key-wise, so `resources.gpu` survives without explicit
  merge logic. The operator reconciles and rolls the engine pods; the gateway
  route is untouched (same endpoint), so no warmup/routing implications.
- **Read side.** `GET /v1/catalog` carries `resources` automatically (entries
  are spread). `listDeployments` (`server.ts:331`) gains
  `resources: d.spec?.resources ?? null` so the edit modal prefills the
  deployment's *actual* values.

## 3. Console

### Catalog model modal (`model-modal.tsx`)

New required row in the "Capacity profiles" section, directly above the
"Profiles" field, Requirements-row idiom (muted inline labels, one line):

```
Requests    cpu [ 2 ]  memory [ 3Gi ]
```

- `Draft` gains `cpu`/`memory`; `toDraft` reads `m?.resources`; `toBody` emits
  `resources: { cpu, memory }`. New-model defaults `cpu: "2"`,
  `memory: "3Gi"`.
- Save `disabled` adds `|| !d.cpu || !d.memory`; format errors surface via the
  CP 400 like other fields.
- Hint: "per-replica k8s requests (e.g. 2, 500m / 3Gi) — prefilled into new
  deployments".

### Deploy/edit modal (`deploy-modal.tsx`)

One line after "Sleep after", before "Context":

```
Resources   cpu [ 3 ]  memory [ 11Gi ]
```

- **Prefill, deploy:** both `catalogPick` mappings (`DeployLocalButton`,
  `DeployModelButton`) add `resources`; picking a model sets both fields (same
  pattern as `contextTokens`/`reasoning`). The preselected-model path passes
  `resources` as a prop from the catalog row (`catalog/page.tsx:80`).
- **Prefill, edit:** from the deployment's own `spec.resources` via the new
  projection field, threaded through `EditDeploymentName`'s ctx; sole local
  call site is the detail page (`deployments/[name]/tabs.tsx:22`).
- **Submit:** deploy always sends `resources: { cpu, memory }`; edit sends it
  only when changed, and a change joins `restartChanged` so the restart
  confirm fires.
- **Validation:** client-side, same quantity regexes as the CP, folded into
  `canSubmit` + the existing error-line pattern. Fields are required (they
  arrive prefilled; blank = user cleared them).
- GPU count is intentionally absent from both forms.

## 4. Testing & verification

Backend (`cd control-plane && npm test`, joins the suite; no throwaway
workspaces — Serving is global):
1. `resolveDeployment` unit tests: entry values carried; per-key request
   override; entry without `resources` throws; `gpu` from requirements.
2. Route validation: `POST /v1/catalog` without `resources` → 400; malformed
   quantities (`"2 cores"`, `"3GB"`, `"-1"`) → 400 on all four write
   endpoints; `"500m"`/`"3Gi"` accepted.
3. **Catalog YAML guard**: load `catalog/models.yaml`, assert every entry has
   `resources` with valid quantities — locks the ~60-entry backfill and any
   future additions.

Live (docker-desktop, per verify-before-done):
- CP + console (production build) restart; /catalog, /deployments, detail 200.
- Deploy a small model: fields prefilled from the catalog; engine Deployment
  requests match exactly (`kubectl get deploy -n devproof-serving`).
- Edit resources: restart confirm fires, pods roll with new values.
- `gpu` preservation without GPU nodes: kubectl-create an MD whose
  `spec.resources` includes `gpu` (never schedules — irrelevant), PATCH
  cpu/memory via the API, assert `gpu` survived in the CR spec.
- `npx tsc --noEmit` clean, console `next build` clean.

## Out of scope

- Limits (dropped by decision — nothing prepared, nothing stored).
- Per-profile resources and a capacity-profile picker in the deploy flow.
- Operator/CRD changes (none needed).
- LimitRange or any namespace-level enforcement.
