// Workspace deletion runner (spec 2026-07-13). Drains all resources of a
// 'deleting' workspace batch-wise in FK-safe order, then tombstones the row
// (status='deleted'; id+name survive so gateway_usage stays attributable —
// gateway_usage itself is NEVER touched). Every step deletes-if-exists, so
// the runner is resumable: sweepDeletingWorkspaces (boot) re-runs half-done
// drains after a CP restart. Progress needs no bookkeeping — the deletion
// endpoint compares live row counts against the delete_totals snapshot.
import type { Orchestrator } from "./agents-api.ts";
import type { FileStore } from "./filestore.ts";
import { objectKey } from "./object-key.ts";

const BATCH = 100;

/** Narrow structural surface the deletion runner needs from Repo. */
export interface WorkspaceDeleteRepo {
  workspaceRowIds(table: string, workspaceId: string, limit?: number): Promise<string[]>;
  deleteSession(workspaceId: string, id: string): Promise<string[]>;
  deleteSkill(workspaceId: string, id: string): Promise<string[]>;
  deleteMemoryStore(workspaceId: string, id: string): Promise<string[]>;
  deleteWiki(workspaceId: string, id: string): Promise<string[]>;
  deleteFile(workspaceId: string, id: string): Promise<{ deleted: boolean; objectKey: string | null }>;
  deleteEnvironment(workspaceId: string, id: string): Promise<void>;
  deleteVault(workspaceId: string, id: string): Promise<void>;
  deleteAgent(workspaceId: string, id: string): Promise<void>;
  deleteWorkspaceWebhooks(workspaceId: string): Promise<void>;
  softDeleteWorkspaceApiKeys(workspaceId: string): Promise<void>;
  listWorkspaceFileUploads(workspaceId: string, limit?: number): Promise<{ id: string; upload_key: string; file_id: string }[]>;
  deleteFileUpload(id: string): Promise<void>;
  setWorkspaceStatus(id: string, status: string): Promise<boolean>;
  listWorkspaces(includeDeleted?: boolean): Promise<{ id: string; status: string }[]>;
  workspaceResourceCounts(id: string): Promise<Record<string, number>>;
}

async function drain(repo: WorkspaceDeleteRepo, table: string, wsId: string, each: (id: string) => Promise<void>) {
  for (;;) {
    const ids: string[] = await repo.workspaceRowIds(table, wsId, BATCH);
    if (!ids.length) return;
    for (const id of ids) await each(id);
  }
}

export async function runWorkspaceDelete(repo: WorkspaceDeleteRepo, orchestrator: Orchestrator, files: FileStore, wsId: string) {
  const delKey = async (key: string | null) => {
    if (key) await Promise.resolve(files.del(key)).catch(() => {});
  };
  async function drainAll() {
    // 1. Sessions: stop pods + drop /work PVCs BEFORE the row (the agents→
    //    sessions CASCADE can't do k8s cleanup — same pattern as agent delete).
    await drain(repo, "sessions", wsId, async (id) => {
      await Promise.allSettled([orchestrator.stopSession(id), orchestrator.deleteSessionResources(id)]);
      for (const key of await repo.deleteSession(wsId, id)) await delKey(key);
    });
    // 2+3. Skills and memory stores before files: their file_id FKs are
    //      RESTRICT (migrations 005/006). Entry rows cascade with the store;
    //      the file rows they referenced fall to step 4.
    await drain(repo, "skills", wsId, async (id) => { await repo.deleteSkill(wsId, id); });
    await drain(repo, "memory_stores", wsId, async (id) => { await repo.deleteMemoryStore(wsId, id); });
    await drain(repo, "wikis", wsId, async (id) => { await repo.deleteWiki(wsId, id); });
    // 4. Remaining files (uploads, outputs, checkpoints, skill/memory/wiki blobs).
    await drain(repo, "files", wsId, async (id) => {
      const { objectKey: key } = await repo.deleteFile(wsId, id);
      await delKey(key);
    });
    // 5. Environments: egress proxy + NetworkPolicy per env, then rows
    //    (agent_versions.environment_id is SET NULL).
    await drain(repo, "environments", wsId, async (id) => {
      await orchestrator.deleteEnvironmentResources(id);
      await repo.deleteEnvironment(wsId, id);
    });
    // 6. Vaults: k8s Secret per vault; credential rows cascade.
    await drain(repo, "vaults", wsId, async (id) => {
      await orchestrator.deleteVaultSecret(id);
      await repo.deleteVault(wsId, id);
    });
    // 7. Agents (versions cascade; sessions already gone) + 8. webhooks.
    await drain(repo, "agents", wsId, (id) => repo.deleteAgent(wsId, id));
    await repo.deleteWorkspaceWebhooks(wsId);
    // 9. API keys: SOFT delete — names survive for Usage attribution.
    await repo.softDeleteWorkspaceApiKeys(wsId);
    // 10. Chunked uploads: abort multipart parts, then rows — batched like
    //     every other drain. (Their workspace CASCADE never fires — the
    //     tombstone row survives.)
    for (;;) {
      const ups = await repo.listWorkspaceFileUploads(wsId, BATCH);
      if (!ups.length) break;
      for (const u of ups) {
        const key = objectKey({ kind: "upload", workspaceId: wsId, fileId: u.file_id });
        await Promise.resolve(files.abortUpload?.(key, u.upload_key)).catch(() => {});
        await repo.deleteFileUpload(u.id);
      }
    }
  }
  // Both guard caches (workspace-guard.ts) serve 'active' for up to their TTL
  // (≤10s) after this row flips to 'deleting', and a launch-gate release can
  // land a parked session mid-drain — so a write can insert a row into an
  // already-drained table AFTER that table's pass finished. Once tombstoned,
  // nothing ever revisits these rows (the boot sweep only resumes
  // 'deleting'), so re-check live counts and re-run the whole drain until
  // clean. Bounded (3 passes), not infinite — tombstone regardless after.
  for (let pass = 0; pass < 3; pass++) {
    await drainAll();
    const counts = await repo.workspaceResourceCounts(wsId);
    if (Object.values(counts).every((n) => n === 0)) break;
    if (pass === 2) console.warn(`workspace delete ${wsId}: resources remain after 3 drain passes`, counts);
  }
  // 11. Tombstone.
  await repo.setWorkspaceStatus(wsId, "deleted");
}

/** Boot sweep: resume drains interrupted by a CP restart. */
export async function sweepDeletingWorkspaces(repo: WorkspaceDeleteRepo, orchestrator: Orchestrator, files: FileStore) {
  for (const w of await repo.listWorkspaces(true)) {
    if (w.status !== "deleting") continue;
    await runWorkspaceDelete(repo, orchestrator, files, w.id)
      .catch((err: unknown) => console.warn(`workspace delete resume ${w.id} failed:`, err));
  }
}
