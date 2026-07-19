# Deployment UI Rework — Local + Remote as One Deployment Concept

**Date:** 2026-07-09
**Status:** Approved (brainstorming session)
**Relationship to prior specs:** keeps the data model and gateway machinery of
`2026-07-09-external-providers-deployments-design.md` (external_deployments,
provider keys in the `gateway-provider-keys` Secret, metering by `model_group`,
sanitizer scoped to `devproof_local`). Supersedes the never-built
catalog-rework spec of the same date. **This is a UI-quality rework, not an
architecture change.**

## Problem

The merged external-endpoints feature works but its UI is poor:
1. **"Add endpoint" is misplaced** — rendered inline above the table; opening it
   is a card that shifts the table down.
2. **Edit is `prompt()`/`confirm()` popups** — a nightmare.
3. **Local "Deploy" is impoverished** — a bare button that auto-generates the
   name and hardcodes `cpu-default` with no pool/replica/context choice.

## Framing (the decision that shapes everything)

**A remote endpoint is a *kind of deployment*, not a catalog entry or a separate
section.** A deployment is a named, gateway-routable model; local ones run on a
cluster pod, remote ones proxy to a provider — same object, different backend.
Consequences:

- Everything stays on the **Deployments page**. The catalog stays local-only
  (self-hostable models with hardware/cost profiles — meaningless for remote
  APIs). **No catalog change, no migration.**
- **Name uniqueness is already guaranteed:** one flat gateway `model_name`
  namespace; create routes 409 in both directions (local-vs-external and
  external-vs-local, the latter added in the prior feature's final review).
- **Token usage already works:** the gateway meters every request per deployment
  name (`model_group` attribution), so remote deployments already appear on the
  Usage page's deployment filter. Nothing new needed.

Future extension (explicitly out of scope, non-blocking): a shared **Connection**
object (provider + URL + credential) that many deployments reference, for the
"one API key unlocks many models" case. Treating endpoints as deployments now
does not foreclose it — a deployment would later point at a connection instead
of holding its own key.

## Scope: UI only

No changes to migrations, the `external_deployments` schema, repo methods, the
gateway `custom_callbacks.py`, or the auth/metering/sanitizer/sync machinery.
The route surface is unchanged except one additive field (local deploy
`contextTokens`). All work is in the console plus one small control-plane
passthrough.

## Components

### 1. Shared Deploy/Edit modal (`console/app/deployments/deploy-modal.tsx`, new)

One client component, a centered-overlay modal reusing the existing
`AddCustomModel` pattern (`fixed inset-0` scrim + `.card`, ~560px). Four modes
via a `mode` prop; fields switch by mode. No `prompt()`/`confirm()` anywhere.

| Mode | Opened from | Fields | Submits |
|---|---|---|---|
| `deploy-local` | catalog row "Deploy" | name, pool ▾ (`/v1/pools`), replicas min/max, context tokens | `POST /v1/deployments {name, catalogId, poolRef, replicas, contextTokens}` |
| `deploy-remote` | Deployments "Add endpoint" | name, provider ▾ (presets fill baseUrl), model id, base URL, API key (write-only) + **Test** | `POST /v1/deployments/external {name, provider, baseUrl?, modelId, apiKey?}` |
| `edit-local` | deployment row "Edit" (local) | replicas min/max, context tokens (name/pool shown read-only) | `PATCH /v1/deployments/:name {replicas, contextTokens}` |
| `edit-remote` | deployment row "Edit" (external) | model id, base URL, API key (rotate) + **Test** | `PATCH /v1/deployments/external/:id {modelId?, baseUrl?, apiKey?}` |

- **Layout** (approved earlier): labeled rows, one field group per row, aligned;
  provider modes show a "runs on: remote (<provider>)" line. Buttons
  right-aligned: `Cancel` / `Deploy` (or `Save`).
- **Validation (client, mirrors server):** name required + non-empty on create;
  `custom` provider requires baseUrl; Save/Deploy disabled until required fields
  present. Name immutable on edit.
- **Test connection:** button in remote modes → `POST
  /v1/deployments/external/test`, shows `✓ reachable` / `✗ <detail>` inline.
- **Error + network safety:** every fetch wrapped in try/catch/finally — a
  non-ok response alerts the server error; a network throw alerts and never
  strands the busy state (the failure mode the prior add-form had).

### 2. Deployments page (`console/app/deployments/page.tsx`, modify)

- Move endpoint creation into the **pagehead** as a header action:
  `<div className="formrow"><AddEndpointButton/><SyncButton/><RefreshButton/></div>`
  — `AddEndpointButton` now just opens the modal in `deploy-remote` mode (no
  inline card). Matches how `+ Add custom model` sits in the catalog header.
- Row **Edit** actions open the shared modal (`edit-local` / `edit-remote`)
  instead of `prompt()`. Delete stays as the existing confirm-based
  `DeploymentActions` / external delete (a single confirm on a destructive
  action is fine; the ban is on `prompt()`-for-input and multi-prompt edits).
- Remote rows keep `remote` in the Pool column (already shipped) and the
  `External` phase chip.

### 3. Catalog "Deploy" button (`console/app/actions.tsx` / `catalog` usage)

Replace the fire-immediately `DeployButton` (auto-name + hardcoded pool) with a
button that opens the shared modal in `deploy-local` mode, so a catalog deploy
now asks for name, pool, replicas, and context. The old auto-name behavior is
gone; the modal pre-fills a sensible default name (`<catalogId>` slug) the user
can edit.

### 4. Delete the bad UI

- `console/app/deployments/external.tsx` — the inline-card `AddEndpointButton`
  and the `prompt()`-based edit in `ExternalActions` are **removed**.
  `AddEndpointButton` becomes a thin modal opener (pagehead). `ExternalActions`
  keeps its single-confirm **delete** button and its **Edit** button now opens
  the shared modal in `edit-remote` mode (no `prompt()`).
- `console/app/deployments/edit-local.tsx` — the `prompt()` dialog is **removed**;
  replaced by the modal opener.

### 5. Control-plane: one additive field

`POST /v1/deployments` already accepts `{name, catalogId, poolRef, replicas?}`
and `resolveDeployment` honors `replicas`. Add `contextTokens?: number` to
`DeploymentRequest` and, in `resolveDeployment`, use
`req.contextTokens ?? entry.contextTokens ?? 0` for `spec.model.contextTokens`.
Nothing else changes server-side.

## Error handling

| Case | Behavior |
|---|---|
| Deploy/name collision (local or remote) | 409 (unchanged, both directions) |
| `custom` remote without baseUrl | 400 (unchanged) |
| Test connection network failure | modal shows `✗ <detail>`; never blocks |
| Any modal fetch throws (network) | alert + busy cleared (try/finally) |
| Edit local non-operational field | 400 (unchanged whitelist) |

## Testing

- **Console build** (`npx next build`) — production build only.
- **Manual/e2e (live cluster):**
  1. "Add endpoint" is in the pagehead; clicking opens a centered modal, the
     table does **not** shift.
  2. Deploy a remote `custom` endpoint (loop-back baseUrl to an in-cluster
     model) via the modal → route registered → chat with a key → usage row under
     the deploy name (confirms metering still per-deployment).
  3. Deploy a local model via the catalog → modal asks name/pool/replicas/
     context → CR reflects the chosen replicas + context (`kubectl get
     modeldeployment ... -o jsonpath` on `spec.replicas`/`spec.model.contextTokens`).
  4. Edit a local deployment (replicas) and rotate a remote key — both via the
     modal, zero `prompt()` dialogs.
  5. Regression: all console pages 200; Anthropic-dialect CLI clients still work
     against a local GGUF model (sanitizer intact); `cd control-plane && npm test && npx tsc
     --noEmit` green (the one server change compiles + existing tests pass).
- **Unit (control-plane):** extend a `resolveDeployment` test to assert
  `req.contextTokens` overrides the catalog default and `replicas` passes
  through.

## Out of scope (deliberate)

- The **Connection** object (shared credential for many models) — future.
- Moving providers into the catalog — explicitly rejected (remote APIs have no
  hardware/cost profile; catalog stays local-only).
- Migration / schema / gateway-hook changes — none.
- Carried follow-ups from the prior feature's ledger (clear-baseUrl-to-default,
  row-probe of stored keys, real-provider streaming-metering verification).

## Verified-assumption ledger

- Name uniqueness across local+remote: enforced by the existing 409 guards
  (both directions) — verified in the prior feature's final review.
- Per-deployment usage for remote endpoints: already live (`model_group`
  attribution fix), shown on the Usage page — verified in the prior e2e.
- `resolveDeployment` already honors `replicas`; only `contextTokens` is new —
  verified by reading `control-plane/src/catalog.ts`.
- The `AddCustomModel` overlay is the reusable modal pattern — verified by
  reading `console/app/catalog/create.tsx`.
