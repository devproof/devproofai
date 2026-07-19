"use client";
// Routing detail (spec 2026-07-16; fix wave J: Overview first + default): Overview | Rules | Connect | Trace.
import { useState } from "react";
import { RulesTab } from "./rules";
import { StatsTab } from "../../deployments/[name]/stats";
import { TraceTab } from "../../deployments/[name]/trace";
import { ConnectTab } from "./connect";

export function RoutingTabs({ routing, deployments, keys, agents, gatewayUrl, cost }: {
  routing: any; deployments: any[]; keys: { id: string; name: string }[];
  agents: { id: string; name: string }[]; gatewayUrl: string;
  cost: { enabled: boolean; billing: boolean };
}) {
  const [tab, setTab] = useState<"overview" | "rules" | "trace" | "connect">("overview");
  // Target -> context window, for the Rules tab's per-select hint (fix wave L
  // addendum): locals expose effectiveContextTokens (served, capped) falling
  // back to contextTokens; externals expose contextTokens directly.
  const windowByTarget: Record<string, number> = {};
  for (const d of deployments) {
    const w = d.effectiveContextTokens ?? d.contextTokens;
    if (w) windowByTarget[d.name] = w;
  }
  return (
    <>
      <div className="pagehead"><h1>{routing.name}</h1></div>
      <p className="sub">Routing — requests to <code>{routing.name}</code> resolve through the rule table below.</p>
      <div className="tabs">
        {(["overview", "rules", "connect", "trace"] as const).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === "overview" && <StatsTab name={routing.name} keys={keys} agents={agents} basePath="/v1/routings" />}
      {tab === "rules" && <RulesTab routing={routing} targets={deployments.map((d: any) => d.name)} cost={cost}
        windowByTarget={windowByTarget} minContextTokens={routing.minContextTokens ?? null} />}
      {tab === "trace" && <TraceTab name={routing.name} keys={keys} agents={agents} basePath="/v1/routings" />}
      {tab === "connect" && <ConnectTab name={routing.name} gatewayUrl={gatewayUrl}
        kind={routing.minContextTokens != null ? "local" : "external"}
        contextTokens={routing.minContextTokens ?? null} />}
    </>
  );
}
