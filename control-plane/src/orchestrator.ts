// Session orchestrator: one K8s Job per session running the session-runner
// image (concept §6.2). Dev topology: control plane runs on the host, session
// pods call back via host.docker.internal.
import * as k8s from "@kubernetes/client-node";
import type { Orchestrator } from "./agents-api.ts";
import { squidConf } from "./egress.ts";
import type { PodConfig } from "./pod-config.ts";
import { aggregateNodeScheduling } from "./node-scheduling.ts";
import { AGENTS_NAMESPACE, GATEWAY_NAMESPACE } from "./namespaces.ts";
import { INTERNAL_KEY_SECRET, INTERNAL_KEY_ENTRY } from "./gateway-secret.ts";

const RUNNER_IMAGE = process.env.DEVPROOF_RUNNER_IMAGE ?? "devproof/session-runner:dev";
// Egress-proxy image + pod contract (resources/nodeSelector/tolerations) from
// the chart (agents.egressProxy). Fallbacks match the chart defaults so the
// out-of-cluster dev CP behaves like a chart-deployed one.
const EGRESS_PROXY_IMAGE =
  process.env.DEVPROOF_EGRESS_PROXY_IMAGE ?? "ghcr.io/devproof/devproofai-squid:6.13";
// Pull secret for the private ghcr.io/devproof images (chart registryAuth →
// DEVPROOF_IMAGE_PULL_SECRET; the chart creates the Secret in the agents
// namespace). Empty = no imagePullSecrets (public images / local dev cache).
const IMAGE_PULL_SECRET = process.env.DEVPROOF_IMAGE_PULL_SECRET ?? "";
const EGRESS_PROXY_POD: {
  resources?: Record<string, Record<string, string>>;
  nodeSelector?: Record<string, string>;
  tolerations?: k8s.V1Toleration[];
} = (() => {
  try { return JSON.parse(process.env.DEVPROOF_EGRESS_PROXY_POD ?? "{}"); } catch { return {}; }
})();
// Gateway's in-cluster hostname — derived once so the URL and noProxy list can't drift.
const GATEWAY_HOST = `gateway.${GATEWAY_NAMESPACE}.svc.cluster.local`;
const GATEWAY_URL =
  process.env.DEVPROOF_GATEWAY_INTERNAL ?? `http://${GATEWAY_HOST}:4000`;
const CALLBACK_URL =
  process.env.DEVPROOF_CALLBACK_URL ?? "http://host.docker.internal:7080";
// The callback host must ride NO_PROXY: runner→CP event posts otherwise go
// through the per-env Squid proxy, which 403s them (live bug sesn_iwjjyat38yk3
// — the in-cluster CP host wasn't listed, only host.docker.internal).
const CALLBACK_HOST = new URL(CALLBACK_URL).hostname;
// In-cluster callback: <svc>.<ns>.svc[.cluster.local] ⇒ the NetworkPolicy needs
// an egress rule to the CP pods too, or enforcing CNIs drop the event posts
// after the proxy bypass (live bug sesn_2i8o557ubzft: runner SYN-blocked on
// :7080, session stuck "generating" forever).
const CALLBACK_SVC_NS = CALLBACK_HOST.match(/^[^.]+\.([^.]+)\.svc(\.cluster\.local)?$/)?.[1];
const CALLBACK_PORT = Number(new URL(CALLBACK_URL).port ||
  (CALLBACK_URL.startsWith("https:") ? 443 : 80));

export function realOrchestrator(): Orchestrator {
  // Fail fast at boot: without the env var the CP silently launches the stale
  // ':dev' runner image, whose pre-multiturn runner posts status 'completed'
  // instead of 'idle' after every turn (live incident 2026-07-16).
  if (!process.env.DEVPROOF_RUNNER_IMAGE) {
    throw new Error(
      "DEVPROOF_RUNNER_IMAGE is not set — refusing to fall back to the stale devproof/session-runner:dev tag");
  }
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const batch = kc.makeApiClient(k8s.BatchV1Api);
  const networking = kc.makeApiClient(k8s.NetworkingV1Api);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  const storage = kc.makeApiClient(k8s.StorageV1Api);

  return {
    async writeVaultSecret(vaultId, secrets) {
      const name = `devproof-vault-${vaultId.replace(/_/g, "-").toLowerCase()}`;
      const body = { metadata: { name }, stringData: secrets };
      try {
        await core.createNamespacedSecret({ namespace: AGENTS_NAMESPACE, body });
      } catch (err: any) {
        if (err?.code !== 409) throw err;
        await core.replaceNamespacedSecret({ name, namespace: AGENTS_NAMESPACE, body });
      }
    },
    // Two-layer egress control per environment:
    // 1. A Squid proxy with a host allowlist (+ PyPI/npm when package managers
    //    are enabled). Session pods get HTTP(S)_PROXY env — effective on all
    //    clusters, including docker-desktop.
    // 2. A NetworkPolicy that (on enforcing CNIs) blocks everything except
    //    DNS, the gateway, the proxy, and the control-plane callback, closing
    //    the "ignore the proxy env" loophole.
    async ensureEnvironmentPolicy(env) {
      const environmentId = env.id;
      const suffix = environmentId.replace(/_/g, "-").toLowerCase();
      const hosts: string[] = [...(env.allowedHosts ?? [])];
      const mcpHosts: string[] = [...(env.mcpHosts ?? [])];
      const conf = squidConf(hosts, env.allowPackageManagers ?? false, mcpHosts);

      const cmName = `egress-${suffix}`;
      const cmBody = { metadata: { name: cmName }, data: { "squid.conf": conf } };
      try {
        await core.createNamespacedConfigMap({ namespace: AGENTS_NAMESPACE, body: cmBody });
      } catch (err: any) {
        if (err?.code !== 409) throw err;
        await core.replaceNamespacedConfigMap({ name: cmName, namespace: AGENTS_NAMESPACE, body: cmBody });
      }
      const labels = { app: cmName };
      const proxyPodSpec = {
        containers: [{
          name: "squid",
          image: EGRESS_PROXY_IMAGE,
          // -N foreground, -d1 log to stderr; without -N the image daemonizes and the pod exits.
          command: ["squid", "-N", "-d1", "-f", "/etc/squid/squid.conf"],
          ports: [{ containerPort: 3128 }],
          volumeMounts: [
            { name: "conf", mountPath: "/etc/squid/squid.conf", subPath: "squid.conf" },
            // Shadow the image's conf.d (debian.conf + rock.conf disk cache
            // that otherwise preallocates and OOM-kills the pod).
            { name: "confd", mountPath: "/etc/squid/conf.d" },
            { name: "spool", mountPath: "/var/spool/squid" },
          ],
          readinessProbe: { tcpSocket: { port: 3128 }, initialDelaySeconds: 3, periodSeconds: 5 },
          resources: EGRESS_PROXY_POD.resources
            ?? { requests: { cpu: "50m", memory: "64Mi" }, limits: { memory: "192Mi" } },
        }],
        ...(IMAGE_PULL_SECRET ? { imagePullSecrets: [{ name: IMAGE_PULL_SECRET }] } : {}),
        ...(EGRESS_PROXY_POD.nodeSelector && Object.keys(EGRESS_PROXY_POD.nodeSelector).length
          ? { nodeSelector: EGRESS_PROXY_POD.nodeSelector } : {}),
        ...(EGRESS_PROXY_POD.tolerations?.length
          ? { tolerations: EGRESS_PROXY_POD.tolerations } : {}),
        volumes: [
          { name: "conf", configMap: { name: cmName } },
          { name: "confd", emptyDir: {} },
          { name: "spool", emptyDir: {} },
        ],
      };
      try {
        await apps.createNamespacedDeployment({
          namespace: AGENTS_NAMESPACE,
          body: {
            metadata: { name: cmName },
            spec: {
              replicas: 1,
              selector: { matchLabels: labels },
              template: { metadata: { labels }, spec: proxyPodSpec },
            },
          },
        });
        await core.createNamespacedService({
          namespace: AGENTS_NAMESPACE,
          body: { metadata: { name: cmName }, spec: { selector: labels, ports: [{ port: 3128 }] } },
        });
      } catch (err: any) {
        if (err?.code !== 409) throw err;
        // config change: restart proxy to reload allowlist. The full pod spec
        // rides along so image/resource/placement changes from the chart reach
        // pre-existing environment proxies too (containers is replaced whole —
        // merge-patch has no per-name array merge).
        await apps.patchNamespacedDeployment(
          { name: cmName, namespace: AGENTS_NAMESPACE,
            body: { spec: { template: {
              metadata: { annotations: { "devproof.ai/conf": String(conf.length) + ":" + hosts.concat(mcpHosts).join(",") } },
              spec: proxyPodSpec,
            } } } },
          k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch),
        );
      }
      const policyBody = buildEnvNetworkPolicy(environmentId, cmName);
      try {
        await networking.createNamespacedNetworkPolicy({ namespace: AGENTS_NAMESPACE, body: policyBody });
      } catch (err: any) {
        if (err?.code !== 409) throw err;
        // Rule changes must reach pre-existing environments (merge-patch
        // replaces the egress array whole, like the proxy Deployment above).
        await networking.patchNamespacedNetworkPolicy(
          { name: policyBody.metadata.name, namespace: AGENTS_NAMESPACE,
            body: { spec: policyBody.spec } },
          k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch),
        );
      }
    },
    // Add/update a single credential key without disturbing the others.
    async putVaultSecretKey(vaultId, key, value) {
      const name = `devproof-vault-${vaultId.replace(/_/g, "-").toLowerCase()}`;
      const body = { metadata: { name }, stringData: { [key]: value } };
      try {
        await core.createNamespacedSecret({ namespace: AGENTS_NAMESPACE, body });
      } catch (err: any) {
        if (err?.code !== 409) throw err;
        const merge = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);
        await core.patchNamespacedSecret({ name, namespace: AGENTS_NAMESPACE, body: { stringData: { [key]: value } } }, merge);
      }
    },
    async removeVaultSecretKey(vaultId, key) {
      const name = `devproof-vault-${vaultId.replace(/_/g, "-").toLowerCase()}`;
      const merge = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);
      try {
        await core.patchNamespacedSecret({ name, namespace: AGENTS_NAMESPACE, body: { data: { [key]: null } } }, merge);
      } catch (err: any) { if (err?.code !== 404) throw err; }
    },
    async deleteVaultSecret(vaultId) {
      const name = `devproof-vault-${vaultId.replace(/_/g, "-").toLowerCase()}`;
      try { await core.deleteNamespacedSecret({ name, namespace: AGENTS_NAMESPACE }); }
      catch (err: any) { if (err?.code !== 404) throw err; }
    },
    // Tear down an environment's egress proxy + policy.
    async deleteEnvironmentResources(environmentId) {
      const suffix = environmentId.replace(/_/g, "-").toLowerCase();
      const names = { cm: `egress-${suffix}`, np: `env-${suffix}` };
      const tries: Promise<unknown>[] = [
        apps.deleteNamespacedDeployment({ name: names.cm, namespace: AGENTS_NAMESPACE }),
        core.deleteNamespacedService({ name: names.cm, namespace: AGENTS_NAMESPACE }),
        core.deleteNamespacedConfigMap({ name: names.cm, namespace: AGENTS_NAMESPACE }),
        networking.deleteNamespacedNetworkPolicy({ name: names.np, namespace: AGENTS_NAMESPACE }),
      ];
      await Promise.allSettled(tries);
    },
    // Interrupt/stop: delete the session's Jobs (and their pods) so it stops
    // consuming resources immediately. Idempotent.
    async stopSession(sessionId) {
      try {
        await batch.deleteCollectionNamespacedJob({
          namespace: AGENTS_NAMESPACE,
          labelSelector: `devproof.ai/session=${sessionId}`,
          propagationPolicy: "Background",
        });
      } catch (err: any) {
        if (err?.code !== 404) throw err;
      }
    },
    // Job state for the reconciler: is the turn's pod still alive?
    async sessionJobState(sessionId, turn) {
      const name = `${sessionId.replace(/_/g, "-").toLowerCase()}-t${turn}`;
      try {
        const job: any = await batch.readNamespacedJob({ name, namespace: AGENTS_NAMESPACE });
        return (job?.status?.active ?? 0) > 0 ? "active" : "finished";
      } catch (err: any) {
        if (err?.code === 404) return "missing"; // never created, or TTL-collected
        throw err;
      }
    },
    // Job state + pod start for the cost sampler: startTime anchors the first
    // accrual of a turn at pod start, not first sampler sighting (spec §4).
    async sessionJobInfo(sessionId, turn) {
      const name = `${sessionId.replace(/_/g, "-").toLowerCase()}-t${turn}`;
      try {
        const job: any = await batch.readNamespacedJob({ name, namespace: AGENTS_NAMESPACE });
        return {
          state: (job?.status?.active ?? 0) > 0 ? ("active" as const) : ("finished" as const),
          startedAt: job?.status?.startTime ? new Date(job.status.startTime) : null,
        };
      } catch (err: any) {
        if (err?.code === 404) return { state: "missing" as const, startedAt: null };
        throw err;
      }
    },
    async startSession(session) {
      // "Persist turns locally": /work rides a durable per-session PVC that
      // every turn pod remounts; created once here, deleted with the session.
      if (session.environment.pod?.disk?.type === "pvc") {
        try {
          await core.createNamespacedPersistentVolumeClaim({ namespace: AGENTS_NAMESPACE, body: buildWorkPvc(session) });
        } catch (err: any) {
          if (err?.code !== 409) throw err; // exists from an earlier turn
        }
      }
      await batch.createNamespacedJob({ namespace: AGENTS_NAMESPACE, body: buildTurnJob(session) });
    },
    // Session-scoped k8s resources beyond Jobs — today just the /work PVC.
    // Deleted by label so an env flipped back to emptyDir mid-session can't orphan it.
    async deleteSessionResources(sessionId) {
      try {
        await core.deleteCollectionNamespacedPersistentVolumeClaim({
          namespace: AGENTS_NAMESPACE,
          labelSelector: `devproof.ai/session=${sessionId}`,
        });
      } catch (err: any) {
        if (err?.code !== 404) throw err;
      }
    },
    async listStorageClasses() {
      const res: any = await storage.listStorageClass();
      return (res.items ?? []).map((sc: any) => ({
        name: sc.metadata?.name ?? "",
        provisioner: sc.provisioner ?? "",
        isDefault: sc.metadata?.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true",
      }));
    },
    async listNodeScheduling() {
      const res: any = await core.listNode();
      return aggregateNodeScheduling(res.items ?? []);
    },
  };
}

/** The durable per-session /work claim's name (one PVC per session). */
export function workPvcName(sessionId: string) {
  return `${sessionId.replace(/_/g, "-").toLowerCase()}-work`;
}

/** Pure PVC body for a session's durable /work volume — exported for tests. */
export function buildWorkPvc(session: Parameters<Orchestrator["startSession"]>[0]) {
  const disk = session.environment.pod?.disk;
  return {
    metadata: {
      name: workPvcName(session.id),
      labels: { "devproof.ai/session": session.id, app: "devproof-session" },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: disk?.storageClass,
      resources: { requests: { storage: `${disk?.sizeGb}Gi` } },
    },
  };
}

/** Pure NetworkPolicy body for one environment — exported for tests. */
export function buildEnvNetworkPolicy(environmentId: string, proxyApp: string) {
  return {
    metadata: { name: `env-${environmentId.replace(/_/g, "-").toLowerCase()}` },
    spec: {
      podSelector: { matchLabels: { "devproof.ai/environment": environmentId } },
      policyTypes: ["Egress"],
      egress: [
        { to: [{ namespaceSelector: {}, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
          ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
        // The egress proxy (only sanctioned path to the internet).
        { to: [{ podSelector: { matchLabels: { app: proxyApp } } }], ports: [{ protocol: "TCP", port: 3128 }] },
        // The model gateway only (agents call /v1/messages) — A2: restrict to
        // the gateway pods on :4000 rather than the whole namespace, which also
        // hosts Postgres/MinIO. (Enforced only on a NetworkPolicy-capable CNI.)
        { to: [{
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": GATEWAY_NAMESPACE } },
            podSelector: { matchLabels: { app: "devproof-gateway" } },
          }],
          ports: [{ protocol: "TCP", port: 4000 }] },
        // Control-plane callback: the in-cluster CP pods when CALLBACK_URL is a
        // cluster service (label matches the chart, like devproof-gateway above)…
        ...(CALLBACK_SVC_NS ? [{
          to: [{
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": CALLBACK_SVC_NS } },
            podSelector: { matchLabels: { app: "devproof-controlplane" } },
          }],
          ports: [{ protocol: "TCP", port: CALLBACK_PORT }],
        }] : []),
        // …and the docker-desktop host for the out-of-cluster dev CP.
        { to: [{ ipBlock: { cidr: "192.168.65.0/24" } }] },
      ],
    },
  };
}

/** Pure Job body for one session turn — exported for tests (spec 2026-07-12). */
export function buildTurnJob(session: Parameters<Orchestrator["startSession"]>[0]) {
  const turn = session.resume?.turn ?? 0;
  const envId = session.environment.id;
  const pod: PodConfig = session.environment?.pod ?? {};
  const disk = pod.disk?.type === "pvc" ? pod.disk : { type: "emptyDir" as const };
  const labels = {
    "devproof.ai/session": session.id,
    app: "devproof-session",
    "devproof.ai/environment": envId,
  };
  const proxy = `http://egress-${envId.replace(/_/g, "-").toLowerCase()}.${AGENTS_NAMESPACE}.svc.cluster.local:3128`;
  const noProxy = [...new Set([
    GATEWAY_HOST, CALLBACK_HOST, "host.docker.internal", "localhost", "127.0.0.1", "10.0.0.0/8",
  ])].join(",");
  const nodeSelector = pod.nodeSelector && Object.keys(pod.nodeSelector).length ? { ...pod.nodeSelector } : undefined;
  const tolerations = (pod.tolerations ?? []).map((t) => ({
    ...(t.key != null ? { key: t.key } : {}),
    ...(t.operator != null ? { operator: t.operator } : {}),
    ...(t.value != null ? { value: t.value } : {}),
    ...(t.effect ? { effect: t.effect } : {}),
  }));
  return {
    metadata: { name: `${session.id.replace(/_/g, "-").toLowerCase()}-t${turn}`, labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      // Per-agent turn deadline; the reconciler marks the session failed
      // (resumable) when the pod is killed by it.
      activeDeadlineSeconds: (session.config as any).turn_deadline_sec ?? 7200,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          // Non-root runner (uid/gid 1000): group-own mounted volumes so /work
          // stays writable on PVCs whose filesystem is root-owned.
          securityContext: { fsGroup: 1000 },
          ...(IMAGE_PULL_SECRET ? { imagePullSecrets: [{ name: IMAGE_PULL_SECRET }] } : {}),
          ...(nodeSelector ? { nodeSelector } : {}),
          ...(tolerations.length ? { tolerations } : {}),
          volumes: [
            disk.type === "pvc"
              ? { name: "work", persistentVolumeClaim: { claimName: workPvcName(session.id) } }
              : { name: "work", emptyDir: {} },
          ],
          containers: [
            {
              name: "runner",
              image: RUNNER_IMAGE,
              imagePullPolicy: "IfNotPresent",
              volumeMounts: [{ name: "work", mountPath: "/work" }],
              env: [
                { name: "DEVPROOF_SESSION_ID", value: session.id },
                { name: "DEVPROOF_PROMPT", value: session.prompt },
                {
                  name: "DEVPROOF_AGENT_CONFIG",
                  value: JSON.stringify({
                    // Runner boundary (dev27, frozen): the env key stays `model`
                    // and carries the routing name — the routing IS the model
                    // name on the wire. Only the TS source key renamed.
                    model: session.config.routing,
                    system_prompt: session.config.system_prompt,
                    tools: session.config.tools,
                    max_turns: session.config.max_turns,
                    mcp_servers: (session as any).mcpServers ?? (session.config as any).mcp_servers ?? {},
                    subagents: (session as any).subagents ?? [],
                    // The runner's platform prompt only claims pip install is
                    // disabled when the environment really blocks PyPI egress.
                    allow_package_managers: session.environment.allowPackageManagers ?? false,
                  }),
                },
                { name: "DEVPROOF_BASE_URL", value: GATEWAY_URL },
                // Internal key: passes gateway auth; metered as source='session' with the attribution headers below.
                // A1: sourced from a Secret (never a plaintext value in the Job spec). optional ⇒ the pod still
                // starts if the secret is missing (auth then fails, mirroring the old "none" fallback).
                { name: "DEVPROOF_AUTH_TOKEN", valueFrom: { secretKeyRef: { name: INTERNAL_KEY_SECRET, key: INTERNAL_KEY_ENTRY, optional: true } } },
                {
                  // Attribution for gateway metering/trace (spec 2026-07-10):
                  // the agent client sends these on every request to the gateway.
                  name: "DEVPROOF_CUSTOM_HEADERS",
                  value: [
                    `X-Devproof-Agent: ${(session.config as any).agent_id ?? ""}`,
                    `X-Devproof-Session: ${session.id}`,
                    `X-Devproof-Workspace: ${session.workspace ?? "wrkspc_default"}`,
                    // Per-turn attribution (fix wave H): stamps gateway_usage.turn
                    // so the session step panel can scope deployments to a turn.
                    `X-Devproof-Turn: ${turn}`,
                  ].join("\n"),
                },
                // Served context window: the SDK auto-compacts against this
                // instead of overflowing into a gateway ContextWindowExceededError.
                ...(session.contextWindow
                  ? [{ name: "DEVPROOF_CONTEXT_WINDOW", value: String(session.contextWindow) }]
                  : []),
                { name: "DEVPROOF_EVENTS_URL", value: `${CALLBACK_URL}/v1/sessions/${session.id}` },
                { name: "DEVPROOF_FILES_URL", value: `${CALLBACK_URL}/v1/files` },
                { name: "DEVPROOF_ATTACHMENTS", value: JSON.stringify(session.attachments ?? []) },
                { name: "DEVPROOF_PRIOR_OUTPUTS", value: JSON.stringify(session.priorOutputs ?? []) },
                { name: "DEVPROOF_RESUME", value: session.resume?.sdkSessionId ?? "" },
                { name: "DEVPROOF_CHECKPOINT", value: session.resume?.checkpointFileId ?? "" },
                { name: "DEVPROOF_TURN", value: String(turn) },
                // pvc ⇒ /work persists on the session PVC; keep it out of the checkpoint tarball.
                { name: "DEVPROOF_CHECKPOINT_WORK", value: disk.type === "pvc" ? "0" : "1" },
                { name: "DEVPROOF_SKILLS", value: JSON.stringify(session.skills ?? []) },
                { name: "DEVPROOF_MEMORY", value: JSON.stringify(session.memory ?? []) },
                // Store-presence gate: absent ⇒ the runner skips memory
                // write-back entirely (a model note in the always-writable
                // /mnt/memory otherwise 400s the salvage; sesn_2i8o557ubzft).
                ...(session.memoryStore
                  ? [{ name: "DEVPROOF_MEMORY_STORE", value: session.memoryStore }]
                  : []),
                { name: "DEVPROOF_WIKIS", value: JSON.stringify(session.wikis ?? []) },
                { name: "HTTP_PROXY", value: proxy }, { name: "http_proxy", value: proxy },
                { name: "HTTPS_PROXY", value: proxy }, { name: "https_proxy", value: proxy },
                { name: "NO_PROXY", value: noProxy }, { name: "no_proxy", value: noProxy },
              ],
              // Vault secrets arrive as env vars; never logged in transcripts.
              envFrom: (session.config as any).vault_id
                ? [{ secretRef: { name: `devproof-vault-${String((session.config as any).vault_id).replace(/_/g, "-").toLowerCase()}` } }]
                : [],
              resources: {
                requests: { cpu: pod.requests?.cpu ?? "250m", memory: pod.requests?.memory ?? "512Mi" },
                limits: { ...(pod.limits?.cpu ? { cpu: pod.limits.cpu } : {}), memory: pod.limits?.memory ?? "1Gi" },
              },
            },
          ],
        },
      },
    },
  };
}
