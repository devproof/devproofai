// Test-workspace sweep: the suite runs against the SHARED dev Postgres and most
// test files create throwaway workspaces without deleting them. Historically
// they leaked — ~2000 junk rows had accumulated before the first purge.
//
// This runs AFTER the suite (see scripts/run-tests.mjs), so every workspace it
// can see belongs to a run that has already finished and no age guard is
// needed: a run now cleans up its own mess. Running it by hand is fine too:
//
//   node --import tsx scripts/sweep-workspaces.ts
//
// Test authors: name throwaway workspaces `t-<tag>-${Date.now()}` (or add your
// prefix to TEST_WS_PATTERN below). Never use a prefix a human would pick for a
// real workspace — the sweep hard-deletes whatever matches.
import { createPool } from "../src/db.ts";

const TEST_WS_PATTERN = "^(t-|wsu-|src-|resurrect-|res-ws-|resume-ws-|ext-ws-)";

const pool = createPool();
try {
  await pool.query("SELECT 1");
} catch {
  // No dev database — the suite skipped its DB tests too, so there is nothing
  // to sweep and nothing to complain about.
  console.log("workspace-sweep: no database, skipped");
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(
    `CREATE TEMP TABLE doomed ON COMMIT DROP AS
     SELECT id FROM workspaces
     WHERE id <> 'wrkspc_default'
       AND name ~ $1`, [TEST_WS_PATTERN]);
  // FK order (workspace FKs are NO ACTION — children first; agents cascade
  // versions/sessions-adjacent rows, vaults cascade credentials, memory_stores
  // cascade entries, file_uploads cascade from workspaces).
  const IN = "IN (SELECT id FROM doomed)";
  const SESS = `IN (SELECT id FROM sessions WHERE workspace_id ${IN})`;
  for (const sql of [
    `DELETE FROM pending_launches WHERE session_id ${SESS}`,
    `DELETE FROM session_files WHERE session_id ${SESS}`,
    `DELETE FROM session_events WHERE workspace_id ${IN} OR session_id ${SESS}`,
    `DELETE FROM sessions WHERE workspace_id ${IN}`,
    `DELETE FROM agents WHERE workspace_id ${IN}`,
    `DELETE FROM gateway_usage WHERE workspace_id ${IN}`,
    `DELETE FROM cost_entries WHERE workspace_id ${IN}`,
    `DELETE FROM api_keys WHERE workspace_id ${IN}`,
    // Skills and memory stores BEFORE files: skills.file_id and
    // memory_entries.file_id are RESTRICT (migrations 005/006), so deleting
    // files first violates them. Entry rows cascade with their store; the file
    // rows they referenced then fall to the files delete below. Same order the
    // real drain uses (workspace-delete.ts).
    `DELETE FROM skills WHERE workspace_id ${IN}`,
    `DELETE FROM memory_stores WHERE workspace_id ${IN}`,
    `DELETE FROM files WHERE workspace_id ${IN}`,
    `DELETE FROM environments WHERE workspace_id ${IN}`,
    `DELETE FROM vaults WHERE workspace_id ${IN}`,
    `DELETE FROM webhooks WHERE workspace_id ${IN}`,
    `DELETE FROM file_uploads WHERE workspace_id ${IN}`,
    // price rows of environments that just went away (advisory, kind-scoped)
    `DELETE FROM resource_prices WHERE kind = 'environment' AND ref NOT IN (SELECT id FROM environments)`,
  ]) await client.query(sql);
  // Test rows written into wrkspc_default itself (the sweep above never touches
  // that workspace): repo.test.ts's deploymentStats fixture uses dep-stats-<ts>
  // model names.
  await client.query(`DELETE FROM gateway_usage WHERE model LIKE 'dep-stats-%'`);
  const { rowCount } = await client.query(`DELETE FROM workspaces WHERE id ${IN}`);
  await client.query("COMMIT");
  console.log(`workspace-sweep: removed ${rowCount ?? 0} test workspace(s)`);
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  throw err;
} finally {
  client.release();
}

// The sweep must never touch real workspaces: the default one survives.
const { rows } = await pool.query("SELECT 1 FROM workspaces WHERE id = 'wrkspc_default'");
await pool.end();
if (!rows.length) {
  console.error("workspace-sweep: FAILED — the default workspace is gone");
  process.exit(1);
}

// S3 objects behind the deleted file rows are not touched here; the GC sweep
// (src/gc.ts) reclaims orphaned objects.
