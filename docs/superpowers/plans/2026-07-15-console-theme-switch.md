# Console Theme Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator pick the console theme (System / Light / Dark) from `/settings`, instead of dark mode being reachable only via the OS setting.

**Architecture:** The theme is one more key in the existing `app_settings` JSONB singleton (**no SQL migration**). `layout.tsx` — already an async server component — reads it and stamps `<html data-theme>`, so there is no flash and no inline blocking script. CSS moves every colour token to `light-dark(light, dark)` and lets `color-scheme` choose, which deletes the `@media (prefers-color-scheme: dark)` block entirely.

**Tech Stack:** Fastify + Postgres (control plane, TS), Next.js App Router (console), plain CSS custom properties. Tests: `node --test` via `npm test`.

**Spec:** `docs/superpowers/specs/2026-07-15-console-theme-switch-design.md`

## Global Constraints

- **No new SQL file.** `app_settings` is `(id='global', data JSONB)`; `appearance` is a key in `data`. `migrate()` re-runs every file each boot — not adding one is deliberate.
- **Theme values are exactly** `"system" | "light" | "dark"`. Default `"system"` (= today's behaviour).
- **Validate before persist.** `PUT /v1/settings` runs every validation before the first write; `gc-settings.test.ts` explicitly asserts a bad field leaves earlier fields unpersisted. New validation goes in the validation block, not after it.
- **Persist-when-provided.** A body omitting `appearance` leaves the stored theme untouched and echoes the current value — same convention as `limits` and `storage`.
- **Palette values are carried over verbatim.** This is a refactor; no hex may change. Verified: the light-mode `.phase.ok` colour must still resolve to `color(srgb 0.0785882 0.385255 0.270431)`.
- **`light-dark()` requires Chrome 123+ / Safari 17.5+ / FF 120+.** Verified working in Chrome 150, including nested inside `color-mix()` and resolving from an ancestor's `color-scheme`.
- **Console is always a production build:** `npx next build && npx next start -p 7090`. Building under a running `next start` pins stale chunk hashes — always rebuild *then* restart.
- Run the control plane with `npx tsx src/main.ts` (not `npm run dev` — it exits under tool backgrounding).

---

### Task 1: Appearance module + repo persistence

**Files:**
- Create: `control-plane/src/appearance.ts`
- Modify: `control-plane/src/repo.ts` (add after `putStorageSettings`, ~line 1326)
- Test: `control-plane/test/appearance-settings.test.ts`

**Interfaces:**
- Consumes: `Repo` class and `this.pool` (`repo.ts`), `createPool`/`migrate` (`src/db.ts`).
- Produces:
  - `type Theme = "system" | "light" | "dark"`
  - `interface Appearance { theme: Theme }`
  - `const THEMES: readonly Theme[]`, `const DEFAULT_THEME: Theme`, `const DEFAULT_APPEARANCE: Appearance`
  - `normalizeAppearance(raw: unknown): Appearance`
  - `validateAppearance(raw: unknown): string | null`
  - `Repo.getAppearance(): Promise<Appearance>`, `Repo.putAppearance(a: Appearance): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `control-plane/test/appearance-settings.test.ts` (mirrors `limits-settings.test.ts`):

```ts
// Console theme setting: defaults, validation, repo round-trip (spec 2026-07-15).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { DEFAULT_APPEARANCE, normalizeAppearance, validateAppearance } from "../src/appearance.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

test("normalize: absent/invalid theme reads as the system default", () => {
  assert.deepEqual(normalizeAppearance(undefined), DEFAULT_APPEARANCE);
  assert.equal(normalizeAppearance({}).theme, "system");
  assert.equal(normalizeAppearance({ theme: "blue" }).theme, "system");
  assert.equal(normalizeAppearance({ theme: 7 }).theme, "system");
  assert.equal(normalizeAppearance([]).theme, "system");
  assert.equal(normalizeAppearance({ theme: "dark" }).theme, "dark");
  assert.equal(normalizeAppearance({ theme: "light" }).theme, "light");
});

test("validate: bad themes are named, valid passes", () => {
  assert.equal(validateAppearance(undefined), null);
  assert.equal(validateAppearance({}), null);
  assert.equal(validateAppearance({ theme: "dark" }), null);
  assert.match(validateAppearance({ theme: "blue" })!, /theme/);
  assert.match(validateAppearance({ theme: 7 })!, /theme/);
  assert.match(validateAppearance([])!, /object/);
});

test("appearance round-trip via repo", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const before = await repo.getAppearance();
  try {
    await repo.putAppearance({ theme: "dark" });
    assert.deepEqual(await repo.getAppearance(), { theme: "dark" });
    await repo.putAppearance({ theme: "light" });
    assert.deepEqual(await repo.getAppearance(), { theme: "light" });
  } finally {
    await repo.putAppearance(before); // restore — the dev DB is shared
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd control-plane && npx tsx --test test/appearance-settings.test.ts`
Expected: FAIL — cannot find module `../src/appearance.ts`.

- [ ] **Step 3: Create the appearance module**

Create `control-plane/src/appearance.ts`:

```ts
// Console theme stored in the app_settings JSON singleton under `appearance`
// (spec 2026-07-15). Platform-wide today; a per-user override lands with user
// accounts and reads a cookie ahead of this value. Mirrors limits.ts.

export type Theme = "system" | "light" | "dark";

export interface Appearance {
  theme: Theme;
}

export const THEMES: readonly Theme[] = ["system", "light", "dark"] as const;
export const DEFAULT_THEME: Theme = "system";
export const DEFAULT_APPEARANCE: Appearance = { theme: DEFAULT_THEME };

function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}

/** Coerce stored/absent JSON to a valid Appearance, falling back to the default. */
export function normalizeAppearance(raw: unknown): Appearance {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { theme?: unknown }) : {};
  return { theme: isTheme(r.theme) ? r.theme : DEFAULT_THEME };
}

/** Returns an error message, or null when the input is a valid partial. */
export function validateAppearance(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "appearance must be an object";
  const t = (raw as { theme?: unknown }).theme;
  if (t != null && !isTheme(t)) return `appearance.theme must be one of: ${THEMES.join(", ")}`;
  return null;
}
```

- [ ] **Step 4: Add the repo accessors**

In `control-plane/src/repo.ts`, add to the existing import block near the other settings imports:

```ts
import { normalizeAppearance, type Appearance } from "./appearance.ts";
```

Then insert immediately after `putStorageSettings` (~line 1326), before `getGcLastRun`:

```ts
  // ── Appearance / theme (spec 2026-07-15) ─────────────────────────────────
  async getAppearance(): Promise<Appearance> {
    const { rows } = await this.pool.query("SELECT data->'appearance' AS appearance FROM app_settings WHERE id = 'global'");
    return normalizeAppearance(rows[0]?.appearance);
  }
  async putAppearance(a: Appearance) {
    await this.pool.query(
      `UPDATE app_settings SET data = jsonb_set(data, '{appearance}', $1::jsonb), updated_at = now() WHERE id = 'global'`,
      [JSON.stringify(a)]);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd control-plane && npx tsx --test test/appearance-settings.test.ts`
Expected: PASS — 3 tests. (The round-trip test skips if no DB is reachable; that is fine.)

- [ ] **Step 6: Typecheck**

Run: `cd control-plane && npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/appearance.ts control-plane/src/repo.ts control-plane/test/appearance-settings.test.ts
git commit -m "feat(cp): appearance/theme setting module + repo persistence"
```

---

### Task 2: Expose appearance on GET/PUT /v1/settings

**Files:**
- Modify: `control-plane/src/agents-api.ts:792-830` (the `/v1/settings` GET and PUT handlers)
- Test: `control-plane/test/appearance-settings.test.ts` (extend)

**Interfaces:**
- Consumes: `normalizeAppearance`, `validateAppearance`, `DEFAULT_THEME` from Task 1; `repo.getAppearance` / `repo.putAppearance` from Task 1.
- Produces: `GET /v1/settings` response gains `appearance: { theme }`. `PUT /v1/settings` accepts `appearance?: { theme?: string }`, 400s on a bad theme, and returns `{ costs, limits, storage, appearance }`.

- [ ] **Step 1: Write the failing tests**

Append to `control-plane/test/appearance-settings.test.ts`. Add these imports to the top of the file (merge with the existing import block):

```ts
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgentRoutes, type Orchestrator } from "../src/agents-api.ts";
import { localFileStore } from "../src/filestore.ts";
```

Append these tests (the `build()` helper mirrors `gc-settings.test.ts`):

```ts
async function build() {
  const repo = new Repo(pool);
  const root = mkdtempSync(join(tmpdir(), "appearance-settings-test-"));
  const files = localFileStore(root);
  const app = Fastify();
  await registerAgentRoutes(app, repo, {} as unknown as Orchestrator, files);
  return { app, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("GET /v1/settings includes the appearance block", { skip: !available }, async () => {
  const { app, cleanup } = await build();
  try {
    const res = await app.inject({ method: "GET", url: "/v1/settings" });
    assert.equal(res.statusCode, 200);
    assert.ok(["system", "light", "dark"].includes(res.json().appearance.theme));
  } finally { cleanup(); }
});

test("PUT /v1/settings validates theme BEFORE persisting anything", { skip: !available }, async () => {
  const { app, repo, cleanup } = await build();
  const beforeTheme = await repo.getAppearance();
  try {
    const before = await app.inject({ method: "GET", url: "/v1/settings" });
    const originalCosts = before.json().costs;
    // Flip an observable field so a persist-then-validate handler leaves a trace.
    const flippedCosts = { ...originalCosts, enabled: !originalCosts.enabled };

    const bad = await app.inject({
      method: "PUT", url: "/v1/settings",
      payload: { costs: flippedCosts, appearance: { theme: "blue" } },
    });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /theme/);

    const afterBad = await app.inject({ method: "GET", url: "/v1/settings" });
    assert.deepEqual(afterBad.json().costs, originalCosts);
  } finally {
    await repo.putAppearance(beforeTheme);
    cleanup();
  }
});

test("PUT /v1/settings persists theme when provided, leaves it when omitted", { skip: !available }, async () => {
  const { app, repo, cleanup } = await build();
  const beforeTheme = await repo.getAppearance();
  try {
    const ok = await app.inject({
      method: "PUT", url: "/v1/settings",
      payload: { costs: {}, appearance: { theme: "dark" } },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().appearance.theme, "dark");
    assert.deepEqual(await repo.getAppearance(), { theme: "dark" });

    // A body without `appearance` must NOT reset the stored theme.
    const omitted = await app.inject({ method: "PUT", url: "/v1/settings", payload: { costs: {} } });
    assert.equal(omitted.statusCode, 200);
    assert.equal(omitted.json().appearance.theme, "dark");
    assert.deepEqual(await repo.getAppearance(), { theme: "dark" });
  } finally {
    await repo.putAppearance(beforeTheme);
    cleanup();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd control-plane && npx tsx --test test/appearance-settings.test.ts`
Expected: FAIL — `GET` has no `appearance` key (`Cannot read properties of undefined (reading 'theme')`), and the bad-theme PUT returns 200 instead of 400.

- [ ] **Step 3: Import the validators in agents-api.ts**

Add to the import block at the top of `control-plane/src/agents-api.ts`:

```ts
import { normalizeAppearance, validateAppearance } from "./appearance.ts";
```

- [ ] **Step 4: Add appearance to the GET handler**

In `control-plane/src/agents-api.ts`, replace the `GET /v1/settings` handler:

```ts
  app.get("/v1/settings", async () => ({
    costs: await repo.getCostSettings(),
    limits: await repo.getLimits(),
    storage: await repo.getStorageSettings(),
    appearance: await repo.getAppearance(),
    gcLastRun: await repo.getGcLastRun(),
  }));
```

- [ ] **Step 5: Add validation + persistence to the PUT handler**

In the `PUT /v1/settings` handler, widen the body type:

```ts
    const b = req.body as { costs?: unknown; limits?: unknown; storage?: { gcCron?: unknown }; appearance?: unknown };
```

Add this validation immediately after the `cronErr` check and **before** `const costs = normalizeCostSettings(...)` — every validation must run before the first write:

```ts
    const appErr = validateAppearance(b?.appearance);
    if (appErr) return reply.code(400).send({ error: appErr });
```

Then, immediately before the `return`, add the persist-when-provided block and widen the return:

```ts
    // Persist appearance only when the body carries an explicit theme (same
    // convention as limits/storage): an omitted block leaves the stored theme.
    let appearance = await repo.getAppearance();
    const ab = b?.appearance as { theme?: unknown } | undefined;
    if (ab?.theme !== undefined) {
      appearance = normalizeAppearance(ab);
      await repo.putAppearance(appearance);
    }
    return { costs, limits, storage, appearance };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd control-plane && npm test`
Expected: PASS — the whole suite, including the 3 new route tests. No regressions in `gc-settings.test.ts` or `limits-settings.test.ts`.

- [ ] **Step 7: Typecheck**

Run: `cd control-plane && npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 8: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/test/appearance-settings.test.ts
git commit -m "feat(cp): expose appearance.theme on GET/PUT /v1/settings"
```

---

### Task 3: CSS — light-dark() tokens, delete the media query

**Files:**
- Modify: `console/app/globals.css:7-35` (the `:root` block and the `@media (prefers-color-scheme: dark)` block)

**Interfaces:**
- Consumes: nothing.
- Produces: `:root[data-theme="light"]` and `:root[data-theme="dark"]` selectors that force `color-scheme`; every colour token resolves via `light-dark()`. Task 4 stamps the `data-theme` attribute that drives these.

**Why:** the dark palette currently exists only inside the media query, so an explicit override cannot reach it by selector. Duplicating the block would mean two places to edit per token forever. `light-dark()` collapses it to one.

- [ ] **Step 1: Replace the `:root` block and delete the media query**

In `console/app/globals.css`, replace **everything from `:root {` (line 7) through the closing `}` of the `@media (prefers-color-scheme: dark)` block (line 35)** with:

```css
:root {
  /* Theme: `color-scheme` picks which half of every light-dark() resolves.
     Default `light dark` = follow the OS (the System setting). The
     [data-theme] rules below force a side; layout.tsx stamps the attribute
     from app_settings. Setting color-scheme also makes native scrollbars,
     dropdowns and form controls follow the theme — they didn't before.
     ONE source of truth per token: no @media (prefers-color-scheme) block. */
  color-scheme: light dark;
  --paper: light-dark(#eaeef3, #0b1a2c);
  --panel: light-dark(#ffffff, #10243d);
  --ink:   light-dark(#0f2038, #dbe6f3);
  --muted: light-dark(#5c6b7d, #8ba1ba);
  /* Labels (table heads, card/section eyebrows) sit at small uppercase sizes
     where --muted's thin stems wash out (4.85:1 on --thead). --label is the
     same hue at ~7.8:1 light / ~7.95:1 dark — --muted stays the prose grey. */
  --label: light-dark(#3d4c5e, #b6c9de);
  --line:  light-dark(#d6dde7, #24405f);
  --edge:  light-dark(#b9c4d2, #33547a);
  --thead: light-dark(#eef2f7, #14304d);
  --blue:   light-dark(#1e5bc6, #6ba6ff);
  --accent: light-dark(#e8641b, #f2823c);
  --hover:  light-dark(#eef3f9, #17324f);
  --grid:   light-dark(rgba(30, 91, 198, .045), rgba(107, 166, 255, .06));
  --good: light-dark(#167c4a, #46c07d);
  --bad:  light-dark(#c0303a, #ec6a72);
  --mcp:  light-dark(#7b5bd6, #a98cf0);
  /* Chart series pair (validated: lightness band, chroma, CVD ΔE 60+, ≥3:1
     on --panel). Cool blueprint pair — the orange accent stays out of data. */
  --chart1: light-dark(#1e5bc6, #4c8dff);
  --chart2: light-dark(#0d9488, #10a394);
  /* Roles: --font-cond = DISPLAY ONLY (>=18px: h1, .card .big, modal/sheet
     titles). Below that its counters fill in and M/S rasterize dirty — small
     uppercase labels use --font-sans 600 + --label. --font-mono = machine data
     (ids, code, chips, axes); its fixed advances look ragged as label text. */
  --font-sans: var(--f-sans, system-ui), -apple-system, "Segoe UI", sans-serif;
  --font-cond: var(--f-cond, var(--f-sans, system-ui)), sans-serif;
  --font-mono: var(--f-mono, ui-monospace, "Cascadia Mono", Consolas), monospace;
}
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"]  { color-scheme: dark; }
```

Every hex is carried over verbatim from the old two blocks. No palette value changes.

- [ ] **Step 2: Rebuild and restart the console**

Run:
```bash
cd console && npx next build
```
Expected: `✓ Compiled successfully`.

Then stop whatever listens on 7090 and restart (building under a running `next start` pins stale chunk hashes):
```bash
npx next start -p 7090
```

- [ ] **Step 3: Verify the palette is unchanged and both themes flip**

Open `http://localhost:7090/deployments`. In the browser console:

```js
const root = document.documentElement;
const probe = () => {
  const th = getComputedStyle(document.querySelector('thead th')).color;
  const badge = getComputedStyle(document.querySelector('.phase')).color;
  return { th, badge };
};
root.setAttribute('data-theme', 'light');  const light = probe();
root.setAttribute('data-theme', 'dark');   const dark = probe();
root.removeAttribute('data-theme');
console.log({ light, dark, flips: JSON.stringify(light) !== JSON.stringify(dark) });
```

Expected: `flips: true`, and **`light.th` is `rgb(61, 76, 94)`** (`--label` #3d4c5e) and **`light.badge` is `color(srgb 0.0785882 0.385255 0.270431)`** — byte-identical to the pre-refactor values. If either differs, a hex was transcribed wrong.

- [ ] **Step 4: Verify no page scrolls horizontally / nothing visually broke**

Load `/`, `/deployments`, `/sessions` and confirm they render normally with no `data-theme` set (System = OS decides, i.e. unchanged behaviour).

- [ ] **Step 5: Commit**

```bash
git add console/app/globals.css
git commit -m "refactor(console): light-dark() colour tokens; drop prefers-color-scheme block"
```

---

### Task 4: Stamp data-theme server-side in layout.tsx

**Files:**
- Modify: `console/app/layout.tsx:14-33`

**Interfaces:**
- Consumes: `appearance.theme` from `GET /v1/settings` (Task 2); the `[data-theme]` selectors from Task 3.
- Produces: `<html data-theme="system|light|dark">` on every page, server-rendered.

**Why server-side:** the usual SSR theme workaround (an inline blocking script) exists because the client learns the theme too late. Here the value is already on the server — `layout.tsx` is async and already fetches `/v1/workspaces`.

- [ ] **Step 1: Replace the RootLayout body**

In `console/app/layout.tsx`, replace the whole `RootLayout` function with:

```tsx
export default async function RootLayout({ children }: { children: ReactNode }) {
  // Both reads are independent and degrade separately, so they run in parallel:
  // workspaces falls back to the default list, theme falls back to "system"
  // (= the OS decides, i.e. the pre-2026-07-15 behaviour) when the control
  // plane is down. Server-rendered ⇒ no flash, no inline blocking script.
  const [wsRes, setRes] = await Promise.allSettled([
    wsGet<{ workspaces: any[] }>("/v1/workspaces"),
    wsGet<{ appearance?: { theme?: string } }>("/v1/settings"),
  ]);

  let workspaces = [{ id: "wrkspc_default", name: "Default workspace", status: "active" }];
  if (wsRes.status === "fulfilled" && wsRes.value?.workspaces?.length) workspaces = wsRes.value.workspaces;

  const theme = (setRes.status === "fulfilled" && setRes.value?.appearance?.theme) || "system";

  const cookie = await currentWorkspace();
  // Cookie may point at a deleting/deleted workspace — fall back to default.
  const current = workspaces.some((w) => w.id === cookie && w.status !== "deleting") ? cookie : "wrkspc_default";
  return (
    <html lang="en" data-theme={theme} className={`${sans.variable} ${cond.variable} ${mono.variable}`}>
      <body>
        <div className="shell">
          <Nav workspaces={workspaces} current={current} />
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Rebuild and restart the console**

```bash
cd console && npx next build
```
Then stop the process on 7090 and `npx next start -p 7090`.

- [ ] **Step 3: Verify the attribute is server-rendered (not client-patched)**

Run: `curl -s http://localhost:7090/deployments | grep -o 'data-theme="[a-z]*"' | head -1`
Expected: `data-theme="system"` — present in the **raw HTML**, which is what proves there is no flash.

- [ ] **Step 4: Verify it reflects a stored value end-to-end**

```bash
curl -s -X PUT http://localhost:7080/v1/settings \
  -H 'content-type: application/json' \
  -d '{"costs":{},"appearance":{"theme":"dark"}}' | head -c 200
curl -s http://localhost:7090/deployments | grep -o 'data-theme="[a-z]*"' | head -1
```
Expected: `data-theme="dark"`. Then restore:
```bash
curl -s -X PUT http://localhost:7080/v1/settings \
  -H 'content-type: application/json' -d '{"costs":{},"appearance":{"theme":"system"}}' > /dev/null
```

- [ ] **Step 5: Verify the CP-down fallback**

Stop the control plane, load `http://localhost:7090/deployments`, confirm the page still renders and the HTML carries `data-theme="system"`. Restart the control plane.

- [ ] **Step 6: Commit**

```bash
git add console/app/layout.tsx
git commit -m "feat(console): stamp data-theme from app_settings server-side"
```

---

### Task 5: Appearance panel on /settings

**Files:**
- Modify: `console/app/lib/icons.tsx:11` (add a `theme` icon to the `Icon` object)
- Modify: `console/app/settings/page.tsx` (fetch + pass `appearance`)
- Modify: `console/app/settings/form.tsx` (prop, state, panel, save payload)

**Interfaces:**
- Consumes: `appearance: { theme }` from `GET /v1/settings` (Task 2); `submitJson` from `../lib/modal`; the `setacc`/`setpanel`/`setrow` classes already used by the Cost/Limits/Storage panels.
- Produces: user-facing control that PUTs `appearance: { theme }` and calls `router.refresh()`, which re-runs Task 4's layout and repaints.

- [ ] **Step 1: Add the theme icon**

In `console/app/lib/icons.tsx`, add this entry to the `Icon` object (next to `gauge`):

```tsx
  theme: () => <S><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" /></S>,
```

A circle with a filled right half — the conventional contrast/theme glyph.

- [ ] **Step 2: Fetch and pass appearance from the settings page**

In `console/app/settings/page.tsx`, replace the `SettingsPage` function with:

```tsx
export default async function SettingsPage() {
  const s = await wsGet<{ costs: CostSettings; limits: { maxWorkGb: number }; storage: { gcCron: string }; appearance: { theme: string }; gcLastRun: GcSummary | null }>("/v1/settings").catch(() => null);
  return (
    <>
      <div className="pagehead"><h1>Settings</h1></div>
      <p className="sub">Platform-wide settings. Cost tracking and billing apply across all workspaces.</p>
      {s ? <SettingsForm initial={s.costs} initialLimits={s.limits} initialStorage={s.storage}
                         initialAppearance={s.appearance} gcLastRun={s.gcLastRun} />
         : <div className="empty">Control plane unreachable.</div>}
    </>
  );
}
```

- [ ] **Step 3: Add the prop, state, and save payload in form.tsx**

In `console/app/settings/form.tsx`, change the component signature and add state:

```tsx
export function SettingsForm({ initial, initialLimits, initialStorage, initialAppearance, gcLastRun }: {
  initial: CostSettings; initialLimits: { maxWorkGb: number };
  initialStorage: { gcCron: string }; initialAppearance: { theme: string };
  gcLastRun: GcSummary | null;
}) {
```

Add next to the other `useState` calls (after the `gcCron` line):

```tsx
  const [theme, setTheme] = useState(initialAppearance?.theme ?? "system");
```

In `save()`, include appearance in the payload — replace the `submitJson` line with:

```tsx
    const err = await submitJson("PUT", "/v1/settings", {
      costs: c, limits: { maxWorkGb: n }, storage: { gcCron: gcCron.trim() }, appearance: { theme },
    });
```

`router.refresh()` already runs on success, which re-renders the layout with the new `data-theme`.

- [ ] **Step 4: Add the Appearance panel last**

In `console/app/settings/form.tsx`, insert this immediately **after** the Storage `</details>` and **before** the closing `</div>` of `setacc-group`:

```tsx
      <details className="setacc" open>
        <summary><Icon.theme />Appearance</summary>
        <div className="setpanel">
          <label className="setrow plain">
            <span />
            <span className="setrow-name">Theme</span>
            <span className="setrow-hint" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <select value={theme} onChange={(e) => setTheme(e.target.value)}
                      style={{ width: 130, flex: "none" }}>
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
              System follows each viewer&apos;s operating system setting — applies to everyone using this console
            </span>
          </label>
        </div>
      </details>
```

- [ ] **Step 5: Rebuild and restart the console**

```bash
cd console && npx next build
```
Then stop the process on 7090 and `npx next start -p 7090`.

- [ ] **Step 6: Exercise the flow against the live cluster**

Open `http://localhost:7090/settings`:
1. Appearance panel appears **last**, after Storage.
2. Select **Dark** → **Save settings** → page repaints dark immediately.
3. **Hard-reload** (Ctrl+Shift+R) → still dark, **no flash of light** on load. This is the whole point of Task 4; watch for it specifically.
4. Select **Light** → Save → repaints light; reload stays light regardless of the OS setting.
5. Select **System** → Save → toggle Chrome DevTools' `prefers-color-scheme` emulation and confirm the console follows the OS again.
6. Confirm scrollbars and the `<select>` dropdowns render dark in dark mode (this is the `color-scheme` fix from Task 3).

- [ ] **Step 7: Verify every route in both themes**

With the theme set to `dark`, run:
```bash
for p in / /agents /skills /sessions /environments /vaults /files /memory-stores /catalog /deployments /pools /cache /usage/api /usage/sessions /api-keys /settings /workspaces; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:7090$p"); echo "$code  $p";
done
```
Expected: all `200`. Repeat with `light`. Check the browser console for errors on `/settings` and `/deployments`.

Restore the theme to `system` when done.

- [ ] **Step 8: Commit**

```bash
git add console/app/lib/icons.tsx console/app/settings/page.tsx console/app/settings/form.tsx
git commit -m "feat(console): Appearance panel — System/Light/Dark theme setting"
```

---

### Task 6: Document the convention in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (the "Conventions & gotchas" list)

**Interfaces:**
- Consumes: the finished behaviour from Tasks 1–5.
- Produces: nothing code-facing.

**Why:** `CLAUDE.md` is the project's convention record, and the `light-dark()` rule is exactly the kind of thing that gets silently reverted by someone adding a token the old way.

- [ ] **Step 1: Add the bullet**

Add to the "Conventions & gotchas" list in `CLAUDE.md`:

```markdown
- **Theme (spec 2026-07-15):** `app_settings.data.appearance.theme` = `system|light|dark` (default `system`; no migration — it's a JSONB key). `layout.tsx` stamps `<html data-theme>` server-side from `GET /v1/settings`, so there's no flash and no inline script; CP down ⇒ `system`. CSS has NO `prefers-color-scheme` block: every colour token in `:root` is `light-dark(light, dark)` and `color-scheme` picks (`:root[data-theme="light"|"dark"]` force a side) — add new colour tokens the same way or they won't theme. `color-scheme` is also what makes native scrollbars/dropdowns follow the theme. Platform-wide today; a per-user override would layer a cookie ahead of the stamp in `layout.tsx` (the only seam it touches).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record the theme + light-dark() token convention"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Storage & API — no migration | 1 (module + repo), 2 (routes) |
| CSS — `light-dark()`, media query deleted | 3 |
| Data flow — server-rendered, no flash | 4 |
| UI — Appearance panel last | 5 |
| Testing (unit: bad theme 400, omitted leaves untouched, default system) | 1 (normalize/validate/round-trip), 2 (route tests) |
| Testing (live: three values, no flash, System tracks OS, 17 routes) | 5 steps 6–7 |
| Future (per-user override seam) | documented in 6 |

**Type consistency:** `Theme`, `Appearance`, `normalizeAppearance`, `validateAppearance`, `DEFAULT_APPEARANCE`, `THEMES`, `repo.getAppearance`, `repo.putAppearance` are defined in Task 1 and used with identical names in Tasks 2 and 5. The `appearance: { theme }` response shape is consistent across Tasks 2, 4 and 5.

**Placeholders:** none — every code step carries complete code.
