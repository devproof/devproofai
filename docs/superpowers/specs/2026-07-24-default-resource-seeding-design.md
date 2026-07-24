# Default resource seeding — design

Date: 2026-07-24
Status: approved

## Goal

Fresh installs should come up with a usable baseline: two environments
(`default-all-blocked`, `default-all-allowed`) in the default workspace and two
pools (`default-cpu`, `default-gpu`). Seeding happens exactly once per
installation (marker-guarded), the resources are ordinary user-deletable
objects afterwards (deletion never resurrects them), and a Helm values flag can
disable the behavior entirely.

User decisions (2026-07-24):

- **Once-only = first seed ever, marker-based** — not Helm post-install
  semantics. Fresh installs AND existing installs upgrading to this version
  seed once; after the marker is set, never again.
- **Collisions: skip existing, seed the rest**, then set the marker. Nothing is
  ever overwritten.
- **`default-gpu` seeds `gpusPerNode: 1`** (the live dev cluster's `0` was a
  placeholder).

## Why CP boot seeding (approach decision)

Environments are Postgres rows; pools are ModelPool CRs. The control plane is
the only component that already writes both with the right validation and RBAC
(`repo.createEnvironment` at `repo.ts:1258`; `store.create("modelpools", …)` in
the `/v1/pools` route; RBAC grant in
`helm-charts/templates/controlplane/rbac.yaml` lines 25–27). Boot-time cluster
writes are an established CP pattern (`ensureGatewayAuthSecret` /
`ensureInternalKeyInAgentsNs` in `main.ts`), and the marker gives exactly-once
semantics a `helm.sh/hook: post-install` Job cannot (hooks skip upgrades, and a
Job would need its own marker plus CP-readiness retries anyway). A
migration-based alternative was rejected: migrations can't be flag-gated by
Helm values and can't create CRs.

There is no ModelPool controller in the operator — pools are only read when a
ModelDeployment references one (`modeldeployment_controller.go:87`) — so a
seeded pool CR is inert until used; no boot-ordering race with the operator.

## 1. Values flag (Helm)

- `helm-charts/values.yaml`: new key `controlplane.seedDefaults: true`
  (commented: seeds two environments + two pools once at first CP boot,
  marker-guarded; set `false` to disable).
- `helm-charts/templates/controlplane/deployment.yaml`: render
  `DEVPROOF_SEED_DEFAULTS: "true" | "false"` — always explicit.
- CP treats an **unset** env var as OFF, so the out-of-cluster dev CP
  (`npx tsx src/main.ts`) never seeds unless the flag is exported deliberately.
- `values-dev.yaml` needs nothing (the dev profile ships no CP pod).

## 2. Seed content

New module `control-plane/src/seed-defaults.ts` with hardcoded constants:

| Resource | Spec |
|---|---|
| env `default-all-blocked` | `allowed_hosts []`, `allow_package_managers false`, `allow_mcp_servers false`, `pod {disk:{type:"emptyDir"}}`, workspace `wrkspc_default` |
| env `default-all-allowed` | `allowed_hosts ["*"]`, `allow_package_managers true`, `allow_mcp_servers true`, `pod {disk:{type:"emptyDir"}}`, workspace `wrkspc_default` |
| pool `default-cpu` | `gpuType cpu`, `gpusPerNode 0`, `maxNodes 1`, `nodeSelector {}`, `tolerations []` |
| pool `default-gpu` | `gpuType gpu`, `gpusPerNode 1`, `maxNodes 1`, `nodeSelector {}`, `tolerations []` |

## 3. Mechanism

`seedDefaults({ repo, kube })` runs in `main.ts` right after the Repo and
kubestore are constructed (after `migrate()`), guarded by:

1. `DEVPROOF_SEED_DEFAULTS === "true"` (any other value, including unset, is
   off), AND
2. the `app_settings` marker `data->'seed'->>'defaultsApplied'` is absent
   (read/written via the established `jsonb_set` pattern on the `id='global'`
   singleton row).

Per-resource skip-if-exists:

- Environments: existence check against the `(workspace_id, name)` unique
  index; a concurrent-insert unique violation is also treated as "exists".
  Creation goes through `repo.createEnvironment`.
- Pools: `kube.get("modelpools", name)`; creation mirrors the `/v1/pools`
  route's `store.create("modelpools", …)` shape.

The marker is set **only after all four resources succeeded** (created or
skipped), so a transient failure retries on the next boot and skip-if-exists
makes the retry harmless. The whole step is wrapped warn-and-continue like the
gateway-secret bootstrap (`main.ts:40-47`) — a failed seed never blocks CP
boot. If local serving is disabled (`localServingEnabled()` false → no
kubestore), pools are skipped with a warning, environments still seed, and the
marker is still set the same way (pool seeding is a serving concern; a later
serving enablement does not re-trigger seeding).

The seed workspace id is an injectable parameter defaulting to
`DEFAULT_WORKSPACE` (for tests only; production always seeds
`wrkspc_default`).

## 4. Error handling

- Flag off / unset → no-op, no marker written.
- Marker present → no-op forever; deleted resources are never resurrected.
- Partial failure → marker stays unset, retried next boot, existing resources
  skipped.
- Existing cluster with all four names present (the current dev cluster) →
  four skips, marker set, done.
- Concurrent CP replicas → unique index / kubestore conflict resolve the race;
  both treat "already exists" as success.

## 5. Testing

New `control-plane/test/seed-defaults.test.ts` (real dev DB + fake kube store,
matching existing test conventions):

- seeds all four resources when the flag is on and the marker absent;
- skips existing environment rows and pool CRs, still sets the marker;
- no-ops when the marker is present;
- no-ops when the flag is off/unset;
- pool seeding skipped (envs still seeded, marker set) when no kubestore.

Tests target a throwaway `t-seed-…` workspace via the injectable workspace id
(never the real `wrkspc_default`) and save/restore the `app_settings` marker in
teardown (safe under `--test-concurrency=1`).

Verification beyond unit tests: `npx tsc --noEmit`, and `helm template` render
checks that `DEVPROOF_SEED_DEFAULTS` appears as `"true"`/`"false"` per the
values flag.

## Out of scope

No console changes, no SQL migrations, no new RBAC, no version bumps (CI/CD
owns versioning), no re-seeding controls beyond the single marker.
