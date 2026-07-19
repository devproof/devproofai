# Session pod configuration on environments — design

Date: 2026-07-12. Status: approved.

## Goal

Give environments full control over the session (turn) pods that run under them,
and make environments mandatory for agents. New per-environment settings:

- CPU/memory **requests** and **limits**
- **Node selector** and **tolerations** (UI aligned with pool creation)
- A **disk for `/work`**: EmptyDir (default, no limits) or an **ephemeral PVC**
  (storage class from the cluster, size in GB, default 64) for larger disks

Non-goals: session-level environment override; pod name on the session page;
any migration/backfill of existing rows (software not rolled out — existing
agents without an environment are fixed by hand).

## Context (verified 2026-07-12)

- Session pods today have **no volumes**; `/work` is bare container fs.
  Resources are hardcoded: requests `250m`/`512Mi`, limits `memory: 1Gi`, no
  CPU limit (`orchestrator.ts`).
- `/work` persists across turns only via the checkpoint tarball
  (`CHECKPOINT_PATHS` = the CLI's state dir + config file (of the
  legacy CLI runtime) + `/work`, `runner.py`).
- `agent_versions.environment_id` is nullable; sessions with no environment
  fall back to the synthetic `env_none` (deny-all egress, provisioned at boot,
  not a DB row).
- Pool modal (`console/app/pools/pool-modal.tsx`) is the pattern for node
  selector (`kvrow` key/value rows) and tolerations (key/operator/value/effect
  rows).
- Installed `@kubernetes/client-node@^1.3.0` has `StorageV1Api`;
  `listStorageClass()` returns `{items}` directly (no `.body`). Live
  docker-desktop classes: `hostpath`, `standard` (default) — both
  `rancher.io/local-path`.
- Next migration number: `025`. `migrate()` re-runs every sql file each boot.

## Decisions made during brainstorming

1. **No migration/backfill** for existing null `environment_id` rows — user
   updates them manually; the software has never been rolled out.
2. **EmptyDir keeps today's checkpoint behavior** (`/work` in the tarball).
   **PVC adds a "Persist /work across turns" toggle**: on (default) = `/work`
   stays in the checkpoint; off = `/work` is per-turn scratch, only the CLI's
   state dir checkpoints.
3. **Approach A** chosen: one JSONB `pod` column on `environments`, resolved
   **live at Job creation** (env edits apply to every session's next turn,
   consistent with the Squid allowlist). Rejected: typed columns (7+ columns,
   nothing queries them individually); snapshotting into the session (couldn't
   fix an OOM-ing agent by editing its environment).

## 1. Data model & API

Migration `025_environment_pod.sql`:

```sql
ALTER TABLE environments ADD COLUMN IF NOT EXISTS pod JSONB NOT NULL DEFAULT '{}';
```

`pod` shape (all fields optional; absent = today's behavior):

```jsonc
{
  "requests":     { "cpu": "250m", "memory": "512Mi" },   // k8s quantity strings
  "limits":       { "cpu": "2",    "memory": "1Gi" },
  "nodeSelector": { "kubernetes.io/arch": "amd64" },
  "tolerations":  [{ "key": "…", "operator": "Equal", "value": "…", "effect": "NoSchedule" }],
  "disk": { "type": "emptyDir" },
  // or:
  "disk": { "type": "pvc", "storageClass": "standard", "sizeGb": 64, "persistWork": true }
}
```

`agent_versions.environment_id` stays schema-nullable (NOT NULL would crash
every boot while old rows exist, since migrations re-run); mandatory-ness is
enforced at the API layer.

API changes (`agents-api.ts`):

- `POST`/`PATCH /v1/environments` accept `pod`, validated: cpu/memory match the
  k8s quantity format; toleration operator/effect from the k8s enums;
  `disk.type ∈ emptyDir|pvc`; `pvc` requires non-empty `storageClass` and
  integer `sizeGb ≥ 1`. Invalid → 400 with a field-specific message.
- `POST /v1/agents` and agent edits: missing `environmentId` → 400
  `environment required`; unknown id → 400 (checked, not left to the FK error).
- New `GET /v1/storage-classes` →
  `{ storageClasses: [{ name, provisioner, isDefault }] }` via
  `StorageV1Api.listStorageClass()`; `isDefault` from the
  `storageclass.kubernetes.io/is-default-class` annotation. Global (cluster
  infra, like Serving).
- **`env_none` removed entirely**: boot provisioning in `main.ts`, the delete
  guard, and the orchestrator fallback. Session start (new or follow-up) with a
  config lacking `environment_id` → clear 400 instead of silent deny-all.

## 2. Orchestrator & runner

**Resolution timing:** the session-start/turn routes fetch the environment row
for `config.environment_id` and pass it to the orchestrator — missing/unknown
environment is a 400 before any Job is created. Read fresh per turn; mid-turn
pods untouched.

**Job spec assembly** — extracted into a pure exported
`buildTurnJob(args, environment)` (same pattern as `squidConf`), the k8s call
stays a thin wrapper:

- `resources`: from `pod.requests`/`pod.limits`, fallbacks = today's values
  (requests `250m`/`512Mi`, memory limit `1Gi`); CPU limit set only if
  configured.
- `nodeSelector`/`tolerations` pass through verbatim onto `template.spec`.
- `/work` becomes a real volume in all cases:
  - emptyDir (default / `disk` absent): `{ name: "work", emptyDir: {} }` — no
    size limits.
  - pvc: generic ephemeral volume —
    `{ name: "work", ephemeral: { volumeClaimTemplate: { spec: {
    accessModes: ["ReadWriteOnce"], storageClassName,
    resources: { requests: { storage: "<sizeGb>Gi" } } } } } }`. Kubernetes
    creates the PVC with the pod and garbage-collects it via owner reference —
    nothing for the reconciler to clean up.
- New container env `DEVPROOF_CHECKPOINT_WORK`: `"0"` only when
  `disk.type === "pvc" && !persistWork`, else `"1"`.

**Failure mode (no new code):** an unbindable PVC leaves the pod Pending; the
Job's `activeDeadlineSeconds` fires regardless of scheduling, the zombie
reconciler marks the session `failed` (resumable); fix the environment and
resume.

**Runner (`runner.py`, image tag → `dev24`):**

- `CHECKPOINT_PATHS` drops `/work` when `DEVPROOF_CHECKPOINT_WORK == "0"`;
  restore needs no change (tarball simply lacks `/work`).
- The platform prompt's `/work` line becomes conditional: "persists across
  turns of THIS session" vs "scratch for this turn only — anything you want to
  keep must go to outputs or memory".

## 3. Console UI

**Environment modal** (`console/app/environments/create.tsx`, width `md`→`lg`):

- Requests CPU/Memory (placeholders `250m`/`512Mi`), Limits CPU/Memory
  (placeholders `none`/`1Gi`); hint "empty = platform default"; client-side
  k8s-quantity validation mirroring the API.
- Node selector + tolerations rows copied from the pool modal so the two
  dialogs stay identical.
- Disk select: `EmptyDir (node disk)` default | `PVC (dedicated volume)`.
  PVC reveals: storage class dropdown (from `GET /v1/storage-classes` on modal
  open, cluster default preselected; fetch failure shows the modal error
  state), Size (GB) number input prefilled 64, and "Persist /work across
  turns" checkbox default checked.

**Agent form** (`agent-form.tsx`): `"No environment"` option deleted; submit
disabled until an environment is selected; hint becomes "egress, resources,
and disk the sessions run under".

**Environments list page**: new Disk column — `emptyDir` or
`pvc · 64 GB · standard`.

## 4. Testing

Node test runner + `tsc --noEmit`, existing mock-orchestrator patterns:

- env create/patch: valid pod config accepted; bad quantity, bad disk type,
  PVC missing class/size → 400 each.
- agents: missing/unknown `environmentId` → 400; session start whose config
  lacks an environment → 400.
- `buildTurnJob`: emptyDir default, PVC volume shape, resource fallbacks,
  `DEVPROOF_CHECKPOINT_WORK` matrix (pvc × persistWork).
- storage-classes endpoint with an injected fake storage API (default-class
  annotation mapping).

Manual verify (per CLAUDE.md): rebuild runner as `dev24`, restart CP + console,
all pages 200; create a PVC environment on `standard`, run a session —
`kubectl get pvc` shows the claim during the turn and gone after; with persist
off, confirm the checkpoint tarball lacks `/work` and the follow-up turn still
resumes conversation state.
