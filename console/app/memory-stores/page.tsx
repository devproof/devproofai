import Link from "next/link";
import { CreateStore } from "./create";
import { wsGet, offsetOf } from "../lib/api";
import { Pager } from "../lib/pager";
import { DeleteButton } from "../lib/delete";
import { DateTime } from "../lib/datetime";

export const dynamic = "force-dynamic";

export default async function MemoryStoresPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const offset = offsetOf((await searchParams).page);
  const { stores, count } = await wsGet<{ stores: any[]; count: number }>(`/v1/memory-stores?offset=${offset}`);
  return (
    <>
      <div className="pagehead"><h1>Memory stores</h1><CreateStore /></div>
      <p className="sub">Browse and manage persistent memory for your agents — one mini-filesystem per business entity.</p>
      <div className="tablewrap"><table>
        <thead><tr><th>ID</th><th>Name</th><th>Files</th><th>Last modified</th><th></th></tr></thead>
        <tbody>
          {stores.map((s: any) => (
            <tr key={s.id}>
              <td><Link href={`/memory-stores/${s.id}`}><code>{s.id}</code></Link></td>
              <td>{s.name}</td>
              <td>{s.entry_count ?? 0}</td>
              <td><DateTime iso={s.updated_at} /></td>
              <td><DeleteButton path={`/v1/memory-stores/${s.id}`} confirmText={`Delete memory store "${s.name}" and all its entries?`} /></td>
            </tr>
          ))}
          {stores.length === 0 && <tr><td colSpan={5} className="empty">No memory stores yet.</td></tr>}
        </tbody>
      </table></div>
      <Pager count={count} />
    </>
  );
}
