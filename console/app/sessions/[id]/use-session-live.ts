"use client";
// One owner for all mutable session state (spec §2): events, status, totals.
// The SSE stream stays open through idle so resumes from anywhere appear live.
import { useEffect, useRef, useState } from "react";

export interface LiveEvent { seq: number; type: string; payload: any;
  tokens_in: number; tokens_out: number; duration_ms: number; created_at: string; }
export interface Totals { tokensIn: number; tokensOut: number; billedCost: number; turns: number;
  lastModel: string | null; }

const TERMINAL = ["completed", "failed"];

export function useSessionLive(id: string, initial: { events: LiveEvent[]; status: string; totals: Totals }) {
  const [events, setEvents] = useState<LiveEvent[]>(initial.events);
  const [status, setStatus] = useState(initial.status);
  const [totals, setTotals] = useState<Totals>(initial.totals);
  const seqRef = useRef(initial.events.at(-1)?.seq ?? 0);
  const statusRef = useRef(initial.status);
  useEffect(() => { statusRef.current = status; }, [status]);

  useEffect(() => {
    if (TERMINAL.includes(initial.status)) return;
    let es: EventSource | null = null;
    let closed = false;
    const connect = () => {
      if (closed) return;
      es = new EventSource(`/api/v1/sessions/${id}/events?stream=1&after=${seqRef.current}`);
      es.onmessage = (m) => {
        const e = JSON.parse(m.data) as LiveEvent;
        if (e.seq <= seqRef.current) return;               // reconnect duplicates
        seqRef.current = e.seq;
        setEvents((prev) => [...prev, e]);
      };
      es.addEventListener("status", (m) => {
        const s = JSON.parse((m as MessageEvent).data);
        setStatus(s.status);
        setTotals({ tokensIn: s.tokens_in, tokensOut: s.tokens_out,
                    billedCost: Number(s.billed_cost ?? 0), turns: s.turns,
                    lastModel: s.last_model ?? null });
      });
      es.addEventListener("end", () => { closed = true; es?.close(); });
      es.onerror = () => {                                  // recreate with the latest seq
        es?.close();
        if (!closed && !TERMINAL.includes(statusRef.current)) setTimeout(connect, 1500);
      };
    };
    connect();
    return () => { closed = true; es?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const live = !TERMINAL.includes(status) && status !== "idle";
  return { events, status, totals, live, setStatus };
}
