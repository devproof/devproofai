"use client";
// Realtime token graph (spec 2026-07-10): 3s polling over gateway_usage
// buckets, rendered with the same stacked/grouped bar charts as the usage
// pages (user 2026-07-14) — windows, buckets, and units are unchanged.
import { useEffect, useState } from "react";
import { wsHeader } from "../../lib/client";
import { UsageBars } from "../../lib/usage-bars";
import { TOKEN_SERIES, costSeries, seriesFrom } from "../../usage/shared";
import { fmtCost, currencySymbol } from "../../lib/currency";

// Rule-index -> readable label for the "requests by rule" chart (fix wave H).
const ruleLabel = (k: string) =>
  k === "rejects" ? "rejected" : k === "null" ? "(pre-feature)"
    : k === "-1" ? "No match (default)" : k === "-2" ? "classifier"
    : `Rule ${Number(k) + 1}`;

// Placeholder single all-zero series (fix wave I): keeps the chart frame +
// zero-filled bucket axis rendering even before any target/rule has been
// seen, matching how the tokens chart always renders its frame.
const NO_TARGETS = [{ key: "_none", color: "var(--muted)", label: "no routed requests yet" }];
const NO_RULES = [{ key: "_none", color: "var(--muted)", label: "no rule matches yet" }];

const WINDOWS: [string, string][] = [["1m", "Last minute"], ["5m", "Last 5 min"],
  ["30m", "Last 30 min"], ["1h", "Last hour"], ["3h", "Last 3 hours"], ["6h", "Last 6 hours"],
  ["12h", "Last 12 hours"], ["24h", "Last 24 hours"], ["48h", "Last 48 hours"]];

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

// Time labels: seconds below 1h windows; weekday prefix once a window spans a
// day boundary (>=24h — bare times would repeat within the span).
export const bucketTimeLabel = (t: number, bucketSeconds: number) => {
  const d = new Date(t * 1000);
  if (bucketSeconds < 60) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (bucketSeconds >= 1440) return d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

interface Bucket { t: number; tokens_in: number; tokens_out: number; requests: number; real_cost: number; billed_cost: number }
interface Stats {
  bucketSeconds: number;
  buckets: Bucket[];
  totals: { tokens_in: number; tokens_out: number; requests: number; real_cost: number; billed_cost: number };
  costs: { currency: string; tokensOnly: boolean; real: boolean; billed: boolean } | null;
  targets?: { model: string; requests: number }[];
  rejects?: number;
  targetBuckets?: { t: number; [model: string]: number }[];
  targetSeries?: string[];
  ruleBuckets?: { t: number; [rule: string]: number }[];
  ruleSeries?: string[];
}

export function StatsTab({ name, keys, agents, basePath = "/v1/deployments" }:
  { name: string; keys: { id: string; name: string }[]; agents: { id: string; name: string }[]; basePath?: string }) {
  const [win, setWin] = useState("24h");
  const [apiKey, setApiKey] = useState("");
  const [agent, setAgent] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let stale = false;
    const load = () => {
      const q = new URLSearchParams({ window: win });
      if (apiKey) q.set("api_key", apiKey);
      if (agent) q.set("agent", agent);
      fetch(`/api${basePath}/${encodeURIComponent(name)}/stats?${q}`, { headers: wsHeader() })
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => { if (!stale) { if (s) { setStats(s); setLive(true); } else setLive(false); } })
        .catch(() => { if (!stale) setLive(false); });
    };
    load();
    const iv = setInterval(load, 3000);
    return () => { stale = true; clearInterval(iv); };
  }, [name, win, apiKey, agent, basePath]);

  const buckets = (stats?.buckets ?? []).map((b) => ({ ...b, label: bucketTimeLabel(b.t, stats!.bucketSeconds) }));
  const fmtC = (n: number) =>
    `${n >= 1 || n === 0 ? n.toFixed(2) : n.toFixed(4)} ${currencySymbol(stats?.costs?.currency ?? "EUR")}`;
  const showReal = !!stats?.costs?.real;
  const showBilled = !!stats?.costs?.billed;

  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <select value={win} onChange={(e) => setWin(e.target.value)}>
          {WINDOWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={apiKey} onChange={(e) => setApiKey(e.target.value)}>
          <option value="">All traffic</option>
          <option value="__internal__">(internal sessions)</option>
          {keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
        </select>
        <select value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">All agents</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <span className={`livedot ${live ? "on" : ""}`} title={live ? "updating every 3s" : "not connected"} />
      </div>
      <p className="sub" style={{ margin: "0 0 14px" }}>
        Counts all traffic on this deployment — API keys and agent sessions, across all workspaces.
        Time-based costs accrue per started minute while replicas run, even with zero traffic.
      </p>

      <div className="cards">
        <div className="card"><h3>Input tokens</h3><div className="big">{fmt(stats?.totals.tokens_in ?? 0)}</div></div>
        <div className="card"><h3>Output tokens</h3><div className="big">{fmt(stats?.totals.tokens_out ?? 0)}</div></div>
        <div className="card"><h3>Requests</h3><div className="big">{stats?.totals.requests ?? 0}</div></div>
        {stats?.costs && showReal && (
          <div className="card"><h3>Real cost</h3>
            <div className="big">{fmtCost(stats.totals.real_cost, stats.costs.currency)}</div></div>)}
        {stats?.costs && showBilled && (
          <div className="card"><h3>Billed cost</h3>
            <div className="big">{fmtCost(stats.totals.billed_cost, stats.costs.currency)}</div></div>)}
      </div>

      {/* Routing-only breakdown charts (fix wave H): render only when the
          payload carries them — deployment stats never do. */}
      {stats?.targetSeries && (<>
        <div className="group" style={{ padding: "6px 0 8px", display: "flex", alignItems: "baseline", gap: 12 }}>
          <span>Requests by target</span>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            {stats.rejects ?? 0} rejected in this window
          </span>
        </div>
        <UsageBars
          buckets={(stats.targetBuckets ?? []).map((b) => ({ ...b, label: bucketTimeLabel(b.t, stats.bucketSeconds) }))}
          labelKey="label"
          series={stats.targetSeries.length ? seriesFrom(stats.targetSeries) : NO_TARGETS}
          mode="stack" format={(n) => String(n)}
          unit={`requests / ${stats.bucketSeconds}s`} />

        <div className="group" style={{ padding: "14px 0 8px" }}>Requests by rule</div>
        <UsageBars
          buckets={(stats.ruleBuckets ?? []).map((b) => ({ ...b, label: bucketTimeLabel(b.t, stats.bucketSeconds) }))}
          labelKey="label"
          series={stats.ruleSeries?.length ? seriesFrom(stats.ruleSeries, ruleLabel) : NO_RULES}
          mode="stack" format={(n) => String(n)}
          unit={`requests / ${stats.bucketSeconds}s`} />
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          classifier calls are counted separately — the stack may exceed request totals
        </div>
      </>)}

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
