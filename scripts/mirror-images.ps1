# Mirror the third-party images referenced in helm-charts/values.yaml to
# ghcr.io/devproof. These are NOT built by docker-bake.hcl / release.yml
# (which cover only the first-party images) — run this whenever a mirror
# tag in values.yaml changes. PowerShell twin of mirror-images.sh.
#
# Uses `docker buildx imagetools create`, which copies the FULL multi-arch
# manifest registry-to-registry (no local pull, no arch loss — amd64+arm64
# verified present on all four upstreams).
#
# Prereqs: docker login ghcr.io with a token that has write:packages.
# After the FIRST push of a new package, flip its visibility to public in
# the GitHub packages UI — GHCR defaults new packages to private.
$ErrorActionPreference = "Stop"

$Registry = if ($env:REGISTRY) { $env:REGISTRY } else { "ghcr.io/devproof" }

# upstream reference -> mirror name:tag (tag = what values.yaml pins)
$Mirrors = @(
    @{ Src = "minio/minio:RELEASE.2025-09-07T16-13-09Z";     Dst = "devproofai-minio:RELEASE.2025-09-07T16-13-09Z" }
    @{ Src = "postgres:17.10-alpine";                        Dst = "devproofai-postgres:17.10-alpine" }
    @{ Src = "ubuntu/squid:6.13-25.04_edge";                 Dst = "devproofai-squid:6.13" }
    @{ Src = "ghcr.io/defilantech/llmkube-controller:0.9.7"; Dst = "devproofai-llmkube-controller:0.9.7" }
)

# The source annotation makes GHCR list the package under the devproofai
# repo (the upstream images' own source labels point at THEIR repos).
# Caveat: minio/minio and ubuntu/squid ship Docker-format manifest lists,
# which cannot carry OCI annotations — buildx silently drops the flag there
# (it re-pushes the upstream list unchanged). Their packages were connected
# to the repo once (2026-07-20, via a hand-PUT annotated OCI index); the
# package-repo connection persists across future pushes, so re-runs of this
# script don't need to repeat it.
$SourceAnnotation = "index:org.opencontainers.image.source=https://github.com/devproof/devproofai"

foreach ($m in $Mirrors) {
    Write-Host "==> $($m.Src) -> $Registry/$($m.Dst)"
    docker buildx imagetools create --annotation $SourceAnnotation --tag "$Registry/$($m.Dst)" $m.Src
    if ($LASTEXITCODE -ne 0) { throw "mirror failed: $($m.Src)" }
}

Write-Host "Done. Verify anonymously with:"
Write-Host "  docker manifest inspect $Registry/devproofai-minio:RELEASE.2025-09-07T16-13-09Z"
