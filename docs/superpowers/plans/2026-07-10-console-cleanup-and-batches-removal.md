# Console Cleanup + Batches Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the skill-update 500, remove the batches feature end-to-end (console, API, repo, DB), restructure the console navigation (dissolve Build, add MANAGE), uppercase the tab title, trim the overview page, and add two dashboard header buttons.

**Architecture:** Devproof AI console (Next.js, port 7090, production builds only) + control plane (Fastify/TS, port 7080, Postgres). Spec: `docs/superpowers/specs/2026-07-10-console-cleanup-and-batches-removal-design.md`. All changes are deletions or small surgical edits; the only new file is migration `018_drop_batches.sql`.

**Tech Stack:** TypeScript, Fastify, node:test (`npm test` = `node --import tsx --test "test/*.test.ts"`), Postgres (dev DB on `localhost:15432`, migrations auto-applied by `migrate()` in lexical order), Next.js App Router.

## Global Constraints

- Browser-tab title is exactly `DEVPROOF.AI — Control Plane`.
- Nav group order/content: (untitled) Dashboard; **Managed Agents**: Agents, Skills, Sessions, Environments, Credential vaults, Files, Memory stores; **Serving**: Model catalog, Deployments, Pools, Cache (unchanged); **Analytics**: Usage; **Manage**: API keys. The **Build** group is gone. Group titles are CSS-uppercased — the string is `"Manage"`, never `"MANAGE"`.
- Page routes never change; only the menu moves. `/batches` routes are deleted entirely.
- `repo.createFileRecord` insert gains `ON CONFLICT (id) DO NOTHING` — content-addressed ids (`file_<sha256>`) mean same id ⇒ same bytes.
- Migration `control-plane/sql/018_drop_batches.sql` drops `batch_items` then `batches` with `IF EXISTS`; migrations 011/014 stay untouched.
- Dashboard: the four stat cards stay (including Catalog); only the "Models" section (group header + model-card grid) goes. Header buttons: `Generate an API key` (ghost, key icon, real create-key modal via reusable `CreateApiKey`) LEFT of `Build an agent` (solid, agent icon).
- The `.btn` class alone (not `button` globally) gets `display: inline-flex; align-items: center; gap: 7px; justify-content: center`.
- Console dialogs use the shared `Modal` (`app/lib/modal.tsx`); no browser `prompt()`/`confirm()`/`alert()`. No transparent text buttons (ghost = solid panel fill).
- Console builds are production: `npx next build` (never dev mode). Backend gates: `npm test` green + `npx tsc --noEmit` clean in `control-plane/`.
- Work happens on branch `feature/console-cleanup` off `main`.

---

### Task 0 (controller, no subagent): create the branch

Run before dispatching Task 1:

```bash
cd C:/Users/carst/Desktop/devproofai && git checkout -b feature/console-cleanup
```

---

### Task 1: `createFileRecord` upsert — fixes skill-update 500

**Files:**
- Modify: `control-plane/src/repo.ts:572-578` (method `createFileRecord`)
- Test: `control-plane/test/repo.test.ts` (append one test before the `test.after` at the bottom)

**Interfaces:**
- Consumes: existing `Repo` class, `files` table (`id TEXT PRIMARY KEY`, content-addressed `file_<sha256>` ids from `filestore.ts put()`).
- Produces: `createFileRecord(meta)` keeps its exact signature and still returns `meta`; duplicate-id inserts become no-ops. No caller changes anywhere.

**Background for the implementer:** File ids are content-addressed (`file_<sha256>`). Re-publishing a skill (`POST /v1/skills?name=X`) re-inserts a `files` row per package file; any file whose bytes already exist violates `files_pkey` → Postgres error `23505` → 500. Reproduced live on 2026-07-10. The fix is a conflict-tolerant insert: same id ⇒ same bytes, so the existing row already describes the content.

`test/repo.test.ts` runs against the live dev Postgres (`localhost:15432`) and self-skips when unreachable — the DB is expected to be up; if the new test reports `skip`, stop and report BLOCKED rather than claiming success.

- [ ] **Step 1: Write the failing test**

In `control-plane/test/repo.test.ts`, insert before the `test.after(async () => { await pool.end(); });` line:

```ts
test("createFileRecord tolerates re-inserting a content-addressed id", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const id = `file_dup${Date.now()}`;
  const meta = { id, name: "skill/t/SKILL.md", size: 5, sha256: `sha-${id}`, kind: "skill", workspaceId: "wrkspc_default" };
  await repo.createFileRecord(meta);
  // Same bytes re-uploaded (e.g. unchanged file inside an updated skill zip) → same id.
  await repo.createFileRecord({ ...meta, name: "skill/t2/SKILL.md" });
  const { rows } = await pool.query("SELECT name FROM files WHERE id = $1", [id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "skill/t/SKILL.md"); // first record wins; duplicate insert is a no-op
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npx tsx --test test/repo.test.ts`
Expected: the new test FAILS with `duplicate key value violates unique constraint "files_pkey"` (code 23505). All pre-existing tests in the file still pass.

- [ ] **Step 3: Make the insert conflict-tolerant**

In `control-plane/src/repo.ts`, `createFileRecord` currently reads:

```ts
  async createFileRecord(meta: { id: string; name: string; size: number; sha256: string; sessionId?: string; kind?: string; workspaceId?: string }) {
    await this.pool.query(
      "INSERT INTO files (id, workspace_id, session_id, name, size, sha256, kind) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [meta.id, meta.workspaceId ?? DEFAULT_WORKSPACE, meta.sessionId ?? null, meta.name, meta.size, meta.sha256, meta.kind ?? "upload"],
    );
    return meta;
  }
```

Change only the SQL string (add `ON CONFLICT (id) DO NOTHING` and a comment line above the method):

```ts
  // Content-addressed ids (file_<sha256>): same id ⇒ same bytes, so a duplicate
  // insert (re-uploaded file, re-published skill) is a no-op, not an error.
  async createFileRecord(meta: { id: string; name: string; size: number; sha256: string; sessionId?: string; kind?: string; workspaceId?: string }) {
    await this.pool.query(
      "INSERT INTO files (id, workspace_id, session_id, name, size, sha256, kind) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING",
      [meta.id, meta.workspaceId ?? DEFAULT_WORKSPACE, meta.sessionId ?? null, meta.name, meta.size, meta.sha256, meta.kind ?? "upload"],
    );
    return meta;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd control-plane && npx tsx --test test/repo.test.ts`
Expected: PASS, including the new test.

- [ ] **Step 5: Full backend gate**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: all tests pass (57 existing + 1 new), tsc emits nothing.

- [ ] **Step 6: End-to-end confirmation against the live control plane**

The control plane runs on `localhost:7080` (restart not needed for this check only if it was restarted after the code change — restart it first; it runs out-of-cluster via `npx tsx src/main.ts`, see CLAUDE.md for the full env). Then:

```bash
cd /tmp && printf '# e2e skill' > e2e.md
curl -s -X POST "http://127.0.0.1:7080/v1/skills?name=e2e-upd" -H "X-Devproof-Workspace: wrkspc_default" -F "file=@e2e.md"
curl -s -X POST "http://127.0.0.1:7080/v1/skills?name=e2e-upd" -H "X-Devproof-Workspace: wrkspc_default" -F "file=@e2e.md"
```

Expected: BOTH calls return 201 JSON; the second shows `"version":2` (before the fix it returned a 500 with `files_pkey`). Clean up: `curl -s -X DELETE "http://127.0.0.1:7080/v1/skills/<id-from-response>" -H "X-Devproof-Workspace: wrkspc_default"`.

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/repo.ts control-plane/test/repo.test.ts
git commit -m "fix(control-plane): skill re-publish 500 — createFileRecord tolerates duplicate content-addressed ids"
```

---

### Task 2: Remove batches from the control plane + DB + docs

**Files:**
- Modify: `control-plane/src/agents-api.ts:579-611` (delete the batches route block)
- Modify: `control-plane/src/repo.ts` (delete `deleteBatch` at ~512-514 and the `── Batches ──` section at ~707-749)
- Modify: `control-plane/test/agents-api.test.ts:94` (delete the `deleteBatch` mock line)
- Create: `control-plane/sql/018_drop_batches.sql`
- Modify: `CLAUDE.md:36` (ID list), `README.md:22` (feature list)
- Test: existing suite (`npm test`) — removal has no new behavior to test; the gate is green tests + clean tsc + tables actually dropped.

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `/v1/batches*` endpoints no longer exist (404 via Fastify default); `Repo` no longer has any batch method; tables `batches`/`batch_items` are dropped. Task 3 deletes the console pages that called these endpoints — between Tasks 2 and 3 the console's `/batches` page would error if visited; that transient is acceptable on a feature branch.

- [ ] **Step 1: Delete the batches routes**

In `control-plane/src/agents-api.ts`, delete this entire block (it is the last block in `registerAgentRoutes`, ending just before the function's closing `}`):

```ts
  // ── Batches (fan a prompt list across sessions of one agent) ──
  app.get("/v1/batches", async (req) => {
    await repo.reconcileBatches(ws(req));
    const { limit, offset } = pg(req);
    const { rows, count } = await repo.listBatches(ws(req), limit, offset);
    return { batches: rows, count, offset };
  });
  app.get("/v1/batches/:id/items", async (req) => ({ items: await repo.getBatchItems(ws(req), (req.params as any).id) }));
  app.delete("/v1/batches/:id", async (req, reply) => {
    await repo.deleteBatch(ws(req), (req.params as any).id);
    return reply.code(204).send();
  });
  app.post("/v1/batches", async (req, reply) => {
    const b = req.body as { agent: string; requests: { custom_id: string; prompt: string }[] };
    if (!b?.agent || !Array.isArray(b.requests) || !b.requests.length) {
      return reply.code(400).send({ error: "agent and non-empty requests[] required" });
    }
    const workspace = ws(req);
    const batch = await repo.createBatch(workspace, b.agent, b.requests.map((r) => ({ customId: r.custom_id })));
    // Fan out: one session per request.
    for (const r of b.requests) {
      let session;
      try {
        session = await repo.createSession(workspace, b.agent, r.prompt, `batch:${r.custom_id}`);
      } catch (err: any) {
        return reply.code(404).send({ error: err.message });
      }
      const skills = (await repo.listSkills(workspace, (session.config as any).skill_ids ?? [])).map((s: any) => ({ name: s.name, files: s.files ?? [{ path: "SKILL.md", fileId: s.file_id }] }));
      await orchestrator.startSession({ id: session.id, prompt: r.prompt, config: session.config, skills });
      await repo.attachBatchSession(batch.id, r.custom_id, session.id);
    }
    return reply.code(201).send({ id: batch.id, processing_status: "in_progress", request_counts: { total: b.requests.length } });
  });
```

Also update the comment on the agent-delete route at `agents-api.ts:336` from
`// Cascades sessions/batches/versions (FKs). Stop any running session pods first.` to
`// Cascades sessions/versions (FKs). Stop any running session pods first.`

- [ ] **Step 2: Delete the repo methods**

In `control-plane/src/repo.ts` delete BOTH of these:

(a) the `deleteBatch` method (sits between `deleteEnvironment` and the Custom-catalog section):

```ts
  async deleteBatch(workspaceId: string, id: string) {
    await this.pool.query("DELETE FROM batches WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  }
```

(b) the entire `// ── Batches ──…` section at the bottom of the class — everything from the `// ── Batches ──` comment line through the closing brace of `reconcileBatches` (methods `createBatch`, `attachBatchSession`, `listBatches`, `getBatchItems`, `reconcileBatches`). The class's closing `}` stays.

- [ ] **Step 3: Delete the test mock**

In `control-plane/test/agents-api.test.ts` delete the line:

```ts
    async deleteBatch() {},
```

- [ ] **Step 4: Write migration 018**

Create `control-plane/sql/018_drop_batches.sql`:

```sql
-- Batches feature removed 2026-07-10 (spec: 2026-07-10-console-cleanup-and-batches-removal).
-- Sessions created by batches survive as ordinary sessions (named batch:<custom_id>).
-- Fresh-DB bootstrap stays order-safe: 011 creates these tables, 014 re-points the
-- agent FK (table still exists at that point), 018 drops them.
DROP TABLE IF EXISTS batch_items;
DROP TABLE IF EXISTS batches;
```

Order matters: `batch_items` references `batches`.

- [ ] **Step 5: Docs**

In `CLAUDE.md` line 36, change

```
- **IDs** mirror Anthropic: `wrkspc_/apikey_/msgbatch_/memstore_/file_/vlt_/env_/skill_/sesn_/agent_`.
```

to

```
- **IDs** mirror Anthropic: `wrkspc_/apikey_/memstore_/file_/vlt_/env_/skill_/sesn_/agent_`.
```

In `README.md` line 22, remove `batches, ` from the feature list so `…memory stores, batches, API keys, usage.` becomes `…memory stores, API keys, usage.`
Do NOT edit `docs/concept/*` — those are historical decision records.

- [ ] **Step 6: Run the gate (this also applies the migration)**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: all tests pass, tsc clean. (`test/repo.test.ts` calls `migrate(pool)` at load, which executes `018_drop_batches.sql` against the dev DB.)

- [ ] **Step 7: Verify the tables are gone**

Run:

```bash
cd control-plane && node --import tsx -e "import {createPool} from './src/db.ts'; const p=createPool(); const r=await p.query(\"SELECT to_regclass('batches') AS b, to_regclass('batch_items') AS i\"); console.log(r.rows[0]); await p.end();"
```

Expected output: `{ b: null, i: null }`

- [ ] **Step 8: Grep for dangling backend references**

Run: `grep -rn "batch" control-plane/src control-plane/test --include="*.ts" -i`
Expected: only the K8s `BatchV1Api` job client in `orchestrator.ts` (Kubernetes Jobs API — unrelated, keep) and the `batch:` session-name prefix string if any remains in comments. No `repo.`/route references.

- [ ] **Step 9: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/src/repo.ts control-plane/test/agents-api.test.ts control-plane/sql/018_drop_batches.sql CLAUDE.md README.md
git commit -m "feat(control-plane)!: remove batches feature — routes, repo, tables (migration 018)"
```

---

### Task 3: Console — tab title, nav restructure, delete batches pages

**Files:**
- Modify: `console/app/layout.tsx:12`
- Modify: `console/app/nav.tsx:10-25` (the `GROUPS` constant)
- Delete: `console/app/batches/` (contains `page.tsx`, `create.tsx`, `[id]/page.tsx`)
- Modify: `console/app/lib/icons.tsx:26` (remove the `batch` icon)
- Test: production build + browser checks (the console has no unit-test runner).

**Interfaces:**
- Consumes: nothing from earlier tasks (independent of Task 1/2 code, but visiting `/batches` before this task lands would 500 since Task 2 removed the API — expected mid-branch).
- Produces: final `GROUPS` shape (below) that Task 4's browser verification will see. `IconName` union shrinks by `"batch"` (it is derived from the `Icon` object keys — removing the entry updates the type automatically).

- [ ] **Step 1: Title**

In `console/app/layout.tsx` change

```tsx
export const metadata = { title: "Devproof.AI — Control Plane" };
```

to

```tsx
export const metadata = { title: "DEVPROOF.AI — Control Plane" };
```

- [ ] **Step 2: Nav groups**

In `console/app/nav.tsx` replace the whole `GROUPS` constant with:

```tsx
const GROUPS: { title: string | null; items: [string, string, IconName][] }[] = [
  { title: null, items: [["Dashboard", "/", "dashboard"]] },
  {
    title: "Managed Agents",
    items: [
      ["Agents", "/agents", "agent"],
      ["Skills", "/skills", "skill"],
      ["Sessions", "/sessions", "session"],
      ["Environments", "/environments", "env"],
      ["Credential vaults", "/vaults", "vault"],
      ["Files", "/files", "file"],
      ["Memory stores", "/memory-stores", "memory"],
    ],
  },
  { title: "Serving", items: [["Model catalog", "/catalog", "catalog"], ["Deployments", "/deployments", "deploy"], ["Pools", "/pools", "pool"], ["Cache", "/cache", "cache"]] },
  { title: "Analytics", items: [["Usage", "/usage", "usage"]] },
  { title: "Manage", items: [["API keys", "/api-keys", "key"]] },
];
```

(Group titles render uppercase via `.sidebar .group { text-transform: uppercase }` — do not write "MANAGE".)

- [ ] **Step 3: Delete the batches pages and icon**

```bash
git rm -r console/app/batches
```

Then in `console/app/lib/icons.tsx` delete the line:

```tsx
  batch: () => <S><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></S>,
```

Verify nothing else references it: `grep -rn "batch" console/app --include="*.ts*" -i` → expected: no matches (nav entry gone in Step 2, pages deleted, icon deleted).

- [ ] **Step 4: Production build**

Run: `cd console && npx next build`
Expected: build succeeds; the route list no longer contains `/batches`. A `IconName`/type error here means a `batch` reference survived — fix before proceeding.

- [ ] **Step 5: Browser check**

Restart the console (`cd console && npx next start -p 7090`, background) and verify on `http://localhost:7090`:
- Tab title reads `DEVPROOF.AI — Control Plane`.
- Sidebar shows exactly: Dashboard / MANAGED AGENTS (Agents, Skills, Sessions, Environments, Credential vaults, Files, Memory stores) / SERVING (unchanged) / ANALYTICS (Usage) / MANAGE (API keys); no BUILD group, no Batches.
- `http://localhost:7090/batches` returns 404.
- `/files`, `/skills`, `/api-keys` still 200 and highlight the correct nav item.

- [ ] **Step 6: Commit**

```bash
git add console/app/layout.tsx console/app/nav.tsx console/app/lib/icons.tsx
git commit -m "feat(console): DEVPROOF.AI title, nav restructure (Manage group, Build dissolved), remove batches UI"
```

---

### Task 4: Dashboard — drop Models section, add header buttons

**Files:**
- Modify: `console/app/page.tsx`
- Modify: `console/app/api-keys/create.tsx` (trigger props on `CreateApiKey`)
- Modify: `console/app/globals.css` (`.btn` inline-flex rule)
- Test: production build + browser checks.

**Interfaces:**
- Consumes: `Icon.agent`, `Icon.key` from `console/app/lib/icons.tsx`; existing `CreateApiKey` from `console/app/api-keys/create.tsx` (client component with the create-modal + show-key-once flow).
- Produces: `CreateApiKey({ label?: string; ghost?: boolean; icon?: boolean })` — defaults `label="+ Create key"`, `ghost=false`, `icon=false` keep the API-keys page rendering byte-identical.

- [ ] **Step 1: Parameterize the CreateApiKey trigger**

In `console/app/api-keys/create.tsx`:

Add to the imports:

```tsx
import { Icon } from "../lib/icons";
```

Change the signature from

```tsx
export function CreateApiKey() {
```

to

```tsx
export function CreateApiKey({ label = "+ Create key", ghost = false, icon = false }:
  { label?: string; ghost?: boolean; icon?: boolean } = {}) {
```

Change the trigger button from

```tsx
    <button onClick={() => { setOpen(true); setError(null); }}>+ Create key</button>
```

to

```tsx
    <button className={ghost ? "ghost" : undefined} onClick={() => { setOpen(true); setError(null); }}>
      {icon && <Icon.key />}{label}
    </button>
```

Nothing else in the component changes (modal, copy-once flow stay as-is).

- [ ] **Step 2: Rework the dashboard page**

In `console/app/page.tsx`:

(a) Replace the imports block

```tsx
import Link from "next/link";
import { wsGet } from "./lib/api";
import { DeployLocalButton } from "./deployments/deploy-modal";
```

with

```tsx
import Link from "next/link";
import { wsGet } from "./lib/api";
import { CreateApiKey } from "./api-keys/create";
import { Icon } from "./lib/icons";
```

(b) Replace the pagehead block

```tsx
      <div className="pagehead">
        <h1>Good {hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}</h1>
        <Link className="btn" href="/agents">Build an agent</Link>
      </div>
```

with

```tsx
      <div className="pagehead">
        <h1>Good {hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}</h1>
        <div style={{ display: "flex", gap: 10 }}>
          <CreateApiKey label="Generate an API key" ghost icon />
          <Link className="btn" href="/agents"><Icon.agent /> Build an agent</Link>
        </div>
      </div>
```

(`page.tsx` stays a server component; `CreateApiKey` is `"use client"` — embedding a client component is standard Next.js.)

(c) Delete the Models section — these lines go entirely (the Catalog stat card in the `cards` block above stays, so the `catalog` fetch in `Promise.all` stays too):

```tsx
      <div className="group" style={{ padding: "0 0 8px" }}>Models</div>
      <div className="cards">
        {catalog.models.slice(0, 8).map((m: any) => (
          <div className="card" key={m.id}>
            <h3>{m.family}</h3>
            <div style={{ fontWeight: 600 }}>{m.displayName}</div>
            <div className="hint">
              {m.parameters} · {m.quantization ?? m.format} · tools: {m.toolCalling ?? "—"}
              {m.observedTokensPerSec ? ` · measured ${m.observedTokensPerSec.toFixed(0)} tok/s` : ""}
            </div>
            <div style={{ marginTop: 10 }}><DeployLocalButton catalogId={m.id} defaultName={m.id} small /></div>
          </div>
        ))}
      </div>
```

- [ ] **Step 3: `.btn` icon alignment CSS**

In `console/app/globals.css`, directly after the shared `button, .btn { … }` rule (ends at line ~107), add:

```css
.btn { display: inline-flex; align-items: center; gap: 7px; justify-content: center; }
```

Scope is `.btn` only — do NOT change the `button` element selector.

- [ ] **Step 4: Production build**

Run: `cd console && npx next build`
Expected: success, no type errors (a `DeployLocalButton` unused-import error means Step 2(a) was missed).

- [ ] **Step 5: Browser check**

Restart the console (`npx next start -p 7090`, background) and verify on `http://localhost:7090`:
- Header shows `[🔑 Generate an API key] [🤖 Build an agent]` in that order; the key button uses the light ghost fill, the agent button the solid dark fill; icons vertically centered with the text.
- Clicking "Generate an API key" opens the Create API key modal; creating a key shows the copy-once modal; the key then appears on `/api-keys`. (Delete the test key afterwards on `/api-keys`.)
- No "Models" section below the stat cards; the four stat cards (incl. Catalog) still render.
- `/api-keys` page: its "+ Create key" button renders exactly as before (solid, no icon).
- Other `.btn` links (e.g. any list-page header buttons) look unchanged.

- [ ] **Step 6: Commit**

```bash
git add console/app/page.tsx console/app/api-keys/create.tsx console/app/globals.css
git commit -m "feat(console): dashboard header buttons (generate key, build agent w/ icon); drop Models section"
```
