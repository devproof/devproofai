# Vault dialog cleanups — design

Date: 2026-07-14. Source: TODO.txt "Next" bucket. Two small console-only UX
fixes to the vault dialogs. No server, migration, or gateway changes.

## 1. Create Vault dialog (`console/app/vaults/create.tsx`)

**Problem:** the create modal carries a `Credentials` textarea (`KEY=value`
lines, prefilled `API_TOKEN=`). Credentials created this way bypass the typed
credential flow (they land untyped via `POST /v1/vaults` `secrets`), and the
box duplicates the "Add credential" dialog on the vault detail page.

**Change:**
- Remove the `Credentials` textarea, the `pairs` state, and the KEY=value
  parsing. POST body becomes `{ name }` only.
- On success, navigate to the new vault's detail page (`/vaults/<id>`) instead
  of closing + refreshing the list — the detail page is where "Add credential"
  lives. The POST returns the vault object (201) including its id; read the
  response body (via `apiPost` from `app/lib/client.ts` or a minimal extension
  of the current `submitJson` helper, whichever fits its return shape).

## 2. Add credential dialog (`console/app/vaults/[id]/credentials.tsx`)

**Problem:** for MCP types (bearer token / MCP OAuth) the Name field is
optional ("derived from the server when empty") with a literal `context7`
placeholder.

**Change:**
- **Name required for all types.** The `ready` check requires a valid name for
  MCP types too, validated against the server's rule
  `^[A-Za-z0-9_.-]{1,64}$` (`CRED_NAME_RE` in `control-plane/src/mcp.ts`).
  The Field renders `required` and drops the "optional — derived from the
  server when empty" hint.
- **Prefill from the MCP server pick.** Selecting a server fills Name with the
  server's registry name (e.g. Context7 → `context7`) — but only if the field
  is empty or still holds the previous auto-filled value, so a manually typed
  name is never clobbered.
- **No `context7` placeholder.** With prefill, the MCP name input needs no
  placeholder. The env-var placeholder `MY_API_KEY` stays.
- Rotate flow unchanged (name/type/server are locked there).

## Server side: intentionally unchanged

`POST /v1/vaults` keeps accepting optional `secrets`, and
`validateCredentialBody` keeps deriving a name from `mcpServerName`/hostname
when empty. Both remain as lenient public-API behavior (aligned with the
Anthropic credential shape, where the name is derivable) and as backward
compatibility; the console simply stops using the lenient paths.

## Verification

Console-only change: `npx next build` + restart, then exercise live:
1. Create a vault → modal has no credentials box → lands on the detail page.
2. Add a bearer-token credential → picking an MCP server prefills Name;
   clearing Name disables submit; typing a custom name then re-picking a
   server does not clobber it.
3. Add an environment-variable credential → unchanged behavior.
4. Rotate an existing credential → unchanged (fields locked).

No backend tests affected (server untouched); `npx tsc --noEmit` in console
via the build.
