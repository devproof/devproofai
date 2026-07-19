# Session file attachment in the UI — design

Date: 2026-07-10. Status: approved by user (both sections).

## Problem

`POST /v1/sessions` and `POST /v1/sessions/:id/messages` accept `files[]`
(and create accepts `memoryStore`), but the console exposes neither: the
create-session dialog is agent/name/prompt only and the follow-up composer is
text-only. Attaching files or a memory store requires the raw API.

## Decisions (user-confirmed)

1. Attachment appears in BOTH the create-session dialog and the follow-up
   composer.
2. The create dialog also gains the **memory store** selector (one store per
   session, the API's `memoryStore` field).
3. Approach A: one shared `AttachFiles` control — pick existing workspace
   files AND upload new ones inline.
4. Copy fix riding along: the create dialog's Name hint becomes just
   `optional` (drop " — e.g. a ticket id").

## 1. The `AttachFiles` control and its two homes

**New `console/app/sessions/attach.tsx`** exports a controlled component:
`AttachFiles({ value, onChange, compact? }: { value: {id, name}[];
onChange(files): void; compact?: boolean })`.

- **Chips row:** each selected file renders as a chip (`name ✕`); ✕ removes.
  Empty selection: nothing (compact) / muted hint (dialog).
- **Trigger:** solid-styled button — `clip icon + "Attach files"` in the
  dialog; icon-only in the composer (`compact`).
- **Picker:** a small `Modal` (width sm, existing dialog system): search
  input filtering by name; checkbox list of attachable workspace files
  (name + size + date, first 100, newest first, from
  `GET /v1/files?kind=upload&limit=100`); an **Upload new…** button (hidden
  multi-select file input) that multiparts each file to `POST /v1/files`
  and auto-checks the results. Footer: Cancel / `Attach N file(s)`.
  Upload/list failures render in the modal's inline error banner.

**Create-session dialog** (`console/app/sessions/create.tsx`):
- New Field `Files` hosting `AttachFiles` (hint: "mounted at
  /mnt/session/uploads in the session").
- New Field `Memory store`: select with `No memory store` + stores by name;
  submitted as `memoryStore` (omitted when none). The sessions page
  (`page.tsx`) fetches `/v1/memory-stores` alongside agents and passes
  `memoryStores` into `CreateSession`.
- Submit body adds `files: value.map(f => f.id)` (omitted when empty).
- Name field hint: `optional`.

**Composer** (`console/app/sessions/[id]/trace.tsx`):
- Compact `AttachFiles` (paperclip icon button) left of the text input;
  selected chips render in a slim row above the composer.
- `send()` includes `files: [...]` in the message POST when non-empty and
  clears the selection together with the prompt.
- No transcript special-casing: the runner already prepends the attachment
  listing to the user prompt, and the session's Files chip updates via the
  existing resources refetch at the turn boundary.

## 2. Backend nuance — RESOLVED: no backend change needed

Verified during planning: console uploads get `kind = "upload"` by default
(`repo.createFileRecord`, repo.ts:575), and `repo.listAllFiles` with
`kind=upload` already selects exactly the attachable set (runner blobs are
kinded `output`/`checkpoint`/`memory`/`skill` and excluded). The picker
queries `GET /v1/files?kind=upload&limit=100`. The design's earlier
assumption (null kind → filter tweak) was wrong; §1's picker query is
updated accordingly and no repo/test change ships.

Both session routes already accept the fields, and unknown file ids already
400 before anything is recorded.

## Files touched

- Create: `console/app/sessions/attach.tsx`
- Modify: `console/app/sessions/create.tsx`, `console/app/sessions/page.tsx`,
  `console/app/sessions/[id]/trace.tsx`, `console/app/lib/icons.tsx`
  (`clip` icon), `console/app/globals.css` (chips-row styles)

## Testing

- Console: production build; live browser walk — create a session with one
  picked + one freshly-uploaded file and a memory store (chips show
  `2 files` / `1 memory`; the runner's attachment listing appears in the
  user row); send a follow-up with an attachment and watch the Files chip
  tick up at the turn boundary; failure path: an upload error renders in
  the picker's inline banner.

## Out of scope

Multi-store memory attachment; drag-and-drop upload; attachment previews in
the picker; per-message attachment display in transcript rows.
