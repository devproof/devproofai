// Devproof control-plane REST API (phase-1 serving subset, concept §6.4/§5).
import Fastify from "fastify";
import { CatalogEntry, resolveDeployment, DeploymentRequest } from "./catalog.ts";
import { buildGatewayConfig, envKeyFor, newlyRouted } from "./gateway-config.ts";
import { fetchPeakThroughput, fetchServingMetrics, observedByCatalogId } from "./metrics.ts";
import { validateRouting, reachableLocalTargets, reachableTargets, ROUTING_NAME, type RoutingSpec } from "./routing-rules.ts";
import { cacheRows, progressPct, DOWNLOAD_BYTES_CMD } from "./cache-rows.ts";
import type { KubeStore } from "./kubestore.ts";
import { SERVING_NAMESPACE } from "./namespaces.ts";
import { localServingEnabled } from "./serving-mode.ts";

export interface CustomCatalog {
  list(): Promise<CatalogEntry[]>;
  /** Upsert (repo backs this with ON CONFLICT (id) DO UPDATE) — also used for edits and bundled-model overrides. */
  create(entry: CatalogEntry): Promise<CatalogEntry>;
  delete(id: string): Promise<void>;
}

export interface ExternalStore {
  create(d: { name: string; provider: string; baseUrl?: string; modelId: string; hasKey: boolean;
              reasoningEffort?: string | null; contextTokens: number }): Promise<any>;
  list(): Promise<any[]>;
  get(id: string): Promise<any | null>;
  getByName(name: string): Promise<any | null>;
  update(id: string, patch: { baseUrl?: string; modelId?: string; rotateKey?: boolean;
                              reasoningEffort?: string | null; contextTokens?: number }): Promise<any | null>;
  delete(id: string): Promise<any | null>;
}

export interface RoutingStore {
  list(): Promise<any[]>;
  get(name: string): Promise<any | null>;
  create(name: string, rules: unknown, terminal: unknown): Promise<any>;
  update(name: string, patch: { rules?: unknown; terminal?: unknown }): Promise<any | null>;
  delete(name: string): Promise<any | null>;
  /** Names of agents whose latest version references this routing — the
   *  delete guard 409s while any exist (pool-delete convention). */
  agentsReferencing?(name: string): Promise<string[]>;
}

export function buildServer(
  bundled: CatalogEntry[], store: KubeStore, custom?: CustomCatalog, externals?: ExternalStore,
  hooks?: {
    /** Fired once per model when it becomes routed AND its warmup finished —
     *  the launch gate releases sessions parked on that model here. */
    onModelRouted?: (name: string) => void;
    /** Fired after a pool/deployment/external resource is deleted, to clean
     *  up its price row (spec 2026-07-14 §2). */
    onResourceDeleted?: (kind: "pool" | "deployment" | "external", ref: string) => Promise<void>;
    /** Fired after every gateway sync. The operator triggers a sync on
     *  Ready↔Idle transitions, so this keeps the model_routing projection
     *  near-live — without it a freshly-slept model's requests are not held
     *  until the next 60s sweep (live gap, 2026-07-15). */
    onGatewaySynced?: () => void;
  },
  routings?: RoutingStore,
  opts?: { localServing?: boolean },
) {
  const app = Fastify({ logger: false });

  // Lite deployments (spec 2026-07-19): local serving off ⇒ the local-only
  // surfaces 404 and no serving-CRD kubestore call is ever made.
  const localServing = opts?.localServing ?? localServingEnabled();
  const localGate = (reply: { code(n: number): { send(b: unknown): unknown } }): boolean => {
    if (localServing) return false;
    reply.code(404).send({ error: "local serving disabled" });
    return true;
  };

  // First request to a fresh model pays graph/buffer allocation; warm each
  // newly-routed deployment through the gateway (the only path reachable
  // from an out-of-cluster CP). Retries cover the gateway's config-reload
  // restart. Warmups meter as source='session' (~8 tokens, invisible to
  // billing). After a CP restart every ready model re-warms once — harmless.
  const routedModels = new Set<string>();
  const warmDeployment = async (name: string) => {
    const gw = process.env.DEVPROOF_GATEWAY_LOCAL_URL ?? "http://127.0.0.1:14000";
    for (let attempt = 1; attempt <= 12; attempt++) {
      try {
        const res = await fetch(`${gw}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.DEVPROOF_INTERNAL_KEY ?? "none"}` },
          // devproof_direct: internal-only escape hatch — a same-named routing
          // must NOT shadow the warmup (would deadlock the wake). The hook honors
          // this only for internal callers (spec 2026-07-16).
          body: JSON.stringify({ model: name, messages: [{ role: "user", content: "hi" }], max_tokens: 8, metadata: { devproof_direct: true } }),
          signal: AbortSignal.timeout(120_000),
        });
        if (res.ok) { console.log(`warmup: ${name} ready (attempt ${attempt})`); return; }
      } catch { /* gateway restarting or model still routing — retry */ }
      // unref: pending retries must never hold the process open (tests, shutdown)
      await new Promise((r) => setTimeout(r, 10_000).unref());
    }
    console.warn(`warmup: ${name} never answered — first real request will pay the cold start`);
  };
  const syncGateway = async () => {
    const deployments = localServing ? await store.list("modeldeployments") : [];
    const config = buildGatewayConfig(deployments, externals ? await externals.list() : [], {
      publicApiTarget: process.env.DEVPROOF_PUBLIC_API_TARGET ?? "http://host.docker.internal:7080/api",
      routingNames: routings ? (await routings.list()).map((r: any) => r.name) : [],
    });
    const changed = await store.writeGatewayConfig(config);
    // Release parked launches only after the gateway rollout completed AND the
    // warmup answered. One successful warmup is NOT enough (live-bug
    // 2026-07-12): during the rolling config reload, stale route-less replicas
    // stay in the Service rotation for minutes, and a released session's first
    // request can round-robin onto one and 400. Await the rollout even when
    // this sync changed nothing — an earlier sync's rollout may still be in
    // flight. On rollout timeout, warn and warm anyway: a stuck gateway fails
    // requests regardless, and the failed session stays resumable.
    for (const name of newlyRouted(routedModels, deployments)) {
      void store.awaitGatewayRollout()
        .then((settled) => {
          if (!settled) console.warn(`warmup: gateway rollout still unsettled — warming ${name} against mixed replicas`);
          return warmDeployment(name);
        })
        .then(() => hooks?.onModelRouted?.(name));
    }
    // Ready↔Idle transitions trigger a sync (operator routingChanged) but
    // change no routes — this hook re-projects model_routing so the gateway
    // hold engages within seconds of a sleep, not at the next 60s sweep.
    hooks?.onGatewaySynced?.();
    return changed;
  };

  // Fixed 100/page pagination for the serving lists (sliced in memory);
  // dropdown consumers pass ?limit= (capped at 1000).
  const page = (req: any) => {
    const q = (req.query ?? {}) as { offset?: string; page?: string; limit?: string };
    const offset = q.page ? (Math.max(1, Number(q.page)) - 1) * 100 : Math.max(0, Number(q.offset) || 0);
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 100));
    return { limit, offset };
  };
  const paged = <T>(items: T[], req: any) => {
    const { limit, offset } = page(req);
    return { rows: items.slice(offset, offset + limit), count: items.length, offset };
  };

  const bundledIds = new Set(bundled.map((b) => b.id));
  // Bundled YAML entries + DB entries (DB wins on id clash — custom models AND bundled overrides).
  const fullCatalog = async (): Promise<{ entries: CatalogEntry[]; dbIds: Set<string> }> => {
    const extra = custom ? await custom.list() : [];
    const dbIds = new Set(extra.map((e) => e.id));
    return { entries: [...extra, ...bundled.filter((b) => !dbIds.has(b.id))], dbIds };
  };

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/v1/catalog", async (req, reply) => {
    if (localGate(reply)) return reply;
    const { entries: catalog, dbIds } = await fullCatalog();
    const items = await store.list("modeldeployments");
    const deployments = items.map((d: any) => ({ name: d.metadata.name, catalogId: d.spec?.catalogId }));
    const observed = observedByCatalogId(deployments, await fetchPeakThroughput());
    const models = catalog.map((m) => ({
      ...m,
      custom: dbIds.has(m.id) && !bundledIds.has(m.id),
      overridden: dbIds.has(m.id) && bundledIds.has(m.id),
      observedTokensPerSec: observed[m.id] ?? null,
    }));
    const { rows, count, offset } = paged(models, req);
    return { models: rows, count, offset };
  });

  const badReleaseDate = (s: unknown) =>
    s != null && !(typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)));

  // K8s-quantity sanity check (spec 2026-07-16). requireBoth: catalog entries
  // must be complete; deployment requests may override a single key.
  const CPU_QTY = /^(\d+(\.\d+)?|\d+m)$/;
  const MEM_QTY = /^\d+(Ki|Mi|Gi|Ti)$/;
  const resourcesError = (r: unknown, opts: { requireBoth: boolean }): string | null => {
    if (r == null || typeof r !== "object" || Array.isArray(r)) return "resources must be { cpu, memory }";
    const { cpu, memory } = r as any;
    const extra = Object.keys(r).filter((k) => k !== "cpu" && k !== "memory");
    if (extra.length) return `resources: unknown keys ${extra.join(", ")}`;
    if (opts.requireBoth && (cpu == null || memory == null)) return "resources needs both cpu and memory";
    if (!opts.requireBoth && cpu == null && memory == null) return "resources needs cpu or memory";
    if (cpu != null && !(typeof cpu === "string" && CPU_QTY.test(cpu)))
      return `resources.cpu must be a k8s cpu quantity (e.g. "2", "500m")`;
    if (memory != null && !(typeof memory === "string" && MEM_QTY.test(memory)))
      return `resources.memory must be a k8s memory quantity (e.g. "3Gi")`;
    return null;
  };

  // Custom-model reasoning: same shape the bundled YAML uses (spec 2026-07-12).
  const reasoningShapeError = (r: unknown): string | null => {
    if (r == null) return null;
    const efforts = (r as any)?.efforts;
    if (typeof r !== "object" || Array.isArray(r) || !efforts || typeof efforts !== "object" || Array.isArray(efforts))
      return "reasoning must be { efforts: { <name>: <tokenBudget> } }";
    const keys = Object.keys(efforts);
    if (!keys.length || keys.length > 8) return "reasoning.efforts needs 1–8 entries";
    for (const k of keys) {
      if (!k || k.length > 16) return "reasoning effort names must be 1–16 chars";
      if (!Number.isInteger(efforts[k]) || efforts[k] < 0 || efforts[k] > 131072)
        return "reasoning budgets must be integers 0–131072";
    }
    return null;
  };

  app.post("/v1/catalog", async (req, reply) => {
    if (localGate(reply)) return reply;
    if (!custom) return reply.code(501).send({ error: "custom catalog not enabled" });
    const b = req.body as Partial<CatalogEntry>;
    if (!b?.id || !b?.displayName || !b?.source || !b?.format) {
      return reply.code(400).send({ error: "id, displayName, source, format required" });
    }
    if (badReleaseDate(b.releaseDate)) return reply.code(400).send({ error: "releaseDate must be YYYY-MM-DD" });
    const reErr = reasoningShapeError(b.reasoning);
    if (reErr) return reply.code(400).send({ error: reErr });
    const resErr = resourcesError(b.resources, { requireBoth: true });
    if (resErr) return reply.code(400).send({ error: resErr });
    // Normalize into a deployable entry with a sensible CPU capacity profile
    // so it can be deployed immediately; caller may override fields.
    const entry: any = {
      id: b.id, family: b.family ?? "custom", displayName: b.displayName,
      parameters: b.parameters ?? "—", format: b.format, quantization: b.quantization,
      source: b.source, license: b.license ?? "custom", releaseDate: b.releaseDate,
      recommendedEngine: b.recommendedEngine ?? (b.format === "gguf" ? "llama.cpp" : "vllm"),
      toolCalling: b.toolCalling ?? "basic", contextTokens: b.contextTokens,
      requirements: b.requirements ?? { vramGB: 0, diskGB: 1, gpus: 0 },
      resources: b.resources,
      capacityProfiles: b.capacityProfiles ?? [
        { gpuType: "cpu", instanceType: "cpu-4vcpu", gpusPerReplica: 0, vramGB: 0, estTokensPerSec: 15 },
      ],
      ...(b.reasoning ? { reasoning: b.reasoning } : {}),
    };
    return reply.code(201).send(await custom.create(entry));
  });

  app.delete("/v1/catalog/:id", async (req, reply) => {
    if (localGate(reply)) return reply;
    if (!custom) return reply.code(501).send({ error: "custom catalog not enabled" });
    await custom.delete((req.params as any).id);
    return reply.code(204).send();
  });

  app.patch("/v1/catalog/:id", async (req, reply) => {
    if (localGate(reply)) return reply;
    if (!custom) return reply.code(501).send({ error: "custom catalog not enabled" });
    const id = (req.params as any).id;
    const b = (req.body ?? {}) as Partial<CatalogEntry>;
    const allowed = new Set(["displayName", "family", "parameters", "format", "quantization", "source",
      "license", "releaseDate", "recommendedEngine", "toolCalling", "contextTokens", "requirements", "capacityProfiles", "reasoning", "resources"]);
    const extra = Object.keys(b).filter((k) => !allowed.has(k));
    if (extra.length) return reply.code(400).send({ error: `not editable: ${extra.join(", ")}` });
    if (badReleaseDate(b.releaseDate)) return reply.code(400).send({ error: "releaseDate must be YYYY-MM-DD" });
    const reErr = reasoningShapeError(b.reasoning);
    if (reErr) return reply.code(400).send({ error: reErr });
    if (b.resources !== undefined) {
      const resErr = resourcesError(b.resources, { requireBoth: true });
      if (resErr) return reply.code(400).send({ error: resErr });
    }
    const current = (await fullCatalog()).entries.find((e) => e.id === id);
    if (!current) return reply.code(404).send({ error: "unknown catalog entry" });
    // Merge over the effective entry (YAML or prior override) and upsert — bundled ids become DB overrides.
    return custom.create({ ...current, ...b, id } as CatalogEntry);
  });

  app.get("/v1/cache", async (req, reply) => {
    if (localGate(reply)) return reply;
    const [models, pods] = await Promise.all([
      store.listCachedModels(),
      store.listServingPods("inference.llmkube.dev/model").catch(() => []),
    ]);
    const { rows: all, downloading } = cacheRows(models, pods);
    // Percentage via one-shot exec, downloading models only (typically 0-1).
    // Any failure degrades to Downloading-without-number, never an error.
    await Promise.all(downloading.map(async (d) => {
      try {
        const out = await store.execInPod(d.pod, "model-downloader", DOWNLOAD_BYTES_CMD);
        const row = all.find((r) => r.name === d.name);
        if (row) row.progress = progressPct(Number(out.trim()), d.total);
      } catch { /* degrade */ }
    }));
    const { rows, count, offset } = paged(all, req);
    return { cache: rows, count, offset };
  });

  // Committed = sum of max replicas of the deployments on a pool; maxNodes is
  // the budget it must stay under (0/unset = unlimited). Spec 2026-07-11 §3.2.
  const committedByPool = async (): Promise<Record<string, number>> => {
    const committed: Record<string, number> = {};
    for (const d of await store.list("modeldeployments")) {
      const p = d.spec?.poolRef;
      if (p) committed[p] = (committed[p] ?? 0) + (d.spec?.replicas?.max ?? 0);
    }
    return committed;
  };

  // Spec 2026-07-11 §4.2: 0 ≤ min ≤ max, max ≥ 1, 0 ≤ reserve ≤ max − min.
  const replicasError = (r: any): string | null => {
    const { min, max } = r ?? {};
    const reserve = r?.reserve ?? 0;
    if (![min, max, reserve].every(Number.isInteger)) return "replicas needs integer min and max (reserve optional)";
    if (min < 0 || max < 1 || max < min) return "replicas: need 0 <= min <= max and max >= 1";
    if (reserve < 0 || reserve > max - min) return `replicas: reserve must be between 0 and max - min (${max - min})`;
    const idle = r.idleMinutes;
    if (idle != null) {
      if (!Number.isInteger(idle) || idle < 1 || idle > 1440) return "replicas: idleMinutes must be an integer 1-1440";
      if (min !== 0) return "replicas: idleMinutes only applies with min 0";
    }
    return null;
  };
  // §3.2: budget check against the target pool, excluding the deployment's own row on edits.
  const poolBudgetError = async (poolName: string, requestedMax: number, exclude?: string): Promise<string | null> => {
    const pool = await store.get("modelpools", poolName);
    const budget = pool?.spec?.maxNodes ?? 0;
    if (!budget) return null;
    const committed = (await store.list("modeldeployments"))
      .filter((d: any) => d.spec?.poolRef === poolName && d.metadata.name !== exclude)
      .reduce((s: number, d: any) => s + (d.spec?.replicas?.max ?? 0), 0);
    return committed + requestedMax > budget
      ? `pool ${poolName}: committed max replicas ${committed} + requested ${requestedMax} exceeds budget ${budget}`
      : null;
  };

  app.get("/v1/pools", async (_req, reply) => {
    if (localGate(reply)) return reply;
    const [pools, committed] = await Promise.all([store.list("modelpools"), committedByPool()]);
    return { pools: pools.map((p: any) => ({ ...p, committedMaxReplicas: committed[p.metadata.name] ?? 0 })) };
  });

  const DNS1035 = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
  type Toleration = { key?: string; operator?: string; value?: string; effect?: string };
  type PoolBody = { nodeSelector?: Record<string, string>; gpuType?: string;
                    gpusPerNode?: number; maxNodes?: number; tolerations?: Toleration[] };
  const poolSpecOf = (b: PoolBody, reply: any): Record<string, unknown> | null => {
    for (const t of b.tolerations ?? []) {
      if (t.operator && !["Exists", "Equal"].includes(t.operator)) {
        reply.code(400).send({ error: "toleration operator must be Exists or Equal" });
        return null;
      }
      if (t.effect && !["NoSchedule", "PreferNoSchedule", "NoExecute"].includes(t.effect)) {
        reply.code(400).send({ error: "toleration effect must be NoSchedule, PreferNoSchedule or NoExecute" });
        return null;
      }
    }
    const spec: Record<string, unknown> = {};
    if (b.nodeSelector !== undefined) spec.nodeSelector = b.nodeSelector;
    if (b.gpuType !== undefined) spec.gpuType = b.gpuType;
    if (typeof b.gpusPerNode === "number") spec.gpusPerNode = b.gpusPerNode;
    if (typeof b.maxNodes === "number") spec.maxNodes = b.maxNodes;
    if (b.tolerations !== undefined) spec.tolerations = b.tolerations;
    return spec;
  };

  app.post("/v1/pools", async (req, reply) => {
    if (localGate(reply)) return reply;
    const b = req.body as { name?: string } & PoolBody;
    if (!b?.name || b.name.length > 63 || !DNS1035.test(b.name))
      return reply.code(400).send({ error: "name must be DNS-1035: lowercase letters, digits, dashes; start with a letter" });
    const spec = poolSpecOf(b, reply);
    if (!spec) return;
    const created = await store.create("modelpools", {
      apiVersion: "serving.devproof.ai/v1alpha1",
      kind: "ModelPool",
      metadata: { name: b.name, namespace: SERVING_NAMESPACE },
      spec,
    });
    return reply.code(201).send(created);
  });

  app.patch("/v1/pools/:name", async (req, reply) => {
    if (localGate(reply)) return reply;
    const name = (req.params as any).name;
    const current = await store.get("modelpools", name);
    if (!current) return reply.code(404).send({ error: "not found" });
    const spec = poolSpecOf((req.body ?? {}) as PoolBody, reply);
    if (!spec) return;
    if (typeof spec.maxNodes === "number" && spec.maxNodes > 0) {
      const committed = (await committedByPool())[name] ?? 0;
      if (committed > spec.maxNodes)
        return reply.code(400).send({ error: `pool ${name}: committed max replicas ${committed} exceeds new budget ${spec.maxNodes}` });
    }
    if (spec.nodeSelector) {
      // Full replacement under RFC 7386: null out keys the new selector drops.
      const nulls = Object.fromEntries(
        Object.keys(current.spec?.nodeSelector ?? {}).map((k) => [k, null]));
      spec.nodeSelector = { ...nulls, ...(spec.nodeSelector as Record<string, string>) };
    }
    const patched = await store.patch("modelpools", name, { spec });
    return { name, spec: patched.spec };
  });

  app.delete("/v1/pools/:name", async (req, reply) => {
    if (localGate(reply)) return reply;
    const name = (req.params as any).name;
    if (!(await store.get("modelpools", name))) return reply.code(404).send({ error: "not found" });
    const users = (await store.list("modeldeployments"))
      .filter((d: any) => d.spec?.poolRef === name).map((d: any) => d.metadata.name);
    if (users.length)
      return reply.code(409).send({ error: `pool "${name}" is used by: ${users.join(", ")} — undeploy first` });
    await store.delete("modelpools", name);
    await hooks?.onResourceDeleted?.("pool", name).catch(() => {}); // price row is advisory — never fail the delete
    return reply.code(204).send();
  });

  // Merged local (CRD + metrics) + external (global) deployment view.
  const listDeployments = async (): Promise<any[]> => {
    const items = localServing ? await store.list("modeldeployments") : [];
    const { tokens } = localServing ? await fetchServingMetrics() : { tokens: {} as Record<string, number> };
    const { entries: cat } = await fullCatalog();
    const locals = items.map((d: any) => ({
      kind: "local",
      name: d.metadata.name,
      catalogId: d.spec?.catalogId,
      poolRef: d.spec?.poolRef,
      engine: d.spec?.engine,
      contextTokens: d.spec?.model?.contextTokens ?? null,
      // Served window (operator-capped, status-sourced) — may be smaller than
      // contextTokens; null until the operator reports it.
      effectiveContextTokens: d.status?.effectiveContextTokens ?? null,
      resources: d.spec?.resources ?? null,
      replicas: d.spec?.replicas ?? null,
      phase: d.status?.phase ?? "Pending",
      // Display-only overlay on phase (spec 2026-07-15 badges): ScalingUp |
      // ScalingDown | null. Nothing here routes on it — the console renders
      // `activity || phase`.
      activity: d.status?.activity ?? null,
      downloadPercent: d.status?.downloadPercent ?? null,
      endpoint: d.status?.endpoint,
      readyReplicas: d.status?.readyReplicas ?? 0,
      tokensPerSec: tokens[d.metadata.name] ?? null,
      // Scaler-published (spec §4.3): -1/missing = unknown => null; 0 is a value.
      queueDepth: (d.status?.queueDepth ?? -1) >= 0 ? d.status.queueDepth : null,
      reasoning: d.spec?.reasoning ?? null,
      // Efforts the deployment's catalog entry offers NOW (renders the edit
      // select); null when the entry is gone or has no reasoning.
      reasoningOptions: cat.find((e) => e.id === d.spec?.catalogId)?.reasoning?.efforts ?? null,
    }));
    for (const e of externals ? await externals.list() : []) {
      locals.push({
        kind: "external", id: e.id, name: e.name, provider: e.provider, modelId: e.model_id,
        baseUrl: e.base_url, reasoningEffort: e.reasoning_effort ?? null,
        contextTokens: e.context_tokens ?? null,
        phase: "External", activity: null, downloadPercent: null, readyReplicas: 0,
        tokensPerSec: null, queueDepth: null,
      } as any);
    }
    locals.sort((a, b) => a.name.localeCompare(b.name));
    return locals;
  };

  app.get("/v1/deployments", async (req) => {
    const { rows, count, offset } = paged(await listDeployments(), req);
    return { deployments: rows, count, offset };
  });

  app.get("/v1/deployments/:name", async (req, reply) => {
    const d = (await listDeployments()).find((x) => x.name === (req.params as any).name);
    if (!d) return reply.code(404).send({ error: "deployment not found" });
    return d;
  });

  app.post("/v1/deployments", async (req, reply) => {
    if (localGate(reply)) return reply;
    const b = req.body as DeploymentRequest;
    if (b.name === "external") return reply.code(400).send({ error: `"external" is a reserved deployment name` });
    if (externals && await externals.getByName(b.name))
      return reply.code(409).send({ error: `model name "${b.name}" is taken by an external endpoint` });
    // A same-named routing is allowed and shadows this deployment for normal
    // traffic (spec 2026-07-16); no collision check against routings.
    if (b.engine && !["auto", "llama.cpp", "vllm", "sglang"].includes(b.engine))
      return reply.code(400).send({ error: "bad engine" });
    if (b.resources !== undefined) {
      const resErr = resourcesError(b.resources, { requireBoth: false });
      if (resErr) return reply.code(400).send({ error: resErr });
    }
    if (b.replicas) {
      const err = replicasError(b.replicas);
      if (err) return reply.code(400).send({ error: err });
    }
    const budgetErr = await poolBudgetError(b.poolRef, b.replicas?.max ?? 1);
    if (budgetErr) return reply.code(400).send({ error: budgetErr });
    let cr;
    try {
      cr = resolveDeployment((await fullCatalog()).entries, b);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
    let created;
    try {
      created = await store.create("modeldeployments", cr);
    } catch (err: any) {
      if (err?.statusCode === 409 || err?.code === 409 || err?.body?.code === 409)
        return reply.code(409).send({ error: `deployment "${b.name}" already exists` });
      throw err;
    }
    return reply.code(201).send(created);
  });

  app.delete("/v1/deployments/:name", async (req, reply) => {
    if (localGate(reply)) return reply;
    await store.delete("modeldeployments", (req.params as any).name);
    await hooks?.onResourceDeleted?.("deployment", (req.params as any).name).catch(() => {});
    return reply.code(204).send();
  });

  app.delete("/v1/cache/:name", async (req, reply) => {
    if (localGate(reply)) return reply;
    await store.deleteCachedModel((req.params as any).name);
    return reply.code(204).send();
  });

  app.post("/v1/gateway/sync", async () => {
    const changed = await syncGateway();
    const deployments = localServing ? await store.list("modeldeployments") : [];
    const routed = deployments.filter((d: any) => d.status?.phase === "Ready").length
      + (externals ? (await externals.list()).length : 0);
    return { synced: true, routedModels: routed, changed };
  });

  const PROVIDERS: Record<string, { base: string; modelsPath: string }> = {
    openai:     { base: "https://api.openai.com/v1",    modelsPath: "/models" },
    anthropic:  { base: "https://api.anthropic.com",    modelsPath: "/v1/models" },
    openrouter: { base: "https://openrouter.ai/api/v1", modelsPath: "/models" },
    ollama:     { base: "https://ollama.com/v1",        modelsPath: "/models" },
    custom:     { base: "",                             modelsPath: "/models" },
  };

  // Reasoning effort is free text (spec 2026-07-12 rework): vendor
  // vocabularies differ (xhigh, max, none, …) and keep drifting. Sanity-only
  // here — the real validator is the Test connection completion probe.
  const reasoningEffortError = (v: unknown): string | null => {
    if (v == null) return null;
    const t = typeof v === "string" ? v.trim() : null;
    if (t == null || !t || /\s/.test(t) || t.length > 32)
      return "reasoningEffort must be a short value without whitespace (max 32 chars)";
    return null;
  };
  const trimEffort = (v: string | null | undefined) => (typeof v === "string" ? v.trim() : v);

  // Mandatory context-window metadata (fix wave L, spec 2026-07-16): the
  // platform has no idea how big an external model's window is otherwise —
  // external-only routings got no compaction cap at all.
  const CONTEXT_TOKENS_ERR = "contextTokens required (1024-2000000)";
  const contextTokensValid = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 1024 && v <= 2000000;

  app.post("/v1/deployments/external", async (req, reply) => {
    if (!externals) return reply.code(501).send({ error: "external deployments not configured" });
    const b = req.body as { name?: string; provider?: string; baseUrl?: string; modelId?: string;
                            apiKey?: string; reasoningEffort?: string | null; contextTokens?: number };
    if (!b?.name || !b.modelId || !PROVIDERS[b.provider ?? ""])
      return reply.code(400).send({ error: "name, modelId and provider (openai|anthropic|openrouter|ollama|custom) required" });
    if (b.name === "external") return reply.code(400).send({ error: `"external" is a reserved deployment name` });
    if (b.provider === "custom" && !b.baseUrl)
      return reply.code(400).send({ error: "baseUrl required for custom provider" });
    const reErr = reasoningEffortError(b.reasoningEffort);
    if (reErr) return reply.code(400).send({ error: reErr });
    if (!contextTokensValid(b.contextTokens))
      return reply.code(400).send({ error: CONTEXT_TOKENS_ERR });
    if (await externals.getByName(b.name) || (localServing && await store.get("modeldeployments", b.name)))
      return reply.code(409).send({ error: `model name "${b.name}" already exists` });
    // A same-named routing is allowed and shadows this endpoint for normal
    // traffic (spec 2026-07-16); no collision check against routings.
    // Row first (Secret entry key derives from the row id); a Secret-write failure deletes the row — no orphaned credentials either way.
    const hasKey = !!b.apiKey;
    const row = await externals.create({
      name: b.name, provider: b.provider!, baseUrl: b.baseUrl, modelId: b.modelId, hasKey,
      reasoningEffort: trimEffort(b.reasoningEffort) ?? null, contextTokens: b.contextTokens,
    });
    if (hasKey) {
      try { await store.writeProviderKey(envKeyFor(row.id), b.apiKey!); }
      catch (err) { await externals.delete(row.id); throw err; }
    }
    await syncGateway();
    return reply.code(201).send(row);
  });

  app.patch("/v1/deployments/external/:id", async (req, reply) => {
    if (!externals) return reply.code(501).send({ error: "external deployments not configured" });
    const id = (req.params as any).id;
    const b = req.body as { baseUrl?: string; modelId?: string; apiKey?: string;
                            reasoningEffort?: string | null; contextTokens?: number };
    const existing = await externals.get(id);
    if (!existing) return reply.code(404).send({ error: "not found" });
    const reErr = reasoningEffortError(b?.reasoningEffort);
    if (reErr) return reply.code(400).send({ error: reErr });
    if (b?.contextTokens !== undefined && !contextTokensValid(b.contextTokens))
      return reply.code(400).send({ error: CONTEXT_TOKENS_ERR });
    // Phase 1: non-credential fields.
    let row = await externals.update(id, {
      baseUrl: b?.baseUrl, modelId: b?.modelId, reasoningEffort: trimEffort(b?.reasoningEffort),
      contextTokens: b?.contextTokens,
    });
    if (!row) return reply.code(404).send({ error: "not found" });
    if (b?.apiKey) {
      // Secret before the has_key/key_version bump: a Secret failure leaves the
      // row un-rotated (consistent); a bump failure leaves the new value staged
      // but unreferenced until the next config roll — a staged-but-unreferenced entry is healed by DELETE's unconditional cleanup.
      await store.writeProviderKey(envKeyFor(id), b.apiKey);
      row = await externals.update(id, { rotateKey: true });
    }
    await syncGateway();
    return row;
  });

  app.delete("/v1/deployments/external/:id", async (req, reply) => {
    if (!externals) return reply.code(501).send({ error: "external deployments not configured" });
    const row = await externals.delete((req.params as any).id);
    if (!row) return reply.code(404).send({ error: "not found" });
    // Unconditional: deleteProviderKey is idempotent, and this heals the PATCH first-key-add window where a staged Secret entry exists while has_key is still false.
    await store.deleteProviderKey(envKeyFor(row.id));
    await hooks?.onResourceDeleted?.("external", row.id).catch(() => {});
    await syncGateway();
    return reply.code(204).send();
  });

  // Connection probe — runs from the control-plane process, so cluster-internal
  // custom URLs are unreachable in the out-of-cluster dev topology (expected;
  // the probe targets internet providers).
  app.post("/v1/deployments/external/test", async (req, reply) => {
    const b = req.body as { provider?: string; baseUrl?: string; apiKey?: string;
                            modelId?: string; reasoningEffort?: string | null };
    const preset = PROVIDERS[b?.provider ?? ""];
    if (!preset) return reply.code(400).send({ error: "unknown provider" });
    const base = (b.baseUrl || preset.base).replace(/\/$/, "");
    if (!base) return reply.code(400).send({ error: "baseUrl required for custom provider" });
    // Same sanity rule as save — a probe pass must predict a save success.
    const effErr = reasoningEffortError(b.reasoningEffort);
    if (effErr) return { ok: false, detail: effErr };
    const headers: Record<string, string> = b.provider === "anthropic"
      ? { "x-api-key": b.apiKey ?? "", "anthropic-version": "2023-06-01" }
      : b.apiKey ? { Authorization: `Bearer ${b.apiKey}` } : {};
    const eff = typeof b.reasoningEffort === "string" ? b.reasoningEffort.trim() : "";
    try {
      if (eff && b.modelId) {
        // Reasoning value set → tiny real completion with the value in the
        // provider-native slot, so the provider itself validates the
        // vocabulary (spec 2026-07-12 rework §6). Costs a few tokens.
        headers["Content-Type"] = "application/json";
        const [path, body] = b.provider === "anthropic"
          ? ["/v1/messages", { model: b.modelId, max_tokens: 16, output_config: { effort: eff },
                               messages: [{ role: "user", content: "hi" }] }] as const
          : ["/chat/completions", { model: b.modelId, max_tokens: 16,
                                    messages: [{ role: "user", content: "hi" }],
                                    ...(b.provider === "openrouter" ? { reasoning: { effort: eff } }
                                                                    : { reasoning_effort: eff }) }] as const;
        const res = await fetch(base + path, { method: "POST", headers,
          body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
        if (res.ok) return { ok: true, detail: "completion ok — reasoning accepted" };
        const text = (await res.text().catch(() => "")).slice(0, 200);
        return { ok: false, detail: `HTTP ${res.status}${text ? `: ${text}` : ""}` };
      }
      const res = await fetch(base + preset.modelsPath, { headers, signal: AbortSignal.timeout(8000) });
      const suffix = eff && !b.modelId ? " — enter a model id to validate reasoning" : "";
      return { ok: res.ok, detail: res.ok ? `reachable (HTTP ${res.status})${suffix}` : `HTTP ${res.status}` };
    } catch (err: any) {
      return { ok: false, detail: String(err?.cause?.message ?? err?.message ?? err) };
    }
  });

  // Local deployment edit: operational fields + poolRef (spec whitelist).
  app.patch("/v1/deployments/:name", async (req, reply) => {
    if (localGate(reply)) return reply;
    const name = (req.params as any).name;
    const b = (req.body ?? {}) as Record<string, any>;
    const allowed = new Set(["replicas", "contextTokens", "engine", "targetTokensPerSec", "poolRef", "reasoningEffort", "resources"]);
    const extra = Object.keys(b).filter((k) => !allowed.has(k));
    if (extra.length) return reply.code(400).send({ error: `only ${[...allowed].join(", ")} are editable (got: ${extra.join(", ")})` });
    if (b.engine && !["auto", "llama.cpp", "vllm", "sglang"].includes(b.engine)) return reply.code(400).send({ error: "bad engine" });
    if (b.resources !== undefined) {
      const resErr = resourcesError(b.resources, { requireBoth: false });
      if (resErr) return reply.code(400).send({ error: resErr });
    }
    if (b.replicas) {
      const err = replicasError(b.replicas);
      if (err) return reply.code(400).send({ error: err });
    }
    const current = await store.get("modeldeployments", name);
    if (!current) return reply.code(404).send({ error: "not found" });
    if (b.poolRef && !(await store.get("modelpools", b.poolRef)))
      return reply.code(400).send({ error: `unknown pool: ${b.poolRef}` });
    const targetPool = b.poolRef ?? current.spec?.poolRef;
    const newMax = b.replicas?.max ?? current.spec?.replicas?.max ?? 1;
    if (b.replicas || b.poolRef) {
      const budgetErr = await poolBudgetError(targetPool, newMax, name);
      if (budgetErr) return reply.code(400).send({ error: budgetErr });
    }
    // Reasoning: string = re-resolve via the entry's CURRENT catalog mapping;
    // null = clear (merge-patch deletes the key); omitted = untouched.
    let resolvedReasoning: { effort: string; budgetTokens: number } | undefined;
    if (b.reasoningEffort !== undefined && b.reasoningEffort !== null) {
      const entry = (await fullCatalog()).entries.find((e) => e.id === current.spec?.catalogId);
      if (!entry) return reply.code(400).send({ error: `unknown catalog entry: ${current.spec?.catalogId}` });
      const efforts = entry.reasoning?.efforts;
      if (!efforts) return reply.code(400).send({ error: `model does not support configurable reasoning` });
      const budgetTokens = efforts[b.reasoningEffort];
      if (typeof budgetTokens !== "number")
        return reply.code(400).send({ error: `unknown reasoning effort "${b.reasoningEffort}" — valid: ${Object.keys(efforts).join(", ")}` });
      const engine = b.engine ?? current.spec?.engine ?? "auto";
      if (engine !== "auto" && engine !== "llama.cpp")
        return reply.code(400).send({ error: `reasoning is llama.cpp-only (engine: ${engine})` });
      resolvedReasoning = { effort: b.reasoningEffort, budgetTokens };
    }
    const spec: any = {};
    if (b.replicas) spec.replicas = {
      min: b.replicas.min, max: b.replicas.max, reserve: b.replicas.reserve ?? 0,
      ...(b.replicas.idleMinutes != null ? { idleMinutes: b.replicas.idleMinutes } : {}),
    };
    if (b.engine) spec.engine = b.engine;
    if (typeof b.targetTokensPerSec === "number") spec.targetTokensPerSec = b.targetTokensPerSec;
    if (typeof b.contextTokens === "number") spec.model = { contextTokens: b.contextTokens };
    if (b.poolRef) spec.poolRef = b.poolRef;
    // Merge-patch semantics: only the sent keys change; resources.gpu survives.
    if (b.resources) spec.resources = {
      ...(b.resources.cpu != null ? { cpu: b.resources.cpu } : {}),
      ...(b.resources.memory != null ? { memory: b.resources.memory } : {}),
    };
    if (b.reasoningEffort === null) spec.reasoning = null;
    else if (resolvedReasoning) spec.reasoning = resolvedReasoning;
    else if (b.engine && b.engine !== "auto" && b.engine !== "llama.cpp" && current.spec?.reasoning)
      spec.reasoning = null; // engine left llama.cpp — the budget flag no longer applies
    const patched = await store.patch("modeldeployments", name, { spec });
    // Operator reconciles the CR (pods roll) and auto-syncs the gateway route.
    return { name, spec: patched.spec };
  });

  // ── Routings (spec 2026-07-16) — global rule tables in the gateway model
  // namespace. Rule edits are DB-only (hook reads live); create/delete syncs
  // the gateway config so /v1/models lists the name.
  const routingTargetCtx = async () => ({
    localNames: new Set<string>(localServing ? (await store.list("modeldeployments")).map((d: any) => d.metadata.name) : []),
    externalNames: new Set<string>(externals ? (await externals.list()).map((e: any) => e.name) : []),
  });

  app.get("/v1/routings", async (req) => {
    if (!routings) return { routings: [], count: 0, offset: 0 };
    const items = (await routings.list()).map((r: any) => ({
      name: r.name, ruleCount: (r.rules ?? []).length, terminal: r.terminal, updated_at: r.updated_at,
      targets: [...new Set([...(r.rules ?? []).map((x: any) => x.target), ...(r.terminal?.action === "route" ? [r.terminal.target] : [])])],
    }));
    const { rows, count, offset } = paged(items, req);
    return { routings: rows, count, offset };
  });

  app.get("/v1/routings/:name", async (req, reply) => {
    if (!routings) return reply.code(501).send({ error: "routings not configured" });
    const row = await routings.get((req.params as any).name);
    if (!row) return reply.code(404).send({ error: "routing not found" });
    const ctx = await routingTargetCtx();
    const spec: RoutingSpec = { rules: row.rules ?? [], terminal: row.terminal };
    const locals = reachableLocalTargets(spec, ctx.localNames);
    let min: number | null = null;
    for (const t of locals) {
      const d = await store.get("modeldeployments", t);
      const c = d?.status?.effectiveContextTokens ?? null;
      if (c && (min === null || c < min)) min = c;
    }
    // External targets contribute their mandatory context_tokens to the min
    // too (fix wave L) — reachableTargets in the response stays locals-only
    // for console backward-compat; only the min changes.
    for (const t of reachableTargets(spec)) {
      if (ctx.localNames.has(t)) continue;
      const ext = externals ? await externals.getByName(t) : null;
      const c = ext?.context_tokens ?? null;
      if (c != null && (min === null || c < min)) min = c;
    }
    return { ...row, minContextTokens: min, reachableTargets: locals };
  });

  app.post("/v1/routings", async (req, reply) => {
    if (!routings) return reply.code(501).send({ error: "routings not configured" });
    const b = req.body as { name?: string; rules?: unknown; terminal?: unknown };
    if (!b?.name || b.name.length > 63 || !ROUTING_NAME.test(b.name))
      return reply.code(400).send({ error: "name must be DNS-1035: lowercase letters, digits, dashes; start with a letter" });
    if (b.name === "external") return reply.code(400).send({ error: `"external" is a reserved name` });
    if (await routings.get(b.name)) return reply.code(409).send({ error: `routing "${b.name}" already exists` });
    // A routing MAY share a deployment/external name and shadows it for normal
    // traffic (spec 2026-07-16, routing-first resolution) — no collision check.
    const spec = { rules: (b.rules as any) ?? [], terminal: b.terminal as any };
    const err = validateRouting(spec, await routingTargetCtx());
    if (err) return reply.code(400).send({ error: err });
    const row = await routings.create(b.name, spec.rules, spec.terminal);
    await syncGateway(); // the name must appear in /v1/models
    return reply.code(201).send(row);
  });

  app.patch("/v1/routings/:name", async (req, reply) => {
    if (!routings) return reply.code(501).send({ error: "routings not configured" });
    const name = (req.params as any).name;
    const current = await routings.get(name);
    if (!current) return reply.code(404).send({ error: "routing not found" });
    const b = (req.body ?? {}) as { rules?: unknown; terminal?: unknown };
    // Normalize null→undefined so a `rules: null`/`terminal: null` body keeps the
    // current value (validate + store) instead of storing a JSONB null.
    const rules = b.rules ?? undefined;
    const terminal = b.terminal ?? undefined;
    const spec = { rules: rules ?? current.rules ?? [], terminal: terminal ?? current.terminal };
    const err = validateRouting(spec, await routingTargetCtx());
    if (err) return reply.code(400).send({ error: err });
    return routings.update(name, { rules, terminal }); // NO gateway sync — rules are read live
  });

  app.delete("/v1/routings/:name", async (req, reply) => {
    if (!routings) return reply.code(501).send({ error: "routings not configured" });
    const name = (req.params as any).name;
    if (!(await routings.get(name))) return reply.code(404).send({ error: "routing not found" });
    const users = (await routings.agentsReferencing?.(name)) ?? [];
    if (users.length)
      return reply.code(409).send({ error: `routing "${name}" is referenced by agent(s): ${users.join(", ")} — point them at another routing first` });
    await routings.delete(name);
    await syncGateway(); // drop the /v1/models listing → clean 400 for callers
    return reply.code(204).send();
  });

  return app;
}
