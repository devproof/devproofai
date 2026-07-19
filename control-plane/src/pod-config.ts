// Pod-level configuration an environment applies to its session (turn) pods
// (spec 2026-07-12). Validated at the API edge; consumed by buildTurnJob.

export interface PodDisk {
  /** pvc = "Persist turns locally": a durable per-session PVC backs /work
   *  across turns (and /work is excluded from checkpoint tarballs). */
  type: "emptyDir" | "pvc";
  storageClass?: string;
  sizeGb?: number;
}

export interface PodConfig {
  requests?: { cpu?: string; memory?: string };
  limits?: { cpu?: string; memory?: string };
  nodeSelector?: Record<string, string>;
  tolerations?: { key?: string; operator?: string; value?: string; effect?: string }[];
  disk?: PodDisk;
}

// k8s resource quantity: number with optional decimal + optional SI/binary suffix.
const QUANTITY = /^[0-9]+(\.[0-9]+)?(m|k|M|G|T|P|Ki|Mi|Gi|Ti|Pi)?$/;
const TOL_OPERATORS = ["Equal", "Exists"];
const TOL_EFFECTS = ["", "NoSchedule", "PreferNoSchedule", "NoExecute"];

// k8s label key: optional DNS-subdomain prefix ("prefix/") + a name segment.
// Each of prefix and name is ≤63 chars, alnum-bounded, [A-Za-z0-9._-] inside.
const LABEL_SEG = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
// k8s label value: empty, or the same alnum-bounded ≤63 form.
const LABEL_VAL = /^([A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)?$/;
// k8s label-key prefix is a DNS subdomain: lowercase alnum labels joined by dots.
const LABEL_PREFIX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const POD_KEYS = ["requests", "limits", "nodeSelector", "tolerations", "disk"];
const TOL_KEYS = ["key", "operator", "value", "effect"];

// A5: keep untrusted session pods off control-plane / system nodes.
const RESERVED_NODE_PREFIX = "node-role.kubernetes.io/";
// A6: per-pod resource ceiling (a tenant can otherwise request 100000Gi and
// either wedge its own pods or starve the cluster at scale).
const MAX_CPU_MILLI = 16_000;             // 16 cores
const MAX_MEMORY_BYTES = 64 * 1024 ** 3;  // 64Gi
const MEM_MULT: Record<string, number> = {
  "": 1, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5,
};

/** cpu quantity → millicores ("500m"→500, "2"→2000). Assumes QUANTITY-valid. */
function cpuMilli(v: string): number {
  return v.endsWith("m") ? parseFloat(v) : parseFloat(v) * 1000;
}
/** memory quantity → bytes. Assumes QUANTITY-valid. */
function memBytes(v: string): number {
  const m = v.match(/^([0-9]+(?:\.[0-9]+)?)(m|k|M|G|T|P|Ki|Mi|Gi|Ti|Pi)?$/);
  return m ? parseFloat(m[1]) * (MEM_MULT[m[2] ?? ""] ?? 1) : NaN;
}

function isLabelKey(k: string): boolean {
  const slash = k.indexOf("/");
  if (slash === -1) return LABEL_SEG.test(k);
  const prefix = k.slice(0, slash), name = k.slice(slash + 1);
  return prefix.length > 0 && prefix.length <= 253 && LABEL_PREFIX.test(prefix)
      && name.length > 0 && LABEL_SEG.test(name);
}

/** Returns an error message, or null when the config is valid. */
export function validatePodConfig(pod: unknown, opts?: { maxWorkGb?: number }): string | null {
  const maxWorkGb = opts?.maxWorkGb ?? 2048;
  if (pod == null) return null;
  if (typeof pod !== "object" || Array.isArray(pod)) return "pod must be an object";
  const p = pod as PodConfig;
  for (const k of Object.keys(p)) {
    if (!POD_KEYS.includes(k)) return `pod has unknown field ${k}`;
  }
  for (const [group, vals] of [["requests", p.requests], ["limits", p.limits]] as const) {
    for (const key of ["cpu", "memory"] as const) {
      const v = vals?.[key];
      if (v != null && (typeof v !== "string" || !QUANTITY.test(v)))
        return `pod.${group}.${key} must be a Kubernetes quantity (e.g. 250m, 512Mi)`;
      if (v != null && key === "cpu" && cpuMilli(v) > MAX_CPU_MILLI)
        return `pod.${group}.cpu exceeds the ${MAX_CPU_MILLI / 1000}-core per-pod limit`;
      if (v != null && key === "memory" && memBytes(v) > MAX_MEMORY_BYTES)
        return `pod.${group}.memory exceeds the ${MAX_MEMORY_BYTES / 1024 ** 3}Gi per-pod limit`;
    }
  }
  if (p.nodeSelector != null) {
    if (typeof p.nodeSelector !== "object" || Array.isArray(p.nodeSelector))
      return "pod.nodeSelector must be an object mapping label keys to string values";
    for (const [k, v] of Object.entries(p.nodeSelector)) {
      if (!k || typeof v !== "string") return "pod.nodeSelector must map non-empty label keys to string values";
      if (!isLabelKey(k)) return `pod.nodeSelector key ${k} is not a valid Kubernetes label key`;
      if (k.startsWith(RESERVED_NODE_PREFIX)) return `pod.nodeSelector key ${k} is reserved (session pods may not target control-plane/system nodes)`;
      if (!LABEL_VAL.test(v)) return `pod.nodeSelector value for ${k} is not a valid Kubernetes label value`;
    }
  }
  if (p.tolerations != null) {
    if (!Array.isArray(p.tolerations)) return "pod.tolerations must be an array";
    for (const t of p.tolerations) {
      if (typeof t !== "object" || t === null || Array.isArray(t)) return "pod.tolerations entries must be objects";
      for (const k of Object.keys(t)) {
        if (!TOL_KEYS.includes(k)) return `pod.tolerations has unknown field ${k}`;
      }
      if (t.key != null && typeof t.key !== "string") return "pod.tolerations key must be a string";
      if (t.key != null && !isLabelKey(t.key)) return `pod.tolerations key ${t.key} is not a valid Kubernetes label key`;
      if (t.value != null && typeof t.value !== "string") return "pod.tolerations value must be a string";
      if (!TOL_OPERATORS.includes(t?.operator ?? "Equal")) return "pod.tolerations operator must be Equal or Exists";
      if (!TOL_EFFECTS.includes(t?.effect ?? "")) return "pod.tolerations effect must be NoSchedule, PreferNoSchedule or NoExecute";
      if ((t?.operator ?? "Equal") === "Exists" && t.key == null)
        return "pod.tolerations: a key-less Exists toleration (tolerates every taint) is not allowed";
      if (t.key != null && t.key.startsWith(RESERVED_NODE_PREFIX))
        return `pod.tolerations key ${t.key} is reserved (session pods may not tolerate control-plane/system node taints)`;
    }
  }
  if (p.disk != null && p.disk.type !== "emptyDir") {
    if (p.disk.type !== "pvc") return "pod.disk.type must be emptyDir or pvc";
    if (!p.disk.storageClass?.trim()) return "pod.disk.storageClass is required for a pvc disk";
    if (!Number.isInteger(p.disk.sizeGb) || (p.disk.sizeGb as number) < 1 || (p.disk.sizeGb as number) > maxWorkGb)
      return `pod.disk.sizeGb must be an integer between 1 and ${maxWorkGb}`;
  }
  return null;
}
