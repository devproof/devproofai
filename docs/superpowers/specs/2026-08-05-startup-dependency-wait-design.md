# Control-plane startup dependency wait — design

Date: 2026-08-05 · Status: approved

## Problem

On cluster cold start (fresh kind/docker-desktop boot, `helm install`), the control plane
races its dependencies. Postgres is still in `ContainerCreating` (PVC provisioning, image
pull) when the CP boots, so `migrate(pool)` at `control-plane/src/main.ts:39` throws
`ECONNREFUSED` and the process exits — CrashLoopBackOff with Error states and restart
counts until Postgres arrives, plus up to minutes of added convergence time from the
kubelet's exponential backoff. Observed live (controlplane 0/1 Error, 3 restarts in 65s,
postgres still ContainerCreating).

Startup-dependency audit (2026-08-05, all other deps verified covered):

| Dependency | Boot behavior | Verdict |
|---|---|---|
| Postgres | `migrate()` — no retry, crashes | **the bug** |
| MinIO/S3 | CreateBucket retry loop (30×2s, then crash) | covered; budget short for cold clusters |
| Kube API (gateway secret, seed) | warn-and-continue | covered |
| Gateway | boot sync writes ConfigMap; warmups retry internally | covered |
| Console → CP | console readiness probe waits | self-heals |

No initContainers exist anywhere in the chart; all five bundled pods have readiness
probes. Nothing in `main.ts` executes before the migrate call except lazy pool
construction.

## Decision (approach A, approved)

**In-app patient wait, configurable via Helm values.** No initContainers (in-cluster-only
fix, extra image for the air-gapped story, duplicates what the app does better — the app
knows which errors are retryable).

### Wait behavior

New `waitForPostgres(pool, opts)` in `control-plane/src/db.ts`, called from `main.ts`
immediately before `migrate(pool)`:

- Probe: `SELECT 1` via the pool.
- **Retryable** (`err.code`): `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`,
  `ENETUNREACH`, `ENOTFOUND`, `EAI_AGAIN` (service DNS not yet registered), and Postgres SQLSTATE
  `57P03` ("the database system is starting up" — the official image's init dance can
  accept TCP before recovery finishes). Node socket errors and Postgres server errors
  both arrive on `err.code`, so one switch covers both classes (the live crash log
  confirms pg-pool propagates the raw `ECONNREFUSED`).
- Retry every **2s**, one log line per attempt (`postgres not ready (<code>), waiting…`),
  until the budget is exhausted, then **rethrow → crash** — a genuinely broken install
  must surface as a failing pod, not a silent hang. K8s restarts the pod and the wait
  effectively continues.
- **Non-retryable** errors fail immediately (bad credentials `28P01`, missing database
  `3D000`, and any unlisted code) — misconfiguration must not burn the budget.

### Configuration

One knob for the whole boot, not per-dependency:

- Env: `DEVPROOF_STARTUP_WAIT_SEC`, integer seconds, **default 300** when unset/invalid
  (out-of-cluster dev gets the default with no setup).
- Helm: new value `controlplane.startupWaitSeconds: 300` in `helm-charts/values.yaml`,
  rendered as the env var in `helm-charts/templates/controlplane/deployment.yaml`.
- The existing S3 CreateBucket loop in `main.ts` switches from its hardcoded 30-attempt
  cap to a deadline computed from the same budget (2s cadence and crash-on-exhaustion
  semantics unchanged).

## Files

- `control-plane/src/db.ts` — add `waitForPostgres`.
- `control-plane/src/main.ts` — call it before `migrate()`; S3 loop reads the shared
  budget.
- `helm-charts/values.yaml` + `helm-charts/templates/controlplane/deployment.yaml` —
  `startupWaitSeconds` → `DEVPROOF_STARTUP_WAIT_SEC`.
- `control-plane/test/` — new unit test file for `waitForPostgres`.
- **No version bumps** (CI's job), no probe or initContainer changes.

## Testing & verification

1. Unit tests (Node test runner, one new file): `waitForPostgres` accepts injectable
   delay so tests run instantly against a stub pool — (a) fails N× `ECONNREFUSED` then
   succeeds ⇒ N+1 attempts, resolves; (b) budget exhaustion ⇒ rethrows the last error;
   (c) `28P01` ⇒ immediate rethrow, single attempt; (d) `57P03` retries.
2. Suite green: `cd control-plane && npm test` and `npx tsc --noEmit`.
3. Live negative check: out-of-cluster CP pointed at a closed port with
   `DEVPROOF_STARTUP_WAIT_SEC=6` ⇒ ~3 retry lines then crash.
4. Normal dev boot unchanged (Postgres already up ⇒ zero added latency).
5. Final gate — in-cluster cold start: rebuild the CP image on its EXISTING tag,
   ctr-import to the kind nodes, `kubectl delete pod` postgres+controlplane (or full
   cluster restart), watch the CP wait cleanly (log lines, 0 restarts, no Error state)
   and come Ready after Postgres.

## Out of scope

Mid-life Postgres outages (pool reconnect behavior), gateway/console boot ordering
(already self-healing), initContainers, readiness-probe changes.

## Amendment 2026-08-06 — default 600s, single-sourced

User decisions post-ship: (1) default raised 300s → **600s**; (2) the default lives in
exactly ONE place — `DEFAULT_STARTUP_WAIT_SEC` in `control-plane/src/db.ts` — consumed by
`waitForPostgres` and main.ts's env fallback. `helm-charts/values.yaml` ships
`startupWaitSeconds` UNSET (pure override): the template renders an empty env value, which
the blank-guard treats as unset ⇒ code default. Setting the value (incl. 0 = fail fast)
overrides normally.
