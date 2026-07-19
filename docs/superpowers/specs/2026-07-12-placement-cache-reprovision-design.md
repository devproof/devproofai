# Placement change ⇒ model-cache re-provision — design

**Date:** 2026-07-12
**Status:** approved
**Builds on:** `2026-07-12-pool-redeploy-design.md` (pool watch + affinity translation, shipped)

## Problem

Moving a model's placement (pool selector/taints, or a deployment's pool)
strands the new pod Pending with
`didn't match PersistentVolume's node affinity`: the model-weights cache PVC
is bound to the old node. Observed live immediately after the pool-redeploy
feature shipped.

Two root causes, verified in LLMkube 0.9.4 source and on the cluster:

1. **Cache mode.** The install runs `--model-cache-mode=shared`: ONE
   cluster-wide RWO PVC (`llmkube-model-cache`) mounted by every model pod.
   On node-local storage (docker-desktop local-path) this pins ALL models to
   a single node — pools cannot place models on different nodes at all.
   LLMkube's documented fix for multi-node clusters without RWX storage is
   `perService` mode: each InferenceService gets its own
   `<name>-model-cache` PVC — RWO, WaitForFirstConsumer (binds where the pod
   schedules), owner-ref'd to the ISVC (GC'd with it).
2. **Node-bound cache on placement moves.** Even in perService mode, a later
   placement change leaves the cache PVC bound to the old node. The old pod
   holds the RWO claim (pvc-protection finalizer), the replacement can never
   become Ready on the new node — a deadlock unless the PVC is deleted and
   the pods bounced. `ensureModelCachePVC` recreates a missing cache PVC on
   every ISVC reconcile (verified), so deletion is self-healing.

## Decisions (user-approved)

- **A — infra:** switch LLMkube to `modelCache.mode: perService` via the
  pinned Helm values file.
- **B — operator:** on a placement change, the MD reconciler deletes the
  deployment's per-service cache PVC and its engine pods so the cache
  re-provisions on the new placement. Accepted semantics: a placement change
  means a brief serving gap plus a full weight re-download for that model.

## Design

### A. Infra (`deploy/llmkube/values.yaml`)

```yaml
modelCache:
  mode: perService
```

Applied with the file's own documented command:
`helm upgrade llmkube llmkube/llmkube -n llmkube-system --version 0.9.4 -f deploy/llmkube/values.yaml`.

Migration: on the next reconcile each ISVC gets `<name>-model-cache`; the
volume name in the pod template changes → pods roll → weights re-download
once per model. Afterwards delete the now-unused shared PVC
`llmkube-model-cache` (devproof-serving) and any Released local-path PVs
still claiming it (one stale PV on desktop-worker2 exists today).

### B. Operator (`operator/internal/controller/modeldeployment_controller.go`)

In `Reconcile`, fetch the live ISVC **before** the SSA apply and compare
placement:

- New pure helper (transform package):
  `PlacementChanged(live, desired *unstructured.Unstructured) bool` —
  semantic-deep-equal of the three spec fields `nodeSelector`, `affinity`,
  `tolerations` (missing ≡ nil). A NotFound live ISVC ⇒ `false` (first
  create: nothing to bounce).
- After a **successful** apply, when placement changed:
  1. Delete PVC `<md.Name>-model-cache` in the MD namespace, ignore NotFound.
     By construction this can never touch the shared cache (different name),
     so the delete is safe even if someone reverts to shared mode.
  2. `DeleteAllOf` pods in the namespace with label
     `inference.llmkube.dev/service: <md.Name>`.
  3. Log one line (`placement changed — re-provisioning model cache`).
- Convergence: the RS recreates pods; pods referencing the Terminating/absent
  PVC stay Pending; LLMkube's reconcile (triggered by its owned Deployment
  events) recreates the PVC and applies the new template; the scheduler
  places the pod on the new placement; WaitForFirstConsumer binds the fresh
  PVC there; the init container re-downloads; Ready.
- Add kubebuilder RBAC markers for `persistentvolumeclaims` (delete) and
  `pods` (list, delete). Dev runs out-of-cluster with admin kubeconfig; the
  markers keep generated RBAC honest for in-cluster installs.
- Scaler replica updates change only `replicas` ⇒ no placement diff ⇒ no
  bounce. The affinity rendering is key-sorted (previous feature), so
  repeated reconciles produce identical placement ⇒ no false positives.

### Console copy (both files shipped by the previous feature)

- Pool dialog message becomes (exact):
  `Placement changed — this restarts the engine pods of N deployment(s): <names>. Their model caches re-provision on the target nodes (weights re-download; brief serving gap).`
- Deployment dialog: when the pool changed (`poolRef !== ctx.poolRef`),
  append (exact): ` Moving pools re-provisions the model cache on the new nodes (weights re-download).`
  Otherwise the message stays `This restarts <name>'s engine pods.`

### CLAUDE.md

Extend the Pools bullet: cache mode is perService (values file), and a
placement change deletes the deployment's `<name>-model-cache` PVC + engine
pods so the cache re-provisions on the target nodes (weights re-download,
brief serving gap).

## Edge cases

- **Shared mode active when a placement change fires:** PVC
  `<name>-model-cache` doesn't exist ⇒ NotFound no-op; pods still bounce
  (today they'd deadlock Pending anyway). Safe by construction.
- **First reconcile (no live ISVC):** no diff, no bounce.
- **PVC held by old pod:** deletion parks it Terminating; the pod bounce
  releases the finalizer. Ordering (PVC then pods) makes the gap one pass.
- **`spec.modelCache.claimName` user-owned claims:** devproof never sets the
  field; the operator only ever deletes the `<name>-model-cache` name.
- **Replicas/context/engine-only edits:** placement unchanged ⇒ no bounce
  (context/engine changes roll pods in place on the same node — cache stays).

## Testing

- **Go:** `PlacementChanged` unit tests (nil vs set, key-order equality via
  the sorted rendering, tolerations diff, replicas-only ⇒ false).
  Reconciler test with fake client: placement change ⇒ PVC + labeled pods
  deleted, others untouched; NotFound PVC tolerated; no-change ⇒ no deletes.
- **Live (definition of done):** helm upgrade applied; both models Ready on
  per-service PVCs; shared PVC + stale PVs removed; pool selector flipped
  worker3→worker2 → dialog (new copy) → pods bounce, cache re-provisions on
  worker2, model re-downloads, deployment returns Ready on worker2, gateway
  serves a completion; flip back → same in reverse; replicas-only edit ⇒ no
  bounce, cache PVC untouched (same UID before/after).

## Amendment (2026-07-12, post live verification): scale-to-zero bounce

Live verification hit a reproducible deadlock on every placement move. The
original design (delete PVC + delete pods) re-arms a race instead of fixing
it: the OLD ReplicaSet (old affinity) recreates its pod first, that pod
schedules on the old node and claims the freshly recreated
WaitForFirstConsumer PVC — re-binding it to the old node — and the new-affinity
pod can then never schedule while RollingUpdate keeps the old pod alive
(maxUnavailable=0). Manual `kubectl scale`/`delete pvc` was needed three of
three times.

**Fix — the bounce becomes a stateless two-phase drain**, replacing the
pod-deletion step (the PVC-deletion step and its shared-cache safety guarantee
are unchanged):

- **Phase 1** (placement moved): the reconciler applies the ISVC with the NEW
  placement and `replicas: 0`, then requeues (~3s). LLMkube scales the engine
  Deployment to zero; every ReplicaSet drains; nothing can claim the PVC.
- **Phase 2** (live placement == desired AND live replicas == 0 AND the
  deployment wants > 0 — a state only phase 1 can produce, since
  `ClampReplicas` floors desired replicas at 1): requeue until the labeled
  engine pods are fully gone (Terminating pods still hold the pvc-protection
  finalizer), then delete the cache PVC (unclaimed ⇒ deletes instantly) and
  apply the ISVC with the real replica count. LLMkube recreates the PVC; the
  new pods schedule on the new placement and bind it there.

No annotations or in-memory state: the phase is inferred from the live ISVC,
so an operator restart mid-bounce resumes correctly. A second placement change
mid-bounce re-enters phase 1 with the newest placement and converges. The
serving gap already accepted for placement moves covers the drain window; the
gateway route deregisters at readyReplicas 0 and re-registers on Ready via the
existing phase machinery. Definition of done: a placement move converges
hands-off — zero kubectl intervention.

## Out of scope

- Tolerations on CPU pods (LLMkube renders them GPU-only — unchanged).
- Cache migration/copy between nodes (re-download is the accepted cost).
- RWX storage classes.
