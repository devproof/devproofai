# Changelog

## v0.1.8 — 2026-07-23

### Fixed
- GPU deployments silently ran on CPU (~0.2 tok/s for a 12B): the operator now
  sets the Model CR's `hardware.gpu.count`, which is what LLMkube uses to pick
  the CUDA engine image (measured: 0.18 → ~60 tok/s).
- Session Wait rows now appear only for real model deploy/scale-up waits.
  Transient gateway-reload blips no longer show a row or split tool groups
  ("Bash ×3" stays grouped) — their time counts into the next action.
- A scale-to-zero wake that fit inside the gateway hold showed no Wait badge
  (the held first call never retried) — its time leaked into the Think row.
  The runner now detects it from the time-to-first-frame.
- A routing whose target model was deleted made sessions wait ~30 min instead
  of failing. Sending now fails fast with "routing … points to model … that
  no longer exists".
- Session send errors are shown above the composer input, not after the button.
- Model Cache page no longer stalls (up to ~45s) while a model downloads: the
  progress probe uses `stat -c %s` instead of busybox `wc -c`.

### Changed
- `helm uninstall` keeps the bundled Postgres and MinIO data PVCs
  (`helm.sh/resource-policy: keep`); delete them manually to drop data.
  Model-cache and session-work PVCs are unaffected.

## v0.1.7 — 2026-07-23

### Fixed
- Model cache said "Ready" while weights were still downloading — the LLMkube
  Model CR resolves the source before a byte lands. `/v1/cache` now reports
  `Downloading` with a live percentage (exec'd byte count vs content length)
  and the console polls it every 3s while a download runs.
- Deployments showed a phantom "Scaling up" badge during rollouts and after
  replica crashes. Activity now compares desired against the last SETTLED
  replica count; wake/grow/drain badges unchanged, rollouts show Deploying.
- A running session died with `400 Invalid model name` when its model rolled
  or scaled mid-turn (gateway replicas serve a route-less config during the
  rolling reload). The gateway now 503s (`Retry-After`) for any known local
  model missing from a replica's loaded config, and the session runner
  retries patiently on a time budget (`DEVPROOF_SDK_PATIENT_RETRY`, default
  30 min) — a bare 503 is the trigger, since the `/v1/messages` bridge drops
  response headers. Verified: a session survived a 15-minute mid-turn outage.
- Session traces charged model deploy/scale wait to the model's step (e.g. a
  7-minute "thinking" time). Waits now get their own amber "Wait" row and
  the step timer starts when the model is up. (Waits shorter than the
  gateway's 300s hold resolve inside one request and stay in the step time.)

### Added
- Session view shows "model deploying / scaling up…" instead of
  "generating…" while the serving model isn't ready (SSE `model_state`;
  external endpoints unaffected).
- Deployments page updates itself: 3s poll while visible — deploys from any
  client appear without a manual refresh (Refresh button removed).
- Local model deploys prefill the context window from the catalog entry.
- Dev: console and control plane are localhost LoadBalancers
  (`deploy/dev/localhost-lb.yaml`) — no more port-forwards that die with pods.

### Changed
- Bundled LLMkube subchart upgraded 0.9.7 → 0.9.10 (mirrored controller image
  follows). Additive upstream release: new default-off values blocks (`pyrra`,
  `gpuSharing`, `runtimeImages`, `platformFloors`), same CRD set, passthrough
  values contract unchanged. None of the known upstream issues the operator
  works around (HPA selector labels, phase flap, ISVC image/imagePullSecrets
  flap) are fixed, so all workarounds remain.

## v0.1.6 — 2026-07-22

### Fixed
- GPU model deployments were stuck in Pending forever: the operator copied
  `resources.gpu` into the InferenceService as a string, but the LLMkube CRD
  types it as an integer, so the typed server-side apply rejected every
  reconcile and the ISVC was never created. The gpu value is now emitted
  numeric (`cpu`/`memory` stay strings).

## v0.1.5 — 2026-07-22

### Fixed
- Tool output containing a NUL byte failed the whole session — Postgres
  rejects U+0000 in `jsonb`, so the event insert 500'd and the runner's retry
  gave up. NULs are now stripped from values and keys on both sides.
- Console session view could stick on "generating…" after a turn finished.
  The stream now stays open through `failed`, sends real status pings,
  reconnects after 45s of silence, and 404s an unknown session. The public
  `/v1` event stream is unchanged.
- The Python client's PyPI release failed on a missing OIDC permission.
- Chart render tests went red on the bare-semver image tags from v0.1.4.

### Changed
- README: install examples no longer pin a chart version — `helm install`
  resolves the newest tag now that chart tags are bare semver.

## v0.1.4 — 2026-07-21

### Changed
- Released artifacts are tagged with **bare semver**: the chart and the five
  images are now `0.1.4`, not `v0.1.4` (git tags keep the `v`). Helm's OCI
  version resolution only sees strict-semver tags, so the old chart tags were
  invisible to it — `helm pull`/`helm install` without an exact `--version`
  failed with "unable to locate any tags". Install commands change to
  `--version 0.1.4`.
- The bundled MinIO is pulled from `quay.io/minio/minio` (same release, no
  longer mirrored) — registry allowlists need to permit `quay.io`.

### Added
- `THIRD-PARTY-NOTICES.md`: what the project redistributes (mirrored images,
  upstream baked into images built here, the packaged LLMkube subchart), with
  each component's upstream reference, source URL, and license — kept separate
  from components users pull themselves at install time.
- `values.yaml` documents that the bundled PostgreSQL and MinIO are a
  local/demo convenience, and which values replace each with a managed
  service.
- README: the agent-session screenshot is now a live recording.

## v0.1.3 — 2026-07-20

### Added
- Console: configurable time format (Settings → Appearance, after Theme) —
  Browser default, ISO 8601, US, or European. Applies to every timestamp,
  platform-wide; changing it re-renders open pages without a reload.

### Fixed
- Console timestamps were inconsistent and partly wrong: server-rendered
  pages showed en-US/UTC (two hours off for European viewers), client-side
  views the browser locale. All timestamps now render through one formatter
  in each viewer's locale and timezone, at minutes precision.
- Sessions list: rows no longer wrap the Billed and Last activity cells onto
  two lines; table cells keep atomic values on one line everywhere.

## v0.1.2 — 2026-07-20

### Fixed
- In-cluster gateway: the public-API pass-through now targets the in-cluster
  control plane instead of the out-of-cluster dev address (every `/api` call
  through the gateway returned a 500).
- `mirror-images` links all mirrored packages to the repo, including the
  Docker-format manifest lists (minio, squid) that `buildx --annotation`
  silently skipped.
- Chart render tests no longer pin the release version, which broke on the
  first `bump-version` run.

### Changed
- `bump-version` only stamps and tags; the release build is started by hand
  on the tag ref (BUILD.md updated).
- CI: `azure/setup-helm` v4 → v5 and `actions/setup-python` v5 → v6 (Node 24).

## v0.1.1 — 2026-07-20

### Fixed
- In-cluster session callbacks: runner event posts bypass the egress proxy
  and are allowed through the environment NetworkPolicy.
- Turn-end salvage saves outputs, memory, wiki, and checkpoint independently —
  one failure no longer loses the rest.
- Memory mounts were empty on every turn after the first.
- Wikis attached to an old agent version could never be deleted.
- Delegate resolves files from earlier turns via the prior-outputs staging dir.
- S3 bucket creation retries at boot (fresh-install race with MinIO).

### Added
- New wikis are seeded with an `index.md`/`log.md` skeleton.
- Reader agents get read-only wiki mounts.
- Console: edit/delete on wiki and memory-store pages; markdown rendering in
  the memory-store browser; memory-store rename API.
- `bump-version` workflow: stamps the version everywhere, tags, and triggers
  the release build.
- `mirror-images` script: multi-arch GHCR mirrors of third-party images.
- README architecture diagrams and an external-APIs-only install example.

### Changed
- The vendored LLMkube subchart schema is patched, so chart installs no
  longer need `--skip-schema-validation`.
- Runner test suite is green on Windows hosts.

## v0.1.0 — 2026-07-19

Initial release.
