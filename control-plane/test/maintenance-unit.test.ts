import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cronMatches, validateCron, runGc, DEFAULT_MAINTENANCE_CRON,
  defaultMaintenanceSettings, mergeMaintenanceSettings, validateMaintenanceSettings,
  retentionMs, runMaintenance, type MaintenanceSettings as MS,
} from "../src/maintenance.ts";
import { localFileStore } from "../src/filestore.ts";

test("cronMatches: default daily 1am", () => {
  assert.equal(validateCron(DEFAULT_MAINTENANCE_CRON), null);
  assert.equal(cronMatches("0 1 * * *", new Date(2026, 6, 14, 1, 0)), true);
  assert.equal(cronMatches("0 1 * * *", new Date(2026, 6, 14, 1, 1)), false);
  assert.equal(cronMatches("0 1 * * *", new Date(2026, 6, 14, 2, 0)), false);
});

test("cronMatches: steps, ranges, lists, weekday", () => {
  assert.equal(cronMatches("*/15 * * * *", new Date(2026, 6, 14, 9, 30)), true);
  assert.equal(cronMatches("*/15 * * * *", new Date(2026, 6, 14, 9, 31)), false);
  assert.equal(cronMatches("0 9-17 * * *", new Date(2026, 6, 14, 12, 0)), true);
  assert.equal(cronMatches("0 0 * * 1,3", new Date(2026, 6, 13, 0, 0)), true);  // 2026-07-13 is a Monday
  assert.equal(cronMatches("0 0 * * 1,3", new Date(2026, 6, 14, 0, 0)), false); // Tuesday
  assert.equal(cronMatches("0 0 * * 7", new Date(2026, 6, 19, 0, 0)), true);    // Sunday as 7
  // vixie rule: dom OR dow when both are restricted
  assert.equal(cronMatches("0 0 13 * 2", new Date(2026, 6, 13, 0, 0)), true);   // dom matches, dow (Tue) doesn't
});

test("validateCron rejects malformed expressions", () => {
  for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "a * * * *", "*/0 * * * *", "1-70 * * * *"]) {
    assert.notEqual(validateCron(bad), null, bad);
  }
  assert.equal(validateCron("*/5 9-17 1,15 * 1-5"), null);
});

test("runGc deletes orphan rows+objects and old unreferenced objects, honors grace", async () => {
  const root = mkdtempSync(join(tmpdir(), "gc-test-"));
  const files = localFileStore(root);
  try {
    await files.put(Buffer.from("orphan-row-content"), "w/sessions/sesn_dead/file_a");
    await files.put(Buffer.from("live"), "w/files/file_live");
    await files.put(Buffer.from("stray-old"), "w/files/file_stray");
    await files.put(Buffer.from("stray-new"), "w/files/file_fresh");
    // Age the stray + orphan objects past the grace window (mtime -2h).
    const old = (Date.now() - 2 * 3600_000) / 1000;
    utimesSync(join(root, "w", "files", "file_stray"), old, old);

    const deletedRows: string[] = [];
    const repo = {
      async listOrphanFileRows(_grace: number) { return [{ id: "file_a" }]; },
      async deleteFileRecordById(id: string) { deletedRows.push(id); return "w/sessions/sesn_dead/file_a"; },
      async objectKeyExists(key: string) { return key === "w/files/file_live" || key === "w/files/file_fresh"; },
    };
    const summary = await runGc(repo, files, { graceMs: 3600_000 });
    assert.deepEqual(deletedRows, ["file_a"]);
    assert.equal(summary.rows, 1);
    assert.equal(summary.objects, 2); // the orphan row's object + the old stray
    assert.ok(summary.bytes >= "stray-old".length);
    await assert.rejects(async () => files.get("w/sessions/sesn_dead/file_a"));
    await assert.rejects(async () => files.get("w/files/file_stray"));
    assert.equal((await files.get("w/files/file_fresh")).toString(), "stray-new"); // grace kept it
    assert.equal((await files.get("w/files/file_live")).toString(), "live");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("defaultMaintenanceSettings: spec defaults + legacy cron fallback", () => {
  const d = defaultMaintenanceSettings();
  assert.equal(d.cron, DEFAULT_MAINTENANCE_CRON);
  assert.deepEqual(d.orphans, { enabled: true });
  assert.deepEqual(d.billing, { enabled: false, keep: 365, unit: "days" });
  assert.deepEqual(d.tokens, { enabled: false, keep: 365, unit: "days" });
  assert.deepEqual(d.sessions.idle, { enabled: false, keep: 7, unit: "days" });
  assert.deepEqual(d.sessions.completed, { enabled: false, keep: 4, unit: "hours" });
  assert.deepEqual(d.files.input, { enabled: false, keep: 4, unit: "hours" });
  assert.deepEqual(d.files.output, { enabled: false, keep: 4, unit: "hours" });
  assert.equal(defaultMaintenanceSettings("*/5 * * * *").cron, "*/5 * * * *");
});

test("mergeMaintenanceSettings: per-field merge over base", () => {
  const base = defaultMaintenanceSettings();
  const m = mergeMaintenanceSettings(base, { cron: "*/30 * * * *", billing: { enabled: true } });
  assert.equal(m.cron, "*/30 * * * *");
  assert.equal(m.billing.enabled, true);
  assert.equal(m.billing.keep, 365);          // absent field keeps base
  assert.equal(m.sessions.idle.keep, 7);      // untouched section keeps base
  const noop = mergeMaintenanceSettings(base, {});
  assert.deepEqual(noop, base);               // empty object is a no-op, not a reset
});

test("validateMaintenanceSettings rejects bad fields", () => {
  assert.equal(validateMaintenanceSettings(undefined), null);
  assert.equal(validateMaintenanceSettings({}), null);
  assert.match(validateMaintenanceSettings({ cron: "bad" })!, /cron/);
  assert.match(validateMaintenanceSettings({ billing: { keep: 0 } })!, /keep/);
  assert.match(validateMaintenanceSettings({ billing: { keep: 1.5 } })!, /keep/);
  assert.match(validateMaintenanceSettings({ files: { input: { unit: "weeks" } } })!, /unit/);
  assert.match(validateMaintenanceSettings({ tokens: { enabled: "yes" } })!, /enabled/);
  assert.match(validateMaintenanceSettings("nope")!, /object/);
});

test("retentionMs converts hours and days", () => {
  assert.equal(retentionMs({ enabled: true, keep: 4, unit: "hours" }), 14_400_000);
  assert.equal(retentionMs({ enabled: true, keep: 7, unit: "days" }), 604_800_000);
});

function fakeDeps(settings: MS) {
  const calls = {
    cost: [] as number[], usage: [] as number[],
    deleted: [] as string[], fileRows: [] as string[], persisted: null as any,
  };
  const root = mkdtempSync(join(tmpdir(), "maint-unit-"));
  const files = localFileStore(root);
  const deps = {
    repo: {
      async getMaintenanceSettings() { return settings; },
      async setMaintenanceLastRun(s: any) { calls.persisted = s; },
      async pruneCostEntries(ms: number) { calls.cost.push(ms); return 3; },
      async pruneGatewayUsage(ms: number) { calls.usage.push(ms); return 5; },
      async listExpiredSessions(idleMs: number | null, doneMs: number | null) {
        const out: any[] = [];
        if (idleMs !== null) out.push({ id: "sesn_i", workspace_id: "w", status: "idle" });
        if (doneMs !== null) out.push({ id: "sesn_c", workspace_id: "w", status: "completed" });
        return out;
      },
      async listExpiredFiles(kind: string) { return kind === "upload" ? [{ id: "file_i", size: 10 }] : []; },
      async deleteFileRecordById(id: string) { calls.fileRows.push(id); return null; },
      async listOrphanFileRows() { return []; },
      async objectKeyExists() { return true; },
    },
    files,
    deleteSession: async (_w: string, id: string) => { calls.deleted.push(id); },
  };
  return { deps: deps as any, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("runMaintenance: disabled sections are skipped (ran:false), orphans run by default", async () => {
  const { deps, calls, cleanup } = fakeDeps(defaultMaintenanceSettings());
  try {
    const s = await runMaintenance(deps);
    assert.equal(s.sections.billing.ran, false);
    assert.equal(s.sections.tokens.ran, false);
    assert.equal(s.sections.sessions.ran, false);
    assert.equal(s.sections.files.ran, false);
    assert.equal(s.sections.orphans.ran, true);
    assert.deepEqual(calls.cost, []);
    assert.deepEqual(calls.deleted, []);
    assert.ok(calls.persisted, "summary persisted");
  } finally { cleanup(); }
});

test("runMaintenance: enabled sections run with converted cutoffs and report counts", async () => {
  const all = defaultMaintenanceSettings();
  all.billing = { enabled: true, keep: 2, unit: "days" };
  all.tokens = { enabled: true, keep: 12, unit: "hours" };
  all.sessions.idle = { enabled: true, keep: 7, unit: "days" };
  all.sessions.completed = { enabled: true, keep: 4, unit: "hours" };
  all.files.input = { enabled: true, keep: 4, unit: "hours" };
  // files.output stays disabled → output half must stay undefined
  const { deps, calls, cleanup } = fakeDeps(all);
  try {
    const s = await runMaintenance(deps);
    assert.deepEqual(calls.cost, [2 * 86_400_000]);
    assert.deepEqual(calls.usage, [12 * 3_600_000]);
    assert.equal(s.sections.billing.rows, 3);
    assert.equal(s.sections.tokens.rows, 5);
    assert.deepEqual(calls.deleted, ["sesn_i", "sesn_c"]);
    assert.equal(s.sections.sessions.idle, 1);
    assert.equal(s.sections.sessions.completed, 1);
    assert.equal(s.sections.files.input, 1);
    assert.equal(s.sections.files.output, undefined, "disabled half stays undefined");
    assert.deepEqual(calls.fileRows, ["file_i"]);
  } finally { cleanup(); }
});

test("runMaintenance: a section error is recorded and later sections still run", async () => {
  const all = defaultMaintenanceSettings();
  all.billing = { enabled: true, keep: 1, unit: "days" };
  all.tokens = { enabled: true, keep: 1, unit: "days" };
  const { deps, calls, cleanup } = fakeDeps(all);
  deps.repo.pruneCostEntries = async () => { throw new Error("boom"); };
  try {
    const s = await runMaintenance(deps);
    assert.equal(s.sections.billing.ran, true);
    assert.match(s.sections.billing.error!, /boom/);
    assert.equal(s.sections.tokens.rows, 5, "tokens still ran");
    assert.equal(s.sections.orphans.ran, true, "orphans still ran");
    assert.ok(calls.persisted);
  } finally { cleanup(); }
});
