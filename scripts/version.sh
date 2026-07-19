#!/usr/bin/env bash
# Build version = git describe: v0.1.0 on a tag, v0.1.0-14-ga1b2c3d between
# tags, -dirty appended on local modifications. Single source of truth is git
# tags — no version file to bump. (Reproducible-builds spec 2026-07-18.)
set -euo pipefail
cd "$(dirname "$0")/.."
git describe --tags --match "v*" --dirty 2>/dev/null \
  || echo "v0.0.0-$(git rev-list --count HEAD)-g$(git rev-parse --short HEAD)"
