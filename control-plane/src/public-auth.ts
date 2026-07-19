// dpk_ API-key auth for the public /api namespace (spec 2026-07-12).
// The gateway's custom_auth also validates pass-through requests (defense in
// depth); this check is the authoritative one. Workspace comes from the key.
import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface ApiKeyRepo {
  findApiKeyBySecretHash(hash: string): Promise<{ id: string; workspace_id: string } | null>;
  touchApiKey(id: string): Promise<void>;
}

const TOUCH_INTERVAL_MS = 60_000;

export function apiKeyAuth(repo: ApiKeyRepo, ttlMs = 30_000) {
  const cache = new Map<string, { id: string; workspaceId: string; expires: number }>();
  const lastTouch = new Map<string, number>();
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const rawAuth = req.headers.authorization;
    const auth = (Array.isArray(rawAuth) ? rawAuth[0] : rawAuth) ?? "";
    const rawApiKey = req.headers["x-api-key"];
    const apiKeyHeader = (Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey) ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : apiKeyHeader;
    if (!key.startsWith("dpk_")) return reply.code(401).send({ error: "invalid API key" });
    const hash = createHash("sha256").update(key).digest("hex");
    let hit = cache.get(hash);
    if (!hit || hit.expires < Date.now()) {
      const row = await repo.findApiKeyBySecretHash(hash);
      if (!row) return reply.code(401).send({ error: "invalid API key" });
      hit = { id: row.id, workspaceId: row.workspace_id, expires: Date.now() + ttlMs };
      cache.set(hash, hit);
    }
    if ((lastTouch.get(hit.id) ?? 0) + TOUCH_INTERVAL_MS < Date.now()) {
      lastTouch.set(hit.id, Date.now());
      repo.touchApiKey(hit.id).catch(() => {}); // fire-and-forget
    }
    (req as any).apiKey = { id: hit.id, workspaceId: hit.workspaceId };
  };
}
