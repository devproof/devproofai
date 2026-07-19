# Baked gateway image (`devproofai-gateway`) — design

**Date:** 2026-07-19
**Status:** approved (local-only rollout — no GHCR push, no release run)

## Problem

The gateway pod runs the stock LiteLLM mirror
(`ghcr.io/devproof/devproofai-litellm:main-stable-052b5a21`) and installs
`asyncpg` at **every pod boot** via `python3 -m ensurepip && pip install
asyncpg` (`helm-charts/templates/gateway/deployment.yaml`). That needs PyPI
egress at runtime — the known air-gap gap, flagged in the deployment comment
("Air-gap follow-up: bake a devproof/gateway image").

## Decision

Bake `asyncpg` into a first-party image built from the shared bake file
(approach chosen over a one-off hand-pushed derived tag).

## Design

### 1. New image: `gateway/Dockerfile` (context = `gateway/`)

- `FROM ghcr.io/berriai/litellm:main-stable@sha256:<full digest>` — digest
  resolved from the existing `devproofai-litellm:main-stable-052b5a21` mirror
  (tag suffix = digest prefix), per BUILD.md's pinned-by-digest rule.
- `RUN python3 -m ensurepip && python3 -m pip install --no-cache-dir
  asyncpg==0.31.0` — the exact commands the pod runs today, moved to build
  time, version pinned (0.31 = the spike-verified version from the
  gateway-auth plan).
- `ARG DEVPROOF_VERSION` → `ENV DEVPROOF_VERSION`, like the other images.
- No ENTRYPOINT/CMD change — config path and port stay chart-side.

### 2. Bake target

5th target `gateway` in `docker-bake.hcl`: inherits `_common`,
`tags("gateway")` → `<registry>/devproofai-gateway:<version>`, added to the
default group. `scripts/build.sh`, `build.ps1`, and `release.yml` pick it up
automatically (all three just run the bake file). BUILD.md: add the
per-component table row; "all four images" → "all five".

### 3. Chart (`helm-charts/`)

- `values.yaml`: `gateway.image` → repository
  `ghcr.io/devproof/devproofai-gateway`, tag `v0.1.2` (user decision: keep the
  current release version; the user bumps it with the next release). **The tag
  is unpublished on GHCR until then** — accepted: main is dev, and dev
  clusters use the local build (below).
- `templates/gateway/deployment.yaml`: drop the `/bin/sh -c` wrapper and the
  `ensurepip && pip install` line → plain
  `command: ["litellm", "--config", "/etc/litellm/config.yaml", "--port", "4000"]`;
  delete the asyncpg/air-gap comment.
- `tests/render.test.mjs`: update the image assertion to the new name:tag.

### 4. Local-only rollout / verification

No GHCR push, no release. Locally:

1. `scripts/build.sh gateway` (or `.ps1`) → `devproof/devproofai-gateway:<git-describe>`.
2. `docker tag` that as `ghcr.io/devproof/devproofai-gateway:v0.1.2` —
   docker-desktop shares the daemon, `IfNotPresent` finds it, no pull.
3. `helm upgrade` the umbrella chart; gateway pod must go Ready with **no
   PyPI egress at boot**.
4. Live checks: callbacks import `asyncpg` (auth works — a `dpk_` key call
   succeeds, an invalid key 401s), a metered call lands in `gateway_usage`.
5. `helm lint` + render tests + the offline callback tests stay green.

BUILD.md known-gaps: remove the "asyncpg installed at container start" gap
note if present; the deployment comment about ensurepip goes away with the
template change.

## Error handling

Nothing new. A wrong base digest fails the build; a missing/broken asyncpg
fails gateway boot loudly (readiness probe never passes) — same failure
surface as today, moved earlier.

## Out of scope

- Pushing any image or chart to GHCR (next release does that).
- Removing the `devproofai-litellm` mirror from GHCR (harmless leftover).
- Any change to `custom_callbacks.py` or gateway config generation.
