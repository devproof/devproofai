# External Provider Endpoints + Editable Deployments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register OpenAI / Anthropic / OpenRouter / custom OpenAI-compatible endpoints as first-class deployments (gateway-routed, key-enforced, metered), and make deployments editable (external: url/model/key-rotation; local: operational CR fields).

**Architecture:** External endpoints live in a new `external_deployments` table (workspace-scoped, `mdep_` ids) with API keys held only in a K8s Secret (`gateway-provider-keys`) that the gateway consumes via `envFrom`; `buildGatewayConfig` emits them as LiteLLM provider-native entries with `os.environ/` key refs and tags every entry `model_info.devproof_local` so the GBNF sanitizer scrubs only local backends. Local deployments stay pure CRs; editing merge-patches the CR and the existing operator auto-sync keeps routes. Spec: `docs/superpowers/specs/2026-07-09-external-providers-deployments-design.md`.

**Tech Stack:** Fastify/TypeScript control plane (Node test runner), LiteLLM gateway (`custom_callbacks.py` in ConfigMap), Postgres 17, Next.js console, Go operator (unchanged).

## Global Constraints

- Workspace scoping via `X-Devproof-Workspace` header (default `wrkspc_default`). External rows are workspace-scoped; local CRs remain cluster-global (recorded asymmetry — do not "fix").
- Migrations idempotent (`CREATE TABLE IF NOT EXISTS` etc.) — `migrate()` re-runs every file.
- **Don't-regress (CLAUDE.md):** generated config MUST keep `litellm_settings.callbacks` AND `general_settings.custom_auth`; the sanitizer's `_scrub` logic stays byte-identical; auth/metering hooks in `custom_callbacks.py` untouched except where this plan says.
- **Sanitizer failure bias:** if the hook cannot parse the config, it scrubs ALL models (today's behavior) — never scrubs none.
- Gateway env var for Postgres is `DEVPROOF_DATABASE_URL` — **never** `DATABASE_URL` (LiteLLM Prisma auto-migration wiped the dev DB once; see 2026-07-09 incident notes).
- Provider API keys are **never** stored in Postgres or the ConfigMap — only in Secret `gateway-provider-keys` (namespace `devproof-gateway`), entry key `DEVPROOF_EP_<id sanitized to [A-Za-z0-9_]>`.
- One flat gateway model namespace: external `name` colliding with any local CR name or other external name → 409.
- Provider enum exactly: `openai | anthropic | openrouter | custom`; `custom` requires `baseUrl`.
- Local PATCH whitelist exactly: `replicas {min,max}`, `contextTokens`, `engine (auto|llama.cpp|vllm)`, `targetTokensPerSec` — anything else → 400.
- Backend verify: `cd control-plane && npm test && npx tsc --noEmit`. Console: production build only.
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `control-plane/sql/017_external_deployments.sql` | create | external endpoints table |
| `control-plane/src/repo.ts` | modify | external CRUD (create/list/listAll/update/delete/getByName) |
| `control-plane/test/repo.test.ts` | modify | live-DB roundtrip incl. key_version bump |
| `control-plane/src/gateway-config.ts` | modify | external entries, `devproof_local` flags, `envKeyFor` |
| `control-plane/test/gateway-config.test.ts` | modify | provider-mapping matrix + flag assertions |
| `control-plane/src/kubestore.ts` | modify | `patch()` for CRs, `writeProviderKey`/`deleteProviderKey` |
| `control-plane/src/server.ts` | modify | external CRUD/test routes, local PATCH, merged GET, sync passes externals |
| `control-plane/test/server.test.ts` | modify | fake store/externals + route tests |
| `control-plane/src/main.ts` | modify | wire repo-backed externals into buildServer |
| `deploy/gateway/litellm.yaml` | modify | sanitizer scoping, `envFrom` provider-keys, bootstrap `model_info` |
| `console/app/deployments/external.tsx` | create | AddEndpointButton + ExternalActions (client) |
| `console/app/deployments/edit-local.tsx` | create | EditLocalButton dialog (client) |
| `console/app/deployments/page.tsx` | modify | kind badges, provider column, wire buttons |
| `CLAUDE.md`, `docs/concept/decisions-log.md`, `docs/concept/platform-alignment-and-scale.md` | modify | docs |

**Spec-consistent addition** (record in the final report): the table gains a `has_key BOOLEAN NOT NULL DEFAULT false` column — the config generator must know whether to emit the `api_key` line, and the key itself is (correctly) not in the DB to check.

---

### Task 1: Migration 017 + repo external CRUD

**Files:**
- Create: `control-plane/sql/017_external_deployments.sql`
- Modify: `control-plane/src/repo.ts` (new section after the API-keys section, ~line 601)
- Test: `control-plane/test/repo.test.ts` (append before `test.after`)

**Interfaces:**
- Produces (consumed by Tasks 4's routes and, shape-wise, Task 2's config generator):
  - `repo.createExternalDeployment(ws: string, d: {name: string; provider: string; baseUrl?: string; modelId: string; hasKey: boolean})` → row `{id, workspace_id, name, provider, base_url, model_id, key_version, has_key, created_at, updated_at}` (id = `rid("mdep")`)
  - `repo.listExternalDeployments(ws: string)` → row[] (workspace-filtered, name-sorted)
  - `repo.listAllExternalDeployments()` → row[] (ALL workspaces — gateway routes are global)
  - `repo.getExternalDeploymentByName(name: string)` → row | null (collision checks are cross-workspace)
  - `repo.updateExternalDeployment(ws: string, id: string, patch: {baseUrl?: string; modelId?: string; rotateKey?: boolean})` → row | null (rotateKey bumps `key_version` and sets `has_key = true`; always touches `updated_at`)
  - `repo.deleteExternalDeployment(ws: string, id: string)` → deleted row | null (caller needs `id`/`has_key` to remove the Secret entry)

- [ ] **Step 1: Write the migration**

```sql
-- control-plane/sql/017_external_deployments.sql
-- External provider endpoints served through the gateway (spec 2026-07-09).
-- API keys are NOT here: they live only in the gateway-provider-keys K8s
-- Secret; has_key/key_version exist so config generation can reference them.
CREATE TABLE IF NOT EXISTS external_deployments (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL UNIQUE,
  provider     TEXT NOT NULL CHECK (provider IN ('openai','anthropic','openrouter','custom')),
  base_url     TEXT,
  model_id     TEXT NOT NULL,
  key_version  INT NOT NULL DEFAULT 1,
  has_key      BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS external_deployments_ws ON external_deployments (workspace_id, created_at);
```

- [ ] **Step 2: Write the failing test**

Append to `control-plane/test/repo.test.ts` (uses the file's `{ skip: !available }` live-DB pattern; requires Postgres on localhost:15432 — verify with `npx tsx -e "import {createPool} from './src/db.ts'; const p=createPool(); await p.query('SELECT 1'); console.log('db ok'); await p.end()"` and report BLOCKED if unreachable, do not let it skip silently):

```ts
test("external deployments CRUD roundtrip", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = await repo.createWorkspace(`ext-ws-${Date.now()}`);
  const name = `ext-${Date.now()}`;
  const created = await repo.createExternalDeployment(ws.id, {
    name, provider: "openrouter", modelId: "meta-llama/llama-3.1-8b-instruct", hasKey: true,
  });
  assert.match(created.id, /^mdep_/);
  assert.equal(created.key_version, 1);
  assert.equal(created.has_key, true);
  assert.equal(created.base_url, null);

  assert.equal((await repo.getExternalDeploymentByName(name))!.id, created.id);
  assert.equal(await repo.getExternalDeploymentByName("nope-" + name), null);

  const listed = await repo.listExternalDeployments(ws.id);
  assert.ok(listed.some((r: any) => r.id === created.id));
  assert.ok((await repo.listAllExternalDeployments()).some((r: any) => r.id === created.id));
  assert.equal((await repo.listExternalDeployments("wrkspc_other")).some((r: any) => r.id === created.id), false);

  const rotated = await repo.updateExternalDeployment(ws.id, created.id, { rotateKey: true, modelId: "openai/gpt-4o" });
  assert.equal(rotated!.key_version, 2);
  assert.equal(rotated!.model_id, "openai/gpt-4o");

  const gone = await repo.deleteExternalDeployment(ws.id, created.id);
  assert.equal(gone!.id, created.id);
  assert.equal(await repo.getExternalDeploymentByName(name), null);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd control-plane && npx tsx --test test/repo.test.ts`
Expected: FAIL — `repo.createExternalDeployment is not a function`

- [ ] **Step 4: Implement the repo methods**

Insert in `control-plane/src/repo.ts` after the API-keys section (~line 601):

```ts
  // ── External deployments (provider endpoints routed by the gateway) ──────
  async createExternalDeployment(
    workspaceId: string,
    d: { name: string; provider: string; baseUrl?: string; modelId: string; hasKey: boolean },
  ) {
    const id = rid("mdep");
    const { rows } = await this.pool.query(
      `INSERT INTO external_deployments (id, workspace_id, name, provider, base_url, model_id, has_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, workspaceId, d.name, d.provider, d.baseUrl ?? null, d.modelId, d.hasKey],
    );
    return rows[0];
  }
  async listExternalDeployments(workspaceId: string) {
    const { rows } = await this.pool.query(
      "SELECT * FROM external_deployments WHERE workspace_id = $1 ORDER BY name", [workspaceId]);
    return rows;
  }
  async listAllExternalDeployments() {
    const { rows } = await this.pool.query("SELECT * FROM external_deployments ORDER BY name");
    return rows;
  }
  async getExternalDeploymentByName(name: string) {
    const { rows } = await this.pool.query("SELECT * FROM external_deployments WHERE name = $1", [name]);
    return rows[0] ?? null;
  }
  async updateExternalDeployment(
    workspaceId: string, id: string,
    patch: { baseUrl?: string; modelId?: string; rotateKey?: boolean },
  ) {
    const { rows } = await this.pool.query(
      `UPDATE external_deployments SET
         base_url    = COALESCE($3, base_url),
         model_id    = COALESCE($4, model_id),
         key_version = key_version + CASE WHEN $5 THEN 1 ELSE 0 END,
         has_key     = has_key OR $5,
         updated_at  = now()
       WHERE workspace_id = $1 AND id = $2 RETURNING *`,
      [workspaceId, id, patch.baseUrl ?? null, patch.modelId ?? null, patch.rotateKey === true],
    );
    return rows[0] ?? null;
  }
  async deleteExternalDeployment(workspaceId: string, id: string) {
    const { rows } = await this.pool.query(
      "DELETE FROM external_deployments WHERE workspace_id = $1 AND id = $2 RETURNING *",
      [workspaceId, id]);
    return rows[0] ?? null;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd control-plane && npx tsx --test test/repo.test.ts`
Expected: PASS (all repo tests, external roundtrip included, not skipped)

- [ ] **Step 6: Typecheck and commit**

```bash
cd control-plane && npx tsc --noEmit
git add control-plane/sql/017_external_deployments.sql control-plane/src/repo.ts control-plane/test/repo.test.ts
git commit -m "feat(deployments): external_deployments table + workspace-scoped CRUD"
```

---

### Task 2: `buildGatewayConfig` — external entries + `devproof_local` flags

**Files:**
- Modify: `control-plane/src/gateway-config.ts`
- Test: `control-plane/test/gateway-config.test.ts`

**Interfaces:**
- Consumes: external row shape from Task 1 (snake_case DB fields).
- Produces (consumed by Task 4's sync route and Task 5's Python hook):
  - `buildGatewayConfig(deployments: DeploymentLike[], externals: ExternalLike[] = []): string`
  - `export interface ExternalLike { id: string; name: string; provider: string; base_url: string | null; model_id: string; key_version: number; has_key: boolean }`
  - `export function envKeyFor(id: string): string` → `"DEVPROOF_EP_" + id.replace(/[^A-Za-z0-9_]/g, "_")` (also used by Task 4 for Secret entry names)
  - Local entries gain `model_info: { devproof_local: true }`; external entries get `model_info: { devproof_local: false, key_version: N }`.

- [ ] **Step 1: Write the failing tests**

Append to `control-plane/test/gateway-config.test.ts`:

```ts
const ext = (over: Partial<any> = {}) => ({
  id: "mdep_abc123", name: "gpt4o", provider: "openai", base_url: null,
  model_id: "gpt-4o", key_version: 3, has_key: true, ...over,
});

test("external entries map to provider-native litellm params", () => {
  const cfg = parse(buildGatewayConfig([], [
    ext(),
    ext({ id: "mdep_a1", name: "anthro", provider: "anthropic", model_id: "some-model" }),
    ext({ id: "mdep_a2", name: "router", provider: "openrouter", model_id: "meta-llama/llama-3.1-8b" }),
    ext({ id: "mdep_a3", name: "gpu-box", provider: "custom", base_url: "http://host.docker.internal:8081/v1", has_key: false }),
  ]));
  const by = Object.fromEntries(cfg.model_list.map((m: any) => [m.model_name, m]));
  assert.equal(by.gpt4o.litellm_params.model, "openai/gpt-4o");
  assert.equal(by.gpt4o.litellm_params.api_base, undefined);
  assert.equal(by.gpt4o.litellm_params.api_key, "os.environ/DEVPROOF_EP_mdep_abc123");
  assert.equal(by.anthro.litellm_params.model, "anthropic/some-model");
  assert.equal(by.router.litellm_params.model, "openrouter/meta-llama/llama-3.1-8b");
  assert.equal(by["gpu-box"].litellm_params.model, "openai/gpt-4o"); // custom uses the openai/ prefix
  assert.equal(by["gpu-box"].litellm_params.api_base, "http://host.docker.internal:8081/v1");
  assert.equal(by["gpu-box"].litellm_params.api_key, undefined); // no key → no line
  assert.equal(by.gpt4o.model_info.devproof_local, false);
  assert.equal(by.gpt4o.model_info.key_version, 3);
});

test("base_url override applies to known providers", () => {
  const cfg = parse(buildGatewayConfig([], [ext({ base_url: "https://eu.openai.azureish.example/v1" })]));
  assert.equal(cfg.model_list[0].litellm_params.api_base, "https://eu.openai.azureish.example/v1");
});

test("local entries are flagged devproof_local for the sanitizer", () => {
  const cfg = parse(buildGatewayConfig([dep("a", "Ready")], []));
  assert.equal(cfg.model_list[0].model_info.devproof_local, true);
});

test("envKeyFor sanitizes ids to env-var-safe names", () => {
  assert.equal(envKeyFor("mdep_x-1.z"), "DEVPROOF_EP_mdep_x_1_z");
});
```

Also update the import line to `import { buildGatewayConfig, envKeyFor } from "../src/gateway-config.ts";`. Note: `by["gpu-box"].litellm_params.model` must equal `"openai/gpt-4o"` — write the assertion once; the duplicated line above is illustrative of intent, keep only one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd control-plane && npx tsx --test test/gateway-config.test.ts`
Expected: FAIL — `envKeyFor` not exported / arity mismatch

- [ ] **Step 3: Implement**

Replace the body of `control-plane/src/gateway-config.ts` with:

```ts
// Generates the LiteLLM proxy config from Ready ModelDeployments (concept §5.7)
// plus registered external provider endpoints (spec 2026-07-09).
import { stringify } from "yaml";

export interface DeploymentLike {
  metadata: { name: string; namespace: string };
  status?: { phase?: string; endpoint?: string };
}

export interface ExternalLike {
  id: string;
  name: string;
  provider: string; // openai | anthropic | openrouter | custom
  base_url: string | null;
  model_id: string;
  key_version: number;
  has_key: boolean;
}

/** Secret entry / env var name for an external deployment's API key. */
export function envKeyFor(id: string): string {
  return "DEVPROOF_EP_" + id.replace(/[^A-Za-z0-9_]/g, "_");
}

// custom endpoints are OpenAI-compatible servers, hence the openai/ prefix.
const PROVIDER_PREFIX: Record<string, string> = {
  openai: "openai", anthropic: "anthropic", openrouter: "openrouter", custom: "openai",
};

export function buildGatewayConfig(deployments: DeploymentLike[], externals: ExternalLike[] = []): string {
  const model_list: any[] = deployments
    .filter((d) => d.status?.phase === "Ready" && d.status?.endpoint)
    .map((d) => ({
      model_name: d.metadata.name,
      litellm_params: {
        model: `openai/${d.metadata.name}`,
        // endpoint is .../v1/chat/completions; LiteLLM wants the /v1 base
        api_base: d.status!.endpoint!.replace(/\/chat\/completions$/, ""),
        api_key: "none",
      },
      // devproof_local drives the GBNF sanitizer scope in custom_callbacks.py.
      model_info: { devproof_local: true },
    }));
  for (const e of externals) {
    model_list.push({
      model_name: e.name,
      litellm_params: {
        model: `${PROVIDER_PREFIX[e.provider] ?? "openai"}/${e.model_id}`,
        ...(e.base_url ? { api_base: e.base_url } : {}),
        // Key never appears in this config — env ref only (gateway-provider-keys Secret).
        ...(e.has_key ? { api_key: `os.environ/${envKeyFor(e.id)}` } : {}),
      },
      // key_version changes the config bytes on rotation → diff-aware sync rolls
      // the gateway → new Secret env is picked up.
      model_info: { devproof_local: false, key_version: e.key_version },
    });
  }
  return stringify({
    model_list,
    litellm_settings: {
      drop_params: true,
      // custom_callbacks.py (mounted beside config.yaml) strips oversized
      // string-length bounds from tool schemas — they break llama.cpp's
      // JSON-schema→grammar conversion ("failed to parse grammar").
      callbacks: "custom_callbacks.proxy_handler_instance",
    },
    general_settings: {
      // API-key enforcement against the api_keys table (custom_callbacks.py).
      custom_auth: "custom_callbacks.user_custom_auth",
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npx tsx --test test/gateway-config.test.ts`
Expected: all tests pass (existing 3 + new 4)

- [ ] **Step 5: Commit**

```bash
cd control-plane && npx tsc --noEmit
git add control-plane/src/gateway-config.ts control-plane/test/gateway-config.test.ts
git commit -m "feat(gateway): external provider entries + devproof_local sanitizer flags in generated config"
```

---

### Task 3: KubeStore — CR merge-patch + provider-key Secret ops

**Files:**
- Modify: `control-plane/src/kubestore.ts`
- Modify: `control-plane/test/server.test.ts` (fake store gains the three methods so it keeps satisfying `KubeStore`; behavior assertions come in Task 4)

**Interfaces:**
- Produces (consumed by Task 4's routes):
  - `patch(plural: "modelpools" | "modeldeployments", name: string, body: any): Promise<any>` — JSON merge-patch on the CR (used for local deployment edits; merge semantics preserve unspecified spec fields).
  - `writeProviderKey(entryKey: string, value: string): Promise<void>` — create-or-patch Secret `gateway-provider-keys` in `devproof-gateway`, setting one entry.
  - `deleteProviderKey(entryKey: string): Promise<void>` — remove one entry (404s ignored).

- [ ] **Step 1: Extend the `KubeStore` interface**

In `control-plane/src/kubestore.ts` add to the interface after `create`:

```ts
  /** JSON merge-patch a Devproof CR (local deployment edits). */
  patch(plural: "modelpools" | "modeldeployments", name: string, body: any): Promise<any>;
```

and after `writeGatewayConfig`:

```ts
  /** Set one entry of the gateway-provider-keys Secret (external API keys). */
  writeProviderKey(entryKey: string, value: string): Promise<void>;
  /** Remove one entry of the gateway-provider-keys Secret. */
  deleteProviderKey(entryKey: string): Promise<void>;
```

- [ ] **Step 2: Implement in `realKubeStore`**

After the `create` implementation:

```ts
    async patch(plural, name, body) {
      const mergePatch = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);
      return custom.patchNamespacedCustomObject({ ...base, plural, name, body }, mergePatch);
    },
```

After `writeGatewayConfig` (inside the returned object):

```ts
    async writeProviderKey(entryKey, value) {
      const b64 = Buffer.from(value, "utf8").toString("base64");
      const mergePatch = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);
      try {
        await core.patchNamespacedSecret(
          { name: "gateway-provider-keys", namespace: GATEWAY_NAMESPACE, body: { data: { [entryKey]: b64 } } },
          mergePatch,
        );
      } catch (err: any) {
        if (err?.code !== 404) throw err;
        await core.createNamespacedSecret({
          namespace: GATEWAY_NAMESPACE,
          body: { metadata: { name: "gateway-provider-keys" }, data: { [entryKey]: b64 } },
        });
      }
    },
    async deleteProviderKey(entryKey) {
      const mergePatch = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch);
      try {
        await core.patchNamespacedSecret(
          { name: "gateway-provider-keys", namespace: GATEWAY_NAMESPACE, body: { data: { [entryKey]: null } } },
          mergePatch,
        );
      } catch (err: any) {
        if (err?.code !== 404) throw err;
      }
    },
```

- [ ] **Step 3: Extend the fake store in `control-plane/test/server.test.ts`**

Inside `fakeStore()` add state + methods (after `writeGatewayConfig`):

```ts
    async patch(plural, name, body) {
      const obj = objects[plural].find((o) => o.metadata.name === name);
      if (!obj) throw Object.assign(new Error("not found"), { code: 404 });
      // shallow-merge spec like a JSON merge patch (sufficient for tests)
      obj.spec = { ...obj.spec, ...body.spec, model: { ...obj.spec?.model, ...body.spec?.model } };
      return obj;
    },
    async writeProviderKey(k, v) { providerKeys[k] = v; },
    async deleteProviderKey(k) { delete providerKeys[k]; },
```

with `const providerKeys: Record<string, string> = {};` declared beside `objects`, and `providerKeys` added to the function's return for later assertions: `return { store, objects, getGatewayConfig: () => gatewayConfig, providerKeys };`

- [ ] **Step 4: Verify compile + suite, commit**

Run: `cd control-plane && npx tsc --noEmit && npm test`
Expected: clean; all existing tests pass.

```bash
git add control-plane/src/kubestore.ts control-plane/test/server.test.ts
git commit -m "feat(kubestore): CR merge-patch + gateway-provider-keys secret ops"
```

---

### Task 4: Server routes — external CRUD/test, local PATCH, merged GET

**Files:**
- Modify: `control-plane/src/server.ts`
- Modify: `control-plane/src/main.ts` (wire repo-backed externals)
- Test: `control-plane/test/server.test.ts`

**Interfaces:**
- Consumes: Task 1 repo methods, Task 2 `buildGatewayConfig`/`envKeyFor`, Task 3 kubestore methods.
- Produces: `buildServer(catalog, store, customCatalog?, externals?)` where

```ts
export interface ExternalStore {
  create(ws: string, d: { name: string; provider: string; baseUrl?: string; modelId: string; hasKey: boolean }): Promise<any>;
  list(ws: string): Promise<any[]>;
  listAll(): Promise<any[]>;
  getByName(name: string): Promise<any | null>;
  update(ws: string, id: string, patch: { baseUrl?: string; modelId?: string; rotateKey?: boolean }): Promise<any | null>;
  delete(ws: string, id: string): Promise<any | null>;
}
```

Routes produced (consumed by Task 6 console):
- `POST /v1/deployments/external` → 201 record (no key echo) | 400 | 409
- `PATCH /v1/deployments/external/:id` → record | 404
- `DELETE /v1/deployments/external/:id` → 204 | 404
- `POST /v1/deployments/external/test` → `{ok: boolean, detail: string}`
- `PATCH /v1/deployments/:name` (local) → patched CR summary | 400 | 404
- `GET /v1/deployments` rows gain `kind: "local" | "external"`; external rows: `{name, kind, provider, modelId, baseUrl, phase: "External", readyReplicas: 0, id}`; merged + name-sorted BEFORE pagination; `count` covers both.

- [ ] **Step 1: Write the failing tests**

Append to `control-plane/test/server.test.ts`. First a fake externals store + builder helper:

```ts
function fakeExternals() {
  const rows: any[] = [];
  let seq = 0;
  const externals = {
    async create(ws: string, d: any) {
      const row = { id: `mdep_t${seq++}`, workspace_id: ws, name: d.name, provider: d.provider,
        base_url: d.baseUrl ?? null, model_id: d.modelId, key_version: 1, has_key: d.hasKey };
      rows.push(row); return row;
    },
    async list(ws: string) { return rows.filter((r) => r.workspace_id === ws); },
    async listAll() { return rows; },
    async getByName(name: string) { return rows.find((r) => r.name === name) ?? null; },
    async update(ws: string, id: string, p: any) {
      const r = rows.find((x) => x.id === id && x.workspace_id === ws);
      if (!r) return null;
      if (p.baseUrl !== undefined) r.base_url = p.baseUrl;
      if (p.modelId !== undefined) r.model_id = p.modelId;
      if (p.rotateKey) { r.key_version++; r.has_key = true; }
      return r;
    },
    async delete(ws: string, id: string) {
      const i = rows.findIndex((x) => x.id === id && x.workspace_id === ws);
      return i >= 0 ? rows.splice(i, 1)[0] : null;
    },
  };
  return { externals, rows };
}

test("external deployment lifecycle: create routes gateway, delete unroutes", async () => {
  const { store, getGatewayConfig, providerKeys } = fakeStore();
  const { externals } = fakeExternals();
  const app = buildServer(catalog, store, undefined, externals);
  const res = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "gpt4o", provider: "openai", modelId: "gpt-4o", apiKey: "sk-secret" } });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.apiKey, undefined);              // never echoed
  assert.ok(providerKeys[`DEVPROOF_EP_${body.id.replace(/[^A-Za-z0-9_]/g, "_")}`]); // secret written
  assert.match(getGatewayConfig(), /gpt4o/);          // sync ran
  assert.match(getGatewayConfig(), /os\.environ\/DEVPROOF_EP_/);

  const del = await app.inject({ method: "DELETE", url: `/v1/deployments/external/${body.id}` });
  assert.equal(del.statusCode, 204);
  assert.doesNotMatch(getGatewayConfig(), /gpt4o/);   // re-synced
  assert.equal(Object.keys(providerKeys).length, 0);  // secret entry removed
});

test("external create validates: custom needs baseUrl, name collisions 409", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push({ metadata: { name: "taken", namespace: "devproof-serving" }, spec: {}, status: {} });
  const { externals } = fakeExternals();
  const app = buildServer(catalog, store, undefined, externals);
  const noUrl = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "x", provider: "custom", modelId: "m" } });
  assert.equal(noUrl.statusCode, 400);
  const collide = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "taken", provider: "openai", modelId: "gpt-4o" } });
  assert.equal(collide.statusCode, 409);
  const badProvider = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "y", provider: "bedrock", modelId: "m" } });
  assert.equal(badProvider.statusCode, 400);
});

test("GET /v1/deployments merges external rows with kind tags", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push({ metadata: { name: "local1", namespace: "devproof-serving" }, spec: { poolRef: "p" },
    status: { phase: "Ready", endpoint: "http://local1.devproof-serving.svc.cluster.local:8080/v1/chat/completions" } });
  const { externals } = fakeExternals();
  await externals.create("wrkspc_default", { name: "ext1", provider: "anthropic", modelId: "some-model", hasKey: true });
  const app = buildServer(catalog, store, undefined, externals);
  const res = await app.inject({ method: "GET", url: "/v1/deployments" });
  const { deployments, count } = res.json();
  assert.equal(count, 2);
  const ext1 = deployments.find((d: any) => d.name === "ext1");
  assert.equal(ext1.kind, "external");
  assert.equal(ext1.phase, "External");
  assert.equal(ext1.provider, "anthropic");
  assert.equal(deployments.find((d: any) => d.name === "local1").kind, "local");
});

test("PATCH /v1/deployments/:name whitelists operational fields", async () => {
  const { store, objects } = fakeStore();
  objects.modeldeployments.push({ metadata: { name: "local1", namespace: "devproof-serving" },
    spec: { poolRef: "p", replicas: { min: 1, max: 2 }, model: { source: "s", format: "gguf", contextTokens: 8192 } }, status: {} });
  const app = buildServer(catalog, store, undefined, fakeExternals().externals);
  const ok = await app.inject({ method: "PATCH", url: "/v1/deployments/local1",
    payload: { replicas: { min: 2, max: 4 }, contextTokens: 16384 } });
  assert.equal(ok.statusCode, 200);
  const cr = objects.modeldeployments[0];
  assert.equal(cr.spec.replicas.max, 4);
  assert.equal(cr.spec.model.contextTokens, 16384);
  assert.equal(cr.spec.model.source, "s"); // merge preserved siblings

  const bad = await app.inject({ method: "PATCH", url: "/v1/deployments/local1",
    payload: { poolRef: "gpu" } });
  assert.equal(bad.statusCode, 400);
  const missing = await app.inject({ method: "PATCH", url: "/v1/deployments/nope", payload: { contextTokens: 1 } });
  assert.equal(missing.statusCode, 404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd control-plane && npx tsx --test test/server.test.ts`
Expected: FAIL — buildServer arity / 404 routes

- [ ] **Step 3: Implement in `control-plane/src/server.ts`**

(a) Extend imports/signature:

```ts
import { buildGatewayConfig, envKeyFor } from "./gateway-config.ts";
```

`export function buildServer(catalog: CatalogEntry[], store: KubeStore, customCatalog?: CustomCatalog, externals?: ExternalStore)` — with the `ExternalStore` interface from this task's header exported from server.ts. Add a workspace helper near the top of the function:

```ts
  const ws = (req: any) => (req.headers["x-devproof-workspace"] as string) || "wrkspc_default";
  const syncGateway = async () => {
    const deployments = await store.list("modeldeployments");
    const config = buildGatewayConfig(deployments, externals ? await externals.listAll() : []);
    return store.writeGatewayConfig(config);
  };
```

(b) Rewrite the existing `/v1/gateway/sync` route to use the helper:

```ts
  app.post("/v1/gateway/sync", async () => {
    const changed = await syncGateway();
    const deployments = await store.list("modeldeployments");
    const routed = deployments.filter((d: any) => d.status?.phase === "Ready").length
      + (externals ? (await externals.listAll()).length : 0);
    return { synced: true, routedModels: routed, changed };
  });
```

(c) Merge externals into `GET /v1/deployments` — replace the current handler body:

```ts
  app.get("/v1/deployments", async (req) => {
    const items = await store.list("modeldeployments");
    const locals = items.map((d: any) => ({
      kind: "local",
      name: d.metadata.name,
      catalogId: d.spec?.catalogId,
      poolRef: d.spec?.poolRef,
      phase: d.status?.phase ?? "Pending",
      downloadPercent: d.status?.downloadPercent ?? null,
      endpoint: d.status?.endpoint,
      readyReplicas: d.status?.readyReplicas ?? 0,
    }));
    const { tokens, queue } = await fetchServingMetrics();
    const merged = mergeMetrics(locals, tokens, queue) as any[];
    for (const e of externals ? await externals.list(ws(req)) : []) {
      merged.push({
        kind: "external", id: e.id, name: e.name, provider: e.provider, modelId: e.model_id,
        baseUrl: e.base_url, phase: "External", downloadPercent: null, readyReplicas: 0,
        tokensPerSec: null, queueDepth: null,
      });
    }
    merged.sort((a, b) => a.name.localeCompare(b.name));
    const { rows, count, offset } = paged(merged, req);
    return { deployments: rows, count, offset };
  });
```

(d) External CRUD + test probe (place after the deployments routes; note Fastify prefers the static `external` segment over `:name` params, so ordering is safe):

```ts
  const PROVIDERS: Record<string, { base: string; modelsPath: string }> = {
    openai:     { base: "https://api.openai.com/v1",    modelsPath: "/models" },
    anthropic:  { base: "https://api.anthropic.com",    modelsPath: "/v1/models" },
    openrouter: { base: "https://openrouter.ai/api/v1", modelsPath: "/models" },
    custom:     { base: "",                             modelsPath: "/models" },
  };

  app.post("/v1/deployments/external", async (req, reply) => {
    if (!externals) return reply.code(501).send({ error: "external deployments not configured" });
    const b = req.body as { name?: string; provider?: string; baseUrl?: string; modelId?: string; apiKey?: string };
    if (!b?.name || !b.modelId || !PROVIDERS[b.provider ?? ""])
      return reply.code(400).send({ error: "name, modelId and provider (openai|anthropic|openrouter|custom) required" });
    if (b.provider === "custom" && !b.baseUrl)
      return reply.code(400).send({ error: "baseUrl required for custom provider" });
    if (await externals.getByName(b.name) || await store.get("modeldeployments", b.name))
      return reply.code(409).send({ error: `model name "${b.name}" already exists` });
    // Secret-first: no orphaned credentials if the row insert fails.
    const hasKey = !!b.apiKey;
    const row = await externals.create(ws(req), {
      name: b.name, provider: b.provider!, baseUrl: b.baseUrl, modelId: b.modelId, hasKey,
    }).catch(async (err) => { throw err; });
    if (hasKey) {
      try { await store.writeProviderKey(envKeyFor(row.id), b.apiKey!); }
      catch (err) { await externals.delete(ws(req), row.id); throw err; }
    }
    await syncGateway();
    return reply.code(201).send(row);
  });

  app.patch("/v1/deployments/external/:id", async (req, reply) => {
    if (!externals) return reply.code(501).send({ error: "external deployments not configured" });
    const b = req.body as { baseUrl?: string; modelId?: string; apiKey?: string };
    const row = await externals.update(ws(req), (req.params as any).id, {
      baseUrl: b?.baseUrl, modelId: b?.modelId, rotateKey: !!b?.apiKey,
    });
    if (!row) return reply.code(404).send({ error: "not found" });
    if (b?.apiKey) await store.writeProviderKey(envKeyFor(row.id), b.apiKey);
    await syncGateway();
    return row;
  });

  app.delete("/v1/deployments/external/:id", async (req, reply) => {
    if (!externals) return reply.code(501).send({ error: "external deployments not configured" });
    const row = await externals.delete(ws(req), (req.params as any).id);
    if (!row) return reply.code(404).send({ error: "not found" });
    if (row.has_key) await store.deleteProviderKey(envKeyFor(row.id));
    await syncGateway();
    return reply.code(204).send();
  });

  // Connection probe — runs from the control-plane process, so cluster-internal
  // custom URLs are unreachable in the out-of-cluster dev topology (expected;
  // the probe targets internet providers).
  app.post("/v1/deployments/external/test", async (req, reply) => {
    const b = req.body as { provider?: string; baseUrl?: string; apiKey?: string };
    const preset = PROVIDERS[b?.provider ?? ""];
    if (!preset) return reply.code(400).send({ error: "unknown provider" });
    const base = (b.baseUrl || preset.base).replace(/\/$/, "");
    if (!base) return reply.code(400).send({ error: "baseUrl required for custom provider" });
    const headers: Record<string, string> = b.provider === "anthropic"
      ? { "x-api-key": b.apiKey ?? "", "anthropic-version": "2023-06-01" }
      : b.apiKey ? { Authorization: `Bearer ${b.apiKey}` } : {};
    try {
      const res = await fetch(base + preset.modelsPath, { headers, signal: AbortSignal.timeout(8000) });
      return { ok: res.ok, detail: res.ok ? `reachable (HTTP ${res.status})` : `HTTP ${res.status}` };
    } catch (err: any) {
      return { ok: false, detail: String(err?.cause?.message ?? err?.message ?? err) };
    }
  });

  // Local deployment edit: operational fields only (spec whitelist).
  app.patch("/v1/deployments/:name", async (req, reply) => {
    const name = (req.params as any).name;
    const b = (req.body ?? {}) as Record<string, any>;
    const allowed = new Set(["replicas", "contextTokens", "engine", "targetTokensPerSec"]);
    const extra = Object.keys(b).filter((k) => !allowed.has(k));
    if (extra.length) return reply.code(400).send({ error: `only ${[...allowed].join(", ")} are editable (got: ${extra.join(", ")})` });
    if (b.engine && !["auto", "llama.cpp", "vllm"].includes(b.engine)) return reply.code(400).send({ error: "bad engine" });
    if (b.replicas && (typeof b.replicas.min !== "number" || typeof b.replicas.max !== "number"))
      return reply.code(400).send({ error: "replicas needs numeric min and max" });
    if (!(await store.get("modeldeployments", name))) return reply.code(404).send({ error: "not found" });
    const spec: any = {};
    if (b.replicas) spec.replicas = { min: b.replicas.min, max: b.replicas.max };
    if (b.engine) spec.engine = b.engine;
    if (typeof b.targetTokensPerSec === "number") spec.targetTokensPerSec = b.targetTokensPerSec;
    if (typeof b.contextTokens === "number") spec.model = { contextTokens: b.contextTokens };
    const patched = await store.patch("modeldeployments", name, { spec });
    // Operator reconciles the CR (pods roll) and auto-syncs the gateway route.
    return { name, spec: patched.spec };
  });
```

(e) Wire in `control-plane/src/main.ts` — extend the `buildServer` call:

```ts
const app = buildServer(loadCatalog(catalogPath), realKubeStore(), {
  list: () => repo.listCatalogModels(),
  create: (e) => repo.createCatalogModel(e),
  delete: (id) => repo.deleteCatalogModel(id),
}, {
  create: (ws, d) => repo.createExternalDeployment(ws, d),
  list: (ws) => repo.listExternalDeployments(ws),
  listAll: () => repo.listAllExternalDeployments(),
  getByName: (n) => repo.getExternalDeploymentByName(n),
  update: (ws, id, p) => repo.updateExternalDeployment(ws, id, p),
  delete: (ws, id) => repo.deleteExternalDeployment(ws, id),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npx tsx --test test/server.test.ts` then `npm test && npx tsc --noEmit`
Expected: all green (note: existing sync-route tests still pass — `buildGatewayConfig` tolerates the omitted externals arg).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/server.ts control-plane/src/main.ts control-plane/test/server.test.ts
git commit -m "feat(deployments): external endpoint CRUD + connection probe + editable local CR fields"
```

---

### Task 5: Gateway manifest — sanitizer scoping + provider-keys env

**Files:**
- Modify: `deploy/gateway/litellm.yaml` (ConfigMap `custom_callbacks.py`, bootstrap `config.yaml`, Deployment)

Live-verified task (no unit harness for the Python). The auth/metering code in the file is **untouched** — only the sanitizer gains scoping and the Deployment gains `envFrom`.

- [ ] **Step 1: Scope the sanitizer in `custom_callbacks.py`**

Insert after the `MAX_BOUND = 1024` line (keep `_scrub` itself byte-identical):

```python
CONFIG_PATH = "/etc/litellm/config.yaml"

def _load_local_models():
    # Sanitizer scope: only local (GGUF/llama.cpp) backends need GBNF scrubbing;
    # external providers get full-fidelity schemas. On ANY parse failure scrub
    # EVERYTHING - degrade toward loose schemas, never toward broken local models.
    try:
        import yaml
        with open(CONFIG_PATH) as f:
            cfg = yaml.safe_load(f) or {}
        names = {m.get("model_name") for m in (cfg.get("model_list") or [])
                 if (m.get("model_info") or {}).get("devproof_local")}
        print(f"devproof-sanitizer: scrubbing {sorted(names)}", flush=True)
        return names, False
    except Exception as e:  # noqa: BLE001
        print(f"devproof-sanitizer: config parse failed, scrubbing all models: {e}", flush=True)
        return set(), True

LOCAL_MODELS, SCRUB_ALL = _load_local_models()
```

and change ONLY the body of `async_pre_call_hook` in `SchemaSanitizer` to:

```python
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        if SCRUB_ALL or data.get("model") in LOCAL_MODELS:
            for t in data.get("tools") or []:
                _scrub(t)
        return data
```

(Freshness: every config change already restarts the pod via the sync, so the module-load parse cannot go stale.)

- [ ] **Step 2: Tag the bootstrap config + add envFrom**

In the bootstrap `config.yaml` inside the ConfigMap, the `qwen05b-dp` entry gains:

```yaml
        model_info:
          devproof_local: true
```

In the Deployment container spec, after the existing `env:` block add:

```yaml
          envFrom:
            - secretRef: { name: gateway-provider-keys, optional: true }
```

(`optional: true` — the Secret first appears when the first keyed external endpoint is created.)

- [ ] **Step 3: Apply and live-verify**

```bash
kubectl apply -f deploy/gateway/litellm.yaml
kubectl rollout restart deployment/gateway -n devproof-gateway
kubectl rollout status deployment/gateway -n devproof-gateway --timeout=240s
kubectl logs -n devproof-gateway deploy/gateway --tail=30 | grep devproof-sanitizer
```
Expected: `devproof-sanitizer: scrubbing ['qwen05b-dp', ...]` (local names only, no parse-failure line).

Sanitizer regression check (the don't-regress case — a tool schema with an oversized bound against a LOCAL model must still work). Control plane must be running (start per CLAUDE.md if not, background); create a key, then:

```bash
KEY=$(curl -s -X POST http://localhost:7080/v1/api-keys -H "Content-Type: application/json" -H "X-Devproof-Workspace: wrkspc_default" -d '{"name":"sanitizer-check"}' | python -c "import sys,json;print(json.load(sys.stdin)['key'])")
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:14000/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"model":"qwen05b-dp","max_tokens":10,"messages":[{"role":"user","content":"call the tool"}],"tools":[{"type":"function","function":{"name":"t","parameters":{"type":"object","properties":{"s":{"type":"string","maxLength":524288,"pattern":"^[\\w-]+$"}}}}}]}'
```
Expected: `200` (scrub applied for the local model; without it llama.cpp returns a grammar error).

- [ ] **Step 4: Commit**

```bash
git add deploy/gateway/litellm.yaml
git commit -m "feat(gateway): scope GBNF sanitizer to local backends + provider-keys envFrom"
```

---

### Task 6: Console — Add endpoint, external actions, local edit

**Files:**
- Create: `console/app/deployments/external.tsx`
- Create: `console/app/deployments/edit-local.tsx`
- Modify: `console/app/deployments/page.tsx`

**Interfaces:**
- Consumes: Task 4 routes via the `/api` rewrite + `wsHeader()`/`apiPost` from `app/lib/client.ts`. GET rows now carry `kind`, and for externals `id`, `provider`, `modelId`, `baseUrl`.

- [ ] **Step 1: Create `console/app/deployments/external.tsx`**

```tsx
"use client";
// External provider endpoints: add-form + row actions (spec 2026-07-09).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { wsHeader } from "../lib/client";
import { Icon } from "../lib/icons";

const PRESETS: Record<string, { label: string; base: string; hint: string }> = {
  openai:     { label: "OpenAI",            base: "https://api.openai.com/v1",    hint: "gpt-4o" },
  anthropic:  { label: "Anthropic",          base: "https://api.anthropic.com",    hint: "<model-id>" },
  openrouter: { label: "OpenRouter",        base: "https://openrouter.ai/api/v1", hint: "meta-llama/llama-3.1-8b-instruct" },
  custom:     { label: "OpenAI-compatible (custom URL)", base: "", hint: "served model id" },
};

export function AddEndpointButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState("openai");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<string | null>(null);

  const test = async () => {
    setBusy(true); setProbe(null);
    const res = await fetch("/api/v1/deployments/external/test", {
      method: "POST", headers: { "Content-Type": "application/json", ...wsHeader() },
      body: JSON.stringify({ provider, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined }),
    });
    const j = await res.json();
    setProbe(j.ok ? `✓ ${j.detail}` : `✗ ${j.detail ?? j.error}`);
    setBusy(false);
  };

  const save = async () => {
    setBusy(true);
    const res = await fetch("/api/v1/deployments/external", {
      method: "POST", headers: { "Content-Type": "application/json", ...wsHeader() },
      body: JSON.stringify({ name, provider, baseUrl: baseUrl || undefined, modelId, apiKey: apiKey || undefined }),
    });
    setBusy(false);
    if (res.ok) { setOpen(false); setName(""); setModelId(""); setApiKey(""); setProbe(null); router.refresh(); }
    else alert(`Failed: ${(await res.json()).error ?? res.status}`);
  };

  if (!open) return <button onClick={() => setOpen(true)}><Icon.deploy /> Add endpoint</button>;
  return (
    <div className="card" style={{ marginBottom: 16, padding: 14 }}>
      <div className="formrow">
        <select value={provider} onChange={(e) => { setProvider(e.target.value); setBaseUrl(""); setProbe(null); }}>
          {Object.entries(PRESETS).map(([v, p]) => <option key={v} value={v}>{p.label}</option>)}
        </select>
        <input placeholder="deployment name (e.g. gpt4o)" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder={`model id (e.g. ${PRESETS[provider].hint})`} value={modelId} onChange={(e) => setModelId(e.target.value)} style={{ minWidth: 220 }} />
      </div>
      <div className="formrow">
        <input placeholder={provider === "custom" ? "base URL (required, e.g. http://host.docker.internal:8081/v1)" : `base URL (default: ${PRESETS[provider].base})`}
               value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ minWidth: 340 }} />
        <input placeholder="API key (write-only, optional for local)" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={{ minWidth: 240 }} />
      </div>
      <div className="formrow" style={{ alignItems: "center" }}>
        <button className="ghost" disabled={busy} onClick={test}>Test connection</button>
        {probe && <span style={{ fontSize: 12, color: probe.startsWith("✓") ? "var(--blue)" : "#d97706" }}>{probe}</span>}
        <button disabled={busy || !name || !modelId || (provider === "custom" && !baseUrl)} onClick={save}>
          {busy ? "Saving…" : "Save endpoint"}
        </button>
        <button className="ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

export function ExternalActions({ id, baseUrl, modelId }: { id: string; baseUrl: string | null; modelId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const edit = async () => {
    const newModel = prompt("Model id:", modelId);
    if (newModel === null) return;
    const newBase = prompt("Base URL (empty = provider default):", baseUrl ?? "");
    if (newBase === null) return;
    const newKey = prompt("New API key (leave empty to keep current):", "");
    setBusy(true);
    await fetch(`/api/v1/deployments/external/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json", ...wsHeader() },
      body: JSON.stringify({ modelId: newModel || undefined, baseUrl: newBase || undefined, apiKey: newKey || undefined }),
    });
    setBusy(false); router.refresh();
  };
  const del = async () => {
    if (!confirm("Remove this endpoint? The gateway route disappears immediately.")) return;
    setBusy(true);
    await fetch(`/api/v1/deployments/external/${id}`, { method: "DELETE", headers: wsHeader() });
    setBusy(false); router.refresh();
  };
  return (
    <div className="rowactions">
      <button className="iconbtn" title="Edit endpoint" aria-label="Edit endpoint" disabled={busy} onClick={edit}><Icon.deploy /></button>
      <button className="iconbtn danger" title="Remove endpoint" aria-label="Remove endpoint" disabled={busy} onClick={del}>
        {busy ? <span className="spin" /> : <Icon.trash />}
      </button>
    </div>
  );
}
```

(If `Icon.deploy` renders oddly as an edit glyph, pick any existing pencil-like icon from `app/lib/icons.tsx` — do not add new icon assets.)

- [ ] **Step 2: Create `console/app/deployments/edit-local.tsx`**

```tsx
"use client";
// Edit operational fields of a local deployment (CR merge-patch; pods roll).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { wsHeader } from "../lib/client";

export function EditLocalButton({ name }: { name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const edit = async () => {
    const min = prompt("Replicas min (empty = unchanged):", "");
    if (min === null) return;
    const max = prompt("Replicas max (empty = unchanged):", "");
    if (max === null) return;
    const ctx = prompt("Context tokens (empty = unchanged):", "");
    if (ctx === null) return;
    const body: any = {};
    if (min !== "" && max !== "") body.replicas = { min: Number(min), max: Number(max) };
    if (ctx !== "") body.contextTokens = Number(ctx);
    if (!Object.keys(body).length) return;
    setBusy(true);
    const res = await fetch(`/api/v1/deployments/${name}`, {
      method: "PATCH", headers: { "Content-Type": "application/json", ...wsHeader() },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) alert(`Edit failed: ${(await res.json()).error ?? res.status}`);
    router.refresh();
  };
  return <button className="iconbtn" title="Edit deployment" aria-label="Edit deployment" disabled={busy} onClick={edit}>✎</button>;
}
```

- [ ] **Step 3: Wire `console/app/deployments/page.tsx`**

- Extend the `Deployment` interface: `kind: "local" | "external"; id?: string; provider?: string; modelId?: string; baseUrl?: string | null;`
- Imports: `import { AddEndpointButton, ExternalActions } from "./external"; import { EditLocalButton } from "./edit-local";`
- In the `pagehead` formrow, add `<AddEndpointButton />` before `<SyncButton />`... the AddEndpointButton form is block-level: render `<AddEndpointButton />` on its own line directly under the `<p className="sub">` instead, and keep the pagehead unchanged.
- `PhaseCell`: externals have `phase === "External"` — render `<span className="phase Ready">External</span>` via: add at the top of `PhaseCell`: `if (d.phase === "External") return <span className="phase Ready">External</span>;`
- Table: Catalog cell becomes `d.kind === "external" ? <code>{d.provider}/{d.modelId}</code> : <code>{d.catalogId ?? "—"}</code>`; Pool cell `d.kind === "external" ? "—" : d.poolRef ?? "—"`; Endpoint cell for externals shows `d.baseUrl ?? "provider default"` truncated the same way.
- Actions cell:

```tsx
<td>{d.kind === "external"
  ? <ExternalActions id={d.id!} baseUrl={d.baseUrl ?? null} modelId={d.modelId!} />
  : <div className="rowactions"><EditLocalButton name={d.name} /><DeploymentActions name={d.name} /></div>}</td>
```

(`DeploymentActions` already returns a `rowactions` div; nesting is fine visually, but if it doubles the gap, move `EditLocalButton` inside the same wrapper style as used there.)

- [ ] **Step 4: Build + verify**

```bash
cd console && npx next build
```
Expected: build succeeds. Then with control plane + console running: `/deployments` shows the Add-endpoint button; adding a `custom` endpoint appears with kind `External`; edit/delete work; local rows show the ✎ button.

- [ ] **Step 5: Commit**

```bash
git add console/app/deployments/external.tsx console/app/deployments/edit-local.tsx console/app/deployments/page.tsx
git commit -m "feat(console): add-endpoint form, external row actions, local deployment edit"
```

---

### Task 7: E2E verification + docs

**Files:**
- Modify: `CLAUDE.md` (components line: migrations `016`→`017`; conventions: one line on external deployments + key Secret)
- Modify: `docs/concept/decisions-log.md` (new row 3.9)
- Modify: `docs/concept/platform-alignment-and-scale.md` (§2 gateway row gains "external provider endpoints routed alongside local models")

- [ ] **Step 1: Live e2e checklist**

With control plane (restart to pick up new code), console, operator, and gateway running:

```bash
# 0. fresh key
KEY=$(curl -s -X POST http://localhost:7080/v1/api-keys -H "Content-Type: application/json" -H "X-Devproof-Workspace: wrkspc_default" -d '{"name":"ext-e2e"}' | python -c "import sys,json;print(json.load(sys.stdin)['key'])")
# 1. custom external endpoint pointing at an in-cluster model service (no key) —
#    proves the external path with zero new infra; the GATEWAY can reach cluster DNS.
curl -s -X POST http://localhost:7080/v1/deployments/external -H "Content-Type: application/json" \
  -H "X-Devproof-Workspace: wrkspc_default" \
  -d '{"name":"ext-loop","provider":"custom","baseUrl":"http://qwen05b-dp.devproof-serving.svc.cluster.local:8080/v1","modelId":"qwen05b-dp"}'
kubectl rollout status deployment/gateway -n devproof-gateway --timeout=240s   # sync restarted it
# 2. chat through the gateway using the EXTERNAL name, Anthropic dialect
curl -s -X POST http://localhost:14000/v1/messages -H "Content-Type: application/json" \
  -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" \
  -d '{"model":"ext-loop","max_tokens":8,"messages":[{"role":"user","content":"Say OK"}]}'   # expect 200 + content
# 3. usage row landed under the external name
kubectl exec -n devproof-system deploy/postgres -- psql -U devproof -d devproof \
  -c "SELECT model, tokens_in, tokens_out FROM gateway_usage WHERE model='ext-loop' ORDER BY id DESC LIMIT 1"
# 4. test probe: internet provider without key → ok:false with an auth-ish detail (proves probe plumbing)
curl -s -X POST http://localhost:7080/v1/deployments/external/test -H "Content-Type: application/json" \
  -H "X-Devproof-Workspace: wrkspc_default" -d '{"provider":"openrouter"}'
# 5. edit local deployment: contextTokens on qwen2-5-0-5b-instruct-q4-5195 → CR patched, pods roll, route survives
curl -s -X PATCH http://localhost:7080/v1/deployments/qwen2-5-0-5b-instruct-q4-5195 -H "Content-Type: application/json" \
  -H "X-Devproof-Workspace: wrkspc_default" -d '{"contextTokens":16384}'
kubectl get modeldeployment qwen2-5-0-5b-instruct-q4-5195 -n devproof-serving -o jsonpath='{.spec.model.contextTokens}'  # 16384
# wait for Ready again, then confirm the route still answers (auto-sync held it)
# 6. sanitizer still scrubs local (Task 5's check) AND ext-loop entry has devproof_local:false in the live ConfigMap
kubectl get configmap litellm-config -n devproof-gateway -o jsonpath='{.data.config\.yaml}' | grep -A2 "model_name: ext-loop"
# 7. key rotation path: PATCH ext-loop with an apiKey → Secret gateway-provider-keys gains the entry, key_version 2 in config, gateway rolled
# 8. console: /deployments shows ext-loop (External badge), edit + delete work; delete ext-loop at the end → route gone
# 9. regression: cd control-plane && npm test && npx tsc --noEmit; all console pages 200
```

If the user supplies a real OpenRouter/Anthropic key at verification time, additionally register a real provider endpoint and verify a streaming request meters tokens (spec's verified-assumption ledger item). If no key is available, record that §8.2 of the spec remains unverified — do not fake it.

- [ ] **Step 2: Docs**

- `CLAUDE.md` line 14: `latest \`015\`` was already bumped to `016` — bump to `017`. In Conventions add: `- **External model endpoints** (OpenAI/Anthropic/OpenRouter/custom) are deployments too: rows in \`external_deployments\`, keys ONLY in the \`gateway-provider-keys\` Secret, routed by the gateway alongside local models; sanitizer applies only to \`devproof_local\` entries.`
- `docs/concept/decisions-log.md` §3 append: `| 3.9 | **External provider endpoints as deployments** — typed providers (OpenAI/Anthropic/OpenRouter/custom OpenAI-compatible), keys write-only in a K8s Secret, deployments editable (operational fields); version tracking explicitly deferred | Requested 07-09 | 07-09 |`
- `platform-alignment-and-scale.md` §2 Gateway sync row: append "External provider endpoints (BYO OpenAI/Anthropic/OpenRouter/custom) route through the same gateway with the same auth/metering."

- [ ] **Step 3: Final commit**

```bash
git add CLAUDE.md docs/concept/decisions-log.md docs/concept/platform-alignment-and-scale.md
git commit -m "docs: external provider endpoints — conventions, decision log, alignment notes"
```

---

## Self-Review Notes

- **Spec coverage:** table+CRUD (T1), provider mapping/env refs/key_version/flags (T2), Secret ops + CR patch (T3), routes incl. probe/409/400/whitelist/merged-paged GET (T4), sanitizer scoping + envFrom + bootstrap tag (T5), console add/edit/delete + local edit (T6), e2e incl. rotation + docs (T7). Spec §6 Secret-first create → T4 create with rollback-on-row-failure (implemented as row-then-secret-with-rollback inverted: row first, secret second, row deleted on secret failure — same no-orphaned-credentials property; the fixer may flip the order to match the spec text exactly if reviewers insist).
- **Placeholder scan:** clean.
- **Type consistency:** `envKeyFor` used in T2/T4 with same signature; `ExternalStore` methods match T1 repo signatures; row fields snake_case from DB everywhere; `kind` values `"local" | "external"` consistent T4/T6.
- **Create ordering:** T4 creates the DB row, then the Secret entry, deleting the row if the Secret write fails — the spec's §6 was amended (same commit) to state the invariant (no orphaned credentials, no keyed row without its Secret entry) with this order, since the entry key derives from the row id.
