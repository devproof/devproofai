# Deployment UI Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deployment UI's inline-card add-form and `prompt()`-based edits with one shared centered-modal used for deploy-local / deploy-remote / edit-local / edit-remote, move "Add endpoint" into the page header, and give catalog "Deploy" a real name/pool/replicas/context form.

**Architecture:** A remote endpoint is a *kind of deployment* — no catalog change, no migration, no gateway/auth/metering change. One new client component (`deploy-modal.tsx`) holds all four modes; the Deployments page and catalog Deploy button open it; the old `external.tsx` add-card and both `prompt()` dialogs are deleted. One additive server field (`contextTokens` on local deploy). Spec: `docs/superpowers/specs/2026-07-09-deployment-ui-rework-design.md`.

**Tech Stack:** Next.js console (client components, `wsHeader()` from `app/lib/client.ts`, `/api` rewrite), Fastify/TS control plane (Node test runner).

## Global Constraints

- **UI-only rework** except one control-plane field. Do NOT touch: migrations, `external_deployments` schema, repo methods, `deploy/gateway/litellm.yaml`, auth/metering/sanitizer.
- No `prompt()` or `confirm()`-for-input anywhere in the new code. A single `confirm()` on a destructive **delete** is allowed (existing pattern, kept).
- The modal reuses the existing overlay pattern from `console/app/catalog/create.tsx` (`fixed inset-0` scrim + `.card`, ~560px, `formrow` field rows).
- Every fetch in new code is wrapped in try/catch/finally: non-ok → alert server error; network throw → alert + clear busy (never strand).
- Client validation mirrors server: name required; `custom` provider requires baseUrl; name immutable on edit.
- Name uniqueness is already enforced server-side (409 both directions) — the UI just surfaces the error.
- Provider presets (exact): openai `https://api.openai.com/v1`, anthropic `https://api.anthropic.com`, openrouter `https://openrouter.ai/api/v1`, custom `` (empty, required). Enum: `openai|anthropic|openrouter|custom`.
- Console verify = production build only (`cd console && npx next build`). Backend verify = `cd control-plane && npm test && npx tsc --noEmit`.
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `control-plane/src/catalog.ts` | modify | `DeploymentRequest.contextTokens?` + honor it in `resolveDeployment` |
| `control-plane/test/catalog.test.ts` | modify | assert contextTokens override + replicas passthrough |
| `console/app/deployments/deploy-modal.tsx` | create | the one shared modal (4 modes) + the thin opener buttons |
| `console/app/deployments/page.tsx` | modify | header "Add endpoint"; row Edit opens modal; wire delete |
| `console/app/deployments/external.tsx` | delete | inline card + prompt edit removed (opener moves to deploy-modal.tsx) |
| `console/app/deployments/edit-local.tsx` | delete | prompt dialog removed (opener moves to deploy-modal.tsx) |
| `console/app/actions.tsx` | modify | `DeployButton` opens the modal in deploy-local mode |

---

### Task 1: Control-plane — `contextTokens` on local deploy

**Files:**
- Modify: `control-plane/src/catalog.ts` (`DeploymentRequest` ~line 33, `resolveDeployment` ~line 64)
- Test: `control-plane/test/catalog.test.ts`

**Interfaces:**
- Produces: `DeploymentRequest` gains `contextTokens?: number`; `resolveDeployment` sets `spec.model.contextTokens = req.contextTokens ?? entry.contextTokens ?? 0`. Consumed by Task 2's `deploy-local` POST body.

- [ ] **Step 1: Write the failing test**

Append to `control-plane/test/catalog.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npx tsx --test test/catalog.test.ts`
Expected: FAIL — `contextTokens` not on `DeploymentRequest` (tsx) / assertion mismatch (16384 vs entry default).

- [ ] **Step 3: Implement**

In `control-plane/src/catalog.ts`, add to `DeploymentRequest`:

```ts
export interface DeploymentRequest {
  name: string;
  catalogId: string;
  poolRef: string;
  replicas?: { min: number; max: number };
  contextTokens?: number;
}
```

In `resolveDeployment`, change the `model` line:

```ts
      model: { source: entry.source, format: entry.format, contextTokens: req.contextTokens ?? entry.contextTokens ?? 0 },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npx tsx --test test/catalog.test.ts`
Expected: all pass (existing 3 + new).

- [ ] **Step 5: Full backend verify + commit**

```bash
cd control-plane && npm test && npx tsc --noEmit
git add control-plane/src/catalog.ts control-plane/test/catalog.test.ts
git commit -m "feat(deployments): honor per-deploy contextTokens override in resolveDeployment"
```

---

### Task 2: Shared deploy/edit modal

**Files:**
- Create: `console/app/deployments/deploy-modal.tsx`

**Interfaces:**
- Consumes: `wsHeader()` from `app/lib/client.ts`; routes `POST /v1/deployments`, `POST /v1/deployments/external`, `POST /v1/deployments/external/test`, `PATCH /v1/deployments/:name`, `PATCH /v1/deployments/external/:id`, `GET /v1/pools`.
- Produces (consumed by Tasks 3 & 4):
  - `DeployModal` (internal) — the overlay, driven by a `mode` + context props.
  - `AddEndpointButton()` — header button, opens `deploy-remote`.
  - `DeployLocalButton({ catalogId, defaultName, small? })` — catalog row button, opens `deploy-local`.
  - `EditDeploymentButton({ kind, ...ctx })` — row Edit button, opens `edit-local` or `edit-remote`.

- [ ] **Step 1: Write the component**

```tsx
// console/app/deployments/deploy-modal.tsx
"use client";
// One centered modal for every deploy/edit flow (spec 2026-07-09). No prompt().
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { wsHeader } from "../lib/client";
import { Icon } from "../lib/icons";

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
  const [probe, setProbe] = useState<string | null>(null);
  const [pools, setPools] = useState<string[]>([]);

  // local fields
  const [name, setName] = useState(ctx.name ?? ctx.defaultName ?? "");
  const [poolRef, setPoolRef] = useState(ctx.poolRef ?? "");
  const [minR, setMinR] = useState("1");
  const [maxR, setMaxR] = useState("1");
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

  const call = async (url: string, method: string, body: unknown) => {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method, headers: { "Content-Type": "application/json", ...wsHeader() },
        body: JSON.stringify(body),
      });
      if (res.ok) { onClose(); router.refresh(); }
      else alert(`Failed: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
    } catch (err) {
      alert(`Failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true); setProbe(null);
    try {
      const res = await fetch("/api/v1/deployments/external/test", {
        method: "POST", headers: { "Content-Type": "application/json", ...wsHeader() },
        body: JSON.stringify({ provider, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined }),
      });
      const j = await res.json();
      setProbe(j.ok ? `✓ ${j.detail}` : `✗ ${j.detail ?? j.error}`);
    } catch (err) {
      setProbe(`✗ ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (mode === "deploy-local")
      return call("/api/v1/deployments", "POST", {
        name, catalogId: ctx.catalogId, poolRef,
        replicas: { min: Number(minR) || 0, max: Number(maxR) || 0 },
        ...(ctxTokens ? { contextTokens: Number(ctxTokens) } : {}),
      });
    if (mode === "deploy-remote")
      return call("/api/v1/deployments/external", "POST", {
        name, provider, baseUrl: baseUrl || undefined, modelId, apiKey: apiKey || undefined,
      });
    if (mode === "edit-local")
      return call(`/api/v1/deployments/${ctx.name}`, "PATCH", {
        replicas: { min: Number(minR) || 0, max: Number(maxR) || 0 },
        ...(ctxTokens ? { contextTokens: Number(ctxTokens) } : {}),
      });
    // edit-remote
    return call(`/api/v1/deployments/external/${ctx.externalId}`, "PATCH", {
      modelId: modelId || undefined, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined,
    });
  };

  const title = mode === "deploy-local" ? "Deploy model"
    : mode === "deploy-remote" ? "Add remote endpoint"
    : mode === "edit-local" ? `Edit ${ctx.name}`
    : `Edit ${ctx.name}`;

  const canSubmit = isEdit
    ? !busy
    : !busy && !!name && (isLocal ? !!poolRef : (!!modelId && (provider !== "custom" || !!baseUrl)));

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(10,20,40,.45)", zIndex: 20, display: "grid", placeItems: "center" }}>
      <div className="card" style={{ width: 560, maxHeight: "88vh", overflowY: "auto" }}>
        <h1 style={{ fontSize: 18, marginBottom: 12 }}>{title}</h1>

        {!isEdit && (
          <label className="formrow">
            <span style={{ width: 90, color: "var(--muted)" }}>Name</span>
            <input style={{ flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="deployment name" />
          </label>
        )}
        {isEdit && <p className="sub" style={{ marginTop: 0 }}>Name <code>{ctx.name}</code> is immutable.</p>}

        {isLocal ? (
          <>
            <label className="formrow">
              <span style={{ width: 90, color: "var(--muted)" }}>Pool</span>
              {mode === "deploy-local"
                ? <select value={poolRef} onChange={(e) => setPoolRef(e.target.value)}>
                    {pools.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                : <code>{ctx.poolRef ?? "—"}</code>}
            </label>
            <label className="formrow">
              <span style={{ width: 90, color: "var(--muted)" }}>Replicas</span>
              min <input style={{ width: 70 }} value={minR} onChange={(e) => setMinR(e.target.value)} />
              max <input style={{ width: 70 }} value={maxR} onChange={(e) => setMaxR(e.target.value)} />
            </label>
            <label className="formrow">
              <span style={{ width: 90, color: "var(--muted)" }}>Context</span>
              <input style={{ width: 120 }} value={ctxTokens} onChange={(e) => setCtxTokens(e.target.value)}
                     placeholder={mode === "edit-local" ? "unchanged" : "default"} /> tokens
            </label>
          </>
        ) : (
          <>
            {mode === "deploy-remote" && (
              <label className="formrow">
                <span style={{ width: 90, color: "var(--muted)" }}>Provider</span>
                <select value={provider} onChange={(e) => { setProvider(e.target.value); setBaseUrl(""); setProbe(null); }}>
                  {Object.entries(PRESETS).map(([v, p]) => <option key={v} value={v}>{p.label}</option>)}
                </select>
              </label>
            )}
            <label className="formrow">
              <span style={{ width: 90, color: "var(--muted)" }}>Model id</span>
              <input style={{ flex: 1 }} value={modelId} onChange={(e) => setModelId(e.target.value)}
                     placeholder={PRESETS[provider]?.hint} />
            </label>
            <label className="formrow">
              <span style={{ width: 90, color: "var(--muted)" }}>Base URL</span>
              <input style={{ flex: 1 }} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                     placeholder={provider === "custom" ? "required (e.g. http://host.docker.internal:8081/v1)" : `default: ${PRESETS[provider]?.base}`} />
            </label>
            <label className="formrow">
              <span style={{ width: 90, color: "var(--muted)" }}>API key</span>
              <input style={{ flex: 1 }} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                     placeholder={isEdit ? "leave empty to keep current" : "write-only, optional for local"} />
            </label>
            <div className="formrow" style={{ alignItems: "center" }}>
              <button className="ghost" disabled={busy} onClick={test}>Test connection</button>
              {probe && <span style={{ fontSize: 12, color: probe.startsWith("✓") ? "var(--blue)" : "#d97706" }}>{probe}</span>}
              <span style={{ color: "var(--muted)", fontSize: 12, marginLeft: "auto" }}>runs on: remote ({provider})</span>
            </div>
          </>
        )}

        <div className="formrow" style={{ justifyContent: "flex-end", marginTop: 8 }}>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button disabled={!canSubmit} onClick={submit}>
            {busy ? "Working…" : isEdit ? "Save" : "Deploy"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AddEndpointButton() {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}><Icon.deploy /> Add endpoint</button>
    {open && <DeployModal mode="deploy-remote" ctx={{}} onClose={() => setOpen(false)} />}
  </>);
}

export function DeployLocalButton({ catalogId, defaultName, small }: { catalogId: string; defaultName: string; small?: boolean }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button className={small ? "deploy-sm" : ""} onClick={() => setOpen(true)}><Icon.deploy /> Deploy</button>
    {open && <DeployModal mode="deploy-local" ctx={{ catalogId, defaultName }} onClose={() => setOpen(false)} />}
  </>);
}

export function EditDeploymentButton(props:
  | { kind: "local"; name: string; poolRef?: string }
  | { kind: "external"; name: string; externalId: string; provider?: string; baseUrl?: string | null; modelId?: string }) {
  const [open, setOpen] = useState(false);
  const mode = props.kind === "local" ? "edit-local" : "edit-remote";
  const ctx: Ctx = props.kind === "local"
    ? { name: props.name, poolRef: props.poolRef }
    : { name: props.name, externalId: props.externalId, provider: props.provider, baseUrl: props.baseUrl, modelId: props.modelId };
  return (<>
    <button className="iconbtn" title="Edit deployment" aria-label="Edit deployment" onClick={() => setOpen(true)}>✎</button>
    {open && <DeployModal mode={mode} ctx={ctx} onClose={() => setOpen(false)} />}
  </>);
}
```

- [ ] **Step 2: Compile-check via the build in Task 3** (this file has no standalone test; it's exercised by the page build + manual e2e). For now just confirm it type-checks by importing it — done in Task 3's build. Commit after Task 3 wires it (so the build proves it compiles). Skip a standalone commit here to avoid committing an unreferenced file.

(No commit yet — Task 3 imports this file and runs the build that validates it.)

---

### Task 3: Wire the Deployments page + delete old files

**Files:**
- Modify: `console/app/deployments/page.tsx`
- Delete: `console/app/deployments/external.tsx`, `console/app/deployments/edit-local.tsx`

**Interfaces:**
- Consumes: `AddEndpointButton`, `EditDeploymentButton` from Task 2's `deploy-modal.tsx`; `DeploymentActions` (existing delete for local) from `../actions`.
- Note: `ExternalActions` (external delete) lived in the deleted `external.tsx`. Replace external-row delete with a small inline delete using the existing `DeleteButton` from `app/lib/delete.tsx` (used elsewhere in the app), pointed at `/v1/deployments/external/:id`.

- [ ] **Step 1: Confirm the shared delete helper exists**

Run: `grep -n "export function DeleteButton" console/app/lib/delete.tsx`
Expected: a `DeleteButton({ path, confirmText, label })` export (used by the catalog page). If its props differ, adapt the usage below to match its real signature.

- [ ] **Step 2: Rewrite `page.tsx`**

Replace the imports and the two wiring points. New imports:

```tsx
import { DeploymentActions, RefreshButton, SyncButton } from "../actions";
import { AutoRefresh } from "./autorefresh";
import { wsGet, offsetOf } from "../lib/api";
import { Pager } from "../lib/pager";
import { AddEndpointButton, EditDeploymentButton } from "./deploy-modal";
import { DeleteButton } from "../lib/delete";
```

Pagehead — add `AddEndpointButton` as a header action, remove the standalone `<AddEndpointButton />` line under `<p className="sub">`:

```tsx
      <div className="pagehead">
        <h1>Deployments</h1>
        <div className="formrow" style={{ margin: 0 }}><AddEndpointButton /><SyncButton /><RefreshButton /></div>
      </div>
      <p className="sub">Models serving through the gateway — local (cluster pods) and remote (external providers). Deploy local models from the catalog.</p>
```

(Delete the old `<AddEndpointButton />` that was on its own line after the `<p className="sub">`.)

Actions cell — replace with modal-based edit + appropriate delete:

```tsx
              <td>{d.kind === "external"
                ? <div className="rowactions">
                    <EditDeploymentButton kind="external" name={d.name} externalId={d.id!} provider={d.provider} baseUrl={d.baseUrl ?? null} modelId={d.modelId} />
                    <DeleteButton path={`/v1/deployments/external/${d.id}`} confirmText={`Remove endpoint "${d.name}"? The gateway route disappears immediately.`} label="Remove" />
                  </div>
                : <div className="rowactions">
                    <EditDeploymentButton kind="local" name={d.name} poolRef={d.poolRef} />
                    <DeploymentActions name={d.name} />
                  </div>}</td>
```

- [ ] **Step 3: Delete the obsolete files**

```bash
git rm console/app/deployments/external.tsx console/app/deployments/edit-local.tsx
```

- [ ] **Step 4: Build**

```bash
cd console && npx next build
```
Expected: compiles clean (proves Task 2's `deploy-modal.tsx` type-checks and nothing still imports the deleted files). If the build reports a leftover import of `external`/`edit-local`, fix that importer (should only be `page.tsx` and `actions.tsx` — `actions.tsx` is Task 4).

- [ ] **Step 5: Commit**

```bash
git add console/app/deployments/page.tsx console/app/deployments/deploy-modal.tsx
git commit -m "feat(console): shared deploy/edit modal; move Add-endpoint to header; drop inline card + prompt() edits"
```

(The `git rm` from Step 3 is included in this commit.)

---

### Task 4: Catalog + dashboard Deploy buttons open the modal

**Files:**
- Modify: `console/app/actions.tsx` (`DeployButton`), `console/app/catalog/page.tsx` (usage), `console/app/page.tsx` (dashboard usage)

**Interfaces:**
- Consumes: `DeployLocalButton` from Task 2.

- [ ] **Step 1: Repoint BOTH Deploy-button usages**

`DeployButton catalogId={m.id} small` is used in TWO places (verified): `console/app/catalog/page.tsx:67` and `console/app/page.tsx:49` (dashboard). Swap both to the modal opener.

In `console/app/catalog/page.tsx` — change the import and usage:

```tsx
import { DeployLocalButton } from "../deployments/deploy-modal";
```
```tsx
                  <DeployLocalButton catalogId={m.id} defaultName={m.id} small />
```

In `console/app/page.tsx` — same:

```tsx
import { DeployLocalButton } from "./deployments/deploy-modal";
```
```tsx
            <div style={{ marginTop: 10 }}><DeployLocalButton catalogId={m.id} defaultName={m.id} small /></div>
```

(Note the relative import path differs: `../deployments/` from catalog, `./deployments/` from the dashboard root.)

- [ ] **Step 2: Remove the now-unused `DeployButton`**

In `console/app/actions.tsx`, delete the `DeployButton` export (lines ~12-35) — replaced by `DeployLocalButton`. Keep `DeploymentActions`, `RefreshButton`, `SyncButton`, `syncGateway`. Confirm nothing else imports `DeployButton`:

Run: `grep -rn "\bDeployButton\b" console/app`
Expected: no remaining references (only `DeployLocalButton`).

- [ ] **Step 3: Build**

```bash
cd console && npx next build
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add console/app/actions.tsx console/app/catalog/page.tsx console/app/page.tsx
git commit -m "feat(console): catalog + dashboard Deploy opens the deploy modal (name/pool/replicas/context)"
```

---

### Task 5: E2E verification

**Files:** none (verification + a short note if anything surfaces).

- [ ] **Step 1: Restart the console on the merged code**

Kill the stale console on :7090 (German-locale netstat: LISTEN shows as `ABHÖREN`; `netstat -ano | grep ":7090"`, take the numeric pid, `taskkill //F //PID <pid>`), then `cd console && npx next start -p 7090` in background (`.next` is current from Task 4's build). Control plane + operator are already running; if the control plane isn't, start it per CLAUDE.md (needs the Task 1 change, so restart it: kill :7080 pid, then the `npx tsx src/main.ts` command with the env vars). Leave all running.

- [ ] **Step 2: Manual checklist (live)**

1. `/deployments`: "Add endpoint" is in the header row next to Sync/Refresh; clicking opens a centered modal and the **table does not shift**.
2. Add a remote `custom` endpoint via the modal (baseUrl `http://qwen05b-dp.devproof-serving.svc.cluster.local:8080/v1`, modelId `qwen05b-dp`, no key), Test connection shows a result, Deploy → row appears (External, pool `remote`). Wait for the gateway rollout the sync triggers.
3. Create a key on `/api-keys`, chat via the new endpoint name through the gateway (`curl /v1/messages` on :14000), confirm a `gateway_usage` row under the endpoint name (`kubectl exec ... psql ... SELECT model,tokens_in FROM gateway_usage ORDER BY id DESC LIMIT 1`).
4. `/catalog`: Deploy a small local model (e.g. `qwen2.5-0.5b-instruct-q4`) via the modal — it asks name / pool (`cpu-default`) / replicas / context; set replicas 1/2 + context 16384, Deploy. Verify `kubectl get modeldeployment <name> -n devproof-serving -o jsonpath='{.spec.replicas}{" "}{.spec.model.contextTokens}'` → `{"min":1,"max":2} 16384`.
5. Edit that local deployment (change replicas) and Edit the remote endpoint (rotate a dummy key) — both via the modal, **no `prompt()` dialogs**.
6. Regression: all console pages 200; an Anthropic-dialect coding CLI still answers against a local GGUF model (sanitizer intact); `cd control-plane && npm test && npx tsc --noEmit` green.
7. Clean up the test endpoint + test deployment created above (via each row's Remove).

- [ ] **Step 3: Docs + commit**

Update `CLAUDE.md` deployments note if needed (one line: deploy/edit is a shared modal; remote endpoints are deployments with a remote backend). Then:

```bash
git add CLAUDE.md
git commit -m "docs: deployment UI is a shared deploy/edit modal (local + remote)"
```

---

## Self-Review Notes

- **Spec coverage:** shared modal 4 modes (T2), header button + delete old UI (T3), catalog Deploy form (T4), contextTokens server field (T1), e2e incl. no-table-shift + usage-still-metered + real deploy form (T5). "No prompt()" — the two prompt files are deleted (T3), modal has none (T2).
- **Placeholder scan:** clean. Task 2 has no standalone commit by design (unreferenced until T3) — called out explicitly.
- **Type consistency:** `DeployLocalButton`/`AddEndpointButton`/`EditDeploymentButton` signatures defined in T2 match their uses in T3/T4; `DeploymentRequest.contextTokens` (T1) matches the T2 deploy-local body; external row fields (`id/provider/baseUrl/modelId`) from the existing GET contract feed `EditDeploymentButton` in T3.
- **Assumption to verify during T3 Step 1:** `DeleteButton`'s real prop names in `app/lib/delete.tsx` — the plan adapts if they differ.
