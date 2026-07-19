# Pool/deployment redeploy propagation + pools list cleanup — design

**Date:** 2026-07-12
**Status:** approved

## Problem

1. Editing a pool's node selector or tolerations does nothing: the operator's
   ModelDeployment reconciler reads the pool only when the MD itself is
   touched — it does not watch ModelPools. The pool modal's hint even admits
   it ("Changes apply when a deployment's pods next roll").
2. Even when the pool values reach the InferenceService, LLMkube 0.9.4 renders
   ISVC `nodeSelector`/`tolerations` into the engine Deployment **only for
   GPU/DRA workloads** (`deployment_builder.go` gates them behind
   `if gpuCount > 0`). CPU engine pods silently ignore placement. Verified
   live: the qwen ISVCs carry `nodeSelector: desktop-worker2` while the pods
   run on `desktop-worker3`. `affinity` and `topologySpreadConstraints` ARE
   applied unconditionally.
3. The pools list renders every selector and toleration as chips — noisy at
   any real number of entries.

Deployment-config edits (`contextTokens`, `engine`, `poolRef`) already
redeploy today: the MD watch fires, the ISVC updates, and LLMkube diffs the
full pod template and rolls the Deployment (verified live — a template change
replaced the pod within seconds). What deployments lack is only a restart
warning in the console.

## Decisions (user-confirmed)

- **UX on save:** automatic propagation with a confirm dialog listing the
  affected deployments. No manual "redeploy" action, no silent restarts.
- **LLMkube CPU gap:** translate the pool's nodeSelector into ISVC
  `affinity.nodeAffinity` (applied unconditionally by LLMkube). Tolerations
  remain GPU-only until LLMkube fixes it upstream — surfaced as a UI hint and
  a CLAUDE.md note, not worked around.
- **Pools list:** keep two columns (Node selector, Tolerations), each showing
  a count ("2 selectors" / "1 toleration") or muted "none".
- **Trigger mechanism:** Approach A — a k8s-native operator watch on
  ModelPool, mapping pool events to the deployments that reference it. Works
  for every writer (console, kubectl, GitOps); no CP orchestration.

## Design

### Operator (`operator/`)

**Pool watch.** `ModelDeploymentReconciler.SetupWithManager` gains:

```go
Watches(&v1alpha1.ModelPool{}, handler.EnqueueRequestsFromMapFunc(r.deploymentsForPool))
```

`deploymentsForPool` lists ModelDeployments in the pool's namespace and
enqueues those with `spec.poolRef == pool.Name`. Pool create/update/delete all
flow through it; delete already degrades gracefully (reconciler sets
`Failed: ModelPool not found`; the CP blocks deleting in-use pools anyway).

**Affinity translation.** `transform.Build` keeps setting
`nodeSelector`/`tolerations` on the ISVC (native path, works on GPU/DRA pods)
and additionally renders the pool's nodeSelector as:

```
spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution
  .nodeSelectorTerms[0].matchExpressions =
    [{key: k, operator: In, values: [v]} for each selector entry]
```

One term, all expressions AND'd — identical semantics to nodeSelector. An
empty selector omits `affinity` entirely; SSA (client.Apply + ForceOwnership)
prunes the field from the ISVC, LLMkube diffs the template, pods roll back to
unconstrained. GPU pods carry both the native selector and the equivalent
affinity — redundant, never contradictory.

No CRD/API changes (no controller-gen regen needed).

### Control plane (`control-plane/`)

One read-path addition: `listDeployments` (server.ts) includes
`contextTokens: d.spec?.model?.contextTokens ?? null` on local rows, so the
console edit modal can distinguish "changed" from "merely filled in". No
behavioral change.

### Console (`console/`)

**Pools list (`app/pools/page.tsx`).** Selector/toleration cells become
counts: `N selector(s)` / `N toleration(s)` (singular/plural), muted `none`
when empty. Details remain in the edit modal (click the name, as today).

**Pool save confirm (`app/pools/pool-modal.tsx`).** On edit save, if the
normalized submitted `nodeSelector` or `tolerations` differ from the pool's
current spec (entry-wise compare, key order irrelevant) and the pool has ≥ 1
deployment, show the shared `ConfirmDialog` (verb "Restart") before the PATCH:

> Placement changed — this restarts the engine pods of N deployment(s):
> _names_. Pods may stay Pending on new nodes until model weights are
> available there.

Affected names come from the deployments list the pools page already fetches
(passed `EditPoolName` → `PoolModal`); no new endpoint. The dialog renders
**instead of** the pool form (not stacked over it); cancel returns to the form
with the draft intact. Create-pool never confirms; edits touching only
`gpuType`/`gpusPerNode`/`maxNodes` don't either.

**Deployment edit confirm (`app/deployments/deploy-modal.tsx`,
`edit-local` only).** Same pattern when a restart-relevant field changed —
`contextTokens` (diffed against the new `ctx.contextTokens`), `engine`, or
`poolRef`:

> This restarts _name_'s engine pods.

Replica-only changes don't warn (scale, not restart); remote/external edits
never warn (no pods). `EditButton`'s local variant passes `contextTokens`
through; side benefit: the context-window placeholder becomes accurate in
edit mode.

**Copy fixes.** Node-selector hint: drop "Changes apply when a deployment's
pods next roll", say saving rolls the pool's engine pods onto matching nodes.
Tolerations hint gains: "currently applied to GPU pools only".

## Edge cases

- **Pods can't reschedule** (node-local model-weights PV, e.g. local-path on
  docker-desktop): RollingUpdate keeps the old pod serving while the new one
  is Pending; phase shows Deploying; the existing "readyReplicas>0 + endpoint
  ⇒ Ready" guard keeps the gateway route. Reverting the selector unwinds it
  (verified live). Covered in the dialog copy.
- **Selector emptied:** verified live — affinity pruned, rollout reverts.
- **Multiple deployments per pool:** map function enqueues each; independent
  reconciles; rapid edits coalesce in the controller queue.
- **Unchanged `contextTokens`:** not sent in the PATCH (existing behavior),
  never warns.

## Testing

- **Operator:** transform unit tests (multi-key selector → one term with
  AND'd matchExpressions; empty selector omits affinity; tolerations
  passthrough unchanged) + map-function test (enqueues exactly the MDs with
  matching poolRef). `go test ./...`.
- **Control plane:** deployments-list test asserts `contextTokens`.
  `npm test` + `npx tsc --noEmit`.
- **Console:** `npx next build` clean.
- **Live (definition of done):** pool selector edit → dialog lists both qwen
  deployments → pods roll; revert → pods return; deployment `contextTokens`
  edit → single-name dialog → pod rolls with new `--ctx-size`; no-placement
  save → no dialog, no rollout; pools list shows counts.

## Out of scope

- Tolerations on CPU pools (upstream LLMkube limitation; UI hint documents it).
- Migrating node-local model caches when placement moves (pods stay Pending
  until weights exist on the target node — surfaced, not solved).
- Any change to `gpuType`/`gpusPerNode`/`maxNodes` semantics (they never
  reach pods).
