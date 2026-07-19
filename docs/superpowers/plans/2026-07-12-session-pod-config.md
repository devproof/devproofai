# Session Pod Configuration on Environments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Environments carry the full pod configuration for session (turn) pods — resources, placement, and a `/work` disk (emptyDir or ephemeral PVC) — and become mandatory for agents.

**Architecture:** One JSONB `pod` column on `environments`, validated at the API edge (`pod-config.ts`), resolved live at Job creation by a pure `buildTurnJob` extracted from the orchestrator. The synthetic `env_none` fallback is removed. Runner learns `DEVPROOF_CHECKPOINT_WORK` (tag `dev24`). Spec: `docs/superpowers/specs/2026-07-12-session-pod-config-design.md`.

**Tech Stack:** Node/TS (Fastify, node:test via `npm test`), `@kubernetes/client-node@^1.3.0`, Postgres JSONB, Next.js console, Python runner.

## Global Constraints

- Migrations re-run EVERY boot — `025` must be idempotent (`ADD COLUMN IF NOT EXISTS`); do NOT add `NOT NULL` to `agent_versions.environment_id`.
- No behavior handling for legacy null-environment rows — the user fixes data by hand; APIs just 400.
- Runner changes bump the image tag: `dev23` → `dev24`; CP is started with `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev24`.
- The platform prompt must NEVER contain the word "Claude" (see CLAUDE.md model-identity rules).
- Console: shared `Modal`/`Field` components only; no `prompt()`/`confirm()`; no transparent text buttons; production build (`npx next build`).
- Backend gates: `cd control-plane && npm test` and `npx tsc --noEmit` must pass at every commit.
- All commits end with the standard `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_018jG2NiYKGURjee1g6RWhyb` trailer.

---

### Task 1: `PodConfig` type + `validatePodConfig` (pure)

**Files:**
- Create: `control-plane/src/pod-config.ts`
- Create: `control-plane/test/pod-config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface PodConfig { requests?: {cpu?: string; memory?: string}; limits?: {cpu?: string; memory?: string}; nodeSelector?: Record<string,string>; tolerations?: {key?: string; operator?: string; value?: string; effect?: string}[]; disk?: PodDisk }`, `interface PodDisk { type: "emptyDir"|"pvc"; storageClass?: string; sizeGb?: number; persistWork?: boolean }`, and `function validatePodConfig(pod: unknown): string | null` (error message, or null when valid; null/undefined input is valid).

- [ ] **Step 1: Write the failing test**

```ts
// control-plane/test/pod-config.test.ts
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
    tolerations: [{ key: "gpu", operator: "Equal", value: "true", effect: "NoSchedule" }, { operator: "Exists" }],
    disk: { type: "pvc", storageClass: "standard", sizeGb: 64, persistWork: false },
  }), null);
  assert.equal(validatePodConfig({ disk: { type: "emptyDir" } }), null);
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
});

test("rejects bad disk configs", () => {
  assert.match(validatePodConfig({ disk: { type: "hostPath" } })!, /disk\.type/);
  assert.match(validatePodConfig({ disk: { type: "pvc", sizeGb: 64 } })!, /storageClass/);
  assert.match(validatePodConfig({ disk: { type: "pvc", storageClass: "standard" } })!, /sizeGb/);
  assert.match(validatePodConfig({ disk: { type: "pvc", storageClass: "standard", sizeGb: 0 } })!, /sizeGb/);
  assert.match(validatePodConfig({ disk: { type: "pvc", storageClass: "standard", sizeGb: 1.5 } })!, /sizeGb/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --import tsx --test test/pod-config.test.ts`
Expected: FAIL — cannot find module `../src/pod-config.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// control-plane/src/pod-config.ts
// Pod-level configuration an environment applies to its session (turn) pods
// (spec 2026-07-12). Validated at the API edge; consumed by buildTurnJob.

export interface PodDisk {
  type: "emptyDir" | "pvc";
  storageClass?: string;
  sizeGb?: number;
  /** pvc only: keep /work in the checkpoint tarball (default true). */
  persistWork?: boolean;
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

/** Returns an error message, or null when the config is valid. */
export function validatePodConfig(pod: unknown): string | null {
  if (pod == null) return null;
  if (typeof pod !== "object" || Array.isArray(pod)) return "pod must be an object";
  const p = pod as PodConfig;
  for (const [group, vals] of [["requests", p.requests], ["limits", p.limits]] as const) {
    for (const key of ["cpu", "memory"] as const) {
      const v = vals?.[key];
      if (v != null && (typeof v !== "string" || !QUANTITY.test(v)))
        return `pod.${group}.${key} must be a Kubernetes quantity (e.g. 250m, 512Mi)`;
    }
  }
  if (p.nodeSelector != null && (typeof p.nodeSelector !== "object" || Array.isArray(p.nodeSelector)
      || Object.entries(p.nodeSelector).some(([k, v]) => !k || typeof v !== "string")))
    return "pod.nodeSelector must map non-empty label keys to string values";
  if (p.tolerations != null) {
    if (!Array.isArray(p.tolerations)) return "pod.tolerations must be an array";
    for (const t of p.tolerations) {
      if (!TOL_OPERATORS.includes(t?.operator ?? "Equal")) return "pod.tolerations operator must be Equal or Exists";
      if (!TOL_EFFECTS.includes(t?.effect ?? "")) return "pod.tolerations effect must be NoSchedule, PreferNoSchedule or NoExecute";
    }
  }
  if (p.disk != null && p.disk.type !== "emptyDir") {
    if (p.disk.type !== "pvc") return "pod.disk.type must be emptyDir or pvc";
    if (!p.disk.storageClass?.trim()) return "pod.disk.storageClass is required for a pvc disk";
    if (!Number.isInteger(p.disk.sizeGb) || (p.disk.sizeGb as number) < 1)
      return "pod.disk.sizeGb must be an integer ≥ 1";
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd control-plane && node --import tsx --test test/pod-config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/pod-config.ts control-plane/test/pod-config.test.ts
git commit -m "feat(cp): PodConfig type + validation for environment pod settings"
```

---

### Task 2: Migration 025 + repo `pod` support

**Files:**
- Create: `control-plane/sql/025_environment_pod.sql`
- Modify: `control-plane/src/repo.ts` (createEnvironment ~line 612, updateEnvironment ~line 627; new getEnvironment)

**Interfaces:**
- Consumes: `PodConfig` from Task 1.
- Produces: `repo.createEnvironment(workspaceId, name, allowPackageManagers?, allowedHosts?, pod?: PodConfig)`; `repo.updateEnvironment(workspaceId, id, patch: { name?; allowPackageManagers?; allowedHosts?; pod?: PodConfig })`; `repo.getEnvironment(id: string): Promise<row | null>` (row is the full snake_case environments row incl. `pod`).

- [ ] **Step 1: Write the migration**

```sql
-- control-plane/sql/025_environment_pod.sql
-- Session-pod configuration on environments (spec 2026-07-12): resources,
-- placement, and the /work disk. Shape documented in src/pod-config.ts.
ALTER TABLE environments ADD COLUMN IF NOT EXISTS pod JSONB NOT NULL DEFAULT '{}';
```

- [ ] **Step 2: Update `repo.ts`**

Add to imports: `import type { PodConfig } from "./pod-config.ts";`

Replace `createEnvironment`:

```ts
  async createEnvironment(workspaceId: string, name: string, allowPackageManagers = false, allowedHosts: string[] = [], pod: PodConfig = {}) {
    const id = rid("env");
    await this.pool.query(
      "INSERT INTO environments (id, workspace_id, name, allow_package_managers, allowed_hosts, pod) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, workspaceId, name, allowPackageManagers, JSON.stringify(allowedHosts), JSON.stringify(pod)],
    );
    return { id, name, allowPackageManagers, allowedHosts, pod };
  }
```

In `updateEnvironment`, widen the patch type to `{ name?: string; allowPackageManagers?: boolean; allowedHosts?: string[]; pod?: PodConfig }` and add after the `allowedHosts` line:

```ts
    if (patch.pod !== undefined) { params.push(JSON.stringify(patch.pod)); sets.push(`pod = $${params.length}`); }
```

Add below `updateEnvironment` (id is unguessable; runner-adjacent paths don't carry a workspace — same posture as the inline query in `getSessionDetail`):

```ts
  /** Environment row by id, workspace-agnostic (ids are unguessable). */
  async getEnvironment(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM environments WHERE id = $1", [id]);
    return rows[0] ?? null;
  }
```

- [ ] **Step 3: Verify types + suite**

Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: both pass (no behavior change yet).

- [ ] **Step 4: Commit**

```bash
git add control-plane/sql/025_environment_pod.sql control-plane/src/repo.ts
git commit -m "feat(cp): environments.pod JSONB column + repo accessors"
```

---

### Task 3: Environment routes accept + validate `pod`

**Files:**
- Modify: `control-plane/src/agents-api.ts` (POST /v1/environments ~line 153, PATCH ~line 161)
- Test: `control-plane/test/agents-api.test.ts` (fake repo `createEnvironment`/`updateEnvironment` ~lines 112–116, plus new tests)

**Interfaces:**
- Consumes: `validatePodConfig`, `PodConfig` (Task 1); repo signatures (Task 2).
- Produces: `POST/PATCH /v1/environments` accept an optional `pod` body field; invalid pod → 400 `{error: <field-specific message>}`.

- [ ] **Step 1: Write the failing tests** (append to `agents-api.test.ts`)

```ts
test("environment create accepts a pod config and passes it to the repo", async () => {
  const { app } = await build();
  const res = await app.inject({ method: "POST", url: "/v1/environments", payload: {
    name: "big", pod: { requests: { cpu: "500m" }, disk: { type: "pvc", storageClass: "standard", sizeGb: 128, persistWork: true } },
  } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().pod.disk.sizeGb, 128);
});

test("environment create/patch rejects invalid pod configs with 400", async () => {
  const { app } = await build();
  for (const pod of [
    { requests: { cpu: "lots" } },
    { disk: { type: "hostPath" } },
    { disk: { type: "pvc", sizeGb: 64 } },
  ]) {
    const res = await app.inject({ method: "POST", url: "/v1/environments", payload: { name: "bad", pod } });
    assert.equal(res.statusCode, 400, JSON.stringify(pod));
  }
  const patch = await app.inject({ method: "PATCH", url: "/v1/environments/env_0", payload: { pod: { limits: { memory: "1 GB" } } } });
  assert.equal(patch.statusCode, 400);
});
```

Update the fake repo so the accept-test can echo `pod`:

```ts
    async createEnvironment(_ws: string, name: string, _pkg?: boolean, _hosts?: string[], pod?: any) {
      return { id: "env_0", name, allowPackageManagers: false, pod: pod ?? {} };
    },
```

and in the fake `updateEnvironment` return object add `pod: patch.pod ?? {}`.

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && node --import tsx --test test/agents-api.test.ts`
Expected: FAIL — 201 where 400 expected (no validation yet) and missing pod echo.

- [ ] **Step 3: Implement the route changes**

Add to `agents-api.ts` imports: `import { validatePodConfig, type PodConfig } from "./pod-config.ts";`

POST /v1/environments becomes:

```ts
  app.post("/v1/environments", async (req, reply) => {
    const b = req.body as { name: string; allowPackageManagers?: boolean; allowedHosts?: string[]; pod?: unknown };
    if (!b?.name) return reply.code(400).send({ error: "name required" });
    const podErr = validatePodConfig(b.pod);
    if (podErr) return reply.code(400).send({ error: podErr });
    const env = await repo.createEnvironment(ws(req), b.name, b.allowPackageManagers ?? false, b.allowedHosts ?? [], (b.pod as PodConfig) ?? {});
    await orchestrator.ensureEnvironmentPolicy(env);
    return reply.code(201).send(env);
  });
```

PATCH /v1/environments/:id — widen the body type with `pod?: unknown`, and before `repo.updateEnvironment` add:

```ts
    if (b.pod !== undefined) {
      const podErr = validatePodConfig(b.pod);
      if (podErr) return reply.code(400).send({ error: podErr });
    }
```

then include `pod: b.pod as PodConfig | undefined` in the patch object passed to `repo.updateEnvironment`.

- [ ] **Step 4: Run tests**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/test/agents-api.test.ts
git commit -m "feat(cp): environment routes accept validated pod config"
```

---

### Task 4: `GET /v1/storage-classes`

**Files:**
- Modify: `control-plane/src/agents-api.ts` (Orchestrator interface ~line 8; new route near the environment routes)
- Modify: `control-plane/src/orchestrator.ts` (new api client + method)
- Test: `control-plane/test/agents-api.test.ts` (fake orchestrator ~line 141)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Orchestrator.listStorageClasses(): Promise<{ name: string; provisioner: string; isDefault: boolean }[]>`; route `GET /v1/storage-classes` → `{ storageClasses: [...] }`.

- [ ] **Step 1: Write the failing test**

```ts
test("GET /v1/storage-classes returns the cluster's classes", async () => {
  const { app } = await build();
  const res = await app.inject({ method: "GET", url: "/v1/storage-classes" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { storageClasses: [{ name: "standard", provisioner: "rancher.io/local-path", isDefault: true }] });
});
```

Add to the fake orchestrator object in `fakes()`:

```ts
    async listStorageClasses() { return [{ name: "standard", provisioner: "rancher.io/local-path", isDefault: true }]; },
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && node --import tsx --test test/agents-api.test.ts`
Expected: FAIL — 404 on the route (and a type error until the interface gains the method).

- [ ] **Step 3: Implement**

In the `Orchestrator` interface (`agents-api.ts`) add:

```ts
  /** Cluster StorageClasses for the environment PVC-disk dropdown. */
  listStorageClasses(): Promise<{ name: string; provisioner: string; isDefault: boolean }[]>;
```

Route (place after the DELETE /v1/environments handler; global — cluster infra, like Serving):

```ts
  // Cluster storage classes for the environment disk dropdown (spec 2026-07-12).
  app.get("/v1/storage-classes", async () => ({ storageClasses: await orchestrator.listStorageClasses() }));
```

In `orchestrator.ts`, next to the other clients add `const storage = kc.makeApiClient(k8s.StorageV1Api);` and to the returned object (verified live: client-node 1.x returns `{items}` directly):

```ts
    async listStorageClasses() {
      const res: any = await storage.listStorageClass();
      return (res.items ?? []).map((sc: any) => ({
        name: sc.metadata?.name ?? "",
        provisioner: sc.provisioner ?? "",
        isDefault: sc.metadata?.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true",
      }));
    },
```

- [ ] **Step 4: Run tests**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/src/orchestrator.ts control-plane/test/agents-api.test.ts
git commit -m "feat(cp): GET /v1/storage-classes reads cluster StorageClasses"
```

---

### Task 5: Extract pure `buildTurnJob` + apply pod config

**Files:**
- Modify: `control-plane/src/orchestrator.ts` (startSession ~lines 192–291 → extracted)
- Modify: `control-plane/src/agents-api.ts` (Orchestrator.startSession param gains OPTIONAL `environment`)
- Create: `control-plane/test/orchestrator.test.ts`

**Interfaces:**
- Consumes: `PodConfig`, `PodDisk` (Task 1).
- Produces: `buildTurnJob(session: Parameters<Orchestrator["startSession"]>[0]): object` (the complete Job body, exported from `orchestrator.ts`); `startSession` accepts `environment?: { id: string; pod?: PodConfig | null }` (made REQUIRED in Task 6).

- [ ] **Step 1: Add the optional field to the interface**

In `agents-api.ts` `Orchestrator.startSession` param object, after `workspace?: string;` add:

```ts
    /** The agent's environment, resolved fresh per turn (required from Task 6). */
    environment?: { id: string; pod?: import("./pod-config.ts").PodConfig | null };
```

- [ ] **Step 2: Write the failing tests**

```ts
// control-plane/test/orchestrator.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTurnJob } from "../src/orchestrator.ts";

const base = () => ({
  id: "sesn_x1", prompt: "hi", workspace: "wrkspc_default",
  config: { model: "m", system_prompt: "", tools: [], max_turns: 10 },
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

test("pvc disk becomes a generic ephemeral volume; persistWork=false flips the flag", () => {
  const s: any = base();
  s.environment.pod = { disk: { type: "pvc", storageClass: "standard", sizeGb: 128, persistWork: false } };
  const job: any = buildTurnJob(s);
  const podSpec = job.spec.template.spec;
  assert.deepEqual(podSpec.volumes, [{ name: "work", ephemeral: { volumeClaimTemplate: { spec: {
    accessModes: ["ReadWriteOnce"], storageClassName: "standard",
    resources: { requests: { storage: "128Gi" } },
  } } } }]);
  assert.equal(podSpec.containers[0].env.find((e: any) => e.name === "DEVPROOF_CHECKPOINT_WORK").value, "0");
});

test("pvc with persistWork=true keeps checkpoint-work on", () => {
  const s: any = base();
  s.environment.pod = { disk: { type: "pvc", storageClass: "standard", sizeGb: 64, persistWork: true } };
  const job: any = buildTurnJob(s);
  assert.equal(job.spec.template.spec.containers[0].env.find((e: any) => e.name === "DEVPROOF_CHECKPOINT_WORK").value, "1");
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

test("resume turn is reflected in the job name and DEVPROOF_TURN", () => {
  const s: any = { ...base(), resume: { turn: 3, sdkSessionId: "sdk1", checkpointFileId: "file_1" } };
  const job: any = buildTurnJob(s);
  assert.equal(job.metadata.name, "sesn-x1-t3");
  assert.equal(job.spec.template.spec.containers[0].env.find((e: any) => e.name === "DEVPROOF_TURN").value, "3");
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd control-plane && node --import tsx --test test/orchestrator.test.ts`
Expected: FAIL — `buildTurnJob` is not exported.

- [ ] **Step 4: Extract and implement `buildTurnJob`**

In `orchestrator.ts`: add `import type { PodConfig } from "./pod-config.ts";`. Replace the whole `async startSession(session) { ... }` method with:

```ts
    async startSession(session) {
      await batch.createNamespacedJob({ namespace: AGENTS_NAMESPACE, body: buildTurnJob(session) });
    },
```

and add the exported function at module level (below `realOrchestrator`). It is the CURRENT job body verbatim — same env vars, labels, envFrom, deadlines — with these changes: shared `labels` const, `envId` prefers `session.environment?.id`, resources/nodeSelector/tolerations/volumes from `pod`, the `work` volume + mount, `DEVPROOF_CHECKPOINT_WORK`, and `securityContext.fsGroup`:

```ts
/** Pure Job body for one session turn — exported for tests (spec 2026-07-12). */
export function buildTurnJob(session: Parameters<Orchestrator["startSession"]>[0]) {
  const turn = session.resume?.turn ?? 0;
  // env_none fallback removed in the env_none-removal task once environment is required.
  const envId = session.environment?.id ?? (session.config as any).environment_id ?? "env_none";
  const pod: PodConfig = session.environment?.pod ?? {};
  const disk = pod.disk?.type === "pvc" ? pod.disk : { type: "emptyDir" as const };
  const labels = {
    "devproof.ai/session": session.id,
    app: "devproof-session",
    "devproof.ai/environment": envId,
  };
  const proxy = `http://egress-${envId.replace(/_/g, "-").toLowerCase()}.${AGENTS_NAMESPACE}.svc.cluster.local:3128`;
  const noProxy = "gateway.devproof-gateway.svc.cluster.local,host.docker.internal,localhost,127.0.0.1,10.0.0.0/8";
  return {
    metadata: { name: `${session.id.replace(/_/g, "-").toLowerCase()}-t${turn}`, labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      // Per-agent turn deadline; the reconciler marks the session failed
      // (resumable) when the pod is killed by it.
      activeDeadlineSeconds: (session.config as any).turn_deadline_sec ?? 1800,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          // Non-root runner (uid/gid 1000): group-own mounted volumes so /work
          // stays writable on PVCs whose filesystem is root-owned.
          securityContext: { fsGroup: 1000 },
          ...(Object.keys(pod.nodeSelector ?? {}).length ? { nodeSelector: pod.nodeSelector } : {}),
          ...((pod.tolerations ?? []).length ? { tolerations: pod.tolerations } : {}),
          volumes: [
            disk.type === "pvc"
              ? { name: "work", ephemeral: { volumeClaimTemplate: { spec: {
                  accessModes: ["ReadWriteOnce"],
                  storageClassName: disk.storageClass,
                  resources: { requests: { storage: `${disk.sizeGb}Gi` } },
                } } } }
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
                    model: session.config.model,
                    system_prompt: session.config.system_prompt,
                    tools: session.config.tools,
                    max_turns: session.config.max_turns,
                    mcp_servers: (session.config as any).mcp_servers ?? {},
                  }),
                },
                { name: "ANTHROPIC_BASE_URL", value: GATEWAY_URL },
                // Internal key: passes gateway auth; metered as source='session' with the attribution headers below.
                { name: "ANTHROPIC_AUTH_TOKEN", value: process.env.DEVPROOF_INTERNAL_KEY ?? "none" },
                {
                  // Attribution for gateway metering/trace (spec 2026-07-10):
                  // the agent client sends these on every request to the gateway.
                  name: "ANTHROPIC_CUSTOM_HEADERS",
                  value: [
                    `X-Devproof-Agent: ${(session.config as any).agent_id ?? ""}`,
                    `X-Devproof-Session: ${session.id}`,
                    `X-Devproof-Workspace: ${session.workspace ?? "wrkspc_default"}`,
                  ].join("\n"),
                },
                { name: "DEVPROOF_EVENTS_URL", value: `${CALLBACK_URL}/v1/sessions/${session.id}` },
                { name: "DEVPROOF_FILES_URL", value: `${CALLBACK_URL}/v1/files` },
                { name: "DEVPROOF_ATTACHMENTS", value: JSON.stringify(session.attachments ?? []) },
                { name: "DEVPROOF_RESUME", value: session.resume?.sdkSessionId ?? "" },
                { name: "DEVPROOF_CHECKPOINT", value: session.resume?.checkpointFileId ?? "" },
                { name: "DEVPROOF_TURN", value: String(turn) },
                // pvc + persistWork=false ⇒ /work is per-turn scratch, excluded from the checkpoint.
                { name: "DEVPROOF_CHECKPOINT_WORK", value: disk.type === "pvc" && disk.persistWork === false ? "0" : "1" },
                { name: "DEVPROOF_SKILLS", value: JSON.stringify(session.skills ?? []) },
                { name: "DEVPROOF_MEMORY", value: JSON.stringify(session.memory ?? []) },
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
```

Note: the old IIFE that built the proxy env vars is inlined (envId is now computed once at the top); the comment "No environment ⇒ built-in deny-all egress" on the labels goes away in Task 7 with the fallback itself. Compare against the pre-edit `startSession` body (git diff) to confirm NOTHING else changed — same env var names, order-insensitive.

- [ ] **Step 5: Run tests**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: PASS (orchestrator tests + full suite).

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/orchestrator.ts control-plane/src/agents-api.ts control-plane/test/orchestrator.test.ts
git commit -m "feat(cp): pure buildTurnJob applies environment pod config (resources, placement, /work disk)"
```

---

### Task 6: Environments mandatory — agent routes + session routes pass `environment`

**Files:**
- Modify: `control-plane/src/agents-api.ts` (POST /v1/agents ~line 146; POST /v1/agents/:id/versions ~line 394; POST /v1/sessions ~line 416; POST /v1/sessions/:id/messages ~line 450; Orchestrator interface: `environment` becomes required)
- Test: `control-plane/test/agents-api.test.ts` (fakes + every agent-creating test payload + new tests)

**Interfaces:**
- Consumes: `repo.getEnvironment(id)` (Task 2); optional `environment` on startSession (Task 5).
- Produces: `startSession` param `environment: { id: string; pod?: PodConfig | null }` (REQUIRED); agent create/edit APIs require an existing `environmentId`.

- [ ] **Step 1: Write the failing tests** (append)

```ts
test("agent create without environment → 400; unknown environment → 400", async () => {
  const { app } = await build();
  const missing = await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "x", model: "m" } });
  assert.equal(missing.statusCode, 400);
  const unknown = await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "x", model: "m", environmentId: "env_nope" } });
  assert.equal(unknown.statusCode, 400);
});

test("agent version without environment → 400", async () => {
  const { app } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "x", model: "m", environmentId: "env_0" } })).json();
  const res = await app.inject({ method: "POST", url: `/v1/agents/${a.id}/versions`, payload: { model: "m" } });
  assert.equal(res.statusCode, 400);
});

test("session start passes the resolved environment to the orchestrator", async () => {
  const { app, startSpecs } = await build();
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "x", model: "m", environmentId: "env_0" } })).json();
  const s = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "p" } });
  assert.equal(s.statusCode, 201);
  assert.deepEqual(startSpecs[0].environment, { id: "env_0", pod: {} });
});

```

For the fourth test (a hand-edited/legacy version with no environment), give the fake repo a switch: in `fakes()` add `envForVersion: true as boolean,` next to `agentStatuses`, and in the fake `getAgentVersion`/`getAgentWithVersions`/`createSession` include `environment_id: (this as any).envForVersion ? (a.environmentId ?? null) : null`. Then:

```ts
test("session start when the agent version has no environment → 400", async () => {
  const f = fakes();
  (f.repo as any).envForVersion = false;
  const { app } = await build(f);
  const a = (await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "x", model: "m", environmentId: "env_0" } })).json();
  const res = await app.inject({ method: "POST", url: "/v1/sessions", payload: { agent: a.id, prompt: "p" } });
  assert.equal(res.statusCode, 400);
});
```

- [ ] **Step 2: Update the fakes so the suite can pass**

In `fakes()`:
- `getAgentVersion`: add `environment_id: (this as any).envForVersion ? (a.environmentId ?? null) : null` to the returned object (and the same field inside `getAgentWithVersions`'s `versions[0]` and `createSession`'s `config`).
- Add: `async getEnvironment(id: string) { return id === "env_0" ? { id, name: "e", allowed_hosts: [], allow_package_managers: false, pod: {} } : null; },`
- `startTurn`'s returned `config` gains `environment_id: "env_0"`.

Then add `environmentId: "env_0"` to EVERY `POST /v1/agents` payload in the whole test file (`grep -n '"/v1/agents"' test/*.test.ts` — also check `test/server.test.ts` if it creates agents).

- [ ] **Step 3: Run to verify the new tests fail (routes not implemented)**

Run: `cd control-plane && npm test`
Expected: the four new tests FAIL (201/`environment` undefined); pre-existing tests still pass.

- [ ] **Step 4: Implement the route changes**

POST /v1/agents:

```ts
  app.post("/v1/agents", async (req, reply) => {
    const b = req.body as { name: string } & AgentConfig;
    if (!b?.name || !b?.model) return reply.code(400).send({ error: "name and model required" });
    if (!b.environmentId) return reply.code(400).send({ error: "environmentId required" });
    if (!(await repo.getEnvironment(b.environmentId))) return reply.code(400).send({ error: "unknown environment" });
    const agent = await repo.createAgent(ws(req), b.name, b);
    return reply.code(201).send(agent);
  });
```

POST /v1/agents/:id/versions — add the same two guards before `repo.newAgentVersion`.

POST /v1/sessions — after the disabled-agent check (line ~420), resolve the environment BEFORE creating the session:

```ts
    const v = await repo.getAgentVersion(b.agent);
    const environment = v?.environment_id ? await repo.getEnvironment(v.environment_id) : null;
    if (!environment) return reply.code(400).send({ error: "agent has no environment; edit the agent and assign one" });
```

and extend the startSession call: `await orchestrator.startSession({ ..., environment: { id: environment.id, pod: environment.pod ?? {} } });`

POST /v1/sessions/:id/messages — after the disabled-agent check:

```ts
    let environment: any = null;
    if (session) {
      const v = await repo.getAgentVersion(session.agent_id, session.agent_version);
      environment = v?.environment_id ? await repo.getEnvironment(v.environment_id) : null;
      if (!environment) return reply.code(400).send({ error: "agent has no environment; edit the agent and assign one" });
    }
```

(the `!session` path already 409s at `startTurn`), and extend its startSession call the same way.

Finally, in the `Orchestrator` interface make the field required: `environment: { id: string; pod?: import("./pod-config.ts").PodConfig | null };` and in `buildTurnJob` the `?? (session.config as any).environment_id ?? "env_none"` fallback can now be simplified to `session.environment.id` — do that in Task 7 with the rest of env_none.

- [ ] **Step 5: Run tests**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/test/agents-api.test.ts control-plane/test/server.test.ts
git commit -m "feat(cp): environments mandatory for agents; session turns resolve + pass the env to the orchestrator"
```

---

### Task 7: Remove `env_none`

**Files:**
- Modify: `control-plane/src/main.ts` (~lines 60–65)
- Modify: `control-plane/src/agents-api.ts` (DELETE /v1/environments guard ~line 180)
- Modify: `control-plane/src/orchestrator.ts` (buildTurnJob envId fallback)

- [ ] **Step 1: Delete the boot provisioning** in `main.ts` — remove:

```ts
// Built-in deny-all egress for sessions without an environment (spec
// 2026-07-10): same mechanics as a real environment, empty allowlist.
orchestrator
  .ensureEnvironmentPolicy({ id: "env_none", allowedHosts: [], allowPackageManagers: false })
  .catch((err) => console.warn("env_none egress provisioning failed:", err));
```

- [ ] **Step 2: Delete the DELETE-route guard** in `agents-api.ts` — remove the two lines:

```ts
    // env_none is the built-in deny-all egress for no-environment sessions —
    // not a DB row, and deleting its k8s resources would silently un-lock them.
    if (id === "env_none") return reply.code(404).send({ error: "environment not found" });
```

- [ ] **Step 3: Tighten `buildTurnJob`** — replace

```ts
  const envId = session.environment?.id ?? (session.config as any).environment_id ?? "env_none";
```

with

```ts
  const envId = session.environment.id;
```

and delete the two "No environment ⇒ built-in deny-all egress" label comments that remain in the file.

- [ ] **Step 4: Verify no live references remain**

Run: `grep -rn "env_none" control-plane/src control-plane/test console session-runner`
Expected: no hits (docs/ hits are fine). Then `cd control-plane && npm test && npx tsc --noEmit` — PASS.

One-time cluster cleanup (dev): `kubectl -n devproof-agents delete deploy/egress-env-none svc/egress-env-none cm/egress-env-none netpol/env-env-none --ignore-not-found`

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/main.ts control-plane/src/agents-api.ts control-plane/src/orchestrator.ts
git commit -m "feat(cp): drop the synthetic env_none — environments are mandatory"
```

---

### Task 8: Runner `dev24` — conditional `/work` checkpointing

**Files:**
- Modify: `session-runner/runner.py` (lines 27, 91–108)

**Interfaces:**
- Consumes: container env `DEVPROOF_CHECKPOINT_WORK` ("0" excludes /work; default "1").
- Produces: image `devproof/session-runner:dev24`.

- [ ] **Step 1: Implement the flag** — replace line 27:

```python
CHECKPOINT_PATHS = [os.path.expanduser("<cli-state-dir>"), os.path.expanduser("<cli-config-file>"), "/work"]  # historical: the legacy CLI runtime's state dir + config file
```

with:

```python
# pvc + persistWork=false ⇒ /work is per-turn scratch, excluded from the checkpoint.
CHECKPOINT_WORK = os.environ.get("DEVPROOF_CHECKPOINT_WORK", "1") != "0"
CHECKPOINT_PATHS = [os.path.expanduser("<cli-state-dir>"), os.path.expanduser("<cli-config-file>")] + (["/work"] if CHECKPOINT_WORK else [])
```

- [ ] **Step 2: Make the prompt's /work line conditional** — rename `PLATFORM_PROMPT_20260711` → `PLATFORM_PROMPT_20260712` (both the constant and its use in `system_prompt()`), extend the comment above it with `rev 2026-07-12: /work persistence line is conditional`, and replace the hard-coded line

```
- /work is your scratch workspace for ephemeral experiments; it persists across turns of THIS session, but not beyond it.
```

with `{_WORK_LINE}` inside the f-string, defining just above the prompt:

```python
_WORK_LINE = (
    "- /work is your scratch workspace for ephemeral experiments; it persists across turns of THIS session, but not beyond it."
    if CHECKPOINT_WORK else
    f"- /work is per-turn scratch on a dedicated disk: it does NOT survive past this turn — anything worth keeping must go to {OUTPUTS_DIR} or the memory store."
)
```

- [ ] **Step 3: Sanity-check + build**

Run: `python -c "import ast; ast.parse(open('session-runner/runner.py').read())"` — no output.
Run: `docker build -t devproof/session-runner:dev24 session-runner`
Expected: build succeeds (identity patch step passes).

- [ ] **Step 4: Commit**

```bash
git add session-runner/runner.py
git commit -m "feat(runner): DEVPROOF_CHECKPOINT_WORK excludes /work from checkpoints (dev24)"
```

---

### Task 9: Console — `apiGet` + environment modal (resources, placement, disk)

**Files:**
- Modify: `console/app/lib/client.ts`
- Modify: `console/app/environments/create.tsx`

**Interfaces:**
- Consumes: `GET /v1/storage-classes` (Task 4); `pod` on environment create/patch (Task 3).
- Produces: `apiGet<T>(path: string): Promise<T>` in `client.ts`.

- [ ] **Step 1: Add `apiGet`** to `client.ts`:

```ts
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: wsHeader() });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Rework `EnvironmentModal`** in `create.tsx`. Keep `CreateEnvironment`/`EditEnvironmentName` exports, `HOSTS_HINT`, `parseHosts`, and the Name/Allowed hosts/Packages fields unchanged. Modal width `"md"` → `"lg"`. New imports: `useEffect` from react, `apiGet` from `../lib/client`. Complete new state/submit/JSX:

```tsx
const QUANTITY = /^[0-9]+(\.[0-9]+)?(m|k|M|G|T|P|Ki|Mi|Gi|Ti|Pi)?$/;
interface TolDraft { key: string; operator: string; value: string; effect: string }
```

State (replacing the current `useState`):

```tsx
  const initialPod = env?.pod ?? {};
  const [form, setForm] = useState({
    name: env?.name ?? "",
    hosts: (env?.allowed_hosts ?? []).join(", "),
    pkg: env?.allow_package_managers ?? false,
    reqCpu: initialPod.requests?.cpu ?? "", reqMem: initialPod.requests?.memory ?? "",
    limCpu: initialPod.limits?.cpu ?? "", limMem: initialPod.limits?.memory ?? "",
    selector: Object.entries(initialPod.nodeSelector ?? {}).map(([k, v]) => ({ k, v: String(v) })),
    tolerations: ((initialPod.tolerations ?? []) as any[]).map((t) => ({
      key: t.key ?? "", operator: t.operator ?? "Equal", value: t.value ?? "", effect: t.effect ?? "",
    })) as TolDraft[],
    diskType: initialPod.disk?.type ?? "emptyDir",
    storageClass: initialPod.disk?.storageClass ?? "",
    sizeGb: String(initialPod.disk?.sizeGb ?? 64),
    persistWork: initialPod.disk?.persistWork ?? true,
  });
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const setRow = (i: number, k: "k" | "v", v: string) =>
    set("selector", form.selector.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const setTol = (i: number, k: keyof TolDraft, v: string) =>
    set("tolerations", form.tolerations.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  // Storage classes come from the cluster; loaded once per modal open.
  const [classes, setClasses] = useState<{ name: string; isDefault: boolean }[] | null>(null);
  useEffect(() => {
    apiGet<{ storageClasses: { name: string; isDefault: boolean }[] }>("/v1/storage-classes")
      .then((r) => setClasses(r.storageClasses))
      .catch(() => { setClasses([]); setError("failed to load storage classes from the cluster"); });
  }, []);
  useEffect(() => {
    if (form.diskType === "pvc" && !form.storageClass && classes?.length)
      set("storageClass", (classes.find((c) => c.isDefault) ?? classes[0]).name);
  }, [classes, form.diskType]);   // eslint-disable-line react-hooks/exhaustive-deps
```

Submit (replacing the current one):

```tsx
  const submit = async () => {
    for (const [label, v] of [["Requests CPU", form.reqCpu], ["Requests memory", form.reqMem],
                              ["Limits CPU", form.limCpu], ["Limits memory", form.limMem]] as const) {
      if (v.trim() && !QUANTITY.test(v.trim())) { setError(`${label}: not a Kubernetes quantity (e.g. 250m, 512Mi)`); return; }
    }
    if (form.diskType === "pvc" && (!form.storageClass || !(Number(form.sizeGb) >= 1))) {
      setError("PVC disk needs a storage class and a size of at least 1 GB"); return;
    }
    const pod: any = {};
    const req: any = {};
    if (form.reqCpu.trim()) req.cpu = form.reqCpu.trim();
    if (form.reqMem.trim()) req.memory = form.reqMem.trim();
    if (Object.keys(req).length) pod.requests = req;
    const lim: any = {};
    if (form.limCpu.trim()) lim.cpu = form.limCpu.trim();
    if (form.limMem.trim()) lim.memory = form.limMem.trim();
    if (Object.keys(lim).length) pod.limits = lim;
    const nodeSelector = Object.fromEntries(form.selector.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]));
    if (Object.keys(nodeSelector).length) pod.nodeSelector = nodeSelector;
    const tolerations = form.tolerations
      .filter((t) => t.key.trim() || t.operator === "Exists")
      .map((t) => ({
        ...(t.key.trim() ? { key: t.key.trim() } : {}),
        operator: t.operator,
        ...(t.operator === "Equal" && t.value ? { value: t.value } : {}),
        ...(t.effect ? { effect: t.effect } : {}),
      }));
    if (tolerations.length) pod.tolerations = tolerations;
    pod.disk = form.diskType === "pvc"
      ? { type: "pvc", storageClass: form.storageClass, sizeGb: Math.floor(Number(form.sizeGb)), persistWork: form.persistWork }
      : { type: "emptyDir" };
    const body = { name: form.name, allowPackageManagers: form.pkg, allowedHosts: parseHosts(form.hosts), pod };
    setBusy(true); setError(null);
    const err = env ? await submitJson("PATCH", `/v1/environments/${env.id}`, body)
                    : await submitJson("POST", "/v1/environments", body);
    setBusy(false);
    if (err) setError(err); else { onClose(); router.refresh(); }
  };
```

JSX — after the existing Packages field, add (mirrors `pools/pool-modal.tsx` rows exactly):

```tsx
      <Field label="Requests" hint="cpu / memory each session pod reserves; empty = platform default (250m / 512Mi)">
        <input style={{ width: 110, flex: "none" }} value={form.reqCpu} placeholder="250m"
               onChange={(e) => set("reqCpu", e.target.value)} />
        <input style={{ width: 110, flex: "none" }} value={form.reqMem} placeholder="512Mi"
               onChange={(e) => set("reqMem", e.target.value)} />
      </Field>
      <Field label="Limits" hint="hard caps; empty cpu = uncapped, empty memory = 1Gi">
        <input style={{ width: 110, flex: "none" }} value={form.limCpu} placeholder="none"
               onChange={(e) => set("limCpu", e.target.value)} />
        <input style={{ width: 110, flex: "none" }} value={form.limMem} placeholder="1Gi"
               onChange={(e) => set("limMem", e.target.value)} />
      </Field>
      <Field label="Node selector" stack
             hint="key=value node labels session pods must land on; no rows = any node">
        <div className="kvrows">
          {form.selector.map((r, i) => (
            <div className="kvrow" key={i}>
              <input value={r.k} onChange={(e) => setRow(i, "k", e.target.value)} placeholder="kubernetes.io/arch" />
              <span className="muted">=</span>
              <input value={r.v} onChange={(e) => setRow(i, "v", e.target.value)} placeholder="amd64" />
              <button className="iconbtn danger" title="Remove label" aria-label="Remove label"
                      onClick={() => set("selector", form.selector.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button className="ghost" onClick={() => set("selector", [...form.selector, { k: "", v: "" }])}>+ Add label</button></div>
        </div>
      </Field>
      <Field label="Tolerations" stack
             hint="let session pods run on tainted nodes — taint the nodes themselves with kubectl">
        <div className="kvrows">
          {form.tolerations.map((t, i) => (
            <div className="kvrow" key={i}>
              <input value={t.key} placeholder="nvidia.com/gpu"
                     onChange={(e) => setTol(i, "key", e.target.value)} />
              <select value={t.operator} onChange={(e) => setTol(i, "operator", e.target.value)}>
                <option value="Equal">Equal</option>
                <option value="Exists">Exists</option>
              </select>
              {t.operator === "Equal" && (
                <input value={t.value} placeholder="value" onChange={(e) => setTol(i, "value", e.target.value)} />
              )}
              <select value={t.effect} onChange={(e) => setTol(i, "effect", e.target.value)}>
                <option value="">any effect</option>
                <option value="NoSchedule">NoSchedule</option>
                <option value="PreferNoSchedule">PreferNoSchedule</option>
                <option value="NoExecute">NoExecute</option>
              </select>
              <button className="iconbtn danger" title="Remove toleration" aria-label="Remove toleration"
                      onClick={() => set("tolerations", form.tolerations.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button className="ghost" onClick={() =>
            set("tolerations", [...form.tolerations, { key: "", operator: "Equal", value: "", effect: "" }])}>+ Add toleration</button></div>
        </div>
      </Field>
      <Field label="Disk" hint="volume backing /work in session pods">
        <select style={{ flex: "none", width: 230 }} value={form.diskType} onChange={(e) => set("diskType", e.target.value)}>
          <option value="emptyDir">EmptyDir (node disk)</option>
          <option value="pvc">PVC (dedicated volume)</option>
        </select>
      </Field>
      {form.diskType === "pvc" && (<>
        <Field label="Storage class" required>
          <select value={form.storageClass} onChange={(e) => set("storageClass", e.target.value)}>
            {classes === null && <option value="">loading…</option>}
            {classes !== null && classes.length === 0 && <option value="">no storage classes found</option>}
            {(classes ?? []).map((c) => (
              <option key={c.name} value={c.name}>{c.name}{c.isDefault ? " (default)" : ""}</option>
            ))}
          </select>
        </Field>
        <Field label="Size (GB)" required>
          <input style={{ width: 90, flex: "none" }} value={form.sizeGb} onChange={(e) => set("sizeGb", e.target.value)} />
        </Field>
        <Field label="Persistence">
          <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={form.persistWork} onChange={(e) => set("persistWork", e.target.checked)} />
            Persist /work across turns (checkpointed — large content slows turn start/end)
          </label>
        </Field>
      </>)}
```

Note the tolerations rows in the pool modal render the value input unconditionally — check `pool-modal.tsx:88-104` and copy ITS exact row markup if it differs from the above; the two dialogs must match.

- [ ] **Step 3: Build**

Run: `cd console && npx next build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add console/app/lib/client.ts console/app/environments/create.tsx
git commit -m "feat(console): environment modal — pod resources, placement, /work disk (emptyDir|PVC)"
```

---

### Task 10: Console — mandatory environment in agent form + Disk column

**Files:**
- Modify: `console/app/agents/agent-form.tsx` (lines 39, 57, 85–90)
- Modify: `console/app/environments/page.tsx` (table + subtitle)

- [ ] **Step 1: Agent form** — three changes:
  - Line 39: `environmentId: f.environmentId || undefined,` → `environmentId: f.environmentId,`
  - Line 57 submit-disabled: `disabled={busy || (mode === "create" && !f.name) || !f.model || !f.environmentId}`
  - Environment field:

```tsx
      <Field label="Environment" required hint="egress, resources, and disk the sessions run under">
        <select value={f.environmentId} onChange={(e) => set("environmentId", e.target.value)}>
          <option value="" disabled>Select environment…</option>
          {environments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </Field>
```

- [ ] **Step 2: Environments page** — in `page.tsx`:
  - Subtitle → `Configuration templates for session containers: network policy, package managers, and pod resources/disk.`
  - Header row: add `<th>Disk</th>` after `<th>Package managers</th>`.
  - Body row, after the package-managers cell:

```tsx
              <td>{e.pod?.disk?.type === "pvc"
                ? <code>pvc · {e.pod.disk.sizeGb} GB · {e.pod.disk.storageClass}</code>
                : <code>emptyDir</code>}</td>
```

  - Empty-state `colSpan={6}` → `colSpan={7}`.

- [ ] **Step 3: Build**

Run: `cd console && npx next build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add console/app/agents/agent-form.tsx console/app/environments/page.tsx
git commit -m "feat(console): environment mandatory on agent form; Disk column on environments"
```

---

### Task 11: Docs + end-to-end verification

**Files:**
- Modify: `CLAUDE.md` (runner tag, env_none bullets, platform prompt name)
- Modify: `TODO.txt` (trim the shipped "Next" item)

- [ ] **Step 1: Update CLAUDE.md**
  - Runner image: `current dev23` → `current dev24` and append to its parenthetical: `; DEVPROOF_CHECKPOINT_WORK=0 (PVC disk with persistWork off) excludes /work from checkpoints`.
  - Egress bullet: replace the `env_none` sentence with: `Environments are MANDATORY (spec 2026-07-12): agent create/edit 400s without one; the synthetic env_none is gone. environments.pod (JSONB) carries session-pod requests/limits/nodeSelector/tolerations and the /work disk (emptyDir default, or ephemeral PVC via storage class + sizeGb + persistWork), applied per turn by buildTurnJob.`
  - Session view bullet: `PLATFORM_PROMPT_20260711` → `PLATFORM_PROMPT_20260712`.
  - Running section: update the CP command's `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev23` → `dev24`.

- [ ] **Step 2: Update TODO.txt** — replace the line
  `- session pod resources -> cpu, memory. disk (storage class read from k8s) node selector, taints (in environments page!). Session should show the pod name.`
  with `- Session should show the pod name.`

- [ ] **Step 3: Full verification (per CLAUDE.md "Verify before claiming done")**

1. `cd control-plane && npm test && npx tsc --noEmit` — all pass.
2. Restart CP with `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev24` (+ the usual S3 env; `npx tsx src/main.ts`), rebuild + restart console (`npx next build && npx next start -p 7090`). All pages 200.
3. Migration applied: `psql postgresql://devproof:devproof@localhost:15432/devproof -c "\d environments"` shows `pod jsonb not null default '{}'`.
4. Manually assign environments to any existing agents (user data fix — new versions via the console).
5. Console flow: create environment "pvc-test" with Disk = PVC, class `standard`, 64 GB, persist ON; verify the Disk column; create an agent WITHOUT selecting an environment → button disabled; select "pvc-test", create.
6. Start a session; while running: `kubectl -n devproof-agents get pvc` shows a `-work` claim; after the turn: claim gone.
7. Edit the environment: persist OFF; send a follow-up message; confirm the runner env has `DEVPROOF_CHECKPOINT_WORK=0` (`kubectl -n devproof-agents get pod -l devproof.ai/session=<id> -o yaml | grep -A1 CHECKPOINT_WORK`) and the next checkpoint tarball lacks `work/` (download via the session's checkpoint file id, `tar tzf`). Conversation state still resumes (follow-up references turn-1 context).
8. Legacy guard: an agent version with no environment (only if one still exists) → session start returns 400 with the assign-one message.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md TODO.txt
git commit -m "docs: session-pod-config shipped — envs mandatory, dev24 runner, pod config on environments"
```
