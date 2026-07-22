// Repository for agents-core entities (concept §6.1). IDs use Anthropic-style
// prefixes. Every user-facing entity is workspace-scoped; runner-callback paths
// key by the (unguessable) session/file id and rely on the column DEFAULT.
import { createHash } from "node:crypto";
import type pg from "pg";
import { bucketSeries, rangeWindow } from "./usage-range.ts";
import { shortId, secretToken } from "./id.ts";
import type { PodConfig } from "./pod-config.ts";
import { normalizeCostSettings, spreadCostEntries, GAP_CAP_SEC, type CostSettings } from "./costs.ts";
import { normalizeLimits, type Limits } from "./limits.ts";
import { normalizeAppearance, type Appearance } from "./appearance.ts";
import {
  defaultMaintenanceSettings, mergeMaintenanceSettings,
  type MaintenanceSettings, type MaintenanceSummary,
} from "./maintenance.ts";

const rid = (prefix: string) => `${prefix}_${shortId()}`;

export const DEFAULT_WORKSPACE = "wrkspc_default";

// Postgres jsonb cannot store a NUL (U+0000): the insert throws 22P05
// ("unsupported Unicode escape sequence") and the route 500s. A runner event
// can carry one in any string field — e.g. a Bash tool result from
// `cat /proc/self/attr/current`, which is NUL-terminated — so strip NUL from
// every string before serializing the payload (live failure sesn_5r6qnuuxtwho,
// 2026-07-22: the runner retried the identical NUL payload and failed the
// whole session). Guards every runner version at the last hop before the DB.
const NUL = String.fromCharCode(0);
function stripNul(value: unknown): unknown {
  if (typeof value === "string") return value.includes(NUL) ? value.split(NUL).join("") : value;
  if (Array.isArray(value)) return value.map(stripNul);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = stripNul(v);
    return out;
  }
  return value;
}

export interface AgentConfig {
  /** The routing this agent's requests flow through (renamed from `model`,
   *  spec 2026-07-16 amendment — agents reference routings only). */
  routing: string;
  systemPrompt?: string;
  tools?: string[];
  maxTurns?: number;
  /** Seconds a single turn's runner pod may live (Job activeDeadlineSeconds); null = default 7200. */
  turnDeadlineSeconds?: number;
  environmentId?: string;
  skillIds?: string[];
  /** SDK-shaped MCP server config, e.g. {"jira": {"type": "http", "url": "..."}} */
  mcpServers?: Record<string, unknown>;
  vaultId?: string;
  /** Agents this agent may delegate to (spec 2026-07-17); instructions =
   *  free-text "when to use", rendered into the runner's Delegation block. */
  subagents?: { agentId: string; instructions: string }[];
  /** LLM wikis this agent mounts (spec 2026-07-18). read = read-only (default,
   *  unlimited); write = the sole writer (one per wiki; makes the agent
   *  single-session so writes never race). */
  wikiRefs?: { wikiId: string; mode: "read" | "write" }[];
}

export interface SessionEvent {
  type: string;
  payload?: unknown;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  /** Client-minted idempotency key (runner dev36+): a retried at-least-once
   *  POST re-sends the same uid and appendEvents skips it. Optional — events
   *  without a uid (user prompts, old runners) insert unconditionally. */
  uid?: string;
}

/** Tables the deletion runner drains / the progress endpoint counts.
 *  Names are interpolated into SQL — NEVER extend without the allowlist. */
const DRAIN_TABLES = ["sessions", "skills", "memory_stores", "wikis", "files",
                      "environments", "vaults", "agents", "webhooks", "file_uploads"] as const;

export class Repo {
  constructor(private pool: pg.Pool) {}

  // ── Workspaces ───────────────────────────────────────────────────────────
  async listWorkspaces(includeDeleted = false) {
    const { rows } = await this.pool.query(
      includeDeleted
        ? "SELECT * FROM workspaces ORDER BY created_at"
        : "SELECT * FROM workspaces WHERE status <> 'deleted' ORDER BY created_at");
    return rows;
  }

  async createWorkspace(name: string) {
    const id = rid("wrkspc");
    await this.pool.query("INSERT INTO workspaces (id, name) VALUES ($1, $2)", [id, name]);
    return { id, name };
  }

  async getWorkspace(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM workspaces WHERE id = $1", [id]);
    return rows[0] ?? null;
  }

  async renameWorkspace(id: string, name: string): Promise<"ok" | "notfound" | "conflict"> {
    try {
      const { rowCount } = await this.pool.query(
        "UPDATE workspaces SET name = $2 WHERE id = $1 AND status <> 'deleted'", [id, name]);
      return (rowCount ?? 0) > 0 ? "ok" : "notfound";
    } catch (err: any) {
      if (err?.code === "23505") return "conflict"; // uq_workspaces_live_name
      throw err;
    }
  }

  async setWorkspaceStatus(id: string, status: string) {
    const { rowCount } = await this.pool.query(
      "UPDATE workspaces SET status = $2 WHERE id = $1", [id, status]);
    return (rowCount ?? 0) > 0;
  }

  /** Flip to 'deleting' + snapshot the progress denominator. No-op if already
   *  deleting/deleted (repeat DELETE is idempotent). Returns whether THIS call
   *  performed the flip, so a caller racing a concurrent DELETE can tell
   *  whether it — not the other request — owns kicking off the runner. */
  async beginWorkspaceDelete(id: string, totals: Record<string, number>): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "UPDATE workspaces SET status = 'deleting', delete_totals = $2 WHERE id = $1 AND status NOT IN ('deleting','deleted')",
      [id, JSON.stringify(totals)]);
    return (rowCount ?? 0) > 0;
  }

  /** Live per-resource-type counts: delete-confirm dialog, delete_totals
   *  snapshot, and deletion progress all read this. api_keys counts only
   *  non-deleted rows so a drained workspace reaches 0 everywhere. */
  async workspaceResourceCounts(id: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const t of DRAIN_TABLES) counts[t] = await this.count(t, id);
    const { rows } = await this.pool.query(
      "SELECT count(*)::int AS n FROM api_keys WHERE workspace_id = $1 AND status <> 'deleted'", [id]);
    counts.api_keys = rows[0].n;
    return counts;
  }

  /** First `limit` ids of a drainable table — the runner's batch cursor. */
  async workspaceRowIds(table: string, workspaceId: string, limit = 100): Promise<string[]> {
    if (!(DRAIN_TABLES as readonly string[]).includes(table)) throw new Error(`not drainable: ${table}`);
    const { rows } = await this.pool.query(
      `SELECT id FROM ${table} WHERE workspace_id = $1 LIMIT $2`, [workspaceId, limit]);
    return rows.map((r: any) => r.id);
  }

  async deleteWorkspaceWebhooks(workspaceId: string) {
    await this.pool.query("DELETE FROM webhooks WHERE workspace_id = $1", [workspaceId]);
  }

  /** Soft-delete (existing api-key convention): names survive for Usage attribution. */
  async softDeleteWorkspaceApiKeys(workspaceId: string) {
    await this.pool.query("UPDATE api_keys SET status = 'deleted' WHERE workspace_id = $1", [workspaceId]);
  }

  async listWorkspaceFileUploads(workspaceId: string, limit = 100) {
    const { rows } = await this.pool.query(
      "SELECT id, upload_key, file_id FROM file_uploads WHERE workspace_id = $1 LIMIT $2", [workspaceId, limit]);
    return rows;
  }

  // ── Agents ───────────────────────────────────────────────────────────────
  async createAgent(workspaceId: string, name: string, config: AgentConfig) {
    const id = rid("agent");
    await this.pool.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)", [id, workspaceId, name]);
    await this.addVersion(workspaceId, id, 1, config);
    return { id, name, version: 1 };
  }

  private async addVersion(workspaceId: string, agentId: string, version: number, c: AgentConfig) {
    await this.pool.query(
      `INSERT INTO agent_versions (id, workspace_id, agent_id, version, routing, system_prompt, tools, max_turns, turn_deadline_sec, environment_id, skill_ids, mcp_servers, vault_id, subagents, wiki_refs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [rid("agntv"), workspaceId, agentId, version, c.routing, c.systemPrompt ?? "",
       JSON.stringify(c.tools ?? []), c.maxTurns ?? 500, c.turnDeadlineSeconds ?? null, c.environmentId ?? null,
       JSON.stringify(c.skillIds ?? []), JSON.stringify(c.mcpServers ?? {}), c.vaultId ?? null,
       JSON.stringify(c.subagents ?? []), JSON.stringify(c.wikiRefs ?? [])],
    );
  }

  async newAgentVersion(workspaceId: string, agentId: string, config: AgentConfig): Promise<number> {
    const { rows } = await this.pool.query(
      "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM agent_versions WHERE agent_id = $1",
      [agentId],
    );
    await this.addVersion(workspaceId, agentId, rows[0].v, config);
    return rows[0].v;
  }

  async listAgents(workspaceId: string, limit = 100, offset = 0) {
    const { rows } = await this.pool.query(
      `SELECT a.id, a.name, a.status, a.created_at, a.updated_at, v.version, v.routing, v.wiki_refs
       FROM agents a
       JOIN LATERAL (SELECT * FROM agent_versions WHERE agent_id = a.id
                     ORDER BY version DESC LIMIT 1) v ON true
       WHERE a.workspace_id = $1
       ORDER BY a.updated_at DESC LIMIT $2 OFFSET $3`,
      [workspaceId, limit, offset],
    );
    return { rows, count: await this.count("agents", workspaceId) };
  }

  async getAgent(workspaceId: string, id: string) {
    const { rows } = await this.pool.query(
      "SELECT id, name, status, created_at FROM agents WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
    return rows[0] ?? null;
  }

  async setAgentStatus(workspaceId: string, id: string, status: string) {
    const { rowCount } = await this.pool.query(
      "UPDATE agents SET status = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2", [id, workspaceId, status]);
    return (rowCount ?? 0) > 0;
  }

  /** Rename an agent — display metadata only, NOT versioned (config lives on
   *  agent_versions; every consumer joins the name live by agent id). */
  async renameAgent(workspaceId: string, id: string, name: string): Promise<"ok" | "notfound" | "conflict"> {
    try {
      const { rowCount } = await this.pool.query(
        "UPDATE agents SET name = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2", [id, workspaceId, name]);
      return (rowCount ?? 0) > 0 ? "ok" : "notfound";
    } catch (err: any) {
      if (err?.code === "23505") return "conflict"; // agents.name UNIQUE (global, migration 001)
      throw err;
    }
  }

  /** Total rows for a workspace-scoped table, for pagination. */
  private async count(table: string, workspaceId: string): Promise<number> {
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
    return rows[0].n;
  }

  async getAgentVersion(agentId: string, version?: number) {
    const { rows } = await this.pool.query(
      version != null
        ? { text: "SELECT * FROM agent_versions WHERE agent_id = $1 AND version = $2", values: [agentId, version] }
        : { text: "SELECT * FROM agent_versions WHERE agent_id = $1 ORDER BY version DESC LIMIT 1", values: [agentId] },
    );
    return rows[0] ?? null;
  }

  async getAgentWithVersions(agentId: string, workspaceId?: string) {
    const { rows: [agent] } = await this.pool.query(
      workspaceId
        ? { text: "SELECT * FROM agents WHERE id = $1 AND workspace_id = $2", values: [agentId, workspaceId] }
        : { text: "SELECT * FROM agents WHERE id = $1", values: [agentId] },
    );
    if (!agent) return null;
    const { rows: versions } = await this.pool.query(
      "SELECT * FROM agent_versions WHERE agent_id = $1 ORDER BY version DESC", [agentId]);
    return { ...agent, versions };
  }

  // ── Sessions ─────────────────────────────────────────────────────────────
  async createSession(workspaceId: string, agentId: string, prompt: string, name?: string, parentSessionId?: string) {
    const agent = await this.getAgentWithVersions(agentId, workspaceId);
    if (!agent) throw new Error(`agent not found: ${agentId}`);
    const v = agent.versions[0];
    const id = rid("sesn");
    await this.pool.query(
      `INSERT INTO sessions (id, workspace_id, agent_id, agent_version, name, prompt, status, parent_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7)`,
      [id, workspaceId, agentId, v.version, name ?? null, prompt, parentSessionId ?? null],
    );
    return { id, agentId, agentVersion: v.version, config: v };
  }

  async appendEvents(sessionId: string, events: SessionEvent[]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [sessionId]);
      // Idempotency (migration 042): the runner retries event posts, so a
      // batch whose response was lost arrives again with the same uids —
      // skip those. Safe under the FOR UPDATE lock above (no concurrent
      // writer for this session between the check and the inserts).
      const uids = events.map((e) => e.uid).filter((u): u is string => !!u);
      const seen = new Set<string>();
      if (uids.length) {
        const dup = await client.query(
          "SELECT uid FROM session_events WHERE session_id = $1 AND uid = ANY($2)",
          [sessionId, uids],
        );
        for (const r of dup.rows) seen.add(r.uid);
      }
      const fresh = events.filter((e) => !(e.uid && seen.has(e.uid)));
      const { rows } = await client.query(
        "SELECT COALESCE(MAX(seq), 0) AS s FROM session_events WHERE session_id = $1",
        [sessionId],
      );
      let seq = Number(rows[0].s);
      for (const e of fresh) {
        seq += 1;
        await client.query(
          `INSERT INTO session_events (session_id, seq, type, payload, tokens_in, tokens_out, duration_ms, uid)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [sessionId, seq, e.type, JSON.stringify(stripNul(e.payload ?? {})),
           e.tokensIn ?? 0, e.tokensOut ?? 0, e.durationMs ?? 0, e.uid ?? null],
        );
      }
      // "running" means the RUNNER reported in — the route's own user-prompt
      // append must not flip a queued session while the pod is still starting.
      // `session.waiting` is likewise a CP-generated gate event (launch gate /
      // writer queue): a PARKED session has no pod, so it must stay queued —
      // else a writer-queued session shows "running" (bug 2026-07-18).
      // Session totals are NOT accumulated here: the gateway_usage trigger
      // (migration 027) is the sole writer of sessions.tokens_in/out; event
      // tokens (e.g. the old runner's session.result usage) are display-only.
      const fromRunner = events.some((e) => e.type !== "user" && e.type !== "session.waiting");
      if (fromRunner) {
        await client.query(
          "UPDATE sessions SET status = 'running', updated_at = now() WHERE id = $1 AND status = 'queued'",
          [sessionId],
        );
      }
      await client.query("SELECT pg_notify('devproof_session', $1)", [sessionId]);
      await client.query("COMMIT");
      return seq;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async setSessionStatus(
    sessionId: string,
    status: "completed" | "failed" | "running" | "idle",
    extras?: { sdkSessionId?: string; checkpointFileId?: string },
    reportedTurn?: number,
  ) {
    // Growth guard: report the checkpoint file this update replaces so the
    // caller can delete it (dedup used to make replacements free).
    let replacedCheckpointFileId: string | null = null;
    if (extras?.checkpointFileId) {
      const { rows } = await this.pool.query("SELECT checkpoint_file_id FROM sessions WHERE id = $1", [sessionId]);
      const prev = rows[0]?.checkpoint_file_id ?? null;
      if (prev && prev !== extras.checkpointFileId) replacedCheckpointFileId = prev;
    }
    // Stale-turn guard: a runner pod that outlived an interrupt must not
    // clobber the follow-up turn's state (status, checkpoint, sdk id). The
    // check lives in the WHERE so it cannot race a concurrent startTurn
    // (turns + 1). reportedTurn undefined — non-runner callers and pods from
    // pre-dev23 images — applies unconditionally, exactly as before.
    const result = await this.pool.query(
      `UPDATE sessions SET status = $2,
         sdk_session_id = COALESCE($3, sdk_session_id),
         checkpoint_file_id = COALESCE($4, checkpoint_file_id),
         completed_at = CASE WHEN $2 IN ('completed','failed','idle') THEN now() ELSE completed_at END,
         updated_at = now()
       WHERE id = $1 AND ($5::int IS NULL OR turns <= $5::int)`,
      [sessionId, status, extras?.sdkSessionId ?? null, extras?.checkpointFileId ?? null, reportedTurn ?? null],
    );
    const applied = (result.rowCount ?? 0) > 0;
    if (applied) await this.pool.query("SELECT pg_notify('devproof_session', $1)", [sessionId]);
    return { replacedCheckpointFileId: applied ? replacedCheckpointFileId : null, applied };
  }

  async startTurn(sessionId: string) {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    // failed is resumable: the next turn picks up from the last completed
    // turn's checkpoint (mid-turn progress of the failed turn is lost).
    if (!["idle", "failed"].includes(session.status)) {
      throw new Error(`session is ${session.status}, only idle or failed sessions accept new messages`);
    }
    const { rows } = await this.pool.query(
      "UPDATE sessions SET turns = turns + 1, status = 'queued', updated_at = now() WHERE id = $1 RETURNING turns",
      [sessionId],
    );
    const config = await this.getAgentVersion(session.agent_id, session.agent_version);
    return {
      turn: Number(rows[0].turns),
      config,
      sdkSessionId: session.sdk_session_id as string | null,
      checkpointFileId: session.checkpoint_file_id as string | null,
    };
  }

  /** Sessions that look in-flight, with their latest sign of life — input for
   *  the zombie reconciler (a runner pod can die without reporting). Sessions
   *  parked in pending_launches are excluded: they deliberately have no Job
   *  while their model deployment becomes Ready (launch-gate 2026-07-12). */
  async listStuckSessions() {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.status, s.turns,
              GREATEST(s.created_at, COALESCE(e.last_event, s.created_at)) AS last_activity
       FROM sessions s
       LEFT JOIN LATERAL (SELECT max(created_at) AS last_event
                          FROM session_events WHERE session_id = s.id) e ON true
       WHERE s.status IN ('queued', 'running')
         AND NOT EXISTS (SELECT 1 FROM pending_launches p WHERE p.session_id = s.id)`,
    );
    return rows;
  }

  /** Park a turn whose model deployment is not Ready yet (launch gate). The
   *  payload is the exact orchestrator.startSession argument, replayed on
   *  release. Upsert: a session waits for at most one launch. */
  async addPendingLaunch(sessionId: string, model: string, payload: unknown) {
    await this.pool.query(
      `INSERT INTO pending_launches (session_id, model, payload) VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO UPDATE SET model = $2, payload = $3, created_at = now()`,
      [sessionId, model, JSON.stringify(payload)],
    );
  }

  /** Atomically claim every launch parked on a model (DELETE … RETURNING), so
   *  concurrent release triggers never double-launch a session. */
  async takePendingLaunches(model: string) {
    const { rows } = await this.pool.query(
      "DELETE FROM pending_launches WHERE model = $1 RETURNING session_id, payload",
      [model],
    );
    return rows as { session_id: string; payload: unknown }[];
  }

  /** Claim a single session's parked launch (interrupt path); null if none. */
  async takePendingLaunch(sessionId: string) {
    const { rows } = await this.pool.query(
      "DELETE FROM pending_launches WHERE session_id = $1 RETURNING session_id, model, payload",
      [sessionId],
    );
    return rows[0] ?? null;
  }

  async listPendingLaunchModels(): Promise<string[]> {
    // Exclude writer-queue parks (model key `wq:<agentId>`): those are released
    // by the writer-queue sweep, not the model-readiness sweep, which would try
    // to resolve the fake model name and fail the parked session.
    const { rows } = await this.pool.query("SELECT DISTINCT model FROM pending_launches WHERE model NOT LIKE 'wq:%'");
    return rows.map((r: any) => r.model);
  }

  // ── Writer-slot queue (spec 2026-07-18) ───────────────────────────────────
  // A writer agent (latest version has any wiki write ref) runs ONE session at a
  // time so wiki writes never race. Sessions beyond the one holding the slot
  // park under model key `wq:<agentId>` and are released FIFO.

  /** True when another (non-parked) queued|running session of this agent holds
   *  the writer slot. Writer-parked sessions (a `wq:%` pending row) don't count —
   *  they are the ones waiting for the slot. */
  async writerSlotHeld(agentId: string, exceptSessionId: string) {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM sessions s
       WHERE s.agent_id = $1 AND s.status IN ('queued','running') AND s.id <> $2
         AND NOT EXISTS (SELECT 1 FROM pending_launches p WHERE p.session_id = s.id AND p.model LIKE 'wq:%')
       LIMIT 1`, [agentId, exceptSessionId]);
    return rows.length > 0;
  }

  /** Atomically take the oldest parked writer launch for this agent, but ONLY
   *  when the slot is free. Advisory-locked per agent so concurrent release
   *  triggers (status hook + reconciler sweep) never start two at once. */
  async takeNextWriterLaunch(agentId: string): Promise<{ session_id: string; payload: unknown } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`wq:${agentId}`]);
      const held = await client.query(
        `SELECT 1 FROM sessions s
         WHERE s.agent_id = $1 AND s.status IN ('queued','running')
           AND NOT EXISTS (SELECT 1 FROM pending_launches p WHERE p.session_id = s.id AND p.model LIKE 'wq:%')
         LIMIT 1`, [agentId]);
      if (held.rows.length) { await client.query("COMMIT"); return null; }
      const { rows } = await client.query(
        `DELETE FROM pending_launches WHERE session_id = (
           SELECT session_id FROM pending_launches WHERE model = $1 ORDER BY created_at ASC LIMIT 1)
         RETURNING session_id, payload`, [`wq:${agentId}`]);
      await client.query("COMMIT");
      return rows[0] ?? null;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Agent ids with at least one parked writer session — the sweep's work list. */
  async listWriterQueueAgents(): Promise<string[]> {
    const { rows } = await this.pool.query(
      "SELECT DISTINCT substring(model from 4) AS agent_id FROM pending_launches WHERE model LIKE 'wq:%'");
    return rows.map((r: any) => r.agent_id);
  }

  // ── Scale-to-zero routing state (spec 2026-07-15) ──
  async setModelRouting(model: string, state: "idle" | "waking" | "ready", phase?: string) {
    await this.pool.query(
      `INSERT INTO model_routing (model, state, phase, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (model) DO UPDATE SET state = EXCLUDED.state,
         phase = COALESCE(EXCLUDED.phase, model_routing.phase), updated_at = now()`,
      [model, state, phase ?? null]);
  }

  async deleteModelRouting(model: string) {
    await this.pool.query("DELETE FROM model_routing WHERE model = $1", [model]);
    await this.pool.query("DELETE FROM wake_requests WHERE model = $1", [model]);
  }

  /** Projection hygiene: drop rows for deployments that no longer exist. */
  async pruneModelRouting(keep: string[]) {
    await this.pool.query("DELETE FROM model_routing WHERE NOT (model = ANY($1))", [keep]);
  }

  /** Atomically claim pending wake signals (DELETE … RETURNING — same
   *  pattern as takePendingLaunches, so concurrent sweeps never double-act). */
  async takeWakeRequests(): Promise<string[]> {
    const { rows } = await this.pool.query("DELETE FROM wake_requests RETURNING model");
    return rows.map((r: any) => r.model);
  }

  async clearWakeRequest(model: string) {
    await this.pool.query("DELETE FROM wake_requests WHERE model = $1", [model]);
  }

  async getSession(id: string, workspaceId?: string) {
    const { rows } = await this.pool.query(
      workspaceId
        ? { text: "SELECT * FROM sessions WHERE id = $1 AND workspace_id = $2", values: [id, workspaceId] }
        : { text: "SELECT * FROM sessions WHERE id = $1", values: [id] },
    );
    return rows[0] ?? null;
  }

  /** Deployments a session's turn actually hit, from gateway_usage (spec
   *  2026-07-16, fix wave H). Feeds the session step panel; the client matches
   *  a step to models by timestamp containment within [first_ts, last_ts]. */
  async sessionTurnDeployments(sessionId: string, turn: number) {
    const { rows } = await this.pool.query(
      `SELECT model, count(*)::int AS requests,
              min(created_at) AS first_ts, max(created_at) AS last_ts
       FROM gateway_usage WHERE session_id = $1 AND turn = $2
       GROUP BY model ORDER BY requests DESC`, [sessionId, turn]);
    return rows.map((r: any) => ({ model: r.model, requests: r.requests,
      first_ts: r.first_ts, last_ts: r.last_ts }));
  }

  async listSessions(workspaceId: string, agentId?: string, limit = 100, offset = 0, fileId?: string) {
    const conds = ["s.workspace_id = $1"];
    const params: unknown[] = [workspaceId];
    if (agentId) { params.push(agentId); conds.push(`s.agent_id = $${params.length}`); }
    if (fileId) {
      params.push(fileId);
      conds.push(`EXISTS (SELECT 1 FROM session_files sf WHERE sf.session_id = s.id AND sf.file_id = $${params.length})`);
    }
    const where = conds.join(" AND ");
    const { rows } = await this.pool.query(
      { text: `SELECT s.*, a.name AS agent_name FROM sessions s JOIN agents a ON a.id = s.agent_id
               WHERE ${where} ORDER BY s.updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        values: [...params, limit, offset] });
    const { rows: c } = await this.pool.query(
      { text: `SELECT count(*)::int AS n FROM sessions s WHERE ${where}`, values: params });
    return { rows, count: c[0].n };
  }

  async setSessionMemoryStore(sessionId: string, storeId: string) {
    await this.pool.query("UPDATE sessions SET memory_store_id = $2 WHERE id = $1", [sessionId, storeId]);
  }

  /** Everything a session detail page shows: files (in/out), memory, skills,
   *  tools, environment, vault, mcp, subagents — resolved to names, from the pinned version. */
  async sessionResources(sessionId: string, workspaceId: string) {
    const session = await this.getSession(sessionId, workspaceId);
    if (!session) return null;
    const v = await this.getAgentVersion(session.agent_id, session.agent_version);
    const { rows: agentRows } = await this.pool.query(
      "SELECT name FROM agents WHERE id = $1", [session.agent_id]);
    const files = await this.listSessionFiles(sessionId);
    const skillIds: string[] = v?.skill_ids ?? [];
    const skills = skillIds.length ? await this.listSkills(workspaceId, skillIds) : [];
    let memory = null, environment = null, vault = null;
    if (session.memory_store_id) memory = await this.getMemoryStore(session.memory_store_id);
    if (v?.environment_id) {
      const { rows } = await this.pool.query("SELECT id, name, allowed_hosts, allow_package_managers FROM environments WHERE id = $1", [v.environment_id]);
      environment = rows[0] ?? null;
    }
    if (v?.vault_id) {
      const { rows } = await this.pool.query("SELECT id, name FROM vaults WHERE id = $1", [v.vault_id]);
      vault = rows[0] ?? null;
    }
    const rawSubagents: { agentId: string; instructions: string }[] = v?.subagents ?? [];
    let subagents: { agentId: string; name: string; instructions: string }[] = [];
    if (rawSubagents.length) {
      const { rows: subagentAgents } = await this.pool.query(
        "SELECT id, name FROM agents WHERE id = ANY($1)", [rawSubagents.map((s) => s.agentId)]);
      const nameById = new Map(subagentAgents.map((a: any) => [a.id, a.name]));
      subagents = rawSubagents.map((s) => ({
        agentId: s.agentId, name: nameById.get(s.agentId) ?? s.agentId, instructions: s.instructions,
      }));
    }
    return {
      inputFiles: files.filter((f: any) => f.role === "input"),
      outputFiles: files.filter((f: any) => f.role === "output"),
      memory,
      skills: skills.map((s: any) => ({ id: s.id, name: s.name })),
      tools: v?.tools ?? [],
      environment,
      vault,
      mcpServers: v?.mcp_servers ?? {},
      routing: v?.routing,
      subagents,
      agent: {
        id: session.agent_id,
        name: agentRows[0]?.name ?? session.agent_id,
        version: session.agent_version,
        systemPrompt: v?.system_prompt ?? "",
        maxTurns: v?.max_turns ?? null,
      },
    };
  }

  /** Delete a session (events cascade) AND its file rows (checkpoints/outputs —
   *  the pre-033 leak: ON DELETE SET NULL orphaned them). Returns the object
   *  keys safe to purge (shared-key rule; see deleteFileRecordById).
   *  Excludes kind='memory': those blobs belong to the persistent,
   *  session-independent memory store (reclaimed via memory-entry
   *  replacement, memory-store delete, or GC) and memory_entries.file_id is
   *  ON DELETE NO ACTION — sweeping them here 23503s any session that wrote
   *  memory (runner uploads memory files under the session id). The FK's
   *  sessions→SET NULL just detaches them when the session row goes. */
  async deleteSession(workspaceId: string, id: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `WITH del AS (DELETE FROM files WHERE session_id = $1 AND workspace_id = $2 AND kind NOT IN ('memory', 'wiki') RETURNING id, object_key)
       SELECT DISTINCT d.object_key FROM del d
       WHERE NOT EXISTS (
         SELECT 1 FROM files f WHERE f.object_key = d.object_key AND f.id NOT IN (SELECT id FROM del))`,
      [id, workspaceId]);
    await this.pool.query("DELETE FROM sessions WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
    return rows.map((r: any) => r.object_key);
  }

  async deleteFile(workspaceId: string, id: string): Promise<{ deleted: boolean; objectKey: string | null }> {
    const { rows: owned } = await this.pool.query(
      "SELECT 1 FROM files WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
    if (!owned.length) return { deleted: false, objectKey: null };
    return { deleted: true, objectKey: await this.deleteFileRecordById(id) };
  }

  /** Unscoped delete for platform-managed rows (checkpoints, memory, skill
   *  files). Returns the row's object_key when no OTHER row references the
   *  same key (safe to delete the object), else null. The outer SELECT of a
   *  data-modifying CTE sees pre-delete state — hence the f.id <> d.id guard. */
  async deleteFileRecordById(id: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `WITH del AS (DELETE FROM files WHERE id = $1 RETURNING id, object_key)
       SELECT d.object_key FROM del d
       WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.object_key = d.object_key AND f.id <> d.id)`,
      [id]);
    return rows[0]?.object_key ?? null;
  }

  async deleteMemoryStore(workspaceId: string, id: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT me.file_id FROM memory_entries me
       JOIN memory_stores ms ON ms.id = me.store_id
       WHERE me.store_id = $1 AND ms.workspace_id = $2`, [id, workspaceId]);
    await this.pool.query("DELETE FROM memory_stores WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
    return rows.map((r: any) => r.file_id);
  }
  async deleteMemoryEntry(storeId: string, path: string) {
    await this.pool.query("DELETE FROM memory_entries WHERE store_id = $1 AND path = $2", [storeId, path]);
  }

  // ── LLM wikis (spec 2026-07-18) ──────────────────────────────────────────
  async createWiki(workspaceId: string, name: string, description = "") {
    const id = rid("wiki");
    await this.pool.query(
      "INSERT INTO wikis (id, workspace_id, name, description) VALUES ($1, $2, $3, $4)",
      [id, workspaceId, name, description]);
    return { id, name };
  }
  async listWikis(workspaceId: string, limit = 100, offset = 0) {
    const { rows } = await this.pool.query(
      `SELECT w.*, (SELECT count(*)::int FROM wiki_entries e WHERE e.wiki_id = w.id) AS entry_count,
              (SELECT COALESCE(sum(f.size), 0)::bigint FROM wiki_entries e JOIN files f ON f.id = e.file_id WHERE e.wiki_id = w.id) AS total_bytes,
              (SELECT a.id FROM agents a
                 JOIN LATERAL (SELECT wiki_refs FROM agent_versions WHERE agent_id = a.id ORDER BY version DESC LIMIT 1) av ON true
                 WHERE a.workspace_id = w.workspace_id
                   AND av.wiki_refs @> jsonb_build_array(jsonb_build_object('wikiId', w.id, 'mode', 'write')) LIMIT 1) AS writer_agent_id
       FROM wikis w WHERE w.workspace_id = $1 ORDER BY w.updated_at DESC LIMIT $2 OFFSET $3`, [workspaceId, limit, offset]);
    return { rows, count: await this.count("wikis", workspaceId) };
  }
  async getWiki(wikiId: string, workspaceId?: string) {
    const { rows } = await this.pool.query(
      workspaceId
        ? { text: "SELECT * FROM wikis WHERE id = $1 AND workspace_id = $2", values: [wikiId, workspaceId] }
        : { text: "SELECT * FROM wikis WHERE id = $1", values: [wikiId] });
    return rows[0] ?? null;
  }
  async updateWiki(workspaceId: string, id: string, patch: { name?: string; description?: string }) {
    const sets: string[] = [], vals: any[] = [id, workspaceId];
    if (patch.name !== undefined) { vals.push(patch.name); sets.push(`name = $${vals.length}`); }
    if (patch.description !== undefined) { vals.push(patch.description); sets.push(`description = $${vals.length}`); }
    if (!sets.length) return this.getWiki(id, workspaceId);
    const { rows } = await this.pool.query(
      `UPDATE wikis SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND workspace_id = $2 RETURNING *`, vals);
    return rows[0] ?? null;
  }
  async deleteWiki(workspaceId: string, id: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT we.file_id FROM wiki_entries we JOIN wikis w ON w.id = we.wiki_id
       WHERE we.wiki_id = $1 AND w.workspace_id = $2`, [id, workspaceId]);
    await this.pool.query("DELETE FROM wikis WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
    return rows.map((r: any) => r.file_id);
  }
  async getWikiEntries(wikiId: string) {
    const { rows } = await this.pool.query(
      "SELECT path, file_id, updated_at FROM wiki_entries WHERE wiki_id = $1 ORDER BY path", [wikiId]);
    return rows;
  }
  async getWikiEntry(wikiId: string, path: string) {
    const { rows } = await this.pool.query(
      "SELECT file_id FROM wiki_entries WHERE wiki_id = $1 AND path = $2", [wikiId, path]);
    return rows[0] ?? null;
  }
  /** Diff-aware upsert (mirrors upsertMemoryEntries): returns orphaned file ids. */
  async upsertWikiEntries(wikiId: string, entries: { path: string; fileId: string }[], deletes: string[] = []) {
    const orphaned: string[] = [];
    for (const e of entries) {
      const { rows } = await this.pool.query(
        "SELECT file_id FROM wiki_entries WHERE wiki_id = $1 AND path = $2", [wikiId, e.path]);
      const prev = rows[0]?.file_id;
      if (prev && prev !== e.fileId) orphaned.push(prev);
      await this.pool.query(
        `INSERT INTO wiki_entries (wiki_id, path, file_id, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (wiki_id, path) DO UPDATE SET file_id = EXCLUDED.file_id, updated_at = now()
         WHERE wiki_entries.file_id <> EXCLUDED.file_id`,
        [wikiId, e.path, e.fileId]);
    }
    if (deletes.length) {
      const { rows } = await this.pool.query(
        "SELECT file_id FROM wiki_entries WHERE wiki_id = $1 AND path = ANY($2)", [wikiId, deletes]);
      orphaned.push(...rows.map((r: any) => r.file_id));
      await this.pool.query("DELETE FROM wiki_entries WHERE wiki_id = $1 AND path = ANY($2)", [wikiId, deletes]);
    }
    return orphaned;
  }
  async deleteWikiEntry(wikiId: string, path: string) {
    await this.pool.query("DELETE FROM wiki_entries WHERE wiki_id = $1 AND path = $2", [wikiId, path]);
  }
  /** Wikis by id in one workspace — launch-time resolution of agent wiki_refs. */
  async getWikisByIds(workspaceId: string, ids: string[]) {
    if (!ids.length) return [];
    const { rows } = await this.pool.query(
      "SELECT id, name FROM wikis WHERE workspace_id = $1 AND id = ANY($2)", [workspaceId, ids]);
    return rows;
  }
  /** Subset of `ids` with no wiki row — agent-save validation. */
  async missingWikiIds(workspaceId: string, ids: string[]) {
    if (!ids.length) return [];
    const found = new Set((await this.getWikisByIds(workspaceId, ids)).map((w: any) => w.id));
    return ids.filter((id) => !found.has(id));
  }
  /** The agent (other than exceptAgentId) whose LATEST version writes this wiki,
   *  or null. Enforces the single-writer rule at agent-save time. */
  async wikiWriterAgent(workspaceId: string, wikiId: string, exceptAgentId?: string) {
    const { rows } = await this.pool.query(
      `SELECT a.id, a.name FROM agents a
       JOIN LATERAL (SELECT wiki_refs FROM agent_versions WHERE agent_id = a.id ORDER BY version DESC LIMIT 1) v ON true
       WHERE a.workspace_id = $1 AND v.wiki_refs @> $2::jsonb AND a.id <> $3 LIMIT 1`,
      [workspaceId, JSON.stringify([{ wikiId, mode: "write" }]), exceptAgentId ?? ""]);
    return rows[0] ?? null;
  }

  /** Serialize the exclusive-writer check-then-insert (validateWikiRefs +
   *  newAgentVersion) so two agents can't both claim write on the same wiki in
   *  the TOCTOU window. A per-wiki session-level advisory lock on a dedicated
   *  connection acts as a mutex; concurrent claimers of the same wiki block.
   *  Returns a release handle; call it in a finally. No write refs ⇒ no-op.
   *  lock_timeout bounds the wait: waiters hold a pool connection while blocked
   *  server-side, and the holder still needs a SECOND connection for the
   *  validate+insert queries — with an unbounded wait, poolMax concurrent
   *  claims of one wiki would drain the pool (max 5) and wedge the whole CP.
   *  Timing out turns that pile-up into a clean per-request error instead. */
  async acquireWikiWriteLock(writeWikiIds: string[]): Promise<{ release: () => Promise<void> }> {
    const ids = [...new Set(writeWikiIds)].sort(); // sorted ⇒ no lock-order deadlock
    if (!ids.length) return { release: async () => {} };
    const client = await this.pool.connect();
    try {
      await client.query("SET lock_timeout = '10s'"); // advisory-lock waits honor it
      for (const id of ids) {
        await client.query("SELECT pg_advisory_lock(hashtext('wiki_writer:' || $1)::bigint)", [id]);
      }
    } catch (err) {
      client.release(err as Error); // couldn't lock — destroy the conn, never pool a half-locked one
      throw err;
    }
    return {
      release: async () => {
        // RESET too: lock_timeout is session-level and would otherwise ride the
        // pooled connection into unrelated queries (e.g. FOR UPDATE waits).
        try { await client.query("SELECT pg_advisory_unlock_all(); RESET lock_timeout"); client.release(); }
        catch (err) { client.release(err as Error); } // destroy so a stuck lock can't linger in the pool
      },
    };
  }
  /** True when any agent's LATEST version references this wiki (blocks delete).
   *  Older versions keep their wiki_refs forever (every save is a new version),
   *  so counting them would make a once-attached wiki permanently undeletable;
   *  sessions pinned to old versions are safe — resolveWikiMounts skips stale refs. */
  async wikiInUse(id: string) {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM agents a
       JOIN LATERAL (SELECT wiki_refs FROM agent_versions WHERE agent_id = a.id ORDER BY version DESC LIMIT 1) v ON true
       WHERE v.wiki_refs @> $1::jsonb OR v.wiki_refs @> $2::jsonb LIMIT 1`,
      [JSON.stringify([{ wikiId: id, mode: "read" }]), JSON.stringify([{ wikiId: id, mode: "write" }])]);
    return rows.length > 0;
  }
  /** A queued|running session for this agent other than exceptId — the writer
   *  agent's single-session lock (spec 2026-07-18). */
  async agentHasActiveSession(agentId: string, exceptId?: string) {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM sessions WHERE agent_id = $1 AND status IN ('queued','running') AND id <> $2 LIMIT 1`,
      [agentId, exceptId ?? ""]);
    return rows.length > 0;
  }

  // ── Observability (per agent) ────────────────────────────────────────────
  async agentObservability(agentId: string) {
    const { rows: [totals] } = await this.pool.query(
      `SELECT count(*)::int AS sessions,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              COALESCE(sum(tokens_in), 0)::bigint AS tokens_in,
              COALESCE(sum(tokens_out), 0)::bigint AS tokens_out,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY turns) AS p50_turns,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY turns) AS p95_turns,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY tokens_in) AS p50_tokens_in,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY tokens_in) AS p95_tokens_in,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at))) AS p50_duration_s
       FROM sessions WHERE agent_id = $1`,
      [agentId],
    );
    const { rows: tools } = await this.pool.query(
      `SELECT e.payload->>'tool' AS tool, count(*)::int AS calls
       FROM session_events e JOIN sessions s ON s.id = e.session_id
       WHERE s.agent_id = $1 AND e.type = 'tool.call'
       GROUP BY 1 ORDER BY 2 DESC`,
      [agentId],
    );
    return {
      sessions: totals.sessions,
      errorRate: totals.sessions ? totals.failed / totals.sessions : 0,
      tokensIn: Number(totals.tokens_in),
      tokensOut: Number(totals.tokens_out),
      p50Turns: Number(totals.p50_turns ?? 0),
      p95Turns: Number(totals.p95_turns ?? 0),
      p50TokensIn: Number(totals.p50_tokens_in ?? 0),
      p95TokensIn: Number(totals.p95_tokens_in ?? 0),
      p50DurationS: Number(totals.p50_duration_s ?? 0),
      toolUsage: tools,
    };
  }

  /** Gateway-metered API usage (gateway_usage, written by the gateway's
   *  success hook). Read-side only — filters + bucketing for the Usage page.
   *  API usage = source='api' (external clients via API keys); session usage
   *  (source='session') is served by sessionUsage below — the old rule that
   *  the Usage page never sees session rows was revoked by spec 2026-07-14. */
  async gatewayUsage(
    workspaceId: string,
    opts: { range?: string; deployment?: string; apiKeyId?: string; allWorkspaces?: boolean } = {},
  ) {
    const { start, end, bucket } = rangeWindow(opts.range ?? "7d");
    const conds = ["u.created_at >= $1", "u.source = 'api'"];
    const params: unknown[] = [start];
    let endParam: string | null = null;
    if (!opts.allWorkspaces) { params.push(workspaceId); conds.push(`u.workspace_id = $${params.length}`); }
    if (end) { params.push(end); endParam = `$${params.length}`; conds.push(`u.created_at < ${endParam}`); }
    if (opts.deployment) { params.push(opts.deployment); conds.push(`u.model = $${params.length}`); }
    if (opts.apiKeyId === "__deleted__") { conds.push("u.api_key_id IS NULL"); }
    else if (opts.apiKeyId) { params.push(opts.apiKeyId); conds.push(`u.api_key_id = $${params.length}`); }
    const where = conds.join(" AND ");
    const num = (r: any) => ({ ...r, tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out),
      requests: Number(r.requests), real_cost: Number(r.real_cost ?? 0), billed_cost: Number(r.billed_cost ?? 0) });

    const [buckets, totals, byDeployment, byKey] = await Promise.all([
      // Zero-filled: one row per bucket across the whole window, so the
      // charts cover the full selected range (user 2026-07-14).
      this.pool.query(
        `SELECT to_char(g.d, 'YYYY-MM-DD') AS bucket,
                COALESCE(a.tokens_in, 0)::bigint AS tokens_in,
                COALESCE(a.tokens_out, 0)::bigint AS tokens_out,
                COALESCE(a.requests, 0)::int AS requests,
                COALESCE(a.real_cost, 0)::numeric AS real_cost,
                COALESCE(a.billed_cost, 0)::numeric AS billed_cost
         FROM ${bucketSeries(bucket, "$1", endParam)} g(d)
         LEFT JOIN (
           SELECT date_trunc('${bucket}', u.created_at) AS d,
                  sum(u.tokens_in) AS tokens_in, sum(u.tokens_out) AS tokens_out, count(*) AS requests,
                  sum(u.real_cost) AS real_cost, sum(u.billed_cost) AS billed_cost
           FROM gateway_usage u WHERE ${where} GROUP BY 1
         ) a ON a.d = g.d ORDER BY 1`, params),
      this.pool.query(
        `SELECT COALESCE(sum(u.tokens_in),0)::bigint AS tokens_in,
                COALESCE(sum(u.tokens_out),0)::bigint AS tokens_out, count(*)::int AS requests,
                COALESCE(sum(u.real_cost),0)::numeric AS real_cost,
                COALESCE(sum(u.billed_cost),0)::numeric AS billed_cost
         FROM gateway_usage u WHERE ${where}`, params),
      this.pool.query(
        `SELECT u.model, COALESCE(sum(u.tokens_in),0)::bigint AS tokens_in,
                COALESCE(sum(u.tokens_out),0)::bigint AS tokens_out, count(*)::int AS requests,
                COALESCE(sum(u.real_cost),0)::numeric AS real_cost,
                COALESCE(sum(u.billed_cost),0)::numeric AS billed_cost
         FROM gateway_usage u WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, params),
      this.pool.query(
        `SELECT u.api_key_id, k.name, k.status, COALESCE(sum(u.tokens_in),0)::bigint AS tokens_in,
                COALESCE(sum(u.tokens_out),0)::bigint AS tokens_out, count(*)::int AS requests,
                COALESCE(sum(u.real_cost),0)::numeric AS real_cost,
                COALESCE(sum(u.billed_cost),0)::numeric AS billed_cost
         FROM gateway_usage u LEFT JOIN api_keys k ON k.id = u.api_key_id
         WHERE ${where} GROUP BY 1, 2, 3 ORDER BY 4 DESC`, params),
    ]);
    return {
      bucket,
      buckets: buckets.rows.map(num),
      totals: num(totals.rows[0]),
      byDeployment: byDeployment.rows.map(num),
      byKey: byKey.rows.map(num),
    };
  }

  /** Session usage from gateway_usage(source='session') — the only basis that
   *  supports range/deployment/workspace filters (the old sessions-table
   *  rollup had NO time filter on byModel and summed lifetime tokens).
   *  Time costs (env_pod real / session_time billed) attach when no
   *  deployment filter is set — those entries carry no deployment. */
  async sessionUsage(workspaceId: string | null,
    opts: { range?: string; deployment?: string; agentId?: string } = {}) {
    const { start, end, bucket } = rangeWindow(opts.range ?? "7d");
    const conds = ["u.created_at >= $1", "u.source = 'session'"];
    const params: unknown[] = [start];
    let endParam: string | null = null;
    if (end) { params.push(end); endParam = `$${params.length}`; conds.push(`u.created_at < ${endParam}`); }
    if (workspaceId) { params.push(workspaceId); conds.push(`u.workspace_id = $${params.length}`); }
    if (opts.deployment) { params.push(opts.deployment); conds.push(`u.model = $${params.length}`); }
    if (opts.agentId) { params.push(opts.agentId); conds.push(`u.agent_id = $${params.length}`); }
    const where = conds.join(" AND ");
    const num = (r: any) => ({ ...r, tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out),
      requests: Number(r.requests ?? 0), sessions: Number(r.sessions ?? 0),
      real_cost: Number(r.real_cost ?? 0), billed_cost: Number(r.billed_cost ?? 0) });

    const sums = `COALESCE(sum(u.tokens_in),0)::bigint AS tokens_in,
                  COALESCE(sum(u.tokens_out),0)::bigint AS tokens_out, count(*)::int AS requests,
                  COALESCE(sum(u.real_cost),0)::numeric AS real_cost,
                  COALESCE(sum(u.billed_cost),0)::numeric AS billed_cost`;
    const [buckets, totals, byDeployment] = await Promise.all([
      // Zero-filled across the whole window (user 2026-07-14).
      this.pool.query(
        `SELECT to_char(g.d, 'YYYY-MM-DD') AS bucket,
                COALESCE(a.tokens_in, 0)::bigint AS tokens_in,
                COALESCE(a.tokens_out, 0)::bigint AS tokens_out,
                COALESCE(a.requests, 0)::int AS requests,
                COALESCE(a.real_cost, 0)::numeric AS real_cost,
                COALESCE(a.billed_cost, 0)::numeric AS billed_cost
         FROM ${bucketSeries(bucket, "$1", endParam)} g(d)
         LEFT JOIN (
           SELECT date_trunc('${bucket}', u.created_at) AS d,
                  sum(u.tokens_in) AS tokens_in, sum(u.tokens_out) AS tokens_out, count(*) AS requests,
                  sum(u.real_cost) AS real_cost, sum(u.billed_cost) AS billed_cost
           FROM gateway_usage u WHERE ${where} GROUP BY 1
         ) a ON a.d = g.d ORDER BY 1`, params),
      this.pool.query(`SELECT ${sums} FROM gateway_usage u WHERE ${where}`, params),
      this.pool.query(
        `SELECT u.model, count(DISTINCT u.session_id)::int AS sessions, ${sums}
         FROM gateway_usage u WHERE ${where} GROUP BY 1 ORDER BY 3 DESC`, params),
    ]);

    // Sessions started in-range (kept from the old card, now range-aware).
    const sConds = ["created_at >= $1"]; const sParams: unknown[] = [start];
    if (end) { sParams.push(end); sConds.push(`created_at < $${sParams.length}`); }
    if (workspaceId) { sParams.push(workspaceId); sConds.push(`workspace_id = $${sParams.length}`); }
    if (opts.agentId) { sParams.push(opts.agentId); sConds.push(`agent_id = $${sParams.length}`); }
    const { rows: sc } = await this.pool.query(
      `SELECT count(*)::int AS n FROM sessions WHERE ${sConds.join(" AND ")}`, sParams);

    // Time costs — env/session ledger kinds; not deployment-attributable, but
    // agent-attributable via the entry's session. Totals feed the cost cards;
    // the per-bucket series (zero-filled) feeds the session infra-cost chart
    // (env uptime real / session-minute billing per day).
    let timeCosts: { real: number; billed: number } | null = null;
    let timeCostBuckets: { bucket: string; real: number; billed: number }[] | null = null;
    if (!opts.deployment) {
      const tConds = ["ts >= $1", "kind IN ('env_pod','session_time')"];
      const tParams: unknown[] = [start];
      let tEndParam: string | null = null;
      if (end) { tParams.push(end); tEndParam = `$${tParams.length}`; tConds.push(`ts < ${tEndParam}`); }
      if (workspaceId) { tParams.push(workspaceId); tConds.push(`workspace_id = $${tParams.length}`); }
      if (opts.agentId) {
        tParams.push(opts.agentId);
        tConds.push(`session_id IN (SELECT id FROM sessions WHERE agent_id = $${tParams.length})`);
      }
      const tWhere = tConds.join(" AND ");
      const [tc, tb] = await Promise.all([
        this.pool.query(
          `SELECT COALESCE(sum(real_cost),0)::numeric AS real, COALESCE(sum(billed_cost),0)::numeric AS billed
           FROM cost_entries WHERE ${tWhere}`, tParams),
        this.pool.query(
          `SELECT to_char(g.d, 'YYYY-MM-DD') AS bucket,
                  COALESCE(a.real, 0)::numeric AS real, COALESCE(a.billed, 0)::numeric AS billed
           FROM ${bucketSeries(bucket, "$1", tEndParam)} g(d)
           LEFT JOIN (
             SELECT date_trunc('${bucket}', ts) AS d, sum(real_cost) AS real, sum(billed_cost) AS billed
             FROM cost_entries WHERE ${tWhere} GROUP BY 1
           ) a ON a.d = g.d ORDER BY 1`, tParams),
      ]);
      timeCosts = { real: Number(tc.rows[0].real), billed: Number(tc.rows[0].billed) };
      timeCostBuckets = tb.rows.map((r: any) => ({ bucket: r.bucket, real: Number(r.real), billed: Number(r.billed) }));
    }
    return {
      bucket,
      buckets: buckets.rows.map(num),
      totals: num(totals.rows[0]),
      byDeployment: byDeployment.rows.map(num),
      sessionsCount: Number(sc[0].n),
      timeCosts,
      timeCostBuckets,
    };
  }

  /** Cross-workspace key list for the all-workspaces usage filter. */
  async listAllApiKeys() {
    const { rows } = await this.pool.query(
      `SELECT k.id, k.name, k.status, k.workspace_id, w.name AS workspace_name
       FROM api_keys k LEFT JOIN workspaces w ON w.id = k.workspace_id
       ORDER BY k.created_at DESC LIMIT 1000`);
    return rows;
  }

  // ── Environments / Vaults / Skills / Memory / Webhooks (workspace-scoped) ──
  async createVault(workspaceId: string, name: string) {
    const id = rid("vlt");
    await this.pool.query("INSERT INTO vaults (id, workspace_id, name) VALUES ($1, $2, $3)", [id, workspaceId, name]);
    return { id, name };
  }
  async getVault(workspaceId: string, id: string) {
    const { rows } = await this.pool.query("SELECT * FROM vaults WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
    return rows[0] ?? null;
  }
  async listVaultCredentials(vaultId: string) {
    const { rows } = await this.pool.query(
      "SELECT name, type, mcp_server_url, mcp_server_name, created_at FROM vault_credentials WHERE vault_id = $1 ORDER BY name",
      [vaultId]);
    return rows;
  }
  async getVaultCredential(vaultId: string, name: string) {
    const { rows } = await this.pool.query(
      "SELECT name, type, mcp_server_url, mcp_server_name, created_at FROM vault_credentials WHERE vault_id = $1 AND name = $2",
      [vaultId, name]);
    return rows[0] ?? null;
  }
  // Same name+type+server = rotate (upsert, the pre-028 semantics); the API
  // layer 409s a name reuse with a DIFFERENT type/server before calling this.
  async addVaultCredential(vaultId: string, name: string, type = "environment_variable",
                           mcpServerUrl?: string | null, mcpServerName?: string | null) {
    await this.pool.query(
      `INSERT INTO vault_credentials (vault_id, name, type, mcp_server_url, mcp_server_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (vault_id, name) DO UPDATE
         SET created_at = now(), type = $3, mcp_server_url = $4, mcp_server_name = $5`,
      [vaultId, name, type, mcpServerUrl ?? null, mcpServerName ?? null]);
  }
  async removeVaultCredential(vaultId: string, name: string) {
    await this.pool.query("DELETE FROM vault_credentials WHERE vault_id = $1 AND name = $2", [vaultId, name]);
  }
  async listVaults(workspaceId: string, limit = 100, offset = 0) {
    const { rows } = await this.pool.query(
      "SELECT * FROM vaults WHERE workspace_id = $1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3", [workspaceId, limit, offset]);
    return { rows, count: await this.count("vaults", workspaceId) };
  }

  async createMemoryStore(workspaceId: string, name: string) {
    const id = rid("memstore");
    await this.pool.query("INSERT INTO memory_stores (id, workspace_id, name) VALUES ($1, $2, $3)", [id, workspaceId, name]);
    return { id, name };
  }
  async updateMemoryStore(workspaceId: string, id: string, patch: { name?: string }) {
    if (patch.name === undefined) return this.getMemoryStore(id, workspaceId);
    const { rows } = await this.pool.query(
      `UPDATE memory_stores SET name = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2 RETURNING *`,
      [id, workspaceId, patch.name]);
    return rows[0] ?? null;
  }
  async listMemoryStores(workspaceId: string, limit = 100, offset = 0) {
    const { rows } = await this.pool.query(
      `SELECT m.*, (SELECT count(*)::int FROM memory_entries e WHERE e.store_id = m.id) AS entry_count
       FROM memory_stores m WHERE m.workspace_id = $1 ORDER BY m.updated_at DESC LIMIT $2 OFFSET $3`, [workspaceId, limit, offset]);
    return { rows, count: await this.count("memory_stores", workspaceId) };
  }
  async getMemoryStore(storeId: string, workspaceId?: string) {
    const { rows } = await this.pool.query(
      workspaceId
        ? { text: "SELECT * FROM memory_stores WHERE id = $1 AND workspace_id = $2", values: [storeId, workspaceId] }
        : { text: "SELECT * FROM memory_stores WHERE id = $1", values: [storeId] });
    return rows[0] ?? null;
  }
  async getMemoryEntries(storeId: string) {
    const { rows } = await this.pool.query(
      "SELECT path, file_id, updated_at FROM memory_entries WHERE store_id = $1 ORDER BY path", [storeId]);
    return rows;
  }
  async getMemoryEntry(storeId: string, path: string) {
    const { rows } = await this.pool.query(
      "SELECT file_id FROM memory_entries WHERE store_id = $1 AND path = $2", [storeId, path]);
    return rows[0] ?? null;
  }
  /** Diff-aware upsert: only touches paths whose file_id changed; supports
   *  deletes. Returns the file ids this call orphaned (replaced or removed)
   *  so the caller can delete their rows + objects — growth guard now that
   *  duplicate uploads are distinct files. */
  async upsertMemoryEntries(storeId: string, entries: { path: string; fileId: string }[], deletes: string[] = []) {
    const orphaned: string[] = [];
    for (const e of entries) {
      const { rows } = await this.pool.query(
        "SELECT file_id FROM memory_entries WHERE store_id = $1 AND path = $2", [storeId, e.path]);
      const prev = rows[0]?.file_id;
      if (prev && prev !== e.fileId) orphaned.push(prev);
      await this.pool.query(
        `INSERT INTO memory_entries (store_id, path, file_id, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (store_id, path) DO UPDATE SET file_id = EXCLUDED.file_id, updated_at = now()
         WHERE memory_entries.file_id <> EXCLUDED.file_id`,
        [storeId, e.path, e.fileId],
      );
    }
    if (deletes.length) {
      const { rows } = await this.pool.query(
        "SELECT file_id FROM memory_entries WHERE store_id = $1 AND path = ANY($2)", [storeId, deletes]);
      orphaned.push(...rows.map((r: any) => r.file_id));
      await this.pool.query("DELETE FROM memory_entries WHERE store_id = $1 AND path = ANY($2)", [storeId, deletes]);
    }
    return orphaned;
  }

  async getSkillIdByName(workspaceId: string, name: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      "SELECT id FROM skills WHERE workspace_id = $1 AND name = $2", [workspaceId, name]);
    return rows[0]?.id ?? null;
  }

  /** files = manifest [{path, fileId}]; the SKILL.md entry seeds file_id.
   *  `id` is honored on the INSERT branch (the route resolves it up front to
   *  build object keys). Re-upload bumps the version and returns the replaced
   *  manifest's file ids so the route can purge them (rows + dropped keys). */
  async createSkill(workspaceId: string, name: string, files: { path: string; fileId: string }[], id?: string) {
    const skillMd = files.find((f) => f.path.toLowerCase() === "skill.md") ?? files[0];
    // Re-uploading a skill by the same name bumps its version in place.
    const { rows: existing } = await this.pool.query(
      "SELECT id, version, file_id, files FROM skills WHERE workspace_id = $1 AND name = $2", [workspaceId, name]);
    if (existing[0]) {
      const version = existing[0].version + 1;
      const prev: { path: string; fileId: string }[] = existing[0].files ?? [];
      const previousFileIds = [...new Set([...prev.map((f) => f.fileId), existing[0].file_id].filter(Boolean))];
      await this.pool.query(
        "UPDATE skills SET file_id = $3, files = $4, version = $5, updated_at = now() WHERE id = $1 AND workspace_id = $2",
        [existing[0].id, workspaceId, skillMd?.fileId ?? null, JSON.stringify(files), version]);
      return { id: existing[0].id, name, version, fileCount: files.length, previousFileIds };
    }
    const skillId = id ?? rid("skill");
    await this.pool.query(
      "INSERT INTO skills (id, workspace_id, name, file_id, files) VALUES ($1, $2, $3, $4, $5)",
      [skillId, workspaceId, name, skillMd?.fileId ?? null, JSON.stringify(files)],
    );
    return { id: skillId, name, version: 1, fileCount: files.length, previousFileIds: [] as string[] };
  }
  async getSkill(workspaceId: string, id: string) {
    const { rows } = await this.pool.query("SELECT * FROM skills WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
    return rows[0] ?? null;
  }

  async deleteSkill(workspaceId: string, id: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      "SELECT file_id, files FROM skills WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
    if (!rows[0]) return [];
    const ids = [...new Set([...(rows[0].files ?? []).map((f: any) => f.fileId), rows[0].file_id].filter(Boolean))];
    await this.pool.query("DELETE FROM skills WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
    return ids;
  }

  /** Subset of `ids` with no skill row — agent-save validation. Sessions
   *  resolve skills by id at launch, so a dead reference silently launches
   *  skill-less sessions (live bug 2026-07-13, sesn_9zxtr63p4xj1). */
  async missingSkillIds(workspaceId: string, ids: string[]) {
    if (!ids.length) return [];
    const found = new Set((await this.listSkills(workspaceId, ids)).map((s: any) => s.id));
    return ids.filter((id) => !found.has(id));
  }

  /** True when any agent version still references this skill (mirrors
   *  environmentInUse: resumed sessions re-resolve skills from their pinned
   *  version's config, so even non-latest references must block deletion). */
  async skillInUse(id: string) {
    const { rows } = await this.pool.query(
      "SELECT 1 FROM agent_versions WHERE skill_ids @> $1::jsonb LIMIT 1", [JSON.stringify([id])]);
    return rows.length > 0;
  }

  async deleteAgent(workspaceId: string, id: string) {
    await this.pool.query("DELETE FROM agents WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  }
  /** Soft delete: the row (and its name) survives for usage attribution;
   *  the gateway rejects it immediately (auth requires status='active'). */
  async deleteApiKey(workspaceId: string, id: string) {
    await this.pool.query("UPDATE api_keys SET status = 'deleted' WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  }
  async deleteVault(workspaceId: string, id: string) {
    await this.pool.query("DELETE FROM vaults WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  }
  async deleteEnvironment(workspaceId: string, id: string) {
    await this.pool.query("DELETE FROM environments WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  }
  /** True when any agent version still references this environment. */
  async environmentInUse(id: string) {
    const { rows } = await this.pool.query("SELECT 1 FROM agent_versions WHERE environment_id = $1 LIMIT 1", [id]);
    return rows.length > 0;
  }
  /** mcp_servers of the LATEST version of every agent bound to this
   *  environment — input for the env's Squid MCP-host allowlist. */
  async mcpServersForEnvironment(environmentId: string): Promise<Record<string, any>[]> {
    const { rows } = await this.pool.query(
      `SELECT mcp_servers FROM (
         SELECT DISTINCT ON (agent_id) environment_id, mcp_servers
         FROM agent_versions ORDER BY agent_id, version DESC
       ) latest WHERE environment_id = $1`, [environmentId]);
    return rows.map((r: any) => r.mcp_servers ?? {});
  }

  // ── Custom catalog models (merged with the bundled YAML) ─────────────────
  async listCatalogModels() {
    const { rows } = await this.pool.query("SELECT entry FROM catalog_models ORDER BY created_at DESC");
    return rows.map((r: any) => r.entry);
  }
  async createCatalogModel(entry: any) {
    await this.pool.query(
      "INSERT INTO catalog_models (id, entry) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET entry = $2",
      [entry.id, JSON.stringify(entry)],
    );
    return entry;
  }
  async deleteCatalogModel(id: string) {
    await this.pool.query("DELETE FROM catalog_models WHERE id = $1", [id]);
  }
  async listSkills(workspaceId: string, ids?: string[], limit = 100, offset = 0) {
    const { rows } = await this.pool.query(
      ids
        ? { text: "SELECT * FROM skills WHERE workspace_id = $1 AND id = ANY($2)", values: [workspaceId, ids] }
        : { text: "SELECT * FROM skills WHERE workspace_id = $1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3", values: [workspaceId, limit, offset] },
    );
    return rows;
  }
  async countSkills(workspaceId: string) { return this.count("skills", workspaceId); }

  async createEnvironment(workspaceId: string, name: string, allowPackageManagers = false,
                          allowedHosts: string[] = [], pod: PodConfig = {}, allowMcpServers = false) {
    const id = rid("env");
    await this.pool.query(
      "INSERT INTO environments (id, workspace_id, name, allow_package_managers, allowed_hosts, pod, allow_mcp_servers) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [id, workspaceId, name, allowPackageManagers, JSON.stringify(allowedHosts), JSON.stringify(pod), allowMcpServers],
    );
    return { id, name, allowPackageManagers, allowedHosts, pod, allowMcpServers };
  }
  async listEnvironments(workspaceId: string, limit = 100, offset = 0) {
    const { rows } = await this.pool.query(
      "SELECT * FROM environments WHERE workspace_id = $1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3", [workspaceId, limit, offset]);
    return { rows, count: await this.count("environments", workspaceId) };
  }
  /** Partial update; returns the updated row (snake_case) or null when the
   *  id doesn't exist in this workspace. */
  async updateEnvironment(
    workspaceId: string, id: string,
    patch: { name?: string; allowPackageManagers?: boolean; allowedHosts?: string[]; pod?: PodConfig; allowMcpServers?: boolean },
  ) {
    const sets: string[] = [];
    const params: unknown[] = [id, workspaceId];
    if (patch.name !== undefined) { params.push(patch.name); sets.push(`name = $${params.length}`); }
    if (patch.allowPackageManagers !== undefined) { params.push(patch.allowPackageManagers); sets.push(`allow_package_managers = $${params.length}`); }
    if (patch.allowMcpServers !== undefined) { params.push(patch.allowMcpServers); sets.push(`allow_mcp_servers = $${params.length}`); }
    if (patch.allowedHosts !== undefined) { params.push(JSON.stringify(patch.allowedHosts)); sets.push(`allowed_hosts = $${params.length}`); }
    if (patch.pod !== undefined) { params.push(JSON.stringify(patch.pod)); sets.push(`pod = $${params.length}`); }
    if (!sets.length) {
      const { rows } = await this.pool.query("SELECT * FROM environments WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
      return rows[0] ?? null;
    }
    const { rows } = await this.pool.query(
      `UPDATE environments SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND workspace_id = $2 RETURNING *`, params);
    return rows[0] ?? null;
  }

  /** Environment row by id, workspace-agnostic (ids are unguessable). */
  async getEnvironment(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM environments WHERE id = $1", [id]);
    return rows[0] ?? null;
  }

  async createWebhook(workspaceId: string, url: string, events?: string[]) {
    const id = rid("whk");
    await this.pool.query(
      "INSERT INTO webhooks (id, workspace_id, url, events) VALUES ($1, $2, $3, $4)",
      [id, workspaceId, url, JSON.stringify(events ?? ["session.completed", "session.failed"])],
    );
    return { id, url };
  }
  async listWebhooks(workspaceId?: string) {
    const { rows } = await this.pool.query(
      workspaceId
        ? { text: "SELECT * FROM webhooks WHERE workspace_id = $1 ORDER BY created_at DESC", values: [workspaceId] }
        : { text: "SELECT * FROM webhooks ORDER BY created_at DESC", values: [] });
    return rows;
  }

  // ── Files ────────────────────────────────────────────────────────────────
  // Plain insert: ids are unique per upload; duplicate bytes create duplicate
  // rows by design (content-addressing removed 2026-07-10 — sha256 is kept as
  // an informational column only).
  async createFileRecord(meta: { id: string; name: string; size: number; sha256: string; objectKey: string; sessionId?: string; kind?: string; workspaceId?: string }) {
    await this.pool.query(
      "INSERT INTO files (id, workspace_id, session_id, name, size, sha256, kind, object_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [meta.id, meta.workspaceId ?? DEFAULT_WORKSPACE, meta.sessionId ?? null, meta.name, meta.size, meta.sha256, meta.kind ?? "upload", meta.objectKey],
    );
    return meta;
  }
  async getFileRecord(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM files WHERE id = $1", [id]);
    return rows[0] ?? null;
  }
  async listFileRecords(ids: string[]) {
    if (!ids.length) return [];
    const { rows } = await this.pool.query("SELECT * FROM files WHERE id = ANY($1)", [ids]);
    return rows;
  }
  /** Paginated file listing. Shows input uploads + session outputs (the
   *  user-facing kinds); with the count of sessions each is attached to. */
  async listAllFiles(workspaceId: string, opts: { kind?: string; limit?: number; offset?: number } = {}) {
    const limit = Math.min(opts.limit ?? 25, 200);
    const offset = opts.offset ?? 0;
    const kinds = opts.kind ? [opts.kind] : ["upload", "output"];
    const { rows } = await this.pool.query(
      `SELECT f.*, (SELECT count(*)::int FROM session_files sf WHERE sf.file_id = f.id) AS session_count
       FROM files f WHERE f.workspace_id = $1 AND f.kind = ANY($2)
       ORDER BY f.created_at DESC LIMIT $3 OFFSET $4`,
      [workspaceId, kinds, limit, offset],
    );
    const { rows: [{ total }] } = await this.pool.query(
      "SELECT count(*)::int AS total FROM files WHERE workspace_id = $1 AND kind = ANY($2)",
      [workspaceId, kinds],
    );
    return { files: rows, total, limit, offset };
  }

  // ── Chunked public-API uploads (spec 2026-07-12) ─────────────────────────
  async createFileUpload(workspaceId: string, m: { id: string; fileId: string; uploadKey: string; name: string; kind: string; partSize: number }) {
    await this.pool.query(
      "INSERT INTO file_uploads (id, workspace_id, file_id, upload_key, name, kind, part_size) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [m.id, workspaceId, m.fileId, m.uploadKey, m.name, m.kind, m.partSize]);
    return { id: m.id, file_id: m.fileId, part_size: m.partSize };
  }
  async getFileUpload(workspaceId: string, id: string) {
    const { rows } = await this.pool.query(
      "SELECT * FROM file_uploads WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
    return rows[0] ?? null;
  }
  /** Record (or replace, for retries) one uploaded part. */
  async recordUploadPart(id: string, part: { n: number; etag: string; sha256: string; size: number }) {
    await this.pool.query(
      `UPDATE file_uploads SET parts =
         (SELECT COALESCE(jsonb_agg(p), '[]'::jsonb) FROM jsonb_array_elements(parts) p WHERE (p->>'n')::int <> $2)
         || $3::jsonb
       WHERE id = $1`,
      [id, part.n, JSON.stringify([part])]);
  }
  async deleteFileUpload(id: string) {
    await this.pool.query("DELETE FROM file_uploads WHERE id = $1", [id]);
  }
  async listStaleFileUploads(olderThanMs: number) {
    const { rows } = await this.pool.query(
      "SELECT id, upload_key, file_id, workspace_id FROM file_uploads WHERE created_at < now() - make_interval(secs => $1)",
      [olderThanMs / 1000]);
    return rows;
  }

  // ── Session ↔ file attachments (many-to-many) ────────────────────────────
  async attachSessionFiles(sessionId: string, fileIds: string[], role: "input" | "output") {
    for (const fid of fileIds) {
      await this.pool.query(
        "INSERT INTO session_files (session_id, file_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [sessionId, fid, role],
      );
    }
  }
  async listSessionFiles(sessionId: string) {
    const { rows } = await this.pool.query(
      `SELECT sf.role, f.id, f.name, f.size, f.kind, f.created_at
       FROM session_files sf JOIN files f ON f.id = sf.file_id
       WHERE sf.session_id = $1 ORDER BY sf.role, f.name`,
      [sessionId],
    );
    return rows;
  }

  /** Latest assistant text of a session — the delegate poll's resultText. */
  async lastAgentMessage(sessionId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT payload->>'text' AS text FROM session_events
       WHERE session_id = $1 AND type = 'agent.message' ORDER BY seq DESC LIMIT 1`, [sessionId]);
    return rows[0]?.text ?? null;
  }

  /** Latest session.failed error text — the delegate poll's failureDetail. */
  async lastFailureDetail(sessionId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT payload->>'error' AS text FROM session_events
       WHERE session_id = $1 AND type = 'session.failed' ORDER BY seq DESC LIMIT 1`, [sessionId]);
    return rows[0]?.text ?? null;
  }

  /** Whether a session's most recent lifecycle signal was an interruption —
   *  the delegate poll's `interrupted` flag: a terminal (idle) child whose
   *  latest `session.interrupted` event is NEWER than its latest
   *  `session.result` (or has no `session.result` at all) had its turn cut
   *  short, so the parent must not read it as a clean success. */
  async wasInterrupted(sessionId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT
         (SELECT max(seq) FROM session_events WHERE session_id = $1 AND type = 'session.interrupted') AS interrupted_seq,
         (SELECT max(seq) FROM session_events WHERE session_id = $1 AND type = 'session.result') AS result_seq`,
      [sessionId]);
    const interruptedSeq = rows[0]?.interrupted_seq;
    if (interruptedSeq === null || interruptedSeq === undefined) return false;
    const resultSeq = rows[0]?.result_seq;
    return resultSeq === null || resultSeq === undefined || Number(interruptedSeq) > Number(resultSeq);
  }

  /** In-flight children of a parent session (interrupt/reconciler propagation).
   *  Includes launch-gate-parked children (status queued, no Job). */
  async listChildSessions(parentId: string): Promise<{ id: string; status: string }[]> {
    const { rows } = await this.pool.query(
      "SELECT id, status FROM sessions WHERE parent_session_id = $1 AND status IN ('queued','running')",
      [parentId]);
    return rows;
  }

  /** Fan-out counts for the delegate cap: total children a parent has spawned,
   *  and how many are currently in-flight (queued|running). */
  async childSessionCounts(parentId: string): Promise<{ total: number; inFlight: number }> {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status IN ('queued','running'))::int AS in_flight
       FROM sessions WHERE parent_session_id = $1`,
      [parentId]);
    return { total: rows[0].total, inFlight: rows[0].in_flight };
  }

  async listEvents(sessionId: string, afterSeq = 0) {
    const { rows } = await this.pool.query(
      `SELECT seq, type, payload, tokens_in, tokens_out, duration_ms, created_at
       FROM session_events WHERE session_id = $1 AND seq > $2 ORDER BY seq`,
      [sessionId, afterSeq],
    );
    return rows;
  }

  // ── API keys ─────────────────────────────────────────────────────────────
  /** Returns the full plaintext key ONCE; only the hash + hint are stored. */
  async createApiKey(workspaceId: string, name: string) {
    const id = rid("apikey");
    // 33 base62 chars ≈ 196.5 bits ≥ the legacy 48-hex 192 bits; auth is a
    // sha256 hash lookup, so pre-existing hex keys stay valid forever.
    const secret = `dpk_${secretToken(33)}`;
    const hint = `dpk_…${secret.slice(-4)}`;
    const hash = createHash("sha256").update(secret).digest("hex");
    await this.pool.query(
      "INSERT INTO api_keys (id, workspace_id, name, partial_hint, secret_hash) VALUES ($1,$2,$3,$4,$5)",
      [id, workspaceId, name, hint, hash],
    );
    return { id, name, key: secret, partial_hint: hint, status: "active" };
  }
  async listApiKeys(workspaceId: string, limit = 100, offset = 0, includeDeleted = false) {
    const cond = includeDeleted ? "" : " AND status <> 'deleted'";
    const { rows } = await this.pool.query(
      `SELECT id, name, partial_hint, status, created_at, last_used_at FROM api_keys
       WHERE workspace_id = $1${cond} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [workspaceId, limit, offset]);
    const { rows: c } = await this.pool.query(
      `SELECT count(*)::int AS n FROM api_keys WHERE workspace_id = $1${cond}`, [workspaceId]);
    return { rows, count: c[0].n };
  }
  async setApiKeyStatus(workspaceId: string, id: string, status: string) {
    // 'deleted' is terminal: a revoked key must never be resurrectable.
    await this.pool.query(
      "UPDATE api_keys SET status = $3 WHERE workspace_id = $1 AND id = $2 AND status <> 'deleted'",
      [workspaceId, id, status]);
  }
  /** Public-API auth: active-key lookup by sha256(secret). */
  async findApiKeyBySecretHash(hash: string): Promise<{ id: string; workspace_id: string } | null> {
    const { rows } = await this.pool.query(
      "SELECT id, workspace_id FROM api_keys WHERE secret_hash = $1 AND status = 'active'", [hash]);
    return rows[0] ?? null;
  }
  async touchApiKey(id: string) {
    await this.pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [id]);
  }

  // ── Routings (spec 2026-07-16) — global, like everything under Serving ──
  async listRoutings() {
    const { rows } = await this.pool.query("SELECT * FROM routings ORDER BY name");
    return rows;
  }
  async getRoutingByName(name: string) {
    const { rows } = await this.pool.query("SELECT * FROM routings WHERE name = $1", [name]);
    return rows[0] ?? null;
  }
  async createRouting(name: string, rules: unknown, terminal: unknown) {
    const { rows } = await this.pool.query(
      `INSERT INTO routings (name, rules, terminal) VALUES ($1, $2, $3) RETURNING *`,
      [name, JSON.stringify(rules), JSON.stringify(terminal)]);
    return rows[0];
  }
  async updateRouting(name: string, patch: { rules?: unknown; terminal?: unknown }) {
    const { rows } = await this.pool.query(
      `UPDATE routings SET
         rules = COALESCE($2, rules), terminal = COALESCE($3, terminal), updated_at = now()
       WHERE name = $1 RETURNING *`,
      [name, patch.rules === undefined ? null : JSON.stringify(patch.rules),
       patch.terminal === undefined ? null : JSON.stringify(patch.terminal)]);
    return rows[0] ?? null;
  }
  async deleteRouting(name: string) {
    const { rows } = await this.pool.query("DELETE FROM routings WHERE name = $1 RETURNING *", [name]);
    return rows[0] ?? null;
  }
  /** Names of every agent whose LATEST version references this routing (global,
   *  across all workspaces — same latest-version rule as the egress sync). Feeds
   *  the routing-delete guard. */
  async agentsReferencingRouting(name: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT a.name FROM agents a
       JOIN LATERAL (SELECT routing FROM agent_versions WHERE agent_id = a.id
                     ORDER BY version DESC LIMIT 1) v ON true
       WHERE v.routing = $1 ORDER BY a.name`, [name]);
    return rows.map((r: any) => r.name);
  }
  async routingTargetBreakdown(name: string, windowSec: number) {
    const { rows } = await this.pool.query(
      `SELECT model, count(*)::int AS requests,
              COALESCE(sum(tokens_in),0)::bigint AS tokens_in, COALESCE(sum(tokens_out),0)::bigint AS tokens_out
       FROM gateway_usage
       WHERE routing = $1 AND created_at > now() - make_interval(secs => $2)
       GROUP BY model ORDER BY requests DESC`, [name, windowSec]);
    return rows.map((r: any) => ({ model: r.model, requests: r.requests,
      tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out) }));
  }
  async routingRejectCount(name: string, windowSec: number): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM routing_rejects
       WHERE routing = $1 AND created_at > now() - make_interval(secs => $2)`, [name, windowSec]);
    return rows[0].n;
  }

  /** Per-bucket breakdowns for the routing Stats charts (spec 2026-07-16, fix
   *  wave H): requests per resolved model (targetBuckets) and per matched rule
   *  incl. a rejects series (ruleBuckets), honoring the same window/api_key/
   *  agent filters as deploymentStats. Every bucket from t0..now is present
   *  and zero-filled across all series keys (same idiom as deploymentStats),
   *  plus a per-chart `series` key list so the client knows the stack order.
   *  Rejects have only api_key attribution: an agent filter omits
   *  them (no agent attribution on rejects). */
  async routingBreakdownBuckets(name: string, opts: {
    windowSec: number; bucketSec: number; apiKeyId?: string; agentId?: string; sessionOnly?: boolean;
  }) {
    const conds = ["routing = $1", "created_at > now() - make_interval(secs => $2)"];
    const params: unknown[] = [name, opts.windowSec];
    if (opts.apiKeyId) { params.push(opts.apiKeyId); conds.push(`api_key_id = $${params.length}`); }
    if (opts.agentId) { params.push(opts.agentId); conds.push(`agent_id = $${params.length}`); }
    if (opts.sessionOnly) conds.push("source = 'session'");
    params.push(opts.bucketSec);
    const bs = `$${params.length}`;
    const bucketT = `(floor(extract(epoch FROM created_at) / ${bs}) * ${bs})::bigint AS t`;

    const [targetRows, ruleRows] = await Promise.all([
      this.pool.query(
        `SELECT ${bucketT}, model, count(*)::int AS n FROM gateway_usage
         WHERE ${conds.join(" AND ")} GROUP BY 1, 2`, params),
      this.pool.query(
        `SELECT ${bucketT}, routing_rule, count(*)::int AS n FROM gateway_usage
         WHERE ${conds.join(" AND ")} GROUP BY 1, 2`, params),
    ]);

    // Rejects: api_key attribution only. api_key filter maps directly;
    // __internal__ (sessionOnly) matches the NULL-key rejects; an agent filter
    // drops the series entirely.
    let rejectRows: { t: number; n: number }[] = [];
    if (!opts.agentId) {
      const rc = ["routing = $1", "created_at > now() - make_interval(secs => $2)"];
      const rp: unknown[] = [name, opts.windowSec];
      if (opts.apiKeyId) { rp.push(opts.apiKeyId); rc.push(`api_key_id = $${rp.length}`); }
      else if (opts.sessionOnly) rc.push("api_key_id IS NULL");
      rp.push(opts.bucketSec);
      const rbs = `$${rp.length}`;
      const { rows } = await this.pool.query(
        `SELECT (floor(extract(epoch FROM created_at) / ${rbs}) * ${rbs})::bigint AS t, count(*)::int AS n
         FROM routing_rejects WHERE ${rc.join(" AND ")} GROUP BY 1`, rp);
      rejectRows = rows.map((r: any) => ({ t: Number(r.t), n: r.n }));
    }

    // Pivot (t -> {key: count}) with per-series totals for stack ordering.
    const pivot = (rows: any[], keyOf: (r: any) => string) => {
      const byT = new Map<number, Record<string, number>>();
      const totals = new Map<string, number>();
      for (const r of rows) {
        const t = Number(r.t); const key = keyOf(r); const n = Number(r.n);
        if (!byT.has(t)) byT.set(t, {});
        byT.get(t)![key] = (byT.get(t)![key] ?? 0) + n;
        totals.set(key, (totals.get(key) ?? 0) + n);
      }
      return { byT, totals };
    };

    const tgt = pivot(targetRows.rows, (r) => r.model ?? "unknown");
    const targetSeries = [...tgt.totals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k]) => k);

    const rl = pivot(ruleRows.rows, (r) => (r.routing_rule === null ? "null" : String(r.routing_rule)));
    for (const r of rejectRows) {
      if (!rl.byT.has(r.t)) rl.byT.set(r.t, {});
      const o = rl.byT.get(r.t)!;
      o.rejects = (o.rejects ?? 0) + r.n;
    }
    // Rule series: numeric rules ascending (0,1,…), then -1/-2, then null,
    // then rejects last so it stacks on top.
    const ruleKeys = [...rl.totals.keys()];
    const ord = (k: string) => {
      if (k === "null") return 1e9;
      const n = Number(k);
      return n >= 0 ? n : 1e6 - n; // -1 -> 1000001, -2 -> 1000002 (after real rules)
    };
    const ruleSeries = ruleKeys.sort((a, b) => ord(a) - ord(b));
    if (rejectRows.some((r) => r.n > 0)) ruleSeries.push("rejects");

    // Zero-fill every bucket from t0..now (same idiom as deploymentStats)
    // so the charts don't compress bars across time gaps.
    const nowSec = Math.floor(Date.now() / 1000);
    const t0 = Math.floor((nowSec - opts.windowSec) / opts.bucketSec) * opts.bucketSec + opts.bucketSec;
    const fill = (byT: Map<number, Record<string, number>>, series: string[]) => {
      const buckets = [];
      for (let t = t0; t <= nowSec; t += opts.bucketSec) {
        const o = byT.get(t) ?? {};
        const b: Record<string, number> = { t };
        for (const k of series) b[k] = o[k] ?? 0;
        buckets.push(b);
      }
      return buckets;
    };

    return {
      targetBuckets: fill(tgt.byT, targetSeries), targetSeries,
      ruleBuckets: fill(rl.byT, ruleSeries), ruleSeries,
    };
  }

  // ── External deployments (provider endpoints routed by the gateway) ──────
  // Global (site-wide) since migration 022 — like local deployments and pools.
  async createExternalDeployment(
    d: { name: string; provider: string; baseUrl?: string; modelId: string; hasKey: boolean;
         reasoningEffort?: string | null; contextTokens: number },
  ) {
    const id = rid("mdep");
    const { rows } = await this.pool.query(
      `INSERT INTO external_deployments (id, name, provider, base_url, model_id, has_key, reasoning_effort, context_tokens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, d.name, d.provider, d.baseUrl ?? null, d.modelId, d.hasKey, d.reasoningEffort ?? null, d.contextTokens],
    );
    return rows[0];
  }
  async listExternalDeployments() {
    const { rows } = await this.pool.query("SELECT * FROM external_deployments ORDER BY name");
    return rows;
  }
  async getExternalDeploymentByName(name: string) {
    const { rows } = await this.pool.query("SELECT * FROM external_deployments WHERE name = $1", [name]);
    return rows[0] ?? null;
  }
  async getExternalDeployment(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM external_deployments WHERE id = $1", [id]);
    return rows[0] ?? null;
  }
  async updateExternalDeployment(
    id: string,
    patch: { baseUrl?: string; modelId?: string; rotateKey?: boolean; reasoningEffort?: string | null;
             contextTokens?: number },
  ) {
    const { rows } = await this.pool.query(
      `UPDATE external_deployments SET
         base_url    = COALESCE($2, base_url),
         model_id    = COALESCE($3, model_id),
         key_version = key_version + CASE WHEN $4 THEN 1 ELSE 0 END,
         has_key     = has_key OR $4,
         reasoning_effort = CASE WHEN $5 THEN $6 ELSE reasoning_effort END,
         context_tokens = COALESCE($7, context_tokens),
         updated_at  = now()
       WHERE id = $1 RETURNING *`,
      [id, patch.baseUrl ?? null, patch.modelId ?? null, patch.rotateKey === true,
       patch.reasoningEffort !== undefined, patch.reasoningEffort ?? null, patch.contextTokens ?? null],
    );
    return rows[0] ?? null;
  }
  async deleteExternalDeployment(id: string) {
    const { rows } = await this.pool.query(
      "DELETE FROM external_deployments WHERE id = $1 RETURNING *", [id]);
    return rows[0] ?? null;
  }

  // ── Deployment monitoring & trace (spec 2026-07-10) ──────────────────────
  /** Fine-grained realtime buckets. model set = one deployment, all-workspace
   *  by design (the detail page monitors the deployment as a whole). model
   *  null = cross-deployment (dashboard, 2026-07-14): token rows may be
   *  workspace-scoped, and the ledger widens to env/session time kinds
   *  (workspace-scoped; infra kinds stay global). */
  async deploymentStats(model: string | null, opts: {
    windowSec: number; bucketSec: number; apiKeyId?: string; agentId?: string; sessionOnly?: boolean;
    costs?: { includeTime: boolean }; workspaceId?: string | null; routingName?: string;
  }) {
    const conds = ["created_at > now() - make_interval(secs => $1)"];
    const params: unknown[] = [opts.windowSec];
    if (model) { params.push(model); conds.push(`model = $${params.length}`); }
    if (opts.workspaceId) { params.push(opts.workspaceId); conds.push(`workspace_id = $${params.length}`); }
    if (opts.apiKeyId) { params.push(opts.apiKeyId); conds.push(`api_key_id = $${params.length}`); }
    if (opts.agentId) { params.push(opts.agentId); conds.push(`agent_id = $${params.length}`); }
    if (opts.routingName) { params.push(opts.routingName); conds.push(`routing = $${params.length}`); }
    if (opts.sessionOnly) conds.push("source = 'session'");
    params.push(opts.bucketSec);
    const bs = `$${params.length}`;
    const { rows } = await this.pool.query(
      `SELECT (floor(extract(epoch FROM created_at) / ${bs}) * ${bs})::bigint AS t,
              COALESCE(sum(tokens_in),0)::bigint AS tokens_in,
              COALESCE(sum(tokens_out),0)::bigint AS tokens_out, count(*)::int AS requests,
              COALESCE(sum(real_cost),0)::numeric AS real_cost,
              COALESCE(sum(billed_cost),0)::numeric AS billed_cost
       FROM gateway_usage WHERE ${conds.join(" AND ")} GROUP BY 1`, params);
    const byT = new Map(rows.map((r: any) => [Number(r.t), r]));
    const nowSec = Math.floor(Date.now() / 1000);
    const t0 = Math.floor((nowSec - opts.windowSec) / opts.bucketSec) * opts.bucketSec + opts.bucketSec;
    const buckets = [];
    const totals = { tokens_in: 0, tokens_out: 0, requests: 0, real_cost: 0, billed_cost: 0 };
    for (let t = t0; t <= nowSec; t += opts.bucketSec) {
      const r: any = byT.get(t);
      const b = {
        t,
        tokens_in: Number(r?.tokens_in ?? 0),
        tokens_out: Number(r?.tokens_out ?? 0),
        requests: Number(r?.requests ?? 0),
        real_cost: Number(r?.real_cost ?? 0),
        billed_cost: Number(r?.billed_cost ?? 0),
      };
      totals.tokens_in += b.tokens_in; totals.tokens_out += b.tokens_out; totals.requests += b.requests;
      totals.real_cost += b.real_cost; totals.billed_cost += b.billed_cost;
      buckets.push(b);
    }
    if (opts.costs?.includeTime) {
      // + GAP_CAP_SEC: an entry spanning the window edge still contributes its
      // overlap. Ledger scope: infra kinds (pool_pod/deployment_time) are
      // global and deployment-filterable; env/session kinds only join the
      // cross-deployment view, workspace-scoped when a workspace is given.
      const tConds = ["ts > now() - make_interval(secs => $1)"];
      const tParams: unknown[] = [opts.windowSec + GAP_CAP_SEC];
      if (model) {
        tParams.push(model);
        tConds.push(`deployment = $${tParams.length} AND kind IN ('pool_pod','deployment_time')`);
      } else if (opts.workspaceId) {
        tParams.push(opts.workspaceId);
        tConds.push(`(kind IN ('pool_pod','deployment_time') OR workspace_id = $${tParams.length})`);
      }
      const { rows: te } = await this.pool.query(
        `SELECT ts, seconds, COALESCE(real_cost,0) AS real_cost, COALESCE(billed_cost,0) AS billed_cost
         FROM cost_entries WHERE ${tConds.join(" AND ")}`, tParams);
      const { real, billed } = spreadCostEntries(
        te.map((r: any) => ({ tsMs: new Date(r.ts).getTime(), seconds: Number(r.seconds),
          realCost: Number(r.real_cost), billedCost: Number(r.billed_cost) })),
        t0, opts.bucketSec, buckets.length);
      buckets.forEach((b: any, i: number) => { b.real_cost += real[i]; b.billed_cost += billed[i]; });
      totals.real_cost += real.reduce((a, b) => a + b, 0);
      totals.billed_cost += billed.reduce((a, b) => a + b, 0);
    }
    return { buckets, totals };
  }

  /** Trace-window routing row; 15s TTL, re-upserted every 5s while the SSE
   *  stream lives. Targets exactly ONE of deployment/routing (036 CHECK). */
  async upsertTraceSubscription(id: string, target: { deployment?: string; routing?: string }, callbackUrl: string) {
    await this.pool.query(
      `INSERT INTO trace_subscriptions (id, deployment, routing, callback_url, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '15 seconds')
       ON CONFLICT (id) DO UPDATE SET expires_at = now() + interval '15 seconds'`,
      [id, target.deployment ?? null, target.routing ?? null, callbackUrl]);
  }
  async deleteTraceSubscription(id: string) {
    await this.pool.query("DELETE FROM trace_subscriptions WHERE id = $1", [id]);
  }

  // ── Cost tracking & billing (spec 2026-07-14) ────────────────────────────
  async getCostSettings(): Promise<CostSettings> {
    const { rows } = await this.pool.query("SELECT data->'costs' AS costs FROM app_settings WHERE id = 'global'");
    return normalizeCostSettings(rows[0]?.costs);
  }

  async putCostSettings(costs: CostSettings) {
    await this.pool.query(
      `UPDATE app_settings SET data = jsonb_set(data, '{costs}', $1::jsonb), updated_at = now() WHERE id = 'global'`,
      [JSON.stringify(costs)]);
  }

  async getLimits(): Promise<Limits> {
    const { rows } = await this.pool.query("SELECT data->'limits' AS limits FROM app_settings WHERE id = 'global'");
    return normalizeLimits(rows[0]?.limits);
  }

  async putLimits(limits: Limits) {
    await this.pool.query(
      `UPDATE app_settings SET data = jsonb_set(data, '{limits}', $1::jsonb), updated_at = now() WHERE id = 'global'`,
      [JSON.stringify(limits)]);
  }

  // ── Maintenance settings (spec 2026-07-17) ───────────────────────────────
  async getMaintenanceSettings(): Promise<MaintenanceSettings> {
    const { rows } = await this.pool.query(
      "SELECT data->'maintenance' AS m, data->'storage'->>'gcCron' AS legacy FROM app_settings WHERE id = 'global'");
    return mergeMaintenanceSettings(defaultMaintenanceSettings(rows[0]?.legacy), rows[0]?.m);
  }
  async putMaintenanceSettings(m: MaintenanceSettings) {
    await this.pool.query(
      `UPDATE app_settings SET data = jsonb_set(data, '{maintenance}', $1::jsonb), updated_at = now() WHERE id = 'global'`,
      [JSON.stringify(m)]);
  }
  async getMaintenanceLastRun(): Promise<MaintenanceSummary | null> {
    const { rows } = await this.pool.query("SELECT data->'maintenanceLastRun' AS run FROM app_settings WHERE id = 'global'");
    return rows[0]?.run ?? null;
  }
  async setMaintenanceLastRun(s: MaintenanceSummary) {
    await this.pool.query(
      `UPDATE app_settings SET data = jsonb_set(data, '{maintenanceLastRun}', $1::jsonb), updated_at = now() WHERE id = 'global'`,
      [JSON.stringify(s)]);
  }

  // ── Maintenance retention queries (spec 2026-07-17 §3) ───────────────────
  async pruneCostEntries(cutoffMs: number): Promise<number> {
    const res = await this.pool.query(
      "DELETE FROM cost_entries WHERE ts < now() - ($1 * interval '1 millisecond')", [cutoffMs]);
    return res.rowCount ?? 0;
  }
  async pruneGatewayUsage(cutoffMs: number): Promise<number> {
    // Never prune source='session' rows: sessions.tokens_in/out are accumulated
    // one-way from them (027 trigger) and the Usage page reads them, so deleting
    // would break the totals==Usage agreement. Session usage is reclaimed when
    // its session is deleted (the session-retention leg); this only prunes
    // non-session (direct API-key) traffic.
    const res = await this.pool.query(
      `DELETE FROM gateway_usage WHERE created_at < now() - ($1 * interval '1 millisecond')
       AND source IS DISTINCT FROM 'session'`, [cutoffMs]);
    return res.rowCount ?? 0;
  }
  /** Sessions eligible for retention delete. A null cutoff disables that leg.
   *  Only active workspaces: disabled = read-only, deleting has its own
   *  drainer (workspace-delete.ts) — never race it. */
  async listExpiredSessions(idleCutoffMs: number | null, completedCutoffMs: number | null):
      Promise<{ id: string; workspace_id: string; status: string }[]> {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.workspace_id, s.status FROM sessions s
        JOIN workspaces w ON w.id = s.workspace_id AND w.status = 'active'
        WHERE ($1::bigint IS NOT NULL AND s.status IN ('idle','failed')
               AND COALESCE(s.updated_at, s.created_at) < now() - ($1 * interval '1 millisecond'))
           OR ($2::bigint IS NOT NULL AND s.status = 'completed'
               AND COALESCE(s.updated_at, s.created_at) < now() - ($2 * interval '1 millisecond'))`,
      [idleCutoffMs, completedCutoffMs]);
    return rows;
  }
  /** Files eligible for retention delete: user-facing kinds only, detached
   *  (no session_files rows AND no live producing session), last attached
   *  before the cutoff. */
  async listExpiredFiles(kind: "upload" | "output", cutoffMs: number): Promise<{ id: string; size: number }[]> {
    const { rows } = await this.pool.query(
      `SELECT f.id, f.size FROM files f
        WHERE f.kind = $1
          AND f.session_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM session_files sf WHERE sf.file_id = f.id)
          AND COALESCE(f.last_attached_at, f.created_at) < now() - ($2 * interval '1 millisecond')`,
      [kind, cutoffMs]);
    return rows;
  }

  // ── Appearance / theme (spec 2026-07-15) ─────────────────────────────────
  async getAppearance(): Promise<Appearance> {
    const { rows } = await this.pool.query("SELECT data->'appearance' AS appearance FROM app_settings WHERE id = 'global'");
    return normalizeAppearance(rows[0]?.appearance);
  }
  async putAppearance(a: Appearance) {
    await this.pool.query(
      `UPDATE app_settings SET data = jsonb_set(data, '{appearance}', $1::jsonb), updated_at = now() WHERE id = 'global'`,
      [JSON.stringify(a)]);
  }

  /** GC step 1 input: rows whose owner is gone or that nothing references.
   *  upload/output rows are user-managed — never GC'd. Grace excludes rows
   *  younger than graceMs (turn-end replacement in flight). */
  async listOrphanFileRows(graceMs: number): Promise<{ id: string }[]> {
    const { rows } = await this.pool.query(
      `SELECT f.id FROM files f
       WHERE f.created_at < now() - ($1 * interval '1 millisecond') AND (
         (f.kind = 'checkpoint' AND (
            f.session_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = f.session_id)
            OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = f.session_id AND s.checkpoint_file_id IS DISTINCT FROM f.id)))
         OR (f.kind = 'skill' AND NOT EXISTS (
            SELECT 1 FROM skills sk WHERE sk.file_id = f.id
              OR sk.files @> jsonb_build_array(jsonb_build_object('fileId', f.id))))
         OR (f.kind = 'memory' AND NOT EXISTS (
            SELECT 1 FROM memory_entries me WHERE me.file_id = f.id))
         OR (f.kind = 'wiki' AND NOT EXISTS (
            SELECT 1 FROM wiki_entries we WHERE we.file_id = f.id)))`,
      [graceMs]);
    return rows;
  }
  async objectKeyExists(key: string): Promise<boolean> {
    const { rows } = await this.pool.query("SELECT 1 FROM files WHERE object_key = $1 LIMIT 1", [key]);
    return rows.length > 0;
  }

  async listResourcePrices() {
    const { rows } = await this.pool.query("SELECT kind, ref, prices FROM resource_prices");
    return rows as { kind: string; ref: string; prices: any }[];
  }
  async getResourcePrice(kind: string, ref: string) {
    const { rows } = await this.pool.query(
      "SELECT prices FROM resource_prices WHERE kind = $1 AND ref = $2", [kind, ref]);
    return rows[0]?.prices ?? null;
  }
  async putResourcePrice(kind: string, ref: string, prices: unknown) {
    await this.pool.query(
      `INSERT INTO resource_prices (kind, ref, prices) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (kind, ref) DO UPDATE SET prices = EXCLUDED.prices, updated_at = now()`,
      [kind, ref, JSON.stringify(prices)]);
  }
  async deleteResourcePrice(kind: string, ref: string) {
    await this.pool.query("DELETE FROM resource_prices WHERE kind = $1 AND ref = $2", [kind, ref]);
  }

  /** Running sessions with their env — the sampler's turn candidates. Parked
   *  (pending-launch) sessions are status 'queued', so they never appear. */
  async listRunningSessionsForBilling() {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.workspace_id, s.turns, v.environment_id
       FROM sessions s
       JOIN agent_versions v ON v.agent_id = s.agent_id AND v.version = s.agent_version
       WHERE s.status = 'running'`);
    return rows.map((r: any) => ({ ...r, turns: Number(r.turns) }));
  }

  /** Settle lookup: same shape, by id, status-agnostic (status already flipped
   *  by the time the settle hook runs). */
  async getSessionForBilling(sessionId: string) {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.workspace_id, s.turns, v.environment_id
       FROM sessions s
       JOIN agent_versions v ON v.agent_id = s.agent_id AND v.version = s.agent_version
       WHERE s.id = $1`, [sessionId]);
    return rows[0] ? { ...rows[0], turns: Number(rows[0].turns) } : null;
  }

  /** Latest ledger ts per subject → watermark map ("dep:<name>" / "sesn:<id>").
   *  Bounded to the last day (uses the existing (kind, ts) index) — semantics
   *  are unchanged, since anything older is gap-capped to GAP_CAP_SEC anyway,
   *  and sessions with no recent entry simply fall back to the pod-start anchor. */
  async costWatermarks(): Promise<Map<string, number>> {
    const wm = new Map<string, number>();
    const { rows: deps } = await this.pool.query(
      `SELECT deployment, max(ts) AS ts FROM cost_entries
       WHERE kind IN ('pool_pod','deployment_time') AND deployment IS NOT NULL
         AND ts > now() - interval '1 day' GROUP BY 1`);
    for (const r of deps) wm.set(`dep:${r.deployment}`, new Date(r.ts).getTime());
    const { rows: sesns } = await this.pool.query(
      `SELECT session_id, max(ts) AS ts FROM cost_entries
       WHERE kind IN ('env_pod','session_time') AND session_id IS NOT NULL
         AND ts > now() - interval '1 day' GROUP BY 1`);
    for (const r of sesns) wm.set(`sesn:${r.session_id}`, new Date(r.ts).getTime());
    return wm;
  }

  async insertCostEntries(entries: import("./costs.ts").CostEntryDraft[]) {
    for (const e of entries) {
      // Explicit ts (span start + billed minutes) carries the sub-minute
      // remainder: the next watermark starts where the billed minutes ended.
      await this.pool.query(
        `INSERT INTO cost_entries (ts, kind, deployment, pool, environment_id, session_id, workspace_id,
                                   seconds, replicas, real_cost, billed_cost)
         VALUES (COALESCE(to_timestamp($1::double precision / 1000), now()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [e.tsMs ?? null, e.kind, e.deployment ?? null, e.pool ?? null, e.environmentId ?? null, e.sessionId ?? null,
         e.workspaceId ?? null, e.seconds, e.replicas ?? null, e.realCost, e.billedCost]);
    }
  }

  /** Session-time billing → chip: bump the accumulated total and wake SSE. */
  async addSessionBilledCost(sessionId: string, amount: number) {
    if (!(amount > 0)) return;
    await this.pool.query(
      "UPDATE sessions SET billed_cost = billed_cost + $2 WHERE id = $1", [sessionId, amount]);
    await this.pool.query("SELECT pg_notify('devproof_session', $1)", [sessionId]);
  }
}
