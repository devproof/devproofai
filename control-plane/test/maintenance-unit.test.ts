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
  assert.deepEqual(d.rejects, { enabled: true, keep: 30, unit: "days" });
  assert.deepEqual(d.prices, { enabled: true });
  assert.deepEqual(d.k8s, { enabled: true });
  assert.equal(defaultMaintenanceSettings("*/5 * * * *").cron, "*/5 * * * *");
});

test("mergeMaintenanceSettings: per-field merge over base", () => {
  const base = defaultMaintenanceSettings();
  const m = mergeMaintenanceSettings(base, { cron: "*/30 * * * *", billing: { enabled: true } });
  assert.equal(m.cron, "*/30 * * * *");
  assert.equal(m.billing.enabled, true);
  assert.equal(m.billing.keep, 365);          // absent field keeps base
  assert.equal(m.sessions.idle.keep, 7);      // untouched section keeps base
  const m2 = mergeMaintenanceSettings(base, { rejects: { keep: 90 }, prices: { enabled: false }, k8s: { enabled: false } });
  assert.deepEqual(m2.rejects, { enabled: true, keep: 90, unit: "days" }); // partial keeps base enabled/unit
  assert.equal(m2.prices.enabled, false);
  assert.equal(m2.k8s.enabled, false);
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
  assert.match(validateMaintenanceSettings({ rejects: { keep: 0 } })!, /keep/);
  assert.match(validateMaintenanceSettings({ prices: { enabled: "yes" } })!, /prices/);
  assert.match(validateMaintenanceSettings({ k8s: { enabled: 1 } })!, /k8s/);
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
    rejects: [] as number[], priceKinds: [] as [string, string[]][],
    sweeps: [] as any[],
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
      async pruneRoutingRejects(ms: number) { calls.rejects.push(ms); return 4; },
      async pruneOrphanResourcePrices(kind: string, refs: string[]) { calls.priceKinds.push([kind, refs]); return 2; },
      async listAllIds(table: string) { return [`${table}_id1`]; },
    },
    files,
    deleteSession: async (_w: string, id: string) => { calls.deleted.push(id); },
    listServing: async () => ({ pools: ["p1"], deployments: ["d1"] }),
    sweepK8s: async (input: any) => { calls.sweeps.push(input); return { secrets: 1, egress: 3, policies: 1, pvcs: 2, errors: [] }; },
  };
  return { deps: deps as any, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("runMaintenance: default sections — retention legs skipped, sweeps run", async () => {
  const { deps, calls, cleanup } = fakeDeps(defaultMaintenanceSettings());
  try {
    const s = await runMaintenance(deps);
    assert.equal(s.sections.billing.ran, false);
    assert.equal(s.sections.tokens.ran, false);
    assert.equal(s.sections.sessions.ran, false);
    assert.equal(s.sections.files.ran, false);
    assert.equal(s.sections.orphans.ran, true);
    assert.equal(s.sections.rejects.ran, true);      // default ON (spec 2026-07-24)
    assert.deepEqual(calls.rejects, [30 * 86_400_000]);
    assert.equal(s.sections.rejects.rows, 4);
    assert.equal(s.sections.prices.ran, true);       // default ON
    assert.equal(s.sections.prices.rows, 8);         // 4 kinds × stub 2
    assert.deepEqual(calls.priceKinds.map(([k]) => k), ["pool", "deployment", "external", "environment"]);
    assert.deepEqual(calls.priceKinds[0][1], ["p1"]);
    assert.deepEqual(calls.priceKinds[2][1], ["external_deployments_id1"]);
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

test("runMaintenance prices: failed serving list skips pool/deployment legs only", async () => {
  const { deps, calls, cleanup } = fakeDeps(defaultMaintenanceSettings());
  deps.listServing = async () => { throw new Error("no CRDs"); };
  try {
    const s = await runMaintenance(deps);
    assert.deepEqual(calls.priceKinds.map(([k]: [string, string[]]) => k), ["external", "environment"]);
    assert.equal(s.sections.prices.rows, 4);
    assert.match(s.sections.prices.error!, /serving.*no CRDs/);
  } finally { cleanup(); }
});

test("runMaintenance prices: absent listServing dep fails the serving legs closed", async () => {
  const { deps, calls, cleanup } = fakeDeps(defaultMaintenanceSettings());
  delete deps.listServing;
  try {
    const s = await runMaintenance(deps);
    assert.deepEqual(calls.priceKinds.map(([k]: [string, string[]]) => k), ["external", "environment"]);
    assert.match(s.sections.prices.error!, /no kubestore access/);
  } finally { cleanup(); }
});

test("runMaintenance rejects: disabled section is skipped", async () => {
  const settings = defaultMaintenanceSettings();
  settings.rejects.enabled = false;
  const { deps, calls, cleanup } = fakeDeps(settings);
  try {
    const s = await runMaintenance(deps);
    assert.equal(s.sections.rejects.ran, false);
    assert.deepEqual(calls.rejects, []);
  } finally { cleanup(); }
});

test("runMaintenance k8s: id sets flow to the sweep, counts land in the summary", async () => {
  const { deps, calls, cleanup } = fakeDeps(defaultMaintenanceSettings());
  try {
    const s = await runMaintenance(deps);
    assert.equal(s.sections.k8s.ran, true);
    assert.equal(calls.sweeps.length, 1);
    assert.deepEqual(calls.sweeps[0].vaultIds, ["vaults_id1"]);
    assert.deepEqual(calls.sweeps[0].environmentIds, ["environments_id1"]);
    assert.deepEqual(calls.sweeps[0].sessionIds, ["sessions_id1"]);
    assert.equal(calls.sweeps[0].graceMs, 3_600_000);
    assert.equal(s.sections.k8s.secrets, 1);
    assert.equal(s.sections.k8s.egress, 3);
    assert.equal(s.sections.k8s.policies, 1);
    assert.equal(s.sections.k8s.pvcs, 2);
    assert.equal(s.sections.k8s.error, undefined);
  } finally { cleanup(); }
});

test("runMaintenance k8s: absent dep reports error, class errors joined", async () => {
  const { deps, cleanup } = fakeDeps(defaultMaintenanceSettings());
  delete deps.sweepK8s;
  try {
    const s = await runMaintenance(deps);
    assert.equal(s.sections.k8s.ran, true);
    assert.match(s.sections.k8s.error!, /no k8s access/);
  } finally { cleanup(); }
  const withErrs = fakeDeps(defaultMaintenanceSettings());
  withErrs.deps.sweepK8s = async () => ({ secrets: 1, errors: ["pvcs: list timed out"] });
  try {
    const s = await runMaintenance(withErrs.deps);
    assert.equal(s.sections.k8s.secrets, 1);
    assert.equal(s.sections.k8s.pvcs, undefined, "failed class stays undefined");
    assert.match(s.sections.k8s.error!, /pvcs: list timed out/);
  } finally { withErrs.cleanup(); }
});

test("runMaintenance k8s: DB id-list failure aborts before the sweep (fail-closed)", async () => {
  const { deps, calls, cleanup } = fakeDeps(defaultMaintenanceSettings());
  deps.repo.listAllIds = async (table: string) => {
    if (table === "sessions") throw new Error("db down");
    return [];
  };
  try {
    const s = await runMaintenance(deps);
    assert.match(s.sections.k8s.error!, /db down/);
    assert.equal(calls.sweeps.length, 0, "sweep never called on partial DB data");
  } finally { cleanup(); }
});
