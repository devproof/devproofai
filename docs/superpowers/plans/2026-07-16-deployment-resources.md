# Per-Deployment CPU/Memory Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every catalog entry carries mandatory per-replica CPU/memory requests; the deploy/edit modal prefills and submits them; they land in the ModelDeployment's existing `spec.resources` (requests only — no limits, no CRD/operator change).

**Architecture:** Catalog-driven values (entry-level, snapshot semantics like reasoning) resolve in `resolveDeployment`; the console threads them catalog row → deploy modal → `POST /v1/deployments`, and deployment detail → edit modal → `PATCH /v1/deployments/:name` (JSON merge-patch preserves the `gpu` key). The 162 bundled entries are backfilled by a one-off script implementing the spec's worst-case EKS/GKE/AKS rule, locked by a guard test.

**Tech Stack:** Node/TS (Fastify, node:test via tsx), Next.js console, YAML catalog.

**Spec:** `docs/superpowers/specs/2026-07-16-deployment-resources-design.md`

## Global Constraints

- **No limits anywhere** — requests only. No `resourceLimits`, no limit fields, nothing "prepared".
- **No legacy fallback** — an entry without `resources` makes `resolveDeployment` throw (→ 400). Do not add a `2`/`2Gi` default anywhere.
- **No CRD or operator change.** `spec.resources` already exists (`operator/api/v1alpha1/types.go:101`); `gpu` stays sourced from `requirements.gpus`.
- Quantity regexes (CP and console identical): cpu `^(\d+(\.\d+)?|\d+m)$`, memory `^\d+(Ki|Mi|Gi|Ti)$`.
- `control-plane` tests: `cd control-plane` then `npx tsx --test test/<file>.ts` for a single file, `npm test` for the suite (serialized on purpose — never add concurrency). Type check: `npx tsc --noEmit`.
- Console is ALWAYS verified with a production build (`cd console && npx next build`), never dev mode.
- This repo is CRLF: after bulk line deletions via Edit, re-check `git diff` for accidental line joins.
- Commit after every task.

---

### Task 1: Backfill `catalog/models.yaml` (162 entries) + guard test

**Files:**
- Modify: `catalog/models.yaml` (via one-off script; plus a manual header-comment edit)
- Create (temporary, deleted before commit): `control-plane/scripts/backfill-resources.mjs`
- Test: `control-plane/test/catalog.test.ts` (append)

**Interfaces:**
- Produces: every YAML entry has `resources: { cpu: "<qty>", memory: "<qty>Gi" }` directly above `capacityProfiles`. Known values later tasks rely on: `qwen2.5-0.5b-instruct-q4` → `{ cpu: "2", memory: "3Gi" }`, `qwen2.5-7b-instruct-q4` → `{ cpu: "3", memory: "11Gi" }`.

- [ ] **Step 1: Write the failing guard test**

Append to `control-plane/test/catalog.test.ts`:

```ts
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
```

Note: `(e as any).resources` because `CatalogEntry` gains the typed field only in Task 2 — the cast keeps this task self-contained; Task 2 removes the need but the cast is harmless and stays.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npx tsx --test test/catalog.test.ts`
Expected: FAIL — `qwen2.5-0.5b-instruct-q4: missing resources`

- [ ] **Step 3: Write the one-off backfill script**

Create `control-plane/scripts/backfill-resources.mjs`:

```js
// One-off (spec 2026-07-16): insert mandatory per-replica resources into
// catalog/models.yaml. Run from control-plane/:  node scripts/backfill-resources.mjs
// Deleted after running — the guard test in test/catalog.test.ts locks the result.
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const PATH = "../catalog/models.yaml";

// Worst-case usable node capacity across EKS/GKE/AKS reservation formulas,
// minus the 500m CPU / 1 GiB DaemonSet allowance (spec §1 table).
const NODES = {
  "g4dn.xlarge":  { cpu: 3.36,   mem: 11.67,  gpusPerNode: 1 },
  "g5.xlarge":    { cpu: 3.36,   mem: 11.67,  gpusPerNode: 1 },
  "g5.2xlarge":   { cpu: 7.32,   mem: 26.71,  gpusPerNode: 1 },
  "g6e.xlarge":   { cpu: 3.36,   mem: 26.71,  gpusPerNode: 1 },
  "a100-80gb-x1": { cpu: 94.44,  mem: 1120.5, gpusPerNode: 8 },
  "a100-80gb-x2": { cpu: 94.44,  mem: 1120.5, gpusPerNode: 8 },
  "a100-80gb-x4": { cpu: 94.44,  mem: 1120.5, gpusPerNode: 8 },
  "h100-80gb-x8": { cpu: 189.48, mem: 1998.5, gpusPerNode: 8 },
};

const doc = parse(readFileSync(PATH, "utf8"));
const values = new Map();
for (const m of doc.models) {
  if (!m.requirements?.gpus) {
    // CPU rule: weights mmap into pod memory; +2Gi covers 32k-capped KV cache + runtime.
    values.set(m.id, { cpu: "2", memory: `${(m.requirements?.diskGB ?? 1) + 2}Gi` });
    continue;
  }
  // GPU rule: usable-node × gpusPerReplica ÷ gpusPerNode, floor AFTER the
  // multiplication, then min across the entry's profiles.
  let cpu = Infinity, mem = Infinity;
  for (const p of m.capacityProfiles ?? []) {
    const n = NODES[p.instanceType];
    if (!n) throw new Error(`${m.id}: unknown instanceType ${p.instanceType}`);
    cpu = Math.min(cpu, Math.floor((n.cpu * p.gpusPerReplica) / n.gpusPerNode));
    mem = Math.min(mem, Math.floor((n.mem * p.gpusPerReplica) / n.gpusPerNode));
  }
  if (!Number.isFinite(cpu)) throw new Error(`${m.id}: GPU entry without capacity profiles`);
  values.set(m.id, { cpu: String(cpu), memory: `${mem}Gi` });
}

const lines = readFileSync(PATH, "utf8").split("\n");
const out = [];
let id = null, inserted = 0;
for (const line of lines) {
  const m = line.match(/^  - id: (.+)$/);
  if (m) id = m[1].trim();
  if (/^    resources:/.test(line)) throw new Error(`${id}: already has resources — run once only`);
  if (/^    capacityProfiles:/.test(line)) {
    const v = values.get(id);
    if (!v) throw new Error(`no computed value for ${id}`);
    out.push(`    resources: { cpu: "${v.cpu}", memory: "${v.memory}" }`);
    inserted++;
  }
  out.push(line);
}
if (inserted !== doc.models.length)
  throw new Error(`inserted ${inserted}, expected ${doc.models.length} — some entry lacks capacityProfiles`);
writeFileSync(PATH, out.join("\n"));
console.log(`inserted resources into ${inserted} entries`);
```

- [ ] **Step 4: Run the script**

Run: `cd control-plane && node scripts/backfill-resources.mjs`
Expected: `inserted resources into 162 entries`

If it throws `unknown instanceType`, the NODES table is missing a type — check the spec's §1 table before improvising; do NOT invent capacity numbers.

- [ ] **Step 5: Document the field in the YAML schema comment**

In `catalog/models.yaml`, the header comment block lists the schema. Change the line

```
#   contextTokens, requirements{vramGB,diskGB,gpus}
```

to

```
#   contextTokens, requirements{vramGB,diskGB,gpus}
#   resources{cpu,memory}: MANDATORY per-replica k8s requests (deploy prefill;
#     assignment rule in docs/superpowers/specs/2026-07-16-deployment-resources-design.md)
```

- [ ] **Step 6: Run the guard test to verify it passes**

Run: `cd control-plane && npx tsx --test test/catalog.test.ts`
Expected: PASS (all tests, including the pre-existing ones — the backfill must not have disturbed reasoning blocks etc.)

- [ ] **Step 7: Spot-check the YAML diff and delete the script**

Run: `git diff --stat catalog/models.yaml` — expected: 1 file, +163 lines (162 inserts + 1 header line... header edit adds 2 lines, so +164 total), 0 deletions. Visually check one CPU and one GPU entry:

```
git diff catalog/models.yaml | grep -A1 -B3 'resources:' | head -30
```

Then delete the one-off: `rm control-plane/scripts/backfill-resources.mjs`

- [ ] **Step 8: Commit**

```bash
git add catalog/models.yaml control-plane/test/catalog.test.ts
git commit -m "feat(catalog): mandatory per-replica resources on all 162 entries"
```

---

### Task 2: `CatalogEntry.resources` type + `resolveDeployment` resolution

**Files:**
- Modify: `control-plane/src/catalog.ts:15-44` (types), `control-plane/src/catalog.ts:72-78` (resolution)
- Test: `control-plane/test/catalog.test.ts`

**Interfaces:**
- Consumes: backfilled `catalog/models.yaml` (Task 1).
- Produces: `CatalogEntry.resources: { cpu: string; memory: string }` (required); `DeploymentRequest.resources?: { cpu?: string; memory?: string }`; `resolveDeployment` returns CR with `spec.resources = { gpu?, cpu, memory }` and throws `catalog entry <id> has no resources` when the entry lacks them.

- [ ] **Step 1: Write the failing tests**

In `control-plane/test/catalog.test.ts`, first update the `synth` array (line ~72) — both entries gain resources, or every reasoning test throws once resolution is mandatory:

```ts
const synth: any[] = [
  { id: "think-model", family: "t", displayName: "T", parameters: "4B", format: "gguf",
    source: "https://example.com/t.gguf", recommendedEngine: "llama.cpp", contextTokens: 32768,
    resources: { cpu: "1", memory: "2Gi" },
    reasoning: { efforts: { off: 0, low: 1024, medium: 4096, high: 16384 } } },
  { id: "plain-model", family: "p", displayName: "P", parameters: "1B", format: "gguf",
    source: "https://example.com/p.gguf", recommendedEngine: "llama.cpp", contextTokens: 8192,
    resources: { cpu: "1", memory: "2Gi" } },
];
```

Then append the new tests:

```ts
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
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd control-plane && npx tsx --test test/catalog.test.ts`
Expected: the three new tests FAIL (`spec.spec.resources` is `{ cpu: "2", memory: "2Gi" }` hardcoded / no throw); pre-existing tests still pass.

- [ ] **Step 3: Implement types and resolution**

In `control-plane/src/catalog.ts`, add to `CatalogEntry` (after `requirements`, line ~29):

```ts
  /** Per-replica k8s requests — MANDATORY (spec 2026-07-16). Prefilled into
   *  the deploy modal; resolveDeployment refuses entries without it. */
  resources: { cpu: string; memory: string };
```

Add to `DeploymentRequest` (after `contextTokens`, line ~41):

```ts
  resources?: { cpu?: string; memory?: string };
```

Replace the hardcoded block in `resolveDeployment` (lines 72-78: `const cpuProfile …` through `void cpuProfile;`) with:

```ts
  // Per-key: explicit request value wins, else the entry's mandatory value.
  // No legacy default (spec 2026-07-16) — an entry without resources is a
  // pre-rollout data bug, surfaced loudly.
  if (!entry.resources?.cpu || !entry.resources?.memory)
    throw new Error(`catalog entry ${entry.id} has no resources — edit the model and set per-replica requests`);
  const resources: Record<string, string> = {};
  if (entry.requirements?.gpus) resources.gpu = String(entry.requirements.gpus);
  resources.cpu = req.resources?.cpu ?? entry.resources.cpu;
  resources.memory = req.resources?.memory ?? entry.resources.memory;
```

(The `resources,` reference in the returned spec object at line ~90 is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npx tsx --test test/catalog.test.ts`
Expected: PASS — all tests including reasoning ones (synth entries now carry resources).

- [ ] **Step 5: Type-check**

Run: `cd control-plane && npx tsc --noEmit`
Expected: clean. If DB-catalog code (`repo.ts` custom-model row mapping) complains about the now-required field, do NOT weaken the type — cast at the DB boundary (`as CatalogEntry`), since old rows are guarded at runtime by resolveDeployment's throw.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/catalog.ts control-plane/test/catalog.test.ts
git commit -m "feat(cp): resolve per-replica resources from catalog entry, request override wins"
```

---

### Task 3: Quantity validation on the catalog routes

**Files:**
- Modify: `control-plane/src/server.ts:134-200` (helper + POST/PATCH /v1/catalog)
- Test: `control-plane/test/server.test.ts`

**Interfaces:**
- Consumes: `CatalogEntry.resources` (Task 2).
- Produces: `resourcesError(r, { requireBoth }): string | null` (module-scope inside `buildServer`, reused by Task 4); `POST /v1/catalog` 400s without valid `resources`; `PATCH /v1/catalog/:id` validates when present.

- [ ] **Step 1: Fix existing tests that will break, write the new failing tests**

In `control-plane/test/server.test.ts`, three existing payloads create catalog entries without `resources` and will 400 once it's mandatory. Add `resources: { cpu: "1", memory: "2Gi" }` to each:

- line ~645 (`PATCH /v1/catalog/:id updates a custom model in place`): `payload: { id: "my-model-custom", displayName: "My Model", source: "https://hf.co/x.gguf", format: "gguf", resources: { cpu: "1", memory: "2Gi" } }`
- line ~667 (`catalog releaseDate…`): the `rd-custom` POST payload gains the same `resources` key (the test still expects 400, but from `releaseDate` — without resources the 400 would pass for the wrong reason).
- line ~850+ (`custom catalog validates the reasoning shape`): the `base` payload object gains `resources: { cpu: "1", memory: "2Gi" }`.

Then append the new tests:

```ts
test("POST /v1/catalog requires valid resources", async () => {
  const app = buildServer(catalog, fakeStore().store, fakeCustom());
  const base = { id: "res-custom", displayName: "R", source: "https://hf.co/x.gguf", format: "gguf" };
  const missing = await app.inject({ method: "POST", url: "/v1/catalog", payload: base });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.json().error, /resources/);
  for (const bad of [
    { cpu: "2 cores", memory: "3Gi" }, { cpu: "2", memory: "3GB" },
    { cpu: "-1", memory: "3Gi" }, { cpu: "2" }, { cpu: "2", memory: "3Gi", gpu: "1" },
  ]) {
    const res = await app.inject({ method: "POST", url: "/v1/catalog", payload: { ...base, resources: bad } });
    assert.equal(res.statusCode, 400, `accepted ${JSON.stringify(bad)}`);
    assert.match(res.json().error, /resources/);
  }
  const ok = await app.inject({ method: "POST", url: "/v1/catalog",
    payload: { ...base, resources: { cpu: "500m", memory: "3Gi" } } });
  assert.equal(ok.statusCode, 201);
  assert.deepEqual(ok.json().resources, { cpu: "500m", memory: "3Gi" });
});

test("PATCH /v1/catalog validates resources when sent", async () => {
  const app = buildServer(catalog, fakeStore().store, fakeCustom());
  const bad = await app.inject({ method: "PATCH", url: "/v1/catalog/qwen2.5-0.5b-instruct-q4",
    payload: { resources: { cpu: "2", memory: "3GB" } } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: "PATCH", url: "/v1/catalog/qwen2.5-0.5b-instruct-q4",
    payload: { resources: { cpu: "3", memory: "4Gi" } } });
  assert.equal(ok.statusCode, 200);
  const { models } = (await app.inject({ method: "GET", url: "/v1/catalog" })).json();
  assert.deepEqual(models.find((x: any) => x.id === "qwen2.5-0.5b-instruct-q4").resources,
    { cpu: "3", memory: "4Gi" });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd control-plane && npx tsx --test test/server.test.ts`
Expected: the two new tests FAIL (missing-resources POST currently returns 201); every pre-existing test PASSES (the payload fixes are backward-compatible — `resources` is not yet validated, just stored).

- [ ] **Step 3: Implement the helper and route validation**

In `control-plane/src/server.ts`, directly after `badReleaseDate` (line ~135), add:

```ts
  // K8s-quantity sanity check (spec 2026-07-16). requireBoth: catalog entries
  // must be complete; deployment requests may override a single key.
  const CPU_QTY = /^(\d+(\.\d+)?|\d+m)$/;
  const MEM_QTY = /^\d+(Ki|Mi|Gi|Ti)$/;
  const resourcesError = (r: unknown, opts: { requireBoth: boolean }): string | null => {
    if (r == null || typeof r !== "object" || Array.isArray(r)) return "resources must be { cpu, memory }";
    const { cpu, memory } = r as any;
    const extra = Object.keys(r).filter((k) => k !== "cpu" && k !== "memory");
    if (extra.length) return `resources: unknown keys ${extra.join(", ")}`;
    if (opts.requireBoth && (cpu == null || memory == null)) return "resources needs both cpu and memory";
    if (!opts.requireBoth && cpu == null && memory == null) return "resources needs cpu or memory";
    if (cpu != null && !(typeof cpu === "string" && CPU_QTY.test(cpu)))
      return `resources.cpu must be a k8s cpu quantity (e.g. "2", "500m")`;
    if (memory != null && !(typeof memory === "string" && MEM_QTY.test(memory)))
      return `resources.memory must be a k8s memory quantity (e.g. "3Gi")`;
    return null;
  };
```

In `POST /v1/catalog` (line ~153), after the `reasoningShapeError` check:

```ts
    const resErr = resourcesError(b.resources, { requireBoth: true });
    if (resErr) return reply.code(400).send({ error: resErr });
```

and in the normalized `entry` object add `resources: b.resources,` (after the `requirements:` line — no default: the check above guarantees presence).

In `PATCH /v1/catalog/:id` (line ~185): add `"resources"` to the `allowed` set, and after the `reasoningShapeError` check:

```ts
    if (b.resources !== undefined) {
      const resErr = resourcesError(b.resources, { requireBoth: true });
      if (resErr) return reply.code(400).send({ error: resErr });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npx tsx --test test/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat(cp): validate mandatory resources on catalog write routes"
```

---

### Task 4: Deployment routes + projection

**Files:**
- Modify: `control-plane/src/server.ts` (POST /v1/deployments ~385, PATCH /v1/deployments/:name ~561, listDeployments ~331)
- Test: `control-plane/test/server.test.ts` (incl. `fakeStore` merge fidelity)

**Interfaces:**
- Consumes: `resourcesError` (Task 3), `DeploymentRequest.resources` (Task 2).
- Produces: `POST /v1/deployments` accepts `resources?: { cpu?, memory? }`; `PATCH /v1/deployments/:name` accepts the same under the `allowed` set; `GET /v1/deployments[/:name]` rows carry `resources: spec.resources | null` (the console prefill in Task 5 reads this).

- [ ] **Step 1: Teach `fakeStore.patch` merge-patch fidelity for `resources`, write the failing test**

The real store is JSON merge-patch (`kubestore.ts:57-60` — RFC 7386 merges nested objects, so `gpu` survives a cpu/memory patch). `fakeStore.patch` (test/server.test.ts:41-56) shallow-merges `spec` and would clobber the map. Mirror the existing `model:` special case: in the `obj.spec = { ... }` line, extend to

```ts
      obj.spec = { ...obj.spec, ...body.spec, model: { ...obj.spec?.model, ...body.spec?.model },
        ...(body.spec?.resources ? { resources: { ...obj.spec?.resources, ...body.spec.resources } } : {}) };
```

Then append the test:

```ts
test("deployment resources: POST validates + overrides, PATCH merges without dropping gpu", async () => {
  const { store, objects } = fakeStore();
  objects.modelpools.push({ metadata: { name: "p1" }, spec: {} });
  const app = buildServer(catalog, store);
  const bad = await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "d1", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "p1", resources: { cpu: "two" } } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /resources\.cpu/);
  const created = await app.inject({ method: "POST", url: "/v1/deployments",
    payload: { name: "d1", catalogId: "qwen2.5-0.5b-instruct-q4", poolRef: "p1", resources: { memory: "6Gi" } } });
  assert.equal(created.statusCode, 201);
  // catalog cpu ("2") + request memory override
  assert.deepEqual(objects.modeldeployments[0].spec.resources, { cpu: "2", memory: "6Gi" });

  // Simulate a GPU deployment: gpu must survive a cpu/memory PATCH (merge-patch).
  objects.modeldeployments[0].spec.resources = { gpu: "1", cpu: "2", memory: "6Gi" };
  const patched = await app.inject({ method: "PATCH", url: "/v1/deployments/d1",
    payload: { resources: { cpu: "3", memory: "8Gi" } } });
  assert.equal(patched.statusCode, 200);
  assert.deepEqual(objects.modeldeployments[0].spec.resources, { gpu: "1", cpu: "3", memory: "8Gi" });

  const badPatch = await app.inject({ method: "PATCH", url: "/v1/deployments/d1",
    payload: { resources: { memory: "8GB" } } });
  assert.equal(badPatch.statusCode, 400);

  // Projection: the edit modal prefills from the deployment's ACTUAL values.
  const rows = (await app.inject({ method: "GET", url: "/v1/deployments" })).json().deployments;
  assert.deepEqual(rows.find((d: any) => d.name === "d1").resources, { gpu: "1", cpu: "3", memory: "8Gi" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd control-plane && npx tsx --test test/server.test.ts`
Expected: the new test FAILS — first at the PATCH: `only replicas, contextTokens, engine, targetTokensPerSec, poolRef, reasoningEffort are editable (got: resources)` (POST already resolves resources via Task 2; PATCH rejects the key; projection lacks `resources`).

- [ ] **Step 3: Implement**

In `control-plane/src/server.ts`:

1. `POST /v1/deployments` (~line 390, after the engine check):

```ts
    if (b.resources !== undefined) {
      const resErr = resourcesError(b.resources, { requireBoth: false });
      if (resErr) return reply.code(400).send({ error: resErr });
    }
```

2. `PATCH /v1/deployments/:name` (~line 564): add `"resources"` to the `allowed` set. After the engine check add the same validation block as above. In the `spec` assembly (after `if (b.poolRef) spec.poolRef = b.poolRef;`):

```ts
    // Merge-patch semantics: only the sent keys change; resources.gpu survives.
    if (b.resources) spec.resources = {
      ...(b.resources.cpu != null ? { cpu: b.resources.cpu } : {}),
      ...(b.resources.memory != null ? { memory: b.resources.memory } : {}),
    };
```

3. `listDeployments` (~line 341, after the `contextTokens:` line):

```ts
      resources: d.spec?.resources ?? null,
```

- [ ] **Step 4: Run tests, then the full suite and type check**

Run: `cd control-plane && npx tsx --test test/server.test.ts`
Expected: PASS.

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: whole suite green (other files create deployments only from bundled entries, which carry resources since Task 1), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat(cp): resources on deployment create/edit + list projection"
```

---

### Task 5: Console — deploy/edit modal + call sites

**Files:**
- Modify: `console/app/deployments/deploy-modal.tsx`, `console/app/deployments/[name]/tabs.tsx:22-25`, `console/app/catalog/page.tsx` (interface + line 80)

**Interfaces:**
- Consumes: `resources` on `GET /v1/catalog` models and `GET /v1/deployments` rows (Task 4).
- Produces: deploy submits `resources: { cpu, memory }`; edit submits it only when changed and triggers the restart confirm.

- [ ] **Step 1: Extend `deploy-modal.tsx`**

All edits in `console/app/deployments/deploy-modal.tsx`:

1. Module scope (below `PRESETS`):

```ts
const CPU_QTY = /^(\d+(\.\d+)?|\d+m)$/, MEM_QTY = /^\d+(Ki|Mi|Gi|Ti)$/;
```

2. `Ctx` interface — add:

```ts
  resources?: { cpu?: string | null; memory?: string | null } | null; // deploy-local preselect / edit-local current values
```

and in `catalogPick`'s element type add `resources?: { cpu?: string; memory?: string } | null;`.

3. State (after the `idleMin` line ~59):

```ts
  const [cpuReq, setCpuReq] = useState(ctx.resources?.cpu ?? "");
  const [memReq, setMemReq] = useState(ctx.resources?.memory ?? "");
  const resValid = !isLocal || (CPU_QTY.test(cpuReq) && MEM_QTY.test(memReq));
  const resChanged = cpuReq !== (ctx.resources?.cpu ?? "") || memReq !== (ctx.resources?.memory ?? "");
```

4. Model-dropdown `onChange` (line ~232, next to `setCtxDefault`):

```ts
              setCpuReq(m?.resources?.cpu ?? "");
              setMemReq(m?.resources?.memory ?? "");
```

5. Submit bodies in `doSubmit`: `deploy-local` payload adds

```ts
        resources: { cpu: cpuReq, memory: memReq },
```

`edit-local` payload adds

```ts
        ...(resChanged ? { resources: { cpu: cpuReq, memory: memReq } } : {}),
```

6. `restartChanged` (line ~171): add `resChanged ||` INSIDE the parenthesized group (the whole expression must stay gated on `mode === "edit-local" && (…)` — appending outside the parens would make deploy-mode submits trip the restart confirm):

```ts
  const restartChanged = mode === "edit-local" && (
    resChanged ||
    (ctxNum !== undefined && ctxNum !== ctx.contextTokens) ||
    (!!poolRef && poolRef !== ctx.poolRef) ||
    engine !== (ctx.engine ?? "auto") ||
    reasoningEffort !== (ctx.reasoningEffort ?? ""));
```

7. Form: after the "Sleep after" `Field` (and its validation `<p>` block, before "Context"):

```tsx
        <Field label="Resources" hint={mode === "edit-local"
            ? "per-replica requests — changing them restarts the engine pods"
            : "per-replica requests; prefilled from the catalog entry"}>
          <span className="muted">cpu</span>
          <input style={{ width: 70, flex: "none" }} value={cpuReq} onChange={(e) => setCpuReq(e.target.value)} />
          <span className="muted">memory</span>
          <input style={{ width: 90, flex: "none" }} value={memReq} onChange={(e) => setMemReq(e.target.value)} />
        </Field>
        {!resValid && (cpuReq || memReq) !== "" && (
          <p className="modal-error" style={{ margin: "0 0 8px" }}>resources: cpu like &quot;2&quot; or &quot;500m&quot;, memory like &quot;3Gi&quot;</p>
        )}
```

8. `canSubmit`: both local arms require `resValid` — edit-local becomes `(replicasValid && !budgetError && resValid)`, deploy-local adds `&& resValid` next to `replicasValid`.

9. `DeployLocalButton`: props type gains `resources?: { cpu?: string; memory?: string } | null;`; destructure it; ctx gains `resources: resources ?? null`; its `catalogPick` mapping adds `resources: m.resources ?? null`. `DeployModelButton`'s mapping adds the same (no ctx.resources — nothing preselected, fields fill on pick).

10. `EditDeploymentName` local variant: props gain `resources?: { cpu?: string; memory?: string } | null;`; the local `ctx` mapping adds `resources: props.resources ?? null`.

- [ ] **Step 2: Wire the two call sites**

`console/app/deployments/[name]/tabs.tsx` (~line 22, local branch): add prop

```tsx
              resources={d.resources ?? null}
```

`console/app/catalog/page.tsx`: the catalog-model interface (~line 16) gains `resources?: { cpu?: string; memory?: string };`, and line 80 adds

```tsx
                  <DeployLocalButton catalogId={m.id} defaultName={m.id} contextTokens={m.contextTokens} reasoning={m.reasoning?.efforts ?? null} resources={m.resources ?? null} small />
```

- [ ] **Step 3: Build to verify**

Run: `cd console && npx next build`
Expected: compiles clean (this is the TS/type verification for the console — there is no console unit-test suite).

- [ ] **Step 4: Commit**

```bash
git add console/app/deployments/deploy-modal.tsx "console/app/deployments/[name]/tabs.tsx" console/app/catalog/page.tsx
git commit -m "feat(console): resources fields on deploy/edit modal, prefilled from catalog/deployment"
```

---

### Task 6: Console — catalog model modal

**Files:**
- Modify: `console/app/catalog/model-modal.tsx`

**Interfaces:**
- Consumes: `POST/PATCH /v1/catalog` requiring `resources` (Task 3).
- Produces: catalog add/edit form always submits `resources: { cpu, memory }`.

- [ ] **Step 1: Extend the form**

All edits in `console/app/catalog/model-modal.tsx`:

1. `Draft` interface: add `cpu: string; memory: string;`
2. `toDraft`: add (new-model defaults match the default CPU profile + disk 1):

```ts
    cpu: m?.resources?.cpu ?? "2", memory: m?.resources?.memory ?? "3Gi",
```

3. `toBody`: add `resources: { cpu: d.cpu, memory: d.memory },`
4. Form — in the "Capacity profiles" section, directly under the `<div className="modal-section">Capacity profiles</div>` line and ABOVE the "Profiles" `Field` (user-specified placement):

```tsx
      <Field label="Requests" hint='per-replica k8s requests (e.g. 2, 500m / 3Gi) — prefilled into new deployments'>
        <span className="muted">cpu</span>
        <input style={{ width: 90, flex: "none" }} value={d.cpu} onChange={(e) => set("cpu", e.target.value)} />
        <span className="muted">memory</span>
        <input style={{ width: 90, flex: "none" }} value={d.memory} onChange={(e) => set("memory", e.target.value)} />
      </Field>
```

5. Footer submit button `disabled` becomes:

```tsx
        <button disabled={busy || !d.displayName || !d.source || !d.cpu || !d.memory} onClick={submit}>
```

(Format errors surface via the CP 400 in the modal's error line, matching how releaseDate/reasoning behave.)

- [ ] **Step 2: Build to verify**

Run: `cd console && npx next build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add console/app/catalog/model-modal.tsx
git commit -m "feat(console): mandatory requests fields on the catalog model form"
```

---

### Task 7: Full verification against the live cluster

**Files:** none (verification only; fixes go where the failure is)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Suite + types**

```bash
cd control-plane && npm test && npx tsc --noEmit
```

Expected: green / clean. (`npm test` is serialized on purpose; ~2 min.)

- [ ] **Step 2: Restart CP and console**

Control plane (from `control-plane/`, NOT `npm run dev`):

```bash
DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev27 \
DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files \
npx tsx src/main.ts
```

Console (production build; if a `next start` is already running, stop it first — a rebuild under a running server pins stale chunk hashes):

```bash
cd console && npx next build && npx next start -p 7090
```

- [ ] **Step 3: Pages 200**

Check `http://localhost:7090/catalog`, `/deployments`, and one deployment detail page render (browser or curl for status).

- [ ] **Step 4: Deploy flow (prefill + pod requests)**

1. On /catalog, click Deploy on `Qwen 2.5 0.5B Instruct` — the modal shows Resources prefilled `cpu 2 / memory 3Gi` after "Sleep after". Deploy as `res-check` on the cpu pool.
2. Verify the engine pod requests match exactly:

```bash
kubectl get deploy -n devproof-serving -l serving.devproof.ai/owned-by=res-check -o jsonpath="{.items[0].spec.template.spec.containers[0].resources}"
```

Expected: `{"requests":{"cpu":"2","memory":"3Gi"}}` (requests only — LLMkube renders no limits).

- [ ] **Step 5: Edit flow (restart confirm + roll)**

On the `res-check` detail page, Edit deployment → change memory to `4Gi` → Save. Expected: "Restart engine pods?" confirm appears; after confirming, the kubectl check from Step 4 shows `"memory":"4Gi"` once pods roll.

- [ ] **Step 6: `gpu` preservation without GPU nodes**

```bash
kubectl apply -f - <<'EOF'
apiVersion: serving.devproof.ai/v1alpha1
kind: ModelDeployment
metadata: { name: gpu-merge-check, namespace: devproof-serving }
spec:
  model: { source: "https://example.com/x.gguf", format: gguf }
  poolRef: cpu-default
  replicas: { min: 0, max: 1 }
  resources: { gpu: "1", cpu: "4", memory: "8Gi" }
EOF
curl -s -X PATCH localhost:7080/v1/deployments/gpu-merge-check \
  -H "Content-Type: application/json" -d '{"resources":{"cpu":"5","memory":"9Gi"}}'
kubectl get mdep gpu-merge-check -n devproof-serving -o jsonpath="{.spec.resources}"
```

Expected: `{"cpu":"5","gpu":"1","memory":"9Gi"}` — the real merge-patch kept `gpu`. Then clean up:

```bash
kubectl delete mdep gpu-merge-check -n devproof-serving
curl -s -X DELETE localhost:7080/v1/deployments/res-check
```

- [ ] **Step 7: Catalog form round-trip**

On /catalog, edit a bundled model → Requests row shows its backfilled values; clear cpu → Save disabled; set `cpu 3 / memory 4Gi` → Save → row re-opens with the override; "Reset to defaults" restores the YAML values.

- [ ] **Step 8: Final commit (if any fixes landed during verification)**

```bash
git add -A && git commit -m "fix: live-verification fixes for deployment resources"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** §1 data model + values → Task 1; §2 types/resolution → Task 2, validation → Task 3, deployment routes + projection → Task 4; §3 deploy/edit modal → Task 5, catalog modal → Task 6; §4 tests woven into Tasks 1–4, live checks → Task 7. Out-of-scope items have no tasks (correct).
- **Existing-test fallout** from mandatory resources is handled where it breaks: `synth` fixture (Task 2), three `/v1/catalog` payloads (Task 3).
- **Type consistency:** `resources` is `{ cpu, memory }` (strings) everywhere; `resourcesError(r, { requireBoth })` defined Task 3, reused Task 4; projection field name `resources` matches the console reads in Task 5.
- The spec says "~60 bundled entries" — the real count is **162** (measured); the rule is unchanged, the guard test asserts per-entry validity, and the backfill script hard-fails if its insert count ≠ entry count.
