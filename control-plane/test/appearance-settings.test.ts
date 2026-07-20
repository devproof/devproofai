// Console theme setting: defaults, validation, repo round-trip (spec 2026-07-15).
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { DEFAULT_APPEARANCE, normalizeAppearance, validateAppearance } from "../src/appearance.ts";
import { registerAgentRoutes, type Orchestrator } from "../src/agents-api.ts";
import { localFileStore } from "../src/filestore.ts";

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
    assert.deepEqual(await repo.getAppearance(), { theme: "dark", timeFormat: "browser" });

    // A body without `appearance` must NOT reset the stored theme.
    const omitted = await app.inject({ method: "PUT", url: "/v1/settings", payload: { costs: {} } });
    assert.equal(omitted.statusCode, 200);
    assert.equal(omitted.json().appearance.theme, "dark");
    assert.deepEqual(await repo.getAppearance(), { theme: "dark", timeFormat: "browser" });

    // An empty `appearance` object is a no-op, not a reset to "system" —
    // mirrors the limits precedent (agents-api.test.ts). This is the case that
    // pins the guard to `?.theme !== undefined`: a guard of `appearance !==
    // undefined` would wrongly reset the stored theme here, and every other
    // test in this file would still pass.
    const empty = await app.inject({
      method: "PUT", url: "/v1/settings",
      payload: { costs: {}, appearance: {} },
    });
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.json().appearance.theme, "dark");
    assert.deepEqual(await repo.getAppearance(), { theme: "dark", timeFormat: "browser" });
  } finally {
    await repo.putAppearance(beforeTheme);
    cleanup();
  }
});
