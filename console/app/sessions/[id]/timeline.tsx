"use client";
// Segmented duration bar: one segment per transcript row, width ∝ duration.
import type { Row } from "./rows";

const COLOR: Record<Row["kind"], string> = {
  user: "var(--accent)", agent: "var(--blue)", thinking: "#9ec1f7",
  tool: "#8a63d2", skill: "var(--skill)", subagent: "var(--subagent)", system: "var(--muted)",
  wait: "var(--wait)",
};

export function Timeline({ rows, selectedSeq, onSelect }: {
  rows: Row[]; selectedSeq: number | null; onSelect: (seq: number) => void;
}) {
  if (!rows.length) return null;
  const total = Math.max(1, rows.reduce((s, r) => s + Math.max(r.durationMs, 1), 0));
  return (
    <div className="timeline" title="session timeline">
      {rows.map((r) => (
        <span key={r.seq} onClick={() => onSelect(r.seq)}
          className={selectedSeq === r.seq ? "sel" : ""}
          style={{ flexBasis: `${Math.max(1.5, (Math.max(r.durationMs, 1) / total) * 100)}%`,
                   background: COLOR[r.kind] }}
          title={`${r.title} · ${(r.durationMs / 1000).toFixed(1)}s`} />
      ))}
    </div>
  );
}
