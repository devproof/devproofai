"use client";
// Dashboard usage panel (2026-07-14): replicates the deployment-Stats surface
// cross-deployment — the SAME realtime windows (1m…3h), 3s polling, and
// area/cost charts, plus deployment / API-key / all-workspaces filters.
import { useEffect, useState } from "react";
import { wsHeader } from "./lib/client";
import { fmtCost, currencySymbol } from "./lib/currency";
import { UsageBars } from "./lib/usage-bars";
import { TOKEN_SERIES, costSeries } from "./usage/shared";
import { bucketTimeLabel } from "./deployments/[name]/stats";

const WINDOWS: [string, string][] = [["1m", "Last minute"], ["5m", "Last 5 min"],
  ["30m", "Last 30 min"], ["1h", "Last hour"], ["3h", "Last 3 hours"], ["6h", "Last 6 hours"],
  ["12h", "Last 12 hours"], ["24h", "Last 24 hours"], ["48h", "Last 48 hours"]];

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

interface Stats {
  bucketSeconds: number;
  buckets: { t: number; tokens_in: number; tokens_out: number; requests: number; real_cost: number; billed_cost: number }[];
  totals: { tokens_in: number; tokens_out: number; requests: number; real_cost: number; billed_cost: number };
  costs: { currency: string; tokensOnly: boolean; real: boolean; billed: boolean } | null;
}

export function DashboardUsage({ deployments }: { deployments: string[] }) {
  const [win, setWin] = useState("24h");
  const [deployment, setDeployment] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [allWs, setAllWs] = useState(false);
  const [keys, setKeys] = useState<any[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let stale = false;
    fetch(`/api/v1/api-keys?${allWs ? "all=1" : "include=deleted&limit=1000"}`, { headers: wsHeader() })
      .then((r) => r.json()).then((j) => {
        if (stale) return;
        const next = j.keys ?? [];
        setKeys(next);
        setApiKey((k) => k && k !== "__internal__" && !next.some((x: any) => x.id === k) ? "" : k);
      }).catch(() => {});
    return () => { stale = true; };
  }, [allWs]);

  useEffect(() => {
    let stale = false;
    const load = () => {
      const q = new URLSearchParams({ window: win });
      if (deployment) q.set("deployment", deployment);
      if (apiKey) q.set("api_key", apiKey);
      if (allWs) q.set("workspaces", "all");
      fetch(`/api/v1/usage/realtime?${q}`, { headers: wsHeader() })
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => { if (!stale) { if (s) { setStats(s); setLive(true); } else setLive(false); } })
        .catch(() => { if (!stale) setLive(false); });
    };
    load();
    const iv = setInterval(load, 3000);
    return () => { stale = true; clearInterval(iv); };
  }, [win, deployment, apiKey, allWs]);

  const tokensOnly = stats?.costs?.tokensOnly ? " (tokens only)" : "";
  const showReal = !!stats?.costs?.real;
  const showBilled = !!stats?.costs?.billed;
  const buckets = (stats?.buckets ?? []).map((b) => ({ ...b, label: bucketTimeLabel(b.t, stats!.bucketSeconds) }));
  const fmtC = (n: number) =>
    `${n >= 1 || n === 0 ? n.toFixed(2) : n.toFixed(4)} ${currencySymbol(stats?.costs?.currency ?? "EUR")}`;
  return (
    <>
      <div className="group" style={{ padding: "18px 0 8px", fontWeight: 600 }}>Usage</div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <select value={win} onChange={(e) => setWin(e.target.value)}>
          {WINDOWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={deployment} onChange={(e) => setDeployment(e.target.value)} style={{ width: 200, flex: "none" }}>
          <option value="">All deployments</option>
          {deployments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        {/* Fixed width: cross-workspace labels are longer — the bar must not
            reflow when the key list swaps (user feedback 2026-07-14). */}
        <select value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={{ width: 220, flex: "none" }}>
          <option value="">All traffic</option>
          <option value="__internal__">(internal sessions)</option>
          {keys.map((k) => <option key={k.id} value={k.id}>
            {k.name}{k.status === "deleted" ? " [deleted]" : ""}{k.workspace_name ? ` — ${k.workspace_name}` : ""}
          </option>)}
        </select>
        <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={allWs} onChange={(e) => setAllWs(e.target.checked)} />
          All workspaces
        </label>
        <span className={`livedot ${live ? "on" : ""}`} title={live ? "updating every 3s" : "not connected"} />
      </div>
      <p className="sub" style={{ margin: "0 0 14px" }}>
        Counts all traffic — API keys and agent sessions{allWs ? ", across all workspaces" : " in this workspace"}.
        Time-based costs accrue per started minute while replicas run, even with zero traffic.
      </p>

      <div className="cards">
        <div className="card"><h3>Requests</h3><div className="big">{stats?.totals.requests ?? 0}</div></div>
        <div className="card"><h3>Input tokens</h3><div className="big">{fmt(stats?.totals.tokens_in ?? 0)}</div></div>
        <div className="card"><h3>Output tokens</h3><div className="big">{fmt(stats?.totals.tokens_out ?? 0)}</div></div>
        {stats?.costs && showReal && (
          <div className="card"><h3>Real cost{tokensOnly}</h3>
            <div className="big">{fmtCost(stats.totals.real_cost, stats.costs.currency)}</div></div>)}
        {stats?.costs && showBilled && (
          <div className="card"><h3>Billed cost{tokensOnly}</h3>
            <div className="big">{fmtCost(stats.totals.billed_cost, stats.costs.currency)}</div></div>)}
      </div>

      <div className="group" style={{ padding: "6px 0 8px" }}>
        Tokens per {stats ? `${stats.bucketSeconds}s` : "bucket"}
      </div>
      {buckets.length
        ? <UsageBars buckets={buckets} labelKey="label" series={TOKEN_SERIES} mode="stack" format={fmt}
                     unit={`tokens / ${stats!.bucketSeconds}s`} />
        : <div className="empty">No traffic yet.</div>}

      {stats?.costs && (showReal || showBilled) && (<>
        <div className="group" style={{ padding: "14px 0 8px" }}>
          Cost per {stats.bucketSeconds}s
          {stats.costs.tokensOnly && <span style={{ marginLeft: 12, fontSize: 11, color: "var(--muted)" }}>
            tokens only (filter active)</span>}
        </div>
        {buckets.length
          ? <UsageBars buckets={buckets} labelKey="label" series={costSeries(showReal, showBilled)} mode="group" format={fmtC}
                       unit={`${currencySymbol(stats.costs.currency)} / ${stats.bucketSeconds}s`} />
          : <div className="empty">No cost data yet.</div>}
      </>)}
    </>
  );
}
