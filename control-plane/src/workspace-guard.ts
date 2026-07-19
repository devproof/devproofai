// Read-only enforcement for disabled workspaces (spec 2026-07-13).
// One TTL-cached status lookup per (workspace, ttl window); GET/HEAD/OPTIONS
// always pass. Rules are POSITIVE prefix lists — routes outside them (Serving,
// /internal, workspace management itself) are never touched, so the guard
// cannot break global surfaces regardless of hook registration order.
import type { FastifyReply, FastifyRequest } from "fastify";

export interface WorkspaceStatusRepo {
  getWorkspace(id: string): Promise<{ id: string; status?: string } | null>;
}

export interface GuardRules {
  /** Only route urls matching this are status-checked. */
  guarded(url: string): boolean;
  /** Escape hatch inside the guarded set. */
  exempt(url: string): boolean;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export function workspaceGuard(
  repo: WorkspaceStatusRepo,
  resolve: (req: any) => string | null,
  rules: GuardRules,
  ttlMs = 10_000,
) {
  const cache = new Map<string, { status: string | null; expires: number }>();
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (SAFE.has(req.method)) return;
    // routeOptions.url is the route PATTERN ("/v1/sessions/:id/interrupt").
    const url: string = (req as any).routeOptions?.url ?? req.url;
    if (!rules.guarded(url) || rules.exempt(url)) return;
    const wsId = resolve(req);
    if (!wsId) return;
    let hit = cache.get(wsId);
    if (!hit || hit.expires < Date.now()) {
      const row = await repo.getWorkspace(wsId);
      hit = { status: row ? (row.status ?? "active") : null, expires: Date.now() + ttlMs };
      cache.set(wsId, hit);
    }
    if (hit.status === null || hit.status === "deleted")
      return reply.code(404).send({ error: "workspace not found" });
    if (hit.status === "deleting")
      return reply.code(409).send({ error: "workspace is being deleted" });
    if (hit.status !== "active")
      return reply.code(409).send({ error: "workspace disabled" });
  };
}

const CONSOLE_PREFIXES = ["/v1/agents", "/v1/sessions", "/v1/files", "/v1/skills", "/v1/vaults",
                          "/v1/memory-stores", "/v1/wikis", "/v1/environments", "/v1/webhooks", "/v1/api-keys"];
const CONSOLE_EXEMPT = new Set([
  "/v1/sessions/:id/interrupt", // emergency brake stays available while disabled
  "/v1/sessions/:id/events",    // ↓ runner callbacks: running turns must
  "/v1/sessions/:id/status",    //   complete, checkpoint, and sync memory
  "/v1/sessions/:id/outputs",   //   on a disabled workspace
  "/v1/sessions/:id/memory",
  "/v1/sessions/:id/wiki",      //   wiki write-back (writer session)
  "/v1/files/raw",              // runner checkpoint upload
]);

/** agents-api (/v1 console surface): workspace-scoped prefixes only. */
export const CONSOLE_RULES: GuardRules = {
  guarded: (url) => CONSOLE_PREFIXES.some((p) => url === p || url.startsWith(p + "/")),
  exempt: (url) => CONSOLE_EXEMPT.has(url),
};

/** public-api (dpk keys): every route is workspace-scoped; three reads ride POST
 *  (LiteLLM buffers plain GET through the gateway pass-through, verified
 *  2026-07-12): interrupt, the streamed events poll, and file content download. */
export const PUBLIC_RULES: GuardRules = {
  guarded: () => true,
  exempt: (url) => url.endsWith("/interrupt") || url.endsWith("/events/stream") || url.endsWith("/files/:id/content"),
};
