"use client";
// Deployments table with live polling (user request 2026-07-23, cache-table
// pattern): unlike the old AutoRefresh (router.refresh gated on the phase at
// SERVER render time — movement starting after load was never picked up),
// this polls /v1/deployments every 3s whenever the tab is visible, so
// deploys, wakes, sleeps and scale events appear without a manual refresh.
import Link from "next/link";
import { useEffect, useState } from "react";
import { DeploymentActions } from "../actions";
import { apiGet } from "../lib/client";
import { DeleteButton } from "../lib/delete";
import { phaseBadge } from "./phase";

export interface Deployment {
  name: string; catalogId?: string; poolRef?: string;
  phase: string; activity?: string | null; downloadPercent: number | null; endpoint?: string; readyReplicas: number;
  tokensPerSec: number | null; queueDepth: number | null;
  kind: "local" | "external"; id?: string; provider?: string; modelId?: string; baseUrl?: string | null;
  replicas?: { min: number; max: number } | null;
}

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

export function DeploymentsTable({ initial, routings, localServing, offset }: {
  initial: Deployment[];
  routings: { name: string; targets?: string[] }[];
  localServing: boolean;
  offset: number;
}) {
  const [rows, setRows] = useState(initial);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return; // no background-tab traffic
      apiGet<{ deployments: Deployment[] }>(`/v1/deployments?offset=${offset}`)
        .then((j) => setRows(j.deployments)).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [offset]);
  const referencedBy = (name: string) => routings.filter((r) => r.targets?.includes(name)).map((r) => r.name);
  return (
    <div className="tablewrap"><table>
      <thead>
        <tr>
          <th>Name</th><th>Catalog</th><th>Pool</th><th>Phase</th>
          <th>Replicas</th><th>Tok/s</th><th>Req Queue</th><th></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
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
        {rows.length === 0 && (
          <tr><td colSpan={8} className="empty">No deployments — {localServing ? "deploy a model from the catalog." : "add an external endpoint."}</td></tr>
        )}
      </tbody>
    </table></div>
  );
}
