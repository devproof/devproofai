import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";

const pool = createPool();
await migrate(pool);
const repo = new Repo(pool);
const R = `t-rstat-${Date.now().toString(36)}`;

after(async () => {
  await pool.query("DELETE FROM gateway_usage WHERE routing = $1", [R]);
  await pool.query("DELETE FROM routing_rejects WHERE routing = $1", [R]);
  await pool.end();
});

test("deploymentStats filters by routing; breakdown and rejects count", async () => {
  await pool.query(
    `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, source, routing)
     VALUES ('wrkspc_default','m-a',10,5,'api',$1), ('wrkspc_default','m-a',20,5,'api',$1),
            ('wrkspc_default','m-b',1,1,'api',$1), ('wrkspc_default','m-a',999,999,'api',NULL)`, [R]);
  await pool.query("INSERT INTO routing_rejects (routing) VALUES ($1), ($1)", [R]);
  const stats = await repo.deploymentStats(null, { windowSec: 3600, bucketSec: 60, routingName: R });
  assert.equal(stats.totals.requests, 3);
  assert.equal(stats.totals.tokens_in, 31);
  const bd = await repo.routingTargetBreakdown(R, 3600);
  assert.deepEqual(bd.map((b) => [b.model, b.requests]), [["m-a", 2], ["m-b", 1]]);
  assert.equal(await repo.routingRejectCount(R, 3600), 2);
});

test("routingBreakdownBuckets: target + rule series with rejects (fix wave H)", async () => {
  const R2 = `${R}-bk`;
  await pool.query(
    `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, source, routing, routing_rule)
     VALUES ('wrkspc_default','m-a',1,1,'api',$1,0), ('wrkspc_default','m-a',1,1,'api',$1,0),
            ('wrkspc_default','m-b',1,1,'api',$1,-1), ('wrkspc_default','m-c',1,1,'api',$1,NULL)`, [R2]);
  await pool.query("INSERT INTO routing_rejects (routing) VALUES ($1)", [R2]);
  const bk = await repo.routingBreakdownBuckets(R2, { windowSec: 3600, bucketSec: 60 });
  // targets ordered by total desc; every bucket carries at least the t key.
  assert.deepEqual(bk.targetSeries, ["m-a", "m-b", "m-c"]);
  assert.ok(bk.targetBuckets.every((b) => typeof b.t === "number"));
  const totalA = bk.targetBuckets.reduce((s, b) => s + Number((b as any)["m-a"] ?? 0), 0);
  assert.equal(totalA, 2);
  // rule series: real rules ascending, then -1, null, then rejects last.
  assert.deepEqual(bk.ruleSeries, ["0", "-1", "null", "rejects"]);
  const rejectTotal = bk.ruleBuckets.reduce((s, b) => s + Number((b as any).rejects ?? 0), 0);
  assert.equal(rejectTotal, 1);
  // agent filter omits the rejects series (no agent attribution on rejects).
  const bkAgent = await repo.routingBreakdownBuckets(R2, { windowSec: 3600, bucketSec: 60, agentId: "agent_none" });
  assert.ok(!bkAgent.ruleSeries.includes("rejects"));
  await pool.query("DELETE FROM gateway_usage WHERE routing = $1", [R2]);
  await pool.query("DELETE FROM routing_rejects WHERE routing = $1", [R2]);
});

test("routingBreakdownBuckets: zero-fills every bucket across a time gap (fix wave H reviewer finding)", async () => {
  const R3 = `${R}-gap`;
  // Two data points 20 minutes apart, well within a 1h window/60s buckets,
  // so there are many empty buckets in between that must still appear,
  // zero-filled for every series key (unlike the old data-bearing-only payload).
  await pool.query(
    `INSERT INTO gateway_usage (workspace_id, model, tokens_in, tokens_out, source, routing, routing_rule, created_at)
     VALUES ('wrkspc_default','m-a',1,1,'api',$1,0, now() - interval '20 minutes'),
            ('wrkspc_default','m-b',1,1,'api',$1,-1, now())`, [R3]);
  const bk = await repo.routingBreakdownBuckets(R3, { windowSec: 3600, bucketSec: 60 });
  const oldT = Math.floor((Date.now() / 1000 - 20 * 60) / 60) * 60;
  const newT = Math.floor(Date.now() / 1000 / 60) * 60;
  // Contiguous coverage: no gaps in the t sequence, exactly one bucket per bucketSec.
  for (let i = 1; i < bk.targetBuckets.length; i++) {
    assert.equal(bk.targetBuckets[i].t - bk.targetBuckets[i - 1].t, 60);
  }
  // A bucket strictly between the two data points exists and is zero across all series.
  const midT = oldT + 10 * 60;
  const midBucket = bk.targetBuckets.find((b) => b.t === midT);
  assert.ok(midBucket, "expected a zero-filled bucket between the two data points");
  for (const key of bk.targetSeries) assert.equal((midBucket as any)[key], 0);
  const midRuleBucket = bk.ruleBuckets.find((b) => b.t === midT);
  assert.ok(midRuleBucket, "expected a zero-filled rule bucket between the two data points");
  for (const key of bk.ruleSeries) assert.equal((midRuleBucket as any)[key], 0);
  // The data-bearing buckets themselves still carry the right values.
  const oldBucket = bk.targetBuckets.find((b) => b.t === oldT);
  const newBucket = bk.targetBuckets.find((b) => b.t === newT);
  assert.equal((oldBucket as any)["m-a"], 1);
  assert.equal((newBucket as any)["m-b"], 1);
  await pool.query("DELETE FROM gateway_usage WHERE routing = $1", [R3]);
});
