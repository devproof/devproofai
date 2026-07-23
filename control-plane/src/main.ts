import { fileURLToPath } from "node:url";
import { registerAgentRoutes } from "./agents-api.ts";
import { loadCatalog } from "./catalog.ts";
import { createPool, migrate, NotifyHub } from "./db.ts";
import { ensureGatewayAuthSecret, ensureInternalKeyInAgentsNs } from "./gateway-secret.ts";
import { localFileStore, s3ClientOptions, s3FileStore } from "./filestore.ts";
import { realKubeStore } from "./kubestore.ts";
import { releasePendingForModel, sweepPendingLaunches } from "./launch-gate.ts";
import { releaseWriterQueue, sweepWriterQueues } from "./writer-queue.ts";
import { reachableLocalTargets, reachableTargets } from "./routing-rules.ts";
import { loadMcpRegistry } from "./mcp.ts";
import { realOrchestrator } from "./orchestrator.ts";
import { registerPublicApi, sweepStaleUploads } from "./public-api.ts";
import { startReconciler } from "./reconciler.ts";
import { sweepModelRouting } from "./routing-state.ts";
import { localServingEnabled } from "./serving-mode.ts";
import { interruptChildSessions } from "./subagents.ts";
import { settleSession, startCostSampler } from "./cost-sampler.ts";
import { startMaintenanceScheduler } from "./maintenance.ts";
import { Repo } from "./repo.ts";
import { deleteSessionFully } from "./session-delete.ts";
import { buildServer } from "./server.ts";
import { TraceHub, registerTraceRoutes } from "./trace.ts";
import { wakeIfIdle, wakeModel } from "./wake.ts";
import { sweepDeletingWorkspaces } from "./workspace-delete.ts";

const catalogPath =
  process.env.DEVPROOF_CATALOG ??
  fileURLToPath(new URL("../../catalog/models.yaml", import.meta.url));

const mcpRegistryPath =
  process.env.DEVPROOF_MCP_REGISTRY ??
  fileURLToPath(new URL("../../catalog/mcp-servers.yaml", import.meta.url));

const localServing = localServingEnabled();

const pool = createPool();
await migrate(pool);
// Internal key for session pods → gateway; gateway pods read the same Secret.
try {
  process.env.DEVPROOF_INTERNAL_KEY = await ensureGatewayAuthSecret();
  // A1: mirror it into the agents namespace so Job pods reference it via
  // secretKeyRef instead of a plaintext env value baked into every Job spec.
  await ensureInternalKeyInAgentsNs(process.env.DEVPROOF_INTERNAL_KEY);
} catch (err) {
  console.warn("gateway-auth secret unavailable — session pods will send 'none':", err);
}
const repo = new Repo(pool);
const kube = realKubeStore();
const orchestrator = realOrchestrator();
const wake = (model: string) => wakeModel({ kube, repo }, model);
// Launch gate (2026-07-12): how a session's model name resolves right now.
// Local deployment → its phase; external endpoint → always routed; neither →
// null (gate launches, sweep fails a waiter whose deployment was deleted).
//
// "Ready" on the CRD is NOT "routable": the gateway config sync, its rolling
// reload, and the warmup completion all lag the Ready transition (verified
// live: a sweep that released on Ready alone re-raced the exact 400 this gate
// exists to prevent). warmedModels tracks the only trustworthy signal — the
// post-warmup onModelRouted hook — and a Ready-but-not-warmed model reports
// phase "Warming", which the gate and sweep treat as wait-a-bit.
const warmedModels = new Set<string>();
const modelPhase = async (name: string): Promise<import("./launch-gate.ts").ModelPhase> => {
  // Routing-first (fix wave I): routings may SHADOW a deployment of the same
  // name, so the routing lookup must run before the deployment lookup — a
  // deployment-first order silently resolves a shadowing routing as the
  // deployment instead (wrong contextWindow — the deployment's own instead of
  // the routing's min across reachable targets — and wrong launch gating, since
  // it parks on the deployment's phase instead of launching via the routing
  // branch). This order is load-bearing; do not swap it back for tidiness.
  const routing = await repo.getRoutingByName(name);
  if (routing) {
    // Min served context across reachable targets — local AND external (fix
    // wave L: external endpoints now carry mandatory context_tokens) — the
    // CLI compacts before ANY possible target overflows. No reachable targets
    // with known context → no cap.
    const spec = { rules: routing.rules ?? [], terminal: routing.terminal };
    const localNames = new Set<string>(localServing
      ? (await kube.list("modeldeployments")).map((x: any) => x.metadata.name) : []);
    const locals = reachableLocalTargets(spec, localNames);
    let min: number | null = null;
    for (const t of locals) {
      const td = await kube.get("modeldeployments", t).catch(() => null);
      const c = td?.status?.effectiveContextTokens ?? null;
      if (c && (min === null || c < min)) min = c;
    }
    let liveExternal = false;
    for (const t of reachableTargets(spec)) {
      if (localNames.has(t)) continue;
      const ext = await repo.getExternalDeploymentByName(t);
      if (ext) liveExternal = true;
      const c = ext?.context_tokens ?? null;
      if (c != null && (min === null || c < min)) min = c;
    }
    // A routing that targets model(s) but has NONE still live is dead — every
    // request 503s "routing target unavailable" and the runner waits it out.
    // Fail such a session at the gate (spec 2026-07-23c). A routing with no
    // targets at all (rules-less + reject terminal) is intentional, not dead.
    const all = reachableTargets(spec);
    const deadTargets = all.length > 0 && locals.length === 0 && !liveExternal ? all : undefined;
    return { kind: "routing", contextTokens: min, ...(deadTargets ? { deadTargets } : {}) };
  }
  const d = localServing ? await kube.get("modeldeployments", name).catch(() => null) : null;
  if (d) {
    const phase = d.status?.phase ?? "Pending";
    // Self-heal: a deployment that leaves Ready (delete/recreate, failure)
    // must re-earn its warmed bit before sessions launch against it again.
    if (phase !== "Ready") warmedModels.delete(name);
    return {
      kind: "local",
      phase: phase === "Ready" && !warmedModels.has(name) ? "Warming" : phase,
      // Served (operator-capped) window — status-sourced so a capped
      // deployment reports what it actually serves, not the catalog value.
      contextTokens: d.status?.effectiveContextTokens ?? null,
    };
  }
  if (await repo.getExternalDeploymentByName(name)) return { kind: "external" };
  return null;
};
// model_routing projection (spec 2026-07-15): shared by the reconciler-cadence
// sweep AND the post-sync hook — the operator syncs on Ready↔Idle transitions,
// so re-projecting here engages the gateway hold within seconds of a sleep
// instead of waiting out the 60s sweep (live gap found 2026-07-15).
const projectModelRouting = () => {
  if (!localServing) return Promise.resolve();
  return sweepModelRouting({
    listDeployments: async () => (await kube.list("modeldeployments"))
      .map((d: any) => ({ name: d.metadata.name, phase: d.status?.phase ?? "Pending" })),
    isWarmed: (n) => warmedModels.has(n),
    setModelRouting: (m, s, p) => repo.setModelRouting(m, s, p),
    pruneModelRouting: (k) => repo.pruneModelRouting(k),
    takeWakeRequests: () => repo.takeWakeRequests(),
    wake,
  }).catch((err) => console.warn("model_routing sweep failed:", err));
};
const app = buildServer(loadCatalog(catalogPath), kube, {
  list: () => repo.listCatalogModels(),
  create: (e) => repo.createCatalogModel(e),
  delete: (id) => repo.deleteCatalogModel(id),
}, {
  create: (d) => repo.createExternalDeployment(d),
  list: () => repo.listExternalDeployments(),
  get: (id) => repo.getExternalDeployment(id),
  getByName: (n) => repo.getExternalDeploymentByName(n),
  update: (id, p) => repo.updateExternalDeployment(id, p),
  delete: (id) => repo.deleteExternalDeployment(id),
}, {
  // Fires after the model's warmup completion answered through the gateway —
  // the only signal that the route is truly live. Mark warmed, then launch
  // everything parked on the model.
  onModelRouted: (name) => {
    warmedModels.add(name);
    // Release order matters: held gateway requests read model_routing.
    void repo.setModelRouting(name, "ready", "Ready").catch((err) => console.warn(`model_routing ready for ${name} failed:`, err));
    void releasePendingForModel(repo, orchestrator, name)
      .catch((err) => console.warn(`launch-gate: release for ${name} failed:`, err));
  },
  onResourceDeleted: (kind, ref) => {
    if (kind === "deployment") void repo.deleteModelRouting(ref).catch(() => {});
    return repo.deleteResourcePrice(kind, ref);
  },
  // Operator-triggered syncs fire on Ready↔Idle — keep the hold-projection live.
  onGatewaySynced: () => { void projectModelRouting(); },
}, {
  list: () => repo.listRoutings(), get: (n) => repo.getRoutingByName(n),
  create: (n, r, t) => repo.createRouting(n, r, t),
  update: (n, p) => repo.updateRouting(n, p), delete: (n) => repo.deleteRouting(n),
  agentsReferencing: (n) => repo.agentsReferencingRouting(n),
});
const notify = new NotifyHub(pool);
await notify.start();
// Gateway pre-call hook signals wakes for sleeping models (spec 2026-07-15).
// Phase-guarded (I1, final review): a post-restart 'waking' projection must
// not stomp the scaler's higher target-replicas annotation on a busy model.
if (localServing) notify.onWake((model) => {
  void wakeIfIdle({ kube, repo }, model).catch((err) => console.warn(`wake ${model} failed (sweep retries):`, err));
});

// Scalable file storage: MinIO/S3 when configured (shared object store, content-
// addressed dedup), else single-host local disk for minimal dev.
let files = localFileStore();
if (process.env.DEVPROOF_S3_ENDPOINT || process.env.DEVPROOF_S3_BUCKET) {
  const bucket = process.env.DEVPROOF_S3_BUCKET ?? "devproof-files";
  const cfg = {
    endpoint: process.env.DEVPROOF_S3_ENDPOINT,
    region: process.env.DEVPROOF_S3_REGION,
    accessKey: process.env.DEVPROOF_S3_ACCESS_KEY,
    secretKey: process.env.DEVPROOF_S3_SECRET_KEY,
    bucket,
  };
  const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");
  const c = new S3Client(s3ClientOptions(cfg));
  // Ensure the bucket exists before serving. Retry with backoff: on a fresh
  // install the CP races the bundled MinIO's first boot (PVC provisioning),
  // and external S3 can blip too. Only "already exists" is success; anything
  // else after the deadline crashes the boot so k8s restarts the pod — a
  // silently missing bucket fails every file op later ("The specified bucket
  // does not exist").
  for (let attempt = 1; ; attempt++) {
    try {
      await c.send(new CreateBucketCommand({ Bucket: bucket }));
      break;
    } catch (e) {
      const name = (e as Error)?.name ?? "";
      if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") break;
      if (attempt >= 30) throw e;
      console.log(`bucket ${bucket} not ready (${name || e}), retry ${attempt}/30`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  files = s3FileStore(cfg);
  console.log(`file store: S3 ${cfg.endpoint ?? "aws"}/${bucket}`);
}
const mcpRegistry = loadMcpRegistry(mcpRegistryPath);
// Time-cost sampler (spec 2026-07-14): pool/env pod-time + session billing.
const samplerDeps = { repo, kube: localServing ? kube : { list: async () => [] as any[] }, orchestrator };
const settle = (id: string) => settleSession(samplerDeps, id);
// A session going terminal/interrupted frees the writer slot — release the next
// queued writer session (spec 2026-07-18). Fire-and-forget; the reconciler sweep
// is the safety net if this trigger is lost.
const releaseWriterSlot = (sessionId: string) => {
  void (async () => {
    const s = await repo.getSession(sessionId);
    if (s) await releaseWriterQueue(repo, orchestrator, s.agent_id);
  })().catch((err) => console.warn(`writer-queue: release for session ${sessionId} failed:`, err));
};
await registerAgentRoutes(app, repo, orchestrator, files, notify, { modelPhase, mcpRegistry, settleSession: settle, releaseWriterSlot, wakeModel: wake });
await registerPublicApi(app, repo, orchestrator, files, notify, { modelPhase, mcpRegistry, settleSession: settle, releaseWriterSlot, wakeModel: wake });
// Chunked uploads that never complete leak MinIO parts — hourly abort sweep.
sweepStaleUploads(repo, files).catch((err) => console.warn("upload sweep failed:", err));
setInterval(() => sweepStaleUploads(repo, files).catch((err) => console.warn("upload sweep failed:", err)), 3_600_000).unref();
// Resume workspace drains interrupted by a restart (runner is idempotent).
sweepDeletingWorkspaces(repo, orchestrator, files).catch((err) => console.warn("workspace delete sweep failed:", err));
registerTraceRoutes(app, repo, new TraceHub());
// Zombie sweep: sessions whose runner died without reporting → failed
// (resumable). The pending sweep is the launch gate's safety net: releases
// waiters whose model turned Ready, fails ones whose model failed/vanished.
startCostSampler(samplerDeps);
startReconciler(repo, orchestrator, async () => {
  await sweepPendingLaunches(repo, orchestrator, modelPhase, wake);
  await sweepWriterQueues(repo, orchestrator); // release parked writer sessions when their slot frees
  await projectModelRouting();
}, async (id) => {
  await settle(id);
  // A zombie-failed parent leaves nobody to collect its children's results.
  await interruptChildSessions({ repo, orchestrator }, id, settle);
});
startMaintenanceScheduler({
  repo, files,
  deleteSession: (w, id) => deleteSessionFully({ repo, orchestrator, files }, w, id),
});
const port = Number(process.env.PORT ?? 7080);
const host = process.env.HOST ?? "127.0.0.1";
app.listen({ port, host }).then(async (addr) => {
  console.log(`devproof control-plane listening on ${addr}`);
  // Boot sync: rebuild the gateway routes and re-warm every ready model so
  // warmedModels repopulates after a CP restart — the operator only triggers
  // syncs on Ready TRANSITIONS, so without this a session parked behind an
  // already-Ready model would wait forever. Failure is non-fatal (the next
  // operator trigger or manual sync heals it).
  try { await app.inject({ method: "POST", url: "/v1/gateway/sync" }); }
  catch (err) { console.warn("boot gateway sync failed:", err); }
});
