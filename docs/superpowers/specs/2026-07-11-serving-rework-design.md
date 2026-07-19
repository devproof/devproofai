# Serving rework — design (2026-07-11)

Twelve serving changes in one combined spec: console polish, global external
endpoints, enforced pool capacity, pool tolerations, reserve replicas, a
queue-depth autoscaler built into the Devproof operator, and gateway HPA.

Decisions fixed during brainstorming:

- **One combined spec** (user choice) covering all items.
- **Autoscaling = operator-built scaler**, not LLMkube's custom-metric HPA:
  LLMkube 0.9.1's custom-metric path is broken (dotted selector labels), the
  cluster has no Prometheus/prometheus-adapter, and an own scaler makes
  "reserve" trivial.
- **Reserve validation = lenient**: `0 ≤ min ≤ max`, `max ≥ 1`,
  `0 ≤ reserve ≤ max − min`. `min == max` stays legal (fixed size, reserve 0).
- **No per-deployment k8s Services.** All models — local and external — are
  accessed uniformly through the gateway (auth + metering + trace). Instead:
  the gateway gets an HPA, and the deployments page documents the access path.
- **Pool capacity enforced everywhere** (deploy, deployment edit, pool edit —
  UI and API).
- **Model dialog = grouped sections** (Identity / Artifact / Capability /
  Capacity profiles).

Verified live during design (docker-desktop, LLMkube 0.9.1):

- InferenceService CRD has `tolerations`, `endpoint.type`, and an
  `autoscaling` block (unused by us after this spec); no Service-annotations
  passthrough exists.
- No Prometheus in the cluster — the current Queue/Tok-s columns are dead
  (`metrics.ts` points at 127.0.0.1:19090 which nothing serves).
- Engine pods are discoverable via label `app=<deployment name>` and via the
  Service endpoints; `GET http://<podIP>:8080/metrics` returns
  `llamacpp:requests_processing` and `llamacpp:requests_deferred`.

## 1. Console polish

### 1.1 Model add/edit dialog (`console/app/catalog/model-modal.tsx`)

Reorganize into labeled groups, one concept per row:

```
── Identity ──────────────────
Display name  [            ]           (required)
Family        [      ]  Params [    ]
License       [            ]
── Artifact ──────────────────
Source        [                      ] (required)
Format        [GGUF (llama.cpp) ▾]  Quant [Q4_K_M]   (quant only for gguf)
Context       [        ] tokens
── Capability ────────────────
Tool calling  [basic ▾]
Requirements  GPUs [ ] VRAM [ ] disk [ ] GB
── Capacity profiles ─────────
GPU type | Instance | GPUs | VRAM | tok/s        (NO $/hr column)
[+ Add profile]
```

Section headers need a small shared style (e.g. `.modal-section`) in the
console CSS next to the other modal styles. Field semantics, hints, and the
add/edit/reset-override behavior are unchanged.

### 1.2 Deploy dialog context placeholder (`console/app/deployments/deploy-modal.tsx`)

`DeployLocalButton` receives the catalog entry's `contextTokens`. In
deploy-local mode the Context field placeholder becomes:

- `"32768 (catalog default)"` — the entry's value (as-is, no cap math in the UI)
- `"engine default"` — when the entry has no contextTokens

Edit mode keeps placeholder `"unchanged"`.

### 1.3 Deployments list (`console/app/deployments/page.tsx`)

- **Remove the Endpoint column.**
- Rename **Ready → "Replicas"**: locals show `readyReplicas` (0 renders as
  `0`); externals show `—`.
- Rename **Queue → "Req Queue"**: locals show the deployment's queue depth
  incl. `0`; `—` only when unknown (status `queueDepth = -1` or missing).
  Source is the operator-published `status.queueDepth` (§4), NOT Prometheus.
  Externals show `—`.
- **Tok/s** unchanged (Prometheus-backed; `—` without it).
- **"Deploy model" button** in the page header, right of "Add remote
  endpoint". Opens the shared `DeployModal` in a new variant of deploy-local
  that adds a **Model dropdown** as the first field: options fetched from
  `/v1/catalog` (all pages if count > 100), labeled `displayName (id)`.
  Picking a model sets `catalogId`, the default name slug, and the context
  placeholder (§1.2). The catalog page's per-row Deploy button keeps the
  fixed-model variant (no dropdown).
- **Access blurb** under the page subtitle — short text plus a copyable
  one-liner, e.g.:

  > Every deployment is served through the gateway:
  > `curl <GATEWAY_URL>/v1/chat/completions -H "Authorization: Bearer dpk_…" -d '{"model": "<deployment name>", …}'`
  > — create keys on the API Keys page.

  `GATEWAY_URL` comes from `DEVPROOF_GATEWAY_PUBLIC_URL` (server-side env,
  default `http://localhost:14000`).
- External deployments' target URL is NOT in the table anymore; their detail
  page labels it **"Target endpoint"** (the URL the gateway forwards to),
  clearly distinct from the gateway access path.

### 1.4 Catalog page (`console/app/catalog/page.tsx`)

- Remove columns **"Cheapest hardware"** and **"Est. $/hr"**. Keep "GPU RAM"
  and "~tok/s" — with cost gone, "cheapest profile" is meaningless, so both
  now come from the FIRST capacity profile; the footer notes that.
- Subtitle: use the real `count` (not the page-scoped `models.length`) and
  drop the "cheapest hardware option" sentence.
- Footer text: drop the Est. $/hr explanation.

### 1.5 Remove `costPerHourUSD` everywhere (item 11)

- `model-modal.tsx`: profile grid column, `ProfileDraft`, `EMPTY_PROFILE`,
  `toDraft`, `toBody`.
- Control plane: catalog schema/validation and types (`catalog.ts`, zod/type
  defs) drop `costPerHourUSD`.
- `catalog/models.yaml`: strip the key from all bundled entries.
- API remains tolerant of unknown keys from old clients (ignore, don't 400).

## 2. External deployments become global (item 4)

- Migration `control-plane/sql/022_external_global.sql`:
  `ALTER TABLE external_deployments DROP COLUMN IF EXISTS workspace_id;`
- `repo.ts`: `listExternalDeployments(ws)` and the ws-filtered delete are
  replaced by global versions; `createExternalDeployment` loses the ws arg;
  `listAllExternalDeployments` becomes the single list function.
- `server.ts`/`main.ts`: routes stop passing the workspace; the gateway sync
  (already global) is unchanged in behavior.
- CLAUDE.md: update the "Serving global vs workspace" note — everything under
  Serving is now global.

## 3. Pools: capacity budget + tolerations (items 6, 7)

### 3.1 Remove `scalingMode`

Drop from `ModelPoolSpec` (`operator/api/v1alpha1/types.go`), regen CRDs,
remove from pool modal + pools page + CP pool routes. Existing CRs simply
lose the field.

### 3.2 `maxNodes` becomes an enforced replica budget

Rule: **Σ(replicas.max) over all deployments with `poolRef = pool` ≤
`pool.maxNodes`.** Semantic note (shown as UI hint): this treats one replica
≈ one node; on CPU pools where several replicas fit a node the budget is
conservative. UI label: **"Max nodes"**, hint "replica budget — the summed
max replicas of this pool's deployments cannot exceed it".

Enforcement (all server-side in the CP, mirrored inline in the UI):

- `POST /v1/deployments` → 400 when `committed + requested.max > maxNodes`.
  Error format: `pool <name>: committed max replicas <c> + requested <r>
  exceeds budget <b>`.
- `PATCH /v1/deployments/:name` (replicas raise or pool move) → same check
  against the target pool (excluding the deployment's own current max when
  staying on the same pool).
- `PATCH /v1/pools/:name` lowering `maxNodes` below the committed sum → 400
  `pool <name>: committed max replicas <c> exceeds new budget <b>`.
- Pools with `maxNodes` 0/unset = unlimited (no budget). Existing pools keep
  working without migration.
- `GET /v1/pools` adds `committedMaxReplicas` per pool (CP computes from the
  ModelDeployment CRs it already lists).
- Deploy/edit modal: computes remaining budget from the pools response,
  shows the error inline, disables Deploy/Save while exceeded.
- Pools list: new **"Committed"** column, `<committed> / <budget>` (`—` when
  unlimited).

### 3.3 Tolerations

- `ModelPoolSpec` gains `tolerations []corev1.Toleration` (regen CRDs).
- `transform.Build` copies them onto the ISVC's `tolerations` field
  (verified present in the LLMkube CRD), like `nodeSelector` today.
- Pool modal: toleration rows under the node-selector rows — fields key,
  operator (`Exists`/`Equal`), value (hidden for Exists), effect
  (`NoSchedule`/`NoExecute`/`PreferNoSchedule`/empty = all).
- CP pool routes accept/return `tolerations` in the same shape.
- Hint text: "tolerations let this pool's pods run on tainted nodes — taint
  the nodes themselves with kubectl".

## 4. Reserve replicas + queue-depth autoscaler (items 8, 12)

### 4.1 CRD changes (`types.go`, regen)

- `ReplicaBounds` gains `Reserve int32` (optional, default 0).
- `ModelDeploymentStatus` gains `QueueDepth int32` — current
  processing+deferred across replicas; `-1` = unknown (mirrors
  `downloadPercent`'s sentinel convention).

### 4.2 Validation (CP + UI)

`0 ≤ min ≤ max`, `max ≥ 1`, `0 ≤ reserve ≤ max − min`. Violations → 400
(API) and inline error + disabled submit (modal). New **"Reserve"** field in
the deploy/edit modal next to min/max, hint: "warm replicas kept idle above
current demand so bursts don't wait for scale-up — 0 = scale on demand only".

### 4.3 Scaler loop (new controller in the Go operator)

Replaces the CPU HPA entirely — `transform.Build` stops emitting the
`autoscaling` block (LLMkube then manages plain `spec.replicas`).

Every **15s**, for each ModelDeployment:

1. Discover engine pods via label `app=<deployment name>` in the serving
   namespace (fallback: Service endpoints); scrape
   `http://<podIP>:8080/metrics` with a ~2s timeout.
2. `inflight = Σ(llamacpp:requests_processing + llamacpp:requests_deferred)`
   over reachable pods. Publish `status.queueDepth = inflight` (scrape ALL
   deployments, including fixed-size min==max, so the console column is
   always live). No pod reachable → `queueDepth = -1`, skip scaling this
   tick.
3. Elastic deployments only (`max > min`):
   `demand = inflight` (slots-per-replica is 1 — we don't set
   `parallelSlots`; if that changes, divide by it), then
   **`desired = clamp(demand + reserve, max(min,1), max)`**.
4. **Scale up immediately**: write `desired` to the ISVC `spec.replicas`.
   **Scale down with hysteresis**: only when desired < current for a full
   3-minute window (12 consecutive ticks), then set to the maximum desired
   seen within that window. State is in-memory; an operator restart just
   restarts the window (safe: it only delays scale-DOWN).

> **Superseded during implementation (commit 23ac269):** the direct-ISVC-patch
> design below raced the reconciler's SSA apply (live: 10/10 scale-ups reverted
> within a tick). The shipped mechanism is single-writer: the scaler records its
> target as the `serving.devproof.ai/target-replicas` annotation on the
> ModelDeployment, and the MD-reconciler — the SOLE writer of ISVC
> `spec.replicas` — applies it (clamped; missing/invalid = min). Everything else
> in this section (tick, scrape, demand/reserve/hysteresis, queueDepth) shipped
> as written.

**Ownership rule (critical):** once the scaler exists, the MD-reconciler must
treat ISVC `spec.replicas` as scaler-owned for elastic deployments — when
rebuilding the desired ISVC it preserves the live `spec.replicas` value
(clamped to the current min/max) instead of resetting it to min. For
fixed-size deployments (min == max) the reconciler keeps writing min.

The decision logic (demand → desired, hysteresis window) is a pure function
with table tests; only the scrape and the ISVC write touch I/O.

Out of scope (unchanged): scale-to-zero (min still floored at 1 via
`minElastic`), Prometheus installation, Tok/s metric source.

## 5. Gateway HPA (reworked item 9)

`deploy/gateway/litellm.yaml`:

- Add CPU/memory **requests** to the gateway container if missing (HPA
  precondition).
- Add an HPA: `minReplicas: 2, maxReplicas: 10`, CPU target 75%.

min 2 also removes the gateway as a single point of failure. LiteLLM pods
are stateless (ConfigMap + Secret + Postgres); `syncGateway`'s rollout
already reaches all replicas. No code change.

## 6. Migrations, tests, docs

- SQL: `022_external_global.sql` (§2).
- CRDs: regen via controller-gen (tolerations, scalingMode removal, reserve,
  status.queueDepth); re-apply to the cluster.
- Runner image: untouched (no tag bump needed).
- Tests:
  - CP (node test runner): pool-budget validation on all three paths incl.
    the same-pool-edit exclusion; reserve bounds; externals-global routes;
    `GET /v1/pools` committedMaxReplicas.
  - Operator (Go): transform — tolerations pass-through, no autoscaling
    block, replicas-ownership rule; scaler decision function table tests
    (demand/reserve/clamp/hysteresis).
  - Console: production build; live exercise per CLAUDE.md (deploy from both
    entry points, budget error path, Req Queue shows 0 on the idle model).
- Docs: CLAUDE.md — autoscaling bullet (operator scaler, no HPA), serving
  global-vs-workspace note, catalog informational-fields note ($/hr gone),
  pool bullet (budget enforced, tolerations).

## Open questions

None — all resolved during brainstorming (see decision list at top).
