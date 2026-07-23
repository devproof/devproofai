// Pure transcript grouping (spec §3): consecutive tool activity collapses
// into a buffer, which is then PARTITIONED at close time into up to two
// rows — Delegate calls (+ their id-matched results) vs everything else —
// using the tool_use id the runner stamps on tool.call/tool.result payloads
// (`payload.id`). Results with no id fall back to the nearest preceding
// call's partition. A buffer that is all-Delegate or all-non-Delegate
// produces exactly one row, unchanged from a flat adjacency grouping.
import type { LiveEvent } from "./use-session-live";

export type RowKind = "user" | "agent" | "thinking" | "tool" | "skill" | "subagent" | "system" | "wait";
// tokensIn/Out are ZERO on every row except the session.result row: the SDK's
// AssistantMessage.usage is all zeros on the wire, so the runner only attaches
// usage to ResultMessage (spec 2026-07-13-realtime-token-usage). Per-row
// attribution does not exist — gateway_usage meters per API call, per SESSION.
// Render these only behind a `> 0` guard (transcript.tsx), never unconditionally
// (that shipped "0/0 tok" on every side sheet).
export interface Row { kind: RowKind; seq: number; title: string; preview?: string;
  error: boolean; tokensIn: number; tokensOut: number; durationMs: number;
  offsetMs: number; events: LiveEvent[]; pending?: boolean; }

// Type badge label, shared by the transcript rows and the detail sheet.
export const CHIP: Record<RowKind, string> =
  { user: "User", agent: "Agent", thinking: "Think", tool: "Tool", skill: "Skill",
    subagent: "Subagent", system: "Sys", wait: "Wait" };

export const offsetLabel = (ms: number) => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// A Wait row is shown ONLY for a genuine model scale-up / deployment wait: a
// scale-to-zero wake (reason "wake", any duration — that IS the model coming
// up) or any wait long enough that the model was demonstrably down/coming up
// (>= WAIT_SHOW_SEC). Shorter waits are transient gateway rolling-reload
// bounces (~5s Retry-After cycles on an already-serving model): they render
// NOTHING and their time folds into the next action, keeping tool groups
// intact ("Bash ×3") — the pre-dev55 accounting (user decision 2026-07-23c).
// Duration, not the classified reason, is the discriminator: a fresh deploy's
// route-absent stretch and a 5s transient bounce are BOTH reason "reload" and
// differ only in length (live: 346s deploy vs 5s bounce in one turn).
const WAIT_SHOW_SEC = 20;
const isScaleUpWait = (e: { payload?: any }) =>
  e.payload?.reason === "wake" || Number(e.payload?.seconds ?? 0) >= WAIT_SHOW_SEC;

const firstLine = (t: string, max = 120) => {
  const line = (t ?? "").split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line;
};

const inputPreview = (input: any) => {
  if (input == null) return "";
  if (typeof input.command === "string") return firstLine(input.command);
  if (typeof input.file_path === "string") return firstLine(input.file_path);
  if (typeof input.prompt === "string") return firstLine(input.prompt);
  return firstLine(JSON.stringify(input));
};

// MCP tool names come off the SDK as `mcp__<server>__<tool>` — server names
// can't contain `__` in practice (validation allows [a-zA-Z0-9_-]), so
// splitting on the first `__` is unambiguous. Both segments are \S so a
// joined multi-tool group title ("mcp__s__a, mcp__s__b" / "mcp__s__a, Bash")
// can never match — those rows keep the plain Tool presentation.
const MCP_TOOL_RE = /^mcp__(\S+?)__(\S+)$/;
export function parseMcpTool(name: string): { server: string; tool: string } | null {
  const m = MCP_TOOL_RE.exec(name);
  return m ? { server: m[1], tool: m[2] } : null;
}

export function groupEvents(events: LiveEvent[]): Row[] {
  const rows: Row[] = [];
  // Cumulative offset of the previous row's last event. The runner's
  // durationMs clock restarts at 0 each turn (fresh pod), so offsets are
  // only meaningful within a turn — this is a documented limitation, not
  // a bug to fix here.
  let prevEnd = 0;
  let tool: Row | null = null;           // open tool group

  const close = (r: Row) => {
    const last = r.events[r.events.length - 1];
    if (last.duration_ms < prevEnd) prevEnd = 0;  // new turn's clock restarted
    r.durationMs = Math.max(0, last.duration_ms - prevEnd);
    prevEnd = Math.max(prevEnd, last.duration_ms);
    rows.push(r);
  };
  // Live bugs this partition fixes: (1) sesn_akcaqzi6hkts — a Delegate call
  // immediately followed by another tool call (no text between) used to
  // merge into one mixed group ("Delegate, Bash"), losing the Subagent kind
  // rewrite AND the child-session link; a call-time split fixed that but (2)
  // broke PARALLEL tool use — the runner emits a message's ToolUseBlocks
  // first, then all its ToolResultBlocks (CALL Bash → CALL Delegate →
  // RES(Bash) → RES(Delegate)), so a call-time split closed the Bash group
  // early and both results landed in the still-open Delegate group,
  // misattributing the Bash result (incl. its is_error) onto the Subagent
  // row and leaving Bash result-less with no pending flag. Buffering
  // everything and partitioning by tool_use id at close time fixes both.
  const closeTool = () => {
    if (!tool) return;
    const buffered = tool.events;
    tool = null;
    // Skill partitions like Delegate: both have dedicated row kinds (green
    // Skill row, Subagent row), and with wait events no longer splitting the
    // buffer (2026-07-23b) a Skill call adjacent to other tools would merge
    // into a mixed "Bash, Skill" group and lose its presentation.
    const delegateEvents: LiveEvent[] = [];
    const skillEvents: LiveEvent[] = [];
    const otherEvents: LiveEvent[] = [];
    type Part = "delegate" | "skill" | "other";
    const bucket: Record<Part, LiveEvent[]> =
      { delegate: delegateEvents, skill: skillEvents, other: otherEvents };
    const partitionById = new Map<string, Part>();
    let lastPartition: Part = "other";
    for (const e of buffered) {
      let partition: Part;
      if (e.type === "tool.call") {
        const name = String(e.payload?.tool);
        partition = name === "Delegate" ? "delegate" : name === "Skill" ? "skill" : "other";
        const id = e.payload?.id;
        if (id != null) partitionById.set(id, partition);
        lastPartition = partition;
      } else {
        const id = e.payload?.id;
        partition = (id != null && partitionById.has(id)) ? partitionById.get(id)! : lastPartition;
      }
      bucket[partition].push(e);
    }
    // Emit in chronological-END order (last event's seq), not start order:
    // close()'s prevEnd bookkeeping and the trailing-pending check (below)
    // both assume rows arrive in the order they finish. A partition that
    // starts first can still finish last (e.g. CALL Bash → CALL Delegate →
    // RES(Delegate) → RES(Bash), or an unresolved trailing call) — sorting
    // by first-seq would emit it before a partition it actually outlasts,
    // corrupting prevEnd's monotonic advance (false "new turn" resets) and
    // hiding a genuinely-pending trailing tool from the rows[last] check.
    const partitions = [delegateEvents, skillEvents, otherEvents]
      .filter((p) => p.length > 0)
      .sort((a, b) => a[a.length - 1].seq - b[b.length - 1].seq);
    for (const p of partitions) {
      const first = p[0];
      const row: Row = { kind: "tool", seq: first.seq, title: "", error: false,
        tokensIn: 0, tokensOut: 0, durationMs: 0, offsetMs: first.duration_ms, events: [] };
      for (const e of p) {
        row.events.push(e);
        row.tokensIn += e.tokens_in; row.tokensOut += e.tokens_out;
        if (e.type === "tool.result" && e.payload?.is_error) row.error = true;
      }
      close(row);
    }
  };
  const mkRow = (kind: RowKind, e: LiveEvent, title: string, error = false): Row => ({
    kind, seq: e.seq, title, error, tokensIn: e.tokens_in, tokensOut: e.tokens_out,
    durationMs: 0, offsetMs: e.duration_ms, events: [e],
  });

  for (const e of events) {
    // Drop transient (short, non-wake) waits BEFORE closeTool so they neither
    // split an open tool group ("Bash ×3" stays grouped) nor advance prevEnd —
    // their time folds into the next row. Genuine scale-up/deploy waits fall
    // through to the Wait row below.
    if (e.type === "model.wait" && !isScaleUpWait(e)) continue;
    if (e.type === "tool.call") {
      if (!tool) tool = { kind: "tool", seq: e.seq, title: "", error: false,
        tokensIn: 0, tokensOut: 0, durationMs: 0, offsetMs: e.duration_ms, events: [] };
      tool.events.push(e);
      tool.tokensIn += e.tokens_in; tool.tokensOut += e.tokens_out;
    } else if (e.type === "tool.result" && tool) {
      tool.events.push(e);
      tool.tokensIn += e.tokens_in; tool.tokensOut += e.tokens_out;
      if (e.payload?.is_error) tool.error = true;
    } else {
      closeTool();
      if (e.type === "user") {
        close(mkRow("user", e, firstLine(e.payload?.text ?? "")));
      } else if (e.type === "agent.message") {
        close(mkRow("agent", e, firstLine(e.payload?.text ?? "")));
      } else if (e.type === "agent.thinking") {
        // Dedicated kind: visible progress in the transcript, but distinct
        // from "agent" so results-only consumers (filter, API clients on
        // agent.message) never see reasoning text.
        close(mkRow("thinking", e, firstLine(e.payload?.text ?? "")));
      } else if (e.type === "tool.result") {
        close(mkRow("system", e, "tool result", !!e.payload?.is_error));
      } else if (e.type === "model.wait") {
        // Only genuine scale-up/deploy waits reach here (the skip above): time
        // the model spent coming up before this call. Offset is stamped at
        // WAIT END, so the delta arithmetic charges the wait to this row and
        // the next step shows pure generation time.
        const secs = Number(e.payload?.seconds ?? 0);
        const label = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
        close(mkRow("wait", e, `waited for model deploy / scale-up — ${label}`));
      } else {
        close(mkRow("system", e,
          e.type === "session.result"
            ? `result · ${e.payload?.subtype ?? "?"} · ${e.payload?.num_turns ?? "?"} turns`
            : e.type === "session.waiting"
            ? (e.payload?.writerAgent
                ? "queued — the wiki writer is busy (runs one session at a time)"
                : `waiting for model ${e.payload?.model ?? "?"} (${e.payload?.phase ?? "deploying"})`)
            : e.type.replace(/^session\./, ""),
          e.type === "session.failed"));
      }
    }
  }
  closeTool();

  // Only the trailing group can still be executing: a tool.call with no
  // result yet means the tool is running right now (the runner emits the
  // call before executing it). Mid-transcript call/result mismatches are
  // adjacency artifacts, not activity.
  // Runs BEFORE the skill-kind rewrite below, so "tool" is the only kind an
  // open group can have here.
  const last = rows[rows.length - 1];
  if (last?.kind === "tool"
      && last.events.filter((e) => e.type === "tool.call").length
       > last.events.filter((e) => e.type === "tool.result").length) {
    last.pending = true;
  }

  // Titles for tool groups: "Bash", "Bash ×2", or "Read, Docs Rag Search".
  // The mixed-name fallback (names.length > 1) can never include "Delegate"
  // or "Skill" here — closeTool's partition above guarantees they never mix
  // with other tools, so they always hit their dedicated branches below.
  for (const r of rows) {
    if (r.kind !== "tool") continue;
    const calls = r.events.filter((e) => e.type === "tool.call");
    const names = [...new Set(calls.map((e) => String(e.payload?.tool ?? "tool")))];
    if (names.length === 1 && names[0] === "Skill") {
      // Skill loads get their own badge + title (user decision 2026-07-17);
      // the result body renders exactly like a tool result. A path input means
      // a bundled reference file was lazily loaded.
      r.kind = "skill";
      const loaded = [...new Set(calls.map((e) => {
        const input = e.payload?.input ?? {};
        return input.path ? `${input.skill ?? "?"}/${input.path}` : String(input.skill ?? "?");
      }))];
      const anyFile = calls.some((e) => e.payload?.input?.path);
      r.title = `${anyFile ? "skill file loaded" : "skill loaded"}: ${loaded.join(", ")}`;
      continue;
    }
    if (names.length === 1 && names[0] === "Delegate") {
      // Delegation rows get their own badge + title (spec 2026-07-17); the
      // result body renders exactly like a tool result.
      r.kind = "subagent";
      const targets = [...new Set(calls.map((e) => String(e.payload?.input?.agent ?? "?")))];
      r.title = `delegate: ${targets.join(", ")}`;
      if (calls.length === 1) r.preview = firstLine(String(calls[0].payload?.input?.prompt ?? ""));
      continue;
    }
    if (names.length === 1) {
      r.title = calls.length > 1 ? `${names[0]} ×${calls.length}` : names[0];
      if (calls.length === 1) r.preview = inputPreview(calls[0].payload?.input);
    } else {
      r.title = names.join(", ");
    }
  }
  return rows;
}

export function rowText(r: Row): string {
  return (r.title + " " + r.events.map((e) =>
    typeof e.payload?.text === "string" ? e.payload.text :
    typeof e.payload?.output === "string" ? e.payload.output :
    JSON.stringify(e.payload ?? {})).join(" ")).toLowerCase();
}
