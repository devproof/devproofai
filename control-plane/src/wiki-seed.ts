// Skeleton seeding for freshly created LLM wikis (spec 2026-07-18 addendum).
// The runner's hardcoded WIKI_STRUCTURE tells every reader "ALWAYS read
// index.md first" and pins index.md/log.md in the console browser, so both
// files must exist from birth — not only after the writer agent's first turn.
// Content stays minimal (a placeholder to replace, not content to preserve)
// and carries no frontmatter: the structure spec reserves that for entity pages.
import { createHash } from "node:crypto";
import type { Repo } from "./repo.ts";
import type { FileStore } from "./filestore.ts";
import { objectKey } from "./object-key.ts";
import { shortId } from "./id.ts";

/** Create index.md + log.md as regular wiki entries. Called by both wiki
 *  create routes (agents-api.ts /v1 + public-api.ts /api) right after
 *  repo.createWiki — same file-minting recipe as the entry-upload routes. */
export async function seedWikiSkeleton(
  repo: Repo, files: FileStore, workspaceId: string,
  wikiId: string, name: string, description: string,
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const index = `# ${name}\n\n`
    + (description ? `${description}\n\n` : "")
    + "## Pages\n\n*No pages yet.*\n";
  const log = `# Log\n\n- ${date}: wiki created\n`;
  for (const [path, text] of [["index.md", index], ["log.md", log]] as const) {
    const content = Buffer.from(text, "utf8");
    const id = `file_${shortId()}`;
    const key = objectKey({ kind: "wiki", workspaceId, wikiId, path });
    await files.put(content, key);
    await repo.createFileRecord({
      id, name: `wiki/${path}`, size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      objectKey: key, kind: "wiki", workspaceId,
    });
    await repo.upsertWikiEntries(wikiId, [{ path, fileId: id }]);
  }
}
