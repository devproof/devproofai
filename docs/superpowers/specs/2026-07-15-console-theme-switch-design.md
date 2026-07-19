# Console theme switch (System / Light / Dark) — design

**Date:** 2026-07-15
**Status:** approved

## Goal

Let the operator choose the console theme from `/settings` instead of being at
the mercy of the OS. Today dark mode is reachable **only** via the OS setting —
`globals.css` carries a single `@media (prefers-color-scheme: dark)` block and
the console has no in-app switch.

Three choices: **System | Light | Dark**, default **System** (= today's
behaviour, so an upgrade changes nothing until the operator asks).

## Scope

- Platform-wide, stored in `app_settings`. There are no user accounts yet; when
  they land, a per-user override layers on top (see *Future* below).
- Control lives on `/settings` only. **No** top-bar quick toggle (not asked for).
- Explicit Save, matching the page's existing convention (`form.tsx`: "Explicit
  Save"). No live preview.

## Storage & API — no migration

`app_settings` is `(id TEXT PRIMARY KEY CHECK (id='global'), data JSONB, ...)`
(`sql/030_cost_tracking.sql`). `costs` / `limits` / `storage` are plain keys in
that JSONB blob, so the theme is **one more key** — no new SQL file. This
matters: `migrate()` re-runs every file each boot, so not adding one is a
feature.

```jsonc
// app_settings.data
{ "costs": {...}, "limits": {...}, "storage": {...},
  "appearance": { "theme": "system" } }   // "system" | "light" | "dark"
```

- **`repo.ts`** — `getAppearance()` / `putAppearance()`, mirroring
  `getStorageSettings` / `putStorageSettings`. `getAppearance()` returns
  `{ theme: "system" }` when the key is absent.
- **`agents-api.ts`** — `GET /v1/settings` adds `appearance` to its response
  (already a public, non-workspace-scoped read).
- **`agents-api.ts`** — `PUT /v1/settings` validates `theme` against the three
  literals (400 otherwise) and persists **only when the body carries
  `appearance`**, exactly the guard `limits` already uses (a body that omits it
  leaves the stored value untouched and echoes the current one).

## CSS — `light-dark()`, media query deleted

The dark palette currently exists only inside the media query, so an explicit
override can't reach it by selector. Rather than duplicate the block, each token
carries both values and `color-scheme` picks:

```css
:root {
  color-scheme: light dark;                  /* System: OS decides */
  --paper: light-dark(#eaeef3, #0b1a2c);
  --ink:   light-dark(#0f2038, #dbe6f3);
  --label: light-dark(#3d4c5e, #b6c9de);
  /* ...every colour token in :root, same shape */
}
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"]  { color-scheme: dark; }
```

The whole `@media (prefers-color-scheme: dark)` block is **removed** — one
source of truth per token instead of two that drift apart.

Two deliberate consequences:

1. **`color-scheme` is now set**, which it never was. Native scrollbars, form
   controls and dropdowns currently render light-on-dark in dark mode; they
   follow the theme after this. Verified live: scrollbars stayed light during
   the 2026-07-15 dark-mode check.
2. Every colour token moves to `light-dark(light, dark)`. Non-colour tokens
   (`--font-*`) are untouched.

**Support:** `light-dark()` needs Chrome 123+ / Safari 17.5+ / Firefox 120+.
Verified resolving both ways in Chrome 150 via `CSS.supports` plus a live
`color-scheme` flip. The codebase already leans on `color-mix()` throughout
(`.phase`, `.tgroup`), a similar vintage — no new constraint.

**Non-goal:** re-tuning any palette value. The hexes carry over verbatim from
the current `:root` and dark blocks.

## Data flow — server-rendered, no flash

`layout.tsx` is already an async server component fetching `/v1/workspaces` with
a try/catch fallback. Add a **parallel** `/v1/settings` fetch and stamp the
result:

```tsx
<html lang="en" data-theme={theme} className={...}>
```

Server-rendered ⇒ no flash of the wrong theme and **no inline blocking script**
— the usual SSR theme workaround is unnecessary because the value is already on
the server. Control plane unreachable ⇒ fall back to `"system"`, i.e. today's
behaviour (the workspace fetch already degrades this way).

Save path: `SettingsForm` PUTs, then `router.refresh()` (existing behaviour) →
layout re-fetches → `data-theme` flips → repaint.

## UI

An **Appearance** panel on `/settings`, placed **last** — after Storage. Cost
tracking and billing are the page's substance; appearance is a preference and
shouldn't sit above them.

- Three options — System / Light / Dark. System's hint names the actual
  behaviour: "Follows your operating system setting."
- Uses the existing `setrow` / `setrow-name` / `setrow-hint` grid. A `<select>`
  fits the existing `.setrow select` styling; radios would need new CSS for no
  gain.
- Panel note states the scope honestly: applies to everyone using this console,
  matching the page's "Platform-wide settings" framing.

## Testing

- `cd control-plane && npm test` + `npx tsc --noEmit`.
- Unit: `PUT /v1/settings` rejects `theme: "blue"` (400); a body without
  `appearance` leaves the stored theme untouched; `getAppearance()` defaults to
  `system` on an empty blob.
- Live: restart CP + console, set each of the three values, confirm the palette
  flips and **survives a hard reload with no flash**; confirm System still
  tracks the OS via Chrome's `prefers-color-scheme` emulation; confirm all 17
  routes 200 in both themes.

## Future (explicitly not built now)

When user accounts exist, a per-user override reads a `devproof_theme` cookie
and falls back to the `app_settings` value. **`layout.tsx`'s `data-theme` stamp
is the only seam that change touches** — the CSS and the API stay as-is.
