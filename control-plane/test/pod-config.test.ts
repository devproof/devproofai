import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePodConfig } from "../src/pod-config.ts";

test("null/undefined/empty pod configs are valid", () => {
  assert.equal(validatePodConfig(undefined), null);
  assert.equal(validatePodConfig(null), null);
  assert.equal(validatePodConfig({}), null);
});

test("accepts a full valid config", () => {
  assert.equal(validatePodConfig({
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "1.5", memory: "2Gi" },
    nodeSelector: { "kubernetes.io/arch": "amd64" },
    tolerations: [{ key: "gpu", operator: "Equal", value: "true", effect: "NoSchedule" }, { key: "gpu", operator: "Exists" }],
    disk: { type: "pvc", storageClass: "standard", sizeGb: 64 },
  }), null);
  assert.equal(validatePodConfig({ disk: { type: "emptyDir" } }), null);
});

test("rejects targeting control-plane/system nodes (A5)", () => {
  assert.match(validatePodConfig({ nodeSelector: { "node-role.kubernetes.io/control-plane": "" } })!,
               /nodeSelector key .* is reserved/);
  assert.match(validatePodConfig({ tolerations: [{ operator: "Exists" }] })!,
               /key-less Exists toleration/);
  assert.match(validatePodConfig({ tolerations: [{ key: "node-role.kubernetes.io/control-plane", operator: "Exists" }] })!,
               /tolerations key .* is reserved/);
});

test("rejects oversized cpu/memory requests (A6)", () => {
  assert.match(validatePodConfig({ requests: { cpu: "64" } })!, /pod\.requests\.cpu exceeds/);
  assert.match(validatePodConfig({ limits: { memory: "100000Gi" } })!, /pod\.limits\.memory exceeds/);
  // at/under the ceiling is fine
  assert.equal(validatePodConfig({ requests: { cpu: "16", memory: "64Gi" } }), null);
});

test("rejects non-quantity cpu/memory", () => {
  assert.match(validatePodConfig({ requests: { cpu: "lots" } })!, /pod\.requests\.cpu/);
  assert.match(validatePodConfig({ limits: { memory: "1 GB" } })!, /pod\.limits\.memory/);
  assert.match(validatePodConfig({ requests: { memory: 512 } })!, /pod\.requests\.memory/);
});

test("rejects malformed nodeSelector and tolerations", () => {
  assert.match(validatePodConfig({ nodeSelector: ["a"] })!, /nodeSelector/);
  assert.match(validatePodConfig({ nodeSelector: { "": "x" } })!, /nodeSelector/);
  assert.match(validatePodConfig({ tolerations: {} })!, /tolerations/);
  assert.match(validatePodConfig({ tolerations: [{ operator: "Sometimes" }] })!, /operator/);
  assert.match(validatePodConfig({ tolerations: [{ effect: "Never" }] })!, /effect/);
  assert.match(validatePodConfig({ tolerations: [null] })!, /tolerations/);
  assert.match(validatePodConfig({ tolerations: [42] })!, /tolerations/);
  assert.match(validatePodConfig({ tolerations: ["x"] })!, /tolerations/);
  assert.match(validatePodConfig({ tolerations: [{ key: 123 }] })!, /key/);
  assert.match(validatePodConfig({ tolerations: [{ key: "k", value: 5 }] })!, /value/);
});

test("rejects bad disk configs", () => {
  assert.match(validatePodConfig({ disk: { type: "hostPath" } })!, /disk\.type/);
  assert.match(validatePodConfig({ disk: { type: "pvc", sizeGb: 64 } })!, /storageClass/);
  assert.match(validatePodConfig({ disk: { type: "pvc", storageClass: "standard" } })!, /sizeGb/);
  assert.match(validatePodConfig({ disk: { type: "pvc", storageClass: "standard", sizeGb: 0 } })!, /sizeGb/);
  assert.match(validatePodConfig({ disk: { type: "pvc", storageClass: "standard", sizeGb: 1.5 } })!, /sizeGb/);
});

test("sizeGb is capped at maxWorkGb (default 2048)", () => {
  const okDisk = { type: "pvc", storageClass: "standard" };
  assert.equal(validatePodConfig({ disk: { ...okDisk, sizeGb: 2048 } }), null);
  assert.match(validatePodConfig({ disk: { ...okDisk, sizeGb: 2049 } })!, /sizeGb/);
  // explicit lower cap
  assert.equal(validatePodConfig({ disk: { ...okDisk, sizeGb: 100 } }, { maxWorkGb: 100 }), null);
  assert.match(validatePodConfig({ disk: { ...okDisk, sizeGb: 101 } }, { maxWorkGb: 100 })!, /sizeGb/);
});

test("nodeSelector keys/values must be valid k8s labels", () => {
  assert.equal(validatePodConfig({ nodeSelector: { "topology.kubernetes.io/zone": "eu-a" } }), null);
  assert.equal(validatePodConfig({ nodeSelector: { "kubernetes.io/arch": "amd64" } }), null);
  assert.equal(validatePodConfig({ nodeSelector: { role: "" } }), null); // empty value allowed
  assert.match(validatePodConfig({ nodeSelector: { "bad key": "x" } })!, /nodeSelector/);
  assert.match(validatePodConfig({ nodeSelector: { role: "has space" } })!, /nodeSelector/);
  assert.match(validatePodConfig({ nodeSelector: { role: "a".repeat(64) } })!, /nodeSelector/);
});

test("toleration keys must be valid label keys", () => {
  assert.equal(validatePodConfig({ tolerations: [{ key: "nvidia.com/gpu", operator: "Exists" }] }), null);
  assert.match(validatePodConfig({ tolerations: [{ key: "bad key", operator: "Exists" }] })!, /key/);
});

test("nodeSelector key prefix must be a valid DNS subdomain", () => {
  assert.equal(validatePodConfig({ nodeSelector: { "example.com/team": "a" } }), null);
  assert.match(validatePodConfig({ nodeSelector: { "bad prefix!/name": "a" } })!, /nodeSelector/);
});

test("rejects unknown top-level pod fields and unknown toleration fields", () => {
  assert.match(validatePodConfig({ bogus: 1 } as any)!, /unknown/);
  assert.match(validatePodConfig({ tolerations: [{ key: "k", operator: "Exists", bogus: 1 }] } as any)!, /unknown/);
});
