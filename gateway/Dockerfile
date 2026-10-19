# LiteLLM proxy with asyncpg baked in: the stock image ships neither asyncpg
# nor pip in its venv, so the chart used to `ensurepip && pip install` at every
# pod boot — needing PyPI egress at runtime (the air-gap gap). Same commands,
# moved to build time. asyncpg pin = the version the runtime install resolved
# (verified in the live gateway pod 2026-07-19); 0.31.0 ships cp313 wheels, which
# is what the v1.106.0 base needs (wolfi + python-3.13).
#
# Pinned by VERSION TAG + digest (2026-10-19, was main-stable@sha256:a1745e62…,
# built 2026-07-19 off the v1.92/1.93 line): `main-stable` and `v1.106.0` resolve
# to the same digest, and naming the version makes the Dockerfile say which
# LiteLLM this is. Re-pin both together.
FROM ghcr.io/berriai/litellm:v1.106.0@sha256:2e4c0371f3a8c28e4da131d77abaa8341cd3b0c2fcc4d34d7c5900431af7b9d0

RUN python3 -m ensurepip && python3 -m pip install --no-cache-dir asyncpg==0.31.0

ARG DEVPROOF_VERSION=dev
ENV DEVPROOF_VERSION=${DEVPROOF_VERSION}
