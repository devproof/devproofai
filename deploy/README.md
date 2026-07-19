# Dev cluster and toolchain notes

## Deployment
All in-cluster components (Postgres, MinIO, gateway, operator, and the LLMkube
subchart) are deployed via the umbrella chart `helm-charts` — see the chart
README. The dev profile is `helm-charts/values-dev.yaml`:

```bash
helm dependency build helm-charts
helm install devproof helm-charts -n devproof --create-namespace \
  -f helm-charts/values-dev.yaml --skip-schema-validation
```

`--skip-schema-validation` is required (llmkube subchart schema quirk). Under
Helm v4 (server-side apply), the control plane co-owns the `litellm-config`
ConfigMap's `config.yaml` key at runtime, so re-`helm upgrade` needs
`--force-conflicts` (the chart re-emits the live value verbatim via `lookup`).
The out-of-cluster dev control plane / console are not chart-managed (dev
profile ships no CP/console pods).

## Cluster
- kubectl context: `docker-desktop` (never switch context in scripts)
- Kubernetes v1.36.1, CPU-only, 6 nodes:
  `desktop-control-plane` (control-plane) + `desktop-worker` … `desktop-worker5`

## Toolchain (installed 2026-07-07)
- kubectl client v1.34.1
- Helm **v4.2.2** (winget `Helm.Helm`; plan assumed 3.x — v4 CLI is command-compatible for our usage)
- Go **1.26.4** — installed from official ZIP to `~/sdk/go` because the winget MSI
  requires UAC elevation. Not on PATH by default: use `$HOME/sdk/go/bin/go`
  (Git Bash) or add `%USERPROFILE%\sdk\go\bin` to PATH.
- Node v25.9.0, npm 11.12.1, Python 3.14.4, Docker 29.5.3

## LLMkube
- Chart + app version **0.9.7** (pinned; 0.9.1 → 0.9.4 on 2026-07-12, → 0.9.7 on 2026-07-19), bundled as the
  `llmkube` subchart of `helm-charts` (runs in the `devproof` namespace); values are set
  under the `llmkube:` key of `helm-charts/values.yaml`.
- CRDs: `models`, `inferenceservices`, `modelrouters`, and since 0.9.7 `gpuquotas` + `loraadapters` (group `inference.llmkube.dev/v1alpha1`; the latter two are unused by Devproof — the quota admission webhook is gated behind `multitenancy.enabled`, default false)

## Autoscaling (phase 2)
- `ReplicaBounds max > min` => operator sets `InferenceService.spec.autoscaling`
  (disables LLMkube replica enforcement) with metric **Resource/cpu @ 75%**;
  LLMkube manages the HPA; metrics-server feeds it. Scale 1->2->1 verified live
  under `scripts/load-burst.mjs`.
- metrics-server: helm chart `metrics-server/metrics-server` in kube-system with
  `--kubelet-insecure-tls` (docker-desktop).
- Prometheus (devproof-observability) scrapes engine pods (llamacpp:* metrics) —
  used for dashboards/learning loop; NOT for the HPA.
- Dead ends verified on LLMkube 0.9.1 (documented in operator transform.go):
  external scalers (KEDA) are reverted unless `autoscaling` is set; KEDA's
  webhook refuses HPA-co-managed targets; LLMkube's custom-metric HPA uses
  dotted selector labels (`inference.llmkube.dev/service`) that no Prometheus
  series can carry => queue-pressure scaling needs an upstream LLMkube fix.
  Re-checked against 0.9.4 (2026-07-12): neither the HPA selector-label bug nor the Progressing phase-flap was fixed upstream — the Devproof scaler and Ready-stickiness workarounds remain required.
  0.9.7 (2026-07-19): ISVC `spec.image` is NOT reliably honored for llamacpp — the
  controller intermittently rebuilds the engine template from the accelerator default,
  flapping the template and rolling engine pods (observed live; that's why
  `operator.engineImage` ships with empty repositories). Same flap on ISVC
  `spec.imagePullSecrets` (observed live, same day) - engine pods therefore run
  PUBLIC upstream images only (curl init reverted to docker.io/curlimages/curl);
  the operator's DEVPROOF_IMAGE_PULL_SECRET env stays unset in the chart.
  Re-checked against 0.9.7 (2026-07-19): the CPU placement gating (ISVC nodeSelector/tolerations rendered only for GPU/DRA pods, `deployment_builder.go`) is verified unchanged at the 0.9.7 tag, so the nodeAffinity workaround stays; the 0.9.5–0.9.7 release notes mention no fix for the HPA selector bug or the phase flap — all workarounds remain.
- KEDA installed but unused by the LLMkube provider path; reserved for
  scale-to-zero (HTTP add-on) and non-LLMkube providers.

## Agents plane (phase 3)
- Session runner image devproof/session-runner:dev - docker-built images ARE visible to the multi-node docker-desktop cluster (verified; no registry needed, imagePullPolicy IfNotPresent).
- Session pods reach the out-of-cluster control plane via http://host.docker.internal:7080 (verified).
- E2E verified: POST /v1/agents + /v1/sessions -> K8s Job -> session runner (in-process agent loop) -> gateway /v1/messages (local model) -> typed events persisted in Postgres.

- Same-tag image rebuilds are NOT seen by nodes (containerd caches by tag with IfNotPresent) - bump the tag per build and set DEVPROOF_RUNNER_IMAGE.

## File storage (scalable)
- MinIO (S3-compatible), PVC-backed, deployed by the `helm-charts` chart (dev profile runs it in the `devproof` namespace).
- Control plane uses it when `DEVPROOF_S3_ENDPOINT` is set (localhost-lb exposes it on `localhost:19000` in dev), else local disk.
  Env: `DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files DEVPROOF_S3_ACCESS_KEY=devproof DEVPROOF_S3_SECRET_KEY=devproof-dev-secret`.
- Files are content-addressed (id = `file_<sha256>`) → identical uploads dedup. Shared across all control-plane
  replicas and session pods, so attachments scale beyond a single host's disk.

## Deletes & interrupt (phase 4+)
- `DELETE /v1/sessions/:id` (stops running Job + purges files), `DELETE /v1/files/:id`,
  `DELETE /v1/memory-stores/:id` and `.../entries?path=`.
- `POST /v1/sessions/:id/interrupt` stops the running Job and sets the session `idle` (resumable).
