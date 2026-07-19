// `npm test` = the suite, then the test-workspace sweep.
//
// The sweep runs even when the suite is RED — a failed run leaks throwaway
// workspaces exactly like a passing one — but it must never decide the exit
// code, or a broken sweep would report a red suite as green (and vice versa).
// The suite's status is the only thing we exit with.
//
// Why a script and not `a && b` / `a ; b` in package.json: npm runs scripts
// through cmd.exe on Windows and sh elsewhere, and neither chain preserves the
// FIRST command's exit code portably.
//
// --test-concurrency=1 is deliberate — see CLAUDE.md. The 45 test files share
// one dev database; parallel files deadlock on migrate()'s DDL and race the
// app_settings singleton.
import { spawnSync } from "node:child_process";

const patterns = process.argv.slice(2);
const suite = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=1", ...(patterns.length ? patterns : ["test/*.test.ts"])],
  { stdio: "inherit" },
);

const sweep = spawnSync(process.execPath, ["--import", "tsx", "scripts/sweep-workspaces.ts"], { stdio: "inherit" });
if (sweep.status !== 0) console.error("workspace-sweep: failed — test result below is unaffected");

process.exit(suite.status ?? 1);
