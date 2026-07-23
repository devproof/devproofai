"use client";
import { useEffect, useState } from "react";
import { apiGet } from "../lib/client";
import { DeleteButton } from "../lib/delete";
import { DateTime } from "../lib/datetime";

export interface CacheEntry {
  name: string; source: string; size: string | null; phase: string;
  created: string; progress: number | null;
}

// Polls /v1/cache every 3s WHILE any row is Downloading; idle otherwise.
export function CacheTable({ initial, offset }: { initial: CacheEntry[]; offset: number }) {
  const [rows, setRows] = useState(initial);
  const downloading = rows.some((r) => r.phase === "Downloading");
  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(() => {
      apiGet<{ cache: CacheEntry[] }>(`/v1/cache?offset=${offset}`)
        .then((j) => setRows(j.cache)).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [downloading, offset]);
  return (
    <table>
      <thead>
        <tr><th>Name</th><th>Size</th><th>Phase</th><th>Source</th><th>Downloaded</th><th></th></tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.name}>
            <td>{c.name}</td>
            <td>{c.size ?? "—"}</td>
            <td>
              <span className={`phase ${c.phase === "Downloading" ? "Deploying" : c.phase}`}>
                {c.phase === "Downloading" && c.progress != null
                  ? `Downloading ${c.progress}%` : c.phase}
              </span>
            </td>
            <td><code style={{ wordBreak: "break-all" }}>{c.source}</code></td>
            <td><DateTime iso={c.created} /></td>
            <td><DeleteButton path={`/v1/cache/${c.name}`} confirmText={`Evict cached model "${c.name}"? It will re-download on next deploy.`} label="Evict" /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
