# Devproof session runner: in-process agent loop (devproof_runner) +
# event-streaming wrapper. Build from the REPO ROOT:
#   docker build -f session-runner/Dockerfile -t devproof/session-runner:devNN .
FROM python:3.14-slim@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f

# Agent tooling: file-analysis CLIs (archives, curl, jq) + Node/npm so agents
# can do JS work and `npm install` in package-manager-enabled environments.
# (The runner itself is pure Python — Node is for the agent's own use only.)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    nodejs npm unzip zip gzip bzip2 xz-utils p7zip-full file jq curl \
    && rm -rf /var/lib/apt/lists/*

# All Python deps — runner loop (httpx/anyio), the default analysis stack, and
# the headless plotting stack (kaleido pinned <1: v1 needs external Chrome —
# which in turn holds plotly on 6.x, since plotly 7 refuses kaleido <1;
# excluded as GUI-bound/unmaintained: pyqtgraph, vispy, ggplot, cufflinks,
# chartify) — come from one fully-frozen requirements.txt (== pins incl.
# transitives, last re-resolved 2026-11-17 on Python 3.14 for dev57; wrapt is
# held on its stable release — formulaic's `>=1.17.0rc1` specifier otherwise
# lets pip pick a pre-release). Regenerate per BUILD.md
# "Updating pins"; never add loose specifiers here.
COPY session-runner/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

WORKDIR /app
COPY session-runner/runner.py .
# The agent loop rides next to runner.py — script dir is on sys.path, no install.
COPY session-runner/devproof_runner ./devproof_runner

# pip's "[notice] To update, run: pip install --upgrade pip" self-update nag
# lands in tool results as transcript noise — silence it for agent pip runs.
ENV PIP_DISABLE_PIP_VERSION_CHECK=1

# Build version (reproducible-builds spec 2026-07-18).
ARG DEVPROOF_VERSION=dev
ENV DEVPROOF_VERSION=${DEVPROOF_VERSION}

# Non-root; agent workspace under /work, session mounts under /mnt/session.
# /mnt/memory (memory stores) and /mnt/wiki (LLM wikis) are pre-created + chowned
# so the non-root agent can stage into them (/mnt itself is root-owned).
RUN useradd -m agent && mkdir -p /work /mnt/session/uploads /mnt/session/outputs /mnt/memory /mnt/wiki \
    && chown -R agent:agent /work /mnt/session /mnt/memory /mnt/wiki
USER agent
WORKDIR /work

ENTRYPOINT ["python", "/app/runner.py"]
