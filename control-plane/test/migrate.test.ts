// Tracked migrations (Postgrator): baseline applies once, re-run is a no-op,
// checksum tamper fails the boot (migration-consolidation spec 2026-07-19).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool, migrate } from "../src/db.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

test("baseline is applied and tracked in schema_migrations", { skip: !available }, async () => {
  // Postgrator's ensureTable() seeds a permanent version-0 sentinel row
  // ("nothing applied yet") — real migrations start at version 1.
  const versions = await pool.query("SELECT version, md5 FROM schema_migrations WHERE version > 0 ORDER BY version");
  assert.ok(versions.rows.length >= 1, "at least the baseline row");
  assert.equal(Number(versions.rows[0].version), 1);
  const t = await pool.query("SELECT to_regclass('workspaces') AS t");
  assert.ok(t.rows[0].t, "baseline created the schema");
});

test("second migrate() is a no-op", { skip: !available }, async () => {
  const before = await pool.query("SELECT count(*)::int AS n, max(version)::int AS v FROM schema_migrations");
  await migrate(pool);
  const after = await pool.query("SELECT count(*)::int AS n, max(version)::int AS v FROM schema_migrations");
  assert.deepEqual(after.rows[0], before.rows[0]);
});

test("checksum mismatch on an applied migration fails migrate()", { skip: !available }, async () => {
  const { rows: [orig] } = await pool.query("SELECT md5 FROM schema_migrations WHERE version = 1");
  await pool.query("UPDATE schema_migrations SET md5 = 'tampered' WHERE version = 1");
  try {
    await assert.rejects(() => migrate(pool), /checksum|md5/i);
  } finally {
    // Restore even on assertion failure — a wrong stored md5 would fail every later boot.
    await pool.query("UPDATE schema_migrations SET md5 = $1 WHERE version = 1", [orig.md5]);
  }
});
