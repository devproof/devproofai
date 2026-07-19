// Hierarchical MinIO/S3 object keys (spec 2026-07-14 §2):
//   <workspace>/<resource-type>/<resource-id>[/<path>]
// The key is computed ONCE at insert and stored in files.object_key — reads
// never derive it. Checkpoint keys carry the file id as leaf (spec amendment):
// a fixed per-session key could be clobbered by a stale pod's salvage upload.

export type ObjectRef =
  | { kind: "upload" | "output"; workspaceId: string; fileId: string }
  | { kind: "checkpoint"; workspaceId: string; sessionId: string; fileId: string }
  | { kind: "memory"; workspaceId: string; storeId: string; path: string }
  | { kind: "skill"; workspaceId: string; skillId: string; path: string }
  | { kind: "wiki"; workspaceId: string; wikiId: string; path: string };

/** Relative path usable as a key suffix: no traversal, no empty/duplicate
 *  segments, printable, bounded. Shared by skill manifests + memory entries. */
export function validEntryPath(path: string): boolean {
  if (!path || path.length > 512) return false;
  if (path.includes("\\") || /[\x00-\x1f]/.test(path)) return false;
  const segments = path.split("/");
  return segments.every((s) => s.length > 0 && s !== "." && s !== "..");
}

export function objectKey(ref: ObjectRef): string {
  switch (ref.kind) {
    case "upload":
    case "output":
      return `${ref.workspaceId}/files/${ref.fileId}`;
    case "checkpoint":
      return `${ref.workspaceId}/sessions/${ref.sessionId}/${ref.fileId}`;
    case "memory":
      if (!validEntryPath(ref.path)) throw new Error(`bad entry path: ${ref.path}`);
      return `${ref.workspaceId}/memory/${ref.storeId}/${ref.path}`;
    case "skill":
      if (!validEntryPath(ref.path)) throw new Error(`bad entry path: ${ref.path}`);
      return `${ref.workspaceId}/skills/${ref.skillId}/${ref.path}`;
    case "wiki":
      if (!validEntryPath(ref.path)) throw new Error(`bad entry path: ${ref.path}`);
      return `${ref.workspaceId}/wiki/${ref.wikiId}/${ref.path}`;
  }
}
