import Link from "next/link";
import { CreateWiki } from "./create";
import { wsGet, offsetOf } from "../lib/api";
import { Pager } from "../lib/pager";
import { DeleteButton } from "../lib/delete";
import { DateTime } from "../lib/datetime";

export const dynamic = "force-dynamic";

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export default async function WikisPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const offset = offsetOf((await searchParams).page);
  const { wikis, count } = await wsGet<{ wikis: any[]; count: number }>(`/v1/wikis?offset=${offset}`);
  return (
    <>
      <div className="pagehead"><h1>LLM wikis</h1><CreateWiki /></div>
      <p className="sub">Hierarchical knowledge bases agents mount at <code>/mnt/wiki</code> — read-only for most agents, with one designated writer that maintains the structure.</p>
      <div className="tablewrap"><table>
        <thead><tr><th>ID</th><th>Name</th><th>Files</th><th>Size</th><th>Last modified</th><th></th></tr></thead>
        <tbody>
          {wikis.map((w: any) => (
            <tr key={w.id}>
              <td><Link href={`/wikis/${w.id}`}><code>{w.id}</code></Link></td>
              <td>{w.name}</td>
              <td>{w.entry_count ?? 0}</td>
              <td>{fmtBytes(Number(w.total_bytes ?? 0))}</td>
              <td><DateTime iso={w.updated_at} /></td>
              <td><DeleteButton path={`/v1/wikis/${w.id}`} confirmText={`Delete wiki "${w.name}" and all its pages?`} /></td>
            </tr>
          ))}
          {wikis.length === 0 && <tr><td colSpan={6} className="empty">No wikis yet.</td></tr>}
        </tbody>
      </table></div>
      <Pager count={count} />
    </>
  );
}
