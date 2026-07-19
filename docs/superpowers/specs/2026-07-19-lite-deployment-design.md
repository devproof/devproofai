# Lite deployment (external-only serving) — design

**Date:** 2026-07-19
**Status:** approved

## Problem

Some installations only want the managed-agents platform against external model
providers (OpenAI/Anthropic/OpenRouter/custom) — no local GPU/CPU serving at
all. Today the chart always assumes LLMkube + the operator are present: the CP
serves local-serving routes that 500 when the serving CRDs are absent, runs
local-serving background loops that error, and the console shows Catalog/Pools/
Cache pages that cannot work.

## Decision summary (user-approved)

1. **Depth:** full CP feature-off ("level B") — the CP boots and runs cleanly in
   a cluster with no LLMkube, no operator, and no serving CRDs. External
   endpoints, routings, gateway, sessions, agents, environments all keep
   working. Console hides the local-only UI.
2. **Flag mechanism:** an **env var**, not an `app_settings` runtime toggle.
   Whether local serving *can* work is an install-time property (is the llmkube
   subchart installed?), so the flag is rendered by the chart and always tells
   the truth about the installation. No guard logic for half-states.
3. **Chart wiring:** **`llmkube.enabled` is the single master switch.** No new
   top-level value.
4. **CP gating mechanism:** explicit flag checks at the seams (a small
   `serving-mode.ts` module + ~a dozen call sites), NOT a stubbed kubestore.
   Explicit and greppable; local-only routes return a clear error instead of
   misleading empty 200s.

## 1. Flag & chart wiring

`llmkube.enabled: false` = lite install. Derived changes, all in `helm-charts/`:

- `templates/controlplane/deployment.yaml`: add
  `DEVPROOF_LOCAL_SERVING: "{{ .Values.llmkube.enabled }}"` to the CP env list
  (renders `"true"`/`"false"`).
- `templates/operator/*.yaml` (deployment, rbac, serviceaccount): gate on
  `and .Values.operator.enabled .Values.llmkube.enabled` — the operator only
  reconciles ModelPool/ModelDeployment into LLMkube and is useless without it.
- `templates/operator/crds/modelpools.yaml` + `modeldeployments.yaml`: gate on
  `and .Values.crds.install .Values.llmkube.enabled` (verified: these two files
  are the only CRD templates and both are serving-only).
- Out-of-cluster dev: set `DEVPROOF_LOCAL_SERVING=false` on the CP process.
  **Absent = enabled** (default true, backward compatible).

## 2. Control plane

### Flag module

New `control-plane/src/serving-mode.ts`:

```ts
export const localServingEnabled = process.env.DEVPROOF_LOCAL_SERVING !== "false";
```

`buildServer` accepts `localServing?: boolean` in its options (defaulting from
the module) so tests can build a disabled server without env juggling.
`main.ts` reads the module directly for loop wiring.

### Local-only routes → 404 `{ error: "local serving disabled" }`

- `/v1/catalog` all verbs (GET `server.ts:137`, POST/PATCH/DELETE `:189,218,224`)
- `/v1/cache` (GET `:245`, DELETE `:472`)
- `/v1/pools` all verbs (`:296–361`)
- Local deployment writes: `POST /v1/deployments` (`:430`),
  `DELETE /v1/deployments/:name` (`:466`), `PATCH /v1/deployments/:name` (`:627`)

### Mixed surfaces lose their local leg (verified call-site inventory)

- `syncGateway` (`server.ts:85`): skip `store.list("modeldeployments")`, pass
  `[]` to `buildGatewayConfig` — externals + routings still render.
  `newlyRouted` over `[]` yields nothing, so the warmup machinery
  (`warmDeployment`, `routedModels`, `onModelRouted`) needs no separate switch.
  Boot gateway sync still runs (external endpoints need gateway config).
- `listDeployments` (`:375`): return external rows only (no kubestore call —
  also removes the would-be 500 when CRDs are absent).
- External-endpoint create name-collision check (`:525`): skip the
  `store.get("modeldeployments", ...)` leg.
- `routingTargetCtx` (`:695`): `localNames` = empty set → routing target
  validation accepts external names only; routing detail min-context (`:718`)
  comes from externals' mandatory `context_tokens` (works since fix wave L).
- `modelPhase` (`main.ts:57–104`): skip `kube.list` (`:72`) / `kube.get`
  (`:76,:88`) — routing branch computes min context from externals only; bare
  names resolve external-or-null. Launch gate needs NO changes:
  `gateDecision` (`launch-gate.ts:35`) already launches immediately for
  `external`/`routing` kinds — only `local` parks, and no local can exist.

### Loops / listeners not started (in `main.ts`)

- `notify.onWake` wake listener (`main.ts:158`) — not registered.
- `projectModelRouting` (`:109`) — becomes a no-op (skip in the reconciler
  sweep callback and the `onGatewaySynced` hook). `model_routing` stays empty,
  so the gateway pre-call hold never engages.
- Cost sampler: skip only its `modeldeployments` leg (`cost-sampler.ts:56`);
  session/env time billing keeps working.
- Pending-launch sweep: **no gating needed** — nothing can ever park (see
  `gateDecision` above), so it iterates an empty model list. Writer-queue
  sweeps and the zombie reconciler are unchanged.

### Kept untouched

Routings CRUD, external endpoint CRUD/test, sessions/agents/environments/
skills/memory/wikis/vaults, `/v1/storage-classes` + `/v1/node-scheduling`
(environment pod config, not model serving), gateway auth/metering, billing.

### Console discovery

`GET /v1/settings` (`agents-api.ts:1036`) gains a **read-only, computed** field:

```json
{ "serving": { "localEnabled": false } }
```

Not stored in `app_settings`; `PUT /v1/settings` ignores it.

## 3. Console

`layout.tsx` already fetches `GET /v1/settings` server-side (theme); it also
passes `serving.localEnabled` to `Nav`:

- **Nav** (`nav.tsx` `GROUPS`, Serving group): drop "Model catalog", "Pools",
  "Cache"; keep "Deployments", "Routings".
- **/deployments**: hide `DeployModelButton` + `SyncButton`, keep
  `AddEndpointButton` (rows are all external anyway). Precedent for
  settings-gated UI: `deploy-modal.tsx:103` (`billing.enabled`).
- Direct URL to `/catalog`, `/pools`, `/cache` when disabled: render a plain
  "Local serving is disabled on this installation" notice (server components
  read the same settings fetch).

## 4. Error handling

- Disabled routes: 404 with `{ error: "local serving disabled" }` — same shape
  as existing error responses.
- A routing created in lite mode can only reference external targets
  (validation, via empty `localNames`). Pre-existing routings that name local
  targets (flag flipped on an existing install) simply never match those
  targets — same behavior as a deleted deployment today.
- Sessions: agents reference routings; routings resolve to external targets;
  `gateDecision` launches immediately. No parking, no wake, no holds.

## 5. Testing & verification

- New backend test file: build a server with `localServing: false`; assert the
  gated routes 404 with the exact error, `GET /v1/deployments` returns
  external-only without touching the kubestore, routing create validates
  against external names only, `GET /v1/settings` exposes
  `serving.localEnabled`. Existing suite runs flag-default-on (zero behavior
  change).
- `cd control-plane && npm test` + `npx tsc --noEmit` green.
- Manual: run CP with `DEVPROOF_LOCAL_SERVING=false`; console pages all 200,
  nav filtered, hidden pages show the notice; create external endpoint +
  routing + agent + session against it end-to-end.
- Chart: `helm template` with `llmkube.enabled=false` renders no operator
  workloads, no serving CRDs, and the CP env var `"false"`; default render
  unchanged.

## Out of scope

- Flipping the flag off on an install that already has local deployments: lite
  is an install-time decision for fresh/external-only installs. Existing CRs
  are simply never touched (the CP stops reading/writing them); no migration,
  no cleanup. Note: `model_routing` rows (DB state, not CRs) also persist on a flip; a
  request naming a previously-sleeping local model waits out the gateway
  hold (300s → 503) instead of failing fast — acceptable for the same
  reason, but prune `model_routing` manually if that matters.
- Runtime toggling via the console Settings page (deliberately rejected —
  decision 2 above).
- Any change to the gateway image/hook (`custom_callbacks.py`) — with
  `model_routing` empty and no local models in the config, its local-serving
  paths are naturally inert.
