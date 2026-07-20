# Changelog

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
