# Devproof AI — Anthropic Platform Alignment & Scale Notes

Companion to `devproof-ai-concept.md`. Records (1) how Devproof's entities and
APIs map to the Anthropic platform docs, and (2) the concrete scaling posture
for hundreds to thousands of concurrent session pods.

## 1. Entity & API alignment

| Concept | Anthropic | Devproof | Status |
|---|---|---|---|
| Workspace id | `wrkspc_…`, `type:"workspace"` | `wrkspc_…` | aligned |
| API key id | `apikey_…`, status `active/inactive/archived/expired` | `apikey_…`, status `active/inactive/archived` | aligned (no `expired` auto-state yet) |
| Message batch | `msgbatch_…`, `processing_status: in_progress/canceling/ended`, `request_counts{processing,succeeded,errored,canceled,expired}`, per-item `custom_id` | `msgbatch_…`, `processing_status: in_progress/ended`, counts `total/succeeded/errored`, `custom_id` | aligned (no cancel/expire lifecycle) |
| Memory store | `memstore_…`, versions `memver_…`, mounted `/mnt/memory/<slug>/`, optimistic concurrency via `content_sha256`, ≤100 kB/memory, ≤2000/store | `memstore_…`, mounted `/mnt/memory`, diff sync by content hash | aligned in shape; no `memver_` audit versions (uses immutable file blobs instead) |
| File | `file_…`, `type:"file"`, `size_bytes`, `mime_type` | `file_…` | aligned |
| Session tools | `bash, read, write, edit, glob, grep, web_fetch, web_search` (toolset `agent_toolset_20260401`) | `Bash, Read, Write, Edit, Glob, Grep, WebFetch` (SDK names) + Python via Bash | aligned (SDK casing; web_search omitted — needs a search backend) |
| Egress control | `config.networking {type:"limited", allowed_hosts, allow_mcp_servers, allow_package_managers}` | environment `{allowedHosts, allowPackageManagers}` → Squid + NetworkPolicy | aligned |
| Session status | `idle, running, rescheduling, terminated` (starts `idle`) | `queued, running, idle, completed, failed` | superset — Devproof keeps `queued/completed`; `failed`≈`terminated`. See note. |
| Usage report | `GET /v1/organizations/usage_report/messages`, group_by model/workspace/api_key, token metrics | `/v1/usage` (sessions) + `/v1/usage/gateway` (per key/model/date-range presets) | aligned in dimensions (key, model, time) |
| Admin API | `/v1/organizations/{workspaces,users,api_keys,invites}` | `/v1/workspaces`, `/v1/api-keys` (workspace-scoped) | subset; no org/users/invites/roles yet (no auth) |

**Deliberate deviations (documented, not accidental):**
- **No auth/RBAC yet** (concept §11.1). Workspace is an isolation + attribution
  scope via the `X-Devproof-Workspace` header, not a security boundary. Org,
  users, invites, and workspace roles are future work.
- **Endpoints are Devproof-flat** (`/v1/agents`, `/v1/api-keys`) rather than
  org-nested (`/v1/organizations/…`), because there is a single implicit org.
- **Session status** keeps `queued` (pre-pod) and `completed` (successful
  terminal) which Anthropic folds into `idle`/`terminated`. Mapping for API
  compatibility can be added in a translation layer if needed.
- **API keys** are created via API here (returning the secret once); Anthropic
  restricts creation to the Console. Same security property (hash stored, hint
  shown), different surface.

## 2. Scaling posture (hundreds → thousands of pods)

What already scales, and the known bottlenecks with their direction. Severity is
for the target of thousands of concurrent session pods.

| Area | State | Direction |
|---|---|---|
| **Session isolation** | ✅ One K8s Job per turn; pod exits when idle → **zero pod cost while idle**; checkpoint+resume on next message. This is the core scale property and it holds. | Warm-pool / pod-reuse to cut cold-start at very high churn (optional). |
| **File attachments** | ✅ Fixed. Was single-host local disk (`localFileStore`) — did **not** scale. Now MinIO/S3 (`s3FileStore`): one shared bucket across all control-plane replicas and session pods, content-addressed by sha256 (identical uploads dedup). Enabled via `DEVPROOF_S3_ENDPOINT`. | Blob refcount GC job (deleting a file record unrefs; shared blobs need a sweep); multi-node MinIO / real S3 for HA. |
| **Memory concurrency** | ✅ Fixed. Diff-based write-back (only changed files), explicit deletes, per-path conditional upsert (`WHERE file_id <> EXCLUDED.file_id`). Concurrent sessions on one store no longer clobber each other's untouched paths. | Object-storage-backed store + `content_sha256` optimistic concurrency for same-path conflicts (Anthropic's model); blob GC. |
| **Live trace (SSE)** | ⚠️ 1 s DB poll per viewer (`agents-api.ts`). N viewers × M live sessions = N×M queries/s. Fine for tens; not thousands of concurrent viewers. | Postgres `LISTEN/NOTIFY` or NATS fan-out on event append (concept §7 already specifies NATS). **Top scale item.** |
| **Control plane** | ⚠️ Single process, out-of-cluster in dev, pods call back via `host.docker.internal`. | In-cluster Deployment (≥2 replicas) behind a ClusterIP Service; callbacks to the service DNS. Removes the host-CIDR NetworkPolicy shortcut. **Second scale item.** |
| **Gateway sync** | ⚠️ Full ConfigMap rewrite + single-replica proxy restart on route changes → drops in-flight traffic. Keys are now real authentication at the gateway (`custom_auth` + metering hooks), not just attribution. Sync is now **automatic** (operator triggers it on Ready-transitions and deletes, env `DEVPROOF_CONTROL_PLANE_URL`) and **diff-aware** (identical config → no patch, no restart). External provider endpoints (BYO OpenAI/Anthropic/OpenRouter/custom) route through the same gateway with the same auth/metering. | Multi-replica gateway with rolling reload / DB-backed LiteLLM config; per-workspace partition. |
| **session_events growth** | ⚠️ Append-only, payloads inline (JSONB), no retention. Per-session `FOR UPDATE` lock is fine (per-session). | Offload large payloads to object storage with a pointer (concept §7); time-partition + retention. |
| **Serving autoscale** | ⚠️ CPU@75% HPA only (LLMkube 0.9.1 queue-metric dead-end, documented in `deploy/README.md`). | Upstream LLMkube fix or non-LLMkube provider for queue-pressure + scale-to-zero. |
| **Workspaces** | ✅ Scoped in DB + API with composite indexes (`(workspace_id, created_at)`). Session pods labeled per environment; single `devproof-agents` namespace. | Per-workspace namespace (`devproof-agents-<ws>`) for hard multi-tenant isolation + quota at thousands of tenants. |
| **DB** | ⚠️ Single Postgres, pool max 5. | Managed HA Postgres + read replicas for list/usage queries; raise pool; PgBouncer. |
| **Image distribution** | ⚠️ Same-tag rebuilds not seen by nodes (bump tag). | Registry with immutable digests + pull secrets. |

**Summary:** the *session model itself* (idle→zero, checkpoint/resume, per-turn
Jobs) and the *data model* (workspace-scoped, indexed) are built to scale. The
four things to fix before thousands of pods are, in order: (1) push-based events
instead of SSE polling, (2) in-cluster multi-replica control plane, (3)
non-restarting gateway reload, (4) large-payload/event offload to object
storage. None require redesign — all are named in the concept (§7) and are
incremental.

## 3. Managed Agents resource model — findings & our alignment (2026-07-08)

Investigated against the Managed Agents docs. Exact attachment points:

| Resource | Anthropic attachment | Config shape | Devproof today | Deviation |
|---|---|---|---|---|
| **Input files** | session `resources[]` `{type:"file", file_id, mount_path}`; a file can mount into many sessions (each mount makes a session-scoped copy id) | discriminator is `downloadable:false` | `session_files(role='input')` join → a file attaches to many sessions; mounted at `/mnt/session/uploads` | aligned (we use a join + role instead of a copy-id) |
| **Output files** | agent writes to `/mnt/session/outputs`, surfaced via `files.list(scope_id=session)`, `downloadable:true` | first-class File objects | runner uploads outputs → `session_files(role='output')`, kind='output' | aligned |
| **Skills** | agent `skills[]` `{type, skill_id, version}`; ZIP upload; ≤20/session; needs `read` tool | multi-file package | agent `skill_ids`; ZIP → file manifest; staged to `/work/.devproof/skills/<name>/` | aligned |
| **Tools** | agent `tools[]` toolset `agent_toolset_20260401` + per-tool `configs`; MCP as `mcp_toolset` | names: bash/read/write/edit/glob/grep/web_fetch/web_search | agent `tools[]` (SDK names); web_search omitted | aligned (naming/casing differs) |
| **Environment** | **session-level** `environment_id` (required); NOT on agent | `config.networking {type, allowed_hosts, allow_mcp_servers, allow_package_managers}`, `packages`, `type cloud|self_hosted` | environment set on **agent version**; egress = Squid+NetworkPolicy | **DEVIATION**: we attach at agent level. Functionally equivalent (session inherits agent env); a session-level override is the follow-up. |
| **Credential vaults** | **session-level** `vault_ids[]`; vault has credentials (`vcrd_`) with auth types `mcp_oauth`/`static_bearer`/`environment_variable`; matched to MCP by url | secrets write-only | vault on **agent version** → K8s Secret env-injected; credentials now **typed** (`environment_variable`/`bearer_token`/`mcp_oauth`, migration 028), bearer/oauth ones bound to an MCP server URL and matched to it (`renderMcpServers`, `src/mcp.ts`) | **DEVIATION**: agent-level (not session `vault_ids[]`); URL-matching now shipped. Session-level `vault_ids` + attachment is the remaining follow-up. |
| **MCP servers** | **agent-level** `mcp_servers[] {type:"url", name, url}` + matching `mcp_toolset`; auth via session `vault_ids`; events `agent.mcp_tool_use/result`; egress via env `allow_mcp_servers` | streamable-HTTP | agent `mcp_servers` (SDK passthrough); console editor + bundled registry (`catalog/mcp-servers.yaml`, `GET /v1/mcp-registry`); env `allow_mcp_servers` toggle adds the env's agents' MCP hosts to the Squid allowlist | aligned on attachment level + egress toggle; still no `mcp_toolset` |

**Decisions recorded:** we keep environment + vault at **agent level** for now (simpler, and the session inherits and *displays* them — the session detail page shows the effective environment, vault, tools, skills, MCP, and input/output files). Moving them to session-level attachment (with per-session override, `vault_ids[]`, and credential auth types) is the documented next step; it's a data-model change, not a redesign. The session page already surfaces every resource so the effective config is visible even though agents can change between versions.

## 4. Lifecycle & management completeness (2026-07-08)

Round of CRUD/lifecycle work — the resource model is now fully manageable from
the console, and the catalog is user-extensible.

| Area | Before | Now |
|---|---|---|
| **Deletes** | sessions / files / memory / skills only | all resource types deletable: **agents** (cascade sessions/batches/versions), **API keys**, **vaults** (+ K8s Secret), **environments** (+ Squid/NetworkPolicy teardown), **batches**, **cached models**. Migration `014` sets FK `ON DELETE CASCADE`/`SET NULL`. |
| **Model catalog** | static bundled YAML only | + **custom models** (DB `catalog_models`, merged with YAML): add HF GGUF/safetensors from the UI, deploy, remove. Custom entries auto-get a CPU capacity profile. |
| **Skills** | single version, no browse | **versioned** (re-upload same name → version bump in place); detail page lists package files, each viewable. |
| **Credential vaults** | write-once secret map at create | **editable named credentials** (add/rotate/remove), each patching one key of the K8s Secret. Names in `vault_credentials` (migration `015`); values write-only. |
| **Pagination** | ad-hoc (files only, 25/page) | **uniform 100/page across every list**, always-visible pager, controls disabled at ≤100 items; endpoints return `{rows, count, offset}`. |
| **Deploy progress** | generic "Deploying" | **"Downloading N%"** phase from the LLMkube Model status (`size`/`sourceContentLength`), surfaced by the operator as `status.downloadPercent`. |

**Still deferred (unchanged):** session-level environment/vault attachment with
`vault_ids[]` + credential auth types; `mcp_toolset` + vault-url matching; the
concept §7 scale items (in-cluster multi-replica control plane, event offload).
