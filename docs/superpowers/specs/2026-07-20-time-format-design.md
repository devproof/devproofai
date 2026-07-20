# Consistent, configurable time formatting (design)

Date: 2026-07-20. Status: approved.

## Problem

Timestamps render differently across the console — and wrongly, on two
independent axes:

1. **Locale/style.** Server-rendered pages (all list pages, detail crumbs)
   call `toLocaleString()` inside the console pod, where Node defaults to
   `en-US` → `7/20/2026, 8:27:12 PM`. Client components (memory/wiki
   browsers, settings form, deployment trace) format in the viewer's browser
   → `20.7.2026, 22:13:12` on a German machine. The sessions list adds a
   third one-off style (`dateStyle/timeStyle: "short"`, commit 0ec0d1d).
2. **Timezone.** The pod runs UTC, so every server-rendered timestamp is
   also offset for the viewer (verified live: a 22:27 CEST event listed as
   `8:27 PM`). Client-rendered ones show viewer-local time.

## Decisions (user, 2026-07-20)

- The format is a platform setting on /settings under Appearance, directly
  after Theme.
- Options are fixed presets: **Browser default** (viewer's locale),
  **ISO 8601**, **US**, **European**. Default: Browser default.
- Timestamps always render in the **viewer's timezone**.
- **Minutes precision** everywhere; seconds survive only in the deployment
  trace row clock and stats chart ticks, where events sit seconds apart.
- Delivery approach A: a `data-timefmt` stamp on `<html>` (the `data-theme`
  mechanism), not a context provider, not server-side formatting.

Viewer timezone + browser-default locale are only knowable in the browser
(no HTTP header carries a timezone), so the formatted string MUST be
produced client-side; the design freedom is only how the setting reaches
the client and how server-rendered pages stay hydration-safe.

## 1. Setting & API (control plane)

`control-plane/src/appearance.ts`:

```ts
export type TimeFormat = "browser" | "iso" | "us" | "eu";
export interface Appearance { theme: Theme; timeFormat: TimeFormat; }
export const DEFAULT_TIME_FORMAT: TimeFormat = "browser";
```

No migration — `appearance` is a JSONB key in the `app_settings` singleton;
`normalizeAppearance` fills defaults for absent fields (existing rows have
no `timeFormat`). `validateAppearance` accepts a partial with either field.

**PUT `/v1/settings` switches the appearance persist from replace-on-theme
to merge-when-provided** (the maintenance idiom). Today the handler
normalizes the whole block when `ab?.theme !== undefined`; once the block
has two fields, a theme-only body would silently reset `timeFormat` to its
default. New behaviour: persist when the block carries `theme` OR
`timeFormat`; merge the provided fields over the stored value. A body that
omits `appearance` (or sends `{}`) still leaves everything untouched.
`test/appearance-settings.test.ts` extends to pin: theme-only body keeps
the stored timeFormat, timeFormat-only body keeps the stored theme.

## 2. Delivery to the console

`console/app/layout.tsx` stamps `data-timefmt={timeFormat}` on `<html>`
next to `data-theme`, falling back to `"browser"` when the CP is down.
Settings save already calls `router.refresh()`, which re-runs the layout
and re-stamps — the exact mechanism theme uses in production (spec
2026-07-15); no new plumbing.

## 3. `console/app/lib/datetime.tsx` — the one formatter

Preset table, `preset → (locale, Intl.DateTimeFormat options)`:

| Preset    | Locale      | Options                                                        | Output (verified in-browser, de-DE/Berlin) |
|-----------|-------------|----------------------------------------------------------------|--------------------------------------------|
| `browser` | `undefined` | `{year:"numeric",month:"numeric",day:"numeric",hour:"numeric",minute:"2-digit"}` | `20.7.2026, 22:13` |
| `iso`     | — (manual)  | `YYYY-MM-DD HH:mm` from local date parts, zero-padded          | `2026-07-20 22:13` |
| `us`      | `en-US`     | same options as `browser`                                      | `7/20/2026, 10:13 PM` |
| `eu`      | `de-DE`     | as `browser` but `2-digit` day/month/hour                      | `20.07.2026, 22:13` |

Exports:

- **`<DateTime iso={string} />`** (`"use client"`). Reads the stamp via
  `useSyncExternalStore`: subscribe = a `MutationObserver` on
  `document.documentElement` with `attributeFilter: ["data-timefmt"]`
  (verified: fires once per attribute change); client snapshot =
  `dataset.timefmt ?? "browser"`; server snapshot = `undefined`. When the
  snapshot is `undefined` (server render and first hydration render) it
  renders the API's ISO string trimmed to minutes by pure string slicing
  (`2026-07-20T20:13:12.000Z` → `2026-07-20 20:13Z` — deterministic, no
  `Date`/timezone involved) — server output equals first client output, so
  there is **no hydration mismatch and no `suppressHydrationWarning`**.
  After hydration React re-renders with the client snapshot and the preset
  format (viewer timezone) appears; a settings change re-stamps `<html>`
  and every mounted `<DateTime>` re-renders live via the observer.
- **`presetLocale(): string | undefined`** — the preset's locale tag for
  the two compact-format sites (below) so their locale follows the setting
  while their shapes stay context-dependent. `browser` → `undefined`,
  `us` → `"en-US"`, `eu` → `"de-DE"`, `iso` → `"sv-SE"` (whose time
  formats are ISO-like: 24h `22:13:12` — `iso` has no real locale, so the
  compact sites need an explicit stand-in).

Trade-off accepted: the pre-JS paint shows the raw ISO-UTC string for a
frame (`2026-07-20 20:13Z`) — legible, deterministic, and the price of
viewer-timezone correctness. It is also the no-JS/crawler fallback.

## 4. Call-site migration (~22 sites)

Every full-timestamp render — `new Date(x).toLocaleString()` in list pages,
detail crumbs, memory/wiki browsers, vault credentials, files, workspaces,
api-keys, agents session tab, settings "Last run" — becomes
`<DateTime iso={x} />` (server components rendering a client component is
fine and already done elsewhere). The sessions page drops the one-off
`short` style from 0ec0d1d.

Compact formats keep their shape, follow the locale:

- `deployments/[name]/trace.tsx:193` row clock (`toLocaleTimeString()`,
  keeps seconds) → `toLocaleTimeString(presetLocale())`.
- `deployments/[name]/stats.tsx:34-36` chart ticks → pass `presetLocale()`
  as the locale argument, options unchanged.

Out of scope: number formatting (`tokens.toLocaleString()` etc.), the
Python client, and any API/wire format (timestamps stay ISO on the wire).

## 5. Settings UI

`console/app/settings/form.tsx`, Appearance panel, directly after Theme: a
`Time format` select with example strings in the labels —
`Browser default (20.7.2026, 22:13)`, `ISO 8601 (2026-07-20 22:13)`,
`US (7/20/2026, 10:13 PM)`, `European (20.07.2026, 22:13)` — wired into the
existing save payload as `appearance: { theme, timeFormat }`.
`settings/page.tsx` threads the new field through `initialAppearance`.

## 6. Verification

- CP: `cd control-plane && npm test` + `npx tsc --noEmit` — new merge tests
  green.
- Console: production build; then live against the cluster: flip each
  preset on /settings and confirm (a) the sessions list (server-rendered)
  and a memory-store browser (client-rendered) show the SAME string in the
  VIEWER'S timezone, (b) already-open pages update without reload
  (observer), (c) with the CP stopped the console falls back to `browser`
  preset and ISO pre-hydration text.

## Evidence

- Preset output strings and the MutationObserver-per-change behaviour were
  verified in the user's actual browser (de-DE, Europe/Berlin) during
  design, 2026-07-20.
- Pod locale/timezone drift verified live the same day (en-US + UTC
  rendering of a CEST event).
