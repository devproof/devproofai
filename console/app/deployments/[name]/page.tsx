import { notFound } from "next/navigation";
import { wsGet } from "../../lib/api";
import { DeploymentTabs } from "./tabs";
import { AutoRefresh } from "../autorefresh";
import { isSettled } from "../phase";

export const dynamic = "force-dynamic";

export default async function DeploymentDetail({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const [d, keys, agents] = await Promise.all([
    wsGet<any>(`/v1/deployments/${encodeURIComponent(name)}`).catch(() => null),
    wsGet<{ keys: { id: string; name: string }[] }>("/v1/api-keys?limit=1000").catch(() => ({ keys: [] })),
    wsGet<{ agents: { id: string; name: string }[] }>("/v1/agents?limit=1000").catch(() => ({ agents: [] })),
  ]);
  if (!d?.name) notFound();
  return (
    <>
      <AutoRefresh active={!isSettled(d)} />
      <DeploymentTabs d={d} keys={keys.keys} agents={agents.agents} />
    </>
  );
}
