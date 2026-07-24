// One-time default resource seed (spec 2026-07-24-default-resource-seeding-
// design.md): the first boot with DEVPROOF_SEED_DEFAULTS=true and no
// app_settings marker seeds two starter environments into the default
// workspace and two starter pools — skip-if-exists per resource, nothing is
// ever overwritten — then sets the marker so deletions never resurrect them.
import type { KubeStore } from "./kubestore.ts";
import { SERVING_NAMESPACE } from "./namespaces.ts";
import { DEFAULT_WORKSPACE, Repo } from "./repo.ts";

export const SEED_ENVIRONMENTS = [
  { name: "default-all-blocked", allowPackageManagers: false, allowedHosts: [] as string[], allowMcpServers: false },
  { name: "default-all-allowed", allowPackageManagers: true, allowedHosts: ["*"], allowMcpServers: true },
];

export const SEED_POOLS = [
  { name: "default-cpu", spec: { gpuType: "cpu", gpusPerNode: 0, maxNodes: 1, nodeSelector: {}, tolerations: [] } },
  { name: "default-gpu", spec: { gpuType: "gpu", gpusPerNode: 1, maxNodes: 1, nodeSelector: {}, tolerations: [] } },
];

export async function seedDefaults(opts: {
  repo: Repo;
  kube: Pick<KubeStore, "get" | "create"> | null; // null = local serving disabled
  workspaceId?: string; // tests only; production always seeds the default workspace
}): Promise<void> {
  if (process.env.DEVPROOF_SEED_DEFAULTS !== "true") return;
  const { repo, kube } = opts;
  const workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE;
  if (await repo.getSeedDefaultsApplied()) return;

  for (const e of SEED_ENVIRONMENTS) {
    try {
      await repo.createEnvironment(workspaceId, e.name, e.allowPackageManagers,
        e.allowedHosts, { disk: { type: "emptyDir" } }, e.allowMcpServers);
    } catch (err: any) {
      if (err?.code !== "23505") throw err; // unique (workspace_id, name) → already exists, skip
    }
  }

  if (kube) {
    for (const p of SEED_POOLS) {
      if (await kube.get("modelpools", p.name)) continue;
      try {
        await kube.create("modelpools", {
          apiVersion: "serving.devproof.ai/v1alpha1",
          kind: "ModelPool",
          metadata: { name: p.name, namespace: SERVING_NAMESPACE },
          spec: p.spec,
        });
      } catch (err: any) {
        if (err?.code !== 409) throw err; // AlreadyExists — a concurrent seeder won the race
      }
    }
  } else {
    console.warn("seed-defaults: local serving disabled — pools default-cpu/default-gpu not seeded");
  }

  // Marker only after every resource succeeded (created or skipped): a
  // transient failure above leaves it unset so the next boot retries, and
  // skip-if-exists makes the retry harmless.
  await repo.setSeedDefaultsApplied();
  console.log("seed-defaults: default environments and pools ensured");
}
