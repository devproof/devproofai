import { notFound } from "next/navigation";
import { wsGet } from "../../lib/api";
import { RoutingTabs } from "./tabs";

export const dynamic = "force-dynamic";

export default async function RoutingDetail({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeURIComponent((await params).name);
  const [r, { deployments }, keys, agents, settings] = await Promise.all([
    wsGet<any>(`/v1/routings/${encodeURIComponent(name)}`).catch(() => null),
    wsGet<{ deployments: any[] }>("/v1/deployments?limit=1000").catch(() => ({ deployments: [] })),
    wsGet<{ keys: { id: string; name: string }[] }>("/v1/api-keys?limit=1000").catch(() => ({ keys: [] })),
    wsGet<{ agents: { id: string; name: string }[] }>("/v1/agents?limit=1000").catch(() => ({ agents: [] })),
    wsGet<{ costs: { enabled: boolean; billing: { enabled: boolean } } }>("/v1/settings").catch(() => null),
  ]);
  if (!r?.name) notFound();
  const gatewayUrl = process.env.DEVPROOF_GATEWAY_PUBLIC_URL ?? "http://localhost:14000";
  // Cost-condition gating (spec G2): the Rules editor offers the "cost" type
  // and its ledgers only when the corresponding tracking is enabled.
  const cost = { enabled: !!settings?.costs?.enabled, billing: !!settings?.costs?.billing?.enabled };
  return <RoutingTabs routing={r} deployments={deployments} keys={keys.keys} agents={agents.agents} gatewayUrl={gatewayUrl} cost={cost} />;
}
