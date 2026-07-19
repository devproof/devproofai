# Platform Improvements Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eleven small improvements: runner image dev15 (tools + `requests` + WebFetch preflight off), egress wildcards + secure no-env default, editable environments, API-key soft delete with honest usage labels, gateway warmup for newly-routed models, and console polish (white content boxes, files→sessions drill-down).

**Architecture:** Control plane is Fastify/TS (`control-plane/`), console is Next.js (`console/`), session runner is a Python image (`session-runner/`), all egress flows through per-environment Squid proxies created by `orchestrator.ts`. Spec: `docs/superpowers/specs/2026-07-10-platform-improvements-batch-design.md`.

**Tech Stack:** Node 22 + tsx + Fastify + pg, Node test runner (`node:test`), Next.js 15 App Router, python:3.12-slim Docker image, Kubernetes (docker-desktop/kind-style multi-node cluster).

## Global Constraints

- Everything must scale to hundreds/thousands of pods and run on the local docker-desktop cluster.
- Console: production build only (`npx next build && npx next start -p 7090`); no `prompt()`/`confirm()`/`alert()` — shared `Modal`/`Field`/`ConfirmDialog` from `console/app/lib/modal.tsx`; no transparent text buttons; table links regular weight; edit-by-name-click uses `className="namebtn"` (pools pattern).
- Multi-tenancy: every entity workspace-scoped via `X-Devproof-Workspace` (default `wrkspc_default`); console helpers `wsGet` (server) / `wsHeader`, `apiPost` (client).
- Runner image changes REQUIRE a tag bump: `dev14` → **`dev15`** (nodes cache same-tag rebuilds).
- Squid conf MUST keep `max_filedescriptors 1024` and the conf.d/spool shadowing (OOM otherwise).
- Backend gates: `cd control-plane && npm test` and `npx tsc --noEmit` green.
- Wildcard semantics (exact copy): `*` = allow all outbound; `*.foo.com` → normalize to `.foo.com`; plain hosts keep inclusive leading-dot semantics; hint text: `comma or newline separated; supports *.domain.com and * (allow all); empty = all outbound blocked`.
- API-key soft delete: `status='deleted'`, row kept; gateway auth already requires `status='active'`. UI labels: `api_key_id === null` → `(deleted key)`; `status === 'deleted'` → `<name> [deleted]`.
- No-env sessions: label `devproof.ai/environment: env_none` + proxy env at the deny-all `egress-env-none` Squid. Session panel copy: "No environment — all outbound blocked".
- Warmup: CP-side on gateway sync (NOT operator — out-of-cluster dev can't reach ClusterIP); gateway URL env `DEVPROOF_GATEWAY_LOCAL_URL` default `http://127.0.0.1:14000`.
- The controller (main session) runs all live-cluster/browser gates and server restarts — subagents must NOT start/restart the CP, console, or clusters.

---

### Task 1: Squid config as a pure function + wildcard support

**Files:**
- Create: `control-plane/src/egress.ts`
- Create: `control-plane/test/egress.test.ts`
- Modify: `control-plane/src/orchestrator.ts:44-61` (replace inline conf build)
- Modify: `console/app/environments/create.tsx:35` (hint text)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function squidConf(hosts: string[], allowPackageManagers: boolean): string` — later tasks (2, 3) call `ensureEnvironmentPolicy`, which uses this internally. Console hint text is reused verbatim by Task 3's edit modal.

- [ ] **Step 1: Write the failing test**

Create `control-plane/test/egress.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { squidConf } from "../src/egress.ts";

test("plain hosts get leading-dot ACLs (domain + subdomains)", () => {
  const conf = squidConf(["docs.dremio.com", "api.github.com"], false);
  assert.match(conf, /acl allowed dstdomain \.docs\.dremio\.com \.api\.github\.com/);
  assert.match(conf, /http_access allow allowed/);
  assert.match(conf, /http_access deny all/);
});

test("*.foo.com normalizes to .foo.com (no double dot, no literal *)", () => {
  const conf = squidConf(["*.dremio.com"], false);
  assert.match(conf, /acl allowed dstdomain \.dremio\.com/);
  assert.ok(!conf.includes("*"));
});

test("* allows all outbound (no acl, allow all before deny)", () => {
  const conf = squidConf(["*"], false);
  assert.match(conf, /http_access allow all/);
  assert.ok(!conf.includes("dstdomain"));
  // "allow all" must come before "deny all" or it is dead config
  assert.ok(conf.indexOf("http_access allow all") < conf.indexOf("http_access deny all"));
});

test("* wins even when mixed with other hosts", () => {
  const conf = squidConf(["docs.dremio.com", "*"], true);
  assert.match(conf, /http_access allow all/);
  assert.ok(!conf.includes("dstdomain"));
});

test("empty hosts = deny all only", () => {
  const conf = squidConf([], false);
  assert.ok(!conf.includes("http_access allow"));
  assert.match(conf, /http_access deny all/);
});

test("package managers append pypi/npm registries", () => {
  const conf = squidConf([], true);
  assert.match(conf, /acl allowed dstdomain \.pypi\.org \.files\.pythonhosted\.org \.registry\.npmjs\.org/);
});

test("memory/FD guards always present", () => {
  for (const conf of [squidConf([], false), squidConf(["*"], false)]) {
    assert.match(conf, /max_filedescriptors 1024/);
    assert.match(conf, /cache deny all/);
    assert.match(conf, /http_port 3128/);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npx tsx --test test/egress.test.ts`
Expected: FAIL — `Cannot find module '../src/egress.ts'`

- [ ] **Step 3: Write the implementation**

Create `control-plane/src/egress.ts`:

```ts
// Squid config for a per-environment egress proxy (spec 2026-07-10).
// Pure so the allowlist → ACL mapping is unit-testable.
//
// Host semantics:
//   "*"          → allow ALL outbound (traffic still flows through the proxy)
//   "*.foo.com"  → alias for "foo.com" (leading dot: apex + all subdomains)
//   "foo.com"    → foo.com + all subdomains (Squid leading-dot dstdomain)
export function squidConf(hosts: string[], allowPackageManagers: boolean): string {
  const all = hosts.includes("*");
  const normalized = hosts
    .filter((h) => h !== "*")
    .map((h) => h.replace(/^\*\./, "."))
    .map((h) => (h.startsWith(".") ? h : `.${h}`));
  if (allowPackageManagers) {
    normalized.push(".pypi.org", ".files.pythonhosted.org", ".registry.npmjs.org");
  }
  return [
    "http_port 3128",
    "cache deny all",           // proxy-only, no caching → low memory
    "cache_mem 8 MB",
    // Containers expose a huge default FD limit; squid reserves per-FD
    // buffers and OOMs unless capped.
    "max_filedescriptors 1024",
    ...(all
      ? ["http_access allow all"]
      : normalized.length
        ? [`acl allowed dstdomain ${normalized.join(" ")}`, "http_access allow allowed"]
        : []),
    "http_access deny all",
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd control-plane && npx tsx --test test/egress.test.ts`
Expected: PASS (7/7)

- [ ] **Step 5: Use it in the orchestrator**

In `control-plane/src/orchestrator.ts`, add to the imports at the top of the file:

```ts
import { squidConf } from "./egress.ts";
```

Then replace the inline conf build inside `ensureEnvironmentPolicy` — delete these lines (currently 44-61):

```ts
      const hosts: string[] = [...(env.allowedHosts ?? [])];
      if (env.allowPackageManagers) {
        hosts.push("pypi.org", "files.pythonhosted.org", "registry.npmjs.org");
      }
      const squidConf = [
        "http_port 3128",
        "cache deny all",           // proxy-only, no caching → low memory
        "cache_mem 8 MB",
        // Containers expose a huge default FD limit; squid reserves per-FD
        // buffers and OOMs unless capped.
        "max_filedescriptors 1024",
        ...(hosts.length ? [
          // Leading dot matches the domain itself plus all subdomains.
          `acl allowed dstdomain ${hosts.map((h) => (h.startsWith(".") ? h : `.${h}`)).join(" ")}`,
          "http_access allow allowed",
        ] : []),
        "http_access deny all",
      ].join("\n");
```

and insert instead:

```ts
      const hosts: string[] = [...(env.allowedHosts ?? [])];
      const conf = squidConf(hosts, env.allowPackageManagers ?? false);
```

Two follow-up references in the same function must change:
1. `const cmBody = { metadata: { name: cmName }, data: { "squid.conf": squidConf } };` → `data: { "squid.conf": conf }`.
2. The restart-annotation patch `"devproof.ai/conf": String(hosts.length) + hosts.join(",")` stays as-is (hosts still identifies the config; package-manager changes flow through `hosts.length` unchanged — replace the whole annotation value with a content hash instead: use `"devproof.ai/conf": String(conf.length) + ":" + hosts.join(",")` so toggling package managers alone also restarts Squid).

- [ ] **Step 6: Update the console hint text**

In `console/app/environments/create.tsx` line 35, change:

```tsx
        <Field label="Allowed hosts" stack hint="comma or newline separated; empty = all outbound blocked">
```

to:

```tsx
        <Field label="Allowed hosts" stack hint="comma or newline separated; supports *.domain.com and * (allow all); empty = all outbound blocked">
```

- [ ] **Step 7: Full check + commit**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: all suites PASS, tsc clean.

```bash
git add control-plane/src/egress.ts control-plane/test/egress.test.ts control-plane/src/orchestrator.ts console/app/environments/create.tsx
git commit -m "feat(egress): extract squidConf as pure function, add * and *.domain wildcards"
```

---

### Task 2: No-env sessions are locked down by default

**Files:**
- Modify: `control-plane/src/orchestrator.ts` (session Job template: label + proxy env, currently lines ~216-274)
- Modify: `control-plane/src/main.ts:59` (ensure the built-in deny-all egress at boot)
- Modify: `console/app/sessions/[id]/panels.tsx:85-100` (EnvPanel copy)

**Interfaces:**
- Consumes: `ensureEnvironmentPolicy(env)` (existing; Task 1 changed only its internals).
- Produces: the pseudo-environment id **`env_none`** — Kubernetes resources `egress-env-none` (ConfigMap/Deployment/Service) + NetworkPolicy `env-env-none`. Task 8 verifies live.

- [ ] **Step 1: Always label + proxy session pods**

In `control-plane/src/orchestrator.ts`, in `createSessionJob`'s Job template. Replace the label block:

```ts
                labels: {
                  "devproof.ai/session": session.id,
                  app: "devproof-session",
                  ...((session.config as any).environment_id
                    ? { "devproof.ai/environment": (session.config as any).environment_id }
                    : {}),
                },
```

with:

```ts
                labels: {
                  "devproof.ai/session": session.id,
                  app: "devproof-session",
                  // No environment ⇒ the built-in deny-all egress (spec 2026-07-10):
                  // no outbound, no pip. Assign an environment to grant access.
                  "devproof.ai/environment": (session.config as any).environment_id ?? "env_none",
                },
```

And replace the conditional proxy env block:

```ts
                      ...((session.config as any).environment_id ? (() => {
                        const proxy = `http://egress-${String((session.config as any).environment_id).replace(/_/g, "-").toLowerCase()}.${AGENTS_NAMESPACE}.svc.cluster.local:3128`;
                        const noProxy = "gateway.devproof-gateway.svc.cluster.local,host.docker.internal,localhost,127.0.0.1,10.0.0.0/8";
                        return [
                          { name: "HTTP_PROXY", value: proxy }, { name: "http_proxy", value: proxy },
                          { name: "HTTPS_PROXY", value: proxy }, { name: "https_proxy", value: proxy },
                          { name: "NO_PROXY", value: noProxy }, { name: "no_proxy", value: noProxy },
                        ];
                      })() : []),
```

with (unconditional — `env_none` routes to the deny-all proxy):

```ts
                      ...(() => {
                        const envId = String((session.config as any).environment_id ?? "env_none");
                        const proxy = `http://egress-${envId.replace(/_/g, "-").toLowerCase()}.${AGENTS_NAMESPACE}.svc.cluster.local:3128`;
                        const noProxy = "gateway.devproof-gateway.svc.cluster.local,host.docker.internal,localhost,127.0.0.1,10.0.0.0/8";
                        return [
                          { name: "HTTP_PROXY", value: proxy }, { name: "http_proxy", value: proxy },
                          { name: "HTTPS_PROXY", value: proxy }, { name: "https_proxy", value: proxy },
                          { name: "NO_PROXY", value: noProxy }, { name: "no_proxy", value: noProxy },
                        ];
                      })(),
```

- [ ] **Step 2: Provision the deny-all egress at CP boot**

In `control-plane/src/main.ts`, the orchestrator is currently constructed inline at line 59. Change:

```ts
await registerAgentRoutes(app, repo, realOrchestrator(), files, notify);
```

to:

```ts
const orchestrator = realOrchestrator();
// Built-in deny-all egress for sessions without an environment (spec
// 2026-07-10): same mechanics as a real environment, empty allowlist.
orchestrator
  .ensureEnvironmentPolicy({ id: "env_none", allowedHosts: [], allowPackageManagers: false })
  .catch((err) => console.warn("env_none egress provisioning failed:", err));
await registerAgentRoutes(app, repo, orchestrator, files, notify);
```

- [ ] **Step 3: Fix the session panel copy**

In `console/app/sessions/[id]/panels.tsx`, `EnvPanel`, replace:

```tsx
        <div className="row"><span className="muted">Type</span><span>{env ? "Limited" : "Unrestricted (no environment)"}</span></div>
        <div className="row"><span className="muted">Packages</span><span>{env?.allow_package_managers ? "Enabled" : "Disabled"}</span></div>
        {env && (
          <div style={{ marginTop: 6 }}>
            {env.allowed_hosts?.length
              ? env.allowed_hosts.map((h: string) => <span key={h} className="chip" style={{ marginRight: 6, marginBottom: 4 }}><code>{h}</code></span>)
              : <span className="muted">all outbound blocked</span>}
          </div>
        )}
```

with:

```tsx
        <div className="row"><span className="muted">Type</span><span>{env ? "Limited" : "No environment — all outbound blocked"}</span></div>
        <div className="row"><span className="muted">Packages</span><span>{env?.allow_package_managers ? "Enabled" : "Disabled"}</span></div>
        <div style={{ marginTop: 6 }}>
          {env?.allowed_hosts?.length
            ? env.allowed_hosts.map((h: string) => <span key={h} className="chip" style={{ marginRight: 6, marginBottom: 4 }}><code>{h}</code></span>)
            : <span className="muted">all outbound blocked</span>}
        </div>
```

- [ ] **Step 4: Full check + commit**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: PASS (no test asserts the old conditional label — if one does, update it to expect `"devproof.ai/environment": "env_none"`).

```bash
git add control-plane/src/orchestrator.ts control-plane/src/main.ts "console/app/sessions/[id]/panels.tsx"
git commit -m "feat(egress): no-environment sessions default to built-in deny-all egress (env_none)"
```

Live verification happens in Task 8 (controller): a no-env session must fail `curl https://example.com` and `pip install`, while model calls + file publishing keep working.

---

### Task 3: Environments are editable (CP PATCH + console modal)

**Files:**
- Modify: `control-plane/src/repo.ts` (add `updateEnvironment` after `listEnvironments`, ~line 552)
- Modify: `control-plane/src/agents-api.ts:138-157` (add PATCH route)
- Modify: `console/app/environments/create.tsx` (extract shared form, add `EditEnvironment`)
- Modify: `console/app/environments/page.tsx` (name cell opens edit)
- Test: `control-plane/test/agents-api.test.ts`

**Interfaces:**
- Consumes: `orchestrator.ensureEnvironmentPolicy({ id, allowedHosts, allowPackageManagers })` (Task 1/2 unchanged signature); `submitJson(method, path, body)` from `console/app/lib/modal.tsx` (existing — supports arbitrary methods).
- Produces: `repo.updateEnvironment(workspaceId: string, id: string, patch: { name?: string; allowPackageManagers?: boolean; allowedHosts?: string[] }): Promise<Row | null>` (Row = snake_case DB row); `PATCH /v1/environments/:id` → 200 row / 404 `{error:"environment not found"}`.

- [ ] **Step 1: Write the failing route test**

In `control-plane/test/agents-api.test.ts`, the `fakes()` repo already has `createEnvironment`/`listEnvironments` (lines 82-83). Add next to them:

```ts
    async updateEnvironment(_ws: string, id: string, patch: any) {
      return id === "env_0" ? { id, name: patch.name ?? "e", allow_package_managers: patch.allowPackageManagers ?? false, allowed_hosts: patch.allowedHosts ?? [] } : null;
    },
```

Find the fake orchestrator in the same file (it implements `Orchestrator`); make its `ensureEnvironmentPolicy` record calls if it doesn't already:

```ts
    envPolicies: [] as any[],
    async ensureEnvironmentPolicy(env: any) { (this as any).envPolicies.push(env); },
```

(Adapt to the fake's existing shape — it may be a plain object literal; keep the recording array reachable from the test.)

Add the test (near other route tests):

```ts
test("PATCH /v1/environments/:id updates and re-syncs the egress policy", async (t) => {
  const { app, orch } = await build(t);   // adapt to the file's existing builder helper
  const res = await app.inject({
    method: "PATCH", url: "/v1/environments/env_0",
    payload: { name: "renamed", allowedHosts: ["*.dremio.com"], allowPackageManagers: true },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().name, "renamed");
  const last = orch.envPolicies.at(-1);
  assert.deepEqual(last, { id: "env_0", allowedHosts: ["*.dremio.com"], allowPackageManagers: true });
});

test("PATCH /v1/environments/:id → 404 for unknown id", async (t) => {
  const { app } = await build(t);
  const res = await app.inject({ method: "PATCH", url: "/v1/environments/env_missing", payload: { name: "x" } });
  assert.equal(res.statusCode, 404);
});
```

(The file has an existing pattern for constructing the app with fakes — mirror it exactly; the essential assertions are status codes, returned name, and the recorded `ensureEnvironmentPolicy` argument.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd control-plane && npm test`
Expected: FAIL — PATCH route returns 404/405 (route not defined).

- [ ] **Step 3: Implement repo + route**

In `control-plane/src/repo.ts`, directly after `listEnvironments` (~line 552):

```ts
  /** Partial update; returns the updated row (snake_case) or null when the
   *  id doesn't exist in this workspace. */
  async updateEnvironment(
    workspaceId: string, id: string,
    patch: { name?: string; allowPackageManagers?: boolean; allowedHosts?: string[] },
  ) {
    const sets: string[] = [];
    const params: unknown[] = [id, workspaceId];
    if (patch.name !== undefined) { params.push(patch.name); sets.push(`name = $${params.length}`); }
    if (patch.allowPackageManagers !== undefined) { params.push(patch.allowPackageManagers); sets.push(`allow_package_managers = $${params.length}`); }
    if (patch.allowedHosts !== undefined) { params.push(JSON.stringify(patch.allowedHosts)); sets.push(`allowed_hosts = $${params.length}`); }
    if (!sets.length) {
      const { rows } = await this.pool.query("SELECT * FROM environments WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
      return rows[0] ?? null;
    }
    const { rows } = await this.pool.query(
      `UPDATE environments SET ${sets.join(", ")} WHERE id = $1 AND workspace_id = $2 RETURNING *`, params);
    return rows[0] ?? null;
  }
```

In `control-plane/src/agents-api.ts`, after the `POST /v1/environments` route (line 144):

```ts
  app.patch("/v1/environments/:id", async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; allowPackageManagers?: boolean; allowedHosts?: string[] };
    const row = await repo.updateEnvironment(ws(req), (req.params as any).id, b);
    if (!row) return reply.code(404).send({ error: "environment not found" });
    // Reload the Squid allowlist for the (possibly running) proxy.
    await orchestrator.ensureEnvironmentPolicy({
      id: row.id, allowedHosts: row.allowed_hosts ?? [], allowPackageManagers: row.allow_package_managers ?? false,
    });
    return row;
  });
```

Also add `updateEnvironment` to the `Repo`-facing type if the file declares one for the repo param (it types `repo: Repo` from the class — no interface change needed).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Console — shared form + EditEnvironment**

Replace the full contents of `console/app/environments/create.tsx` with:

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal, Field, submitJson } from "../lib/modal";

const HOSTS_HINT = "comma or newline separated; supports *.domain.com and * (allow all); empty = all outbound blocked";
const parseHosts = (s: string) => s.split(/[\n,]/).map((h) => h.trim()).filter(Boolean);

function EnvironmentModal({ env, onClose }: { env?: any; onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: env?.name ?? "",
    hosts: (env?.allowed_hosts ?? []).join(", "),
    pkg: env?.allow_package_managers ?? false,
  });

  const submit = async () => {
    setBusy(true); setError(null);
    const err = env
      ? await submitJson("PATCH", `/v1/environments/${env.id}`, {
          name: form.name, allowPackageManagers: form.pkg, allowedHosts: parseHosts(form.hosts) })
      : await submitJson("POST", "/v1/environments", {
          name: form.name, allowPackageManagers: form.pkg, allowedHosts: parseHosts(form.hosts) });
    setBusy(false);
    if (err) setError(err); else { onClose(); router.refresh(); }
  };

  return (
    <Modal title={env ? `Edit environment — ${env.name}` : "Create environment"} width="md"
      onClose={onClose} busy={busy} error={error}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || !form.name} onClick={submit}>
          {busy ? "Saving…" : env ? "Save changes" : "Create environment"}
        </button>
      </>}>
      <Field label="Name" required>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Allowed hosts" stack hint={HOSTS_HINT}>
        <textarea rows={3} value={form.hosts} onChange={(e) => setForm({ ...form, hosts: e.target.value })}
                  placeholder="api.github.com, docs.python.org" />
      </Field>
      <Field label="Packages">
        <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={form.pkg} onChange={(e) => setForm({ ...form, pkg: e.target.checked })} />
          Allow package-manager network access (pip, npm)
        </label>
      </Field>
    </Modal>
  );
}

export function CreateEnvironment() {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}>+ Create environment</button>
    {open && <EnvironmentModal onClose={() => setOpen(false)} />}
  </>);
}

export function EditEnvironmentName({ env }: { env: any }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button className="namebtn" title="Edit environment" onClick={() => setOpen(true)}>{env.name}</button>
    {open && <EnvironmentModal env={env} onClose={() => setOpen(false)} />}
  </>);
}
```

NOTE: this file replaces Task 1's Step-6 hint edit (the constant `HOSTS_HINT` carries the same text). If Task 1 already landed, this rewrite subsumes it — keep the exact hint string.

In `console/app/environments/page.tsx`:

```tsx
import { CreateEnvironment, EditEnvironmentName } from "./create";
```

and change the name cell (line 21) from:

```tsx
              <td>{e.name}</td>
```

to:

```tsx
              <td><EditEnvironmentName env={e} /></td>
```

- [ ] **Step 6: Console production build**

Run: `cd console && npx next build`
Expected: build succeeds, `/environments` compiles.

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/repo.ts control-plane/src/agents-api.ts control-plane/test/agents-api.test.ts console/app/environments/create.tsx console/app/environments/page.tsx
git commit -m "feat(environments): PATCH endpoint + edit modal (name click), squid reload on update"
```

---

### Task 4: API-key soft delete + honest usage labels

**Files:**
- Modify: `control-plane/src/repo.ts` (`deleteApiKey` ~line 505, `listApiKeys` ~line 649, `gatewayUsage` byKey query ~line 385-389)
- Modify: `control-plane/src/agents-api.ts:578-598` (`GET /v1/api-keys` include param)
- Modify: `console/app/usage/api-usage.tsx` (labels + dropdown)
- Modify: `console/app/usage/page.tsx:12` (fetch deleted keys)
- Test: `control-plane/test/agents-api.test.ts`

**Interfaces:**
- Consumes: existing `api_keys.status` column (`active|inactive|archived`, TEXT — no migration for the new `'deleted'` value).
- Produces: `repo.listApiKeys(workspaceId: string, limit = 100, offset = 0, includeDeleted = false)`; `GET /v1/api-keys?include=deleted`; byKey rows gain `status: string | null`. Gateway auth is untouched (requires `status='active'`).

- [ ] **Step 1: Write the failing route test**

In `control-plane/test/agents-api.test.ts`, extend the fake repo:

```ts
    apiKeyCalls: [] as any[],
    async listApiKeys(_ws: string, _limit: number, _offset: number, includeDeleted = false) {
      (this as any).apiKeyCalls.push({ includeDeleted });
      return { rows: [], count: 0 };
    },
```

(If the fake already has `listApiKeys`, add the recording + 4th param to it.) Add tests:

```ts
test("GET /v1/api-keys excludes deleted by default, includes with ?include=deleted", async (t) => {
  const { app, repo } = await build(t);
  await app.inject({ method: "GET", url: "/v1/api-keys" });
  await app.inject({ method: "GET", url: "/v1/api-keys?include=deleted" });
  assert.deepEqual(repo.apiKeyCalls.map((c: any) => c.includeDeleted), [false, true]);
});
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `cd control-plane && npm test`
Expected: new test FAILS (`includeDeleted` is `[false, false]` — route never passes it).

- [ ] **Step 3: Implement CP changes**

`control-plane/src/repo.ts` — replace `deleteApiKey` (line 505-507):

```ts
  /** Soft delete: the row (and its name) survives for usage attribution;
   *  the gateway rejects it immediately (auth requires status='active'). */
  async deleteApiKey(workspaceId: string, id: string) {
    await this.pool.query("UPDATE api_keys SET status = 'deleted' WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  }
```

Replace `listApiKeys` (~line 649-654):

```ts
  async listApiKeys(workspaceId: string, limit = 100, offset = 0, includeDeleted = false) {
    const cond = includeDeleted ? "" : " AND status <> 'deleted'";
    const { rows } = await this.pool.query(
      `SELECT id, name, partial_hint, status, created_at, last_used_at FROM api_keys
       WHERE workspace_id = $1${cond} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [workspaceId, limit, offset]);
    const { rows: c } = await this.pool.query(
      `SELECT count(*)::int AS n FROM api_keys WHERE workspace_id = $1${cond}`, [workspaceId]);
    return { rows, count: c[0].n };
  }
```

In `gatewayUsage` (~line 385-389), change the byKey query to carry status:

```ts
      this.pool.query(
        `SELECT u.api_key_id, k.name, k.status, COALESCE(sum(u.tokens_in),0)::bigint AS tokens_in,
                COALESCE(sum(u.tokens_out),0)::bigint AS tokens_out, count(*)::int AS requests
         FROM gateway_usage u LEFT JOIN api_keys k ON k.id = u.api_key_id
         WHERE ${where} GROUP BY 1, 2, 3 ORDER BY 4 DESC`, params),
```

`control-plane/src/agents-api.ts` — the list route (line 578):

```ts
  app.get("/v1/api-keys", async (req) => {
    const { limit, offset } = pg(req);
    const includeDeleted = (req.query as any)?.include === "deleted";
    const { rows, count } = await repo.listApiKeys(ws(req), limit, offset, includeDeleted);
    return { keys: rows, count, offset };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Console labels + dropdown**

`console/app/usage/page.tsx` line 12 — fetch deleted keys for the filter:

```tsx
  const keys = await wsGet<{ keys: { id: string; name: string; status: string }[] }>("/v1/api-keys?include=deleted").catch(() => ({ keys: [] }));
```

`console/app/usage/api-usage.tsx`:

1. Props/typing — `keys` gains status; byKey gains status:

```tsx
export default function ApiUsage({ deployments, keys }: { deployments: string[]; keys: { id: string; name: string; status?: string }[] }) {
```

```tsx
  byKey: { api_key_id: string | null; name: string | null; status: string | null; tokens_in: number; tokens_out: number; requests: number }[];
```

2. Label rule (line 42-43) becomes:

```tsx
  const keyLabel = (k: { api_key_id: string | null; name: string | null; status: string | null }) =>
    k.api_key_id === null ? "(deleted key)"
      : k.status === "deleted" ? `${k.name ?? k.api_key_id} [deleted]`
      : k.name ?? k.api_key_id;
```

3. Dropdown options (line 57) become:

```tsx
          {keys.map((k) => <option key={k.id} value={k.id}>{k.status === "deleted" ? `${k.name} [deleted]` : k.name}</option>)}
```

(The static `(deleted key)` option on line 58 stays — it filters legacy NULL rows.)

- [ ] **Step 6: Console build + commit**

Run: `cd console && npx next build` — expected success.

```bash
git add control-plane/src/repo.ts control-plane/src/agents-api.ts control-plane/test/agents-api.test.ts console/app/usage/api-usage.tsx console/app/usage/page.tsx
git commit -m "feat(api-keys): soft delete; usage shows 'name [deleted]' instead of losing attribution"
```

---

### Task 5: Files→sessions drill-down + white content boxes

**Files:**
- Modify: `control-plane/src/repo.ts:209-221` (`listSessions` file filter)
- Modify: `control-plane/src/agents-api.ts` (`GET /v1/sessions` ~line 423; new `GET /v1/files/:id` after line 107)
- Modify: `console/app/files/table.tsx:66` (sessions count → link)
- Modify: `console/app/sessions/page.tsx` (file filter + chip)
- Modify: `console/app/globals.css:152` (`pre.block` background)
- Test: `control-plane/test/agents-api.test.ts`

**Interfaces:**
- Consumes: `repo.getFileRecord(id)` (existing, used by the /content route); `session_files (session_id, file_id, role)` join table.
- Produces: `repo.listSessions(workspaceId, agentId?, limit = 100, offset = 0, fileId?)`; `GET /v1/sessions?file=<id>`; `GET /v1/files/:id` → file row / 404 `{error:"file not found"}`.

- [ ] **Step 1: Write the failing route tests**

In `control-plane/test/agents-api.test.ts` — the fake `listSessions` (line 46) must record its args:

```ts
    sessionListCalls: [] as any[],
    async listSessions(_ws: string, agentId?: string, _limit?: number, _offset?: number, fileId?: string) {
      (this as any).sessionListCalls.push({ agentId, fileId });
      return { rows: sessions, count: sessions.length };
    },
```

The fake `getFileRecord` currently returns null (line 84) — keep it, and add tests:

```ts
test("GET /v1/sessions?file= passes the file filter to the repo", async (t) => {
  const { app, repo } = await build(t);
  await app.inject({ method: "GET", url: "/v1/sessions?file=file_abc" });
  assert.equal(repo.sessionListCalls.at(-1).fileId, "file_abc");
});

test("GET /v1/files/:id returns 404 for unknown file", async (t) => {
  const { app } = await build(t);
  const res = await app.inject({ method: "GET", url: "/v1/files/file_missing" });
  assert.equal(res.statusCode, 404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd control-plane && npm test`
Expected: FAIL — `fileId` undefined; `/v1/files/:id` route doesn't exist (Fastify may 404 by accident — assert the error body too if needed: `assert.equal(res.json().error, "file not found")`).

- [ ] **Step 3: Implement CP changes**

`control-plane/src/repo.ts` — replace `listSessions` (lines 209-221):

```ts
  async listSessions(workspaceId: string, agentId?: string, limit = 100, offset = 0, fileId?: string) {
    const conds = ["s.workspace_id = $1"];
    const params: unknown[] = [workspaceId];
    if (agentId) { params.push(agentId); conds.push(`s.agent_id = $${params.length}`); }
    if (fileId) {
      params.push(fileId);
      conds.push(`EXISTS (SELECT 1 FROM session_files sf WHERE sf.session_id = s.id AND sf.file_id = $${params.length})`);
    }
    const where = conds.join(" AND ");
    const { rows } = await this.pool.query(
      { text: `SELECT s.*, a.name AS agent_name FROM sessions s JOIN agents a ON a.id = s.agent_id
               WHERE ${where} ORDER BY s.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        values: [...params, limit, offset] });
    const { rows: c } = await this.pool.query(
      { text: `SELECT count(*)::int AS n FROM sessions s WHERE ${where}`, values: params });
    return { rows, count: c[0].n };
  }
```

`control-plane/src/agents-api.ts` — the sessions list route (line 423-428) becomes:

```ts
  app.get("/v1/sessions", async (req) => {
    const { limit, offset } = pg(req);
    const agent = (req.query as any)?.agent as string | undefined;
    const file = (req.query as any)?.file as string | undefined;
    const { rows, count } = await repo.listSessions(ws(req), agent, limit, offset, file);
    return { sessions: rows, count, offset };
  });
```

(Match the file's current body — keep whatever it already destructures; the only change is reading `file` and passing it as the 5th argument.)

New file-metadata route, after `GET /v1/files` (line 107):

```ts
  app.get("/v1/files/:id", async (req, reply) => {
    const record = await repo.getFileRecord((req.params as any).id);
    if (!record) return reply.code(404).send({ error: "file not found" });
    return record;
  });
```

CAUTION (Fastify routing): `/v1/files/:id` must not shadow `/v1/files/raw` — Fastify prefers static routes over params, so `POST /v1/files/raw` is unaffected (different method anyway) and `GET /v1/files/:id/content` is a longer static suffix that wins. No changes needed, just don't reorder existing routes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Console — link, filter chip, white blocks**

`console/app/files/table.tsx` — add at the top:

```tsx
import Link from "next/link";
```

and change the sessions cell (line 66) from:

```tsx
              <td>{f.session_count}</td>
```

to:

```tsx
              <td>{f.session_count > 0
                ? <Link href={`/sessions?file=${encodeURIComponent(f.id)}`}>{f.session_count}</Link>
                : f.session_count}</td>
```

`console/app/sessions/page.tsx` — replace the component with:

```tsx
export default async function SessionsPage({ searchParams }: { searchParams: Promise<{ page?: string; file?: string }> }) {
  const sp = await searchParams;
  const offset = offsetOf(sp.page);
  const fileQ = sp.file ? `&file=${encodeURIComponent(sp.file)}` : "";
  const [{ sessions, count }, { agents }, { stores }, fileMeta] = await Promise.all([
    wsGet<{ sessions: Session[]; count: number }>(`/v1/sessions?offset=${offset}${fileQ}`),
    wsGet<{ agents: any[] }>("/v1/agents"),
    wsGet<{ stores: any[] }>("/v1/memory-stores"),
    sp.file ? wsGet<{ name: string }>(`/v1/files/${sp.file}`).catch(() => null) : Promise.resolve(null),
  ]);
  return (
    <>
      <div className="pagehead"><h1>Sessions</h1><CreateSession agents={agents} memoryStores={stores.map((s: any) => ({ id: s.id, name: s.name }))} /></div>
      <p className="sub">
        Trace and debug agent sessions. <RefreshButton />
        {sp.file && (
          <span className="chip" style={{ marginLeft: 10 }}>
            file: {fileMeta?.name ?? sp.file} <Link href="/sessions" style={{ marginLeft: 4 }}>×</Link>
          </span>
        )}
      </p>
```

(The rest of the component — table, Pager — is unchanged; keep it verbatim. `Link` is already imported at the top of this file.)

Note on the Pager: `Pager` builds `?page=N` links that drop the `file` param — page 2 of a filtered list loses the filter. Filtered lists are ≤ a handful of sessions in practice; accept this (do NOT modify the shared Pager for this).

`console/app/globals.css` line 152 — change:

```css
pre.block { background: var(--paper); border: 1px solid var(--line); border-radius: 8px; padding: 14px;
```

to:

```css
pre.block { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px;
```

- [ ] **Step 6: Console build + commit**

Run: `cd console && npx next build` — expected success.

```bash
git add control-plane/src/repo.ts control-plane/src/agents-api.ts control-plane/test/agents-api.test.ts console/app/files/table.tsx console/app/sessions/page.tsx console/app/globals.css
git commit -m "feat(console): files→sessions drill-down, GET /v1/files/:id, white content boxes"
```

---

### Task 6: Runner image dev15 — tools, requests, WebFetch preflight off

**Files:**
- Modify: `session-runner/Dockerfile`
- Modify: `session-runner/runner.py` (write settings in `main()`, ~line 258)
- Modify: `CLAUDE.md` (runner tag + tools note)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: image `devproof/session-runner:dev15`. The controller builds/loads it and restarts the CP with `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev15` — the implementer subagent must NOT build images or restart servers; code + docs only.

- [ ] **Step 1: Dockerfile changes**

In `session-runner/Dockerfile`, replace:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm ca-certificates \
    && rm -rf /var/lib/apt/lists/*
```

with:

```dockerfile
# Node for the legacy runner's bundled CLI; plus file-analysis CLI tools (archives,
# curl, jq) so agents don't need pip/apt at runtime for everyday data work.
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm ca-certificates \
    unzip zip gzip bzip2 xz-utils p7zip-full file jq curl \
    && rm -rf /var/lib/apt/lists/*
```

and replace:

```dockerfile
RUN pip install --no-cache-dir numpy pandas matplotlib seaborn scipy openpyxl pyarrow
```

with:

```dockerfile
RUN pip install --no-cache-dir numpy pandas matplotlib seaborn scipy openpyxl pyarrow requests
```

- [ ] **Step 2: runner.py — disable the WebFetch phone-home**

In `session-runner/runner.py`, inside `main()` directly after `restore_checkpoint()` (line 258), insert:

```python
    # WebFetch pre-checks every hostname against api.anthropic.com before
    # fetching; locked-down environments block that, failing ALL WebFetches
    # (and it leaks fetched hostnames). The Squid allowlist is the real
    # control, so turn the pre-check off. setting_sources=["project"] makes
    # the legacy runtime load this file.
    os.makedirs("<cli-settings-dir>", exist_ok=True)  # historical: the legacy CLI runtime's /work settings dir
    with open("<cli-settings-dir>/settings.json", "w") as f:
        json.dump({"skipWebFetchPreflight": True}, f)
```

(`os` and `json` are already imported at the top of runner.py.)

- [ ] **Step 3: CLAUDE.md**

In the repo-root `CLAUDE.md`, update the session-runner bullet: change `(current `dev14`; ships numpy/pandas/matplotlib/seaborn/scipy/openpyxl/pyarrow preinstalled)` to `(current `dev15`; ships numpy/pandas/matplotlib/seaborn/scipy/openpyxl/pyarrow/requests + unzip/zip/gzip/bzip2/xz/7z/file/jq/curl preinstalled; disables the WebFetch anthropic.com preflight — the egress allowlist is the only fetch control)`. Also update the `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev14` line in the run commands to `dev15`.

- [ ] **Step 4: Commit**

```bash
git add session-runner/Dockerfile session-runner/runner.py CLAUDE.md
git commit -m "feat(runner): dev15 — archive/analysis tools, requests, skipWebFetchPreflight"
```

- [ ] **Step 5 (CONTROLLER, not subagent): build + load + smoke**

```bash
docker build -t devproof/session-runner:dev15 session-runner
# multi-node cluster: load onto all nodes the same way dev14 was loaded
# (check: kind get clusters → kind load docker-image devproof/session-runner:dev15 --name <cluster>)
docker run --rm --entrypoint sh devproof/session-runner:dev15 -c \
  "command -v unzip zip gzip bzip2 xz 7z file jq curl && python -c 'import requests; print(requests.__version__)'"
```

Expected: all commands found + a requests version printed. CP restart with the new tag happens in Task 8.

---

### Task 7: Gateway warmup for newly-routed local models

**Files:**
- Modify: `control-plane/src/gateway-config.ts` (add `newlyRouted` helper)
- Modify: `control-plane/src/server.ts:28-32` (`syncGateway` fires warmups)
- Test: `control-plane/test/gateway-config.test.ts` (extend if it exists, else create)

**Interfaces:**
- Consumes: `buildGatewayConfig(deployments, externals)` and its `DeploymentLike` type (both in gateway-config.ts); `process.env.DEVPROOF_INTERNAL_KEY` (set by main.ts before buildServer).
- Produces: `export function newlyRouted(routed: Set<string>, deployments: DeploymentLike[]): string[]` — returns names that just became Ready-with-endpoint and updates the set (adds new, drops gone). New env: `DEVPROOF_GATEWAY_LOCAL_URL` (default `http://127.0.0.1:14000`).

- [ ] **Step 1: Write the failing test**

Check whether `control-plane/test/gateway-config.test.ts` exists; extend or create with:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { newlyRouted } from "../src/gateway-config.ts";

const dep = (name: string, phase: string, endpoint = "http://x:8080") =>
  ({ metadata: { name }, status: { phase, endpoint } }) as any;

test("newlyRouted returns fresh Ready deployments once", () => {
  const routed = new Set<string>();
  assert.deepEqual(newlyRouted(routed, [dep("m1", "Ready"), dep("m2", "Deploying")]), ["m1"]);
  assert.deepEqual(newlyRouted(routed, [dep("m1", "Ready"), dep("m2", "Deploying")]), []);
});

test("a deployment that drops out of Ready re-warms when it returns", () => {
  const routed = new Set<string>();
  newlyRouted(routed, [dep("m1", "Ready")]);
  newlyRouted(routed, [dep("m1", "Deploying")]);   // not ready → forgotten
  assert.deepEqual(newlyRouted(routed, [dep("m1", "Ready")]), ["m1"]);
});

test("Ready without endpoint is not routed", () => {
  const routed = new Set<string>();
  assert.deepEqual(newlyRouted(routed, [dep("m1", "Ready", "")]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npx tsx --test test/gateway-config.test.ts`
Expected: FAIL — `newlyRouted` is not exported.

- [ ] **Step 3: Implement the helper**

In `control-plane/src/gateway-config.ts`, add (after `buildGatewayConfig`):

```ts
/** Tracks the ready-routed set across gateway syncs; returns the names that
 *  just became routed (Ready + endpoint) so the caller can warm them. A name
 *  that leaves the ready set is forgotten, so a re-deploy re-warms. */
export function newlyRouted(routed: Set<string>, deployments: DeploymentLike[]): string[] {
  const ready = new Set(
    deployments.filter((d) => d.status?.phase === "Ready" && d.status?.endpoint).map((d) => d.metadata.name),
  );
  const fresh = [...ready].filter((n) => !routed.has(n));
  for (const n of routed) if (!ready.has(n)) routed.delete(n);
  for (const n of fresh) routed.add(n);
  return fresh;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd control-plane && npx tsx --test test/gateway-config.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Wire warmup into syncGateway**

In `control-plane/src/server.ts`, update the gateway-config import to include `newlyRouted` (the file already imports `buildGatewayConfig` — add to that import statement). Then replace lines 28-32:

```ts
  const syncGateway = async () => {
    const deployments = await store.list("modeldeployments");
    const config = buildGatewayConfig(deployments, externals ? await externals.listAll() : []);
    return store.writeGatewayConfig(config);
  };
```

with:

```ts
  // First request to a fresh model pays graph/buffer allocation; warm each
  // newly-routed deployment through the gateway (the only path reachable
  // from an out-of-cluster CP). Retries cover the gateway's config-reload
  // restart. Warmups meter as source='session' (~8 tokens, invisible to
  // billing). After a CP restart every ready model re-warms once — harmless.
  const routedModels = new Set<string>();
  const warmDeployment = async (name: string) => {
    const gw = process.env.DEVPROOF_GATEWAY_LOCAL_URL ?? "http://127.0.0.1:14000";
    for (let attempt = 1; attempt <= 12; attempt++) {
      try {
        const res = await fetch(`${gw}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.DEVPROOF_INTERNAL_KEY ?? "none"}` },
          body: JSON.stringify({ model: name, messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
          signal: AbortSignal.timeout(120_000),
        });
        if (res.ok) { console.log(`warmup: ${name} ready (attempt ${attempt})`); return; }
      } catch { /* gateway restarting or model still routing — retry */ }
      await new Promise((r) => setTimeout(r, 10_000));
    }
    console.warn(`warmup: ${name} never answered — first real request will pay the cold start`);
  };
  const syncGateway = async () => {
    const deployments = await store.list("modeldeployments");
    const config = buildGatewayConfig(deployments, externals ? await externals.listAll() : []);
    const changed = await store.writeGatewayConfig(config);
    for (const name of newlyRouted(routedModels, deployments)) void warmDeployment(name);
    return changed;
  };
```

- [ ] **Step 6: Full check + commit**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: PASS.

```bash
git add control-plane/src/gateway-config.ts control-plane/src/server.ts control-plane/test/gateway-config.test.ts
git commit -m "feat(gateway): warm newly-routed local models through the gateway on sync"
```

---

### Task 8: Live verification gates + remaining docs (CONTROLLER runs this — no subagent)

**Files:**
- Modify: `CLAUDE.md` (egress semantics, key soft-delete, warmup notes)

**Steps (all against the live docker-desktop cluster, CP restarted with `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev15` and console rebuilt):**

- [ ] 1. Restart CP + console with new code/tag; all pages 200.
- [ ] 2. `kubectl get deploy,svc,cm,networkpolicy -n devproof-agents | grep env-none` — the deny-all egress exists; `kubectl get cm egress-env-none -o jsonpath='{.data.squid\.conf}'` contains `http_access deny all` and NO allow.
- [ ] 3. No-env session: create agent without environment, prompt it to `curl -sS -m 10 https://example.com` and `pip install left-pad || pip download requests` — both must FAIL (proxy denial); model reply + output-file publishing must WORK; session panel shows "No environment — all outbound blocked".
- [ ] 4. Dremio env session (env `pip and docs.dremio.com`): prompt WebFetch for `https://docs.dremio.com/current/get-started/` → SUCCEEDS (no "unable to verify" — preflight is off, proxy allows); WebFetch `https://docs.crewai.com/...` → fails with a network/proxy error, NOT "unable to verify". `unzip --help`, `jq --version`, `python -c "import requests"` all work in-session.
- [ ] 5. Wildcards: edit that environment (console modal, name click) → hosts `*.dremio.com`; verify Squid ConfigMap updates to `.dremio.com` and the proxy pod restarts; in-session `curl https://docs.dremio.com` still works. Then set hosts `*` → `curl https://example.com` works.
- [ ] 6. Key soft delete: create key, send one gateway request, DELETE the key → 401 within ~30s; Usage page shows `<name> [deleted]` in By-API-key and in the filter dropdown; legacy "(deleted key)" rows unchanged.
- [ ] 7. Files → click a sessions count → `/sessions?file=…` shows only attached sessions + chip with file name; × clears.
- [ ] 8. White boxes: skill viewer, memory-store browser, session panels, trace previews — `pre.block` white in light mode.
- [ ] 9. Warmup measurement: `kubectl rollout restart deploy/qwen05b-dp -n devproof-serving` (or redeploy via console), watch CP logs for `warmup: qwen05b-dp ready`; then time first real request vs second (same prompt, fresh prefix). Record numbers. If a large gap remains on big prompts (prefill-bound), add the documented note (CLAUDE.md + deployment Overview hint) per spec E.
- [ ] 10. `cd control-plane && npm test && npx tsc --noEmit` on the final tree; console production build; backend + console restarted; all pages 200.
- [ ] 11. Update `CLAUDE.md`: egress bullet gains wildcard semantics + env_none default-deny; add API-key soft-delete note (delete = status 'deleted', names survive for usage); gateway bullet gains warmup-on-sync note. Commit docs.

```bash
git add CLAUDE.md
git commit -m "docs: egress wildcards + env_none lockdown, key soft-delete, gateway warmup notes"
```

---

## Self-Review Notes

- **Spec coverage:** A→Task 6; B wildcards→Task 1, B lockdown→Task 2; C→Task 3; D→Task 4; E→Task 7 + gate 9 (evidence-gated doc); F blocks→Task 5, F drill-down→Task 5; verification section→Tasks 1/3/4/5/7 tests + Task 8 gates. CLAUDE.md updates split: runner tag in Task 6, the rest in Task 8.
- **Known interactions:** Task 3's create.tsx rewrite subsumes Task 1's hint edit (same string, noted in both). Task 2's `env_none` id intentionally never collides with DB ids (`rid("env")` generates `env_<hex>`; literal `env_none` is reserved by convention).
- **Type consistency:** `squidConf(hosts, allowPackageManagers)` (T1) used only inside orchestrator; `updateEnvironment(ws, id, patch)` returns snake_case row (T3 route maps to camelCase for `ensureEnvironmentPolicy`); `listApiKeys(ws, limit, offset, includeDeleted)` (T4) matches route call; `listSessions(ws, agentId?, limit, offset, fileId?)` (T5) — the other existing call site (`agents-api.ts:357`, agent-scoped session list) passes only 2 args and is unaffected; `newlyRouted(Set, DeploymentLike[])` (T7) matches test + server.ts usage.
- **Deliberate scope cuts:** Pager drops the `file` param on page links (accepted, noted in T5); no dedupe/validation of host strings beyond trimming (Squid tolerates); `GET /v1/files/:id` is workspace-unscoped like the existing `/content` route.
