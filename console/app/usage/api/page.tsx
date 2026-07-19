import { wsGet } from "../../lib/api";
import { ApiUsageClient } from "./client";

export const dynamic = "force-dynamic";

export default async function ApiUsagePage() {
  const [deps, keys] = await Promise.all([
    wsGet<{ deployments: { name: string }[] }>("/v1/deployments?limit=1000").catch(() => ({ deployments: [] })),
    wsGet<{ keys: any[] }>("/v1/api-keys?include=deleted&limit=1000").catch(() => ({ keys: [] })),
  ]);
  return (
    <>
      <div className="pagehead"><h1>Usage — API</h1></div>
      <p className="sub">External traffic through your API keys, metered at the gateway per key and deployment. Managed-agent runs live under Usage — Sessions.</p>
      <ApiUsageClient deployments={deps.deployments.map((d) => d.name)} initialKeys={keys.keys} />
    </>
  );
}
