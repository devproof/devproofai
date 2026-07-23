"use client";
// One owner for all mutable session state (spec §2): events, status, totals.
// The SSE stream stays open through idle AND failed (both are resumable —
// the composer shows on failed) so resumes from anywhere appear live; only
// completed is stream-terminal.
import { useEffect, useRef, useState } from "react";

export interface LiveEvent { seq: number; type: string; payload: any;
  tokens_in: number; tokens_out: number; duration_ms: number; created_at: string; }
export interface Totals { tokensIn: number; tokensOut: number; billedCost: number; turns: number;
  lastModel: string | null; }

const TERMINAL = ["completed"]; // stream-terminal only; "failed" keeps streaming (resumable)

export function useSessionLive(id: string, initial: { events: LiveEvent[]; status: string; totals: Totals }) {
  const [events, setEvents] = useState<LiveEvent[]>(initial.events);
  const [status, setStatus] = useState(initial.status);
  const [totals, setTotals] = useState<Totals>(initial.totals);
  // Serving target's model_routing state ('ready'|'waking'|'idle'; null =
  // external/unknown). Drives the "model deploying / scaling up" label.
  const [modelState, setModelState] = useState<string | null>(null);
  const seqRef = useRef(initial.events.at(-1)?.seq ?? 0);
  const statusRef = useRef(initial.status);
  useEffect(() => { statusRef.current = status; }, [status]);

  useEffect(() => {
    if (TERMINAL.includes(initial.status)) return;
    let es: EventSource | null = null;
    let closed = false;
    let lastBeat = Date.now();
    const connect = () => {
      if (closed) return;
      es?.close();                                          // at most one stream
      lastBeat = Date.now();
      es = new EventSource(`/api/v1/sessions/${id}/events?stream=1&after=${seqRef.current}`);
      es.onmessage = (m) => {
        lastBeat = Date.now();
        const e = JSON.parse(m.data) as LiveEvent;
        if (e.seq <= seqRef.current) return;               // reconnect duplicates
        seqRef.current = e.seq;
        setEvents((prev) => [...prev, e]);
      };
      es.addEventListener("status", (m) => {
        lastBeat = Date.now();
        const s = JSON.parse((m as MessageEvent).data);
        setStatus(s.status);
        setTotals({ tokensIn: s.tokens_in, tokensOut: s.tokens_out,
                    billedCost: Number(s.billed_cost ?? 0), turns: s.turns,
                    lastModel: s.last_model ?? null });
        if ("model_state" in s) setModelState(s.model_state ?? null);
      });
      // Server heartbeat (≤15s cadence). It carries the current status, so
      // client state that diverged from the server (optimistic writes, a
      // missed status frame) reconciles within one beat.
      es.addEventListener("ping", (m) => {
        lastBeat = Date.now();
        const p = JSON.parse((m as MessageEvent).data);
        if (p.status) setStatus(p.status);
        if ("model_state" in p) setModelState(p.model_state ?? null);
      });
      es.addEventListener("end", () => { closed = true; es?.close(); });
      es.onerror = () => {                                  // recreate with the latest seq
        es?.close();
        if (!closed && !TERMINAL.includes(statusRef.current)) setTimeout(connect, 1500);
      };
    };
    connect();
    // Watchdog: a silently dead connection (wedged upstream query, proxy
    // stall) never fires onerror — force a reconnect when the beat goes
    // quiet. Every fresh connection gets an immediate status frame, so any
    // stuck state self-heals on reconnect.
    const dog = setInterval(() => {
      if (!closed && Date.now() - lastBeat > 45_000) connect();
    }, 15_000);
    return () => { closed = true; clearInterval(dog); es?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // live = a turn is in flight; failed is not TERMINAL for the stream but is
  // still a resting state — no activity row, no Interrupt.
  const live = !["completed", "failed", "idle"].includes(status);

  // Optimistic "queued" after a successful send POST — the route flips the
  // session to queued before responding, so the write is truthful unless the
  // new turn's own status frame already landed. Resting states (idle/failed —
  // e.g. the interrupt that preceded this send) and the sender's pre-POST
  // snapshot are safe to overwrite; a rare miss (a fast turn already resting
  // again) reconciles at the next ping beat.
  const markQueued = (before: string) =>
    setStatus((s) => (["idle", "failed", before].includes(s) ? "queued" : s));

  return { events, status, totals, live, markQueued, modelState };
}
