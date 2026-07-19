// Catalog service: loads the curated model catalog and resolves entries
// into ModelDeployment custom resources (concept §5.2/§5.3).
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { SERVING_NAMESPACE } from "./namespaces.ts";

export { SERVING_NAMESPACE };

export interface CapacityProfile {
  gpuType: string;
  /** Cloud instance type this profile maps to (e.g. g5.xlarge, cpu-4vcpu). */
  instanceType: string;
  gpusPerReplica: number;
  vramGB: number;
  estTokensPerSec: number;
}

export interface CatalogEntry {
  id: string;
  family: string;
  displayName: string;
  parameters: string;
  format: "gguf" | "safetensors";
  quantization?: string;
  source: string;
  license?: string;
  /** Original model release date, YYYY-MM-DD. */
  releaseDate?: string;
  recommendedEngine: string;
  toolCalling?: string;
  contextTokens?: number;
  requirements?: { vramGB: number; diskGB: number; gpus: number };
  capacityProfiles?: CapacityProfile[];
  /** Per-replica k8s requests — MANDATORY (spec 2026-07-16). Prefilled into
   *  the deploy modal; resolveDeployment refuses entries without it. */
  resources: { cpu: string; memory: string };
  /** Thinking-capable models: effort label → reasoning token budget (0 = off).
   *  Absent = the model cannot reason; no Reasoning UI is offered. */
  reasoning?: { efforts: Record<string, number> };
}

export interface DeploymentRequest {
  name: string;
  catalogId: string;
  poolRef: string;
  replicas?: { min: number; max: number; reserve?: number; idleMinutes?: number };
  contextTokens?: number;
  engine?: string;
  reasoningEffort?: string;
  resources?: { cpu?: string; memory?: string };
}

export function loadCatalog(path: string): CatalogEntry[] {
  const doc = parse(readFileSync(path, "utf8"));
  return doc?.models ?? [];
}

export function resolveDeployment(catalog: CatalogEntry[], req: DeploymentRequest) {
  const entry = catalog.find((e) => e.id === req.catalogId);
  if (!entry) throw new Error(`unknown catalog entry: ${req.catalogId}`);

  // Effort → budget resolved NOW (snapshot semantics, like bundled-override
  // snapshots): later catalog edits don't retune existing deployments.
  let reasoning: { effort: string; budgetTokens: number } | undefined;
  if (req.reasoningEffort) {
    const efforts = entry.reasoning?.efforts;
    if (!efforts) throw new Error(`model ${entry.id} does not support configurable reasoning`);
    const budgetTokens = efforts[req.reasoningEffort];
    if (typeof budgetTokens !== "number")
      throw new Error(`unknown reasoning effort "${req.reasoningEffort}" — valid: ${Object.keys(efforts).join(", ")}`);
    const engine = req.engine ?? "auto";
    if (engine !== "auto" && engine !== "llama.cpp")
      throw new Error(`reasoning is llama.cpp-only (engine: ${engine})`);
    reasoning = { effort: req.reasoningEffort, budgetTokens };
  }

  // Per-key: explicit request value wins, else the entry's mandatory value.
  // No legacy default (spec 2026-07-16) — an entry without resources is a
  // pre-rollout data bug, surfaced loudly.
  if (!entry.resources?.cpu || !entry.resources?.memory)
    throw new Error(`catalog entry ${entry.id} has no resources — edit the model and set per-replica requests`);
  const resources: Record<string, string> = {};
  if (entry.requirements?.gpus) resources.gpu = String(entry.requirements.gpus);
  resources.cpu = req.resources?.cpu ?? entry.resources.cpu;
  resources.memory = req.resources?.memory ?? entry.resources.memory;

  return {
    apiVersion: "serving.devproof.ai/v1alpha1",
    kind: "ModelDeployment",
    metadata: { name: req.name, namespace: SERVING_NAMESPACE },
    spec: {
      model: { source: entry.source, format: entry.format, contextTokens: req.contextTokens ?? entry.contextTokens ?? 0 },
      catalogId: entry.id,
      poolRef: req.poolRef,
      engine: req.engine ?? "auto",
      replicas: req.replicas ?? { min: 1, max: 1 },
      resources,
      ...(reasoning ? { reasoning } : {}),
    },
  };
}
