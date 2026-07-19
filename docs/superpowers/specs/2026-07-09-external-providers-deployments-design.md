# External Provider Endpoints + Editable Deployments — Design

**Date:** 2026-07-09
**Status:** Approved (brainstorming session)
**Companion to:** `docs/concept/devproof-ai-concept.md` §5.7 (gateway),
`2026-07-09-gateway-auth-usage-design.md` (auth/metering the feature builds on).

## Problem

Deployments today are exclusively local models: `ModelDeployment` CRs
materialized by the operator onto cluster pools, `POST`/`DELETE` only. Many
customers already have model access elsewhere — OpenAI API, Anthropic API,
OpenRouter, or another local server (vLLM/Ollama/llama.cpp on a GPU host that
this cluster can't schedule). They should be able to register those endpoints
and get the full Devproof experience — gateway routing, API-key enforcement,
token metering on the Usage page, both dialects (so Anthropic-dialect CLI
clients work against any of them) — without Devproof managing the backend's
lifecycle. Deployments
also aren't editable: changing replicas or context size means delete+recreate.

## Requirements (user, 2026-07-09)

1. Configurable **connection endpoints** for external model providers:
   OpenAI API, Anthropic API, OpenRouter, and any other
   OpenAI-compatible local/remote deployment.
2. **Deployments become editable.**
3. Version tracking was requested, then **explicitly dropped from scope**
   ("lets skip the versioning for now"). Editing remains in scope.

## Decisions

- **Typed providers + custom** (chosen over OpenAI-compatible-only and raw
  LiteLLM passthrough): provider dropdown `openai | anthropic | openrouter |
  custom`; known providers get base-URL presets and native LiteLLM dialect
  handling; `custom` takes any OpenAI-compatible `/v1` URL (covers vLLM,
  Ollama, llama.cpp, LM Studio — including a host GPU container via
  `host.docker.internal`).
- **Operational-field editing** (chosen over everything-but-name and
  external-only): local deployments edit `replicas.min/max`, `contextTokens`,
  `engine`, `targetTokensPerSec` (CR patch → pods roll); external deployments
  edit `baseUrl`, `modelId`, and rotate the API key (write-only). Identity
  (name) and a local deployment's model source are immutable — a different
  model is a new deployment.
- **No version tracking** (descoped). Consequence: local deployments need no
  DB mirror — the CR stays the single source of truth; only external
  endpoints get a table.
- **Sanitizer scoped to local backends** (refinement, approved): the GBNF
  schema scrub must not degrade tool schemas sent to premium providers.

## Architecture

```
GET /v1/deployments  =  local ModelDeployment CRs (kind:"local", as today)
                        + external_deployments rows (kind:"external", phase "External")

buildGatewayConfig(localCRs, externals) →
  local:    model openai/<name>, api_base <cluster endpoint>,
            model_info: { devproof_local: true }
  external: model <provider-prefixed>/<model_id>, api_base per provider,
            api_key: os.environ/DEVPROOF_EP_<sanitized id>,
            model_info: { devproof_local: false, key_version: N }
```

Everything downstream of the gateway is unchanged and applies automatically to
external endpoints: API-key enforcement, per-request metering into
`gateway_usage` (Usage page filters), Anthropic + OpenAI dialects, streaming.
Agents may reference an external deployment as their model like any other.

## Components

### 1. Migration `sql/017_external_deployments.sql`

```sql
CREATE TABLE IF NOT EXISTS external_deployments (
  id           TEXT PRIMARY KEY,          -- mdep_…
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL UNIQUE,      -- gateway model name; shares one flat
                                          -- namespace with local CR names
  provider     TEXT NOT NULL CHECK (provider IN ('openai','anthropic','openrouter','custom')),
  base_url     TEXT,                      -- required for custom; optional override otherwise
  model_id     TEXT NOT NULL,             -- e.g. gpt-4o, meta-llama/llama-3.1-8b
  key_version  INT NOT NULL DEFAULT 1,    -- bumped on rotation → config bytes change → gateway rolls
  has_key      BOOLEAN NOT NULL DEFAULT false, -- config gen needs to know whether to emit api_key (key itself is never in the DB)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS external_deployments_ws ON external_deployments (workspace_id, created_at);
```

**API keys never touch Postgres or the ConfigMap.** They live in one K8s
Secret `gateway-provider-keys` (namespace `devproof-gateway`); entry key =
`DEVPROOF_EP_<id sanitized to [A-Za-z0-9_]>` (env-var-safe), value = the
provider key. The gateway Deployment adds
`envFrom: [{ secretRef: { name: gateway-provider-keys, optional: true } }]`.
Rotation patches the Secret entry and bumps `key_version`; the resulting
config diff makes the (diff-aware) sync roll the gateway, which re-reads env.
Providers without a key (local custom servers) simply omit the `api_key`
line.

### 2. Gateway config generation (`gateway-config.ts`)

Provider mapping:

| provider | litellm `model` | `api_base` |
|---|---|---|
| openai | `openai/<model_id>` | omitted (LiteLLM default) unless overridden |
| anthropic | `anthropic/<model_id>` | omitted unless overridden |
| openrouter | `openrouter/<model_id>` | omitted unless overridden |
| custom | `openai/<model_id>` | **required** |

Local entries are unchanged except gaining
`model_info: { devproof_local: true }`. The don't-regress test extends to
assert this flag — the sanitizer coupling (below) is pinned by CI.

### 3. Sanitizer scoping (`custom_callbacks.py`)

- At module load, parse the co-mounted `/etc/litellm/config.yaml` (pyyaml
  ships in the image) and build `LOCAL_MODELS` = model names whose
  `model_info.devproof_local` is true.
- `async_pre_call_hook` scrubs tool schemas **only** when
  `data["model"] ∈ LOCAL_MODELS`. GGUF/llama.cpp targets keep GBNF
  protection; external providers receive full-fidelity schemas.
- Freshness: every config change already restarts the gateway pod (sync), so
  the parsed set cannot go stale.
- **Failure bias:** if the parse fails, scrub everything — degrade toward
  today's behavior (loose schemas everywhere), never toward broken local
  models. Anthropic-dialect CLI clients on GGUF models must keep working
  unconditionally.

### 4. Control-plane API

- `POST /v1/deployments/external` `{name, provider, baseUrl?, modelId, apiKey?}`
  → validate (name not colliding with any CR or external name → else 409;
  `custom` requires `baseUrl`), create row + Secret entry, trigger gateway
  sync. Returns the record (no key).
- `PATCH /v1/deployments/external/:id` `{baseUrl?, modelId?, apiKey?}` —
  `apiKey` present → patch Secret entry + bump `key_version`. Any change →
  sync.
- `DELETE /v1/deployments/external/:id` → remove row + Secret entry → sync.
- `POST /v1/deployments/external/test` `{provider, baseUrl?, apiKey?}` —
  connection probe (GET the provider's model list with the given
  credentials); used by the console's "Test connection" button before saving.
  Returns `{ok, detail}`. (A row-level re-probe on an existing record is
  deferred: the stored key is write-only, so it can't be re-supplied to the
  probe — only the add-form probe ships.)
- `PATCH /v1/deployments/:name` (**local**) — accepts ONLY
  `{replicas?, contextTokens?, engine?, targetTokensPerSec?}`; rejects other
  fields (400). Merge-patches the CR spec; the operator reconciles (pods
  roll), and the existing auto-sync keeps the route through the transition.
- `GET /v1/deployments` — merged list, externals appended with
  `kind:"external"`, `phase:"External"`, `provider`, `modelId`. Local rows
  gain `kind:"local"`. Merging happens **before** the standard 100/page
  pagination (one combined, name-sorted list; `count` covers both kinds). External rows are workspace-scoped by the standard
  header; local CRs remain cluster-global (pre-existing asymmetry, unchanged
  by this feature — recorded, not fixed).

### 5. Console

- Deployments page: **"Add endpoint"** button beside catalog Deploy → form:
  provider dropdown (selecting a known provider pre-fills/locks the base URL
  unless "override" is expanded), model id, optional API key (write-only
  password field), **Test connection**, Save.
- List: kind badge (`Local` / provider name), phase column shows `External`
  for endpoints; edit + delete row actions for externals.
- **Edit** action on local rows → dialog with the four operational fields.
  As implemented (`console/app/deployments/edit-local.tsx`), the dialog's
  prompt sequence only covers `replicas.min`/`replicas.max` and
  `contextTokens`; `engine` and `targetTokensPerSec` are PATCH-whitelisted
  server-side (§4) but have no console entry point yet — a documented gap,
  not a regression.
- No changes needed on the Usage page — external deployments appear in the
  deployment filter automatically once traffic flows.

### 6. Error handling

| Case | Behavior |
|---|---|
| Name collision (CR or external) | 409 on create |
| `custom` without `baseUrl` | 400 |
| Invalid provider key at runtime | LiteLLM surfaces the upstream 401/4xx to the caller; "Test connection" is the proactive check |
| Provider outage | upstream error passthrough; no retry logic in v1 |
| Local PATCH with non-operational fields | 400 listing allowed fields |
| Secret/DB partial failure on create | row first (the Secret entry key derives from the row id), then Secret; a Secret-write failure deletes the row. Invariant: no orphaned credentials, and no keyed row without its Secret entry |

No continuous health polling in v1 (YAGNI).

### 7. Egress note (recorded for later topologies)

The gateway pod must reach external providers (api.openai.com, etc.). On
docker-desktop this is open. In a future egress-controlled/in-cluster
topology, the gateway namespace needs an allowlist covering configured
provider hosts — flagged here so it lands in that design, not discovered in
production. This includes CP-originated probe traffic (the Test endpoint
fetches user-supplied URLs — an internal port-scan oracle in hostile
networks) and the baseUrl-change key-exfil path (repointing a keyed
endpoint makes the gateway send the stored key to the new URL): the future
hardening pass needs probe restrictions (metadata/link-local blocklist or
allowlist) and possibly re-confirmation on baseUrl changes.

### 8. Testing

- **Unit (Node):** `buildGatewayConfig` provider-mapping matrix (4 providers ×
  base-url override × key/no-key), `devproof_local` flags on both kinds,
  `key_version` in `model_info`, env-var name sanitization; external CRUD +
  validation (409/400 paths) with the fake kubestore; local PATCH field
  whitelist.
- **Repo (live-DB):** external_deployments roundtrip incl. key_version bump.
- **E2E (live cluster):**
  1. Add a `custom` endpoint pointing at a host llama.cpp container
     (`host.docker.internal`) → Test → chat via gateway with a Devproof key →
     usage row lands with the endpoint's name.
  2. If a real provider key is available (user-supplied at test time): add an
     `openrouter` or `anthropic` endpoint, verify chat + **streaming token
     metering** (the one remaining unverified assumption — LiteLLM's usage
     normalization on non-OpenAI backends).
  3. Edit a local deployment's replicas/context → CR patched, pods roll,
     route survives (auto-sync), Anthropic-dialect CLI clients still work
     (sanitizer still applied to local).
  4. Key rotation: rotate an external key → gateway rolls → old key env gone.
- Regression: full backend suite, `tsc --noEmit`, console production build,
  all pages 200.

## Out of scope (deliberate)

- **Version tracking / history / rollback** (user-descoped this session).
- Continuous health checks of external endpoints.
- Cost/pricing metadata for external providers (usage counts tokens only).
- Workspace scoping of *local* deployments (pre-existing asymmetry).
- Egress allowlisting for the gateway namespace (recorded in §7).
- Provider-specific extras (org ids, Azure OpenAI deployments, custom
  headers) — the `custom` provider plus base-URL override covers the common
  cases; extras arrive when a customer needs them.

## Verified-assumption ledger

- LiteLLM provider prefixes + `os.environ/` key refs: core documented
  behavior (same mechanism the gateway uses today). High confidence.
- `model_info` as a metadata bag: documented LiteLLM config surface.
- Token-usage normalization on `anthropic/`/`openrouter/` backends incl.
  streaming: **unverified by us** — covered by e2e §8.2; metering fields were
  spike-verified for OpenAI-dialect backends on 2026-07-09.
