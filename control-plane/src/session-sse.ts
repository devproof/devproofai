// control-plane/src/session-sse.ts
// SSE poll-follow loop shared by GET /v1/sessions/:id/events?stream=1 and
// POST /api/sessions/:id/events/stream (extracted 2026-07-12).
export async function streamSessionEvents(
  req: any, reply: any, repo: any,
  notify: { subscribe(sessionId: string, fn: () => void): () => void } | undefined,
  id: string, after: number,
) {
  // SSE: poll-follow until the session is terminal.
  // Content-Encoding: identity keeps intermediary compressors (Next's proxy
  // gzips for browsers) from buffering the stream indefinitely.
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Content-Encoding": "identity",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  let seq = after;
  let open = true;
  req.raw.on("close", () => { open = false; wake(); });

  // Push-based: wake on NOTIFY (or a 5 s safety heartbeat) instead of a
  // 1 s busy-poll — one query per real event, not per second per viewer.
  let wake: () => void = () => {};
  let pending = false;
  const unsub = notify?.subscribe(id, () => { pending = true; wake(); }) ?? (() => {});
  let lastStatus = "";
  let lastTokens = "";
  let lastModel = "";
  let terminal = false;
  try {
    while (open) {
      pending = false;
      const events = await repo.listEvents(id, seq);
      for (const e of events) {
        seq = e.seq;
        reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
      }
      const s = await repo.getSession(id);
      if (!s) { terminal = true; break; }
      // Re-send on token movement too (trigger-driven live totals, spec
      // 2026-07-13) — not just on status flips.
      const tokens = `${Number(s.tokens_in ?? 0)}/${Number(s.tokens_out ?? 0)}/${Number(s.billed_cost ?? 0)}`;
      // last_model rides the same tick (fix wave H): the accumulate trigger
      // sets it alongside tokens, so a resolved-model change moves with tokens.
      const model = s.last_model ?? "";
      if (s.status !== lastStatus || tokens !== lastTokens || model !== lastModel) {
        lastStatus = s.status;
        lastTokens = tokens;
        lastModel = model;
        reply.raw.write(`event: status\ndata: ${JSON.stringify({
          status: s.status,
          tokens_in: Number(s.tokens_in ?? 0), tokens_out: Number(s.tokens_out ?? 0),
          billed_cost: Number(s.billed_cost ?? 0),
          turns: Number(s.turns ?? 0),
          last_model: s.last_model ?? null,
        })}\n\n`);
      }
      // Terminal ONLY on completed/failed — idle sessions stay subscribed so
      // resumes from other tabs/API calls appear without a refresh (spec §1).
      if (["completed", "failed"].includes(s.status)) { terminal = true; break; }
      if (pending) continue;  // NOTIFY landed while we were processing — re-check now
      reply.raw.write(": ka\n\n"); // keep-alive comment — defeats idle proxy timeouts
      const heartbeat = s.status === "idle" ? 15000 : 5000;
      await new Promise<void>((r) => { wake = r; setTimeout(r, heartbeat); });
    }
  } finally {
    unsub();
  }
  // `end` means "session over" to the client (it stops reconnecting), so it
  // is only sent on genuine terminal state — a loop error just closes the
  // connection and the client's EventSource retry picks up where it left off.
  if (terminal) reply.raw.write("event: end\ndata: {}\n\n");
  reply.raw.end();
  return reply;
}
