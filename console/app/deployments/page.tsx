import Link from "next/link";
import { DeploymentActions, RefreshButton, SyncButton } from "../actions";
import { AutoRefresh } from "./autorefresh";
import { wsGet, offsetOf } from "../lib/api";
import { Pager } from "../lib/pager";
import { AddEndpointButton, DeployModelButton } from "./deploy-modal";
import { DeleteButton } from "../lib/delete";
import { phaseBadge, isSettled } from "./phase";

interface Deployment {
  name: string; catalogId?: string; poolRef?: string;
  phase: string; activity?: string | null; downloadPercent: number | null; endpoint?: string; readyReplicas: number;
  tokensPerSec: number | null; queueDepth: number | null;
  kind: "local" | "external"; id?: string; provider?: string; modelId?: string; baseUrl?: string | null;
  replicas?: { min: number; max: number } | null;
}

export const dynamic = "force-dynamic";

function PhaseCell({ d }: { d: Deployment }) {
  if (d.phase === "External") return <span className="phase Ready">External</span>;
  if (d.phase === "Downloading" || d.phase === "Copying") {
    const pct = d.downloadPercent != null && d.downloadPercent >= 0 ? d.downloadPercent : null;
    return (
      <div style={{ minWidth: 120 }}>
        <div style={{ fontSize: 11.5, color: "var(--accent)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>
          {d.phase === "Copying" ? "Copying" : "Downloading"} {pct != null ? `${pct}%` : "…"}
        </div>
        <div className="dlbar"><div className="dlbar-fill" style={{ width: `${pct ?? 15}%`, opacity: pct != null ? 1 : .5 }} /></div>
      </div>
    );
  }
  const { label, cls } = phaseBadge(d.phase, d.activity);
  return <span className={`phase ${cls}`}>{label}</span>;
}

export default async function DeploymentsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const offset = offsetOf((await searchParams).page);
  const [{ deployments, count }, { routings }, settings] = await Promise.all([
    wsGet<{ deployments: Deployment[]; count: number }>(`/v1/deployments?offset=${offset}`),
    wsGet<{ routings: any[] }>("/v1/routings?limit=1000").catch(() => ({ routings: [] })),
    wsGet<{ serving?: { localEnabled?: boolean } }>("/v1/settings").catch(() => null),
  ]);
  const localServing = settings?.serving?.localEnabled !== false;
  const inProgress = deployments.some((d) => !isSettled(d));
  const referencedBy = (name: string) => routings.filter((r) => r.targets?.includes(name)).map((r) => r.name);
  return (
    <>
      <AutoRefresh active={inProgress} />
      <div className="pagehead">
        <h1>Deployments</h1>
        <div className="formrow" style={{ margin: 0 }}><AddEndpointButton />{localServing && <DeployModelButton />}{localServing && <SyncButton />}<RefreshButton /></div>
      </div>
      <p className="sub">Models serving through the gateway — local (cluster pods) and remote (external providers).{localServing ? " Deploy local models from the catalog." : ""}</p>
      <div className="tablewrap"><table>
        <thead>
          <tr>
            <th>Name</th><th>Catalog</th><th>Pool</th><th>Phase</th>
            <th>Replicas</th><th>Tok/s</th><th>Req Queue</th><th></th>
          </tr>
        </thead>
        <tbody>
          {deployments.map((d) => (
            <tr key={d.name}>
              <td><Link href={`/deployments/${encodeURIComponent(d.name)}`}>{d.name}</Link></td>
              <td><code>{d.kind === "external" ? `${d.provider}/${d.modelId}` : d.catalogId ?? "—"}</code></td>
              <td>{d.kind === "external" ? <span className="muted">remote</span> : d.poolRef ?? "—"}</td>
              <td><PhaseCell d={d} /></td>
              <td>{d.kind === "external" ? "—" : d.readyReplicas}</td>
              <td>{d.tokensPerSec != null ? d.tokensPerSec.toFixed(1) : "—"}</td>
              <td>{d.kind === "external" ? "—" : d.queueDepth != null ? d.queueDepth : "—"}</td>
              <td>{d.kind === "external"
                ? <div className="rowactions">
                    <DeleteButton path={`/v1/deployments/external/${d.id}`} label="Remove"
                      confirmText={`Remove endpoint "${d.name}"? The gateway route disappears immediately.${
                        referencedBy(d.name).length ? ` Referenced by routing(s): ${referencedBy(d.name).join(", ")} — their rules will treat it as unavailable.` : ""}`} />
                  </div>
                : <DeploymentActions name={d.name} referencedBy={referencedBy(d.name)} />}</td>
            </tr>
          ))}
          {deployments.length === 0 && (
            <tr><td colSpan={8} className="empty">No deployments — {localServing ? "deploy a model from the catalog." : "add an external endpoint."}</td></tr>
          )}
        </tbody>
      </table></div>
      <Pager count={count} />
    </>
  );
}
