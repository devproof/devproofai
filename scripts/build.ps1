# One-command reproducible build — Windows/PowerShell twin of build.sh.
# Version semantics must stay in sync with scripts/version.sh.
# Extra args pass through to bake, e.g.: .\scripts\build.ps1 operator
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

# git describe prints to stderr when no tag matches; PS 5.1 turns redirected
# native stderr into ErrorRecords under Stop preference — relax around it.
$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$version = git describe --tags --match "v*" --dirty 2>$null
$ErrorActionPreference = $prev
if ($LASTEXITCODE -ne 0 -or -not $version) {
  $count = git rev-list --count HEAD
  $sha = git rev-parse --short HEAD
  $version = "v0.0.0-$count-g$sha"
}

$env:VERSION = $version
$env:REVISION = git rev-parse HEAD
Write-Host "devproof build $version ($env:REVISION)"
docker buildx bake -f docker-bake.hcl @args
exit $LASTEXITCODE
