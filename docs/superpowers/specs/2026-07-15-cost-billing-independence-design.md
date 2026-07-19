# Cost tracking & billing independence — design (2026-07-15)

Approved section-by-section in brainstorming. Amends the cost-tracking design
(`2026-07-14-cost-tracking-design.md`) on two points: `costs.enabled` stops
being a master switch and becomes the real-cost switch, a sibling of
`costs.billing.enabled`; and every cost surface gates each ledger on its own
switch instead of on `costs.enabled` alone.

## Motivation

Two defects, one root cause — the 2026-07-14 design made `costs.enabled` a
master gate over the billing subtree:

1. **Settings layout.** `form.tsx:87` wraps Currency, both section headings and
   the entire Billing subtree in `{c.enabled && …}`, so Billing is visually and
   functionally a child of cost tracking rather than its sibling.
2. **Display gating.** Every tile, table column and chart gates on
   `costs.enabled` alone — never on `billing.enabled`, never on the three
   `trackX` flags. A "Billed cost" tile therefore renders `0.00 €` with billing
   fully off, and hides when billing is on but cost tracking is off.

## Decisions (user-confirmed)

- **Full independence.** Billing accrues *and* displays purely on
  `billing.enabled`, regardless of `costs.enabled`. The reverse also holds.
  This is a behavior change to the trigger and the sampler, not just the UI.
- **`enabled` narrows in meaning, not in shape.** It becomes "real cost
  tracking on/off". `data.costs` keeps its exact JSON shape — no migration, no
  `normalizeCostSettings`/`validateCostSettings` change.
- **The three `trackX` flags never affect visibility.** They gate accrual and
  price-input fields only. Real-cost UI appears whenever `costs.enabled` is on,
  even if all three are off (a guaranteed-`0.00` tile is accepted — the flags
  are too fine-grained to hide a shared column).
- **Per-series charts.** Both ledgers off ⇒ no chart and no header; one ledger
  on ⇒ that series alone; both on ⇒ today's two-series chart.
- **Label stays "Enable cost tracking"**, moved under the "Real costs" heading
  as its first row; only its hint changes.

## 1. Settings layout

`console/app/settings/form.tsx` — the `{c.enabled && (<>` at :87 shrinks to
wrap **only** the three tracking checkboxes (:101-109). Currency (:88-98), both
`<Section>` headings (:100, :111) and the whole Billing subtree (:112-131) move
outside it. Target structure inside the unchanged "Cost tracking" accordion:

```
Currency  [EUR (€) ▾]          always visible — first item, unmoved

Real costs      "What the platform costs you — infrastructure and external tokens."
[x] Enable cost tracking       ← first row under the heading
  {c.enabled && …}
  [x] Pool cost tracking
  [ ] External deployment cost tracking
  [ ] Environment cost tracking

Billing         "What consumers are charged — may exceed real costs."
[x] Enable billing             ← behavior unchanged
  {c.billing.enabled && …}
  [x] Show real-time costs in sessions
  [ ] Session billing
  [ ] External token billing
  [ ] Local token billing
  [ ] Time-based deployment billing
```

The `Row` (:13-23) and `Section` (:25-32) components are untouched. The
"Enable cost tracking" hint changes from "master switch — off means nothing
accrues and no cost UI appears anywhere" to "tracks what the platform costs
you — off means no real cost accrues or is shown".

## 2. Display gating

**One rule everywhere: real ⇐ `costs.enabled`, billed ⇐ `costs.billing.enabled`,
independently.**

The four polling surfaces never read `/v1/settings` — they infer visibility
from the `costs` object embedded in each stats response. That object therefore
becomes the single carrier of both flags. Replaces the four
`settings.enabled ? { … } : null` sites in `control-plane/src/agents-api.ts`
(:377, :395, :883, :896):

```ts
costs: (settings.enabled || settings.billing.enabled)
  ? { currency: settings.currency, tokensOnly, real: settings.enabled, billed: settings.billing.enabled }
  : null
```

(the `/v1/usage` and `/v1/usage/gateway` variants at :883/:896 carry no
`tokensOnly`, as today). `opts.costs` (:374, :392) gates on the same
`enabled || billing.enabled` disjunction, so both sums are computed whenever
either ledger is on and the UI picks — repo SQL is untouched.

Consumers read `costs.real` / `costs.billed` instead of mere existence. This
retires the `costsOn` prop and the `costsOn && !!gw?.costs` double-gate
(`usage/api/client.tsx:56`, `usage/sessions/client.tsx:44`), leaving one source
of truth. Both `usage/api/page.tsx` and `usage/sessions/page.tsx` use their
`/v1/settings` fetch for nothing but `costsOn={!!settings?.costs?.enabled}`
(verified), so the `wsGet("/v1/settings")` call, the `CostSettings` import and
the prop are all removed from both — one fewer request per page load. The
sessions pages keep their fetch (they still read the billing sub-flags).

| Site | Change |
|---|---|
| `dashboard-usage.tsx:23`, `deployments/[name]/stats.tsx:32` | `Stats.costs` type gains `real: boolean; billed: boolean` |
| `dashboard-usage.tsx:103-108`, `stats.tsx:89-94` | each tile renders on its own flag |
| `dashboard-usage.tsx:119-129`, `stats.tsx:105-115` | cost block renders if either flag; series filtered |
| `usage/shared.tsx:32-41` (`CostCards`) | `showReal`/`showBilled` props replace unconditional pair |
| `usage/shared.tsx:43-71` (`UsageTable`) | `showCosts` splits into `showReal`/`showBilled`; `colSpan` derived |
| `usage/api/client.tsx:85, 90-94, 96-100` | cards, chart, two tables |
| `usage/sessions/client.tsx:70-71, 78-93, 96-97` | cards, both charts, table |
| `sessions/page.tsx:34`, `sessions/[id]/page.tsx:16` | drop leading `c.enabled &&` |

**The five cost charts**, all following the per-series rule:

| Chart | Page | Series |
|---|---|---|
| "Token costs per day/week" | `/usage` | `COST_SERIES` (real, billed) |
| "Token costs per day/week" | `/usage/sessions` | `COST_SERIES` |
| "Session infrastructure costs per day/week" | `/usage/sessions` | `INFRA_SERIES` (env uptime = real, session minutes = billed) |
| "Cost per Ns" | Dashboard | `COST_SERIES` |
| "Cost per Ns" | Deployment → Stats | `COST_SERIES` |

`COST_SERIES` (`shared.tsx:23-26`) and `INFRA_SERIES`
(`usage/sessions/client.tsx:18-21`) are filtered at the call site by the two
flags. `INFRA_SERIES` keeps `mode="stack"` — a single-series stack renders
correctly. `/usage/sessions`' existing rule that infra costs are hidden under a
deployment filter (:89-92) is unchanged and composes with this.

## 3. Accrual independence

**Three** master gates fall — the sampler's short-circuit, the pure accrual
function, and the SQL trigger. All three must go together: fixing
`computeAccruals` alone would be dead code, because `cost-sampler.ts:35`
returns before ever calling it.

**`control-plane/src/cost-sampler.ts:26-28`** — `needsTime` currently ANDs
`s.enabled` over the whole disjunction, including the billing terms. It splits
per ledger:

```ts
const needsTime = (s: CostSettings) =>
  (s.enabled && (s.trackPoolCosts || s.trackEnvCosts)) ||
  (s.billing.enabled && (s.billing.billSessionTime || s.billing.billDeploymentTime));
```

The remaining two gates fall as follows. Both branches below them already test
their own flag, so nothing else moves.

**`control-plane/src/costs.ts:191`** — delete
`if (!settings.enabled) return { entries, sessionBilled };`. Then:

- `wantsPool` (:204) → `settings.enabled && settings.trackPoolCosts && !!poolP`
- `env_pod` (:246) → `settings.enabled && settings.trackEnvCosts && envP`
- `wantsDep` (:205) and `session_time` (:252) already gate on the local
  `billing` const (:194) — unchanged.

The zero-cost first-sighting rows (:213-218) follow `wantsPool`/`wantsDep` and
stay correct under the split.

**`control-plane/sql/032_token_price_shape.sql:29`** — drop the
`OR NOT COALESCE((cfg->>'enabled')::boolean, false)` conjunct, keeping
`IF cfg IS NULL THEN RETURN NEW`. **Edit 032, not 031** — 032 sorts after 031
and `CREATE OR REPLACE`s the function on every boot (its own header says so), so
no new migration file is needed and the 031 trigger binding is untouched.

**The external real-cost branch needs an `enabled` check ADDED** (corrected
2026-07-15 during implementation; an earlier draft of this spec wrongly claimed
all per-branch checks were already independent). The billing branches do test
their own flag — :44 external and :56 local both read
`{billing,enabled}` — but the external *real* branch at :37 reads only
`trackExternalCosts` and relied entirely on the master gate for `enabled`:

```sql
IF COALESCE((cfg->>'trackExternalCosts')::boolean, false) AND pr #> '{real,tokens}' IS NOT NULL THEN
```

Dropping the master gate without adding `COALESCE((cfg->>'enabled')::boolean,
false) AND` here would stamp `real_cost` with cost tracking off — silent ledger
corruption with no visible symptom. There is no local *real* branch by design
(local real cost is pool pod-time, accrued by the sampler), so :37 is the only
such hole. Caught by the §5 trigger test, which sets `trackExternalCosts: true`
alongside `enabled: false` precisely to prove the real ledger obeys `enabled`
and not the sub-flag.

## 4. Price-input fields

Gated identically today, so billing would otherwise have nothing to price:

- `console/app/deployments/deploy-modal.tsx:88` — `billOn` drops
  `!!cost?.enabled &&` → `!!cost?.billing.enabled`
- `console/app/environments/create.tsx:64` — `showSesBill` drops
  `!!cost?.enabled &&`

Real-cost field gates correctly keep theirs: `pool-modal.tsx:37`,
`create.tsx:63`, `deploy-modal.tsx:91` (`showExtReal`).

Note `cost!.currency` is dereferenced inside these guards
(`pool-modal.tsx:168`, `create.tsx:253/257`, `deploy-modal.tsx:301`); each
remains guarded by a flag that implies `cost != null`, so the non-null
assertions stay valid.

**No price data is at risk:** `mergePriceDoc` (`lib/prices.tsx:47-56`) seeds
from the fetched document and skips invisible edits, so a hidden sub-object
survives a save — the 2026-07-14 promise that "stored prices survive toggling"
continues to hold under the wider gates.

## 5. Testing & verification

- **`computeAccruals` unit tests** — the four-way matrix: billing-only accrues
  `session_time`/`deployment_time` and no `pool_pod`/`env_pod`; tracking-only
  the reverse; both on accrues all four; both off accrues nothing. Plus:
  billing-only still plants the `deployment_time` first-sighting row.
  **`test/costs-accrual.test.ts:132-148` ("toggles gate each kind
  independently; master off = nothing") encodes the old master gate at :140 and
  MUST be updated, not deleted** — it is the regression test for this change.
- **`needsTime` unit tests** — billing-only settings must return true (proving
  the sampler no longer short-circuits before `computeAccruals`).
- **`test/agents-api.test.ts:129`** stubs `getCostSettings()` as
  `{ enabled: false, currency: "EUR" }` with **no `billing` key**; the new
  `settings.billing.enabled` read would throw a TypeError. The stub must return
  the full shape (`{ ...DEFAULT_COST_SETTINGS }`). Production is unaffected —
  `repo.getCostSettings` always runs `normalizeCostSettings` (`repo.ts:1296`).
- **Trigger tests** — billing-only stamps `billed_cost` with `real_cost` NULL
  and accumulates `sessions.billed_cost`; tracking-only stamps `real_cost` on
  external models with `billed_cost` NULL; both off leaves both NULL.
- **Query/type** — `npx tsc --noEmit`; `npm test` (Node runner, sweeps its own
  throwaway workspaces).
- **Live, per the repo verify rule** — restart CP + console, then walk all four
  toggle combinations across: settings page, dashboard Usage panel, deployment
  Stats tab, `/usage`, `/usage/sessions`, sessions list "Billed" column, and the
  session header chip. Confirm every page 200s in each combination.

## Non-goals / known issues left alone

- `PUT /v1/settings` (`agents-api.ts:821-822`) runs `normalizeCostSettings`
  unconditionally, so a body omitting `costs` resets the whole cost block to
  all-false — unlike `limits`/`storage`/`appearance`, which persist-when-
  provided. Pre-existing; the console always sends `costs`.
- `useCostSettings()` (`lib/prices.tsx:14-21`) refetches `/v1/settings` per
  dialog with no cache or dedupe. Pre-existing.
- `UsageTable`'s empty-state `colSpan` (`shared.tsx:67`) ignores the `sessions`
  column. Pre-existing cosmetic bug; the `colSpan` expression is rewritten by
  §2 anyway, so fixing it there is optional and free.
- Renaming `costs.enabled` → `costs.trackReal` (shape change + migration) —
  the narrowed meaning is documented instead.
