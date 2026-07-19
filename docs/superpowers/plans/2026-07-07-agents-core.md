# Devproof AI — Sub-plan F: Agents Core (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Checkbox steps.

**Goal:** Managed agents on self-hosted models (concept §6): versioned Agents, Sessions executed in cluster pods running the runner's agent loop (today the from-scratch in-process `devproof_runner`) against the gateway's `/v1/messages`, typed event stream persisted and viewable in a console trace viewer, Python client. Exit: an agent session runs on `qwen05b-dp`, its full trace (messages, tool calls, tokens, durations) is inspectable in the console, driven from the Python client.

## Spike findings (verified live, 2026-07-07 — bake into all tasks)

- The then-current runner runtime works against the Devproof gateway (`ANTHROPIC_BASE_URL` + `model=qwen05b-dp`): session init, hooks, streaming all function; `ResultMessage.is_error=False`.
- **`jinja: true` required** on InferenceServices for tool schemas (operator sets it since commit `feat(operator): enable jinja…`). Without: llama.cpp "failed to parse grammar" at sampler init.
- **Explicit `tools=[...]` in the runner's options object is mandatory** — the full builtin toolset includes schemas llama.cpp's grammar converter rejects. Simple schemas work end-to-end (verified `tool_use` block from Qwen 0.5B via `/v1/messages`). Agent configs therefore always carry explicit tool lists (matches concept §6.1).
- Qwen 0.5B emits tool calls as literal text instead of `tool_use` blocks in the agent loop (model quality, concept risk R3). Plumbing E2E is still provable; document that real agent quality needs ≥7B `toolCalling: strong` models on GPU pools. ~130s/turn on this CPU cluster — set test timeouts generously.

## Architecture (dev-pragmatic, concept-conformant)

- **Postgres 17** single-pod manifest in `devproof-system` (PVC) — agents, agent_versions, sessions, session_events. Control plane migrates schema at startup (plain SQL, idempotent).
- **Files:** `FileStore` interface in control plane; dev impl = local directory (`.devproof/files`); S3/MinIO impl later. Session inputs mounted into runner pods is deferred — MVP passes the prompt only (files land in a later sub-plan; API shape defined now).
- **Session runner:** container image `devproof/session-runner` (python:3.12-slim + the runner's agent loop + runner.py). Reads env: `DEVPROOF_SESSION_ID`, `DEVPROOF_AGENT_CONFIG` (JSON: model, system_prompt, tools, max_turns), `DEVPROOF_PROMPT`, `ANTHROPIC_BASE_URL` (in-cluster gateway `http://gateway.devproof-gateway.svc:4000`), `DEVPROOF_EVENTS_URL` (control-plane callback). Maps every loop message → typed event (`session.created`, `agent.message`, `tool.call`, `tool.result`, `session.completed`, `session.failed`) POSTed as JSONL batches; exits when the turn completes → K8s Job semantics.
- **Image distribution on docker-desktop multi-node:** MUST verify `docker build` images are visible to `desktop-*` nodes; if not, run a local registry (`docker run -d -p 5001:5000 registry:2`) and reference `host.docker.internal:5001/...` with per-node containerd config or `imagePullPolicy: Never` + `docker save`/`ctr import` fallback. Record what works in `deploy/README.md`.
- **Callback reachability:** control plane runs out-of-cluster in dev; pods reach it via `http://host.docker.internal:7080` (verify; fallback: `kubectl get nodes -o wide` host IP).
- **Session orchestrator:** on `POST /v1/sessions` create DB row + K8s Job in `devproof-agents` ns; watch events arriving; session status from terminal events + Job status backstop.
- **Console:** Sessions page (list: id/name/agent/status/tokens/created) + session detail: chronological event list with role chips, tool name + args preview, per-event tokens/duration, offsets; live via SSE (`/v1/sessions/:id/events?stream=1`); Rendered/Raw toggle in a detail pane.
- **Python client** `clients/python/`: `Devproof(base_url).agents.create/list`, `.sessions.create(agent, prompt, name)`, `.sessions.events(id)` (SSE iterator), `.sessions.get(id)`.

## Tasks

### Task 1: Postgres + schema + repository
**Files:** `deploy/postgres/postgres.yaml`, `control-plane/src/db.ts` (pg pool + migrate), `control-plane/sql/001_agents_sessions.sql`, `control-plane/test/repo.test.ts`
Schema: `agents(id text pk, name text unique, created_at)`, `agent_versions(id text pk, agent_id fk, version int, model text, system_prompt text, tools jsonb, max_turns int, created_at, unique(agent_id, version))`, `sessions(id text pk, agent_id fk, agent_version int, name text, status text, prompt text, tokens_in bigint default 0, tokens_out bigint default 0, created_at, completed_at)`, `session_events(id bigserial pk, session_id fk, seq int, type text, payload jsonb, tokens_in int, tokens_out int, duration_ms int, created_at; unique(session_id, seq))`.
- [ ] Apply postgres manifest (ns `devproof-system`, PVC, password via Secret `devproof-pg`), port-forward 15432 for dev
- [ ] `db.ts`: pool + `migrate()` executing sql file (idempotent `CREATE TABLE IF NOT EXISTS`)
- [ ] Repository fns (TDD against live dev Postgres): `createAgent(name, config)` → v1; `newAgentVersion`; `getAgentVersion`; `createSession`; `appendEvents(sessionId, events[])` (monotonic seq, token rollup onto session); `getSession`, `listSessions`, `listEvents`
- [ ] Commit `feat(agents): persistence layer`

### Task 2: Agents + Sessions REST API
**Files:** `control-plane/src/agents-api.ts` (routes registered into server.ts), `control-plane/test/agents-api.test.ts` (fake repo)
Routes: `POST/GET /v1/agents` (create = name+model+system_prompt+tools[+max_turns] → version 1; update = new version), `GET /v1/agents/:id`; `POST /v1/sessions {agent, prompt, name?}`, `GET /v1/sessions[?agent=]`, `GET /v1/sessions/:id`, `GET /v1/sessions/:id/events` (`?stream=1` → SSE, else JSON page), `POST /v1/sessions/:id/events` (runner callback, batch append; no auth phase-1), `POST /v1/sessions/:id/status` (runner terminal callback).
- [ ] TDD routes with fake repo/orchestrator; wire real ones in main.ts
- [ ] Commit `feat(agents): agents and sessions API`

### Task 3: Session runner image
**Files:** `session-runner/Dockerfile`, `session-runner/runner.py`, `session-runner/README.md`
- [ ] runner.py: SDK query loop → event mapping (with per-event elapsed ms + usage tokens from ResultMessage), POST batches to `DEVPROOF_EVENTS_URL`, terminal status POST; explicit `tools` from config; `permission_mode="bypassPermissions"` (sandboxing = the pod; env/network policy later)
- [ ] Build image; **verify cluster visibility strategy** (registry vs import — record in deploy/README.md)
- [ ] Smoke: `kubectl run` one-off with env pointing at gateway + a `nc`-style echo sink → events arrive
- [ ] Commit `feat(agents): session runner image`

### Task 4: Orchestrator + E2E session
**Files:** `control-plane/src/orchestrator.ts`
- [ ] Create Job per session (ns `devproof-agents`, image, env incl. callback `http://host.docker.internal:7080`, backoffLimit 0, ttlSecondsAfterFinished 3600)
- [ ] E2E: `POST /v1/agents` (model qwen05b-dp, tools ["Bash"]) → `POST /v1/sessions` with prompt → events land in Postgres → session completes; `GET /v1/sessions/:id/events` shows agent.message events
- [ ] Commit `feat(agents): session orchestration e2e`

### Task 5: Console sessions + trace viewer
**Files:** `console/app/sessions/page.tsx`, `console/app/sessions/[id]/page.tsx`, client component for SSE tail
- [ ] Sessions list (agent, status chips, tokens, created; auto-refresh)
- [ ] Trace viewer: event rows (role chip, type, summary, tokens, duration, offset), detail pane with raw JSON toggle; SSE live-append for running sessions
- [ ] Commit `feat(console): sessions list and trace viewer`

### Task 6: Python client + demo
**Files:** `clients/python/pyproject.toml`, `clients/python/devproof/__init__.py`, `examples/demo_agent.py`
- [ ] Minimal client (httpx): agents.create/list, sessions.create/get/events(iterator over SSE)
- [ ] `examples/demo_agent.py`: create agent → session → stream events → print outcome. Run it; keep smokes green
- [ ] Commit `feat(clients): python client + demo`

## Deferred within phase 3 (recorded, not silent)
File upload/mounting, multi-turn `sessions.send()`, resume/checkpointing, environments/NetworkPolicy, memory stores, vaults, MCP connectors → phase 4 sub-plans. API shapes for these already fixed by concept §6.4.
