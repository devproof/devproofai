// LLM wiki attachment validation (spec 2026-07-18). Agents attach wikis with a
// mode: read (default, unlimited) or write (exclusive — one writer per wiki, and
// the writer agent runs one session at a time). Mirrors validateSubagents.
import type { Repo } from "./repo.ts";

export type WikiRef = { wikiId: string; mode: "read" | "write" };

export type WikiRefError = { code: 400 | 409; error: string };

/** Normalize + validate the wiki_refs on an agent create/version save.
 *  Returns {code, error} or null. `agentId` is the agent being saved (null on
 *  create) so the single-writer check can exclude its own row. */
export async function validateWikiRefs(
  repo: Repo, workspaceId: string, agentId: string | null, refs: unknown,
): Promise<WikiRefError | null> {
  if (refs === undefined || refs === null) return null;
  if (!Array.isArray(refs)) return { code: 400, error: "wikiRefs must be an array" };
  const seen = new Set<string>();
  for (const r of refs as any[]) {
    if (!r || typeof r.wikiId !== "string" || !r.wikiId) return { code: 400, error: "each wiki ref needs a wikiId" };
    if (r.mode !== "read" && r.mode !== "write") return { code: 400, error: `wiki ref mode must be read|write (got ${r.mode})` };
    if (seen.has(r.wikiId)) return { code: 400, error: `wiki ${r.wikiId} referenced twice` };
    seen.add(r.wikiId);
  }
  const missing = await repo.missingWikiIds(workspaceId, [...seen]);
  if (missing.length) return { code: 400, error: `unknown wiki id(s): ${missing.join(", ")}` };
  for (const r of refs as WikiRef[]) {
    if (r.mode !== "write") continue;
    const other = await repo.wikiWriterAgent(workspaceId, r.wikiId, agentId ?? undefined);
    if (other) {
      const wiki = await repo.getWiki(r.wikiId, workspaceId);
      return { code: 409, error: `wiki "${wiki?.name ?? r.wikiId}" already has a writer agent (${other.name})` };
    }
  }
  return null;
}

/** The agent is single-session (no concurrent sessions) when it writes any wiki. */
export function hasWriteRef(refs: unknown): boolean {
  return Array.isArray(refs) && (refs as any[]).some((r) => r?.mode === "write");
}

/** Wiki ids the refs claim WRITE on — the keys for the exclusivity lock. */
export function writeWikiIds(refs: unknown): string[] {
  return (Array.isArray(refs) ? refs : []).filter((r: any) => r?.mode === "write").map((r: any) => String(r.wikiId));
}

export type WikiMount = {
  id: string; name: string; mode: "read" | "write";
  entries: { path: string; fileId: string }[];
};

/** Resolve an agent version's wiki_refs into the launch payload: each attached
 *  wiki with its files. Stale refs (wiki deleted) are skipped, mirroring
 *  missing-skill handling at launch. The wiki structure spec is a hardcoded
 *  runner-side convention, so nothing per-wiki needs threading here. */
export async function resolveWikiMounts(
  repo: Repo, workspaceId: string, wikiRefs: unknown,
): Promise<WikiMount[]> {
  const refs = (Array.isArray(wikiRefs) ? wikiRefs : []) as WikiRef[];
  if (!refs.length) return [];
  const byId = new Map((await repo.getWikisByIds(workspaceId, refs.map((r) => r.wikiId))).map((w: any) => [w.id, w]));
  const out: WikiMount[] = [];
  for (const r of refs) {
    const w = byId.get(r.wikiId);
    if (!w) continue;
    const entries = (await repo.getWikiEntries(r.wikiId)).map((e: any) => ({ path: e.path, fileId: e.file_id }));
    out.push({ id: w.id, name: w.name, mode: r.mode, entries });
  }
  return out;
}
