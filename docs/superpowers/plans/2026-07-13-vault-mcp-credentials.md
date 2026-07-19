# Typed Vault Credentials + MCP Server Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typed vault credentials (Environment variable / Bearer token / MCP OAuth token-storage), a bundled MCP registry with a console picker, an agent-form MCP editor, launch-time Authorization-header injection matched by server URL, and an environment `allow_mcp_servers` egress toggle — so a session can authenticate to a remote MCP server (Context7) through the per-environment Squid proxy.

**Architecture:** Approach A from the spec (`docs/superpowers/specs/2026-07-13-vault-mcp-credentials-design.md`): typed rows in `vault_credentials` (values stay ONLY in the per-vault K8s Secret, injected via the existing `envFrom`); the CP renders `Authorization: Bearer ${DEVPROOF_CRED_<NAME>_TOKEN}` **placeholders** into the launch payload's `mcp_servers`; the runner expands `${VAR}` from the pod env. Egress: `squidConf` gains an `mcpHosts` argument, computed per environment from the latest agent versions when `allow_mcp_servers` is on.

**Tech Stack:** Node/TS (Fastify, `node:test`), Postgres (re-run-every-boot migrations), Next.js console, Python runner (unittest inside the Docker image), K8s Secrets/Squid.

## Global Constraints

- Migrations re-run EVERY boot → every statement idempotent (`ADD COLUMN IF NOT EXISTS`; CHECK inline on the column, never `ADD CONSTRAINT` — 023/024 idiom).
- Secret **values** never touch the DB, the Job spec, or `DEVPROOF_AGENT_CONFIG` — only derived key **names**.
- Derived secret keys are `[A-Z0-9_]+` (valid K8s Secret key AND `C_IDENTIFIER` env name).
- Runner change ⇒ bump image tag `dev26` → `dev27` (nodes cache same-tag rebuilds).
- Console: shared `Modal`/`Field` from `console/app/lib/modal.tsx`; NO browser `prompt()/confirm()/alert()`; no transparent text buttons; table links regular weight.
- All lists stay 100/page; endpoints return `{rows, count, offset}` where applicable.
- Backend gate: `cd control-plane && npm test` and `npx tsc --noEmit`. Console gate: `cd console && npx next build`.
- Git commit footer (every commit):
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018jG2NiYKGURjee1g6RWhyb
  ```
- Windows PowerShell 5.1: no `&&` — run chained commands as separate lines (or use the Bash tool).

---

### Task 1: Pure MCP/credential helpers (`src/mcp.ts`)

**Files:**
- Create: `control-plane/src/mcp.ts`
- Test: `control-plane/test/mcp.test.ts`

**Interfaces:**
- Consumes: nothing (pure module; `yaml` dep already in package.json — used by `catalog.ts`).
- Produces (later tasks import these exact names from `./mcp.ts`):
  - `type CredentialType = "environment_variable" | "bearer_token" | "mcp_oauth"`
  - `interface CredentialRow { name: string; type: CredentialType; mcp_server_url?: string | null }`
  - `interface McpRegistryEntry { name: string; label: string; url: string; description?: string; auth: "oauth" | "bearer" | "none" }`
  - `loadMcpRegistry(path: string): McpRegistryEntry[]`
  - `sanitizeCredentialName(name: string): string`
  - `credentialSecretKeys(name: string, type: CredentialType): string[]`
  - `normalizeMcpUrl(url: string): string`
  - `renderMcpServers(mcpServers: Record<string, any>, credentials: CredentialRow[]): Record<string, any>`
  - `mcpHostnames(mcpServersList: Record<string, any>[]): string[]`
  - `validateMcpServers(value: unknown): string | null`
  - `validateCredentialBody(b: any): { error: string } | CredentialInput` where `interface CredentialInput { name: string; type: CredentialType; mcpServerUrl?: string; mcpServerName?: string; secrets: Record<string, string> }`

- [ ] **Step 1: Write the failing tests**

Create `control-plane/test/mcp.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeCredentialName, credentialSecretKeys, normalizeMcpUrl,
  renderMcpServers, mcpHostnames, validateMcpServers, validateCredentialBody,
} from "../src/mcp.ts";

test("sanitizeCredentialName → [A-Z0-9_] only", () => {
  assert.equal(sanitizeCredentialName("context7"), "CONTEXT7");
  assert.equal(sanitizeCredentialName("mcp.context7.com"), "MCP_CONTEXT7_COM");
  assert.equal(sanitizeCredentialName("my-cred 2"), "MY_CRED_2");
});

test("credentialSecretKeys per type", () => {
  assert.deepEqual(credentialSecretKeys("MY_API_KEY", "environment_variable"), ["MY_API_KEY"]);
  assert.deepEqual(credentialSecretKeys("context7", "bearer_token"), ["DEVPROOF_CRED_CONTEXT7_TOKEN"]);
  assert.deepEqual(credentialSecretKeys("gh", "mcp_oauth"),
    ["DEVPROOF_CRED_GH_TOKEN", "DEVPROOF_CRED_GH_CLIENT_ID", "DEVPROOF_CRED_GH_CLIENT_SECRET"]);
});

test("normalizeMcpUrl: lowercase host, trailing slash stripped, path kept", () => {
  assert.equal(normalizeMcpUrl("HTTPS://MCP.Context7.COM/mcp/"), "https://mcp.context7.com/mcp");
  assert.equal(normalizeMcpUrl("https://a.com"), "https://a.com");
  assert.equal(normalizeMcpUrl("https://a.com/x") === normalizeMcpUrl("https://a.com/y"), false);
});

test("renderMcpServers injects a placeholder Authorization for URL-matched credentials", () => {
  const servers = { context7: { type: "http", url: "https://mcp.context7.com/mcp/" } };
  const creds = [{ name: "context7", type: "bearer_token" as const, mcp_server_url: "https://mcp.context7.com/mcp" }];
  const out = renderMcpServers(servers, creds);
  assert.equal(out.context7.headers.Authorization, "Bearer ${DEVPROOF_CRED_CONTEXT7_TOKEN}");
  assert.equal(out.context7.url, "https://mcp.context7.com/mcp/"); // original config untouched otherwise
});

test("renderMcpServers: no match / env-var creds / preset Authorization → unchanged", () => {
  const servers = {
    a: { type: "http", url: "https://a.com/mcp" },
    b: { type: "http", url: "https://b.com/mcp", headers: { authorization: "Bearer preset" } },
  };
  const creds = [
    { name: "x", type: "bearer_token" as const, mcp_server_url: "https://other.com/mcp" },
    { name: "ENV_ONLY", type: "environment_variable" as const },
    { name: "b", type: "bearer_token" as const, mcp_server_url: "https://b.com/mcp" },
  ];
  const out = renderMcpServers(servers, creds);
  assert.equal(out.a.headers, undefined);
  assert.equal(out.b.headers.authorization, "Bearer preset"); // preset (any case) wins
  assert.equal(Object.keys(out.b.headers).length, 1);
});

test("renderMcpServers: mcp_oauth matches like bearer", () => {
  const out = renderMcpServers(
    { gh: { type: "http", url: "https://api.githubcopilot.com/mcp/" } },
    [{ name: "gh", type: "mcp_oauth" as const, mcp_server_url: "https://api.githubcopilot.com/mcp" }]);
  assert.equal(out.gh.headers.Authorization, "Bearer ${DEVPROOF_CRED_GH_TOKEN}");
});

test("mcpHostnames: unique sorted hostnames, invalid urls skipped", () => {
  assert.deepEqual(mcpHostnames([
    { a: { url: "https://mcp.context7.com/mcp" }, b: { url: "https://api.githubcopilot.com/mcp/" } },
    { c: { url: "https://mcp.context7.com/other" } },
    { d: { url: "not a url" } }, { e: {} },
  ]), ["api.githubcopilot.com", "mcp.context7.com"]);
});

test("validateMcpServers: shape errors", () => {
  assert.equal(validateMcpServers(undefined), null);
  assert.equal(validateMcpServers({}), null);
  assert.equal(validateMcpServers({ ok: { type: "http", url: "https://a.com/mcp" } }), null);
  assert.match(validateMcpServers([])!, /object/);
  assert.match(validateMcpServers({ "bad name!": { url: "https://a.com" } })!, /bad server name/);
  assert.match(validateMcpServers({ a: { url: "ftp://a.com" } })!, /http\(s\)/);
  assert.match(validateMcpServers({ a: "nope" })!, /must be an object/);
});

test("validateCredentialBody: env var type (legacy body shape)", () => {
  const r = validateCredentialBody({ name: "MY_API_KEY", value: "s3cret" });
  assert.deepEqual(r, { name: "MY_API_KEY", type: "environment_variable", secrets: { MY_API_KEY: "s3cret" } });
  assert.match((validateCredentialBody({ name: "2bad", value: "x" }) as any).error, /environment variable name/);
  assert.match((validateCredentialBody({ name: "OK" }) as any).error, /value required/);
});

test("validateCredentialBody: bearer_token", () => {
  const r: any = validateCredentialBody({
    type: "bearer_token", mcpServerUrl: "https://mcp.context7.com/mcp", mcpServerName: "context7", token: "tok",
  });
  assert.equal(r.name, "context7"); // derived from mcpServerName when name empty
  assert.deepEqual(r.secrets, { DEVPROOF_CRED_CONTEXT7_TOKEN: "tok" });
  assert.match((validateCredentialBody({ type: "bearer_token", mcpServerUrl: "nope", token: "t" }) as any).error, /http\(s\)/);
  assert.match((validateCredentialBody({ type: "bearer_token", mcpServerUrl: "https://a.com" }) as any).error, /token required/);
});

test("validateCredentialBody: mcp_oauth with optional client fields", () => {
  const r: any = validateCredentialBody({
    type: "mcp_oauth", mcpServerUrl: "https://api.githubcopilot.com/mcp/", accessToken: "at", clientId: "cid",
  });
  assert.equal(r.name, "api.githubcopilot.com"); // no name/mcpServerName → hostname
  assert.deepEqual(r.secrets, {
    "DEVPROOF_CRED_API_GITHUBCOPILOT_COM_TOKEN": "at",
    "DEVPROOF_CRED_API_GITHUBCOPILOT_COM_CLIENT_ID": "cid",
  }); // clientSecret omitted → key not written (rotate leaves it unchanged)
  assert.match((validateCredentialBody({ type: "mcp_oauth", mcpServerUrl: "https://a.com" }) as any).error, /accessToken required/);
});

test("validateCredentialBody: unknown type", () => {
  assert.match((validateCredentialBody({ type: "wat" }) as any).error, /unknown credential type/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `control-plane/`): `npm test -- test/mcp.test.ts` (or `node --test test/mcp.test.ts` if npm test doesn't take a filter)
Expected: FAIL — `Cannot find module '../src/mcp.ts'`

- [ ] **Step 3: Write the implementation**

Create `control-plane/src/mcp.ts`:

```ts
// MCP servers + typed vault credentials (spec 2026-07-13). Pure helpers:
// URL matching, placeholder header rendering, egress hosts, validation.
// Secret VALUES never pass through here — only derived key names.
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type CredentialType = "environment_variable" | "bearer_token" | "mcp_oauth";

export interface CredentialRow {
  name: string;
  type: CredentialType;
  mcp_server_url?: string | null;
}

export interface McpRegistryEntry {
  name: string;
  label: string;
  url: string;
  description?: string;
  auth: "oauth" | "bearer" | "none";
}

export function loadMcpRegistry(path: string): McpRegistryEntry[] {
  const doc = parse(readFileSync(path, "utf8"));
  return doc?.servers ?? [];
}

/** Credential name → key fragment valid as BOTH a Secret key and a
 *  C_IDENTIFIER env var name, so envFrom can never skip it. */
export function sanitizeCredentialName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

/** Every Secret key a credential may own — delete removes them all
 *  (removing a never-written key is a no-op merge patch). */
export function credentialSecretKeys(name: string, type: CredentialType): string[] {
  if (type === "environment_variable") return [name];
  const base = `DEVPROOF_CRED_${sanitizeCredentialName(name)}`;
  return type === "bearer_token"
    ? [`${base}_TOKEN`]
    : [`${base}_TOKEN`, `${base}_CLIENT_ID`, `${base}_CLIENT_SECRET`];
}

/** Credential↔server matching key: lowercase scheme+host (URL does this),
 *  trailing slash stripped, path kept (case-sensitive), query kept. */
export function normalizeMcpUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

/** Inject Authorization PLACEHOLDERS (${VAR}, expanded by the runner from the
 *  pod env) for bearer/oauth credentials whose server URL matches an agent
 *  MCP server. A server that already carries an Authorization header (any
 *  case — raw API config) is left untouched. */
export function renderMcpServers(
  mcpServers: Record<string, any>, credentials: CredentialRow[],
): Record<string, any> {
  const byUrl = new Map<string, CredentialRow>();
  for (const c of credentials) {
    if ((c.type === "bearer_token" || c.type === "mcp_oauth") && c.mcp_server_url) {
      byUrl.set(normalizeMcpUrl(c.mcp_server_url), c);
    }
  }
  const out: Record<string, any> = {};
  for (const [name, cfg] of Object.entries(mcpServers ?? {})) {
    const url = typeof cfg?.url === "string" ? normalizeMcpUrl(cfg.url) : null;
    const cred = url ? byUrl.get(url) : undefined;
    const hasAuth = cfg?.headers &&
      Object.keys(cfg.headers).some((h) => h.toLowerCase() === "authorization");
    out[name] = cred && !hasAuth
      ? { ...cfg, headers: { ...(cfg.headers ?? {}),
          Authorization: `Bearer \${DEVPROOF_CRED_${sanitizeCredentialName(cred.name)}_TOKEN}` } }
      : cfg;
  }
  return out;
}

/** Unique sorted hostnames across mcp_servers maps — the env's Squid
 *  MCP allowlist. Invalid URLs are skipped (validation rejects new ones). */
export function mcpHostnames(mcpServersList: Record<string, any>[]): string[] {
  const hosts = new Set<string>();
  for (const servers of mcpServersList) {
    for (const cfg of Object.values(servers ?? {})) {
      const url = (cfg as any)?.url;
      if (typeof url !== "string") continue;
      try { hosts.add(new URL(url).hostname); } catch { /* skip */ }
    }
  }
  return [...hosts].sort();
}

const SERVER_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Agent mcpServers shape guard (routes 400 on the returned message).
 *  Extra fields (e.g. pre-set headers) pass through untouched. */
export function validateMcpServers(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "mcpServers must be an object";
  for (const [name, cfg] of Object.entries(value as Record<string, any>)) {
    if (!SERVER_NAME_RE.test(name)) return `mcpServers: bad server name "${name}"`;
    if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) return `mcpServers.${name}: must be an object`;
    if (typeof cfg.url !== "string" || !/^https?:\/\//i.test(cfg.url)) return `mcpServers.${name}: url must be http(s)`;
    try { new URL(cfg.url); } catch { return `mcpServers.${name}: invalid url`; }
  }
  return null;
}

export interface CredentialInput {
  name: string;
  type: CredentialType;
  mcpServerUrl?: string;
  mcpServerName?: string;
  /** Derived Secret keys → values to write. Omitted optional parts
   *  (oauth clientId/clientSecret) are simply absent → rotate leaves them. */
  secrets: Record<string, string>;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CRED_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function validateCredentialBody(b: any): { error: string } | CredentialInput {
  const type: CredentialType = b?.type ?? "environment_variable";
  if (!["environment_variable", "bearer_token", "mcp_oauth"].includes(type)) {
    return { error: `unknown credential type "${b?.type}"` };
  }
  if (type === "environment_variable") {
    if (!b?.name || !ENV_NAME_RE.test(b.name)) return { error: "name must be a valid environment variable name" };
    if (typeof b?.value !== "string" || !b.value) return { error: "value required" };
    return { name: b.name, type, secrets: { [b.name]: b.value } };
  }
  const url = b?.mcpServerUrl;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return { error: "mcpServerUrl must be http(s)" };
  let hostname: string;
  try { hostname = new URL(url).hostname; } catch { return { error: "mcpServerUrl invalid" }; }
  const name = String(b?.name ?? "").trim() || String(b?.mcpServerName ?? "").trim() || hostname;
  if (!CRED_NAME_RE.test(name)) return { error: "invalid credential name" };
  const token = type === "bearer_token" ? b?.token : b?.accessToken;
  if (typeof token !== "string" || !token) {
    return { error: type === "bearer_token" ? "token required" : "accessToken required" };
  }
  const base = `DEVPROOF_CRED_${sanitizeCredentialName(name)}`;
  const secrets: Record<string, string> = { [`${base}_TOKEN`]: token };
  if (type === "mcp_oauth") {
    if (b?.clientId) secrets[`${base}_CLIENT_ID`] = String(b.clientId);
    if (b?.clientSecret) secrets[`${base}_CLIENT_SECRET`] = String(b.clientSecret);
  }
  return { name, type, mcpServerUrl: url, mcpServerName: b?.mcpServerName, secrets };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `control-plane/`): `npm test` — all `mcp.test.ts` tests PASS, no other suite broken. Then `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/mcp.ts control-plane/test/mcp.test.ts
git commit -m "feat(cp): pure MCP credential helpers — key derivation, URL matching, header rendering"
```

---

### Task 2: Migration 028 + repo helpers

**Files:**
- Create: `control-plane/sql/028_typed_credentials.sql`
- Modify: `control-plane/src/repo.ts:523-535` (vault credential helpers), `repo.ts:671-703` (environments)
- Test: `control-plane/test/repo.test.ts` (append; suite self-skips without the dev DB)

**Interfaces:**
- Consumes: nothing new.
- Produces (exact repo method signatures later tasks call):
  - `listVaultCredentials(vaultId: string)` → rows now include `type`, `mcp_server_url`, `mcp_server_name`
  - `getVaultCredential(vaultId: string, name: string)` → row or null
  - `addVaultCredential(vaultId: string, name: string, type?: string, mcpServerUrl?: string | null, mcpServerName?: string | null)`
  - `mcpServersForEnvironment(environmentId: string): Promise<Record<string, any>[]>`
  - `createEnvironment(workspaceId, name, allowPackageManagers?, allowedHosts?, pod?, allowMcpServers?)` — returns `{ id, name, allowPackageManagers, allowedHosts, pod, allowMcpServers }`
  - `updateEnvironment(workspaceId, id, patch)` — patch gains `allowMcpServers?: boolean`

- [ ] **Step 1: Write the migration**

Create `control-plane/sql/028_typed_credentials.sql`:

```sql
-- Typed vault credentials + MCP egress toggle (spec 2026-07-13).
-- Values still live ONLY in the per-vault K8s Secret; these columns type the
-- rows and bind MCP credentials to a server URL for launch-time header
-- injection. CHECK rides the ADD COLUMN (023/024 idiom): applied only at
-- column creation, skipped on boot re-runs.
ALTER TABLE vault_credentials ADD COLUMN IF NOT EXISTS type TEXT NOT NULL
  DEFAULT 'environment_variable'
  CHECK (type IN ('environment_variable', 'bearer_token', 'mcp_oauth'));
ALTER TABLE vault_credentials ADD COLUMN IF NOT EXISTS mcp_server_url  TEXT;
ALTER TABLE vault_credentials ADD COLUMN IF NOT EXISTS mcp_server_name TEXT;

ALTER TABLE environments ADD COLUMN IF NOT EXISTS allow_mcp_servers BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 2: Update the repo vault helpers**

In `control-plane/src/repo.ts`, replace `listVaultCredentials` and `addVaultCredential` (lines 523-532) and add `getVaultCredential`:

```ts
  async listVaultCredentials(vaultId: string) {
    const { rows } = await this.pool.query(
      "SELECT name, type, mcp_server_url, mcp_server_name, created_at FROM vault_credentials WHERE vault_id = $1 ORDER BY name",
      [vaultId]);
    return rows;
  }
  async getVaultCredential(vaultId: string, name: string) {
    const { rows } = await this.pool.query(
      "SELECT name, type, mcp_server_url, mcp_server_name, created_at FROM vault_credentials WHERE vault_id = $1 AND name = $2",
      [vaultId, name]);
    return rows[0] ?? null;
  }
  // Same name+type+server = rotate (upsert, the pre-028 semantics); the API
  // layer 409s a name reuse with a DIFFERENT type/server before calling this.
  async addVaultCredential(vaultId: string, name: string, type = "environment_variable",
                           mcpServerUrl?: string | null, mcpServerName?: string | null) {
    await this.pool.query(
      `INSERT INTO vault_credentials (vault_id, name, type, mcp_server_url, mcp_server_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (vault_id, name) DO UPDATE
         SET created_at = now(), type = $3, mcp_server_url = $4, mcp_server_name = $5`,
      [vaultId, name, type, mcpServerUrl ?? null, mcpServerName ?? null]);
  }
```

- [ ] **Step 3: Add the environment MCP query + allow_mcp_servers plumbing**

Still in `repo.ts` — after `environmentInUse` (line 641-644) add:

```ts
  /** mcp_servers of the LATEST version of every agent bound to this
   *  environment — input for the env's Squid MCP-host allowlist. */
  async mcpServersForEnvironment(environmentId: string): Promise<Record<string, any>[]> {
    const { rows } = await this.pool.query(
      `SELECT mcp_servers FROM (
         SELECT DISTINCT ON (agent_id) environment_id, mcp_servers
         FROM agent_versions ORDER BY agent_id, version DESC
       ) latest WHERE environment_id = $1`, [environmentId]);
    return rows.map((r: any) => r.mcp_servers ?? {});
  }
```

Replace `createEnvironment` (lines 671-678) with:

```ts
  async createEnvironment(workspaceId: string, name: string, allowPackageManagers = false,
                          allowedHosts: string[] = [], pod: PodConfig = {}, allowMcpServers = false) {
    const id = rid("env");
    await this.pool.query(
      "INSERT INTO environments (id, workspace_id, name, allow_package_managers, allowed_hosts, pod, allow_mcp_servers) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [id, workspaceId, name, allowPackageManagers, JSON.stringify(allowedHosts), JSON.stringify(pod), allowMcpServers],
    );
    return { id, name, allowPackageManagers, allowedHosts, pod, allowMcpServers };
  }
```

In `updateEnvironment` (lines 686-703): extend the patch type with `allowMcpServers?: boolean` and add after the `allowPackageManagers` line:

```ts
    if (patch.allowMcpServers !== undefined) { params.push(patch.allowMcpServers); sets.push(`allow_mcp_servers = $${params.length}`); }
```

- [ ] **Step 4: Append an integration test**

Append to `control-plane/test/repo.test.ts` (follows the file's skip-without-DB pattern; `pool`, `available` already exist at module top):

```ts
test("typed vault credentials roundtrip + env MCP query", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-ws-mcp-${Date.now()}`)).id;
  const vault = await repo.createVault(ws, `t-vlt-${Date.now()}`);

  await repo.addVaultCredential(vault.id, "context7", "bearer_token", "https://mcp.context7.com/mcp", "Context7");
  const cred = await repo.getVaultCredential(vault.id, "context7");
  assert.equal(cred.type, "bearer_token");
  assert.equal(cred.mcp_server_url, "https://mcp.context7.com/mcp");
  // legacy call shape still works and defaults to environment_variable
  await repo.addVaultCredential(vault.id, "MY_KEY");
  assert.equal((await repo.getVaultCredential(vault.id, "MY_KEY")).type, "environment_variable");
  assert.equal((await repo.listVaultCredentials(vault.id)).length, 2);

  const env = await repo.createEnvironment(ws, `t-env-${Date.now()}`, false, [], {}, true);
  assert.equal(env.allowMcpServers, true);
  const agent = await repo.createAgent(ws, `t-mcp-${Date.now()}`, {
    model: "qwen05b-dp", environmentId: env.id,
    mcpServers: { context7: { type: "http", url: "https://mcp.context7.com/mcp" } },
  });
  const servers = await repo.mcpServersForEnvironment(env.id);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].context7.url, "https://mcp.context7.com/mcp");
  // a NEW version pointing elsewhere removes the agent from this env's set
  await repo.newAgentVersion(ws, agent.id, { model: "qwen05b-dp",
    environmentId: (await repo.createEnvironment(ws, `t-env2-${Date.now()}`)).id });
  assert.equal((await repo.mcpServersForEnvironment(env.id)).length, 0);

  await pool.query("DELETE FROM workspaces WHERE id = $1", [ws]); // cascade cleanup
});
```

- [ ] **Step 5: Run tests**

Run (from `control-plane/`): `npm test` → new repo test PASS (or SKIP if DB down — then start the CP dependencies first; the dev Postgres is `localhost:15432` via localhost-lb). `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add control-plane/sql/028_typed_credentials.sql control-plane/src/repo.ts control-plane/test/repo.test.ts
git commit -m "feat(cp): migration 028 — typed vault credentials + env allow_mcp_servers"
```

---

### Task 3: `squidConf` MCP hosts

**Files:**
- Modify: `control-plane/src/egress.ts:8`
- Test: `control-plane/test/egress.test.ts` (append)

**Interfaces:**
- Produces: `squidConf(hosts: string[], allowPackageManagers: boolean, mcpHosts?: string[]): string` — third arg optional, default `[]`; existing callers unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `control-plane/test/egress.test.ts`:

```ts
test("mcpHosts join the allowlist with leading-dot semantics", () => {
  const conf = squidConf(["docs.dremio.com"], false, ["mcp.context7.com", "api.githubcopilot.com"]);
  assert.match(conf, /acl allowed dstdomain \.docs\.dremio\.com \.mcp\.context7\.com \.api\.githubcopilot\.com/);
});

test("mcpHosts alone still produce an allow rule", () => {
  const conf = squidConf([], false, ["mcp.context7.com"]);
  assert.match(conf, /acl allowed dstdomain \.mcp\.context7\.com/);
  assert.match(conf, /http_access allow allowed/);
});

test("omitted mcpHosts keeps existing behavior", () => {
  assert.equal(squidConf(["a.com"], false), squidConf(["a.com"], false, []));
});
```

- [ ] **Step 2: Run to verify failure** — `npm test` → the two new assertions FAIL (arity/conf mismatch).

- [ ] **Step 3: Implement**

In `control-plane/src/egress.ts` change the signature and add the hosts before the `allowPackageManagers` block:

```ts
export function squidConf(hosts: string[], allowPackageManagers: boolean, mcpHosts: string[] = []): string {
  const all = hosts.includes("*");
  const normalized = hosts
    .filter((h) => h !== "*")
    .map((h) => h.replace(/^\*\./, "."))
    .map((h) => (h.startsWith(".") ? h : `.${h}`));
  // MCP server hostnames (env allow_mcp_servers, spec 2026-07-13) — plain
  // hostnames from URL parsing, same leading-dot subdomain semantics.
  normalized.push(...mcpHosts.map((h) => (h.startsWith(".") ? h : `.${h}`)));
  if (allowPackageManagers) {
```

(rest of the function unchanged)

- [ ] **Step 4: Run tests** — `npm test` → all egress tests PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/egress.ts control-plane/test/egress.test.ts
git commit -m "feat(cp): squidConf accepts MCP server hosts"
```

---

### Task 4: MCP registry — bundled YAML + API routes

**Files:**
- Create: `catalog/mcp-servers.yaml`
- Modify: `control-plane/src/agents-api.ts:74-78` (opts), `control-plane/src/main.ts:16-18,102-103`, `control-plane/src/public-api.ts:35-47`
- Test: manual curl (route is a static passthrough; the loader is covered by using the real file)

**Interfaces:**
- Consumes: `loadMcpRegistry`, `McpRegistryEntry` from Task 1.
- Produces: `GET /v1/mcp-registry` and `GET /api/mcp-registry` → `{ servers: McpRegistryEntry[] }`; `registerAgentRoutes` and `registerPublicApi` `opts` gain `mcpRegistry?: McpRegistryEntry[]`.

- [ ] **Step 1: Create the registry file**

Create `catalog/mcp-servers.yaml`:

```yaml
# Bundled MCP server registry (spec 2026-07-13). Sovereignty stance: shipped
# with the platform like models.yaml — no live registry dependency. Remote
# streamable-HTTP servers only. auth: what the server expects (oauth servers
# accept a pre-obtained token via the MCP OAuth credential type).
servers:
  - name: context7
    label: Context7
    url: https://mcp.context7.com/mcp
    description: Up-to-date library and framework documentation
    auth: bearer
  - name: github
    label: GitHub
    url: https://api.githubcopilot.com/mcp/
    description: GitHub repositories, issues, and pull requests
    auth: oauth
  - name: deepwiki
    label: DeepWiki
    url: https://mcp.deepwiki.com/mcp
    description: Ask questions about public GitHub repositories
    auth: none
  - name: sentry
    label: Sentry
    url: https://mcp.sentry.dev/mcp
    description: Errors, issues, and projects from Sentry
    auth: oauth
  - name: linear
    label: Linear
    url: https://mcp.linear.app/mcp
    description: Linear issues and projects
    auth: oauth
```

- [ ] **Step 2: Serve it from both APIs**

`control-plane/src/agents-api.ts` — extend the `opts` parameter type (line 77):

```ts
  opts?: { modelPhase?: (model: string) => Promise<import("./launch-gate.ts").ModelPhase>;
           mcpRegistry?: import("./mcp.ts").McpRegistryEntry[] },
```

and register (next to `/v1/storage-classes`, after line 214):

```ts
  // Bundled MCP server registry for the console picker (spec 2026-07-13).
  app.get("/v1/mcp-registry", async () => ({ servers: opts?.mcpRegistry ?? [] }));
```

`control-plane/src/public-api.ts` — same `opts` extension on `registerPublicApi` (line 38), and inside the `api` scope (e.g. after the skills routes, line 214):

```ts
    api.get("/mcp-registry", async () => ({ servers: opts?.mcpRegistry ?? [] }));
```

`control-plane/src/main.ts` — after the `catalogPath` const (line 18):

```ts
const mcpRegistryPath =
  process.env.DEVPROOF_MCP_REGISTRY ??
  fileURLToPath(new URL("../../catalog/mcp-servers.yaml", import.meta.url));
```

add `loadMcpRegistry` to the `./mcp.ts` import (new import line: `import { loadMcpRegistry } from "./mcp.ts";`), then extend both registrations (lines 102-103):

```ts
const mcpRegistry = loadMcpRegistry(mcpRegistryPath);
await registerAgentRoutes(app, repo, orchestrator, files, notify, { modelPhase, mcpRegistry });
await registerPublicApi(app, repo, orchestrator, files, notify, { modelPhase, mcpRegistry });
```

- [ ] **Step 3: Verify**

`npx tsc --noEmit` clean; start the CP (per CLAUDE.md run block) and:

```
curl -s http://localhost:7080/v1/mcp-registry
```
Expected: JSON with 5 servers, `context7` first.

- [ ] **Step 4: Commit**

```bash
git add catalog/mcp-servers.yaml control-plane/src/agents-api.ts control-plane/src/public-api.ts control-plane/src/main.ts
git commit -m "feat(cp): bundled MCP server registry + /v1/mcp-registry"
```

---

### Task 5: Typed credential routes (console + public API)

**Files:**
- Modify: `control-plane/src/agents-api.ts:300-317` (credential POST/DELETE), `control-plane/src/public-api.ts:233-248` (same)
- Test: `control-plane/test/vault-credentials.test.ts` (new, self-contained fakes)

**Interfaces:**
- Consumes: `validateCredentialBody`, `credentialSecretKeys` (Task 1); `repo.getVaultCredential`, extended `addVaultCredential` (Task 2).
- Produces: `POST /v1/vaults/:id/credentials` accepts the typed body (legacy `{name, value}` still = env var); 201 `{name, type}`; 400 per-type validation; 409 on name reuse with different type/server. DELETE removes ALL derived Secret keys.

- [ ] **Step 1: Write the failing route tests**

Create `control-plane/test/vault-credentials.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerAgentRoutes, type Orchestrator } from "../src/agents-api.ts";

function fixture() {
  const creds: Record<string, any> = {};
  const secretPuts: [string, string][] = [];   // [key, value]
  const secretRemoves: string[] = [];
  const repo: any = {
    async getVault(_ws: string, id: string) { return id === "vlt_1" ? { id, name: "v" } : null; },
    async getVaultCredential(_v: string, name: string) { return creds[name] ?? null; },
    async addVaultCredential(_v: string, name: string, type = "environment_variable", url?: string, label?: string) {
      creds[name] = { name, type, mcp_server_url: url ?? null, mcp_server_name: label ?? null };
    },
    async removeVaultCredential(_v: string, name: string) { delete creds[name]; },
    async listVaultCredentials() { return Object.values(creds); },
  };
  const orchestrator = {
    async putVaultSecretKey(_v: string, key: string, value: string) { secretPuts.push([key, value]); },
    async removeVaultSecretKey(_v: string, key: string) { secretRemoves.push(key); },
  } as unknown as Orchestrator;
  return { repo, orchestrator, creds, secretPuts, secretRemoves };
}

async function server(f: ReturnType<typeof fixture>) {
  const app = Fastify();
  await registerAgentRoutes(app, f.repo, f.orchestrator, {} as any);
  return app;
}

test("bearer credential: derived key written, typed row stored", async () => {
  const f = fixture(); const app = await server(f);
  const res = await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { type: "bearer_token", mcpServerUrl: "https://mcp.context7.com/mcp", mcpServerName: "Context7", token: "tok" } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json(), { name: "Context7", type: "bearer_token" });
  assert.deepEqual(f.secretPuts, [["DEVPROOF_CRED_CONTEXT7_TOKEN", "tok"]]);
  assert.equal(f.creds.Context7.mcp_server_url, "https://mcp.context7.com/mcp");
});

test("legacy env-var body still works", async () => {
  const f = fixture(); const app = await server(f);
  const res = await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { name: "MY_KEY", value: "s" } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(f.secretPuts, [["MY_KEY", "s"]]);
  assert.equal(f.creds.MY_KEY.type, "environment_variable");
});

test("rotate: same name+type+server upserts; different type 409s", async () => {
  const f = fixture(); const app = await server(f);
  const body = { type: "bearer_token", mcpServerUrl: "https://a.com/mcp", name: "c", token: "t1" };
  assert.equal((await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials", payload: body })).statusCode, 201);
  assert.equal((await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { ...body, token: "t2" } })).statusCode, 201); // rotate
  const conflict = await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { name: "c", value: "x" } }); // same name, env-var type
  assert.equal(conflict.statusCode, 409);
  const moved = await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { ...body, mcpServerUrl: "https://other.com/mcp" } }); // same name, different server
  assert.equal(moved.statusCode, 409);
});

test("validation 400s: unknown type, bad env name, missing token", async () => {
  const f = fixture(); const app = await server(f);
  for (const payload of [
    { type: "wat", name: "x", value: "v" },
    { name: "2bad", value: "v" },
    { type: "mcp_oauth", mcpServerUrl: "https://a.com/mcp" },
  ]) {
    const res = await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials", payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

test("delete removes every derived key for the credential's type", async () => {
  const f = fixture(); const app = await server(f);
  await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials",
    payload: { type: "mcp_oauth", mcpServerUrl: "https://a.com/mcp", name: "gh", accessToken: "t" } });
  const res = await app.inject({ method: "DELETE", url: "/v1/vaults/vlt_1/credentials/gh" });
  assert.equal(res.statusCode, 204);
  assert.deepEqual(f.secretRemoves,
    ["DEVPROOF_CRED_GH_TOKEN", "DEVPROOF_CRED_GH_CLIENT_ID", "DEVPROOF_CRED_GH_CLIENT_SECRET"]);
  assert.equal(f.creds.gh, undefined);
});

test("env-var delete removes the plain key (back-compat)", async () => {
  const f = fixture(); const app = await server(f);
  await app.inject({ method: "POST", url: "/v1/vaults/vlt_1/credentials", payload: { name: "MY_KEY", value: "s" } });
  await app.inject({ method: "DELETE", url: "/v1/vaults/vlt_1/credentials/MY_KEY" });
  assert.deepEqual(f.secretRemoves, ["MY_KEY"]);
});
```

- [ ] **Step 2: Run to verify failure** — `npm test` → new file FAILS (201 body mismatch `{name}` vs `{name, type}`, no 409, single-key delete).

- [ ] **Step 3: Implement the console routes**

`control-plane/src/agents-api.ts` — add to the imports: `import { credentialSecretKeys, validateCredentialBody, validateMcpServers, mcpHostnames } from "./mcp.ts";` (the last two are used in Task 6). Replace the POST/DELETE credential routes (lines 300-317):

```ts
  app.post("/v1/vaults/:id/credentials", async (req, reply) => {
    const { id } = req.params as { id: string };
    const vault = await repo.getVault(ws(req), id);
    if (!vault) return reply.code(404).send({ error: "not found" });
    const cred = validateCredentialBody(req.body);
    if ("error" in cred) return reply.code(400).send({ error: cred.error });
    // Same name+type+server = rotate; a name reused for anything else is a conflict.
    const existing = await repo.getVaultCredential(id, cred.name);
    if (existing && (existing.type !== cred.type ||
        (existing.mcp_server_url ?? null) !== (cred.mcpServerUrl ?? null))) {
      return reply.code(409).send({ error: `credential "${cred.name}" already exists with a different type or server` });
    }
    for (const [key, value] of Object.entries(cred.secrets)) {
      await orchestrator.putVaultSecretKey(id, key, value);
    }
    await repo.addVaultCredential(id, cred.name, cred.type, cred.mcpServerUrl ?? null, cred.mcpServerName ?? null);
    return reply.code(201).send({ name: cred.name, type: cred.type });
  });
  app.delete("/v1/vaults/:id/credentials/:name", async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const vault = await repo.getVault(ws(req), id);
    if (!vault) return reply.code(404).send({ error: "not found" });
    const existing = await repo.getVaultCredential(id, name);
    // Remove every key the credential may own (unwritten keys no-op).
    for (const key of credentialSecretKeys(name, existing?.type ?? "environment_variable")) {
      await orchestrator.removeVaultSecretKey(id, key);
    }
    await repo.removeVaultCredential(id, name);
    return reply.code(204).send();
  });
```

- [ ] **Step 4: Mirror on the public API**

`control-plane/src/public-api.ts` — add the same import (`credentialSecretKeys`, `validateCredentialBody`, `validateMcpServers` from `./mcp.ts`) and replace `api.post("/vaults/:id/credentials")` and `api.delete("/vaults/:id/credentials/:name")` (lines 233-248) with the identical logic (adjust: `req.params.id` style, `ws(req)` from the api scope, no `/v1` prefix).

- [ ] **Step 5: Run tests** — `npm test` → new suite PASS, `public-api.test.ts` / `public-api-contract.test.ts` still PASS (legacy `{name, value}` bodies keep working; response gained a `type` field — if a contract test asserts the exact 201 body, update it to include `type: "environment_variable"`). `npx tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/src/public-api.ts control-plane/test/vault-credentials.test.ts
git commit -m "feat(cp): typed credential routes — per-type validation, rotate-vs-409, multi-key delete"
```

---

### Task 6: Agent mcpServers validation + env toggle + egress re-sync

**Files:**
- Modify: `control-plane/src/agents-api.ts:31` (Orchestrator iface), `:160-211` (agent/env routes), `:422-429` (versions route); `control-plane/src/orchestrator.ts:44-48,100-107` (`ensureEnvironmentPolicy`); `control-plane/src/public-api.ts` (agents create/versions ~382-411, environments routes)
- Test: `control-plane/test/vault-credentials.test.ts` (append route-level checks)

**Interfaces:**
- Consumes: `validateMcpServers`, `mcpHostnames` (Task 1); `repo.mcpServersForEnvironment`, env `allow_mcp_servers` (Task 2); `squidConf` 3-arg (Task 3).
- Produces: `Orchestrator.ensureEnvironmentPolicy(env: { id: string; allowedHosts?: string[]; allowPackageManagers?: boolean; mcpHosts?: string[] })`; environments API accepts `allowMcpServers`; agent create/version 400 on bad `mcpServers` and re-sync the affected environment(s).

- [ ] **Step 1: Extend the Orchestrator interface + implementation**

`agents-api.ts:31`:

```ts
  ensureEnvironmentPolicy(env: { id: string; allowedHosts?: string[]; allowPackageManagers?: boolean; mcpHosts?: string[] }): Promise<void>;
```

`orchestrator.ts` `ensureEnvironmentPolicy` (lines 44-48): pass the hosts through and include them in the restart annotation (lines 103-107) so an MCP-host-only change still rolls the proxy:

```ts
      const hosts: string[] = [...(env.allowedHosts ?? [])];
      const mcpHosts: string[] = [...(env.mcpHosts ?? [])];
      const conf = squidConf(hosts, env.allowPackageManagers ?? false, mcpHosts);
```

and in the 409 patch branch:

```ts
            body: { spec: { template: { metadata: { annotations: { "devproof.ai/conf": String(conf.length) + ":" + hosts.concat(mcpHosts).join(",") } } } } } },
```

- [ ] **Step 2: env-policy sync helper + environment routes**

In `agents-api.ts`, above the `app.post("/v1/environments", …)` route (line 169), add:

```ts
  // Environment Squid allowlist = allowed_hosts (+ MCP server hosts across the
  // latest versions of every agent bound to the env, when the toggle is on).
  // Called on env create/update AND agent create/version-save (spec 2026-07-13).
  const syncEnvPolicy = async (env: any) => {
    const mcpHosts = env.allow_mcp_servers
      ? mcpHostnames(await repo.mcpServersForEnvironment(env.id)) : [];
    await orchestrator.ensureEnvironmentPolicy({
      id: env.id, allowedHosts: env.allowed_hosts ?? [],
      allowPackageManagers: env.allow_package_managers ?? false, mcpHosts,
    });
  };
```

Update `POST /v1/environments` (lines 169-177): body type gains `allowMcpServers?: boolean`; pass it through:

```ts
    const env = await repo.createEnvironment(ws(req), b.name, b.allowPackageManagers ?? false,
      b.allowedHosts ?? [], (b.pod as PodConfig) ?? {}, b.allowMcpServers ?? false);
    await orchestrator.ensureEnvironmentPolicy(env); // fresh env: no agents yet → no mcpHosts
```

Update `PATCH /v1/environments/:id` (lines 179-192): body type gains `allowMcpServers?: boolean`, pass into `repo.updateEnvironment(...)` patch, and replace the trailing `ensureEnvironmentPolicy` call with `await syncEnvPolicy(row);`.

- [ ] **Step 3: agent routes — validate + re-sync**

`POST /v1/agents` (lines 160-167) — after the environment existence check add:

```ts
    const mcpErr = validateMcpServers(b.mcpServers);
    if (mcpErr) return reply.code(400).send({ error: mcpErr });
```

and after `repo.createAgent(...)`:

```ts
    // New MCP servers may need egress holes in the env's Squid allowlist.
    if (Object.keys(b.mcpServers ?? {}).length) {
      await syncEnvPolicy(await repo.getEnvironment(b.environmentId));
    }
```

`POST /v1/agents/:id/versions` (lines 422-429) — same validation guard; capture the previous env before saving, re-sync both when they differ:

```ts
    const mcpErr = validateMcpServers(b.mcpServers);
    if (mcpErr) return reply.code(400).send({ error: mcpErr });
    const prev = await repo.getAgentVersion(id);
    const version = await repo.newAgentVersion(ws(req), id, b);
    const env = await repo.getEnvironment(b.environmentId);
    if (env) await syncEnvPolicy(env);
    if (prev?.environment_id && prev.environment_id !== b.environmentId) {
      const prevEnv = await repo.getEnvironment(prev.environment_id);
      if (prevEnv) await syncEnvPolicy(prevEnv); // drop the moved agent's hosts
    }
    return reply.code(201).send({ id, version });
```

- [ ] **Step 4: Mirror validation on the public API**

`public-api.ts` agents create + versions routes (~382-411): add the same `validateMcpServers` 400 guard (import added in Task 5). Environment routes on the public API (if present — search `api.post("/environments"`): add `allowMcpServers` passthrough the same way.

- [ ] **Step 5: Append route tests**

Append to `control-plane/test/vault-credentials.test.ts` (extend `fixture()` with the extra fakes used here):

```ts
test("agent create 400s on malformed mcpServers and re-syncs env policy on success", async () => {
  const f = fixture();
  const policySyncs: any[] = [];
  Object.assign(f.repo, {
    async getEnvironment(id: string) {
      return { id, allowed_hosts: ["a.com"], allow_package_managers: false, allow_mcp_servers: true };
    },
    async createAgent(_ws: string, name: string, c: any) { return { id: "agent_1", name, version: 1, ...c }; },
    async mcpServersForEnvironment() { return [{ c7: { type: "http", url: "https://mcp.context7.com/mcp" } }]; },
  });
  (f.orchestrator as any).ensureEnvironmentPolicy = async (env: any) => { policySyncs.push(env); };
  const app = await server(f);

  const bad = await app.inject({ method: "POST", url: "/v1/agents",
    payload: { name: "a", model: "m", environmentId: "env_1", mcpServers: { c7: { url: "ftp://x" } } } });
  assert.equal(bad.statusCode, 400);

  const ok = await app.inject({ method: "POST", url: "/v1/agents",
    payload: { name: "a", model: "m", environmentId: "env_1",
      mcpServers: { c7: { type: "http", url: "https://mcp.context7.com/mcp" } } } });
  assert.equal(ok.statusCode, 201);
  assert.equal(policySyncs.length, 1);
  assert.deepEqual(policySyncs[0].mcpHosts, ["mcp.context7.com"]);
});
```

- [ ] **Step 6: Run tests** — `npm test` full suite PASS (existing `agents-api.test.ts` fakes lack `mcpServersForEnvironment`, but their agent-create payloads carry no `mcpServers`, so `syncEnvPolicy` is never reached — verify this holds). `npx tsc --noEmit` clean.

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/src/orchestrator.ts control-plane/src/public-api.ts control-plane/test/vault-credentials.test.ts
git commit -m "feat(cp): mcpServers validation + allow_mcp_servers egress wiring with re-sync triggers"
```

---

### Task 7: Launch-path header injection

**Files:**
- Modify: `control-plane/src/agents-api.ts:12-26` (startSession param type), `control-plane/src/session-actions.ts:85-88,128-133`, `control-plane/src/orchestrator.ts:296-302` (`buildTurnJob`)
- Test: `control-plane/test/orchestrator.test.ts` (append)

**Interfaces:**
- Consumes: `renderMcpServers` (Task 1), typed `repo.listVaultCredentials` (Task 2).
- Produces: launch payload gains `mcpServers?: Record<string, unknown>` (the RENDERED map — placeholders, no values); `buildTurnJob` prefers it over the raw `config.mcp_servers`. Parked `pending_launches` payloads carry it automatically (the whole launch object is stored).

- [ ] **Step 1: Write the failing test**

Append to `control-plane/test/orchestrator.test.ts` (match the file's existing `buildTurnJob` test fixture style — reuse its session-builder helper if one exists; otherwise build the minimal session object inline as below):

```ts
test("buildTurnJob renders the injected mcpServers map into DEVPROOF_AGENT_CONFIG", () => {
  const job: any = buildTurnJob({
    id: "sesn_mcp1", prompt: "p", workspace: "wrkspc_default",
    environment: { id: "env_1", pod: {} },
    config: { model: "m", system_prompt: "", tools: [], max_turns: 5,
              mcp_servers: { c7: { type: "http", url: "https://mcp.context7.com/mcp" } } } as any,
    mcpServers: { c7: { type: "http", url: "https://mcp.context7.com/mcp",
                        headers: { Authorization: "Bearer ${DEVPROOF_CRED_CONTEXT7_TOKEN}" } } },
  } as any);
  const env = job.spec.template.spec.containers[0].env
    .find((e: any) => e.name === "DEVPROOF_AGENT_CONFIG");
  const cfg = JSON.parse(env.value);
  assert.equal(cfg.mcp_servers.c7.headers.Authorization, "Bearer ${DEVPROOF_CRED_CONTEXT7_TOKEN}");
});

test("buildTurnJob falls back to config.mcp_servers when no rendered map is passed", () => {
  const job: any = buildTurnJob({
    id: "sesn_mcp2", prompt: "p", environment: { id: "env_1", pod: {} },
    config: { model: "m", system_prompt: "", tools: [], max_turns: 5,
              mcp_servers: { raw: { type: "http", url: "https://a.com/mcp" } } } as any,
  } as any);
  const env = job.spec.template.spec.containers[0].env
    .find((e: any) => e.name === "DEVPROOF_AGENT_CONFIG");
  assert.equal(JSON.parse(env.value).mcp_servers.raw.url, "https://a.com/mcp");
});
```

- [ ] **Step 2: Run to verify failure** — first test FAILS (no `headers` in the rendered config).

- [ ] **Step 3: Implement**

`agents-api.ts` `startSession` param (inside the object type, after `contextWindow`):

```ts
    /** mcp_servers with credential placeholders injected (renderMcpServers) —
     *  headers reference ${DEVPROOF_CRED_*} env vars, never values. */
    mcpServers?: Record<string, unknown>;
```

`orchestrator.ts` `buildTurnJob` line 301:

```ts
                    mcp_servers: (session as any).mcpServers ?? (session.config as any).mcp_servers ?? {},
```

`session-actions.ts` — in `createSessionAction`, after the `skills` lookup (line 84):

```ts
  // Vault credentials matched to the agent's MCP servers by URL → placeholder
  // Authorization headers (values stay in the vault Secret / pod env).
  const credentials = (session.config as any).vault_id
    ? await repo.listVaultCredentials((session.config as any).vault_id) : [];
  const mcpServers = renderMcpServers((session.config as any).mcp_servers ?? {}, credentials);
```

and add `mcpServers,` to the `gatedLaunch` payload object (line 85-88). Mirror in `sendMessageAction` after line 127 using `turn.config`:

```ts
  const credentials = (turn.config as any).vault_id
    ? await repo.listVaultCredentials((turn.config as any).vault_id) : [];
  const mcpServers = renderMcpServers((turn.config as any).mcp_servers ?? {}, credentials);
```

with `mcpServers,` added to its `gatedLaunch` payload (lines 128-133). Import at top: `import { renderMcpServers } from "./mcp.ts";`

- [ ] **Step 4: Run tests** — `npm test` full suite PASS. Note: `agents-api.test.ts` / `public-api.test.ts` fake repos lack `listVaultCredentials`, but their session configs carry no `vault_id`, so the guard short-circuits — if any test DOES set `vault_id`, add `async listVaultCredentials() { return []; }` to that fake. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/src/session-actions.ts control-plane/src/orchestrator.ts control-plane/test/orchestrator.test.ts
git commit -m "feat(cp): inject credential placeholder headers into launched mcp_servers"
```

---

### Task 8: Runner `${VAR}` expansion (image dev27)

**Files:**
- Modify: `session-runner/runner.py:334-349` (options), new helper above `main()`
- Test: `session-runner/test_runner.py` (append)

**Interfaces:**
- Consumes: pod env vars from the vault `envFrom` (existing) + placeholder headers from Task 7.
- Produces: `expand_mcp_headers(servers: dict, env=None) -> dict` — expands `${VAR}` in header values from the environment; drops headers with unset vars (stderr warning); everything else passes through untouched.

- [ ] **Step 1: Write the failing tests**

Append to `session-runner/test_runner.py`:

```python
class ExpandMcpHeadersTest(unittest.TestCase):
    def test_expands_placeholder_from_env(self):
        servers = {"c7": {"type": "http", "url": "https://x/mcp",
                          "headers": {"Authorization": "Bearer ${DEVPROOF_CRED_C7_TOKEN}"}}}
        out = runner.expand_mcp_headers(servers, env={"DEVPROOF_CRED_C7_TOKEN": "tok"})
        self.assertEqual(out["c7"]["headers"]["Authorization"], "Bearer tok")
        self.assertEqual(out["c7"]["url"], "https://x/mcp")

    def test_drops_header_with_unset_variable(self):
        servers = {"c7": {"url": "https://x/mcp",
                          "headers": {"Authorization": "Bearer ${MISSING_VAR}", "X-Ok": "plain"}}}
        out = runner.expand_mcp_headers(servers, env={})
        self.assertNotIn("Authorization", out["c7"]["headers"])
        self.assertEqual(out["c7"]["headers"]["X-Ok"], "plain")

    def test_untouched_without_headers_and_original_not_mutated(self):
        servers = {"a": {"url": "https://a/mcp"}, "b": "weird-non-dict"}
        out = runner.expand_mcp_headers(servers, env={})
        self.assertEqual(out, servers)
        withph = {"c": {"headers": {"A": "${V}"}}}
        runner.expand_mcp_headers(withph, env={"V": "x"})
        self.assertEqual(withph["c"]["headers"]["A"], "${V}")  # input dict untouched

    def test_empty_and_none(self):
        self.assertEqual(runner.expand_mcp_headers({}, env={}), {})
        self.assertEqual(runner.expand_mcp_headers(None, env={}), {})
```

- [ ] **Step 2: Run to verify failure**

From `session-runner/`:
```
docker run --rm --entrypoint python -v .:/src -w /src devproof/session-runner:dev26 -m unittest test_runner -v
```
Expected: FAIL — `AttributeError: module 'runner' has no attribute 'expand_mcp_headers'`

- [ ] **Step 3: Implement**

In `session-runner/runner.py`, add `import re` to the imports (top of file), and above `async def main()`:

```python
_PLACEHOLDER = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def expand_mcp_headers(servers: dict | None, env=None) -> dict:
    """Expand ${VAR} placeholders in mcp_servers[*].headers values from the
    pod environment (vault envFrom). The CP injects placeholder Authorization
    headers so secret values never ride the Job spec. A header whose variable
    is unset is DROPPED (never send a literal ${...} upstream)."""
    env = os.environ if env is None else env
    out = {}
    for name, cfg in (servers or {}).items():
        if not (isinstance(cfg, dict) and isinstance(cfg.get("headers"), dict)):
            out[name] = cfg
            continue
        headers = {}
        for key, value in cfg["headers"].items():
            if isinstance(value, str):
                missing = [v for v in _PLACEHOLDER.findall(value) if v not in env]
                if missing:
                    print(f"runner: dropping MCP header {name}.{key} — unset: {', '.join(missing)}", flush=True)
                    continue
                value = _PLACEHOLDER.sub(lambda m: env[m.group(1)], value)
            headers[key] = value
        out[name] = {**cfg, "headers": headers}
    return out
```

Then in `options()` (line 345) change:

```python
            mcp_servers={} if no_tools else expand_mcp_headers(CONFIG.get("mcp_servers") or {}),
```

- [ ] **Step 4: Build the dev27 image and run the tests inside it**

From the repo root:
```
docker build -t devproof/session-runner:dev27 session-runner
```
From `session-runner/`:
```
docker run --rm --entrypoint python -v .:/src -w /src devproof/session-runner:dev27 -m unittest test_runner -v
```
Expected: ALL tests PASS (including the pre-existing FailureDetail tests).

- [ ] **Step 5: Commit**

```bash
git add session-runner/runner.py session-runner/test_runner.py
git commit -m "feat(runner): expand credential placeholders in MCP headers (image dev27)"
```

(The CP is started with `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev27` from now on; CLAUDE.md tag bump lands in Task 11.)

---

### Task 9: Console — credential dialog + MCP picker + vault detail

**Files:**
- Create: `console/app/lib/mcp-picker.tsx`
- Rewrite: `console/app/vaults/[id]/credentials.tsx`
- Modify: `console/app/vaults/[id]/page.tsx`, `console/app/globals.css` (two small classes)

**Interfaces:**
- Consumes: `GET /v1/mcp-registry` (Task 4), typed credential POST (Task 5), typed rows from `GET /v1/vaults/:id` (Task 2).
- Produces: `McpServerPicker({ value, onChange, disabled })` with `McpServerPick { name: string; url: string }` (also used by Task 10); `CredentialModal({ vaultId, existing?, onClose })`; `AddCredentialButton({ vaultId })`; `RotateCredentialName({ vaultId, cred })`.

- [ ] **Step 1: Shared picker component**

Create `console/app/lib/mcp-picker.tsx`:

```tsx
"use client";
// Registry-backed MCP server picker (spec 2026-07-13): search the bundled
// registry or enter a custom URL. Used by the credential dialog + agent form.
import { useEffect, useState } from "react";
import { apiGet } from "./client";

export interface McpServerPick { name: string; url: string }
interface RegistryEntry { name: string; label: string; url: string; description?: string; auth: string }

export function McpServerPicker({ value, onChange, disabled }: {
  value: McpServerPick | null; onChange: (v: McpServerPick | null) => void; disabled?: boolean;
}) {
  const [registry, setRegistry] = useState<RegistryEntry[]>([]);
  const [q, setQ] = useState("");
  const [custom, setCustom] = useState(false);
  const [customUrl, setCustomUrl] = useState("");
  useEffect(() => {
    apiGet<{ servers: RegistryEntry[] }>("/v1/mcp-registry")
      .then((r) => setRegistry(r.servers)).catch(() => setRegistry([]));
  }, []);
  if (value) {
    return (
      <span style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
        <span style={{ flex: 1 }}><strong>{value.name}</strong>{" "}
          <span className="muted" style={{ fontSize: 12 }}>{value.url}</span></span>
        {!disabled && <button className="iconbtn danger" title="Clear server" aria-label="Clear server"
          onClick={() => onChange(null)}>✕</button>}
      </span>
    );
  }
  if (custom) {
    return (
      <span style={{ display: "flex", gap: 8, flex: 1 }}>
        <input style={{ flex: 1 }} autoFocus placeholder="https://mcp.example.com/mcp" value={customUrl}
          onChange={(e) => setCustomUrl(e.target.value)} />
        <button className="ghost" disabled={!/^https?:\/\/.+/.test(customUrl)} onClick={() => {
          try { onChange({ name: new URL(customUrl).hostname, url: customUrl }); } catch { /* disabled */ }
        }}>Use</button>
        <button className="ghost" onClick={() => setCustom(false)}>Back</button>
      </span>
    );
  }
  const hits = registry.filter((r) =>
    !q.trim() || `${r.label} ${r.name} ${r.url}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <span style={{ flex: 1 }}>
      <input style={{ width: "100%" }} placeholder="Search the MCP registry or pick Custom…" value={q}
        onChange={(e) => setQ(e.target.value)} />
      <span className="mcp-options">
        {hits.map((r) => (
          <button key={r.name} type="button" className="mcp-option"
            onClick={() => onChange({ name: r.name, url: r.url })}>
            <strong>{r.label}</strong> <span className="muted">{r.url}</span>
            {r.description && <span className="muted" style={{ display: "block", fontSize: 12 }}>{r.description}</span>}
          </button>
        ))}
        <button type="button" className="mcp-option" onClick={() => setCustom(true)}>
          <strong>Custom server…</strong> <span className="muted">enter a URL</span>
        </button>
      </span>
    </span>
  );
}
```

Append to `console/app/globals.css` (adjust `var(--…)` token names to the ones actually defined in this file's `:root` — check before pasting):

```css
/* MCP server picker + shared-credential warning (spec 2026-07-13) */
.mcp-options { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; max-height: 220px; overflow-y: auto; }
.mcp-option { text-align: left; background: var(--panel); border: 1px solid var(--line); padding: 6px 10px; font-size: 13px; cursor: pointer; }
.mcp-option:hover { border-color: var(--accent); }
.warnbox { border: 1px solid #b58900; background: rgba(181, 137, 0, 0.10); padding: 10px 12px; font-size: 13px; margin-top: 10px; border-radius: 3px; }
```

- [ ] **Step 2: Rewrite the credential dialog**

Replace `console/app/vaults/[id]/credentials.tsx` entirely:

```tsx
"use client";
// Typed add/rotate credential dialog (spec 2026-07-13, mirrors the Anthropic
// mockups): Environment variable / Bearer token / MCP OAuth (token storage —
// no Connect flow yet). Values are write-only.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal, Field, submitJson } from "../../lib/modal";
import { McpServerPicker, type McpServerPick } from "../../lib/mcp-picker";

const TYPES = [
  { id: "environment_variable", label: "Environment variable" },
  { id: "bearer_token", label: "Bearer token" },
  { id: "mcp_oauth", label: "MCP OAuth" },
];

export interface CredRow { name: string; type: string; mcp_server_url?: string | null; mcp_server_name?: string | null }

function CredentialModal({ vaultId, existing, onClose }: {
  vaultId: string; existing?: CredRow; onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState(existing?.type ?? "environment_variable");
  const [name, setName] = useState(existing?.name ?? "");
  const [server, setServer] = useState<McpServerPick | null>(existing?.mcp_server_url
    ? { name: existing.mcp_server_name ?? existing.name, url: existing.mcp_server_url } : null);
  const [value, setValue] = useState("");        // env value | bearer token | oauth access token
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [ack, setAck] = useState(false);
  const locked = !!existing;                     // rotate: name/type/server frozen
  const isMcp = type !== "environment_variable";
  const ready = ack && !!value &&
    (isMcp ? !!server : /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));

  const submit = async () => {
    const body: any = { type };
    if (isMcp) {
      body.mcpServerUrl = server!.url;
      body.mcpServerName = server!.name;
      if (name.trim()) body.name = name.trim();
      if (type === "bearer_token") body.token = value; else body.accessToken = value;
      if (type === "mcp_oauth" && clientId.trim()) body.clientId = clientId.trim();
      if (type === "mcp_oauth" && clientSecret) body.clientSecret = clientSecret;
    } else {
      body.name = name.trim();
      body.value = value;
    }
    setBusy(true); setError(null);
    const err = await submitJson("POST", `/v1/vaults/${vaultId}/credentials`, body);
    setBusy(false);
    if (err) setError(err); else { onClose(); router.refresh(); }
  };

  return (
    <Modal title={existing ? `Rotate credential — ${existing.name}` : "Add credential"} width="md"
      subtitle="Add a credential to this vault for agents to use. Values are write-only."
      onClose={onClose} busy={busy} error={error}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || !ready} onClick={submit}>
          {busy ? "Saving…" : existing ? "Rotate credential" : "Add credential"}
        </button>
      </>}>
      <Field label="Type" required>
        <select value={type} disabled={locked} onChange={(e) => { setType(e.target.value); setValue(""); }}>
          {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </Field>
      <Field label={isMcp ? "Name" : "Variable name"} required={!isMcp}
             hint={isMcp ? "optional — derived from the server when empty" : "injected into session pods under this name"}>
        <input value={name} disabled={locked} placeholder={isMcp ? "context7" : "MY_API_KEY"}
               onChange={(e) => setName(e.target.value)} />
      </Field>
      {isMcp && (
        <Field label="MCP server" required>
          <McpServerPicker value={server} onChange={setServer} disabled={locked} />
        </Field>
      )}
      <Field label={type === "mcp_oauth" ? "Access token" : type === "bearer_token" ? "Token" : "Value"} required>
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      {type === "mcp_oauth" && (
        <Field label="OAuth client" hint="optional — stored for the future Connect flow; empty on rotate = keep existing">
          <input placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} />
          <input type="password" placeholder="Client secret" value={clientSecret}
                 onChange={(e) => setClientSecret(e.target.value)} />
        </Field>
      )}
      <div className="warnbox">
        This credential will be shared across this workspace. Anyone with API access can use it in an
        agent session to access the associated service — including reading data and taking actions on
        behalf of the credential owner.
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, marginTop: 10 }}>
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>I acknowledge this credential is shared and that I am responsible for its storage and use.</span>
      </label>
    </Modal>
  );
}

export function AddCredentialButton({ vaultId }: { vaultId: string }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}>+ Add credential</button>
    {open && <CredentialModal vaultId={vaultId} onClose={() => setOpen(false)} />}
  </>);
}

/** Clicking a credential's name opens rotate (name/type/server locked). */
export function RotateCredentialName({ vaultId, cred }: { vaultId: string; cred: CredRow }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button className="namebtn" style={{ fontFamily: "var(--font-mono)" }} title="Rotate credential"
            onClick={() => setOpen(true)}>{cred.name}</button>
    {open && <CredentialModal vaultId={vaultId} existing={cred} onClose={() => setOpen(false)} />}
  </>);
}
```

- [ ] **Step 3: Vault detail page — typed table**

In `console/app/vaults/[id]/page.tsx`: change the import to `import { AddCredentialButton, RotateCredentialName } from "./credentials";`, type `credentials` as `{ name: string; type: string; mcp_server_url?: string | null; mcp_server_name?: string | null; created_at: string }[]`, move the add button into the `pagehead` div (next to Delete vault), and replace the table with:

```tsx
      <div className="tablewrap" style={{ marginTop: 16 }}><table>
        <thead><tr><th>Credential</th><th>Type</th><th>MCP server</th><th>Added</th><th></th></tr></thead>
        <tbody>
          {credentials.map((c) => (
            <tr key={c.name}>
              <td><RotateCredentialName vaultId={vault.id} cred={c} /></td>
              <td>{c.type === "mcp_oauth" ? "MCP OAuth" : c.type === "bearer_token" ? "Bearer token" : "Env var"}</td>
              <td>{c.mcp_server_url ? <span className="muted">{c.mcp_server_url}</span> : "—"}</td>
              <td>{new Date(c.created_at).toLocaleString()}</td>
              <td><DeleteButton path={`/v1/vaults/${vault.id}/credentials/${encodeURIComponent(c.name)}`}
                    confirmText={`Remove credential "${c.name}"?`} label="Remove" /></td>
            </tr>
          ))}
          {credentials.length === 0 && <tr><td colSpan={5} className="empty">No credentials yet — add one with the button above.</td></tr>}
        </tbody>
      </table></div>
```

Also update the `sub` paragraph: "Typed credentials injected into every session that uses this vault — environment variables directly, MCP credentials as Authorization headers on matching servers. Values are write-only; click a name to rotate."

- [ ] **Step 4: Build + verify**

`cd console && npx next build` — clean. Restart `next start`, open `/vaults/<id>`: add an env-var credential, a bearer credential against Context7 (registry picker appears, acknowledge gate blocks until checked), rotate by clicking the name, remove one.

- [ ] **Step 5: Commit**

```bash
git add console/app/lib/mcp-picker.tsx console/app/vaults/[id]/credentials.tsx console/app/vaults/[id]/page.tsx console/app/globals.css
git commit -m "feat(console): typed credential dialog with MCP registry picker"
```

---

### Task 10: Console — environment toggle + agent MCP editor

**Files:**
- Modify: `console/app/environments/create.tsx`, `console/app/agents/agent-form.tsx`, `console/app/agents/[id]/tabs.tsx:52-57`

**Interfaces:**
- Consumes: `McpServerPicker` (Task 9), `allowMcpServers` env API field (Task 6), agent `mcpServers` body field (existing `AgentConfig`).
- Produces: environment form "Allow MCP servers" checkbox; agent form MCP server rows saved as `{name: {type: "http", url}}` (raw-API extras like pre-set `headers` preserved on round-trip).

- [ ] **Step 1: Environment toggle**

`console/app/environments/create.tsx` — in the form state add `mcpAllowed: env?.allow_mcp_servers ?? false,` (after `pkg`); in `submit`'s `body` add `allowMcpServers: form.mcpAllowed,`; after the "Packages" Field add:

```tsx
      <Field label="MCP servers">
        <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={form.mcpAllowed} onChange={(e) => set("mcpAllowed", e.target.checked)} />
          Allow MCP servers (auto-allows the configured MCP hosts of agents using this environment)
        </label>
      </Field>
```

- [ ] **Step 2: Agent form MCP editor**

`console/app/agents/agent-form.tsx`:

Add the import: `import { McpServerPicker, type McpServerPick } from "../lib/mcp-picker";`

In the `useState` initializer add (after `skillIds`):

```tsx
    // {name, url, cfg}: cfg keeps raw-API extras (headers etc.) intact on save.
    mcp: Object.entries((initial?.mcp_servers as Record<string, any>) ?? {})
      .map(([name, cfg]) => ({ name, url: cfg?.url ?? "", cfg })),
```

Add local state below `set`: `const [pickerOpen, setPickerOpen] = useState(false);`

In `submit`'s `body` add:

```tsx
      mcpServers: Object.fromEntries(f.mcp
        .filter((r: any) => r.name && r.url)
        .map((r: any) => [r.name, { ...(r.cfg ?? {}), type: r.cfg?.type ?? "http", url: r.url }])),
```

After the "Vault" Field add:

```tsx
      <Field label="MCP servers" stack
             hint="remote MCP servers the agent can call; attach a matching vault credential to authenticate">
        <div className="kvrows">
          {f.mcp.map((r: any, i: number) => (
            <div className="kvrow" key={r.name}>
              <span style={{ flex: 1 }}><strong>{r.name}</strong>{" "}
                <span className="muted" style={{ fontSize: 12 }}>{r.url}</span></span>
              <button className="iconbtn danger" title="Remove server" aria-label="Remove server"
                onClick={() => set("mcp", f.mcp.filter((_: any, j: number) => j !== i))}>✕</button>
            </div>
          ))}
          {pickerOpen
            ? <McpServerPicker value={null} onChange={(v: McpServerPick | null) => {
                if (v && !f.mcp.some((r: any) => r.name === v.name)) set("mcp", [...f.mcp, { name: v.name, url: v.url }]);
                setPickerOpen(false);
              }} />
            : <div><button className="ghost" onClick={() => setPickerOpen(true)}>+ Add MCP server</button></div>}
          {f.mcp.length > 0 && (() => {
            const env = environments.find((x) => x.id === f.environmentId);
            return env && !env.allow_mcp_servers
              ? <span className="muted" style={{ color: "#b58900" }}>
                  ⚠ this environment blocks MCP egress — enable “Allow MCP servers” on it</span>
              : null;
          })()}
        </div>
      </Field>
```

- [ ] **Step 3: Agent detail chips show the URL**

`console/app/agents/[id]/tabs.tsx` — replace line 17:

```tsx
  const mcpNames = v.mcp_servers ? Object.keys(v.mcp_servers) : [];
```

with:

```tsx
  const mcpEntries: [string, any][] = v.mcp_servers ? Object.entries(v.mcp_servers) : [];
```

and replace the MCP card (lines 52-57):

```tsx
          {mcpEntries.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <h3>MCP servers ({mcpEntries.length})</h3>
              <div>{mcpEntries.map(([m, cfg]) => (
                <span className="chip" key={m} style={{ marginRight: 6 }} title={cfg?.url}>
                  {m} <span className="muted">{cfg?.url}</span>
                </span>
              ))}</div>
            </div>
          )}
```

- [ ] **Step 4: Build + verify**

`cd console && npx next build` — clean. Restart, then: edit an environment → toggle appears and persists; create/edit an agent → add Context7 from the picker, warning shows when the env toggle is off, save, detail tab shows `context7 https://mcp.context7.com/mcp`.

- [ ] **Step 5: Commit**

```bash
git add console/app/environments/create.tsx console/app/agents/agent-form.tsx "console/app/agents/[id]/tabs.tsx"
git commit -m "feat(console): env allow-MCP toggle + agent MCP server editor"
```

---

### Task 11: Docs

**Files:**
- Modify: `CLAUDE.md` (project), `docs/concept/platform-alignment-and-scale.md` (§3 table rows for vaults/MCP)

- [ ] **Step 1: CLAUDE.md**

- Bump the runner tag in the "Session runner image" bullet: `dev26` → `dev27`, appending: "dev27 expands `${VAR}` placeholders in MCP headers from the pod env".
- Add a conventions bullet after the Egress bullet:

```
- **Vault credentials & MCP (spec 2026-07-13):** `vault_credentials` are typed (`environment_variable|bearer_token|mcp_oauth`, migration 028); values live ONLY in the vault K8s Secret (bearer/oauth under derived `DEVPROOF_CRED_<NAME>_*` keys). MCP credentials bind to a server URL; at launch the CP injects `Authorization: Bearer ${DEVPROOF_CRED_<NAME>_TOKEN}` PLACEHOLDERS into matching `mcp_servers` (pure `renderMcpServers`, `src/mcp.ts`) and the runner expands them from the pod env — secrets never ride the Job spec. Same name+type+server = rotate; different = 409. MCP registry is the bundled `catalog/mcp-servers.yaml` (`GET /v1/mcp-registry`). Egress: env `allow_mcp_servers` (mirrors Anthropic) adds the MCP hosts of the env's agents (latest versions) to Squid — re-synced on env save AND agent create/version save; deleted agents' hosts linger until the next sync. MCP OAuth = token storage only (client id/secret stored inert; no Connect flow yet).
```

- [ ] **Step 2: Alignment doc**

In `docs/concept/platform-alignment-and-scale.md` §3, update the **Credential vaults** row's "Devproof today" cell: typed credentials (`mcp_oauth`/`static_bearer`≈`bearer_token`/`environment_variable`) matched to MCP servers by URL — attachment still agent-level (deviation unchanged). Update the **MCP servers** row: console editor + bundled registry + env `allow_mcp_servers` egress toggle shipped; still no `mcp_toolset`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/concept/platform-alignment-and-scale.md
git commit -m "docs: vault/MCP conventions + alignment rows (dev27)"
```

---

### Task 12: Full-suite + live E2E acceptance (Context7)

No new files — the verification gate. Prereqs: docker-desktop cluster up, gateway on `localhost:14000`, a deployed model (e.g. `qwen05b-dp`).

- [ ] **Step 1: Full backend + console gates**

From `control-plane/`: `npm test` (all suites PASS) and `npx tsc --noEmit` (clean).
From `console/`: `npx next build` (clean).

- [ ] **Step 2: Restart both processes**

Restart the CP with the new tag (per CLAUDE.md run block, now `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev27`) and the console (`npx next build` already done → `npx next start -p 7090`). Boot re-runs migrations — confirm the CP log shows no migrate errors (028 applied).

- [ ] **Step 3: All pages 200**

Open (or curl) `/`, `/agents`, `/sessions`, `/vaults`, `/environments`, `/deployments`, `/catalog`, `/pools`, `/usage`, `/api-keys`, `/skills`, `/memory`, `/files` — all 200.

- [ ] **Step 4: The Context7 flow (closes TODO "Credential vaults testing → MCP → context7")**

1. Vaults → create vault `mcp-test` → Add credential → type **Bearer token** → pick **Context7** from the registry → paste a Context7 API key (or any string — Context7 currently accepts unauthenticated calls rate-limited; the header must simply arrive) → acknowledge → Add.
2. Environments → edit the test env → check **Allow MCP servers** → save.
3. Agents → create agent `mcp-probe` (model = a warm deployment, environment = the env above, vault = `mcp-test`) → **+ Add MCP server** → Context7 → save.
4. Verify egress: `kubectl -n devproof-agents get cm egress-env-<id> -o yaml` → `squid.conf` contains `.mcp.context7.com`.
5. Start a session with a prompt like: *"Use the context7 MCP tools to resolve the library id for 'fastify' and tell me what you get."*
6. Expected: the session trace shows an `mcp__context7__*` tool call with a real result (not a connection error). Verify the placeholder never leaked: `kubectl -n devproof-agents get job <sesn>-t0 -o yaml | Select-String DEVPROOF_CRED` shows the `${...}` placeholder inside `DEVPROOF_AGENT_CONFIG` — never a token value.
7. Negative check: uncheck **Allow MCP servers** on the env, start a new session with the same prompt → the MCP call fails (proxy 403 / connection refused), session still completes or fails gracefully.

- [ ] **Step 5: Commit any fixups discovered, then report**

Report results with the session ids used, per the verify-before-done rule.
