import { wsGet } from "../../lib/api";
import { SessionUsageClient } from "./client";

export const dynamic = "force-dynamic";

export default async function SessionUsagePage() {
  const [deps, agents] = await Promise.all([
    wsGet<{ deployments: { name: string }[] }>("/v1/deployments?limit=1000").catch(() => ({ deployments: [] })),
    wsGet<{ agents: { id: string; name: string }[] }>("/v1/agents?limit=1000").catch(() => ({ agents: [] })),
  ]);
  return (
    <>
      <div className="pagehead"><h1>Usage — Sessions</h1></div>
      <p className="sub">Managed-agent runs: model tokens plus session infrastructure — environment uptime and per-minute session billing. External API-key traffic lives under Usage — API.</p>
      <SessionUsageClient deployments={deps.deployments.map((d) => d.name)}
                          agents={agents.agents.map((a) => ({ id: a.id, name: a.name }))} />
    </>
  );
}
