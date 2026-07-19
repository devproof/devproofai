# Cost Tracking & Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real-cost tracking (infra + external tokens) and billing (charged to consumers) across settings, prices, metering, deployment stats, usage page, dashboard, and a live session cost chip — per spec `docs/superpowers/specs/2026-07-14-cost-tracking-design.md`.

**Architecture:** A Postgres BEFORE-INSERT trigger stamps token costs onto `gateway_usage` at usage time; a 60s control-plane sampler accrues pod-time costs into a `cost_entries` ledger; prices live in a uniform `resource_prices` table; settings in a singleton `app_settings` row. Console surfaces read costs through extended usage/stats endpoints and render via one shared currency formatter.

**Tech Stack:** Fastify + node-postgres (control-plane, TS via tsx), plpgsql triggers, Next.js app router console, Node test runner (`npm test` against live dev Postgres — tests self-skip when unreachable).

## Global Constraints

- Migrations re-run EVERY boot (`migrate()`, no tracking table) — every SQL file must be idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`, `ON CONFLICT DO NOTHING`, `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`).
- NULL cost = "not tracked at the time"; 0 = tracked but free. Never backfill; never recompute history (usage-time stamping).
- Time normalization: minute=60s, hour=3600, day=86400, month=2 592 000 (30d), year=31 536 000 (365d). Token prices = currency per 1 000 000 tokens (`inPerM`/`outPerM`).
- Gap cap: sampler accrues at most 120s across a watermark gap (never fabricate outage costs).
- Currency is a display label only (ISO code in settings; symbol via `console/app/lib/currency.ts`). No conversion, no currency in data.
- Every cost toggle gates BOTH accrual and UI visibility. Master `enabled` off ⇒ no accrual anywhere, no cost UI anywhere.
- api-key/agent-filtered cost views show token costs ONLY (time entries are not key-attributable) with a "tokens only" hint.
- Console rules: shared `Modal`/`Field`/`submitJson` from `app/lib/modal.tsx`; no browser dialogs; no transparent text buttons; console runs as production build (`npx next build && npx next start -p 7090`).
- Stop the control plane before `npm test` (shared dev Postgres contention).
- pg returns NUMERIC as strings — wrap in `Number()` in repo mappers.
- `/v1/settings` and `/v1/prices` are global routes; the workspace guard's positive prefix list (`workspace-guard.ts:50`) does not cover them — do NOT add them to `CONSOLE_PREFIXES`.

## Task Overview

1. Migration 030 (all cost schema) + settings module + GET/PUT `/v1/settings`
2. Prices repo + GET/PUT `/v1/prices` + delete-route cleanup
3. Migration 031 stamping trigger + `sessions.billed_cost` accumulation + SSE frame
4. Pure accrual math: `ratePerSecond`, `computeAccruals` (`src/costs.ts`)
5. Cost sampler + orchestrator `sessionJobInfo` + turn-end settle + wiring
6. Console: currency helper + Settings page + nav entry
7. Console: session cost chip (live billed cost)
8. Console: price fields in pool / deploy / environment dialogs
9. Deployment stats endpoint costs + Stats tab boxes + cost chart
10. Usage queries: costs, all-workspaces, session usage rebuild, summary endpoint
11. Usage page rebuild (shared filter bar, cost boxes, tables, new bar chart)
12. Dashboard usage panel
13. Final verification (build, restart, live flow)

---

### Task 1: Cost schema + settings API

**Files:**
- Create: `control-plane/sql/030_cost_tracking.sql`
- Create: `control-plane/src/costs.ts` (settings types/defaults/validation only — accrual math arrives in Task 4)
- Modify: `control-plane/src/repo.ts` (add `getCostSettings`, `putCostSettings` at the end of the class, before the closing `}` at repo.ts:1081)
- Modify: `control-plane/src/agents-api.ts` (add routes next to `GET /v1/usage` at agents-api.ts:722)
- Test: `control-plane/test/costs-settings.test.ts`

**Interfaces:**
- Produces: table `app_settings(id,data,updated_at)`; tables `resource_prices`, `cost_entries`; columns `gateway_usage.real_cost/billed_cost`, `sessions.billed_cost`.
- Produces: `CostSettings` type, `DEFAULT_COST_SETTINGS`, `normalizeCostSettings(raw: unknown): CostSettings`, `validateCostSettings(raw: unknown): string | null` (all from `src/costs.ts`).
- Produces: `repo.getCostSettings(): Promise<CostSettings>`, `repo.putCostSettings(c: CostSettings): Promise<void>`; routes `GET /v1/settings` → `{ costs: CostSettings }`, `PUT /v1/settings` body `{ costs: CostSettings }`.

- [ ] **Step 1: Write the migration**

`control-plane/sql/030_cost_tracking.sql`:

```sql
-- Cost tracking & billing (spec 2026-07-14). Two ledgers: real (what infra +
-- external tokens cost the operator) and billed (what consumers are charged).
-- Costs are stamped/accrued with the price valid at usage time — history is
-- immutable; price edits only affect future usage. NULL cost = tracking was
-- off; 0 = tracked but free. Idempotent: migrate() re-runs every file.

CREATE TABLE IF NOT EXISTS app_settings (
  id         TEXT PRIMARY KEY CHECK (id = 'global'),
  data       JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app_settings (id) VALUES ('global') ON CONFLICT (id) DO NOTHING;

-- One price row per resource; kind: pool | deployment (local, ref=name) |
-- external (ref=row id) | environment (ref=row id). prices JSONB holds
-- optional sub-objects: real.podTime {amount,per}, real.tokens {inPerM,outPerM},
-- billing.podTime, billing.tokens, billing.sessionTime. CP delete routes
-- remove the row with the resource (kubectl-bypass leaves an inert row).
CREATE TABLE IF NOT EXISTS resource_prices (
  kind       TEXT NOT NULL CHECK (kind IN ('pool','deployment','external','environment')),
  ref        TEXT NOT NULL,
  prices     JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref)
);

ALTER TABLE gateway_usage ADD COLUMN IF NOT EXISTS real_cost   NUMERIC;
ALTER TABLE gateway_usage ADD COLUMN IF NOT EXISTS billed_cost NUMERIC;
ALTER TABLE sessions      ADD COLUMN IF NOT EXISTS billed_cost NUMERIC NOT NULL DEFAULT 0;

-- Time-cost ledger, written by the CP sampler (60s grain; exact-to-the-second
-- totals via the turn-end settle). kinds: pool_pod (real), deployment_time
-- (billed), env_pod (real), session_time (billed).
CREATE TABLE IF NOT EXISTS cost_entries (
  id             BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind           TEXT NOT NULL CHECK (kind IN ('pool_pod','deployment_time','env_pod','session_time')),
  deployment     TEXT,
  pool           TEXT,
  environment_id TEXT,
  session_id     TEXT,
  workspace_id   TEXT,
  seconds        NUMERIC NOT NULL,
  replicas       INT,
  real_cost      NUMERIC,
  billed_cost    NUMERIC
);
CREATE INDEX IF NOT EXISTS cost_entries_kind_ts   ON cost_entries (kind, ts);
CREATE INDEX IF NOT EXISTS cost_entries_deploy_ts ON cost_entries (deployment, ts);
CREATE INDEX IF NOT EXISTS cost_entries_session   ON cost_entries (session_id);
```

- [ ] **Step 2: Write the settings module**

`control-plane/src/costs.ts`:

```ts
// Cost tracking & billing (spec 2026-07-14): settings shape + validation.
// Accrual math (ratePerSecond/computeAccruals) lives here too from Task 4 on.

export interface CostSettings {
  enabled: boolean;
  currency: string;
  trackPoolCosts: boolean;
  trackExternalCosts: boolean;
  trackEnvCosts: boolean;
  billing: {
    enabled: boolean;
    showSessionCosts: boolean;
    billSessionTime: boolean;
    billExternalTokens: boolean;
    billLocalTokens: boolean;
    billDeploymentTime: boolean;
  };
}

export const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY"] as const;

export const DEFAULT_COST_SETTINGS: CostSettings = {
  enabled: false,
  currency: "EUR",
  trackPoolCosts: false,
  trackExternalCosts: false,
  trackEnvCosts: false,
  billing: {
    enabled: false,
    showSessionCosts: false,
    billSessionTime: false,
    billExternalTokens: false,
    billLocalTokens: false,
    billDeploymentTime: false,
  },
};

const asBool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);

/** Merge a stored/submitted partial onto defaults — absent keys read as off. */
export function normalizeCostSettings(raw: unknown): CostSettings {
  const r = (raw ?? {}) as any;
  const b = (r.billing ?? {}) as any;
  const d = DEFAULT_COST_SETTINGS;
  return {
    enabled: asBool(r.enabled, d.enabled),
    currency: CURRENCIES.includes(r.currency) ? r.currency : d.currency,
    trackPoolCosts: asBool(r.trackPoolCosts, d.trackPoolCosts),
    trackExternalCosts: asBool(r.trackExternalCosts, d.trackExternalCosts),
    trackEnvCosts: asBool(r.trackEnvCosts, d.trackEnvCosts),
    billing: {
      enabled: asBool(b.enabled, d.billing.enabled),
      showSessionCosts: asBool(b.showSessionCosts, d.billing.showSessionCosts),
      billSessionTime: asBool(b.billSessionTime, d.billing.billSessionTime),
      billExternalTokens: asBool(b.billExternalTokens, d.billing.billExternalTokens),
      billLocalTokens: asBool(b.billLocalTokens, d.billing.billLocalTokens),
      billDeploymentTime: asBool(b.billDeploymentTime, d.billing.billDeploymentTime),
    },
  };
}

/** PUT validation: error string or null. Strict on types, tolerant on absence. */
export function validateCostSettings(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "costs must be an object";
  const r = raw as any;
  if (r.currency !== undefined && !CURRENCIES.includes(r.currency))
    return `currency must be one of ${CURRENCIES.join(", ")}`;
  const boolKeys = ["enabled", "trackPoolCosts", "trackExternalCosts", "trackEnvCosts"];
  for (const k of boolKeys) if (r[k] !== undefined && typeof r[k] !== "boolean") return `${k} must be a boolean`;
  if (r.billing !== undefined) {
    if (r.billing === null || typeof r.billing !== "object" || Array.isArray(r.billing)) return "billing must be an object";
    const bKeys = ["enabled", "showSessionCosts", "billSessionTime", "billExternalTokens", "billLocalTokens", "billDeploymentTime"];
    for (const k of bKeys) if (r.billing[k] !== undefined && typeof r.billing[k] !== "boolean") return `billing.${k} must be a boolean`;
  }
  return null;
}
```

- [ ] **Step 3: Repo methods**

In `control-plane/src/repo.ts`, add `import { normalizeCostSettings, type CostSettings } from "./costs.ts";` to the imports, and before the class's closing brace (after `deleteTraceSubscription`, repo.ts:1080):

```ts
  // ── Cost tracking & billing (spec 2026-07-14) ────────────────────────────
  async getCostSettings(): Promise<CostSettings> {
    const { rows } = await this.pool.query("SELECT data->'costs' AS costs FROM app_settings WHERE id = 'global'");
    return normalizeCostSettings(rows[0]?.costs);
  }

  async putCostSettings(costs: CostSettings) {
    await this.pool.query(
      `UPDATE app_settings SET data = jsonb_set(data, '{costs}', $1::jsonb), updated_at = now() WHERE id = 'global'`,
      [JSON.stringify(costs)]);
  }
```

- [ ] **Step 4: Routes**

In `control-plane/src/agents-api.ts`, add `import { normalizeCostSettings, validateCostSettings } from "./costs.ts";` to the imports, and directly above `// Analytics / Usage rollup for the workspace.` (agents-api.ts:721):

```ts
  // ── Global cost settings (spec 2026-07-14) — public read: every console
  // page needs them to decide whether to render cost UI. Not workspace-scoped.
  app.get("/v1/settings", async () => ({ costs: await repo.getCostSettings() }));

  app.put("/v1/settings", async (req, reply) => {
    const b = req.body as { costs?: unknown };
    const err = validateCostSettings(b?.costs);
    if (err) return reply.code(400).send({ error: err });
    const costs = normalizeCostSettings(b!.costs);
    await repo.putCostSettings(costs);
    return { costs };
  });
```

- [ ] **Step 5: Write the failing test**

`control-plane/test/costs-settings.test.ts`:

```ts
// Settings singleton (spec 2026-07-14): defaults off, PUT round-trip, validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { DEFAULT_COST_SETTINGS, normalizeCostSettings, validateCostSettings } from "../src/costs.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

test("normalize: absent keys read as defaults; unknown currency falls back", () => {
  assert.deepEqual(normalizeCostSettings(undefined), DEFAULT_COST_SETTINGS);
  assert.equal(normalizeCostSettings({ currency: "XXX" }).currency, "EUR");
  assert.equal(normalizeCostSettings({ enabled: true, billing: { enabled: true } }).billing.enabled, true);
});

test("validate: type errors are named", () => {
  assert.equal(validateCostSettings({ enabled: true }), null);
  assert.match(validateCostSettings({ enabled: "yes" })!, /enabled/);
  assert.match(validateCostSettings({ currency: "DOGE" })!, /currency/);
  assert.match(validateCostSettings({ billing: { billSessionTime: 1 } })!, /billSessionTime/);
  assert.match(validateCostSettings([])!, /object/);
});

test("settings round-trip via repo", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const before = await repo.getCostSettings(); // whatever the dev DB holds
  try {
    const next = { ...DEFAULT_COST_SETTINGS, enabled: true, currency: "USD" as const,
      billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: true, billLocalTokens: true } };
    await repo.putCostSettings(next);
    assert.deepEqual(await repo.getCostSettings(), next);
  } finally {
    await repo.putCostSettings(before); // restore — the dev DB is shared
  }
});
```

- [ ] **Step 6: Run the test — expect failure before the files exist, pass after**

```
cd control-plane && npx tsc --noEmit && node --test test/costs-settings.test.ts
```
Expected: all 3 tests PASS (stop the control plane first if it is running).

- [ ] **Step 7: Commit**

```bash
git add control-plane/sql/030_cost_tracking.sql control-plane/src/costs.ts control-plane/src/repo.ts control-plane/src/agents-api.ts control-plane/test/costs-settings.test.ts
git commit -m "feat(cp): cost schema (migration 030) + global cost settings API"
```

---

### Task 2: Prices API + delete-route cleanup

**Files:**
- Modify: `control-plane/src/costs.ts` (add `validatePrices`)
- Modify: `control-plane/src/repo.ts` (price CRUD, after the Task-1 settings methods)
- Modify: `control-plane/src/agents-api.ts` (routes below the settings routes; env-delete cleanup at agents-api.ts:300-306)
- Modify: `control-plane/src/server.ts` (delete hooks at :301-309 pools, :393-396 deployments, :482-488 external; new `hooks.onResourceDeleted`)
- Modify: `control-plane/src/main.ts` (wire `onResourceDeleted` into the `buildServer` hooks object, main.ts:77-86)
- Test: `control-plane/test/resource-prices.test.ts`

**Interfaces:**
- Consumes: `resource_prices` table (Task 1).
- Produces: `repo.listResourcePrices(): Promise<{kind,ref,prices}[]>`, `repo.getResourcePrice(kind, ref)`, `repo.putResourcePrice(kind, ref, prices)`, `repo.deleteResourcePrice(kind, ref)`; routes `GET /v1/prices` → `{ prices: [...] }`, `PUT /v1/prices/:kind/:ref`; `validatePrices(kind, raw): string | null`.
- Produces: `buildServer(..., hooks)` accepts optional `onResourceDeleted?: (kind: string, ref: string) => Promise<void>` alongside `onModelRouted`.

- [ ] **Step 1: Price validation in `src/costs.ts`** (append)

```ts
export type PriceKind = "pool" | "deployment" | "external" | "environment";
export const PRICE_KINDS: PriceKind[] = ["pool", "deployment", "external", "environment"];
const TIME_UNITS = ["minute", "hour", "day", "month", "year"] as const;

// Which sub-objects each kind may carry (spec §2).
const ALLOWED: Record<PriceKind, { real: string[]; billing: string[] }> = {
  pool:        { real: ["podTime"],  billing: [] },
  deployment:  { real: [],           billing: ["podTime", "tokens"] },
  external:    { real: ["tokens"],   billing: ["tokens"] },
  environment: { real: ["podTime"],  billing: ["sessionTime"] },
};

const timeErr = (p: any, label: string, minuteOk: boolean): string | null => {
  if (p === null || typeof p !== "object") return `${label} must be {amount, per}`;
  if (typeof p.amount !== "number" || !(p.amount >= 0)) return `${label}.amount must be a number >= 0`;
  const units = minuteOk ? TIME_UNITS : TIME_UNITS.filter((u) => u !== "minute");
  if (!units.includes(p.per)) return `${label}.per must be one of ${units.join("|")}`;
  return null;
};
const tokErr = (p: any, label: string): string | null => {
  if (p === null || typeof p !== "object") return `${label} must be {inPerM, outPerM}`;
  for (const k of ["inPerM", "outPerM"])
    if (typeof p[k] !== "number" || !(p[k] >= 0)) return `${label}.${k} must be a number >= 0`;
  return null;
};

/** Validate a prices object for a kind. Empty object = "no prices" (caller deletes the row). */
export function validatePrices(kind: string, raw: unknown): string | null {
  if (!PRICE_KINDS.includes(kind as PriceKind)) return `kind must be one of ${PRICE_KINDS.join("|")}`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "prices must be an object";
  const allowed = ALLOWED[kind as PriceKind];
  for (const [ledger, sub] of Object.entries(raw as Record<string, any>)) {
    if (ledger !== "real" && ledger !== "billing") return `unknown ledger "${ledger}" (real|billing)`;
    if (sub === null || typeof sub !== "object") return `${ledger} must be an object`;
    for (const [key, val] of Object.entries(sub)) {
      if (!allowed[ledger as "real" | "billing"].includes(key))
        return `${kind} does not accept ${ledger}.${key}`;
      const err = key === "tokens" ? tokErr(val, `${ledger}.tokens`)
        : timeErr(val, `${ledger}.${key}`, key === "sessionTime");
      if (err) return err;
    }
  }
  return null;
}
```

- [ ] **Step 2: Repo CRUD** (append after `putCostSettings`)

```ts
  async listResourcePrices() {
    const { rows } = await this.pool.query("SELECT kind, ref, prices FROM resource_prices");
    return rows as { kind: string; ref: string; prices: any }[];
  }
  async getResourcePrice(kind: string, ref: string) {
    const { rows } = await this.pool.query(
      "SELECT prices FROM resource_prices WHERE kind = $1 AND ref = $2", [kind, ref]);
    return rows[0]?.prices ?? null;
  }
  async putResourcePrice(kind: string, ref: string, prices: unknown) {
    await this.pool.query(
      `INSERT INTO resource_prices (kind, ref, prices) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (kind, ref) DO UPDATE SET prices = EXCLUDED.prices, updated_at = now()`,
      [kind, ref, JSON.stringify(prices)]);
  }
  async deleteResourcePrice(kind: string, ref: string) {
    await this.pool.query("DELETE FROM resource_prices WHERE kind = $1 AND ref = $2", [kind, ref]);
  }
```

- [ ] **Step 3: Routes in agents-api.ts** (below the Task-1 settings routes)

```ts
  // Resource prices (spec 2026-07-14 §2). Global; ref = pool/deployment name
  // or external/environment row id. Empty prices object deletes the row.
  app.get("/v1/prices", async () => ({ prices: await repo.listResourcePrices() }));

  app.put("/v1/prices/:kind/:ref", async (req, reply) => {
    const { kind, ref } = req.params as { kind: string; ref: string };
    const prices = (req.body as any)?.prices;
    const err = validatePrices(kind, prices);
    if (err) return reply.code(400).send({ error: err });
    const empty = Object.entries(prices as Record<string, any>)
      .every(([, sub]) => Object.keys(sub ?? {}).length === 0);
    if (empty || Object.keys(prices).length === 0) {
      await repo.deleteResourcePrice(kind, ref);
      return { prices: null };
    }
    await repo.putResourcePrice(kind, ref, prices);
    return { prices };
  });
```
Add `validatePrices` to the `./costs.ts` import in agents-api.ts.

Environment delete cleanup — in the existing `DELETE /v1/environments/:id` handler (agents-api.ts:300-306), after `await repo.deleteEnvironment(ws(req), id);` add:

```ts
    await repo.deleteResourcePrice("environment", id);
```

- [ ] **Step 4: server.ts delete hooks**

`buildServer`'s hooks parameter (the object main.ts passes with `onModelRouted`) gains an optional member. Find the hooks type/destructuring in `server.ts` (search `onModelRouted`) and add:

```ts
  onResourceDeleted?: (kind: "pool" | "deployment" | "external", ref: string) => Promise<void>;
```

In `DELETE /v1/pools/:name` (server.ts:301) after `await store.delete("modelpools", name);`:

```ts
    await hooks?.onResourceDeleted?.("pool", name).catch(() => {}); // price row is advisory — never fail the delete
```

In `DELETE /v1/deployments/:name` (server.ts:393) after `await store.delete("modeldeployments", ...)`:

```ts
    await hooks?.onResourceDeleted?.("deployment", (req.params as any).name).catch(() => {});
```

In `DELETE /v1/deployments/external/:id` (server.ts:482) after `await store.deleteProviderKey(envKeyFor(row.id));`:

```ts
    await hooks?.onResourceDeleted?.("external", row.id).catch(() => {});
```

(Use the actual local name of the hooks parameter in server.ts — it may be destructured; match the `onModelRouted` call pattern at its use site.)

In `main.ts`, extend the hooks object passed to `buildServer` (main.ts:77-86):

```ts
  onResourceDeleted: (kind, ref) => repo.deleteResourcePrice(kind, ref),
```

- [ ] **Step 5: Test**

`control-plane/test/resource-prices.test.ts`:

```ts
// Price rows (spec 2026-07-14 §2): validation per kind, upsert/rotate, delete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { validatePrices } from "../src/costs.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

test("validatePrices enforces per-kind shape", () => {
  assert.equal(validatePrices("pool", { real: { podTime: { amount: 1.5, per: "hour" } } }), null);
  assert.match(validatePrices("pool", { billing: { podTime: { amount: 1, per: "hour" } } })!, /does not accept/);
  assert.match(validatePrices("pool", { real: { podTime: { amount: 1, per: "minute" } } })!, /per must be/); // minute is sessionTime-only
  assert.equal(validatePrices("environment", { billing: { sessionTime: { amount: 2, per: "minute" } } }), null);
  assert.equal(validatePrices("external", { real: { tokens: { inPerM: 5, outPerM: 15 } }, billing: { tokens: { inPerM: 10, outPerM: 30 } } }), null);
  assert.match(validatePrices("external", { real: { tokens: { inPerM: -1, outPerM: 0 } } })!, /inPerM/);
  assert.equal(validatePrices("deployment", { billing: { podTime: { amount: 3, per: "day" }, tokens: { inPerM: 1, outPerM: 2 } } }), null);
  assert.match(validatePrices("nope", {})!, /kind/);
});

test("upsert, rotate, delete", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ref = `t-price-${Date.now()}`;
  try {
    await repo.putResourcePrice("pool", ref, { real: { podTime: { amount: 1, per: "hour" } } });
    assert.equal((await repo.getResourcePrice("pool", ref)).real.podTime.amount, 1);
    await repo.putResourcePrice("pool", ref, { real: { podTime: { amount: 2, per: "day" } } });
    assert.equal((await repo.getResourcePrice("pool", ref)).real.podTime.per, "day");
    assert.equal((await repo.listResourcePrices()).some((p) => p.ref === ref), true);
  } finally {
    await repo.deleteResourcePrice("pool", ref);
  }
  assert.equal(await repo.getResourcePrice("pool", ref), null);
});
```

- [ ] **Step 6: Run**

```
cd control-plane && npx tsc --noEmit && node --test test/resource-prices.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A control-plane
git commit -m "feat(cp): resource prices API + price cleanup on resource deletes"
```

---

### Task 3: Stamping trigger + billed accumulation + SSE frame

**Files:**
- Create: `control-plane/sql/031_cost_stamping.sql`
- Modify: `control-plane/sql/027_session_usage_trigger.sql` (pointer comment only)
- Modify: `control-plane/src/session-sse.ts:41-52`
- Test: `control-plane/test/cost-stamping.test.ts`

**Interfaces:**
- Consumes: `app_settings`, `resource_prices`, cost columns (Tasks 1–2).
- Produces: BEFORE INSERT trigger `gateway_usage_cost_stamp`; `session_usage_accumulate()` additionally accumulates `billed_cost`; SSE `status` frames carry `billed_cost` (number).

- [ ] **Step 1: Migration**

`control-plane/sql/031_cost_stamping.sql`:

```sql
-- Token-cost stamping (spec 2026-07-14 §3). BEFORE INSERT on gateway_usage:
-- look up the price valid NOW and stamp real_cost/billed_cost. NULL = not
-- tracked at the time (distinct from 0 = tracked but free). Defensive: any
-- error nulls the costs and lets the insert proceed — a pricing bug may lose
-- cost data, never token metering. Also replaces 027's accumulate function to
-- add billed_cost accumulation (031 runs after 027 each boot; later wins).
CREATE OR REPLACE FUNCTION gateway_usage_cost_stamp() RETURNS trigger AS $$
DECLARE
  cfg jsonb;
  pr  jsonb;
  ext_ref text;
BEGIN
  SELECT data->'costs' INTO cfg FROM app_settings WHERE id = 'global';
  IF cfg IS NULL OR NOT COALESCE((cfg->>'enabled')::boolean, false) THEN
    RETURN NEW;
  END IF;
  -- Name collisions between local and external deployments are prevented at
  -- creation (server.ts:441), so a name match decides the namespace.
  SELECT id INTO ext_ref FROM external_deployments WHERE name = NEW.model;
  IF ext_ref IS NOT NULL THEN
    SELECT prices INTO pr FROM resource_prices WHERE kind = 'external' AND ref = ext_ref;
    IF COALESCE((cfg->>'trackExternalCosts')::boolean, false) AND pr #> '{real,tokens}' IS NOT NULL THEN
      NEW.real_cost :=
          COALESCE(NEW.tokens_in, 0)  * COALESCE((pr #>> '{real,tokens,inPerM}')::numeric, 0)  / 1000000
        + COALESCE(NEW.tokens_out, 0) * COALESCE((pr #>> '{real,tokens,outPerM}')::numeric, 0) / 1000000;
    END IF;
    IF COALESCE((cfg #>> '{billing,enabled}')::boolean, false)
       AND COALESCE((cfg #>> '{billing,billExternalTokens}')::boolean, false)
       AND pr #> '{billing,tokens}' IS NOT NULL THEN
      NEW.billed_cost :=
          COALESCE(NEW.tokens_in, 0)  * COALESCE((pr #>> '{billing,tokens,inPerM}')::numeric, 0)  / 1000000
        + COALESCE(NEW.tokens_out, 0) * COALESCE((pr #>> '{billing,tokens,outPerM}')::numeric, 0) / 1000000;
    END IF;
  ELSE
    -- Local model: no per-token real cost (pool pod-time is its real cost).
    SELECT prices INTO pr FROM resource_prices WHERE kind = 'deployment' AND ref = NEW.model;
    IF COALESCE((cfg #>> '{billing,enabled}')::boolean, false)
       AND COALESCE((cfg #>> '{billing,billLocalTokens}')::boolean, false)
       AND pr #> '{billing,tokens}' IS NOT NULL THEN
      NEW.billed_cost :=
          COALESCE(NEW.tokens_in, 0)  * COALESCE((pr #>> '{billing,tokens,inPerM}')::numeric, 0)  / 1000000
        + COALESCE(NEW.tokens_out, 0) * COALESCE((pr #>> '{billing,tokens,outPerM}')::numeric, 0) / 1000000;
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  NEW.real_cost := NULL;
  NEW.billed_cost := NULL;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gateway_usage_cost_stamp ON gateway_usage;
CREATE TRIGGER gateway_usage_cost_stamp
  BEFORE INSERT ON gateway_usage
  FOR EACH ROW EXECUTE FUNCTION gateway_usage_cost_stamp();

-- Accumulate billed token cost into the session (chip source). Replaces the
-- 027 definition; the trigger binding from 027 is unchanged.
CREATE OR REPLACE FUNCTION session_usage_accumulate() RETURNS trigger AS $$
BEGIN
  UPDATE sessions
     SET tokens_in   = tokens_in  + NEW.tokens_in,
         tokens_out  = tokens_out + NEW.tokens_out,
         billed_cost = billed_cost + COALESCE(NEW.billed_cost, 0)
   WHERE id = NEW.session_id;
  PERFORM pg_notify('devproof_session', NEW.session_id);
  RETURN NULL;
END $$ LANGUAGE plpgsql;
```

- [ ] **Step 2: Pointer comment in 027**

At the end of the header comment block in `control-plane/sql/027_session_usage_trigger.sql` (after line 10) add:

```sql
-- NOTE: 031_cost_stamping.sql REPLACES session_usage_accumulate() (adds
-- billed_cost accumulation). This file's definition only exists for ordering;
-- do not edit the function body here — edit 031.
```

- [ ] **Step 3: SSE frame**

In `control-plane/src/session-sse.ts`, replace lines 43-51:

```ts
      const tokens = `${Number(s.tokens_in ?? 0)}/${Number(s.tokens_out ?? 0)}/${Number(s.billed_cost ?? 0)}`;
      if (s.status !== lastStatus || tokens !== lastTokens) {
        lastStatus = s.status;
        lastTokens = tokens;
        reply.raw.write(`event: status\ndata: ${JSON.stringify({
          status: s.status,
          tokens_in: Number(s.tokens_in ?? 0), tokens_out: Number(s.tokens_out ?? 0),
          billed_cost: Number(s.billed_cost ?? 0),
          turns: Number(s.turns ?? 0),
        })}\n\n`);
      }
```

- [ ] **Step 4: Test**

`control-plane/test/cost-stamping.test.ts` (pattern: `session-usage-trigger.test.ts`):

```ts
// Trigger 031: costs stamped at insert time per settings+prices; billed cost
// accumulates into sessions.billed_cost. Live dev Postgres; self-skip offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { DEFAULT_COST_SETTINGS } from "../src/costs.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

const insertUsage = (ws: string, model: string, tin: number, tout: number, sesn?: string) =>
  pool.query(
    `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, source, session_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING real_cost, billed_cost`,
    [ws, model, tin, tout, sesn ? "session" : "api", sesn ?? null]);

test("stamping honors settings + prices; NULL when off; 0 tracked-but-free", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const before = await repo.getCostSettings();
  const ws = (await repo.createWorkspace(`t-cost-${Date.now()}`)).id;
  const ext = await repo.createExternalDeployment({
    name: `t-cost-ext-${Date.now()}`, provider: "custom", baseUrl: "http://x/v1", modelId: "m" });
  const localName = `t-cost-local-${Date.now()}`;
  try {
    // 1. Master off → NULL costs even with prices present.
    await repo.putResourcePrice("external", ext.id, {
      real: { tokens: { inPerM: 5, outPerM: 15 } }, billing: { tokens: { inPerM: 10, outPerM: 30 } } });
    await repo.putCostSettings({ ...DEFAULT_COST_SETTINGS });
    let r = (await insertUsage(ws, ext.name, 1_000_000, 0)).rows[0];
    assert.equal(r.real_cost, null); assert.equal(r.billed_cost, null);

    // 2. Tracking + billing on → both stamped (1M in = inPerM exactly).
    await repo.putCostSettings({ ...DEFAULT_COST_SETTINGS, enabled: true, trackExternalCosts: true,
      billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: true, billExternalTokens: true } });
    r = (await insertUsage(ws, ext.name, 1_000_000, 2_000_000)).rows[0];
    assert.equal(Number(r.real_cost), 5 + 2 * 15);
    assert.equal(Number(r.billed_cost), 10 + 2 * 30);

    // 3. Local model: real stays NULL (pool time is its real cost); billed via billLocalTokens.
    await repo.putResourcePrice("deployment", localName, { billing: { tokens: { inPerM: 1, outPerM: 2 } } });
    await repo.putCostSettings({ ...DEFAULT_COST_SETTINGS, enabled: true,
      billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: true, billLocalTokens: true } });
    r = (await insertUsage(ws, localName, 500_000, 500_000)).rows[0];
    assert.equal(r.real_cost, null);
    assert.equal(Number(r.billed_cost), 0.5 + 1);

    // 4. Tracked-but-free: price 0 stamps 0, not NULL.
    await repo.putResourcePrice("deployment", localName, { billing: { tokens: { inPerM: 0, outPerM: 0 } } });
    r = (await insertUsage(ws, localName, 9, 9)).rows[0];
    assert.equal(Number(r.billed_cost), 0);

    // 5. Session accumulation: billed_cost rides the 027/031 accumulate.
    await repo.putResourcePrice("deployment", localName, { billing: { tokens: { inPerM: 4, outPerM: 4 } } });
    const agent = await repo.createAgent(ws, `t-cost-${Date.now()}`, { model: localName, tools: [] });
    const session = await repo.createSession(ws, agent.id, "hi");
    await insertUsage(ws, localName, 250_000, 250_000, session.id);
    const s = await repo.getSession(session.id);
    assert.equal(Number(s.billed_cost), 2);
  } finally {
    await repo.putCostSettings(before);
    await repo.deleteResourcePrice("external", ext.id);
    await repo.deleteResourcePrice("deployment", localName);
    await repo.deleteExternalDeployment(ext.id);
    await pool.query("DELETE FROM gateway_usage WHERE workspace_id = $1", [ws]);
  }
});

test("031 idempotent: exactly one stamp trigger after re-migrate", { skip: !available }, async () => {
  await migrate(pool);
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'gateway_usage_cost_stamp' AND NOT tgisinternal");
  assert.equal(rows[0].n, 1);
});
```

- [ ] **Step 5: Run**

```
cd control-plane && npx tsc --noEmit && node --test test/cost-stamping.test.ts
```
Expected: PASS (CP stopped; live dev Postgres reachable).

- [ ] **Step 6: Commit**

```bash
git add control-plane/sql/031_cost_stamping.sql control-plane/sql/027_session_usage_trigger.sql control-plane/src/session-sse.ts control-plane/test/cost-stamping.test.ts
git commit -m "feat(cp): token-cost stamping trigger + session billed_cost accumulation"
```

---

### Task 4: Pure accrual math (`computeAccruals`)

**Files:**
- Modify: `control-plane/src/costs.ts` (append)
- Test: `control-plane/test/costs-accrual.test.ts` (pure — no DB needed)

**Interfaces:**
- Produces (exact — Task 5 depends on these):

```ts
export const GAP_CAP_SEC = 120;
export function ratePerSecond(p?: { amount?: number; per?: string } | null): number;
export interface DeploymentObs { name: string; pool: string | null; readyReplicas: number }
export interface TurnObs { sessionId: string; workspaceId: string; environmentId: string | null; startedAtMs: number | null }
export interface CostEntryDraft {
  kind: "pool_pod" | "deployment_time" | "env_pod" | "session_time";
  deployment?: string; pool?: string; environmentId?: string; sessionId?: string; workspaceId?: string;
  seconds: number; replicas?: number; realCost: number | null; billedCost: number | null;
}
export function computeAccruals(
  nowMs: number,
  settings: CostSettings,
  prices: { kind: string; ref: string; prices: any }[],
  deployments: DeploymentObs[],
  turns: TurnObs[],
  watermarksMs: Map<string, number>,   // keys "dep:<name>" and "sesn:<id>"
): { entries: CostEntryDraft[]; sessionBilled: Map<string, number> };
```

- [ ] **Step 1: Write the failing tests**

`control-plane/test/costs-accrual.test.ts`:

```ts
// Pure accrual math (spec 2026-07-14 §4): rate normalization, replica
// multiplication, gap cap, toggle gating, pod-start anchoring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ratePerSecond, computeAccruals, GAP_CAP_SEC, DEFAULT_COST_SETTINGS } from "../src/costs.ts";

const ON = { ...DEFAULT_COST_SETTINGS, enabled: true, trackPoolCosts: true, trackEnvCosts: true,
  billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: true, billSessionTime: true, billDeploymentTime: true } };
const NOW = 1_800_000_000_000;

test("ratePerSecond normalizes all units; garbage = 0", () => {
  assert.equal(ratePerSecond({ amount: 3600, per: "hour" }), 1);
  assert.equal(ratePerSecond({ amount: 60, per: "minute" }), 1);
  assert.equal(ratePerSecond({ amount: 86400, per: "day" }), 1);
  assert.equal(ratePerSecond({ amount: 2592000, per: "month" }), 1);
  assert.equal(ratePerSecond({ amount: 31536000, per: "year" }), 1);
  assert.equal(ratePerSecond(null), 0);
  assert.equal(ratePerSecond({ amount: -5, per: "hour" }), 0);
  assert.equal(ratePerSecond({ amount: 5, per: "fortnight" }), 0);
});

test("deployment accrual: replicas x rate x elapsed; pool real + deployment billing", () => {
  const prices = [
    { kind: "pool", ref: "cpu-default", prices: { real: { podTime: { amount: 3600, per: "hour" } } } },
    { kind: "deployment", ref: "qwen", prices: { billing: { podTime: { amount: 7200, per: "hour" } } } },
  ];
  const wm = new Map([["dep:qwen", NOW - 60_000]]);
  const { entries } = computeAccruals(NOW, ON, prices,
    [{ name: "qwen", pool: "cpu-default", readyReplicas: 2 }], [], wm);
  const pool = entries.find((e) => e.kind === "pool_pod")!;
  assert.equal(pool.seconds, 60); assert.equal(pool.replicas, 2);
  assert.equal(pool.realCost, 120);          // 1/s x 2 replicas x 60s
  assert.equal(pool.deployment, "qwen"); assert.equal(pool.pool, "cpu-default");
  const bill = entries.find((e) => e.kind === "deployment_time")!;
  assert.equal(bill.billedCost, 240);        // 2/s x 2 x 60
});

test("gap cap: watermark older than GAP_CAP_SEC accrues only the cap", () => {
  const prices = [{ kind: "pool", ref: "p", prices: { real: { podTime: { amount: 3600, per: "hour" } } } }];
  const wm = new Map([["dep:d", NOW - 3_600_000]]); // 1h gap
  const { entries } = computeAccruals(NOW, ON, prices,
    [{ name: "d", pool: "p", readyReplicas: 1 }], [], wm);
  assert.equal(entries[0].seconds, GAP_CAP_SEC);
});

test("first sighting: deployment w/o watermark accrues nothing; turn anchors at pod start", () => {
  const prices = [
    { kind: "pool", ref: "p", prices: { real: { podTime: { amount: 3600, per: "hour" } } } },
    { kind: "environment", ref: "env_1", prices: {
      real: { podTime: { amount: 3600, per: "hour" } },
      billing: { sessionTime: { amount: 60, per: "minute" } } } },
  ];
  const { entries, sessionBilled } = computeAccruals(NOW, ON, prices,
    [{ name: "d", pool: "p", readyReplicas: 1 }],
    [{ sessionId: "sesn_a", workspaceId: "wrkspc_default", environmentId: "env_1", startedAtMs: NOW - 30_000 }],
    new Map());
  assert.equal(entries.some((e) => e.kind === "pool_pod"), false);   // no watermark, no pod-start signal
  const env = entries.find((e) => e.kind === "env_pod")!;
  assert.equal(env.seconds, 30); assert.equal(env.realCost, 30);
  const st = entries.find((e) => e.kind === "session_time")!;
  assert.equal(st.billedCost, 30); assert.equal(st.workspaceId, "wrkspc_default");
  assert.equal(sessionBilled.get("sesn_a"), 30);
});

test("toggles gate each kind independently; master off = nothing", () => {
  const prices = [
    { kind: "pool", ref: "p", prices: { real: { podTime: { amount: 1, per: "hour" } } } },
    { kind: "environment", ref: "e", prices: { billing: { sessionTime: { amount: 1, per: "hour" } } } },
  ];
  const deps = [{ name: "d", pool: "p", readyReplicas: 1 }];
  const turns = [{ sessionId: "s", workspaceId: "w", environmentId: "e", startedAtMs: NOW - 10_000 }];
  const wm = new Map([["dep:d", NOW - 10_000], ["sesn:s", NOW - 10_000]]);
  assert.equal(computeAccruals(NOW, { ...ON, enabled: false }, prices, deps, turns, wm).entries.length, 0);
  const noPool = computeAccruals(NOW, { ...ON, trackPoolCosts: false }, prices, deps, turns, wm).entries;
  assert.equal(noPool.some((e) => e.kind === "pool_pod"), false);
  const noBill = computeAccruals(NOW, { ...ON, billing: { ...ON.billing, enabled: false } }, prices, deps, turns, wm).entries;
  assert.equal(noBill.some((e) => e.kind === "session_time" || e.kind === "deployment_time"), false);
});

test("no price object = no entry (nothing to multiply)", () => {
  const { entries } = computeAccruals(NOW, ON, [],
    [{ name: "d", pool: "p", readyReplicas: 3 }],
    [{ sessionId: "s", workspaceId: "w", environmentId: "e", startedAtMs: NOW - 5_000 }],
    new Map([["dep:d", NOW - 5_000], ["sesn:s", NOW - 5_000]]));
  assert.equal(entries.length, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && node --test test/costs-accrual.test.ts`
Expected: FAIL — `computeAccruals` is not exported.

- [ ] **Step 3: Implement** (append to `control-plane/src/costs.ts`)

```ts
// ── Time-cost accrual (spec §4) — pure; the sampler supplies observations. ──
export const GAP_CAP_SEC = 120;
const PER_SECONDS: Record<string, number> = {
  minute: 60, hour: 3600, day: 86400, month: 2_592_000, year: 31_536_000,
};

export function ratePerSecond(p?: { amount?: number; per?: string } | null): number {
  if (!p || typeof p.amount !== "number" || !(p.amount >= 0)) return 0;
  const s = PER_SECONDS[p.per ?? ""];
  return s ? p.amount / s : 0;
}

export interface DeploymentObs { name: string; pool: string | null; readyReplicas: number }
export interface TurnObs { sessionId: string; workspaceId: string; environmentId: string | null; startedAtMs: number | null }
export interface CostEntryDraft {
  kind: "pool_pod" | "deployment_time" | "env_pod" | "session_time";
  deployment?: string; pool?: string; environmentId?: string; sessionId?: string; workspaceId?: string;
  seconds: number; replicas?: number; realCost: number | null; billedCost: number | null;
}

/** Elapsed seconds since the watermark (or anchor), gap-capped. 0 = skip. */
function spanSec(nowMs: number, watermarkMs: number | undefined, anchorMs: number | null): number {
  const from = watermarkMs ?? anchorMs;
  if (from == null) return 0;                       // first sighting without a start signal
  return Math.min(Math.max(0, (nowMs - from) / 1000), GAP_CAP_SEC);
}

export function computeAccruals(
  nowMs: number,
  settings: CostSettings,
  prices: { kind: string; ref: string; prices: any }[],
  deployments: DeploymentObs[],
  turns: TurnObs[],
  watermarksMs: Map<string, number>,
): { entries: CostEntryDraft[]; sessionBilled: Map<string, number> } {
  const entries: CostEntryDraft[] = [];
  const sessionBilled = new Map<string, number>();
  if (!settings.enabled) return { entries, sessionBilled };
  const price = (kind: string, ref: string | null) =>
    ref == null ? undefined : prices.find((p) => p.kind === kind && p.ref === ref)?.prices;
  const billing = settings.billing.enabled;

  for (const d of deployments) {
    if (d.readyReplicas <= 0) continue;
    const sec = spanSec(nowMs, watermarksMs.get(`dep:${d.name}`), null);
    if (sec <= 0) continue;
    const poolP = price("pool", d.pool)?.real?.podTime;
    if (settings.trackPoolCosts && poolP) {
      entries.push({ kind: "pool_pod", deployment: d.name, pool: d.pool ?? undefined,
        seconds: sec, replicas: d.readyReplicas,
        realCost: ratePerSecond(poolP) * d.readyReplicas * sec, billedCost: null });
    }
    const depP = price("deployment", d.name)?.billing?.podTime;
    if (billing && settings.billing.billDeploymentTime && depP) {
      entries.push({ kind: "deployment_time", deployment: d.name, pool: d.pool ?? undefined,
        seconds: sec, replicas: d.readyReplicas,
        realCost: null, billedCost: ratePerSecond(depP) * d.readyReplicas * sec });
    }
  }

  for (const t of turns) {
    const sec = spanSec(nowMs, watermarksMs.get(`sesn:${t.sessionId}`), t.startedAtMs);
    if (sec <= 0) continue;
    const envPrices = price("environment", t.environmentId);
    const envP = envPrices?.real?.podTime;
    if (settings.trackEnvCosts && envP) {
      entries.push({ kind: "env_pod", environmentId: t.environmentId!, sessionId: t.sessionId,
        workspaceId: t.workspaceId, seconds: sec,
        realCost: ratePerSecond(envP) * sec, billedCost: null });
    }
    const sesP = envPrices?.billing?.sessionTime;
    if (billing && settings.billing.billSessionTime && sesP) {
      const cost = ratePerSecond(sesP) * sec;
      entries.push({ kind: "session_time", environmentId: t.environmentId!, sessionId: t.sessionId,
        workspaceId: t.workspaceId, seconds: sec, realCost: null, billedCost: cost });
      sessionBilled.set(t.sessionId, (sessionBilled.get(t.sessionId) ?? 0) + cost);
    }
  }
  return { entries, sessionBilled };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd control-plane && npx tsc --noEmit && node --test test/costs-accrual.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/costs.ts control-plane/test/costs-accrual.test.ts
git commit -m "feat(cp): pure time-cost accrual math (ratePerSecond, computeAccruals)"
```

---

### Task 5: Cost sampler + turn-end settle + wiring

**Files:**
- Create: `control-plane/src/cost-sampler.ts`
- Modify: `control-plane/src/orchestrator.ts` (add `sessionJobInfo` next to `sessionJobState` at orchestrator.ts:185-194; add it to the `Orchestrator` interface type in the same file)
- Modify: `control-plane/src/repo.ts` (sampler queries, appended after Task-2 price methods)
- Modify: `control-plane/src/reconciler.ts` (optional `onSessionFailed` callback)
- Modify: `control-plane/src/agents-api.ts` (settle on status/interrupt routes via new `opts.settleSession`)
- Modify: `control-plane/src/main.ts` (start sampler; wire settle into routes + reconciler)
- Test: `control-plane/test/cost-sampler.test.ts`

**Interfaces:**
- Consumes: `computeAccruals`, `CostEntryDraft`, `DeploymentObs`, `TurnObs`, `CostSettings` (Task 4); `repo.getCostSettings`, `repo.listResourcePrices` (Tasks 1-2).
- Produces (exact):

```ts
// cost-sampler.ts
export interface SamplerDeps {
  repo: {
    getCostSettings(): Promise<CostSettings>;
    listResourcePrices(): Promise<{ kind: string; ref: string; prices: any }[]>;
    listRunningSessionsForBilling(): Promise<{ id: string; workspace_id: string; turns: number; environment_id: string | null }[]>;
    getSessionForBilling(sessionId: string): Promise<{ id: string; workspace_id: string; turns: number; environment_id: string | null } | null>;
    costWatermarks(): Promise<Map<string, number>>;
    insertCostEntries(entries: CostEntryDraft[]): Promise<void>;
    addSessionBilledCost(sessionId: string, amount: number): Promise<void>;
  };
  kube: { list(plural: "modeldeployments"): Promise<any[]> };
  orchestrator: { sessionJobInfo(sessionId: string, turn: number): Promise<{ state: string; startedAt: Date | null }> };
}
export async function costSamplerTick(deps: SamplerDeps, nowMs?: number): Promise<void>;
export async function settleSession(deps: SamplerDeps, sessionId: string): Promise<void>;
export function startCostSampler(deps: SamplerDeps): () => void;  // 60s interval, unref'd; returns stop
```
- Produces: `orchestrator.sessionJobInfo(sessionId, turn)`; `sweepZombieSessions(repo, orchestrator, onSessionFailed?)` / `startReconciler(repo, orchestrator, pendingSweep?, onSessionFailed?)`; `registerAgentRoutes` opts gains `settleSession?: (id: string) => Promise<void>`.

- [ ] **Step 1: Orchestrator job info**

In `control-plane/src/orchestrator.ts`, directly after `sessionJobState` (orchestrator.ts:194) add:

```ts
    // Job state + pod start for the cost sampler: startTime anchors the first
    // accrual of a turn at pod start, not first sampler sighting (spec §4).
    async sessionJobInfo(sessionId, turn) {
      const name = `${sessionId.replace(/_/g, "-").toLowerCase()}-t${turn}`;
      try {
        const job: any = await batch.readNamespacedJob({ name, namespace: AGENTS_NAMESPACE });
        return {
          state: (job?.status?.active ?? 0) > 0 ? ("active" as const) : ("finished" as const),
          startedAt: job?.status?.startTime ? new Date(job.status.startTime) : null,
        };
      } catch (err: any) {
        if (err?.code === 404) return { state: "missing" as const, startedAt: null };
        throw err;
      }
    },
```

Add the matching member to the `Orchestrator` interface in the same file (search for `sessionJobState(` in the interface block):

```ts
  sessionJobInfo(sessionId: string, turn: number): Promise<{ state: "active" | "finished" | "missing"; startedAt: Date | null }>;
```

- [ ] **Step 2: Repo sampler queries** (append to repo.ts after Task-2 methods)

```ts
  /** Running sessions with their env — the sampler's turn candidates. Parked
   *  (pending-launch) sessions are status 'queued', so they never appear. */
  async listRunningSessionsForBilling() {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.workspace_id, s.turns, v.environment_id
       FROM sessions s
       JOIN agent_versions v ON v.agent_id = s.agent_id AND v.version = s.agent_version
       WHERE s.status = 'running'`);
    return rows.map((r: any) => ({ ...r, turns: Number(r.turns) }));
  }

  /** Settle lookup: same shape, by id, status-agnostic (status already flipped
   *  by the time the settle hook runs). */
  async getSessionForBilling(sessionId: string) {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.workspace_id, s.turns, v.environment_id
       FROM sessions s
       JOIN agent_versions v ON v.agent_id = s.agent_id AND v.version = s.agent_version
       WHERE s.id = $1`, [sessionId]);
    return rows[0] ? { ...rows[0], turns: Number(rows[0].turns) } : null;
  }

  /** Latest ledger ts per subject → watermark map ("dep:<name>" / "sesn:<id>"). */
  async costWatermarks(): Promise<Map<string, number>> {
    const wm = new Map<string, number>();
    const { rows: deps } = await this.pool.query(
      `SELECT deployment, max(ts) AS ts FROM cost_entries
       WHERE kind IN ('pool_pod','deployment_time') AND deployment IS NOT NULL GROUP BY 1`);
    for (const r of deps) wm.set(`dep:${r.deployment}`, new Date(r.ts).getTime());
    const { rows: sesns } = await this.pool.query(
      `SELECT session_id, max(ts) AS ts FROM cost_entries
       WHERE kind IN ('env_pod','session_time') AND session_id IS NOT NULL GROUP BY 1`);
    for (const r of sesns) wm.set(`sesn:${r.session_id}`, new Date(r.ts).getTime());
    return wm;
  }

  async insertCostEntries(entries: import("./costs.ts").CostEntryDraft[]) {
    for (const e of entries) {
      await this.pool.query(
        `INSERT INTO cost_entries (kind, deployment, pool, environment_id, session_id, workspace_id,
                                   seconds, replicas, real_cost, billed_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [e.kind, e.deployment ?? null, e.pool ?? null, e.environmentId ?? null, e.sessionId ?? null,
         e.workspaceId ?? null, e.seconds, e.replicas ?? null, e.realCost, e.billedCost]);
    }
  }

  /** Session-time billing → chip: bump the accumulated total and wake SSE. */
  async addSessionBilledCost(sessionId: string, amount: number) {
    if (!(amount > 0)) return;
    await this.pool.query(
      "UPDATE sessions SET billed_cost = billed_cost + $2 WHERE id = $1", [sessionId, amount]);
    await this.pool.query("SELECT pg_notify('devproof_session', $1)", [sessionId]);
  }
```

- [ ] **Step 3: The sampler**

`control-plane/src/cost-sampler.ts` (complete file):

```ts
// Time-cost sampler (spec 2026-07-14 §4). 60s tick: observe running engine
// replicas (pool real cost + deployment time billing) and running turn pods
// (env real cost + session time billing), accrue since the per-subject
// watermark (latest cost_entries.ts), gap-capped at GAP_CAP_SEC so a CP
// outage under-counts instead of fabricating. settleSession() runs the final
// watermark→now accrual when a turn ends, making totals exact-to-the-second.
import {
  computeAccruals, type CostEntryDraft, type CostSettings,
  type DeploymentObs, type TurnObs,
} from "./costs.ts";

export interface SamplerDeps {
  repo: {
    getCostSettings(): Promise<CostSettings>;
    listResourcePrices(): Promise<{ kind: string; ref: string; prices: any }[]>;
    listRunningSessionsForBilling(): Promise<{ id: string; workspace_id: string; turns: number; environment_id: string | null }[]>;
    getSessionForBilling(sessionId: string): Promise<{ id: string; workspace_id: string; turns: number; environment_id: string | null } | null>;
    costWatermarks(): Promise<Map<string, number>>;
    insertCostEntries(entries: CostEntryDraft[]): Promise<void>;
    addSessionBilledCost(sessionId: string, amount: number): Promise<void>;
  };
  kube: { list(plural: "modeldeployments"): Promise<any[]> };
  orchestrator: { sessionJobInfo(sessionId: string, turn: number): Promise<{ state: string; startedAt: Date | null }> };
}

const needsTime = (s: CostSettings) =>
  s.enabled && (s.trackPoolCosts || s.trackEnvCosts ||
    (s.billing.enabled && (s.billing.billSessionTime || s.billing.billDeploymentTime)));

async function accrue(deps: SamplerDeps, deployments: DeploymentObs[], turns: TurnObs[], nowMs: number) {
  const [settings, prices, watermarks] = await Promise.all([
    deps.repo.getCostSettings(), deps.repo.listResourcePrices(), deps.repo.costWatermarks(),
  ]);
  if (!needsTime(settings)) return;
  const { entries, sessionBilled } = computeAccruals(nowMs, settings, prices, deployments, turns, watermarks);
  if (entries.length) await deps.repo.insertCostEntries(entries);
  for (const [id, amount] of sessionBilled) await deps.repo.addSessionBilledCost(id, amount);
}

export async function costSamplerTick(deps: SamplerDeps, nowMs = Date.now()) {
  const items = await deps.kube.list("modeldeployments").catch((err) => {
    console.warn("cost-sampler: deployment list failed:", err);
    return [] as any[];
  });
  const deployments: DeploymentObs[] = items.map((d: any) => ({
    name: d.metadata?.name ?? "",
    pool: d.spec?.poolRef ?? null,
    readyReplicas: Number(d.status?.readyReplicas ?? 0),
  })).filter((d) => d.name);

  const sessions = await deps.repo.listRunningSessionsForBilling();
  const turns: TurnObs[] = [];
  for (const s of sessions) {
    try {
      const info = await deps.orchestrator.sessionJobInfo(s.id, s.turns);
      if (info.state !== "active") continue;   // pod gone → the settle path owns the tail
      turns.push({ sessionId: s.id, workspaceId: s.workspace_id,
        environmentId: s.environment_id, startedAtMs: info.startedAt?.getTime() ?? null });
    } catch (err) {
      console.warn(`cost-sampler: job info for ${s.id} failed:`, err); // next tick retries
    }
  }
  await accrue(deps, deployments, turns, nowMs);
}

/** Final accrual for one session's turn — called when status leaves running
 *  (runner result, interrupt, zombie fail). The pod may already be gone: the
 *  span ends "now", the observed end of the turn. A turn with neither a
 *  watermark nor a pod-start anchor accrues nothing (unknown span — the gap
 *  cap philosophy says skip, never fabricate). */
export async function settleSession(deps: SamplerDeps, sessionId: string) {
  const s = await deps.repo.getSessionForBilling(sessionId);
  if (!s) return;
  const turns: TurnObs[] = [{ sessionId: s.id, workspaceId: s.workspace_id,
    environmentId: s.environment_id, startedAtMs: null }];
  await accrue(deps, [], turns, Date.now());
}

export function startCostSampler(deps: SamplerDeps) {
  const tick = () => costSamplerTick(deps).catch((err) => console.warn("cost-sampler: tick failed:", err));
  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Reconciler callback + route settles + main wiring**

`reconciler.ts` — add the optional callback parameter:

```ts
export async function sweepZombieSessions(
  repo: ReconcilerRepo, orchestrator: ReconcilerOrchestrator,
  onSessionFailed?: (id: string) => Promise<void>,
) {
```
…and after `await repo.setSessionStatus(s.id, "failed");` (reconciler.ts:53):

```ts
      await onSessionFailed?.(s.id).catch(() => {}); // cost settle — advisory, never blocks the sweep
```
…and thread it through `startReconciler`:

```ts
export function startReconciler(
  repo: ReconcilerRepo, orchestrator: ReconcilerOrchestrator,
  pendingSweep?: () => Promise<void>,
  onSessionFailed?: (id: string) => Promise<void>,
) {
  const sweep = () => {
    sweepZombieSessions(repo, orchestrator, onSessionFailed).catch((err) => console.warn("reconciler: sweep failed:", err));
    pendingSweep?.().catch((err) => console.warn("reconciler: pending-launch sweep failed:", err));
  };
```

`agents-api.ts` — add `settleSession?: (id: string) => Promise<void>` to the `opts` type of `registerAgentRoutes`. In `POST /v1/sessions/:id/status` (agents-api.ts:686-708), after `if (applied) deliverWebhooks(repo, id, b.status).catch(() => {});`:

```ts
    if (applied) opts?.settleSession?.(id).catch(() => {}); // final time-cost accrual (spec §4)
```
In `POST /v1/sessions/:id/interrupt` (agents-api.ts:647-658), after `await repo.setSessionStatus(id, "idle");`:

```ts
    await opts?.settleSession?.(id).catch(() => {});
```

`main.ts` — add the import and replace the `startReconciler(...)` call (main.ts:120):

```ts
import { settleSession, startCostSampler } from "./cost-sampler.ts";
```
```ts
// Time-cost sampler (spec 2026-07-14): pool/env pod-time + session billing.
const samplerDeps = { repo, kube, orchestrator };
startCostSampler(samplerDeps);
const settle = (id: string) => settleSession(samplerDeps, id);
startReconciler(repo, orchestrator, () => sweepPendingLaunches(repo, orchestrator, modelPhase), settle);
```
…and add `settleSession: settle` to the opts object of the `registerAgentRoutes(...)` call (main.ts:109) — note `settle` must be defined before that call; declare `const samplerDeps`/`const settle` above it and keep only `startCostSampler`/`startReconciler` below.

- [ ] **Step 5: Write the tests**

`control-plane/test/cost-sampler.test.ts` (fake deps, real `computeAccruals`):

```ts
// Sampler glue (spec §4): observation mapping, active-turn filter, settle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { costSamplerTick, settleSession, type SamplerDeps } from "../src/cost-sampler.ts";
import { DEFAULT_COST_SETTINGS, type CostEntryDraft } from "../src/costs.ts";

const ON = { ...DEFAULT_COST_SETTINGS, enabled: true, trackPoolCosts: true, trackEnvCosts: true,
  billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: true, billSessionTime: true } };

function fakeDeps(overrides: { orchestrator?: SamplerDeps["orchestrator"] } = {}) {
  const inserted: CostEntryDraft[] = [];
  const billed: [string, number][] = [];
  const deps: SamplerDeps = {
    repo: {
      getCostSettings: async () => ON,
      listResourcePrices: async () => [
        { kind: "pool", ref: "p", prices: { real: { podTime: { amount: 3600, per: "hour" } } } },
        { kind: "environment", ref: "env_1", prices: {
          real: { podTime: { amount: 3600, per: "hour" } },
          billing: { sessionTime: { amount: 3600, per: "hour" } } } },
      ],
      listRunningSessionsForBilling: async () => [
        { id: "sesn_a", workspace_id: "w", turns: 2, environment_id: "env_1" }],
      getSessionForBilling: async (id: string) =>
        id === "sesn_a" ? { id, workspace_id: "w", turns: 2, environment_id: "env_1" } : null,
      costWatermarks: async () => new Map([["dep:d", Date.now() - 60_000], ["sesn:sesn_a", Date.now() - 60_000]]),
      insertCostEntries: async (e) => { inserted.push(...e); },
      addSessionBilledCost: async (id, amount) => { billed.push([id, amount]); },
    },
    kube: { list: async () => [
      { metadata: { name: "d" }, spec: { poolRef: "p" }, status: { readyReplicas: 2 } },
      { metadata: { name: "zero" }, spec: { poolRef: "p" }, status: { readyReplicas: 0 } },
    ] },
    orchestrator: overrides.orchestrator ?? {
      sessionJobInfo: async () => ({ state: "active", startedAt: new Date(Date.now() - 90_000) }) },
  };
  return { deps, inserted, billed };
}

test("tick: replicas>0 accrue; zero-replica deployments skipped; active turn accrues both kinds", async () => {
  const { deps, inserted, billed } = fakeDeps();
  await costSamplerTick(deps);
  assert.equal(inserted.some((e) => e.kind === "pool_pod" && e.deployment === "d" && e.replicas === 2), true);
  assert.equal(inserted.some((e) => e.deployment === "zero"), false);
  assert.equal(inserted.some((e) => e.kind === "env_pod" && e.sessionId === "sesn_a"), true);
  assert.equal(billed.length, 1);
  assert.equal(billed[0][0], "sesn_a");
  assert.ok(Math.abs(billed[0][1] - 60) < 1.5); // ~60s at 1/s (watermark 60s ago)
});

test("tick: finished/missing turn pods accrue nothing (settle path owns the tail)", async () => {
  const { deps, inserted } = fakeDeps({
    orchestrator: { sessionJobInfo: async () => ({ state: "finished", startedAt: null }) } });
  await costSamplerTick(deps);
  assert.equal(inserted.some((e) => e.sessionId === "sesn_a"), false);
});

test("settle: accrues watermark→now for a known session; unknown session no-ops", async () => {
  const { deps, inserted } = fakeDeps();
  await settleSession(deps, "sesn_a");
  assert.equal(inserted.some((e) => e.kind === "session_time" && e.sessionId === "sesn_a"), true);
  const before = inserted.length;
  await settleSession(deps, "sesn_nope");
  assert.equal(inserted.length, before);
});
```

- [ ] **Step 6: Run**

Run: `cd control-plane && npx tsc --noEmit && node --test test/cost-sampler.test.ts && npm test`
Expected: new tests PASS; full suite still green (CP stopped first).

- [ ] **Step 7: Commit**

```bash
git add -A control-plane
git commit -m "feat(cp): 60s cost sampler + turn-end settle wired into status/interrupt/reconciler"
```

---

### Task 6: Console — currency helper, Settings page, nav entry

**Files:**
- Create: `console/app/lib/currency.ts`
- Create: `console/app/settings/page.tsx`
- Create: `console/app/settings/form.tsx`
- Modify: `console/app/nav.tsx:25` (insert Settings between API keys and Workspaces)
- Modify: `console/app/lib/icons.tsx` (add `settings` gear icon)

**Interfaces:**
- Consumes: `GET/PUT /v1/settings` (Task 1).
- Produces: `currencySymbol(code: string): string`, `fmtCost(amount: number, code: string): string` — EVERY later cost surface renders through `fmtCost`. Produces the `CostSettings` client type in `currency.ts` (single import point for client components).

- [ ] **Step 1: Currency helper**

`console/app/lib/currency.ts`:

```ts
// Currency is a display label only (spec 2026-07-14): ISO code in settings,
// symbol where one exists, no conversion ever.
export const CURRENCY_LABELS: [string, string][] = [
  ["EUR", "EUR (€)"], ["USD", "USD ($)"], ["GBP", "GBP (£)"], ["CHF", "CHF"], ["JPY", "JPY (¥)"],
];
const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", JPY: "¥" };

export const currencySymbol = (code: string) => SYMBOLS[code] ?? code;

/** 12.3456 → "12.35 €"; 0.00042 → "0.0004 €"; symbol-less codes suffix the code. */
export function fmtCost(amount: number, code: string): string {
  const n = amount >= 1 || amount === 0 ? amount.toFixed(2) : amount.toFixed(4);
  return `${n} ${currencySymbol(code)}`;
}

// Mirror of the CP CostSettings shape (control-plane/src/costs.ts).
export interface CostSettings {
  enabled: boolean;
  currency: string;
  trackPoolCosts: boolean;
  trackExternalCosts: boolean;
  trackEnvCosts: boolean;
  billing: {
    enabled: boolean;
    showSessionCosts: boolean;
    billSessionTime: boolean;
    billExternalTokens: boolean;
    billLocalTokens: boolean;
    billDeploymentTime: boolean;
  };
}
```

- [ ] **Step 2: Nav + icon**

In `console/app/lib/icons.tsx`, add to the `Icon` object (before the closing `};`):

```tsx
  settings: () => <S><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></S>,
```

In `console/app/nav.tsx:25`, replace the Manage group line with:

```tsx
  { title: "Manage", items: [["API keys", "/api-keys", "key"], ["Settings", "/settings", "settings"], ["Workspaces", "/workspaces", "workspace"]] },
```

- [ ] **Step 3: Settings page (server shell)**

`console/app/settings/page.tsx`:

```tsx
import { wsGet } from "../lib/api";
import type { CostSettings } from "../lib/currency";
import { SettingsForm } from "./form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const s = await wsGet<{ costs: CostSettings }>("/v1/settings").catch(() => null);
  return (
    <>
      <div className="pagehead"><h1>Settings</h1></div>
      <p className="sub">Platform-wide settings. Cost tracking and billing apply across all workspaces.</p>
      {s ? <SettingsForm initial={s.costs} /> : <div className="empty">Control plane unreachable.</div>}
    </>
  );
}
```

- [ ] **Step 4: Settings form (client)**

`console/app/settings/form.tsx`:

```tsx
"use client";
// Cost tracking & billing settings (spec 2026-07-14 §1). Explicit Save —
// toggles gate BOTH accrual and cost UI platform-wide.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Field, submitJson } from "../lib/modal";
import { CURRENCY_LABELS, type CostSettings } from "../lib/currency";

function Check({ label, hint, checked, onChange }: {
  label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "baseline" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}{hint && <span className="muted" style={{ display: "block", fontSize: 11 }}>{hint}</span>}</span>
    </label>
  );
}

export function SettingsForm({ initial }: { initial: CostSettings }) {
  const router = useRouter();
  const [c, setC] = useState<CostSettings>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (patch: Partial<CostSettings>) => setC({ ...c, ...patch });
  const setB = (patch: Partial<CostSettings["billing"]>) => setC({ ...c, billing: { ...c.billing, ...patch } });

  const save = async () => {
    setBusy(true); setMsg(null);
    const err = await submitJson("PUT", "/v1/settings", { costs: c });
    setBusy(false);
    setMsg(err ?? "Saved.");
    if (!err) router.refresh();
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <div className="group" style={{ padding: "6px 0 8px", fontWeight: 600 }}>Cost tracking</div>
      <Field label="Cost tracking" stack>
        <Check label="Enable cost tracking" checked={c.enabled}
               hint="master switch — off = nothing accrues and no cost UI anywhere"
               onChange={(v) => set({ enabled: v })} />
      </Field>
      {c.enabled && (<>
        <Field label="Currency" hint="display label only — changing it never converts amounts">
          <select value={c.currency} onChange={(e) => set({ currency: e.target.value })} style={{ width: 160, flex: "none" }}>
            {CURRENCY_LABELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="Track real costs" stack hint="what the platform costs YOU — infrastructure and external tokens">
          <Check label="Pool cost tracking" checked={c.trackPoolCosts}
                 hint="price per running engine replica, set on each pool"
                 onChange={(v) => set({ trackPoolCosts: v })} />
          <Check label="External deployment cost tracking" checked={c.trackExternalCosts}
                 hint="provider token prices, set on each external deployment"
                 onChange={(v) => set({ trackExternalCosts: v })} />
          <Check label="Environment cost tracking" checked={c.trackEnvCosts}
                 hint="price per running session pod, set on each environment"
                 onChange={(v) => set({ trackEnvCosts: v })} />
        </Field>
        <Field label="Billing" stack hint="what consumers are charged — may exceed real costs">
          <Check label="Enable billing" checked={c.billing.enabled} onChange={(v) => setB({ enabled: v })} />
        </Field>
        {c.billing.enabled && (
          <Field label=" " stack>
            <Check label="Show real-time costs in sessions" checked={c.billing.showSessionCosts}
                   hint="billed-cost chip next to the token chip in the session header"
                   onChange={(v) => setB({ showSessionCosts: v })} />
            <Check label="Session billing" checked={c.billing.billSessionTime}
                   hint="time price on environments; turn-pod runtime, charged per second"
                   onChange={(v) => setB({ billSessionTime: v })} />
            <Check label="External token billing" checked={c.billing.billExternalTokens}
                   hint="token prices on external deployments"
                   onChange={(v) => setB({ billExternalTokens: v })} />
            <Check label="Local token billing" checked={c.billing.billLocalTokens}
                   hint="token prices on local deployments"
                   onChange={(v) => setB({ billLocalTokens: v })} />
            <Check label="Time-based deployment billing" checked={c.billing.billDeploymentTime}
                   hint="price per running replica on local deployments; sums with local token billing"
                   onChange={(v) => setB({ billDeploymentTime: v })} />
          </Field>
        )}
      </>)}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
        <button disabled={busy} onClick={save}>{busy ? "Saving…" : "Save settings"}</button>
        {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Build + verify**

```
cd console && npx next build
```
Expected: build succeeds. Then restart `next start -p 7090` (console pins old chunk hashes if you skip the restart — see project memory), open `http://localhost:7090/settings`, toggle master on → sub-settings appear; Save → reload shows persisted state; nav shows Settings between API keys and Workspaces.

- [ ] **Step 6: Commit**

```bash
git add console/app/lib/currency.ts console/app/settings console/app/nav.tsx console/app/lib/icons.tsx
git commit -m "feat(console): global cost settings page + currency helper + nav entry"
```

---

### Task 7: Console — live session cost chip

**Files:**
- Modify: `console/app/sessions/[id]/use-session-live.ts` (Totals gains `billedCost`)
- Modify: `console/app/sessions/[id]/header.tsx` (cost chip right of the token chip)
- Modify: `console/app/sessions/[id]/page.tsx` (fetch `/v1/settings`, thread a `cost` prop)
- Modify: `console/app/sessions/[id]/trace.tsx` (pass-through prop)

**Interfaces:**
- Consumes: SSE `status` frames with `billed_cost` (Task 3); `fmtCost`, `CostSettings` (Task 6).
- Produces: `Totals` = `{ tokensIn: number; tokensOut: number; billedCost: number; turns: number }`; `SessionHeader` prop `cost?: { show: boolean; currency: string } | null`.

- [ ] **Step 1: Hook**

In `use-session-live.ts:8`, extend the interface:

```ts
export interface Totals { tokensIn: number; tokensOut: number; billedCost: number; turns: number; }
```
In the `status` listener (use-session-live.ts:33-37):

```ts
        setTotals({ tokensIn: s.tokens_in, tokensOut: s.tokens_out,
                    billedCost: Number(s.billed_cost ?? 0), turns: s.turns });
```
The server component that builds `initial.totals` (in `page.tsx`, search `tokensIn:`) must add `billedCost: Number(session.billed_cost ?? 0)` — sessions list/detail responses carry the column automatically (`SELECT *`).

- [ ] **Step 2: Header chip**

In `header.tsx`, add to the props type and destructuring: `cost?: { show: boolean; currency: string } | null`. After the token chip (header.tsx:49-51) insert:

```tsx
        {cost?.show && (
          <span className={live ? "chip tok-tick" : "chip"} key={`c${totals.billedCost}`}
                title="billed cost (tokens + session time)">
            {fmtCost(totals.billedCost, cost.currency)}
          </span>
        )}
```
with `import { fmtCost } from "../../lib/currency";` at the top.

- [ ] **Step 3: Thread the prop**

In `console/app/sessions/[id]/page.tsx`, fetch settings alongside the existing loads:

```ts
  const settings = await wsGet<{ costs: any }>("/v1/settings").catch(() => null);
  const cost = settings?.costs?.enabled && settings.costs.billing?.enabled && settings.costs.billing?.showSessionCosts
    ? { show: true, currency: settings.costs.currency as string } : null;
```
Pass `cost={cost}` into the `SessionView` (trace.tsx) component, add `cost` to `SessionView`'s props, and forward it to `<SessionHeader ... cost={cost} />`. trace.tsx only composes — the prop is pass-through.

- [ ] **Step 4: Verify live**

`npx next build` + restart console. With billing + chip enabled in Settings and a local-token price set (Task 8 not needed — insert a price via `curl -X PUT localhost:7080/v1/prices/deployment/<name> -H 'Content-Type: application/json' -d '{"prices":{"billing":{"tokens":{"inPerM":10,"outPerM":10}}}}'`), run a session turn: the cost chip appears right of the token chip and ticks together with it. With `showSessionCosts` off, no chip.

- [ ] **Step 5: Commit**

```bash
git add console/app/sessions
git commit -m "feat(console): live billed-cost chip in the session header"
```

---

### Task 8: Console — price fields in pool / deploy / environment dialogs

**Files:**
- Create: `console/app/lib/prices.tsx` (client helpers + shared field components)
- Modify: `console/app/pools/pool-modal.tsx`
- Modify: `console/app/deployments/deploy-modal.tsx`
- Modify: `console/app/environments/create.tsx`

**Interfaces:**
- Consumes: `GET /v1/settings`, `GET/PUT /v1/prices/:kind/:ref` (Tasks 1-2); `Field` (`app/lib/modal.tsx`); `currencySymbol`, `CostSettings` (Task 6).
- Produces (used by all three dialogs):

```tsx
// app/lib/prices.tsx
export interface TimePrice { amount: string; per: string }          // draft (string amount for inputs)
export interface TokenPrice { inPerM: string; outPerM: string }
export function useCostSettings(): CostSettings | null;             // fetches /v1/settings once
export function usePrice(kind: string, ref: string | undefined): { price: any | null; loaded: boolean };
export async function savePrice(kind: string, ref: string, prices: any): Promise<string | null>;
export function TimePriceField({ label, hint, value, onChange, currency, minuteOk }: {...}): JSX.Element;
export function TokenPriceField({ label, hint, value, onChange, currency }: {...}): JSX.Element;
export const timeDraft: (p: any) => TimePrice;                      // {amount,per} | undefined → draft
export const tokenDraft: (p: any) => TokenPrice;
export const timeOut: (d: TimePrice) => { amount: number; per: string } | undefined;  // "" → undefined
export const tokenOut: (d: TokenPrice) => { inPerM: number; outPerM: number } | undefined;
```

- [ ] **Step 1: The shared module**

`console/app/lib/prices.tsx`:

```tsx
"use client";
// Price plumbing for the pool/deploy/environment dialogs (spec 2026-07-14 §2).
// Dialogs save the resource first, then PUT the price — CRD routes carry no money.
import { useEffect, useState } from "react";
import { Field, submitJson } from "./modal";
import { wsHeader } from "./client";
import { currencySymbol, type CostSettings } from "./currency";

export interface TimePrice { amount: string; per: string }
export interface TokenPrice { inPerM: string; outPerM: string }

export function useCostSettings(): CostSettings | null {
  const [s, setS] = useState<CostSettings | null>(null);
  useEffect(() => {
    fetch("/api/v1/settings", { headers: wsHeader() })
      .then((r) => r.json()).then((j) => setS(j.costs ?? null)).catch(() => setS(null));
  }, []);
  return s;
}

export function usePrice(kind: string, ref: string | undefined) {
  const [price, setPrice] = useState<any | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!ref) { setLoaded(true); return; }
    fetch("/api/v1/prices", { headers: wsHeader() })
      .then((r) => r.json())
      .then((j) => {
        setPrice((j.prices ?? []).find((p: any) => p.kind === kind && p.ref === ref)?.prices ?? null);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [kind, ref]);
  return { price, loaded };
}

export const savePrice = (kind: string, ref: string, prices: any) =>
  submitJson("PUT", `/v1/prices/${kind}/${encodeURIComponent(ref)}`, { prices });

export const timeDraft = (p: any): TimePrice =>
  ({ amount: p?.amount != null ? String(p.amount) : "", per: p?.per ?? "hour" });
export const tokenDraft = (p: any): TokenPrice =>
  ({ inPerM: p?.inPerM != null ? String(p.inPerM) : "", outPerM: p?.outPerM != null ? String(p.outPerM) : "" });
export const timeOut = (d: TimePrice) =>
  d.amount.trim() !== "" && Number(d.amount) >= 0 ? { amount: Number(d.amount), per: d.per } : undefined;
export const tokenOut = (d: TokenPrice) =>
  d.inPerM.trim() !== "" || d.outPerM.trim() !== ""
    ? { inPerM: Number(d.inPerM) || 0, outPerM: Number(d.outPerM) || 0 } : undefined;

const UNITS = ["minute", "hour", "day", "month", "year"];

export function TimePriceField({ label, hint, value, onChange, currency, minuteOk = false }: {
  label: string; hint?: string; value: TimePrice; onChange: (v: TimePrice) => void;
  currency: string; minuteOk?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <input style={{ width: 110, flex: "none" }} value={value.amount} placeholder="0.00"
             onChange={(e) => onChange({ ...value, amount: e.target.value })} />
      <span className="muted">{currencySymbol(currency)} per</span>
      <select style={{ width: 110, flex: "none" }} value={value.per}
              onChange={(e) => onChange({ ...value, per: e.target.value })}>
        {UNITS.filter((u) => minuteOk || u !== "minute").map((u) => <option key={u} value={u}>{u}</option>)}
      </select>
    </Field>
  );
}

export function TokenPriceField({ label, hint, value, onChange, currency }: {
  label: string; hint?: string; value: TokenPrice; onChange: (v: TokenPrice) => void; currency: string;
}) {
  return (
    <Field label={label} hint={hint ?? `per 1,000,000 tokens, in ${currencySymbol(currency)}`}>
      <span className="muted">in</span>
      <input style={{ width: 90, flex: "none" }} value={value.inPerM} placeholder="0.00"
             onChange={(e) => onChange({ ...value, inPerM: e.target.value })} />
      <span className="muted">out</span>
      <input style={{ width: 90, flex: "none" }} value={value.outPerM} placeholder="0.00"
             onChange={(e) => onChange({ ...value, outPerM: e.target.value })} />
    </Field>
  );
}
```

- [ ] **Step 2: Pool modal** (`pool-modal.tsx`)

Imports: `import { useCostSettings, usePrice, savePrice, timeDraft, timeOut, TimePriceField, type TimePrice } from "../lib/prices";`

Inside `PoolModal`, after the `pendingBody` state (pool-modal.tsx:33):

```tsx
  const cost = useCostSettings();
  const showPoolPrice = !!cost?.enabled && cost.trackPoolCosts;
  const { price } = usePrice("pool", pool?.metadata?.name);
  const [podTime, setPodTime] = useState<TimePrice>(timeDraft(undefined));
  useEffect(() => { setPodTime(timeDraft(price?.real?.podTime)); }, [price]);
```
(add `useEffect` to the react import.)

In `send`, after a successful resource save and before `onClose()`:

```tsx
    if (!err && showPoolPrice) {
      const t = timeOut(podTime);
      const priceErr = await savePrice("pool", isEdit ? pool.metadata.name : d.name,
        t ? { real: { podTime: t } } : {});
      if (priceErr) return priceErr;   // surfaced in the modal banner; resource itself saved
    }
```
Before the final `</Modal>` closing children, add:

```tsx
      {showPoolPrice && (
        <TimePriceField label="Real cost" currency={cost!.currency} value={podTime} onChange={setPodTime}
          hint="what one running engine replica in this pool costs you (real-cost ledger)" />
      )}
```

- [ ] **Step 3: Deploy modal** (`deploy-modal.tsx`)

Imports as in Step 2 plus `tokenDraft, tokenOut, TokenPriceField, type TokenPrice`.

Inside `DeployModal`, after the pools effect (deploy-modal.tsx:79):

```tsx
  const cost = useCostSettings();
  const billOn = !!cost?.enabled && !!cost.billing.enabled;
  const showDepTime = isLocal && billOn && cost!.billing.billDeploymentTime;
  const showLocalTok = isLocal && billOn && cost!.billing.billLocalTokens;
  const showExtReal = !isLocal && !!cost?.enabled && cost.trackExternalCosts;
  const showExtBill = !isLocal && billOn && cost!.billing.billExternalTokens;
  const priceKind = isLocal ? "deployment" : "external";
  const priceRef = isLocal ? (ctx.name ?? undefined) : ctx.externalId;   // deploy modes: ref known only after create
  const { price } = usePrice(priceKind, priceRef);
  const [depTime, setDepTime] = useState<TimePrice>(timeDraft(undefined));
  const [locTok, setLocTok] = useState<TokenPrice>(tokenDraft(undefined));
  const [extReal, setExtReal] = useState<TokenPrice>(tokenDraft(undefined));
  const [extBill, setExtBill] = useState<TokenPrice>(tokenDraft(undefined));
  useEffect(() => {
    setDepTime(timeDraft(price?.billing?.podTime));
    setLocTok(tokenDraft(price?.billing?.tokens));
    setExtReal(tokenDraft(price?.real?.tokens));
    setExtBill(tokenDraft(price?.billing?.tokens));
  }, [price]);
```

In `doSubmit`, after `if (!err) { ... }` becomes: save price first, then close. Replace `if (!err) { onClose(); router.refresh(); }` with:

```tsx
    if (!err && (showDepTime || showLocalTok || showExtReal || showExtBill)) {
      let ref = priceRef;
      if (!ref && !isLocal) {   // deploy-remote: fetch the new row's id by name
        const j = await fetch("/api/v1/deployments", { headers: wsHeader() }).then((r) => r.json()).catch(() => null);
        ref = (j?.deployments ?? []).find((x: any) => x.name === name && x.kind === "external")?.externalId
           ?? (j?.deployments ?? []).find((x: any) => x.name === name)?.id;
      }
      if (!ref && isLocal) ref = name;    // local deployments are keyed by name
      if (ref) {
        const prices: any = {};
        if (isLocal) {
          const b: any = {};
          const t = timeOut(depTime); if (showDepTime && t) b.podTime = t;
          const k = tokenOut(locTok); if (showLocalTok && k) b.tokens = k;
          if (Object.keys(b).length) prices.billing = b;
        } else {
          const r = tokenOut(extReal); if (showExtReal && r) prices.real = { tokens: r };
          const k = tokenOut(extBill); if (showExtBill && k) prices.billing = { tokens: k };
        }
        const priceErr = await savePrice(priceKind, ref, prices);
        if (priceErr) return priceErr;
      }
    }
    if (!err) { onClose(); router.refresh(); }
```
NOTE for the implementer: check what `GET /v1/deployments` returns for external rows (see `server.ts:314-360` mapping — externals carry their row id). Use the actual field name for the external id in the lookup above; if the list does not expose it, extend the mapping in server.ts to include `externalId: e.id` for external entries (one-line change, keep it in this commit).

Before the closing `</>` of the LOCAL branch (after the Reasoning field, deploy-modal.tsx:240):

```tsx
        {showDepTime && (
          <TimePriceField label="Billing / time" currency={cost!.currency} value={depTime} onChange={setDepTime}
            hint="charged per running replica (billing ledger); sums with token billing" />
        )}
        {showLocalTok && (
          <TokenPriceField label="Billing / tokens" currency={cost!.currency} value={locTok} onChange={setLocTok} />
        )}
```
Before the closing `</>` of the REMOTE branch (after the Connection field, deploy-modal.tsx:268):

```tsx
        {showExtReal && (
          <TokenPriceField label="Real cost / tokens" currency={cost!.currency} value={extReal} onChange={setExtReal}
            hint="what the provider charges you per 1,000,000 tokens" />
        )}
        {showExtBill && (
          <TokenPriceField label="Billing / tokens" currency={cost!.currency} value={extBill} onChange={setExtBill}
            hint="what consumers are charged per 1,000,000 tokens" />
        )}
```

- [ ] **Step 4: Environment modal** (`environments/create.tsx`)

Imports as above. Inside `EnvironmentModal`, after the storage-classes effect (create.tsx:50):

```tsx
  const cost = useCostSettings();
  const showEnvReal = !!cost?.enabled && cost.trackEnvCosts;
  const showSesBill = !!cost?.enabled && cost.billing.enabled && cost.billing.billSessionTime;
  const { price } = usePrice("environment", env?.id);
  const [envTime, setEnvTime] = useState<TimePrice>(timeDraft(undefined));
  const [sesTime, setSesTime] = useState<TimePrice>(timeDraft(undefined));
  useEffect(() => {
    setEnvTime(timeDraft(price?.real?.podTime));
    setSesTime({ ...timeDraft(price?.billing?.sessionTime), per: price?.billing?.sessionTime?.per ?? "minute" });
  }, [price]);
```
In `submit`, environments respond with the row — for CREATE the new id is needed. Replace the tail of `submit` (`if (err) setError(err); else { onClose(); router.refresh(); }`) with:

```tsx
    if (!err && (showEnvReal || showSesBill)) {
      let ref = env?.id;
      if (!ref) {   // create: find the new row by name
        const j = await fetch("/api/v1/environments?limit=1000", { headers: wsHeader() })
          .then((r) => r.json()).catch(() => null);
        ref = (j?.environments ?? j?.rows ?? []).find((x: any) => x.name === form.name)?.id;
      }
      if (ref) {
        const prices: any = {};
        const t = timeOut(envTime); if (showEnvReal && t) prices.real = { podTime: t };
        const s = timeOut(sesTime); if (showSesBill && s) prices.billing = { sessionTime: s };
        const priceErr = await savePrice("environment", ref, prices);
        if (priceErr) { setError(priceErr); return; }
      }
    }
    if (err) setError(err); else { onClose(); router.refresh(); }
```
(add `wsHeader` to the client import; check the actual list-response field name of `GET /v1/environments` and match it.)

Before the closing `</Modal>`:

```tsx
      {showEnvReal && (
        <TimePriceField label="Real cost" currency={cost!.currency} value={envTime} onChange={setEnvTime}
          hint="what one running session pod in this environment costs you" />
      )}
      {showSesBill && (
        <TimePriceField label="Session billing" currency={cost!.currency} value={sesTime} onChange={setSesTime}
          minuteOk hint="charged on turn-pod runtime, per second; minute...year units" />
      )}
```

- [ ] **Step 5: Build + verify**

`npx next build` + restart. With all toggles on: pool modal shows Real cost; local deploy edit shows Billing time+tokens; remote edit shows Real+Billing token prices; environment modal shows Real cost + Session billing (with minute). Toggles off ⇒ fields gone. Save, reopen ⇒ values prefilled. Clearing a field and saving deletes that sub-object (verify via `curl localhost:7080/v1/prices`).

- [ ] **Step 6: Commit**

```bash
git add console/app/lib/prices.tsx console/app/pools/pool-modal.tsx console/app/deployments/deploy-modal.tsx console/app/environments/create.tsx
git commit -m "feat(console): price fields in pool/deploy/environment dialogs"
```

---

### Task 9: Deployment Stats tab — cost boxes + cost chart

**Files:**
- Modify: `control-plane/src/costs.ts` (add `spreadCostEntries`)
- Modify: `control-plane/src/repo.ts` (`deploymentStats` cost extension, repo.ts:1036-1068; new `deploymentTimeCosts` query)
- Modify: `control-plane/src/agents-api.ts:321-331` (stats route attaches costs)
- Create: `console/app/lib/area-chart.tsx` (AreaChart moved here + new CostChart)
- Modify: `console/app/deployments/[name]/stats.tsx` (import charts; cost boxes; cost chart; "tokens only" hint)
- Test: `control-plane/test/costs-spread.test.ts`

**Interfaces:**
- Consumes: `gateway_usage.real_cost/billed_cost` (Task 3), `cost_entries` (Task 5), `fmtCost` (Task 6), `repo.getCostSettings` (Task 1).
- Produces:

```ts
// costs.ts
export function spreadCostEntries(
  entries: { tsMs: number; seconds: number; realCost: number; billedCost: number }[],
  t0Sec: number, bucketSec: number, count: number,
): { real: number[]; billed: number[] };   // per-bucket allocations, bucket i covers [t0+i*b, t0+(i+1)*b)
```
- Produces: stats response buckets gain `real_cost`/`billed_cost` (numbers) and totals gain the same, plus top-level `costs: { currency: string; tokensOnly: boolean } | null` (null = tracking off → UI renders no cost surfaces).
- Produces: `console/app/lib/area-chart.tsx` exporting `AreaChart` (existing behavior, unchanged props) and `CostChart({ buckets, bucketSeconds, currency })` where buckets carry `t/real_cost/billed_cost`.

- [ ] **Step 1: spreadCostEntries + test**

Append to `control-plane/src/costs.ts`:

```ts
/** Allocate ledger entries (each spans [ts - seconds, ts]) proportionally
 *  across fixed buckets so 60s-grain entries don't spike in 10s charts. */
export function spreadCostEntries(
  entries: { tsMs: number; seconds: number; realCost: number; billedCost: number }[],
  t0Sec: number, bucketSec: number, count: number,
): { real: number[]; billed: number[] } {
  const real = new Array<number>(count).fill(0);
  const billed = new Array<number>(count).fill(0);
  for (const e of entries) {
    const end = e.tsMs / 1000;
    const start = end - Math.max(e.seconds, 0.001);
    const span = end - start;
    const first = Math.max(0, Math.floor((start - t0Sec) / bucketSec));
    const last = Math.min(count - 1, Math.floor((end - t0Sec) / bucketSec));
    for (let i = first; i <= last; i++) {
      const bStart = t0Sec + i * bucketSec;
      const overlap = Math.min(end, bStart + bucketSec) - Math.max(start, bStart);
      if (overlap <= 0) continue;
      const f = overlap / span;
      real[i] += e.realCost * f;
      billed[i] += e.billedCost * f;
    }
  }
  return { real, billed };
}
```

`control-plane/test/costs-spread.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spreadCostEntries } from "../src/costs.ts";

test("60s entry spreads evenly across six 10s buckets", () => {
  const t0 = 1000;
  const { real } = spreadCostEntries(
    [{ tsMs: (t0 + 60) * 1000, seconds: 60, realCost: 6, billedCost: 0 }], t0, 10, 6);
  for (const v of real) assert.ok(Math.abs(v - 1) < 1e-9);
});

test("entry partially outside the window allocates only the overlap", () => {
  const t0 = 1000;
  const { billed } = spreadCostEntries(
    [{ tsMs: (t0 + 30) * 1000, seconds: 60, realCost: 0, billedCost: 6 }], t0, 10, 6);
  // span [t0-30, t0+30): only [t0, t0+30) is inside → 3 of 6 allocated.
  assert.ok(Math.abs(billed.reduce((a, b) => a + b, 0) - 3) < 1e-9);
});
```
Run: `cd control-plane && node --test test/costs-spread.test.ts` — PASS.

- [ ] **Step 2: repo.deploymentStats costs**

In `repo.ts`, extend the `deploymentStats` opts with `costs?: { includeTime: boolean }` and:

1. Add cost sums to the bucket query (repo.ts:1047-1050):

```ts
      `SELECT (floor(extract(epoch FROM created_at) / ${bs}) * ${bs})::bigint AS t,
              COALESCE(sum(tokens_in),0)::bigint AS tokens_in,
              COALESCE(sum(tokens_out),0)::bigint AS tokens_out, count(*)::int AS requests,
              COALESCE(sum(real_cost),0)::numeric AS real_cost,
              COALESCE(sum(billed_cost),0)::numeric AS billed_cost
       FROM gateway_usage WHERE ${conds.join(" AND ")} GROUP BY 1`, params);
```
2. In the zero-fill loop add to each bucket object `real_cost: Number(r?.real_cost ?? 0), billed_cost: Number(r?.billed_cost ?? 0)` and accumulate `totals.real_cost`/`totals.billed_cost` (initialize totals as `{ tokens_in: 0, tokens_out: 0, requests: 0, real_cost: 0, billed_cost: 0 }`).
3. When `opts.costs?.includeTime`, fetch time entries and spread them:

```ts
    if (opts.costs?.includeTime) {
      const { rows: te } = await this.pool.query(
        `SELECT ts, seconds, COALESCE(real_cost,0) AS real_cost, COALESCE(billed_cost,0) AS billed_cost
         FROM cost_entries
         WHERE deployment = $1 AND kind IN ('pool_pod','deployment_time')
           AND ts > now() - make_interval(secs => $2)`,
        [model, opts.windowSec + 120]);   // +gap so an entry spanning the window edge contributes
      const { spreadCostEntries } = await import("./costs.ts");
      const { real, billed } = spreadCostEntries(
        te.map((r: any) => ({ tsMs: new Date(r.ts).getTime(), seconds: Number(r.seconds),
          realCost: Number(r.real_cost), billedCost: Number(r.billed_cost) })),
        t0, opts.bucketSec, buckets.length);
      buckets.forEach((b: any, i: number) => { b.real_cost += real[i]; b.billed_cost += billed[i]; });
      totals.real_cost += real.reduce((a, b) => a + b, 0);
      totals.billed_cost += billed.reduce((a, b) => a + b, 0);
    }
```
(Use a top-of-file static import instead of the dynamic import — `import { spreadCostEntries } from "./costs.ts";` — the inline form above only marks where it's used.)

- [ ] **Step 3: Stats route**

Replace the handler body of `GET /v1/deployments/:name/stats` (agents-api.ts:321-331):

```ts
  app.get("/v1/deployments/:name/stats", async (req, reply) => {
    const q = req.query as { window?: string; api_key?: string; agent?: string };
    const win = STAT_WINDOWS[q.window ?? "5m"];
    if (!win) return reply.code(400).send({ error: `window must be one of ${Object.keys(STAT_WINDOWS).join("|")}` });
    const opts: any = { ...win };
    if (q.api_key === "__internal__") opts.sessionOnly = true;
    else if (q.api_key) opts.apiKeyId = q.api_key;
    if (q.agent) opts.agentId = q.agent;
    // Cost columns ride along when tracking is on; time-based entries are
    // deployment-wide and not key/agent-attributable — filtered views show
    // token costs only (spec §5).
    const settings = await repo.getCostSettings();
    const tokensOnly = !!(opts.apiKeyId || opts.agentId || opts.sessionOnly);
    if (settings.enabled) opts.costs = { includeTime: !tokensOnly };
    const stats = await repo.deploymentStats((req.params as any).name, opts);
    return { window: q.window ?? "5m", bucketSeconds: win.bucketSec, ...stats,
      costs: settings.enabled ? { currency: settings.currency, tokensOnly } : null };
  });
```

- [ ] **Step 4: Extract charts to `console/app/lib/area-chart.tsx`**

Move `niceMax`, `smoothPath`, the `Bucket` interface, and the whole `AreaChart` component out of `stats.tsx` verbatim into the new file (keep the `"use client"` directive and the `fmt` helper they use); export `AreaChart`. Then add `CostChart` to the same file — a two-line overlay variant (NOT stacked; billed can exceed real):

```tsx
export interface CostBucket { t: number; real_cost: number; billed_cost: number }

export function CostChart({ buckets, bucketSeconds, currency }: {
  buckets: CostBucket[]; bucketSeconds: number; currency: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const n = buckets.length;
  const maxVal = Math.max(1e-6, ...buckets.map((b) => Math.max(b.real_cost, b.billed_cost)));
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const y = (v: number) => 100 - (v / maxVal) * 100;
  const realPath = smoothPath(buckets.map((b, i) => [x(i), y(b.real_cost)] as [number, number]));
  const billPath = smoothPath(buckets.map((b, i) => [x(i), y(b.billed_cost)] as [number, number]));
  const short = bucketSeconds < 60;
  const tLabel = (t: number) => new Date(t * 1000).toLocaleTimeString([],
    short ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
  const step = Math.ceil(n / 5);
  const hb = hover != null ? buckets[hover] : null;
  const fmtC = (v: number) => `${v >= 1 || v === 0 ? v.toFixed(2) : v.toFixed(4)}`;
  return (
    <div className="rt2">
      <div className="rt2-y"><span>{fmtC(maxVal)}</span><span>{fmtC(maxVal / 2)}</span><span>0</span></div>
      <div className="rt2-plot"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n))));
        }}
        onMouseLeave={() => setHover(null)}>
        <div className="rt2-grid" style={{ top: "0%" }} />
        <div className="rt2-grid" style={{ top: "50%" }} />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none">
          <path className="rt2-line-in" d={realPath} />
          <path className="rt2-line-out" d={billPath} />
        </svg>
        {hb && (
          <>
            <div className="rt2-cursor" style={{ left: `${x(hover!)}%` }} />
            <div className="rt2-tip" style={{ left: `${x(hover!)}%`, ...(x(hover!) > 70 ? { transform: "translateX(-105%)" } : {}) }}>
              <div className="rt2-tip-t">{tLabel(hb.t)} · {bucketSeconds}s bucket</div>
              <div><span style={{ color: "var(--blue)" }}>■</span> real <b>{fmtC(hb.real_cost)} {currency}</b></div>
              <div><span style={{ color: "#d97706" }}>■</span> billed <b>{fmtC(hb.billed_cost)} {currency}</b></div>
            </div>
          </>
        )}
        <span className="rt2-yunit">{currency} / {bucketSeconds}s</span>
      </div>
      <div className="rt2-x">
        {buckets.map((b, i) => (i % step === 0
          ? <span key={b.t} style={{ left: `${x(i)}%` }}>{tLabel(b.t)}</span> : null))}
        <span className="rt2-xunit">time</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: stats.tsx UI**

In `stats.tsx`: import `{ AreaChart, CostChart }` from `../../lib/area-chart` and `{ fmtCost, currencySymbol }` from `../../lib/currency`; delete the moved helpers/component; extend the `Stats` interface:

```ts
interface Stats {
  bucketSeconds: number;
  buckets: (Bucket & { real_cost: number; billed_cost: number })[];
  totals: { tokens_in: number; tokens_out: number; requests: number; real_cost: number; billed_cost: number };
  costs: { currency: string; tokensOnly: boolean } | null;
}
```
After the Requests card (stats.tsx:169), add:

```tsx
        {stats?.costs && (<>
          <div className="card"><h3>Real cost{stats.costs.tokensOnly ? " (tokens only)" : ""}</h3>
            <div className="big">{fmtCost(stats.totals.real_cost, stats.costs.currency)}</div></div>
          <div className="card"><h3>Billed cost{stats.costs.tokensOnly ? " (tokens only)" : ""}</h3>
            <div className="big">{fmtCost(stats.totals.billed_cost, stats.costs.currency)}</div></div>
        </>)}
```
After the tokens chart block (stats.tsx:179-181), add:

```tsx
      {stats?.costs && (<>
        <div className="group" style={{ padding: "14px 0 8px" }}>
          Cost per {stats.bucketSeconds}s
          <span style={{ marginLeft: 12, fontSize: 11, color: "var(--muted)" }}>
            <span style={{ color: "var(--blue)" }}>■</span> real&nbsp;&nbsp;
            <span style={{ color: "#d97706" }}>■</span> billed{stats.costs.tokensOnly ? " · tokens only (filter active)" : ""}
          </span>
        </div>
        {stats.buckets.length
          ? <CostChart buckets={stats.buckets} bucketSeconds={stats.bucketSeconds}
                       currency={currencySymbol(stats.costs.currency)} />
          : <div className="empty">No cost data yet.</div>}
      </>)}
```

- [ ] **Step 6: Run + verify**

`cd control-plane && npx tsc --noEmit && node --test test/costs-spread.test.ts` — PASS. `cd console && npx next build` — succeeds. Restart both; on a deployment detail Stats tab with tracking on: two cost boxes + cost chart; selecting an API key adds the "(tokens only)" hint; master off ⇒ no cost UI at all.

- [ ] **Step 7: Commit**

```bash
git add -A control-plane console
git commit -m "feat: deployment stats cost boxes + real/billed cost chart"
```

---

### Task 10: Usage queries — costs, all-workspaces, session usage rebuild, summary

**Files:**
- Modify: `control-plane/src/repo.ts` (`gatewayUsage` at :544-587; DELETE `workspaceUsage` at :516-540; new `sessionUsage`, `usageSummary`, `listAllApiKeys`)
- Modify: `control-plane/src/agents-api.ts` (usage routes :721-733; api-keys route :736-741)
- Test: `control-plane/test/usage-costs.test.ts`

**Interfaces:**
- Consumes: cost columns (Task 3), `cost_entries` (Task 5), `rangeWindow` (`src/usage-range.ts`).
- Produces:
  - `repo.gatewayUsage(workspaceId, { range, deployment, apiKeyId, allWorkspaces })` — every row set gains `real_cost`/`billed_cost` numbers; `allWorkspaces: true` drops the workspace condition.
  - `repo.sessionUsage(workspaceId | null, { range, deployment })` → `{ bucket, buckets[], totals, byDeployment[], sessionsCount, timeCosts: { real, billed } | null }` — token data from `gateway_usage(source='session')`; `timeCosts` from `cost_entries(env_pod, session_time)`, null when a deployment filter is active (env/session entries carry no deployment).
  - `repo.usageSummary(workspaceId | null, { range, deployment, apiKeyId })` → `{ bucket, buckets[], totals }` where buckets carry tokens + requests + costs across BOTH sources, cost buckets merged from `cost_entries` grouped per day/week. Key-filtered ⇒ token costs only (`tokensOnly: true` in the result).
  - `repo.listAllApiKeys()` → keys across all workspaces with `workspace_name`.
  - Routes: `GET /v1/usage/gateway?range&deployment&api_key&workspaces=all`; `GET /v1/usage?range&deployment&workspaces=all` (REPLACES the old rollup — `workspaceUsage` is deleted); `GET /v1/usage/summary?range&deployment&api_key&workspaces=all`; `GET /v1/api-keys?all=1`.
  - Every usage response gains `costs: { currency } | null` (from settings; null = master off).

- [ ] **Step 1: gatewayUsage extension**

In `repo.ts:544-587`: add `allWorkspaces?: boolean` to opts. Build conditions:

```ts
    const conds = ["u.created_at >= $1", "u.source = 'api'"];
    const params: unknown[] = [start];
    if (!opts.allWorkspaces) { params.push(workspaceId); conds.push(`u.workspace_id = $${params.length}`); }
```
(keep the rest of the filter logic; renumber the placeholders accordingly). Add to EVERY select (buckets/totals/byDeployment/byKey):

```sql
COALESCE(sum(u.real_cost),0)::numeric AS real_cost,
COALESCE(sum(u.billed_cost),0)::numeric AS billed_cost
```
and extend `num()`:

```ts
    const num = (r: any) => ({ ...r, tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out),
      requests: Number(r.requests), real_cost: Number(r.real_cost ?? 0), billed_cost: Number(r.billed_cost ?? 0) });
```

- [ ] **Step 2: sessionUsage (replaces workspaceUsage — delete repo.ts:516-540)**

```ts
  /** Session usage from gateway_usage(source='session') — the only basis that
   *  supports range/deployment/workspace filters (the old sessions-table
   *  rollup had NO time filter on byModel and summed lifetime tokens).
   *  Time costs (env_pod real / session_time billed) attach when no
   *  deployment filter is set — those entries carry no deployment. */
  async sessionUsage(workspaceId: string | null, opts: { range?: string; deployment?: string } = {}) {
    const { start, end, bucket } = rangeWindow(opts.range ?? "7d");
    const conds = ["u.created_at >= $1", "u.source = 'session'"];
    const params: unknown[] = [start];
    if (end) { params.push(end); conds.push(`u.created_at < $${params.length}`); }
    if (workspaceId) { params.push(workspaceId); conds.push(`u.workspace_id = $${params.length}`); }
    if (opts.deployment) { params.push(opts.deployment); conds.push(`u.model = $${params.length}`); }
    const where = conds.join(" AND ");
    const num = (r: any) => ({ ...r, tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out),
      requests: Number(r.requests ?? 0), sessions: Number(r.sessions ?? 0),
      real_cost: Number(r.real_cost ?? 0), billed_cost: Number(r.billed_cost ?? 0) });

    const sums = `COALESCE(sum(u.tokens_in),0)::bigint AS tokens_in,
                  COALESCE(sum(u.tokens_out),0)::bigint AS tokens_out, count(*)::int AS requests,
                  COALESCE(sum(u.real_cost),0)::numeric AS real_cost,
                  COALESCE(sum(u.billed_cost),0)::numeric AS billed_cost`;
    const [buckets, totals, byDeployment] = await Promise.all([
      this.pool.query(
        `SELECT to_char(date_trunc('${bucket}', u.created_at), 'YYYY-MM-DD') AS bucket, ${sums}
         FROM gateway_usage u WHERE ${where} GROUP BY 1 ORDER BY 1`, params),
      this.pool.query(`SELECT ${sums} FROM gateway_usage u WHERE ${where}`, params),
      this.pool.query(
        `SELECT u.model, count(DISTINCT u.session_id)::int AS sessions, ${sums}
         FROM gateway_usage u WHERE ${where} GROUP BY 1 ORDER BY 3 DESC`, params),
    ]);

    // Sessions started in-range (kept from the old card, now range-aware).
    const sConds = ["created_at >= $1"]; const sParams: unknown[] = [start];
    if (end) { sParams.push(end); sConds.push(`created_at < $${sParams.length}`); }
    if (workspaceId) { sParams.push(workspaceId); sConds.push(`workspace_id = $${sParams.length}`); }
    const { rows: sc } = await this.pool.query(
      `SELECT count(*)::int AS n FROM sessions WHERE ${sConds.join(" AND ")}`, sParams);

    // Time costs — env/session ledger kinds; not deployment-attributable.
    let timeCosts: { real: number; billed: number } | null = null;
    if (!opts.deployment) {
      const tConds = ["ts >= $1", "kind IN ('env_pod','session_time')"];
      const tParams: unknown[] = [start];
      if (end) { tParams.push(end); tConds.push(`ts < $${tParams.length}`); }
      if (workspaceId) { tParams.push(workspaceId); tConds.push(`workspace_id = $${tParams.length}`); }
      const { rows: tc } = await this.pool.query(
        `SELECT COALESCE(sum(real_cost),0)::numeric AS real, COALESCE(sum(billed_cost),0)::numeric AS billed
         FROM cost_entries WHERE ${tConds.join(" AND ")}`, tParams);
      timeCosts = { real: Number(tc[0].real), billed: Number(tc[0].billed) };
    }
    return {
      bucket,
      buckets: buckets.rows.map(num),
      totals: num(totals.rows[0]),
      byDeployment: byDeployment.rows.map(num),
      sessionsCount: Number(sc[0].n),
      timeCosts,
    };
  }
```

- [ ] **Step 3: usageSummary + listAllApiKeys**

```ts
  /** Dashboard cross-deployment rollup: tokens + costs over BOTH sources,
   *  day/week buckets, plus ledger time-costs merged per bucket. Key filter ⇒
   *  token costs only (time entries aren't key-attributable, spec §5/§6).
   *  Ledger scope: pool_pod/deployment_time are global infra (no workspace);
   *  env_pod/session_time honor the workspace scope. */
  async usageSummary(workspaceId: string | null,
    opts: { range?: string; deployment?: string; apiKeyId?: string } = {}) {
    const { start, end, bucket } = rangeWindow(opts.range ?? "7d");
    const conds = ["u.created_at >= $1"]; const params: unknown[] = [start];
    if (end) { params.push(end); conds.push(`u.created_at < $${params.length}`); }
    if (workspaceId) { params.push(workspaceId); conds.push(`u.workspace_id = $${params.length}`); }
    if (opts.deployment) { params.push(opts.deployment); conds.push(`u.model = $${params.length}`); }
    if (opts.apiKeyId === "__deleted__") conds.push("u.api_key_id IS NULL AND u.source = 'api'");
    else if (opts.apiKeyId) { params.push(opts.apiKeyId); conds.push(`u.api_key_id = $${params.length}`); }
    const where = conds.join(" AND ");
    const sums = `COALESCE(sum(u.tokens_in),0)::bigint AS tokens_in,
                  COALESCE(sum(u.tokens_out),0)::bigint AS tokens_out, count(*)::int AS requests,
                  COALESCE(sum(u.real_cost),0)::numeric AS real_cost,
                  COALESCE(sum(u.billed_cost),0)::numeric AS billed_cost`;
    const num = (r: any) => ({ ...r, tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out),
      requests: Number(r.requests), real_cost: Number(r.real_cost ?? 0), billed_cost: Number(r.billed_cost ?? 0) });
    const [bRes, tRes] = await Promise.all([
      this.pool.query(`SELECT to_char(date_trunc('${bucket}', u.created_at), 'YYYY-MM-DD') AS bucket, ${sums}
                       FROM gateway_usage u WHERE ${where} GROUP BY 1 ORDER BY 1`, params),
      this.pool.query(`SELECT ${sums} FROM gateway_usage u WHERE ${where}`, params),
    ]);
    const buckets = bRes.rows.map(num);
    const totals = num(tRes.rows[0]);
    const tokensOnly = !!opts.apiKeyId;
    if (!tokensOnly) {
      const tConds = ["ts >= $1",
        `(kind IN ('pool_pod','deployment_time')${workspaceId ? " OR workspace_id = $WS" : " OR kind IN ('env_pod','session_time')"})`];
      const tParams: unknown[] = [start];
      if (end) { tParams.push(end); tConds.push(`ts < $${tParams.length}`); }
      if (opts.deployment) { tParams.push(opts.deployment);
        tConds.push(`(deployment = $${tParams.length} OR deployment IS NULL AND false)`); }
      let sql = tConds.join(" AND ");
      if (workspaceId) { tParams.push(workspaceId); sql = sql.replace("$WS", `$${tParams.length}`); }
      const { rows: te } = await this.pool.query(
        `SELECT to_char(date_trunc('${bucket}', ts), 'YYYY-MM-DD') AS bucket,
                COALESCE(sum(real_cost),0)::numeric AS real, COALESCE(sum(billed_cost),0)::numeric AS billed
         FROM cost_entries WHERE ${sql} GROUP BY 1`, tParams);
      const byB = new Map(buckets.map((b: any) => [b.bucket, b]));
      for (const r of te) {
        const b = byB.get(r.bucket) ?? (() => {
          const nb = { bucket: r.bucket, tokens_in: 0, tokens_out: 0, requests: 0, real_cost: 0, billed_cost: 0 };
          buckets.push(nb); byB.set(r.bucket, nb); return nb;
        })();
        b.real_cost += Number(r.real); b.billed_cost += Number(r.billed);
        totals.real_cost += Number(r.real); totals.billed_cost += Number(r.billed);
      }
      buckets.sort((a: any, b: any) => (a.bucket < b.bucket ? -1 : 1));
    }
    return { bucket, buckets, totals, tokensOnly };
  }

  /** Cross-workspace key list for the all-workspaces usage filter. */
  async listAllApiKeys() {
    const { rows } = await this.pool.query(
      `SELECT k.id, k.name, k.status, k.workspace_id, w.name AS workspace_name
       FROM api_keys k LEFT JOIN workspaces w ON w.id = k.workspace_id
       ORDER BY k.created_at DESC LIMIT 1000`);
    return rows;
  }
```
Note on the deployment filter for time entries: when `opts.deployment` is set, ONLY `pool_pod`/`deployment_time` rows of that deployment qualify (`deployment = $n`); env/session entries are excluded (the false-branch in the condition). Simplify the generated SQL if you find a cleaner equivalent — behavior above is the contract. Delete `workspaceUsage` (repo.ts:516-540) — `sessionUsage` replaces it; also update the comment at repo.ts:549-550 ("Billing/usage views only see external API traffic") to say API usage = source='api', session usage = source='session' (rule revoked by spec 2026-07-14).

- [ ] **Step 4: Routes**

Replace the usage routes (agents-api.ts:721-733):

```ts
  // Analytics (spec 2026-07-14): session usage from gateway_usage(source='session').
  app.get("/v1/usage", async (req) => {
    const q = req.query as { range?: string; deployment?: string; workspaces?: string };
    const settings = await repo.getCostSettings();
    const usage = await repo.sessionUsage(q.workspaces === "all" ? null : ws(req), {
      range: q.range ?? "7d", ...(q.deployment ? { deployment: q.deployment } : {}) });
    return { ...usage, costs: settings.enabled ? { currency: settings.currency } : null };
  });

  // Gateway-metered API usage (external clients via API keys).
  app.get("/v1/usage/gateway", async (req) => {
    const q = req.query as { range?: string; deployment?: string; api_key?: string; workspaces?: string };
    const settings = await repo.getCostSettings();
    const usage = await repo.gatewayUsage(ws(req), {
      range: q.range ?? "7d",
      ...(q.deployment ? { deployment: q.deployment } : {}),
      ...(q.api_key ? { apiKeyId: q.api_key } : {}),
      ...(q.workspaces === "all" ? { allWorkspaces: true } : {}),
    });
    return { ...usage, costs: settings.enabled ? { currency: settings.currency } : null };
  });

  // Cross-deployment rollup for the dashboard usage panel.
  app.get("/v1/usage/summary", async (req) => {
    const q = req.query as { range?: string; deployment?: string; api_key?: string; workspaces?: string };
    const settings = await repo.getCostSettings();
    const usage = await repo.usageSummary(q.workspaces === "all" ? null : ws(req), {
      range: q.range ?? "7d",
      ...(q.deployment ? { deployment: q.deployment } : {}),
      ...(q.api_key ? { apiKeyId: q.api_key } : {}),
    });
    return { ...usage, costs: settings.enabled ? { currency: settings.currency } : null };
  });
```
API keys route (agents-api.ts:736-741) — add the cross-workspace variant at the top of the handler:

```ts
    if ((req.query as any)?.all === "1") return { keys: await repo.listAllApiKeys(), count: 0, offset: 0 };
```

- [ ] **Step 5: Test**

`control-plane/test/usage-costs.test.ts`:

```ts
// Usage queries with costs (spec §6): gatewayUsage cost sums + allWorkspaces,
// sessionUsage basis + timeCosts, usageSummary bucket merge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { DEFAULT_COST_SETTINGS } from "../src/costs.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

test("usage queries aggregate stamped costs and ledger entries", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const before = await repo.getCostSettings();
  const ws = (await repo.createWorkspace(`t-uc-${Date.now()}`)).id;
  const model = `t-uc-dep-${Date.now()}`;
  try {
    await repo.putResourcePrice("deployment", model, { billing: { tokens: { inPerM: 10, outPerM: 10 } } });
    await repo.putCostSettings({ ...DEFAULT_COST_SETTINGS, enabled: true,
      billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: true, billLocalTokens: true } });
    // API row (stamped by the 031 trigger) + session row + a ledger entry.
    const key = await repo.createApiKey(ws, `t-uc-${Date.now()}`);
    await pool.query(
      `INSERT INTO gateway_usage (workspace_id, api_key_id, model, tokens_in, tokens_out, source)
       VALUES ($1, $2, $3, 1000000, 0, 'api')`, [ws, key.id, model]);
    await pool.query(
      `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, source, session_id)
       VALUES ($1, $2, 0, 1000000, 'session', 'sesn_uc')`, [ws, model]);
    await repo.insertCostEntries([{ kind: "session_time", environmentId: "env_x", sessionId: "sesn_uc",
      workspaceId: ws, seconds: 60, realCost: null, billedCost: 2 }]);

    const gw = await repo.gatewayUsage(ws, { range: "1d" });
    assert.equal(gw.totals.billed_cost, 10);            // api row only
    assert.equal(gw.totals.requests, 1);
    const gwAll = await repo.gatewayUsage("wrkspc_other", { range: "1d", allWorkspaces: true });
    assert.ok(gwAll.totals.requests >= 1);              // scope dropped

    const su = await repo.sessionUsage(ws, { range: "1d" });
    assert.equal(su.totals.billed_cost, 10);            // session token row
    assert.equal(su.byDeployment[0].model, model);
    assert.equal(su.byDeployment[0].sessions, 1);
    assert.equal(su.timeCosts!.billed, 2);              // ledger entry
    const suDep = await repo.sessionUsage(ws, { range: "1d", deployment: model });
    assert.equal(suDep.timeCosts, null);                // deployment filter ⇒ tokens only

    const sum = await repo.usageSummary(ws, { range: "1d" });
    assert.equal(sum.totals.billed_cost, 22);           // 10 api + 10 session + 2 ledger
    assert.equal(sum.tokensOnly, false);
    const sumKey = await repo.usageSummary(ws, { range: "1d", apiKeyId: key.id });
    assert.equal(sumKey.totals.billed_cost, 10);        // key filter ⇒ token costs only
    assert.equal(sumKey.tokensOnly, true);
  } finally {
    await repo.putCostSettings(before);
    await repo.deleteResourcePrice("deployment", model);
    await pool.query("DELETE FROM gateway_usage WHERE workspace_id = $1", [ws]);
    await pool.query("DELETE FROM cost_entries WHERE workspace_id = $1", [ws]);
  }
});
```

- [ ] **Step 6: Run**

Run: `cd control-plane && npx tsc --noEmit && node --test test/usage-costs.test.ts && npm test`
Expected: PASS; the full suite catches any `workspaceUsage` stragglers (fix call sites the compiler finds — the console fetch is updated in Task 11).

- [ ] **Step 7: Commit**

```bash
git add -A control-plane
git commit -m "feat(cp): usage queries with costs, all-workspaces scope, session-usage rebuild, summary endpoint"
```

---

### Task 11: Usage page rebuild

**Files:**
- Create: `console/app/lib/usage-bars.tsx` (shared bar chart — replaces BOTH ad-hoc flex-bar charts)
- Create: `console/app/usage/usage-client.tsx`
- Modify: `console/app/usage/page.tsx` (full rewrite below)
- Delete: `console/app/usage/api-usage.tsx`

**Interfaces:**
- Consumes: `GET /v1/usage/gateway`, `GET /v1/usage`, `GET /v1/api-keys?all=1` (Task 10); `fmtCost` (Task 6).
- Produces: `UsageBars({ buckets, labelKey, series, mode, height, format })` — reused by Task 12.

- [ ] **Step 1: Shared bar chart**

`console/app/lib/usage-bars.tsx` (fixes the "Tokens per day sucks" complaint: ~200px tall, theme palette, thinned horizontal labels):

```tsx
"use client";
// Shared usage bar chart (spec 2026-07-14 §6) — replaces the two ad-hoc
// 140px flex-bar charts. mode "stack": series stack (input/output tokens);
// mode "group": side-by-side bars (real vs billed cost — not additive).
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface BarSeries { key: string; color: string; label: string }

export function UsageBars({ buckets, labelKey = "bucket", series, mode = "stack", height = 200, format }: {
  buckets: any[]; labelKey?: string; series: BarSeries[]; mode?: "stack" | "group";
  height?: number; format: (n: number) => string;
}) {
  if (!buckets.length) return <div className="empty">No usage in this range.</div>;
  const total = (b: any) => mode === "stack"
    ? series.reduce((a, s) => a + Number(b[s.key] ?? 0), 0)
    : Math.max(...series.map((s) => Number(b[s.key] ?? 0)));
  const peak = Math.max(1e-9, ...buckets.map(total));
  const step = Math.ceil(buckets.length / 8);   // ≤8 readable labels
  const label = (v: string) => {
    const d = new Date(`${v}T00:00:00`);
    return Number.isNaN(d.getTime()) ? v : `${DAYS[d.getDay()]} ${v.slice(5)}`;
  };
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>
        {series.map((s) => <span key={s.key} style={{ marginRight: 14 }}>
          <span style={{ color: s.color }}>■</span> {s.label}</span>)}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height, padding: "8px 6px 6px",
                    border: "1px solid var(--line)", borderRadius: 6, background: "var(--panel)" }}>
        {buckets.map((b) => (
          <div key={b[labelKey]}
               title={`${b[labelKey]}: ${series.map((s) => `${s.label} ${format(Number(b[s.key] ?? 0))}`).join(", ")}`}
               style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%", justifyContent: "flex-end" }}>
            {mode === "stack" ? (
              <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end",
                            height: `${(total(b) / peak) * 100}%`, minHeight: total(b) ? 3 : 0 }}>
                {[...series].reverse().map((s, i) => (
                  <div key={s.key} style={{ background: s.color, flexGrow: Number(b[s.key] ?? 0) || 0.0001,
                    borderRadius: i === 0 ? "3px 3px 0 0" : 0 }} />
                ))}
              </div>
            ) : (
              <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: "100%" }}>
                {series.map((s) => (
                  <div key={s.key} style={{ flex: 1, background: s.color, borderRadius: "3px 3px 0 0",
                    height: `${(Number(b[s.key] ?? 0) / peak) * 100}%`,
                    minHeight: Number(b[s.key] ?? 0) ? 3 : 0 }} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 4, padding: "4px 6px 0" }}>
        {buckets.map((b, i) => (
          <div key={b[labelKey]} style={{ flex: 1, fontSize: 10, color: "var(--muted)",
                textAlign: "center", overflow: "visible", whiteSpace: "nowrap" }}>
            {i % step === 0 ? label(String(b[labelKey])) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Server shell**

`console/app/usage/page.tsx` — full replacement:

```tsx
import { wsGet } from "../lib/api";
import type { CostSettings } from "../lib/currency";
import { UsageClient } from "./usage-client";

export const dynamic = "force-dynamic";

export default async function UsagePage() {
  const [deps, keys, settings] = await Promise.all([
    wsGet<{ deployments: { name: string }[] }>("/v1/deployments?limit=1000").catch(() => ({ deployments: [] })),
    wsGet<{ keys: any[] }>("/v1/api-keys?include=deleted&limit=1000").catch(() => ({ keys: [] })),
    wsGet<{ costs: CostSettings }>("/v1/settings").catch(() => null),
  ]);
  return (
    <>
      <div className="pagehead"><h1>Usage</h1></div>
      <p className="sub">API usage is metered at the gateway per API key and deployment. Session usage covers managed-agent runs.</p>
      <UsageClient deployments={deps.deployments.map((d) => d.name)} initialKeys={keys.keys}
                   costsOn={!!settings?.costs?.enabled} />
    </>
  );
}
```

- [ ] **Step 3: The client**

`console/app/usage/usage-client.tsx` (complete file; `api-usage.tsx` is deleted):

```tsx
"use client";
// Usage page (spec 2026-07-14 §6): ONE filter bar governs both sections.
// API usage = gateway_usage(source='api'); session usage = source='session'
// (rebuilt — the old sessions-table rollup could not honor these filters).
import { useEffect, useState } from "react";
import { wsHeader } from "../lib/client";
import { fmtCost } from "../lib/currency";
import { UsageBars } from "../lib/usage-bars";

const RANGES: [string, string][] = [
  ["1d", "Last day"], ["3d", "Last 3 days"], ["7d", "Last 7 days"], ["14d", "Last 14 days"],
  ["month", "Current month"], ["last_month", "Last month"], ["3m", "Last 3 months"], ["6m", "Last 6 months"],
];
const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
const TOKEN_SERIES = [
  { key: "tokens_in", color: "var(--blue)", label: "input" },
  { key: "tokens_out", color: "#d97706", label: "output" },
];

interface Row { [k: string]: any }
interface Gw { bucket: string; buckets: Row[]; totals: Row; byDeployment: Row[]; byKey: Row[]; costs: { currency: string } | null }
interface Su { bucket: string; buckets: Row[]; totals: Row; byDeployment: Row[]; sessionsCount: number;
  timeCosts: { real: number; billed: number } | null; costs: { currency: string } | null }

const nonZero = (r: Row) =>
  ["requests", "tokens_in", "tokens_out", "real_cost", "billed_cost", "sessions"]
    .some((k) => Number(r[k] ?? 0) > 0);

function CostCards({ totals, currency, extra, hint }: {
  totals: Row; currency: string; extra?: { real: number; billed: number } | null; hint?: string;
}) {
  const real = Number(totals.real_cost ?? 0) + (extra?.real ?? 0);
  const billed = Number(totals.billed_cost ?? 0) + (extra?.billed ?? 0);
  return (<>
    <div className="card"><h3>Real costs{hint ? ` ${hint}` : ""}</h3><div className="big">{fmtCost(real, currency)}</div></div>
    <div className="card"><h3>Billed costs{hint ? ` ${hint}` : ""}</h3><div className="big">{fmtCost(billed, currency)}</div></div>
  </>);
}

export function UsageClient({ deployments, initialKeys, costsOn }: {
  deployments: string[]; initialKeys: Row[]; costsOn: boolean;
}) {
  const [range, setRange] = useState("7d");
  const [deployment, setDeployment] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [allWs, setAllWs] = useState(false);
  const [keys, setKeys] = useState<Row[]>(initialKeys);
  const [gw, setGw] = useState<Gw | null>(null);
  const [su, setSu] = useState<Su | null>(null);

  // All-workspaces refreshes the key list (spec: "list needs to be refreshed").
  useEffect(() => {
    if (!allWs) { setKeys(initialKeys); return; }
    let stale = false;
    fetch("/api/v1/api-keys?all=1", { headers: wsHeader() })
      .then((r) => r.json()).then((j) => { if (!stale) setKeys(j.keys ?? []); })
      .catch(() => {});
    return () => { stale = true; };
  }, [allWs, initialKeys]);

  useEffect(() => {
    const q = new URLSearchParams({ range });
    if (deployment) q.set("deployment", deployment);
    if (allWs) q.set("workspaces", "all");
    const qa = new URLSearchParams(q);
    if (apiKey) qa.set("api_key", apiKey);
    let stale = false;
    fetch(`/api/v1/usage/gateway?${qa}`, { headers: wsHeader() })
      .then((r) => r.json()).then((u) => { if (!stale) setGw(u); }).catch(() => { if (!stale) setGw(null); });
    fetch(`/api/v1/usage?${q}`, { headers: wsHeader() })
      .then((r) => r.json()).then((u) => { if (!stale) setSu(u); }).catch(() => { if (!stale) setSu(null); });
    return () => { stale = true; };
  }, [range, deployment, apiKey, allWs]);

  const keyLabel = (k: Row) =>
    k.api_key_id === null ? "(deleted key)"
      : `${k.name ?? k.api_key_id ?? k.id}${k.status === "deleted" ? " [deleted]" : ""}${k.workspace_name ? ` — ${k.workspace_name}` : ""}`;
  const cur = gw?.costs?.currency ?? su?.costs?.currency ?? "EUR";
  const showCosts = costsOn && !!(gw?.costs || su?.costs);

  return (
    <>
      {/* ── Shared filter bar (governs BOTH sections) ── */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <select value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <select value={deployment} onChange={(e) => setDeployment(e.target.value)}>
          <option value="">All deployments</option>
          {deployments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={apiKey} onChange={(e) => setApiKey(e.target.value)}>
          <option value="">All API keys</option>
          {keys.map((k) => <option key={k.id} value={k.id}>{keyLabel(k)}</option>)}
          <option value="__deleted__">(deleted key)</option>
        </select>
        <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={allWs} onChange={(e) => setAllWs(e.target.checked)} />
          All workspaces
        </label>
      </div>

      {/* ── API usage ── */}
      <div className="group" style={{ padding: "6px 0 8px", fontWeight: 600 }}>API usage</div>
      <div className="cards">
        <div className="card"><h3>Input tokens</h3><div className="big">{fmt(gw?.totals.tokens_in ?? 0)}</div></div>
        <div className="card"><h3>Output tokens</h3><div className="big">{fmt(gw?.totals.tokens_out ?? 0)}</div></div>
        <div className="card"><h3>Requests</h3><div className="big">{gw?.totals.requests ?? 0}</div></div>
        {showCosts && gw && <CostCards totals={gw.totals} currency={cur} />}
      </div>
      <div className="group" style={{ padding: "6px 0 8px" }}>Tokens per {gw?.bucket === "week" ? "week" : "day"}</div>
      <UsageBars buckets={gw?.buckets ?? []} series={TOKEN_SERIES} mode="stack" format={fmt} />
      <div className="group" style={{ padding: "0 0 8px" }}>By deployment</div>
      <UsageTable rows={(gw?.byDeployment ?? []).filter(nonZero)} first="Deployment" firstKey="model"
                  showCosts={showCosts} currency={cur} />
      <div className="group" style={{ padding: "0 0 8px" }}>By API key</div>
      <UsageTable rows={(gw?.byKey ?? []).filter(nonZero)} first="API key" firstKey="__label"
                  labeler={keyLabel} showCosts={showCosts} currency={cur} />

      {/* ── Session usage ── */}
      <div className="group" style={{ padding: "6px 0 8px", fontWeight: 600 }}>Session usage</div>
      <div className="cards">
        <div className="card"><h3>Input tokens</h3><div className="big">{fmt(su?.totals.tokens_in ?? 0)}</div></div>
        <div className="card"><h3>Output tokens</h3><div className="big">{fmt(su?.totals.tokens_out ?? 0)}</div></div>
        <div className="card"><h3>Sessions</h3><div className="big">{su?.sessionsCount ?? 0}</div></div>
        {showCosts && su && <CostCards totals={su.totals} currency={cur} extra={su.timeCosts}
          hint={deployment ? "(tokens only)" : undefined} />}
      </div>
      <div className="group" style={{ padding: "6px 0 8px" }}>Tokens per {su?.bucket === "week" ? "week" : "day"}</div>
      <UsageBars buckets={su?.buckets ?? []} series={TOKEN_SERIES} mode="stack" format={fmt} />
      <div className="group" style={{ padding: "0 0 8px" }}>By deployment</div>
      <UsageTable rows={(su?.byDeployment ?? []).filter(nonZero)} first="Deployment" firstKey="model"
                  sessions showCosts={showCosts} currency={cur} />
    </>
  );
}

function UsageTable({ rows, first, firstKey, labeler, sessions, showCosts, currency }: {
  rows: Row[]; first: string; firstKey: string; labeler?: (r: Row) => string;
  sessions?: boolean; showCosts: boolean; currency: string;
}) {
  return (
    <div className="tablewrap" style={{ marginBottom: 22 }}><table>
      <thead><tr>
        <th>{first}</th>{sessions && <th>Sessions</th>}<th>Requests</th>
        <th>Input tokens</th><th>Output tokens</th>
        {showCosts && <><th>Real costs</th><th>Billed costs</th></>}
      </tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{labeler ? labeler(r) : <code>{r[firstKey]}</code>}</td>
            {sessions && <td>{r.sessions}</td>}
            <td>{r.requests}</td>
            <td>{fmt(Number(r.tokens_in ?? 0))}</td><td>{fmt(Number(r.tokens_out ?? 0))}</td>
            {showCosts && <>
              <td>{fmtCost(Number(r.real_cost ?? 0), currency)}</td>
              <td>{fmtCost(Number(r.billed_cost ?? 0), currency)}</td>
            </>}
          </tr>
        ))}
        {rows.length === 0 && <tr><td colSpan={showCosts ? 7 : 5} className="empty">No usage in this range.</td></tr>}
      </tbody>
    </table></div>
  );
}
```
(`fmt` is module-level so `UsageTable` can use it. TS may need `const fmt = ...` hoisted above both components — it already is.)

- [ ] **Step 4: Delete `console/app/usage/api-usage.tsx`**

```bash
git rm console/app/usage/api-usage.tsx
```

- [ ] **Step 5: Build + verify**

`npx next build` + restart. Verify: one filter bar on top; both sections react to range/deployment; API-key filter only moves the API section; "All workspaces" reloads the key list (workspace names appear) and widens totals; cost cards/columns appear only when tracking is on; zero rows dropped; the bar charts are 200px with readable "Mon 07-13" labels.

- [ ] **Step 6: Commit**

```bash
git add -A console
git commit -m "feat(console): usage page rebuild — shared filter bar, cost surfaces, readable charts"
```

---

### Task 12: Dashboard usage panel

**Files:**
- Create: `console/app/dashboard-usage.tsx`
- Modify: `console/app/page.tsx` (render the panel under the existing cards)

**Interfaces:**
- Consumes: `GET /v1/usage/summary` (Task 10), `UsageBars` (Task 11), `fmtCost` (Task 6), `GET /v1/api-keys?all=1`.

- [ ] **Step 1: Panel component**

`console/app/dashboard-usage.tsx`:

```tsx
"use client";
// Dashboard usage panel (spec 2026-07-14 §6): the deployment-Stats surface,
// cross-deployment — filters: range, deployment, API key, all workspaces.
import { useEffect, useState } from "react";
import { wsHeader } from "./lib/client";
import { fmtCost } from "./lib/currency";
import { UsageBars } from "./lib/usage-bars";

const RANGES: [string, string][] = [
  ["1d", "Last day"], ["3d", "Last 3 days"], ["7d", "Last 7 days"], ["14d", "Last 14 days"],
  ["month", "Current month"], ["last_month", "Last month"], ["3m", "Last 3 months"], ["6m", "Last 6 months"],
];
const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

export function DashboardUsage({ deployments }: { deployments: string[] }) {
  const [range, setRange] = useState("7d");
  const [deployment, setDeployment] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [allWs, setAllWs] = useState(false);
  const [keys, setKeys] = useState<any[]>([]);
  const [u, setU] = useState<any | null>(null);

  useEffect(() => {
    let stale = false;
    fetch(`/api/v1/api-keys?${allWs ? "all=1" : "include=deleted&limit=1000"}`, { headers: wsHeader() })
      .then((r) => r.json()).then((j) => { if (!stale) setKeys(j.keys ?? []); }).catch(() => {});
    return () => { stale = true; };
  }, [allWs]);

  useEffect(() => {
    const q = new URLSearchParams({ range });
    if (deployment) q.set("deployment", deployment);
    if (apiKey) q.set("api_key", apiKey);
    if (allWs) q.set("workspaces", "all");
    let stale = false;
    fetch(`/api/v1/usage/summary?${q}`, { headers: wsHeader() })
      .then((r) => r.json()).then((j) => { if (!stale) setU(j); }).catch(() => { if (!stale) setU(null); });
    return () => { stale = true; };
  }, [range, deployment, apiKey, allWs]);

  const cur = u?.costs?.currency ?? "EUR";
  return (
    <>
      <div className="group" style={{ padding: "18px 0 8px", fontWeight: 600 }}>Usage</div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <select value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={deployment} onChange={(e) => setDeployment(e.target.value)}>
          <option value="">All deployments</option>
          {deployments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={apiKey} onChange={(e) => setApiKey(e.target.value)}>
          <option value="">All API keys</option>
          {keys.map((k) => <option key={k.id} value={k.id}>{k.name}{k.workspace_name ? ` — ${k.workspace_name}` : ""}</option>)}
        </select>
        <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={allWs} onChange={(e) => setAllWs(e.target.checked)} />
          All workspaces
        </label>
      </div>
      <div className="cards">
        <div className="card"><h3>Requests</h3><div className="big">{u?.totals?.requests ?? 0}</div></div>
        <div className="card"><h3>Input tokens</h3><div className="big">{fmt(u?.totals?.tokens_in ?? 0)}</div></div>
        <div className="card"><h3>Output tokens</h3><div className="big">{fmt(u?.totals?.tokens_out ?? 0)}</div></div>
        {u?.costs && (<>
          <div className="card"><h3>Real costs{u.tokensOnly ? " (tokens only)" : ""}</h3>
            <div className="big">{fmtCost(Number(u.totals?.real_cost ?? 0), cur)}</div></div>
          <div className="card"><h3>Billed costs{u.tokensOnly ? " (tokens only)" : ""}</h3>
            <div className="big">{fmtCost(Number(u.totals?.billed_cost ?? 0), cur)}</div></div>
        </>)}
      </div>
      <div className="group" style={{ padding: "6px 0 8px" }}>Tokens per {u?.bucket === "week" ? "week" : "day"}</div>
      <UsageBars buckets={u?.buckets ?? []} mode="stack" format={fmt} series={[
        { key: "tokens_in", color: "var(--blue)", label: "input" },
        { key: "tokens_out", color: "#d97706", label: "output" },
      ]} />
      {u?.costs && (<>
        <div className="group" style={{ padding: "6px 0 8px" }}>Cost per {u?.bucket === "week" ? "week" : "day"}</div>
        <UsageBars buckets={u?.buckets ?? []} mode="group" format={(n) => fmtCost(n, cur)} series={[
          { key: "real_cost", color: "var(--blue)", label: "real" },
          { key: "billed_cost", color: "#d97706", label: "billed" },
        ]} />
      </>)}
    </>
  );
}
```

- [ ] **Step 2: Mount on the dashboard**

In `console/app/page.tsx`, add `import { DashboardUsage } from "./dashboard-usage";` and, after the closing `</div>` of the `.cards` block (page.tsx:42), insert:

```tsx
      <DashboardUsage deployments={deployments.deployments.map((d: any) => d.name)} />
```
The existing four stat cards stay untouched.

- [ ] **Step 3: Build + verify**

`npx next build` + restart. Dashboard shows the Usage panel under the cards; filters work; cost cards + cost chart only with tracking on; API-key filter flips the "(tokens only)" hint.

- [ ] **Step 4: Commit**

```bash
git add console/app/dashboard-usage.tsx console/app/page.tsx
git commit -m "feat(console): dashboard usage panel with cost totals and charts"
```

---

### Task 13: Final verification + docs

**Files:**
- Modify: `CLAUDE.md` (project conventions — one new bullet)

- [ ] **Step 1: Backend suite + types**

Stop the control plane. Run:

```
cd control-plane && npx tsc --noEmit && npm test
```
Expected: clean compile, full suite green.

- [ ] **Step 2: Restart CP + console**

Restart the control plane (`DEVPROOF_RUNNER_IMAGE=... npx tsx src/main.ts` with the env vars from CLAUDE.md) and the console (`npx next build && npx next start -p 7090`).

- [ ] **Step 3: All pages 200**

`/, /usage, /settings, /deployments, /deployments/<name> (Stats tab), /pools, /environments, /sessions, /sessions/<id>, /api-keys, /workspaces` — each renders without client-side exceptions (check the browser console, not just curl — see chunk-hash memory).

- [ ] **Step 4: Live flow (the spec's end-to-end)**

1. Settings: enable tracking + billing + all sub-toggles; currency EUR. Save.
2. Pool modal: set a real cost (e.g. 3.60 €/hour). Deployment edit (local): billing time + token prices. Environment: real cost + session billing (per minute). External deployment (if present): real + billing token prices.
3. Run a session turn. Watch: cost chip appears next to the token chip and ticks; after ~1 min a `session_time`/`env_pod` entry lands (`SELECT * FROM cost_entries ORDER BY id DESC LIMIT 5`).
4. Deployment Stats tab: Real/Billed boxes + cost chart move; API-key filter shows "(tokens only)".
5. Usage page: both sections show cost cards/columns; "All workspaces" widens; zero rows dropped.
6. Dashboard: Usage panel totals match the Usage page for the same filter.
7. Toggle master OFF: every cost surface disappears; `cost_entries` stops growing; history intact.

- [ ] **Step 5: CLAUDE.md bullet**

Append to the Conventions section of `CLAUDE.md` (repo root):

```markdown
- **Cost tracking & billing (spec 2026-07-14):** two ledgers — real (infra/external-token cost to the operator) vs billed (charged to consumers). Prices in `resource_prices` (kind+ref; CP delete routes clean up; kubectl-bypass leaves inert rows), settings in `app_settings` (singleton, `GET/PUT /v1/settings`). Token costs stamped by the 031 BEFORE-INSERT trigger on `gateway_usage` (usage-time pricing — history immutable; NULL = untracked, 0 = free); time costs accrued by `src/cost-sampler.ts` (60s, `cost_entries`, gap cap 120s, `readyReplicas` measure) with exact-to-the-second turn settles via `settleSession` (status/interrupt/reconciler hooks). Session chip = `sessions.billed_cost` (trigger + sampler, same NOTIFY). Filtered (key/agent) cost views are token-only by design. Currency is a display label (`app/lib/currency.ts`). Session usage on the Usage page reads `gateway_usage(source='session')` — the old sessions-table rollup is gone.
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: cost tracking conventions"
```
