// control-plane/test/wikis.test.ts
// LLM wiki repo + validation tests against the live dev Postgres (skipped when
// unreachable). Throwaway workspaces use the `t-wiki-` prefix, swept by
// run-tests.mjs after the suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";
import { validateWikiRefs, hasWriteRef, resolveWikiMounts } from "../src/wiki-refs.ts";
import { releaseWriterQueue } from "../src/writer-queue.ts";
import { seedWikiSkeleton } from "../src/wiki-seed.ts";
import { localFileStore } from "../src/filestore.ts";
import { registerAgentRoutes } from "../src/agents-api.ts";

const pool = createPool();
let available = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { available = false; }

const fid = () => `file_${Math.random().toString(36).slice(2, 14).padEnd(12, "0")}`;

test("wiki CRUD + entries diff + delete returns file ids", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-wiki-${Date.now()}`)).id;
  const wiki = await repo.createWiki(ws, `t-wiki-${Date.now()}`, "desc");
  const got = await repo.getWiki(wiki.id, ws);
  assert.equal(got.description, "desc");

  // description edit
  const upd = await repo.updateWiki(ws, wiki.id, { description: "new desc" });
  assert.equal(upd.description, "new desc");

  // two files, then a diff upsert that orphans the first
  const f1 = fid(), f2 = fid();
  await repo.createFileRecord({ id: f1, name: "wiki/index.md", size: 1, sha256: "a", objectKey: `${ws}/wiki/${wiki.id}/index.md`, kind: "wiki", workspaceId: ws });
  await repo.upsertWikiEntries(wiki.id, [{ path: "index.md", fileId: f1 }]);
  await repo.createFileRecord({ id: f2, name: "wiki/index.md", size: 2, sha256: "b", objectKey: `${ws}/wiki/${wiki.id}/index.md`, kind: "wiki", workspaceId: ws });
  const orphaned = await repo.upsertWikiEntries(wiki.id, [{ path: "index.md", fileId: f2 }]);
  assert.deepEqual(orphaned, [f1]); // replaced file id returned for cleanup

  const entries = await repo.getWikiEntries(wiki.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].file_id, f2);

  const ids = await repo.deleteWiki(ws, wiki.id);
  assert.deepEqual(ids, [f2]); // remaining entry file id returned
  assert.equal(await repo.getWiki(wiki.id, ws), null);
});

test("seedWikiSkeleton creates index.md + log.md at wiki creation", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-wiki-${Date.now()}`)).id;
  const root = mkdtempSync(join(tmpdir(), "wiki-seed-"));
  const files = localFileStore(root);
  try {
    const wiki = await repo.createWiki(ws, `t-wiki-seed-${Date.now()}`, "Test knowledge base");
    await seedWikiSkeleton(repo, files, ws, wiki.id, wiki.name, "Test knowledge base");

    // Exactly the two structural files, as wiki entries.
    const entries = await repo.getWikiEntries(wiki.id);
    assert.deepEqual(entries.map((e: any) => e.path).sort(), ["index.md", "log.md"]);

    // index.md: title + description + explicit empty-state line (no frontmatter —
    // the runner's WIKI_STRUCTURE reserves frontmatter for entity pages).
    const idx = entries.find((e: any) => e.path === "index.md");
    const idxRec = await repo.getFileRecord(idx.file_id);
    assert.equal(idxRec.object_key, `${ws}/wiki/${wiki.id}/index.md`);
    assert.equal(idxRec.kind, "wiki");
    const idxText = (await files.get(idxRec.object_key)).toString();
    assert.ok(idxText.startsWith(`# ${wiki.name}\n`), "index titled with wiki name");
    assert.ok(idxText.includes("Test knowledge base"), "index carries the description");
    assert.ok(idxText.includes("No pages yet"), "index has an explicit empty state");
    assert.ok(!idxText.startsWith("---"), "index has no frontmatter");

    // log.md: newest-first ISO-8601-dated genesis entry.
    const log = entries.find((e: any) => e.path === "log.md");
    const logRec = await repo.getFileRecord(log.file_id);
    const logText = (await files.get(logRec.object_key)).toString();
    assert.match(logText, /^# Log\n/);
    assert.match(logText, /\d{4}-\d{2}-\d{2}: wiki created/);

    // A description-less wiki still seeds a well-formed index.
    const bare = await repo.createWiki(ws, `t-wiki-seed-b-${Date.now()}`);
    await seedWikiSkeleton(repo, files, ws, bare.id, bare.name, "");
    const bareIdx = (await repo.getWikiEntries(bare.id)).find((e: any) => e.path === "index.md");
    const bareText = (await files.get((await repo.getFileRecord(bareIdx.file_id)).object_key)).toString();
    assert.ok(bareText.startsWith(`# ${bare.name}\n`));
    assert.ok(!bareText.includes("\n\n\n"), "no blank gap where the description would be");

    for (const id of [...(await repo.deleteWiki(ws, wiki.id)), ...(await repo.deleteWiki(ws, bare.id))]) {
      await repo.deleteFileRecordById(id);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /v1/wikis seeds the skeleton through the real route", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const wsId = (await repo.createWorkspace(`t-wiki-${Date.now()}`)).id;
  const root = mkdtempSync(join(tmpdir(), "wiki-route-"));
  const files = localFileStore(root);
  const app = Fastify();
  // Wiki routes never touch the orchestrator; a bare stub is enough.
  await registerAgentRoutes(app, repo, {} as any, files);
  const hdrs = { "x-devproof-workspace": wsId, "content-type": "application/json" };
  let wikiId: string | null = null;
  try {
    const res = await app.inject({
      method: "POST", url: "/v1/wikis", headers: hdrs,
      payload: { name: `t-wiki-route-${Date.now()}`, description: "Routed" },
    });
    assert.equal(res.statusCode, 201);
    wikiId = res.json().id;

    const tree = await app.inject({ method: "GET", url: `/v1/wikis/${wikiId}/tree`, headers: hdrs });
    assert.deepEqual(tree.json().entries.map((e: any) => e.path).sort(), ["index.md", "log.md"]);

    const content = await app.inject({ method: "GET", url: `/v1/wikis/${wikiId}/content?path=index.md`, headers: hdrs });
    assert.equal(content.statusCode, 200);
    assert.ok(content.body.includes("No pages yet"));
  } finally {
    if (wikiId) for (const id of await repo.deleteWiki(wsId, wikiId)) await repo.deleteFileRecordById(id);
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateWikiRefs enforces one writer per wiki", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-wiki-${Date.now()}`)).id;
  const wiki = await repo.createWiki(ws, `t-wiki-w-${Date.now()}`);

  // unknown wiki id → 400
  assert.equal((await validateWikiRefs(repo, ws, null, [{ wikiId: "wiki_nope", mode: "read" }]))?.code, 400);
  // bad mode → 400
  assert.equal((await validateWikiRefs(repo, ws, null, [{ wikiId: wiki.id, mode: "rw" }]))?.code, 400);
  // valid read/write → null
  assert.equal(await validateWikiRefs(repo, ws, null, [{ wikiId: wiki.id, mode: "read" }]), null);
  assert.equal(await validateWikiRefs(repo, ws, null, [{ wikiId: wiki.id, mode: "write" }]), null);

  // agentA claims write; agentB then can't
  const a = await repo.createAgent(ws, `t-wiki-a-${Date.now()}`, { routing: "r", wikiRefs: [{ wikiId: wiki.id, mode: "write" }] });
  const conflict = await validateWikiRefs(repo, ws, null, [{ wikiId: wiki.id, mode: "write" }]);
  assert.equal(conflict?.code, 409);
  // agentA re-saving its own write ref is allowed (exclude self)
  assert.equal(await validateWikiRefs(repo, ws, a.id, [{ wikiId: wiki.id, mode: "write" }]), null);
  // a second reader is always fine
  assert.equal(await validateWikiRefs(repo, ws, null, [{ wikiId: wiki.id, mode: "read" }]), null);

  assert.equal(await repo.wikiInUse(wiki.id), true); // referenced → delete blocked at API
  await repo.deleteAgent(ws, a.id);
});

test("hasWriteRef + agentHasActiveSession drive the single-session writer lock", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-wiki-${Date.now()}`)).id;
  const wiki = await repo.createWiki(ws, `t-wiki-lock-${Date.now()}`);
  const agent = await repo.createAgent(ws, `t-wiki-la-${Date.now()}`, { routing: "r", wikiRefs: [{ wikiId: wiki.id, mode: "write" }] });
  const v = await repo.getAgentVersion(agent.id);
  assert.equal(hasWriteRef(v.wiki_refs), true);

  const s1 = await repo.createSession(ws, agent.id, "hi"); // queued
  assert.equal(await repo.agentHasActiveSession(agent.id), true);
  assert.equal(await repo.agentHasActiveSession(agent.id, s1.id), false); // excluding self

  await repo.deleteSession(ws, s1.id);
  await repo.deleteAgent(ws, agent.id);
});

test("writer-slot queue: slot held while active, released FIFO, one at a time", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-wiki-${Date.now()}`)).id;
  const wiki = await repo.createWiki(ws, `t-wiki-q-${Date.now()}`);
  const agent = await repo.createAgent(ws, `t-wiki-qa-${Date.now()}`, { routing: "r", wikiRefs: [{ wikiId: wiki.id, mode: "write" }] });
  const a = await repo.createSession(ws, agent.id, "A"); // holds the slot (queued)
  const b = await repo.createSession(ws, agent.id, "B");
  const c = await repo.createSession(ws, agent.id, "C");

  // A holds the slot → B/C are parked under wq:<agentId>.
  assert.equal(await repo.writerSlotHeld(agent.id, b.id), true);
  await repo.addPendingLaunch(b.id, `wq:${agent.id}`, { id: b.id });
  await repo.addPendingLaunch(c.id, `wq:${agent.id}`, { id: c.id });
  // Parked sessions don't hold the slot; A still does.
  assert.equal(await repo.writerSlotHeld(agent.id, ""), true);
  // The model sweep must ignore wq: keys; the writer sweep sees the agent.
  assert.equal((await repo.listPendingLaunchModels()).some((m) => m.startsWith("wq:")), false);
  assert.ok((await repo.listWriterQueueAgents()).includes(agent.id));
  // Slot busy → nothing released.
  assert.equal(await repo.takeNextWriterLaunch(agent.id), null);

  // A finishes → slot free → next take returns the OLDEST (B), and B now holds it.
  await repo.setSessionStatus(a.id, "idle");
  const first = await repo.takeNextWriterLaunch(agent.id);
  assert.equal((first?.payload as any)?.id, b.id);
  assert.equal(await repo.takeNextWriterLaunch(agent.id), null); // B holds the slot now

  // B finishes → C releases.
  await repo.setSessionStatus(b.id, "idle");
  const second = await repo.takeNextWriterLaunch(agent.id);
  assert.equal((second?.payload as any)?.id, c.id);
  assert.ok(!(await repo.listWriterQueueAgents()).includes(agent.id)); // this agent's queue drained

  await repo.deleteSession(ws, a.id); await repo.deleteSession(ws, b.id); await repo.deleteSession(ws, c.id);
  await repo.deleteAgent(ws, agent.id);
});

test("writer-queue release re-resolves wiki mounts (fresh fileIds, no 404)", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-wiki-${Date.now()}`)).id;
  const wiki = await repo.createWiki(ws, `t-wiki-rr-${Date.now()}`);
  const agent = await repo.createAgent(ws, `t-wiki-rra-${Date.now()}`, { routing: "r", wikiRefs: [{ wikiId: wiki.id, mode: "write" }] });
  const v = await repo.getAgentVersion(agent.id);
  const f1 = fid();
  await repo.createFileRecord({ id: f1, name: "wiki/index.md", size: 1, sha256: "a", objectKey: `${ws}/wiki/${wiki.id}/index.md`, kind: "wiki", workspaceId: ws });
  await repo.upsertWikiEntries(wiki.id, [{ path: "index.md", fileId: f1 }]);

  // A holds the slot; B parks with a payload capturing the OLD fileId f1.
  const a = await repo.createSession(ws, agent.id, "A");
  const b = await repo.createSession(ws, agent.id, "B");
  await repo.addPendingLaunch(b.id, `wq:${agent.id}`, {
    id: b.id, workspace: ws, config: v,
    wikis: [{ id: wiki.id, name: wiki.name, mode: "write", entries: [{ path: "index.md", fileId: f1 }] }],
  });

  // An earlier writer changes the wiki: f1 is replaced by f2 and deleted.
  const f2 = fid();
  await repo.createFileRecord({ id: f2, name: "wiki/index.md", size: 2, sha256: "b", objectKey: `${ws}/wiki/${wiki.id}/index.md`, kind: "wiki", workspaceId: ws });
  assert.deepEqual(await repo.upsertWikiEntries(wiki.id, [{ path: "index.md", fileId: f2 }]), [f1]);
  await repo.deleteFileRecordById(f1); // as the write-back callback would — f1 now 404s

  // A finishes → release B, capturing the payload startSession receives.
  await repo.setSessionStatus(a.id, "idle");
  let started: any = null;
  await releaseWriterQueue(repo, { async startSession(p: any) { started = p; } }, agent.id);
  assert.ok(started && started.id === b.id, "B released");
  // The mount now points at the FRESH fileId (f2), not the orphaned f1 (would 404).
  assert.deepEqual(started.wikis[0].entries, [{ path: "index.md", fileId: f2 }]);

  await repo.deleteSession(ws, a.id); await repo.deleteSession(ws, b.id);
  await repo.deleteWiki(ws, wiki.id); await repo.deleteAgent(ws, agent.id);
});

test("resolveWikiMounts returns entries and skips stale refs", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-wiki-${Date.now()}`)).id;
  const wiki = await repo.createWiki(ws, `t-wiki-m-${Date.now()}`);
  const f1 = fid();
  await repo.createFileRecord({ id: f1, name: "wiki/index.md", size: 1, sha256: "a", objectKey: `${ws}/wiki/${wiki.id}/index.md`, kind: "wiki", workspaceId: ws });
  await repo.upsertWikiEntries(wiki.id, [{ path: "index.md", fileId: f1 }]);

  const mounts = await resolveWikiMounts(repo, ws, [
    { wikiId: wiki.id, mode: "write" },
    { wikiId: "wiki_stale", mode: "read" }, // deleted → skipped
  ]);
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].mode, "write");
  assert.deepEqual(mounts[0].entries, [{ path: "index.md", fileId: f1 }]);

  await repo.deleteWiki(ws, wiki.id);
});

test("deleteSession leaves wiki files intact; orphan sweep reclaims unreferenced ones", { skip: !available }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-wiki-${Date.now()}`)).id;
  const agent = await repo.createAgent(ws, `t-wiki-da-${Date.now()}`, { routing: "r" });
  const session = await repo.createSession(ws, agent.id, "hi");
  const wiki = await repo.createWiki(ws, `t-wiki-d-${Date.now()}`);

  // wiki file uploaded via the runner write-back carries the writer session id.
  const wf = fid();
  await repo.createFileRecord({ id: wf, name: "wiki/index.md", size: 1, sha256: "w", objectKey: `${ws}/wiki/${wiki.id}/index.md`, sessionId: session.id, kind: "wiki", workspaceId: ws });
  await repo.upsertWikiEntries(wiki.id, [{ path: "index.md", fileId: wf }]);

  // Deleting the writer session must NOT sweep the wiki file (FK-referenced).
  await repo.deleteSession(ws, session.id);
  assert.ok(await repo.getFileRecord(wf), "wiki file survives session delete");
  assert.equal((await repo.getWikiEntry(wiki.id, "index.md")).file_id, wf);

  // Once its entry is gone, the orphan sweep classifies it.
  await repo.deleteWikiEntry(wiki.id, "index.md");
  await pool.query("UPDATE files SET created_at = now() - interval '2 hours' WHERE id = $1", [wf]);
  const ids = (await repo.listOrphanFileRows(3_600_000)).map((r) => r.id);
  assert.ok(ids.includes(wf), "unreferenced wiki file is orphan-swept");

  await repo.deleteFileRecordById(wf);
  await repo.deleteWiki(ws, wiki.id);
  await repo.deleteAgent(ws, agent.id);
});
