# Reproducible Builds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Same commit ⇒ same working build locally and in GitHub Actions for all five components (operator, control-plane, console, session-runner images + devproofai-client wheel), with a git-describe version baked into every image, shown in the console nav footer, and documented in a repo-root BUILD.md.

**Architecture:** A repo-root `docker-bake.hcl` is the single build definition consumed identically by `scripts/build.sh` (local) and `.github/workflows/ci.yml` (CI). Version = `git describe --tags --dirty` flows in as build arg `DEVPROOF_VERSION` → `ENV` + OCI labels. All base images pinned by digest; all deps from lockfiles (`go.sum`, `package-lock.json`, a new frozen `session-runner/requirements.txt`). Spec: `docs/superpowers/specs/2026-07-18-reproducible-builds-design.md`.

**Tech Stack:** docker buildx bake (HCL), GitHub Actions, git describe, setuptools-scm, Next.js standalone output, Go `-ldflags -X`.

## Global Constraints

- Host is Windows; run all shell steps in **Git Bash** (the Bash tool), not PowerShell, unless stated. Docker is docker-desktop.
- **Never leave a `<digest>` placeholder in a committed Dockerfile** — every `FROM image:tag@sha256:…` must carry the real digest resolved in that task's steps.
- ZERO third-party AI references in `session-runner/` sources (standing user decision 2026-07-17).
- Don't touch: the `devNN` runner-tag workflow semantics, `--test-concurrency=1`, the CP migration behaviour, or any "don't regress" invariant in `CLAUDE.md`.
- Comments follow repo style: state constraints/decisions, never narrate the change.
- Every commit message ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- This repo is CRLF; after any bulk line-deletion via Edit, re-check `git diff` for accidentally joined lines.
- The version string must never be computed with `Date`/timestamps — it is pure `git describe`.

---

### Task 1: Version script + initial git tag

**Files:**
- Create: `scripts/version.sh`

**Interfaces:**
- Produces: `scripts/version.sh` — prints a single-line version to stdout: `git describe --tags --dirty` (e.g. `v0.1.0`, `v0.1.0-14-ga1b2c3d`, `v0.1.0-14-ga1b2c3d-dirty`), falling back to `v0.0.0-<count>-g<shortsha>` when no tag exists. Consumed by `scripts/build.sh` (Task 8) and CI (Task 10).

- [ ] **Step 1: Write `scripts/version.sh`**

```sh
#!/usr/bin/env bash
# Build version = git describe: v0.1.0 on a tag, v0.1.0-14-ga1b2c3d between
# tags, -dirty appended on local modifications. Single source of truth is git
# tags — no version file to bump. (Reproducible-builds spec 2026-07-18.)
set -euo pipefail
cd "$(dirname "$0")/.."
git describe --tags --dirty 2>/dev/null \
  || echo "v0.0.0-$(git rev-list --count HEAD)-g$(git rev-parse --short HEAD)"
```

Then: `chmod +x scripts/version.sh` (and `git update-index --chmod=+x scripts/version.sh` after `git add`, so the exec bit survives on Linux CI — Windows working trees don't store it).

- [ ] **Step 2: Verify the no-tag fallback**

Run: `scripts/version.sh`
Expected (no tags exist yet): `v0.0.0-<some count>-g<7-char sha>` — e.g. `v0.0.0-312-g1a14a11`.

- [ ] **Step 3: Commit, then create the initial annotated tag**

```bash
git add scripts/version.sh && git update-index --chmod=+x scripts/version.sh
git commit -m "build: version.sh — git-describe build version

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag -a v0.1.0 -m "v0.1.0 — first versioned build"
```

- [ ] **Step 4: Verify describe now resolves the tag**

Run: `scripts/version.sh`
Expected: exactly `v0.1.0` (clean tree, on the tag). Then `touch x.tmp && scripts/version.sh && rm x.tmp` — still `v0.1.0` (describe's `-dirty` only reacts to tracked files; that's fine).

Do NOT push the tag yet — pushed together with everything in Task 11.

---

### Task 2: Control-plane `GET /v1/version` + test

**Files:**
- Modify: `control-plane/src/agents-api.ts` (insert directly above the `app.get("/v1/settings", …)` route at ~line 1030)
- Test: `control-plane/test/version.test.ts`

**Interfaces:**
- Produces: `GET /v1/version` ⇒ `200 {"version": string}` — `process.env.DEVPROOF_VERSION`, fallback `"dev"`. Consumed by the console layout (Task 3). Not workspace-scoped, no auth (same as `/v1/settings`).

- [ ] **Step 1: Write the failing test**

Create `control-plane/test/version.test.ts`. The `build()` helper must mirror the one in `control-plane/test/appearance-settings.test.ts` (lines ~40–57) **verbatim except the test-name prefix in `mkdtempSync`** — same imports, same `registerAgentRoutes(app, repo, {} as unknown as Orchestrator, files)` call, since that registers the whole agents-api surface including the new route. The route touches no DB, so no `{ skip: !available }` guard is needed on these tests:

```ts
// GET /v1/version: env-driven build version, "dev" fallback out-of-cluster
// (reproducible-builds spec 2026-07-18).
import { test } from "node:test";
import assert from "node:assert/strict";
// … copy the remaining imports + the build() helper from
// test/appearance-settings.test.ts, changing the mkdtemp prefix to "version-".

test("GET /v1/version returns the baked env version", async () => {
  process.env.DEVPROOF_VERSION = "v9.9.9-test";
  const { app, cleanup } = await build();
  try {
    const res = await app.inject({ method: "GET", url: "/v1/version" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { version: "v9.9.9-test" });
  } finally {
    delete process.env.DEVPROOF_VERSION;
    await app.close();
    cleanup();
  }
});

test("GET /v1/version falls back to dev without the env", async () => {
  delete process.env.DEVPROOF_VERSION;
  const { app, cleanup } = await build();
  try {
    const res = await app.inject({ method: "GET", url: "/v1/version" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { version: "dev" });
  } finally {
    await app.close();
    cleanup();
  }
});
```

(`node --test` runs tests within a file serially, so the env mutation can't race.)

- [ ] **Step 2: Run the test — expect failure**

Run (from `control-plane/`): `node --test test/version.test.ts`
Expected: both tests FAIL with 404 responses. (If Node refuses the `.ts` file, fall back to `npm test` and look for the two failing `version` tests.)

- [ ] **Step 3: Add the route**

In `control-plane/src/agents-api.ts`, directly above the `// ── Global cost settings` comment block:

```ts
  // ── Build version (reproducible-builds spec 2026-07-18) — baked into every
  // image as DEVPROOF_VERSION; out-of-cluster dev has no env ⇒ "dev".
  app.get("/v1/version", async () => ({
    version: process.env.DEVPROOF_VERSION || "dev",
  }));

```

- [ ] **Step 4: Run the test — expect pass**

Run: `node --test test/version.test.ts` → both PASS.
Then the full gate: `npx tsc --noEmit` (clean) and `npm test` (green — needs the dev Postgres on 15432 up).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/test/version.test.ts
git commit -m "feat(cp): GET /v1/version — build version endpoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Console nav-footer version display

**Files:**
- Modify: `console/app/layout.tsx` (the `Promise.allSettled` block, lines 19–22, and the `<Nav …>` render)
- Modify: `console/app/nav.tsx` (props + footer element before `</nav>`)
- Modify: `console/app/globals.css` (one rule, append near the other `.sidebar` rules)

**Interfaces:**
- Consumes: `GET /v1/version` from Task 2 via the existing `wsGet` helper (`console/app/lib/api.ts`).
- Produces: `Nav` gains a required prop `version: { cp: string; console: string }`.

- [ ] **Step 1: Fetch the version in `layout.tsx`**

Extend the existing parallel block — add a third entry to the `Promise.allSettled` array and a fallback below (same degrade pattern as workspaces/theme):

```ts
  const [wsRes, setRes, verRes] = await Promise.allSettled([
    wsGet<{ workspaces: any[] }>("/v1/workspaces"),
    wsGet<{ appearance?: { theme?: string } }>("/v1/settings"),
    wsGet<{ version: string }>("/v1/version"),
  ]);
```

and after the `theme` line:

```ts
  // Version footer (reproducible-builds spec 2026-07-18): CP version from the
  // API, console's own from the image env — both "dev" out-of-cluster.
  const version = {
    cp: (verRes.status === "fulfilled" && verRes.value?.version) || "dev",
    console: process.env.DEVPROOF_VERSION || "dev",
  };
```

Then pass it: `<Nav workspaces={workspaces} current={current} version={version} />`.

- [ ] **Step 2: Render the footer in `nav.tsx`**

Change the props signature:

```ts
export function Nav({ workspaces, current, version }: { workspaces: { id: string; name: string; status: string }[]; current: string; version: { cp: string; console: string } }) {
```

Immediately before the closing `</nav>`, after the groups `.map()` block:

```tsx
      <div className="nav-version" title={`control plane ${version.cp} · console ${version.console}`}>
        {version.cp}{version.console !== version.cp ? ` · ui ${version.console}` : ""}
      </div>
```

- [ ] **Step 3: Style it**

Append to `console/app/globals.css`, after the existing `.sidebar` rules (~line 100):

```css
.sidebar .nav-version { padding: 18px 16px 0; font-size: 11px; color: var(--muted); letter-spacing: .03em; }
```

- [ ] **Step 4: Verify with a production build**

```bash
cd console && npx next build && npx next start -p 7090
```

(Stop any running console first; per the console-rebuild memory, a build under a running `next start` pins stale chunks.) Open/curl `http://localhost:7090` — the nav bottom shows `dev` (CP up or down; with the CP running it still says `dev` because the tsx process has no `DEVPROOF_VERSION`). `npx tsc --noEmit` in `console/` is clean.

- [ ] **Step 5: Commit**

```bash
git add console/app/layout.tsx console/app/nav.tsx console/app/globals.css
git commit -m "feat(console): build-version line in the nav footer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Operator version stamp + Dockerfile

**Files:**
- Modify: `operator/cmd/main.go` (version var + startup log)
- Create: `operator/Dockerfile`
- Create: `operator/.dockerignore`

**Interfaces:**
- Consumes: build arg `DEVPROOF_VERSION` (set by bake, Task 8; default `dev`).
- Produces: image `devproof/operator` — static binary at `/devproof-operator`, version via `-ldflags "-X main.version=…"`, logged at startup.

- [ ] **Step 1: Add the version var + log to `main.go`**

After the import block:

```go
// Overridden at build time: -ldflags "-X main.version=<git describe>".
var version = "dev"
```

In `main()`, directly after `setupLog := ctrl.Log.WithName("setup")`:

```go
	setupLog.Info("devproof operator", "version", version)
```

- [ ] **Step 2: Verify with go vet/test/run**

From `operator/` (Go lives at `~/sdk/go/bin`, not on PATH):

```bash
export PATH="$HOME/sdk/go/bin:$PATH"
go vet ./... && go test ./...
go run -ldflags "-X main.version=v-test" ./cmd 2>&1 | head -3
```

Expected: vet/test clean; the run's first log lines include `devproof operator` with `"version": "v-test"` (then it may proceed or fail on cluster access — irrelevant; Ctrl-C).

- [ ] **Step 3: Resolve base-image digests**

```bash
docker buildx imagetools inspect golang:1.26-bookworm | head -3
docker buildx imagetools inspect gcr.io/distroless/static-debian12:nonroot | head -3
```

Note each `Digest: sha256:…` line — substitute them for `<golang-digest>` / `<distroless-digest>` below.

- [ ] **Step 4: Write `operator/Dockerfile` and `.dockerignore`**

`operator/.dockerignore`:

```
devproof-operator-dev.exe
config/
```

`operator/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
# Build: docker build -t devproof/operator:dev operator
# Deterministic: base pinned by digest, deps by go.sum, -trimpath build.
FROM golang:1.26-bookworm@sha256:<golang-digest> AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY api ./api
COPY cmd ./cmd
COPY internal ./internal
ARG DEVPROOF_VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X main.version=${DEVPROOF_VERSION}" \
      -o /out/devproof-operator ./cmd

FROM gcr.io/distroless/static-debian12:nonroot@sha256:<distroless-digest>
COPY --from=build /out/devproof-operator /devproof-operator
ARG DEVPROOF_VERSION=dev
ENV DEVPROOF_VERSION=${DEVPROOF_VERSION}
ENTRYPOINT ["/devproof-operator"]
```

- [ ] **Step 5: Build and verify the image**

```bash
docker build --build-arg DEVPROOF_VERSION=v-img-test -t devproof/operator:plan-test operator
docker run --rm devproof/operator:plan-test 2>&1 | head -3
```

Expected: build succeeds; first log lines show `"version": "v-img-test"` (then a kubeconfig error and exit — expected outside a cluster).

- [ ] **Step 6: Commit**

```bash
git add operator/cmd/main.go operator/Dockerfile operator/.dockerignore
git commit -m "feat(operator): version stamp + reproducible image build

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Session-runner — pinned requirements.txt + digest-pinned base

**Files:**
- Create: `session-runner/requirements.txt` (frozen from the dev50 image — NOT hand-written)
- Modify: `session-runner/Dockerfile` (lines 4, 13–28: base digest, pip layers → one `-r requirements.txt` layer, version env)

**Interfaces:**
- Consumes: the existing `devproof/session-runner:dev50` image (freeze source) and build arg `DEVPROOF_VERSION`.
- Produces: byte-identical Python dep set on every build; `ENV DEVPROOF_VERSION` in the image. Runtime behaviour otherwise unchanged.

- [ ] **Step 1: Freeze the exact working dep set from dev50**

```bash
docker run --rm --entrypoint pip devproof/session-runner:dev50 freeze > session-runner/requirements.txt
head -5 session-runner/requirements.txt && grep -c "==" session-runner/requirements.txt
```

Expected: every line `name==version`; spot-check it contains `httpx==`, `anyio==`, `pandas==`, `plotly==`, `kaleido==0.` (must be 0.x — the <1 pin), `holoviews==`, `datashader==`. If `dev50` is missing locally, build it first per the CLAUDE.md line (`docker build -f session-runner/Dockerfile -t devproof/session-runner:dev50 .` from repo root — do this BEFORE editing the Dockerfile).

- [ ] **Step 2: Resolve the base digest**

```bash
docker buildx imagetools inspect python:3.12-slim | head -3
```

Note the `Digest: sha256:…` for `<python-digest>` below.

- [ ] **Step 3: Rewrite the Dockerfile's dep layers**

Line 4 becomes:

```dockerfile
FROM python:3.12-slim@sha256:<python-digest>
```

Replace lines 13–28 (the three `RUN pip install` blocks AND their comment blocks — keep the apt block above untouched) with:

```dockerfile
# All Python deps — runner loop (httpx/anyio), the default analysis stack, and
# the headless plotting stack (kaleido pinned <1: v1 needs external Chrome;
# excluded as GUI-bound/unmaintained: pyqtgraph, vispy, ggplot, cufflinks,
# chartify) — come from one fully-frozen requirements.txt (== pins incl.
# transitives, frozen from the dev50 image). Regenerate per BUILD.md
# "Updating pins"; never add loose specifiers here.
COPY session-runner/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt
```

After the existing `ENV PIP_DISABLE_PIP_VERSION_CHECK=1` line add:

```dockerfile
# Build version (reproducible-builds spec 2026-07-18).
ARG DEVPROOF_VERSION=dev
ENV DEVPROOF_VERSION=${DEVPROOF_VERSION}
```

- [ ] **Step 4: Build as dev51 and verify parity**

From the repo root:

```bash
docker build -f session-runner/Dockerfile --build-arg DEVPROOF_VERSION=v-img-test -t devproof/session-runner:dev51 .
docker run --rm --entrypoint python devproof/session-runner:dev51 -c "import httpx, anyio, pandas, plotly, kaleido, holoviews, datashader; import os; print('ok', os.environ['DEVPROOF_VERSION'])"
docker run --rm --entrypoint pip devproof/session-runner:dev51 freeze | diff - session-runner/requirements.txt && echo FROZEN-IDENTICAL
```

Expected: `ok v-img-test` and `FROZEN-IDENTICAL`. Also run the suite against the new image via bind mount (the 3 Delegate path tests pass in-image):

```bash
docker run --rm --entrypoint python -w /app -v "$(pwd)/session-runner/tests:/app/tests" devproof/session-runner:dev51 -m unittest discover -s tests -p "test_*.py"
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add session-runner/requirements.txt session-runner/Dockerfile
git commit -m "build(runner): pin base by digest + freeze all pip deps (dev51)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Control-plane Dockerfile

**Files:**
- Create: `control-plane/Dockerfile`
- Create: `.dockerignore` (repo root — the CP and session-runner builds share the root context)

**Interfaces:**
- Consumes: build arg `DEVPROOF_VERSION`; repo-root build context (main.ts resolves `../../catalog/models.yaml` relative to `src/`, db.ts resolves `../sql` — the image must preserve the `control-plane/` + `catalog/` layout under `/app`).
- Produces: image `devproof/control-plane` listening on 7080, runtime `npx tsx src/main.ts` (same as dev — deliberately no compile step).

- [ ] **Step 1: Resolve the node base digest**

```bash
docker buildx imagetools inspect node:22-slim | head -3
```

Note `<node-digest>` (reused in Task 7 — record it).

- [ ] **Step 2: Write the Dockerfile + .dockerignore**

`control-plane/.dockerignore` (context is the repo root, so this must live at the ROOT as patterns below — instead create/extend a repo-root `.dockerignore`):

At the repo root create `.dockerignore` (shared by the CP and session-runner builds, both root-context):

```
**/node_modules
**/.next
**/__pycache__
console/
operator/
tmp/
docs/
*.log
*.err
control-plane/cp*.log
control-plane/cp*.err.log
session-runner;C/
```

`control-plane/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
# Build from the REPO ROOT (src/main.ts reads ../../catalog/*.yaml):
#   docker build -f control-plane/Dockerfile -t devproof/control-plane:dev .
# Deterministic: base pinned by digest, deps by package-lock via npm ci.
FROM node:22-slim@sha256:<node-digest>
WORKDIR /app/control-plane
COPY control-plane/package.json control-plane/package-lock.json ./
# npm ci with dev deps: tsx (the runtime) is a devDependency.
RUN npm ci
COPY control-plane/tsconfig.json ./
COPY control-plane/src ./src
COPY control-plane/sql ./sql
COPY catalog /app/catalog
ARG DEVPROOF_VERSION=dev
ENV DEVPROOF_VERSION=${DEVPROOF_VERSION} NODE_ENV=production
EXPOSE 7080
CMD ["npx", "tsx", "src/main.ts"]
```

- [ ] **Step 3: Build and verify**

```bash
docker build -f control-plane/Dockerfile --build-arg DEVPROOF_VERSION=v-img-test -t devproof/control-plane:plan-test .
docker run --rm --entrypoint node devproof/control-plane:plan-test -e "console.log(process.env.DEVPROOF_VERSION); require('node:fs').accessSync('/app/catalog/models.yaml'); require('node:fs').accessSync('/app/control-plane/sql'); console.log('layout ok')"
```

Expected: `v-img-test` then `layout ok`. Best-effort full-boot check (may fail on kube access — that's a deploy concern, not a build failure; note the outcome for BUILD.md):

```bash
docker run --rm -e DEVPROOF_DATABASE_URL=postgres://devproof:devproof-dev@host.docker.internal:15432/devproof -p 17080:7080 devproof/control-plane:plan-test &
sleep 8 && curl -s http://localhost:17080/v1/version; docker ps -q --filter ancestor=devproof/control-plane:plan-test | xargs -r docker stop
```

Expected if boot tolerates no-cluster: `{"version":"v-img-test"}`.

- [ ] **Step 4: Commit**

```bash
git add control-plane/Dockerfile .dockerignore
git commit -m "build(cp): reproducible control-plane image (repo-root context)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Console standalone Dockerfile

**Files:**
- Modify: `console/next.config.ts` (add `output: "standalone"`)
- Create: `console/Dockerfile`
- Create: `console/.dockerignore`

**Interfaces:**
- Consumes: `<node-digest>` from Task 6; build args `DEVPROOF_VERSION` and `DEVPROOF_API` (the `/api` rewrite target is baked at build time by `next.config.ts` — default `http://127.0.0.1:7080`).
- Produces: image `devproof/console` on port 7090 (`node server.js`, standalone output).

- [ ] **Step 1: Add standalone output**

In `console/next.config.ts`, inside `nextConfig`:

```ts
  // Standalone server bundle for the Docker image (reproducible-builds spec
  // 2026-07-18); local `next start` dev flow is unaffected.
  output: "standalone",
```

- [ ] **Step 2: Write `console/.dockerignore` and `console/Dockerfile`**

`console/.dockerignore`:

```
node_modules
.next
```

`console/Dockerfile` (context is `console/`; substitute the SAME `<node-digest>` as Task 6):

```dockerfile
# syntax=docker/dockerfile:1
# Build: docker build -t devproof/console:dev console
# NOTE: next/font/google downloads IBM Plex at build time — needs network
# egress to Google Fonts (documented gap in BUILD.md).
FROM node:22-slim@sha256:<node-digest> AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# /api rewrite target — baked into the route manifest at build time.
ARG DEVPROOF_API=http://127.0.0.1:7080
ENV DEVPROOF_API=${DEVPROOF_API}
RUN npx next build

FROM node:22-slim@sha256:<node-digest>
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
ARG DEVPROOF_VERSION=dev
ENV DEVPROOF_VERSION=${DEVPROOF_VERSION} PORT=7090 HOSTNAME=0.0.0.0
EXPOSE 7090
CMD ["node", "server.js"]
```

- [ ] **Step 3: Verify the local flow still works, then the image**

```bash
cd console && npx next build && cd ..
docker build --build-arg DEVPROOF_VERSION=v-img-test -t devproof/console:plan-test console
docker run --rm -d -p 17090:7090 --name console-plan-test devproof/console:plan-test
sleep 3 && curl -s http://localhost:17090/ | grep -o "v-img-test" | head -1; docker stop console-plan-test
```

Expected: local build still green; curl output contains `v-img-test` (the nav footer, server-rendered — CP unreachable from the container is fine, everything degrades). If the footer shows `dev · ui v-img-test` instead, that's also a pass (CP fell back, console env won) — the grep still matches.

- [ ] **Step 4: Commit**

```bash
git add console/next.config.ts console/Dockerfile console/.dockerignore
git commit -m "build(console): standalone output + reproducible image

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: docker-bake.hcl + build.sh — the shared entrypoint

**Files:**
- Create: `docker-bake.hcl`
- Create: `scripts/build.sh`

**Interfaces:**
- Consumes: the four Dockerfiles (Tasks 4–7), `scripts/version.sh` (Task 1).
- Produces: `docker buildx bake` variables `VERSION`, `REVISION`, `REGISTRY` (default `devproof`), `EXTRA_TAG` (default empty; CI sets short SHA), `LATEST` (default empty; CI main sets `latest`). Targets: `operator`, `control-plane`, `console`, `session-runner`. Consumed verbatim by CI (Task 10).

- [ ] **Step 1: Write `docker-bake.hcl`**

```hcl
// One build definition for local AND CI (reproducible-builds spec 2026-07-18).
// Local: scripts/build.sh   CI: .github/workflows/ci.yml — the same file, so
// the two can't drift.
variable "VERSION"   { default = "dev" }
variable "REVISION"  { default = "" }
variable "REGISTRY"  { default = "devproof" }      // CI: ghcr.io/devproof
variable "EXTRA_TAG" { default = "" }              // CI: short commit SHA
variable "LATEST"    { default = "" }              // CI main: "latest"

function "tags" {
  params = [name]
  result = compact([
    "${REGISTRY}/${name}:${VERSION}",
    EXTRA_TAG != "" ? "${REGISTRY}/${name}:${EXTRA_TAG}" : "",
    LATEST != "" ? "${REGISTRY}/${name}:latest" : "",
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
  targets = ["operator", "control-plane", "console", "session-runner"]
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
```

- [ ] **Step 2: Write `scripts/build.sh`**

```sh
#!/usr/bin/env bash
# One-command reproducible build: all four images, version-stamped from git.
# Extra args pass through to bake (e.g. scripts/build.sh operator).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(scripts/version.sh)"
REVISION="$(git rev-parse HEAD)"
export VERSION REVISION
echo "devproof build ${VERSION} (${REVISION})"
docker buildx bake -f docker-bake.hcl "$@"
```

`chmod +x scripts/build.sh` + `git update-index --chmod=+x scripts/build.sh` after adding.

- [ ] **Step 3: Full local build + label/env verification**

```bash
scripts/build.sh
docker image ls "devproof/*" | head -8
V=$(scripts/version.sh)
docker inspect "devproof/operator:${V}" --format '{{index .Config.Labels "org.opencontainers.image.version"}} {{.Config.Env}}' | head -1
```

Expected: all four targets build (console/session-runner take minutes); four images tagged `devproof/<name>:<version>` (note: with uncommitted changes the tag ends `-dirty` — that's correct); inspect shows the version label AND `DEVPROOF_VERSION=<version>` in env. Spot-check the other three images' labels the same way.

- [ ] **Step 4: Commit**

```bash
git add docker-bake.hcl scripts/build.sh && git update-index --chmod=+x scripts/build.sh
git commit -m "build: docker-bake.hcl + build.sh — single local/CI build entrypoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: devproofai-client — setuptools-scm versioning + build

**Files:**
- Modify: `devproofai-client/pyproject.toml`

**Interfaces:**
- Consumes: git tags from Task 1 (`v0.1.0`); setuptools-scm maps describe → PEP 440 (`0.1.0` on tag, `0.1.1.devN+g<sha>` between tags).
- Produces: `python -m build` ⇒ `dist/*.whl` + `dist/*.tar.gz` with the scm version. CI job (Task 10) runs the same.

- [ ] **Step 1: Rewrite `pyproject.toml`**

```toml
[project]
name = "devproofai-client"
dynamic = ["version"]
description = "Python client for the Devproof AI platform (managed agents on self-hosted models)"
requires-python = ">=3.10"
dependencies = ["httpx>=0.27"]

[build-system]
requires = ["setuptools>=68", "setuptools-scm>=8"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["devproof*"]

# Version from git tags (vX.Y.Z), shared with the image builds — the client
# lives in a subdir of the repo, hence root = "..".
[tool.setuptools_scm]
root = ".."
```

- [ ] **Step 2: Build and verify the version**

```bash
cd devproofai-client
python -m pip install --quiet build setuptools-scm
python -m build
ls dist/
```

Expected: a wheel + sdist named `devproofai_client-0.1.1.devN+g<sha>...` (or `-0.1.0` if HEAD is exactly the tag). If `python` is not on PATH in Git Bash, use `py -3` for all three commands.

- [ ] **Step 3: Ignore dist output + commit**

Ensure `devproofai-client/dist/` and `*.egg-info` are git-ignored (add to the repo `.gitignore` if not already covered), then:

```bash
git add devproofai-client/pyproject.toml .gitignore
git commit -m "build(client): version from git tags via setuptools-scm

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `docker-bake.hcl` variables (Task 8), `scripts/version.sh` (Task 1). CP tests reach Postgres via the default URL `postgres://devproof:devproof-dev@127.0.0.1:15432/devproof` (db.ts default) — the service container maps `15432:5432`, so NO env var is needed.
- Produces: on PR — tests + image builds; on push to main — additionally pushes `ghcr.io/devproof/<name>:{<version>, <short-sha>, latest}`.

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
# Reproducible builds CI (spec 2026-07-18). Images build via the SAME
# docker-bake.hcl as scripts/build.sh — keep it that way.
name: ci

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  packages: write

jobs:
  operator:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: operator } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version-file: operator/go.mod }
      - run: go vet ./...
      - run: go test ./...

  control-plane:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: devproof
          POSTGRES_PASSWORD: devproof-dev
          POSTGRES_DB: devproof
        # Same port as the dev cluster's localhost-lb, so db.ts's default
        # connection string works unchanged.
        ports: ["15432:5432"]
        options: >-
          --health-cmd "pg_isready -U devproof"
          --health-interval 5s --health-timeout 5s --health-retries 20
    defaults: { run: { working-directory: control-plane } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: control-plane/package-lock.json
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm test

  session-runner:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: session-runner } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install "httpx>=0.27" "anyio>=4"
      - run: python -m unittest discover -s tests -p "test_*.py"

  client:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: devproofai-client } }
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # setuptools-scm needs tags
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install build
      - run: python -m build
      - uses: actions/upload-artifact@v4
        with: { name: devproofai-client-dist, path: devproofai-client/dist/ }

  images:
    needs: [operator, control-plane, session-runner, client]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # git describe needs tags + history
      - uses: docker/setup-buildx-action@v3
      - id: v
        run: |
          echo "version=$(scripts/version.sh)" >> "$GITHUB_OUTPUT"
          echo "sha=$(git rev-parse --short HEAD)" >> "$GITHUB_OUTPUT"
      - if: github.event_name == 'push'
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: bake (PRs build, main builds + pushes)
        env:
          VERSION: ${{ steps.v.outputs.version }}
          REVISION: ${{ github.sha }}
        run: |
          if [ "${{ github.event_name }}" = "push" ]; then
            REGISTRY=ghcr.io/devproof EXTRA_TAG="${{ steps.v.outputs.sha }}" LATEST=latest \
              docker buildx bake --push
          else
            docker buildx bake
          fi
```

- [ ] **Step 2: Static validation**

`docker buildx bake --print` from the repo root exits 0 (validates the HCL the workflow consumes). Optionally `actionlint` if installed; otherwise rely on the live run in Task 11.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: build + test all components; push images to GHCR on main

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Live verification happens in Task 11 (needs the push).

---

### Task 11: BUILD.md, CLAUDE.md touch-ups, push + live CI verification

**Files:**
- Create: `BUILD.md` (repo root — exact name per user request)
- Modify: `CLAUDE.md` (two one-line touches, listed below)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write `BUILD.md`**

```markdown
# Building Devproof AI

Reproducible builds: the same commit produces the same working build locally
and in CI. Spec: `docs/superpowers/specs/2026-07-18-reproducible-builds-design.md`.

## TL;DR

    scripts/build.sh            # all four images, version-stamped
    scripts/build.sh console    # just one target

Requires: Docker (buildx — docker-desktop has it), Git Bash on Windows.
The Python client: `cd devproofai-client && python -m build` (needs
`pip install build`).

## Version scheme

`scripts/version.sh` = `git describe --tags --dirty`:

| State | Version |
|---|---|
| on tag `v0.1.0`, clean | `v0.1.0` |
| 14 commits later | `v0.1.0-14-ga1b2c3d` |
| uncommitted changes | `…-dirty` |

Release = push an annotated tag (`git tag -a v0.2.0 -m "…" && git push origin v0.2.0`).
The version rides into every image as build arg `DEVPROOF_VERSION` →
`ENV DEVPROOF_VERSION` + the `org.opencontainers.image.version` label, and:

- operator: also `-ldflags -X main.version=…`, logged at startup
- control-plane: served at `GET /v1/version` (no env ⇒ `"dev"`)
- console: shown in the left-nav footer (CP version, plus `· ui <v>` if the
  console image differs)
- devproofai-client: setuptools-scm maps the same tags to PEP 440
  (`0.1.0` on tag, `0.1.1.devN+g<sha>` between tags)

## One definition, two consumers

`docker-bake.hcl` defines all four image targets. `scripts/build.sh` (local)
and `.github/workflows/ci.yml` (CI) both run `docker buildx bake` against it —
never encode build steps anywhere else, or local and CI drift.

Bake variables: `VERSION`, `REVISION` (set by build.sh/CI), `REGISTRY`
(default `devproof`; CI uses `ghcr.io/devproof`), `EXTRA_TAG` (CI: short SHA),
`LATEST` (CI main: `latest`).

## Per-component builds

| Target | Context | Dockerfile | Notes |
|---|---|---|---|
| operator | `operator/` | `operator/Dockerfile` | static Go, `-trimpath`, distroless |
| control-plane | repo root | `control-plane/Dockerfile` | needs `catalog/` in context; runtime = tsx, same as dev |
| console | `console/` | `console/Dockerfile` | Next standalone; `DEVPROOF_API` build arg bakes the `/api` rewrite target |
| session-runner | repo root | `session-runner/Dockerfile` | dev tags stay `devNN` (bump on every change) |

## What makes it deterministic

- Base images pinned **by digest** in every Dockerfile.
- Go: `go.sum`; Node: `package-lock.json` via `npm ci`; Python (runner): a
  fully frozen `session-runner/requirements.txt` (`==` pins incl. transitives).
- No timestamps or environment leaks into the artifacts (version is pure git).

Known gaps (accepted, deterministic-not-bit-for-bit):
- apt packages in the runner/console images are unpinned (Debian has no sane
  version pinning).
- `next/font/google` downloads IBM Plex during the console build — needs
  network egress to Google Fonts.
- The control-plane image expects cluster credentials at runtime (in-cluster
  ServiceAccount or mounted kubeconfig); out-of-cluster dev keeps running the
  tsx process directly.

## Updating pins

- **Runner Python deps:** edit/build with loose specifiers temporarily, then
  refreeze: `docker run --rm --entrypoint pip devproof/session-runner:devNN
  freeze > session-runner/requirements.txt`, rebuild, run the runner suite.
- **Base images:** `docker buildx imagetools inspect <image:tag>` → paste the
  new digest into the Dockerfile.
- **Node deps:** normal `npm install` flow updates `package-lock.json`.

## CI (GitHub Actions)

`.github/workflows/ci.yml`, on PR + push to main:

- **operator:** `go vet`, `go test`
- **control-plane:** `npm ci`, `tsc --noEmit`, `npm test` against a Postgres
  16 service container on `15432:5432` — matches db.ts's default URL; the
  suite needs Postgres ONLY (k8s + files are faked in tests)
- **session-runner:** full unittest suite (the 3 Delegate path tests that
  fail on Windows hosts pass on Linux)
- **client:** `python -m build`, wheel uploaded as an artifact
- **images:** `docker buildx bake` from the shared bake file; on main also
  pushes `ghcr.io/devproof/<name>:{<version>, <short-sha>, latest}` using the
  built-in `GITHUB_TOKEN`

## Determinism spot-check

Build twice from a clean checkout of the same commit: versions, tags, and the
full dependency trees are identical (`pip freeze` diff empty, same lockfiles).
Layer hashes MAY differ — bit-for-bit identity is explicitly out of scope.
```

- [ ] **Step 2: CLAUDE.md touch-ups (surgical, two lines)**

1. In the `## Components` intro or `## Running` section, add one line: `Builds: see BUILD.md (bake-based, version-stamped; scripts/build.sh).`
2. In the session-runner bullet, prepend to the tag history: `dev51 pins the base image by digest + freezes all pip deps into session-runner/requirements.txt (no behavior change; requirements frozen FROM dev50)` — keep the existing `current dev50` claim unless the user switches `DEVPROOF_RUNNER_IMAGE`; if they do, update `current` to `dev51`.

- [ ] **Step 3: Commit docs**

```bash
git add BUILD.md CLAUDE.md
git commit -m "docs: BUILD.md — reproducible build process + CI reference

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Push branch + tag, verify CI live**

⚠️ Outward-facing: confirm with the user before the FIRST push if anything about the repo state looks unexpected. Then:

```bash
git push origin main
git push origin v0.1.0
gh run watch --exit-status
```

Expected: all five test jobs green; `images` job builds AND pushes (this is a main push) — check `gh api /orgs/devproof/packages?package_type=container` (or the repo's Packages page) for the four `ghcr.io/devproof/*` images tagged with the describe version, short SHA, and `latest`. If any job fails, fix forward on main (or a branch + PR if the fix is non-trivial) — first-run CI friction (e.g. a test assuming pre-seeded dev-DB state) was an accepted residual risk in the spec.

- [ ] **Step 5: Final local gate**

```bash
cd control-plane && npm test && npx tsc --noEmit && cd ..
scripts/build.sh
```

Expected: suite green, all four images build with the current version. Done.
