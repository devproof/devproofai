// Shared skill-package storage (spec 2026-07-14 §2) — one implementation for
// both API surfaces (was duplicated in agents-api.ts/public-api.ts). Resolves
// the skill id BEFORE storing so objects land under <ws>/skills/<skill_id>/…;
// same-path re-uploads overwrite in place, and the replaced version's rows +
// dropped-path objects are purged via the shared-key delete rule.
import { createHash } from "node:crypto";
import type { FileStore } from "./filestore.ts";
import { objectKey, validEntryPath } from "./object-key.ts";
import { shortId } from "./id.ts";

export interface SkillRepo {
  getSkillIdByName(workspaceId: string, name: string): Promise<string | null>;
  createFileRecord(meta: { id: string; name: string; size: number; sha256: string; objectKey: string; kind?: string; workspaceId?: string }): Promise<unknown>;
  deleteFileRecordById(id: string): Promise<string | null>;
  createSkill(workspaceId: string, name: string, files: { path: string; fileId: string }[], id?: string):
    Promise<{ id: string; name: string; version: number; fileCount: number; previousFileIds: string[] }>;
}

export async function storeSkillPackage(
  deps: { repo: SkillRepo; files: FileStore },
  workspaceId: string, name: string, filename: string, buf: Buffer,
): Promise<{ error: string } | { skill: { id: string; name: string; version: number; fileCount: number } }> {
  const { repo, files } = deps;
  // Entries as {path, content}; zip paths get the wrapper-folder strip as before.
  let entries: { path: string; content: Buffer }[];
  if (/\.zip$/i.test(filename)) {
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(buf);
    const allEntries = zip.getEntries().filter((e: any) => !e.isDirectory);

    // PowerShell's Compress-Archive writes entry names with backslash path
    // separators (violates the zip spec but is extremely common on Windows);
    // normalize to "/" before any path processing so wrapper-stripping,
    // traversal checks, and validEntryPath all see a single, spec-compliant
    // form.
    const named = allEntries.map((e: any) => ({ entry: e, name: e.entryName.replaceAll("\\", "/") }));

    // Validate normalized entry names for traversal paths before any processing
    for (const { name } of named) {
      // Check for ".." or leading "/" before validating with validEntryPath
      // (AdmZip might normalize these, so we check raw names first)
      if (name.includes("..") || name.startsWith("/") || !validEntryPath(name)) {
        return { error: `bad entry path: ${name}` };
      }
    }

    // Detect if there's a common wrapper folder (all entries share the same first segment)
    let stripWrapper = false;
    if (named.length > 0) {
      const firstSegments = new Set(named.map(({ name }) => name.split("/")[0]));
      stripWrapper = firstSegments.size === 1 && Array.from(firstSegments)[0] !== "";
    }

    entries = named.map(({ entry, name }) => {
      let path = name;
      if (stripWrapper) {
        path = path.replace(/^[^/]+\//, "");
      }
      path = path.replace(/^\/+/, "");
      return { path, content: entry.getData() };
    })
      // Directory entries are normally caught by isDirectory above, which
      // (verified empirically) already treats a trailing "\" the same as a
      // trailing "/" — but filter defensively so a post-normalization
      // trailing "/" can never survive as a file entry.
      .filter((e: { path: string }) => e.path && !e.path.endsWith("/"));
    if (!entries.some((e) => e.path.toLowerCase() === "skill.md")) {
      return { error: "zip must contain a SKILL.md at its root" };
    }
  } else {
    entries = [{ path: "SKILL.md", content: buf }];
  }
  const bad = entries.find((e) => !validEntryPath(e.path));
  if (bad) return { error: `bad entry path: ${bad.path}` };
  if (new Set(entries.map((e) => e.path)).size !== entries.length) {
    return { error: "duplicate paths in skill package" };
  }

  const skillId = (await repo.getSkillIdByName(workspaceId, name)) ?? `skill_${shortId()}`;
  const manifest: { path: string; fileId: string }[] = [];
  for (const e of entries) {
    const id = `file_${shortId()}`;
    const key = objectKey({ kind: "skill", workspaceId, skillId, path: e.path });
    await files.put(e.content, key);
    await repo.createFileRecord({
      id,
      name: `skill/${name}/${e.path}`,
      size: e.content.length,
      sha256: createHash("sha256").update(e.content).digest("hex"),
      objectKey: key,
      kind: "skill",
      workspaceId,
    });
    manifest.push({ path: e.path, fileId: id });
  }
  const skill = await repo.createSkill(workspaceId, name, manifest, skillId);
  // Purge the replaced version: rows always; objects only when the key has no
  // surviving referent (an overwritten path's key is now owned by the new row).
  for (const fid of skill.previousFileIds) {
    const key = await repo.deleteFileRecordById(fid).catch(() => null);
    if (key) await Promise.resolve(files.del(key)).catch(() => {});
  }
  return { skill: { id: skill.id, name: skill.name, version: skill.version, fileCount: skill.fileCount } };
}
