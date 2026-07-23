import { SyncButton } from "../actions";
import { wsGet, offsetOf } from "../lib/api";
import { Pager } from "../lib/pager";
import { AddEndpointButton, DeployModelButton } from "./deploy-modal";
import { DeploymentsTable, type Deployment } from "./deployments-table";

export const dynamic = "force-dynamic";

export default async function DeploymentsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const offset = offsetOf((await searchParams).page);
  const [{ deployments, count }, { routings }, settings] = await Promise.all([
    wsGet<{ deployments: Deployment[]; count: number }>(`/v1/deployments?offset=${offset}`),
    wsGet<{ routings: any[] }>("/v1/routings?limit=1000").catch(() => ({ routings: [] })),
    wsGet<{ serving?: { localEnabled?: boolean } }>("/v1/settings").catch(() => null),
  ]);
  const localServing = settings?.serving?.localEnabled !== false;
  return (
    <>
      <div className="pagehead">
        <h1>Deployments</h1>
        {/* No Refresh button: the table polls /v1/deployments every 3s (2026-07-23). */}
        <div className="formrow" style={{ margin: 0 }}><AddEndpointButton />{localServing && <DeployModelButton />}{localServing && <SyncButton />}</div>
      </div>
      <p className="sub">Models serving through the gateway — local (cluster pods) and remote (external providers).{localServing ? " Deploy local models from the catalog." : ""}</p>
      <DeploymentsTable initial={deployments} routings={routings} localServing={localServing} offset={offset} />
      <Pager count={count} />
    </>
  );
}
