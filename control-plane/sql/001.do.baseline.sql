-- Devproof AI control-plane schema baseline.
-- Consolidated from the 44 accreted migration files (control-plane/sql/001..044)
-- into a single Postgrator "do" migration. Semantically identical to the
-- legacy chain's end state (verified via schema+seed pg_dump diff) — this is
-- the curated, readable form, not a raw dump.

-- ============================================================
-- Workspaces & settings
-- ============================================================

-- Multi-tenancy: every entity belongs to exactly one workspace (Anthropic
-- org->workspace model). wrkspc_default is immutable (no rename/disable/delete).
-- status: active | disabled | deleting | deleted. A deleted workspace is a
-- TOMBSTONE: the row (id + name) survives forever so gateway_usage stays
-- attributable; all resources are drained by workspace-delete.ts.
CREATE TABLE workspaces (
    id text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    delete_totals jsonb
);

CREATE TABLE app_settings (
    id text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_settings_id_check CHECK ((id = 'global'::text))
);

ALTER TABLE ONLY workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);

ALTER TABLE ONLY app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (id);

-- Tombstones keep their name without blocking reuse: uniqueness applies to
-- live (non-deleted) rows only.
CREATE UNIQUE INDEX uq_workspaces_live_name ON workspaces USING btree (name) WHERE (status <> 'deleted'::text);

-- ============================================================
-- Agents / sessions / events
-- ============================================================

-- Agent lifecycle: disabled agents reject NEW sessions and follow-up messages
-- (409); running turns always finish.
CREATE TABLE agents (
    id text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id text DEFAULT 'wrkspc_default'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Each save is a new version row (append-only); only removed by the agents
-- cascade.
CREATE TABLE agent_versions (
    id text NOT NULL,
    agent_id text NOT NULL,
    version integer NOT NULL,
    -- Agents reference routings only (never a deployment/external endpoint
    -- directly) — routing must name an existing row in `routings`.
    routing text NOT NULL,
    system_prompt text DEFAULT ''::text NOT NULL,
    tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    max_turns integer DEFAULT 10 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    environment_id text,
    skill_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    mcp_servers jsonb DEFAULT '{}'::jsonb NOT NULL,
    vault_id text,
    workspace_id text DEFAULT 'wrkspc_default'::text NOT NULL,
    -- Seconds a single turn's runner pod may live (K8s Job
    -- activeDeadlineSeconds). NULL = platform default (7200).
    turn_deadline_sec integer,
    -- Agent delegation: agents this version may push work to via the
    -- Delegate tool; a delegated session carries its parent's id
    -- (sessions.parent_session_id). One level only.
    subagents jsonb DEFAULT '[]'::jsonb NOT NULL,
    -- Wikis this version mounts: [{wikiId, mode:"read"|"write"}]. Read is the
    -- default and unlimited; write is exclusive (one writer agent per wiki)
    -- and makes the agent single-session so writes never race.
    wiki_refs jsonb DEFAULT '[]'::jsonb NOT NULL
);

CREATE TABLE sessions (
    id text NOT NULL,
    agent_id text NOT NULL,
    agent_version integer NOT NULL,
    name text,
    status text DEFAULT 'queued'::text NOT NULL,
    prompt text DEFAULT ''::text NOT NULL,
    -- tokens_in/out (and billed_cost, last_model below) are accumulated ONLY
    -- by the gateway_usage `session_usage_accumulate` trigger (see usage/
    -- billing section) — appendEvents must never re-accumulate event-reported
    -- usage; the runner's session.result usage stays display-only.
    tokens_in bigint DEFAULT 0 NOT NULL,
    tokens_out bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    sdk_session_id text,
    checkpoint_file_id text,
    turns integer DEFAULT 0 NOT NULL,
    memory_store_id text,
    workspace_id text DEFAULT 'wrkspc_default'::text NOT NULL,
    billed_cost numeric DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_model text,
    -- Delegated child sessions carry their parent's id (one level only: the
    -- CP resolves `subagents` to [] for any session with a parent).
    parent_session_id text
);

CREATE TABLE session_events (
    id bigint NOT NULL,
    session_id text NOT NULL,
    seq integer NOT NULL,
    type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    tokens_in integer DEFAULT 0 NOT NULL,
    tokens_out integer DEFAULT 0 NOT NULL,
    duration_ms integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id text DEFAULT 'wrkspc_default'::text NOT NULL,
    -- Idempotency key: the runner posts events at-least-once (retries on
    -- transient CP/network failure) and mints a uid per event; appendEvents
    -- skips any uid already stored for the session.
    uid text
);

CREATE SEQUENCE session_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE session_events_id_seq OWNED BY session_events.id;

ALTER TABLE ONLY session_events ALTER COLUMN id SET DEFAULT nextval('session_events_id_seq'::regclass);

ALTER TABLE ONLY agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY agent_versions
    ADD CONSTRAINT agent_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY agent_versions
    ADD CONSTRAINT agent_versions_agent_id_version_key UNIQUE (agent_id, version);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_events
    ADD CONSTRAINT session_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_events
    ADD CONSTRAINT session_events_session_id_seq_key UNIQUE (session_id, seq);

-- Names are unique per-workspace, not globally (same pattern used by every
-- workspace-scoped resource below).
CREATE UNIQUE INDEX uq_agents_ws_name ON agents USING btree (workspace_id, name);

CREATE INDEX idx_agents_ws ON agents USING btree (workspace_id, created_at DESC);
CREATE INDEX idx_agents_ws_updated ON agents USING btree (workspace_id, updated_at DESC);
CREATE INDEX idx_sessions_agent ON sessions USING btree (agent_id, created_at DESC);
CREATE INDEX idx_sessions_ws ON sessions USING btree (workspace_id, created_at DESC);
CREATE INDEX idx_sessions_ws_updated ON sessions USING btree (workspace_id, updated_at DESC);
CREATE INDEX idx_sessions_parent ON sessions USING btree (parent_session_id) WHERE (parent_session_id IS NOT NULL);
CREATE INDEX idx_session_events_session ON session_events USING btree (session_id, seq);

-- Nullable + partial unique index: pre-idempotency/uid-less events (and any
-- future caller that omits a uid) insert unconditionally — only non-null
-- uids are deduped.
CREATE UNIQUE INDEX uq_session_events_uid ON session_events USING btree (session_id, uid) WHERE (uid IS NOT NULL);

CREATE FUNCTION touch_agent_new() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE agents a SET updated_at = now() WHERE a.id IN (SELECT agent_id FROM newtab);
  RETURN NULL;
END; $$;

-- Child-driven touch: an agent's "update" is a new version row. STATEMENT-
-- level with a transition table (not row-level) so a bulk write fires one
-- parent UPDATE per statement, not one per child row (measured 3-18x faster,
-- 21x less parent heap bloat). agent_versions rows are append-only, so INSERT
-- is the only event that matters. The same STATEMENT-level/transition-table
-- pattern recurs below for memory_stores, vaults, and wikis.
CREATE TRIGGER trg_touch_agent_ins AFTER INSERT ON agent_versions REFERENCING NEW TABLE AS newtab FOR EACH STATEMENT EXECUTE FUNCTION touch_agent_new();

-- ============================================================
-- Files / skills / memory / wikis
-- ============================================================

CREATE TABLE files (
    id text NOT NULL,
    session_id text,
    name text NOT NULL,
    size bigint NOT NULL,
    sha256 text NOT NULL,
    kind text DEFAULT 'upload'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id text DEFAULT 'wrkspc_default'::text NOT NULL,
    -- Hierarchical object key, stamped at insert (src/object-key.ts) and
    -- stored — reads never derive it. Non-unique: memory/skill path
    -- overwrites briefly share a key between the old and new row (the
    -- shared-key delete rule in repo.ts handles it).
    object_key text DEFAULT ''::text NOT NULL,
    -- Bumped on every session attach (trg_session_files_touch below); no bump
    -- on detach, so a freed file ages from its last attach for the retention
    -- sweep (files with no session_files rows older than the cutoff).
    last_attached_at timestamp with time zone DEFAULT now()
);

-- In-flight chunked multipart uploads (public API); completed/aborted rows
-- are deleted. parts is [{n, etag, sha256, size}]. file_id is the reserved
-- final files.id.
CREATE TABLE file_uploads (
    id text NOT NULL,
    workspace_id text NOT NULL,
    file_id text NOT NULL,
    upload_key text NOT NULL,
    name text NOT NULL,
    kind text DEFAULT 'upload'::text NOT NULL,
    part_size bigint NOT NULL,
    parts jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Files <-> sessions is many-to-many: an input file can be attached to
-- multiple sessions; output files are produced by a session. Role
-- distinguishes them.
CREATE TABLE session_files (
    session_id text NOT NULL,
    file_id text NOT NULL,
    role text DEFAULT 'input'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE skills (
    id text NOT NULL,
    name text NOT NULL,
    file_id text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id text DEFAULT 'wrkspc_default'::text NOT NULL,
    -- A skill can be a multi-file package (SKILL.md + scripts/resources), not
    -- just a single markdown. `files` is the manifest [{path,fileId}].
    files jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE memory_stores (
    id text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id text DEFAULT 'wrkspc_default'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- One row per file in the store's mini-filesystem; content lives in
-- FileStore.
CREATE TABLE memory_entries (
    store_id text NOT NULL,
    path text NOT NULL,
    file_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- A wiki is a workspace-scoped, hierarchical corpus of markdown files
-- (OKF/karpathy pattern: index.md catalog, one page per entity, log.md
-- history) attachable to MANY agents read-only, with at most ONE writer
-- agent (enforced by validateWikiRefs, not a DB constraint). The structure
-- spec itself is hardcoded in the runner prompt, not user config.
CREATE TABLE wikis (
    id text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- One row per file in the wiki's tree; content lives in FileStore (object
-- key kind "wiki" = <ws>/wiki/<wikiId>/<path>), mirroring memory_entries.
CREATE TABLE wiki_entries (
    wiki_id text NOT NULL,
    path text NOT NULL,
    file_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY file_uploads
    ADD CONSTRAINT file_uploads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_files
    ADD CONSTRAINT session_files_pkey PRIMARY KEY (session_id, file_id, role);

ALTER TABLE ONLY skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (id);

ALTER TABLE ONLY memory_stores
    ADD CONSTRAINT memory_stores_pkey PRIMARY KEY (id);

ALTER TABLE ONLY memory_entries
    ADD CONSTRAINT memory_entries_pkey PRIMARY KEY (store_id, path);

ALTER TABLE ONLY wikis
    ADD CONSTRAINT wikis_pkey PRIMARY KEY (id);

ALTER TABLE ONLY wiki_entries
    ADD CONSTRAINT wiki_entries_pkey PRIMARY KEY (wiki_id, path);

CREATE INDEX files_object_key ON files USING btree (object_key);
CREATE INDEX idx_files_session ON files USING btree (session_id);
CREATE INDEX idx_files_ws ON files USING btree (workspace_id, created_at DESC);
CREATE INDEX idx_session_files_file ON session_files USING btree (file_id);
CREATE UNIQUE INDEX uq_skills_ws_name ON skills USING btree (workspace_id, name);
CREATE UNIQUE INDEX uq_memstores_ws_name ON memory_stores USING btree (workspace_id, name);
CREATE UNIQUE INDEX uq_wikis_ws_name ON wikis USING btree (workspace_id, name);
CREATE INDEX idx_wikis_ws_updated ON wikis USING btree (workspace_id, updated_at DESC);

CREATE FUNCTION touch_file_last_attached() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE files SET last_attached_at = now()
   WHERE id IN (SELECT DISTINCT file_id FROM new_rows);
  RETURN NULL;
END $$;

CREATE TRIGGER trg_session_files_touch AFTER INSERT ON session_files REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION touch_file_last_attached();

CREATE FUNCTION touch_memory_store_new() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE memory_stores s SET updated_at = now() WHERE s.id IN (SELECT store_id FROM newtab);
  RETURN NULL;
END; $$;

CREATE FUNCTION touch_memory_store_old() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE memory_stores s SET updated_at = now() WHERE s.id IN (SELECT store_id FROM oldtab);
  RETURN NULL;
END; $$;

CREATE TRIGGER trg_touch_memory_store_ins AFTER INSERT ON memory_entries REFERENCING NEW TABLE AS newtab FOR EACH STATEMENT EXECUTE FUNCTION touch_memory_store_new();
CREATE TRIGGER trg_touch_memory_store_upd AFTER UPDATE ON memory_entries REFERENCING NEW TABLE AS newtab FOR EACH STATEMENT EXECUTE FUNCTION touch_memory_store_new();
CREATE TRIGGER trg_touch_memory_store_del AFTER DELETE ON memory_entries REFERENCING OLD TABLE AS oldtab FOR EACH STATEMENT EXECUTE FUNCTION touch_memory_store_old();

CREATE FUNCTION touch_wiki_new() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE wikis w SET updated_at = now() WHERE w.id IN (SELECT wiki_id FROM newtab);
  RETURN NULL;
END; $$;

CREATE FUNCTION touch_wiki_old() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE wikis w SET updated_at = now() WHERE w.id IN (SELECT wiki_id FROM oldtab);
  RETURN NULL;
END; $$;

CREATE TRIGGER trg_touch_wiki_ins AFTER INSERT ON wiki_entries REFERENCING NEW TABLE AS newtab FOR EACH STATEMENT EXECUTE FUNCTION touch_wiki_new();
CREATE TRIGGER trg_touch_wiki_upd AFTER UPDATE ON wiki_entries REFERENCING NEW TABLE AS newtab FOR EACH STATEMENT EXECUTE FUNCTION touch_wiki_new();
CREATE TRIGGER trg_touch_wiki_del AFTER DELETE ON wiki_entries REFERENCING OLD TABLE AS oldtab FOR EACH STATEMENT EXECUTE FUNCTION touch_wiki_old();

-- ============================================================
-- Environments / vaults
-- ============================================================

-- Session-pod configuration: resources, placement, and the /work disk. Shape
-- documented in src/pod-config.ts. allow_package_managers/allow_mcp_servers
-- gate what the environment's egress proxy (Squid) allows.
CREATE TABLE environments (
    id text NOT NULL,
    name text NOT NULL,
    allow_package_managers boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    allowed_hosts jsonb DEFAULT '[]'::jsonb NOT NULL,
    workspace_id text DEFAULT 'wrkspc_default'::text NOT NULL,
    pod jsonb DEFAULT '{}'::jsonb NOT NULL,
    allow_mcp_servers boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE vaults (
    id text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id text DEFAULT 'wrkspc_default'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Named credentials in a vault. Values live only in the per-vault K8s Secret
-- (write-only) — we keep the names here so the UI can list/manage them.
-- type + mcp_server_url/name bind MCP credentials to a server URL for
-- launch-time header injection (DEVPROOF_CRED_<NAME>_* placeholders).
CREATE TABLE vault_credentials (
    vault_id text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    type text DEFAULT 'environment_variable'::text NOT NULL,
    mcp_server_url text,
    mcp_server_name text,
    CONSTRAINT vault_credentials_type_check CHECK ((type = ANY (ARRAY['environment_variable'::text, 'bearer_token'::text, 'mcp_oauth'::text])))
);

ALTER TABLE ONLY environments
    ADD CONSTRAINT environments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY vaults
    ADD CONSTRAINT vaults_pkey PRIMARY KEY (id);

ALTER TABLE ONLY vault_credentials
    ADD CONSTRAINT vault_credentials_pkey PRIMARY KEY (vault_id, name);

CREATE UNIQUE INDEX uq_environments_ws_name ON environments USING btree (workspace_id, name);
CREATE UNIQUE INDEX uq_vaults_ws_name ON vaults USING btree (workspace_id, name);

CREATE FUNCTION touch_vault_new() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE vaults v SET updated_at = now() WHERE v.id IN (SELECT vault_id FROM newtab);
  RETURN NULL;
END; $$;

CREATE FUNCTION touch_vault_old() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE vaults v SET updated_at = now() WHERE v.id IN (SELECT vault_id FROM oldtab);
  RETURN NULL;
END; $$;

CREATE TRIGGER trg_touch_vault_ins AFTER INSERT ON vault_credentials REFERENCING NEW TABLE AS newtab FOR EACH STATEMENT EXECUTE FUNCTION touch_vault_new();
CREATE TRIGGER trg_touch_vault_upd AFTER UPDATE ON vault_credentials REFERENCING NEW TABLE AS newtab FOR EACH STATEMENT EXECUTE FUNCTION touch_vault_new();
CREATE TRIGGER trg_touch_vault_del AFTER DELETE ON vault_credentials REFERENCING OLD TABLE AS oldtab FOR EACH STATEMENT EXECUTE FUNCTION touch_vault_old();

-- ============================================================
-- Serving (external endpoints, routing, wake/launch gating, catalog, trace)
-- ============================================================
-- Serving is global — NOT workspace-scoped (pools, deployments, catalog,
-- external endpoints, and routings all live outside multi-tenancy).

-- External provider endpoints served through the gateway alongside local
-- models. API keys are NOT here: they live only in the gateway-provider-keys
-- K8s Secret; has_key/key_version exist so config generation can reference
-- them without touching the DB.
CREATE TABLE external_deployments (
    id text NOT NULL,
    name text NOT NULL,
    provider text NOT NULL,
    base_url text,
    model_id text NOT NULL,
    key_version integer DEFAULT 1 NOT NULL,
    has_key boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    -- Free text (not an enum): vendor reasoning-effort vocabularies differ
    -- (xhigh, max, none, ...) and keep drifting. NULL = don't pass anything;
    -- the provider default applies.
    reasoning_effort text,
    -- Mandatory: an external-only routing needs a real compaction cap. No
    -- legacy fallback — every row carries this.
    context_tokens integer NOT NULL,
    CONSTRAINT external_deployments_provider_check CHECK ((provider = ANY (ARRAY['openai'::text, 'anthropic'::text, 'openrouter'::text, 'ollama'::text, 'custom'::text])))
);

-- Custom catalog models (merged with the bundled catalog/models.yaml at read
-- time). Global, like the rest of Serving.
CREATE TABLE catalog_models (
    id text NOT NULL,
    entry jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Scale-to-zero routing state: what the gateway pre-call hook reads to hold
-- requests for sleeping models. A CP-maintained PROJECTION of (deployment
-- phase, warmed) — event-updated for snappy holds, swept at reconciler
-- cadence for convergence.
CREATE TABLE model_routing (
    model text NOT NULL,
    state text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    -- Lets the hook's `available` condition distinguish Failed/Deploying from
    -- Ready/Idle (state 'waking' alone conflates them).
    phase text,
    CONSTRAINT model_routing_state_check CHECK ((state = ANY (ARRAY['idle'::text, 'waking'::text, 'ready'::text])))
);

-- The wake hook's signal (INSERT + NOTIFY devproof_wake); the CP deletes rows
-- as it patches deployments awake.
CREATE TABLE wake_requests (
    model text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Global named rule tables the gateway pre-call hook evaluates per request,
-- top to bottom (rules/terminal are validated JSONB — see
-- src/routing-rules.ts). External dpk_ keys are routing-only: a bare
-- deployment name 403s.
CREATE TABLE routings (
    name text NOT NULL,
    rules jsonb DEFAULT '[]'::jsonb NOT NULL,
    terminal jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Wait-for-deployment launch gate: a turn whose local model deployment isn't
-- Ready parks its exact orchestrator.startSession payload here instead of
-- starting a pod (the gateway only routes Ready deployments). Released by the
-- newly-routed gateway-sync hook + the reconciler sweep; removed on
-- interrupt; cascades away with the session.
CREATE TABLE pending_launches (
    session_id text NOT NULL,
    model text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Ephemeral trace routing: one row per open trace window (SSE viewer),
-- heartbeat-refreshed by the control plane, polled by the gateway. UNLOGGED:
-- pure transient state, safe to lose on crash. Message content NEVER touches
-- the database.
CREATE UNLOGGED TABLE trace_subscriptions (
    id text NOT NULL,
    deployment text,
    callback_url text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    routing text,
    -- A row targets exactly one of deployment/routing.
    CONSTRAINT trace_subscriptions_one_target CHECK (((deployment IS NULL) <> (routing IS NULL)))
);

ALTER TABLE ONLY external_deployments
    ADD CONSTRAINT external_deployments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY external_deployments
    ADD CONSTRAINT external_deployments_name_key UNIQUE (name);

ALTER TABLE ONLY catalog_models
    ADD CONSTRAINT catalog_models_pkey PRIMARY KEY (id);

ALTER TABLE ONLY model_routing
    ADD CONSTRAINT model_routing_pkey PRIMARY KEY (model);

ALTER TABLE ONLY wake_requests
    ADD CONSTRAINT wake_requests_pkey PRIMARY KEY (model);

ALTER TABLE ONLY routings
    ADD CONSTRAINT routings_pkey PRIMARY KEY (name);

ALTER TABLE ONLY pending_launches
    ADD CONSTRAINT pending_launches_pkey PRIMARY KEY (session_id);

ALTER TABLE ONLY trace_subscriptions
    ADD CONSTRAINT trace_subscriptions_pkey PRIMARY KEY (id);

CREATE INDEX pending_launches_model ON pending_launches USING btree (model);

-- ============================================================
-- Usage / billing
-- ============================================================
-- Two ledgers: real (what infra + external tokens cost the operator) and
-- billed (what consumers are charged). Costs are stamped/accrued with the
-- price valid at usage time — history is immutable; price edits only affect
-- future usage. NULL cost = tracking was off; 0 = tracked but free.

-- Per-request token metering written by the gateway's success hook
-- (custom_callbacks.py). source: 'api' (external key) | 'session' (managed-
-- agent internal traffic). routing = attribution stamp for requests resolved
-- through a routing (model = the resolved target; NULL routing = a direct
-- call). routing_rule = matched rule index (-1 terminal/no-match, -2
-- classifier sub-call, NULL = direct/pre-feature). turn = the session turn
-- the call belongs to (from the x-devproof-turn header), NULL for non-session
-- traffic.
CREATE TABLE gateway_usage (
    id bigint NOT NULL,
    workspace_id text NOT NULL,
    -- ON DELETE SET NULL keeps historical totals when a key is deleted; the
    -- UI shows such rows as "(deleted key)".
    api_key_id text,
    model text NOT NULL,
    tokens_in bigint DEFAULT 0 NOT NULL,
    tokens_out bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'api'::text NOT NULL,
    agent_id text,
    session_id text,
    real_cost numeric,
    billed_cost numeric,
    routing text,
    routing_rule integer,
    turn integer
);

CREATE SEQUENCE gateway_usage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE gateway_usage_id_seq OWNED BY gateway_usage.id;

ALTER TABLE ONLY gateway_usage ALTER COLUMN id SET DEFAULT nextval('gateway_usage_id_seq'::regclass);

-- One price row per resource; kind: pool | deployment (local, ref=name) |
-- external (ref=row id) | environment (ref=row id). prices JSONB holds
-- optional sub-objects: real.podTime {amount,per}, real.tokens
-- {in/out:{amount,perTokens}}, billing.podTime, billing.tokens,
-- billing.sessionTime. CP delete routes remove the row with the resource
-- (kubectl-bypass leaves an inert row).
CREATE TABLE resource_prices (
    kind text NOT NULL,
    ref text NOT NULL,
    prices jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT resource_prices_kind_check CHECK ((kind = ANY (ARRAY['pool'::text, 'deployment'::text, 'external'::text, 'environment'::text])))
);

-- Time-cost ledger, written by the CP sampler (60s grain; exact-to-the-second
-- totals via the turn-end settle). kinds: pool_pod (real), deployment_time
-- (billed), env_pod (real), session_time (billed). Session-pod/environment
-- time never counts toward a routing cost-condition reject (that only
-- enforces deployment costs).
CREATE TABLE cost_entries (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    kind text NOT NULL,
    deployment text,
    pool text,
    environment_id text,
    session_id text,
    workspace_id text,
    seconds numeric NOT NULL,
    replicas integer,
    real_cost numeric,
    billed_cost numeric,
    CONSTRAINT cost_entries_kind_check CHECK ((kind = ANY (ARRAY['pool_pod'::text, 'deployment_time'::text, 'env_pod'::text, 'session_time'::text])))
);

CREATE SEQUENCE cost_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE cost_entries_id_seq OWNED BY cost_entries.id;

ALTER TABLE ONLY cost_entries ALTER COLUMN id SET DEFAULT nextval('cost_entries_id_seq'::regclass);

-- Reject-terminal hits (rejected requests never reach the metering callback,
-- so they don't appear in gateway_usage).
CREATE TABLE routing_rejects (
    id bigint NOT NULL,
    routing text NOT NULL,
    api_key_id text,
    workspace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE routing_rejects_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE routing_rejects_id_seq OWNED BY routing_rejects.id;

ALTER TABLE ONLY routing_rejects ALTER COLUMN id SET DEFAULT nextval('routing_rejects_id_seq'::regclass);

ALTER TABLE ONLY gateway_usage
    ADD CONSTRAINT gateway_usage_pkey PRIMARY KEY (id);

ALTER TABLE ONLY resource_prices
    ADD CONSTRAINT resource_prices_pkey PRIMARY KEY (kind, ref);

ALTER TABLE ONLY cost_entries
    ADD CONSTRAINT cost_entries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY routing_rejects
    ADD CONSTRAINT routing_rejects_pkey PRIMARY KEY (id);

CREATE INDEX gateway_usage_key_time ON gateway_usage USING btree (api_key_id, created_at);
CREATE INDEX gateway_usage_model_time ON gateway_usage USING btree (model, created_at);
CREATE INDEX gateway_usage_routing_time ON gateway_usage USING btree (routing, created_at);
CREATE INDEX gateway_usage_ws_time ON gateway_usage USING btree (workspace_id, created_at);
CREATE INDEX cost_entries_deploy_ts ON cost_entries USING btree (deployment, ts);
CREATE INDEX cost_entries_kind_ts ON cost_entries USING btree (kind, ts);
CREATE INDEX cost_entries_session ON cost_entries USING btree (session_id);
CREATE INDEX routing_rejects_routing_time ON routing_rejects USING btree (routing, created_at);

-- BEFORE INSERT on gateway_usage: look up the price valid NOW and stamp
-- real_cost/billed_cost. NULL = not tracked at the time (distinct from
-- 0 = tracked but free). Defensive: any error nulls the costs and lets the
-- insert proceed — a pricing bug may lose cost data, never token metering.
-- Name collisions between local and external deployments are prevented at
-- creation (server.ts), so a name match on gateway_usage.model decides the
-- namespace (external_deployments vs. local deployment).
CREATE FUNCTION gateway_usage_cost_stamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  cfg jsonb;
  pr  jsonb;
  ext_ref text;
BEGIN
  SELECT data->'costs' INTO cfg FROM app_settings WHERE id = 'global';
  IF cfg IS NULL THEN
    RETURN NEW;
  END IF;
  -- Name collisions between local and external deployments are prevented at
  -- creation (server.ts), so a name match decides the namespace.
  SELECT id INTO ext_ref FROM external_deployments WHERE name = NEW.model;
  IF ext_ref IS NOT NULL THEN
    SELECT prices INTO pr FROM resource_prices WHERE kind = 'external' AND ref = ext_ref;
    IF COALESCE((cfg->>'enabled')::boolean, false)
       AND COALESCE((cfg->>'trackExternalCosts')::boolean, false) AND pr #> '{real,tokens}' IS NOT NULL THEN
      NEW.real_cost :=
          COALESCE(NEW.tokens_in, 0)  * COALESCE((pr #>> '{real,tokens,in,amount}')::numeric
                                                 / NULLIF((pr #>> '{real,tokens,in,perTokens}')::numeric, 0), 0)
        + COALESCE(NEW.tokens_out, 0) * COALESCE((pr #>> '{real,tokens,out,amount}')::numeric
                                                 / NULLIF((pr #>> '{real,tokens,out,perTokens}')::numeric, 0), 0);
    END IF;
    IF COALESCE((cfg #>> '{billing,enabled}')::boolean, false)
       AND COALESCE((cfg #>> '{billing,billExternalTokens}')::boolean, false)
       AND pr #> '{billing,tokens}' IS NOT NULL THEN
      NEW.billed_cost :=
          COALESCE(NEW.tokens_in, 0)  * COALESCE((pr #>> '{billing,tokens,in,amount}')::numeric
                                                 / NULLIF((pr #>> '{billing,tokens,in,perTokens}')::numeric, 0), 0)
        + COALESCE(NEW.tokens_out, 0) * COALESCE((pr #>> '{billing,tokens,out,amount}')::numeric
                                                 / NULLIF((pr #>> '{billing,tokens,out,perTokens}')::numeric, 0), 0);
    END IF;
  ELSE
    -- Local model: no per-token real cost (pool pod-time is its real cost).
    SELECT prices INTO pr FROM resource_prices WHERE kind = 'deployment' AND ref = NEW.model;
    IF COALESCE((cfg #>> '{billing,enabled}')::boolean, false)
       AND COALESCE((cfg #>> '{billing,billLocalTokens}')::boolean, false)
       AND pr #> '{billing,tokens}' IS NOT NULL THEN
      NEW.billed_cost :=
          COALESCE(NEW.tokens_in, 0)  * COALESCE((pr #>> '{billing,tokens,in,amount}')::numeric
                                                 / NULLIF((pr #>> '{billing,tokens,in,perTokens}')::numeric, 0), 0)
        + COALESCE(NEW.tokens_out, 0) * COALESCE((pr #>> '{billing,tokens,out,amount}')::numeric
                                                 / NULLIF((pr #>> '{billing,tokens,out,perTokens}')::numeric, 0), 0);
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  NEW.real_cost := NULL;
  NEW.billed_cost := NULL;
  RETURN NEW;
END $$;

CREATE TRIGGER gateway_usage_cost_stamp BEFORE INSERT ON gateway_usage FOR EACH ROW EXECUTE FUNCTION gateway_usage_cost_stamp();

-- SOLE writer of sessions.tokens_in/out/billed_cost/last_model: accumulates
-- session-attributed gateway_usage rows into the session's running totals, so
-- they tick live mid-turn and survive failed/interrupted turns. appendEvents
-- must never re-accumulate event-reported usage (the runner's session.result
-- usage stays display-only). NOTIFY wakes the session SSE loop so the
-- console header updates live.
CREATE FUNCTION session_usage_accumulate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE sessions
     SET tokens_in   = tokens_in  + NEW.tokens_in,
         tokens_out  = tokens_out + NEW.tokens_out,
         billed_cost = billed_cost + COALESCE(NEW.billed_cost, 0),
         last_model  = NEW.model
   WHERE id = NEW.session_id;
  PERFORM pg_notify('devproof_session', NEW.session_id);
  RETURN NULL;
END $$;

CREATE TRIGGER session_usage_accumulate AFTER INSERT ON gateway_usage FOR EACH ROW WHEN ((new.session_id IS NOT NULL)) EXECUTE FUNCTION session_usage_accumulate();

-- ============================================================
-- Webhooks / keys
-- ============================================================

CREATE TABLE webhooks (
    id text NOT NULL,
    url text NOT NULL,
    events jsonb DEFAULT '["session.completed", "session.failed"]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id text DEFAULT 'wrkspc_default'::text NOT NULL
);

-- Anthropic apikey_ shape: workspace-scoped, status enum. DELETE flips
-- status='deleted' (soft-delete) — the row + name survive for Usage
-- attribution ("name [deleted]"); gateway auth requires status='active'.
CREATE TABLE api_keys (
    id text NOT NULL,
    workspace_id text NOT NULL,
    name text NOT NULL,
    partial_hint text NOT NULL,
    secret_hash text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);

ALTER TABLE ONLY webhooks
    ADD CONSTRAINT webhooks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);

CREATE INDEX idx_api_keys_ws ON api_keys USING btree (workspace_id, created_at DESC);

-- ============================================================
-- Foreign keys (trailing: every referenced table above is created first)
-- ============================================================

ALTER TABLE ONLY agents
    ADD CONSTRAINT agents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id);

ALTER TABLE ONLY agent_versions
    ADD CONSTRAINT agent_versions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_versions
    ADD CONSTRAINT agent_versions_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE SET NULL;

ALTER TABLE ONLY agent_versions
    ADD CONSTRAINT agent_versions_vault_id_fkey FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE SET NULL;

ALTER TABLE ONLY agent_versions
    ADD CONSTRAINT agent_versions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_memory_store_id_fkey FOREIGN KEY (memory_store_id) REFERENCES memory_stores(id) ON DELETE SET NULL;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id);

ALTER TABLE ONLY session_events
    ADD CONSTRAINT session_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_events
    ADD CONSTRAINT session_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id);

ALTER TABLE ONLY files
    ADD CONSTRAINT files_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY files
    ADD CONSTRAINT files_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id);

ALTER TABLE ONLY file_uploads
    ADD CONSTRAINT file_uploads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_files
    ADD CONSTRAINT session_files_file_id_fkey FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_files
    ADD CONSTRAINT session_files_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY skills
    ADD CONSTRAINT skills_file_id_fkey FOREIGN KEY (file_id) REFERENCES files(id);

ALTER TABLE ONLY skills
    ADD CONSTRAINT skills_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id);

ALTER TABLE ONLY memory_stores
    ADD CONSTRAINT memory_stores_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id);

ALTER TABLE ONLY memory_entries
    ADD CONSTRAINT memory_entries_file_id_fkey FOREIGN KEY (file_id) REFERENCES files(id);

ALTER TABLE ONLY memory_entries
    ADD CONSTRAINT memory_entries_store_id_fkey FOREIGN KEY (store_id) REFERENCES memory_stores(id) ON DELETE CASCADE;

ALTER TABLE ONLY wiki_entries
    ADD CONSTRAINT wiki_entries_file_id_fkey FOREIGN KEY (file_id) REFERENCES files(id);

ALTER TABLE ONLY wiki_entries
    ADD CONSTRAINT wiki_entries_wiki_id_fkey FOREIGN KEY (wiki_id) REFERENCES wikis(id) ON DELETE CASCADE;

ALTER TABLE ONLY environments
    ADD CONSTRAINT environments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id);

ALTER TABLE ONLY vaults
    ADD CONSTRAINT vaults_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id);

ALTER TABLE ONLY vault_credentials
    ADD CONSTRAINT vault_credentials_vault_id_fkey FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE CASCADE;

ALTER TABLE ONLY pending_launches
    ADD CONSTRAINT pending_launches_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY gateway_usage
    ADD CONSTRAINT gateway_usage_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL;

ALTER TABLE ONLY webhooks
    ADD CONSTRAINT webhooks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id);

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id);

-- ============================================================
-- Seeds
-- ============================================================
-- Seeds: the immutable default workspace and the settings singleton.
INSERT INTO workspaces (id, name) VALUES ('wrkspc_default', 'Default workspace')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO app_settings (id) VALUES ('global') ON CONFLICT (id) DO NOTHING;
