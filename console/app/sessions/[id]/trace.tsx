"use client";
// Composition root for the session view (spec 2026-07-09 sessions rework).
import { useEffect, useMemo, useRef, useState } from "react";
import { wsHeader } from "../../lib/client";
import { AttachFiles, type AttachedFile } from "../attach";
import { useSessionLive, type LiveEvent, type Totals } from "./use-session-live";
import { groupEvents } from "./rows";
import { SessionHeader, type PanelId } from "./header";
import { AgentPanel, EnvPanel, FilesPanel, MemoryPanel, OutputsPanel, EventPanel } from "./panels";
import { Transcript, DebugList, filterRows, type Activity, type EventFilter } from "./transcript";
import { Timeline } from "./timeline";

interface Session {
  id: string; name: string | null; status: string; prompt: string;
  agent_version: number; tokens_in: string; tokens_out: string; billed_cost: string; turns: number;
  last_model: string | null; memory_store_id: string | null; created_at: string;
}

export function SessionView({ session: s0, resources, initialEvents, cost }:
  { session: Session; resources: any; initialEvents: LiveEvent[];
    cost?: { show: boolean; currency: string } | null }) {
  const initialTotals: Totals = {
    tokensIn: Number(s0.tokens_in), tokensOut: Number(s0.tokens_out),
    billedCost: Number(s0.billed_cost ?? 0), turns: Number(s0.turns),
    lastModel: s0.last_model ?? null,
  };
  const { events, status, totals, live, markQueued, modelState } =
    useSessionLive(s0.id, { events: initialEvents, status: s0.status, totals: initialTotals });

  // Resources (files/outputs/memory/agent) change at turn boundaries — refetch
  // when the stream reports one, so the chips update without a page refresh.
  // (The runner attaches outputs BEFORE posting idle, so this never races.)
  const [res, setRes] = useState<any>(resources);
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (prev !== status && ["idle", "completed", "failed"].includes(status)) {
      fetch(`/api/v1/sessions/${s0.id}/resources`, { headers: wsHeader() })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (j) setRes(j); })
        .catch(() => { /* chips keep the last known state */ });
    }
  }, [status, s0.id]);

  const [panel, setPanel] = useState<PanelId>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [tab, setTab] = useState<"transcript" | "debug">("transcript");
  const [filter, setFilter] = useState<EventFilter>("all");
  const [search, setSearch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attached, setAttached] = useState<AttachedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only the record list scrolls; header/toolbar/timeline/composer stay pinned.
  // "Follow" keeps the list pinned to the newest record: sending a message
  // turns it on, scrolling up turns it off, scrolling back down re-arms it.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const toEnd = () => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);

  const allEvents = events;

  useEffect(() => {
    if (follow) toEnd();
  }, [events.length, status, tab, follow]);   // status: the activity row appears without a new event

  const rows = useMemo(() => groupEvents(allEvents), [allEvents]);
  const visible = useMemo(() => filterRows(rows, filter, search), [rows, filter, search]);
  const selectedRow = selectedSeq != null ? rows.find((r) => r.seq === selectedSeq) ?? null : null;
  const durationMs = events.at(-1)?.duration_ms ?? 0;
  // Turn of the selected step = the last `user` event at or before it (every
  // prompt is a user event carrying payload.turn; routes append it per turn).
  const selectedTurn = selectedRow == null ? 0
    : allEvents.filter((e) => e.type === "user" && e.seq <= selectedRow.seq)
        .reduce((t, e) => Number(e.payload?.turn ?? t), 0);

  // What's happening right now: a pending tool call highlights its row; a
  // generating model / starting pod gets a synthetic bottom row. Either way
  // the counter ticks so long turns visibly make progress (spec: no silent gaps).
  const activity = useMemo<Activity | null>(() => {
    if (!live) return null;
    const tail = rows.at(-1);
    if (tail?.pending) {
      const lastCall = [...tail.events].reverse().find((e) => e.type === "tool.call");
      return { pending: true, label: String(lastCall?.payload?.tool ?? "tool"),
               since: lastCall?.created_at ?? tail.events[0].created_at };
    }
    // A non-ready LOCAL model outranks the generic labels: the turn is
    // stalled on the model, not the LLM thinking (externals resolve null
    // and keep the defaults — they have no deploy/scale lifecycle).
    const modelWaiting = modelState != null && modelState !== "ready";
    return { pending: false,
             label: modelWaiting ? "model deploying / scaling up…"
                  : status === "queued" ? "starting…" : "generating…",
             since: allEvents.at(-1)?.created_at ?? s0.created_at };
  }, [live, status, rows, allEvents, s0.created_at, modelState]);

  function selectRow(seq: number) { setSelectedSeq(seq); setPanel(null); }
  function openPanel(p: Exclude<PanelId, null>) { setPanel(p); setSelectedSeq(null); }
  function closeAll() { setPanel(null); setSelectedSeq(null); }

  async function interrupt() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/v1/sessions/${s0.id}/interrupt`, { method: "POST", headers: wsHeader() });
      if (!res.ok) setError(`Interrupt failed: ${res.status}`);
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  }
  async function send() {
    if (!prompt.trim()) return;
    setBusy(true); setError(null);
    try {
      if (!["idle", "failed"].includes(status)) {
        const ir = await fetch(`/api/v1/sessions/${s0.id}/interrupt`, { method: "POST", headers: wsHeader() });
        if (!ir.ok) { setError(`Interrupt failed: ${ir.status}`); return; }
      }
      const res = await fetch(`/api/v1/sessions/${s0.id}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json", ...wsHeader() },
        body: JSON.stringify({ prompt, ...(attached.length ? { files: attached.map((f) => f.id) } : {}) }),
      });
      // events + status arrive via SSE; markQueued bridges the gap until the
      // new turn's own status frame lands (reconciliation logic in the hook).
      if (res.ok) { setPrompt(""); setAttached([]); markQueued(status); setFollow(true); toEnd(); }
      else setError(`Send failed: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  }

  return (
    <div className="sv">
      <SessionHeader sessionId={s0.id} name={s0.name ?? s0.id} status={status} live={live} totals={totals}
        durationMs={durationMs} resources={res} onOpen={openPanel} cost={cost} />

      <div className="sv-toolbar">
        <div className="tabs" style={{ margin: 0, borderBottom: 0 }}>
          <button className={tab === "transcript" ? "active" : ""} onClick={() => setTab("transcript")}>Transcript</button>
          <button className={tab === "debug" ? "active" : ""} onClick={() => setTab("debug")}>Debug</button>
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value as EventFilter)}>
          <option value="all">All events</option>
          <option value="agent">Agent messages</option>
          <option value="thinking">Thinking</option>
          <option value="tool">Tool calls</option>
          <option value="error">Errors</option>
        </select>
        <input type="search" placeholder="Search transcript…" value={search}
          onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
        <label className="follow-toggle" title="Keep the list pinned to the newest record">
          <input type="checkbox" checked={follow}
            onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        {/* always rendered (disabled when not live) so the toolbar doesn't reflow */}
        <button className="ghost danger" disabled={busy || !live} onClick={interrupt}>■ Interrupt</button>
      </div>

      <Timeline rows={visible} selectedSeq={selectedSeq} onSelect={selectRow} />

      <div className="sv-scroll" ref={scrollRef} onScroll={(e) => {
        const el = e.currentTarget;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        setFollow((f) => (f === atBottom ? f : atBottom));
      }}>
        {tab === "transcript"
          ? <Transcript rows={visible} selectedSeq={selectedSeq} onSelect={selectRow} activity={activity} />
          : <DebugList events={allEvents} search={search} selectedSeq={selectedSeq} onSelect={selectRow} activity={activity} />}
      </div>

      {status !== "completed" && (
        <div className="sv-composer">
          {attached.length > 0 && (
            <div className="attach" style={{ padding: "0 2px" }}>
              <AttachFiles value={attached} onChange={setAttached} compact />
            </div>
          )}
          <div className="sv-input">
            {attached.length === 0 && <AttachFiles value={attached} onChange={setAttached} compact />}
            <input type="text"
              placeholder={status === "idle"
                ? "Send a follow-up message (resumes the session)…"
                : status === "failed"
                ? "Send a message — resumes from the last completed turn (the failed turn's progress is lost)…"
                : "Send a message — interrupts the current run and starts a new turn…"}
              value={prompt} onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && send()} />
            <button disabled={busy || !prompt.trim()} onClick={send}>{busy ? "Sending…" : "Send ▸"}</button>
            {error && <span className="modal-error" style={{ margin: 0 }}>{error}</span>}
          </div>
        </div>
      )}
      {error && status === "completed" && <span className="modal-error" style={{ margin: 0 }}>{error}</span>}

      {panel === "agent" && <AgentPanel resources={res} onClose={closeAll} />}
      {panel === "env" && <EnvPanel resources={res} onClose={closeAll} />}
      {panel === "files" && <FilesPanel resources={res} onClose={closeAll} />}
      {panel === "memory" && <MemoryPanel resources={res} onClose={closeAll} />}
      {panel === "outputs" && <OutputsPanel resources={res} onClose={closeAll} />}
      {selectedRow && <EventPanel row={selectedRow} outputs={res?.outputFiles} onClose={closeAll}
        sessionId={s0.id} turn={selectedTurn} />}
    </div>
  );
}
