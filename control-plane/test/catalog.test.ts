import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadCatalog, resolveDeployment } from "../src/catalog.ts";

const seedPath = fileURLToPath(new URL("../../catalog/models.yaml", import.meta.url));

test("loadCatalog parses the seed catalog", () => {
  const entries = loadCatalog(seedPath);
  assert.ok(entries.length >= 10, "catalog should offer a broad model selection");
  const e = entries.find((x) => x.id === "qwen2.5-0.5b-instruct-q4")!;
  assert.ok(e, "seed CPU model present");
  assert.equal(e.format, "gguf");
  assert.match(e.source, /^https:\/\/huggingface\.co\//);
  assert.equal(e.recommendedEngine, "llama.cpp");
  // Every profile carries instance type + estimated throughput for the UI.
  for (const m of entries) {
    for (const p of m.capacityProfiles ?? []) {
      assert.ok(p.instanceType && typeof p.estTokensPerSec === "number", `${m.id} profile needs instanceType+estTokensPerSec`);
    }
  }
});

test("resolveDeployment maps catalog entry to ModelDeployment spec", () => {
  const catalog = loadCatalog(seedPath);
  const spec = resolveDeployment(catalog, {
    name: "qwen05b-api",
    catalogId: "qwen2.5-0.5b-instruct-q4",
    poolRef: "cpu-default",
  });
  assert.equal(spec.metadata.name, "qwen05b-api");
  assert.equal(spec.metadata.namespace, "devproof-serving");
  assert.equal(spec.spec.model.source, catalog[0].source);
  assert.equal(spec.spec.model.format, "gguf");
  assert.equal(spec.spec.poolRef, "cpu-default");
  assert.deepEqual(spec.spec.replicas, { min: 1, max: 1 });
  assert.equal(spec.spec.catalogId, "qwen2.5-0.5b-instruct-q4");
});

test("resolveDeployment throws on unknown catalogId", () => {
  const catalog = loadCatalog(seedPath);
  assert.throws(
    () => resolveDeployment(catalog, { name: "x", catalogId: "nope", poolRef: "p" }),
    /unknown catalog entry/,
  );
});

test("resolveDeployment passes engine through, defaulting to auto", () => {
  const catalog = loadCatalog(seedPath);
  const withEngine = resolveDeployment(catalog, {
    name: "d1", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "p", engine: "sglang",
  });
  assert.equal(withEngine.spec.engine, "sglang");
  const without = resolveDeployment(catalog, { name: "d2", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "p" });
  assert.equal(without.spec.engine, "auto");
});

test("resolveDeployment honors request contextTokens and replicas overrides", () => {
  const catalog = loadCatalog(seedPath);
  const spec = resolveDeployment(catalog, {
    name: "q", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "cpu-default",
    replicas: { min: 2, max: 5 }, contextTokens: 16384,
  });
  assert.deepEqual(spec.spec.replicas, { min: 2, max: 5 });
  assert.equal(spec.spec.model.contextTokens, 16384);
  // Falls back to the catalog entry's context when the request omits it.
  const dflt = resolveDeployment(catalog, { name: "q2", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "cpu-default" });
  const entry = catalog.find((e) => e.id === "qwen2.5-0.5b-instruct-q4")!;
  assert.equal(dflt.spec.model.contextTokens, entry.contextTokens ?? 0);
});

const synth: any[] = [
  { id: "think-model", family: "t", displayName: "T", parameters: "4B", format: "gguf",
    source: "https://example.com/t.gguf", recommendedEngine: "llama.cpp", contextTokens: 32768,
    resources: { cpu: "1", memory: "2Gi" },
    reasoning: { efforts: { off: 0, low: 1024, medium: 4096, high: 16384 } } },
  { id: "plain-model", family: "p", displayName: "P", parameters: "1B", format: "gguf",
    source: "https://example.com/p.gguf", recommendedEngine: "llama.cpp", contextTokens: 8192,
    resources: { cpu: "1", memory: "2Gi" } },
];

test("resolveDeployment resolves a reasoning effort to a budget snapshot", () => {
  const spec = resolveDeployment(synth, {
    name: "t1", catalogId: "think-model", poolRef: "p", reasoningEffort: "medium",
  });
  assert.deepEqual(spec.spec.reasoning, { effort: "medium", budgetTokens: 4096 });
  // "off" resolves to budget 0 — 0 is a value, not unset.
  const off = resolveDeployment(synth, {
    name: "t2", catalogId: "think-model", poolRef: "p", reasoningEffort: "off",
  });
  assert.deepEqual(off.spec.reasoning, { effort: "off", budgetTokens: 0 });
});

test("resolveDeployment omits spec.reasoning when no effort requested", () => {
  const spec = resolveDeployment(synth, { name: "t3", catalogId: "think-model", poolRef: "p" });
  assert.equal(spec.spec.reasoning, undefined);
  const empty = resolveDeployment(synth, { name: "t4", catalogId: "think-model", poolRef: "p", reasoningEffort: "" });
  assert.equal(empty.spec.reasoning, undefined);
});

test("resolveDeployment rejects efforts the catalog does not define", () => {
  assert.throws(
    () => resolveDeployment(synth, { name: "x", catalogId: "plain-model", poolRef: "p", reasoningEffort: "low" }),
    /does not support configurable reasoning/,
  );
  assert.throws(
    () => resolveDeployment(synth, { name: "x", catalogId: "think-model", poolRef: "p", reasoningEffort: "max" }),
    /unknown reasoning effort "max" — valid: off, low, medium, high/,
  );
});

test("resolveDeployment rejects reasoning on non-llama.cpp engines", () => {
  for (const engine of ["sglang", "vllm"]) {
    assert.throws(
      () => resolveDeployment(synth, { name: "x", catalogId: "think-model", poolRef: "p", engine, reasoningEffort: "low" }),
      /reasoning is llama\.cpp-only/,
    );
  }
  // auto and llama.cpp are fine
  for (const engine of [undefined, "auto", "llama.cpp"]) {
    const s = resolveDeployment(synth, { name: "x", catalogId: "think-model", poolRef: "p", engine, reasoningEffort: "low" });
    assert.ok(s.spec.reasoning);
    assert.equal(s.spec.reasoning.budgetTokens, 1024);
  }
});

test("seed catalog reasoning blocks follow the classification", () => {
  const HYBRID = { off: 0, low: 1024, medium: 4096, high: 16384 };
  const DEDICATED = { low: 2048, medium: 8192, high: 32768 };
  const entries = loadCatalog(seedPath);
  const byId = new Map(entries.map((e) => [e.id, e]));
  // Hybrid: off + standard tiers.
  assert.deepEqual(byId.get("qwen3-4b-q4")!.reasoning,
    { efforts: { off: 0, low: 1024, medium: 4096, high: 16384 } });
  assert.deepEqual(byId.get("glm-5.2-q4")!.reasoning,
    { efforts: { off: 0, low: 1024, medium: 4096, high: 16384 } });
  // Dedicated reasoner: no off, heavier tiers.
  assert.deepEqual(byId.get("deepseek-r1-distill-qwen-7b-q4")!.reasoning,
    { efforts: { low: 2048, medium: 8192, high: 32768 } });
  assert.deepEqual(byId.get("gpt-oss-20b-q4")!.reasoning,
    { efforts: { low: 2048, medium: 8192, high: 32768 } });
  // Non-thinking models have no block.
  assert.equal(byId.get("qwen2.5-0.5b-instruct-q4")!.reasoning, undefined);
  assert.equal(byId.get("qwen3-4b-instruct-2507-q4")!.reasoning, undefined);
  // gguf-only rule: the safetensors R1 twins are excluded.
  assert.equal(byId.get("deepseek-r1-distill-qwen-7b")!.reasoning, undefined);
  assert.equal(byId.get("deepseek-r1-distill-llama-70b")!.reasoning, undefined);
  // Structural rules across the whole catalog.
  let blocks = 0;
  for (const e of entries) {
    if (!e.reasoning) continue;
    blocks++;
    assert.equal(e.format, "gguf", `${e.id}: reasoning on a non-gguf entry`);
    const efforts = Object.entries(e.reasoning.efforts);
    assert.ok(efforts.length >= 3, `${e.id}: too few efforts`);
    for (const [k, v] of efforts) {
      assert.ok(typeof k === "string" && k.length > 0 && k !== "false", `${e.id}: bad effort key ${k} (YAML 1.1 boolean leak?)`);
      assert.ok(Number.isInteger(v) && v >= 0, `${e.id}.${k}: budget must be an int ≥ 0`);
    }
    assert.ok(
      JSON.stringify(e.reasoning.efforts) === JSON.stringify(HYBRID)
        || JSON.stringify(e.reasoning.efforts) === JSON.stringify(DEDICATED),
      `${e.id}: efforts must exactly match one canonical tier`,
    );
  }
  assert.equal(blocks, 72, "expected exactly 72 reasoning blocks (39 hybrid + 33 dedicated)");
});

test("every catalog entry carries valid per-replica resources (spec 2026-07-16)", () => {
  const CPU_QTY = /^(\d+(\.\d+)?|\d+m)$/, MEM_QTY = /^\d+(Ki|Mi|Gi|Ti)$/;
  const entries = loadCatalog(seedPath);
  for (const e of entries) {
    assert.ok((e as any).resources, `${e.id}: missing resources`);
    assert.match((e as any).resources.cpu, CPU_QTY, `${e.id}: bad cpu`);
    assert.match((e as any).resources.memory, MEM_QTY, `${e.id}: bad memory`);
  }
  // Spot-checks lock the assignment rule's arithmetic (worst-case usable
  // node capacity, floor AFTER multiplying by gpusPerReplica, min across
  // profiles; CPU models: cpu 2 / (diskGB+2)Gi).
  const byId = new Map(entries.map((e) => [e.id, e as any]));
  assert.deepEqual(byId.get("qwen2.5-0.5b-instruct-q4")!.resources, { cpu: "2", memory: "3Gi" });
  assert.deepEqual(byId.get("qwen2.5-7b-instruct-q4")!.resources, { cpu: "3", memory: "11Gi" });
  assert.deepEqual(byId.get("phi-4-14b")!.resources, { cpu: "3", memory: "26Gi" });
  assert.deepEqual(byId.get("mistral-small-24b-instruct")!.resources, { cpu: "3", memory: "26Gi" });
  assert.deepEqual(byId.get("qwen2.5-32b-instruct")!.resources, { cpu: "11", memory: "140Gi" });
  assert.deepEqual(byId.get("llama-3.3-70b-instruct")!.resources, { cpu: "23", memory: "280Gi" });
  assert.deepEqual(byId.get("qwen3-235b-a22b-instruct-2507-q4")!.resources, { cpu: "47", memory: "560Gi" });
  assert.deepEqual(byId.get("qwen3-coder-480b-a35b-instruct-q4")!.resources, { cpu: "189", memory: "1998Gi" });
});

test("resolveDeployment sources resources from the catalog entry", () => {
  const catalog = loadCatalog(seedPath);
  const spec = resolveDeployment(catalog, { name: "r1", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "p" });
  // CPU model: no gpu key (requirements.gpus is 0)
  assert.deepEqual(spec.spec.resources, { cpu: "2", memory: "3Gi" });
});

test("resolveDeployment honors per-key request overrides", () => {
  const catalog = loadCatalog(seedPath);
  const spec = resolveDeployment(catalog, {
    name: "r2", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "p", resources: { memory: "6Gi" },
  });
  assert.deepEqual(spec.spec.resources, { cpu: "2", memory: "6Gi" });
});

test("resolveDeployment keeps gpu from requirements; throws without entry resources", () => {
  const catalog = loadCatalog(seedPath);
  const gpu = resolveDeployment(catalog, { name: "r3", catalogId: "qwen2.5-7b-instruct-q4", poolRef: "p" });
  assert.deepEqual(gpu.spec.resources, { gpu: "1", cpu: "3", memory: "11Gi" });
  // No legacy fallback (spec decision): an entry without resources is a hard error.
  const noRes = { ...catalog.find((e) => e.id === "qwen2.5-0.5b-instruct-q4")!, id: "no-res" } as any;
  delete noRes.resources;
  assert.throws(
    () => resolveDeployment([noRes], { name: "x", catalogId: "no-res", poolRef: "p" }),
    /has no resources/,
  );
});
