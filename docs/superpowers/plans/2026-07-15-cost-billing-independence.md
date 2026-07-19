# Cost Tracking & Billing Independence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cost tracking and billing two independent switches — `costs.enabled` governs the real-cost ledger only, `costs.billing.enabled` governs the billing ledger only — across settings, accrual, and every display surface.

**Architecture:** Three master gates that AND `costs.enabled` over the billing ledger are removed (sampler short-circuit, pure accrual function, SQL stamping trigger). Display visibility is carried per-ledger by the server-embedded `costs` object, because the four polling surfaces never read `/v1/settings`. The settings form unwraps one JSX conditional so Currency and Billing become siblings of Real costs rather than its children.

**Tech Stack:** TypeScript, Node test runner (`node --test`), Fastify, Postgres (plpgsql triggers), Next.js 15 App Router, React.

Spec: `docs/superpowers/specs/2026-07-15-cost-billing-independence-design.md` (commits `8c2c986`, `10ebc52`).

## Global Constraints

- **No schema change.** `data.costs` keeps its exact JSON shape. Do NOT add a migration file. Do NOT edit `normalizeCostSettings` or `validateCostSettings` in `control-plane/src/costs.ts`.
- **Edit `sql/032_token_price_shape.sql`, NEVER `sql/031_cost_stamping.sql`.** 032 sorts after 031 and `CREATE OR REPLACE`s the stamping function on every boot; 031 holds the trigger binding. `migrate()` re-runs every SQL file each boot.
- **`costs.enabled` narrows in meaning, not in name.** It means "real cost tracking on/off". Do not rename it.
- **The three `trackX` flags never affect display visibility.** They gate accrual and price-input fields only. A `0.00` "Real cost" tile with all three off is intended.
- **Chart rule, all five charts:** both ledgers off ⇒ no chart AND no section header; one ledger on ⇒ that series alone; both on ⇒ two series.
- **Backend tests:** `cd control-plane && npm test` (Node runner, `--test-concurrency=1` on purpose — never remove it) and `npx tsc --noEmit`.
- **Console verification is a production build:** `cd console && npx next build && npx next start -p 7090`. Dev mode is too slow.
- **Never use `prompt()`/`confirm()`/`alert()` in the console.** Not applicable to this change, but the ban stands.

---

### Task 1: Accrual independence (sampler, pure math, SQL trigger)

Removes all three master gates together. They must ship as one task: fixing `computeAccruals` alone is dead code, because `cost-sampler.ts:35` returns before calling it.

**Files:**
- Modify: `control-plane/src/cost-sampler.ts:26-28`
- Modify: `control-plane/src/costs.ts:191, 204, 246`
- Modify: `control-plane/sql/032_token_price_shape.sql:29`
- Test: `control-plane/test/costs-accrual.test.ts:132-148` (rewrite in place)
- Test: `control-plane/test/cost-sampler.test.ts:10-41` (extend `fakeDeps`), plus 2 new tests
- Test: `control-plane/test/cost-stamping.test.ts` (1 new test)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `computeAccruals(nowMs, settings, prices, deployments, turns, watermarksMs, mode?)` — unchanged signature, new gating semantics. `needsTime` stays module-private (not exported); test it through `costSamplerTick`.

- [ ] **Step 1: Rewrite the accrual toggle test to assert independence**

In `control-plane/test/costs-accrual.test.ts`, replace the whole test at lines 132-148 (`"toggles gate each kind independently; master off = nothing"`) with this. It is the regression test for this change — rewrite it, do not delete it.

```ts
test("toggles gate each ledger independently; real and billing are siblings", () => {
  const prices = [
    { kind: "pool", ref: "p", prices: { real: { podTime: { amount: 1, per: "hour" } } } },
    { kind: "deployment", ref: "d", prices: { billing: { podTime: { amount: 1, per: "hour" } } } },
    { kind: "environment", ref: "e", prices: {
      real: { podTime: { amount: 1, per: "hour" } },
      billing: { sessionTime: { amount: 1, per: "hour" } } } },
  ];
  const deps = [{ name: "d", pool: "p", readyReplicas: 1 }];
  const turns = [{ sessionId: "s", workspaceId: "w", environmentId: "e", startedAtMs: NOW - 60_000 }];
  const wm = new Map([["dep:d", NOW - 60_000], ["sesn:s", NOW - 60_000]]);
  const kinds = (s: any) => computeAccruals(NOW, s, prices, deps, turns, wm).entries.map((e) => e.kind).sort();

  // Both ledgers on: all four kinds accrue.
  assert.deepEqual(kinds(ON), ["deployment_time", "env_pod", "pool_pod", "session_time"]);
  // Billing only (cost tracking OFF) — the 2026-07-15 independence change:
  // `enabled` no longer masters the billing ledger.
  assert.deepEqual(kinds({ ...ON, enabled: false }), ["deployment_time", "session_time"]);
  // Real only (billing off).
  assert.deepEqual(kinds({ ...ON, billing: { ...ON.billing, enabled: false } }), ["env_pod", "pool_pod"]);
  // Both off: nothing accrues.
  assert.deepEqual(kinds({ ...ON, enabled: false, billing: { ...ON.billing, enabled: false } }), []);
  // Sub-flags still gate their own kind within an enabled ledger.
  assert.equal(kinds({ ...ON, trackPoolCosts: false }).includes("pool_pod"), false);
  assert.equal(kinds({ ...ON, billing: { ...ON.billing, billSessionTime: false } }).includes("session_time"), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd control-plane && npx tsx --test test/costs-accrual.test.ts`

Expected: FAIL on the billing-only case — actual `[]`, expected `["deployment_time", "session_time"]` (the master gate at `costs.ts:191` returns early).

- [ ] **Step 3: Split the gate in the pure accrual function**

In `control-plane/src/costs.ts`, delete line 191 entirely:

```ts
  if (!settings.enabled) return { entries, sessionBilled };
```

Then change `wantsPool` (line 204) to add the real-ledger gate:

```ts
    const wantsPool = settings.enabled && settings.trackPoolCosts && !!poolP;
```

And change the `env_pod` condition (line 246) the same way:

```ts
    if (settings.enabled && settings.trackEnvCosts && envP) {
```

Leave `wantsDep` (line 205) and the `session_time` condition (line 252) alone — they already gate on the local `billing` const from line 194.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd control-plane && npx tsx --test test/costs-accrual.test.ts`

Expected: PASS, all tests in the file.

- [ ] **Step 5: Add a settings override to the sampler test fixture**

In `control-plane/test/cost-sampler.test.ts`, change the `fakeDeps` signature (line 10) and its `getCostSettings` (line 15):

```ts
function fakeDeps(overrides: {
  orchestrator?: SamplerDeps["orchestrator"]; watermarks?: Map<string, number>;
  settings?: typeof ON;
} = {}) {
```

```ts
      getCostSettings: async () => overrides.settings ?? ON,
```

- [ ] **Step 6: Write the failing sampler tests**

Append to `control-plane/test/cost-sampler.test.ts`:

```ts
test("billing-only settings still tick: needsTime no longer short-circuits on costs.enabled", async () => {
  const { deps, inserted, billed } = fakeDeps({ settings: { ...ON, enabled: false } });
  await costSamplerTick(deps);
  assert.equal(inserted.some((e) => e.kind === "session_time" && e.sessionId === "sesn_a"), true,
    "billing ledger must accrue with cost tracking off");
  assert.equal(inserted.some((e) => e.kind === "env_pod" || e.kind === "pool_pod"), false,
    "real ledger stays off");
  assert.equal(billed.length, 1);
});

test("both ledgers off: the sampler accrues nothing", async () => {
  const { deps, inserted } = fakeDeps({ settings: { ...DEFAULT_COST_SETTINGS } });
  await costSamplerTick(deps);
  assert.equal(inserted.length, 0);
});
```

- [ ] **Step 7: Run them to verify the first fails**

Run: `cd control-plane && npx tsx --test test/cost-sampler.test.ts`

Expected: FAIL on "billing-only settings still tick" — nothing inserted, because `needsTime` returns false. "both ledgers off" already passes.

- [ ] **Step 8: Split the sampler's short-circuit**

In `control-plane/src/cost-sampler.ts`, replace lines 26-28:

```ts
// Per-ledger (spec 2026-07-15): real ⇐ enabled, billing ⇐ billing.enabled.
// ANDing `enabled` over the billing terms would make computeAccruals' billing
// paths unreachable whenever cost tracking is off.
const needsTime = (s: CostSettings) =>
  (s.enabled && (s.trackPoolCosts || s.trackEnvCosts)) ||
  (s.billing.enabled && (s.billing.billSessionTime || s.billing.billDeploymentTime));
```

- [ ] **Step 9: Run the sampler tests to verify they pass**

Run: `cd control-plane && npx tsx --test test/cost-sampler.test.ts`

Expected: PASS, all tests.

- [ ] **Step 10: Write the failing trigger test**

Append to `control-plane/test/cost-stamping.test.ts` (inside the file, as a new top-level test):

```ts
test("billing-only settings stamp billed_cost with cost tracking off (2026-07-15)", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const before = await repo.getCostSettings();
  const ws = (await repo.createWorkspace(`t-cost-indep-${Date.now()}`)).id;
  const ext = await repo.createExternalDeployment({
    name: `t-cost-indep-ext-${Date.now()}`, provider: "custom", baseUrl: "http://x/v1", modelId: "m", hasKey: false });
  try {
    await repo.putResourcePrice("external", ext.id, {
      real: { tokens: { in: { amount: 10, perTokens: 1_000_000 }, out: { amount: 10, perTokens: 1_000_000 } } },
      billing: { tokens: { in: { amount: 20, perTokens: 1_000_000 }, out: { amount: 20, perTokens: 1_000_000 } } } });

    // Billing ON, cost tracking OFF → billed stamped, real NULL.
    await repo.putCostSettings({ ...DEFAULT_COST_SETTINGS, enabled: false,
      trackExternalCosts: true, // proves the real ledger obeys `enabled`, not the sub-flag
      billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: true, billExternalTokens: true } });
    let r = (await insertUsage(ws, ext.name, 1_000_000, 0)).rows[0];
    assert.equal(Number(r.billed_cost), 20);
    assert.equal(r.real_cost, null, "real ledger off ⇒ NULL");

    // Cost tracking ON, billing OFF → real stamped, billed NULL.
    await repo.putCostSettings({ ...DEFAULT_COST_SETTINGS, enabled: true, trackExternalCosts: true,
      billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: false, billExternalTokens: true } });
    r = (await insertUsage(ws, ext.name, 1_000_000, 0)).rows[0];
    assert.equal(Number(r.real_cost), 10);
    assert.equal(r.billed_cost, null, "billing ledger off ⇒ NULL");
  } finally {
    await repo.putCostSettings(before);
    await repo.deleteResourcePrice("external", ext.id);
    await repo.deleteExternalDeployment(ext.id);
    await pool.query("DELETE FROM gateway_usage WHERE workspace_id = $1", [ws]);
  }
});
```

- [ ] **Step 11: Run it to verify it fails**

Run: `cd control-plane && npx tsx --test test/cost-stamping.test.ts`

Expected: FAIL on the first assertion — `billed_cost` is `null`, expected `20` (the trigger's master gate returns NEW early).

If it reports `skip`, the dev Postgres is unreachable; start it before continuing — this test cannot be validated offline.

- [ ] **Step 12: Drop the trigger's master gate**

In `control-plane/sql/032_token_price_shape.sql`, replace line 29:

```sql
  IF cfg IS NULL THEN
```

(keeping the `RETURN NEW; END IF;` lines below it unchanged). The billing branches at :44 (external) and :56 (local) already test their own `{billing,enabled}` flag and need no edit. The external *real* branch at :37 does NOT — it reads only `trackExternalCosts` and relied on the master gate for `enabled`, so add `COALESCE((cfg->>'enabled')::boolean, false) AND` there. There is no local *real* branch by design (local real cost is pool pod-time, accrued by the sampler).

Also update the file's header comment to record why (append after the existing header block):

```sql
-- 2026-07-15: costs.enabled no longer masters the billing ledger — it gates
-- the real ledger only. Each branch below tests its own flag.
```

- [ ] **Step 13: Run the trigger test to verify it passes**

Run: `cd control-plane && npx tsx --test test/cost-stamping.test.ts`

Expected: PASS, all 3 tests (`migrate()` re-runs 032 and replaces the function).

- [ ] **Step 14: Commit**

```bash
git add control-plane/src/costs.ts control-plane/src/cost-sampler.ts control-plane/sql/032_token_price_shape.sql control-plane/test/costs-accrual.test.ts control-plane/test/cost-sampler.test.ts control-plane/test/cost-stamping.test.ts
git commit -m "feat(costs): accrue each ledger on its own switch

Three master gates ANDed costs.enabled over the billing ledger: the
sampler short-circuit (needsTime), the pure accrual function, and the
032 stamping trigger. All three now gate per ledger, so billing accrues
and stamps with cost tracking off.

costs-accrual's toggle test asserted the old master-gate behavior; it is
rewritten as the regression test for the four-way matrix."
```

---

### Task 2: Server carries per-ledger visibility

The dashboard and deployment-Stats surfaces never fetch `/v1/settings` — they infer cost visibility from the `costs` object embedded in each stats response. That object becomes the carrier for both flags.

**Files:**
- Modify: `control-plane/src/agents-api.ts:14, 374, 377, 392, 395, 883, 896`
- Test: `control-plane/test/agents-api.test.ts:129` (fix partial stub), plus 1 new test

**Interfaces:**
- Consumes: `CostSettings` from `control-plane/src/costs.ts` (existing type, unchanged).
- Produces: the wire shape every console consumer in Tasks 4 reads —
  `costs: { currency: string; real: boolean; billed: boolean; tokensOnly?: boolean } | null`.
  `null` only when BOTH ledgers are off. `tokensOnly` is present on
  `/v1/deployments/:name/stats` and `/v1/usage/realtime` only.

- [ ] **Step 1: Fix the partial settings stub**

`control-plane/test/agents-api.test.ts:129` returns a `CostSettings` with no `billing` key, which the new `settings.billing.enabled` read would throw on. Replace line 129:

```ts
    async getCostSettings() { return { ...DEFAULT_COST_SETTINGS }; },
```

And add the import at the top of the file (after the existing `import type { Repo }` line):

```ts
import { DEFAULT_COST_SETTINGS } from "../src/costs.ts";
```

This preserves the stub's intent exactly (`enabled: false`, `currency: "EUR"`) while carrying the full shape. Production is unaffected — `repo.getCostSettings` always runs `normalizeCostSettings` (`repo.ts:1296`).

- [ ] **Step 2: Write the failing payload test**

Append to `control-plane/test/agents-api.test.ts`:

```ts
test("usage costs meta carries per-ledger visibility (2026-07-15)", async () => {
  const settingsFor = (enabled: boolean, billing: boolean) => ({
    ...DEFAULT_COST_SETTINGS, enabled,
    billing: { ...DEFAULT_COST_SETTINGS.billing, enabled: billing },
  });
  const costsFor = async (enabled: boolean, billing: boolean, url: string) => {
    const f = fakes();
    f.repo.getCostSettings = async () => settingsFor(enabled, billing);
    const { app } = await build(f);
    return (await app.inject({ method: "GET", url })).json().costs;
  };

  // tokensOnly rides only on the two realtime/stats surfaces; /v1/usage and
  // /v1/usage/gateway return the bare meta.
  for (const url of ["/v1/usage/gateway", "/v1/usage", "/v1/usage/realtime"]) {
    const withTokensOnly = url === "/v1/usage/realtime";
    assert.equal(await costsFor(false, false, url), null, `${url}: both off ⇒ null`);
    assert.deepEqual(
      await costsFor(true, false, url),
      { currency: "EUR", real: true, billed: false, ...(withTokensOnly ? { tokensOnly: false } : {}) },
      `${url}: real only`);
    const billedOnly = await costsFor(false, true, url);
    assert.equal(billedOnly.real, false, `${url}: billing-only ⇒ real false`);
    assert.equal(billedOnly.billed, true, `${url}: billing-only ⇒ billed true`);
  }
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd control-plane && npx tsx --test test/agents-api.test.ts`

Expected: FAIL on the "real only" case — actual `{ currency: "EUR", tokensOnly: false }`, missing `real`/`billed`. The billing-only case fails too (`costs` is `null`).

- [ ] **Step 4: Add the costs-meta helper**

In `control-plane/src/agents-api.ts`, extend the import on line 14:

```ts
import { normalizeCostSettings, validateCostSettings, validatePrices, type CostSettings } from "./costs.ts";
```

Then add this helper at module scope, immediately above `registerAgentRoutes`:

```ts
/** Cost UI visibility is per ledger (spec 2026-07-15): real ⇐ costs.enabled,
 *  billed ⇐ costs.billing.enabled. Null only when BOTH are off. The polling
 *  surfaces (dashboard, deployment Stats) never read /v1/settings, so this
 *  object is the sole carrier of visibility for every cost tile and chart. */
const costsMeta = (s: CostSettings) =>
  s.enabled || s.billing.enabled
    ? { currency: s.currency, real: s.enabled, billed: s.billing.enabled }
    : null;
```

- [ ] **Step 5: Use it at the four sites**

`agents-api.ts` lines 374 + 376-377 become:

```ts
    if (settings.enabled || settings.billing.enabled) opts.costs = { includeTime: !tokensOnly };
    const stats = await repo.deploymentStats((req.params as any).name, opts);
    const meta = costsMeta(settings);
    return { window: q.window ?? "5m", bucketSeconds: win.bucketSec, ...stats,
      costs: meta && { ...meta, tokensOnly } };
```

Lines 392 + 394-395 become:

```ts
    if (settings.enabled || settings.billing.enabled) opts.costs = { includeTime: !tokensOnly };
    const stats = await repo.deploymentStats(q.deployment || null, opts);
    const meta = costsMeta(settings);
    return { window: q.window ?? "5m", bucketSeconds: win.bucketSec, ...stats,
      costs: meta && { ...meta, tokensOnly } };
```

Lines 883 and 896 each become:

```ts
    return { ...usage, costs: costsMeta(settings) };
```

(`/v1/usage` and `/v1/usage/gateway` never set `opts.costs` — their sums are computed unconditionally. Leave that as-is.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd control-plane && npx tsx --test test/agents-api.test.ts`

Expected: PASS, all tests.

- [ ] **Step 7: Typecheck and run the full backend suite**

Run: `cd control-plane && npx tsc --noEmit && npm test`

Expected: tsc clean; suite green. `npm test` runs the suite then sweeps its throwaway workspaces; the exit code is the suite's.

- [ ] **Step 8: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/test/agents-api.test.ts
git commit -m "feat(usage): carry per-ledger cost visibility in the costs meta

The dashboard and deployment-Stats surfaces never read /v1/settings —
they infer cost visibility from the embedded costs object. It now carries
real/billed booleans and is null only when both ledgers are off.

The agents-api stub returned a CostSettings with no billing key, which
the new billing.enabled read throws on; it now returns the full shape."
```

---

### Task 3: Settings form relayout

**Files:**
- Modify: `console/app/settings/form.tsx:2-5, 84-132`

**Interfaces:**
- Consumes: `CostSettings` from `console/app/lib/currency.ts` (unchanged shape).
- Produces: no new exports. `Row` and `Section` are untouched.

- [ ] **Step 1: Update the file header comment**

Replace lines 2-5 of `console/app/settings/form.tsx`:

```tsx
// Cost tracking & billing settings (spec 2026-07-14, amended 2026-07-15).
// Explicit Save — toggles gate BOTH accrual and cost UI platform-wide. Real
// costs and Billing are SIBLING sections, each with its own switch; Currency
// spans both. Every toggle row is [checkbox | name | hint] on one shared grid.
```

- [ ] **Step 2: Unwrap the master conditional**

Replace lines 84-132 of `console/app/settings/form.tsx` (from `<Row label="Enable cost tracking"` through the `</>)}` that closes the `{c.enabled && (<>` block) with:

```tsx
        <label className="setrow plain">
          <span />
          <span className="setrow-name">Currency</span>
          <span className="setrow-hint" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <select value={c.currency} onChange={(e) => set({ currency: e.target.value })}
                    style={{ width: 130, flex: "none" }}>
              {CURRENCY_LABELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            display label only — never converts amounts
          </span>
        </label>

        <Section title="Real costs" note="What the platform costs you — infrastructure and external tokens." />
        <Row label="Enable cost tracking" checked={c.enabled}
             hint="tracks what the platform costs you — off means no real cost accrues or is shown"
             onChange={(v) => set({ enabled: v })} />
        {c.enabled && (<>
          <Row label="Pool cost tracking" checked={c.trackPoolCosts}
               hint="price per running engine replica, set on each pool"
               onChange={(v) => set({ trackPoolCosts: v })} />
          <Row label="External deployment cost tracking" checked={c.trackExternalCosts}
               hint="provider token prices, set on each external deployment"
               onChange={(v) => set({ trackExternalCosts: v })} />
          <Row label="Environment cost tracking" checked={c.trackEnvCosts}
               hint="price per running session pod, set on each environment"
               onChange={(v) => set({ trackEnvCosts: v })} />
        </>)}

        <Section title="Billing" note="What consumers are charged — may exceed real costs." />
        <Row label="Enable billing" checked={c.billing.enabled}
             hint="master switch for all billing below"
             onChange={(v) => setB({ enabled: v })} />
        {c.billing.enabled && (<>
          <Row label="Show real-time costs in sessions" checked={c.billing.showSessionCosts}
               hint="billed-cost chip next to the token chip in the session header"
               onChange={(v) => setB({ showSessionCosts: v })} />
          <Row label="Session billing" checked={c.billing.billSessionTime}
               hint="time price on environments; turn-pod runtime, billed per started minute"
               onChange={(v) => setB({ billSessionTime: v })} />
          <Row label="External token billing" checked={c.billing.billExternalTokens}
               hint="token prices on external deployments"
               onChange={(v) => setB({ billExternalTokens: v })} />
          <Row label="Local token billing" checked={c.billing.billLocalTokens}
               hint="token prices on local deployments"
               onChange={(v) => setB({ billLocalTokens: v })} />
          <Row label="Time-based deployment billing" checked={c.billing.billDeploymentTime}
               hint="price per running replica on local deployments; sums with local token billing"
               onChange={(v) => setB({ billDeploymentTime: v })} />
        </>)}
```

Note the JSX above is no longer wrapped in a fragment — it sits directly inside the `<div className="setpanel">`. Confirm the `</div></details>` that follows is still balanced.

- [ ] **Step 3: Typecheck**

Run: `cd console && npx tsc --noEmit`

Expected: no errors. (If it reports an unbalanced JSX tag, the `{c.enabled && (<>` fragment close was over- or under-removed.)

- [ ] **Step 4: Commit**

```bash
git add console/app/settings/form.tsx
git commit -m "feat(settings): Real costs and Billing become sibling sections

Enable cost tracking moves under the Real costs heading as its first row
and now gates only the three tracking checkboxes. Currency and the
Billing subtree move out from behind it."
```

---

### Task 4: Console display gating

**Files:**
- Modify: `console/app/usage/shared.tsx:23-71`
- Modify: `console/app/usage/api/client.tsx:8-13, 55-56, 85, 90-100`
- Modify: `console/app/usage/api/page.tsx`
- Modify: `console/app/usage/sessions/client.tsx:9, 15, 23-24, 43-44, 70-71, 78-93, 96-97`
- Modify: `console/app/usage/sessions/page.tsx`
- Modify: `console/app/dashboard-usage.tsx:23, 103-108, 119-129`
- Modify: `console/app/deployments/[name]/stats.tsx:32, 89-94, 105-115`
- Modify: `console/app/sessions/page.tsx:34`
- Modify: `console/app/sessions/[id]/page.tsx:16`

**Interfaces:**
- Consumes: the wire shape from Task 2 — `costs: { currency, real, billed, tokensOnly? } | null`.
- Produces: `costSeries(showReal, showBilled)` from `console/app/usage/shared.tsx`; `CostCards` and `UsageTable` both take `showReal: boolean; showBilled: boolean` in place of `showCosts`.

- [ ] **Step 1: Add the series filter and split the shared components**

In `console/app/usage/shared.tsx`, add below `COST_SERIES` (line 26):

```ts
/** Per-ledger chart series (spec 2026-07-15): a disabled ledger drops its
 *  series. With both off the CALLER renders no chart at all — never call this
 *  expecting an empty array to hide anything. */
export const costSeries = (showReal: boolean, showBilled: boolean) =>
  COST_SERIES.filter((s) => (s.key === "real_cost" ? showReal : showBilled));
```

Replace `CostCards` (lines 32-41):

```tsx
export function CostCards({ totals, currency, extra, hint, showReal, showBilled }: {
  totals: Row; currency: string; extra?: { real: number; billed: number } | null; hint?: string;
  showReal: boolean; showBilled: boolean;
}) {
  const real = Number(totals.real_cost ?? 0) + (extra?.real ?? 0);
  const billed = Number(totals.billed_cost ?? 0) + (extra?.billed ?? 0);
  return (<>
    {showReal && <div className="card"><h3>Real costs{hint ? ` ${hint}` : ""}</h3>
      <div className="big">{fmtCost(real, currency)}</div></div>}
    {showBilled && <div className="card"><h3>Billed costs{hint ? ` ${hint}` : ""}</h3>
      <div className="big">{fmtCost(billed, currency)}</div></div>}
  </>);
}
```

Replace `UsageTable` (lines 43-71):

```tsx
export function UsageTable({ rows, first, firstKey, labeler, sessions, showReal, showBilled, currency }: {
  rows: Row[]; first: string; firstKey: string; labeler?: (r: Row) => string;
  sessions?: boolean; showReal: boolean; showBilled: boolean; currency: string;
}) {
  // Derived, not hard-coded: first + requests + in + out, plus the optional
  // sessions / real / billed columns.
  const cols = 4 + (sessions ? 1 : 0) + (showReal ? 1 : 0) + (showBilled ? 1 : 0);
  return (
    <div className="tablewrap" style={{ marginBottom: 22 }}><table>
      <thead><tr>
        <th>{first}</th>{sessions && <th>Sessions</th>}<th>Requests</th>
        <th>Input tokens</th><th>Output tokens</th>
        {showReal && <th>Real costs</th>}{showBilled && <th>Billed costs</th>}
      </tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{labeler ? labeler(r) : <code>{r[firstKey]}</code>}</td>
            {sessions && <td>{r.sessions}</td>}
            <td>{r.requests}</td>
            <td>{fmt(Number(r.tokens_in ?? 0))}</td><td>{fmt(Number(r.tokens_out ?? 0))}</td>
            {showReal && <td>{fmtCost(Number(r.real_cost ?? 0), currency)}</td>}
            {showBilled && <td>{fmtCost(Number(r.billed_cost ?? 0), currency)}</td>}
          </tr>
        ))}
        {rows.length === 0 && <tr><td colSpan={cols} className="empty">No usage in this range.</td></tr>}
      </tbody>
    </table></div>
  );
}
```

- [ ] **Step 2: Update Usage — API**

In `console/app/usage/api/client.tsx`, change the import (line 8) to pull `costSeries` instead of `COST_SERIES`:

```ts
import { RANGES, DEFAULT_RANGE, TOKEN_SERIES, costSeries, fmt, nonZero, CostCards, UsageTable, type Row } from "../shared";
```

Change the `Gw` interface (line 10) and the component signature (lines 12-14):

```ts
interface Gw { bucket: string; buckets: Row[]; totals: Row; byDeployment: Row[]; byKey: Row[];
  costs: { currency: string; real: boolean; billed: boolean } | null }

export function ApiUsageClient({ deployments, initialKeys }: {
  deployments: string[]; initialKeys: Row[];
}) {
```

Replace line 56:

```ts
  const showReal = !!gw?.costs?.real;
  const showBilled = !!gw?.costs?.billed;
```

Replace line 85:

```tsx
        {gw && <CostCards totals={gw.totals} currency={cur} showReal={showReal} showBilled={showBilled} />}
```

Replace lines 90-94:

```tsx
      {(showReal || showBilled) && (<>
        <div className="group" style={{ padding: "0 0 8px" }}>Token costs per {gw?.bucket === "week" ? "week" : "day"}</div>
        <UsageBars buckets={gw?.buckets ?? []} series={costSeries(showReal, showBilled)} mode="group"
                   format={(n) => fmtCost(n, cur)} unit={`${currencySymbol(cur)} / ${gw?.bucket === "week" ? "week" : "day"}`} />
      </>)}
```

Replace the two `showCosts={showCosts}` props on the tables (lines 97 and 100) with:

```tsx
                  showReal={showReal} showBilled={showBilled} currency={cur} />
```

- [ ] **Step 3: Drop the settings fetch from the Usage — API page**

`console/app/usage/api/page.tsx` uses `/v1/settings` for nothing but `costsOn`. Replace the whole file:

```tsx
import { wsGet } from "../../lib/api";
import { ApiUsageClient } from "./client";

export const dynamic = "force-dynamic";

export default async function ApiUsagePage() {
  const [deps, keys] = await Promise.all([
    wsGet<{ deployments: { name: string }[] }>("/v1/deployments?limit=1000").catch(() => ({ deployments: [] })),
    wsGet<{ keys: any[] }>("/v1/api-keys?include=deleted&limit=1000").catch(() => ({ keys: [] })),
  ]);
  return (
    <>
      <div className="pagehead"><h1>Usage — API</h1></div>
      <p className="sub">External traffic through your API keys, metered at the gateway per key and deployment. Managed-agent runs live under Usage — Sessions.</p>
      <ApiUsageClient deployments={deps.deployments.map((d) => d.name)} initialKeys={keys.keys} />
    </>
  );
}
```

- [ ] **Step 4: Update Usage — Sessions**

In `console/app/usage/sessions/client.tsx`, change the import (line 9):

```ts
import { RANGES, DEFAULT_RANGE, TOKEN_SERIES, costSeries, fmt, nonZero, CostCards, UsageTable, type Row } from "../shared";
```

Change the `Su.costs` type (line 15):

```ts
  costs: { currency: string; real: boolean; billed: boolean } | null;
```

Change the component signature (lines 23-25):

```ts
export function SessionUsageClient({ deployments, agents }: {
  deployments: string[]; agents: { id: string; name: string }[];
}) {
```

Replace line 44:

```ts
  const showReal = !!su?.costs?.real;
  const showBilled = !!su?.costs?.billed;
```

Replace lines 70-71:

```tsx
        {su && <CostCards totals={su.totals} currency={cur} extra={su.timeCosts}
          hint={deployment ? "(tokens only)" : undefined} showReal={showReal} showBilled={showBilled} />}
```

Replace lines 78-93 (both charts) with:

```tsx
      {(showReal || showBilled) && (<>
        <div className="group" style={{ padding: "0 0 8px" }}>Token costs per {su?.bucket === "week" ? "week" : "day"}</div>
        <UsageBars buckets={su?.buckets ?? []} series={costSeries(showReal, showBilled)} mode="group"
                   format={(n) => fmtCost(n, cur)} unit={`${currencySymbol(cur)} / ${su?.bucket === "week" ? "week" : "day"}`} />

        <div className="group" style={{ padding: "0 0 8px" }}>
          Session infrastructure costs per {su?.bucket === "week" ? "week" : "day"}
          {deployment && <span style={{ marginLeft: 10, fontSize: 11, color: "var(--muted)" }}>
            not deployment-attributable — clear the deployment filter to see them
          </span>}
        </div>
        {deployment
          ? <div className="empty" style={{ marginBottom: 22 }}>Environment uptime and session-minute billing are not tied to a deployment.</div>
          : <UsageBars buckets={su?.timeCostBuckets ?? []} series={INFRA_SERIES.filter((s) => (s.key === "real" ? showReal : showBilled))}
                       mode="stack" format={(n) => fmtCost(n, cur)}
                       unit={`${currencySymbol(cur)} / ${su?.bucket === "week" ? "week" : "day"}`} />}
      </>)}
```

(`INFRA_SERIES` keys are `real`/`billed`, not `real_cost`/`billed_cost`, so it filters inline rather than via `costSeries`. `mode="stack"` stays — a single-series stack renders correctly.)

Replace line 97:

```tsx
                  sessions showReal={showReal} showBilled={showBilled} currency={cur} />
```

- [ ] **Step 5: Drop the settings fetch from the Usage — Sessions page**

Replace the whole of `console/app/usage/sessions/page.tsx`:

```tsx
import { wsGet } from "../../lib/api";
import { SessionUsageClient } from "./client";

export const dynamic = "force-dynamic";

export default async function SessionUsagePage() {
  const [deps, agents] = await Promise.all([
    wsGet<{ deployments: { name: string }[] }>("/v1/deployments?limit=1000").catch(() => ({ deployments: [] })),
    wsGet<{ agents: { id: string; name: string }[] }>("/v1/agents?limit=1000").catch(() => ({ agents: [] })),
  ]);
  return (
    <>
      <div className="pagehead"><h1>Usage — Sessions</h1></div>
      <p className="sub">Managed-agent runs: model tokens plus session infrastructure — environment uptime and per-minute session billing. External API-key traffic lives under Usage — API.</p>
      <SessionUsageClient deployments={deps.deployments.map((d) => d.name)}
                          agents={agents.agents.map((a) => ({ id: a.id, name: a.name }))} />
    </>
  );
}
```

- [ ] **Step 6: Update the dashboard panel**

In `console/app/dashboard-usage.tsx`, change the import (line 9):

```ts
import { TOKEN_SERIES, costSeries } from "./usage/shared";
```

Change the `Stats.costs` type (line 23):

```ts
  costs: { currency: string; tokensOnly: boolean; real: boolean; billed: boolean } | null;
```

Add below line 64 (`const tokensOnly = …`):

```ts
  const showReal = !!stats?.costs?.real;
  const showBilled = !!stats?.costs?.billed;
```

Replace lines 103-108:

```tsx
        {stats?.costs && showReal && (
          <div className="card"><h3>Real cost{tokensOnly}</h3>
            <div className="big">{fmtCost(stats.totals.real_cost, stats.costs.currency)}</div></div>)}
        {stats?.costs && showBilled && (
          <div className="card"><h3>Billed cost{tokensOnly}</h3>
            <div className="big">{fmtCost(stats.totals.billed_cost, stats.costs.currency)}</div></div>)}
```

Replace line 126 (the cost `UsageBars` `series` prop):

```tsx
          ? <UsageBars buckets={buckets} labelKey="label" series={costSeries(showReal, showBilled)} mode="group" format={fmtC}
```

The `{stats?.costs && (<>` wrapper at line 119 already yields the right behavior: the server sends `costs: null` when both ledgers are off, so the header and chart disappear together.

- [ ] **Step 7: Update the deployment Stats tab**

In `console/app/deployments/[name]/stats.tsx`, change the `Stats.costs` type (line 32):

```ts
  costs: { currency: string; tokensOnly: boolean; real: boolean; billed: boolean } | null;
```

Change the import on line 8:

```ts
import { TOKEN_SERIES, costSeries } from "../../usage/shared";
```

Then add below line 61 (`const fmtC = …`):

```ts
  const showReal = !!stats?.costs?.real;
  const showBilled = !!stats?.costs?.billed;
```

Replace lines 89-94:

```tsx
        {stats?.costs && showReal && (
          <div className="card"><h3>Real cost{stats.costs.tokensOnly ? " (tokens only)" : ""}</h3>
            <div className="big">{fmtCost(stats.totals.real_cost, stats.costs.currency)}</div></div>)}
        {stats?.costs && showBilled && (
          <div className="card"><h3>Billed cost{stats.costs.tokensOnly ? " (tokens only)" : ""}</h3>
            <div className="big">{fmtCost(stats.totals.billed_cost, stats.costs.currency)}</div></div>)}
```

Replace line 112 (the cost `UsageBars` `series` prop):

```tsx
          ? <UsageBars buckets={buckets} labelKey="label" series={costSeries(showReal, showBilled)} mode="group" format={fmtC}
```

- [ ] **Step 8: Drop the leading conjunct on both session gates**

`console/app/sessions/page.tsx` line 34:

```ts
  const showBilled = !!(c?.billing?.enabled && c.billing?.showSessionCosts);
```

`console/app/sessions/[id]/page.tsx` line 16:

```ts
  const cost = settings?.costs?.billing?.enabled && settings.costs.billing?.showSessionCosts
    ? { show: true, currency: settings.costs.currency as string } : null;
```

Both pages keep their `/v1/settings` fetch — they read the billing sub-flags, which the stats payload does not carry.

- [ ] **Step 9: Typecheck and build**

Run: `cd console && npx tsc --noEmit && npx next build`

Expected: tsc clean; build succeeds. A `showCosts` type error means a `CostCards`/`UsageTable` call site was missed — the compiler enumerates them.

- [ ] **Step 10: Commit**

```bash
git add console/app/usage console/app/dashboard-usage.tsx "console/app/deployments/[name]/stats.tsx" console/app/sessions/page.tsx "console/app/sessions/[id]/page.tsx"
git commit -m "feat(console): show each cost ledger on its own switch

Real cost surfaces follow costs.enabled, billed cost surfaces follow
billing.enabled, independently — tiles, table columns and all five
charts. Both off drops the chart and its header.

The costs meta from the server is now the single source of visibility,
so the costsOn prop and the /v1/settings fetch leave both usage pages.
UsageTable's empty-state colSpan is derived rather than hard-coded,
which also fixes its long-standing off-by-one under the sessions column."
```

---

### Task 5: Price-input field gates

Without this, enabling billing alone shows billed-cost UI with no way to enter a billing price.

**Files:**
- Modify: `console/app/deployments/deploy-modal.tsx:88`
- Modify: `console/app/environments/create.tsx:64`

**Interfaces:**
- Consumes: `useCostSettings()` from `console/app/lib/prices.tsx` (unchanged).
- Produces: nothing.

- [ ] **Step 1: Widen the deployment billing gate**

`console/app/deployments/deploy-modal.tsx` line 88:

```ts
  const billOn = !!cost?.billing.enabled;
```

Lines 89-92 are unchanged: `showDepTime`/`showLocalTok`/`showExtBill` build on `billOn`, and `showExtReal` (line 91) keeps `!!cost?.enabled && cost.trackExternalCosts` — it is a real-cost field.

- [ ] **Step 2: Widen the session billing gate**

`console/app/environments/create.tsx` line 64:

```ts
  const showSesBill = !!cost?.billing.enabled && cost.billing.billSessionTime;
```

Line 63 (`showEnvReal`) is unchanged — it is a real-cost field.

- [ ] **Step 3: Typecheck**

Run: `cd console && npx tsc --noEmit`

Expected: no errors. The `cost!.currency` non-null assertions at `deploy-modal.tsx:301` and `create.tsx:257` stay valid — each is still behind a guard that implies `cost != null`.

- [ ] **Step 4: Commit**

```bash
git add console/app/deployments/deploy-modal.tsx console/app/environments/create.tsx
git commit -m "fix(console): billing price fields follow billing.enabled

Both gates ANDed costs.enabled, so enabling billing alone showed billed
cost UI with no way to enter a price. Real-cost field gates are unchanged.

Stored prices are unaffected either way: mergePriceDoc seeds from the
fetched doc and skips invisible edits."
```

---

### Task 6: Full verification against the live cluster

The repo rule: restart CP + console and exercise the touched flow against the live cluster before claiming done.

**Files:** none — verification only.

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: a verification record for the final commit message.

- [ ] **Step 1: Run the full backend suite and typecheck**

Run: `cd control-plane && npx tsc --noEmit && npm test`

Expected: tsc clean; suite green. Do not proceed on a red suite.

- [ ] **Step 2: Build the console**

Run: `cd console && npx tsc --noEmit && npx next build`

Expected: both clean.

- [ ] **Step 3: Restart both processes**

A console rebuild under a running `next start` pins old chunk hashes — restart it, don't just rebuild.

```bash
# control plane (NOT `npm run dev` — it exits under tool backgrounding)
cd control-plane && DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev27 \
  DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files \
  npx tsx src/main.ts

# console (separate shell)
cd console && npx next start -p 7090
```

- [ ] **Step 4: Walk the four toggle combinations**

For each combination below, set it on `/settings`, Save, then load every surface and confirm the expected columns/tiles/charts. Both ledgers on is the pre-change baseline — it must look exactly as it did before.

| # | Enable cost tracking | Enable billing | Expected on every cost surface |
|---|---|---|---|
| 1 | off | off | no cost tiles, no cost columns, no cost charts, no chart headers |
| 2 | on | off | Real only — one tile, one column, one series per chart |
| 3 | off | on | Billed only — one tile, one column, one series per chart |
| 4 | on | on | both (unchanged baseline) |

Surfaces to check in each combination — all must return 200:
- `/settings` — Currency always visible and first; Real costs and Billing headings always visible; "Enable cost tracking" first under Real costs, revealing exactly 3 checkboxes; "Enable billing" revealing exactly 5
- `/` (dashboard Usage panel)
- `/deployments/<name>` → Stats tab
- `/usage` (API)
- `/usage/sessions`
- `/sessions` — "Billed" column follows billing.enabled + showSessionCosts
- `/sessions/<id>` — cost chip follows the same two flags

- [ ] **Step 5: Verify billing accrues with cost tracking off**

This is the behavior change that a UI-only fix would have missed.

Set combination 3 (cost tracking OFF, billing ON) with `billLocalTokens` on and a token price on a local deployment. Run a session, then confirm the billed cost is non-zero and the real cost is untracked:

```bash
psql "$DEVPROOF_DATABASE_URL" -c \
  "SELECT model, tokens_in, real_cost, billed_cost FROM gateway_usage ORDER BY id DESC LIMIT 3;"
```

Expected: `billed_cost` non-NULL and > 0; `real_cost` NULL. Before this change, both were NULL.

Confirm the session chip ticks and `/usage/sessions` shows a Billed column with no Real column.

- [ ] **Step 6: Restore your settings and commit the verification note**

Return `/settings` to whatever the environment had before, then:

```bash
git commit --allow-empty -m "test: verify cost/billing independence against the live cluster

All four toggle combinations walked across settings, dashboard, the
deployment Stats tab, both usage pages, the sessions list and the session
chip; every page 200s in every combination.

Confirmed the behavior change a UI-only fix would have missed: with cost
tracking off and billing on, gateway_usage rows stamp billed_cost with
real_cost NULL, and the session chip ticks."
```

---

## Notes for the implementer

- **Do not "fix" `--test-concurrency=1`** in `control-plane/scripts/run-tests.mjs`. The 44 test files share one dev database; parallel runs deadlock on `migrate()` DDL and race the `app_settings` singleton. Measured: parallel = 3 of 4 runs fail.
- **Task 1 is the only task with a behavior change users can't see.** Tasks 3-5 are visibility; Task 1 changes what gets written to the ledger. Review it hardest.
- **If a test in `cost-stamping.test.ts` reports `skip`,** the dev Postgres is unreachable. Those tests cannot validate the trigger offline — start the database rather than accepting a skip.
- **Pre-existing issues deliberately untouched** (spec §"Non-goals"): `PUT /v1/settings` resets the cost block when a body omits `costs`; `useCostSettings()` refetches per dialog uncached. Do not fix these here.
