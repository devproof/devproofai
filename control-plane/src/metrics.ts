// Live serving metrics from Prometheus (concept §6.5 serving observability).
export const PROMETHEUS_URL =
  process.env.DEVPROOF_PROMETHEUS ?? "http://127.0.0.1:19090";

export function servingMetricsQuery(metric: string): string {
  return `sum by (service) (${metric})`;
}

export interface PromVector {
  status: string;
  data: { result: { metric: Record<string, string>; value: [number, string] }[] };
}

export function parseVector(res: PromVector): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of res.data?.result ?? []) {
    if (r.metric.service) out[r.metric.service] = Number(r.value[1]);
  }
  return out;
}

/**
 * Learning loop (concept §5.5): fold measured peak throughput per deployment
 * back onto catalog entries via the deployment→catalogId mapping. Highest
 * observation wins; entries never measured get null.
 */
export function observedByCatalogId(
  deployments: { name: string; catalogId?: string }[],
  peakByService: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of deployments) {
    if (!d.catalogId) continue;
    const v = peakByService[d.name];
    if (v == null) continue;
    out[d.catalogId] = Math.max(out[d.catalogId] ?? 0, v);
  }
  return out;
}

export async function fetchPeakThroughput(baseUrl = PROMETHEUS_URL): Promise<Record<string, number>> {
  try {
    const q = `max by (service) (max_over_time(llamacpp:predicted_tokens_seconds[24h]))`;
    const res = await fetch(`${baseUrl}/api/v1/query?query=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(3000),
    });
    return parseVector(await res.json());
  } catch {
    return {};
  }
}

export async function fetchServingMetrics(baseUrl = PROMETHEUS_URL) {
  const q = async (metric: string) => {
    try {
      const url = `${baseUrl}/api/v1/query?query=${encodeURIComponent(servingMetricsQuery(metric))}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return parseVector(await res.json());
    } catch {
      return {}; // metrics are best-effort decoration
    }
  };
  // Queue depth is NOT fetched here anymore — the operator's scaler publishes
  // it in ModelDeployment status (works without Prometheus).
  return { tokens: await q("llamacpp:predicted_tokens_seconds") };
}
