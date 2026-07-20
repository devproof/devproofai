# Building Devproof AI

Reproducible builds: the same commit produces the same working build locally
and in CI. Spec: `docs/superpowers/specs/2026-07-18-reproducible-builds-design.md`.

## TL;DR

    scripts/build.sh            # all five images, version-stamped
    scripts/build.sh console    # just one target
    scripts\build.ps1           # same, native Windows PowerShell (no Git Bash needed)

Requires: Docker (buildx — docker-desktop has it), Git Bash or PowerShell on Windows.
The Python client: `cd python-client && python -m build` (needs
`pip install build`).

## Version scheme

`scripts/version.sh` = `git describe --tags --dirty`:

| State | Version |
|---|---|
| on tag `v0.1.0`, clean | `v0.1.0` |
| 14 commits later | `v0.1.0-14-ga1b2c3d` |
| uncommitted changes | `…-dirty` |

Release = run the **bump-version** workflow manually (Actions → bump-version
→ Run workflow) and enter the version (e.g. `v0.2.0`) — nothing publishes
images automatically. It stamps the version into every pinned spot
(Chart.yaml, the devproof image tags in values.yaml, both package.jsons, the
README install examples), commits the bump, force-moves the git tag onto that
commit (an existing tag is overwritten), and dispatches **release**, which
builds from the tag: the image version comes from `scripts/version.sh`
against that tag (asserted equal), so git and GHCR can't drift. No manual
tagging.
The version rides into every image as build arg `DEVPROOF_VERSION` →
`ENV DEVPROOF_VERSION` + the `org.opencontainers.image.version` label, and:

- operator: also `-ldflags -X main.version=…`, logged at startup
- control-plane: served at `GET /v1/version` (no env ⇒ `"dev"`)
- console: shown in the left-nav footer (CP version, plus `· ui <v>` if the
  console image differs)
- python-client (`devproofai-client` on PyPI): setuptools-scm maps the same tags to PEP 440
  (`0.1.0` on tag, `0.1.1.devN+g<sha>` between tags)

## One definition, two consumers

`docker-bake.hcl` defines all five image targets. `scripts/build.sh` (local)
and `.github/workflows/release.yml` (CI) both run `docker buildx bake` against
it — never encode build steps anywhere else, or local and CI drift. Releases
additionally build `linux/amd64` + `linux/arm64` via a bake `--set
"*.platform=…"` override (local builds stay native single-arch).

Bake variables: `VERSION`, `REVISION` (set by build.sh/release.yml),
`REGISTRY` (default `devproof`; releases use `ghcr.io/devproof` - public GHCR,
no pull limits), `EXTRA_TAG` (optional second tag), `LATEST` (unused; refs pin
versions).

## Per-component builds

| Target | Context | Dockerfile | Notes |
|---|---|---|---|
| operator | `operator/` | `operator/Dockerfile` | static Go, `-trimpath`, distroless |
| control-plane | repo root | `control-plane/Dockerfile` | needs `catalog/` in context; runtime = tsx, same as dev |
| console | `console/` | `console/Dockerfile` | Next standalone; `DEVPROOF_API` build arg bakes the `/api` rewrite target |
| session-runner | repo root | `session-runner/Dockerfile` | dev tags stay `devNN` (bump on every change); the current frozen `requirements.txt` was captured from image dev50, built as dev51 with an identical dep set (verified in-image: 112/112 tests) |
| gateway | `gateway/` | `gateway/Dockerfile` | LiteLLM `main-stable` (digest-pinned) + `asyncpg==0.31.0` baked in — no runtime pip install / PyPI egress at pod boot |

## What makes it deterministic

- Base images pinned **by digest** in every Dockerfile.
- Go: `go.sum`; Node: `package-lock.json` via `npm ci`; Python (runner): a
  fully frozen `session-runner/requirements.txt` (`==` pins incl. transitives).
- No timestamps or environment leaks into the artifacts (version is pure git).

Known gaps (accepted, deterministic-not-bit-for-bit):
- apt packages in the runner/console images are unpinned (Debian has no sane
  version pinning).
- `next/font/google` downloads IBM Plex during the console build — needs
  network egress to Google Fonts.
- The control-plane image expects cluster credentials at runtime (in-cluster
  ServiceAccount or mounted kubeconfig); out-of-cluster dev keeps running the
  tsx process directly.
- The control-plane image also requires runtime envs at deploy time (e.g.
  `DEVPROOF_RUNNER_IMAGE` is mandatory — boot exits without it; DB via
  `DEVPROOF_DATABASE_URL`).
- The published console image bakes the /api rewrite target (DEVPROOF_API
  build arg, default 127.0.0.1:7080) into its route manifest at build time —
  deploying the console against a differently-addressed control plane needs
  a rebuild with that build arg, not just a runtime env.

## Updating pins

- **Runner Python deps:** edit/build with loose specifiers temporarily, then
  refreeze: `docker run --rm --entrypoint pip devproof/devproofai-session-runner:devNN
  freeze > session-runner/requirements.txt`, rebuild, run the runner suite.
- **Base images:** `docker buildx imagetools inspect <image:tag>` → paste the
  new digest into the Dockerfile.
- **Node deps:** normal `npm install` flow updates `package-lock.json`.

## CI (GitHub Actions)

`.github/workflows/test.yml`, on PR + push to main (no image builds):

- **operator:** `go vet`, `go test`
- **control-plane:** `npm ci`, `tsc --noEmit`, `npm test` against a Postgres
  16 service container on `15432:5432` — matches db.ts's default URL; the
  suite needs Postgres ONLY (k8s + files are faked in tests)
- **session-runner:** full unittest suite (the 3 Delegate path tests that
  fail on Windows hosts pass on Linux)
- **client:** `python -m build`, wheel uploaded as an artifact
- **chart:** `helm lint` + the render tests

`.github/workflows/bump-version.yml`, manual only (`workflow_dispatch` with a
`version` input): stamps the version everywhere, commits the bump on the
dispatched branch, force-pushes the annotated tag `<version>` onto that
commit (an existing tag is overwritten), and dispatches release on the tag
ref — required because a GITHUB_TOKEN tag push never fires release's own
`tags` trigger (that trigger only catches manually pushed tags).

`.github/workflows/release.yml`, tag-driven (tag push or dispatched on a tag
ref; it never creates tags): `docker buildx bake --push` from the shared
bake file for `linux/amd64` + `linux/arm64` (arm64 under QEMU — expect a long
build), pushing `ghcr.io/devproof/devproofai-<name>:<version>` (public GHCR;
no floating `latest` - refs pin versions) using the built-in `GITHUB_TOKEN`.
It also packages the helm chart at that version (`--version`/`--app-version`
override Chart.yaml's) and pushes it to `oci://ghcr.io/devproof` →
`ghcr.io/devproof/devproofai-helm:<version>` (the OCI repo name comes from the
chart `name:` in Chart.yaml — that's why the chart is named `devproofai-helm`).
Install from the release: `helm install devproof
oci://ghcr.io/devproof/devproofai-helm --version <version> -n devproof …`.

CI hygiene: `npm audit` runs implicitly via `npm ci` — treat new findings as
action items (current state: 0 known vulnerabilities; adm-zip and a postcss
override were fixed 2026-07-18). The control-plane job silences the
transitive DEP0040/DEP0169 Node deprecations; remove those flags to
re-check. GitHub's "Node 20 deprecation" notices mean an action pin needs a
major bump.

## Determinism spot-check

Build twice from a clean checkout of the same commit: versions, tags, and the
full dependency trees are identical (`pip freeze` diff empty, same lockfiles).
Layer hashes MAY differ — bit-for-bit identity is explicitly out of scope.
