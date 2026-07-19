import Link from "next/link";
import { WikiBrowser } from "./browser";
import { wsGet } from "../../lib/api";
import { CopyId } from "../../lib/copy-id";

export const dynamic = "force-dynamic";

export default async function WikiDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ entries }, wikiRes] = await Promise.all([
    wsGet<{ entries: any[] }>(`/v1/wikis/${id}/tree`),
    wsGet<{ wiki: any }>(`/v1/wikis/${id}`).catch(() => null),
  ]);
  const wiki = wikiRes?.wiki;
  return (
    <>
      <div className="crumbs"><Link href="/wikis">LLM wikis</Link> / <CopyId id={id} />
        {wiki && <> · last modified {new Date(wiki.updated_at).toLocaleString()}</>}</div>
      <h1>{wiki?.name ?? "Wiki"}</h1>
      <p className="sub">{wiki?.description || `${entries.length} page(s)`}</p>
      <WikiBrowser wikiId={id} entries={entries} />
    </>
  );
}
