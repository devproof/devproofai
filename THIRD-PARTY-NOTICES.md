# Third-party notices

Devproof AI itself is licensed under the [Elastic License 2.0](LICENSE). This
file covers the third-party software the project **redistributes** — container
images republished under `ghcr.io/devproof/`, upstream code baked into images
this repo builds, and the packaged Helm dependency. Software that is merely
*referenced* (pulled by the user at install time from its own vendor registry)
is listed separately at the end, because no redistribution obligations attach
to us for it.

Each entry names the exact upstream reference the chart pins, so the
Corresponding Source of any redistributed component can be located from its
version alone.

**The bundled datastores are a local/demo convenience, not a dependency.**
PostgreSQL and MinIO ship enabled so a fresh `helm install` comes up with no
external prerequisites. Production installs are expected to turn both off and
use managed services — `postgres.enabled=false` + `externalDatabase.*` for the
database, `minio.enabled=false` + `s3.*` for object storage (any S3-compatible
endpoint, including AWS S3). With both disabled, neither image is deployed and
the corresponding entries below stop applying to that installation.

## Container images republished under ghcr.io/devproof

Copied byte-for-byte from upstream by `scripts/mirror-images.sh` (a
registry-to-registry manifest copy — the layers are unmodified). We mirror
these only to avoid Docker Hub pull limits.

| Mirror | Upstream image | Project & source | License |
| --- | --- | --- | --- |
| `devproofai-postgres:17.10-alpine` | `postgres:17.10-alpine` (Docker Official Image) | PostgreSQL — https://github.com/postgres/postgres · image: https://github.com/docker-library/postgres | [PostgreSQL License](https://www.postgresql.org/about/licence/) (BSD-style) |
| `devproofai-squid:6.13` | `ubuntu/squid:6.13-25.04_edge` | Squid — http://www.squid-cache.org/ · source: https://github.com/squid-cache/squid | GPL-2.0-or-later |
| `devproofai-llmkube-controller:0.9.7` | `ghcr.io/defilantech/llmkube-controller:0.9.7` | LLMKube — https://github.com/defilantech/LLMKube | Apache-2.0 |

**Squid (GPL-2.0-or-later).** We redistribute an unmodified binary
distribution. The Corresponding Source for release 6.13 is published by the
Squid project at http://www.squid-cache.org/Versions/ and, for the Ubuntu
packaging in this image, via `apt-get source squid` on Ubuntu 25.04. We make
no modifications to Squid; the per-environment proxy configuration Devproof
generates (`control-plane/src/egress.ts`) is a configuration file consumed at
runtime, not a derivative of Squid's source.

## Upstream code baked into images this repo builds

| Our image | Bundled upstream | Project & source | License |
| --- | --- | --- | --- |
| `devproofai-gateway` | `ghcr.io/berriai/litellm:main-stable` (digest-pinned base image; see `gateway/Dockerfile`) | LiteLLM — https://github.com/BerriAI/litellm | MIT |

`devproofai-gateway` adds Devproof's own callback module and `asyncpg` on top
of the LiteLLM base image; LiteLLM itself is unmodified.

## Packaged Helm dependency

| Dependency | Version | Source | License |
| --- | --- | --- | --- |
| `llmkube` | 0.9.7 | https://github.com/defilantech/LLMKube (chart repo: https://defilantech.github.io/LLMKube) | Apache-2.0 |

The chart tarball is vendored into the released `devproofai-helm` package by
`helm dependency build`. `scripts/patch-llmkube-schema.sh` modifies **only**
the packaged chart's `values.schema.json` (relaxing `additionalProperties` so
subchart-injected keys validate); no Go source or template logic is altered.

## Referenced, not redistributed

Pulled by the cluster directly from the vendor's own registry at install time.
Devproof AI never copies, republishes, or modifies these — it only names them
in `helm-charts/values.yaml`, and each remains subject to its own license
between its publisher and the operator who deploys it.

| Image | Project & source | License |
| --- | --- | --- |
| `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` | MinIO — https://github.com/minio/minio | AGPL-3.0-or-later |
| `docker.io/curlimages/curl:8.18.0` (LLMKube init container) | curl — https://github.com/curl/curl | curl license (MIT-style) |
| llama.cpp engine images (selected by LLMKube per deployment) | llama.cpp — https://github.com/ggml-org/llama.cpp | MIT |

**MinIO (AGPL-3.0-or-later).** Deliberately *not* mirrored under
`ghcr.io/devproof` (decision 2026-07-21): republishing an AGPL binary would
make this project a redistributor, with the notice and Corresponding Source
obligations of AGPL §4/§6. quay.io is MinIO's official registry and imposes no
pull limits, so pulling from it directly costs nothing and keeps the boundary
clean. Devproof AI's control plane communicates with MinIO exclusively over
the S3 HTTP API, as a separate process in a separate pod — an arm's-length
aggregation, not a combined work. MinIO is also optional: set
`minio.enabled=false` and point `s3.endpoint` at any S3-compatible store.
Do not add MinIO to `scripts/mirror-images.sh`.

## Reporting

Believe something here is incomplete or wrong? Open an issue at
https://github.com/devproof/devproofai/issues.
