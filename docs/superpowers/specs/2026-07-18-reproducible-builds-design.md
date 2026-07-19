# Reproducible builds — design

Date: 2026-07-18. Status: approved.

## Goal

Same commit ⇒ same working build, locally and in GitHub Actions, for every
component — with one shared build definition so local and CI cannot drift.
Strictness level: **deterministic** (all dependencies pinned via lockfiles and
digests; identical commands both places), not bit-for-bit identical binaries.
Plus: a build/version number baked into all four images and shown in the
console, and a repo-root `BUILD.md` documenting the whole process.

## Components and artifacts

| Component | Artifact | New? |
|---|---|---|
| `operator/` | Docker image `devproof/operator` | new Dockerfile |
| `control-plane/` | Docker image `devproof/control-plane` | new Dockerfile |
| `console/` | Docker image `devproof/console` | new Dockerfile |
| `session-runner/` | Docker image `devproof/session-runner` | existing Dockerfile, made deterministic |
| `devproofai-client/` | wheel + sdist | build via `python -m build` |

## Architecture: `docker buildx bake` as the single entrypoint

A repo-root `docker-bake.hcl` defines all four image targets with a shared
`VERSION` build arg. Local build = `scripts/build.sh` (computes the version,
runs `docker buildx bake`); CI runs the **same bake file** with the same
script. That shared definition — not parallel-maintained commands — is what
makes local and CI identical. Works on docker-desktop as-is.

The Python client wheel is the one non-image artifact; it is built separately
(`python -m build`) both locally and in CI.

Rejected alternatives: a root Makefile (`make` is not in Git Bash on Windows;
Makefile logic drifts from CI), and CI-as-orchestrator with per-component
scripts (build definition lives in YAML that cannot run locally; shared config
duplicated per component).

## Versioning

- **Scheme: `git describe --tags --dirty`** — e.g. `v0.1.0` on a tagged
  commit, `v0.1.0-14-ga1b2c3d` between tags, `-dirty` appended for local
  uncommitted changes. Single source of truth (git tags), no file to bump,
  identical locally and in CI. An initial `v0.1.0` tag is created as part of
  this work; before any tag exists, `scripts/version.sh` falls back to
  `v0.0.0-<commit-count>-g<sha>`.
- `scripts/version.sh` emits the version; `scripts/build.sh` passes it to bake
  as build arg `DEVPROOF_VERSION`.
- Every image gets `ENV DEVPROOF_VERSION=<version>` plus the OCI label
  `org.opencontainers.image.version` (and `…image.revision` = full SHA).
- The operator additionally embeds it via
  `-ldflags "-X main.version=$VERSION"`.
- **Python client uses setuptools-scm** (same git tags, mapped to PEP 440:
  tagged ⇒ `0.1.0`, between tags ⇒ `0.1.0.dev14+ga1b2c3d`). Replaces the
  static `version` field in `pyproject.toml`.

## Per-component build design

All base images are pinned **by digest** (`image:tag@sha256:…`); all package
managers install from lockfiles.

- **operator** — multi-stage: pinned `golang:1.26` builder,
  `CGO_ENABLED=0 go build -trimpath` (deps already pinned by `go.sum`),
  static runtime stage (distroless/static or scratch + ca-certificates).
- **control-plane** — pinned `node:22-slim`, `npm ci` (existing
  `package-lock.json`), runtime = `npx tsx src/main.ts` — the same runtime as
  dev, deliberately no new compile step to diverge from how the CP actually
  runs.
- **console** — pinned `node:22-slim`, `npm ci` + `next build` with
  `output: "standalone"` in `next.config`; runtime stage copies
  `.next/standalone` for a slim image, `next start`-equivalent on port 7090.
  Note: `next/font/google` downloads fonts at build time — the console image
  build needs network egress to Google Fonts (fine locally and in CI;
  documented in BUILD.md; vendoring the fonts would remove it, out of scope).
- **session-runner** — existing Dockerfile made deterministic: the three
  unpinned `pip install` layers move to a fully pinned
  `session-runner/requirements.txt` (exact `==` versions frozen from the
  current dev50 image, so runtime behaviour is unchanged — including
  `kaleido<1` resolving to its current 0.x); base `python:3.12-slim` pinned by
  digest. Apt packages stay unpinned (Debian offers no sane version pinning) —
  documented as the known determinism gap. The manual `devNN` tag workflow for
  dev stays; CI tags by version/SHA.
- **devproofai-client** — `python -m build` ⇒ wheel + sdist, version from
  setuptools-scm.

## Version display

- New CP endpoint `GET /v1/version` ⇒ `{ version }`, read from
  `process.env.DEVPROOF_VERSION`, fallback `"dev"` (covers out-of-cluster tsx
  dev, where no env is set).
- Console left-nav footer: a small muted version line pinned at the bottom of
  the nav, on every page — shows the CP version (fetched server-side,
  `Promise.allSettled`-guarded like the layout's existing CP reads; CP down ⇒
  `dev`/hidden), plus the console's own build-time version if it differs.

## GitHub Actions

`.github/workflows/ci.yml`, on PR and push to main:

Parallel test jobs:
- **operator**: `go vet ./...`, `go test ./...`.
- **control-plane**: `npm ci`, `npx tsc --noEmit`, `npm test` with a
  **Postgres service container** (connection via `DEVPROOF_DATABASE_URL`).
  Verified against the code: the suite needs Postgres only — k8s goes through
  `fakeStore()`, file storage is faked (no test touches S3/MinIO), so no
  MinIO container and no skip-guards. `--test-concurrency=1` stays (shared-DB
  races, see CLAUDE.md).
- **session-runner**: `python -m unittest discover -s tests -p "test_*.py"` —
  the 3 Delegate-path tests that fail on the Windows host pass on Linux, so
  the full suite runs.
- **client**: `python -m build` (artifact uploaded).

Build job (after tests): `docker buildx bake` from the same `docker-bake.hcl`
— PRs build without pushing; pushes to main additionally log in to GHCR with
the built-in `GITHUB_TOKEN` and push
`ghcr.io/devproof/<component>:{<short-sha>, <git-describe>, latest}`.

## BUILD.md

Repo-root `BUILD.md` (exact name per request) documenting: prerequisites
(Docker + buildx, Node, Go, Python), the version scheme, the one-command local
build (`scripts/build.sh`), per-component build commands, what makes each
build deterministic (lockfiles, digest-pinned bases, frozen requirements) and
the known gaps (apt packages; Google Fonts fetch at console build), how to
update pins (refreeze `requirements.txt`, bump base digests, `npm ci` after
lockfile changes), and how each CI job maps to the local commands.

## Error handling

- `scripts/version.sh` degrades gracefully outside a tag (`v0.0.0-…`
  fallback) and appends `-dirty` on local modifications.
- `GET /v1/version` never fails: missing env ⇒ `"dev"`.
- Console footer degrades like the rest of the layout when the CP is down.
- CI: test jobs gate the build job; a red suite never publishes images.

## Testing / verification

- Existing suites unchanged (CP `npm test`, session-runner unittest, operator
  `go test`); CI runs them all.
- New behaviour verified by: CP `/v1/version` test (env set/unset); a green
  first CI run on a PR; local `scripts/build.sh` producing all four images
  with the version visible in `docker inspect` labels and the console footer.
- Determinism spot-check documented in BUILD.md: build twice from a clean
  checkout ⇒ identical dependency trees (not necessarily identical layer
  hashes — bit-for-bit is out of scope).

## Risks (verified during design)

- CP tests in CI: **closed** — Postgres-only, fakes for k8s/files, env-driven
  DB URL.
- Console `next build` without a live CP: **closed** — all pages
  `force-dynamic`, layout fetches guarded; CP-down builds already exercised
  routinely in dev.
- Residual: ordinary first-run CI friction (e.g. a test assuming pre-seeded
  dev-DB state on a fresh database). Handled during implementation, not a
  design risk.
