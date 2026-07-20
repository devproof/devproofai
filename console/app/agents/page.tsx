import Link from "next/link";
import { CreateAgentButton } from "./agent-form";
import { DeleteButton } from "../lib/delete";
import { wsGet, offsetOf } from "../lib/api";
import { Pager } from "../lib/pager";
import { DateTime } from "../lib/datetime";

export const dynamic = "force-dynamic";

export default async function AgentsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const offset = offsetOf((await searchParams).page);
  const [{ agents, count }, { environments }, { skills }, { vaults }, { routings }, { agents: allAgents }, { wikis }] = await Promise.all([
    wsGet<{ agents: any[]; count: number }>(`/v1/agents?offset=${offset}`),
    wsGet<{ environments: any[] }>("/v1/environments?limit=1000"),
    wsGet<{ skills: any[] }>("/v1/skills?limit=1000"),
    wsGet<{ vaults: any[] }>("/v1/vaults?limit=1000"),
    wsGet<{ routings: any[] }>("/v1/routings?limit=1000"),
    wsGet<{ agents: any[] }>("/v1/agents?limit=1000"),
    wsGet<{ wikis: any[] }>("/v1/wikis?limit=1000"),
  ]);
  return (
    <>
      <div className="pagehead">
        <h1>Agents</h1>
        <CreateAgentButton environments={environments} skills={skills} vaults={vaults}
                           models={routings.map((r: any) => r.name)} agents={allAgents} wikis={wikis} />
      </div>
      <p className="sub">Create and manage autonomous agents.</p>
      <div className="tablewrap"><table>
        <thead><tr><th>ID</th><th>Name</th><th>Routing</th><th>Version</th><th>Status</th><th>Last modified</th><th></th></tr></thead>
        <tbody>
          {agents.map((a: any) => (
            <tr key={a.id}>
              <td><Link href={`/agents/${a.id}`}><code>{a.id}</code></Link></td>
              <td>{a.name}{((a.wiki_refs ?? []).some((r: any) => r.mode === "write")) &&
                <span className="badge-writer" title="Writes an LLM wiki — runs one session at a time">Wiki Writer</span>}</td>
              <td><code>{a.routing}</code></td>
              <td><span className="phase ver">v{a.version}</span></td>
              <td><span className={`phase ${a.status === "disabled" ? "bad" : "Ready"}`}>{a.status === "disabled" ? "Disabled" : "Active"}</span></td>
              <td><DateTime iso={a.updated_at} /></td>
              <td><DeleteButton path={`/v1/agents/${a.id}`} confirmText={`Delete agent "${a.name}" and all its sessions?`} /></td>
            </tr>
          ))}
          {agents.length === 0 && <tr><td colSpan={7} className="empty">No agents yet.</td></tr>}
        </tbody>
      </table></div>
      <Pager count={count} />
    </>
  );
}
