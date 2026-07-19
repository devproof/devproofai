// Aggregates the cluster's node labels and taints into pick-lists for the
// environment scheduling editors (spec 2026-07-14). Pure — the orchestrator
// feeds it `core.listNode().items`.

export interface NodeScheduling {
  labels: Record<string, string[]>;
  taints: { key: string; value: string; effect: string }[];
}

export function aggregateNodeScheduling(nodes: any[]): NodeScheduling {
  const labelSets: Record<string, Set<string>> = {};
  const seenTaints = new Set<string>();
  const taints: NodeScheduling["taints"] = [];
  for (const n of nodes ?? []) {
    for (const [k, v] of Object.entries(n?.metadata?.labels ?? {})) {
      (labelSets[k] ??= new Set()).add(String(v));
    }
    for (const t of n?.spec?.taints ?? []) {
      const key = t?.key ?? "", value = t?.value ?? "", effect = t?.effect ?? "";
      const id = `${key}|${value}|${effect}`;
      if (!seenTaints.has(id)) { seenTaints.add(id); taints.push({ key, value, effect }); }
    }
  }
  const labels: Record<string, string[]> = {};
  for (const [k, set] of Object.entries(labelSets)) labels[k] = [...set].sort();
  return { labels, taints };
}
