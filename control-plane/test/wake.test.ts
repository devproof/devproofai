import { test } from "node:test";
import assert from "node:assert/strict";
import { wakeIfIdle, wakeModel } from "../src/wake.ts";

test("wakeModel patches the deployment awake, marks waking, clears the request", async () => {
  const calls: any[] = [];
  const deps = {
    kube: { patch: async (plural: string, name: string, body: any) => { calls.push(["patch", plural, name, body]); } },
    repo: {
      setModelRouting: async (m: string, s: string) => { calls.push(["state", m, s]); },
      clearWakeRequest: async (m: string) => { calls.push(["clear", m]); },
    },
  };
  await wakeModel(deps as any, "qwen-medium");
  assert.deepEqual(calls[0], ["patch", "modeldeployments", "qwen-medium",
    { metadata: { annotations: { "serving.devproof.ai/target-replicas": "1" } } }]);
  assert.deepEqual(calls[1], ["state", "qwen-medium", "waking"]);
  assert.deepEqual(calls[2], ["clear", "qwen-medium"]);
});

test("wakeModel does not mark waking when the patch fails", async () => {
  const calls: any[] = [];
  const deps = {
    kube: { patch: async () => { throw new Error("apiserver down"); } },
    repo: {
      setModelRouting: async (m: string, s: string) => { calls.push(["state", m, s]); },
      clearWakeRequest: async (m: string) => { calls.push(["clear", m]); },
    },
  };
  await assert.rejects(() => wakeModel(deps as any, "qwen-medium"));
  assert.equal(calls.length, 0); // sweep retries the whole wake
});

// CP-restart stomp guard (I1, final review): NOTIFY-wake path must only act
// on deployments the CRD itself reports Idle — never on 'waking' (post-
// restart warmedModels gap) or Ready, or it would stomp the scaler's higher
// target-replicas annotation on a busy min>0 deployment.
test("wakeIfIdle: phase Idle -> patch+state+clear happen", async () => {
  const calls: any[] = [];
  const deps = {
    kube: {
      get: async (plural: string, name: string) => { calls.push(["get", plural, name]); return { status: { phase: "Idle" } }; },
      patch: async (plural: string, name: string, body: any) => { calls.push(["patch", plural, name, body]); },
    },
    repo: {
      setModelRouting: async (m: string, s: string) => { calls.push(["state", m, s]); },
      clearWakeRequest: async (m: string) => { calls.push(["clear", m]); },
    },
  };
  await wakeIfIdle(deps as any, "qwen-medium");
  assert.deepEqual(calls[0], ["get", "modeldeployments", "qwen-medium"]);
  assert.deepEqual(calls[1], ["patch", "modeldeployments", "qwen-medium",
    { metadata: { annotations: { "serving.devproof.ai/target-replicas": "1" } } }]);
  assert.deepEqual(calls[2], ["state", "qwen-medium", "waking"]);
  assert.deepEqual(calls[3], ["clear", "qwen-medium"]);
});

test("wakeIfIdle: phase Ready -> NO patch, NO state write, NO clear", async () => {
  const calls: any[] = [];
  const deps = {
    kube: {
      get: async () => ({ status: { phase: "Ready" } }),
      patch: async (plural: string, name: string, body: any) => { calls.push(["patch", plural, name, body]); },
    },
    repo: {
      setModelRouting: async (m: string, s: string) => { calls.push(["state", m, s]); },
      clearWakeRequest: async (m: string) => { calls.push(["clear", m]); },
    },
  };
  await wakeIfIdle(deps as any, "qwen-medium");
  assert.equal(calls.length, 0);
});

test("wakeIfIdle: deployment missing (get throws) -> no writes, resolves", async () => {
  const calls: any[] = [];
  const deps = {
    kube: {
      get: async () => { throw new Error("not found"); },
      patch: async (plural: string, name: string, body: any) => { calls.push(["patch", plural, name, body]); },
    },
    repo: {
      setModelRouting: async (m: string, s: string) => { calls.push(["state", m, s]); },
      clearWakeRequest: async (m: string) => { calls.push(["clear", m]); },
    },
  };
  await wakeIfIdle(deps as any, "qwen-medium");
  assert.equal(calls.length, 0);
});
