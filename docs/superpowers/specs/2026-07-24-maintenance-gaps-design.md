# Maintenance cleanup gaps — design (2026-07-24)

Closes three gaps in the maintenance runner's coverage (audit 2026-07-24):

- **G1** — `routing_rejects` grows unbounded: the gateway inserts a row per
  routing 403 (`custom_callbacks.py:897`), nothing ever deletes one.
- **G3** — no sweep for orphaned k8s resources: an egress proxy trio, a
  `env-*` NetworkPolicy, a vault Secret, or a `<sesn>-work` PVC whose owning
  DB row vanished by a non-route path (direct SQL, restore, partial drain)
  lingers forever.
- **G4** — `resource_prices` keeps inert rows when a pool/deployment is
  deleted via kubectl (route-side cleanup is advisory only).

Out of scope by explicit decision:

- **G2** (standalone `session_events` prune keeping the session row) —
  dropped; cascade-on-session-delete is enough. Installs that need transcript
  storage back enable session retention instead.
- **G5** (soft-deleted `api_keys`) — permanent by design; the name survives
  for usage attribution.

## Shape

Three new sections join `runMaintenance` (`control-plane/src/maintenance.ts`),
keeping its idiom: settings-gated, error-isolated via `guard`, counts in the
summary, console toggle per section. New run order:

    billing → tokens → rejects → sessions → files → prices → k8s → orphans

`rejects` sits with its retention siblings; `prices` and `k8s` are diff-based
sweeps and run just before `orphans`, which stays last. No SQL migration:
settings live in the `app_settings` JSONB and flow through
`defaultMaintenanceSettings` + `mergeMaintenanceSettings`, so existing
installs pick up the new defaults on first read.

## G1 — `rejects` retention section

Table (`001.do.baseline.sql:671`): `routing_rejects(id bigint PK, routing,
api_key_id, workspace_id, created_at timestamptz DEFAULT now())`. No FKs in or
out. One writer (gateway INSERT), two readers (`routingRejectCount`
`repo.ts:1564`, the rejects leg of `routingBreakdownBuckets` `repo.ts:1611`) —
both windowed to hours, so a 30-day prune is invisible to them.

- `MaintenanceSettings.rejects: Retention`, default
  `{ enabled: true, keep: 30, unit: "days" }` — **ON by default** (user
  decision): rejects are diagnostic rows, not billing history; a default-off
  section would leave the unbounded growth in place.
- `MaintenanceRepo.pruneRoutingRejects(cutoffMs): Promise<number>` —
  `DELETE FROM routing_rejects WHERE created_at < now() - make_interval(secs => $1)`
  (mirrors `pruneCostEntries`). The existing index leads with `routing`, so
  the delete is a seq scan — acceptable at nightly cadence; no new index.
- Summary: `rejects: { ran, rows?, error? }`. Validation: add `rejects` to the
  `rules` list in `validateMaintenanceSettings`.
- Console (`console/app/settings/form.tsx`): one more retention row via the
  shared `RetentionForm` component ("Routing rejects"), plus a `sectionLines`
  entry for the last-run summary.

## G3 — `k8s` orphaned-resource sweep

`MaintenanceSettings.k8s: { enabled: boolean }`, default **true** (user
decision — same posture as `orphans`; orphaned k8s resources are pure waste,
and the safety rails below make false positives structurally hard). Summary:
`k8s: { ran, secrets?, egress?, policies?, pvcs?, error? }`. Agents namespace
only.

### Discovery — expected-set diff, never name reversal

1. Load full live id lists from the DB **first**: vault ids, environment ids,
   session ids (three small repo methods, global scope).
2. List candidate resources per class; delete any candidate **not** in the
   expected set rendered from those ids:

| Class | Candidates | Owner rows |
|---|---|---|
| Secrets `devproof-vault-<suffix>` | name = `devproof-vault-` + strict id-shape suffix | `vaults` |
| ConfigMap/Deployment/Service `egress-<suffix>` | `egress-` + id-shape suffix | `environments` |
| NetworkPolicy `env-<suffix>` | `env-` + id-shape suffix | `environments` |
| PVCs | label selector `app=devproof-session`; owning session id read from the `devproof.ai/session` label (`orchestrator.ts:296`) — no name matching | `sessions` |

"Id-shape suffix" = the rendered form of both id generations:
`<prefix>-<12 base36>` or 24-hex. The strict regex keeps chart-shipped
resources in the namespace (image-pull secret, operator additions) out of the
candidate set entirely.

### Safety rails

- **DB before k8s, fail-closed.** Expected sets load before any k8s list; any
  DB error aborts the whole section before a single delete. Row deleted after
  the snapshot → resource genuinely orphaned. Row created after → resource is
  seconds old, protected by grace.
- **1h creation-age grace** (`GRACE_MS`): skip any resource whose
  `creationTimestamp` is younger.
- **Per-class isolation**: a failed k8s list skips that class only; never
  delete on partial data.
- **PVCs strictest** (deletion = session data loss if wrong): label-selected,
  id from the label, membership checked against `sessions`. Parked / queued /
  writer-waiting sessions all still have rows, so limbo states are inherently
  safe.

### Wiring

`orchestrator.ts` (owner of the kube clients and the naming scheme) exports
`sweepOrphanedK8s({ vaultIds, environmentIds, sessionIds, graceMs })` →
per-class delete counts; it renders expected names internally —
`maintenance.ts` never learns the naming. `MaintenanceDeps` gains it as
optional `sweepK8s`; absent (pure unit tests) the section reports
`error: "no k8s access"` rather than claiming success. Name rendering +
candidate-regex matching are extracted as pure functions for direct unit
testing. Console: orphans-style single toggle ("Orphaned cluster resources")
plus a `sectionLines` entry.

## G4 — `prices` orphan prune

`MaintenanceSettings.prices: { enabled: boolean }`, default **true**. Ref
semantics (verified `agents-api.ts:1159`): pool/deployment → CR name;
external/environment → row id.

| kind | live refs from |
|---|---|
| `pool` | `kubestore.list("modelpools")` → CR names |
| `deployment` | `kubestore.list("modeldeployments")` → CR names |
| `external` | `external_deployments` ids |
| `environment` | `environments` ids |

- `MaintenanceRepo.pruneOrphanResourcePrices(kind, liveRefs): Promise<number>`
  — `DELETE FROM resource_prices WHERE kind = $1 AND NOT (ref = ANY($2))`.
- **Fail-closed per kind**: a failed CR list or table query skips that kind
  only. An empty-but-successful list is valid — zero pools means every
  `pool` price row is genuinely orphaned.
- No age grace (table has no timestamp) and none needed: prices are only set
  on already-existing resources via the console form, and deleting a row for
  an absent ref cannot affect cost stamping — the 031 trigger reads prices at
  usage time, and an absent deployment/external produces no usage.
- Summary: `prices: { ran, rows?, error? }`; console orphans-style toggle.
- `scripts/sweep-workspaces.ts:64` already prunes the environment leg for test
  hygiene — unaffected.

### Wiring (shared with G3)

`MaintenanceDeps` gains optional `listServing: () => Promise<{ pools: string[];
deployments: string[] }>` (kubestore-backed). The deps object is built **once**
in `main.ts` and shared by `startMaintenanceScheduler` and the
`POST /v1/maintenance/run` route (`agents-api.ts:1154`) — today each site
constructs its own, and the manual run would otherwise silently lack the new
sweeps.

## Testing

- **Unit** (`control-plane/test`; one shared DB, `--test-concurrency=1` rules
  apply):
  - defaults + merge + validate for the three new settings fields;
  - rejects prune: seed rows with explicit `created_at` on both sides of the
    cutoff, assert only old rows deleted;
  - prices prune per kind, incl. empty-list-deletes-all and
    failed-lister-skips-kind;
  - `runMaintenance` passes correct expected-id sets to a stubbed `sweepK8s`;
    absent dep → `error: "no k8s access"`;
  - the extracted name-rendering/regex/grace functions: both id shapes match,
    chart-style names don't, young resources skipped.
- **Live** (docker-desktop): orphan an environment row via SQL →
  `POST /v1/maintenance/run` → its egress ConfigMap/Deployment/Service +
  NetworkPolicy vanish while every live env/vault/session resource survives;
  same for a hand-created vault-pattern Secret and an orphan price row.
  Exercise the console panel (toggles, last-run lines). Then `npm test`,
  `npx tsc --noEmit`, restart CP + console, all pages 200.
