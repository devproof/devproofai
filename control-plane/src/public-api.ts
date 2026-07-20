// control-plane/src/public-api.ts
// Public /api namespace: dpk_-authenticated managed-agents surface reached
// through the gateway pass-through (spec 2026-07-12-public-api-design.md).
// Contract rules: no /v1 segment after /api; uploads are multipart; streamed
// responses are POST {"stream": true}. Handlers wrap the same repo/filestore
// functions as the /v1 UI routes — separation is contract-level only.
import multipart from "@fastify/multipart";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { FileStore } from "./filestore.ts";
import { apiKeyAuth } from "./public-auth.ts";
import { workspaceGuard, PUBLIC_RULES } from "./workspace-guard.ts";
import type { Orchestrator } from "./agents-api.ts";
import type { AgentConfig } from "./repo.ts";
import { validatePodConfig, type PodConfig } from "./pod-config.ts";
import { validateHosts } from "./egress.ts";
import { createSessionAction, sendMessageAction } from "./session-actions.ts";
import { streamSessionEvents } from "./session-sse.ts";
import { shortId } from "./id.ts";
import { credentialSecretKeys, validateCredentialBody, validateMcpServers, mcpHostnames } from "./mcp.ts";
import { validateSubagents, interruptChildSessions } from "./subagents.ts";
import { validateWikiRefs, writeWikiIds } from "./wiki-refs.ts";
import { objectKey, validEntryPath } from "./object-key.ts";
import { seedWikiSkeleton } from "./wiki-seed.ts";
import { storeSkillPackage } from "./skill-upload.ts";
import { deleteSessionFully } from "./session-delete.ts";

export const PART_SIZE = 32 * 1024 * 1024; // 33554432 — verified through the pass-through

const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/** Abort chunked uploads that never completed (frees MinIO parts). */
export async function sweepStaleUploads(repo: any, files: FileStore, olderThanMs = STALE_UPLOAD_MS) {
  for (const u of await repo.listStaleFileUploads(olderThanMs)) {
    try {
      await files.abortUpload?.(objectKey({ kind: "upload", workspaceId: u.workspace_id, fileId: u.file_id }), u.upload_key);
      await repo.deleteFileUpload(u.id);
    } catch (err) {
      console.warn(`upload sweep: ${u.id} failed:`, err); // next sweep retries
    }
  }
}

export async function registerPublicApi(
  app: FastifyInstance, repo: any, orchestrator: Orchestrator, files: FileStore,
  notify?: { subscribe(sessionId: string, fn: () => void): () => void },
  opts?: { modelPhase?: (model: string) => Promise<import("./launch-gate.ts").ModelPhase>;
           releaseWriterSlot?: (sessionId: string) => void;
           mcpRegistry?: import("./mcp.ts").McpRegistryEntry[];
           settleSession?: (id: string) => Promise<void>;
           wakeModel?: (model: string) => Promise<void> },
) {
  const sessionDeps = { repo, orchestrator, modelPhase: opts?.modelPhase, wakeModel: opts?.wakeModel };
  // agents-api registers multipart in production; register here only when
  // running standalone (unit tests, future split deployments).
  if (!app.hasContentTypeParser("multipart/form-data")) {
    await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  }

  await app.register(async (api) => {
    api.addHook("preHandler", apiKeyAuth(repo));
    // Disabled workspaces are read-only on the public surface too. The dpk
    // key resolves the workspace; interrupt + POST-stream reads stay open.
    api.addHook("preHandler", workspaceGuard(repo, (req: any) => req.apiKey?.workspaceId ?? null, PUBLIC_RULES));
    const ws = (req: any): string => req.apiKey.workspaceId;
    const pg = (req: any): { limit: number; offset: number } => {
      const q = (req.query ?? {}) as { offset?: string; limit?: string };
      return {
        limit: Math.min(1000, Math.max(1, Number(q.limit) || 100)),
        offset: Math.max(0, Number(q.offset) || 0),
      };
    };

    // Ownership checks for session inputs (Task 3-style IDOR guards): a
    // caller must not be able to reference another workspace's files or
    // memory store when creating/resuming a session.
    const filesOwned = async (req: any, ids: string[] | undefined): Promise<boolean> => {
      if (!ids?.length) return true;
      const recs = await repo.listFileRecords(ids);
      const owned = recs.filter((r: any) => r.workspace_id === ws(req));
      return owned.length === ids.length;
    };

    // ── Files ────────────────────────────────────────────────────────────
    api.post("/files", async (req: any, reply) => {
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: "multipart file field required" });
      const content = await part.toBuffer();
      const kind = (req.query as any).kind === "output" ? "output" : "upload";
      const id = `file_${shortId()}`;
      const key = objectKey({ kind, workspaceId: ws(req), fileId: id });
      await files.put(content, key);
      const record = await repo.createFileRecord({
        id, name: part.filename ?? id, size: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
        objectKey: key, kind, workspaceId: ws(req),
      });
      return reply.code(201).send(record);
    });

    api.get("/files", async (req: any) => {
      const { limit, offset } = pg(req);
      return repo.listAllFiles(ws(req), { kind: (req.query as any).kind, limit, offset });
    });

    api.get("/files/:id", async (req: any, reply) => {
      const record = await repo.getFileRecord(req.params.id);
      if (!record || record.workspace_id !== ws(req)) return reply.code(404).send({ error: "file not found" });
      return record;
    });

    // Download: POST {"stream": true} streams through the gateway pass-through
    // (plain GET responses are buffered by LiteLLM — verified 2026-07-12).
    api.post("/files/:id/content", async (req: any, reply) => {
      const record = await repo.getFileRecord(req.params.id);
      if (!record || record.workspace_id !== ws(req)) return reply.code(404).send({ error: "file not found" });
      reply.header("Content-Disposition", `attachment; filename="${record.name}"`);
      reply.type("application/octet-stream");
      if (files.getStream) return reply.send(await files.getStream(record.object_key));
      return reply.send(await files.get(record.object_key));
    });

    api.delete("/files/:id", async (req: any, reply) => {
      const { deleted, objectKey: key } = await repo.deleteFile(ws(req), req.params.id);
      if (!deleted) return reply.code(404).send({ error: "file not found" });
      if (key) { try { await files.del(key); } catch { /* best effort */ } }
      return reply.code(204).send();
    });

    // ── Chunked uploads (files > PART_SIZE, up to 4 GB+) ────────────────
    api.post("/files/uploads", async (req: any, reply) => {
      const b = (req.body ?? {}) as { name?: string; kind?: string };
      if (!b.name) return reply.code(400).send({ error: "name required" });
      if (!files.createUpload) return reply.code(501).send({ error: "chunked uploads unavailable on this file store" });
      const fileId = `file_${shortId()}`;
      const key = objectKey({ kind: "upload", workspaceId: ws(req), fileId });
      const uploadKey = await files.createUpload(key);
      const id = `upl_${shortId()}`;
      await repo.createFileUpload(ws(req), { id, fileId, uploadKey, name: b.name, kind: b.kind ?? "upload", partSize: PART_SIZE });
      return reply.code(201).send({ upload_id: id, file_id: fileId, part_size: PART_SIZE });
    });

    api.post("/files/uploads/:id/parts/:n", async (req: any, reply) => {
      const up = await repo.getFileUpload(ws(req), req.params.id);
      if (!up) return reply.code(404).send({ error: "upload not found" });
      const n = Number(req.params.n);
      if (!Number.isInteger(n) || n < 1 || n > 10000) return reply.code(400).send({ error: "part number must be 1..10000" });
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: "multipart file field required" });
      const data = await part.toBuffer();
      const key = objectKey({ kind: "upload", workspaceId: up.workspace_id, fileId: up.file_id });
      const etag = await files.uploadPart!(key, up.upload_key, n, data);
      const partSha = createHash("sha256").update(data).digest("hex");
      await repo.recordUploadPart(up.id, { n, etag, sha256: partSha, size: data.length });
      return { n, etag, sha256: partSha };
    });

    api.post("/files/uploads/:id/complete", async (req: any, reply) => {
      const up = await repo.getFileUpload(ws(req), req.params.id);
      if (!up) return reply.code(404).send({ error: "upload not found" });
      const parts = ([...(up.parts ?? [])] as { n: number; etag: string; sha256: string; size: number }[])
        .sort((a, b) => a.n - b.n);
      if (!parts.length || parts.some((p, i) => p.n !== i + 1)) {
        return reply.code(400).send({ error: "parts must be contiguous starting at 1" });
      }
      const key = objectKey({ kind: "upload", workspaceId: up.workspace_id, fileId: up.file_id });
      await files.completeUpload!(key, up.upload_key, parts.map((p) => ({ n: p.n, etag: p.etag })));
      // Composite hash: sha256 over the concatenated per-part sha256 hex
      // strings. files.sha256 is informational (content addressing removed
      // 2026-07-10); the Python lib computes the same composite to verify.
      const composite = createHash("sha256").update(parts.map((p) => p.sha256).join("")).digest("hex");
      const size = parts.reduce((s, p) => s + Number(p.size), 0);
      const record = await repo.createFileRecord({
        id: up.file_id, name: up.name, size, sha256: composite, objectKey: key, kind: up.kind, workspaceId: ws(req),
      });
      await repo.deleteFileUpload(up.id);
      return reply.code(201).send(record);
    });

    api.delete("/files/uploads/:id", async (req: any, reply) => {
      const up = await repo.getFileUpload(ws(req), req.params.id);
      if (!up) return reply.code(404).send({ error: "upload not found" });
      const key = objectKey({ kind: "upload", workspaceId: up.workspace_id, fileId: up.file_id });
      await files.abortUpload?.(key, up.upload_key);
      await repo.deleteFileUpload(up.id);
      return reply.code(204).send();
    });

    // ── Skills (port of agents-api.ts:230-277) ───────────────────────────
    // A skill is a package: a single SKILL.md, or a Claude Code skill ZIP
    // (SKILL.md + scripts/resources). Both become a file manifest.
    api.post("/skills", async (req: any, reply) => {
      const part = await req.file();
      const fname: string = part?.filename ?? "";
      const name = (req.query as any).name ?? fname.replace(/\.(md|zip)$/i, "");
      if (!part || !name) return reply.code(400).send({ error: "multipart file + name required" });
      const result = await storeSkillPackage({ repo, files }, ws(req), name, fname, await part.toBuffer());
      if ("error" in result) return reply.code(400).send({ error: result.error });
      return reply.code(201).send(result.skill);
    });

    api.get("/skills", async (req: any) => {
      const { limit, offset } = pg(req);
      return { skills: await repo.listSkills(ws(req), undefined, limit, offset), count: await repo.countSkills(ws(req)), offset };
    });

    api.get("/skills/:id", async (req: any, reply) => {
      const skill = await repo.getSkill(ws(req), req.params.id);
      if (!skill) return reply.code(404).send({ error: "not found" });
      return { skill };
    });

    api.delete("/skills/:id", async (req: any, reply) => {
      // Sessions resolve skills by id at launch: deleting a referenced skill
      // would silently launch skill-less sessions (mirrors the environment 409).
      if (await repo.skillInUse(req.params.id)) {
        return reply.code(409).send({ error: "skill is in use by one or more agents" });
      }
      for (const fid of await repo.deleteSkill(ws(req), req.params.id)) {
        const key = await repo.deleteFileRecordById(fid).catch(() => null);
        if (key) await Promise.resolve(files.del(key)).catch(() => {});
      }
      return reply.code(204).send();
    });

    api.get("/mcp-registry", async () => ({ servers: opts?.mcpRegistry ?? [] }));

    // ── Vaults (port of agents-api.ts:279-323) ───────────────────────────
    // Vaults: named secret bundles backed by K8s Secrets, injected into
    // session pods as env vars; values are write-only through this API.
    api.post("/vaults", async (req: any, reply) => {
      const b = (req.body ?? {}) as { name: string; secrets?: Record<string, string> };
      if (!b?.name) return reply.code(400).send({ error: "name required" });
      const vault = await repo.createVault(ws(req), b.name);
      await orchestrator.writeVaultSecret(vault.id, b.secrets ?? {});
      for (const key of Object.keys(b.secrets ?? {})) await repo.addVaultCredential(vault.id, key);
      return reply.code(201).send(vault);
    });

    api.get("/vaults/:id", async (req: any, reply) => {
      const vault = await repo.getVault(ws(req), req.params.id);
      if (!vault) return reply.code(404).send({ error: "not found" });
      return { vault, credentials: await repo.listVaultCredentials(vault.id) };
    });
    api.post("/vaults/:id/credentials", async (req: any, reply) => {
      const vault = await repo.getVault(ws(req), req.params.id);
      if (!vault) return reply.code(404).send({ error: "not found" });
      const cred = validateCredentialBody(req.body);
      if ("error" in cred) return reply.code(400).send({ error: cred.error });
      // Same name+type+server = rotate; a name reused for anything else is a conflict.
      const existing = await repo.getVaultCredential(req.params.id, cred.name);
      if (existing && (existing.type !== cred.type ||
          (existing.mcp_server_url ?? null) !== (cred.mcpServerUrl ?? null))) {
        return reply.code(409).send({ error: `credential "${cred.name}" already exists with a different type or server` });
      }
      // Distinct names must not derive overlapping Secret keys (e.g. an
      // env-var literally named DEVPROOF_CRED_X_TOKEN vs. a bearer credential
      // named X). Compare full derived key sets, not just this call's payload.
      const mine = new Set(credentialSecretKeys(cred.name, cred.type));
      const clash = (await repo.listVaultCredentials(req.params.id)).find((c: any) =>
        c.name !== cred.name && credentialSecretKeys(c.name, c.type).some((k) => mine.has(k)));
      if (clash) {
        return reply.code(409).send({ error: `credential "${cred.name}" would collide with "${clash.name}" (same derived secret key)` });
      }
      for (const [key, value] of Object.entries(cred.secrets)) {
        await orchestrator.putVaultSecretKey(req.params.id, key, value);
      }
      await repo.addVaultCredential(req.params.id, cred.name, cred.type, cred.mcpServerUrl ?? null, cred.mcpServerName ?? null);
      return reply.code(201).send({ name: cred.name, type: cred.type });
    });
    api.delete("/vaults/:id/credentials/:name", async (req: any, reply) => {
      const vault = await repo.getVault(ws(req), req.params.id);
      if (!vault) return reply.code(404).send({ error: "not found" });
      const existing = await repo.getVaultCredential(req.params.id, req.params.name);
      // Remove every key the credential may own (unwritten keys no-op).
      for (const key of credentialSecretKeys(req.params.name, existing?.type ?? "environment_variable")) {
        await orchestrator.removeVaultSecretKey(req.params.id, key);
      }
      await repo.removeVaultCredential(req.params.id, req.params.name);
      return reply.code(204).send();
    });

    api.get("/vaults", async (req: any) => {
      const { limit, offset } = pg(req);
      const { rows, count } = await repo.listVaults(ws(req), limit, offset);
      return { vaults: rows, count, offset };
    });

    api.delete("/vaults/:id", async (req: any, reply) => {
      const vault = await repo.getVault(ws(req), req.params.id);
      if (!vault) return reply.code(404).send({ error: "not found" });
      await orchestrator.deleteVaultSecret(req.params.id);
      await repo.deleteVault(ws(req), req.params.id);
      return reply.code(204).send();
    });

    // ── Memory stores (port of agents-api.ts:325-386) ────────────────────
    api.post("/memory-stores", async (req: any, reply) => {
      const b = (req.body ?? {}) as { name: string };
      if (!b?.name) return reply.code(400).send({ error: "name required" });
      return reply.code(201).send(await repo.createMemoryStore(ws(req), b.name));
    });

    api.get("/memory-stores", async (req: any) => {
      const { limit, offset } = pg(req);
      const { rows, count } = await repo.listMemoryStores(ws(req), limit, offset);
      return { stores: rows, count, offset };
    });

    api.delete("/memory-stores/:id", async (req: any, reply) => {
      for (const fid of await repo.deleteMemoryStore(ws(req), req.params.id)) {
        const key = await repo.deleteFileRecordById(fid).catch(() => null);
        if (key) await Promise.resolve(files.del(key)).catch(() => {});
      }
      return reply.code(204).send();
    });

    api.delete("/memory-stores/:id/entries", async (req: any, reply) => {
      const storeId = req.params.id;
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

    // Add a memory entry directly (multipart file → entry).
    api.post("/memory-stores/:id/entries", async (req: any, reply) => {
      const storeId = req.params.id;
      const store = await repo.getMemoryStore(storeId, ws(req));
      if (!store) return reply.code(404).send({ error: "memory store not found" });
      const part = await req.file();
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

    // SECURITY (Task 3 review): the /v1 tree/content handlers are unscoped
    // (repo.getMemoryEntries(id) with no workspace check) — the public
    // surface must not carry that hole. Look the store up scoped first.
    api.get("/memory-stores/:id/tree", async (req: any, reply) => {
      const store = await repo.getMemoryStore(req.params.id, ws(req));
      if (!store) return reply.code(404).send({ error: "memory store not found" });
      return { entries: await repo.getMemoryEntries(req.params.id) };
    });

    api.get("/memory-stores/:id/content", async (req: any, reply) => {
      const store = await repo.getMemoryStore(req.params.id, ws(req));
      if (!store) return reply.code(404).send({ error: "memory store not found" });
      const { path } = req.query as { path?: string };
      if (!path) return reply.code(400).send({ error: "path query required" });
      const entry = await repo.getMemoryEntry(req.params.id, path);
      if (!entry) return reply.code(404).send({ error: "no such memory entry" });
      const rec = await repo.getFileRecord(entry.file_id);
      if (!rec) return reply.code(404).send({ error: "memory content missing" });
      return reply.type("text/plain").send(await files.get(rec.object_key));
    });

    // ── LLM wikis (port of agents-api.ts wiki routes) ────────────────────
    api.post("/wikis", async (req: any, reply) => {
      const b = (req.body ?? {}) as { name?: string; description?: string };
      if (!b?.name) return reply.code(400).send({ error: "name required" });
      const wiki = await repo.createWiki(ws(req), b.name, b.description ?? "");
      await seedWikiSkeleton(repo, files, ws(req), wiki.id, wiki.name, b.description ?? "");
      return reply.code(201).send(wiki);
    });

    api.get("/wikis", async (req: any) => {
      const { limit, offset } = pg(req);
      const { rows, count } = await repo.listWikis(ws(req), limit, offset);
      return { wikis: rows, count, offset };
    });

    api.get("/wikis/:id", async (req: any, reply) => {
      const wiki = await repo.getWiki(req.params.id, ws(req));
      if (!wiki) return reply.code(404).send({ error: "wiki not found" });
      return { wiki };
    });

    api.patch("/wikis/:id", async (req: any, reply) => {
      const wiki = await repo.updateWiki(ws(req), req.params.id, (req.body ?? {}) as any);
      if (!wiki) return reply.code(404).send({ error: "wiki not found" });
      return { wiki };
    });

    api.delete("/wikis/:id", async (req: any, reply) => {
      const id = req.params.id;
      if (!(await repo.getWiki(id, ws(req)))) return reply.code(404).send({ error: "wiki not found" });
      if (await repo.wikiInUse(id)) return reply.code(409).send({ error: "wiki is attached to one or more agents" });
      for (const fid of await repo.deleteWiki(ws(req), id)) {
        const key = await repo.deleteFileRecordById(fid).catch(() => null);
        if (key) await Promise.resolve(files.del(key)).catch(() => {});
      }
      return reply.code(204).send();
    });

    api.delete("/wikis/:id/entries", async (req: any, reply) => {
      const wikiId = req.params.id;
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

    api.post("/wikis/:id/entries", async (req: any, reply) => {
      const wikiId = req.params.id;
      if (!(await repo.getWiki(wikiId, ws(req)))) return reply.code(404).send({ error: "wiki not found" });
      const part = await req.file();
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

    api.get("/wikis/:id/tree", async (req: any, reply) => {
      const wiki = await repo.getWiki(req.params.id, ws(req));
      if (!wiki) return reply.code(404).send({ error: "wiki not found" });
      return { entries: await repo.getWikiEntries(req.params.id) };
    });

    api.get("/wikis/:id/content", async (req: any, reply) => {
      const wiki = await repo.getWiki(req.params.id, ws(req));
      if (!wiki) return reply.code(404).send({ error: "wiki not found" });
      const { path } = req.query as { path?: string };
      if (!path) return reply.code(400).send({ error: "path query required" });
      const entry = await repo.getWikiEntry(req.params.id, path);
      if (!entry) return reply.code(404).send({ error: "no such wiki entry" });
      const rec = await repo.getFileRecord(entry.file_id);
      if (!rec) return reply.code(404).send({ error: "wiki content missing" });
      return reply.type("text/plain").send(await files.get(rec.object_key));
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

    // ── Environments (port of agents-api.ts:162-204) ─────────────────────
    api.post("/environments", async (req: any, reply) => {
      const b = (req.body ?? {}) as { name: string; allowPackageManagers?: boolean; allowedHosts?: string[]; pod?: unknown; allowMcpServers?: boolean };
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

    api.patch("/environments/:id", async (req: any, reply) => {
      const b = (req.body ?? {}) as { name?: string; allowPackageManagers?: boolean; allowedHosts?: string[]; pod?: unknown; allowMcpServers?: boolean };
      if (b.pod !== undefined) {
        const { maxWorkGb } = await repo.getLimits();
        const podErr = validatePodConfig(b.pod, { maxWorkGb });
        if (podErr) return reply.code(400).send({ error: podErr });
      }
      const hostErr = validateHosts(b.allowedHosts);
      if (hostErr) return reply.code(400).send({ error: hostErr });
      const row = await repo.updateEnvironment(ws(req), req.params.id, { ...b, pod: b.pod as PodConfig | undefined });
      if (!row) return reply.code(404).send({ error: "environment not found" });
      // Reload the Squid allowlist for the (possibly running) proxy.
      await syncEnvPolicy(row);
      return row;
    });

    api.get("/environments", async (req: any) => {
      const { limit, offset } = pg(req);
      const { rows, count } = await repo.listEnvironments(ws(req), limit, offset);
      return { environments: rows, count, offset };
    });

    api.delete("/environments/:id", async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const env = await repo.getEnvironment(id);
      if (!env || env.workspace_id !== ws(req)) return reply.code(404).send({ error: "environment not found" });
      // Environments are mandatory for agents: deleting a referenced one
      // would strand every referencing agent — block instead.
      if (await repo.environmentInUse(id)) {
        return reply.code(409).send({ error: "environment is in use by one or more agents" });
      }
      await orchestrator.deleteEnvironmentResources(id);
      await repo.deleteEnvironment(ws(req), id);
      return reply.code(204).send();
    });

    // ── Agents (port of agents-api.ts:153-160, 402-450) ─────────────────
    api.post("/agents", async (req: any, reply) => {
      const b = (req.body ?? {}) as { name: string } & AgentConfig;
      if (!b?.name || !b?.routing) return reply.code(400).send({ error: "name and routing required" });
      if (!(await repo.getRoutingByName(b.routing))) return reply.code(400).send({ error: "routing must reference an existing routing" });
      if (!b.environmentId) return reply.code(400).send({ error: "environmentId required" });
      const env = await repo.getEnvironment(b.environmentId);
      if (!env || env.workspace_id !== ws(req)) return reply.code(400).send({ error: "unknown environment" });
      const missingSkills = await repo.missingSkillIds(ws(req), b.skillIds ?? []);
      if (missingSkills.length) return reply.code(400).send({ error: `unknown skill ids: ${missingSkills.join(", ")}` });
      const mcpErr = validateMcpServers(b.mcpServers);
      if (mcpErr) return reply.code(400).send({ error: mcpErr });
      const subErr = await validateSubagents(repo, ws(req), null, b.subagents);
      if (subErr) return reply.code(400).send({ error: subErr });
      const wikiLock = await repo.acquireWikiWriteLock(writeWikiIds(b.wikiRefs)); // B4: atomic writer claim
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

    api.get("/agents", async (req: any) => {
      const { limit, offset } = pg(req);
      const { rows, count } = await repo.listAgents(ws(req), limit, offset);
      return { agents: rows, count, offset };
    });

    api.get("/agents/:id", async (req: any, reply) => {
      const agent = await repo.getAgentWithVersions(req.params.id, ws(req));
      if (!agent) return reply.code(404).send({ error: "agent not found" });
      return agent;
    });

    api.post("/agents/:id/versions", async (req: any, reply) => {
      const b = req.body as AgentConfig;
      // The agent must belong to the caller's workspace — otherwise a new
      // version could be written onto another tenant's agent (version lookups
      // are keyed by agent_id, so it would become that agent's active config).
      if (!(await repo.getAgent(ws(req), req.params.id))) return reply.code(404).send({ error: "agent not found" });
      if (!b?.routing || !(await repo.getRoutingByName(b.routing))) return reply.code(400).send({ error: "routing must reference an existing routing" });
      if (!b.environmentId) return reply.code(400).send({ error: "environmentId required" });
      const env = await repo.getEnvironment(b.environmentId);
      if (!env || env.workspace_id !== ws(req)) return reply.code(400).send({ error: "unknown environment" });
      const missingSkills = await repo.missingSkillIds(ws(req), b.skillIds ?? []);
      if (missingSkills.length) return reply.code(400).send({ error: `unknown skill ids: ${missingSkills.join(", ")}` });
      const mcpErr = validateMcpServers(b.mcpServers);
      if (mcpErr) return reply.code(400).send({ error: mcpErr });
      const subErr = await validateSubagents(repo, ws(req), req.params.id, b.subagents);
      if (subErr) return reply.code(400).send({ error: subErr });
      const wikiLock = await repo.acquireWikiWriteLock(writeWikiIds(b.wikiRefs)); // B4: atomic writer claim
      let prev: any, version: number;
      try {
        const wikiErr = await validateWikiRefs(repo, ws(req), req.params.id, b.wikiRefs);
        if (wikiErr) return reply.code(wikiErr.code).send({ error: wikiErr.error });
        prev = await repo.getAgentVersion(req.params.id);
        version = await repo.newAgentVersion(ws(req), req.params.id, b);
      } finally {
        await wikiLock.release();
      }
      await syncEnvPolicy(env);
      if (prev?.environment_id && prev.environment_id !== b.environmentId) {
        const prevEnv = await repo.getEnvironment(prev.environment_id);
        if (prevEnv) await syncEnvPolicy(prevEnv); // drop the moved agent's hosts
      }
      return reply.code(201).send({ id: req.params.id, version });
    });

    // Rename only — name is row metadata, not part of the versioned config.
    api.patch("/agents/:id", async (req: any, reply) => {
      const { name } = (req.body ?? {}) as { name?: string };
      if (!name?.trim()) return reply.code(400).send({ error: "name required" });
      const res = await repo.renameAgent(ws(req), req.params.id, name.trim());
      if (res === "notfound") return reply.code(404).send({ error: "agent not found" });
      if (res === "conflict") return reply.code(409).send({ error: "name already taken" });
      return { ok: true };
    });

    api.post("/agents/:id/status", async (req: any, reply) => {
      const { status } = (req.body ?? {}) as { status?: string };
      if (!["active", "disabled"].includes(status ?? "")) return reply.code(400).send({ error: "bad status" });
      const ok = await repo.setAgentStatus(ws(req), req.params.id, status!);
      if (!ok) return reply.code(404).send({ error: "agent not found" });
      return { ok: true };
    });

    api.delete("/agents/:id", async (req: any, reply) => {
      // Cascades sessions/versions (FKs). Stop any running session pods first,
      // and drop each session's durable /work PVC (the row cascade can't).
      const { rows: sessions } = await repo.listSessions(ws(req), req.params.id);
      await Promise.allSettled(sessions.flatMap((s: any) =>
        [orchestrator.stopSession(s.id), orchestrator.deleteSessionResources(s.id)]));
      for (const s of sessions) {
        const keys = await repo.deleteSession(ws(req), s.id);
        for (const key of keys) { try { await files.del(key); } catch { /* best effort */ } }
      }
      await repo.deleteAgent(ws(req), req.params.id);
      return reply.code(204).send();
    });

    // ── Sessions — via the shared actions (Task 4) ──────────────────────
    api.post("/sessions", async (req: any, reply) => {
      const b = (req.body ?? {}) as { files?: string[]; memoryStore?: string };
      if (!(await filesOwned(req, b.files))) return reply.code(400).send({ error: "unknown file id in files[]" });
      if (b.memoryStore && !(await repo.getMemoryStore(b.memoryStore, ws(req)))) {
        return reply.code(404).send({ error: "memory store not found" });
      }
      const r = await createSessionAction(sessionDeps, ws(req), req.body ?? {});
      return reply.code(r.code).send(r.body);
    });
    api.post("/sessions/:id/messages", async (req: any, reply) => {
      const s = await repo.getSession(req.params.id, ws(req));
      if (!s) return reply.code(404).send({ error: "session not found" });
      const b = (req.body ?? {}) as { files?: string[] };
      if (!(await filesOwned(req, b.files))) return reply.code(400).send({ error: "unknown file id in files[]" });
      const r = await sendMessageAction(sessionDeps, ws(req), req.params.id, req.body ?? {});
      return reply.code(r.code).send(r.body);
    });
    api.get("/sessions", async (req: any) => {
      const { limit, offset } = pg(req);
      const { rows, count } = await repo.listSessions(ws(req), req.query.agent, limit, offset, req.query.file);
      return { sessions: rows, count, offset };
    });
    api.get("/sessions/:id", async (req: any, reply) => {
      const session = await repo.getSession(req.params.id, ws(req));
      if (!session) return reply.code(404).send({ error: "session not found" });
      return session;
    });
    api.get("/sessions/:id/resources", async (req: any, reply) => {
      const r = await repo.sessionResources(req.params.id, ws(req));
      if (!r) return reply.code(404).send({ error: "session not found" });
      return r;
    });
    api.post("/sessions/:id/interrupt", async (req: any, reply) => {
      const session = await repo.getSession(req.params.id, ws(req));
      if (!session) return reply.code(404).send({ error: "session not found" });
      await orchestrator.stopSession(req.params.id);
      const wasRunning = session.status === "running";
      await repo.setSessionStatus(req.params.id, "idle");
      // Only settle a turn that was actually running — a duplicate/late interrupt
      // on an already-terminal session would otherwise bill phantom time.
      if (wasRunning) await opts?.settleSession?.(req.params.id).catch(() => {});
      opts?.releaseWriterSlot?.(req.params.id);
      await repo.appendEvents(req.params.id, [{ type: "session.interrupted", payload: { by: "api" } }]);
      await interruptChildSessions({ repo, orchestrator }, req.params.id, opts?.settleSession);
      return { ok: true, status: "idle" };
    });
    api.delete("/sessions/:id", async (req: any, reply) => {
      const s = await repo.getSession(req.params.id, ws(req));
      if (!s) return reply.code(404).send({ error: "session not found" });
      await deleteSessionFully({ repo, orchestrator, files }, ws(req), req.params.id);
      return reply.code(204).send();
    });
    api.get("/sessions/:id/events", async (req: any, reply) => {
      const s = await repo.getSession(req.params.id, ws(req));
      if (!s) return reply.code(404).send({ error: "session not found" });
      return { events: await repo.listEvents(req.params.id, Number(req.query.after ?? 0)) };
    });
    // Streamed events: POST {"stream": true} (pass-through requirement).
    // Without stream:true this degrades to the poll shape (lib fallback).
    api.post("/sessions/:id/events/stream", async (req: any, reply) => {
      const s = await repo.getSession(req.params.id, ws(req));
      if (!s) return reply.code(404).send({ error: "session not found" });
      const b = (req.body ?? {}) as { stream?: boolean; after?: number };
      if (!b.stream) return { events: await repo.listEvents(req.params.id, Number(b.after ?? 0)) };
      return streamSessionEvents(req, reply, repo, notify, req.params.id, Number(b.after ?? 0));
    });
  }, { prefix: "/api" });
}
