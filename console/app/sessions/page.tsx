import Link from "next/link";
import { RefreshButton } from "../actions";
import { CreateSession } from "./create";
import { wsGet, offsetOf } from "../lib/api";
import { DeleteButton } from "../lib/delete";
import { Pager } from "../lib/pager";
import { fmtCost, type CostSettings } from "../lib/currency";
import { DateTime } from "../lib/datetime";

interface Session {
  id: string; name: string | null; agent_name: string; agent_version: number;
  status: string; tokens_in: string; tokens_out: string; billed_cost: string | null; created_at: string; updated_at: string;
}

export const dynamic = "force-dynamic";

const fmtTokens = (n: string) => {
  const v = Number(n);
  return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
};

export default async function SessionsPage({ searchParams }: { searchParams: Promise<{ page?: string; file?: string }> }) {
  const sp = await searchParams;
  const offset = offsetOf(sp.page);
  const fileQ = sp.file ? `&file=${encodeURIComponent(sp.file)}` : "";
  const [{ sessions, count }, { agents }, { stores }, fileMeta, settings] = await Promise.all([
    wsGet<{ sessions: Session[]; count: number }>(`/v1/sessions?offset=${offset}${fileQ}`),
    wsGet<{ agents: any[] }>("/v1/agents?limit=1000"),
    wsGet<{ stores: any[] }>("/v1/memory-stores?limit=1000"),
    sp.file ? wsGet<{ name: string }>(`/v1/files/${encodeURIComponent(sp.file)}`).catch(() => null) : Promise.resolve(null),
    wsGet<{ costs: CostSettings }>("/v1/settings").catch(() => null),
  ]);
  // Same gate as the session header's cost chip.
  const c = settings?.costs;
  const showBilled = !!(c?.billing?.enabled && c.billing?.showSessionCosts);
  const cols = showBilled ? 8 : 7;
  return (
    <>
      <div className="pagehead"><h1>Sessions</h1><CreateSession agents={agents.filter((a: any) => a.status !== "disabled")} memoryStores={stores.map((s: any) => ({ id: s.id, name: s.name }))} /></div>
      <p className="sub">
        Trace and debug agent sessions. <RefreshButton />
        {sp.file && (
          <span className="chip" style={{ marginLeft: 10 }}>
            file: {fileMeta?.name ?? sp.file} <Link href="/sessions" style={{ marginLeft: 4 }}>×</Link>
          </span>
        )}
      </p>
      <div className="tablewrap"><table>
        <thead>
          <tr><th>ID</th><th className="flex">Name</th><th>Agent</th><th>Status</th><th>Tokens in / out</th>{showBilled && <th>Billed</th>}<th>Last activity</th><th></th></tr>
        </thead>
        <tbody>
          {sessions.map((s: Session) => (
            <tr key={s.id}>
              <td><Link href={`/sessions/${s.id}`}><code>{s.id}</code></Link></td>
              <td className="flex">{s.name ?? "—"}</td>
              <td>{s.agent_name} <span className="phase ver">v{s.agent_version}</span></td>
              <td><span className={`phase ${s.status === "completed" || s.status === "idle" ? "Ready" : s.status === "failed" ? "Failed" : "Deploying"}`}>{s.status}</span></td>
              <td>{fmtTokens(s.tokens_in)} / {fmtTokens(s.tokens_out)}</td>
              {showBilled && <td>{fmtCost(Number(s.billed_cost ?? 0), c!.currency)}</td>}
              <td><DateTime iso={s.updated_at} /></td>
              <td><DeleteButton path={`/v1/sessions/${s.id}`} confirmText="Delete this session and its trace?" /></td>
            </tr>
          ))}
          {sessions.length === 0 && (
            <tr><td colSpan={cols} style={{ color: "var(--muted)" }}>No sessions yet — create one via the API or Python client.</td></tr>
          )}
        </tbody>
      </table></div>
      <Pager count={count} />
    </>
  );
}
