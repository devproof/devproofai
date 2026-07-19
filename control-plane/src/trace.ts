// Ephemeral live-trace fan-out (spec 2026-07-10 deployment monitoring & trace).
// The gateway POSTs truncated request/response/error events here — ONLY while a
// trace window is open (it polls trace_subscriptions). Events are never stored;
// this hub is in-memory and lossy by design.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

export interface TraceEvent {
  // deployment is null for a reject/unavailable routing verdict — no
  // deployment was ever resolved; the routing name is the only key.
  id?: string; kind: "request" | "response" | "error"; deployment: string | null;
  routing?: string; target?: string; rule?: number;
  ts?: string; [k: string]: unknown;
}

export class TraceHub {
  private subs = new Map<string, Set<(e: TraceEvent) => void>>();
  subscribe(deployment: string, fn: (e: TraceEvent) => void): () => void {
    let set = this.subs.get(deployment);
    if (!set) { set = new Set(); this.subs.set(deployment, set); }
    set.add(fn);
    return () => { set!.delete(fn); if (set!.size === 0) this.subs.delete(deployment); };
  }
  publish(e: TraceEvent) {
    if (e.deployment) this.subs.get(e.deployment)?.forEach((fn) => fn(e));
    if (e.routing && e.routing !== e.deployment) this.subs.get(e.routing)?.forEach((fn) => fn(e));
  }
}

const CALLBACK =
  process.env.DEVPROOF_TRACE_CALLBACK_URL ?? process.env.DEVPROOF_CALLBACK_URL ?? "http://host.docker.internal:7080";

export function registerTraceRoutes(
  app: FastifyInstance,
  repo: {
    upsertTraceSubscription(id: string, target: { deployment?: string; routing?: string }, url: string): Promise<void>;
    deleteTraceSubscription(id: string): Promise<void>;
  },
  hub: TraceHub,
) {
  // Gateway-facing ingest. Bearer auth against the internal key when configured
  // (same phase-1 posture as runner callbacks when it isn't).
  app.post("/internal/trace-events", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const key = process.env.DEVPROOF_INTERNAL_KEY;
    if (key && req.headers.authorization !== `Bearer ${key}`) {
      return reply.code(401).send({ error: "internal key required" });
    }
    for (const e of ((req.body as any)?.events ?? []) as TraceEvent[]) {
      // A rejected/unavailable routing verdict has no resolved deployment
      // (deployment: null) — the routing name is the only key, so accept
      // either.
      if ((e?.deployment || e?.routing) && e?.kind) hub.publish(e);
    }
    return reply.code(202).send({ ok: true });
  });

  // Browser-facing SSE. Opening this stream IS the capture switch: the
  // subscription row it maintains is what makes the gateway start emitting.
  const streamFor = (hubKey: string, target: { deployment?: string; routing?: string }) =>
    async (req: any, reply: any) => {
      const subId = `trace_${randomUUID()}`;
      // Attach BEFORE any await: a disconnect during the initial upsert must not
      // be lost (one-shot event), or the heartbeat/subscription leak forever.
      let closed = false;
      let signalClose = () => { closed = true; };
      const closedP = new Promise<void>((resolve) => {
        signalClose = () => { closed = true; resolve(); };
      });
      req.raw.on("close", () => signalClose());
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Content-Encoding": "identity",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      });
      let heartbeat: NodeJS.Timeout | undefined;
      let unsub: (() => void) | undefined;
      try {
        await repo.upsertTraceSubscription(subId, target, CALLBACK);
        if (!closed) {
          heartbeat = setInterval(() => {
            repo.upsertTraceSubscription(subId, target, CALLBACK).catch(() => { /* next beat retries */ });
            reply.raw.write(": ka\n\n");
          }, 5000);
          unsub = hub.subscribe(hubKey, (e) => {
            reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
          });
          await closedP;
        }
      } catch { /* early failure: close the stream; the EventSource client retries */ }
      finally {
        if (heartbeat) clearInterval(heartbeat);
        unsub?.();
        await repo.deleteTraceSubscription(subId).catch(() => { /* 15s TTL cleans up */ });
        reply.raw.end();
      }
      return reply;
    };

  app.get("/v1/deployments/:name/trace/stream", async (req, reply) => {
    const name = (req.params as any).name as string;
    return streamFor(name, { deployment: name })(req, reply);
  });
  app.get("/v1/routings/:name/trace/stream", async (req, reply) => {
    const name = (req.params as any).name as string;
    return streamFor(name, { routing: name })(req, reply);
  });
}
