# Devproof AI — Concept Paper

**Version:** 1.0 (draft)
**Date:** 2026-07-07
**Status:** For review — basis for phase-2 implementation planning
**Audience:** Stakeholders (motivation, positioning) and engineering (architecture blueprint)

---

## 1. Executive Summary

Devproof AI is a self-hosted platform for running large language models and autonomous AI agents on Kubernetes — in your own data center, in your own cloud account, or on a laptop. It consists of two integrated planes:

1. **Serving Plane** — deploy open-weight models (Llama, Qwen, Mistral, DeepSeek, …) from a curated catalog onto logical node pools with capacity-aware autoscaling, exposed through OpenAI-compatible endpoints that work with any standard tooling (Claude Code, Codex, Hermes, LangChain, plain OpenAI SDKs).
2. **Agent Plane** — a managed-agents platform modeled on Anthropic's Managed Agents console: define versioned agents, run them as sandboxed sessions inside the cluster, attach files and tools, monitor every session down to individual tool calls and token counts, and drive everything from a Python API.

The strategic goal is **independence**: no dependency on OpenAI, Anthropic, or any cloud provider for the platform to function. Models are downloaded once, cached in-cluster, and can run fully air-gapped. The entire platform installs via a single Helm chart and runs on a local kind/k3d cluster for development — this is an acceptance criterion, not an aspiration.

The build strategy is pragmatic rather than purist: Devproof reuses best-of-breed open components — **LLMkube** for model lifecycle on K8s, **vLLM/llama.cpp** as inference engines, **KEDA** for autoscaling, **LiteLLM** for protocol translation — but wraps each behind Devproof-owned interfaces so every one of them is replaceable. The one component too central to outsource is the agent runtime itself: the reasoning loop, `devproof_runner`, is built from scratch in-house — no external agent framework anywhere in the stack.

---

## 2. Motivation and Strategic Context

### 2.1 Why this product

- **Sovereignty over AI infrastructure.** Organizations increasingly cannot — for regulatory, cost, confidentiality, or geopolitical reasons — send data to OpenAI/Anthropic APIs or run workloads only in hyperscaler regions. Open-weight models (Llama 3.x/4, Qwen 3, DeepSeek V3/R1, Mistral) have reached a quality level where self-hosting is a real alternative for many workloads, especially agentic back-office automation.
- **Run applications and AI in own data centers.** Kubernetes is the de-facto operating system of the modern data center. A platform that makes "deploy a 70B model" and "run a fleet of support agents" as routine as deploying a microservice removes the main adoption barrier: infrastructure expertise.
- **Cost control.** API-priced tokens are expensive at scale. Self-hosted inference on owned or reserved GPUs, with autoscaling that releases cloud capacity when load drops, changes the cost structure from per-token to per-GPU-hour.
- **The managed-agents gap.** Hosted agent platforms (Anthropic Managed Agents, launched April 2026) demonstrate the product shape enterprises want — versioned agents, sandboxed sessions, deep observability, credential management — but they only run on the vendor's models and the vendor's cloud. Nothing comparable exists for self-hosted models. Devproof fills that gap.

### 2.2 What Devproof is not

- Not a model training or fine-tuning platform (out of scope; may compose with external tools later).
- Not a general ML serving platform for predictive models (KServe's classic domain).
- Not a chat product. The consumers are developers, platform teams, and the applications/agents they build.

### 2.3 Target users

| Persona | Uses Devproof for |
|---|---|
| Platform engineer | Installs the platform, defines ModelPools, watches capacity and cost |
| AI/application developer | Picks models from the catalog, builds and versions agents, integrates via Python/REST/OpenAI-compatible APIs |
| Operator / support engineer | Monitors sessions, inspects traces, debugs failed runs |
| Stakeholder / management | Usage and cost dashboards, proof that AI workloads run on owned infrastructure |

---

## 3. Landscape and Positioning

### 3.1 Model serving on Kubernetes — alternatives considered

| Option | Assessment |
|---|---|
| **LLMkube** (chosen base) | Apache-2.0 Go operator; CRDs `Model`, `InferenceService`, `ModelRouter` (API group `inference.llmkube.dev/v1alpha1`); pluggable engines (llama.cpp primary, vLLM, TGI); automatic HuggingFace download with PVC-backed model cache; OpenAI-compatible endpoint per service; HPA/KEDA autoscaling on queue metrics; multi-GPU sharding; heterogeneous accelerators (NVIDIA, AMD, Apple Silicon, Intel). Best functional fit. **Risk:** pre-1.0 (`v1alpha1`), single-vendor, small community (~160 stars as of mid-2026). |
| **KubeAI** | Zero-dependency operator with Model CRD, OpenAI proxy, prefix-aware load balancing, scale-from-zero without Knative. Closest philosophical competitor to LLMkube; the primary named fallback. |
| **KServe + llm-d** | CNCF incubating; `LLMInferenceService` CRD built on llm-d (prefill/decode disaggregation, KV-cache-aware routing, multi-node). Strong ecosystem, heavier footprint. The named scale-out path if Devproof must serve very large MoE models across many nodes. |
| **vLLM production-stack / AIBrix** | vLLM-ecosystem reference stacks with KV-aware routing and LMCache. Components (routing ideas, metrics) inform Devproof's gateway design even where not adopted wholesale. |
| **Ray Serve / KubeRay** | Python-native orchestration; best when inference mixes with data/RL pipelines. Too much platform for Devproof's focused scope. |
| **NVIDIA NIM** | Maximum out-of-the-box NVIDIA performance, but commercial licensing and NVIDIA-only — conflicts with the independence motivation. |
| **Ollama on K8s** | Great DX, weak production/multi-tenant semantics; not a platform base. |

**Decision:** LLMkube as the serving provider, **behind a Devproof-owned abstraction** (see §5.4). Devproof's own CRDs and gateway are the stable API; LLMkube is an implementation detail that can be swapped for KubeAI, direct vLLM management, or llm-d without touching the console, the agents platform, or client integrations.

### 3.2 Agent platform — reference and runtime

The product blueprint for the Agent Plane is **Anthropic's Managed Agents console** (analyzed in detail from screenshots; see §6). Its entity model — workspaces, versioned agents, sessions with typed event traces, environments with network policy, skills, memory stores, credential vaults, files, observability rollups — is proven with real production users and is adopted by Devproof largely as-is, re-implemented on self-hosted infrastructure.

The runtime that actually executes an agent's reasoning loop is **`devproof_runner` (Python)** — a Devproof-owned, in-process agent loop built from scratch for this platform:

- It provides the full loop: tool execution (Bash, Read/Write/Edit, Glob/Grep, WebFetch + Skill), streamable-HTTP MCP client support, agent delegation, session persistence/resume via transcripts, skills loading, and client-side auto-compaction.
- It is in-process and driven directly by the session runner — no subprocess CLI, no hidden system blocks, and GBNF-safe tool schemas by construction.
- **Dialect:** it speaks the *Anthropic Messages API*. Devproof's gateway therefore exposes an Anthropic-compatible `/v1/messages` endpoint translated onto the OpenAI-compatible model deployments (LiteLLM implements exactly this translation and documents the pattern).
- **Sovereignty:** owning the loop end-to-end means no external runtime dependency, no vendor ToS or branding constraints, and full freedom to evolve the loop with the platform; the runtime-agnostic runner contract (§6.3) keeps even this component swappable.

---

## 4. Product Overview

### 4.1 System architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Devproof Console (Next.js)                                    │
│  Model Catalog · Deployments · Pools · Agents · Sessions ·     │
│  Skills · Memory · Environments · Vaults · Observability       │
└────────────┬───────────────────────────────────────────────────┘
             │ REST
┌────────────▼───────────────────────────────────────────────────┐
│  Devproof Control Plane (Node.js / TypeScript)                 │
│  · Platform API  (workspace-scoped REST, SSE event streams)    │
│  · Session Orchestrator (schedules/supervises session pods)    │
│  · Model Deployment Service (writes Devproof CRDs)             │
│  · Catalog Service (curated model catalog, capacity profiles)  │
│  PostgreSQL (metadata) · MinIO/S3 (files, artifacts) ·         │
│  NATS (event bus) · Prometheus/Grafana (metrics)               │
└──────┬─────────────────────────────────┬───────────────────────┘
       │                                 │
┌──────▼──────────────────┐   ┌──────────▼──────────────────────┐
│ SERVING PLANE           │   │ AGENT PLANE                     │
│ Devproof Operator (Go)  │   │ Session pods:                   │
│  ModelPool CRD          │   │  runner.py (session wrapper)    │
│  ModelDeployment CRD    │   │  └─ devproof_runner (Python)    │
│   └─ generates LLMkube  │   │  workspace volume               │
│      Model + Inference- │   │  /mnt/session/uploads           │
│      Service resources  │   │  NetworkPolicy from Environment │
│ llama.cpp / vLLM pods   │   │  events → NATS → control plane  │
│ KEDA ScaledObjects      │   └──────────┬──────────────────────┘
│ PVC model weight cache  │              │ Anthropic Messages API
└──────▲──────────────────┘   ┌──────────▼──────────────────────┐
       │ OpenAI-compatible    │ Devproof AI Gateway (LiteLLM-   │
       │ per-deployment       │ based):                         │
       └──────────────────────┤  /v1/chat/completions (OpenAI)  │
                              │  /v1/messages (Anthropic-compat)│
   External clients ─────────▶│  /v1/models (deployment list)   │
   (Codex, Hermes, and        │  routing, keys, usage metering  │
    other CLIs, OpenAI SDKs)  └─────────────────────────────────┘
```

### 4.2 Structural principles

1. **The AI Gateway is the seam.** Every model deployment auto-registers with the gateway. The gateway is the single endpoint for external tools *and* for the platform's own agent sessions. It exposes both protocol dialects (OpenAI and Anthropic Messages) and is the natural place for API-key issuance, usage metering, and later rate limiting.
2. **Provider abstraction in the serving plane.** Devproof CRDs are the contract; LLMkube resources are generated output. The operator's provider interface has three responsibilities: materialize a model server for (model, engine, resources), report readiness/health, expose scaling target metrics.
3. **Workspace-scoped everything.** Every entity (deployment, agent, session, file, skill, memory store, environment, vault, API key) belongs to exactly one workspace. Phase 1 ships a default workspace and no login; the scoping is structural so multi-tenancy and RBAC can be added without data-model migration.
4. **Runs on a laptop.** One Helm chart, a `dev` values profile with a CPU-only ModelPool and a small GGUF model, MinIO and single-node Postgres in-cluster. Full user journey — catalog → deploy → agent → session → trace — must work on a 32 GB machine with no GPU.
5. **Air-gap capable.** Once model weights are in the cache and images are in a local registry, no internet egress is required.

### 4.3 Primary user journeys

1. **Serve a model:** open catalog → pick family/size/quantization → UI shows which pools fit → deploy → endpoint + API key appear → connect any coding-agent CLI by setting base URL.
2. **Build an agent:** create agent (model, system prompt, tools, skills, environment) → test-run a session from the console → iterate (new version) → integrate via Python API.
3. **Operate:** watch sessions list → open a misbehaving session's trace → inspect the exact tool call and token spend where it went wrong → fix prompt/skill → new agent version.
4. **Scale:** watch pool utilization → adjust replica bounds or add nodes → autoscaler follows demand; on-prem static pools redistribute replicas within fixed capacity.

---

## 5. Serving Plane Specification

### 5.1 ModelPool — logical node pools

A `ModelPool` is a workspace-level declaration of homogeneous compute capacity, configured in the UI and mapped to physical nodes via selectors/taints:

```yaml
apiVersion: serving.devproof.ai/v1alpha1
kind: ModelPool
metadata: { name: gpu-a100 }
spec:
  nodeSelector: { devproof.ai/pool: gpu-a100 }
  tolerations: [{ key: nvidia.com/gpu, operator: Exists }]
  gpuType: nvidia-a100-80gb        # drives capacity math and catalog fit
  gpusPerNode: 4
  maxNodes: 8                      # ceiling for dynamic scaling
  scalingMode: dynamic             # dynamic | static
```

- **`static`** (on-prem, fixed hardware): node count never changes; deployments scale replicas only within existing capacity; the scheduler bin-packs.
- **`dynamic`** (AWS/Azure with cluster autoscaler): replica scale-out beyond current capacity triggers node provisioning up to `maxNodes`; scale-in releases nodes to save cost.

Pools declare capacity; they never deploy anything. The console shows per-pool utilization (GPUs allocated/total, deployments resident, headroom).

### 5.2 Model Catalog

A curated, versioned dataset (YAML/JSON shipped with releases, extendable per workspace) presenting the Unsloth-style **family × size × quantization matrix**. Each entry carries everything needed for one-click deployment:

```yaml
id: llama-3.3-70b-instruct-q4
family: llama
displayName: "Llama 3.3 70B Instruct"
parameters: 70B
format: gguf                     # gguf | safetensors
quantization: Q4_K_M
source: https://huggingface.co/...(resolve URL)
license: llama3.3
recommendedEngine: llama.cpp
toolCalling: strong              # strong | basic | none — surfaced in agent UI
requirements: { vramGB: 42, diskGB: 40, gpus: 2 }
capacityProfiles:
  - gpuType: nvidia-a100-80gb
    gpusPerReplica: 2
    estTokensPerSec: 25          # aggregate generation throughput per replica
```

The console computes **pool fit** automatically ("fits gpu-a100 at 2 GPUs/replica; does not fit gpu-t4") — the user never manually reasons about which model needs which node pool. Custom entries can point at any HuggingFace repo; capacity profiles for custom entries start empty and are filled from measured throughput after first deployment (§5.5).

### 5.3 ModelDeployment

```yaml
apiVersion: serving.devproof.ai/v1alpha1
kind: ModelDeployment
metadata: { name: llama70b-prod, labels: { devproof.ai/workspace: default } }
spec:
  modelRef: llama-3.3-70b-instruct-q4    # catalog entry
  poolRef: gpu-a100
  engine: auto                            # auto → llama.cpp for GGUF, vLLM for safetensors
  replicas: { min: 1, max: 6 }            # min: 0 enables scale-to-zero
  targetTokensPerSec: 400                 # desired aggregate capacity (sizing input)
  engineArgs: {}                          # escape hatch: raw engine flags
status:
  phase: Ready
  readyReplicas: 2
  endpoint: http://gateway.devproof/v1    # via gateway, model=llama70b-prod
  observedTokensPerSec: 47
```

### 5.4 Devproof Operator and the provider abstraction

A Go operator (Kubebuilder) reconciles `ModelPool`/`ModelDeployment` into provider resources. Phase 1 ships one provider:

- **LLMkube provider:** generates `Model` (source URL, format) and `InferenceService` (replicas, resources, node selector from the pool, engine selection) resources; watches their status back into `ModelDeployment.status`.

The provider interface is deliberately narrow — *materialize server, report health, expose metrics endpoint* — so alternates (KubeAI, direct vLLM Deployments, llm-d) are implementable without CRD changes. This is the concrete mechanism behind the "LLMkube is swappable" decision.

The operator additionally owns what LLMkube does not: gateway registration/deregistration on deployment lifecycle, KEDA `ScaledObject` generation from the capacity model, and workspace labeling.

### 5.5 Autoscaling — the token-capacity model

**Sizing (planning time).** `targetTokensPerSec / capacityProfile.estTokensPerSec → initial replica count`, validated against pool headroom in the UI before deployment. This is where the "model ↔ nodepool defines how many tokens can be handled" requirement lives.

**Scaling (run time).** Live scaling uses engine-native pressure metrics, not token estimates — measured queue pressure beats predicted throughput:

- vLLM: `vllm:num_requests_waiting` (primary), `vllm:kv_cache_usage_perc` (secondary)
- llama.cpp: slot occupancy / queued requests from the server's metrics endpoint

KEDA `ScaledObject`s (Prometheus trigger) per deployment implement: scale out fast (short window), scale in slow (long stabilization window — cold-starting a 70B model costs minutes), floor/ceiling from `replicas.min/max`, hard ceiling from pool capacity. `min: 0` gives scale-to-zero for rarely used models; the gateway holds and retries the first request while a replica warms (documented cold-start latency applies).

**Learning loop.** The operator records observed tokens/sec per (model, GPU type, engine) and feeds it back into capacity profiles, so sizing improves from estimates to measurements.

**Static pools.** Same KEDA mechanics, but the ceiling is fixed capacity; when demand exceeds it, the deployment reports saturation in the console instead of provisioning nodes.

### 5.6 Model weight caching

- **Base (phase 1):** LLMkube's PVC-backed cache — download once from HuggingFace, reuse across replicas, restarts, and redeployments. RWX storage class where available (NFS/CephFS/EFS/Azure Files); per-node RWO cache otherwise.
- **Console:** a Cache view — cached models, sizes, last-used, evict action, pre-warm action (download without deploying).
- **Air-gap:** pre-seed the cache PVC (or point sources at an internal artifact mirror); no runtime internet dependency.
- **Named upgrade path (later phases):** OCI model artifacts (registry-native distribution, layer dedup, image pre-pull) and Fluid-style distributed prefetching for multi-minute → sub-minute cold starts.

### 5.7 Gateway and endpoints

LiteLLM-based deployment, configured dynamically by the operator:

- `POST /v1/chat/completions`, `GET /v1/models` — OpenAI-compatible; `model` = deployment name. Works out of the box with Codex, Hermes, LangChain, LlamaIndex, and any OpenAI SDK.
- `POST /v1/messages` — Anthropic Messages-compatible, translated to the backend; consumed by Anthropic-dialect coding CLIs (`ANTHROPIC_BASE_URL`), the `devproof_runner` loop inside session pods, and any Anthropic-SDK client. Both dialects ship from phase 1, since local-tool connectivity (Codex, Hermes, and other coding-agent CLIs) is a phase-1 exit criterion.
- Streaming (SSE) supported on both dialects; tool/function-calling payloads translated between dialects.
- Per-key usage metering (tokens in/out per key/deployment/day) recorded to Postgres — feeds the console's usage views. Keys are unauthenticated-but-identifying in phase 1 (attribution, not security).
- Per-deployment raw engine endpoints remain cluster-internal for debugging.

---

## 6. Agent Plane Specification

### 6.1 Entity model

All entities are workspace-scoped, carry ULID-style prefixed IDs (`agent_…`, `sesn_…`, `sevt_…`, `env_…`, `vlt_…`, `memstore_…`, `file_…`, `skill_…`), and follow the console patterns evidenced in the Anthropic Managed Agents UI.

| Entity | Definition | Notes |
|---|---|---|
| **Agent** | Versioned config: model (deployment name or gateway alias), system prompt, allowed tools, skill refs, environment ref, vault bindings, MCP server configs | Editing creates a new immutable version; sessions pin the version they ran with |
| **Session** | One run of an agent version: status (`queued / running / idle / completed / failed`), input files, output artifacts, event log, token/latency accounting | Idle sessions are checkpointed and resumable; names are client-assigned (e.g. ticket IDs) |
| **Session event** | Typed, ordered record: `session.created`, `user.message`, `agent.message`, `tool.call`, `tool.result`, `subagent.start/stop`, `session.idle`, `session.failed` | Each carries tokens in/out, duration, offset from session start; payloads stored raw + renderable |
| **Environment** | Container template: base image, packages, network policy (allowlisted hosts, package-manager egress toggle, MCP egress toggle), resource limits, metadata | Enforced via K8s NetworkPolicy + egress proxy for host allowlists |
| **Skill** | Versioned instruction package (SKILL.md + resources), mounted read-only into session pods | Format-compatible with Anthropic skills so existing skills are reusable |
| **Memory store** | Persistent mini-filesystem keyed to a business entity (ticket, customer, project), mounted read-write into sessions that reference it | Browsable/editable file tree in the console; writes attributed to the writing key/session |
| **Credential vault** | Named secret bundles for MCP servers/tools | K8s Secrets in phase 1 behind a storage interface (HashiCorp Vault pluggable later); injected as env/files, never logged in transcripts |
| **File** | Uploaded blob in object storage | Mounted at `/mnt/session/uploads/` per attachment; outputs collected from `/mnt/session/outputs/` |
| **Webhook** | Workspace-level HTTP notification on session lifecycle events | Phase 4 |

### 6.2 Session lifecycle

1. **Create** (API or console): control plane persists the session, resolves agent version → environment → pod spec.
2. **Schedule:** Session Orchestrator creates a **session pod** on the agent-workload node pool: session-runner container + workspace volume; init container stages input files and skills; NetworkPolicy from the environment applied.
3. **Run:** runner boots the in-process `devproof_runner` loop with translated options — system prompt, allowed tools, MCP servers (credentials from vault), skills directory, gateway `/v1/messages` base URL, model = the agent's deployment. Each user message (with optional new file attachments, announced to the agent as newly mounted files) drives a loop turn.
4. **Stream:** the runner maps every loop message and event to a typed session event, publishes to NATS; the control plane persists to Postgres and fans out to console/API subscribers via SSE. Subagent activity nests as child spans in the same trace.
5. **Idle / resume:** after a turn completes, the session goes `idle`; a checkpoint (loop transcript state + workspace volume snapshot) allows pod teardown and later `resume` with full context.
6. **Complete:** outputs from `/mnt/session/outputs/` are persisted as artifacts; final accounting (turns, tokens, duration, stop reason) is recorded.
7. **Fail:** runner crash, engine error, or policy violation → `failed` with the error event preserved in the trace.

### 6.3 Runtime pluggability

The session runner is the only component that knows which agent-loop implementation runs inside the pod. Its internal contract — *start(agentConfig), sendMessage(content, files), events (async stream), checkpoint(), resume(checkpoint)* — is runtime-agnostic. The current implementation is the from-scratch `devproof_runner` loop; the seam has already carried a full runtime-generation change (2026-07-17) with no changes to the platform API or console. This retired risk R2 (§10).

### 6.4 Python API

Devproof-owned client (`pip install devproof`), shaped after familiar SDK conventions; REST + SSE underneath so any language can integrate.

```python
from devproof import Devproof

client = Devproof(base_url="https://devproof.internal", workspace="support-bot")

agent = client.agents.create(
    name="triage-agent",
    model="qwen3-72b",                       # a ModelDeployment name
    system_prompt=open("prompt.md").read(),
    tools=["bash", "read", "grep", "write"],
    skills=["helm-triage", "log-analysis"],
    environment="support-env",
)

session = client.sessions.create(agent=agent.id, name="ZD-1234")
client.files.upload(session=session.id, path="diag-bundle.zip")

for event in client.sessions.stream(session.id, prompt="Analyze the attached bundle"):
    print(event.type, event.summary)          # tool.call Bash …, agent.message …

result = client.sessions.get(session.id)
for artifact in result.outputs:
    client.files.download(artifact.id, dest="./out/")
```

REST surface (workspace-scoped, phase-1 subset):

```
POST   /v1/agents                    GET /v1/agents/{id}          (versions: /v1/agents/{id}/versions)
POST   /v1/sessions                  GET /v1/sessions?agent=…&status=…
POST   /v1/sessions/{id}/messages    (prompt + attachments; starts/continues a turn)
GET    /v1/sessions/{id}/events      (SSE stream or paginated history)
POST   /v1/files                     GET /v1/files/{id}/content
POST   /v1/skills                    POST /v1/environments        POST /v1/vaults
POST   /v1/memory-stores             GET  /v1/memory-stores/{id}/tree
```

### 6.5 Monitoring and observability UI

- **Sessions list** (global and per-agent): filter by agent, status, date, deployment; columns for name, status, version, tokens in/out, created; live status updates.
- **Session detail — trace viewer** (the platform's flagship screen): chronological event list with role chips (User/Agent/Tool), tool name + argument preview, per-event tokens, per-event latency, elapsed-offset column; timeline minimap for scrubbing; event detail panel with Rendered/Raw views and permalinked event IDs; header chips for agent, environment, file/output counts, duration, total tokens; artifact download; free-text search and event-type filter. Live sessions stream into the same view via SSE.
- **Agent observability tab:** sessions count, error rate, total tokens, session-activity histogram, p50/p90/p95 for turns, active time, and tokens per session; tool-usage table; stop-reason breakdown; group-by agent version.
- **Platform metrics:** Prometheus + bundled Grafana dashboards for serving (per-deployment QPS, queue depth, KV-cache %, tokens/sec, replica count, GPU utilization) and agents (active sessions, event throughput). The console embeds the key serving charts; Grafana remains the deep-dive tool.

---

## 7. Technology Stack and Data Architecture

| Layer | Choice | Rationale |
|---|---|---|
| Console | Next.js (App Router, TypeScript) | User-set; SSR + streaming fit the live-trace UI |
| Platform API + Session Orchestrator | Node.js/TypeScript, single deployable (modular monolith) | One language with the frontend; split into services only when scale demands |
| Operator | Go + Kubebuilder | Idiomatic K8s reconciliation; extends the Go-based LLMkube naturally |
| Gateway | LiteLLM (containerized, config-managed by operator) | Proven OpenAI↔Anthropic dialect translation; replaceable behind the registered-routes contract |
| Session runner | Python wrapper (`runner.py`) + in-process `devproof_runner` loop in one pod | Runner owns the platform contract; the in-house loop owns the agent turn |
| Metadata | PostgreSQL | Sessions, events, entities; boring and reliable |
| Files/artifacts | MinIO (in-cluster) / S3 / Azure Blob | Same API everywhere incl. laptop |
| Event bus | NATS (Postgres LISTEN/NOTIFY fallback profile for minimal installs) | Lightweight fan-out for live traces |
| Metrics | Prometheus + Grafana (bundled, optional) | KEDA triggers and dashboards share one source |
| Packaging | Single Helm chart, `dev`/`prod` value profiles | Laptop-to-datacenter parity |

**Event volume note:** session events are append-only and can be large (multi-MB tool results). Payloads above a size threshold are stored in object storage with a Postgres pointer; the events table stays lean for list/filter queries.

---

## 8. Deployment and Local Development

- **Install:** `helm install devproof devproof/devproof -f values-dev.yaml` on kind/k3d/minikube. The `dev` profile: CPU-only ModelPool, catalog defaults to a 1–3B GGUF model (e.g. Qwen 3 1.7B Q4), in-cluster MinIO + single-node Postgres, NATS optional, no GPU drivers required.
- **Acceptance criterion:** the full journey — install → catalog → deploy small model → chat via gateway with an OpenAI SDK → create agent → run session with a file attached → watch the live trace → download an artifact — completes on a 32 GB laptop with no internet after initial image/model pull.
- **Production topology:** control plane on system nodes; ModelPools on labeled/tainted GPU nodes; agent session pods on a general workload pool; RWX storage class for the model cache where available.
- **Cloud (AWS/Azure):** dynamic ModelPools + cluster autoscaler; S3/Blob for files; managed Postgres optional.
- **Air-gapped:** private registry for images, pre-seeded model cache, catalog sources pointed at internal mirror.

---

## 9. Roadmap

Implementation follows this concept paper as the project's second phase; the roadmap below breaks that implementation into platform phases, each with a demoable exit criterion. ("Phase" below always means platform phase.)

| Phase | Scope | Exit criterion |
|---|---|---|
| **1 — Serving MVP** | Devproof operator + LLMkube provider, catalog UI, ModelPools, deploy/undeploy, gateway (OpenAI + Anthropic dialects), PVC cache, static replicas, dev Helm profile | An Anthropic-dialect coding CLI and an OpenAI SDK app chat with a locally served model through the gateway |
| **2 — Autoscaling & serving observability** | KEDA integration, capacity profiles + learning loop, dynamic/static pool modes, scale-to-zero, cache manager UI, serving dashboards | A load test scales a deployment out and back; on-prem static pool saturates gracefully |
| **3 — Agents core** | Agent CRUD + versioning, session pods (agent loop via `/v1/messages`), files upload/mount/outputs, Python client, sessions list + trace viewer (live SSE) | A support-triage demo agent analyzes an uploaded bundle on a self-hosted model; the full trace is inspectable |
| **4 — Agents platform completion** | Environments + network policy enforcement, skills, memory stores, credential vaults, MCP connectors, webhooks, agent observability rollups, session resume | The Anthropic-console workflow (per-ticket sessions, skills-driven analysis, persistent memory) reproduced end-to-end on Devproof |
| **Later** | AuthN/Z + RBAC, multi-workspace management UI, OCI/Fluid weight distribution, llm-d provider for multi-node serving, batch API, recurring/scheduled agents, agent templates & NL-assisted creation wizard | — |

---

## 10. Risks and Mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **LLMkube immaturity** (pre-1.0 API, single vendor) | Serving plane breakage on upstream changes; abandonment | Provider abstraction (§5.4); pin versions; KubeAI/direct-vLLM as implemented-interface fallbacks; contribute upstream where gaps found |
| R2 | **(Retired 2026-07-17)** External agent-runtime dependency | Behavior drift on upstream updates; subtle protocol mismatches through translation; ToS/licensing questions for commercial distribution | Resolved: the runtime is the in-house `devproof_runner` loop, built from scratch behind the runtime-agnostic runner contract (§6.3) — no client-visible change |
| R3 | **Open-weight model quality for agentic work** (tool-calling reliability vs. frontier hosted models) | Agents underperform expectations; product disappoints | `toolCalling` capability flags in the catalog; recommended-models list for agents; evaluation harness in phase 3 to grade candidate models on tool-use benchmarks; expectations set explicitly in docs |
| R4 | **Capacity estimates inaccurate** (tokens/sec varies with context length, batching, quantization) | Wrong sizing, thrashing autoscaler | Profiles are sizing hints only; live scaling uses measured queue pressure; learning loop replaces estimates with observations |
| R5 | **Anthropic-dialect translation gaps** (streaming tool use, images, new API features) | Agent runtime failures on edge cases | Conformance tests per LiteLLM/gateway upgrade; gateway version pinned and upgraded deliberately |
| R6 | **Scope breadth** (two products in one) | Slow time-to-value | Strict phasing with demoable exits; serving plane alone (phases 1–2) is already a useful product |
| R7 | **GPU heterogeneity** (AMD/Intel/Apple support claims vs. reality) | Pool types that don't actually work | Phase 1 validates NVIDIA + CPU only; other accelerators are explicitly experimental until tested |

---

## 11. Open Questions (deferred to implementation planning)

1. Gateway hardening: at what phase do API keys become real authentication rather than attribution?
2. Session pod security: is `NetworkPolicy` + non-root containers sufficient for phase 3, or is gVisor/Kata sandboxing required before any untrusted-prompt use?
3. Memory store implementation: PVC-per-store vs. object-storage-backed virtual FS (leaning object-storage for scalability; decide in phase 4 design).
4. Whether to upstream the ModelPool/capacity-profile concepts to LLMkube or keep them Devproof-proprietary.
5. Licensing/branding review of the agent runtime (R2) — moot: the runtime is built from scratch in-house (`devproof_runner`), so nothing external ships in it.

---

## Appendix A — ID conventions

`ws_…` workspace · `agent_…` agent · `agntv_…` agent version · `sesn_…` session · `sevt_…` session event · `env_…` environment · `skill_…` skill · `memstore_…` memory store · `mem_…` memory entry · `vlt_…` vault · `file_…` file · `dpk_…` API key · `mdep_…` model deployment record.

## Appendix B — Sources

- LLMkube: llmkube.com, github.com/defilantech/llmkube (CRDs, engines, cache, autoscaling)
- Serving alternatives: KServe `LLMInferenceService`/llm-d docs, KubeAI (kubeai.org), vLLM production-stack, AIBrix, NVIDIA NIM Operator docs
- Autoscaling: vLLM production-stack KEDA tutorial (`vllm:num_requests_waiting`), Gateway API Inference Extension (kubernetes-sigs)
- Weight caching: KServe OCI "modelcars", Fluid (CNCF), JuiceFS
- Agent runtime: `session-runner/devproof_runner` (in-repo, built from scratch), LiteLLM Anthropic-dialect docs
- Agent platform reference: Anthropic Managed Agents console (25 screenshots, analyzed 2026-07-07; entity model, trace viewer, environments, vaults, memory stores)
