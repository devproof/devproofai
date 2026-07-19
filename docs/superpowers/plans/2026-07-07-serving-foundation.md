# Devproof AI — Sub-plan A: Serving Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Devproof monorepo and prove the serving base end-to-end: LLMkube running on the docker-desktop cluster, a small CPU GGUF model deployed through LLMkube CRDs, answering chat completions via its OpenAI-compatible endpoint, verified by an automated smoke test.

**Architecture:** This is sub-plan A of 4 for Phase 1 (Serving MVP) per `docs/concept/devproof-ai-concept.md` §9. It creates the repo skeleton and validates the foundation everything else builds on (LLMkube provider → sub-plan B operator; endpoint → sub-plan C gateway). No Devproof code ships in this sub-plan beyond the smoke test — the deliverable is a proven substrate plus the repo.

**Tech Stack:** git, winget (Go 1.24+, Helm 3.x), kubectl v1.34 against docker-desktop (6 nodes, CPU-only), LLMkube (helm chart, `inference.llmkube.dev/v1alpha1`), Node 25 (smoke test in plain node:test).

## Global Constraints

- Cluster context is `docker-desktop`; never switch context in scripts (`kubectl config use-context` forbidden).
- Cluster is CPU-only: all models in this sub-plan must be ≤1B params, GGUF Q4, no `gpu:` fields.
- All Devproof namespaces are prefixed `devproof-`; LLMkube lives in `llmkube-system`.
- Windows host: shell scripts must run under Git Bash (POSIX sh); no PowerShell-only scripts in the repo.
- Repo root is `C:\Users\carst\Desktop\devproofai`. Screenshots folder stays untracked (add to `.gitignore`).
- Commit messages: conventional commits (`feat:`, `chore:`, `test:`, `docs:`).

## Sub-plan sequence (context)

| Sub-plan | Deliverable | Status |
|---|---|---|
| **A (this)** | Repo + LLMkube + model answering on cluster + smoke test | in progress |
| B | Go operator: ModelPool/ModelDeployment CRDs → LLMkube resources | not started |
| C | LiteLLM gateway (OpenAI + Anthropic dialects) + control-plane API + catalog | not started |
| D | Next.js console + Devproof Helm chart (dev profile) | not started |

---

### Task 1: Repository initialization and monorepo skeleton

**Files:**
- Create: `.gitignore`, `README.md`, `catalog/models.yaml` (seed), directory placeholders `operator/`, `control-plane/`, `console/`, `charts/`, `scripts/`, `deploy/`
- Existing kept: `docs/concept/devproof-ai-concept.md`, `docs/superpowers/plans/…`

**Interfaces:**
- Produces: repo layout consumed by all later sub-plans — `operator/` (Go), `control-plane/` (Node/TS), `console/` (Next.js), `charts/devproof/` (Helm), `catalog/models.yaml` (catalog data, schema per concept §5.2), `deploy/` (raw K8s YAML used before Helm exists), `scripts/` (dev tooling).

- [ ] **Step 1: git init and .gitignore**

```bash
cd /c/Users/carst/Desktop/devproofai && git init -b main
```

Create `.gitignore`:

```gitignore
node_modules/
.next/
dist/
bin/
*.log
.env*
screenshots/
*.gguf
```

- [ ] **Step 2: README.md**

```markdown
# Devproof AI

Self-hosted platform for LLM serving and managed agents on Kubernetes.
See `docs/concept/devproof-ai-concept.md` for the full concept.

## Layout
- `operator/` — Go operator (ModelPool, ModelDeployment CRDs)
- `control-plane/` — Node/TS platform API + session orchestrator
- `console/` — Next.js UI
- `charts/` — Helm charts
- `catalog/` — curated model catalog data
- `deploy/` — raw K8s manifests (pre-Helm bootstrap)
- `scripts/` — dev/test tooling

## Dev cluster
docker-desktop (CPU-only). Bootstrap: see `deploy/README.md`.
```

- [ ] **Step 3: skeleton dirs + seed catalog**

```bash
mkdir -p operator control-plane console charts deploy scripts catalog
```

Create `catalog/models.yaml` (schema exactly per concept §5.2; one CPU-class entry used by this sub-plan):

```yaml
models:
  - id: qwen2.5-0.5b-instruct-q4
    family: qwen
    displayName: "Qwen 2.5 0.5B Instruct"
    parameters: 0.5B
    format: gguf
    quantization: Q4_K_M
    source: https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf
    license: apache-2.0
    recommendedEngine: llama.cpp
    toolCalling: basic
    requirements: { vramGB: 0, diskGB: 1, gpus: 0 }
    capacityProfiles:
      - gpuType: cpu
        gpusPerReplica: 0
        estTokensPerSec: 20
```

- [ ] **Step 4: commit**

```bash
git add -A && git commit -m "chore: repo skeleton, concept paper, seed catalog"
```

Expected: commit created on `main`, `screenshots/` not staged.

---

### Task 2: Toolchain — install Helm and Go

**Files:** none (host tooling). Record versions in `deploy/README.md` (created here).

**Interfaces:**
- Produces: `helm` and `go` on PATH — helm needed by Task 3, Go needed by sub-plan B.

- [ ] **Step 1: install**

```powershell
winget install --id Helm.Helm -e --accept-source-agreements --accept-package-agreements
winget install --id GoLang.Go -e --accept-source-agreements --accept-package-agreements
```

- [ ] **Step 2: verify (new shell so PATH refreshes)**

Run: `helm version --short` → expected `v3.x.y`
Run: `go version` → expected `go1.2x windows/amd64`
If PATH not refreshed in the current session, invoke via absolute path (`$LOCALAPPDATA/Microsoft/WinGet/Links/helm` or `C:\Program Files\Go\bin\go`) and note it.

- [ ] **Step 3: create `deploy/README.md`** documenting cluster context, node list, and installed tool versions (exact `kubectl get nodes` output + versions from step 2).

- [ ] **Step 4: commit**

```bash
git add deploy/README.md && git commit -m "docs: dev cluster + toolchain notes"
```

---

### Task 3: Install LLMkube operator on docker-desktop

**Files:**
- Create: `deploy/llmkube/values.yaml` (pinned chart values, even if defaults)

**Interfaces:**
- Produces: LLMkube controller running in `llmkube-system`; CRDs `models.inference.llmkube.dev`, `inferenceservices.inference.llmkube.dev` established — consumed by Task 4 and by sub-plan B's provider.

- [ ] **Step 1: add repo and inspect chart version**

```bash
helm repo add llmkube https://defilantech.github.io/LLMKube && helm repo update
helm search repo llmkube/llmkube
```

Record the chart + app version in `deploy/llmkube/values.yaml` header comment. Pin it in the install.

- [ ] **Step 2: install pinned**

```bash
helm install llmkube llmkube/llmkube --namespace llmkube-system --create-namespace --version <pinned>
```

- [ ] **Step 3: verify controller Ready and CRDs present**

```bash
kubectl -n llmkube-system get pods
kubectl get crds | grep llmkube
```

Expected: controller pod `Running 1/1`; at least `models.inference.llmkube.dev` and `inferenceservices.inference.llmkube.dev` listed. If the pod image fails to pull or CrashLoops, capture `kubectl describe` output before proceeding — do NOT retry blind.

- [ ] **Step 4: commit**

```bash
git add deploy/llmkube && git commit -m "chore: install LLMkube operator (pinned chart)"
```

---

### Task 4: Deploy the seed model via LLMkube CRDs

**Files:**
- Create: `deploy/models/qwen05b.yaml`

**Interfaces:**
- Consumes: catalog entry `qwen2.5-0.5b-instruct-q4` (Task 1), LLMkube CRDs (Task 3).
- Produces: K8s Service `qwen05b` in `devproof-serving` exposing OpenAI-compatible `POST /v1/chat/completions` on port 8080 — consumed by Task 5's smoke test and later by sub-plan C's gateway.

- [ ] **Step 1: write manifest**

`deploy/models/qwen05b.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata: { name: devproof-serving }
---
apiVersion: inference.llmkube.dev/v1alpha1
kind: Model
metadata: { name: qwen05b, namespace: devproof-serving }
spec:
  source: https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf
  format: gguf
---
apiVersion: inference.llmkube.dev/v1alpha1
kind: InferenceService
metadata: { name: qwen05b, namespace: devproof-serving }
spec:
  modelRef: qwen05b
  replicas: 1
  resources: { cpu: "2", memory: "2Gi" }
```

Note: exact `InferenceService.spec` fields must be validated against the installed CRD (`kubectl explain inferenceservice.spec` or the CRD schema) — adjust field names to the pinned chart version if they differ, and record any deviation in `deploy/README.md`.

- [ ] **Step 2: apply and watch**

```bash
kubectl apply -f deploy/models/qwen05b.yaml
kubectl -n devproof-serving get model,inferenceservice,pods -w
```

Expected: model download job/init completes (~400 MB), inference pod reaches `Running 1/1`, Service `qwen05b` exists. Allow several minutes for download.

- [ ] **Step 3: manual chat verification**

```bash
kubectl -n devproof-serving port-forward svc/qwen05b 8080:8080 &
curl -s http://localhost:8080/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say READY and nothing else."}],"max_tokens":10}'
```

Expected: JSON with `choices[0].message.content` containing a reply. Kill the port-forward afterward.

- [ ] **Step 4: commit**

```bash
git add deploy/models && git commit -m "feat: serve qwen2.5-0.5b via LLMkube on dev cluster"
```

---

### Task 5: Automated smoke test

**Files:**
- Create: `scripts/smoke-serving.mjs`
- Create: `scripts/README.md`

**Interfaces:**
- Consumes: Service `qwen05b` in `devproof-serving` (Task 4).
- Produces: `node scripts/smoke-serving.mjs` — exit 0 on healthy serving path, exit 1 with diagnostics otherwise. Reused as the regression gate for sub-plans B–D (they must keep it green).

- [ ] **Step 1: write the failing test first**

`scripts/smoke-serving.mjs` (no deps, Node ≥20):

```javascript
// Smoke test: the serving foundation answers chat completions.
// Usage: node scripts/smoke-serving.mjs [baseUrl]
// Starts its own kubectl port-forward unless baseUrl is given.
import { spawn, execSync } from "node:child_process";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:18080";
let pf = null;

async function waitFor(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { await fetch(url); return; } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  throw new Error(`not reachable within ${ms}ms: ${url}`);
}

try {
  if (!process.argv[2]) {
    execSync("kubectl -n devproof-serving get svc qwen05b", { stdio: "pipe" });
    pf = spawn("kubectl", ["-n", "devproof-serving", "port-forward", "svc/qwen05b", "18080:8080"],
               { stdio: "ignore" });
  }
  await waitFor(`${baseUrl}/v1/models`, 30000).catch(() => {}); // endpoint optional; readiness probe only
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Reply with the single word: pong" }], max_tokens: 10 }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (!text || typeof text !== "string") throw new Error(`no content in response: ${JSON.stringify(body).slice(0, 500)}`);
  console.log(`SMOKE PASS — model replied: ${JSON.stringify(text.trim().slice(0, 80))}`);
  process.exit(0);
} catch (err) {
  console.error(`SMOKE FAIL — ${err.message}`);
  process.exit(1);
} finally {
  pf?.kill();
}
```

- [ ] **Step 2: verify it fails when serving is absent**

Run with the InferenceService scaled down or against a dead port:
`node scripts/smoke-serving.mjs http://127.0.0.1:19999`
Expected: `SMOKE FAIL — …` and exit code 1.

- [ ] **Step 3: verify it passes against the live cluster**

Run: `node scripts/smoke-serving.mjs`
Expected: `SMOKE PASS — model replied: …`, exit code 0.

- [ ] **Step 4: `scripts/README.md`** — one paragraph: what the smoke test asserts, how sub-plans B–D must keep it green.

- [ ] **Step 5: commit**

```bash
git add scripts && git commit -m "test: serving-foundation smoke test"
```

---

## Self-review notes

- Spec coverage: this sub-plan covers concept §5 foundation only (LLMkube substrate + endpoint); §5.1–5.7 Devproof-owned features land in sub-plans B–D by design.
- Known uncertainty flagged in-task: exact `InferenceService.spec` field names at the pinned chart version (Task 4 Step 1 includes the validation step); winget PATH refresh (Task 2 Step 2 includes the workaround).
- Type/name consistency: namespace `devproof-serving`, service `qwen05b`, port 8080, smoke port 18080 used consistently across Tasks 4–5.
