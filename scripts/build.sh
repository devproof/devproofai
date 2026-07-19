#!/usr/bin/env bash
# One-command reproducible build: all five images, version-stamped from git.
# Extra args pass through to bake (e.g. scripts/build.sh operator).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(scripts/version.sh)"
REVISION="$(git rev-parse HEAD)"
export VERSION REVISION
echo "devproof build ${VERSION} (${REVISION})"
docker buildx bake -f docker-bake.hcl "$@"
