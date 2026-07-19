// Writer-slot queue (spec 2026-07-18). A writer agent runs one session at a
// time so wiki writes never race; extra launch attempts park under model key
// `wq:<agentId>` (in pending_launches) and are released FIFO. Release triggers:
// (1) the snappy status/interrupt hook when a session frees the slot, (2) the
// reconciler sweep (boot + 60s) as the self-healing safety net. Both go through
// the advisory-locked takeNextWriterLaunch, so they never double-launch.
import type { Repo } from "./repo.ts";
import { resolveWikiMounts } from "./wiki-refs.ts";

type LaunchOrchestrator = { startSession(session: any): Promise<void> };

/** Release the next parked session for one writer agent (at most one). No-op if
 *  the slot is still held or the queue is empty. */
export async function releaseWriterQueue(repo: Repo, orchestrator: LaunchOrchestrator, agentId: string) {
  const next = await repo.takeNextWriterLaunch(agentId);
  if (!next) return;
  const payload = next.payload as any;
  try {
    // Re-resolve the wiki mounts (fresh fileIds). The payload was frozen at park
    // time, but an EARLIER writer session almost certainly changed the wiki while
    // this one waited — `upsertWikiEntries` deletes the orphaned old files, so the
    // parked fileIds would 404 in stage_wikis (bug 2026-07-18, sesn_oxmn4wl486d0).
    // The releasing session now holds the writer slot, so no other writer can
    // change them before it stages.
    if (payload?.config?.wiki_refs && payload?.workspace) {
      payload.wikis = await resolveWikiMounts(repo, payload.workspace, payload.config.wiki_refs);
    }
    await orchestrator.startSession(payload);
  } catch (err: any) {
    // Mirror the launch-gate: a failed deferred launch fails the session
    // (resumable), rather than leaving it stuck queued with no pod.
    console.warn(`writer-queue: deferred launch of ${next.session_id} failed:`, err);
    await repo.appendEvents(next.session_id, [{ type: "session.failed", payload: { error: `deferred launch failed: ${err?.message ?? err}` } }]);
    await repo.setSessionStatus(next.session_id, "failed");
  }
}

/** Try to release the next session for every writer agent that has a queue —
 *  the reconciler-cadence safety net (also runs once on boot). */
export async function sweepWriterQueues(repo: Repo, orchestrator: LaunchOrchestrator) {
  for (const agentId of await repo.listWriterQueueAgents()) {
    await releaseWriterQueue(repo, orchestrator, agentId)
      .catch((err) => console.warn(`writer-queue: sweep release for ${agentId} failed:`, err));
  }
}
