# Devproof AI — Sub-plan C: Gateway + Control Plane API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Checkbox steps.

**Goal:** LiteLLM-based AI gateway on the cluster exposing OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) dialects for deployed models, plus a Node/TS control-plane REST API: catalog listing, ModelPool/ModelDeployment CRUD (resolving catalog → CRD), and gateway config sync. Serving smoke test stays green; new gateway smoke test proves both dialects.

**Architecture (per concept §5.7, §7):** Gateway = LiteLLM proxy Deployment + ConfigMap in `devproof-gateway`, config generated from Ready ModelDeployments; MVP sync is an explicit control-plane action (`POST /v1/gateway/sync`) that rewrites the ConfigMap and restarts the proxy — operator-driven registration comes later (concept §5.4 lists it as operator duty; deferred deliberately, recorded here). Control plane = Fastify (TypeScript) service run out-of-cluster in dev; K8s access via `@kubernetes/client-node` behind a thin `KubeStore` interface so route logic is unit-testable with an in-memory fake. Catalog resolution (catalogId → ModelSource/resources) is a pure function with tests.

**Tech Stack:** LiteLLM proxy (`ghcr.io/berriai/litellm:main-stable`, pinned digest recorded in manifest), Fastify 5, TypeScript, tsx, node:test.

## Global Constraints
- Same as sub-plans A/B. Gateway namespace: `devproof-gateway`. No auth (phase 1).
- Control plane binds 127.0.0.1:7080 in dev.

### Task 1: Gateway on cluster
**Files:** `deploy/gateway/litellm.yaml` (Namespace, ConfigMap with `model_list` for `qwen05b-dp`, Deployment, Service :4000)
- [ ] Manifest with LiteLLM config: `model_name: qwen05b-dp` → `openai/qwen05b-dp`, `api_base: http://qwen05b-dp.devproof-serving.svc.cluster.local:8080/v1`
- [ ] Apply; pod Ready
- [ ] Verify OpenAI dialect via port-forward :14000 — `POST /v1/chat/completions {"model":"qwen05b-dp",...}` returns content
- [ ] Verify Anthropic dialect — `POST /v1/messages` with `x-api-key` + `anthropic-version` headers returns `content[0].text`
- [ ] Commit `feat(gateway): LiteLLM gateway with OpenAI + Anthropic dialects`

### Task 2: Control plane scaffold + catalog service (TDD)
**Files:** `control-plane/package.json`, `tsconfig.json`, `src/catalog.ts`, `test/catalog.test.ts`
**Interfaces:** `loadCatalog(path): CatalogEntry[]`; `resolveDeployment(catalog, {name, catalogId, poolRef, replicas?}): ModelDeploymentSpec-shaped object` (throws on unknown catalogId).
- [ ] Failing tests: parses seed catalog (1 entry, id/source/format), resolve maps catalogId→model source+resources+engine, unknown id throws
- [ ] Implement; tests pass (`npm test` = `node --import tsx --test test/`)
- [ ] Commit `feat(control-plane): catalog service`

### Task 3: KubeStore + REST API (TDD via in-memory fake)
**Files:** `src/kubestore.ts` (interface + real impl via CustomObjectsApi), `src/server.ts` (Fastify routes), `test/server.test.ts` (fake store)
**Routes:** `GET /healthz`; `GET /v1/catalog`; `GET|POST /v1/pools`; `GET|POST|DELETE /v1/deployments[/:name]` (POST resolves catalog, sets namespace `devproof-serving`); `POST /v1/gateway/sync` (build LiteLLM yaml from Ready deployments → ConfigMap `devproof-gateway/litellm-config` → patch Deployment restart annotation). `buildGatewayConfig(deployments): string` is pure + tested.
- [ ] Failing tests: catalog route returns entries; POST deployment creates CR with resolved model + printed status roundtrip; buildGatewayConfig yields model_list entries only for phase Ready; unknown catalogId → 400
- [ ] Implement; tests pass
- [ ] Commit `feat(control-plane): REST API with pool/deployment CRUD and gateway sync`

### Task 4: Live E2E
- [ ] Start control plane (`npm run dev`) against docker-desktop; `GET /v1/catalog` OK
- [ ] `POST /v1/deployments {name: qwen05b-api, catalogId: qwen2.5-0.5b-instruct-q4, poolRef: cpu-default}` → CR created, reaches Ready (cache hit, fast)
- [ ] `POST /v1/gateway/sync` → ConfigMap now routes `qwen05b-api`; gateway answers for model `qwen05b-api` on both dialects
- [ ] `node scripts/smoke-serving.mjs` still green; add `scripts/smoke-gateway.mjs` (both dialects) and run
- [ ] Cleanup: DELETE the test deployment via API, re-sync; commit `feat(control-plane): e2e verified`

## Self-review notes
- Gateway registration by control-plane sync (not operator) is a recorded MVP deviation from concept §5.4.
- LiteLLM `main-stable` tag pinned by digest at apply time (recorded in manifest comment) — R5 mitigation.
