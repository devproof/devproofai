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
#
# NOT mirrored: minio. It is AGPLv3, and mirroring makes us a REDISTRIBUTOR
# (AGPL §4/§6: license text, copyright notices and directions to the
# Corresponding Source must accompany the copy — and the source annotation
# this script stamps would point at devproofai, which carries none of it).
# values.yaml pulls it from quay.io/minio/minio instead — MinIO's own
# registry, no pull limits, so the mirror bought nothing. Weigh the licence
# before adding any copyleft image here; see THIRD-PARTY-NOTICES.md.
$Mirrors = @(
    @{ Src = "postgres:17.10-alpine";                        Dst = "devproofai-postgres:17.10-alpine" }
    @{ Src = "ubuntu/squid:6.13-25.04_edge";                 Dst = "devproofai-squid:6.13" }
    @{ Src = "ghcr.io/defilantech/llmkube-controller:0.9.7"; Dst = "devproofai-llmkube-controller:0.9.7" }
)

# The source annotation makes GHCR list the package under the devproofai
# repo (the upstream images' own source labels point at THEIR repos).
# buildx applies it only when the upstream is an OCI index (postgres,
# llmkube-controller); for a Docker-format manifest list (squid) it is
# silently dropped, so mirror-annotate.py re-PUTs those as annotated OCI
# indexes afterwards. Both steps are idempotent — every run reasserts the
# link instead of relying on a one-off manual fix.
$SourceUrl = "https://github.com/devproof/devproofai"
$SourceAnnotation = "index:org.opencontainers.image.source=$SourceUrl"
$Annotate = Join-Path $PSScriptRoot "mirror-annotate.py"

foreach ($m in $Mirrors) {
    Write-Host "==> $($m.Src) -> $Registry/$($m.Dst)"
    docker buildx imagetools create --annotation $SourceAnnotation --tag "$Registry/$($m.Dst)" $m.Src
    if ($LASTEXITCODE -ne 0) { throw "mirror failed: $($m.Src)" }
    python $Annotate "$Registry/$($m.Dst)" $SourceUrl
    if ($LASTEXITCODE -ne 0) { throw "annotate failed: $($m.Dst)" }
}

Write-Host "Done. Verify anonymously with:"
Write-Host "  docker manifest inspect $Registry/devproofai-postgres:17.10-alpine"
