# Devproof AI — Sub-plan G: Agents Platform Completion (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Checkbox steps.

**Goal:** Complete the managed-agents platform per concept §9 phase 4: files (upload → mounted at `/mnt/session/uploads/`), multi-turn sessions, environments with network policy, skills, memory stores, credential vaults, webhooks, and per-agent observability rollups. Ordered by user-stated priority: files and mid-session additions first.

**Carry-over context (verified in phases 1–3):** control plane out-of-cluster on :7080 (Fastify/TS, Postgres via port-forward 15432); session pods = K8s Jobs in `devproof-agents` running `devproof/session-runner:dev` (docker-built images visible to cluster; callback via host.docker.internal:7080); gateway `/v1/messages` at `http://gateway.devproof-gateway.svc.cluster.local:4000`; agents must use explicit tools lists; models need `jinja`.

## Tasks (each: TDD where logic exists, live verify, commit)

### Task 1: Files
- `files(id, session_id nullable, name, size, sha256, created_at)` table; `FileStore` interface with local-dir impl (`.devproof/files/<id>`); S3 impl deferred.
- Routes: `POST /v1/files` (multipart upload), `GET /v1/files/:id/content`, `GET /v1/files?session=`.
- Session attachment: `POST /v1/sessions {files: [file_id]}` → orchestrator stages file contents into the Job via an init approach that works with an out-of-cluster control plane: runner downloads attachments from `DEVPROOF_EVENTS_URL/../files/:id/content` into `/mnt/session/uploads/` before starting the loop (no shared volume needed in dev). Prompt is prefixed with a "Newly attached files" block listing mounted paths (matches Anthropic console pattern).
- E2E: upload a text file, session with `tools:["Read"]` + prompt referencing it; trace shows the file being read.

### Task 2: Multi-turn sessions + resume
- `POST /v1/sessions/:id/messages {prompt, files?}` → if session pod gone (Job completed): new Job with `DEVPROOF_RESUME=<sdk_session_id>` (runner passes `resume=` to the loop; loop session state persisted to the workspace dir must survive — runner uploads the loop's state dir (session JSONL; of the legacy runner runtime — checkpoints now capture `~/.devproof`) as a session artifact at end of turn and restores before resume; store as file rows tagged `kind=checkpoint`).
- Session status transitions `completed → running` on new turn; `idle` introduced as the between-turns terminal-per-turn state (list UI chip).
- E2E: two-turn conversation where turn 2 references turn 1 content.

### Task 3: Environments + NetworkPolicy
- `environments(id, name, allowed_hosts jsonb, allow_package_managers bool, created_at)`; agent versions get `environment_id` nullable.
- Orchestrator: label session pods `devproof.ai/environment=<name>`; apply per-environment `NetworkPolicy` in `devproof-agents` (default-deny egress except DNS + gateway + control-plane callback; allowed_hosts as documented limitation — L7 host allowlists need an egress proxy, phase 4+ note, NOT silently claimed).
- E2E: session in restricted env cannot curl an external IP; can still reach gateway.

### Task 4: Skills
- `skills(id, name, version, created_at)` + content dirs (`.devproof/skills/<id>/SKILL.md` + resources) via FileStore; Anthropic-compatible format.
- Runner: downloads agent's skills into the workspace skills dir before start (SDK `setting_sources`/skills loading; skills stage at `/work/.devproof/skills` today); agent version gets `skill_ids jsonb`.
- E2E: skill with a distinctive instruction demonstrably alters agent output.

### Task 5: Memory stores
- `memory_stores(id, name, created_at)`; content = FileStore dir per store; runner mounts (downloads) store files to `/mnt/memory/` and uploads changes back at turn end (last-write-wins, dev semantics documented); agent version gets optional `memory_store_id`; console file-tree browser page.

### Task 6: Credential vaults (K8s Secrets) + MCP config
- `vaults` table mapping to K8s Secret `devproof-vault-<id>` in `devproof-agents`; agent version gets `mcp_servers jsonb` (SDK `mcp_servers` passthrough) with `{"env_from_vault": ...}` resolution; secrets injected as Job env, never logged.
- E2E: agent with an in-process/simple MCP server config uses a tool through it.

### Task 7: Webhooks + observability rollups
- `webhooks(id, url, events jsonb)`; control plane POSTs `session.completed/failed` payloads (at-least-once, 3 retries).
- `GET /v1/agents/:id/observability`: sessions count, error rate, token totals, p50/p95 turns+duration+tokens (SQL percentile_cont), tool-usage counts from events; console Observability tab per agent.

## Definition of done (phase 4)
Anthropic-console workflow reproduced: per-ticket session with attached bundle, skills-driven analysis, persistent memory, restricted egress, trace + rollups — on self-hosted models. Smokes + all suites green.
