// Agents + Sessions REST API (concept §6.4, phase-3 subset).
import multipart from "@fastify/multipart";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { FileStore } from "./filestore.ts";
import type { Repo, AgentConfig } from "./repo.ts";
import { DEFAULT_WORKSPACE } from "./repo.ts";
import { validatePodConfig, type PodConfig } from "./pod-config.ts";
import { validateHosts } from "./egress.ts";
import { createSessionAction, sendMessageAction, delegateAction, delegateStatusAction, delegateCompleteAction } from "./session-actions.ts";
import { streamSessionEvents } from "./session-sse.ts";
import { credentialSecretKeys, validateCredentialBody, validateMcpServers, mcpHostnames } from "./mcp.ts";
import { validateSubagents, interruptChildSessions } from "./subagents.ts";
import { validateWikiRefs, writeWikiIds } from "./wiki-refs.ts";
import { workspaceGuard, CONSOLE_RULES } from "./workspace-guard.ts";
import { runWorkspaceDelete } from "./workspace-delete.ts";
import { normalizeCostSettings, validateCostSettings, validatePrices, type CostSettings } from "./costs.ts";
import { validateLimits, normalizeLimits } from "./limits.ts";
import { normalizeAppearance, validateAppearance } from "./appearance.ts";
import { runMaintenance, validateMaintenanceSettings, mergeMaintenanceSettings } from "./maintenance.ts";
import { objectKey, validEntryPath } from "./object-key.ts";
import { storeSkillPackage } from "./skill-upload.ts";
import { shortId } from "./id.ts";
import { seedWikiSkeleton } from "./wiki-seed.ts";
import { reframeFailureText } from "./failure-text.ts";
import { deleteSessionFully } from "./session-delete.ts";
import { localServingEnabled } from "./serving-mode.ts";

/** Starts the session workload; dev impl creates a K8s Job. */
export interface Orchestrator {
  startSession(session: {
    id: string;
    prompt: string;
    workspace?: string;
    /** The agent's environment, resolved fresh per turn (required from Task 6). */
    environment: { id: string; pod?: import("./pod-config.ts").PodConfig | null; allowPackageManagers?: boolean };
    config: { routing: string; system_prompt: string; tools: unknown; max_turns: number; turn_deadline_sec?: number | null };
    /** Served context window of a local model (tokens) — renders the runner's
     *  CLI auto-compact env so long sessions compact instead of overflowing. */
    contextWindow?: number | null;
    /** mcp_servers with credential placeholders injected (renderMcpServers) —
     *  headers reference ${DEVPROOF_CRED_*} env vars, never values. */
    mcpServers?: Record<string, unknown>;
    /** Resolved delegation targets (spec 2026-07-17); [] for child sessions. */
    subagents?: { name: string; agentId: string; instructions: string }[];
    attachments?: { id: string; name: string }[];
    /** Output-role files from earlier turns (spec 2026-07-17 delegation wave):
     *  staged read-only so a follow-up turn's pod can see prior deliverables
     *  instead of regenerating them. [] on turn 0 — nothing prior exists. */
    priorOutputs?: { id: string; name: string }[];
    skills?: { name: string; files: { path: string; fileId: string }[] }[];
    memory?: { path: string; fileId: string }[];
    /** Attached memory store id — renders DEVPROOF_MEMORY_STORE so the runner
     *  only attempts memory write-back when a store exists (/mnt/memory is
     *  always writable; live bug sesn_2i8o557ubzft). */
    memoryStore?: string | null;
    /** LLM wikis mounted at /mnt/wiki/<name> (spec 2026-07-18). Read wikis are
     *  staged read-only; the single write wiki is synced back. The structure
     *  spec is a hardcoded runner-side convention (not per-wiki config). */
    wikis?: { id: string; name: string; mode: "read" | "write";
              entries: { path: string; fileId: string }[] }[];
    resume?: { turn: number; sdkSessionId: string | null; checkpointFileId: string | null };
  }): Promise<void>;
  /** Whether the turn's Job still has a live pod ("active"), has ended
   *  ("finished"), or is gone ("missing") — input for the zombie reconciler. */
  sessionJobState(sessionId: string, turn: number): Promise<"active" | "finished" | "missing">;
  /** Job state + pod start for the cost sampler (spec §4). */
  sessionJobInfo(sessionId: string, turn: number): Promise<{ state: "active" | "finished" | "missing"; startedAt: Date | null }>;
  /** Idempotently create egress proxy + NetworkPolicy for an environment. */
  ensureEnvironmentPolicy(env: { id: string; allowedHosts?: string[]; allowPackageManagers?: boolean; mcpHosts?: string[] }): Promise<void>;
  /** Create/replace the K8s Secret backing a vault. */
  writeVaultSecret(vaultId: string, secrets: Record<string, string>): Promise<void>;
  /** Add/update a single credential key in a vault's Secret. */
  putVaultSecretKey(vaultId: string, key: string, value: string): Promise<void>;
  /** Remove a single credential key from a vault's Secret. */
  removeVaultSecretKey(vaultId: string, key: string): Promise<void>;
  /** Delete the K8s Secret backing a vault. */
  deleteVaultSecret(vaultId: string): Promise<void>;
  /** Tear down an environment's egress proxy + NetworkPolicy. */
  deleteEnvironmentResources(environmentId: string): Promise<void>;
  /** Stop/interrupt a session's running Job(s). */
  stopSession(sessionId: string): Promise<void>;
  /** Delete a session's k8s resources beyond Jobs (the durable /work PVC). */
  deleteSessionResources(sessionId: string): Promise<void>;
  /** Cluster StorageClasses for the environment PVC-disk dropdown. */
  listStorageClasses(): Promise<{ name: string; provisioner: string; isDefault: boolean }[]>;
  /** Cluster node labels + taints for the environment scheduling pickers. */
  listNodeScheduling(): Promise<import("./node-scheduling.ts").NodeScheduling>;
}

/** At-least-once webhook delivery: session terminal states, 3 attempts. */
async function deliverWebhooks(repo: Repo, sessionId: string, status: string) {
  const eventName = status === "failed" ? "session.failed" : status === "idle" ? "session.idle" : "session.completed";
  const hooks = (await repo.listWebhooks()).filter((w: any) =>
    (w.events as string[]).includes(eventName));
  if (!hooks.length) return;
  const session = await repo.getSession(sessionId);
  const payload = JSON.stringify({ event: eventName, session });
  for (const hook of hooks) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(hook.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) break;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

/** Cost UI visibility is per ledger (spec 2026-07-15): real ⇐ costs.enabled,
 *  billed ⇐ costs.billing.enabled. Null only when BOTH are off. The polling
 *  surfaces (dashboard, deployment Stats) never read /v1/settings, so this
 *  object is the sole carrier of visibility for every cost tile and chart. */
const costsMeta = (s: CostSettings) =>
  s.enabled || s.billing.enabled
    ? { currency: s.currency, real: s.enabled, billed: s.billing.enabled }
    : null;

export async function registerAgentRoutes(
  app: FastifyInstance, repo: Repo, orchestrator: Orchestrator, files: FileStore,
  notify?: { subscribe(sessionId: string, fn: () => void): () => void },
  opts?: { modelPhase?: (model: string) => Promise<import("./launch-gate.ts").ModelPhase>;
           mcpRegistry?: import("./mcp.ts").McpRegistryEntry[];
           settleSession?: (id: string) => Promise<void>;
           /** Called when a session frees the writer slot (terminal/interrupt) —
            *  releases the next parked writer session (spec 2026-07-18). */
           releaseWriterSlot?: (sessionId: string) => void;
           wakeModel?: (model: string) => Promise<void>;
           maintenanceDeps?: import("./maintenance.ts").MaintenanceDeps },
) {
  const sessionDeps = { repo, orchestrator, modelPhase: opts?.modelPhase, wakeModel: opts?.wakeModel };
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  app.addContentTypeParser("application/octet-stream",
    { parseAs: "buffer", bodyLimit: 200 * 1024 * 1024 },
    (_req, body, done) => done(null, body));

  // Resolve the caller's workspace (header, default). No auth in phase 1 —
  // this is attribution + isolation scoping, not a security boundary yet.
  const ws = (req: any): string => (req.headers["x-devproof-workspace"] as string) || "wrkspc_default";
  // Disabled/deleting workspaces are read-only (spec 2026-07-13): writes to
  // workspace-scoped routes 409; interrupt + runner callbacks stay open
  // (CONSOLE_RULES). Registered before routes — hooks don't apply retroactively.
  app.addHook("preHandler", workspaceGuard(repo, ws, CONSOLE_RULES));
  // Pagination: fixed 100/page; offset from ?offset (or ?page).
  const pg = (req: any): { limit: number; offset: number } => {
    const q = (req.query ?? {}) as { offset?: string; page?: string; limit?: string };
    const offset = q.page ? (Math.max(1, Number(q.page)) - 1) * 100 : Math.max(0, Number(q.offset) || 0);
    // Dropdown consumers pass ?limit= (capped at 1000); tables keep the 100/page default.
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 100));
    return { limit, offset };
  };

  app.get("/v1/workspaces", async (req) => ({
    workspaces: await repo.listWorkspaces((req.query as any)?.include === "deleted") }));
  app.post("/v1/workspaces", async (req, reply) => {
    const b = req.body as { name: string };
    if (!b?.name) return reply.code(400).send({ error: "name required" });
    return reply.code(201).send(await repo.createWorkspace(b.name));
  });

  app.patch("/v1/workspaces/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name?.trim()) return reply.code(400).send({ error: "name required" });
    if (id === DEFAULT_WORKSPACE) return reply.code(400).send({ error: "the default workspace cannot be renamed" });
    const r = await repo.renameWorkspace(id, name.trim());
    if (r === "conflict") return reply.code(409).send({ error: "a workspace with that name already exists" });
    if (r === "notfound") return reply.code(404).send({ error: "workspace not found" });
    return { ok: true };
  });

  app.post("/v1/workspaces/:id/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status } = (req.body ?? {}) as { status?: string };
    if (!["active", "disabled"].includes(status ?? "")) return reply.code(400).send({ error: "bad status" });
    if (id === DEFAULT_WORKSPACE) return reply.code(400).send({ error: "the default workspace cannot be disabled" });
    const w = await repo.getWorkspace(id);
    if (!w || w.status === "deleted") return reply.code(404).send({ error: "workspace not found" });
    if (w.status === "deleting") return reply.code(409).send({ error: "workspace is being deleted" });
    await repo.setWorkspaceStatus(id, status!);
    return { ok: true };
  });

  app.get("/v1/workspaces/:id/resources", async (req, reply) => {
    const w = await repo.getWorkspace((req.params as any).id);
    if (!w || w.status === "deleted") return reply.code(404).send({ error: "workspace not found" });
    return { counts: await repo.workspaceResourceCounts(w.id) };
  });

  app.delete("/v1/workspaces/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === DEFAULT_WORKSPACE) return reply.code(400).send({ error: "the default workspace cannot be deleted" });
    const w = await repo.getWorkspace(id);
    if (!w || w.status === "deleted") return reply.code(404).send({ error: "workspace not found" });
    // beginWorkspaceDelete's WHERE clause is the atomic decision point (TOCTOU
    // guard): two concurrent DELETEs both read status !== 'deleting' above,
    // but only one UPDATE actually flips the row — only that caller kicks the runner.
    const began = await repo.beginWorkspaceDelete(id, await repo.workspaceResourceCounts(id));
    if (began) {
      // Fire-and-forget: 202 now, progress via GET /deletion; a crash mid-
      // drain is resumed by the boot sweep (main.ts).
      void runWorkspaceDelete(repo, orchestrator, files, id)
        .catch((err) => console.warn(`workspace delete ${id} failed (boot sweep resumes):`, err));
    }
    return reply.code(202).send({ ok: true, status: "deleting" });
  });

  app.get("/v1/workspaces/:id/deletion", async (req, reply) => {
    const w = await repo.getWorkspace((req.params as any).id);
    if (!w) return reply.code(404).send({ error: "workspace not found" });
    const totals: Record<string, number> = w.delete_totals ?? {};
    const remaining = w.status === "deleted" ? {} : await repo.workspaceResourceCounts(w.id);
    const resources = Object.fromEntries(Object.entries(totals).map(([k, total]) => {
      const rem = (remaining as Record<string, number>)[k] ?? 0;
      return [k, { total, remaining: rem, state: rem === 0 ? "done" : "draining" }];
    }));
    return { status: w.status, resources };
  });

  app.post("/v1/files", async (req, reply) => {
    const part = await (req as any).file();
    if (!part) return reply.code(400).send({ error: "multipart file field required" });
    const content = await part.toBuffer();
    const id = `file_${shortId()}`;
    const key = objectKey({ kind: "upload", workspaceId: ws(req), fileId: id });
    await files.put(content, key);
    const record = await repo.createFileRecord({
      id, name: part.filename ?? id, size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      objectKey: key, workspaceId: ws(req),
    });
    return reply.code(201).send(record);
  });

  // Raw upload for machine callers (runner checkpoints): body = bytes.
  app.post("/v1/files/raw", async (req, reply) => {
    const { name, session, kind } = req.query as { name?: string; session?: string; kind?: string };
    const content = req.body as Buffer;
    if (!name || !Buffer.isBuffer(content)) return reply.code(400).send({ error: "name query + binary body required" });
    // Runner callbacks carry no workspace header — attribute to the SESSION's
    // workspace (unscoped lookup) so checkpoints don't leak into wrkspc_default.
    const sess = session ? await repo.getSession(session) : null;
    // Same default createFileRecord applies — non-session raw uploads keep the
    // prior default-workspace attribution.
    const workspaceId = sess?.workspace_id ?? DEFAULT_WORKSPACE;
    const id = `file_${shortId()}`;
    let key: string;
    if (kind === "checkpoint" && sess) {
      key = objectKey({ kind: "checkpoint", workspaceId, sessionId: sess.id, fileId: id });
    } else if (kind === "memory") {
      // No store ⇒ reject loudly instead of silently storing an orphan under
      // an upload-style key (the follow-up /memory post 400s anyway).
      if (!sess?.memory_store_id) return reply.code(400).send({ error: "session has no memory store" });
      if (!validEntryPath(name)) return reply.code(400).send({ error: "bad memory path" });
      key = objectKey({ kind: "memory", workspaceId, storeId: sess.memory_store_id, path: name });
    } else if (kind === "wiki" && sess) {
      // Wiki write-back: the session's agent must be this wiki's writer. The
      // target wiki id is the version's single write ref (validated on save).
      if (!validEntryPath(name)) return reply.code(400).send({ error: "bad wiki path" });
      const v = await repo.getAgentVersion(sess.agent_id, sess.agent_version);
      const writeRef = ((v?.wiki_refs ?? []) as any[]).find((r) => r.mode === "write");
      if (!writeRef) return reply.code(403).send({ error: "session has no write wiki" });
      key = objectKey({ kind: "wiki", workspaceId, wikiId: writeRef.wikiId, path: name });
    } else {
      key = objectKey({ kind: kind === "output" ? "output" : "upload", workspaceId, fileId: id });
    }
    await files.put(content, key);
    const record = await repo.createFileRecord({
      id, name, size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      objectKey: key, sessionId: sess?.id, kind: kind ?? "upload", workspaceId: sess?.workspace_id,
    });
    return reply.code(201).send(record);
  });

  app.get("/v1/files", async (req) => {
    const q = req.query as any;
    return repo.listAllFiles(ws(req), { kind: q.kind, limit: Number(q.limit ?? 25), offset: Number(q.offset ?? 0) });
  });

  app.get("/v1/files/:id", async (req, reply) => {
    const record = await repo.getFileRecord((req.params as any).id);
    if (!record) return reply.code(404).send({ error: "file not found" });
    return record;
  });

  // Raster images get a real mime + inline disposition so the console can
  // embed them (<img>, lightbox). Everything else — including SVG, which can
  // carry scripts — stays an octet-stream download.
  const IMAGE_MIME: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  };
  app.get("/v1/files/:id/content", async (req, reply) => {
    const record = await repo.getFileRecord((req.params as any).id);
    if (!record) return reply.code(404).send({ error: "file not found" });
    const mime = IMAGE_MIME[record.name.split(".").pop()?.toLowerCase() ?? ""];
    reply.header("Content-Disposition", `${mime ? "inline" : "attachment"}; filename="${record.name}"`);
    return reply.type(mime ?? "application/octet-stream").send(await files.get(record.object_key));
  });

  app.delete("/v1/files/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { deleted, objectKey: key } = await repo.deleteFile(ws(req), id);
    if (!deleted) return reply.code(404).send({ error: "file not found" });
    if (key) { try { await files.del(key); } catch { /* best effort */ } }
    return reply.code(204).send();
  });

  app.post("/v1/agents", async (req, reply) => {
    const b = req.body as { name: string } & AgentConfig;
    if (!b?.name || !b?.routing) return reply.code(400).send({ error: "name and routing required" });
    if (!(await repo.getRoutingByName(b.routing))) return reply.code(400).send({ error: "routing must reference an existing routing" });
    if (!b.environmentId) return reply.code(400).send({ error: "environmentId required" });
    const env = await repo.getEnvironment(b.environmentId);
    if (!env) return reply.code(400).send({ error: "unknown environment" });
    const missingSkills = await repo.missingSkillIds(ws(req), b.skillIds ?? []);
    if (missingSkills.length) return reply.code(400).send({ error: `unknown skill ids: ${missingSkills.join(", ")}` });
    const mcpErr = validateMcpServers(b.mcpServers);
    if (mcpErr) return reply.code(400).send({ error: mcpErr });
    const subErr = await validateSubagents(repo, ws(req), null, b.subagents);
    if (subErr) return reply.code(400).send({ error: subErr });
    // Hold the per-wiki writer lock across the exclusivity check + insert (B4).
    const wikiLock = await repo.acquireWikiWriteLock(writeWikiIds(b.wikiRefs));
    let agent;
    try {
      const wikiErr = await validateWikiRefs(repo, ws(req), null, b.wikiRefs);
      if (wikiErr) return reply.code(wikiErr.code).send({ error: wikiErr.error });
      agent = await repo.createAgent(ws(req), b.name, b);
    } finally {
      await wikiLock.release();
    }
    // New MCP servers may need egress holes in the env's Squid allowlist.
    if (Object.keys(b.mcpServers ?? {}).length) {
      await syncEnvPolicy(env);
    }
    return reply.code(201).send(agent);
  });

  // Environment Squid allowlist = allowed_hosts (+ MCP server hosts across the
  // latest versions of every agent bound to the env, when the toggle is on).
  // Called on env create/update AND agent create/version-save (spec 2026-07-13).
  const syncEnvPolicy = async (env: any) => {
    const mcpHosts = env.allow_mcp_servers
      ? mcpHostnames(await repo.mcpServersForEnvironment(env.id)) : [];
    await orchestrator.ensureEnvironmentPolicy({
      id: env.id, allowedHosts: env.allowed_hosts ?? [],
      allowPackageManagers: env.allow_package_managers ?? false, mcpHosts,
    });
  };

  app.post("/v1/environments", async (req, reply) => {
    const b = req.body as { name: string; allowPackageManagers?: boolean; allowedHosts?: string[]; pod?: unknown; allowMcpServers?: boolean };
    if (!b?.name) return reply.code(400).send({ error: "name required" });
    const { maxWorkGb } = await repo.getLimits();
    const podErr = validatePodConfig(b.pod, { maxWorkGb });
    if (podErr) return reply.code(400).send({ error: podErr });
    const hostErr = validateHosts(b.allowedHosts);
    if (hostErr) return reply.code(400).send({ error: hostErr });
    const env = await repo.createEnvironment(ws(req), b.name, b.allowPackageManagers ?? false,
      b.allowedHosts ?? [], (b.pod as PodConfig) ?? {}, b.allowMcpServers ?? false);
    await orchestrator.ensureEnvironmentPolicy(env); // fresh env: no agents yet → no mcpHosts
    return reply.code(201).send(env);
  });

  app.patch("/v1/environments/:id", async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; allowPackageManagers?: boolean; allowedHosts?: string[]; pod?: unknown; allowMcpServers?: boolean };
    if (b.pod !== undefined) {
      const { maxWorkGb } = await repo.getLimits();
      const podErr = validatePodConfig(b.pod, { maxWorkGb });
      if (podErr) return reply.code(400).send({ error: podErr });
    }
    const hostErr = validateHosts(b.allowedHosts);
    if (hostErr) return reply.code(400).send({ error: hostErr });
    const row = await repo.updateEnvironment(ws(req), (req.params as any).id, { ...b, pod: b.pod as PodConfig | undefined });
    if (!row) return reply.code(404).send({ error: "environment not found" });
    // Reload the Squid allowlist for the (possibly running) proxy.
    await syncEnvPolicy(row);
    return row;
  });

  app.get("/v1/environments", async (req) => {
    const { limit, offset } = pg(req);
    const { rows, count } = await repo.listEnvironments(ws(req), limit, offset);
    return { environments: rows, count, offset };
  });

  app.delete("/v1/environments/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    // Environments are mandatory for agents (spec 2026-07-12): deleting a
    // referenced one would SET NULL agent_versions.environment_id and strand
    // every referencing agent (and pin old sessions to an unresumable config).
    if (await repo.environmentInUse(id)) {
      return reply.code(409).send({ error: "environment is in use by one or more agents" });
    }
    await orchestrator.deleteEnvironmentResources(id);
    await repo.deleteEnvironment(ws(req), id);
    await repo.deleteResourcePrice("environment", id).catch(() => {}); // price row is advisory — never fail the delete
    return reply.code(204).send();
  });

  // Cluster storage classes for the environment disk dropdown (spec 2026-07-12).
  app.get("/v1/storage-classes", async () => ({ storageClasses: await orchestrator.listStorageClasses() }));

  // Cluster node labels + taints for the environment scheduling pickers (spec 2026-07-14).
  app.get("/v1/node-scheduling", async () => await orchestrator.listNodeScheduling());

  // Bundled MCP server registry for the console picker (spec 2026-07-13).
  app.get("/v1/mcp-registry", async () => ({ servers: opts?.mcpRegistry ?? [] }));

  // ── Deployment realtime stats (spec 2026-07-10 deployment monitoring) ──
  // Whole-deployment monitoring: buckets count all workspaces' traffic.
  const STAT_WINDOWS: Record<string, { windowSec: number; bucketSec: number }> = {
    "1m": { windowSec: 60, bucketSec: 2 }, "5m": { windowSec: 300, bucketSec: 10 },
    "30m": { windowSec: 1800, bucketSec: 30 }, "1h": { windowSec: 3600, bucketSec: 60 },
    "3h": { windowSec: 10800, bucketSec: 180 }, "6h": { windowSec: 21600, bucketSec: 360 },
    "12h": { windowSec: 43200, bucketSec: 720 }, "24h": { windowSec: 86400, bucketSec: 1440 },
    "48h": { windowSec: 172800, bucketSec: 2880 },
  };
  app.get("/v1/deployments/:name/stats", async (req, reply) => {
    const q = req.query as { window?: string; api_key?: string; agent?: string };
    const win = STAT_WINDOWS[q.window ?? "5m"];
    if (!win) return reply.code(400).send({ error: `window must be one of ${Object.keys(STAT_WINDOWS).join("|")}` });
    const opts: any = { ...win };
    if (q.api_key === "__internal__") opts.sessionOnly = true;
    else if (q.api_key) opts.apiKeyId = q.api_key;
    if (q.agent) opts.agentId = q.agent;
    // Cost columns ride along when tracking is on; time-based entries are
    // deployment-wide and not key/agent-attributable — filtered views show
    // token costs only (spec §5).
    const settings = await repo.getCostSettings();
    const tokensOnly = !!(opts.apiKeyId || opts.agentId || opts.sessionOnly);
    if (settings.enabled || settings.billing.enabled) opts.costs = { includeTime: !tokensOnly };
    const stats = await repo.deploymentStats((req.params as any).name, opts);
    const meta = costsMeta(settings);
    return { window: q.window ?? "5m", bucketSeconds: win.bucketSec, ...stats,
      costs: meta && { ...meta, tokensOnly } };
  });

  // Routing stats (spec 2026-07-16): token costs only — time costs are not
  // routing-attributable. Extra: per-target breakdown + reject count.
  app.get("/v1/routings/:name/stats", async (req, reply) => {
    const q = req.query as { window?: string; api_key?: string; agent?: string };
    const win = STAT_WINDOWS[q.window ?? "5m"];
    if (!win) return reply.code(400).send({ error: `window must be one of ${Object.keys(STAT_WINDOWS).join("|")}` });
    const name = (req.params as any).name;
    const opts: any = { ...win, routingName: name };
    if (q.api_key === "__internal__") opts.sessionOnly = true;
    else if (q.api_key) opts.apiKeyId = q.api_key;
    if (q.agent) opts.agentId = q.agent;
    const settings = await repo.getCostSettings();
    const [stats, targets, rejects, breakdown] = await Promise.all([
      repo.deploymentStats(null, opts),
      repo.routingTargetBreakdown(name, win.windowSec),
      repo.routingRejectCount(name, win.windowSec),
      repo.routingBreakdownBuckets(name, {
        windowSec: win.windowSec, bucketSec: win.bucketSec,
        apiKeyId: opts.apiKeyId, agentId: opts.agentId, sessionOnly: opts.sessionOnly }),
    ]);
    const meta = costsMeta(settings);
    return { window: q.window ?? "5m", bucketSeconds: win.bucketSec, ...stats,
      targets, rejects, ...breakdown, costs: meta && { ...meta, tokensOnly: true } };
  });

  // Cross-deployment realtime stats for the dashboard (2026-07-14): the
  // deployment-Stats surface, aggregated — same windows, same 3s polling.
  app.get("/v1/usage/realtime", async (req, reply) => {
    const q = req.query as { window?: string; api_key?: string; deployment?: string; workspaces?: string };
    const win = STAT_WINDOWS[q.window ?? "5m"];
    if (!win) return reply.code(400).send({ error: `window must be one of ${Object.keys(STAT_WINDOWS).join("|")}` });
    const opts: any = { ...win };
    if (q.api_key === "__internal__") opts.sessionOnly = true;
    else if (q.api_key) opts.apiKeyId = q.api_key;
    if (q.workspaces !== "all") opts.workspaceId = ws(req);
    const settings = await repo.getCostSettings();
    const tokensOnly = !!(opts.apiKeyId || opts.sessionOnly);
    if (settings.enabled || settings.billing.enabled) opts.costs = { includeTime: !tokensOnly };
    const stats = await repo.deploymentStats(q.deployment || null, opts);
    const meta = costsMeta(settings);
    return { window: q.window ?? "5m", bucketSeconds: win.bucketSec, ...stats,
      costs: meta && { ...meta, tokensOnly } };
  });

  // A skill is a package: a single SKILL.md, or a Claude Code skill ZIP
  // (SKILL.md + scripts/resources). Both become a file manifest.
  app.post("/v1/skills", async (req, reply) => {
    const part = await (req as any).file();
    const fname: string = part?.filename ?? "";
    const name = (req.query as any).name ?? fname.replace(/\.(md|zip)$/i, "");
    if (!part || !name) return reply.code(400).send({ error: "multipart file + name required" });
    const result = await storeSkillPackage({ repo, files }, ws(req), name, fname, await part.toBuffer());
    if ("error" in result) return reply.code(400).send({ error: result.error });
    return reply.code(201).send(result.skill);
  });

  app.get("/v1/skills", async (req) => {
    const { limit, offset } = pg(req);
    return { skills: await repo.listSkills(ws(req), undefined, limit, offset), count: await repo.countSkills(ws(req)), offset };
  });

  app.get("/v1/skills/:id", async (req, reply) => {
    const skill = await repo.getSkill(ws(req), (req.params as any).id);
    if (!skill) return reply.code(404).send({ error: "not found" });
    return { skill };
  });

  app.delete("/v1/skills/:id", async (req, reply) => {
    // Sessions resolve skills by id at launch: deleting a referenced skill
    // would silently launch skill-less sessions (mirrors the environment 409).
    if (await repo.skillInUse((req.params as any).id)) {
      return reply.code(409).send({ error: "skill is in use by one or more agents" });
    }
    for (const fid of await repo.deleteSkill(ws(req), (req.params as any).id)) {
      const key = await repo.deleteFileRecordById(fid).catch(() => null);
      if (key) await Promise.resolve(files.del(key)).catch(() => {});
    }
    return reply.code(204).send();
  });

  // Vaults: named secret bundles backed by K8s Secrets, injected into
  // session pods as env vars; values are write-only through this API.
  app.post("/v1/vaults", async (req, reply) => {
    const b = req.body as { name: string; secrets?: Record<string, string> };
    if (!b?.name) return reply.code(400).send({ error: "name required" });
    const vault = await repo.createVault(ws(req), b.name);
    await orchestrator.writeVaultSecret(vault.id, b.secrets ?? {});
    for (const key of Object.keys(b.secrets ?? {})) await repo.addVaultCredential(vault.id, key);
    return reply.code(201).send(vault);
  });

  app.get("/v1/vaults/:id", async (req, reply) => {
    const vault = await repo.getVault(ws(req), (req.params as any).id);
    if (!vault) return reply.code(404).send({ error: "not found" });
    return { vault, credentials: await repo.listVaultCredentials(vault.id) };
  });
  app.post("/v1/vaults/:id/credentials", async (req, reply) => {
    const { id } = req.params as { id: string };
    const vault = await repo.getVault(ws(req), id);
    if (!vault) return reply.code(404).send({ error: "not found" });
    const cred = validateCredentialBody(req.body);
    if ("error" in cred) return reply.code(400).send({ error: cred.error });
    // Same name+type+server = rotate; a name reused for anything else is a conflict.
    const existing = await repo.getVaultCredential(id, cred.name);
    if (existing && (existing.type !== cred.type ||
        (existing.mcp_server_url ?? null) !== (cred.mcpServerUrl ?? null))) {
      return reply.code(409).send({ error: `credential "${cred.name}" already exists with a different type or server` });
    }
    // Distinct names must not derive overlapping Secret keys (e.g. an
    // env-var literally named DEVPROOF_CRED_X_TOKEN vs. a bearer credential
    // named X). Compare full derived key sets, not just this call's payload.
    const mine = new Set(credentialSecretKeys(cred.name, cred.type));
    const clash = (await repo.listVaultCredentials(id)).find((c: any) =>
      c.name !== cred.name && credentialSecretKeys(c.name, c.type).some((k) => mine.has(k)));
    if (clash) {
      return reply.code(409).send({ error: `credential "${cred.name}" would collide with "${clash.name}" (same derived secret key)` });
    }
    for (const [key, value] of Object.entries(cred.secrets)) {
      await orchestrator.putVaultSecretKey(id, key, value);
    }
    await repo.addVaultCredential(id, cred.name, cred.type, cred.mcpServerUrl ?? null, cred.mcpServerName ?? null);
    return reply.code(201).send({ name: cred.name, type: cred.type });
  });
  app.delete("/v1/vaults/:id/credentials/:name", async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const vault = await repo.getVault(ws(req), id);
    if (!vault) return reply.code(404).send({ error: "not found" });
    const existing = await repo.getVaultCredential(id, name);
    // Remove every key the credential may own (unwritten keys no-op).
    for (const key of credentialSecretKeys(name, existing?.type ?? "environment_variable")) {
      await orchestrator.removeVaultSecretKey(id, key);
    }
    await repo.removeVaultCredential(id, name);
    return reply.code(204).send();
  });

  app.get("/v1/vaults", async (req) => {
    const { limit, offset } = pg(req);
    const { rows, count } = await repo.listVaults(ws(req), limit, offset);
    return { vaults: rows, count, offset };
  });

  app.delete("/v1/vaults/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await orchestrator.deleteVaultSecret(id);
    await repo.deleteVault(ws(req), id);
    return reply.code(204).send();
  });

  app.post("/v1/memory-stores", async (req, reply) => {
    const b = req.body as { name: string };
    if (!b?.name) return reply.code(400).send({ error: "name required" });
    return reply.code(201).send(await repo.createMemoryStore(ws(req), b.name));
  });

  app.get("/v1/memory-stores", async (req) => {
    const { limit, offset } = pg(req);
    const { rows, count } = await repo.listMemoryStores(ws(req), limit, offset);
    return { stores: rows, count, offset };
  });

  app.delete("/v1/memory-stores/:id", async (req, reply) => {
    for (const fid of await repo.deleteMemoryStore(ws(req), (req.params as any).id)) {
      const key = await repo.deleteFileRecordById(fid).catch(() => null);
      if (key) await Promise.resolve(files.del(key)).catch(() => {});
    }
    return reply.code(204).send();
  });

  app.delete("/v1/memory-stores/:id/entries", async (req, reply) => {
    const storeId = (req.params as any).id;
    const { path } = req.query as { path?: string };
    const store = await repo.getMemoryStore(storeId, ws(req));
    if (!store || !path) return reply.code(400).send({ error: "store + path required" });
    const entries = await repo.getMemoryEntries(storeId);
    const victim = entries.find((e: any) => e.path === path)?.file_id;
    await repo.deleteMemoryEntry(storeId, path);
    if (victim) {
      (async () => {
        const key = await repo.deleteFileRecordById(victim);
        if (key) await files.del(key);
      })().catch(() => {});
    }
    return reply.code(204).send();
  });

  // Add a memory entry directly from the console (multipart file → entry).
  app.post("/v1/memory-stores/:id/entries", async (req, reply) => {
    const storeId = (req.params as any).id;
    const store = await repo.getMemoryStore(storeId, ws(req));
    if (!store) return reply.code(404).send({ error: "memory store not found" });
    const part = await (req as any).file();
    const path = ((req.query as any).path ?? part?.filename ?? "").replace(/^\/+/, "");
    if (!part || !path) return reply.code(400).send({ error: "multipart file + path required" });
    if (!validEntryPath(path)) return reply.code(400).send({ error: "bad entry path" });
    const content = await part.toBuffer();
    const id = `file_${shortId()}`;
    const key = objectKey({ kind: "memory", workspaceId: ws(req), storeId, path });
    await files.put(content, key);
    await repo.createFileRecord({
      id, name: `mem/${path}`, size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      objectKey: key, kind: "memory", workspaceId: ws(req),
    });
    const orphaned = await repo.upsertMemoryEntries(storeId, [{ path, fileId: id }]);
    for (const fid of orphaned) {
      const okey = await repo.deleteFileRecordById(fid).catch(() => null);
      if (okey) await Promise.resolve(files.del(okey)).catch(() => {});
    }
    return reply.code(201).send({ path, fileId: id });
  });

  app.get("/v1/memory-stores/:id", async (req, reply) => {
    const store = await repo.getMemoryStore((req.params as any).id, ws(req));
    if (!store) return reply.code(404).send({ error: "memory store not found" });
    return { store };
  });

  app.patch("/v1/memory-stores/:id", async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string };
    const store = await repo.updateMemoryStore(ws(req), (req.params as any).id, b);
    if (!store) return reply.code(404).send({ error: "memory store not found" });
    return { store };
  });

  app.get("/v1/memory-stores/:id/tree", async (req) => ({
    entries: await repo.getMemoryEntries((req.params as any).id),
  }));

  app.get("/v1/memory-stores/:id/content", async (req, reply) => {
    const { path } = req.query as { path?: string };
    if (!path) return reply.code(400).send({ error: "path query required" });
    const entry = await repo.getMemoryEntry((req.params as any).id, path);
    if (!entry) return reply.code(404).send({ error: "no such memory entry" });
    const rec = await repo.getFileRecord(entry.file_id);
    if (!rec) return reply.code(404).send({ error: "memory content missing" });
    return reply.type("text/plain").send(await files.get(rec.object_key));
  });

  // Accept only file ids owned by the session's workspace. These runner
  // callbacks are unauthenticated, so a foreign file id must not be persisted
  // into a store/wiki or staged into the session.
  const ownedFiles = async (workspaceId: string, ids: string[]): Promise<Set<string>> =>
    new Set((await repo.listFileRecords(ids ?? []))
      .filter((f: any) => f.workspace_id === workspaceId).map((f: any) => f.id));

  // Runner callback: diff of memory files changed/removed during the turn.
  app.post("/v1/sessions/:id/memory", async (req, reply) => {
    const session = await repo.getSession((req.params as any).id);
    if (!session?.memory_store_id) return reply.code(400).send({ error: "session has no memory store" });
    const b = req.body as { entries: { path: string; fileId: string }[]; deletes?: string[] };
    const owned = await ownedFiles(session.workspace_id, (b?.entries ?? []).map((e) => e.fileId));
    const entries = (b?.entries ?? []).filter((e) => owned.has(e.fileId));
    const orphaned = await repo.upsertMemoryEntries(session.memory_store_id, entries, b?.deletes ?? []);
    for (const fid of orphaned) {
      const key = await repo.deleteFileRecordById(fid).catch(() => null);
      if (key) await Promise.resolve(files.del(key)).catch(() => {});
    }
    return { ok: true };
  });

  // ── LLM wikis (spec 2026-07-18) ──────────────────────────────────────────
  app.post("/v1/wikis", async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; description?: string };
    if (!b?.name) return reply.code(400).send({ error: "name required" });
    const wiki = await repo.createWiki(ws(req), b.name, b.description ?? "");
    await seedWikiSkeleton(repo, files, ws(req), wiki.id, wiki.name, b.description ?? "");
    return reply.code(201).send(wiki);
  });

  app.get("/v1/wikis", async (req) => {
    const { limit, offset } = pg(req);
    const { rows, count } = await repo.listWikis(ws(req), limit, offset);
    return { wikis: rows, count, offset };
  });

  app.get("/v1/wikis/:id", async (req, reply) => {
    const wiki = await repo.getWiki((req.params as any).id, ws(req));
    if (!wiki) return reply.code(404).send({ error: "wiki not found" });
    return { wiki };
  });

  app.patch("/v1/wikis/:id", async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; description?: string };
    const wiki = await repo.updateWiki(ws(req), (req.params as any).id, b);
    if (!wiki) return reply.code(404).send({ error: "wiki not found" });
    return { wiki };
  });

  app.delete("/v1/wikis/:id", async (req, reply) => {
    const id = (req.params as any).id;
    if (!(await repo.getWiki(id, ws(req)))) return reply.code(404).send({ error: "wiki not found" });
    if (await repo.wikiInUse(id)) return reply.code(409).send({ error: "wiki is attached to one or more agents" });
    for (const fid of await repo.deleteWiki(ws(req), id)) {
      const key = await repo.deleteFileRecordById(fid).catch(() => null);
      if (key) await Promise.resolve(files.del(key)).catch(() => {});
    }
    return reply.code(204).send();
  });

  app.get("/v1/wikis/:id/tree", async (req) => ({
    entries: await repo.getWikiEntries((req.params as any).id),
  }));

  app.get("/v1/wikis/:id/content", async (req, reply) => {
    const { path } = req.query as { path?: string };
    if (!path) return reply.code(400).send({ error: "path query required" });
    const entry = await repo.getWikiEntry((req.params as any).id, path);
    if (!entry) return reply.code(404).send({ error: "no such wiki entry" });
    const rec = await repo.getFileRecord(entry.file_id);
    if (!rec) return reply.code(404).send({ error: "wiki content missing" });
    return reply.type("text/plain").send(await files.get(rec.object_key));
  });

  app.post("/v1/wikis/:id/entries", async (req, reply) => {
    const wikiId = (req.params as any).id;
    if (!(await repo.getWiki(wikiId, ws(req)))) return reply.code(404).send({ error: "wiki not found" });
    const part = await (req as any).file();
    const path = ((req.query as any).path ?? part?.filename ?? "").replace(/^\/+/, "");
    if (!part || !path) return reply.code(400).send({ error: "multipart file + path required" });
    if (!validEntryPath(path)) return reply.code(400).send({ error: "bad entry path" });
    const content = await part.toBuffer();
    const id = `file_${shortId()}`;
    const key = objectKey({ kind: "wiki", workspaceId: ws(req), wikiId, path });
    await files.put(content, key);
    await repo.createFileRecord({
      id, name: `wiki/${path}`, size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      objectKey: key, kind: "wiki", workspaceId: ws(req),
    });
    const orphaned = await repo.upsertWikiEntries(wikiId, [{ path, fileId: id }]);
    for (const fid of orphaned) {
      const okey = await repo.deleteFileRecordById(fid).catch(() => null);
      if (okey) await Promise.resolve(files.del(okey)).catch(() => {});
    }
    return reply.code(201).send({ path, fileId: id });
  });

  app.delete("/v1/wikis/:id/entries", async (req, reply) => {
    const wikiId = (req.params as any).id;
    const { path } = req.query as { path?: string };
    const wiki = await repo.getWiki(wikiId, ws(req));
    if (!wiki || !path) return reply.code(400).send({ error: "wiki + path required" });
    const entry = await repo.getWikiEntry(wikiId, path);
    await repo.deleteWikiEntry(wikiId, path);
    if (entry?.file_id) {
      (async () => {
        const key = await repo.deleteFileRecordById(entry.file_id);
        if (key) await files.del(key);
      })().catch(() => {});
    }
    return reply.code(204).send();
  });

  // Runner callback: diff of wiki files changed/removed during a WRITE session.
  // Validate the session's agent actually holds a write ref to this wiki.
  app.post("/v1/sessions/:id/wiki", async (req, reply) => {
    const session = await repo.getSession((req.params as any).id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const b = req.body as { wikiId: string; entries?: { path: string; fileId: string }[]; deletes?: string[] };
    if (!b?.wikiId) return reply.code(400).send({ error: "wikiId required" });
    const v = await repo.getAgentVersion(session.agent_id, session.agent_version);
    const writes = ((v?.wiki_refs ?? []) as any[]).some((r) => r.wikiId === b.wikiId && r.mode === "write");
    if (!writes) return reply.code(403).send({ error: "session agent is not the writer of this wiki" });
    const owned = await ownedFiles(session.workspace_id, (b.entries ?? []).map((e) => e.fileId));
    const entries = (b.entries ?? []).filter((e) => owned.has(e.fileId));
    const orphaned = await repo.upsertWikiEntries(b.wikiId, entries, b.deletes ?? []);
    for (const fid of orphaned) {
      const key = await repo.deleteFileRecordById(fid).catch(() => null);
      if (key) await Promise.resolve(files.del(key)).catch(() => {});
    }
    return { ok: true };
  });

  app.get("/v1/agents", async (req) => {
    const { limit, offset } = pg(req);
    const { rows, count } = await repo.listAgents(ws(req), limit, offset);
    return { agents: rows, count, offset };
  });

  app.get("/v1/agents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await repo.getAgentWithVersions(id, ws(req));
    if (!agent) return reply.code(404).send({ error: "agent not found" });
    return agent;
  });

  app.post("/v1/agents/:id/versions", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as AgentConfig;
    // The agent must belong to the caller's workspace — version lookups are
    // keyed by agent_id only, so an unscoped write would hijack another
    // tenant's agent config.
    if (!(await repo.getAgent(ws(req), id))) return reply.code(404).send({ error: "agent not found" });
    if (!b?.routing || !(await repo.getRoutingByName(b.routing))) return reply.code(400).send({ error: "routing must reference an existing routing" });
    if (!b.environmentId) return reply.code(400).send({ error: "environmentId required" });
    const env = await repo.getEnvironment(b.environmentId);
    if (!env) return reply.code(400).send({ error: "unknown environment" });
    const missingSkills = await repo.missingSkillIds(ws(req), b.skillIds ?? []);
    if (missingSkills.length) return reply.code(400).send({ error: `unknown skill ids: ${missingSkills.join(", ")}` });
    const mcpErr = validateMcpServers(b.mcpServers);
    if (mcpErr) return reply.code(400).send({ error: mcpErr });
    const subErr = await validateSubagents(repo, ws(req), id, b.subagents);
    if (subErr) return reply.code(400).send({ error: subErr });
    // Hold the per-wiki writer lock across the exclusivity check + insert (B4).
    const wikiLock = await repo.acquireWikiWriteLock(writeWikiIds(b.wikiRefs));
    let prev: any, version: number;
    try {
      const wikiErr = await validateWikiRefs(repo, ws(req), id, b.wikiRefs);
      if (wikiErr) return reply.code(wikiErr.code).send({ error: wikiErr.error });
      prev = await repo.getAgentVersion(id);
      version = await repo.newAgentVersion(ws(req), id, b);
    } finally {
      await wikiLock.release();
    }
    await syncEnvPolicy(env);
    if (prev?.environment_id && prev.environment_id !== b.environmentId) {
      const prevEnv = await repo.getEnvironment(prev.environment_id);
      if (prevEnv) await syncEnvPolicy(prevEnv); // drop the moved agent's hosts
    }
    return reply.code(201).send({ id, version });
  });

  // Rename only — name is row metadata, not part of the versioned config.
  app.patch("/v1/agents/:id", async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name?.trim()) return reply.code(400).send({ error: "name required" });
    const res = await repo.renameAgent(ws(req), (req.params as any).id, name.trim());
    if (res === "notfound") return reply.code(404).send({ error: "agent not found" });
    if (res === "conflict") return reply.code(409).send({ error: "name already taken" });
    return { ok: true };
  });

  app.post("/v1/agents/:id/status", async (req, reply) => {
    const { status } = (req.body ?? {}) as { status?: string };
    if (!["active", "disabled"].includes(status ?? "")) return reply.code(400).send({ error: "bad status" });
    const ok = await repo.setAgentStatus(ws(req), (req.params as any).id, status!);
    if (!ok) return reply.code(404).send({ error: "agent not found" });
    return { ok: true };
  });

  app.delete("/v1/agents/:id", async (req, reply) => {
    // Cascades sessions/versions (FKs). Stop any running session pods first,
    // and drop each session's durable /work PVC (the row cascade can't).
    const { rows: sessions } = await repo.listSessions(ws(req), (req.params as any).id);
    await Promise.allSettled(sessions.flatMap((s: any) =>
      [orchestrator.stopSession(s.id), orchestrator.deleteSessionResources(s.id)]));
    for (const s of sessions) {
      const keys = await repo.deleteSession(ws(req), s.id);
      for (const key of keys) { try { await files.del(key); } catch { /* best effort */ } }
    }
    await repo.deleteAgent(ws(req), (req.params as any).id);
    return reply.code(204).send();
  });

  app.post("/v1/sessions", async (req, reply) => {
    const r = await createSessionAction(sessionDeps, ws(req), req.body as any);
    return reply.code(r.code).send(r.body);
  });

  app.post("/v1/sessions/:id/messages", async (req, reply) => {
    const r = await sendMessageAction(sessionDeps, ws(req), (req.params as any).id, req.body as any);
    return reply.code(r.code).send(r.body);
  });

  app.get("/v1/sessions", async (req) => {
    const { limit, offset } = pg(req);
    const agent = (req.query as any)?.agent as string | undefined;
    const file = (req.query as any)?.file as string | undefined;
    const { rows, count } = await repo.listSessions(ws(req), agent, limit, offset, file);
    return { sessions: rows, count, offset };
  });

  app.get("/v1/sessions/:id", async (req, reply) => {
    const session = await repo.getSession((req.params as any).id, ws(req));
    if (!session) return reply.code(404).send({ error: "session not found" });
    return session;
  });

  // Deployments a given turn's gateway calls resolved to (spec 2026-07-16, fix
  // wave H) — feeds the session step panel. Workspace-scoped like the sibling
  // session routes; fetched lazily when a step is opened.
  app.get("/v1/sessions/:id/deployments", async (req, reply) => {
    const { id } = req.params as { id: string };
    const turn = Number((req.query as any)?.turn ?? 0);
    const session = await repo.getSession(id, ws(req));
    if (!session) return reply.code(404).send({ error: "session not found" });
    return { deployments: await repo.sessionTurnDeployments(id, turn) };
  });

  // Attached/produced resources for the session detail page.
  app.get("/v1/sessions/:id/resources", async (req, reply) => {
    const r = await repo.sessionResources((req.params as any).id, ws(req));
    if (!r) return reply.code(404).send({ error: "session not found" });
    return r;
  });

  // Runner callback: output files produced in /mnt/session/outputs.
  app.post("/v1/sessions/:id/outputs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await repo.getSession(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const b = req.body as { fileIds: string[] };
    const owned = await ownedFiles(session.workspace_id, b?.fileIds ?? []);
    const fileIds = (b?.fileIds ?? []).filter((fid) => owned.has(fid));
    await repo.attachSessionFiles(id, fileIds, "output");
    return reply.code(202).send({ attached: fileIds.length });
  });

  // Runner callback (spec 2026-07-17): synchronous delegation to a configured
  // subagent — creates a linked child session / polls it. Workspace checks
  // live in the action (runner posts carry no workspace header).
  app.post("/v1/sessions/:id/delegate", async (req, reply) => {
    const r = await delegateAction(sessionDeps, (req.params as any).id, req.body as any);
    return reply.code(r.code).send(r.body);
  });
  app.get("/v1/sessions/:id/delegate/:childId", async (req, reply) => {
    const { id, childId } = req.params as { id: string; childId: string };
    const r = await delegateStatusAction(sessionDeps, id, childId);
    return reply.code(r.code).send(r.body);
  });
  // Runner callback (amendment 2026-07-17b): lock a child to `completed` —
  // terminal, mirrors the interrupt route's webhook + settle sequence.
  app.post("/v1/sessions/:id/delegate/:childId/complete", async (req, reply) => {
    const { id, childId } = req.params as { id: string; childId: string };
    const r = await delegateCompleteAction(sessionDeps, id, childId, req.body as any);
    if (r.locked) {
      deliverWebhooks(repo, childId, "completed").catch(() => {}); // fire-and-forget
      opts?.settleSession?.(childId).catch(() => {}); // final time-cost accrual (spec §4)
    }
    return reply.code(r.code).send(r.body);
  });

  // Runner callback: the Job env snapshots the checkpoint id at creation
  // (orchestrator DEVPROOF_CHECKPOINT); an interrupted turn's pod can replace
  // (and delete) that checkpoint before the next pod starts. This lets the
  // runner re-fetch the CURRENT id on a 404 and retry (see runner.py
  // restore_checkpoint). Unauthenticated like the other runner callbacks.
  app.get("/v1/sessions/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await repo.getSession(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    return { checkpointFileId: session.checkpoint_file_id ?? null };
  });

  // Interrupt a running session: stop its pod/Job, mark it idle so it can be
  // resumed with a follow-up message (Anthropic interrupt-via-events model).
  app.post("/v1/sessions/:id/interrupt", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await repo.getSession(id, ws(req));
    if (!session) return reply.code(404).send({ error: "session not found" });
    await orchestrator.stopSession(id);
    // A session waiting for its model deployment has no Job — un-park it so
    // it isn't launched later; idle keeps it resumable (follow-up re-gates).
    await repo.takePendingLaunch(id);
    const wasRunning = session.status === "running";
    await repo.setSessionStatus(id, "idle");
    // Only settle a turn that was actually running — a duplicate/late interrupt
    // on an already-terminal session would otherwise bill phantom time.
    if (wasRunning) await opts?.settleSession?.(id).catch(() => {});
    opts?.releaseWriterSlot?.(id); // interrupting a writer frees its slot → next queued
    await repo.appendEvents(id, [{ type: "session.interrupted", payload: { by: "user" } }]);
    await interruptChildSessions({ repo, orchestrator }, id, opts?.settleSession);
    return { ok: true, status: "idle" };
  });

  app.delete("/v1/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await deleteSessionFully({ repo, orchestrator, files }, ws(req), id);
    return reply.code(204).send();
  });

  app.get("/v1/sessions/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { stream, after } = req.query as { stream?: string; after?: string };
    if (stream !== "1") {
      return { events: await repo.listEvents(id, Number(after ?? 0)) };
    }
    return streamSessionEvents(req, reply, repo, notify, id, Number(after ?? 0), { console: true });
  });

  // Runner callbacks (unauthenticated in phase 1, matches gateway posture).
  app.post("/v1/sessions/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { events: any[] };
    // A routing terminal reject surfaces to the runner's SDK as a confusing
    // "Failed to authenticate" 403 (fix wave M) — reframe it before it's
    // persisted so every reader sees the clear text. Applied to EVERY event's
    // text/error field (identity on non-reject text): the SDK's wording rides
    // agent.message transcript bubbles, not just session.failed (live gap
    // 2026-07-17 — a fresh reject still showed the auth prefix in the
    // transcript).
    const events = (b?.events ?? []).map((e) => {
      if (!e?.payload) return e;
      const p = { ...e.payload };
      if (typeof p.error === "string") p.error = reframeFailureText(p.error);
      if (typeof p.text === "string") p.text = reframeFailureText(p.text);
      return { ...e, payload: p };
    });
    const seq = await repo.appendEvents(id, events);
    return reply.code(202).send({ seq });
  });

  app.post("/v1/sessions/:id/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { status: "completed" | "failed" | "idle"; sdkSessionId?: string; checkpointFileId?: string; turn?: number };
    if (!["completed", "failed", "idle"].includes(b?.status)) return reply.code(400).send({ error: "bad status" });
    // Stale-turn guard: a pod that outlived an interrupt reports a turn lower
    // than the session's current one — ignore the whole post (status,
    // checkpoint, webhooks). Posts without a turn (pre-dev23 images) apply.
    const reportedTurn = typeof b.turn === "number" && Number.isInteger(b.turn) ? b.turn : undefined;
    const status = b.status;
    const { replacedCheckpointFileId, applied } = await repo.setSessionStatus(id, status, b, reportedTurn);
    if (replacedCheckpointFileId) {
      // Best effort — a stale checkpoint must never fail the status update.
      (async () => {
        const key = await repo.deleteFileRecordById(replacedCheckpointFileId);
        if (key) await files.del(key);
      })().catch(() => {});
    }
    if (!applied && reportedTurn !== undefined && b.checkpointFileId) {
      // Rejected stale post: its salvage checkpoint is referenced nowhere —
      // reclaim it or it leaks one tarball per raced interrupt (best effort).
      (async () => {
        const key = await repo.deleteFileRecordById(b.checkpointFileId!);
        if (key) await files.del(key);
      })().catch(() => {});
    }
    if (applied) deliverWebhooks(repo, id, status).catch(() => {}); // fire-and-forget
    if (applied) opts?.settleSession?.(id).catch(() => {}); // final time-cost accrual (spec §4)
    if (applied) opts?.releaseWriterSlot?.(id); // free the writer slot → launch the next queued session
    return { ok: true, applied };
  });

  app.post("/v1/webhooks", async (req, reply) => {
    const b = req.body as { url: string; events?: string[] };
    if (!b?.url) return reply.code(400).send({ error: "url required" });
    return reply.code(201).send(await repo.createWebhook(ws(req), b.url, b.events));
  });

  app.get("/v1/webhooks", async (req) => ({ webhooks: await repo.listWebhooks(ws(req)) }));

  app.get("/v1/agents/:id/observability", async (req) =>
    repo.agentObservability((req.params as any).id));

  // ── Build version (reproducible-builds spec 2026-07-18) — baked into every
  // image as DEVPROOF_VERSION; out-of-cluster dev has no env ⇒ "dev".
  app.get("/v1/version", async () => ({
    version: process.env.DEVPROOF_VERSION || "dev",
  }));

  // ── Global cost settings (spec 2026-07-14) — public read: every console
  // page needs them to decide whether to render cost UI. Not workspace-scoped.
  app.get("/v1/settings", async () => ({
    costs: await repo.getCostSettings(),
    limits: await repo.getLimits(),
    maintenance: await repo.getMaintenanceSettings(),
    appearance: await repo.getAppearance(),
    maintenanceLastRun: await repo.getMaintenanceLastRun(),
    // Read-only, computed from env (lite-deployment spec 2026-07-19) — never
    // stored in app_settings; PUT ignores it.
    serving: { localEnabled: localServingEnabled() },
  }));

  app.put("/v1/settings", async (req, reply) => {
    const b = req.body as { costs?: unknown; limits?: unknown; maintenance?: unknown; appearance?: unknown };
    const costErr = validateCostSettings(b?.costs);
    if (costErr) return reply.code(400).send({ error: costErr });
    const limErr = validateLimits(b?.limits);
    if (limErr) return reply.code(400).send({ error: limErr });
    const maintErr = validateMaintenanceSettings(b?.maintenance);
    if (maintErr) return reply.code(400).send({ error: maintErr });
    const appErr = validateAppearance(b?.appearance);
    if (appErr) return reply.code(400).send({ error: appErr });
    const costs = normalizeCostSettings(b!.costs);
    await repo.putCostSettings(costs);
    // Persist limits only when the body carries an explicit maxWorkGb; a body
    // that omits `limits` (or sends an empty object) leaves the stored cap
    // untouched and echoes the current value rather than the 2048 default.
    let limits;
    if (b?.limits !== undefined && (b.limits as { maxWorkGb?: unknown }).maxWorkGb !== undefined) {
      limits = normalizeLimits(b.limits);
      await repo.putLimits(limits);
    } else {
      limits = await repo.getLimits();
    }
    // Persist maintenance only when the body carries the block (limits idiom);
    // merge-when-provided: absent fields keep their stored values.
    let maintenance = await repo.getMaintenanceSettings();
    if (b?.maintenance !== undefined) {
      maintenance = mergeMaintenanceSettings(maintenance, b.maintenance);
      await repo.putMaintenanceSettings(maintenance);
    }
    // Persist appearance only when the body carries an explicit field, merging
    // the provided fields over the stored block (maintenance idiom) — a
    // theme-only body must not reset timeFormat to its default, and vice versa.
    // An omitted or empty block leaves everything untouched.
    let appearance = await repo.getAppearance();
    const ab = b?.appearance as { theme?: unknown; timeFormat?: unknown } | undefined;
    if (ab?.theme !== undefined || ab?.timeFormat !== undefined) {
      appearance = normalizeAppearance({
        theme: ab.theme !== undefined ? ab.theme : appearance.theme,
        timeFormat: ab.timeFormat !== undefined ? ab.timeFormat : appearance.timeFormat,
      });
      await repo.putAppearance(appearance);
    }
    return { costs, limits, maintenance, appearance };
  });

  // Manual maintenance trigger (console "Run maintenance now"). Synchronous:
  // bounded work, the console shows the returned per-section summary. Uses the
  // SAME deps object as the scheduler (main.ts) so the two can never diverge.
  app.post("/v1/maintenance/run", async () => runMaintenance(opts?.maintenanceDeps ?? {
    repo, files,
    deleteSession: (w, id) => deleteSessionFully({ repo, orchestrator, files }, w, id),
  }));

  // Resource prices (spec 2026-07-14 §2). Global; ref = pool/deployment name
  // or external/environment row id. Empty prices object deletes the row.
  app.get("/v1/prices", async () => ({ prices: await repo.listResourcePrices() }));

  app.put("/v1/prices/:kind/:ref", async (req, reply) => {
    const { kind, ref } = req.params as { kind: string; ref: string };
    const prices = (req.body as any)?.prices;
    const err = validatePrices(kind, prices);
    if (err) return reply.code(400).send({ error: err });
    const empty = Object.entries(prices as Record<string, any>)
      .every(([, sub]) => Object.keys(sub ?? {}).length === 0);
    if (empty || Object.keys(prices).length === 0) {
      await repo.deleteResourcePrice(kind, ref);
      return { prices: null };
    }
    await repo.putResourcePrice(kind, ref, prices);
    return { prices };
  });

  // Analytics (spec 2026-07-14): session usage from gateway_usage(source='session').
  app.get("/v1/usage", async (req) => {
    const q = req.query as { range?: string; deployment?: string; agent?: string; workspaces?: string };
    const settings = await repo.getCostSettings();
    const usage = await repo.sessionUsage(q.workspaces === "all" ? null : ws(req), {
      range: q.range ?? "7d",
      ...(q.deployment ? { deployment: q.deployment } : {}),
      ...(q.agent ? { agentId: q.agent } : {}),
    });
    return { ...usage, costs: costsMeta(settings) };
  });

  // Gateway-metered API usage (external clients via API keys).
  app.get("/v1/usage/gateway", async (req) => {
    const q = req.query as { range?: string; deployment?: string; api_key?: string; workspaces?: string };
    const settings = await repo.getCostSettings();
    const usage = await repo.gatewayUsage(ws(req), {
      range: q.range ?? "7d",
      ...(q.deployment ? { deployment: q.deployment } : {}),
      ...(q.api_key ? { apiKeyId: q.api_key } : {}),
      ...(q.workspaces === "all" ? { allWorkspaces: true } : {}),
    });
    return { ...usage, costs: costsMeta(settings) };
  });

  // ── API keys ──
  app.get("/v1/api-keys", async (req) => {
    if ((req.query as any)?.all === "1") return { keys: await repo.listAllApiKeys(), count: 0, offset: 0 };
    const { limit, offset } = pg(req);
    const includeDeleted = (req.query as any)?.include === "deleted";
    const { rows, count } = await repo.listApiKeys(ws(req), limit, offset, includeDeleted);
    return { keys: rows, count, offset };
  });
  app.post("/v1/api-keys", async (req, reply) => {
    const b = req.body as { name: string };
    if (!b?.name) return reply.code(400).send({ error: "name required" });
    // Full key returned once; never retrievable again.
    return reply.code(201).send(await repo.createApiKey(ws(req), b.name));
  });
  app.post("/v1/api-keys/:id", async (req, reply) => {
    const { status } = req.body as { status: string };
    if (!["active", "inactive", "archived"].includes(status)) return reply.code(400).send({ error: "bad status" });
    await repo.setApiKeyStatus(ws(req), (req.params as any).id, status);
    return { ok: true };
  });
  app.delete("/v1/api-keys/:id", async (req, reply) => {
    await repo.deleteApiKey(ws(req), (req.params as any).id);
    return reply.code(204).send();
  });
}
