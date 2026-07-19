import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkspaceDelete, sweepDeletingWorkspaces } from "../src/workspace-delete.ts";

// In-memory workspace with one of everything. Tables map id -> row.
function fixtures() {
  const ws = "wrkspc_t";
  const calls: string[] = [];
  const tables: Record<string, Map<string, any>> = {
    sessions: new Map([["sesn_1", {}], ["sesn_2", {}]]),
    skills: new Map([["skill_1", {}]]),
    memory_stores: new Map([["memstore_1", {}]]),
    wikis: new Map([["wiki_1", {}]]),
    files: new Map([["file_abc123def456", {}], ["file_" + "a".repeat(64), {}]]), // new-format + legacy
    environments: new Map([["env_1", {}]]),
    vaults: new Map([["vlt_1", {}]]),
    agents: new Map([["agent_1", {}]]),
    webhooks: new Map([["whk_1", {}]]),
    file_uploads: new Map([["uplj_1", { id: "uplj_1", upload_key: "k", file_id: "file_up1" }]]),
  };
  let status = "deleting";
  const repo = {
    async workspaceRowIds(table: string, _ws: string, limit = 100) {
      return [...tables[table].keys()].slice(0, limit);
    },
    async deleteSession(_ws: string, id: string) { calls.push(`deleteSession:${id}`); tables.sessions.delete(id); return ["file_abc123def456"]; },
    async deleteSkill(_ws: string, id: string) { calls.push(`deleteSkill:${id}`); tables.skills.delete(id); return []; },
    async deleteMemoryStore(_ws: string, id: string) { calls.push(`deleteMemoryStore:${id}`); tables.memory_stores.delete(id); return []; },
    async deleteWiki(_ws: string, id: string) { calls.push(`deleteWiki:${id}`); tables.wikis.delete(id); return []; },
    // Legacy content-addressed rows (pre-033) carry an empty object_key
    // (migration default) — the real deleteFileRecordById returns it as-is,
    // and the caller's `if (key)` naturally skips deleting a falsy key; mirror
    // that here instead of a separate regex guard.
    async deleteFile(_ws: string, id: string) {
      calls.push(`deleteFile:${id}`); tables.files.delete(id);
      return { deleted: true, objectKey: /^file_[a-z0-9]{12}$/.test(id) ? id : null };
    },
    async deleteEnvironment(_ws: string, id: string) { calls.push(`deleteEnvironment:${id}`); tables.environments.delete(id); },
    async deleteVault(_ws: string, id: string) { calls.push(`deleteVault:${id}`); tables.vaults.delete(id); },
    async deleteAgent(_ws: string, id: string) { calls.push(`deleteAgent:${id}`); tables.agents.delete(id); },
    async deleteWorkspaceWebhooks(_ws: string) { calls.push("deleteWebhooks"); tables.webhooks.clear(); },
    async softDeleteWorkspaceApiKeys(_ws: string) { calls.push("softDeleteKeys"); },
    async listWorkspaceFileUploads(_ws: string) { return [...tables.file_uploads.values()]; },
    async deleteFileUpload(id: string) { calls.push(`deleteFileUpload:${id}`); tables.file_uploads.delete(id); },
    async setWorkspaceStatus(_id: string, s: string) { calls.push(`status:${s}`); status = s; return true; },
    async listWorkspaces(_all: boolean) { return [{ id: ws, status }]; },
    async workspaceResourceCounts(_id: string) {
      return { ...Object.fromEntries(Object.entries(tables).map(([k, t]) => [k, t.size])), api_keys: 0 };
    },
  };
  const orchestrator = {
    async stopSession(id: string) { calls.push(`stopSession:${id}`); },
    async deleteSessionResources(id: string) { calls.push(`deletePvc:${id}`); },
    async deleteEnvironmentResources(id: string) { calls.push(`deleteEgress:${id}`); },
    async deleteVaultSecret(id: string) { calls.push(`deleteSecret:${id}`); },
  } as any;
  const files = {
    async del(id: string) { calls.push(`s3del:${id}`); },
    async abortUpload(fileId: string, key: string) { calls.push(`abort:${fileId}:${key}`); },
  } as any;
  return { ws, repo, orchestrator, files, calls, tables, get status() { return status; } };
}

test("drains everything in FK order and tombstones the row", async () => {
  const f = fixtures();
  await runWorkspaceDelete(f.repo, f.orchestrator, f.files, f.ws);

  // All tables empty; workspace tombstoned.
  for (const [name, t] of Object.entries(f.tables)) assert.equal(t.size, 0, `${name} drained`);
  assert.equal(f.status, "deleted");

  // Sessions: pods stopped + PVCs deleted before the row goes.
  assert.ok(f.calls.indexOf("stopSession:sesn_1") < f.calls.indexOf("deleteSession:sesn_1"));
  assert.ok(f.calls.indexOf("deletePvc:sesn_1") < f.calls.indexOf("deleteSession:sesn_1"));
  // FK order: skills and memory stores drain before files.
  assert.ok(f.calls.indexOf("deleteSkill:skill_1") < f.calls.indexOf("deleteFile:file_abc123def456"));
  assert.ok(f.calls.indexOf("deleteMemoryStore:memstore_1") < f.calls.indexOf("deleteFile:file_abc123def456"));
  // Sessions before agents (agents→sessions is CASCADE; must not skip k8s cleanup).
  assert.ok(f.calls.indexOf("deleteSession:sesn_2") < f.calls.indexOf("deleteAgent:agent_1"));
  // K8s teardown per env/vault.
  assert.ok(f.calls.includes("deleteEgress:env_1"));
  assert.ok(f.calls.includes("deleteSecret:vlt_1"));
  // Keys soft-deleted; uploads aborted; tombstone LAST.
  assert.ok(f.calls.includes("softDeleteKeys"));
  assert.ok(f.calls.includes(`abort:${f.ws}/files/file_up1:k`));
  assert.equal(f.calls.at(-1), "status:deleted");

  // S3 objects: new-format ids deleted, legacy content-addressed ids leaked
  // (may be shared across workspaces from the dedup era).
  assert.ok(f.calls.includes("s3del:file_abc123def456"));
  assert.ok(!f.calls.some((c) => c === "s3del:file_" + "a".repeat(64)));
});

test("idempotent: a second run over a drained workspace is a no-op + tombstone", async () => {
  const f = fixtures();
  await runWorkspaceDelete(f.repo, f.orchestrator, f.files, f.ws);
  const before = f.calls.length;
  await runWorkspaceDelete(f.repo, f.orchestrator, f.files, f.ws);
  // Second run: only the constant-cost steps (webhooks, keys, tombstone) repeat.
  assert.ok(f.calls.length - before <= 4);
  assert.equal(f.status, "deleted");
});

test("s3 delete failure does not abort the drain", async () => {
  const f = fixtures();
  f.files.del = async () => { throw new Error("minio down"); };
  await runWorkspaceDelete(f.repo, f.orchestrator, f.files, f.ws);
  assert.equal(f.status, "deleted");
});

test("re-drains a late-inserted row before tombstoning, and tombstones exactly once", async () => {
  const f = fixtures();
  // Simulate a write landing in the guard-cache TTL window (or a launch-gate
  // release) after the first sessions drain pass already finished: the first
  // workspaceResourceCounts check reports a live session while the tables are
  // otherwise already drained, and injects the late row so the second pass's
  // (unmodified) workspaceRowIds/deleteSession genuinely finds and drains it.
  let countCalls = 0;
  const origCounts = f.repo.workspaceResourceCounts.bind(f.repo);
  (f.repo as any).workspaceResourceCounts = async (id: string) => {
    countCalls++;
    if (countCalls === 1) {
      f.tables.sessions.set("sesn_late", {});
      return { sessions: 1, skills: 0, memory_stores: 0, files: 0, environments: 0, vaults: 0, agents: 0, webhooks: 0, file_uploads: 0, api_keys: 0 };
    }
    return origCounts(id);
  };
  await runWorkspaceDelete(f.repo, f.orchestrator, f.files, f.ws);
  assert.ok(f.calls.includes("deleteSession:sesn_late"), "late session drained on the second pass");
  assert.equal(f.calls.filter((c) => c === "status:deleted").length, 1, "tombstoned exactly once");
  assert.equal(f.status, "deleted");
  assert.equal(f.tables.sessions.size, 0);
});

test("sweep resumes 'deleting' workspaces only", async () => {
  const f = fixtures();
  await sweepDeletingWorkspaces(f.repo, f.orchestrator, f.files);
  assert.equal(f.status, "deleted"); // was 'deleting' → drained
  const g = fixtures();
  (g.repo as any).listWorkspaces = async () => [{ id: g.ws, status: "active" }];
  await sweepDeletingWorkspaces(g.repo, g.orchestrator, g.files);
  assert.equal(g.tables.sessions.size, 2); // untouched
});
