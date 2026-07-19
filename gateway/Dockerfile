# LiteLLM proxy with asyncpg baked in: the stock image ships neither asyncpg
# nor pip in its venv, so the chart used to `ensurepip && pip install` at every
# pod boot — needing PyPI egress at runtime (the air-gap gap). Same commands,
# moved to build time. asyncpg pin = the version the runtime install resolved
# (verified in the live gateway pod 2026-07-19).
FROM ghcr.io/berriai/litellm:main-stable@sha256:a1745e629abfb17d434426ff48b115f54f4f4c4a0f5af241de569e93c63c411e

RUN python3 -m ensurepip && python3 -m pip install --no-cache-dir asyncpg==0.31.0

ARG DEVPROOF_VERSION=dev
ENV DEVPROOF_VERSION=${DEVPROOF_VERSION}
