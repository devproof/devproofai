import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTurnJob, buildWorkPvc, workPvcName, realOrchestrator } from "../src/orchestrator.ts";

const base = () => ({
  id: "sesn_x1", prompt: "hi", workspace: "wrkspc_default",
  config: { routing: "m", system_prompt: "", tools: [], max_turns: 10 },
  environment: { id: "env_a", pod: {} },
});

test("defaults: emptyDir /work, stock resources, checkpoint-work on, fsGroup", () => {
  const job: any = buildTurnJob(base() as any);
  const podSpec = job.spec.template.spec;
  const c = podSpec.containers[0];
  assert.equal(job.metadata.name, "sesn-x1-t0");
  assert.equal(job.metadata.labels["devproof.ai/environment"], "env_a");
  assert.deepEqual(podSpec.volumes, [{ name: "work", emptyDir: {} }]);
  assert.deepEqual(c.volumeMounts, [{ name: "work", mountPath: "/work" }]);
  assert.deepEqual(c.resources, { requests: { cpu: "250m", memory: "512Mi" }, limits: { memory: "1Gi" } });
  assert.deepEqual(podSpec.securityContext, { fsGroup: 1000 });
  assert.equal(podSpec.nodeSelector, undefined);
  assert.equal(podSpec.tolerations, undefined);
  assert.equal(c.env.find((e: any) => e.name === "DEVPROOF_CHECKPOINT_WORK").value, "1");
});

test("pvc disk mounts the durable session claim and turns checkpoint-work off", () => {
  const s: any = base();
  s.environment.pod = { disk: { type: "pvc", storageClass: "standard", sizeGb: 128 } };
  const job: any = buildTurnJob(s);
  const podSpec = job.spec.template.spec;
  assert.deepEqual(podSpec.volumes, [{ name: "work", persistentVolumeClaim: { claimName: "sesn-x1-work" } }]);
  assert.equal(podSpec.containers[0].env.find((e: any) => e.name === "DEVPROOF_CHECKPOINT_WORK").value, "0");
});

test("buildWorkPvc: session-labeled durable claim from the env disk config", () => {
  const s: any = base();
  s.environment.pod = { disk: { type: "pvc", storageClass: "standard", sizeGb: 128 } };
  assert.equal(workPvcName(s.id), "sesn-x1-work");
  assert.deepEqual(buildWorkPvc(s), {
    metadata: {
      name: "sesn-x1-work",
      labels: { "devproof.ai/session": "sesn_x1", app: "devproof-session" },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "standard",
      resources: { requests: { storage: "128Gi" } },
    },
  });
});

test("resources and placement come from the pod config", () => {
  const s: any = base();
  s.environment.pod = {
    requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "2", memory: "4Gi" },
    nodeSelector: { zone: "a" }, tolerations: [{ key: "gpu", operator: "Exists" }],
  };
  const job: any = buildTurnJob(s);
  const podSpec = job.spec.template.spec;
  assert.deepEqual(podSpec.containers[0].resources, {
    requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "2", memory: "4Gi" },
  });
  assert.deepEqual(podSpec.nodeSelector, { zone: "a" });
  assert.deepEqual(podSpec.tolerations, [{ key: "gpu", operator: "Exists" }]);
});

test("turn deadline defaults to 7200s and honors the agent's turn_deadline_sec", () => {
  assert.equal(buildTurnJob(base() as any).spec.activeDeadlineSeconds, 7200);
  const s: any = base();
  s.config.turn_deadline_sec = 900;
  assert.equal(buildTurnJob(s).spec.activeDeadlineSeconds, 900);
});

test("contextWindow renders the SDK auto-compact env; absent when unknown", () => {
  const s: any = { ...base(), contextWindow: 32768 };
  const env = buildTurnJob(s).spec.template.spec.containers[0].env as any[];
  assert.equal(env.find((e) => e.name === "DEVPROOF_CONTEXT_WINDOW").value, "32768");
  const bare = buildTurnJob(base() as any).spec.template.spec.containers[0].env as any[];
  assert.equal(bare.find((e) => e.name === "DEVPROOF_CONTEXT_WINDOW"), undefined);
});

test("resume turn is reflected in the job name and DEVPROOF_TURN", () => {
  const s: any = { ...base(), resume: { turn: 3, sdkSessionId: "sdk1", checkpointFileId: "file_1" } };
  const job: any = buildTurnJob(s);
  assert.equal(job.metadata.name, "sesn-x1-t3");
  assert.equal(job.spec.template.spec.containers[0].env.find((e: any) => e.name === "DEVPROOF_TURN").value, "3");
});

test("buildTurnJob renders the injected mcpServers map into DEVPROOF_AGENT_CONFIG", () => {
  const job: any = buildTurnJob({
    id: "sesn_mcp1", prompt: "p", workspace: "wrkspc_default",
    environment: { id: "env_1", pod: {} },
    config: { routing: "m", system_prompt: "", tools: [], max_turns: 5,
              mcp_servers: { c7: { type: "http", url: "https://mcp.context7.com/mcp" } } } as any,
    mcpServers: { c7: { type: "http", url: "https://mcp.context7.com/mcp",
                        headers: { Authorization: "Bearer ${DEVPROOF_CRED_CONTEXT7_TOKEN}" } } },
  } as any);
  const env = job.spec.template.spec.containers[0].env
    .find((e: any) => e.name === "DEVPROOF_AGENT_CONFIG");
  const cfg = JSON.parse(env.value);
  assert.equal(cfg.mcp_servers.c7.headers.Authorization, "Bearer ${DEVPROOF_CRED_CONTEXT7_TOKEN}");
});

test("buildTurnJob renders DEVPROOF_PRIOR_OUTPUTS from session.priorOutputs; empty array default", () => {
  const s: any = { ...base(), priorOutputs: [{ id: "file_a", name: "a.png" }] };
  const env = buildTurnJob(s).spec.template.spec.containers[0].env as any[];
  assert.deepEqual(JSON.parse(env.find((e) => e.name === "DEVPROOF_PRIOR_OUTPUTS").value),
    [{ id: "file_a", name: "a.png" }]);
  const bare = buildTurnJob(base() as any).spec.template.spec.containers[0].env as any[];
  assert.deepEqual(JSON.parse(bare.find((e: any) => e.name === "DEVPROOF_PRIOR_OUTPUTS").value), []);
});

test("buildTurnJob renders subagents into DEVPROOF_AGENT_CONFIG", () => {
  const job: any = buildTurnJob({
    id: "sesn_sub", prompt: "p",
    config: { routing: "m", system_prompt: "", tools: [], max_turns: 5 },
    environment: { id: "env_1", pod: {} },
    subagents: [{ name: "reviewer", agentId: "agent_t", instructions: "reviews code" }],
  } as any);
  const env = job.spec.template.spec.containers[0].env;
  const cfg = JSON.parse(env.find((e: any) => e.name === "DEVPROOF_AGENT_CONFIG").value);
  assert.deepEqual(cfg.subagents, [{ name: "reviewer", agentId: "agent_t", instructions: "reviews code" }]);
});

test("buildTurnJob renders the environment's package-manager flag into DEVPROOF_AGENT_CONFIG", () => {
  const cfgOf = (job: any) => JSON.parse(job.spec.template.spec.containers[0].env
    .find((e: any) => e.name === "DEVPROOF_AGENT_CONFIG").value);
  // Absent (pre-flag payloads, e.g. parked launches) defaults to false.
  assert.equal(cfgOf(buildTurnJob(base() as any)).allow_package_managers, false);
  const allowed: any = base();
  allowed.environment.allowPackageManagers = true;
  assert.equal(cfgOf(buildTurnJob(allowed)).allow_package_managers, true);
});

test("buildTurnJob falls back to config.mcp_servers when no rendered map is passed", () => {
  const job: any = buildTurnJob({
    id: "sesn_mcp2", prompt: "p", environment: { id: "env_1", pod: {} },
    config: { routing: "m", system_prompt: "", tools: [], max_turns: 5,
              mcp_servers: { raw: { type: "http", url: "https://a.com/mcp" } } } as any,
  } as any);
  const env = job.spec.template.spec.containers[0].env
    .find((e: any) => e.name === "DEVPROOF_AGENT_CONFIG");
  assert.equal(JSON.parse(env.value).mcp_servers.raw.url, "https://a.com/mcp");
});

test("buildTurnJob strips unknown toleration fields, keeps the four allowed", () => {
  const s: any = base();
  s.environment.pod = {
    nodeSelector: { zone: "a" },
    tolerations: [{ key: "gpu", operator: "Equal", value: "true", effect: "NoSchedule", tolerationSeconds: 5, bogus: "x" } as any],
  };
  const podSpec: any = buildTurnJob(s).spec.template.spec;
  assert.deepEqual(podSpec.tolerations, [{ key: "gpu", operator: "Equal", value: "true", effect: "NoSchedule" }]);
  assert.deepEqual(podSpec.nodeSelector, { zone: "a" });
});

test("realOrchestrator fails fast when DEVPROOF_RUNNER_IMAGE is unset", () => {
  const prev = process.env.DEVPROOF_RUNNER_IMAGE;
  delete process.env.DEVPROOF_RUNNER_IMAGE;
  try {
    assert.throws(() => realOrchestrator(), /DEVPROOF_RUNNER_IMAGE/);
  } finally {
    if (prev !== undefined) process.env.DEVPROOF_RUNNER_IMAGE = prev;
  }
});
