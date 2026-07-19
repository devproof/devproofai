import Link from "next/link";
import { notFound } from "next/navigation";
import { AgentTabs } from "./tabs";
import { EditAgentButton } from "../agent-form";
import { StatusToggle } from "../status-toggle";
import { CreateSession } from "../../sessions/create";
import { wsGet, offsetOf } from "../../lib/api";
import { CopyId } from "../../lib/copy-id";
import { DeleteButton } from "../../lib/delete";

export const dynamic = "force-dynamic";

export default async function AgentDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const offset = offsetOf(sp.page);
  const [agent, obs, sessions, { skills }, { environments }, { vaults }, { stores }, { routings }, { agents: allAgents }, { wikis }] = await Promise.all([
    wsGet<any>(`/v1/agents/${id}`),
    wsGet<any>(`/v1/agents/${id}/observability`),
    wsGet<{ sessions: any[]; count: number }>(`/v1/sessions?agent=${id}&offset=${offset}`),
    wsGet<{ skills: any[] }>(`/v1/skills?limit=1000`),
    wsGet<{ environments: any[] }>(`/v1/environments?limit=1000`),
    wsGet<{ vaults: any[] }>(`/v1/vaults?limit=1000`),
    wsGet<{ stores: any[] }>(`/v1/memory-stores?limit=1000`),
    wsGet<{ routings: any[] }>(`/v1/routings?limit=1000`),
    wsGet<{ agents: any[] }>(`/v1/agents?limit=1000`),
    wsGet<{ wikis: any[] }>(`/v1/wikis?limit=1000`),
  ]);
  if (!agent?.id) notFound(); // unknown id (e.g. /agents/new) → graceful 404, not a crash
  // Version panel shows each version's routing's effective min context window
  // (fix wave L addendum L9) — fetch the detail (list doesn't carry
  // minContextTokens) per distinct routing referenced across versions; a
  // since-deleted routing 404s → null → no extra text.
  const routingNames: string[] = [...new Set((agent.versions ?? []).map((v: any) => v.routing).filter(Boolean) as string[])];
  const routingWindows: Record<string, number | null> = {};
  await Promise.all(routingNames.map(async (name) => {
    const r = await wsGet<any>(`/v1/routings/${encodeURIComponent(name)}`).catch(() => null);
    routingWindows[name] = r?.name ? (r.minContextTokens ?? null) : null;
  }));
  return (
    <>
      <div className="crumbs"><Link href="/agents">Agents</Link> / <CopyId id={agent.id} /> · last modified {new Date(agent.updated_at).toLocaleString()}</div>
      <div className="pagehead">
        <h1>{agent.name} <span className={`phase ${agent.status === "disabled" ? "bad" : "Ready"}`} style={{ verticalAlign: "middle" }}>
          {agent.status === "disabled" ? "Disabled" : "Active"}</span></h1>
        <div style={{ display: "flex", gap: 10 }}>
          {agent.status !== "disabled" && (
            <CreateSession ghost agents={[{ id: agent.id, name: agent.name }]}
                           memoryStores={stores.map((s: any) => ({ id: s.id, name: s.name }))} />
          )}
          <StatusToggle agent={agent} />
          <EditAgentButton agent={agent} environments={environments} skills={skills} vaults={vaults}
                           models={routings.map((r: any) => r.name)} agents={allAgents} wikis={wikis} />
          <DeleteButton path={`/v1/agents/${agent.id}`} redirect="/agents"
                        confirmText={`Delete agent "${agent.name}" and all its sessions?`} label="Delete agent" />
        </div>
      </div>
      <AgentTabs agent={agent} observability={obs} sessions={sessions.sessions} sessionCount={sessions.count}
                 initialTab={sp.page ? "sessions" : "agent"}
                 skills={skills} environments={environments} vaults={vaults} routingWindows={routingWindows}
                 agents={allAgents} wikis={wikis} />
    </>
  );
}
