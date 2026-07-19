"use client";
// Usage — Sessions (split 2026-07-14): gateway_usage(source='session') tokens
// plus the session-infrastructure ledger — env_pod uptime (real) and
// session_time minute billing (billed) — charted per day.
import { useEffect, useState } from "react";
import { wsHeader } from "../../lib/client";
import { fmtCost, currencySymbol } from "../../lib/currency";
import { UsageBars } from "../../lib/usage-bars";
import { RANGES, DEFAULT_RANGE, TOKEN_SERIES, costSeries, fmt, nonZero, CostCards, UsageTable, type Row } from "../shared";

interface Su {
  bucket: string; buckets: Row[]; totals: Row; byDeployment: Row[]; sessionsCount: number;
  timeCosts: { real: number; billed: number } | null;
  timeCostBuckets: { bucket: string; real: number; billed: number }[] | null;
  costs: { currency: string; real: boolean; billed: boolean } | null;
}

const INFRA_SERIES = [
  { key: "real", color: "var(--chart1)", label: "environment uptime (real)" },
  { key: "billed", color: "var(--chart2)", label: "session minutes (billed)" },
];

export function SessionUsageClient({ deployments, agents }: {
  deployments: string[]; agents: { id: string; name: string }[];
}) {
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [deployment, setDeployment] = useState("");
  const [agent, setAgent] = useState("");
  const [allWs, setAllWs] = useState(false);
  const [su, setSu] = useState<Su | null>(null);

  useEffect(() => {
    const q = new URLSearchParams({ range });
    if (deployment) q.set("deployment", deployment);
    if (agent) q.set("agent", agent);
    if (allWs) q.set("workspaces", "all");
    let stale = false;
    fetch(`/api/v1/usage?${q}`, { headers: wsHeader() })
      .then((r) => r.json()).then((u) => { if (!stale) setSu(u); }).catch(() => { if (!stale) setSu(null); });
    return () => { stale = true; };
  }, [range, deployment, agent, allWs]);

  const cur = su?.costs?.currency ?? "EUR";
  const showReal = !!su?.costs?.real;
  const showBilled = !!su?.costs?.billed;

  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <select value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <select value={deployment} onChange={(e) => setDeployment(e.target.value)}>
          <option value="">All deployments</option>
          {deployments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={agent} onChange={(e) => setAgent(e.target.value)} style={{ width: 200, flex: "none" }}>
          <option value="">All agents</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={allWs} onChange={(e) => setAllWs(e.target.checked)} />
          All workspaces
        </label>
      </div>

      <div className="cards">
        <div className="card"><h3>Input tokens</h3><div className="big">{fmt(su?.totals.tokens_in ?? 0)}</div></div>
        <div className="card"><h3>Output tokens</h3><div className="big">{fmt(su?.totals.tokens_out ?? 0)}</div></div>
        <div className="card"><h3>Sessions</h3><div className="big">{su?.sessionsCount ?? 0}</div></div>
        {su && <CostCards totals={su.totals} currency={cur} extra={su.timeCosts}
          hint={deployment ? "(tokens only)" : undefined} showReal={showReal} showBilled={showBilled} />}
      </div>

      <div className="group" style={{ padding: "6px 0 8px" }}>Tokens per {su?.bucket === "week" ? "week" : "day"}</div>
      <UsageBars buckets={su?.buckets ?? []} series={TOKEN_SERIES} mode="stack" format={fmt}
                 unit={`tokens / ${su?.bucket === "week" ? "week" : "day"}`} />

      {(showReal || showBilled) && (<>
        <div className="group" style={{ padding: "0 0 8px" }}>Token costs per {su?.bucket === "week" ? "week" : "day"}</div>
        <UsageBars buckets={su?.buckets ?? []} series={costSeries(showReal, showBilled)} mode="group"
                   format={(n) => fmtCost(n, cur)} unit={`${currencySymbol(cur)} / ${su?.bucket === "week" ? "week" : "day"}`} />

        <div className="group" style={{ padding: "0 0 8px" }}>
          Session infrastructure costs per {su?.bucket === "week" ? "week" : "day"}
          {deployment && <span style={{ marginLeft: 10, fontSize: 11, color: "var(--muted)" }}>
            not deployment-attributable — clear the deployment filter to see them
          </span>}
        </div>
        {deployment
          ? <div className="empty" style={{ marginBottom: 22 }}>Environment uptime and session-minute billing are not tied to a deployment.</div>
          : <UsageBars buckets={su?.timeCostBuckets ?? []} series={INFRA_SERIES.filter((s) => (s.key === "real" ? showReal : showBilled))}
                       mode="stack" format={(n) => fmtCost(n, cur)}
                       unit={`${currencySymbol(cur)} / ${su?.bucket === "week" ? "week" : "day"}`} />}
      </>)}

      <div className="group" style={{ padding: "0 0 8px" }}>By deployment</div>
      <UsageTable rows={(su?.byDeployment ?? []).filter(nonZero)} first="Deployment" firstKey="model"
                  sessions showReal={showReal} showBilled={showBilled} currency={cur} />
    </>
  );
}
