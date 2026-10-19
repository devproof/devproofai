# LLMkube 0.10.4 + LiteLLM v1.106.0 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the bundled LLMkube subchart from 0.9.10 to 0.10.4 and the gateway's LiteLLM base image from the July `main-stable` digest (≈v1.92/1.93) to `v1.106.0`, drop the operator nodeAffinity workaround that 0.10.4 makes redundant, and verify both live on the docker-desktop cluster.

**Architecture:** Two independent dependency bumps, LLMkube first, each its own commit and its own live verification pass. LLMkube is a chart-pin + mirrored-controller-tag change (Tasks 1–2); the nodeAffinity removal it enables is a separate operator change (Task 3); the gateway base is a Dockerfile digest re-pin whose risk lives entirely in `helm-charts/files/custom_callbacks.py`'s compatibility with a 13-minor-version-newer LiteLLM (Task 4). Task 5 is the whole-stack regression gate.

**Tech Stack:** Helm v4.2.2 (`helm dependency update`, `scripts/patch-llmkube-schema.sh`), LLMkube chart 0.10.4 (`https://defilantech.github.io/LLMKube`), `ghcr.io/berriai/litellm:v1.106.0`, Go 1.26.4 (`~/sdk/go/bin/go`), docker buildx bake, docker-desktop Kubernetes v1.36.1.

**Spec:** No separate design doc — this is a dependency upgrade, so the investigation findings below are the spec. Upstream sources: LLMKube releases <https://github.com/defilantech/LLMKube/releases>, LiteLLM release notes <https://docs.litellm.ai/release_notes/>.

## Investigation findings (2026-10-19)

**LLMkube: 0.9.10 → 0.10.4** (chart + appVersion 0.10.4, published 2026-10-16; 0.10.0 landed 2026-09-29).

| Check | Result |
| --- | --- |
| InferenceService CRD `spec` properties | 64 → 69, **nothing removed**; added `bindAddress`, `maxPodLifetimeIdleTimeoutSeconds`, `multiNode`, `stageModel`, `suspend`. `required: [modelRef]` unchanged. |
| Model CRD `spec` properties | 10 → 15, **nothing removed**; added `attestation`, `fileSha256`, `prefetch`, `prefetchNodeSelector`, `prefetchTolerations`. `required: [source]` unchanged. |
| CRD set | `gpuquotas`, `inferenceservices`, `loraadapters`, `modelrouters`, `models` + new `modelpools` (group `inference.llmkube.dev` — no collision with our `serving.devproof.ai` ModelPool) and `federatedclusters` (`federation.llmkube.dev`). |
| Values keys we pass through | All present with identical defaults: `imagePullSecrets`, `controllerManager.image.{repository,tag}`, `controllerManager.initContainer.{repository,tag}`, `controllerManager.{resources,nodeSelector,tolerations}`, `modelCache.{enabled,mode,size,storageClass,mountPath}`. |
| `values.schema.json` subchart gap | Still `additionalProperties:false` at the root with no `enabled`/`global` → **`scripts/patch-llmkube-schema.sh` stays required**. |
| Webhooks | Same three as 0.9.10 (`vmodelrouter`, `vinferenceservicequota` gated behind `multitenancy.enabled`, mutating `mmodel` with `failurePolicy: Ignore`); 0.10.4 adds an optional cert-manager mode, default off. |
| New default-ON behaviour | `controllerManager.watchCanary` (interval `60s`, `failAfter 5m`): the controller renews a Lease and requires its own informer to observe the write, else the **liveness probe fails and the kubelet restarts it**. Also `reconcileTimeout: 15m`. New RBAC: lease verbs without leader election, `serviceaccounts` read, `pods` create/delete/patch, `secrets` create, `federatedclusters`. |
| Upstream fix that touches us | **0.9.17 (#1504, 2026-08-13) "apply nodeSelector and tolerations to non-GPU services"**, confirmed in source at tag v0.10.4: `internal/controller/deployment_builder.go` lines 618–641 moved both **out of the `gpuCount > 0` branch**, with a comment that the old gating was the bug. `isvc.Spec.Image` (line 453) and `isvc.Spec.ImagePullSecrets` (line 575) are consumed as before; whether the *flap* that made us ship public engine images is fixed is only observable live. |
| Release notes read | All 25 app releases v0.9.11 → v0.10.4. Nothing affecting Devproof's surface beyond the above: the ISVC `scale` subresource already existed in 0.9.10 (0.9.30 #1881 only adds `labelSelectorPath: .status.selector`, so an HPA *can* target an ISVC — we create none and set no `spec.autoscaling`, and 0.10.3 #2010 makes the controller refuse to overwrite a same-name HPA); 0.9.12/0.9.13 changed the `Available` condition and added `Stopped`/`Suspended` phases, which our status mapping never reads (it reads `status.phase`, `status.endpoint`, `status.readyReplicas`, and those phases require `spec.suspend`, which we never set); 0.9.26's ModelPool reclaim/`poolActivation` and the router's own 503 + `Retry-After` belong to LLMkube's router and ModelPool, which Devproof does not use; 0.9.30 #1898 adds llama.cpp `--alias` so the engine reports a clean model id. |

**LiteLLM: July `main-stable` → v1.106.0.**

| Check | Result |
| --- | --- |
| Current pin | `ghcr.io/berriai/litellm:main-stable@sha256:a1745e629abfb17d434426ff48b115f54f4f4c4a0f5af241de569e93c63c411e` — image created 2026-07-19 from source revision `052b5a21` (commit dated 2026-07-19), i.e. the v1.92.1/v1.93.0 line. No `LITELLM_RELEASE_TAG` env in that build. |
| Target | `v1.106.0`, released 2026-10-18. The GHCR tag `v1.106.0` and today's `main-stable` resolve to the **same digest** `sha256:2e4c0371f3a8c28e4da131d77abaa8341cd3b0c2fcc4d34d7c5900431af7b9d0` (`LITELLM_RELEASE_TAG=v1.106.0`, wolfi base, `python-3.13`). `main-stable` is still published despite third-party claims of deprecation. |
| Our API surface at v1.106.0 | All present: `CustomLogger.async_pre_call_hook`, `async_post_call_streaming_iterator_hook`, `async_log_success_event`, `async_post_call_{success,failure}_hook`; `litellm.proxy._types.UserAPIKeyAuth`; `litellm.proxy.proxy_server.llm_router`; `user_custom_auth`; `litellm.use_chat_completions_url_for_anthropic_messages` (default False, we set it true); `drop_params`. |
| `asyncpg==0.31.0` | Ships cp313 wheels, `requires_python >=3.9` → the baked install still resolves on the new python-3.13 base. (0.32.0 exists; **not** part of this upgrade.) |
| Breaking changes read | Every `:::danger[Breaking Changes]` block in the docs repo for v1.94.0 → v1.105.1 plus v1.106.0rc1–rc3 (the GA notes page for 1.106.0 is not published; rc1 carries that line's only breaking block, rc2/rc3 none). |
| …that reach us | **v1.104.0**: proxy **refuses to start with an unset/empty/publicly-known master key** (escape hatches `LITELLM_DANGEROUSLY_PERMIT_WEAK_OR_UNSET_MASTER_KEY=true` / `general_settings.dangerously_permit_weak_or_unset_master_key`). **v1.94.0**: `timeout`, `stream_timeout` and `request_timeout` in `litellm_params` are now **enforced on `/v1/messages`** (previously ignored there; `stream_timeout` caps the gap between any two chunks) — we set none of the three anywhere, so the 600s client default still applies and our ≤300s wake-holds fit inside it, but the knob is now live on that surface. |
| …that do not | DB/Prisma gates (v1.104 exit-on-DB-failure, v1.105 `ENFORCE_PRISMA_MIGRATION_CHECK` ignored, v1.103 SpendLogs index build): LiteLLM gets no `DATABASE_URL` — ours is `DEVPROOF_DATABASE_URL` on purpose. Budgets (v1.94/v1.95 team-key budgets, v1.99 shadow-eval dollars, v1.103 fallback re-checks and `max_budget: 0`, v1.104's 422): we enforce spend in our own hook, not LiteLLM's. v1.103 "config file owns every setting it declares, DB no longer overrides": we are config-only and never call `/config/field/update` — neutral. v1.102/v1.103 `model_info` pricing rules: our `model_info` carries only marker flags (`devproof_sanitize`, `key_version`, `devproof_reasoning_effort`, `devproof_routing`) — no prices, no `key` field. v1.106.0rc1 `cache_params.max_messages: 4`: we never enable the response cache. v1.100 `prompt_token_calculator` deletion, v1.98 Langfuse/StandardLoggingPayload allowlist: our success hook reads only `prompt_tokens`/`completion_tokens` from `standard_logging_object` and takes attribution from `litellm_params.metadata`/`litellm_metadata`. Also not applicable: v1.96 mock params, v1.97 auto-router affinity, v1.98 worker registry, v1.99 audit logs, v1.100 MCP toolsets + `/spend/logs` cap, v1.101 MongoDB/OpenAI-WS/password policy, v1.103 MCP upstream auth + `CustomLogger` moderation (we register no moderation hook), v1.105 Bedrock GPT native Chat Completions and `/sso/debug`, and v1.105's `safety_identifier` 400 (we set `drop_params: true`). |
| Rust `/v1/messages` (verified, not assumed) | `litellm/rust_bridge/catalog.py` at v1.106.0: `RouteRule(MESSAGES, RUST_OPT_IN, providers={"anthropic"})` then `RouteRule(MESSAGES, PYTHON_ONLY)`, first match wins — so the Rust path is reachable **only** for provider `anthropic` on `/v1/messages`, and `configuration.py`'s `decide()` resolves `RUST_OPT_IN` to `Decision.PYTHON` whenever `LITELLM_RUST` is unset and no process override is set. `CHAT_COMPLETIONS` is `PYTHON_ONLY` outright, which is the bridge our `use_chat_completions_url_for_anthropic_messages: true` routes through. Our model_list uses `openai/`-prefixed providers for locals and custom endpoints, so only a user-added Anthropic external endpoint even reaches the opt-in rule. `OCR` is `RUST_REQUIRED` and Bedrock transcription too — neither is a Devproof surface. |
| Upstream-bug compensations (wire-only) | Our hooks exist because the `/v1/messages` chat-completions bridge hardcodes `message_start.usage.input_tokens=0`, drops plain `metadata` (not `litellm_metadata`), and drops `Retry-After` on 503. No release note between 1.94 and 1.106 mentions any of the three, so whether they still hold is observable only on the wire — Task 4 checks each. |

## Global Constraints

- **Never bump platform semver by hand** (image tags, `Chart.yaml` `version`/`appVersion`, `package.json`, git tags, README install examples): that is CI/CD's job via `bump-version` + `release`. This plan changes only the **dependency** pins (`Chart.yaml` `dependencies[].version`, the mirrored controller tag, the gateway base digest) — exactly the surface of the precedent commit `636aacb`.
- **Commit messages carry no Claude/AI references** — no `Co-Authored-By`, no "Generated with" line (project decision 2026-07-23).
- Chart renders must pass with the subchart schema patched: run `scripts/patch-llmkube-schema.sh` after every `helm dependency build`/`update`, before lint/package.
- `helm upgrade` of an existing release needs `--force-conflicts` (the CP co-owns the `litellm-config` ConfigMap's `config.yaml` key) and `-f helm-charts/values-dev.yaml` on the dev cluster.
- `LITELLM_RUST` must never be set in the chart or the gateway image.
- Keep the engine images public and the ISVC `spec.image` posture unchanged in this upgrade; only the nodeAffinity workaround is being withdrawn.
- Go is not on PATH: use `~/sdk/go/bin/go`.

## Review Focus

1. **Empty master key is now fatal, not a warning** (LiteLLM ≥1.104). CORRECTED 2026-10-19 after review: the chart's generated path is NOT affected — `devproof.stableSecretValue` falls through to `randAlphaNum 24` and the rendered Secret is non-empty even without a cluster (verified by rendering it; the comment in `templates/gateway/secret.yaml` that claimed otherwise was wrong and is fixed). The real exposures are a bring-your-own `existingSecret` whose `master-key` is present but EMPTY (LiteLLM boot refusal) or ABSENT (kubelet `CreateContainerConfigError`, the env var being a required `secretKeyRef`). Task 4 boots the new image with and without a master key and records both outcomes.
2. **`litellm_params` timeouts now bite `/v1/messages`** (v1.94.0). We set none today, so nothing breaks on upgrade — but the first person to add `timeout`/`stream_timeout`/`request_timeout` to a deployment or external endpoint will now cut long local-model streams mid-response (`stream_timeout` measures the gap between *any* two chunks, and a CPU llama.cpp prefill is seconds-to-tens-of-seconds) and can truncate a held wake request. Task 4 asserts the rendered config still carries no timeout key, so the absence is a checked invariant rather than an accident; `LITELLM_RUST` is asserted absent in the same step as cheap defense, though `catalog.py` already makes our surfaces Python-only.
3. **Dropping `affinity` from the rendered ISVC must not read as a placement move.** `PlacementChanged` compares `affinity`, and a reported move drains the deployment to zero and deletes the per-service model-cache PVC (weights re-download). Task 3 removes `affinity` from both the renderer and the comparison, and verifies live that the engine pods roll but the PVC survives.
4. **The watch-canary can restart the controller mid-reconcile** on a loaded single-host cluster — including mid cache-bounce, between the drain apply and the PVC delete. Task 2 watches restart counts across a ≥20-minute window and a deliberate bounce.
5. **Our hooks compensate for upstream `/v1/messages` bugs that may now be fixed.** CORRECTED 2026-10-19 after review: `_bump_usage_dict` raises `input_tokens` only when the existing value is `< est`, so a now-populated upstream count is NOT overwritten — the residual is narrower, a legitimate count BELOW the estimate (prompt caching splits the total across `cache_read`/`cache_creation`) still gets inflated, which is pre-existing and conservative for compaction; if `Retry-After` now survives, dev53's bare-503 patient path changes its delay source; if plain `metadata` now survives, the dual-channel merge still works but the comment is stale. Task 4 checks all three on the wire before concluding the upgrade is clean.

---

### Task 1: Bump the bundled LLMkube subchart 0.9.10 → 0.10.4

**Files:**
- Modify: `helm-charts/Chart.yaml:12` (`dependencies[0].version`)
- Modify: `helm-charts/Chart.lock` (regenerated)
- Modify: `helm-charts/values.yaml:35` (comment "defaults mirror upstream 0.9.10") and `helm-charts/values.yaml:49` (`llmkube.controllerManager.image.tag`)
- Modify: `scripts/mirror-images.sh:34`, `scripts/mirror-images.ps1` (same mirror line)
- Modify: `THIRD-PARTY-NOTICES.md` (mirrored-image row + chart dependency row)
- Modify: `helm-charts/README.md:57` (passthrough audit line)
- Modify: `deploy/README.md` (LLMkube section: version line, CRD list, workaround note)
- Modify: `CHANGELOG.md` (Changed entry)
- Test: `helm-charts/tests/render.test.mjs` (existing; expected to pass unchanged)

**Interfaces:**
- Consumes: nothing.
- Produces: subchart 0.10.4 vendored at `helm-charts/charts/llmkube-0.10.4.tgz`; mirrored controller image `ghcr.io/devproof/devproofai-llmkube-controller:0.10.4` referenced by `values.yaml`. Tasks 2 and 3 deploy this chart.

- [ ] **Step 1: Mirror the upstream controller image to GHCR**

Edit the mirror line in both scripts first (`ghcr.io/defilantech/llmkube-controller:0.9.10 → devproofai-llmkube-controller:0.9.10` becomes `…:0.10.4 → …:0.10.4`), then:

```bash
docker login ghcr.io          # token needs write:packages
scripts/mirror-images.sh
docker manifest inspect ghcr.io/devproof/devproofai-llmkube-controller:0.10.4 | head -20
```

Expected: a multi-arch manifest list (amd64 + arm64). The package is already public, so no visibility flip is needed for the new tag.

- [ ] **Step 2: Repin the dependency and regenerate the lock**

```bash
helm repo update llmkube
helm dependency update helm-charts     # update, not build: Chart.lock must regenerate
scripts/patch-llmkube-schema.sh
ls helm-charts/charts/
```

Expected: `llmkube-0.10.4.tgz` present, `llmkube-0.9.10.tgz` gone, `Chart.lock` version 0.10.4 with a fresh digest, and the patch script printing `patched …: schema now allows subchart keys 'enabled'/'global'`.

- [ ] **Step 3: Diff the rendered output old vs new**

Render the new chart, then render the pre-bump chart from a clean checkout of the two pin files into a temporary worktree (so the vendored tgz of each version is rendered against the same values), and diff:

```bash
helm template devproof helm-charts -n devproof -f helm-charts/values-dev.yaml --skip-schema-validation > /tmp/new.yaml
git worktree add /tmp/pre-bump HEAD
cd /tmp/pre-bump && helm dependency build helm-charts && scripts/patch-llmkube-schema.sh \
  && helm template devproof helm-charts -n devproof -f helm-charts/values-dev.yaml --skip-schema-validation > /tmp/old.yaml
cd - && git worktree remove /tmp/pre-bump --force
diff -u /tmp/old.yaml /tmp/new.yaml | grep -E "^[+-]" | grep -vE "^[+-]{3}" | head -80
```

Expected: only additive changes — the new controller args (`--watch-canary-*`, `--reconcile-timeout`), the new CRDs (`modelpools`, `federatedclusters`), the widened RBAC, the canary Role, and the image tag `0.9.10 → 0.10.4`. Any **removed** key that Devproof sets is a stop: re-check it against the 0.10.4 `values.yaml` before continuing.

- [ ] **Step 4: Run the chart tests**

```bash
helm lint helm-charts --skip-schema-validation
node --test helm-charts/tests/render.test.mjs
```

Expected: lint clean; all render tests pass with no edits (the assertions key on Devproof's own images and the `imagePullSecrets` count, not on llmkube internals).

- [ ] **Step 5: Update the docs**

`THIRD-PARTY-NOTICES.md`: bump both the `devproofai-llmkube-controller` mirror row and the `llmkube` chart-dependency row to 0.10.4. `helm-charts/README.md:57`: append `; re-verified 2026-10-19 against 0.10.4 — passthrough keys unchanged, new top-level keys only: grafana, modelAttestation, metalRelay, extraObjects, plus controllerManager.{watchCanary,reconcileTimeout,driRenderGID,caCertConfigMap}`. `deploy/README.md` LLMkube section: version line `→ 0.10.4 on 2026-10-19`, CRD list gains `modelpools` + `federatedclusters` (both unused by Devproof), and a `Re-checked against 0.10.4` line recording that the CPU placement gating **is fixed** (`deployment_builder.go` lines 618–641) while the HPA selector bug, the phase flap and the ISVC image/imagePullSecrets flap are unverified at this tag. `CHANGELOG.md`: a `### Changed` entry under the unreleased heading naming the version jump, the additive CRD/values delta, and the default-on watch canary.

- [ ] **Step 6: Commit**

```bash
git add helm-charts/Chart.yaml helm-charts/Chart.lock helm-charts/values.yaml \
        scripts/mirror-images.sh scripts/mirror-images.ps1 \
        THIRD-PARTY-NOTICES.md helm-charts/README.md deploy/README.md CHANGELOG.md
git commit -m "deps: bump bundled llmkube subchart 0.9.10 -> 0.10.4"
```

---

### Task 2: Verify LLMkube 0.10.4 live on the docker-desktop cluster

**Files:**
- Modify: `deploy/README.md` (verification outcome appended to the 0.10.4 note)
- Modify: `CHANGELOG.md` (only if a finding changes the entry)
- Modify: `helm-charts/values.yaml` (only if Step 4 forces the `watchCanary.failAfter` mitigation)

**Interfaces:**
- Consumes: the chart from Task 1.
- Produces: a verified 0.10.4 install; the live baseline Task 3 measures its PVC-survival claim against.

- [ ] **Step 1: Bring the cluster up and record the starting state**

`kubectl get nodes` currently refuses the connection — Docker Desktop Kubernetes is off. Start it, then:

```bash
kubectl config current-context          # must be docker-desktop; never switch it in a script
kubectl get nodes
kubectl get ns
kubectl -n <release-ns> get pods
kubectl -n <release-ns> get modeldeployments,inferenceservices,models
kubectl -n <release-ns> get pvc
kubectl -n <release-ns> get isvc -o yaml > /tmp/isvc-before.yaml
```

The release namespace is `devproof` per CLAUDE.md but drifted to `default` on the 2026-07-22 cluster (sessions in `devproof-agents`) — read it off `kubectl get ns` and use it consistently below.

- [ ] **Step 2: Upgrade the release**

```bash
helm upgrade devproof helm-charts -n <ns> -f helm-charts/values-dev.yaml \
  --skip-schema-validation --force-conflicts
kubectl -n <ns> rollout status deploy/<llmkube-controller-deploy> --timeout=180s
kubectl get crd | grep llmkube.dev
diff <(grep -v -E "resourceVersion|generation" /tmp/isvc-before.yaml) \
     <(kubectl -n <ns> get isvc -o yaml | grep -v -E "resourceVersion|generation")
```

Expected: controller Ready on image `…devproofai-llmkube-controller:0.10.4`; CRDs include `modelpools.inference.llmkube.dev` and `federatedclusters.federation.llmkube.dev`; the ISVC diff is empty (pre-existing objects survive the CRD update untouched).

- [ ] **Step 3: Verify serving still works**

```bash
kubectl -n <ns> get pods -l inference.llmkube.dev/service   # engine pods Running
node scripts/smoke-serving.mjs            # or: node scripts/smoke-gateway.mjs <routing-name>
kubectl -n <ns> get pvc | grep model-cache    # perService naming: <isvc>-model-cache
```

Expected: a completion comes back; cache PVCs keep their `<isvc>-model-cache` names and `Bound` status (no re-provision from the subchart upgrade alone).

- [ ] **Step 4: Watch the canary for ≥20 minutes (Review Focus 4)**

```bash
kubectl -n <ns> get lease | grep -i canary
kubectl -n <ns> get lease <canary-lease> -o jsonpath='{.spec.renewTime}{"\n"}'   # repeat: advances ~60s
kubectl -n <ns> get pod <controller-pod> -o jsonpath='{.status.containerStatuses[0].restartCount}{"\n"}'
kubectl -n <ns> describe pod <controller-pod> | grep -A3 "Liveness\|Last State"
```

Expected: restartCount stays at its pre-upgrade value and the Lease's `renewTime` advances every ~60s. A restart with `Liveness probe failed` is the dev-cluster flakiness this plan anticipated: record it in `deploy/README.md` and set `llmkube.controllerManager.watchCanary.failAfter: 15m` in `helm-charts/values.yaml` as the documented mitigation (keep the canary on).

- [ ] **Step 5: Verify a placement move still bounces the cache**

Change the pool's node selector (console Pools page or `kubectl edit modelpool`) to a different worker, then:

```bash
kubectl -n <ns> get md <name> -o jsonpath='{.metadata.annotations}{"\n"}'   # cache-bounce: "1" during phase 1
kubectl -n <ns> get pvc <isvc>-model-cache -w        # deleted, then re-created and Bound on the new node
kubectl -n <ns> get pods -o wide -l inference.llmkube.dev/service   # engine pod on the new node
```

Expected: the two-phase bounce runs to completion (annotation set → drain to 0 → PVC deleted → replicas restored → pod Ready on the target node), proving the 0.10.4 controller still honours our drain/restore sequence. Revert the selector afterwards and let it settle.

- [ ] **Step 6: Record the outcome and commit**

Append the measured results (restart count, PVC behaviour, placement move) to the `Re-checked against 0.10.4` line in `deploy/README.md`.

```bash
git add deploy/README.md CHANGELOG.md helm-charts/values.yaml
git commit -m "docs(deploy): record llmkube 0.10.4 live verification"
```

---

### Task 3: Drop the operator's nodeAffinity mirror (fixed upstream in 0.10.4)

**Files:**
- Modify: `operator/internal/transform/transform.go:162-189` (delete the affinity block), `:269` (drop `"affinity"` from `PlacementChanged`'s field list), `:6` (drop the now-unused `"sort"` import — `sort.Strings` at line 173 is its only use)
- Modify: `operator/internal/transform/transform_test.go:158-194` (affinity tests), `:245-285` (`TestPlacementChanged`), `:287-298` (`TestPlacementChangedStableAcrossRebuilds` comment)
- Modify: `CLAUDE.md` (Pools bullet), `deploy/README.md` (workaround note), `CHANGELOG.md`
- Test: `operator/internal/transform/transform_test.go`

**Interfaces:**
- Consumes: the upstream fix from 0.9.17 (#1504), still present in 0.10.4's `deployment_builder.go`, which applies ISVC `nodeSelector`/`tolerations` to CPU pods (verified live in Task 2 Step 5).
- Produces: `transform.Build` renders no `spec.affinity`; `transform.PlacementChanged` compares `nodeSelector` and `tolerations` only. No signature changes — both keep their current parameters and return types.

- [ ] **Step 1: Rewrite the failing tests**

Delete `TestBuildAffinityFromNodeSelector`. Replace `TestBuildOmitsAffinityWhenNoSelector` with a test that pins the new contract for both cases:

```go
func TestBuildNeverRendersAffinity(t *testing.T) {
	md, pool := fixtures()
	pool.Spec.NodeSelector = map[string]string{"zone": "a"}
	_, isvc := Build(md, pool, 1, EngineImages{})
	if _, found, _ := unstructured.NestedMap(isvc.Object, "spec", "affinity"); found {
		t.Fatal("affinity must not be rendered: LLMkube 0.10.4 applies ISVC nodeSelector to CPU pods")
	}
	sel, found, _ := unstructured.NestedStringMap(isvc.Object, "spec", "nodeSelector")
	if !found || sel["zone"] != "a" {
		t.Fatalf("nodeSelector must still carry the pool selector, found=%v got %v", found, sel)
	}
}
```

In `TestPlacementChanged`, replace the "adding affinity must be reported" case with its inverse — the upgrade case where the live object still carries the affinity we no longer render:

```go
	aff := base()
	aff["affinity"] = map[string]interface{}{"nodeAffinity": map[string]interface{}{}}
	if PlacementChanged(isvcWithSpec(aff), isvcWithSpec(base())) {
		t.Fatal("a live-only affinity is not a placement move: SSA prunes it without a cache bounce")
	}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd operator && ~/sdk/go/bin/go test ./internal/transform/ -run 'TestBuildNeverRendersAffinity|TestPlacementChanged' -v`
Expected: FAIL — `affinity must not be rendered` and `a live-only affinity is not a placement move`.

- [ ] **Step 3: Remove the affinity rendering and comparison**

In `transform.go`, delete the whole `// LLMkube (verified through 0.9.7) renders ISVC nodeSelector/tolerations…` block (lines 162–189) and the `"sort"` import; change `PlacementChanged`'s loop to `for _, field := range []string{"nodeSelector", "tolerations"}` and update its doc comment to say that affinity is no longer rendered, so a live-only affinity is pruned by server-side apply without a bounce — the reconciler applies with `client.Apply` + `ForceOwnership` as field owner `devproof-operator`, so the field disappears from live ISVCs on the next reconcile.

- [ ] **Step 4: Run the full operator suite**

Run: `cd operator && ~/sdk/go/bin/go vet ./... && ~/sdk/go/bin/go test ./...`
Expected: PASS. `TestPlacementChangedStableAcrossRebuilds` keeps passing (its comment about sorted affinity keys should now read "sorted selector keys").

- [ ] **Step 5: Roll the operator into the cluster and verify no bounce (Review Focus 3)**

Build and import the operator image at the **current** release tag (never invent a new one), per the in-cluster rollout procedure — ctr-import to every node the pod may land on, then verify `status.containerStatuses[0].imageID` against the build digest:

```bash
VERSION=<current> REGISTRY=ghcr.io/devproof docker buildx bake operator
# ctr-import per node, then:
kubectl -n <ns> rollout restart deploy/<operator-deploy>
kubectl -n <ns> get isvc <name> -o jsonpath='{.spec.affinity}{"\n"}'          # empty
kubectl -n <ns> get pvc <isvc>-model-cache -o jsonpath='{.metadata.uid}{"\n"}' # unchanged uid
kubectl -n <ns> get md <name> -o jsonpath='{.metadata.annotations}{"\n"}'      # no cache-bounce annotation
kubectl -n <ns> get pods -o wide -l inference.llmkube.dev/service             # still on the selected node
```

Expected: the ISVC's `spec.affinity` is gone, the engine pods roll once (pod-template change) and land back on the pool's selected node via `spec.nodeSelector`, the cache PVC keeps its uid, and **no** cache-bounce annotation ever appears. A PVC delete here means `PlacementChanged` still sees the diff — stop and re-check Step 3.

- [ ] **Step 6: Update the docs and commit**

`CLAUDE.md` Pools bullet: replace "the pool nodeSelector is additionally rendered as ISVC nodeAffinity because LLMkube (verified through 0.9.7) applies ISVC nodeSelector/tolerations to GPU/DRA pods only" with the 0.10.4 reality — upstream applies them to CPU pods too (`deployment_builder.go`), so the mirror is gone and `PlacementChanged` compares nodeSelector/tolerations only. Mirror the same correction in `deploy/README.md`'s workaround note and add a CHANGELOG entry.

```bash
git add operator/internal/transform/transform.go operator/internal/transform/transform_test.go \
        CLAUDE.md deploy/README.md CHANGELOG.md
git commit -m "feat(operator): drop the ISVC nodeAffinity mirror (llmkube 0.10.4 applies nodeSelector to CPU pods)"
```

---

### Task 4: Repin the gateway base image to LiteLLM v1.106.0

**Files:**
- Modify: `gateway/Dockerfile:6` (the `FROM` line) and the comment above it
- Modify: `BUILD.md:66` (gateway row), `THIRD-PARTY-NOTICES.md:47` + the note below it
- Modify: `helm-charts/values.yaml` (`gateway.auth` comment, only if Step 3 shows an empty key now CrashLoops)
- Modify: `CHANGELOG.md`
- Test: `helm-charts/files/test_custom_callbacks.py` (run **inside** the new image, where the real litellm shadows its `sys.modules.setdefault` stubs), `control-plane/test/gateway-config.test.ts` (existing)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ghcr.io/devproof/devproofai-gateway:<current version>` built on `litellm:v1.106.0`; the `custom_callbacks.py` contract (`user_custom_auth`, `SchemaSanitizer` hooks) unchanged.

- [ ] **Step 1: Repin and build**

Replace the `FROM` line with the version-tagged, digest-pinned base (the tag documents what the digest is; the digest is what builds):

```dockerfile
FROM ghcr.io/berriai/litellm:v1.106.0@sha256:2e4c0371f3a8c28e4da131d77abaa8341cd3b0c2fcc4d34d7c5900431af7b9d0
```

Update the comment above it to name the version and note that `asyncpg==0.31.0` still has cp313 wheels for the new python-3.13 base. Then:

```bash
VERSION=<current> REGISTRY=ghcr.io/devproof docker buildx bake gateway
```

Expected: the build succeeds, including `python3 -m ensurepip && python3 -m pip install asyncpg==0.31.0`. A failure here is the whole point of the build-time install — the old runtime-install posture would have failed at pod boot instead.

- [ ] **Step 2: Verify the hook module imports against the real LiteLLM**

The offline suite stubs `litellm`, `litellm.integrations.custom_logger` and `litellm.proxy._types` with `sys.modules.setdefault`, so running it **inside the image** exercises the real imports instead:

```bash
docker run --rm -v "$PWD/helm-charts/files:/hooks:ro" -w /hooks \
  --entrypoint python ghcr.io/devproof/devproofai-gateway:<current> test_custom_callbacks.py
```

Expected: every line `PASS`, exit 0. An `ImportError` on `litellm.proxy._types.UserAPIKeyAuth` or `litellm.integrations.custom_logger.CustomLogger` is the upgrade blocker this step exists to catch (both symbols were verified present at the v1.106.0 tag, so a failure means a packaging move, not an API removal).

- [ ] **Step 3: Verify the master-key boot gate both ways (Review Focus 1)**

Write a minimal `config.yaml` to the scratchpad (one `model_list` entry pointing at any reachable target, `litellm_settings.callbacks` omitted so this checks the proxy alone), then:

```bash
# Use the shape the chart actually renders — 24 bare alphanumerics, no sk- prefix —
# so the check exercises what every install ships (1.104 also rejects weak keys).
docker run --rm -d --name gw-ok -e LITELLM_MASTER_KEY=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24) \
  -v "<scratchpad>/config.yaml:/app/config.yaml:ro" -p 14001:4000 \
  ghcr.io/devproof/devproofai-gateway:<current> --config /app/config.yaml --port 4000
curl -s localhost:14001/health/readiness | head -c 300; docker rm -f gw-ok
docker run --rm -v "<scratchpad>/config.yaml:/app/config.yaml:ro" \
  ghcr.io/devproof/devproofai-gateway:<current> --config /app/config.yaml --port 4000 2>&1 | tail -20
```

Expected: ready with a key; a startup refusal without one. Record the refusal text in `CHANGELOG.md` and, since the chart can render an empty key (no cluster `lookup` and no fixed `masterKey`, or an `existingSecret` lacking `master-key`), note in `helm-charts/values.yaml`'s `gateway.auth` comment that an empty key is now a CrashLoop rather than a warning.

- [ ] **Step 4: Assert no timeouts and no Rust opt-in (Review Focus 2)**

```bash
helm template devproof helm-charts -n devproof -f helm-charts/values-dev.yaml --skip-schema-validation \
  | grep -nE "stream_timeout|request_timeout|[^_]timeout:"            # expect: nothing
kubectl -n <ns> get cm litellm-config -o jsonpath='{.data.config\.yaml}' \
  | grep -nE "stream_timeout|request_timeout|[^_]timeout:"            # the LIVE config the CP wrote: nothing
helm template devproof helm-charts -n devproof -f helm-charts/values-dev.yaml --skip-schema-validation | grep -i LITELLM_RUST
docker run --rm --entrypoint env ghcr.io/devproof/devproofai-gateway:<current> | grep -i rust
```

Expected: no output from any of the four. A timeout key in `litellm_params` is now enforced on `/v1/messages` (v1.94.0) and would cut long local-model streams; `LITELLM_RUST` truthy would route Anthropic-provider `/v1/messages` through the axum gateway, bypassing `user_custom_auth`, the routing evaluator, the metering callback and the SSE usage injection.

- [ ] **Step 5: Roll it into the cluster and check the wire contracts (Review Focus 5)**

ctr-import to every candidate node, `kubectl -n <ns> rollout restart deploy/gateway`, confirm `imageID`, then:

```bash
curl -s localhost:14000/v1/models -H "Authorization: Bearer dpk_<key>" | head -c 400   # routing names listed
curl -s -o /dev/null -w '%{http_code}\n' localhost:14000/v1/models                      # 401 without a key
curl -s -o /dev/null -w '%{http_code}\n' localhost:14000/v1/messages -H "Authorization: Bearer dpk_<key>" \
  -H 'content-type: application/json' \
  -d '{"model":"<deployment-name>","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
# ^ 403: external dpk_ keys are routing-only
curl -N -s localhost:14000/v1/messages -H "Authorization: Bearer dpk_<key>" -H 'content-type: application/json' \
  -d '{"model":"<routing-name>","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"count to five"}]}' \
  | grep -m2 -E "message_start|message_delta"
```

Then in Postgres: `select model, routing, tokens_in, tokens_out from gateway_usage order by created_at desc limit 5;` — the routing name must be attributed on the `/v1/messages` surface (the dual-channel `metadata` + `litellm_metadata` path) and `tokens_in/out` must be non-zero. From the SSE frames, record whether `message_start.usage.input_tokens` is now populated upstream: if it is, `_inject_prompt_estimate` is overwriting a real count with an estimate, which becomes a follow-up issue (not a change in this task). Also exercise a thinking-capable deployment and confirm the console's Think rows are non-empty, and call a sleeping (Idle) deployment through a routing to confirm the wake-hold still returns the held response rather than a bare 503 — noting whether a `Retry-After` header now rides along.

- [ ] **Step 6: Run one managed session end to end**

Start a session from the console against a routing whose target is a local deployment, let it use a tool, and confirm: the transcript rows render (user → think → message → tool), the header token chip ticks mid-turn, `sessions.tokens_in/out` move, and the Usage page agrees with `gateway_usage`. This is the only check that covers the metering callback, the sanitizer and the session path together.

- [ ] **Step 7: Update the docs and commit**

`BUILD.md:66`: `LiteLLM v1.106.0 (version-tagged + digest-pinned)`. `THIRD-PARTY-NOTICES.md:47`: same version in the base-image cell. `CHANGELOG.md`: a `### Changed` entry naming the version jump, the v1.104 master-key gate, and that `LITELLM_RUST` stays unset by design.

```bash
git add gateway/Dockerfile BUILD.md THIRD-PARTY-NOTICES.md CHANGELOG.md helm-charts/values.yaml
git commit -m "deps: repin the gateway base to litellm v1.106.0"
```

---

### Task 5: Full-stack regression gate

**Files:**
- Modify: `CHANGELOG.md` (only if a regression forces a note)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: the evidence the project's "Verify before claiming done" rule asks for.

- [ ] **Step 1: Run every suite**

```bash
cd operator && ~/sdk/go/bin/go vet ./... && ~/sdk/go/bin/go test ./...
cd ../control-plane && npx tsc --noEmit && npm test
cd ../session-runner && python -m unittest discover -s tests -p "test_*.py"
cd .. && node --test helm-charts/tests/render.test.mjs && helm lint helm-charts --skip-schema-validation
python helm-charts/files/test_custom_callbacks.py
```

Expected: all green. `npm test` ends with the workspace sweep; the suite's exit status is what counts.

- [ ] **Step 2: Restart the console and walk the touched pages**

```bash
cd console && npx next build && npx next start -p 7090
```

Then confirm 200s and correct content on `/deployments`, a deployment detail (Resources line, context tokens, Trace), `/pools`, `/routings` + a routing detail (Rules, Connect, Trace), `/sessions` + the session from Task 4 Step 6, and `/usage`. A rebuild under a running `next start` pins old chunk hashes — restart the server, do not just rebuild.

- [ ] **Step 3: Report**

State plainly which suites passed, what the live checks showed (especially the three Review-Focus-5 wire observations and the controller restart count), and anything deferred to a follow-up. If a check failed, say so with the output rather than reporting the upgrade as done.
