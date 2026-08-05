# Startup Dependency Wait Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The control plane waits patiently (Helm-configurable budget, default 300s) for Postgres on boot instead of crash-looping, and the existing S3 bucket wait honors the same budget.

**Architecture:** A new `waitForPostgres(pool, opts)` in `control-plane/src/db.ts` probes `SELECT 1`, retrying connection-class errors every 2s within a budget and failing fast on everything else. `main.ts` calls it before `migrate()` and derives one shared budget from `DEVPROOF_STARTUP_WAIT_SEC`, which the chart renders from `controlplane.startupWaitSeconds`. Spec: `docs/superpowers/specs/2026-08-05-startup-dependency-wait-design.md`.

**Tech Stack:** TypeScript (Node test runner via tsx), Helm.

## Global Constraints

- **No version bumps anywhere** (image tags, Chart.yaml, package.json — CI's job).
- Commit messages: no Claude/AI references, no Co-Authored-By trailer.
- Retryable `err.code` set, exactly: `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`, `ENOTFOUND`, `EAI_AGAIN`, `57P03`. Anything else (incl. `28P01`, `3D000`) rethrows immediately.
- Retry cadence 2s; budget default 300s; on exhaustion rethrow (crash) — never hang silently.
- Env contract: `DEVPROOF_STARTUP_WAIT_SEC` (integer seconds; unset/invalid ⇒ 300; `0` ⇒ fail immediately on first error). Helm value: `controlplane.startupWaitSeconds: 300`.
- **Test-infra precondition:** the full suite needs the dev Postgres on `localhost:15432`. The user's clusters are currently torn down — Task 0 provisions an ephemeral container and records a pre-change baseline. The new unit tests themselves need NO database.

---

### Task 0: Test-infra precondition + baseline

**Files:** none (environment only).

**Interfaces:**
- Produces: a Postgres reachable at `postgres://devproof:devproof-dev@127.0.0.1:15432/devproof` (matches `createPool()`'s default), and a recorded baseline of which suite tests pass/fail BEFORE any change.

- [ ] **Step 1: Check for an existing dev Postgres; provision one if absent**

```powershell
Test-NetConnection 127.0.0.1 -Port 15432 -InformationLevel Quiet
```
If `False`:
```powershell
docker run -d --name devproof-test-pg -p 15432:5432 -e POSTGRES_USER=devproof -e POSTGRES_PASSWORD=devproof-dev -e POSTGRES_DB=devproof postgres:17
```
Expected: container starts; re-run the port test until `True` (a few seconds).

- [ ] **Step 2: Record the pre-change baseline**

```powershell
Set-Location C:\Users\carst\Desktop\devproofai\control-plane
npm test 2>&1 | Tee-Object -FilePath $env:TEMP\suite-baseline.txt | Select-Object -Last 15
```
Some tests may fail on a bare Postgres without MinIO/kube — that is WHY the baseline exists. Note the pass/fail counts; later tasks must not regress them. Runtime ~2–3 min (`--test-concurrency=1` is deliberate — never remove it).

---

### Task 1: `waitForPostgres` (TDD)

**Files:**
- Create: `control-plane/test/startup-wait.test.ts`
- Modify: `control-plane/src/db.ts` (add export after `createPool`, before `migrate`)

**Interfaces:**
- Produces: `export async function waitForPostgres(pool: { query: (text: string) => Promise<unknown> }, opts?: { budgetMs?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<void>` — Task 2 imports it in `main.ts`. (Structural param on purpose: `pg.Pool` satisfies it, and stub pools in tests don't have to impersonate pg's overloaded `query` type, which would fail `tsc --noEmit`.)

- [ ] **Step 1: Write the failing tests** — full content of `control-plane/test/startup-wait.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForPostgres } from "../src/db.ts";

// Stub pool: fails with the given codes in order, then succeeds forever.
const stubPool = (codes: string[]) => {
  let calls = 0;
  return {
    calls: () => calls,
    query: async () => {
      calls++;
      const code = codes.shift();
      if (code) throw Object.assign(new Error(`stub ${code}`), { code });
      return { rows: [] };
    },
  };
};
const instant = { delayMs: 1, sleep: async () => {} };

test("retries ECONNREFUSED until postgres answers", async () => {
  const pool = stubPool(["ECONNREFUSED", "ECONNREFUSED", "ECONNREFUSED"]);
  await waitForPostgres(pool, { budgetMs: 10_000, ...instant });
  assert.equal(pool.calls(), 4, "three failures + one success");
});

test("57P03 (starting up) is retryable", async () => {
  const pool = stubPool(["57P03", "57P03"]);
  await waitForPostgres(pool, { budgetMs: 10_000, ...instant });
  assert.equal(pool.calls(), 3);
});

test("budget exhaustion rethrows the last error", async () => {
  const pool = stubPool(Array(1000).fill("ECONNREFUSED"));
  await assert.rejects(
    () => waitForPostgres(pool, { budgetMs: 25, delayMs: 10, sleep: async () => {} }),
    (err: any) => err.code === "ECONNREFUSED",
  );
  assert.ok(pool.calls() >= 2, "retried at least once before giving up");
  assert.ok(pool.calls() < 1000, "did not retry unbounded");
});

test("non-retryable code fails immediately (bad password)", async () => {
  const pool = stubPool(["28P01"]);
  await assert.rejects(
    () => waitForPostgres(pool, { budgetMs: 10_000, ...instant }),
    (err: any) => err.code === "28P01",
  );
  assert.equal(pool.calls(), 1, "no retry on misconfiguration");
});

test("zero budget fails on the first retryable error", async () => {
  const pool = stubPool(["ECONNREFUSED"]);
  await assert.rejects(
    () => waitForPostgres(pool, { budgetMs: 0, ...instant }),
    (err: any) => err.code === "ECONNREFUSED",
  );
  assert.equal(pool.calls(), 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd C:\Users\carst\Desktop\devproofai\control-plane; npx tsx --test test/startup-wait.test.ts`
Expected: FAIL — `waitForPostgres` is not exported (SyntaxError/undefined import).

- [ ] **Step 3: Implement** — insert into `control-plane/src/db.ts` between `createPool` and `migrate`:

```ts
// Startup-dependency wait (spec 2026-08-05): on cluster cold start the CP races
// Postgres (PVC provisioning, image pull, init). Retry connection-class errors
// within a budget instead of crash-looping; anything else — bad credentials,
// missing database — fails immediately so misconfiguration surfaces at once.
// Node socket errors and Postgres SQLSTATEs both arrive on err.code.
const RETRYABLE_STARTUP_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "ENOTFOUND", "EAI_AGAIN", // service DNS may not be registered yet
  "57P03", // "the database system is starting up"
]);

export async function waitForPostgres(
  pool: { query: (text: string) => Promise<unknown> },
  opts: { budgetMs?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const budgetMs = opts.budgetMs ?? 300_000;
  const delayMs = opts.delayMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("SELECT 1");
      if (attempt > 1) console.log(`postgres ready (attempt ${attempt})`);
      return;
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "";
      if (!RETRYABLE_STARTUP_CODES.has(code) || Date.now() + delayMs > deadline) throw err;
      console.log(`postgres not ready (${code}), retrying in ${delayMs / 1000}s…`);
      await sleep(delayMs);
    }
  }
}
```

Note: `pool.query` in the success path returns rows we ignore; the structural param type lets `pg.Pool` and the test stubs both satisfy it without casts.

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test test/startup-wait.test.ts`
Expected: 5 passing, 0 failing.

- [ ] **Step 5: Typecheck + commit**

```powershell
npx tsc --noEmit
git add test/startup-wait.test.ts src/db.ts
git commit -m "feat(cp): patient postgres wait on boot (waitForPostgres, budgeted retry)"
```

---

### Task 2: Wire into main.ts + shared S3 budget

**Files:**
- Modify: `control-plane/src/main.ts` (import at line 4 area; boot at lines 38–39; S3 loop at lines 203–220)

**Interfaces:**
- Consumes: `waitForPostgres` from Task 1.
- Produces: env contract `DEVPROOF_STARTUP_WAIT_SEC` (read once at boot), used by both the Postgres wait and the S3 CreateBucket loop. Task 3 renders it from Helm.

- [ ] **Step 1: Import** — extend the existing db.ts import (line 4):

```ts
import { createPool, migrate, NotifyHub, waitForPostgres } from "./db.ts";
```

- [ ] **Step 2: Boot wiring** — replace (main.ts:38–39):

```ts
const pool = createPool();
await migrate(pool);
```

with:

```ts
// Startup-dependency wait (spec 2026-08-05): one shared budget for boot-time
// dependencies. Unset/invalid ⇒ 300s; rendered by the chart from
// controlplane.startupWaitSeconds.
const startupWaitSec = (() => {
  const n = Number(process.env.DEVPROOF_STARTUP_WAIT_SEC);
  return Number.isFinite(n) && n >= 0 ? n : 300;
})();
const pool = createPool();
await waitForPostgres(pool, { budgetMs: startupWaitSec * 1000 });
await migrate(pool);
```

- [ ] **Step 3: S3 loop on the same budget** — in the CreateBucket loop (main.ts ~203–220), replace the comment's "Retry with backoff" paragraph tail and the attempt cap. The existing comment lines

```ts
  // Ensure the bucket exists before serving. Retry with backoff: on a fresh
  // install the CP races the bundled MinIO's first boot (PVC provisioning),
  // and external S3 can blip too. Only "already exists" is success; anything
  // else after the deadline crashes the boot so k8s restarts the pod — a
  // silently missing bucket fails every file op later ("The specified bucket
  // does not exist").
  for (let attempt = 1; ; attempt++) {
```

become:

```ts
  // Ensure the bucket exists before serving. Retry on the shared startup
  // budget (DEVPROOF_STARTUP_WAIT_SEC, spec 2026-08-05): on a fresh install
  // the CP races the bundled MinIO's first boot (PVC provisioning), and
  // external S3 can blip too. Only "already exists" is success; anything
  // else after the deadline crashes the boot so k8s restarts the pod — a
  // silently missing bucket fails every file op later ("The specified bucket
  // does not exist").
  const s3Deadline = Date.now() + startupWaitSec * 1000;
  for (let attempt = 1; ; attempt++) {
```

and inside the catch, replace

```ts
      if (attempt >= 30) throw e;
      console.log(`bucket ${bucket} not ready (${name || e}), retry ${attempt}/30`);
```

with

```ts
      if (Date.now() + 2000 > s3Deadline) throw e;
      console.log(`bucket ${bucket} not ready (${name || e}), retry ${attempt} (budget ${startupWaitSec}s)`);
```

- [ ] **Step 4: Typecheck + full suite vs baseline**

```powershell
npx tsc --noEmit
npm test
```
Expected: tsc clean; suite results match Task 0's baseline (same pass/fail sets — the boot path additions must not change any test outcome, since tests import `migrate` directly, not the main.ts boot).

- [ ] **Step 5: Live negative check (budget + crash observable)**

```powershell
Set-Location C:\Users\carst\Desktop\devproofai\control-plane
$env:DEVPROOF_STARTUP_WAIT_SEC = "6"
$env:DEVPROOF_DATABASE_URL = "postgres://x:x@127.0.0.1:9/none"
npx tsx src/main.ts
```
Expected: ~3 lines `postgres not ready (ECONNREFUSED), retrying in 2s…`, then the pg error is thrown and the process exits non-zero within ~7s. Afterwards clear both env vars (`Remove-Item Env:DEVPROOF_STARTUP_WAIT_SEC, Env:DEVPROOF_DATABASE_URL`).

- [ ] **Step 6: Live positive check (no added latency when DB is up)**

With the Task 0 Postgres running and env vars cleared, start the CP (`npx tsx src/main.ts`) and confirm the boot log shows NO "postgres not ready" lines and the server reaches its listen line, then Ctrl-C/kill it. (S3 not configured out-of-cluster without envs ⇒ the local file-store path is used; that's fine for this check.)

- [ ] **Step 7: Commit**

```powershell
git add src/main.ts
git commit -m "feat(cp): shared DEVPROOF_STARTUP_WAIT_SEC budget for postgres and s3 boot waits"
```

---

### Task 3: Helm value + env rendering

**Files:**
- Modify: `helm-charts/values.yaml` (controlplane section, after the `seedDefaults` block at ~line 222)
- Modify: `helm-charts/templates/controlplane/deployment.yaml` (env block, after the `HOST` entry)

**Interfaces:**
- Consumes: the `DEVPROOF_STARTUP_WAIT_SEC` contract from Task 2.

- [ ] **Step 1: values.yaml** — insert after the `seedDefaults: true` line:

```yaml
  # Boot-dependency wait budget in seconds: how long the control plane retries
  # unreachable Postgres/S3 at startup before crashing (a cold cluster races
  # PVC provisioning and image pulls). 0 = fail fast on the first error.
  startupWaitSeconds: 300
```

- [ ] **Step 2: deployment.yaml** — insert directly after `- { name: HOST, value: "0.0.0.0" }`:

```yaml
            - { name: DEVPROOF_STARTUP_WAIT_SEC, value: {{ .Values.controlplane.startupWaitSeconds | default 300 | quote }} }
```

- [ ] **Step 3: Render check**

```powershell
Set-Location C:\Users\carst\Desktop\devproofai
helm template devproof helm-charts --skip-schema-validation | Select-String "DEVPROOF_STARTUP_WAIT_SEC" -Context 0,0
```
Expected: one line, `value: "300"`. Also `helm template devproof helm-charts --skip-schema-validation --set controlplane.startupWaitSeconds=42 | Select-String STARTUP_WAIT` shows `"42"`.

- [ ] **Step 4: Commit**

```powershell
git add helm-charts/values.yaml helm-charts/templates/controlplane/deployment.yaml
git commit -m "feat(chart): controlplane.startupWaitSeconds renders DEVPROOF_STARTUP_WAIT_SEC"
```

---

### Task 4: In-cluster cold-start gate

**Files:** none (verification; fix commits only if a defect is found).

**Interfaces:**
- Consumes: everything above. Requires Docker + kind on this machine (present).

- [ ] **Step 1: Build the CP image on its EXISTING tag** (never bump — CI's job). The bake target is `control-plane` (docker-bake.hcl:41). Current released tag is 0.1.9 (from the user's crash log):

```powershell
Set-Location C:\Users\carst\Desktop\devproofai
$env:VERSION = "0.1.9"; docker buildx bake control-plane
```
Expected: builds `ghcr.io/devproof/devproofai-control-plane:0.1.9` locally. If the bake output names a different tag pattern, read BUILD.md and adjust — but never a NEW version.

- [ ] **Step 2: Create a test cluster and preload the image** (the empty `kind` cluster from earlier can be reused or deleted first — check `kind get clusters`):

```powershell
kind create cluster --name devproof-wait-test
kind load docker-image ghcr.io/devproof/devproofai-control-plane:0.1.9 --name devproof-wait-test
```
(`imagePullPolicy` is rendered from values; the preloaded image satisfies IfNotPresent so the local build wins over GHCR.)

- [ ] **Step 3: Cold-start install and WATCH the race**

```powershell
helm install devproof helm-charts -n default --skip-schema-validation
kubectl get pods -w
```
Expected: while postgres is `ContainerCreating`, the controlplane pod goes `Running` (not Error), its log shows `postgres not ready (ECONNREFUSED), retrying in 2s…` lines (`kubectl logs deploy/controlplane -f`), **0 restarts**, and it becomes Ready shortly after postgres does. This is the acceptance criterion from the spec: no Error states, no restart count, clean convergence.

- [ ] **Step 4: Tear down**

```powershell
helm uninstall devproof; kind delete cluster --name devproof-wait-test
```

- [ ] **Step 5: If any defect surfaced, fix + re-run the affected checks, commit as** `fix(cp): <what>` — otherwise nothing to commit in this task.
