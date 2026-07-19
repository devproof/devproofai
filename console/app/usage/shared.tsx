"use client";
// Shared pieces of the two usage pages (Usage - API / Usage - Sessions,
// split 2026-07-14): ranges, formatters, cost cards, and the usage table.
import { fmtCost } from "../lib/currency";

export const RANGES: [string, string][] = [
  ["1d", "Last day"], ["3d", "Last 3 days"], ["7d", "Last 7 days"], ["14d", "Last 14 days"],
  ["28d", "Last 28 days"], ["month", "Current month"], ["last_month", "Last month"],
  ["3m", "Last 3 months"], ["6m", "Last 6 months"],
];
export const DEFAULT_RANGE = "28d";

export const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

export interface Row { [k: string]: any }

export const TOKEN_SERIES = [
  { key: "tokens_in", color: "var(--chart1)", label: "input" },
  { key: "tokens_out", color: "var(--chart2)", label: "output" },
];
// Token-cost series (real vs billed are NOT additive — render grouped).
export const COST_SERIES = [
  { key: "real_cost", color: "var(--chart1)", label: "real" },
  { key: "billed_cost", color: "var(--chart2)", label: "billed" },
];

/** Per-ledger chart series (spec 2026-07-15): a disabled ledger drops its
 *  series. With both off the CALLER renders no chart at all — never call this
 *  expecting an empty array to hide anything. */
export const costSeries = (showReal: boolean, showBilled: boolean) =>
  COST_SERIES.filter((s) => (s.key === "real_cost" ? showReal : showBilled));

// Categorical palette for stacked charts with an arbitrary series count
// (routing target/rule breakdowns, fix wave H). --chart1/2 lead (matching the
// token chart), then mid-tone accents that read on both themes behind the
// bars' 30%-translucent fills. Cycles if a chart has more series than colors.
export const CHART_PALETTE = [
  "var(--chart1)", "var(--chart2)", "#a855f7", "#f59e0b", "#14b8a6",
  "#ec4899", "#84cc16", "#6366f1", "#f97316", "#06b6d4",
];
/** Build UsageBars series from ordered keys. `reject` gets a fixed red so it
 *  always stands out; other keys cycle the palette by position. */
export const seriesFrom = (keys: string[], label?: (k: string) => string) =>
  keys.map((k, i) => ({
    key: k,
    color: k === "rejects" ? "#ef4444" : CHART_PALETTE[i % CHART_PALETTE.length],
    label: label ? label(k) : k,
  }));

export const nonZero = (r: Row) =>
  ["requests", "tokens_in", "tokens_out", "real_cost", "billed_cost", "sessions"]
    .some((k) => Number(r[k] ?? 0) > 0);

export function CostCards({ totals, currency, extra, hint, showReal, showBilled }: {
  totals: Row; currency: string; extra?: { real: number; billed: number } | null; hint?: string;
  showReal: boolean; showBilled: boolean;
}) {
  const real = Number(totals.real_cost ?? 0) + (extra?.real ?? 0);
  const billed = Number(totals.billed_cost ?? 0) + (extra?.billed ?? 0);
  return (<>
    {showReal && <div className="card"><h3>Real costs{hint ? ` ${hint}` : ""}</h3>
      <div className="big">{fmtCost(real, currency)}</div></div>}
    {showBilled && <div className="card"><h3>Billed costs{hint ? ` ${hint}` : ""}</h3>
      <div className="big">{fmtCost(billed, currency)}</div></div>}
  </>);
}

export function UsageTable({ rows, first, firstKey, labeler, sessions, showReal, showBilled, currency }: {
  rows: Row[]; first: string; firstKey: string; labeler?: (r: Row) => string;
  sessions?: boolean; showReal: boolean; showBilled: boolean; currency: string;
}) {
  // Derived, not hard-coded: first + requests + in + out, plus the optional
  // sessions / real / billed columns.
  const cols = 4 + (sessions ? 1 : 0) + (showReal ? 1 : 0) + (showBilled ? 1 : 0);
  return (
    <div className="tablewrap" style={{ marginBottom: 22 }}><table>
      <thead><tr>
        <th>{first}</th>{sessions && <th>Sessions</th>}<th>Requests</th>
        <th>Input tokens</th><th>Output tokens</th>
        {showReal && <th>Real costs</th>}{showBilled && <th>Billed costs</th>}
      </tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{labeler ? labeler(r) : <code>{r[firstKey]}</code>}</td>
            {sessions && <td>{r.sessions}</td>}
            <td>{r.requests}</td>
            <td>{fmt(Number(r.tokens_in ?? 0))}</td><td>{fmt(Number(r.tokens_out ?? 0))}</td>
            {showReal && <td>{fmtCost(Number(r.real_cost ?? 0), currency)}</td>}
            {showBilled && <td>{fmtCost(Number(r.billed_cost ?? 0), currency)}</td>}
          </tr>
        ))}
        {rows.length === 0 && <tr><td colSpan={cols} className="empty">No usage in this range.</td></tr>}
      </tbody>
    </table></div>
  );
}
