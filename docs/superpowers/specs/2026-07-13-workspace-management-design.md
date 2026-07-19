# Workspace management — design

**Date:** 2026-07-13
**Status:** Approved (brainstorming session)

## Goal

Add a `Manage → Workspaces` console page and the backing control-plane API so
workspaces become first-class managed resources: rename, disable (read-only),
and delete (with all resources, tracked by a live deletion-progress view).
Replace the nav's native workspace `<select>` with an MCP-picker-style
dropdown showing name + id.

## Decisions (from brainstorming)

- **Default workspace** (`wrkspc_default`) can never be renamed, disabled, or
  deleted.
- **Disabled workspace** = read-only: every mutating call is blocked (creates,
  edits, deletes, new sessions, follow-up messages) **except**
  `POST /v1/sessions/:id/interrupt` (the emergency brake). Running turns
  complete and checkpoint normally.
- **Deletion keeps usage history**, attributable by workspace **name and id**:
  the workspace row survives as a soft-deleted tombstone; all resources are
  hard-deleted. `gateway_usage` rows are never touched
  (`gateway_usage.workspace_id` has no FK — verified 016).
- **Deletion is tracked**: status `deleting` + a progress view showing which
  resource types are drained/draining; resilient to CP restarts.

## Data model — migration 029

- `workspaces.status TEXT NOT NULL DEFAULT 'active'` —
  `active | disabled | deleting | deleted`.
- `workspaces.delete_totals JSONB` — per-resource-type counts snapshotted when
  deletion starts (the progress denominator).
- Name uniqueness: drop `workspaces_name_key`, add partial unique index
  `ON workspaces(name) WHERE status <> 'deleted'` — tombstones keep their
  name forever without blocking reuse.
- Boot-rerun safe (idempotent DDL); migration 010 untouched.

## API (control plane)

| Route | Behavior |
|---|---|
| `GET /v1/workspaces` | includes `status`; excludes `deleted` unless `?include=deleted` |
| `POST /v1/workspaces` | unchanged (create) |
| `PATCH /v1/workspaces/:id` | rename; 400 on default, 404 unknown/deleted, 409 name conflict |
| `POST /v1/workspaces/:id/status` | body `{status: "active"\|"disabled"}`; 400 on default or bad status, 404 unknown/deleted, 409 if `deleting` |
| `GET /v1/workspaces/:id/resources` | live per-resource-type counts (feeds the delete-confirm dialog; same query snapshots `delete_totals`) |
| `DELETE /v1/workspaces/:id` | 400 on default, 404 unknown/deleted; snapshots `delete_totals`, sets `deleting`, starts the deletion runner, returns **202**; repeat DELETE while `deleting` → 202 (idempotent) |
| `GET /v1/workspaces/:id/deletion` | progress: per resource type `{total, remaining, state}`; `remaining` computed live from row counts (restart-proof by construction) |

Progress is **polled** (~1.5s while `deleting`), not SSE: it is derived state
(row counts), not an event stream; deletions are rare and short-lived. The
LISTEN/NOTIFY convention remains for session events.

## Deletion runner

In-process async task started by the DELETE route; also re-launched by a boot
sweep for any workspace found in `deleting` (idempotent per-entity steps make
resume safe — all helpers verified 404-tolerant). Batched loops (100 rows per
batch) so a large workspace never holds one giant transaction or request.

Order (FK-verified — `skills.file_id` and `memory_entries.file_id` are
RESTRICT FKs, so both drain before files; sessions drain before agents so the
`agents→sessions` cascade can't skip K8s cleanup):

1. **Sessions** — per session: `stopSession` (Jobs) +
   `deleteSessionResources` (/work PVCs) + session file rows/S3 objects, then
   the row (events/session_files/pending_launches cascade). Template:
   agent-delete at `agents-api.ts:513`.
2. **Skills** — rows, then their file rows + S3 objects.
3. **Memory stores** — rows (entries cascade), entry file rows + S3 objects.
4. **Remaining files** — rows + S3 objects (`files.del`, best-effort like the
   existing DELETE /v1/files/:id).
5. **Environments** — `deleteEnvironmentResources` (egress proxy Deployment/
   Service/ConfigMap + NetworkPolicy) + rows.
6. **Vaults** — `deleteVaultSecret` (K8s Secret) + rows (credentials cascade).
7. **Agents** — rows (versions cascade; sessions already gone).
8. **Webhooks** — rows.
9. **API keys** — **soft**-deleted (`status='deleted'`, existing convention;
   names survive for Usage attribution).
10. **file_uploads** — explicit delete (+ abort of pending multipart
    uploads). Its `ON DELETE CASCADE` never fires because the tombstone row
    survives.
11. Flip workspace to `deleted` (keep `delete_totals` for the final render).

`gateway_usage` is never touched.

## Read-only enforcement (disable)

`workspaceGuard` — a preHandler factory with a TTL-cached (~10s) workspace-
status lookup, same pattern as `apiKeyAuth`:

- Non-GET request whose resolved workspace is `disabled`/`deleting` → **409**
  `workspace disabled` (mirrors the agent-disabled 409). `deleted`/unknown →
  **404**.
- Registered on both API surfaces: agents-api (workspace from
  `X-Devproof-Workspace`) and public-api (workspace from the dpk key).
- **Exempt:** `POST /v1/sessions/:id/interrupt`; the `/v1/workspaces`
  management routes themselves; Serving routes (pools, deployments, catalog,
  external endpoints — global, never workspace-gated).
- **Untouched:** runner callback routes — running turns post status/
  checkpoints and complete normally.
- **Gateway** (`deploy/gateway/litellm.yaml` custom_auth, line ~267): the key
  lookup gains a JOIN requiring the key's workspace `status='active'`, so dpk
  keys of a disabled workspace stop working for inference too. Running
  sessions use the internal key and are unaffected.
- Propagation latency: ≤ ~10s CP-side, ≤30s gateway-side (auth caches). Not
  instant; accepted.

New sessions and follow-up messages are non-GET, so they are blocked
automatically — "running sessions can still complete, nothing new starts."

## Console UI

- **Nav:** `Workspaces` added to the Manage group after API keys
  (`nav.tsx` GROUPS).
- **`/workspaces` page:** standard table + shared `Pager` (100/page).
  Full **id is the clickable element** and opens the edit modal (environments
  convention). Columns: id, name (plain text), status badge, created.
  Row actions: Disable/Enable toggle, Delete. The default workspace shows no
  rename/disable/delete affordances.
- **Create:** the existing `WorkspaceModal` is extracted from `nav.tsx` into a
  shared module and reused by both the switcher's "+ New workspace…" and the
  page's create button.
- **Delete confirm:** `ConfirmDialog` requiring the workspace **name typed
  back**, listing the resource counts that will be destroyed (from
  `GET /v1/workspaces/:id/resources`).
- **Deletion progress:** a `deleting` row opens an inline progress panel:
  each resource type with `deleted/total`, checkmark when drained, spinner on
  the active one; polls `GET /v1/workspaces/:id/deletion` (~1.5s) until
  `deleted`, then the row leaves the list.
- **Switcher:** MCP-picker-style dropdown replaces the native `<select>`
  (`mcp-picker.tsx` is the styling precedent): colored initial tile
  (`hashHue`) + bold name, small gray id beneath; `disabled` badge on disabled
  workspaces (still selectable — read-only browsing); `deleting`/`deleted`
  excluded; "+ New workspace…" at the bottom.
- **Read-only banner:** when the current workspace is disabled, a slim banner
  under the switcher: "Workspace disabled — read-only."
- **Fallback:** if the cookie points at a workspace missing from the fetched
  list (deleting/deleted), the layout falls back to `wrkspc_default`
  (membership check in `layout.tsx`).

## Error handling

- Rename conflict (live name exists) → 409 with message; modal shows it.
- Disable/delete race with running turns: turns finish; their runner posts are
  turn-attributed and unaffected (callback routes exempt).
- Runner step failures: S3/K8s deletes are best-effort per existing
  convention (404-tolerant, `Promise.allSettled` where parallel); a hard DB
  error leaves the workspace in `deleting` and the boot sweep retries.
- Deleting the currently-selected workspace: console falls back to default on
  next render.

## Testing

Backend (`cd control-plane && npm test` + `npx tsc --noEmit`):

- Guard matrix: disabled → writes 409, reads 200, interrupt 200; deleting →
  writes 409; deleted → 404; active → all pass; Serving + workspace routes
  exempt.
- Default-workspace protections: rename/disable/delete → 400.
- Rename: success, 409 conflict, tombstone name reusable after delete.
- Deletion runner: full drain across all resource types; idempotency (run
  twice ⇒ same end state); resume-from-`deleting`; api_keys soft-deleted;
  gateway_usage rows intact; progress endpoint counts monotonically drain.

Live verify (per repo convention): restart CP + console, all pages 200; then
create workspace → populate (agent, env, vault credential, session) → disable
→ confirm read-only + interrupt + running-session completion → enable →
delete → watch the progress panel drain → confirm K8s (Jobs, PVCs, Secrets,
egress) and S3 clean, tombstone row + usage intact, name reusable, switcher
and fallback behave.

## Out of scope

- Global/cross-workspace usage view surfacing deleted workspaces' history
  (data is preserved for it; UI is future work — TODO "Workspace Management →
  Costs").
- Background/reconciler-driven deletion beyond the boot sweep (the runner is
  already resumable; moving it fully into the reconciler is a later refactor
  if needed).
- Workspace-scoped Serving (explicitly global today).
