// Pure logic of the orphaned-k8s maintenance sweep (spec 2026-07-24 G3).
// The k8s glue in sweepOrphanedK8s is thin (list → filter → delete) and is
// verified live; everything decision-making is tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { orphanCandidates, orphanPvcNames } from "../src/orchestrator.ts";

const NOW = () => new Date("2026-07-24T12:00:00Z");
const OLD = "2026-07-24T10:00:00Z"; // 2h ago — past the 1h grace
const YOUNG = "2026-07-24T11:30:00Z"; // 30min ago — inside grace
const H = 3_600_000;

test("orphanCandidates: strict id-shape match, expected-set survival, grace", () => {
  const items = [
    { name: "devproof-vault-vlt-abc123def456", creationTimestamp: OLD },  // orphan, new-style id
    { name: "devproof-vault-0123456789abcdef01234567", creationTimestamp: OLD }, // orphan, legacy hex
    { name: "devproof-vault-vlt-live00000001", creationTimestamp: OLD },  // live — in ownerIds
    { name: "devproof-vault-vlt-young0000001", creationTimestamp: YOUNG }, // orphan but young — grace keeps it
    { name: "devproof-vault-vlt-noage0000001" },                           // no creationTimestamp — keep (fail-safe)
    { name: "devproof-vault-registry-auth", creationTimestamp: OLD },      // chart-ish name — not id-shaped
    { name: "some-other-secret", creationTimestamp: OLD },                 // wrong prefix
  ];
  const got = orphanCandidates(items, "devproof-vault-", ["vlt_live00000001"], H, NOW);
  assert.deepEqual(got.sort(), [
    "devproof-vault-0123456789abcdef01234567",
    "devproof-vault-vlt-abc123def456",
  ]);
});

test("orphanCandidates: env NetworkPolicy double-prefix shape", () => {
  const items = [
    { name: "env-env-abc123def456", creationTimestamp: OLD },  // orphan (rendered env_abc123def456)
    { name: "env-env-live00000002", creationTimestamp: OLD },  // live
    { name: "env-gateway-lockdown", creationTimestamp: OLD },  // operator-added policy — not id-shaped
  ];
  assert.deepEqual(
    orphanCandidates(items, "env-", ["env_live00000002"], H, NOW),
    ["env-env-abc123def456"]);
});

test("orphanPvcNames: label-driven, session row wins, grace + missing label fail-safe", () => {
  const items = [
    { name: "sesn-dead00000001-work", creationTimestamp: OLD, sessionLabel: "sesn_dead00000001" },  // orphan
    { name: "sesn-live00000001-work", creationTimestamp: OLD, sessionLabel: "sesn_live00000001" },  // live session
    { name: "sesn-young0000001-work", creationTimestamp: YOUNG, sessionLabel: "sesn_young0000001" }, // young
    { name: "sesn-nolabel000001-work", creationTimestamp: OLD },                                     // no label — keep
  ];
  assert.deepEqual(
    orphanPvcNames(items, ["sesn_live00000001"], H, NOW),
    ["sesn-dead00000001-work"]);
});
