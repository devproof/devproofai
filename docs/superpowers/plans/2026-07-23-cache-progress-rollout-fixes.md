# Cache Download Progress + Rollout Badges + Rollout-Safe Sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec `docs/superpowers/specs/2026-07-23-cache-download-progress-design.md` — /cache shows `Downloading N%` live, /deployments stops showing phantom "Scaling up" on rollouts, and running sessions survive model rollouts instead of failing.

**Architecture:** (1) CP overrides the Model CR's premature `Ready` from live pod init-state + exec-based byte count; console polls while downloading. (2) Operator carries `settledReplicas` in MD status; activity compares desired vs last-settled. (3) Gateway hook 503s (never 400s) known local models missing from a replica's loaded config; runner client honors `Retry-After` with a patient time-bounded retry.

**Tech Stack:** Node/TS (Fastify, `@kubernetes/client-node` v1.3, node:test), Next.js client components, Go (controller-runtime, controller-gen v0.21.0 at `~/go/bin/controller-gen.exe`), LiteLLM hook (Python, rendered ConfigMap), Python runner (httpx, unittest).

## Global Constraints

- **Never bump release versions.** In-cluster CP/operator changes rebuild the SAME tag `0.1.6` (check the live deployment's image tag first — use whatever it currently runs) and ctr-import to ALL 8 nodes (`desktop-control-plane` + `desktop-worker`..`worker7`), then rollout-restart and VERIFY the pod's `imageID` matches the fresh build's config digest.
- **Runner image gets a NEW dev tag: `dev52`** (`ghcr.io/devproof/devproofai-session-runner:dev52`, built from repo root). Never pushed to GHCR; ctr-imported per node.
- ZERO third-party AI references in `session-runner/` sources.
- Go binary: `~/sdk/go/bin/go`. CP tests: `cd control-plane && npm test` (sequential on purpose) + `npx tsc --noEmit`. Runner tests: `cd session-runner && python -m unittest discover -s tests -p "test_*.py"`.
- Console is ALWAYS a production build: `cd console && npx next build && npx next start -p 7090` (check what owns :7090 before concluding a build is stale — see memory `console-rebuild-restart-german-netstat`).
- The cluster is Docker Desktop kind, 8 nodes, platform in namespace `default`. ctr-import procedure: `kubectl debug node/<n> --profile=sysadmin --image=busybox -- sleep 1800`, then `kubectl exec -i <debugger> -- chroot /host ctr -n k8s.io images import - < image.tar` (Git Bash: `export MSYS_NO_PATHCONV=1`). Delete debugger pods afterwards.
- Commit after each task; message style `fix:`/`feat:` matching recent history; plain messages with no authorship footers (per-run instruction: the branch squashes to one clean commit).

---

### Task 1: `cacheRows` pure helper (CP)

**Files:**
- Create: `control-plane/src/cache-rows.ts`
- Test: `control-plane/test/cache-rows.test.ts`

**Interfaces:**
- Produces: `cacheRows(models: any[], pods: any[]): { rows: CacheRow[]; downloading: DownloadTarget[] }` where `CacheRow = { name, source, size, phase, created, progress: number|null }` and `DownloadTarget = { name, pod, total }`; `progressPct(bytes: number, total: number): number | null`. Task 2 wires these into `/v1/cache`.

- [ ] **Step 1: Write the failing test**

```ts
// control-plane/test/cache-rows.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheRows, progressPct } from "../src/cache-rows.ts";

const model = (name: string, phase = "Ready", total?: number) => ({
  metadata: { name, creationTimestamp: "2026-07-23T00:00:00Z" },
  spec: { source: `https://hf.co/${name}.gguf` },
  status: { phase, size: "6.6 GiB", ...(total ? { sourceContentLength: total } : {}) },
});
const pod = (label: string, initState: object | null, phase = "Pending") => ({
  metadata: { name: `${label}-pod-1`, labels: { "inference.llmkube.dev/model": label } },
  status: {
    phase,
    initContainerStatuses: initState ? [{ name: "model-downloader", state: initState }] : [],
  },
});

test("model with a running downloader overrides phase to Downloading", () => {
  const { rows, downloading } = cacheRows(
    [model("gemma", "Ready", 1000)],
    [pod("gemma", { running: { startedAt: "x" } })],  // mid-init pods are phase Pending
  );
  assert.equal(rows[0].phase, "Downloading");
  assert.equal(rows[0].progress, null); // exec fills it later
  assert.deepEqual(downloading, [{ name: "gemma", pod: "gemma-pod-1", total: 1000 }]);
});

test("no pod / terminated downloader passes the CR phase through", () => {
  const { rows: noPod } = cacheRows([model("a")], []);
  assert.equal(noPod[0].phase, "Ready");
  const { rows: done, downloading } = cacheRows(
    [model("b")], [pod("b", { terminated: { exitCode: 0 } }, "Running")]);
  assert.equal(done[0].phase, "Ready");
  assert.equal(downloading.length, 0);
});

test("Failed and Succeeded pods are ignored (exec into them 500s)", () => {
  const { downloading } = cacheRows(
    [model("c", "Ready", 5)],
    [pod("c", { running: {} }, "Failed"), pod("c", { running: {} }, "Succeeded")]);
  assert.equal(downloading.length, 0);
});

test("missing sourceContentLength -> Downloading but not an exec target", () => {
  const { rows, downloading } = cacheRows(
    [model("d", "Ready")], [pod("d", { running: {} })]);
  assert.equal(rows[0].phase, "Downloading");
  assert.equal(downloading.length, 0);
});

test("row shape keeps the existing /v1/cache fields", () => {
  const { rows } = cacheRows([model("e")], []);
  assert.deepEqual(Object.keys(rows[0]).sort(),
    ["created", "name", "phase", "progress", "size", "source"]);
});

test("progressPct math", () => {
  assert.equal(progressPct(500, 1000), 50);
  assert.equal(progressPct(2000, 1000), 100); // clamp
  assert.equal(progressPct(0, 1000), 0);
  assert.equal(progressPct(500, 0), null);    // unknown total degrades
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && node --test --test-concurrency=1 test/cache-rows.test.ts`
Expected: FAIL — cannot find module `../src/cache-rows.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// control-plane/src/cache-rows.ts
// Pure row-building for /v1/cache (spec 2026-07-23 issue 1): the LLMkube
// Model CR reports Ready as soon as the SOURCE resolves — the actual download
// runs in the engine pod's model-downloader init container. A model whose pod
// has that init container RUNNING is Downloading, whatever the CR says.
export interface CacheRow {
  name: string; source?: string; size: string | null; phase: string;
  created?: string; progress: number | null;
}
export interface DownloadTarget { name: string; pod: string; total: number }

export function cacheRows(models: any[], pods: any[]): { rows: CacheRow[]; downloading: DownloadTarget[] } {
  // Mid-init pods are phase Pending; only Failed/Succeeded are dead ends
  // (exec into a completed pod is a websocket 500 — spike 2026-07-23).
  const downloaderPod = new Map<string, any>();
  for (const p of pods) {
    const name = p.metadata?.labels?.["inference.llmkube.dev/model"];
    if (!name || p.status?.phase === "Failed" || p.status?.phase === "Succeeded") continue;
    const dl = (p.status?.initContainerStatuses ?? []).find((c: any) => c.name === "model-downloader");
    if (dl?.state?.running) downloaderPod.set(name, p);
  }
  const rows: CacheRow[] = [];
  const downloading: DownloadTarget[] = [];
  for (const m of models) {
    const name = m.metadata?.name;
    const p = downloaderPod.get(name);
    rows.push({
      name,
      source: m.spec?.source,
      size: m.status?.size ?? null,
      phase: p ? "Downloading" : (m.status?.phase ?? "Unknown"),
      created: m.metadata?.creationTimestamp,
      progress: null,
    });
    const total = Number(m.status?.sourceContentLength ?? 0);
    if (p && total > 0) downloading.push({ name, pod: p.metadata.name, total });
  }
  return { rows, downloading };
}

/** 0-100 (clamped) or null when the total is unknown — degrade, never error. */
export const progressPct = (bytes: number, total: number): number | null =>
  total > 0 && Number.isFinite(bytes) && bytes >= 0
    ? Math.min(100, Math.floor((bytes / total) * 100))
    : null;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd control-plane && node --test --test-concurrency=1 test/cache-rows.test.ts`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/cache-rows.ts control-plane/test/cache-rows.test.ts
git commit -m "feat: pure cacheRows helper — Downloading phase override for /v1/cache"
```

---

### Task 2: kubestore pod list + exec, `/v1/cache` wiring, RBAC

**Files:**
- Modify: `control-plane/src/kubestore.ts` (interface near line 17-31, impl inside `realKubeStore()` near line 64)
- Modify: `control-plane/src/server.ts:260-272` (the `/v1/cache` GET)
- Modify: `helm-charts/templates/controlplane/rbac.yaml:9-11`
- Grep first: `grep -rn "listCachedModels" control-plane/src control-plane/test` — every other `KubeStore` implementer (test fakes) needs the two new methods stubbed (`listServingPods: async () => []`, `execInPod: async () => ""`).

**Interfaces:**
- Consumes: `cacheRows`/`progressPct` from Task 1.
- Produces: `KubeStore.listServingPods(labelSelector: string): Promise<any[]>` and `KubeStore.execInPod(pod: string, container: string, command: string[]): Promise<string>` (stdout). `/v1/cache` rows gain `progress: number|null` — Task 3 consumes that field.

- [ ] **Step 1: Add the two methods to the `KubeStore` interface**

```ts
  /** Pods in the serving namespace matching a label selector. */
  listServingPods(labelSelector: string): Promise<any[]>;
  /** One-shot exec in a pod container; returns captured stdout.
   *  Only call on pods that are NOT Failed/Succeeded (websocket 500). */
  execInPod(pod: string, container: string, command: string[]): Promise<string>;
```

- [ ] **Step 2: Implement in `realKubeStore()`** (the `kc`, `core` consts are already in scope; add `import { Writable } from "node:stream";` at the top)

```ts
    async listServingPods(labelSelector) {
      const res: any = await core.listNamespacedPod({ namespace: SERVING_NAMESPACE, labelSelector });
      return res.items ?? [];
    },
    async execInPod(pod, container, command) {
      let out = "";
      const sink = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
      const exec = new k8s.Exec(kc);
      await new Promise<void>((resolve, reject) => {
        exec.exec(SERVING_NAMESPACE, pod, container, command, sink, sink, null, false,
          (status) => (status?.status === "Success"
            ? resolve()
            : reject(new Error(status?.message ?? "exec failed"))),
        ).catch(reject);
      });
      return out;
    },
```

- [ ] **Step 3: Rewire `/v1/cache`** (replace the current body at `server.ts:260-272`; add `import { cacheRows, progressPct } from "./cache-rows.ts";` matching the file's existing import style)

```ts
  app.get("/v1/cache", async (req, reply) => {
    if (localGate(reply)) return reply;
    const [models, pods] = await Promise.all([
      store.listCachedModels(),
      store.listServingPods("inference.llmkube.dev/model").catch(() => []),
    ]);
    const { rows: all, downloading } = cacheRows(models, pods);
    // Percentage via one-shot exec, downloading models only (typically 0-1).
    // Any failure degrades to Downloading-without-number, never an error.
    await Promise.all(downloading.map(async (d) => {
      try {
        const out = await store.execInPod(d.pod, "model-downloader",
          ["sh", "-c", 'wc -c < "$MODEL_PATH"']);
        const row = all.find((r) => r.name === d.name);
        if (row) row.progress = progressPct(Number(out.trim()), d.total);
      } catch { /* degrade */ }
    }));
    const { rows, count, offset } = paged(all, req);
    return { cache: rows, count, offset };
  });
```

- [ ] **Step 4: RBAC** — in `helm-charts/templates/controlplane/rbac.yaml`, extend the first core-group rule (line 9-11) to:

```yaml
  - apiGroups: [""]
    resources: [configmaps, secrets, services]
    verbs: [get, list, create, update, patch, delete]
  - apiGroups: [""]
    resources: [pods]
    verbs: [get, list]
  - apiGroups: [""]
    resources: [pods/exec]
    verbs: [create]
```

- [ ] **Step 5: Typecheck + full CP suite**

Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: clean typecheck; suite green (fakes updated per the grep above).

- [ ] **Step 6: Apply RBAC to the live cluster** (helm template drift is fine — the chart file is the durable artifact):

```bash
kubectl patch role -n default $(kubectl get role -n default -o name | grep -i controlplane | head -1 | sed 's|.*/||') --type json -p '[{"op":"add","path":"/rules/-","value":{"apiGroups":[""],"resources":["pods"],"verbs":["get","list"]}},{"op":"add","path":"/rules/-","value":{"apiGroups":[""],"resources":["pods/exec"],"verbs":["create"]}}]'
```

- [ ] **Step 7: Roll the CP image (same tag) and verify live**

```bash
TAG=$(kubectl get deploy -n default -o jsonpath='{range .items[*]}{.spec.template.spec.containers[0].image}{"\n"}{end}' | grep control-plane | sed 's/.*://')
VERSION=$TAG REGISTRY=ghcr.io/devproof docker buildx bake control-plane
docker save ghcr.io/devproof/devproofai-control-plane:$TAG -o cp.tar
# import to all 8 nodes via node-debugger pods (Global Constraints), then:
kubectl rollout restart deploy -n default $(kubectl get deploy -n default -o name | grep controlplane | sed 's|.*/||')
# verify imageID == fresh build config digest, then:
curl -s http://localhost:7080/v1/cache | head -c 400   # if :7080 LB absent, kubectl port-forward svc/controlplane 7080:7080
```
Expected: rows include `"progress":null` and phase per CR (nothing downloading right now).

- [ ] **Step 8: Commit**

```bash
git add control-plane/src/kubestore.ts control-plane/src/server.ts helm-charts/templates/controlplane/rbac.yaml
git commit -m "feat: /v1/cache reports Downloading with live percentage (pod init-state + exec)"
```

---

### Task 3: Console cache page — polling client table

**Files:**
- Create: `console/app/cache/cache-table.tsx`
- Modify: `console/app/cache/page.tsx`

**Interfaces:**
- Consumes: `/v1/cache` rows with `progress` (Task 2), `apiGet` from `app/lib/client.ts`, `DeleteButton`, `DateTime`, `Pager`.

- [ ] **Step 1: Write the client table** (page stays a server component for the settings gate + pager — state lives in the child, matching the trace.tsx composition rule)

```tsx
// console/app/cache/cache-table.tsx
"use client";
import { useEffect, useState } from "react";
import { apiGet } from "../lib/client";
import { DeleteButton } from "../lib/delete";
import { DateTime } from "../lib/datetime";

export interface CacheEntry {
  name: string; source: string; size: string | null; phase: string;
  created: string; progress: number | null;
}

// Polls /v1/cache every 3s WHILE any row is Downloading; idle otherwise.
export function CacheTable({ initial, offset }: { initial: CacheEntry[]; offset: number }) {
  const [rows, setRows] = useState(initial);
  const downloading = rows.some((r) => r.phase === "Downloading");
  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(() => {
      apiGet<{ cache: CacheEntry[] }>(`/v1/cache?offset=${offset}`)
        .then((j) => setRows(j.cache)).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [downloading, offset]);
  return (
    <table>
      <thead>
        <tr><th>Name</th><th>Size</th><th>Phase</th><th>Source</th><th>Downloaded</th><th></th></tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.name}>
            <td>{c.name}</td>
            <td>{c.size ?? "—"}</td>
            <td>
              <span className={`phase ${c.phase === "Downloading" ? "Deploying" : c.phase}`}>
                {c.phase === "Downloading" && c.progress != null
                  ? `Downloading ${c.progress}%` : c.phase}
              </span>
            </td>
            <td><code style={{ wordBreak: "break-all" }}>{c.source}</code></td>
            <td><DateTime iso={c.created} /></td>
            <td><DeleteButton path={`/v1/cache/${c.name}`} confirmText={`Evict cached model "${c.name}"? It will re-download on next deploy.`} label="Evict" /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Slim the page to gate + fetch + table + pager**

```tsx
// console/app/cache/page.tsx  (replace the <table> block; keep everything above it)
import { wsGet, offsetOf } from "../lib/api";
import { Pager } from "../lib/pager";
import { CacheTable, type CacheEntry } from "./cache-table";

export const dynamic = "force-dynamic";

export default async function CachePage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const settings = await wsGet<{ serving?: { localEnabled?: boolean } }>("/v1/settings").catch(() => null);
  if (settings?.serving?.localEnabled === false) return (
    <>
      <h1>Model Cache</h1>
      <p className="sub">Local serving is disabled on this installation.</p>
    </>
  );
  const offset = offsetOf((await searchParams).page);
  const { cache, count } = await wsGet<{ cache: CacheEntry[]; count: number }>(`/v1/cache?offset=${offset}`);
  return (
    <>
      <h1>Model Cache</h1>
      <p className="sub">Model artifacts downloaded to the cluster — deployments reuse these without re-downloading.</p>
      <CacheTable initial={cache} offset={offset} />
      <Pager count={count} />
    </>
  );
}
```

- [ ] **Step 3: Build + restart the host console, check the page**

```bash
cd console && npx next build && npx next start -p 7090   # kill the old next start first
curl -s http://localhost:7090/cache | grep -o "Model Cache" | head -1
```
Expected: build clean, page 200.

- [ ] **Step 4: Live check with a real download** — evict + redeploy is disruptive; instead this is validated in Task 8's end-to-end run. For now confirm the idle state renders (Ready rows, no polling — check the Network tab shows no /v1/cache requests after load).

- [ ] **Step 5: Commit**

```bash
git add console/app/cache/cache-table.tsx console/app/cache/page.tsx
git commit -m "feat: cache page shows Downloading with live percentage (3s poll while active)"
```

---

### Task 4: Operator `settledReplicas` — honest rollout badges

**Files:**
- Modify: `operator/api/v1alpha1/types.go:139` (after `Provisioned`)
- Modify: `operator/internal/controller/modeldeployment_controller.go:264-271` + `activityFor` (line 296-311) + new `settleNow`
- Modify: `operator/internal/controller/activity_test.go`
- Regen: `operator/config/crd/serving.devproof.ai_modeldeployments.yaml` (controller-gen)
- Modify: `helm-charts/templates/operator/crds/modeldeployments.yaml` (mirror the new status property near `provisioned:` at line 200)

**Interfaces:**
- Produces: `settleNow(prev, desired, ready int32) int32`; `activityFor(phase string, provisioned bool, desired, settled int32) string` (LAST PARAM CHANGES MEANING: settled, not ready). MD status gains `settledReplicas` (int32, optional).

- [ ] **Step 1: Rewrite the tests (failing)** — replace `TestActivity` and add `TestSettleNow` + the sequence test in `activity_test.go`:

```go
package controller

import "testing"

// Activity compares desired vs the last SETTLED desired (spec 2026-07-23
// issue 2): a rollout or crashed replica (desired unchanged) shows NO
// phantom scale overlay; real grows/drains/wakes keep their badges.
func TestActivity(t *testing.T) {
	cases := []struct {
		name             string
		phase            string
		provisioned      bool
		desired, settled int32
		want             string
	}{
		{"first deploy pending", "Pending", false, 1, 0, ""},
		{"first deploy deploying", "Deploying", false, 1, 0, ""},
		{"wake from idle (settled 0)", "Deploying", true, 1, 0, "ScalingUp"},
		{"grow under load 1->3", "Ready", true, 3, 1, "ScalingUp"},
		{"shrink 3->2", "Ready", true, 2, 3, "ScalingDown"},
		{"drain to sleep", "Idle", true, 0, 1, "ScalingDown"},
		{"asleep", "Idle", true, 0, 0, ""},
		{"steady", "Ready", true, 2, 2, ""},
		// THE BUG CASES: desired == settled -> no overlay however low ready is.
		{"rollout (ready dipped, desired unchanged)", "Deploying", true, 1, 1, ""},
		{"crashed replica", "Ready", true, 3, 3, ""},
		// Precedence phases still win.
		{"failed wins", "Failed", true, 2, 1, ""},
		{"downloading wins", "Downloading", true, 2, 1, ""},
		{"copying wins", "Copying", true, 2, 1, ""},
		{"pending wins", "Pending", true, 2, 1, ""},
	}
	for _, c := range cases {
		if got := activityFor(c.phase, c.provisioned, c.desired, c.settled); got != c.want {
			t.Errorf("%s: activityFor(%q,%v,%d,%d) = %q, want %q",
				c.name, c.phase, c.provisioned, c.desired, c.settled, got, c.want)
		}
	}
}

// settleNow: settled tracks desired only when ready has fully caught up.
func TestSettleNow(t *testing.T) {
	cases := []struct {
		name                 string
		prev, desired, ready int32
		want                 int32
	}{
		{"caught up settles", 1, 3, 3, 3},
		{"mid-grow carries", 1, 3, 1, 1},
		{"mid-rollout carries", 1, 1, 0, 1},
		{"zero settles (sleep)", 1, 0, 0, 0},
		{"upgrade seed: ready==desired settles immediately", 0, 1, 1, 1},
	}
	for _, c := range cases {
		if got := settleNow(c.prev, c.desired, c.ready); got != c.want {
			t.Errorf("%s: settleNow(%d,%d,%d) = %d, want %d", c.name, c.prev, c.desired, c.ready, got, c.want)
		}
	}
}

// Reconcile-ordering contract: settle FIRST, then compute activity against
// the updated value — overlays clear in the same reconcile ready catches up.
func TestSettleThenActivitySequences(t *testing.T) {
	type tick struct {
		phase          string
		provisioned    bool
		desired, ready int32
		want           string
	}
	seqs := []struct {
		name    string
		settled int32
		seq     []tick
	}{
		{"rollout", 1, []tick{
			{"Deploying", true, 1, 0, ""},
			{"Ready", true, 1, 1, ""},
		}},
		{"wake", 0, []tick{
			{"Deploying", true, 1, 0, "ScalingUp"},
			{"Ready", true, 1, 1, ""},
		}},
		{"grow", 1, []tick{
			{"Ready", true, 3, 1, "ScalingUp"},
			{"Ready", true, 3, 3, ""},
		}},
		{"placement move drain+restore", 2, []tick{
			{"Deploying", true, 0, 2, "ScalingDown"},
			{"Deploying", true, 0, 0, ""},
			{"Deploying", true, 2, 0, "ScalingUp"},
			{"Ready", true, 2, 2, ""},
		}},
	}
	for _, s := range seqs {
		settled := s.settled
		for i, tk := range s.seq {
			settled = settleNow(settled, tk.desired, tk.ready)
			if got := activityFor(tk.phase, tk.provisioned, tk.desired, settled); got != tk.want {
				t.Fatalf("%s tick %d: got %q want %q (settled=%d)", s.name, i, got, tk.want, settled)
			}
		}
	}
}
```
(Keep `TestProvisioned` unchanged.)

- [ ] **Step 2: Run to verify failure**

Run: `cd operator && ~/sdk/go/bin/go test ./internal/controller/ -run "TestActivity|TestSettle" -v 2>&1 | tail -5`
Expected: compile error — `settleNow` undefined.

- [ ] **Step 3: Implement.** In `types.go` after `Provisioned` (line 139):

```go
	// SettledReplicas is the last desired count that ready fully reached.
	// Activity compares desired against THIS (not ready), so a rollout or a
	// crashed replica — desired unchanged — shows no phantom scale overlay
	// (spec 2026-07-23). Carried forward like Provisioned.
	// +optional
	SettledReplicas int32 `json:"settledReplicas,omitempty"`
```

In `modeldeployment_controller.go`, replace lines 269-270 with (settle FIRST — the ordering is load-bearing):

```go
	status.Provisioned = provisionedNow(md.Status.Provisioned, status.Phase)
	status.SettledReplicas = settleNow(md.Status.SettledReplicas, replicas, int32(ready))
	status.Activity = activityFor(status.Phase, status.Provisioned, replicas, status.SettledReplicas)
```

Replace `activityFor` and add `settleNow`:

```go
// settleNow tracks the last desired count that ready fully reached; carried
// forward through moves exactly like Provisioned (status rebuilt per reconcile).
func settleNow(prev, desired, ready int32) int32 {
	if ready == desired {
		return desired
	}
	return prev
}

// Activity is a DISPLAY-ONLY overlay on Phase: the deployment is moving
// between replica COUNTS. desired vs last-SETTLED desired (not ready): a
// rollout or crashed replica keeps desired == settled and shows no overlay
// (spec 2026-07-23; the pre-settled comparison against ready flagged every
// rollout as a phantom "Scaling up"). Nothing routes on it — Phase stays
// authoritative for the gateway, launch gate and model_routing projection.
func activityFor(phase string, provisioned bool, desired, settled int32) string {
	if !provisioned {
		return "" // first deploy: Downloading/Copying/Deploying are the truth
	}
	switch phase {
	case "Failed", "Downloading", "Copying", "Pending":
		return "" // a real (re-)provision outranks any replica delta
	}
	switch {
	case desired > settled:
		return "ScalingUp"
	case desired < settled:
		return "ScalingDown"
	}
	return ""
}
```

- [ ] **Step 4: Tests green, full operator suite**

Run: `cd operator && ~/sdk/go/bin/go test ./... 2>&1 | tail -5`
Expected: all packages ok (if another test calls `activityFor` with the old meaning, update its expectations per the new table).

- [ ] **Step 5: Regenerate CRDs + mirror to chart**

```bash
cd operator && ~/go/bin/controller-gen.exe object crd paths=./... output:crd:artifacts:config=config/crd
git diff --stat config/crd  # expect settledReplicas added to modeldeployments
```
Then hand-add the same property to `helm-charts/templates/operator/crds/modeldeployments.yaml` next to `provisioned:` (line ~200), copying the generated block:

```yaml
              settledReplicas:
                description: |-
                  SettledReplicas is the last desired count that ready fully reached.
                format: int32
                type: integer
```
(Description text: copy verbatim from the regenerated file.)

- [ ] **Step 6: Apply CRD + roll the operator (same tag), verify live**

```bash
kubectl apply -f operator/config/crd/serving.devproof.ai_modeldeployments.yaml
TAG=$(kubectl get deploy devproof-operator -n default -o jsonpath='{.spec.template.spec.containers[0].image}' | sed 's/.*://')
VERSION=$TAG REGISTRY=ghcr.io/devproof docker buildx bake operator
# save + ctr-import to all 8 nodes + rollout restart + verify imageID (Global Constraints)
kubectl delete pod -n default -l inference.llmkube.dev/model=gemma-4-12b-it-q4   # quick bounce = a rollout
kubectl get modeldeployment gemma-4-12b-it-q4 -n default -o jsonpath='{.status.activity}/{.status.phase}/{.status.settledReplicas}'
```
Expected: during the bounce `"/Deploying/1"` (empty activity — no phantom badge), back to `/Ready/1` after; console /deployments shows the orange `Deploying` badge, not "Scaling up".

- [ ] **Step 7: Commit**

```bash
git add operator/api/v1alpha1/ operator/internal/controller/ operator/config/crd/ helm-charts/templates/operator/crds/modeldeployments.yaml
git commit -m "fix: rollouts and crashed replicas no longer show a phantom Scaling-up badge"
```

---

### Task 5: Gateway hook — known local models never 400

**Files:**
- Modify: `helm-charts/files/custom_callbacks.py` — insert AFTER the scale-to-zero hold block (the `try:` at line ~945 ending `print(f"devproof-wake: hold check failed (open): {e}", ...)`), BEFORE the sanitizer block (`if SCRUB_ALL or ...`).

**Interfaces:**
- Consumes: `_routing_state(model)` (existing, line 131), `HTTPException` (already imported).
- Produces: requests for a known local model missing from this replica's loaded router return `503` + `Retry-After: 5` (Task 6's runner client consumes that header).

- [ ] **Step 1: Verify the router accessor in the live gateway**

```bash
GW=$(kubectl get pods -n default -o name | grep gateway | head -1)
kubectl exec -n default ${GW#pod/} -- python -c "from litellm import Router; print(hasattr(Router,'get_model_names'))"
```
Expected: `True`. (If False: use `[m['model_name'] for m in (router.model_list or [])]` instead in Step 2.)

- [ ] **Step 2: Insert the rollout guard**

```python
        try:  # rollout guard (spec 2026-07-23 issue 3): a model the platform
              # KNOWS (model_routing row exists) but that THIS replica's loaded
              # config lacks — the rolling-reload window, route dropped or not
              # yet re-added — must get a retryable 503, never LiteLLM's
              # validation 400 (killed sesn_o0roa4kwnots mid-turn; reproduced
              # 2026-07-23: 200/400 interleave across mixed-config replicas).
              # Runs AFTER the hold so a released request is re-checked here.
              # Unknown models (external/deleted) keep the 400. Fail OPEN.
            model0 = data.get("model")
            if model0 and await _routing_state(model0) is not None:
                from litellm.proxy import proxy_server
                router = getattr(proxy_server, "llm_router", None)
                if router is not None and model0 not in set(router.get_model_names()):
                    raise HTTPException(status_code=503,
                        detail=f"model {model0} is reloading on this gateway replica - retry shortly",
                        headers={"Retry-After": "5"})
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            print(f"devproof-rollout-guard: check failed (open): {e}", flush=True)
```

- [ ] **Step 3: Roll the hook into the live ConfigMap + restart gateways**

```bash
python - <<'EOF'
import json, subprocess
src = open('helm-charts/files/custom_callbacks.py', encoding='utf-8').read()
patch = json.dumps({"data": {"custom_callbacks.py": src}})
subprocess.run(["kubectl","patch","configmap","litellm-config","-n","default","--type","merge","-p",patch], check=True)
EOF
kubectl rollout restart deploy/gateway -n default && kubectl rollout status deploy/gateway -n default --timeout=300s
```

- [ ] **Step 4: Verify — happy path + guard path**

```bash
KEY=$(kubectl get secret gateway-auth -n default -o jsonpath='{.data.internal-key}' | base64 -d)
# happy: known + routed -> 200
curl -s -o /dev/null -w "%{http_code}\n" --max-time 60 http://localhost:14000/v1/chat/completions -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"model":"gemma4","messages":[{"role":"user","content":"hi"}],"max_tokens":3}'
# unknown model still 400s:
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:14000/v1/chat/completions -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"model":"no-such-model","messages":[{"role":"user","content":"hi"}],"max_tokens":3}'
```
Expected: `200` then `400`. The guard's 503 path is exercised by Task 8's outage rerun.

- [ ] **Step 5: Commit**

```bash
git add helm-charts/files/custom_callbacks.py
git commit -m "fix: gateway 503s (Retry-After) instead of 400 when a known model is missing from a replica's reloading config"
```

---

### Task 6: Runner client — patient Retry-After retries

**Files:**
- Modify: `session-runner/devproof_runner/errors.py` (`APIError` gains `retry_after`)
- Modify: `session-runner/devproof_runner/client.py` (lines 110-145: `create()` loop + `_stream_once` header capture; add `import time` to the imports)
- Create: `session-runner/tests/test_client_retry.py`

**Interfaces:**
- Consumes: gateway `503` + `Retry-After` (Task 5).
- Produces: `APIError(msg, status=..., retryable=..., retry_after: float|None)`; module constant `PATIENT_WINDOW` (env `DEVPROOF_SDK_PATIENT_RETRY`, default `1800` seconds).

- [ ] **Step 1: Read `errors.py`, then write the failing tests**

```python
# session-runner/tests/test_client_retry.py
"""Retry policy (spec 2026-07-23 issue 3): 503+Retry-After and
no-response transport errors retry patiently (time-bounded); other
retryables keep the bounded attempt count; 4xx fail immediately."""
import unittest
from unittest import mock

import anyio
import httpx

from devproof_runner import client as client_mod
from devproof_runner.client import MessagesClient
from devproof_runner.errors import APIError


def make_client(handler) -> MessagesClient:
    c = MessagesClient(base_url="http://gw.test", auth_token="t")
    c._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://gw.test")
    return c


def call(c: MessagesClient):
    async def run():
        return await c.create(model="m", system="", messages=[], tools=None, max_tokens=8)
    return anyio.run(run)


class RetryTests(unittest.TestCase):
    def setUp(self):
        # No real sleeping in tests.
        async def no_sleep(_s): return None
        p = mock.patch.object(client_mod.anyio, "sleep", no_sleep)
        p.start(); self.addCleanup(p.stop)

    def test_503_with_retry_after_is_patient_then_final_error_surfaces(self):
        calls = []
        def handler(req):
            calls.append(1)
            if len(calls) < 6:  # more than MAX_ATTEMPTS: proves the patient path
                return httpx.Response(503, headers={"Retry-After": "0"},
                                      json={"error": {"message": "reloading"}})
            return httpx.Response(400, json={"error": {"message": "bad"}})
        with self.assertRaises(APIError) as ctx:
            call(make_client(handler))
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(len(calls), 6)

    def test_400_never_retried(self):
        calls = []
        def handler(req):
            calls.append(1)
            return httpx.Response(400, json={"error": {"message": "invalid model"}})
        with self.assertRaises(APIError):
            call(make_client(handler))
        self.assertEqual(len(calls), 1)

    def test_patient_window_bounds_the_5xx_loop(self):
        def handler(req):
            return httpx.Response(503, headers={"Retry-After": "0"},
                                  json={"error": {"message": "reloading"}})
        c = make_client(handler)
        with mock.patch.object(client_mod, "PATIENT_WINDOW", 0.0):
            with self.assertRaises(APIError) as ctx:
                call(c)
        self.assertEqual(ctx.exception.status, 503)
        self.assertIsNotNone(ctx.exception.retry_after)

    def test_connect_error_is_patient(self):
        calls = []
        def handler(req):
            calls.append(1)
            if len(calls) < 6:
                raise httpx.ConnectError("refused")
            return httpx.Response(400, json={"error": {"message": "done"}})
        with self.assertRaises(APIError) as ctx:
            call(make_client(handler))
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(len(calls), 6)

    def test_plain_500_keeps_bounded_attempts(self):
        calls = []
        def handler(req):
            calls.append(1)
            return httpx.Response(500, json={"error": {"message": "boom"}})
        with self.assertRaises(APIError):
            call(make_client(handler))
        self.assertEqual(len(calls), client_mod.MAX_ATTEMPTS)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd session-runner && python -m unittest tests.test_client_retry -v 2>&1 | tail -5`
Expected: FAIL — `APIError` has no `retry_after` / patient loop absent (503 test sees only MAX_ATTEMPTS calls).

- [ ] **Step 3: Implement.** `errors.py`: add the field to `APIError.__init__` (match its existing style):

```python
    def __init__(self, message, *, status=None, retryable=False, retry_after=None):
        super().__init__(message)
        self.status = status
        self.retryable = retryable
        self.retry_after = retry_after
```
(Adapt to the file's actual current signature — keep every existing attribute.)

`client.py`: add near the constants (line ~21):

```python
# Patient retries (spec 2026-07-23): a gateway 503 carrying Retry-After means
# "the model is coming back — wait" (hold-cap expiry, rolling config reload),
# and a connect-level failure means no request was consumed. Both retry on a
# TIME budget instead of an attempt count, so a session waits out a model
# rollout instead of failing the turn. Other retryables keep MAX_ATTEMPTS.
PATIENT_WINDOW = float(os.environ.get("DEVPROOF_SDK_PATIENT_RETRY", "1800"))
```

Replace the `create()` retry loop (lines 118-132):

```python
        last_err: APIError | None = None
        patient = False
        attempt = 0
        deadline = time.monotonic() + PATIENT_WINDOW
        while True:
            if attempt:
                # Jitter: hundreds of session pods retrying a gateway blip must
                # not re-arrive in lockstep. Retry-After (capped) wins when set.
                delay = 2 ** min(attempt, 4) + random.uniform(0, 1)
                if last_err is not None and last_err.retry_after is not None:
                    delay = min(last_err.retry_after, 30.0) + random.uniform(0, 1)
                await anyio.sleep(delay)
            try:
                return await self._stream_once(body)
            except APIError as err:
                if not err.retryable:
                    raise
                last_err = err
                patient = err.retry_after is not None
            except httpx.HTTPError as err:
                last_err = APIError(f"connection error: {err}", retryable=True)
                # No response consumed -> always safe to resend.
                patient = isinstance(err, (httpx.ConnectError, httpx.ConnectTimeout,
                                           httpx.RemoteProtocolError))
            attempt += 1
            if patient:
                if time.monotonic() >= deadline:
                    raise last_err
            elif attempt >= MAX_ATTEMPTS:
                raise last_err
```

In `_stream_once` (line 136-144), capture the header:

```python
            if res.status_code != 200:
                raw = (await res.aread()).decode("utf-8", "replace")
                try:
                    detail = json.loads(raw).get("error", {}).get("message") or raw
                except (json.JSONDecodeError, AttributeError):
                    detail = raw
                ra = res.headers.get("retry-after")
                try:
                    retry_after = float(ra) if ra is not None else None
                except ValueError:
                    retry_after = None
                raise APIError(f"API Error: {res.status_code} {detail}"[:4000],
                               status=res.status_code,
                               retryable=res.status_code in RETRYABLE_STATUS,
                               retry_after=retry_after)
```

Add `import time` to the stdlib imports.

- [ ] **Step 4: Full runner suite**

Run: `cd session-runner && python -m unittest discover -s tests -p "test_*.py" 2>&1 | tail -3`
Expected: all green (incl. the 5 new tests).

- [ ] **Step 5: Commit**

```bash
git add session-runner/devproof_runner/errors.py session-runner/devproof_runner/client.py session-runner/tests/test_client_retry.py
git commit -m "feat: runner waits out model rollouts — patient Retry-After retries bounded by time, not attempts"
```

---

### Task 7: Runner image dev52 — build, import, wire

**Files:** none (build + cluster ops)

- [ ] **Step 1: Build from the repo root**

```bash
docker build -f session-runner/Dockerfile -t ghcr.io/devproof/devproofai-session-runner:dev52 .
```

- [ ] **Step 2: In-image test run** (bind mount keeps the image test-free):

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd)/session-runner/tests:/tests:ro" ghcr.io/devproof/devproofai-session-runner:dev52 sh -c "cd / && python -m unittest discover -s /tests -p 'test_*.py'" 2>&1 | tail -3
```
Expected: green (skips allowed where tests declare them).

- [ ] **Step 3: ctr-import into all 8 nodes** (Global Constraints procedure; ~587MB tar) and point the CP at it:

```bash
docker save ghcr.io/devproof/devproofai-session-runner:dev52 -o runner52.tar
# import via node-debugger pods on every node, then:
kubectl set env -n default deploy/$(kubectl get deploy -n default -o name | grep controlplane | sed 's|.*/||') DEVPROOF_RUNNER_IMAGE=ghcr.io/devproof/devproofai-session-runner:dev52
kubectl rollout status -n default deploy/$(kubectl get deploy -n default -o name | grep controlplane | sed 's|.*/||') --timeout=120s
rm runner52.tar
```

- [ ] **Step 4: Smoke a session** — start a short session via the console (or `POST /v1/sessions` with the `profile analysis` agent) and confirm it completes; check the session pod's image is `dev52`.

- [ ] **Step 5: Commit** — CLAUDE.md's runner-image bullet gains the dev52 line (current-tag pointer):

Update `CLAUDE.md`: in the Session runner image bullet, change `(current dev50; ...)` to `(current dev52; dev52 adds patient Retry-After retries in the /v1/messages client — 503-with-Retry-After and connect-level failures retry on a time budget (env DEVPROOF_SDK_PATIENT_RETRY, default 1800s) so sessions wait out model rollouts; ...)` keeping the existing history text.

```bash
git add CLAUDE.md
git commit -m "docs: runner dev52 — patient retries for model rollouts"
```

---

### Task 8: End-to-end validation — the session MUST wait

**Files:** none (live validation; scripts in scratchpad)

- [ ] **Step 1: Rerun the outage experiment against the patched gateway.** Reuse the round-2 script shape (state watcher + sequential probes + park device plugin + delete engine pod + 6-min outage + restore — see `repro2.sh` in the 2026-07-23 session scratchpad; recreate if gone). Success criteria versus the baseline run:
  - ZERO probe outcomes with `code=400` (baseline had 11)
  - Probes show only: 200, held-then-200, or 503 with the reload/waking detail
  - After restore, probes return to stable 200 within ~60s
  Cleanup after: delete `UnexpectedAdmissionError` pod carcasses (`kubectl get pods -n default --no-headers | grep UnexpectedAdmissionError | awk '{print $1}' | xargs -r kubectl delete pod -n default`), confirm gemma serving.

- [ ] **Step 2: Real session across a rollout.** Start a session (profile-analysis agent), and while its turn is running, `kubectl delete pod -n default -l inference.llmkube.dev/model=gemma-4-12b-it-q4`. Expected: the session does NOT fail — the turn stalls (gateway hold, then runner patient retries visible in the pod log) and completes once the model is back. Verify in the console session view: no `session.failed`, final `session.result` success.

- [ ] **Step 3: Cache page live.** Evict the gemma cache entry (console /cache → Evict) and bounce the engine pod so it re-downloads; watch /cache show `Downloading N%` climbing on 3s polls, flipping to Ready when done. (This re-downloads 6.6GB — acceptable on this cluster; skip if the user objects and rely on the Task 1/2 unit + spike evidence.)

- [ ] **Step 4: Full battery**

```bash
cd control-plane && npm test && npx tsc --noEmit
cd ../operator && ~/sdk/go/bin/go test ./...
cd ../session-runner && python -m unittest discover -s tests -p "test_*.py"
cd ../console && npx next build
```
Expected: all green. Then confirm /cache, /deployments, /sessions pages 200 on :7090.

- [ ] **Step 5: Final commit** (spec + plan + any stragglers)

```bash
git add docs/superpowers/specs/2026-07-23-cache-download-progress-design.md docs/superpowers/plans/2026-07-23-cache-progress-rollout-fixes.md
git commit -m "docs: spec + plan for cache progress, rollout badges, rollout-safe sessions"
```

---

## Self-Review Notes

- Spec coverage: issue 1 → Tasks 1-3; issue 2 → Task 4; issue 3 → Tasks 5-7; live verification → Task 8. RBAC (spec issue-1 note) → Task 2 Steps 4/6. Runner tag bump → Task 7. CLAUDE.md tag pointer → Task 7 Step 5.
- Type consistency: `progress: number|null` flows Task 1 → 2 → 3; `activityFor(phase, provisioned, desired, settled)` consistent Task 4 test/impl; `retry_after` consistent Task 6 errors/client/tests.
- Known adaptation points (not placeholders): Task 2 fake-store stubs found by grep; Task 6 Step 3 errors.py "adapt to actual signature" — the executor reads the file first (its exact current shape is 10 lines and may differ in attribute defaults).
