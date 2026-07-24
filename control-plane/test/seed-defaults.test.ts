// One-time default resource seed (spec 2026-07-24-default-resource-seeding-
// design.md): marker-guarded, per-resource skip-if-exists, flag-gated.
// Shared dev DB — throwaway t-seed-* workspaces (swept by run-tests.mjs);
// the app_settings singleton is snapshotted and restored around every test
// (safe under --test-concurrency=1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { seedDefaults } from "../src/seed-defaults.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

const tag = Date.now();
const repo = new Repo(pool);

test("seed marker: absent → false, set → true", { skip: !available }, async () => {
  const { rows: snap } = await pool.query("SELECT data FROM app_settings WHERE id = 'global'");
  const original = snap[0].data;
  try {
    await pool.query("UPDATE app_settings SET data = data - 'seed' WHERE id = 'global'");
    assert.equal(await repo.getSeedDefaultsApplied(), false);
    await repo.setSeedDefaultsApplied();
    assert.equal(await repo.getSeedDefaultsApplied(), true);
  } finally {
    await pool.query("UPDATE app_settings SET data = $1 WHERE id = 'global'", [original]);
  }
});

function fakeKube() {
  const pools = new Map<string, any>();
  const kube = {
    async get(_plural: any, name: string) { return pools.get(name) ?? null; },
    async create(_plural: any, body: any) { pools.set(body.metadata.name, body); return body; },
  };
  return { pools, kube };
}

// Fresh throwaway workspace + cleared marker per test; restores the whole
// app_settings singleton and the flag env afterwards.
async function withSeedRun(n: number, fn: (wsId: string) => Promise<void>) {
  const wsId = `t-seed-${tag}-${n}`;
  await pool.query("INSERT INTO workspaces (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING", [wsId]);
  const { rows: snap } = await pool.query("SELECT data FROM app_settings WHERE id = 'global'");
  const original = snap[0].data;
  await pool.query("UPDATE app_settings SET data = data - 'seed' WHERE id = 'global'");
  try {
    await fn(wsId);
  } finally {
    delete process.env.DEVPROOF_SEED_DEFAULTS;
    await pool.query("UPDATE app_settings SET data = $1 WHERE id = 'global'", [original]);
  }
}

const envRows = async (wsId: string) => (await pool.query(
  "SELECT name, allow_package_managers, allowed_hosts, allow_mcp_servers, pod FROM environments WHERE workspace_id = $1 ORDER BY name",
  [wsId])).rows;

test("seedDefaults: seeds 2 envs + 2 pools and sets the marker", { skip: !available }, async () => {
  await withSeedRun(1, async (wsId) => {
    process.env.DEVPROOF_SEED_DEFAULTS = "true";
    const { pools, kube } = fakeKube();
    await seedDefaults({ repo, kube, workspaceId: wsId });

    const rows = await envRows(wsId);
    assert.deepEqual(rows.map((r) => r.name), ["default-all-allowed", "default-all-blocked"]);
    const allowed = rows[0], blocked = rows[1];
    assert.equal(allowed.allow_package_managers, true);
    assert.equal(allowed.allow_mcp_servers, true);
    assert.deepEqual(allowed.allowed_hosts, ["*"]);
    assert.deepEqual(allowed.pod, { disk: { type: "emptyDir" } });
    assert.equal(blocked.allow_package_managers, false);
    assert.equal(blocked.allow_mcp_servers, false);
    assert.deepEqual(blocked.allowed_hosts, []);
    assert.deepEqual(blocked.pod, { disk: { type: "emptyDir" } });

    assert.equal(pools.size, 2);
    assert.deepEqual(pools.get("default-cpu").spec,
      { gpuType: "cpu", gpusPerNode: 0, maxNodes: 1, nodeSelector: {}, tolerations: [] });
    assert.deepEqual(pools.get("default-gpu").spec,
      { gpuType: "gpu", gpusPerNode: 1, maxNodes: 1, nodeSelector: {}, tolerations: [] });
    assert.equal(pools.get("default-cpu").kind, "ModelPool");

    assert.equal(await repo.getSeedDefaultsApplied(), true);
  });
});

test("seedDefaults: skips existing resources untouched, seeds the rest", { skip: !available }, async () => {
  await withSeedRun(2, async (wsId) => {
    process.env.DEVPROOF_SEED_DEFAULTS = "true";
    // Pre-existing env with a DIFFERENT config — must survive unmodified.
    await repo.createEnvironment(wsId, "default-all-blocked", true, ["keep.me"], {}, true);
    const { pools, kube } = fakeKube();
    pools.set("default-cpu", { metadata: { name: "default-cpu" }, spec: { sentinel: true } });

    await seedDefaults({ repo, kube, workspaceId: wsId });

    const rows = await envRows(wsId);
    assert.equal(rows.length, 2); // no duplicate default-all-blocked
    const blocked = rows.find((r) => r.name === "default-all-blocked")!;
    assert.deepEqual(blocked.allowed_hosts, ["keep.me"]); // untouched
    assert.equal(pools.get("default-cpu").spec.sentinel, true); // untouched
    assert.ok(pools.get("default-gpu"), "missing pool seeded");
    assert.equal(await repo.getSeedDefaultsApplied(), true);
  });
});

test("seedDefaults: marker present → no-op", { skip: !available }, async () => {
  await withSeedRun(3, async (wsId) => {
    process.env.DEVPROOF_SEED_DEFAULTS = "true";
    await repo.setSeedDefaultsApplied();
    const { pools, kube } = fakeKube();
    await seedDefaults({ repo, kube, workspaceId: wsId });
    assert.equal((await envRows(wsId)).length, 0);
    assert.equal(pools.size, 0);
  });
});

test("seedDefaults: flag unset or not 'true' → no-op, no marker", { skip: !available }, async () => {
  await withSeedRun(4, async (wsId) => {
    delete process.env.DEVPROOF_SEED_DEFAULTS;
    const { pools, kube } = fakeKube();
    await seedDefaults({ repo, kube, workspaceId: wsId });
    process.env.DEVPROOF_SEED_DEFAULTS = "false";
    await seedDefaults({ repo, kube, workspaceId: wsId });
    assert.equal((await envRows(wsId)).length, 0);
    assert.equal(pools.size, 0);
    assert.equal(await repo.getSeedDefaultsApplied(), false);
  });
});

test("seedDefaults: no kubestore → envs seeded, pools skipped, marker set", { skip: !available }, async () => {
  await withSeedRun(5, async (wsId) => {
    process.env.DEVPROOF_SEED_DEFAULTS = "true";
    await seedDefaults({ repo, kube: null, workspaceId: wsId });
    assert.equal((await envRows(wsId)).length, 2);
    assert.equal(await repo.getSeedDefaultsApplied(), true);
  });
});

test("seedDefaults: kube.create failure leaves marker unset; retry converges", { skip: !available }, async () => {
  await withSeedRun(6, async (wsId) => {
    process.env.DEVPROOF_SEED_DEFAULTS = "true";
    const { pools, kube } = fakeKube();
    const failing = {
      get: kube.get,
      async create(_plural: any, _body: any) { throw new Error("apiserver unavailable"); },
    };
    await assert.rejects(() => seedDefaults({ repo, kube: failing as any, workspaceId: wsId }));
    assert.equal(await repo.getSeedDefaultsApplied(), false); // marker stays unset
    assert.equal((await envRows(wsId)).length, 2); // envs landed before the pool failure

    await seedDefaults({ repo, kube, workspaceId: wsId }); // retry with a healthy kube
    assert.equal((await envRows(wsId)).length, 2); // 23505 path skipped the existing envs
    assert.equal(pools.size, 2);
    assert.equal(await repo.getSeedDefaultsApplied(), true);
  });
});
