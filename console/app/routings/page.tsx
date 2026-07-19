import Link from "next/link";
import { wsGet, offsetOf } from "../lib/api";
import { Pager } from "../lib/pager";
import { DeleteButton } from "../lib/delete";
import { CreateRoutingButton } from "./routing-modal";

export const dynamic = "force-dynamic";

export default async function RoutingsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page } = await searchParams;
  const [{ routings, count }, { deployments }] = await Promise.all([
    wsGet<{ routings: any[]; count: number; offset: number }>(`/v1/routings?offset=${offsetOf(page)}`),
    wsGet<{ deployments: any[] }>("/v1/deployments?limit=1000"),
  ]);
  const targets = deployments.map((d: any) => d.name);
  return (
    <>
      <div className="pagehead"><h1>Routings</h1><CreateRoutingButton targets={targets} /></div>
      <p className="sub">
        Ordered rule tables that resolve incoming requests to a model — or reject them. Clients call a
        routing exactly like a model (<code>model = &lt;routing name&gt;</code>); external API keys can
        only call routings. Rule edits apply live, no restart.
      </p>
      <div className="tablewrap"><table>
        <thead><tr><th>Name</th><th>Rules</th><th>No match</th><th>Last modified</th><th></th></tr></thead>
        <tbody>
          {routings.map((r: any) => (
            <tr key={r.name}>
              <td><Link href={`/routings/${encodeURIComponent(r.name)}`}>{r.name}</Link></td>
              <td>{r.ruleCount}</td>
              <td>{r.terminal?.action === "route" ? <>route to <code>{r.terminal.target}</code></> : "reject (403)"}</td>
              <td>{r.updated_at ? new Date(r.updated_at).toLocaleString() : "—"}</td>
              <td><DeleteButton path={`/v1/routings/${encodeURIComponent(r.name)}`}
                    confirmText={`Delete routing "${r.name}"? Clients calling it will be rejected (400/403). Blocked while any agent references it.`} /></td>
            </tr>
          ))}
          {routings.length === 0 && <tr><td colSpan={5} className="empty">No routings — create one to put rules in front of your models.</td></tr>}
        </tbody>
      </table></div>
      <Pager count={count} />
    </>
  );
}
