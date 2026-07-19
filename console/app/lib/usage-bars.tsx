"use client";
// Shared usage bar chart (spec 2026-07-14 §6) — replaces the two ad-hoc
// 140px flex-bar charts. mode "stack": series stack (input/output tokens);
// mode "group": side-by-side bars (real vs billed cost — not additive).
// Anatomy matches the realtime charts (user 2026-07-14): y-axis labels +
// unit, dashed gridlines, and a hover tooltip with per-series values.
// Look: translucent fills with a solid hairline cap.
import { useState } from "react";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface BarSeries { key: string; color: string; label: string }

const fill = (c: string) => `color-mix(in srgb, ${c} 30%, transparent)`;

export function UsageBars({ buckets, labelKey = "bucket", series, mode = "stack", height = 200, format, unit }: {
  buckets: any[]; labelKey?: string; series: BarSeries[]; mode?: "stack" | "group";
  height?: number; format: (n: number) => string; unit?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (!buckets.length) return <div className="empty">No usage in this range.</div>;
  const n = buckets.length;
  const total = (b: any) => mode === "stack"
    ? series.reduce((a, s) => a + Number(b[s.key] ?? 0), 0)
    : Math.max(...series.map((s) => Number(b[s.key] ?? 0)));
  const rawPeak = Math.max(...buckets.map(total));
  const peak = Math.max(1e-9, rawPeak);       // height math only — never divide by 0
  const axisPeak = rawPeak > 0 ? rawPeak : 0; // labels stay honest zeros when empty
  const step = Math.ceil(n / 8);   // ≤8 readable labels
  const label = (v: string, long = false) => {
    const d = new Date(`${v}T00:00:00`);
    return Number.isNaN(d.getTime()) ? v : `${DAYS[d.getDay()]} ${long ? v : v.slice(5)}`;
  };
  const hb = hover != null ? buckets[hover] : null;
  const x = (i: number) => ((i + 0.5) / n) * 100;

  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>
        {series.map((s) => <span key={s.key} style={{ marginRight: 14 }}>
          <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, marginRight: 4,
                         background: fill(s.color), border: `1.5px solid ${s.color}`,
                         verticalAlign: "-1px" }} /> {s.label}</span>)}
      </div>
    <div className="rt2" style={{ gridTemplateRows: `${height}px 26px`, marginBottom: 0 }}>
      <div className="rt2-y">
        <span>{format(axisPeak)}</span><span>{format(axisPeak / 2)}</span><span>0</span>
      </div>
      <div className="rt2-plot"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n))));
        }}
        onMouseLeave={() => setHover(null)}>
        <div className="rt2-grid" style={{ top: "0%" }} />
        <div className="rt2-grid" style={{ top: "50%" }} />
        <div style={{ position: "absolute", inset: "8px 6px 0", display: "flex", alignItems: "flex-end", gap: 4 }}>
          {buckets.map((b, i) => (
            <div key={b[labelKey]}
                 style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%",
                          justifyContent: "flex-end", borderRadius: 3,
                          background: hover === i ? "var(--hover)" : "transparent" }}>
              {mode === "stack" ? (
                <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end",
                              height: `${(total(b) / peak) * 100}%`, minHeight: total(b) ? 3 : 0 }}>
                  {[...series].reverse().map((s) => (
                    <div key={s.key} style={{ background: fill(s.color), flexGrow: Number(b[s.key] ?? 0) || 0.0001,
                      borderTop: Number(b[s.key] ?? 0) ? `2px solid ${s.color}` : 0,
                      borderRadius: "2px 2px 0 0" }} />
                  ))}
                </div>
              ) : (
                <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: "100%" }}>
                  {series.map((s) => (
                    <div key={s.key} style={{ flex: 1, background: fill(s.color),
                      borderTop: Number(b[s.key] ?? 0) ? `2px solid ${s.color}` : 0,
                      borderRadius: "2px 2px 0 0",
                      height: `${(Number(b[s.key] ?? 0) / peak) * 100}%`,
                      minHeight: Number(b[s.key] ?? 0) ? 3 : 0 }} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        {hb && (
          <div className="rt2-tip" style={{ left: `${x(hover!)}%`, ...(x(hover!) > 70 ? { transform: "translateX(-105%)" } : {}) }}>
            <div className="rt2-tip-t">{label(String(hb[labelKey]), true)}</div>
            {series.map((s) => (
              <div key={s.key}><span style={{ color: s.color }}>■</span> {s.label} <b>{format(Number(hb[s.key] ?? 0))}</b></div>
            ))}
            {mode === "stack" && series.length > 1 && (
              <div><span className="muted">total</span> <b>{format(total(hb))}</b></div>
            )}
          </div>
        )}
        {unit && <span className="rt2-yunit">{unit}</span>}
      </div>
      <div style={{ gridColumn: 2, display: "flex", gap: 4, padding: "4px 6px 0" }}>
        {buckets.map((b, i) => (
          <div key={b[labelKey]} style={{ flex: 1, fontSize: 10, color: "var(--muted)",
                textAlign: "center", overflow: "visible", whiteSpace: "nowrap" }}>
            {i % step === 0 ? label(String(b[labelKey])) : ""}
          </div>
        ))}
      </div>
    </div>
    </div>
  );
}
