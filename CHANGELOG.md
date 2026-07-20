# Changelog

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
