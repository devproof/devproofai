# Consistent, Configurable Time Formatting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One timestamp formatter across the console — an `appearance.timeFormat` preset (`browser|iso|us|eu`) set on /settings, rendered hydration-safely in the viewer's locale and timezone everywhere.

**Architecture:** The control plane stores `timeFormat` next to `theme` in the `app_settings` JSONB singleton (no migration) and merges partial `appearance` bodies on PUT. The console layout stamps `data-timefmt` on `<html>` (the `data-theme` mechanism); a client `<DateTime>` component subscribes to that attribute via `useSyncExternalStore` + `MutationObserver` and formats client-side (viewer timezone is unknowable server-side). Spec: `docs/superpowers/specs/2026-07-20-time-format-design.md`.

**Tech Stack:** Fastify + node:test (control plane), Next.js 15 App Router + React `useSyncExternalStore` (console), `Intl.DateTimeFormat`.

## Global Constraints

- Spec is authoritative: `docs/superpowers/specs/2026-07-20-time-format-design.md`. Preset outputs (verified in-browser): `browser` → `20.7.2026, 22:13` (de-DE viewer), `iso` → `2026-07-20 22:13`, `us` → `7/20/2026, 10:13 PM`, `eu` → `20.07.2026, 22:13`. Minutes precision; seconds only in the deployment trace clock and stats ticks.
- **Console has NO unit-test harness.** Console verification = `npx next build` (includes type-check) + the live checks in Task 6. Control-plane tasks are TDD with node:test.
- **CP tests need a real Postgres.** This cluster (in-cluster chart, `default` namespace) uses generated passwords; the full DB URL lives in secret `devproof-db`, key `database-url` (host `postgres`). Build the env var WITHOUT printing it (PowerShell):
  ```powershell
  Start-Process kubectl -ArgumentList "port-forward","svc/postgres","15432:5432" -WindowStyle Hidden
  $u = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((kubectl get secret devproof-db -n default -o jsonpath="{.data.database-url}")))
  $env:DEVPROOF_DATABASE_URL = $u -replace "@postgres:5432", "@127.0.0.1:15432"
  ```
  Tests skip themselves (`{ skip: !available }`) if the DB is unreachable — a run where the round-trip/PUT tests all report `# SKIP` did NOT verify anything; fix the connection instead of accepting it.
- `npm test` in `control-plane/` runs the suite then a workspace sweep; `--test-concurrency=1` is deliberate — never parallelize.
- This repo is CRLF. After any bulk line deletion via Edit, re-check `git diff` — a leading-`\n` old_string can join adjacent lines.
- Commits: imperative subject, body explains why, end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Images: `ghcr.io/devproof/devproofai-*:v0.1.1`, built locally with `VERSION=v0.1.1 REGISTRY=ghcr.io/devproof docker buildx bake <target>` and **ctr-imported into the nodes, never pushed**. No `:latest` ever.
- ZERO third-party AI references in `session-runner/` (untouched here, but absolute).

---

### Task 1: Control plane — `appearance.timeFormat`

**Files:**
- Modify: `control-plane/src/appearance.ts` (whole file shown below)
- Test: `control-plane/test/appearance-settings.test.ts:18-35`

**Interfaces:**
- Consumes: nothing new.
- Produces: `type TimeFormat = "browser" | "iso" | "us" | "eu"`, `interface Appearance { theme: Theme; timeFormat: TimeFormat }`, `DEFAULT_TIME_FORMAT = "browser"`, `normalizeAppearance(raw: unknown): Appearance` (fills BOTH defaults), `validateAppearance(raw: unknown): string | null` (accepts partials with either field). Task 2 and the GET/PUT handlers rely on these exact names.

- [ ] **Step 1: Extend the normalize/validate tests (failing first)**

In `control-plane/test/appearance-settings.test.ts`, replace the two pure tests (lines 18–35) with:

```ts
test("normalize: absent/invalid theme reads as the system default", () => {
  assert.deepEqual(normalizeAppearance(undefined), DEFAULT_APPEARANCE);
  assert.equal(normalizeAppearance({}).theme, "system");
  assert.equal(normalizeAppearance({ theme: "blue" }).theme, "system");
  assert.equal(normalizeAppearance({ theme: 7 }).theme, "system");
  assert.equal(normalizeAppearance([]).theme, "system");
  assert.equal(normalizeAppearance({ theme: "dark" }).theme, "dark");
  assert.equal(normalizeAppearance({ theme: "light" }).theme, "light");
});

test("normalize: absent/invalid timeFormat reads as the browser default", () => {
  assert.deepEqual(DEFAULT_APPEARANCE, { theme: "system", timeFormat: "browser" });
  assert.equal(normalizeAppearance({}).timeFormat, "browser");
  assert.equal(normalizeAppearance({ timeFormat: "rfc2822" }).timeFormat, "browser");
  assert.equal(normalizeAppearance({ timeFormat: 7 }).timeFormat, "browser");
  assert.equal(normalizeAppearance({ theme: "dark" }).timeFormat, "browser");
  for (const f of ["browser", "iso", "us", "eu"]) {
    assert.equal(normalizeAppearance({ timeFormat: f }).timeFormat, f);
  }
});

test("validate: bad themes and timeFormats are named, valid passes", () => {
  assert.equal(validateAppearance(undefined), null);
  assert.equal(validateAppearance({}), null);
  assert.equal(validateAppearance({ theme: "dark" }), null);
  assert.equal(validateAppearance({ timeFormat: "iso" }), null);
  assert.equal(validateAppearance({ theme: "dark", timeFormat: "eu" }), null);
  assert.match(validateAppearance({ theme: "blue" })!, /theme/);
  assert.match(validateAppearance({ theme: 7 })!, /theme/);
  assert.match(validateAppearance({ timeFormat: "rfc2822" })!, /timeFormat/);
  assert.match(validateAppearance({ timeFormat: 7 })!, /timeFormat/);
  assert.match(validateAppearance([])!, /object/);
});
```

Also update the repo round-trip test (line 37) to full objects — `putAppearance` stores the whole block:

```ts
test("appearance round-trip via repo", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const before = await repo.getAppearance();
  try {
    await repo.putAppearance({ theme: "dark", timeFormat: "iso" });
    assert.deepEqual(await repo.getAppearance(), { theme: "dark", timeFormat: "iso" });
    await repo.putAppearance({ theme: "light", timeFormat: "browser" });
    assert.deepEqual(await repo.getAppearance(), { theme: "light", timeFormat: "browser" });
  } finally {
    await repo.putAppearance(before); // restore — the dev DB is shared
  }
});
```

- [ ] **Step 2: Run, verify failure**

```powershell
cd control-plane
node --test --test-concurrency=1 test/appearance-settings.test.ts
```
Expected: FAIL — `DEFAULT_APPEARANCE` deepEqual mismatch (no `timeFormat`), `normalizeAppearance({}).timeFormat` is `undefined`, `validateAppearance({ timeFormat: "rfc2822" })` returns `null` instead of an error. (The two `{ skip: !available }` tests need the DB URL from Global Constraints; the pure tests fail regardless.)

- [ ] **Step 3: Implement — replace `control-plane/src/appearance.ts` with:**

```ts
// Console theme + time format stored in the app_settings JSON singleton under
// `appearance` (specs 2026-07-15 theme, 2026-07-20 time format). Platform-wide
// today; a per-user override lands with user accounts and reads a cookie ahead
// of this value. Mirrors limits.ts.

export type Theme = "system" | "light" | "dark";
export type TimeFormat = "browser" | "iso" | "us" | "eu";

export interface Appearance {
  theme: Theme;
  timeFormat: TimeFormat;
}

export const THEMES: readonly Theme[] = ["system", "light", "dark"] as const;
export const TIME_FORMATS: readonly TimeFormat[] = ["browser", "iso", "us", "eu"] as const;
export const DEFAULT_THEME: Theme = "system";
export const DEFAULT_TIME_FORMAT: TimeFormat = "browser";
export const DEFAULT_APPEARANCE: Appearance = { theme: DEFAULT_THEME, timeFormat: DEFAULT_TIME_FORMAT };

function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}
function isTimeFormat(v: unknown): v is TimeFormat {
  return typeof v === "string" && (TIME_FORMATS as readonly string[]).includes(v);
}

/** Coerce stored/absent JSON to a valid Appearance, falling back to defaults. */
export function normalizeAppearance(raw: unknown): Appearance {
  const r = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { theme?: unknown; timeFormat?: unknown }) : {};
  return {
    theme: isTheme(r.theme) ? r.theme : DEFAULT_THEME,
    timeFormat: isTimeFormat(r.timeFormat) ? r.timeFormat : DEFAULT_TIME_FORMAT,
  };
}

/** Returns an error message, or null when the input is a valid partial. */
export function validateAppearance(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "appearance must be an object";
  const r = raw as { theme?: unknown; timeFormat?: unknown };
  if (r.theme != null && !isTheme(r.theme)) return `appearance.theme must be one of: ${THEMES.join(", ")}`;
  if (r.timeFormat != null && !isTimeFormat(r.timeFormat)) return `appearance.timeFormat must be one of: ${TIME_FORMATS.join(", ")}`;
  return null;
}
```

- [ ] **Step 4: Run, verify pass**

Same command as Step 2. Expected: all tests in the file PASS (round-trip/HTTP ones not `# SKIP` — DB env set). Then `npx tsc --noEmit` in `control-plane/`: clean.

- [ ] **Step 5: Commit**

Use the Bash tool (heredoc — PowerShell 5.1 mangles multi-line `-m`):
```bash
git add control-plane/src/appearance.ts control-plane/test/appearance-settings.test.ts
git commit -F - <<'EOF'
cp: appearance gains timeFormat (browser|iso|us|eu)

Stored in the app_settings JSONB singleton next to theme — no migration;
normalize fills defaults on read, so existing rows need no backfill.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Control plane — PUT `/v1/settings` merges partial appearance

**Files:**
- Modify: `control-plane/src/agents-api.ts:1136-1143` (the appearance persist block)
- Test: `control-plane/test/appearance-settings.test.ts` (extend the PUT test)

**Interfaces:**
- Consumes: `normalizeAppearance` from Task 1.
- Produces: PUT semantics the console relies on — a body carrying `appearance.theme` and/or `appearance.timeFormat` persists the provided fields merged over stored; omitted block or `{}` leaves everything untouched; response echoes the effective full block.

**Why:** today the handler runs `normalizeAppearance(ab)` when `ab?.theme !== undefined` — once the block has two fields, a theme-only body would RESET `timeFormat` to its default (normalize fills defaults for absent fields).

- [ ] **Step 1: Extend the PUT test (failing first)**

In `test/appearance-settings.test.ts`, inside `test("PUT /v1/settings persists theme when provided, leaves it when omitted", ...)`, insert before the `// A body without \`appearance\`` comment:

```ts
    // Merge-when-provided (spec 2026-07-20): a timeFormat-only body keeps the
    // stored theme, and a theme-only body keeps the stored timeFormat — the
    // old replace-on-theme handler would reset timeFormat to "browser" here.
    const fmtOnly = await app.inject({
      method: "PUT", url: "/v1/settings",
      payload: { costs: {}, appearance: { timeFormat: "iso" } },
    });
    assert.equal(fmtOnly.statusCode, 200);
    assert.deepEqual(fmtOnly.json().appearance, { theme: "dark", timeFormat: "iso" });

    const themeOnly = await app.inject({
      method: "PUT", url: "/v1/settings",
      payload: { costs: {}, appearance: { theme: "light" } },
    });
    assert.equal(themeOnly.statusCode, 200);
    assert.deepEqual(themeOnly.json().appearance, { theme: "light", timeFormat: "iso" });
    assert.deepEqual(await repo.getAppearance(), { theme: "light", timeFormat: "iso" });
```

Note: the later assertions in that test then run against theme `light`/format `iso` — update the three existing `appearance.theme, "dark"` assertions after the inserted block to `"light"`, and the two `deepEqual(await repo.getAppearance(), { theme: "dark" })` after it to `{ theme: "light", timeFormat: "iso" }`. Also update the earlier assertions in the same test: `assert.deepEqual(await repo.getAppearance(), { theme: "dark" })` (line 102) becomes `{ theme: "dark", timeFormat: "browser" }` — normalize now always fills both fields.

- [ ] **Step 2: Run, verify failure**

```powershell
node --test --test-concurrency=1 test/appearance-settings.test.ts
```
Expected: FAIL — `themeOnly` response has `timeFormat: "browser"` (reset by the old handler), expected `"iso"`.

- [ ] **Step 3: Implement — in `agents-api.ts`, replace the persist block:**

Old (lines 1136–1143):
```ts
    // Persist appearance only when the body carries an explicit theme (same
    // convention as limits/maintenance): an omitted block leaves the stored theme.
    let appearance = await repo.getAppearance();
    const ab = b?.appearance as { theme?: unknown } | undefined;
    if (ab?.theme !== undefined) {
      appearance = normalizeAppearance(ab);
      await repo.putAppearance(appearance);
    }
```

New:
```ts
    // Persist appearance only when the body carries an explicit field, merging
    // the provided fields over the stored block (maintenance idiom) — a
    // theme-only body must not reset timeFormat to its default, and vice versa.
    // An omitted or empty block leaves everything untouched.
    let appearance = await repo.getAppearance();
    const ab = b?.appearance as { theme?: unknown; timeFormat?: unknown } | undefined;
    if (ab?.theme !== undefined || ab?.timeFormat !== undefined) {
      appearance = normalizeAppearance({
        theme: ab.theme !== undefined ? ab.theme : appearance.theme,
        timeFormat: ab.timeFormat !== undefined ? ab.timeFormat : appearance.timeFormat,
      });
      await repo.putAppearance(appearance);
    }
```

- [ ] **Step 4: Run, verify pass**

Same file run: PASS. Then the full gate: `npm test` and `npx tsc --noEmit` in `control-plane/` — green (the agents-api test fake at `test/agents-api.test.ts:202` uses `_appearance: { theme: "system" }`; if `tsc` complains about the fake's shape, extend it to `{ theme: "system", timeFormat: "browser" }`).

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/test/appearance-settings.test.ts control-plane/test/agents-api.test.ts
git commit -F - <<'EOF'
cp: PUT /v1/settings merges partial appearance fields

The old guard normalized the whole block when theme was present; with a
second field that silently reset timeFormat to its default on a theme-only
body. Merge-when-provided (the maintenance idiom) instead.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Console — `app/lib/datetime.tsx` + layout stamp

**Files:**
- Create: `console/app/lib/datetime.tsx`
- Modify: `console/app/layout.tsx:21,28,42`

**Interfaces:**
- Consumes: `data-timefmt` attribute on `<html>` (stamped below).
- Produces (Tasks 4–5 rely on these exact names):
  - `<DateTime iso={string} />` — hydration-safe full timestamp, minutes precision.
  - `presetLocale(): string | undefined` — locale tag for compact formats; `undefined` server-side and for `browser`.
  - `type TimeFormat = "browser" | "iso" | "us" | "eu"` (console-side copy; the wire value is validated by the CP).

- [ ] **Step 1: Create `console/app/lib/datetime.tsx`:**

```tsx
"use client";
// One timestamp formatter for the whole console (spec 2026-07-20-time-format).
// The preset is stamped on <html data-timefmt> by layout.tsx (the data-theme
// mechanism). <DateTime> subscribes to the attribute via useSyncExternalStore +
// MutationObserver, so a settings save (router.refresh re-stamps <html>)
// re-renders every mounted timestamp without a reload. Formatting is
// client-side ON PURPOSE: the viewer's timezone and default locale are
// unknowable on the server, and the pod's en-US/UTC rendering was the bug.
import { useSyncExternalStore } from "react";

export type TimeFormat = "browser" | "iso" | "us" | "eu";

const OPTS: Intl.DateTimeFormatOptions =
  { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" };
const EU_OPTS: Intl.DateTimeFormatOptions =
  { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" };

// `iso` is formatted manually below; compact call sites (presetLocale) get
// sv-SE, whose time formats are ISO-like (24h clock).
const LOCALES: Record<TimeFormat, string | undefined> =
  { browser: undefined, iso: "sv-SE", us: "en-US", eu: "de-DE" };

function subscribe(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-timefmt"] });
  return () => mo.disconnect();
}
const getSnapshot = () =>
  (document.documentElement.dataset.timefmt ?? "browser") as TimeFormat;
// Server + first hydration render: no preset — <DateTime> falls back to the
// sliced ISO string, so server output equals first client output (no mismatch).
const getServerSnapshot = () => undefined;

const pad = (n: number) => String(n).padStart(2, "0");

export function fmtDateTime(d: Date, fmt: TimeFormat): string {
  if (fmt === "iso")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toLocaleString(LOCALES[fmt], fmt === "eu" ? EU_OPTS : OPTS);
}

/** Locale tag for compact context-dependent formats (deployment trace clock,
 *  stats chart ticks) so their locale follows the setting while their shapes
 *  stay context-dependent. Not a hook: safe in plain render helpers; those
 *  call sites render from client-side fetched data, so the SSR undefined
 *  branch never paints real content. */
export function presetLocale(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return LOCALES[(document.documentElement.dataset.timefmt ?? "browser") as TimeFormat];
}

/** Hydration-safe timestamp, minutes precision. Pre-hydration it shows the ISO
 *  string trimmed by pure slicing ("2026-07-20T20:13:12.000Z" → "2026-07-20
 *  20:13Z") — deterministic, no Date/timezone involved — then swaps to the
 *  preset format in the viewer's timezone. */
export function DateTime({ iso }: { iso: string }) {
  const fmt = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (!fmt) return <>{`${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`}</>;
  return <>{fmtDateTime(new Date(iso), fmt)}</>;
}
```

- [ ] **Step 2: Stamp the preset in `console/app/layout.tsx`**

Line 21 — widen the settings type:
```ts
    wsGet<{ appearance?: { theme?: string; timeFormat?: string }; serving?: { localEnabled?: boolean } }>("/v1/settings"),
```
After line 28 (`const theme = ...`) add:
```ts
  const timefmt = (setRes.status === "fulfilled" && setRes.value?.appearance?.timeFormat) || "browser";
```
Line 42 — add the stamp next to `data-theme`:
```tsx
    <html lang="en" data-theme={theme} data-timefmt={timefmt} className={`${sans.variable} ${cond.variable} ${mono.variable}`}>
```

- [ ] **Step 3: Build to type-check**

```powershell
cd console; npx next build
```
Expected: build succeeds. (Nothing renders `<DateTime>` yet — that's Tasks 4–5.)

- [ ] **Step 4: Commit**

```bash
git add console/app/lib/datetime.tsx console/app/layout.tsx
git commit -F - <<'EOF'
console: DateTime formatter + data-timefmt stamp

Client-side formatting on purpose: viewer timezone/locale are unknowable
server-side (the pod's en-US/UTC rendering was the bug). Hydration-safe via
useSyncExternalStore with an undefined server snapshot -> sliced-ISO
fallback; a MutationObserver on <html data-timefmt> re-renders mounted
timestamps live when settings change.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Console — settings UI

**Files:**
- Modify: `console/app/settings/form.tsx:102-110,166-168,310-327`
- Modify: `console/app/settings/page.tsx:10`

**Interfaces:**
- Consumes: PUT merge semantics (Task 2) — the form still sends the full block `{ theme, timeFormat }`.
- Produces: the saved `appearance.timeFormat` that layout stamps (Task 3).

- [ ] **Step 1: Thread the field through the form**

`form.tsx` — prop type (lines 102–105): change `initialAppearance: { theme: string }` to `initialAppearance: { theme: string; timeFormat?: string }`. Below line 110 (`const [theme, setTheme] = ...`) add:
```ts
  const [timeFormat, setTimeFormat] = useState(initialAppearance?.timeFormat ?? "browser");
```
Save payload (line 167): `appearance: { theme }` → `appearance: { theme, timeFormat }`.

Appearance panel — after the Theme `</label>` (line 325), inside the same `setpanel` div, add:
```tsx
          <label className="setrow plain">
            <span />
            <span className="setrow-name">Time format</span>
            <span className="setrow-hint" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <select value={timeFormat} onChange={(e) => setTimeFormat(e.target.value)}
                      style={{ width: 230, flex: "none" }}>
                <option value="browser">Browser default (20.7.2026, 22:13)</option>
                <option value="iso">ISO 8601 (2026-07-20 22:13)</option>
                <option value="us">US (7/20/2026, 10:13 PM)</option>
                <option value="eu">European (20.07.2026, 22:13)</option>
              </select>
              timestamps always show in each viewer&apos;s timezone — applies to everyone using this console
            </span>
          </label>
```

`page.tsx` line 10: `appearance: { theme: string }` → `appearance: { theme: string; timeFormat?: string }`.

- [ ] **Step 2: Build**

```powershell
cd console; npx next build
```
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add console/app/settings/form.tsx console/app/settings/page.tsx
git commit -F - <<'EOF'
console: time format select on settings (Appearance)

After Theme, same setrow shape; option labels carry example strings so the
choice is self-explanatory. Saved as appearance.timeFormat in the existing
PUT payload.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Console — migrate every timestamp render

**Files:** (all under `console/app/`; line numbers pre-edit)
- Modify: the 24 full-timestamp sites and 2 compact sites listed below.

**Interfaces:**
- Consumes: `<DateTime iso={...} />` and `presetLocale()` from Task 3, exactly as defined there.

- [ ] **Step 1: Swap all full-timestamp sites**

The transformation is always: `{new Date(X).toLocaleString()}` → `<DateTime iso={X} />`, with the import added once per file. Import path by directory depth: files in `app/<dir>/` use `import { DateTime } from "../lib/datetime";`, files in `app/<dir>/[param]/` use `"../../lib/datetime"`. Server components may import a client component — already common in this app.

| File:line | Old expression (inside JSX) | New |
|---|---|---|
| `api-keys/page.tsx:26` | `{new Date(k.created_at).toLocaleString()}` | `<DateTime iso={k.created_at} />` |
| `api-keys/page.tsx:27` | `{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "—"}` | `{k.last_used_at ? <DateTime iso={k.last_used_at} /> : "—"}` |
| `environments/page.tsx:30` | `{new Date(e.updated_at).toLocaleString()}` | `<DateTime iso={e.updated_at} />` |
| `files/table.tsx:71` | `{new Date(f.created_at).toLocaleString()}` | `<DateTime iso={f.created_at} />` |
| `cache/page.tsx:36` | `{new Date(c.created).toLocaleString()}` | `<DateTime iso={c.created} />` |
| `agents/page.tsx:39` | `{new Date(a.updated_at).toLocaleString()}` | `<DateTime iso={a.updated_at} />` |
| `agents/[id]/page.tsx:42` | `last modified {new Date(agent.updated_at).toLocaleString()}` | `last modified <DateTime iso={agent.updated_at} />` |
| `agents/[id]/tabs.tsx:123` | `{new Date(s.updated_at).toLocaleString()}` | `<DateTime iso={s.updated_at} />` |
| `files/[id]/page.tsx:18` | `created {new Date(f.created_at).toLocaleString()}` | `created <DateTime iso={f.created_at} />` |
| `workspaces/page.tsx:31` | `{new Date(w.created_at).toLocaleString()}` | `<DateTime iso={w.created_at} />` |
| `skills/page.tsx:28` | `{new Date(s.updated_at).toLocaleString()}` | `<DateTime iso={s.updated_at} />` |
| `skills/[id]/page.tsx:16` | `last modified {new Date(skill.updated_at).toLocaleString()}` | `last modified <DateTime iso={skill.updated_at} />` |
| `sessions/page.tsx:60` | `{new Date(s.updated_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}` | `<DateTime iso={s.updated_at} />` |
| `sessions/[id]/page.tsx:23` | `last activity {new Date(session.updated_at).toLocaleString()}` | `last activity <DateTime iso={session.updated_at} />` |
| `memory-stores/page.tsx:24` | `{new Date(s.updated_at).toLocaleString()}` | `<DateTime iso={s.updated_at} />` |
| `memory-stores/[id]/page.tsx:20` | `last modified {new Date(store.updated_at).toLocaleString()}` | `last modified <DateTime iso={store.updated_at} />` |
| `memory-stores/[id]/browser.tsx:53` | `{new Date(entries.find((e) => e.path === loaded)!.updated_at).toLocaleString()}` | `<DateTime iso={entries.find((e) => e.path === loaded)!.updated_at} />` |
| `wikis/page.tsx:32` | `{new Date(w.updated_at).toLocaleString()}` | `<DateTime iso={w.updated_at} />` |
| `wikis/[id]/page.tsx:20` | `last modified {new Date(wiki.updated_at).toLocaleString()}` | `last modified <DateTime iso={wiki.updated_at} />` |
| `wikis/[id]/browser.tsx:61` | `{new Date(entries.find((e) => e.path === loaded)!.updated_at).toLocaleString()}` | `<DateTime iso={entries.find((e) => e.path === loaded)!.updated_at} />` |
| `vaults/page.tsx:24` | `{new Date(v.updated_at).toLocaleString()}` | `<DateTime iso={v.updated_at} />` |
| `vaults/[id]/page.tsx:15` | `last modified {new Date(vault.updated_at).toLocaleString()}` | `last modified <DateTime iso={vault.updated_at} />` |
| `vaults/[id]/page.tsx:35` | `{new Date(c.created_at).toLocaleString()}` | `<DateTime iso={c.created_at} />` |
| `routings/page.tsx:32` | `{r.updated_at ? new Date(r.updated_at).toLocaleString() : "—"}` | `{r.updated_at ? <DateTime iso={r.updated_at} /> : "—"}` |

Special case — `settings/form.tsx:296` builds a plain STRING inside a ternary, so it becomes JSX instead (the surrounding `<span>` renders nodes fine). Replace lines 293–297:

```tsx
              {maintDirty
                ? <span style={{ color: "var(--bad)" }}>⚠ Unsaved changes — press “Save settings” first.</span>
                : (runMsg ?? (summary
                  ? <>Last run <DateTime iso={summary.at} /> — {Object.values(summary.sections).some((x) => x.error) ? "completed with errors" : "completed successfully"}</>
                  : "never run"))}
```
(`form.tsx` sits in `app/settings/` → import from `"../lib/datetime"`.)

- [ ] **Step 2: Compact sites follow the locale, keep their shapes**

`deployments/[name]/trace.tsx:193` (keeps seconds):
```tsx
            <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>{new Date(e.ts).toLocaleTimeString(presetLocale())}</span>
```
`deployments/[name]/stats.tsx:32-37` — pass the locale in `bucketTimeLabel` (its callers in `stats.tsx` and `dashboard-usage.tsx` need no change; both files render from client-side fetched data, so the SSR `undefined` branch never paints):
```tsx
export const bucketTimeLabel = (t: number, bucketSeconds: number) => {
  const d = new Date(t * 1000);
  if (bucketSeconds < 60) return d.toLocaleTimeString(presetLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (bucketSeconds >= 1440) return d.toLocaleString(presetLocale(), { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return d.toLocaleTimeString(presetLocale(), { hour: "2-digit", minute: "2-digit" });
};
```
Both files import `presetLocale` from `"../../lib/datetime"`.

- [ ] **Step 3: Verify nothing was missed**

```powershell
cd console; npx next build
```
Expected: success. Then:
```
Grep pattern "new Date\([^)]*\)\.toLocale" in console/app — expected matches: NONE.
```
(The remaining `toLocaleString()` calls are NUMBER formatting — token counts, byte counts, pager — out of scope and they don't match this pattern.) Also `git diff --stat`: only the listed files changed; on this CRLF repo re-check the diff for accidentally joined lines.

- [ ] **Step 4: Commit**

```bash
git add -A console/app
git commit -F - <<'EOF'
console: route every timestamp through DateTime

24 full-timestamp sites swap to <DateTime iso>; the deployment trace clock
and stats/dashboard chart ticks keep their compact shapes but take
presetLocale(). Drops the sessions-page one-off short style (0ec0d1d).
Number formatting (toLocaleString on counts) deliberately untouched.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Deploy to the local cluster + live verification

**Files:** none (build + cluster ops). Both CP and console images changed.

**Interfaces:**
- Consumes: everything above, plus this cluster's rollout procedure (in-cluster chart, `default` ns, images ctr-imported per node — never pushed; kubelet may cache same-tag digests, so verify `imageID`).

- [ ] **Step 1: Build both images** (Git Bash, repo root)

```bash
VERSION=v0.1.1 REGISTRY=ghcr.io/devproof REVISION=$(git rev-parse HEAD) docker buildx bake console control-plane
```
Expected: both end with `naming to ghcr.io/devproof/devproofai-<name>:v0.1.1 done`. Note each build's `exporting config sha256:…` digest — that's what `imageID` must show later.

- [ ] **Step 2: Import into all 7 worker nodes** (Git Bash; scratchpad dir for tars)

```bash
docker save ghcr.io/devproof/devproofai-console:v0.1.1 -o console.tar
docker save ghcr.io/devproof/devproofai-control-plane:v0.1.1 -o cp.tar
for n in desktop-worker desktop-worker2 desktop-worker3 desktop-worker4 desktop-worker5 desktop-worker6 desktop-worker7; do
  MSYS_NO_PATHCONV=1 kubectl debug node/$n --profile=sysadmin --image=busybox --attach=false -q -- sleep 900
done
sleep 5
for p in $(kubectl get pods -o name | grep node-debugger); do
  MSYS_NO_PATHCONV=1 kubectl exec -i ${p#pod/} -- chroot /host ctr -n k8s.io images import - < console.tar
  MSYS_NO_PATHCONV=1 kubectl exec -i ${p#pod/} -- chroot /host ctr -n k8s.io images import - < cp.tar
done
```
Expected per import: `unpacking ... done` / the saved-image line. Afterwards delete the debugger pods and the tars.

- [ ] **Step 3: Roll both deployments, verify the digests**

```bash
kubectl rollout restart deploy/console deploy/controlplane -n default
kubectl rollout status deploy/console -n default --timeout=180s
kubectl rollout status deploy/controlplane -n default --timeout=180s
kubectl get pods -n default -o jsonpath='{range .items[*]}{.metadata.name} {.status.containerStatuses[0].imageID}{"\n"}{end}' | grep -E "console|controlplane"
```
Expected: both `imageID`s equal the Step-1 config digests. If stale (kubelet tag→digest cache), delete the pod once more. The `kubectl port-forward svc/console 7090:7090` on the host dies with the old pod — restart it (hidden window) before the browser checks.

- [ ] **Step 4: Live verification** (browser at `http://localhost:7090`)

1. All pages 200 (spot-check /sessions, /agents, /files, /settings, /deployments, /wikis).
2. Pre-hydration check (JS-free): `curl -s http://localhost:7090/sessions | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}Z' | head -3` — expected: sliced-ISO fallbacks present in the server HTML.
3. Default preset: /sessions Last activity shows `20.7.2026, 22:13`-style (browser locale, VIEWER timezone — the listed time must match the local clock, not UTC−2h).
4. Flip each preset on /settings → Save: the "Last run" timestamp on the settings page itself re-renders WITHOUT a reload (the MutationObserver path); /sessions (server-rendered) and a memory-store entry view (client-rendered) show the SAME string style.
5. `iso` preset: deployment detail → Trace tab clock shows 24h `22:13:12`; Stats ticks 24h.
6. CP-down fallback: `kubectl scale deploy/controlplane -n default --replicas=0`, reload /sessions — page renders with sliced-ISO timestamps (layout falls back to `browser`, data fetch may show the unreachable state; no crash) — then `--replicas=1` and wait Ready.
7. Reset the setting to the user's preference (ask, or leave on `browser`).

- [ ] **Step 5: Commit nothing — confirm clean tree**

`git status` — expected: clean (Tasks 1–5 committed everything; this task only built and deployed).
