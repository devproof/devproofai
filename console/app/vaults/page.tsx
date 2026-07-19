import Link from "next/link";
import { CreateVault } from "./create";
import { DeleteButton } from "../lib/delete";
import { wsGet, offsetOf } from "../lib/api";
import { Pager } from "../lib/pager";

export const dynamic = "force-dynamic";

export default async function VaultsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const offset = offsetOf((await searchParams).page);
  const { vaults, count } = await wsGet<{ vaults: any[]; count: number }>(`/v1/vaults?offset=${offset}`);
  return (
    <>
      <div className="pagehead"><h1>Credential vaults</h1><CreateVault /></div>
      <p className="sub">Secret bundles injected into agent sessions as environment variables — values are write-only.</p>
      <div className="tablewrap"><table>
        <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Last modified</th><th></th></tr></thead>
        <tbody>
          {vaults.map((v: any) => (
            <tr key={v.id}>
              <td><Link href={`/vaults/${v.id}`}><code>{v.id}</code></Link></td>
              <td>{v.name}</td>
              <td><span className="phase Ready">Active</span></td>
              <td>{new Date(v.updated_at).toLocaleString()}</td>
              <td><DeleteButton path={`/v1/vaults/${v.id}`} confirmText={`Delete vault "${v.name}"?`} /></td>
            </tr>
          ))}
          {vaults.length === 0 && <tr><td colSpan={5} className="empty">No vaults yet — create your first vault to get started.</td></tr>}
        </tbody>
      </table></div>
      <Pager count={count} />
    </>
  );
}
