// One build definition for local AND CI (reproducible-builds spec 2026-07-18).
// Local: scripts/build.sh   CI: .github/workflows/release.yml — the same file,
// so the two can't drift.
variable "VERSION"   { default = "dev" }
variable "REVISION"  { default = "" }
variable "REGISTRY"  { default = "devproof" }      // local builds; release.yml: ghcr.io/devproof (public GHCR — no pull limits)
variable "EXTRA_TAG" { default = "" }              // optional second tag (e.g. a short commit SHA)
variable "LATEST"    { default = "" }              // opt-in "latest" tag — unused; refs pin versions (decision 2026-07-19)

// Repo names carry the devproofai- prefix (Docker Hub account-wide naming
// convention, 2026-07-19): devproof/devproofai-<component>.
function "tags" {
  params = [name]
  result = compact([
    "${REGISTRY}/devproofai-${name}:${VERSION}",
    EXTRA_TAG != "" ? "${REGISTRY}/devproofai-${name}:${EXTRA_TAG}" : "",
    LATEST != "" ? "${REGISTRY}/devproofai-${name}:latest" : "",
  ])
}

target "_common" {
  args = { DEVPROOF_VERSION = "${VERSION}" }
  labels = {
    "org.opencontainers.image.version"  = "${VERSION}"
    "org.opencontainers.image.revision" = "${REVISION}"
    "org.opencontainers.image.source"   = "https://github.com/devproof/devproofai"
  }
}

group "default" {
  targets = ["operator", "control-plane", "console", "session-runner", "gateway"]
}

target "operator" {
  inherits   = ["_common"]
  context    = "operator"
  dockerfile = "Dockerfile"
  tags       = tags("operator")
}

target "control-plane" {
  inherits   = ["_common"]
  context    = "."
  dockerfile = "control-plane/Dockerfile"
  tags       = tags("control-plane")
}

target "console" {
  inherits   = ["_common"]
  context    = "console"
  dockerfile = "Dockerfile"
  tags       = tags("console")
}

target "session-runner" {
  inherits   = ["_common"]
  context    = "."
  dockerfile = "session-runner/Dockerfile"
  tags       = tags("session-runner")
}

target "gateway" {
  inherits   = ["_common"]
  context    = "gateway"
  dockerfile = "Dockerfile"
  tags       = tags("gateway")
}
