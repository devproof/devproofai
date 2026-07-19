# Console cleanup + batches removal — design

Date: 2026-07-10. Status: approved by Carsten (option A for the dashboard key button; batches removal depth: everything incl. DB).

Eight small changes bundled into one implementation pass: browser-tab title, navigation
restructure (new MANAGE group, Build group dissolved), the skill-update 500 fix, full
batches removal, overview-page Models section removal, and two dashboard header buttons.

## 1. Browser-tab title

`console/app/layout.tsx` metadata title changes from `"Devproof.AI — Control Plane"` to
`"DEVPROOF.AI — Control Plane"`. The sidebar brand already renders DEVPROOF.AI; this
aligns the tab title.

## 2. Navigation restructure (`console/app/nav.tsx`)

New `GROUPS` value — one edit, page URLs unchanged:

```
Dashboard                          (untitled group, unchanged)
Managed Agents   Agents · Skills · Sessions · Environments · Credential vaults · Files · Memory stores
Serving          Model catalog · Deployments · Pools · Cache   (unchanged)
Analytics        Usage
Manage           API keys
```

- The **Build** group is removed entirely; its pages keep their routes.
- **Skills** moves to Managed Agents, immediately after Agents.
- **Files** moves to Managed Agents, immediately before Memory stores.
- **Batches** disappears (see §4).
- New **Manage** group after Analytics holds API keys. Group titles are CSS-uppercased
  (`.sidebar .group { text-transform: uppercase }`), so the title string is `"Manage"`
  and renders as MANAGE.
- Icons stay with their items (`skill`, `file`, `key`).

## 3. Skill update 500 — fix

**Root cause (reproduced live 2026-07-10):** file IDs are content-addressed
(`file_<sha256>`, `filestore.ts put()`). Re-publishing a skill re-inserts a `files` row
for every file in the package (`agents-api.ts` POST `/v1/skills` →
`repo.createFileRecord`). Any file whose bytes already exist in the DB violates
`files_pkey` → Postgres `23505` → 500. A single-file update with changed text works; an
update with unchanged content — or a zip where any script/resource didn't change, the
normal update case — fails.

**Fix:** `repo.createFileRecord` INSERT gains `ON CONFLICT (id) DO NOTHING`. Correct by
construction: same ID ⇒ same bytes; the existing row already describes the content. The
method keeps returning `meta` unchanged. This also fixes the identical latent bug in
plain file uploads (`POST /v1/files`, `/v1/files/raw`) and memory-store writes.

**Test:** publish a skill, re-publish byte-identical content under the same name →
expect 201 with `version: 2` (this exact sequence returned 500 before the fix).

## 4. Batches — full removal

Sessions previously created by batches survive as ordinary sessions (named
`batch:<custom_id>`).

- **Console:** delete `console/app/batches/` (page, `[id]/page`, `create`); nav entry
  goes with §2; remove the `batch` icon from `lib/icons.tsx` if nothing else uses it.
- **Control plane routes:** delete the four `/v1/batches` handlers in
  `src/agents-api.ts` (GET list, GET `:id/items`, DELETE `:id`, POST).
- **Repo:** delete `createBatch`, `attachBatchSession`, `listBatches`, `getBatchItems`,
  `reconcileBatches`, `deleteBatch` from `src/repo.ts`; drop the `deleteBatch` mock from
  `test/agents-api.test.ts` and any batch-route tests.
- **DB:** new migration `sql/018_drop_batches.sql`:
  `DROP TABLE IF EXISTS batch_items; DROP TABLE IF EXISTS batches;`
  Existing migrations 011/014 stay untouched (already applied; guarded with IF EXISTS —
  014's ALTERs on `batches` are IF-EXISTS-safe against a fresh DB where 018 runs after).
- **Docs:** remove `msgbatch_` from the ID list in project `CLAUDE.md`; drop the
  Batches nav item from any docs that enumerate it.

Note for fresh-DB bootstrap: migrations run in order, so 011 creates the tables and 018
drops them — wasteful but correct; 014's `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`
on `batches` runs while the table still exists (011 < 014 < 018). Verify migration
order-safety on a clean database in the test run.

## 5. Overview page — remove Models section

In `console/app/page.tsx`: remove the `Models` group header and the catalog model-card
grid (with its `DeployLocalButton`), plus the now-unused import and the `/v1/catalog`
fetch if nothing else on the page uses it. The four stat cards stay, including the
Catalog count card (flagged; Carsten did not ask to remove it).

## 6. Dashboard header buttons

Current: `<Link className="btn" href="/agents">Build an agent</Link>` in the pagehead.

- **"Build an agent"** gains the agent icon: `<Icon.agent /> Build an agent`.
- **"Generate an API key"** sits to its **left**, in the lighter ghost treatment, and
  performs the real action (option A): reuse `CreateApiKey` from
  `console/app/api-keys/create.tsx` by adding optional trigger props — e.g.
  `{ label?, ghost?, icon? }` with defaults preserving the current "+ Create key"
  rendering on the API-keys page. The dashboard renders
  `<CreateApiKey label="Generate an API key" ghost icon />` → opens the existing create
  modal + show-key-once/copy flow in place. No duplicated flow; the trigger is a real
  `<button className="ghost">` so existing ghost CSS applies.
- CSS: the `.btn` class alone (not `button` globally) gets `display: inline-flex;
  align-items: center; gap: 7px; justify-content: center` so icon + text align; verify
  the other `.btn` links (dashboard, list pages) render unchanged.
- Dashboard `page.tsx` is a server component; `CreateApiKey` is `"use client"` —
  embedding is fine.

## Verification

- Backend: new re-publish-identical-skill test; existing suite (57 tests) passes;
  `npx tsc --noEmit` clean; migration 018 applies against the dev DB and a fresh DB
  bootstrap stays order-safe.
- Console: production build (`npx next build`); all touched pages 200; browser check of
  tab title, nav groups/order, dashboard buttons (key-creation flow end-to-end),
  overview without Models; skill update exercised through the UI (upload same zip twice).
- Grep for dangling references: `batches`, `msgbatch`, `Icon.batch`.
