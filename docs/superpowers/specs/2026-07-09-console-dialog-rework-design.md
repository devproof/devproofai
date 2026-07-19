# Console dialog & edit rework — design

Date: 2026-07-09. Status: approved by user.

## Problem

The console's create/edit/confirm surfaces grew ad hoc:

- Deployments edit via a `✎` icon button — every other list opens a resource by
  clicking its name.
- "Add endpoint" is ambiguously named and the shared deploy modal is a bare
  stack of unlabeled `formrow`s with inline styles.
- Workspace, API-key, skill, and memory-store creation use browser `prompt()`;
  every delete uses browser `confirm()`; every error uses `alert()`.
- Catalog models cannot be edited at all (backend has only POST/DELETE); node
  selectors (a ModelPool property) have no UI anywhere.
- Agents cannot be edited from the UI even though the backend supports
  versioned edits (`POST /v1/agents/:id/versions`).

## Decisions (user-confirmed)

1. **Node selectors** are configured on a **new Pools page** under Serving
   (pools are the model→hardware mapping; node labels differ per cloud and
   per customer).
2. **All catalog models are editable** — custom models update their DB row;
   bundled models get a DB override row that shadows the YAML entry (needed so
   each installation can map models to its own node pools / resource types).
3. **Agent edit = new version** (existing backend semantics; version picker
   already in the UI).
4. Approach: **shared dialog primitives** (`Modal`, `Field`, `ConfirmDialog`),
   then migrate every flow — not per-dialog bespoke fixes, not a component
   library (fights the hand-rolled blueprint CSS identity).

## 1. Shared primitives — `console/app/lib/modal.tsx`

Styled via a new `.modal-*` block in `globals.css` reusing existing tokens
(panel, edge, shadows, condensed headings); ink-tinted backdrop with light
blur. No inline-style dialogs anywhere after migration.

**`Modal`** — the single overlay for every dialog.
- Title (condensed blueprint style), optional subtitle, widths sm 440 / md 560
  / lg 680, body scrolls at 88vh.
- Escape closes; backdrop click closes; both disabled while submitting.
  `dismissible={false}` opt-out for the copy-API-key modal (must only close via
  its explicit Done button).
- First input auto-focused.
- Standard footer: Cancel (ghost) + one primary action with busy spinner.
- Submit failures render an **inline red error banner** above the footer; the
  dialog stays open with input intact. `alert()` is banned.

**`Field`** — labeled form row: fixed label column + control + optional muted
hint line (e.g. "empty = all outbound blocked"). Placeholder-as-label is
banned; every input gets a visible label. Required fields marked; the primary
button disables until valid.

**`ConfirmDialog`** — replaces every browser `confirm()`. Small danger modal:
title with the resource name ("Undeploy qwen7b-gpu?"), one consequence
sentence, **red solid button labeled with the verb** (Delete / Undeploy /
Remove / Reset), ghost Cancel. Busy state and failure shown inline.
`DeleteButton` (`lib/delete.tsx`) swaps its `confirm()` for this internally,
so all delete sites migrate without per-page changes; the undeploy button
(`actions.tsx`) and bulk file delete (`files/table.tsx`) migrate too.

## 2. Edit entry points & per-page flows

**Pattern:** clicking a resource's **name** opens the resource — the detail
page where one exists (agents, sessions, skills, vaults, memory stores:
unchanged), the **edit dialog** where none does (deployments, catalog models,
pools). Names get the standard blue-underline link styling. Pen icons are
removed; trailing columns keep only delete/download row actions.

- **Deployments** — name cell opens the edit modal (local/remote variant);
  `✎` removed. Header button renamed **"Add remote endpoint"**. Forms get
  Field treatment (labels, hints such as "write-only — leave empty to keep
  current"; Test-connection result as a proper status line).
- **Catalog** — model name opens **Edit model**: displayName, family, source,
  format + quantization, parameters, contextTokens, license, toolCalling,
  requirements, and **capacity profiles as a list of add/removable rows**
  (gpuType, instanceType, gpusPerReplica, vramGB, estTokensPerSec,
  costPerHourUSD) — the YAML has 28 profiles across 21 models, so
  multi-profile is required. Bundled models that have been edited show an
  "overrides defaults" note and a **Reset to defaults** action (= existing
  DELETE; the YAML entry reappears). **Add custom model** is rebuilt on the
  same shared `ModelFormModal` (two modes, like the deploy modal).
- **Pools (new page `/pools`, nav group Serving)** — table: name, node
  selector, in-use-by count (join on `poolRef` from `GET /v1/deployments`).
  Create/edit modal: name + **nodeSelector as key=value rows** (add/remove)
  + the ModelPoolSpec capacity fields: gpuType, gpusPerNode, maxNodes,
  scalingMode (dynamic|static). Hint text states when selector changes take
  effect (see §3 open item).
- **Agents** — name still navigates to the detail page. There, an **Edit
  agent** button in the page head opens the shared agent form prefilled from
  the **latest version**; saving calls `POST /v1/agents/:id/versions` → new
  version appears in the existing picker. Form rebuilt: labeled fields,
  **skills as a checkbox list** (replaces the bare multi-`<select>`), labeled
  max-turns.
- **Workspaces** — sidebar "+ New workspace…" opens a small modal (name).
- **API keys** — "Create key" opens a small modal (name). Copy-your-key modal
  rebuilt on `Modal` with `dismissible={false}` and a copy-to-clipboard
  button.
- **Skills** — file picker stays first; the `prompt()` after it becomes a
  small modal: name prefilled from filename, kebab-case hint, chosen file
  shown.
- **Memory stores** — create via small modal; the memory browser's add-entry
  `prompt()` becomes a small modal with a path field.
- **Sessions / batches / environments / vaults / file upload** — no flow
  change; migrated onto `Modal`/`Field` for consistent look + inline errors.

## 3. Backend changes

**Catalog (`server.ts`):**
- `PATCH /v1/catalog/:id` — body: editable fields (displayName, family,
  parameters, format, quantization, source, license, toolCalling,
  contextTokens, requirements, capacityProfiles). Custom id → update row.
  Bundled id → merge YAML entry + patch, write via the existing upsert
  (`repo.ts` `ON CONFLICT (id) DO UPDATE`); shadowing comes free from
  `fullCatalog()` precedence (DB wins on id clash). `id` immutable.
- `GET /v1/catalog` — add `overridden: true` for DB rows whose id exists in
  YAML (drives the "overrides defaults" note + Reset action; the existing
  `custom` flag already stays false for these).
- Reset to defaults = existing `DELETE /v1/catalog/:id` (console labels it
  "Reset to defaults" for bundled ids, "Remove" for custom ones).

**Pools (`server.ts`):**
- `POST /v1/pools` — tighten to typed body `{name, nodeSelector?, gpuType?,
  gpusPerNode?, maxNodes?, scalingMode?}` (the ModelPoolSpec fields); validate
  name (DNS-1035, same slug rule as deployments).
- `PATCH /v1/pools/:name` — merge-patch spec via existing
  `kubestore.patch("modelpools", …)`.
- `DELETE /v1/pools/:name` — 409 with a clear message if any ModelDeployment
  references the pool.
- **Open item (implementation-time):** verify whether the operator
  re-reconciles existing deployments when their pool's nodeSelector changes
  (pool → `InferenceService.spec.nodeSelector` at transform time). Either
  answer works; it only changes the pools-modal hint ("applies immediately"
  vs "applies on next deployment rollout").

**No backend changes:** agents (versions endpoint exists), workspaces, API
keys, skills, memory stores.

## 4. Dialog inventory (target state)

| Flow | Today | Target |
|---|---|---|
| Deploy local / edit deployment | shared modal, pen icon, inline styles | `Modal`+`Field`; opened from name click (edit) or Deploy button |
| Add remote endpoint | "Add endpoint", bare rows | renamed; labeled fields; Test-connection status line |
| Add / edit model | placeholder-only inputs; no edit | shared `ModelFormModal`; capacity-profile rows; Reset to defaults |
| Create / edit pool | — (no UI) | new `/pools` page; nodeSelector key=value rows |
| Create / edit agent | create only; bare multi-select | shared form modal; Edit on detail page → new version; skill checkboxes |
| New workspace | `prompt()` | small modal |
| Create API key | `prompt()` + copy modal | small modal; non-dismissible copy modal + copy button |
| Create skill | picker + `prompt()` | picker + small modal (prefilled name) |
| Memory store create / add memory | `prompt()` ×2 | small modals |
| Session / batch / environment / vault / upload | bespoke overlays | migrated, no flow change |
| Deletes / undeploy / bulk delete | `confirm()` | `ConfirmDialog` |

## 5. Verification

1. Backend tests: `PATCH /v1/catalog/:id` (custom update; bundled override +
   `overridden` flag; reset via DELETE), pools PATCH + DELETE guard.
   `npm test` + `npx tsc --noEmit` (stop the control plane first — shared dev
   Postgres contention).
2. Console: production build; against the live cluster all pages 200; exercise
   name-click→edit (deployments, catalog), agent edit → version bump in
   picker, pool create/edit → selector visible via
   `kubectl get modelpool -o yaml`, workspace/API-key/skill/memory-store
   creation, one delete per kind through `ConfirmDialog`, one forced failure
   (duplicate name) renders the inline error.
3. Grep gate: `confirm\(|prompt\(|alert\(` → **zero hits** under `console/`.

## Out of scope

- Deployment detail pages; auth/RBAC; session-level env/vault attachment;
  toast/notification system (inline errors suffice); editing bundled
  `catalog/models.yaml` itself.
