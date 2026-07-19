"use client";
// Usage — API (split 2026-07-14): gateway_usage(source='api') only — external
// traffic through dpk_ API keys. Session traffic lives on Usage — Sessions.
import { useEffect, useState } from "react";
import { wsHeader } from "../../lib/client";
import { UsageBars } from "../../lib/usage-bars";
import { fmtCost, currencySymbol } from "../../lib/currency";
import { RANGES, DEFAULT_RANGE, TOKEN_SERIES, costSeries, fmt, nonZero, CostCards, UsageTable, type Row } from "../shared";

interface Gw { bucket: string; buckets: Row[]; totals: Row; byDeployment: Row[]; byKey: Row[];
  costs: { currency: string; real: boolean; billed: boolean } | null }

export function ApiUsageClient({ deployments, initialKeys }: {
  deployments: string[]; initialKeys: Row[];
}) {
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [deployment, setDeployment] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [allWs, setAllWs] = useState(false);
  const [keys, setKeys] = useState<Row[]>(initialKeys);
  const [gw, setGw] = useState<Gw | null>(null);

  // All-workspaces refreshes the key list; a selected key that left the list resets.
  useEffect(() => {
    if (!allWs) {
      setKeys(initialKeys);
      setApiKey((k) => k && k !== "__deleted__" && !initialKeys.some((x: any) => x.id === k) ? "" : k);
      return;
    }
    let stale = false;
    fetch("/api/v1/api-keys?all=1", { headers: wsHeader() })
      .then((r) => r.json()).then((j) => {
        if (!stale) {
          setKeys(j.keys ?? []);
          setApiKey((k) => k && k !== "__deleted__" && !(j.keys ?? []).some((x: any) => x.id === k) ? "" : k);
        }
      })
      .catch(() => {});
    return () => { stale = true; };
  }, [allWs, initialKeys]);

  useEffect(() => {
    const q = new URLSearchParams({ range });
    if (deployment) q.set("deployment", deployment);
    if (apiKey) q.set("api_key", apiKey);
    if (allWs) q.set("workspaces", "all");
    let stale = false;
    fetch(`/api/v1/usage/gateway?${q}`, { headers: wsHeader() })
      .then((r) => r.json()).then((u) => { if (!stale) setGw(u); }).catch(() => { if (!stale) setGw(null); });
    return () => { stale = true; };
  }, [range, deployment, apiKey, allWs]);

  const keyLabel = (k: Row) =>
    k.api_key_id === null ? "(deleted key)"
      : `${k.name ?? k.api_key_id ?? k.id}${k.status === "deleted" ? " [deleted]" : ""}${k.workspace_name ? ` — ${k.workspace_name}` : ""}`;
  const cur = gw?.costs?.currency ?? "EUR";
  const showReal = !!gw?.costs?.real;
  const showBilled = !!gw?.costs?.billed;

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
        {/* Fixed width: cross-workspace labels are longer — the bar must not
            reflow (and the checkbox must not jump) when the key list swaps. */}
        <select value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={{ width: 220, flex: "none" }}>
          <option value="">All API keys</option>
          {keys.map((k) => <option key={k.id} value={k.id}>{keyLabel(k)}</option>)}
          <option value="__deleted__">(deleted key)</option>
        </select>
        <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={allWs} onChange={(e) => setAllWs(e.target.checked)} />
          All workspaces
        </label>
      </div>

      <div className="cards">
        <div className="card"><h3>Input tokens</h3><div className="big">{fmt(gw?.totals.tokens_in ?? 0)}</div></div>
        <div className="card"><h3>Output tokens</h3><div className="big">{fmt(gw?.totals.tokens_out ?? 0)}</div></div>
        <div className="card"><h3>Requests</h3><div className="big">{gw?.totals.requests ?? 0}</div></div>
        {gw && <CostCards totals={gw.totals} currency={cur} showReal={showReal} showBilled={showBilled} />}
      </div>
      <div className="group" style={{ padding: "6px 0 8px" }}>Tokens per {gw?.bucket === "week" ? "week" : "day"}</div>
      <UsageBars buckets={gw?.buckets ?? []} series={TOKEN_SERIES} mode="stack" format={fmt}
                 unit={`tokens / ${gw?.bucket === "week" ? "week" : "day"}`} />
      {(showReal || showBilled) && (<>
        <div className="group" style={{ padding: "0 0 8px" }}>Token costs per {gw?.bucket === "week" ? "week" : "day"}</div>
        <UsageBars buckets={gw?.buckets ?? []} series={costSeries(showReal, showBilled)} mode="group"
                   format={(n) => fmtCost(n, cur)} unit={`${currencySymbol(cur)} / ${gw?.bucket === "week" ? "week" : "day"}`} />
      </>)}
      <div className="group" style={{ padding: "0 0 8px" }}>By deployment</div>
      <UsageTable rows={(gw?.byDeployment ?? []).filter(nonZero)} first="Deployment" firstKey="model"
                  showReal={showReal} showBilled={showBilled} currency={cur} />
      <div className="group" style={{ padding: "0 0 8px" }}>By API key</div>
      <UsageTable rows={(gw?.byKey ?? []).filter(nonZero)} first="API key" firstKey="__label"
                  labeler={keyLabel} showReal={showReal} showBilled={showBilled} currency={cur} />
    </>
  );
}
