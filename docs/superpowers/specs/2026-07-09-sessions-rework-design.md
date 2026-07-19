# Sessions experience rework — design

Date: 2026-07-09. Status: approved by user (all four sections).
Reference screenshots: `tmp/screens_sessions/` (Anthropic Managed Agents session view).

## Problem (user's seven items)

1. Session page layout should match the reference screenshots; the meta
   information currently shown as an always-visible card grid should appear
   only on click, in a right-side panel.
2. The running-status chip has no spacing to its neighbor (absorbed by 1).
3. The page requires manual browser refresh; it must update automatically on
   every new action.
4. Clicking an output shows plain text; markdown must render nicely.
5. The model gets no platform contract (where input/output files live, where
   to experiment, where memory is) — provide a technical base prompt.
   **Decision: hardcoded in the runner** (versioned constant), not per-agent
   configurable.
6. Bug: follow-up messages sent from the UI are neither shown nor tracked.
7. Default 500 turns; the model must know its budget and deliver an answer on
   the last turn. **Decision: budget stated in the preamble + a guaranteed
   wrap-up turn on exhaustion.**

Additional decision: **full screenshot fidelity** including the event-type
filter, Debug tab, and transcript search.

## Root causes (verified in code)

- No `user` event exists anywhere: the initial prompt is a hardcoded block in
  `trace.tsx`; `POST /v1/sessions/:id/messages` records nothing → item 6.
- `trace.tsx` seeds `useState` from server props once and calls
  `router.refresh()`, which updates props the component never re-adopts; the
  SSE stream (push-based via NOTIFY) closes whenever the session goes idle →
  item 3.
- `runner.py`: no platform preamble; `max_turns` fallback 10. The bundled SDK
  (verified in the dev7 image) reports turn exhaustion as
  `ResultMessage.subtype == "error_max_turns"` with `is_error=True`, then the
  CLI exits non-zero and the runtime RAISES on the iterator — today this marks the
  session **failed**. The legacy runtime's `resume` option (types.py:1790; historical —
  superseded by the in-process `devproof_runner` loop) is the same
  mechanism cross-pod resume already uses; `query()` spawns a fresh CLI
  subprocess per call, so a second in-process call is safe.

## 1. Backend & runner

**User-message events (item 6).** `POST /v1/sessions` and
`POST /v1/sessions/:id/messages` append `{type: "user", payload: {text,
turn}}` via `repo.appendEvents` BEFORE `orchestrator.startSession` (so the
event exists before the pod starts and NOTIFY pushes it to open viewers).
Legacy sessions with no `user` event: the UI renders `session.prompt` as the
first row (no migration).

**Platform preamble (item 5).** `runner.py` gains a versioned constant
`PLATFORM_PROMPT_20260709`, prepended to the agent's system prompt
(`system_prompt = PREAMBLE + "\n\n" + (agent prompt or "")`). Content:
- Input files land in `/mnt/session/uploads` (listed in the first user
  message when present — the existing listing stays in the user prompt).
- Anything written to `/mnt/session/outputs` is published to the user as a
  downloadable output file — final deliverables belong there.
- `/work` is the scratch workspace for ephemeral experiments; it persists
  across turns of this session (checkpointed) but not beyond it.
- `/mnt/memory` is the shared memory store (when mounted): read it before
  starting; write durable learnings back — changes sync automatically.
- Turn budget: "You have N turns in this session" (N = max_turns); the final
  turn must contain the answer/deliverable, not a tool call.

**Turn budget (item 7).** Default `maxTurns` 500: console agent-form default
AND runner fallback `CONFIG.get("max_turns", 500)`. Existing agent versions
keep their stored value (agents are editable). Wrap-up mechanism in
`runner.py`: wrap the `async for … query(...)` loop so that when the result
is `error_max_turns` (ResultMessage seen, or the runtime's trailing raised error
whose text carries it), the runner issues ONE extra
`query(prompt="Your turn budget is exhausted — provide your final answer
now.", options=…resume=sdk_session_id, max_turns=1)`, emitting its output as
normal `agent.message` events. A turn-exhausted-then-wrapped-up session ends
**idle** (checkpointed, resumable), not failed. Other error subtypes keep the
current failed path.

**Resources endpoint additions.** `repo.sessionResources` additionally
returns: agent `name`, `version`, `systemPrompt`, `maxTurns` (from the
session's agent version row). Environment/vault/files/memory/model/tools/mcp
are already present. Additive change.

**SSE lifetime.** `GET /v1/sessions/:id/events?stream=1` keeps streaming
until the session is TERMINAL (`completed`/`failed`) or the client
disconnects — it no longer closes on `idle`. NOTIFY wakes stay instant; the
safety heartbeat becomes 15 s while idle. On every status change the server
writes a synthetic SSE event `event: status` with
`{status, tokens_in, tokens_out, turns}` so the client updates header state
without refetching. `event: end` is only sent on terminal status.

## 2. Live-update model (item 3)

One hook `use-session-live.ts` owns all mutable state; components render from
it. State: `events[]`, `status`, `totals`, seeded from server props on mount.
One `EventSource` opened at `after=<last seq>`, kept until terminal status or
unmount. SSE `message` appends an event; SSE `status` updates status/totals;
`end` closes (terminal). On `EventSource` error the hook re-creates the
source with the latest seq (native Last-Event-ID is not wired). No
`router.refresh()` in any flow. Follow-up send and interrupt are plain POSTs
— their effects (user event, interrupted event, status changes) arrive
through the stream, including for OTHER viewers of the same session.
Auto-scroll only when the viewport is already at the bottom.

## 3. UI layout (items 1, 2, 4)

**Header** (replaces the res-grid cards AND the old sv-head chips):
breadcrumb; `<h1>` session name + status chip (pulse while live; proper gap —
item 2); one row of meta chips: `agent name vN` · `env name` ·
`N files[, memory store]` · `N outputs` · `duration` · `tokens in/out`.
The first four chips open a right **slide-over side sheet** (fixed position,
panel-styled, ✕ and Escape close; Escape handling follows the dialog-system
conventions). Duration/tokens are display-only. Interrupt button in the
header while running.

**Panels** (`panels.tsx`), from the extended resources payload:
- Agent: name+version, created, id, "Go to agent →", Model, System prompt
  (scrollable block), Tools, MCP servers, Skills chips.
- Environment: name, networking type (limited), hosts chips, package access,
  vault, "Go to environment →".
- Files: input files with sizes + download links.
- Outputs: file list; selecting one shows name/mime/size/date + download;
  text files preview inline (same content fetch as the skill viewer).

**Transcript** (`transcript.tsx`): compact rows — role chip (User accent /
Agent blue / Tool violet-grey) + title + right-aligned: Error chip (from
`tool.result.is_error`), `tokens in/out`, per-event duration, wall-clock
offset. Consecutive tool activity groups into ONE row: `tool.call` pairs with
its `tool.result` by tool_use id (fallback: sequence adjacency); runs of the
same tool collapse to `Bash ×2`; mixed runs list names (`Read, Docs Rag
Search`). Row title for single tool calls: tool name bold + first-line input
preview greyed. `user` events render as rows (item 6 visible; legacy
fallback: `session.prompt` first row). Clicking a row opens the event detail
in the same right side sheet with **Rendered** (markdown) / **Raw** (pretty
JSON) tabs.

**Markdown** (`app/lib/markdown.tsx`, item 4): `react-markdown` +
`remark-gfm`, styled to the blueprint identity (headings, lists, tables,
code blocks reuse `pre.block` styling). Used by the row detail (agent/user
messages) and the outputs preview for `.md` files. Reusable by other pages
later.

**Tabs + filter + search**: `Transcript | Debug` tabs. Debug = ungrouped raw
event list (every event incl. session.init / checkpoint noise, JSON
one-liners). Filter dropdown: All / Agent messages / Tool calls / Errors /
System. Search input: client-side substring filter over title + payload text;
applies to both tabs.

**Timeline** (`timeline.tsx`): one segment per transcript row group, width
proportional to the group's share of total duration (with a min-width floor),
colored by role; selected segment outlined; click selects + scrolls to the
row.

**Follow-up input** pinned under the transcript when idle (unchanged
behavior, now with instant echo via the user event).

## 4. Files, testing, rollout

**Console:** new `app/sessions/[id]/use-session-live.ts`, `header.tsx`,
`panels.tsx`, `transcript.tsx`, `timeline.tsx`; new `app/lib/markdown.tsx`;
`trace.tsx` becomes the composition root (keeps the `SessionView` export);
`page.tsx` drops the res-grid and passes resources through; `globals.css`
gains side-sheet/row/timeline/markdown styles. New dependency:
`react-markdown` + `remark-gfm`.
**Control plane:** `agents-api.ts` (user events ×2 routes, SSE terminal-only
close + synthetic status event), `repo.ts` (`sessionResources` additions).
**Runner:** `runner.py` (preamble, fallback 500, wrap-up flow) → image
`devproof/session-runner:dev8`; CLAUDE.md + run docs updated to dev8.
**Agent form:** default maxTurns 500.

**Testing.** Backend tests (existing harness): both routes append the user
event before the session starts; resources payload carries the new fields.
Runner + SSE verified live: create session → user row appears instantly;
tool rows group; markdown renders; every chip panel opens/closes (Escape);
follow-up streams in with no refresh; a second tab sees a resume; interrupt;
turn-exhaustion exercised with a tiny maxTurns agent (e.g. 2) → wrap-up
answer arrives and session ends idle; console production build; grep gate
(no browser dialogs) stays clean.

**Rollout.** No DB migration (`user` is a new event type through the existing
JSONB pipeline). Runner: build dev8, restart CP with
`DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev8`. Old sessions render via
the legacy prompt fallback.

## Out of scope

Sessions LIST page live updates; transcript virtualization; markdown in row
titles (plain text there); per-turn countdown injection into the model
context (budget is stated once in the preamble); output-file image previews.
