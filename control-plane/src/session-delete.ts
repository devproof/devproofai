// Full session teardown, shared by the DELETE routes (agents-api, public-api)
// and the maintenance runner — one definition of "delete a session".
import type { FileStore } from "./filestore.ts";

export type SessionDeleteDeps = {
  repo: { deleteSession(workspaceId: string, id: string): Promise<string[]> };
  orchestrator: {
    stopSession(id: string): Promise<unknown>;
    deleteSessionResources(id: string): Promise<unknown>;
  };
  files: FileStore;
};

export async function deleteSessionFully(deps: SessionDeleteDeps, workspaceId: string, sessionId: string): Promise<void> {
  await deps.orchestrator.stopSession(sessionId);
  await deps.orchestrator.deleteSessionResources(sessionId);
  const keys = await deps.repo.deleteSession(workspaceId, sessionId);
  for (const key of keys) { try { await deps.files.del(key); } catch { /* best effort */ } }
}
