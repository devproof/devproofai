# LiteLLM proxy with asyncpg baked in: the stock image ships neither asyncpg
# nor pip in its venv, so the chart used to `ensurepip && pip install` at every
# pod boot — needing PyPI egress at runtime (the air-gap gap). Same commands,
# moved to build time. asyncpg is pinned exactly; 0.32.0 ships cp313 wheels,
# which is what the v1.109.1 base needs (wolfi + python-3.13).
#
# Pinned by VERSION TAG + digest (2026-11-17, was v1.106.0@sha256:2e4c0371…):
# `main-stable` and `v1.109.1` resolve to the same digest, and naming the
# version makes the Dockerfile say which LiteLLM this is. Re-pin both together.
FROM ghcr.io/berriai/litellm:v1.109.1@sha256:11175975a3093e05e92faee2fe2fe3412a3ae2fcaa849eb0fe25d5f0d8bcb2e9

RUN python3 -m ensurepip && python3 -m pip install --no-cache-dir asyncpg==0.32.0

ARG DEVPROOF_VERSION=dev
ENV DEVPROOF_VERSION=${DEVPROOF_VERSION}
