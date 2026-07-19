// KubeStore: thin seam over the Kubernetes API so routes stay unit-testable.
import * as k8s from "@kubernetes/client-node";
import { GATEWAY_NAMESPACE, SERVING_NAMESPACE } from "./namespaces.ts";

const GROUP = "serving.devproof.ai";
const VERSION = "v1alpha1";
export { GATEWAY_NAMESPACE };

export interface KubeStore {
  list(plural: "modelpools" | "modeldeployments"): Promise<any[]>;
  get(plural: "modelpools" | "modeldeployments", name: string): Promise<any | null>;
  create(plural: "modelpools" | "modeldeployments", body: any): Promise<any>;
  /** JSON merge-patch a Devproof CR (local deployment edits). */
  patch(plural: "modelpools" | "modeldeployments", name: string, body: any): Promise<any>;
  delete(plural: "modelpools" | "modeldeployments", name: string): Promise<void>;
  /** LLMkube Model resources — the downloaded/cached model artifacts. */
  listCachedModels(): Promise<any[]>;
  /** Evict a cached model (delete the LLMkube Model CR). */
  deleteCachedModel(name: string): Promise<void>;
  /** Apply the LiteLLM config. Returns false (no-op, no gateway restart) when
   *  the config is already identical — lets the operator trigger syncs freely. */
  writeGatewayConfig(configYaml: string): Promise<boolean>;
  /** Resolve once the gateway Deployment has fully rolled out — no stale
   *  replicas serving an older config. Returns false on timeout (rollout
   *  stuck); callers may proceed but must expect mixed-config routing. */
  awaitGatewayRollout(): Promise<boolean>;
  /** Set one entry of the gateway-provider-keys Secret (external API keys). */
  writeProviderKey(entryKey: string, value: string): Promise<void>;
  /** Remove one entry of the gateway-provider-keys Secret. */
  deleteProviderKey(entryKey: string): Promise<void>;
}

export function realKubeStore(): KubeStore {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const custom = kc.makeApiClient(k8s.CustomObjectsApi);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const apps = kc.makeApiClient(k8s.AppsV1Api);

  const base = { group: GROUP, version: VERSION, namespace: SERVING_NAMESPACE };
  return {
    async list(plural) {
      const res: any = await custom.listNamespacedCustomObject({ ...base, plural });
      return res.items ?? [];
    },
    async get(plural, name) {
      try {
        return await custom.getNamespacedCustomObject({ ...base, plural, name });
      } catch (err: any) {
        if (err?.code === 404) return null;
        throw err;
      }
    },
    async create(plural, body) {
      return custom.createNamespacedCustomObject({ ...base, plural, body });
    },
    async patch(plural, name, body) {
      const mergePatch = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);
      return custom.patchNamespacedCustomObject({ ...base, plural, name, body }, mergePatch);
    },
    async delete(plural, name) {
      await custom.deleteNamespacedCustomObject({ ...base, plural, name });
    },
    async listCachedModels() {
      const res: any = await custom.listNamespacedCustomObject({
        group: "inference.llmkube.dev",
        version: "v1alpha1",
        namespace: SERVING_NAMESPACE,
        plural: "models",
      });
      return res.items ?? [];
    },
    async deleteCachedModel(name) {
      try {
        await custom.deleteNamespacedCustomObject({
          group: "inference.llmkube.dev", version: "v1alpha1",
          namespace: SERVING_NAMESPACE, plural: "models", name,
        });
      } catch (err: any) { if (err?.code !== 404) throw err; }
    },
    async writeGatewayConfig(configYaml) {
      const current: any = await core.readNamespacedConfigMap({
        name: "litellm-config",
        namespace: GATEWAY_NAMESPACE,
      });
      if (current?.data?.["config.yaml"] === configYaml) return false;
      const mergePatch = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);
      await core.patchNamespacedConfigMap(
        {
          name: "litellm-config",
          namespace: GATEWAY_NAMESPACE,
          body: { data: { "config.yaml": configYaml } },
        },
        mergePatch,
      );
      // Restart the proxy to pick up the new config.
      await apps.patchNamespacedDeployment(
        {
          name: "gateway",
          namespace: GATEWAY_NAMESPACE,
          body: {
            spec: {
              template: {
                metadata: {
                  annotations: { "devproof.ai/config-sync": new Date().toISOString() },
                },
              },
            },
          },
        },
        mergePatch,
      );
      return true;
    },
    async awaitGatewayRollout() {
      // Mirrors `kubectl rollout status`: the controller has observed the
      // latest template (observedGeneration), every replica is updated AND
      // no old-ReplicaSet pods remain (replicas === updatedReplicas), and
      // the updated pods are available. Live-bug 2026-07-12: a warmup that
      // succeeded via one reloaded pod released a session into a stale
      // route-less replica that kept serving for minutes → 400.
      const deadline = Date.now() + 10 * 60_000;
      for (;;) {
        try {
          const d: any = await apps.readNamespacedDeployment({ name: "gateway", namespace: GATEWAY_NAMESPACE });
          const want = d.spec?.replicas ?? 1;
          const s = d.status ?? {};
          if ((s.observedGeneration ?? 0) >= (d.metadata?.generation ?? 0)
              && (s.updatedReplicas ?? 0) >= want
              && (s.replicas ?? 0) === (s.updatedReplicas ?? 0)
              && (s.availableReplicas ?? 0) >= want) return true;
        } catch { /* transient API error — keep polling until the deadline */ }
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 5_000).unref());
      }
    },
    async writeProviderKey(entryKey, value) {
      const b64 = Buffer.from(value, "utf8").toString("base64");
      const mergePatch = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);
      try {
        await core.patchNamespacedSecret(
          { name: "gateway-provider-keys", namespace: GATEWAY_NAMESPACE, body: { data: { [entryKey]: b64 } } },
          mergePatch,
        );
      } catch (err: any) {
        if (err?.code !== 404) throw err;
        await core.createNamespacedSecret({
          namespace: GATEWAY_NAMESPACE,
          body: { metadata: { name: "gateway-provider-keys" }, data: { [entryKey]: b64 } },
        });
      }
    },
    async deleteProviderKey(entryKey) {
      const mergePatch = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);
      try {
        await core.patchNamespacedSecret(
          { name: "gateway-provider-keys", namespace: GATEWAY_NAMESPACE, body: { data: { [entryKey]: null } } },
          mergePatch,
        );
      } catch (err: any) {
        if (err?.code !== 404) throw err;
      }
    },
  };
}
