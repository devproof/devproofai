# Console Dialog & Edit Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every browser `prompt()/confirm()/alert()` and bespoke overlay in the console with shared `Modal`/`Field`/`ConfirmDialog` primitives; make deployments/models/pools editable by clicking their name; make agents editable (new version); add a Pools page for K8s node selectors; add catalog PATCH with bundled-model DB overrides.

**Architecture:** Spec: `docs/superpowers/specs/2026-07-09-console-dialog-rework-design.md`. Backend first (2 small route tasks, TDD with the existing `fakeStore`/`app.inject` pattern), then a shared client-side dialog layer in `console/app/lib/modal.tsx` + CSS, then mechanical migration of every dialog. The bundled-model override needs no new persistence: `fullCatalog()` already lets DB rows shadow YAML by id, and the `catalog_models` insert is an upsert.

**Tech Stack:** Fastify + Node test runner (`app.inject`, fakes — no live cluster in tests), Next.js 15 App Router (server pages + `"use client"` islands), hand-rolled CSS in `globals.css` (no component library).

## Global Constraints

- Console must always be verified with a **production build** (`npx next build` in `console/`); dev mode is banned in this repo.
- After the final task, `grep -rnE "confirm\(|prompt\(|alert\("` under `console/app` must return **zero hits**.
- Do NOT export server-callable helpers from a `"use client"` module (`offsetOf` stays in `lib/api.ts`).
- Backend tests: **stop any running control-plane process first** (it contends with `npm test` on the shared dev Postgres → 30s timeout on gatewayUsage).
- Every list endpoint keeps the `{rows-alias, count, offset}` shape; every ID is immutable.
- IDs mirror Anthropic (`wrkspc_/apikey_/…`); deployment/pool names are DNS-1035 slugs (`/^[a-z]([-a-z0-9]*[a-z0-9])?$/`, ≤63 chars).
- All work happens on `main` (repo convention: feature work merges to main same-day; keep commits per task).
- Go is at `~/sdk/go/bin` (not on PATH) — only needed if you touch the operator (this plan does not).

## File Structure (what's created/changed)

| File | Role |
|---|---|
| `control-plane/src/server.ts` | + `PATCH /v1/catalog/:id`, `overridden` flag, typed `POST /v1/pools`, `PATCH/DELETE /v1/pools/:name` |
| `control-plane/test/server.test.ts` | + `fakeCustom()`, catalog PATCH tests, pools tests, fakeStore.patch null-key emulation |
| `console/app/lib/modal.tsx` | **new** — `Modal`, `Field`, `ConfirmDialog`, `submitJson` |
| `console/app/globals.css` | + `.modal-*`, `.field*`, `.checklist`, `.kvrow*`, `.profile-*`, `button.namebtn` |
| `console/app/lib/delete.tsx` | `DeleteButton` → `ConfirmDialog` internally (14 call sites untouched) |
| `console/app/actions.tsx` | undeploy → `ConfirmDialog` |
| `console/app/files/table.tsx` | bulk delete → `ConfirmDialog` |
| `console/app/deployments/deploy-modal.tsx` | rebuild on `Modal`/`Field`; `EditDeploymentButton` → `EditDeploymentName` (name click); "Add remote endpoint" |
| `console/app/deployments/page.tsx` | name cell opens edit; pen icon gone |
| `console/app/catalog/model-modal.tsx` | **new** — shared add/edit model form, capacity-profile rows, Reset to defaults |
| `console/app/catalog/create.tsx` | **deleted** (replaced by model-modal) |
| `console/app/catalog/page.tsx` | name click opens edit; `overridden` chip |
| `console/app/pools/page.tsx`, `console/app/pools/pool-modal.tsx` | **new** — Pools page + create/edit modal (nodeSelector k=v rows) |
| `console/app/nav.tsx` | + Pools nav item; workspace `prompt()` → modal |
| `console/app/lib/icons.tsx` | + `pool` icon |
| `console/app/agents/agent-form.tsx` | **new** — shared create/edit agent modal (skills checkboxes) |
| `console/app/agents/create.tsx` | **deleted** (replaced by agent-form) |
| `console/app/agents/page.tsx`, `console/app/agents/[id]/page.tsx` | use new form; Edit button on detail page |
| `console/app/api-keys/create.tsx` | name modal + non-dismissible copy modal with clipboard button |
| `console/app/skills/create.tsx` | picker + name modal |
| `console/app/memory-stores/create.tsx`, `console/app/memory-stores/[id]/browser.tsx` | name/path modals; delete → ConfirmDialog |
| `console/app/sessions/create.tsx`, `console/app/batches/create.tsx`, `console/app/environments/create.tsx`, `console/app/vaults/create.tsx` | migrate to `Modal`/`Field` |
| `console/app/vaults/[id]/credentials.tsx`, `console/app/files/upload.tsx`, `console/app/sessions/[id]/trace.tsx` | `alert()` → inline error text |
| `CLAUDE.md` | one convention line about the dialog system |

---

### Task 1: Backend — `PATCH /v1/catalog/:id` + `overridden` flag

**Files:**
- Modify: `control-plane/src/server.ts` (fullCatalog ~line 44, GET /v1/catalog ~line 53, POST /v1/deployments ~line 149; new PATCH route after DELETE /v1/catalog/:id ~line 93)
- Test: `control-plane/test/server.test.ts`

**Interfaces:**
- Consumes: `CustomCatalog.create` (which is an upsert: `repo.ts:514` `ON CONFLICT (id) DO UPDATE`), `fullCatalog()` merge (DB wins on id clash).
- Produces: `PATCH /v1/catalog/:id` accepting `Partial<CatalogEntry>` minus `id`; `GET /v1/catalog` entries gain `overridden: boolean`. The console (Task 6) relies on both, and on `DELETE /v1/catalog/:id` reverting an override.

- [ ] **Step 1: Write the failing tests**

Append to `control-plane/test/server.test.ts`:

```ts
function fakeCustom() {
  const rows: any[] = [];
  return {
    async list() { return [...rows]; },
    // Mirrors repo.ts createCatalogModel: INSERT … ON CONFLICT (id) DO UPDATE (an upsert).
    async create(e: any) {
      const i = rows.findIndex((r) => r.id === e.id);
      if (i >= 0) rows[i] = e; else rows.push(e);
      return e;
    },
    async delete(id: string) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
  };
}

test("PATCH /v1/catalog/:id updates a custom model in place", async () => {
  const app = buildServer(catalog, fakeStore().store, fakeCustom());
  await app.inject({ method: "POST", url: "/v1/catalog",
    payload: { id: "my-model-custom", displayName: "My Model", source: "https://hf.co/x.gguf", format: "gguf" } });
  const res = await app.inject({ method: "PATCH", url: "/v1/catalog/my-model-custom",
    payload: { displayName: "My Model v2", contextTokens: 8192 } });
  assert.equal(res.statusCode, 200);
  const { models } = (await app.inject({ method: "GET", url: "/v1/catalog" })).json();
  const m = models.find((x: any) => x.id === "my-model-custom");
  assert.equal(m.displayName, "My Model v2");
  assert.equal(m.contextTokens, 8192);
  assert.equal(m.custom, true);
  assert.equal(!!m.overridden, false);
  assert.equal(m.source, "https://hf.co/x.gguf"); // untouched fields preserved
});

test("PATCH bundled id creates a DB override; DELETE resets to YAML", async () => {
  const id = "qwen2.5-0.5b-instruct-q4";
  const orig = catalog.find((e) => e.id === id)!;
  const app = buildServer(catalog, fakeStore().store, fakeCustom());
  const res = await app.inject({ method: "PATCH", url: `/v1/catalog/${id}`,
    payload: { displayName: "Qwen (site override)", capacityProfiles: [
      { gpuType: "nvidia-a100", instanceType: "p4d.24xlarge", gpusPerReplica: 1, vramGB: 40, estTokensPerSec: 90, costPerHourUSD: 4.1 },
    ] } });
  assert.equal(res.statusCode, 200);
  let { models } = (await app.inject({ method: "GET", url: "/v1/catalog" })).json();
  let m = models.find((x: any) => x.id === id);
  assert.equal(m.displayName, "Qwen (site override)");
  assert.equal(m.overridden, true);
  assert.equal(m.custom, false);                       // bundled origin, not user-added
  assert.equal(m.source, orig.source);                 // unpatched fields come from YAML
  assert.equal(m.capacityProfiles[0].gpuType, "nvidia-a100");

  const del = await app.inject({ method: "DELETE", url: `/v1/catalog/${id}` });
  assert.equal(del.statusCode, 204);
  ({ models } = (await app.inject({ method: "GET", url: "/v1/catalog" })).json());
  m = models.find((x: any) => x.id === id);
  assert.equal(m.displayName, orig.displayName);       // YAML entry reappears
  assert.equal(!!m.overridden, false);
});

test("PATCH /v1/catalog validation: 404 unknown, 400 immutable id, 501 without custom store", async () => {
  const app = buildServer(catalog, fakeStore().store, fakeCustom());
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/catalog/nope", payload: { displayName: "x" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/catalog/qwen2.5-0.5b-instruct-q4", payload: { id: "new-id" } })).statusCode, 400);
  const noCustom = buildServer(catalog, fakeStore().store);
  assert.equal((await noCustom.inject({ method: "PATCH", url: "/v1/catalog/qwen2.5-0.5b-instruct-q4", payload: { displayName: "x" } })).statusCode, 501);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd control-plane && node --test test/server.test.ts
```
Expected: the three new tests FAIL (PATCH route missing → 404 where 200 expected; `overridden` undefined where true expected). Pre-existing tests PASS.

- [ ] **Step 3: Implement**

In `control-plane/src/server.ts`:

(a) Document the upsert on the interface (top of file):

```ts
export interface CustomCatalog {
  list(): Promise<CatalogEntry[]>;
  /** Upsert (repo backs this with ON CONFLICT (id) DO UPDATE) — also used for edits and bundled-model overrides. */
  create(entry: CatalogEntry): Promise<CatalogEntry>;
  delete(id: string): Promise<void>;
}
```

(b) Replace `fullCatalog` (line ~44) so callers can tell DB rows apart, and add a bundled-id set:

```ts
  const bundledIds = new Set(bundled.map((b) => b.id));
  // Bundled YAML entries + DB entries (DB wins on id clash — custom models AND bundled overrides).
  const fullCatalog = async (): Promise<{ entries: CatalogEntry[]; dbIds: Set<string> }> => {
    const extra = custom ? await custom.list() : [];
    const dbIds = new Set(extra.map((e) => e.id));
    return { entries: [...extra, ...bundled.filter((b) => !dbIds.has(b.id))], dbIds };
  };
```

(c) Update `GET /v1/catalog` (line ~53) to destructure and emit both flags:

```ts
  app.get("/v1/catalog", async (req) => {
    const { entries: catalog, dbIds } = await fullCatalog();
    const items = await store.list("modeldeployments");
    const deployments = items.map((d: any) => ({ name: d.metadata.name, catalogId: d.spec?.catalogId }));
    const observed = observedByCatalogId(deployments, await fetchPeakThroughput());
    const models = catalog.map((m) => ({
      ...m,
      custom: dbIds.has(m.id) && !bundledIds.has(m.id),
      overridden: dbIds.has(m.id) && bundledIds.has(m.id),
      observedTokensPerSec: observed[m.id] ?? null,
    }));
    const { rows, count, offset } = paged(models, req);
    return { models: rows, count, offset };
  });
```

(d) Update `POST /v1/deployments` (line ~149): `cr = resolveDeployment((await fullCatalog()).entries, b);`

(e) Add the PATCH route directly after `DELETE /v1/catalog/:id`:

```ts
  app.patch("/v1/catalog/:id", async (req, reply) => {
    if (!custom) return reply.code(501).send({ error: "custom catalog not enabled" });
    const id = (req.params as any).id;
    const b = (req.body ?? {}) as Partial<CatalogEntry>;
    const allowed = new Set(["displayName", "family", "parameters", "format", "quantization", "source",
      "license", "recommendedEngine", "toolCalling", "contextTokens", "requirements", "capacityProfiles"]);
    const extra = Object.keys(b).filter((k) => !allowed.has(k));
    if (extra.length) return reply.code(400).send({ error: `not editable: ${extra.join(", ")}` });
    const current = (await fullCatalog()).entries.find((e) => e.id === id);
    if (!current) return reply.code(404).send({ error: "unknown catalog entry" });
    // Merge over the effective entry (YAML or prior override) and upsert — bundled ids become DB overrides.
    return custom.create({ ...current, ...b, id } as CatalogEntry);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

```
cd control-plane && node --test test/server.test.ts && npx tsc --noEmit
```
Expected: all PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat(catalog): PATCH /v1/catalog/:id — edit custom models, DB-override bundled ones"
```

---

### Task 2: Backend — typed pools API (validated POST, PATCH, guarded DELETE)

**Files:**
- Modify: `control-plane/src/server.ts` (replace `POST /v1/pools` line ~110; add PATCH/DELETE after it)
- Test: `control-plane/test/server.test.ts` (also extend `fakeStore.patch`)

**Interfaces:**
- Consumes: `kubestore.patch("modelpools", name, {spec})` (`kubestore.ts:53`). **First verify** `kubestore.ts` patch uses `application/merge-patch+json` (RFC 7386) — read the function; the deployments PATCH already relies on merge semantics. If it were JSON-Patch instead, stop and flag.
- Produces (Task 7 relies on these): `POST /v1/pools {name, nodeSelector?, gpuType?, gpusPerNode?, maxNodes?, scalingMode?}` → 201 CR; `PATCH /v1/pools/:name` same body minus name → `{name, spec}` with **full nodeSelector replacement** (removed keys really gone); `DELETE /v1/pools/:name` → 204, or 409 `{error}` naming the deployments that use it; `GET /v1/pools` (unchanged) → `{pools: ModelPool CRs}`.

- [ ] **Step 1: Extend fakeStore.patch to emulate merge-patch null-deletion**

In `fakeStore()` in `server.test.ts`, replace the `patch` method:

```ts
    async patch(plural, name, body) {
      const obj = objects[plural].find((o) => o.metadata.name === name);
      if (!obj) throw Object.assign(new Error("not found"), { code: 404 });
      const prevSelector = obj.spec?.nodeSelector;
      // shallow-merge spec like a JSON merge patch (sufficient for tests)
      obj.spec = { ...obj.spec, ...body.spec, model: { ...obj.spec?.model, ...body.spec?.model } };
      // RFC 7386 for maps: keys merge, null values delete (pool nodeSelector replacement relies on this)
      if (body.spec?.nodeSelector) {
        const merged: Record<string, any> = { ...prevSelector, ...body.spec.nodeSelector };
        obj.spec.nodeSelector = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null));
      }
      return obj;
    },
```

- [ ] **Step 2: Write the failing tests**

```ts
test("POST /v1/pools validates DNS-1035 name and writes a typed spec", async () => {
  const { store, objects } = fakeStore();
  const app = buildServer(catalog, store);
  assert.equal((await app.inject({ method: "POST", url: "/v1/pools", payload: { name: "My Pool" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/v1/pools", payload: { name: "ok", scalingMode: "elastic" } })).statusCode, 400);
  const res = await app.inject({ method: "POST", url: "/v1/pools", payload: {
    name: "gpu-a100", nodeSelector: { "devproof.ai/pool": "gpu-a100" },
    gpuType: "nvidia-a100", gpusPerNode: 4, maxNodes: 8, scalingMode: "dynamic",
  } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(objects.modelpools[0].spec, {
    nodeSelector: { "devproof.ai/pool": "gpu-a100" },
    gpuType: "nvidia-a100", gpusPerNode: 4, maxNodes: 8, scalingMode: "dynamic",
  });
});

test("PATCH /v1/pools/:name fully replaces nodeSelector and merges capacity fields", async () => {
  const { store, objects } = fakeStore();
  objects.modelpools.push({ metadata: { name: "p1", namespace: "devproof-serving" },
    spec: { nodeSelector: { a: "1", b: "2" }, gpuType: "cpu", maxNodes: 2 } });
  const app = buildServer(catalog, store);
  const res = await app.inject({ method: "PATCH", url: "/v1/pools/p1",
    payload: { nodeSelector: { a: "9" }, maxNodes: 3 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(objects.modelpools[0].spec.nodeSelector, { a: "9" });  // b removed
  assert.equal(objects.modelpools[0].spec.maxNodes, 3);
  assert.equal(objects.modelpools[0].spec.gpuType, "cpu");                 // untouched
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/pools/nope", payload: {} })).statusCode, 404);
});

test("DELETE /v1/pools/:name is guarded by referencing deployments", async () => {
  const { store, objects } = fakeStore();
  objects.modelpools.push({ metadata: { name: "p1", namespace: "devproof-serving" }, spec: {} });
  objects.modeldeployments.push({ metadata: { name: "dep1", namespace: "devproof-serving" },
    spec: { poolRef: "p1" }, status: {} });
  const app = buildServer(catalog, store);
  const blocked = await app.inject({ method: "DELETE", url: "/v1/pools/p1" });
  assert.equal(blocked.statusCode, 409);
  assert.match(blocked.json().error, /dep1/);
  objects.modeldeployments.length = 0;
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/pools/p1" })).statusCode, 204);
  assert.equal(objects.modelpools.length, 0);
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/pools/p1" })).statusCode, 404);
});
```

- [ ] **Step 3: Run tests to verify they fail**

```
cd control-plane && node --test test/server.test.ts
```
Expected: 3 new tests FAIL (old POST accepts any name via `{name, spec}` body; PATCH/DELETE routes 404).

- [ ] **Step 4: Implement**

Replace `POST /v1/pools` (line ~110) and add the two routes:

```ts
  const DNS1035 = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
  type PoolBody = { nodeSelector?: Record<string, string>; gpuType?: string;
                    gpusPerNode?: number; maxNodes?: number; scalingMode?: string };
  const poolSpecOf = (b: PoolBody, reply: any): Record<string, unknown> | null => {
    if (b.scalingMode && !["dynamic", "static"].includes(b.scalingMode)) {
      reply.code(400).send({ error: "scalingMode must be dynamic or static" });
      return null;
    }
    const spec: Record<string, unknown> = {};
    if (b.nodeSelector !== undefined) spec.nodeSelector = b.nodeSelector;
    if (b.gpuType !== undefined) spec.gpuType = b.gpuType;
    if (typeof b.gpusPerNode === "number") spec.gpusPerNode = b.gpusPerNode;
    if (typeof b.maxNodes === "number") spec.maxNodes = b.maxNodes;
    if (b.scalingMode !== undefined) spec.scalingMode = b.scalingMode;
    return spec;
  };

  app.post("/v1/pools", async (req, reply) => {
    const b = req.body as { name?: string } & PoolBody;
    if (!b?.name || b.name.length > 63 || !DNS1035.test(b.name))
      return reply.code(400).send({ error: "name must be DNS-1035: lowercase letters, digits, dashes; start with a letter" });
    const spec = poolSpecOf(b, reply);
    if (!spec) return;
    const created = await store.create("modelpools", {
      apiVersion: "serving.devproof.ai/v1alpha1",
      kind: "ModelPool",
      metadata: { name: b.name, namespace: "devproof-serving" },
      spec,
    });
    return reply.code(201).send(created);
  });

  app.patch("/v1/pools/:name", async (req, reply) => {
    const name = (req.params as any).name;
    const current = await store.get("modelpools", name);
    if (!current) return reply.code(404).send({ error: "not found" });
    const spec = poolSpecOf((req.body ?? {}) as PoolBody, reply);
    if (!spec) return;
    if (spec.nodeSelector) {
      // Full replacement under RFC 7386: null out keys the new selector drops.
      const nulls = Object.fromEntries(
        Object.keys(current.spec?.nodeSelector ?? {}).map((k) => [k, null]));
      spec.nodeSelector = { ...nulls, ...(spec.nodeSelector as Record<string, string>) };
    }
    const patched = await store.patch("modelpools", name, { spec });
    return { name, spec: patched.spec };
  });

  app.delete("/v1/pools/:name", async (req, reply) => {
    const name = (req.params as any).name;
    if (!(await store.get("modelpools", name))) return reply.code(404).send({ error: "not found" });
    const users = (await store.list("modeldeployments"))
      .filter((d: any) => d.spec?.poolRef === name).map((d: any) => d.metadata.name);
    if (users.length)
      return reply.code(409).send({ error: `pool "${name}" is used by: ${users.join(", ")} — undeploy first` });
    await store.delete("modelpools", name);
    return reply.code(204).send();
  });
```

- [ ] **Step 5: Run the full backend suite**

```
cd control-plane && npm test && npx tsc --noEmit
```
Expected: all PASS (control plane must not be running — shared Postgres). If `gatewayUsage` times out or hits ECONNRESET, restart the Postgres tunnel: `kubectl rollout restart deployment/postgres -n devproof-system` (known dev-env flake, not your change).

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat(pools): typed POST validation, PATCH nodeSelector/capacity, guarded DELETE"
```

---

### Task 3: Console primitives — `Modal`, `Field`, `ConfirmDialog`, `submitJson` + CSS

**Files:**
- Create: `console/app/lib/modal.tsx`
- Modify: `console/app/globals.css` (append one block at the end)

**Interfaces:**
- Consumes: `wsHeader()` from `console/app/lib/client.ts`.
- Produces (every later task relies on these EXACT signatures):
  - `Modal({title, subtitle?, width?: "sm"|"md"|"lg", onClose, dismissible?, busy?, error?: string|null, footer?, children})`
  - `Field({label, hint?, required?, stack?, children})` — `stack` = full-width control (textareas, checklists)
  - `ConfirmDialog({title, message, verb?, onConfirm: () => Promise<string|null>, onClose})` — `onConfirm` returns an error string (dialog stays open, shows it) or `null` (dialog closes)
  - `submitJson(method, path, body?) => Promise<string|null>` — error string or null; adds `/api` prefix + workspace header

- [ ] **Step 1: Create `console/app/lib/modal.tsx`**

```tsx
"use client";
// Shared dialog primitives (spec 2026-07-09). Every create/edit/confirm flow
// in the console uses these — browser prompt()/confirm()/alert() are banned.
import { useEffect, useRef, useState } from "react";
import { wsHeader } from "./client";

export function Modal({ title, subtitle, width = "md", onClose, dismissible = true, busy = false,
                        error, footer, children }: {
  title: string; subtitle?: string; width?: "sm" | "md" | "lg"; onClose: () => void;
  dismissible?: boolean; busy?: boolean; error?: string | null;
  footer?: React.ReactNode; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && dismissible && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismissible, busy, onClose]);
  useEffect(() => { ref.current?.querySelector<HTMLElement>("input, select, textarea")?.focus(); }, []);
  return (
    <div className="modal-overlay"
         onMouseDown={(e) => { if (e.target === e.currentTarget && dismissible && !busy) onClose(); }}>
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title}
           style={{ width: { sm: 440, md: 560, lg: 680 }[width] }}>
        <h2 className="modal-title">{title}</h2>
        {subtitle && <p className="modal-sub">{subtitle}</p>}
        <div className="modal-body">{children}</div>
        {error && <div className="modal-error" role="alert">{error}</div>}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Labeled form row. Div-based (not <label>) so it can hold checklists/multiple controls. */
export function Field({ label, hint, required, stack, children }: {
  label: string; hint?: string; required?: boolean; stack?: boolean; children: React.ReactNode;
}) {
  return (
    <div className={`field${stack ? " stack" : ""}`}>
      <span className="field-label">{label}{required && <em> *</em>}</span>
      <span className="field-control">{children}</span>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

/** JSON fetch for dialogs: resolves to an error string (shown in the modal banner) or null on success. */
export async function submitJson(method: string, path: string, body?: unknown): Promise<string | null> {
  try {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? wsHeader() : { "Content-Type": "application/json", ...wsHeader() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return null;
    return (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`;
  } catch (err) {
    return String(err);
  }
}

/** Styled replacement for window.confirm — danger verb button, inline failure. */
export function ConfirmDialog({ title, message, verb = "Delete", onConfirm, onClose }: {
  title: string; message: string; verb?: string;
  onConfirm: () => Promise<string | null>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={title} width="sm" onClose={onClose} busy={busy} error={error} footer={<>
      <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
      <button className="danger-solid" disabled={busy} onClick={async () => {
        setBusy(true);
        const err = await onConfirm();
        setBusy(false);
        if (err) setError(err); else onClose();
      }}>{busy ? <span className="spin" /> : verb}</button>
    </>}>
      <p className="modal-msg">{message}</p>
    </Modal>
  );
}
```

- [ ] **Step 2: Append the CSS block to `console/app/globals.css`**

```css
/* ── Modal system (shared dialog primitives) ─────────────────────── */
.modal-overlay { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center;
  background: color-mix(in srgb, var(--ink) 42%, transparent); backdrop-filter: blur(2px); }
.modal { background: var(--panel); border: 1px solid var(--edge); border-radius: 12px;
  padding: 20px 22px; max-width: calc(100vw - 32px); max-height: 88vh;
  display: flex; flex-direction: column;
  box-shadow: 0 24px 60px -24px rgba(15,32,56,.45); }
.modal-title { margin: 0 0 4px; font-family: var(--font-cond); font-size: 20px; font-weight: 600;
  letter-spacing: .02em; text-transform: uppercase; }
.modal-sub { margin: 0 0 14px; color: var(--muted); font-size: 13px; }
.modal-body { overflow-y: auto; padding: 2px; }
.modal-error { margin-top: 10px; padding: 8px 12px; border-radius: 7px; font-size: 12.5px;
  border: 1px solid color-mix(in srgb, var(--bad) 45%, var(--line));
  background: color-mix(in srgb, var(--bad) 8%, transparent); color: var(--bad); }
.modal-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
.modal-msg { margin: 4px 0 2px; font-size: 13.5px; line-height: 1.55; }

.field { display: grid; grid-template-columns: 130px 1fr; gap: 4px 12px; align-items: center; margin-bottom: 11px; }
.field-label { font-size: 12.5px; color: var(--muted); font-weight: 550; }
.field-label em { color: var(--accent); font-style: normal; }
.field-control { display: flex; gap: 8px; align-items: center; min-width: 0; flex-wrap: wrap; }
.field-control > input, .field-control > select, .field-control > textarea { flex: 1; min-width: 0; }
.field-hint { grid-column: 2; font-size: 11.5px; color: var(--muted); }
.field.stack { grid-template-columns: 1fr; }
.field.stack .field-hint { grid-column: 1; }
.field.stack textarea { width: 100%; }

.checklist { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 6px 12px;
  border: 1px solid var(--line); border-radius: 7px; padding: 10px 12px; width: 100%;
  max-height: 170px; overflow-y: auto; }
.checklist label { display: flex; gap: 8px; align-items: center; font-size: 13px; cursor: pointer; }

.kvrows { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.kvrow { display: flex; gap: 8px; align-items: center; }
.kvrow input { flex: 1; min-width: 0; }

.profile-head, .profile-row { display: grid; gap: 6px; align-items: center;
  grid-template-columns: 1.1fr 1.2fr .7fr .7fr .8fr .8fr 30px; }
.profile-head span { font-size: 10px; text-transform: uppercase; letter-spacing: .08em;
  color: var(--muted); font-family: var(--font-mono); }

/* Name-as-edit-trigger (deployments / catalog / pools rows) */
button.namebtn { display: inline; background: none; border: 0; padding: 0; color: var(--blue);
  text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px;
  font-size: inherit; font-weight: 600; font-family: inherit; cursor: pointer; text-align: left; }
button.namebtn:hover { background: none; color: var(--blue); text-decoration-thickness: 2px; }
```

- [ ] **Step 3: Verify with a production build**

```
cd console && npx next build
```
Expected: build succeeds (new module is not imported yet — that's fine).

- [ ] **Step 4: Commit**

```bash
git add console/app/lib/modal.tsx console/app/globals.css
git commit -m "feat(console): shared Modal/Field/ConfirmDialog dialog primitives"
```

---

### Task 4: Replace every browser `confirm()` — DeleteButton, undeploy, bulk file delete

**Files:**
- Modify: `console/app/lib/delete.tsx`, `console/app/actions.tsx`, `console/app/files/table.tsx`

**Interfaces:**
- Consumes: `ConfirmDialog`, `submitJson` (Task 3).
- Produces: `DeleteButton` keeps its EXACT public props `{path, confirmText?, redirect?, label?}` — all 14 existing call sites compile untouched. `DeploymentActions({name})`, `FilesTable` unchanged externally.

- [ ] **Step 1: Rewrite `DeleteButton` in `console/app/lib/delete.tsx`**

Replace the `DeleteButton` function (keep `DownloadButton`/`RowActions` as-is):

```tsx
/** Quiet icon action used in the last column of list rows. Confirms via ConfirmDialog. */
export function DeleteButton({ path, confirmText, redirect, label = "Delete" }:
  { path: string; confirmText?: string; redirect?: string; label?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (<>
    <button className="iconbtn danger" title={label} aria-label={label} onClick={() => setOpen(true)}>
      <Icon.trash />
    </button>
    {open && <ConfirmDialog title={label} verb={label} onClose={() => setOpen(false)}
      message={confirmText ?? "Delete this permanently?"}
      onConfirm={async () => {
        const err = await submitJson("DELETE", path);
        if (!err) { redirect ? router.push(redirect) : router.refresh(); }
        return err;
      }} />}
  </>);
}
```

Update the file's imports: drop `wsHeader` (now unused here), add `import { ConfirmDialog, submitJson } from "./modal";`.

- [ ] **Step 2: Rewrite the undeploy confirm in `console/app/actions.tsx`**

Replace `DeploymentActions`:

```tsx
export function DeploymentActions({ name }: { name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <div className="rowactions">
      <button className="iconbtn danger" title="Undeploy" aria-label="Undeploy" onClick={() => setOpen(true)}>
        <Icon.trash />
      </button>
      {open && <ConfirmDialog title="Undeploy" verb="Undeploy" onClose={() => setOpen(false)}
        message={`Undeploy "${name}"? This stops serving it and removes its gateway route.`}
        onConfirm={async () => {
          const err = await submitJson("DELETE", `/v1/deployments/${name}`);
          if (!err) { await syncGateway(); router.refresh(); }
          return err;
        }} />}
    </div>
  );
}
```

Add `import { ConfirmDialog, submitJson } from "./lib/modal";`. Remove the now-unused `useState` import ONLY if nothing else in the file uses it (`SyncButton` does — keep it).

- [ ] **Step 3: Rewrite the bulk delete in `console/app/files/table.tsx`**

Replace the `deleteSelected` function and the action bar with a ConfirmDialog flow:

```tsx
  const [confirmOpen, setConfirmOpen] = useState(false);
```

Action bar (replaces the current `deleteSelected` button):

```tsx
      {sel.size > 0 && (
        <div className="formrow" style={{ marginBottom: 12 }}>
          <button className="danger-solid" onClick={() => setConfirmOpen(true)}>
            {`Delete ${sel.size} selected`}
          </button>
          <button className="ghost" onClick={() => setSel(new Set())}>Clear selection</button>
        </div>
      )}
      {confirmOpen && <ConfirmDialog title="Delete files" verb={`Delete ${sel.size}`}
        message={`Delete ${sel.size} file(s)? This cannot be undone.`}
        onClose={() => setConfirmOpen(false)}
        onConfirm={async () => {
          const results = await Promise.all([...sel].map((id) =>
            fetch(`/api/v1/files/${id}`, { method: "DELETE", headers: wsHeader() })
              .then((r) => r.ok).catch(() => false)));
          const failed = results.filter((ok) => !ok).length;
          setSel(new Set()); router.refresh();
          return failed ? `${failed} of ${results.length} deletes failed` : null;
        }} />}
```

Delete the old `deleteSelected` function and the `busy` state (no longer used). Add `import { ConfirmDialog } from "../lib/modal";`.

- [ ] **Step 4: Build + grep check**

```
cd console && npx next build
grep -rnE "confirm\(" app | grep -v "ConfirmDialog"
```
Expected: build passes; grep hits only remain in `memory-stores/[id]/browser.tsx` (migrated in Task 9).

- [ ] **Step 5: Commit**

```bash
git add console/app/lib/delete.tsx console/app/actions.tsx console/app/files/table.tsx
git commit -m "feat(console): styled ConfirmDialog replaces window.confirm for deletes/undeploy"
```

---

### Task 5: Deployments — Modal/Field rebuild, name-click edit, "Add remote endpoint"

**Files:**
- Modify: `console/app/deployments/deploy-modal.tsx` (full rewrite below), `console/app/deployments/page.tsx`

**Interfaces:**
- Consumes: `Modal`, `Field`, `submitJson` (Task 3).
- Produces: `AddEndpointButton()` (renamed label), `DeployLocalButton({catalogId, defaultName, small?})` (unchanged signature — catalog + dashboard call it), `EditDeploymentName(props)` replacing `EditDeploymentButton` with the SAME prop union `{kind:"local", name, poolRef?, replicas?} | {kind:"external", name, externalId, provider?, baseUrl?, modelId?}` but rendering the deployment name as the trigger.

- [ ] **Step 1: Rewrite `console/app/deployments/deploy-modal.tsx`**

```tsx
"use client";
// One centered modal for every deploy/edit flow (specs 2026-07-09), built on
// the shared Modal/Field primitives. Editing opens from the row's name.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { wsHeader } from "../lib/client";
import { Icon } from "../lib/icons";
import { Modal, Field, submitJson } from "../lib/modal";

type Mode = "deploy-local" | "deploy-remote" | "edit-local" | "edit-remote";

const PRESETS: Record<string, { label: string; base: string; hint: string }> = {
  openai:     { label: "OpenAI",             base: "https://api.openai.com/v1",    hint: "gpt-4o" },
  anthropic:  { label: "Anthropic",          base: "https://api.anthropic.com",    hint: "<model-id>" },
  openrouter: { label: "OpenRouter",         base: "https://openrouter.ai/api/v1", hint: "meta-llama/llama-3.1-8b-instruct" },
  custom:     { label: "OpenAI-compatible (custom URL)", base: "", hint: "served model id" },
};

interface Ctx {
  catalogId?: string;          // deploy-local
  defaultName?: string;        // deploy-local / deploy-remote
  name?: string;               // edit modes (immutable, shown)
  poolRef?: string;            // edit-local (shown)
  minReplicas?: number; maxReplicas?: number; // edit-local (prefill)
  externalId?: string;         // edit-remote
  provider?: string;           // edit-remote (shown)
  baseUrl?: string | null;     // edit-remote
  modelId?: string;            // edit-remote
}

function DeployModal({ mode, ctx, onClose }: { mode: Mode; ctx: Ctx; onClose: () => void }) {
  const router = useRouter();
  const isLocal = mode === "deploy-local" || mode === "edit-local";
  const isEdit = mode === "edit-local" || mode === "edit-remote";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<string | null>(null);
  const [pools, setPools] = useState<string[]>([]);

  // local fields
  const [name, setName] = useState(ctx.name ?? ctx.defaultName ?? "");
  const [poolRef, setPoolRef] = useState(ctx.poolRef ?? "");
  const [minR, setMinR] = useState(ctx.minReplicas != null ? String(ctx.minReplicas) : "1");
  const [maxR, setMaxR] = useState(ctx.maxReplicas != null ? String(ctx.maxReplicas) : "1");
  const nMin = Number(minR), nMax = Number(maxR);
  const replicasValid = Number.isInteger(nMin) && Number.isInteger(nMax) && nMin >= 0 && nMax >= 1 && nMax >= nMin;
  const [ctxTokens, setCtxTokens] = useState("");
  // remote fields
  const [provider, setProvider] = useState(ctx.provider ?? "openai");
  const [baseUrl, setBaseUrl] = useState(ctx.baseUrl ?? "");
  const [modelId, setModelId] = useState(ctx.modelId ?? "");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    if (mode !== "deploy-local") return;
    fetch("/api/v1/pools", { headers: wsHeader() }).then((r) => r.json())
      .then((d) => {
        const names = (d.pools ?? []).map((p: any) => p.metadata?.name).filter(Boolean);
        setPools(names);
        if (names.length && !poolRef) setPoolRef(names[0]);
      }).catch(() => setPools([]));
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setBusy(true); setError(null);
    const err =
      mode === "deploy-local" ? await submitJson("POST", "/v1/deployments", {
        name, catalogId: ctx.catalogId, poolRef,
        replicas: { min: Number(minR) || 0, max: Number(maxR) || 0 },
        ...(ctxTokens && !Number.isNaN(Number(ctxTokens)) ? { contextTokens: Number(ctxTokens) } : {}),
      })
      : mode === "deploy-remote" ? await submitJson("POST", "/v1/deployments/external", {
        name, provider, baseUrl: baseUrl || undefined, modelId, apiKey: apiKey || undefined,
      })
      : mode === "edit-local" ? await submitJson("PATCH", `/v1/deployments/${ctx.name}`, {
        replicas: { min: Number(minR) || 0, max: Number(maxR) || 0 },
        ...(ctxTokens && !Number.isNaN(Number(ctxTokens)) ? { contextTokens: Number(ctxTokens) } : {}),
      })
      : await submitJson("PATCH", `/v1/deployments/external/${ctx.externalId}`, {
        modelId: modelId || undefined, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined,
      });
    setBusy(false);
    if (err) setError(err); else { onClose(); router.refresh(); }
  };

  const test = async () => {
    setBusy(true); setProbe(null);
    try {
      const res = await fetch("/api/v1/deployments/external/test", {
        method: "POST", headers: { "Content-Type": "application/json", ...wsHeader() },
        body: JSON.stringify({ provider, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined }),
      });
      const j = await res.json().catch(() => ({ ok: false, detail: `HTTP ${res.status}` }));
      setProbe(j.ok ? `✓ ${j.detail}` : `✗ ${j.detail ?? j.error}`);
    } catch (err) {
      setProbe(`✗ ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const title = mode === "deploy-local" ? "Deploy model"
    : mode === "deploy-remote" ? "Add remote endpoint" : `Edit ${ctx.name}`;
  const canSubmit = isEdit
    ? !busy && (isLocal ? replicasValid : true)
    : !busy && !!name && (isLocal ? (!!poolRef && replicasValid) : (!!modelId && (provider !== "custom" || !!baseUrl)));

  return (
    <Modal title={title} width="md" onClose={onClose} busy={busy} error={error}
      subtitle={isEdit ? `The name is immutable — it is the gateway model name.` : undefined}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={!canSubmit} onClick={submit}>{busy ? "Working…" : isEdit ? "Save" : "Deploy"}</button>
      </>}>
      {!isEdit && (
        <Field label="Name" required hint="lowercase letters, digits, dashes — becomes the gateway model name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-deployment" />
        </Field>
      )}
      {isLocal ? (<>
        <Field label="Pool" required={mode === "deploy-local"}
               hint={mode === "deploy-local" && !pools.length ? "no pools yet — create one on the Pools page" : undefined}>
          {mode === "deploy-local"
            ? <select value={poolRef} onChange={(e) => setPoolRef(e.target.value)}>
                {pools.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            : <code>{ctx.poolRef ?? "—"}</code>}
        </Field>
        <Field label="Replicas" hint="min 0 allows scale-to-zero; the HPA scales between the bounds">
          <span className="muted">min</span>
          <input style={{ width: 70, flex: "none" }} value={minR} onChange={(e) => setMinR(e.target.value)} />
          <span className="muted">max</span>
          <input style={{ width: 70, flex: "none" }} value={maxR} onChange={(e) => setMaxR(e.target.value)} />
        </Field>
        <Field label="Context" hint={mode === "edit-local"
            ? "tokens — leave empty to keep the current value"
            : "tokens — leave empty for the catalog default"}>
          <input style={{ width: 130, flex: "none" }} value={ctxTokens}
                 onChange={(e) => setCtxTokens(e.target.value)}
                 placeholder={mode === "edit-local" ? "unchanged" : "default"} />
        </Field>
      </>) : (<>
        {mode === "deploy-remote" && (
          <Field label="Provider" required>
            <select value={provider} onChange={(e) => { setProvider(e.target.value); setBaseUrl(""); setProbe(null); }}>
              {Object.entries(PRESETS).map(([v, p]) => <option key={v} value={v}>{p.label}</option>)}
            </select>
          </Field>
        )}
        <Field label="Model id" required hint={`what the provider serves, e.g. ${PRESETS[provider]?.hint}`}>
          <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder={PRESETS[provider]?.hint} />
        </Field>
        <Field label="Base URL" required={provider === "custom"}
               hint={provider === "custom" ? "e.g. http://host.docker.internal:8081/v1"
                                           : `leave empty for the provider default (${PRESETS[provider]?.base})`}>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </Field>
        <Field label="API key" hint={isEdit ? "write-only — leave empty to keep the current key"
                                            : "write-only; optional for keyless local endpoints"}>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </Field>
        <Field label="Connection">
          <button className="ghost" disabled={busy} onClick={test}>Test connection</button>
          {probe && <span style={{ fontSize: 12, color: probe.startsWith("✓") ? "var(--good)" : "var(--accent)" }}>{probe}</span>}
        </Field>
      </>)}
    </Modal>
  );
}

export function AddEndpointButton() {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}><Icon.deploy /> Add remote endpoint</button>
    {open && <DeployModal mode="deploy-remote" ctx={{}} onClose={() => setOpen(false)} />}
  </>);
}

export function DeployLocalButton({ catalogId, defaultName, small }: { catalogId: string; defaultName: string; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const slug = defaultName.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return (<>
    <button className={small ? "deploy-sm" : ""} onClick={() => setOpen(true)}><Icon.deploy /> Deploy</button>
    {open && <DeployModal mode="deploy-local" ctx={{ catalogId, defaultName: slug }} onClose={() => setOpen(false)} />}
  </>);
}

/** The deployment's name IS the edit affordance (console-wide pattern: click the name to open the resource). */
export function EditDeploymentName(props:
  | { kind: "local"; name: string; poolRef?: string; replicas?: { min: number; max: number } }
  | { kind: "external"; name: string; externalId: string; provider?: string; baseUrl?: string | null; modelId?: string }) {
  const [open, setOpen] = useState(false);
  const mode = props.kind === "local" ? "edit-local" : "edit-remote";
  const ctx: Ctx = props.kind === "local"
    ? { name: props.name, poolRef: props.poolRef, minReplicas: props.replicas?.min, maxReplicas: props.replicas?.max }
    : { name: props.name, externalId: props.externalId, provider: props.provider, baseUrl: props.baseUrl, modelId: props.modelId };
  return (<>
    <button className="namebtn" title="Edit deployment" onClick={() => setOpen(true)}>{props.name}</button>
    {open && <DeployModal mode={mode} ctx={ctx} onClose={() => setOpen(false)} />}
  </>);
}
```

- [ ] **Step 2: Update `console/app/deployments/page.tsx`**

Change the import: `import { AddEndpointButton, EditDeploymentName } from "./deploy-modal";`

Replace the name cell `<td>{d.name}</td>` with:

```tsx
              <td>{d.kind === "external"
                ? <EditDeploymentName kind="external" name={d.name} externalId={d.id!} provider={d.provider} baseUrl={d.baseUrl ?? null} modelId={d.modelId} />
                : <EditDeploymentName kind="local" name={d.name} poolRef={d.poolRef} replicas={d.replicas ?? undefined} />}</td>
```

Replace the trailing actions cell (removing the pen buttons):

```tsx
              <td>{d.kind === "external"
                ? <div className="rowactions">
                    <DeleteButton path={`/v1/deployments/external/${d.id}`} confirmText={`Remove endpoint "${d.name}"? The gateway route disappears immediately.`} label="Remove" />
                  </div>
                : <DeploymentActions name={d.name} />}</td>
```

- [ ] **Step 3: Build**

```
cd console && npx next build
```
Expected: PASS. (The catalog and dashboard pages import `DeployLocalButton`, whose signature didn't change.)

- [ ] **Step 4: Commit**

```bash
git add console/app/deployments/deploy-modal.tsx console/app/deployments/page.tsx
git commit -m "feat(console): deployments edit via name click; Modal/Field deploy dialogs; 'Add remote endpoint'"
```

---

### Task 6: Catalog — shared model form (add custom / edit any), overrides, Reset to defaults

**Files:**
- Create: `console/app/catalog/model-modal.tsx`
- Delete: `console/app/catalog/create.tsx`
- Modify: `console/app/catalog/page.tsx`

**Interfaces:**
- Consumes: `PATCH /v1/catalog/:id` + `overridden` flag (Task 1), `Modal`/`Field`/`ConfirmDialog`/`submitJson` (Task 3).
- Produces: `AddCustomModelButton()` and `EditModelName({entry})` where `entry` is the full catalog row from `GET /v1/catalog` (including `id`, `custom`, `overridden`, `capacityProfiles`).

- [ ] **Step 1: Create `console/app/catalog/model-modal.tsx`**

```tsx
"use client";
// Shared add/edit form for catalog models (spec 2026-07-09). Editing a bundled
// model writes a DB override; "Reset to defaults" deletes it (YAML reappears).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal, Field, ConfirmDialog, submitJson } from "../lib/modal";

interface ProfileDraft { gpuType: string; instanceType: string; gpusPerReplica: string;
                         vramGB: string; estTokensPerSec: string; costPerHourUSD: string; }
const EMPTY_PROFILE: ProfileDraft = { gpuType: "cpu", instanceType: "cpu-4vcpu", gpusPerReplica: "0",
                                      vramGB: "0", estTokensPerSec: "15", costPerHourUSD: "0.15" };

interface Draft {
  displayName: string; family: string; parameters: string; format: string; quantization: string;
  source: string; license: string; toolCalling: string; contextTokens: string;
  vramGB: string; diskGB: string; gpus: string; profiles: ProfileDraft[];
}

function toDraft(m?: any): Draft {
  return {
    displayName: m?.displayName ?? "", family: m?.family ?? "custom",
    parameters: m?.parameters ?? "", format: m?.format ?? "gguf",
    quantization: m?.quantization ?? "Q4_K_M", source: m?.source ?? "",
    license: m?.license ?? "", toolCalling: m?.toolCalling ?? "basic",
    contextTokens: m?.contextTokens != null ? String(m.contextTokens) : "",
    vramGB: String(m?.requirements?.vramGB ?? 0), diskGB: String(m?.requirements?.diskGB ?? 1),
    gpus: String(m?.requirements?.gpus ?? 0),
    profiles: (m?.capacityProfiles ?? [{ ...EMPTY_PROFILE }]).map((p: any) => ({
      gpuType: p.gpuType ?? "cpu", instanceType: p.instanceType ?? "",
      gpusPerReplica: String(p.gpusPerReplica ?? 0), vramGB: String(p.vramGB ?? 0),
      estTokensPerSec: String(p.estTokensPerSec ?? 0), costPerHourUSD: String(p.costPerHourUSD ?? 0),
    })),
  };
}

function toBody(d: Draft) {
  return {
    displayName: d.displayName, family: d.family || "custom", parameters: d.parameters || "—",
    format: d.format, quantization: d.format === "gguf" ? d.quantization || undefined : undefined,
    source: d.source, license: d.license || undefined, toolCalling: d.toolCalling,
    contextTokens: d.contextTokens ? Number(d.contextTokens) : undefined,
    requirements: { vramGB: Number(d.vramGB) || 0, diskGB: Number(d.diskGB) || 1, gpus: Number(d.gpus) || 0 },
    capacityProfiles: d.profiles.map((p) => ({
      gpuType: p.gpuType, instanceType: p.instanceType,
      gpusPerReplica: Number(p.gpusPerReplica) || 0, vramGB: Number(p.vramGB) || 0,
      estTokensPerSec: Number(p.estTokensPerSec) || 0, costPerHourUSD: Number(p.costPerHourUSD) || 0,
    })),
  };
}

export function ModelFormModal({ mode, entry, onClose }: { mode: "add" | "edit"; entry?: any; onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [d, setD] = useState<Draft>(() => toDraft(entry));
  const set = (k: keyof Draft, v: any) => setD({ ...d, [k]: v });
  const setP = (i: number, k: keyof ProfileDraft, v: string) =>
    setD({ ...d, profiles: d.profiles.map((p, j) => (j === i ? { ...p, [k]: v } : p)) });

  const submit = async () => {
    setBusy(true); setError(null);
    const err = mode === "add"
      ? await submitJson("POST", "/v1/catalog", {
          id: d.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-custom",
          ...toBody(d),
        })
      : await submitJson("PATCH", `/v1/catalog/${entry.id}`, toBody(d));
    setBusy(false);
    if (err) setError(err); else { onClose(); router.refresh(); }
  };

  return (
    <Modal title={mode === "add" ? "Add custom model" : `Edit ${entry.displayName}`} width="lg"
      subtitle={mode === "add"
        ? "Point at any HuggingFace model. GGUF → llama.cpp, safetensors → vLLM."
        : entry.overridden ? "This bundled model has site overrides." 
        : entry.custom ? undefined : "Editing a bundled model stores a site override; the YAML default stays intact."}
      onClose={onClose} busy={busy} error={error}
      footer={<>
        {mode === "edit" && entry.overridden && (
          <button className="ghost danger" disabled={busy} style={{ marginRight: "auto" }}
                  onClick={() => setResetOpen(true)}>Reset to defaults</button>
        )}
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || !d.displayName || !d.source} onClick={submit}>
          {busy ? "Saving…" : mode === "add" ? "Add model" : "Save"}
        </button>
      </>}>
      <Field label="Display name" required>
        <input value={d.displayName} onChange={(e) => set("displayName", e.target.value)} placeholder="My Qwen 1.5B" />
      </Field>
      <Field label="Source" required stack
             hint="HF resolve URL for GGUF, or repo id for safetensors">
        <input value={d.source} onChange={(e) => set("source", e.target.value)}
               placeholder="https://huggingface.co/…/resolve/main/model-Q4_K_M.gguf" />
      </Field>
      <Field label="Format">
        <select value={d.format} onChange={(e) => set("format", e.target.value)} style={{ flex: "none", width: 190 }}>
          <option value="gguf">GGUF (llama.cpp)</option>
          <option value="safetensors">safetensors (vLLM)</option>
        </select>
        {d.format === "gguf" && (<>
          <span className="muted">quant</span>
          <input style={{ width: 110, flex: "none" }} value={d.quantization} onChange={(e) => set("quantization", e.target.value)} />
        </>)}
      </Field>
      <Field label="Family / params">
        <input style={{ width: 130, flex: "none" }} value={d.family} onChange={(e) => set("family", e.target.value)} />
        <input style={{ width: 90, flex: "none" }} value={d.parameters} onChange={(e) => set("parameters", e.target.value)} placeholder="1.5B" />
      </Field>
      <Field label="Context / license">
        <input style={{ width: 110, flex: "none" }} value={d.contextTokens} onChange={(e) => set("contextTokens", e.target.value)} placeholder="tokens" />
        <input style={{ width: 130, flex: "none" }} value={d.license} onChange={(e) => set("license", e.target.value)} placeholder="apache-2.0" />
      </Field>
      <Field label="Tool calling" hint="how well the model drives agent tools">
        <select value={d.toolCalling} onChange={(e) => set("toolCalling", e.target.value)} style={{ flex: "none", width: 130 }}>
          <option value="strong">strong</option><option value="basic">basic</option><option value="none">none</option>
        </select>
      </Field>
      <Field label="Requirements" hint="per replica: GPU count, VRAM, disk for weights">
        <span className="muted">GPUs</span>
        <input style={{ width: 60, flex: "none" }} value={d.gpus} onChange={(e) => set("gpus", e.target.value)} />
        <span className="muted">VRAM GB</span>
        <input style={{ width: 70, flex: "none" }} value={d.vramGB} onChange={(e) => set("vramGB", e.target.value)} />
        <span className="muted">disk GB</span>
        <input style={{ width: 70, flex: "none" }} value={d.diskGB} onChange={(e) => set("diskGB", e.target.value)} />
      </Field>
      <Field label="Capacity profiles" stack
             hint="hardware options this model can deploy on — the catalog shows the cheapest">
        <div className="kvrows">
          <div className="profile-head">
            <span>GPU type</span><span>Instance</span><span>GPUs</span><span>VRAM</span><span>tok/s</span><span>$/hr</span><span />
          </div>
          {d.profiles.map((p, i) => (
            <div className="profile-row" key={i}>
              <input value={p.gpuType} onChange={(e) => setP(i, "gpuType", e.target.value)} />
              <input value={p.instanceType} onChange={(e) => setP(i, "instanceType", e.target.value)} />
              <input value={p.gpusPerReplica} onChange={(e) => setP(i, "gpusPerReplica", e.target.value)} />
              <input value={p.vramGB} onChange={(e) => setP(i, "vramGB", e.target.value)} />
              <input value={p.estTokensPerSec} onChange={(e) => setP(i, "estTokensPerSec", e.target.value)} />
              <input value={p.costPerHourUSD} onChange={(e) => setP(i, "costPerHourUSD", e.target.value)} />
              <button className="iconbtn danger" title="Remove profile" aria-label="Remove profile"
                      disabled={d.profiles.length <= 1}
                      onClick={() => set("profiles", d.profiles.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button className="ghost" onClick={() => set("profiles", [...d.profiles, { ...EMPTY_PROFILE }])}>+ Add profile</button></div>
        </div>
      </Field>
      {resetOpen && <ConfirmDialog title="Reset to defaults" verb="Reset"
        message={`Discard the site overrides for "${entry.displayName}"? The bundled catalog defaults come back.`}
        onClose={() => setResetOpen(false)}
        onConfirm={async () => {
          const err = await submitJson("DELETE", `/v1/catalog/${entry.id}`);
          if (!err) { onClose(); router.refresh(); }
          return err;
        }} />}
    </Modal>
  );
}

export function AddCustomModelButton() {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}>+ Add custom model</button>
    {open && <ModelFormModal mode="add" onClose={() => setOpen(false)} />}
  </>);
}

/** Model name = edit affordance (console-wide name-click pattern). */
export function EditModelName({ entry }: { entry: any }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button className="namebtn" title="Edit model" onClick={() => setOpen(true)}>{entry.displayName}</button>
    {open && <ModelFormModal mode="edit" entry={entry} onClose={() => setOpen(false)} />}
  </>);
}
```

- [ ] **Step 2: Update `console/app/catalog/page.tsx`, delete `create.tsx`**

- Replace `import { AddCustomModel } from "./create";` with `import { AddCustomModelButton, EditModelName } from "./model-modal";`; use `<AddCustomModelButton />` in the pagehead.
- Add `overridden?: boolean` to the row type (`CatalogEntry & { custom?: boolean; overridden?: boolean }`).
- Replace the name cell's first line:

```tsx
                <td>
                  <div style={{ fontWeight: 600 }}>
                    <EditModelName entry={m} />
                    {m.custom && <span className="chip" style={{ marginLeft: 8, fontSize: 10 }}>custom</span>}
                    {m.overridden && <span className="chip" style={{ marginLeft: 8, fontSize: 10 }}>overridden</span>}
                  </div>
                  <div style={{ color: "var(--muted)", fontSize: 12 }}>
                    {m.family} · {m.license ?? "—"}{m.requirements?.diskGB ? ` · ~${m.requirements.diskGB} GB` : ""}
                  </div>
                </td>
```

- The trailing actions cell keeps `DeployLocalButton` and the custom-only `DeleteButton` (label "Remove") exactly as today — reset for overridden models lives inside the edit modal.
- Update the `.sub` blurb's "or edit `catalog/models.yaml`" tail to: `Click a model's name to edit it — bundled models keep their YAML defaults and get a site override.`
- Delete the file `console/app/catalog/create.tsx`.

- [ ] **Step 3: Build**

```
cd console && npx next build
```
Expected: PASS (would fail if any import of `./create` remains — grep `from "./create"` under `console/app/catalog` to be sure).

- [ ] **Step 4: Commit**

```bash
git add -A console/app/catalog
git commit -m "feat(console): catalog models editable via name click — shared form, overrides, reset to defaults"
```

---

### Task 7: Pools page — node selectors get a home

**Files:**
- Create: `console/app/pools/page.tsx`, `console/app/pools/pool-modal.tsx`
- Modify: `console/app/lib/icons.tsx` (add `pool`), `console/app/nav.tsx` (Serving group)

**Interfaces:**
- Consumes: Task 2 pool routes; `Modal`/`Field`/`submitJson`; `DeleteButton`; `wsGet` from `../lib/api`.
- Produces: `/pools` page; `CreatePoolButton()`, `EditPoolName({pool})` where `pool` is a raw ModelPool CR (`{metadata:{name}, spec:{nodeSelector?, gpuType?, gpusPerNode?, maxNodes?, scalingMode?}}`).

- [ ] **Step 1: Add the `pool` icon to `console/app/lib/icons.tsx`**

Insert into the `Icon` object (after `deploy`):

```tsx
  pool: () => <S><rect x="2" y="4" width="20" height="7" rx="1.5" /><rect x="2" y="13" width="20" height="7" rx="1.5" /><path d="M6 7.5h.01M6 16.5h.01" /></S>,
```

- [ ] **Step 2: Add the nav item in `console/app/nav.tsx`**

In the Serving group, insert Pools after Deployments:

```tsx
  { title: "Serving", items: [["Model catalog", "/catalog", "catalog"], ["Deployments", "/deployments", "deploy"], ["Pools", "/pools", "pool"], ["Cache", "/cache", "cache"]] },
```

- [ ] **Step 3: Create `console/app/pools/pool-modal.tsx`**

```tsx
"use client";
// Create/edit ModelPools — where K8s node selectors are configured (spec 2026-07-09).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal, Field, submitJson } from "../lib/modal";

interface Draft { name: string; gpuType: string; gpusPerNode: string; maxNodes: string;
                  scalingMode: string; selector: { k: string; v: string }[]; }

export function PoolModal({ pool, onClose }: { pool?: any; onClose: () => void }) {
  const isEdit = !!pool;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [d, setD] = useState<Draft>(() => ({
    name: pool?.metadata?.name ?? "",
    gpuType: pool?.spec?.gpuType ?? "cpu",
    gpusPerNode: String(pool?.spec?.gpusPerNode ?? 0),
    maxNodes: String(pool?.spec?.maxNodes ?? 1),
    scalingMode: pool?.spec?.scalingMode ?? "static",
    selector: Object.entries(pool?.spec?.nodeSelector ?? {}).map(([k, v]) => ({ k, v: String(v) })),
  }));
  const set = (k: keyof Draft, v: any) => setD({ ...d, [k]: v });
  const setRow = (i: number, k: "k" | "v", v: string) =>
    set("selector", d.selector.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  const submit = async () => {
    const nodeSelector = Object.fromEntries(
      d.selector.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]));
    const body = { nodeSelector, gpuType: d.gpuType || undefined,
      gpusPerNode: Number(d.gpusPerNode) || 0, maxNodes: Number(d.maxNodes) || 0,
      scalingMode: d.scalingMode };
    setBusy(true); setError(null);
    const err = isEdit
      ? await submitJson("PATCH", `/v1/pools/${pool.metadata.name}`, body)
      : await submitJson("POST", "/v1/pools", { name: d.name, ...body });
    setBusy(false);
    if (err) setError(err); else { onClose(); router.refresh(); }
  };

  return (
    <Modal title={isEdit ? `Edit pool ${pool.metadata.name}` : "Create pool"} width="md"
      subtitle="A pool maps deployments onto physical nodes — node labels differ per cloud and per cluster."
      onClose={onClose} busy={busy} error={error}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || (!isEdit && !d.name)} onClick={submit}>
          {busy ? "Saving…" : isEdit ? "Save" : "Create pool"}
        </button>
      </>}>
      {!isEdit && (
        <Field label="Name" required hint="DNS-1035: lowercase letters, digits, dashes; starts with a letter">
          <input value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="gpu-a100" />
        </Field>
      )}
      <Field label="Node selector" stack
             hint="key=value node labels this pool's pods must land on; no rows = any node. Changes apply when a deployment's pods next roll.">
        <div className="kvrows">
          {d.selector.map((r, i) => (
            <div className="kvrow" key={i}>
              <input value={r.k} onChange={(e) => setRow(i, "k", e.target.value)} placeholder="nvidia.com/gpu.product" />
              <span className="muted">=</span>
              <input value={r.v} onChange={(e) => setRow(i, "v", e.target.value)} placeholder="NVIDIA-A100-SXM4-40GB" />
              <button className="iconbtn danger" title="Remove label" aria-label="Remove label"
                      onClick={() => set("selector", d.selector.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button className="ghost" onClick={() => set("selector", [...d.selector, { k: "", v: "" }])}>+ Add label</button></div>
        </div>
      </Field>
      <Field label="GPU type" hint={`accelerator class for capacity math — "cpu" for CPU-only pools`}>
        <input style={{ width: 160, flex: "none" }} value={d.gpuType} onChange={(e) => set("gpuType", e.target.value)} />
      </Field>
      <Field label="GPUs / node">
        <input style={{ width: 90, flex: "none" }} value={d.gpusPerNode} onChange={(e) => set("gpusPerNode", e.target.value)} />
      </Field>
      <Field label="Max nodes" hint="caps dynamic scaling">
        <input style={{ width: 90, flex: "none" }} value={d.maxNodes} onChange={(e) => set("maxNodes", e.target.value)} />
      </Field>
      <Field label="Scaling">
        <select style={{ width: 160, flex: "none" }} value={d.scalingMode} onChange={(e) => set("scalingMode", e.target.value)}>
          <option value="static">static (fixed on-prem)</option>
          <option value="dynamic">dynamic (cloud autoscaler)</option>
        </select>
      </Field>
    </Modal>
  );
}

export function CreatePoolButton() {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}>+ Create pool</button>
    {open && <PoolModal onClose={() => setOpen(false)} />}
  </>);
}

export function EditPoolName({ pool }: { pool: any }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button className="namebtn" title="Edit pool" onClick={() => setOpen(true)}>{pool.metadata.name}</button>
    {open && <PoolModal pool={pool} onClose={() => setOpen(false)} />}
  </>);
}
```

- [ ] **Step 4: Create `console/app/pools/page.tsx`**

```tsx
import { wsGet } from "../lib/api";
import { DeleteButton } from "../lib/delete";
import { CreatePoolButton, EditPoolName } from "./pool-modal";

export const dynamic = "force-dynamic";

export default async function PoolsPage() {
  const [{ pools }, { deployments }] = await Promise.all([
    wsGet<{ pools: any[] }>("/v1/pools"),
    wsGet<{ deployments: any[] }>("/v1/deployments"),
  ]);
  const inUse = (name: string) => deployments.filter((d: any) => d.poolRef === name).length;
  return (
    <>
      <div className="pagehead"><h1>Pools</h1><CreatePoolButton /></div>
      <p className="sub">
        Logical node pools map models onto physical nodes via Kubernetes node selectors.
        Deployments pick a pool; the pool's selector decides which nodes serve the pods.
      </p>
      <div className="tablewrap"><table>
        <thead><tr>
          <th>Name</th><th>Node selector</th><th>GPU type</th><th>GPUs/node</th>
          <th>Max nodes</th><th>Scaling</th><th>In use</th><th></th>
        </tr></thead>
        <tbody>
          {pools.map((p: any) => {
            const sel = Object.entries(p.spec?.nodeSelector ?? {});
            return (
              <tr key={p.metadata.name}>
                <td><EditPoolName pool={p} /></td>
                <td>{sel.length
                  ? sel.map(([k, v]) => <span className="chip" key={k} style={{ marginRight: 6 }}><code>{k}={String(v)}</code></span>)
                  : <span className="muted">any node</span>}</td>
                <td>{p.spec?.gpuType ?? "—"}</td>
                <td>{p.spec?.gpusPerNode ?? "—"}</td>
                <td>{p.spec?.maxNodes ?? "—"}</td>
                <td>{p.spec?.scalingMode ?? "—"}</td>
                <td>{inUse(p.metadata.name)} deployment(s)</td>
                <td><DeleteButton path={`/v1/pools/${p.metadata.name}`}
                      confirmText={`Delete pool "${p.metadata.name}"? Deployments still using it block deletion.`} /></td>
              </tr>
            );
          })}
          {pools.length === 0 && <tr><td colSpan={8} className="empty">No pools — create one to map models onto your nodes.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
```

Note: `GET /v1/pools` is unpaged (raw CR list) and `GET /v1/deployments` returns the first 100 — fine for the in-use count at current scale; no Pager on this page.

- [ ] **Step 5: Build, then live-verify the operator question (spec §3 open item)**

```
cd console && npx next build
```
Then with the stack running (CP + operator per CLAUDE.md): create a pool on `/pools` with selector `devproof.ai/pool=cpu-default`, check `kubectl get modelpool -n devproof-serving <name> -o yaml` shows the spec. Edit the selector on a pool that has a live deployment and watch whether the LLMkube InferenceService's `spec.nodeSelector` changes without touching the deployment (`kubectl get inferenceservice -n devproof-serving <dep> -o yaml`). If it DOES re-reconcile immediately, change the PoolModal hint sentence to `"Changes apply to running deployments within the operator's next reconcile."` Otherwise keep the shipped hint (applies on next rollout).

- [ ] **Step 6: Commit**

```bash
git add console/app/pools console/app/lib/icons.tsx console/app/nav.tsx
git commit -m "feat(console): Pools page — node selectors, capacity fields, guarded delete"
```

---

### Task 8: Agents — shared form, Edit-as-new-version on the detail page

**Files:**
- Create: `console/app/agents/agent-form.tsx`
- Delete: `console/app/agents/create.tsx`
- Modify: `console/app/agents/page.tsx`, `console/app/agents/[id]/page.tsx`

**Interfaces:**
- Consumes: `POST /v1/agents` (create) and `POST /v1/agents/:id/versions` (edit — body is the AgentConfig subset `{model, systemPrompt, tools, maxTurns, environmentId?, vaultId?, skillIds}`; camelCase in requests, snake_case in version rows). `agent.versions[0]` is the LATEST (`repo.ts:110` orders `version DESC`).
- Produces: `CreateAgentButton({environments, skills, vaults, models})`, `EditAgentButton({agent, environments, skills, vaults, models})`.

- [ ] **Step 1: Create `console/app/agents/agent-form.tsx`**

```tsx
"use client";
// Create + edit agents on one form. Edit saves a NEW immutable version
// (POST /v1/agents/:id/versions) — running sessions keep the version they started with.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal, Field, submitJson } from "../lib/modal";

const DEFAULT_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch"];

export function AgentFormModal({ mode, agentId, initial, environments, skills, vaults, models, onClose }: {
  mode: "create" | "edit"; agentId?: string; initial?: any;
  environments: any[]; skills: any[]; vaults: any[]; models: string[]; onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState(() => ({
    name: initial?.name ?? "",
    model: initial?.model ?? models[0] ?? "",
    systemPrompt: initial?.system_prompt ?? "",
    tools: ((initial?.tools as string[] | undefined) ?? DEFAULT_TOOLS).join(","),
    maxTurns: String(initial?.max_turns ?? 10),
    environmentId: initial?.environment_id ?? "",
    vaultId: initial?.vault_id ?? "",
    skillIds: (initial?.skill_ids as string[] | undefined) ?? [],
  }));
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const toggleSkill = (id: string) =>
    set("skillIds", f.skillIds.includes(id) ? f.skillIds.filter((s: string) => s !== id) : [...f.skillIds, id]);

  const submit = async () => {
    const body = {
      model: f.model, systemPrompt: f.systemPrompt,
      tools: f.tools.split(",").map((t: string) => t.trim()).filter(Boolean),
      maxTurns: Number(f.maxTurns) || 10,
      environmentId: f.environmentId || undefined,
      vaultId: f.vaultId || undefined,
      skillIds: f.skillIds,
    };
    setBusy(true); setError(null);
    const err = mode === "create"
      ? await submitJson("POST", "/v1/agents", { name: f.name, ...body })
      : await submitJson("POST", `/v1/agents/${agentId}/versions`, body);
    setBusy(false);
    if (err) setError(err); else { onClose(); router.refresh(); }
  };

  return (
    <Modal title={mode === "create" ? "Create agent" : `Edit ${initial?.name}`} width="lg"
      subtitle={mode === "edit" ? "Saving creates a new version; running sessions keep the version they started with." : undefined}
      onClose={onClose} busy={busy} error={error}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || (mode === "create" && !f.name) || !f.model} onClick={submit}>
          {busy ? "Saving…" : mode === "create" ? "Create agent" : "Save as new version"}
        </button>
      </>}>
      {mode === "create" && (
        <Field label="Name" required>
          <input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="support-triage" />
        </Field>
      )}
      <Field label="Model" required hint="a deployment name — local or remote">
        <select value={f.model} onChange={(e) => set("model", e.target.value)}>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
          {f.model && !models.includes(f.model) && <option value={f.model}>{f.model} (not deployed)</option>}
        </select>
      </Field>
      <Field label="Max turns" hint="agent-loop iterations per message">
        <input style={{ width: 90, flex: "none" }} value={f.maxTurns} onChange={(e) => set("maxTurns", e.target.value)} />
      </Field>
      <Field label="System prompt" stack>
        <textarea rows={5} value={f.systemPrompt} onChange={(e) => set("systemPrompt", e.target.value)} placeholder="You are…" />
      </Field>
      <Field label="Tools" hint="comma-separated SDK tool names (python runs via Bash)">
        <input value={f.tools} onChange={(e) => set("tools", e.target.value)} />
      </Field>
      <Field label="Environment" hint="egress allowlist the sessions run under">
        <select value={f.environmentId} onChange={(e) => set("environmentId", e.target.value)}>
          <option value="">No environment</option>
          {environments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </Field>
      <Field label="Vault" hint="credentials injected into sessions">
        <select value={f.vaultId} onChange={(e) => set("vaultId", e.target.value)}>
          <option value="">No vault</option>
          {vaults.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </Field>
      <Field label="Skills" stack>
        {skills.length ? (
          <div className="checklist">
            {skills.map((s) => (
              <label key={s.id}>
                <input type="checkbox" checked={f.skillIds.includes(s.id)} onChange={() => toggleSkill(s.id)} />
                <span>{s.name} <span className="muted">v{s.version}</span></span>
              </label>
            ))}
          </div>
        ) : <span className="muted">no skills uploaded yet</span>}
      </Field>
    </Modal>
  );
}

export function CreateAgentButton(props: { environments: any[]; skills: any[]; vaults: any[]; models: string[] }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}>+ Create agent</button>
    {open && <AgentFormModal mode="create" {...props} onClose={() => setOpen(false)} />}
  </>);
}

export function EditAgentButton({ agent, ...props }: { agent: any; environments: any[]; skills: any[]; vaults: any[]; models: string[] }) {
  const [open, setOpen] = useState(false);
  const latest = agent.versions[0]; // versions are ordered DESC — [0] is the newest
  return (<>
    <button className="ghost" onClick={() => setOpen(true)}>Edit agent</button>
    {open && <AgentFormModal mode="edit" agentId={agent.id}
      initial={{ ...latest, name: agent.name }} {...props} onClose={() => setOpen(false)} />}
  </>);
}
```

- [ ] **Step 2: Rewire the pages**

`console/app/agents/page.tsx`: replace `import { CreateAgent } from "./create";` with `import { CreateAgentButton } from "./agent-form";` and the pagehead usage with `<CreateAgentButton environments={environments} skills={skills} vaults={vaults} models={deployments.map((d: any) => d.name)} />`. Delete `console/app/agents/create.tsx`.

`console/app/agents/[id]/page.tsx`: add the deployments fetch and the Edit button:

```tsx
import { EditAgentButton } from "../agent-form";
```

```tsx
  const [agent, obs, sessions, { skills }, { environments }, { vaults }, { deployments }] = await Promise.all([
    wsGet<any>(`/v1/agents/${id}`),
    wsGet<any>(`/v1/agents/${id}/observability`),
    wsGet<{ sessions: any[] }>(`/v1/sessions?agent=${id}`),
    wsGet<{ skills: any[] }>(`/v1/skills`),
    wsGet<{ environments: any[] }>(`/v1/environments`),
    wsGet<{ vaults: any[] }>(`/v1/vaults`),
    wsGet<{ deployments: any[] }>(`/v1/deployments`),
  ]);
```

```tsx
      <div className="pagehead">
        <h1>{agent.name} <span className="phase Ready" style={{ verticalAlign: "middle" }}>Active</span></h1>
        <EditAgentButton agent={agent} environments={environments} skills={skills} vaults={vaults}
                         models={deployments.map((d: any) => d.name)} />
      </div>
```

- [ ] **Step 3: Build**

```
cd console && npx next build
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A console/app/agents
git commit -m "feat(console): agents editable — shared form modal, edit saves a new version"
```

---

### Task 9: Kill the `prompt()`s — workspace, API key, skill, memory store, memory path

**Files:**
- Modify: `console/app/nav.tsx`, `console/app/api-keys/create.tsx`, `console/app/skills/create.tsx`, `console/app/memory-stores/create.tsx`, `console/app/memory-stores/[id]/browser.tsx`

**Interfaces:**
- Consumes: `Modal`, `Field`, `ConfirmDialog`, `submitJson` (Task 3).
- Produces: no signature changes — `CreateApiKey()`, `CreateSkill()`, `CreateStore()`, `MemoryBrowser({storeId, entries})`, `Nav({workspaces, current})` keep their exports.

- [ ] **Step 1: Workspace modal in `console/app/nav.tsx`**

Add imports `import { useState } from "react";` and `import { Modal, Field } from "./lib/modal";`. Inside `Nav`, replace `createWorkspace` with modal state:

```tsx
  const [wsModal, setWsModal] = useState(false);
```

Change the select's onChange: `onChange={(e) => e.target.value === "__new" ? setWsModal(true) : switchWorkspace(e.target.value)}` (the select is controlled by `value={current}`, so it snaps back on re-render). Delete the old `createWorkspace` function. Render at the end of the `<nav>`, after the groups:

```tsx
      {wsModal && <WorkspaceModal onClose={() => setWsModal(false)}
                                  onCreated={(id) => { setWsModal(false); switchWorkspace(id); }} />}
```

And add the component in the same file:

```tsx
function WorkspaceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/v1/workspaces", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      if (res.ok) { onCreated((await res.json()).id); return; }
      setError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    } catch (err) { setError(String(err)); }
    setBusy(false);
  };
  return (
    <Modal title="New workspace" width="sm" onClose={onClose} busy={busy} error={error}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || !name.trim()} onClick={submit}>{busy ? "Creating…" : "Create workspace"}</button>
      </>}>
      <Field label="Name" required hint="every resource is scoped to a workspace">
        <input value={name} onChange={(e) => setName(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && submit()} placeholder="team-research" />
      </Field>
    </Modal>
  );
}
```

- [ ] **Step 2: Rewrite `console/app/api-keys/create.tsx`**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { wsHeader } from "../lib/client";
import { Modal, Field } from "../lib/modal";

export function CreateApiKey() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/v1/api-keys", {
        method: "POST", headers: { "Content-Type": "application/json", ...wsHeader() },
        body: JSON.stringify({ name }),
      });
      if (res.ok) { setCreated(await res.json()); setOpen(false); setName(""); router.refresh(); }
      else setError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    } catch (err) { setError(String(err)); }
    setBusy(false);
  };

  return (<>
    <button onClick={() => { setOpen(true); setError(null); }}>+ Create key</button>
    {open && (
      <Modal title="Create API key" width="sm" onClose={() => setOpen(false)} busy={busy} error={error}
        footer={<>
          <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button disabled={busy || !name.trim()} onClick={submit}>{busy ? "Creating…" : "Create key"}</button>
        </>}>
        <Field label="Name" required hint="what will use this key, e.g. codex-laptop">
          <input value={name} onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && submit()} />
        </Field>
      </Modal>
    )}
    {created && (
      // Deliberately NOT dismissible: the key is shown exactly once.
      <Modal title="Copy your API key" width="sm" dismissible={false} onClose={() => {}}
        subtitle={`This is the only time ${created.name}'s full key is shown. Store it securely.`}
        footer={<>
          <button className="ghost" onClick={async () => {
            await navigator.clipboard.writeText(created.key); setCopied(true);
          }}>{copied ? "Copied ✓" : "Copy to clipboard"}</button>
          <button onClick={() => { setCreated(null); setCopied(false); }}>Done</button>
        </>}>
        <pre className="block" style={{ userSelect: "all" }}>{created.key}</pre>
      </Modal>
    )}
  </>);
}
```

- [ ] **Step 3: Rewrite `console/app/skills/create.tsx`**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { wsHeader } from "../lib/client";
import { Modal, Field } from "../lib/modal";

export function CreateSkill() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!file) return;
    setBusy(true); setError(null);
    const body = new FormData();
    body.append("file", file);
    try {
      const res = await fetch(`/api/v1/skills?name=${encodeURIComponent(name)}`, { method: "POST", headers: wsHeader(), body });
      if (res.ok) { setFile(null); router.refresh(); }
      else setError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    } catch (err) { setError(String(err)); }
    setBusy(false);
  };

  return (<>
    <input ref={input} type="file" accept=".md,.zip" style={{ display: "none" }} onChange={(e) => {
      const f = e.target.files?.[0];
      if (f) { setFile(f); setName(f.name.replace(/\.(md|zip)$/i, "")); setError(null); }
      e.target.value = "";
    }} />
    <button onClick={() => input.current?.click()}>+ Create skill</button>
    {file && (
      <Modal title="Create skill" width="sm" onClose={() => setFile(null)} busy={busy} error={error}
        subtitle={`Uploading ${file.name} (${(file.size / 1024).toFixed(1)} KB). Re-uploading an existing name bumps its version.`}
        footer={<>
          <button className="ghost" disabled={busy} onClick={() => setFile(null)}>Cancel</button>
          <button disabled={busy || !name.trim()} onClick={submit}>{busy ? "Creating…" : "Create skill"}</button>
        </>}>
        <Field label="Name" required hint="kebab-case — staged into /work/.devproof/skills/<name>/ in sessions">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </Modal>
    )}
  </>);
}
```

- [ ] **Step 4: Rewrite `console/app/memory-stores/create.tsx`**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal, Field, submitJson } from "../lib/modal";

export function CreateStore() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    const err = await submitJson("POST", "/v1/memory-stores", { name });
    setBusy(false);
    if (err) setError(err); else { setOpen(false); setName(""); router.refresh(); }
  };

  return (<>
    <button onClick={() => setOpen(true)}>+ Create memory store</button>
    {open && (
      <Modal title="Create memory store" width="sm" onClose={() => setOpen(false)} busy={busy} error={error}
        footer={<>
          <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button disabled={busy || !name.trim()} onClick={submit}>{busy ? "Creating…" : "Create store"}</button>
        </>}>
        <Field label="Name" required hint="e.g. a ticket id — sessions mount it at /mnt/memory">
          <input value={name} onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && submit()} />
        </Field>
      </Modal>
    )}
  </>);
}
```

- [ ] **Step 5: Rewrite the prompt/confirm in `console/app/memory-stores/[id]/browser.tsx`**

Add `import { Modal, Field, ConfirmDialog } from "../../lib/modal";`. Replace the `addFile` flow with a pending-file modal and the delete confirm with `ConfirmDialog`:

```tsx
  const [pending, setPending] = useState<File | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
```

File input onChange becomes: `onChange={(e) => { const f = e.target.files?.[0]; if (f) { setPending(f); setPath(f.name); setError(null); } e.target.value = ""; }}`.

Add after the button row:

```tsx
      {pending && (
        <Modal title="Add memory" width="sm" onClose={() => setPending(null)} busy={busy} error={error}
          subtitle={`Uploading ${pending.name} (${(pending.size / 1024).toFixed(1)} KB).`}
          footer={<>
            <button className="ghost" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
            <button disabled={busy || !path.trim()} onClick={async () => {
              setBusy(true); setError(null);
              const body = new FormData();
              body.append("file", pending);
              const res = await fetch(`/api/v1/memory-stores/${storeId}/entries?path=${encodeURIComponent(path)}`, {
                method: "POST", headers: wsHeader(), body,
              });
              setBusy(false);
              if (res.ok) { setPending(null); router.refresh(); }
              else setError(`Add failed: ${res.status}`);
            }}>{busy ? "Adding…" : "Add memory"}</button>
          </>}>
          <Field label="Memory path" required hint="where agents see it under /mnt/memory">
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="index/notes.json" />
          </Field>
        </Modal>
      )}
```

Replace the delete button's `confirm()` handler with:

```tsx
                  <button className="ghost danger" onClick={() => setDeleting(true)}>Delete</button>
```

and render next to it:

```tsx
                  {deleting && loaded && <ConfirmDialog title="Delete memory" verb="Delete"
                    message={`Delete "${loaded}" from this store?`}
                    onClose={() => setDeleting(false)}
                    onConfirm={async () => {
                      const res = await fetch(`/api/v1/memory-stores/${storeId}/entries?path=${encodeURIComponent(loaded)}`,
                        { method: "DELETE", headers: wsHeader() });
                      if (!res.ok) return `Delete failed: ${res.status}`;
                      setLoaded(null); router.refresh(); return null;
                    }} />}
```

Delete the old `addFile` function.

- [ ] **Step 6: Build + commit**

```
cd console && npx next build
```
Expected: PASS.

```bash
git add console/app/nav.tsx console/app/api-keys/create.tsx console/app/skills/create.tsx console/app/memory-stores
git commit -m "feat(console): modals replace prompt() — workspace, API key, skill, memory store/path"
```

---

### Task 10: Migrate the remaining bespoke overlays + inline errors for `alert()`s

**Files:**
- Modify: `console/app/sessions/create.tsx`, `console/app/batches/create.tsx`, `console/app/environments/create.tsx`, `console/app/vaults/create.tsx`, `console/app/vaults/[id]/credentials.tsx`, `console/app/files/upload.tsx`, `console/app/sessions/[id]/trace.tsx`

**Interfaces:**
- Consumes: `Modal`, `Field` (Task 3). No export signature changes anywhere in this task.

- [ ] **Step 1: Rewrite `console/app/sessions/create.tsx`**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { wsHeader } from "../lib/client";
import { Modal, Field } from "../lib/modal";

export function CreateSession({ agents }: { agents: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ agent: agents[0]?.id ?? "", name: "", prompt: "" });

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/v1/sessions", {
        method: "POST", headers: { "Content-Type": "application/json", ...wsHeader() },
        body: JSON.stringify({ agent: form.agent, prompt: form.prompt, name: form.name || undefined }),
      });
      if (res.ok) { const { id } = await res.json(); router.push(`/sessions/${id}`); return; }
      setError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    } catch (err) { setError(String(err)); }
    setBusy(false);
  };

  return (<>
    <button onClick={() => setOpen(true)}>+ Create session</button>
    {open && (
      <Modal title="Create session" width="md" onClose={() => setOpen(false)} busy={busy} error={error}
        footer={<>
          <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button disabled={busy || !form.agent || !form.prompt} onClick={submit}>
            {busy ? "Starting…" : "Start session"}
          </button>
        </>}>
        <Field label="Agent" required>
          <select value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value })}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Name" hint="optional — e.g. a ticket id">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="First message" required stack>
          <textarea rows={4} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                    placeholder="The task for this session…" />
        </Field>
      </Modal>
    )}
  </>);
}
```

Keep `SendMessage` in the same file but replace its `alert()` with inline error state:

```tsx
export function SendMessage({ sessionId, status }: { sessionId: string; status: string }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!["idle"].includes(status)) return null;
  return (
    <div className="formrow" style={{ marginTop: 16 }}>
      <input style={{ flex: 1 }} type="text" placeholder="Send a follow-up message (resumes the session)…"
        value={prompt} onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !busy && prompt && document.getElementById("send-btn")?.click()} />
      <button id="send-btn" disabled={busy || !prompt} onClick={async () => {
        setBusy(true); setError(null);
        const res = await fetch(`/api/v1/sessions/${sessionId}/messages`, {
          method: "POST", headers: { "Content-Type": "application/json", ...wsHeader() },
          body: JSON.stringify({ prompt }),
        });
        setBusy(false);
        if (res.ok) { setPrompt(""); router.refresh(); }
        else setError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      }}>{busy ? "Sending…" : "Send"}</button>
      {error && <span className="modal-error" style={{ margin: 0 }}>{error}</span>}
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `console/app/batches/create.tsx`**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal, Field, submitJson } from "../lib/modal";

export function CreateBatch({ agents }: { agents: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState(agents[0]?.id ?? "");
  const [prompts, setPrompts] = useState("Summarize the concept of Kubernetes.\nExplain autoscaling in one sentence.");
  const lines = prompts.split("\n").map((l) => l.trim()).filter(Boolean);

  const submit = async () => {
    setBusy(true); setError(null);
    const err = await submitJson("POST", "/v1/batches", {
      agent, requests: lines.map((prompt, i) => ({ custom_id: `req-${i + 1}`, prompt })),
    });
    setBusy(false);
    if (err) setError(err); else { setOpen(false); router.refresh(); }
  };

  return (<>
    <button disabled={!agents.length} onClick={() => setOpen(true)}>+ Create batch</button>
    {open && (
      <Modal title="Create batch" width="md" onClose={() => setOpen(false)} busy={busy} error={error}
        footer={<>
          <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button disabled={busy || !agent || !lines.length} onClick={submit}>
            {busy ? "Launching…" : `Launch ${lines.length || ""} session${lines.length === 1 ? "" : "s"}`}
          </button>
        </>}>
        <Field label="Agent" required>
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Prompts" required stack hint="one prompt per line — each becomes a session">
          <textarea rows={8} value={prompts} onChange={(e) => setPrompts(e.target.value)} />
        </Field>
      </Modal>
    )}
  </>);
}
```

- [ ] **Step 3: Rewrite `console/app/environments/create.tsx`**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal, Field, submitJson } from "../lib/modal";

export function CreateEnvironment() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", hosts: "", pkg: false });

  const submit = async () => {
    setBusy(true); setError(null);
    const err = await submitJson("POST", "/v1/environments", {
      name: form.name,
      allowPackageManagers: form.pkg,
      allowedHosts: form.hosts.split(/[\n,]/).map((h) => h.trim()).filter(Boolean),
    });
    setBusy(false);
    if (err) setError(err); else { setOpen(false); router.refresh(); }
  };

  return (<>
    <button onClick={() => setOpen(true)}>+ Create environment</button>
    {open && (
      <Modal title="Create environment" width="md" onClose={() => setOpen(false)} busy={busy} error={error}
        footer={<>
          <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button disabled={busy || !form.name} onClick={submit}>{busy ? "Creating…" : "Create environment"}</button>
        </>}>
        <Field label="Name" required>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Allowed hosts" stack hint="comma or newline separated; empty = all outbound blocked">
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
    )}
  </>);
}
```

- [ ] **Step 4: Rewrite `console/app/vaults/create.tsx`**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal, Field, submitJson } from "../lib/modal";

export function CreateVault() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [pairs, setPairs] = useState("API_TOKEN=");

  const submit = async () => {
    const secrets: Record<string, string> = {};
    for (const line of pairs.split("\n")) {
      const idx = line.indexOf("=");
      if (idx > 0) secrets[line.slice(0, idx).trim()] = line.slice(idx + 1);
    }
    setBusy(true); setError(null);
    const err = await submitJson("POST", "/v1/vaults", { name, secrets });
    setBusy(false);
    if (err) setError(err); else { setOpen(false); router.refresh(); }
  };

  return (<>
    <button onClick={() => setOpen(true)}>+ Create vault</button>
    {open && (
      <Modal title="Create vault" width="md" onClose={() => setOpen(false)} busy={busy} error={error}
        footer={<>
          <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button disabled={busy || !name} onClick={submit}>{busy ? "Creating…" : "Create vault"}</button>
        </>}>
        <Field label="Name" required>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Credentials" stack
               hint="KEY=value, one per line — values are write-only (stored in a K8s Secret)">
          <textarea rows={5} style={{ fontFamily: "var(--font-mono)" }} value={pairs}
                    onChange={(e) => setPairs(e.target.value)} />
        </Field>
      </Modal>
    )}
  </>);
}
```

- [ ] **Step 5: Inline errors in `credentials.tsx` and `upload.tsx`; trace.tsx alert**

`console/app/vaults/[id]/credentials.tsx` — add `const [error, setError] = useState<string | null>(null);`, replace `alert(...)` with `setError(\`Save failed: ${res.status}\`)` (and `setError(null)` on success + before each attempt), and append inside the formrow:

```tsx
      {error && <span className="modal-error" style={{ margin: 0 }}>{error}</span>}
```

`console/app/files/upload.tsx` — same pattern: `error` state, replace `alert(\`Upload failed: ${res.status}\`)` with `setError(...)`, clear on success/next attempt, and render after the button:

```tsx
      {error && <span className="modal-error" style={{ margin: 0, marginLeft: 8 }}>{error}</span>}
```

`console/app/sessions/[id]/trace.tsx` (line ~82) — the send handler's `alert(...)`: add an `error` state next to the existing input state, set it instead of alerting (clear on success/before send), and render `{error && <span className="modal-error" style={{ margin: 0 }}>{error}</span>}` inside the `.sv-input` row.

- [ ] **Step 6: Build + commit**

```
cd console && npx next build
```
Expected: PASS.

```bash
git add console/app/sessions console/app/batches/create.tsx console/app/environments/create.tsx console/app/vaults console/app/files/upload.tsx
git commit -m "feat(console): sessions/batches/environments/vaults on shared modals; inline errors replace alert()"
```

---

### Task 11: Final sweep — grep gate, full verification, docs

**Files:**
- Modify: `CLAUDE.md` (one convention line)

- [ ] **Step 1: Grep gate — zero browser dialogs left**

```
grep -rnE "confirm\(|prompt\(|alert\(" console/app
```
Expected: **no output** (exit 1). If anything appears, fix it with the Task-3 primitives before proceeding.

- [ ] **Step 2: Backend suite + types**

Stop any running control-plane process first, then:

```
cd control-plane && npm test && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 3: Full console build + live verification**

```
cd console && npx next build && npx next start -p 7090
```

With the control plane + operator running (per CLAUDE.md run notes), walk the flows against the live cluster:
1. Every nav page returns 200 — including the new `/pools`.
2. Deployments: click a local deployment's **name** → edit modal prefilled (replicas!) → change max replicas → Save → CR patched (`kubectl get modeldeployment -n devproof-serving <name> -o yaml`). Click an external endpoint's name → edit → Save. "Add remote endpoint" button label correct; Escape closes the modal.
3. Catalog: click a bundled model's name → edit → change displayName → Save → "overridden" chip appears; reopen → "Reset to defaults" → chip gone, YAML name back. Add + remove a custom model.
4. Pools: create a pool with a `devproof.ai/pool=x` selector → visible in `kubectl get modelpool`; try deleting a pool that a deployment uses → inline 409 message in the ConfirmDialog; delete a free pool → gone.
5. Agents: detail page → "Edit agent" → change system prompt → "Save as new version" → version picker shows v2.
6. Workspace: sidebar "+ New workspace…" → modal → created + switched. API key: create via modal → non-dismissible copy modal (Escape does nothing) → Copy to clipboard works → Done. Skill upload → name modal. Memory store create + add-memory path modal + entry delete confirm.
7. One delete per remaining kind through the styled ConfirmDialog (session, batch, environment, vault, file bulk-delete, cached model).
8. Forced failure renders inline: create a deployment with a taken name (409) → red banner inside the modal, dialog stays open.

- [ ] **Step 4: Update CLAUDE.md conventions**

In the `## Conventions & gotchas` section, extend the Deployments-UI bullet (or add below it):

```markdown
- **Dialogs:** every create/edit/confirm uses the shared `Modal`/`Field`/`ConfirmDialog` in `console/app/lib/modal.tsx` — browser `prompt()`/`confirm()`/`alert()` are banned in the console. Edit opens by clicking the row's **name** (deployments/catalog/pools); agents edit from their detail page (each save = new version). Node selectors live on Pools (`/pools`).
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: dialog-system + name-click-edit conventions"
```

---

## Self-Review (done at plan time)

- **Spec coverage:** §1 primitives → Task 3; §2 deployments/catalog/pools/agents/workspace/api-keys/skills/memory/sessions-batches-envs-vaults-upload → Tasks 5/6/7/8/9/10; §3 backend → Tasks 1/2 (+ operator-reconcile check in Task 7 Step 5); §4 inventory → Tasks 4–10; §5 verification → Task 11. Out-of-scope list respected (no deployment detail pages, no toasts).
- **Type consistency:** `submitJson` returns `Promise<string|null>` everywhere; `ConfirmDialog.onConfirm` matches; `EditDeploymentName` prop union copied verbatim from the old `EditDeploymentButton`; `DeleteButton` public props unchanged (14 call sites listed in exploration compile untouched); `agent.versions[0]` latest confirmed against `repo.ts:110`.
- **Placeholders:** none — every step carries full code or an exact command with expected output.
