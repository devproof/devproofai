# Devproof AI — Sub-plan E: Autoscaling (Phase 2 core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Checkbox steps.

**Goal:** Queue-pressure autoscaling per concept §5.5: Prometheus scrapes llama.cpp engine metrics; the Devproof operator generates a KEDA ScaledObject per ModelDeployment (when `replicas.max > min`); a load burst scales a deployment 1→2 and idle scales it back. Smoke tests stay green.

**Architecture decision (supersedes the interim LLMkube-HPA wiring):** Devproof owns scaling via KEDA, NOT via LLMkube's `autoscaling` field — two HPAs on one Deployment would conflict, KEDA is the concept-named mechanism, and only KEDA reaches scale-to-zero later. The transform reverts InferenceService to static `replicas = min` and emits a `keda.sh/v1alpha1 ScaledObject` targeting the provider Deployment. Trigger: Prometheus query `sum(llamacpp:requests_processing + llamacpp:requests_deferred)` for the deployment's pods, threshold 2 per replica (llama.cpp default parallel slots = 1; >2 waiting ⇒ queue pressure). Scale-in stabilization 120s (cold starts are expensive). Scale-to-zero (`min: 0`) is wired in the ScaledObject (`minReplicaCount: 0` allowed) but NOT activated for the dev model; activating it end-to-end needs the KEDA HTTP add-on for wake-on-request — documented as open, not silently claimed.

**Verified precondition:** engine pods expose `llamacpp:requests_processing`/`requests_deferred`/`predicted_tokens_seconds` on `:8080/metrics` (checked live); no scrape annotations exist, so Prometheus gets an explicit kubernetes_sd pod scrape job for namespace `devproof-serving`.

## Tasks

### Task 1: Prometheus (minimal) on cluster
**Files:** `deploy/prometheus/values.yaml`
- [ ] Helm install `prometheus-community/prometheus` (server only: alertmanager, pushgateway, node-exporter, kube-state-metrics disabled) in ns `devproof-observability`, with `extraScrapeConfigs`: job `devproof-serving-pods`, kubernetes_sd role pod, keep namespace `devproof-serving`, port 8080, path `/metrics`, plus a `service` relabel from pod label `app`
- [ ] Verify: query API returns nonzero series for `llamacpp:requests_processing`
- [ ] Commit `feat(observability): minimal Prometheus scraping engine metrics`

### Task 2: KEDA on cluster
**Files:** `deploy/keda/values.yaml` (pinned version note)
- [ ] Helm install kedacore/keda in ns `keda`
- [ ] Verify operator + metrics-apiserver pods Ready
- [ ] Commit `feat(observability): KEDA installed`

### Task 3: Operator emits ScaledObject (TDD)
**Files:** `operator/internal/transform/transform.go` (+_test), `operator/internal/controller/modeldeployment_controller.go`
**Interface change:** `Build(md, pool)` → adds third return `scaledObject *unstructured.Unstructured` (nil when max<=min). InferenceService loses the `autoscaling` field (static replicas=min always).
- [ ] Update tests: no `spec.autoscaling` ever; ScaledObject nil when min==max; when max>min: kind ScaledObject, `spec.scaleTargetRef.name == md.Name`, min/maxReplicaCount from bounds, prometheus trigger with serverAddress `http://prometheus-server.devproof-observability.svc`, query contains `llamacpp:requests_processing` and pod regex for the deployment, threshold "2", `spec.advanced.horizontalPodAutoscalerConfig.behavior.scaleDown.stabilizationWindowSeconds: 120`
- [ ] Implement; unit tests pass
- [ ] Controller applies/deletes ScaledObject with ownerRef (SSA, same pattern)
- [ ] Delete stale LLMkube HPA path: patch qwen05b-dp InferenceService via re-reconcile (autoscaling field dropped by SSA since we own the field set)
- [ ] Commit `feat(operator): KEDA ScaledObject generation, replaces provider HPA path`

### Task 4: Live scale test
**Files:** `scripts/load-burst.mjs` (N concurrent chat requests for T seconds)
- [ ] Restart operator; verify ScaledObject exists, HPA (KEDA-owned) present, old LLMkube HPA gone
- [ ] Burst 8 concurrent × ~60s at qwen05b-dp via gateway → watch replicas reach 2
- [ ] Idle ≥3 min → replicas return to 1
- [ ] Both smoke tests green; commit `feat(autoscaling): live scale-out/in verified on dev cluster`

## Self-review notes
- Scale-to-zero explicitly deferred (needs KEDA HTTP add-on for wake) — recorded in Architecture.
- Threshold 2/replica is a starting heuristic; capacity-profile-driven thresholds are the learning-loop follow-up (concept §5.5), out of this sub-plan.
