# Devproof umbrella chart

One `helm install` deploys the platform: control plane, console, LiteLLM
gateway, Devproof operator, and (toggleable) bundled Postgres + MinIO. The
LLMkube operator is a pinned chart dependency.

## Install

    helm dependency build helm-charts
    scripts/patch-llmkube-schema.sh
    helm install devproof helm-charts -n devproof --create-namespace

Dev (docker-desktop):

    helm install devproof helm-charts -n devproof --create-namespace \
      -f helm-charts/values-dev.yaml

(`patch-llmkube-schema.sh` fixes the vendored LLMkube subchart schema after
`helm dependency build`; the released OCI chart ships already patched.)

### Upgrades

`helm upgrade` additionally requires `--force-conflicts`: under Helm 4
server-side apply, the control plane co-owns the `config.yaml` key of the
`litellm-config` ConfigMap (it rewrites gateway config at runtime), so a plain
upgrade fails with a field-ownership conflict. `--force-conflicts` is expected
and safe here because the chart re-emits the CP-written value verbatim
(lookup-preserve).

## Prerequisites

- metrics-server (gateway HPA)
- Optional: Prometheus (dashboards), KEDA (reserved) — not chart-managed

## Key values

| Value | Meaning |
|---|---|
| `postgres.enabled=false` + `externalDatabase.*` | bring your own Postgres |
| `minio.enabled=false` + `s3.*` | real S3; `s3.auth.mode=podIdentity` uses the pod's AWS identity (set `controlplane.serviceAccount.annotations` for IRSA) |
| `<component>.service.{type,annotations,nodePort}` | endpoint exposure (console, gateway, controlplane) |
| `<component>.{resources,nodeSelector,tolerations}` | scheduling — every component |
| `<component>.{labels,annotations,podAnnotations}` | extra labels/annotations on the workload object and its pods — every component (postgres, minio, gateway, controlplane, console, operator) |
| `postgres|minio.persistence.{storageClass,size}` | disks |
| `agents.namespace` | session-pod namespace (chart-created) |
| `operator.controlPlaneUrl` | operator→CP callback URL (auto-derived in-cluster; set for out-of-cluster CP) |
| `namespaces.gateway|serving` | split layouts; default = release namespace |
| `llmkube.*` | passthrough to the LLMkube dependency (see audit below) |

## Out of scope (v1)

Ingress/TLS, credential rotation, observability stack, gateway image baking,
chart publishing. `existingSecret` values must exist before install (read via
`lookup`). Generated passwords are minted once and survive upgrades; rotation
is not supported. This chart's `crds.install` gates only the devproof-authored
CRDs (ModelPool, ModelDeployment); the LLMkube subchart's own CRDs
(InferenceService, ModelRouter, Model) are governed by its own
`llmkube.crds.install` value.

## LLMkube passthrough (audited 2026-07-18, chart 0.9.4; re-verified 2026-07-19 against 0.9.7 — upstream values contract unchanged, only a new `multitenancy.enabled` key, default false; re-verified 2026-07-23 against 0.9.10 — passthrough keys unchanged, new top-level keys only: `pyrra`, `gpuSharing`, `runtimeImages`, `platformFloors`, all default-off/empty)

Everything under the `llmkube:` values key passes through to the upstream
LLMkube chart (pinned dependency). Scheduling/resources/PVC requirements map
as follows:

| Umbrella value | Upstream effect |
|---|---|
| `llmkube.controllerManager.resources` | operator pod resources (requests/limits) |
| `llmkube.controllerManager.nodeSelector` | operator nodeSelector |
| `llmkube.controllerManager.tolerations` | operator tolerations |
| `llmkube.modelCache.storageClass` | model-cache PVC storage class |
| `llmkube.modelCache.size` | model-cache PVC size |
| `llmkube.podAnnotations` / `llmkube.podLabels` | controller-manager pod annotations/labels (top-level upstream keys, NOT nested under `controllerManager` — verified against `templates/deployment.yaml`) |

Verified by rendering `helm template test llmkube/llmkube --version 0.9.4`
(templates carrying these keys are byte-identical in 0.9.7)
with each of the above set to a distinct probe value:

- `controllerManager.resources` renders verbatim onto the `manager` container
  in the `templates/deployment.yaml` Deployment (`resources.requests`/`.limits`).
- `controllerManager.nodeSelector` and `controllerManager.tolerations` render
  verbatim onto the same Deployment's pod spec (`spec.template.spec.nodeSelector`
  / `.tolerations`).
- `modelCache.storageClass` and `modelCache.size` render onto the shared-mode
  cache PVC (`templates/model-cache-pvc.yaml`, `spec.storageClassName` /
  `spec.resources.requests.storage`) **and** are threaded to the controller as
  `--model-cache-storage-class` / `--model-cache-size` args, which the
  operator uses to provision the per-`InferenceService` cache PVCs when
  `modelCache.mode: perService` (the mode this chart sets via the `llmkube`
  subchart values in `values.yaml`) — so both cache modes are covered by the
  same two values.
- `podAnnotations` and `podLabels` (2026-07-19 audit, controller pod
  labels/annotations) render verbatim onto the controller-manager pod
  template (`templates/deployment.yaml` lines 14-23: annotations alongside
  the fixed `kubectl.kubernetes.io/default-container: manager`, labels
  alongside the fixed selector labels). Confirmed via
  `helm show values llmkube/llmkube --version 0.9.4 | grep -in "podAnnotations\|podLabels"`
  (comments: "Pod annotations" / "Pod labels"). These are top-level chart
  values, not nested under `controllerManager` — set them as
  `llmkube.podAnnotations.<key>` / `llmkube.podLabels.<key>` (Helm forwards
  the whole `llmkube:` block to the subchart, so no umbrella wiring is
  needed). No equivalent knob exists for the controller-manager *Deployment
  object's own* metadata (only its pods) — not a gap worth a passthrough
  value, since the umbrella's own `<component>.labels/annotations` contract
  only reaches devproof-authored workloads.

No other upstream values.yaml path was found for these five requirements;
`helm show values llmkube/llmkube --version 0.9.4` documents all five
directly (comments: "Resource limits and requests", "Node affinity for
multi-architecture support", "Storage size for each model cache PVC",
"Storage class (leave empty for the cluster default)").

### Gaps

No gaps — all required knobs exposed.

## Operator CRDs

`templates/operator/crds/modelpools.yaml` and `modeldeployments.yaml` are exact
copies of `operator/config/crd/serving.devproof.ai_modelpools.yaml` and
`serving.devproof.ai_modeldeployments.yaml`, each wrapped in
`{{- if and .Values.crds.install .Values.llmkube.enabled }} ... {{- end }}`. After running `controller-gen`
to regenerate `operator/config/crd/`, re-copy both files into the chart and
re-apply the same wrap (first line `{{- if and .Values.crds.install .Values.llmkube.enabled }}`, last line
`{{- end }}`, content otherwise byte-for-byte unchanged).
