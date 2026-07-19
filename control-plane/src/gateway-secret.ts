// Internal API key for platform-owned gateway traffic (agent session pods).
// Never shown in the UI, never metered. Lives in a K8s Secret consumed by
// both the gateway Deployment (env DEVPROOF_INTERNAL_KEY) and session Jobs.
import { randomBytes } from "node:crypto";
import * as k8s from "@kubernetes/client-node";
import { GATEWAY_NAMESPACE } from "./kubestore.ts";
import { AGENTS_NAMESPACE } from "./namespaces.ts";

const SECRET_NAME = "gateway-auth";

// A1: session Job pods reference the internal key via secretKeyRef instead of a
// plaintext env VALUE in the Job spec. The key lives in the gateway namespace;
// pods run in the agents namespace, so mirror it into a Secret there.
export const INTERNAL_KEY_SECRET = "internal-auth";
export const INTERNAL_KEY_ENTRY = "internal-key";

/** Upsert the internal key into a Secret in the AGENTS namespace (idempotent). */
export async function ensureInternalKeyInAgentsNs(key: string): Promise<void> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const body = { metadata: { name: INTERNAL_KEY_SECRET }, stringData: { [INTERNAL_KEY_ENTRY]: key } };
  try {
    await core.createNamespacedSecret({ namespace: AGENTS_NAMESPACE, body });
  } catch (err: any) {
    if (err?.code !== 409) throw err; // already exists → patch the value
    const merge = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);
    await core.patchNamespacedSecret(
      { name: INTERNAL_KEY_SECRET, namespace: AGENTS_NAMESPACE, body: { stringData: { [INTERNAL_KEY_ENTRY]: key } } }, merge);
  }
}

export async function ensureGatewayAuthSecret(attempt = 0): Promise<string> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(k8s.CoreV1Api);
  let exists = false;
  try {
    const s: any = await core.readNamespacedSecret({ name: SECRET_NAME, namespace: GATEWAY_NAMESPACE });
    exists = true;
    const b64 = s.data?.["internal-key"];
    if (b64) return Buffer.from(b64, "base64").toString("utf8");
  } catch (err: any) {
    if (err?.code !== 404) throw err;
  }
  if (exists) throw new Error(`Secret ${SECRET_NAME} exists but has no internal-key entry — delete it to re-provision`);
  const key = `dpk_internal_${randomBytes(24).toString("hex")}`;
  const body = { metadata: { name: SECRET_NAME }, stringData: { "internal-key": key } };
  try {
    await core.createNamespacedSecret({ namespace: GATEWAY_NAMESPACE, body });
  } catch (err: any) {
    if (err?.code !== 409) throw err; // lost a create race: another replica made it
    if (attempt >= 2) throw new Error(`Secret ${SECRET_NAME} create race did not settle`);
    return ensureGatewayAuthSecret(attempt + 1);
  }
  return key;
}
