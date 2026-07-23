// Pure row-building for /v1/cache (spec 2026-07-23 issue 1): the LLMkube
// Model CR reports Ready as soon as the SOURCE resolves — the actual download
// runs in the engine pod's model-downloader init container. A model whose pod
// has that init container RUNNING is Downloading, whatever the CR says.
export interface CacheRow {
  name: string; source?: string; size: string | null; phase: string;
  created?: string; progress: number | null;
}
export interface DownloadTarget { name: string; pod: string; total: number }

export function cacheRows(models: any[], pods: any[]): { rows: CacheRow[]; downloading: DownloadTarget[] } {
  // Mid-init pods are phase Pending; only Failed/Succeeded are dead ends
  // (exec into a completed pod is a websocket 500 — spike 2026-07-23).
  const downloaderPod = new Map<string, any>();
  for (const p of pods) {
    const name = p.metadata?.labels?.["inference.llmkube.dev/model"];
    if (!name || p.status?.phase === "Failed" || p.status?.phase === "Succeeded") continue;
    const dl = (p.status?.initContainerStatuses ?? []).find((c: any) => c.name === "model-downloader");
    if (dl?.state?.running) downloaderPod.set(name, p);
  }
  const rows: CacheRow[] = [];
  const downloading: DownloadTarget[] = [];
  for (const m of models) {
    const name = m.metadata?.name;
    const p = downloaderPod.get(name);
    rows.push({
      name,
      source: m.spec?.source,
      size: m.status?.size ?? null,
      phase: p ? "Downloading" : (m.status?.phase ?? "Unknown"),
      created: m.metadata?.creationTimestamp,
      progress: null,
    });
    const total = Number(m.status?.sourceContentLength ?? 0);
    if (p && total > 0) downloading.push({ name, pod: p.metadata.name, total });
  }
  return { rows, downloading };
}

/** 0-100 (clamped) or null when the total is unknown — degrade, never error. */
export const progressPct = (bytes: number, total: number): number | null =>
  total > 0 && Number.isFinite(bytes) && bytes >= 0
    ? Math.min(100, Math.floor((bytes / total) * 100))
    : null;
