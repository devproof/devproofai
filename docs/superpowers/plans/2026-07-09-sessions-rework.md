# Sessions Experience Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the session detail page to the reference-screenshot layout (row transcript, clickable meta chips → slide-over panels, live SSE updates, markdown rendering) and give the runner a platform preamble + 500-turn budget with a guaranteed wrap-up answer.

**Architecture:** Spec: `docs/superpowers/specs/2026-07-09-sessions-rework-design.md` (approved). Backend first (user events, SSE lifetime, resources additions — TDD on the existing in-memory fakes), then the runner (preamble, budget, wrap-up — no test harness, live-verified), then the console rebuilt as focused modules composed by `trace.tsx` (every intermediate task keeps `npx next build` green by adding unused-but-compiled modules until the final composition swap).

**Tech Stack:** Fastify + Node test runner (fakes, `app.inject`), Python runner on its then-current agent loop (today the from-scratch in-process `devproof_runner`; image tag dev7 → **dev8**), Next.js 15 App Router, `react-markdown` + `remark-gfm` (new console deps), hand-rolled CSS in `globals.css`.

## Global Constraints

- Console verified with a **production build** (`cd console && npx next build`); dev mode banned.
- No browser `prompt()`/`confirm()`/`alert()`; grep gate `grep -rnE "confirm\(|prompt\(|alert\(" console/app` stays at zero hits.
- No transparent text buttons (ghost = solid panel fill); table/name links regular weight.
- Backend test command: `cd control-plane && node --import tsx --test test/<file>.ts` (bare `node --test` fails on type-only imports). Do NOT run `npm test` in implementer subagents (live-DB contention); the controller runs the full suite at the end.
- Runner changes ship as image **`devproof/session-runner:dev8`** — same-tag rebuilds are invisible to nodes; the tag MUST bump.
- SSE close rule (spec §1): stream ends only on `completed`/`failed` or client disconnect — never on `idle`.
- Turn defaults (spec §1): 500 in the console agent form, `repo.ts` (`c.maxTurns ?? 500`), and the runner fallback (`CONFIG.get("max_turns", 500)`).
- Preamble constant name: `PLATFORM_PROMPT_20260709` (versioned).
- Every list endpoint keeps `{rows-alias, count, offset}`; IDs immutable; no DB migration in this plan.
- Work on a feature branch `feature/sessions-rework` off main (repo convention; merge via finishing-a-development-branch).

## File Structure (created/changed)

| File | Role |
|---|---|
| `control-plane/src/agents-api.ts` | user events in create/messages routes; SSE terminal-only close + `status` events + idle heartbeat |
| `control-plane/src/repo.ts` | `pg_notify` in `setSessionStatus`; `sessionResources` gains `agent` block; `maxTurns ?? 500` |
| `control-plane/test/agents-api.test.ts` | user-event route tests (fakes) |
| `control-plane/test/repo.test.ts` | live-DB test: resources `agent` block |
| `session-runner/runner.py` | platform preamble, fallback 500, wrap-up turn on `error_max_turns` |
| `console/package.json` | + `react-markdown`, `remark-gfm` |
| `console/app/lib/markdown.tsx` | **new** — blueprint-styled markdown renderer (reusable) |
| `console/app/sessions/[id]/use-session-live.ts` | **new** — SSE/state hook (`LiveEvent`, `Totals`) |
| `console/app/sessions/[id]/rows.ts` | **new** — pure `groupEvents()` transcript grouping |
| `console/app/sessions/[id]/header.tsx` | **new** — name/status/meta-chip header |
| `console/app/sessions/[id]/panels.tsx` | **new** — SideSheet + agent/env/files/outputs/event panels |
| `console/app/sessions/[id]/transcript.tsx` | **new** — row list + Debug list |
| `console/app/sessions/[id]/timeline.tsx` | **new** — segmented duration bar |
| `console/app/sessions/[id]/trace.tsx` | rewritten as composition root (keeps `SessionView` export) |
| `console/app/sessions/[id]/page.tsx` | drops res-grid; passes `resources` into `SessionView` |
| `console/app/agents/agent-form.tsx` | default maxTurns 500 |
| `console/app/globals.css` | + sheet/chipbtn/trow/timeline/md styles; − dead `.msg`/`.detail` styles |
| `CLAUDE.md` | runner tag dev8; sessions-view conventions line |

---

### Task 1: Control plane — user events, SSE lifetime, resources agent block

**Files:**
- Modify: `control-plane/src/agents-api.ts` (create route ~line 336, messages route ~line 366, SSE route ~line 435)
- Modify: `control-plane/src/repo.ts` (`setSessionStatus` ~line 165, `sessionResources` ~line 230, `addVersion` insert ~line 60)
- Test: `control-plane/test/agents-api.test.ts`, `control-plane/test/repo.test.ts`

**Interfaces:**
- Consumes: `repo.appendEvents(sessionId, events[])` (already does `pg_notify('devproof_session', id)` and flips `queued→running` — an accepted side effect: status reads "running" from the moment a prompt is recorded).
- Produces (later tasks rely on):
  - Event type `"user"` with `payload: {text: string, turn: number}` — first event of every turn.
  - SSE named event `status` with data `{status, tokens_in, tokens_out, turns}` (numbers), emitted on every status change observed by the stream; `end` only at terminal.
  - `GET /v1/sessions/:id/resources` additionally returns `agent: {id, name, version, systemPrompt, maxTurns}`.

- [ ] **Step 1: Write the failing route tests**

Append to `control-plane/test/agents-api.test.ts` (the file's `fakes()` helper and existing tests show the pattern — reuse its `mkAgent`-style setup used by the existing session tests; the fake `repo.appendEvents`/`listEvents` already exist):

```ts
test("POST /v1/sessions records the prompt as the first user event", async () => {
  const { app, repo } = await appWithAgent();      // helper below if absent
  const res = await app.inject({ method: "POST", url: "/v1/sessions",
    payload: { agent: "agent_0", prompt: "do the thing" } });
  assert.equal(res.statusCode, 201);
  const { id } = res.json();
  const evs = (await app.inject({ method: "GET", url: `/v1/sessions/${id}/events` })).json().events;
  assert.equal(evs[0].type, "user");
  assert.equal(evs[0].payload.text, "do the thing");
  assert.equal(evs[0].payload.turn, 0);
});

test("POST /v1/sessions/:id/messages records a user event with the turn number", async () => {
  const { app, repo } = await appWithAgent();
  const { id } = (await app.inject({ method: "POST", url: "/v1/sessions",
    payload: { agent: "agent_0", prompt: "first" } })).json();
  await repo.setSessionStatus(id, "idle");
  const res = await app.inject({ method: "POST", url: `/v1/sessions/${id}/messages`,
    payload: { prompt: "follow up" } });
  assert.equal(res.statusCode, 202);
  const evs = (await app.inject({ method: "GET", url: `/v1/sessions/${id}/events` })).json().events;
  const user = evs.filter((e: any) => e.type === "user");
  assert.equal(user.length, 2);
  assert.equal(user[1].payload.text, "follow up");
  assert.equal(user[1].payload.turn, 1);
});
```

If the file has no shared helper that creates an app with one agent, add one next to `fakes()`:

```ts
async function appWithAgent() {
  const f = fakes();
  const app = Fastify();
  registerAgentRoutes(app, f.repo as unknown as Repo, f.orchestrator as Orchestrator, f.files as any, f.notify as any);
  await app.inject({ method: "POST", url: "/v1/agents", payload: { name: "a", model: "m" } });
  return { app, repo: f.repo };
}
```
(Match the actual `registerAgentRoutes(...)` parameter order at the top of the file — copy how the existing tests construct the app.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd control-plane && node --import tsx --test test/agents-api.test.ts`
Expected: both new tests FAIL (no `user` event exists / count is 1).

- [ ] **Step 3: Implement the route changes**

In `agents-api.ts`, `POST /v1/sessions` — directly after `session = await repo.createSession(...)` succeeds:

```ts
    // The prompt is part of the transcript: first event of turn 0.
    await repo.appendEvents(session.id, [{ type: "user", payload: { text: b.prompt, turn: 0 } }]);
```

In `POST /v1/sessions/:id/messages` — directly after `turn = await repo.startTurn(id)` succeeds:

```ts
    await repo.appendEvents(id, [{ type: "user", payload: { text: b.prompt, turn: turn.turn } }]);
```

- [ ] **Step 4: Rewrite the SSE streaming section**

In the `GET /v1/sessions/:id/events` handler, replace the `try { while (open) ... }` loop with:

```ts
    let lastStatus = "";
    try {
      while (open) {
        const events = await repo.listEvents(id, seq);
        for (const e of events) {
          seq = e.seq;
          reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
        }
        const s = await repo.getSession(id);
        if (!s) break;
        if (s.status !== lastStatus) {
          lastStatus = s.status;
          reply.raw.write(`event: status\ndata: ${JSON.stringify({
            status: s.status,
            tokens_in: Number(s.tokens_in ?? 0), tokens_out: Number(s.tokens_out ?? 0),
            turns: Number(s.turns ?? 0),
          })}\n\n`);
        }
        // Terminal ONLY on completed/failed — idle sessions stay subscribed so
        // resumes from other tabs/API calls appear without a refresh (spec §1).
        if (["completed", "failed"].includes(s.status)) break;
        const heartbeat = s.status === "idle" ? 15000 : 5000;
        await new Promise<void>((r) => { wake = r; setTimeout(r, heartbeat); });
      }
    } finally {
      unsub();
    }
```

(The surrounding `seq`/`open`/`wake`/`unsub` declarations and the trailing `event: end` write stay as they are.)

- [ ] **Step 5: repo.ts — NOTIFY on status change, resources agent block, 500 default**

(a) In `setSessionStatus`, after its `UPDATE sessions ...` query and before the function returns, add:

```ts
    await this.pool.query("SELECT pg_notify('devproof_session', $1)", [sessionId]);
```
(Without this, an SSE viewer of an idle session learns about status flips only on the heartbeat.)

(b) In `sessionResources`, after `const v = await this.getAgentVersion(...)`:

```ts
    const { rows: agentRows } = await this.pool.query(
      "SELECT name FROM agents WHERE id = $1", [session.agent_id]);
```

and add to the returned object:

```ts
      agent: {
        id: session.agent_id,
        name: agentRows[0]?.name ?? session.agent_id,
        version: session.agent_version,
        systemPrompt: v?.system_prompt ?? "",
        maxTurns: v?.max_turns ?? null,
      },
```

(c) In `addVersion`'s INSERT parameter list change `c.maxTurns ?? 10` to `c.maxTurns ?? 500`.

- [ ] **Step 6: Live-DB repo test for the agent block**

Append to `control-plane/test/repo.test.ts`, following its existing connect-or-skip pattern (copy the guard the file already uses):

```ts
test("sessionResources returns the agent block", { skip: !process.env.DEVPROOF_TEST_DB && !available }, async () => {
  // reuse the file's setup helpers: create workspace → agent → session
  const agent = await repo.createAgent(ws, "res-agent", { model: "m1", systemPrompt: "SP", maxTurns: 7, tools: [] });
  const s = await repo.createSession(ws, agent.id, "hello");
  const r = await repo.sessionResources(s.id, ws);
  assert.equal(r.agent.name, "res-agent");
  assert.equal(r.agent.version, 1);
  assert.equal(r.agent.systemPrompt, "SP");
  assert.equal(r.agent.maxTurns, 7);
});
```
(Adapt variable names to the file's existing fixtures — read its first test and mirror it exactly.)

- [ ] **Step 7: Run tests + typecheck**

Run: `cd control-plane && node --import tsx --test test/agents-api.test.ts && npx tsc --noEmit`
Expected: PASS (repo.test.ts self-skips without a DB; run it too if `localhost:15432` is up).

- [ ] **Step 8: Commit**

```bash
git add control-plane/src/agents-api.ts control-plane/src/repo.ts control-plane/test/agents-api.test.ts control-plane/test/repo.test.ts
git commit -m "feat(sessions): user-message events, terminal-only SSE with status pushes, resources agent block"
```

---

### Task 2: Runner — platform preamble, 500-turn default, wrap-up turn (image dev8)

**Files:**
- Modify: `session-runner/runner.py`
- Modify: `console/app/agents/agent-form.tsx` (maxTurns default), `CLAUDE.md` (dev7 → dev8 mentions)

**Interfaces:**
- Consumes: runtime facts (verified in the dev7 image): `ResultMessage.subtype == "error_max_turns"` with `is_error=True`; after that result the runtime RAISES on the iterator (ProcessError replaced with structured text containing the error); the runtime's options object (`resume=<sdk session id>`) resumes; each `query()` call spawns its own subprocess.
- Produces: system prompt = `PLATFORM_PROMPT_20260709` block + agent prompt; new event `session.budget_exhausted {max_turns}`; a turn-exhausted session ends **idle** after a wrap-up `agent.message`, not failed. No test harness — Task 6 verifies live.

- [ ] **Step 1: Add the preamble and helpers to `runner.py`**

After the `MEMORY_DIR` constant block, add:

```python
MAX_TURNS = int(CONFIG.get("max_turns") or 500)

# Versioned platform contract (spec 2026-07-09). Always prepended to the
# agent's own system prompt — the model cannot use the sandbox without it.
PLATFORM_PROMPT_20260709 = f"""You are running inside a Devproof managed session (a sandboxed container).

Filesystem contract:
- Input files attached to this session are mounted at {UPLOADS_DIR} (also listed in the first user message when present).
- Write final deliverables to {OUTPUTS_DIR} — everything there is published to the user as downloadable output files when the turn ends.
- /work is your scratch workspace for ephemeral experiments; it persists across turns of THIS session, but not beyond it.
- If {MEMORY_DIR} exists, it is a shared memory store: read it before starting work, and write durable learnings back — changes sync automatically when the turn ends.

Turn budget: you have {MAX_TURNS} turns in this session. Budget your work so the FINAL turn contains your answer or deliverable as a plain message, not a tool call."""


def system_prompt() -> str:
    agent = (CONFIG.get("system_prompt") or "").strip()
    return PLATFORM_PROMPT_20260709 + ("\n\n" + agent if agent else "")
```

- [ ] **Step 2: Restructure `main()` around a reusable query loop with wrap-up**

Replace `main()` with:

```python
async def run_query(prompt: str, options) -> tuple[str | None, str | None, bool]:
    """Stream one SDK query; returns (sdk_session_id, result_subtype, is_error).
    The runtime raises after an is_error result (CLI exits non-zero) — the caller
    inspects the subtype we captured before the raise."""
    from <legacy-runner-lib> import query          # historical: the legacy runner runtime
    from <legacy-runner-lib>.types import AssistantMessage, ResultMessage, SystemMessage, UserMessage

    sdk_session_id: str | None = getattr(options, "resume", None)
    subtype: str | None = None
    is_error = False
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, SystemMessage):
            if message.subtype == "init":
                sdk_session_id = message.data.get("session_id") or sdk_session_id
                emit("session.init", {"session_id": sdk_session_id,
                                      "tools": message.data.get("tools", [])})
        elif isinstance(message, AssistantMessage):
            for block in message.content:
                kind = type(block).__name__
                if kind == "TextBlock":
                    emit("agent.message", {"text": block.text})
                elif kind == "ToolUseBlock":
                    emit("tool.call", {"tool": block.name, "input": block.input, "id": block.id})
                elif kind == "ThinkingBlock":
                    emit("agent.thinking", {"text": getattr(block, "thinking", "")[:2000]})
        elif isinstance(message, UserMessage):
            content = message.content if isinstance(message.content, list) else []
            for block in content:
                if type(block).__name__ == "ToolResultBlock":
                    text = block.content if isinstance(block.content, str) else json.dumps(
                        block.content, default=str)[:4000]
                    emit("tool.result", {"id": block.tool_use_id, "output": text,
                                         "is_error": bool(block.is_error)})
        elif isinstance(message, ResultMessage):
            usage = message.usage or {}
            subtype = message.subtype
            is_error = bool(message.is_error)
            emit("session.result", {
                "subtype": message.subtype, "num_turns": message.num_turns,
                "stop_reason": getattr(message, "stop_reason", None),
                "is_error": message.is_error,
            }, tokens_in=usage.get("input_tokens", 0), tokens_out=usage.get("output_tokens", 0),
               duration_ms=message.duration_ms)
    return sdk_session_id, subtype, is_error


async def main() -> None:
    # Import here so config/env errors still produce a session.failed event.
    from <legacy-runner-lib> import <LegacyOptions>   # historical: the legacy runner runtime's options class

    restore_checkpoint()

    def options(max_turns: int, resume: str | None):
        return <LegacyOptions>(
            model=CONFIG["model"],
            system_prompt=system_prompt(),
            tools=CONFIG.get("tools") or [],
            allowed_tools=CONFIG.get("tools") or [],
            permission_mode="bypassPermissions",
            max_turns=max_turns,
            resume=resume,
            cwd="/work",
            setting_sources=["project"],   # loads the legacy runtime's project settings dir under /work (skills; now /work/.devproof/skills)
            mcp_servers=CONFIG.get("mcp_servers") or {},
        )

    staged_skills = stage_skills()
    stage_memory()
    staged = stage_attachments()
    emit("session.created", {"model": CONFIG["model"], "tools": CONFIG.get("tools", []),
                             "files": staged, "skills": staged_skills})
    prompt = PROMPT
    if staged:
        listing = "\n".join(f"- {p}" for p in staged)
        prompt = f"Newly attached files ({len(staged)}) mounted at {UPLOADS_DIR}:\n{listing}\n\n{PROMPT}"

    sdk_session_id = RESUME_ID or None
    exhausted = False
    result_error = True
    try:
        sdk_session_id, subtype, is_error = await run_query(prompt, options(MAX_TURNS, sdk_session_id))
        exhausted = subtype == "error_max_turns"
        result_error = is_error and not exhausted
    except Exception as err:  # noqa: BLE001 — the runtime raises after error results
        if "error_max_turns" in str(err):
            exhausted = True
        else:
            raise

    if exhausted:
        # Guaranteed final answer (spec item 7): one wrap-up turn, then idle.
        emit("session.budget_exhausted", {"max_turns": MAX_TURNS})
        try:
            sdk_session_id, _subtype, wrap_error = await run_query(
                "Your turn budget is exhausted — provide your final answer now, "
                "based on the work you have completed so far.",
                options(1, sdk_session_id))
            result_error = bool(wrap_error)
        except Exception as err:  # noqa: BLE001 — a raise after the wrap-up answer is not a failure
            if "error_max_turns" not in str(err) and "returned an error result" not in str(err):
                raise
            result_error = False

    if result_error:
        post("/status", {"status": "failed"})
        return
    checkpoint_id = None
    try:
        collect_outputs()
        sync_memory_back()
        checkpoint_id = save_checkpoint()
    except Exception as err:  # noqa: BLE001 — a failed checkpoint must not fail the turn
        emit("session.checkpoint_failed", {"error": str(err)[:500]})
    post("/status", {"status": "idle", "sdkSessionId": sdk_session_id,
                     "checkpointFileId": checkpoint_id})
```

Delete the old inline `async for` loop and the `options = <LegacyOptions>(...)` block (the legacy runtime's options object) that this replaces. Keep the `__main__` guard unchanged.

- [ ] **Step 3: Syntax check**

Run: `python -m py_compile session-runner/runner.py` (any Python 3.10+; the file has no imports outside stdlib at module level except anyio which py_compile doesn't execute).
Expected: exit 0, no output.

- [ ] **Step 4: Console + docs defaults**

- `console/app/agents/agent-form.tsx`: change `maxTurns: String(initial?.max_turns ?? 10)` to `maxTurns: String(initial?.max_turns ?? 500)`.
- `CLAUDE.md`: update the two runner-image mentions from `dev7` to `dev8` (the components bullet "current `dev7`" and the run command `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev7`).

- [ ] **Step 5: Console build**

Run: `cd console && npx next build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add session-runner/runner.py console/app/agents/agent-form.tsx CLAUDE.md
git commit -m "feat(runner): platform preamble, 500-turn default, guaranteed wrap-up answer on turn exhaustion"
```

---

### Task 3: Markdown renderer

**Files:**
- Modify: `console/package.json` (via npm install)
- Create: `console/app/lib/markdown.tsx`
- Modify: `console/app/globals.css` (append `.md` block)

**Interfaces:**
- Produces: `Markdown({text}: {text: string})` client component — later tasks import it from `../../lib/markdown` (panels) and `../lib/markdown`.

- [ ] **Step 1: Install dependencies**

Run: `cd console && npm install react-markdown remark-gfm`
Expected: both added to `dependencies` in `console/package.json`.

- [ ] **Step 2: Create `console/app/lib/markdown.tsx`**

```tsx
"use client";
// Blueprint-styled markdown (spec 2026-07-09 sessions rework, item 4).
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 3: Append the `.md` block to `console/app/globals.css`**

```css
/* ── Markdown rendering (session transcripts, previews) ──────────── */
.md { font-size: 13.5px; line-height: 1.6; word-break: break-word; }
.md h1, .md h2, .md h3, .md h4 { font-family: var(--font-cond); text-transform: none;
  letter-spacing: 0; line-height: 1.25; margin: 14px 0 6px; }
.md h1 { font-size: 19px; } .md h2 { font-size: 16.5px; } .md h3 { font-size: 14.5px; } .md h4 { font-size: 13.5px; }
.md p { margin: 7px 0; }
.md ul, .md ol { margin: 7px 0; padding-left: 22px; }
.md li { margin: 3px 0; }
.md code { background: var(--paper); border: 1px solid var(--line); border-radius: 4px;
  padding: 1px 5px; font-size: 12px; }
.md pre { background: var(--paper); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px; overflow-x: auto; font-size: 12.5px; line-height: 1.5; margin: 8px 0; }
.md pre code { background: none; border: 0; padding: 0; }
.md blockquote { margin: 8px 0; padding: 2px 12px; border-left: 3px solid var(--edge); color: var(--muted); }
.md table { font-size: 12.5px; margin: 8px 0; box-shadow: none; }
.md th, .md td { padding: 6px 10px; }
.md a { color: var(--blue); text-decoration: underline; text-underline-offset: 2px; }
.md hr { border: 0; border-top: 1px solid var(--line); margin: 12px 0; }
```

- [ ] **Step 4: Build + commit**

Run: `cd console && npx next build` — expected PASS (module unused yet, that's fine).

```bash
git add console/package.json console/package-lock.json console/app/lib/markdown.tsx console/app/globals.css
git commit -m "feat(console): blueprint-styled markdown renderer (react-markdown + gfm)"
```

---

### Task 4: Live-session hook + transcript grouping (pure logic)

**Files:**
- Create: `console/app/sessions/[id]/use-session-live.ts`
- Create: `console/app/sessions/[id]/rows.ts`

**Interfaces:**
- Consumes: SSE contract from Task 1 (`message` = LiveEvent JSON; named `status` event `{status, tokens_in, tokens_out, turns}`; `end` only at terminal).
- Produces (Tasks 5–7 rely on these EXACT shapes):

```ts
// use-session-live.ts
export interface LiveEvent { seq: number; type: string; payload: any;
  tokens_in: number; tokens_out: number; duration_ms: number; created_at: string; }
export interface Totals { tokensIn: number; tokensOut: number; turns: number; }
export function useSessionLive(id: string, initial: { events: LiveEvent[]; status: string; totals: Totals }):
  { events: LiveEvent[]; status: string; totals: Totals; live: boolean; setStatus: (s: string) => void }

// rows.ts
export type RowKind = "user" | "agent" | "tool" | "system";
export interface Row { kind: RowKind; seq: number; title: string; preview?: string;
  error: boolean; tokensIn: number; tokensOut: number; durationMs: number;
  offsetMs: number; events: LiveEvent[]; }
export function groupEvents(events: LiveEvent[]): Row[]
export function rowText(r: Row): string          // searchable text (title + payload text)
export const offsetLabel: (ms: number) => string // "m:ss"
```

- [ ] **Step 1: Create `console/app/sessions/[id]/use-session-live.ts`**

```ts
"use client";
// One owner for all mutable session state (spec §2): events, status, totals.
// The SSE stream stays open through idle so resumes from anywhere appear live.
import { useEffect, useRef, useState } from "react";

export interface LiveEvent { seq: number; type: string; payload: any;
  tokens_in: number; tokens_out: number; duration_ms: number; created_at: string; }
export interface Totals { tokensIn: number; tokensOut: number; turns: number; }

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
        setTotals({ tokensIn: s.tokens_in, tokensOut: s.tokens_out, turns: s.turns });
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
```

- [ ] **Step 2: Create `console/app/sessions/[id]/rows.ts`**

```ts
// Pure transcript grouping (spec §3): consecutive tool activity collapses to
// one row; call/result pairs match by tool_use id with adjacency fallback.
import type { LiveEvent } from "./use-session-live";

export type RowKind = "user" | "agent" | "tool" | "system";
export interface Row { kind: RowKind; seq: number; title: string; preview?: string;
  error: boolean; tokensIn: number; tokensOut: number; durationMs: number;
  offsetMs: number; events: LiveEvent[]; }

export const offsetLabel = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

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

export function groupEvents(events: LiveEvent[]): Row[] {
  const rows: Row[] = [];
  let prevEnd = 0;                       // cumulative offset of the previous row's last event
  let tool: Row | null = null;           // open tool group
  const closeTool = () => { if (tool) { rows.push(tool); tool = null; } };

  const push = (r: Row) => { closeTool(); rows.push(r); };
  const rowBase = (e: LiveEvent): Pick<Row, "tokensIn" | "tokensOut" | "offsetMs" | "durationMs"> => ({
    tokensIn: e.tokens_in, tokensOut: e.tokens_out,
    offsetMs: e.duration_ms, durationMs: Math.max(0, e.duration_ms - prevEnd),
  });

  for (const e of events) {
    const end = e.duration_ms;
    if (e.type === "user") {
      push({ kind: "user", seq: e.seq, title: firstLine(e.payload?.text ?? ""), error: false, ...rowBase(e), events: [e] });
    } else if (e.type === "agent.message" || e.type === "agent.thinking") {
      push({ kind: "agent", seq: e.seq,
        title: (e.type === "agent.thinking" ? "(thinking) " : "") + firstLine(e.payload?.text ?? ""),
        error: false, ...rowBase(e), events: [e] });
    } else if (e.type === "tool.call") {
      if (!tool) tool = { kind: "tool", seq: e.seq, title: "", error: false,
        tokensIn: 0, tokensOut: 0, durationMs: 0, offsetMs: e.duration_ms, events: [] };
      tool.events.push(e);
      tool.tokensIn += e.tokens_in; tool.tokensOut += e.tokens_out;
    } else if (e.type === "tool.result") {
      if (tool) {
        tool.events.push(e);
        tool.tokensIn += e.tokens_in; tool.tokensOut += e.tokens_out;
        if (e.payload?.is_error) tool.error = true;
        tool.durationMs = Math.max(0, e.duration_ms - Math.max(prevEnd, tool.offsetMs) + (tool.offsetMs - prevEnd));
      } else {
        push({ kind: "system", seq: e.seq, title: "tool result", error: !!e.payload?.is_error, ...rowBase(e), events: [e] });
      }
    } else {
      push({ kind: "system", seq: e.seq,
        title: e.type.replace(/^session\./, ""), error: e.type === "session.failed", ...rowBase(e), events: [e] });
    }
    if (!tool || e.type !== "tool.call") prevEnd = end;
  }
  closeTool();

  // Titles for tool groups: "Bash", "Bash ×2", or "Read, Docs Rag Search".
  for (const r of rows) {
    if (r.kind !== "tool") continue;
    const calls = r.events.filter((e) => e.type === "tool.call");
    const names = [...new Set(calls.map((e) => String(e.payload?.tool ?? "tool")))];
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
```

- [ ] **Step 3: Build + commit**

Run: `cd console && npx next build` — expected PASS.

```bash
git add "console/app/sessions/[id]/use-session-live.ts" "console/app/sessions/[id]/rows.ts"
git commit -m "feat(console): session live-state hook and pure transcript grouping"
```

---

### Task 5: Header, side sheets, panels (+ CSS)

**Files:**
- Create: `console/app/sessions/[id]/header.tsx`, `console/app/sessions/[id]/panels.tsx`
- Modify: `console/app/globals.css` (append sheet/chip styles)

**Interfaces:**
- Consumes: `Totals` from Task 4; `Markdown` from Task 3; resources shape from Task 1 (`agent`, `environment`, `vault`, `inputFiles`, `outputFiles`, `memory`, `skills`, `tools`, `mcpServers`, `model`); `Row` from Task 4 (EventPanel).
- Produces (Task 7 composes these):

```ts
export type PanelId = "agent" | "env" | "files" | "outputs" | null;
// header.tsx
export function SessionHeader(props: { name: string; status: string; live: boolean;
  totals: Totals; durationMs: number; resources: any; busy: boolean;
  onInterrupt: () => void; onOpen: (p: Exclude<PanelId, null>) => void }): JSX.Element
// panels.tsx
export function SideSheet(props: { title: React.ReactNode; subtitle?: React.ReactNode;
  onClose: () => void; children: React.ReactNode }): JSX.Element
export function AgentPanel({ resources, onClose }): JSX.Element
export function EnvPanel({ resources, onClose }): JSX.Element
export function FilesPanel({ resources, onClose }): JSX.Element
export function OutputsPanel({ resources, onClose }): JSX.Element
export function EventPanel({ row, onClose }: { row: Row; onClose: () => void }): JSX.Element
```

- [ ] **Step 1: Create `console/app/sessions/[id]/header.tsx`**

```tsx
"use client";
// Screenshot-style session header: name + status + clickable meta chips.
import { Icon } from "../../lib/icons";
import type { Totals } from "./use-session-live";
import { offsetLabel } from "./rows";

export type PanelId = "agent" | "env" | "files" | "outputs" | null;

export function SessionHeader({ name, status, live, totals, durationMs, resources, busy, onInterrupt, onOpen }: {
  name: string; status: string; live: boolean; totals: Totals; durationMs: number;
  resources: any; busy: boolean; onInterrupt: () => void; onOpen: (p: Exclude<PanelId, null>) => void;
}) {
  const r = resources;
  const files = r?.inputFiles?.length ?? 0;
  const outputs = r?.outputFiles?.length ?? 0;
  const statusClass = ["completed", "idle"].includes(status) ? "Ready" : status === "failed" ? "Failed" : "Deploying";
  return (
    <div className="sv-titlebar">
      <div className="sv-title">
        <h1 style={{ fontSize: 24 }}>{name}</h1>
        <span className={`phase ${statusClass}`}>{status}{live && <span className="pulse" />}</span>
      </div>
      <div className="metachips">
        {r?.agent && (
          <button className="chipbtn" onClick={() => onOpen("agent")}>
            <Icon.agent /> {r.agent.name} <span className="muted">v{r.agent.version}</span>
          </button>
        )}
        <button className="chipbtn" onClick={() => onOpen("env")}>
          <Icon.env /> {r?.environment?.name ?? "default environment"}
        </button>
        <button className="chipbtn" onClick={() => onOpen("files")}>
          <Icon.file /> {files} file{files === 1 ? "" : "s"}{r?.memory ? ", memory store" : ""}
        </button>
        <button className="chipbtn" onClick={() => onOpen("outputs")}>
          <Icon.download /> {outputs} output{outputs === 1 ? "" : "s"}
        </button>
        <span className="chip">{offsetLabel(durationMs)}</span>
        <span className="chip">{totals.tokensIn.toLocaleString()} / {totals.tokensOut.toLocaleString()} tok</span>
        {live && <button className="ghost danger" disabled={busy} onClick={onInterrupt}>■ Interrupt</button>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `console/app/sessions/[id]/panels.tsx`**

```tsx
"use client";
// Right slide-over sheets: agent / environment / files / outputs / event detail.
import Link from "next/link";
import { useEffect, useState } from "react";
import { wsHeader } from "../../lib/client";
import { Markdown } from "../../lib/markdown";
import type { Row } from "./rows";

const fmtSize = (n: number) =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

export function SideSheet({ title, subtitle, onClose, children }: {
  title: React.ReactNode; subtitle?: React.ReactNode; onClose: () => void; children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <aside className="sheet">
      <div className="sheet-head">
        <div>
          <h2 className="sheet-title">{title}</h2>
          {subtitle && <div className="sub" style={{ margin: "2px 0 0" }}>{subtitle}</div>}
        </div>
        <button className="iconbtn" title="Close" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="sheet-body">{children}</div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (<div className="sheet-sec"><h3>{title}</h3>{children}</div>);
}

export function AgentPanel({ resources, onClose }: { resources: any; onClose: () => void }) {
  const a = resources?.agent;
  const mcp = resources?.mcpServers ? Object.keys(resources.mcpServers) : [];
  return (
    <SideSheet onClose={onClose}
      title={<>{a?.name} <span className="chip">v{a?.version}</span></>}
      subtitle={<><code>{a?.id}</code> · <Link className="linkbtn" href={`/agents/${a?.id}`}>Go to agent →</Link></>}>
      <Section title="Model"><code>{resources?.model ?? "—"}</code></Section>
      <Section title="System prompt">
        <pre className="block" style={{ maxHeight: 320 }}>{a?.systemPrompt || "—"}</pre>
      </Section>
      <Section title="Limits">max turns {a?.maxTurns ?? "—"}</Section>
      <Section title={`Tools (${resources?.tools?.length ?? 0})`}>
        {resources?.tools?.length
          ? resources.tools.map((t: string) => <span key={t} className="tool">{t}</span>)
          : <span className="muted">none</span>}
        {mcp.length > 0 && <div style={{ marginTop: 6 }}>{mcp.map((m) => <span key={m} className="pill">mcp: {m}</span>)}</div>}
      </Section>
      <Section title={`Skills (${resources?.skills?.length ?? 0})`}>
        {resources?.skills?.length
          ? resources.skills.map((s: any) => <span key={s.id} className="tool">{s.name}</span>)
          : <span className="muted">none</span>}
      </Section>
    </SideSheet>
  );
}

export function EnvPanel({ resources, onClose }: { resources: any; onClose: () => void }) {
  const env = resources?.environment;
  return (
    <SideSheet onClose={onClose} title={env?.name ?? "Default environment"}
      subtitle={env && <><code>{env.id}</code> · <Link className="linkbtn" href="/environments">Go to environments →</Link></>}>
      <Section title="Networking">
        <div className="row"><span className="muted">Type</span><span>{env ? "Limited" : "Unrestricted (no environment)"}</span></div>
        <div className="row"><span className="muted">Packages</span><span>{env?.allow_package_managers ? "Enabled" : "Disabled"}</span></div>
        {env && (
          <div style={{ marginTop: 6 }}>
            {env.allowed_hosts?.length
              ? env.allowed_hosts.map((h: string) => <span key={h} className="chip" style={{ marginRight: 6, marginBottom: 4 }}><code>{h}</code></span>)
              : <span className="muted">all outbound blocked</span>}
          </div>
        )}
      </Section>
      <Section title="Credentials">
        {resources?.vault ? <span className="pill">vault: {resources.vault.name}</span> : <span className="muted">no vault</span>}
      </Section>
      <Section title="Memory">
        {resources?.memory
          ? <Link className="linkbtn" href={`/memory-stores/${resources.memory.id}`}>{resources.memory.name}</Link>
          : <span className="muted">none</span>}
      </Section>
    </SideSheet>
  );
}

export function FilesPanel({ resources, onClose }: { resources: any; onClose: () => void }) {
  const files = resources?.inputFiles ?? [];
  return (
    <SideSheet onClose={onClose} title={`Input files (${files.length})`}>
      {files.length ? files.map((f: any) => (
        <div key={f.id} className="row">
          <a className="linkbtn" href={`/api/v1/files/${f.id}/content`}>{f.name}</a>
          <span className="muted">{fmtSize(Number(f.size))}</span>
        </div>
      )) : <span className="muted">no input files attached</span>}
      {resources?.memory && (
        <Section title="Memory store">
          <Link className="linkbtn" href={`/memory-stores/${resources.memory.id}`}>{resources.memory.name}</Link>
        </Section>
      )}
    </SideSheet>
  );
}

export function OutputsPanel({ resources, onClose }: { resources: any; onClose: () => void }) {
  const files = resources?.outputFiles ?? [];
  const [sel, setSel] = useState<any | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  async function open(f: any) {
    setSel(f); setPreview(null);
    if (Number(f.size) < 262144) {
      try {
        const res = await fetch(`/api/v1/files/${f.id}/content`, { headers: wsHeader() });
        if (res.ok) setPreview(await res.text());
      } catch { /* preview is best-effort */ }
    }
  }
  return (
    <SideSheet onClose={onClose} title={`Output files (${files.length})`}>
      {files.length === 0 && <span className="muted">produced during the run — none yet</span>}
      {files.map((f: any) => (
        <div key={f.id} className="row" style={{ cursor: "pointer" }} onClick={() => open(f)}>
          <span className={sel?.id === f.id ? "linkbtn" : ""}>{f.name}</span>
          <span className="muted">{fmtSize(Number(f.size))}</span>
        </div>
      ))}
      {sel && (
        <Section title={sel.name}>
          <div className="sub" style={{ margin: "0 0 8px" }}>
            {fmtSize(Number(sel.size))} · <a className="linkbtn" href={`/api/v1/files/${sel.id}/content`} download>Download</a>
          </div>
          {preview != null
            ? sel.name.toLowerCase().endsWith(".md")
              ? <Markdown text={preview} />
              : <pre className="block" style={{ maxHeight: 300 }}>{preview}</pre>
            : <span className="muted">no inline preview (large or binary)</span>}
        </Section>
      )}
    </SideSheet>
  );
}

export function EventPanel({ row, onClose }: { row: Row; onClose: () => void }) {
  const [view, setView] = useState<"rendered" | "raw">("rendered");
  const text = row.events.map((e) =>
    typeof e.payload?.text === "string" ? e.payload.text :
    typeof e.payload?.output === "string" ? e.payload.output : "").filter(Boolean).join("\n\n");
  return (
    <SideSheet onClose={onClose} title={row.title || row.kind}
      subtitle={`${row.events.length} event${row.events.length === 1 ? "" : "s"} · ${row.tokensIn}/${row.tokensOut} tok · ${(row.durationMs / 1000).toFixed(1)}s`}>
      <div className="tabs" style={{ margin: "0 0 10px" }}>
        <button className={view === "rendered" ? "active" : ""} onClick={() => setView("rendered")}>Rendered</button>
        <button className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}>Raw</button>
      </div>
      {view === "rendered"
        ? (text ? <Markdown text={text} /> : <span className="muted">no text content — see Raw</span>)
        : row.events.map((e) => (
            <div key={e.seq} style={{ marginBottom: 10 }}>
              <div className="detail-meta">seq {e.seq} · {e.type}</div>
              <pre className="block" style={{ maxHeight: 260 }}>{JSON.stringify(e.payload, null, 2)}</pre>
            </div>
          ))}
    </SideSheet>
  );
}
```

- [ ] **Step 3: Append side-sheet CSS to `console/app/globals.css`**

```css
/* ── Session view: title, meta chips, slide-over sheets ──────────── */
.sv-titlebar { display: flex; flex-direction: column; gap: 10px; margin-bottom: 4px; }
.sv-title { display: flex; align-items: center; gap: 12px; }
.metachips { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.chipbtn { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; padding: 4px 11px;
  background: var(--panel); color: var(--ink); border: 1px solid var(--edge); border-radius: 6px;
  font-weight: 500; box-shadow: 0 1px 2px rgba(15,32,56,.06); }
.chipbtn:hover { border-color: var(--blue); color: var(--blue); background: var(--panel); }
.chipbtn svg { width: 13px; height: 13px; }

.sheet { position: fixed; top: 0; right: 0; bottom: 0; width: 480px; max-width: 92vw; z-index: 25;
  background: var(--panel); border-left: 1px solid var(--edge);
  box-shadow: -18px 0 40px -24px rgba(15,32,56,.4); display: flex; flex-direction: column; }
.sheet-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;
  padding: 16px 18px 12px; border-bottom: 1px solid var(--line); }
.sheet-title { margin: 0; font-family: var(--font-cond); font-size: 18px; font-weight: 600;
  text-transform: none; letter-spacing: .01em; }
.sheet-body { padding: 14px 18px; overflow-y: auto; }
.sheet-sec { margin-bottom: 16px; }
.sheet-sec h3 { margin: 0 0 8px; font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
  font-family: var(--font-mono); color: var(--muted); font-weight: 600; }
.sheet-sec .row { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; padding: 3px 0; }
.sheet .tool, .sheet .pill { display: inline-block; font-size: 11.5px; padding: 2px 8px; margin: 0 4px 4px 0;
  border: 1px solid var(--line); border-radius: 5px; background: var(--paper); font-family: var(--font-mono); }
.sheet .pill { color: var(--mcp); border-color: color-mix(in srgb, var(--mcp) 40%, var(--line)); }
```

- [ ] **Step 4: Build + commit**

Run: `cd console && npx next build` — expected PASS.

```bash
git add "console/app/sessions/[id]/header.tsx" "console/app/sessions/[id]/panels.tsx" console/app/globals.css
git commit -m "feat(console): session header chips and slide-over resource panels"
```

---

### Task 6: Transcript rows, Debug list, timeline (+ CSS)

**Files:**
- Create: `console/app/sessions/[id]/transcript.tsx`, `console/app/sessions/[id]/timeline.tsx`
- Modify: `console/app/globals.css` (append row/timeline styles)

**Interfaces:**
- Consumes: `Row`, `groupEvents`, `rowText`, `offsetLabel` (Task 4); `LiveEvent` (Task 4).
- Produces (Task 7 composes):

```ts
// transcript.tsx
export type EventFilter = "all" | "agent" | "tool" | "error" | "system";
export function filterRows(rows: Row[], filter: EventFilter, search: string): Row[]
export function Transcript({ rows, selectedSeq, onSelect }): JSX.Element
export function DebugList({ events, search, selectedSeq, onSelect }): JSX.Element
// timeline.tsx
export function Timeline({ rows, selectedSeq, onSelect }): JSX.Element
```

- [ ] **Step 1: Create `console/app/sessions/[id]/transcript.tsx`**

```tsx
"use client";
// Compact screenshot-style transcript rows + raw Debug list.
import type { LiveEvent } from "./use-session-live";
import { type Row, rowText, offsetLabel } from "./rows";

export type EventFilter = "all" | "agent" | "tool" | "error" | "system";

export function filterRows(rows: Row[], filter: EventFilter, search: string): Row[] {
  const q = search.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === "agent" && !(r.kind === "agent" || r.kind === "user")) return false;
    if (filter === "tool" && r.kind !== "tool") return false;
    if (filter === "error" && !r.error) return false;
    if (filter === "system" && r.kind !== "system") return false;
    if (q && !rowText(r).includes(q)) return false;
    return true;
  });
}

const CHIP: Record<Row["kind"], string> = { user: "User", agent: "Agent", tool: "Tool", system: "Sys" };

export function Transcript({ rows, selectedSeq, onSelect }: {
  rows: Row[]; selectedSeq: number | null; onSelect: (seq: number) => void;
}) {
  if (!rows.length) return <div className="empty">Waiting for the first event…</div>;
  return (
    <div className="trows">
      {rows.map((r) => (
        <div key={r.seq} className={`trow ${r.kind} ${selectedSeq === r.seq ? "sel" : ""}`} onClick={() => onSelect(r.seq)}>
          <span className={`trow-chip ${r.kind}`}>{CHIP[r.kind]}</span>
          <span className="trow-title">
            {r.title || <span className="muted">—</span>}
            {r.preview && <span className="trow-preview"> {r.preview}</span>}
          </span>
          <span className="trow-meta">
            {r.error && <span className="phase bad">Error</span>}
            {(r.tokensIn > 0 || r.tokensOut > 0) && <span>{r.tokensIn.toLocaleString()}/{r.tokensOut.toLocaleString()}</span>}
            {r.durationMs > 0 && <span>{(r.durationMs / 1000).toFixed(1)}s</span>}
            <span className="muted">{offsetLabel(r.offsetMs)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function DebugList({ events, search, selectedSeq, onSelect }: {
  events: LiveEvent[]; search: string; selectedSeq: number | null; onSelect: (seq: number) => void;
}) {
  const q = search.trim().toLowerCase();
  const list = q
    ? events.filter((e) => (e.type + " " + JSON.stringify(e.payload ?? {})).toLowerCase().includes(q))
    : events;
  return (
    <div className="trows">
      {list.map((e) => (
        <div key={e.seq} className={`trow system ${selectedSeq === e.seq ? "sel" : ""}`} onClick={() => onSelect(e.seq)}>
          <span className="trow-chip system">{e.seq}</span>
          <span className="trow-title"><code>{e.type}</code>
            <span className="trow-preview"> {JSON.stringify(e.payload ?? {}).slice(0, 160)}</span></span>
          <span className="trow-meta"><span className="muted">{offsetLabel(e.duration_ms)}</span></span>
        </div>
      ))}
      {list.length === 0 && <div className="empty">No events match.</div>}
    </div>
  );
}
```

- [ ] **Step 2: Create `console/app/sessions/[id]/timeline.tsx`**

```tsx
"use client";
// Segmented duration bar: one segment per transcript row, width ∝ duration.
import type { Row } from "./rows";

const COLOR: Record<Row["kind"], string> = {
  user: "var(--accent)", agent: "var(--blue)", tool: "#8a63d2", system: "var(--muted)",
};

export function Timeline({ rows, selectedSeq, onSelect }: {
  rows: Row[]; selectedSeq: number | null; onSelect: (seq: number) => void;
}) {
  if (!rows.length) return null;
  const total = Math.max(1, rows.reduce((s, r) => s + Math.max(r.durationMs, 1), 0));
  return (
    <div className="timeline" title="session timeline">
      {rows.map((r) => (
        <span key={r.seq} onClick={() => onSelect(r.seq)}
          className={selectedSeq === r.seq ? "sel" : ""}
          style={{ flexBasis: `${Math.max(1.5, (Math.max(r.durationMs, 1) / total) * 100)}%`,
                   background: COLOR[r.kind] }}
          title={`${r.title} · ${(r.durationMs / 1000).toFixed(1)}s`} />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Append row/timeline CSS to `console/app/globals.css`**

```css
/* ── Session transcript rows ─────────────────────────────────────── */
.trows { display: flex; flex-direction: column; border: 1px solid var(--edge); border-radius: 10px;
  background: var(--panel); overflow: hidden; }
.trow { display: flex; align-items: center; gap: 12px; padding: 9px 14px; cursor: pointer;
  border-bottom: 1px solid var(--line); font-size: 13.5px; }
.trow:last-child { border-bottom: 0; }
.trow:hover { background: var(--hover); }
.trow.sel { background: var(--hover); box-shadow: inset 2px 0 0 var(--accent); }
.trow-chip { flex: none; width: 46px; text-align: center; font-family: var(--font-mono); font-size: 10.5px;
  font-weight: 600; padding: 2px 0; border-radius: 5px; border: 1px solid var(--line);
  color: var(--muted); background: var(--paper); }
.trow-chip.user { color: #fff; background: var(--accent); border-color: var(--accent); }
.trow-chip.agent { color: #fff; background: var(--blue); border-color: var(--blue); }
.trow-chip.tool { color: #6a49b8; background: color-mix(in srgb, #8a63d2 12%, transparent);
  border-color: color-mix(in srgb, #8a63d2 45%, var(--line)); }
.trow-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.trow-preview { color: var(--muted); font-family: var(--font-mono); font-size: 12px; }
.trow-meta { flex: none; display: flex; gap: 12px; align-items: center; font-family: var(--font-mono);
  font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }

/* Timeline: row-grouped segments (replaces the per-event sliver strip) */
.timeline span { opacity: .55; border-radius: 2px; cursor: pointer; }
.timeline span:hover, .timeline span.sel { opacity: 1; }
.timeline span.sel { outline: 2px solid var(--ink); outline-offset: 1px; }
```

- [ ] **Step 4: Build + commit**

Run: `cd console && npx next build` — expected PASS.

```bash
git add "console/app/sessions/[id]/transcript.tsx" "console/app/sessions/[id]/timeline.tsx" console/app/globals.css
git commit -m "feat(console): transcript rows, debug list, duration-proportional timeline"
```

---

### Task 7: Composition — rewrite trace.tsx, wire page.tsx, retire old styles

**Files:**
- Rewrite: `console/app/sessions/[id]/trace.tsx`
- Modify: `console/app/sessions/[id]/page.tsx`, `console/app/globals.css` (delete dead blocks)

**Interfaces:**
- Consumes: everything from Tasks 3–6 with the exact names/props defined there.
- Produces: `SessionView({ session, resources, initialEvents })` — the only export `page.tssx` needs.

- [ ] **Step 1: Rewrite `console/app/sessions/[id]/trace.tsx`**

```tsx
"use client";
// Composition root for the session view (spec 2026-07-09 sessions rework).
import { useMemo, useState } from "react";
import { wsHeader } from "../../lib/client";
import { useSessionLive, type LiveEvent, type Totals } from "./use-session-live";
import { groupEvents } from "./rows";
import { SessionHeader, type PanelId } from "./header";
import { AgentPanel, EnvPanel, FilesPanel, OutputsPanel, EventPanel } from "./panels";
import { Transcript, DebugList, filterRows, type EventFilter } from "./transcript";
import { Timeline } from "./timeline";

interface Session {
  id: string; name: string | null; status: string; prompt: string;
  agent_version: number; tokens_in: string; tokens_out: string; turns: number;
  memory_store_id: string | null; created_at: string;
}

export function SessionView({ session: s0, resources, initialEvents }:
  { session: Session; resources: any; initialEvents: LiveEvent[] }) {
  const initialTotals: Totals = {
    tokensIn: Number(s0.tokens_in), tokensOut: Number(s0.tokens_out), turns: Number(s0.turns),
  };
  const { events, status, totals, live, setStatus } =
    useSessionLive(s0.id, { events: initialEvents, status: s0.status, totals: initialTotals });

  const [panel, setPanel] = useState<PanelId>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [tab, setTab] = useState<"transcript" | "debug">("transcript");
  const [filter, setFilter] = useState<EventFilter>("all");
  const [search, setSearch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Legacy sessions (pre user-events) get a synthetic first row from s0.prompt.
  const allEvents = useMemo<LiveEvent[]>(() => {
    if (events.some((e) => e.type === "user")) return events;
    const legacy: LiveEvent = { seq: 0, type: "user", payload: { text: s0.prompt, turn: 0 },
      tokens_in: 0, tokens_out: 0, duration_ms: 0, created_at: s0.created_at };
    return [legacy, ...events];
  }, [events, s0.prompt, s0.created_at]);

  const rows = useMemo(() => groupEvents(allEvents), [allEvents]);
  const visible = useMemo(() => filterRows(rows, filter, search), [rows, filter, search]);
  const selectedRow = selectedSeq != null ? rows.find((r) => r.seq === selectedSeq) ?? null : null;
  const durationMs = events.at(-1)?.duration_ms ?? 0;

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
      const res = await fetch(`/api/v1/sessions/${s0.id}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json", ...wsHeader() },
        body: JSON.stringify({ prompt }),
      });
      if (res.ok) { setPrompt(""); setStatus("queued"); }  // events + status arrive via SSE
      else setError(`Send failed: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  }

  return (
    <div className="sv">
      <SessionHeader name={s0.name ?? s0.id} status={status} live={live} totals={totals}
        durationMs={durationMs} resources={resources} busy={busy}
        onInterrupt={interrupt} onOpen={openPanel} />

      <div className="sv-toolbar">
        <div className="tabs" style={{ margin: 0, borderBottom: 0 }}>
          <button className={tab === "transcript" ? "active" : ""} onClick={() => setTab("transcript")}>Transcript</button>
          <button className={tab === "debug" ? "active" : ""} onClick={() => setTab("debug")}>Debug</button>
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value as EventFilter)}>
          <option value="all">All events</option>
          <option value="agent">Agent messages</option>
          <option value="tool">Tool calls</option>
          <option value="error">Errors</option>
          <option value="system">System</option>
        </select>
        <input type="search" placeholder="Search transcript…" value={search}
          onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
      </div>

      <Timeline rows={visible} selectedSeq={selectedSeq} onSelect={selectRow} />

      {tab === "transcript"
        ? <Transcript rows={visible} selectedSeq={selectedSeq} onSelect={selectRow} />
        : <DebugList events={allEvents} search={search} selectedSeq={selectedSeq} onSelect={selectRow} />}

      {status === "idle" && (
        <div className="sv-input">
          <input type="text" placeholder="Send a follow-up message (resumes the session)…"
            value={prompt} onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && send()} />
          <button disabled={busy || !prompt.trim()} onClick={send}>{busy ? "Sending…" : "Send ▸"}</button>
          {error && <span className="modal-error" style={{ margin: 0 }}>{error}</span>}
        </div>
      )}
      {error && status !== "idle" && <span className="modal-error" style={{ margin: 0 }}>{error}</span>}

      {panel === "agent" && <AgentPanel resources={resources} onClose={closeAll} />}
      {panel === "env" && <EnvPanel resources={resources} onClose={closeAll} />}
      {panel === "files" && <FilesPanel resources={resources} onClose={closeAll} />}
      {panel === "outputs" && <OutputsPanel resources={resources} onClose={closeAll} />}
      {selectedRow && <EventPanel row={selectedRow} onClose={closeAll} />}
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `console/app/sessions/[id]/page.tsx`**

```tsx
import Link from "next/link";
import { SessionView } from "./trace";
import { wsGet } from "../../lib/api";

export const dynamic = "force-dynamic";

export default async function SessionDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [session, { events }, resources] = await Promise.all([
    wsGet<any>(`/v1/sessions/${id}`),
    wsGet<{ events: any[] }>(`/v1/sessions/${id}/events`),
    wsGet<any>(`/v1/sessions/${id}/resources`).catch(() => null),
  ]);
  return (
    <>
      <div className="crumbs"><Link href="/sessions">Sessions</Link> / <code>{session.id}</code></div>
      <SessionView session={session} resources={resources} initialEvents={events} />
    </>
  );
}
```

- [ ] **Step 3: Retire dead CSS**

In `console/app/globals.css` delete the now-unused blocks (verify each with a grep over `console/app` first — delete only selectors with zero remaining JSX users):
- `.sv-head` rule (replaced by `.sv-titlebar`).
- `.msg`, `.msg:hover`, `.msg.sel`, `.msg.user/.agent/.tool/.system`, `.msg-role`, `.msg-meta`, `.msg-body`, `.msg .muted` (replaced by `.trow*`).
- `.detail`, `.detail-head`, `.detail .rendered` (replaced by `.sheet*`) — KEEP `.detail-meta` (used by `EventPanel`).
- `.stream` (replaced by `.trows`).
Keep `.sv`, `.pulse`, `.timeline` (restyled), `.sv-input`, `.res-grid`/`.res` ONLY if another page still uses them — grep `res-grid` (the old session page was its only user; if so, delete `.res-grid`/`.res` too but keep `.res .tool/.pill` equivalents already duplicated under `.sheet`).
Add the toolbar rule:

```css
.sv-toolbar { display: flex; gap: 10px; align-items: center; }
.sv-toolbar select { font-size: 12.5px; }
```

- [ ] **Step 4: Build + grep gates**

Run: `cd console && npx next build`
Expected: PASS.
Run: `grep -rnE "confirm\(|prompt\(|alert\(" console/app` → zero hits (the `prompt` STATE variable and `placeholder` strings don't match the call-paren pattern; verify).

- [ ] **Step 5: Commit**

```bash
git add "console/app/sessions/[id]/trace.tsx" "console/app/sessions/[id]/page.tsx" console/app/globals.css
git commit -m "feat(console): screenshot-fidelity session view — composed transcript, panels, live updates"
```

---

### Task 8: Build dev8, live verification sweep, docs

**Files:**
- Modify: `CLAUDE.md` (verify dev8 mentions from Task 2; add sessions conventions line)

- [ ] **Step 1: Build the runner image**

Run: `docker build -t devproof/session-runner:dev8 session-runner/`
Expected: image builds (the directory contains the Dockerfile used for dev7).

- [ ] **Step 2: Backend full suite (control plane stopped)**

Stop anything on :7080 first, then: `cd control-plane && npm test && npx tsc --noEmit`
Expected: all pass. (Known flake: gatewayUsage ECONNRESET = dropped Postgres tunnel — `kubectl rollout restart deployment/postgres -n devproof-system`, retry.)

- [ ] **Step 3: Start the stack with dev8**

- Control plane (from `control-plane/`): `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev8 DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files npx tsx src/main.ts` (background).
- Operator (from `operator/`): `DEVPROOF_CONTROL_PLANE_URL=http://localhost:7080 ~/sdk/go/bin/go run ./cmd` (background) — only needed if a model must deploy; `qwen05b-dp` usually exists.
- Console: `cd console && npx next build && npx next start -p 7090` (background).

- [ ] **Step 4: Live walk (browser, on a real session)**

1. Create an agent (defaults show max turns 500) and a session against `qwen05b-dp` with a short prompt. On the session page: the prompt appears as a `User` row immediately (before the pod even runs).
2. Watch live: tool rows appear and group; the status chip pulses; token totals tick via the `status` SSE event; NO manual refresh at any point.
3. When idle: send a follow-up — the `User` row appears instantly, agent events stream in (item 6 fixed). Open the same session in a second tab BEFORE sending another follow-up: both tabs update.
4. Click a row → EventPanel: Rendered shows markdown (ask the agent to "reply in markdown with a table" to have real material); Raw shows JSON. Escape closes.
5. Click all four header chips: agent panel (system prompt shows the AGENT prompt — the platform preamble is runner-side and NOT in the stored config; verify the panel matches the agent form), env, files, outputs (upload a small `.md` output via a prompt like "write a markdown report to /mnt/session/outputs/report.md" → preview renders).
6. Turn budget: create a throwaway agent with max turns 2, prompt something tool-heavy ("list files in 5 different directories one per turn"). Watch: `session.budget_exhausted` appears in Debug, then a final agent message (wrap-up answer), session ends **idle**, not failed.
7. Filter dropdown (Errors shows only error rows), search box narrows rows, Debug tab lists raw events.
8. Timeline segments: widths differ, click scrolls/selects.
9. Old session (created before this branch): page renders with the legacy prompt row.
10. `grep -rnE "confirm\(|prompt\(|alert\(" console/app` → zero hits.

- [ ] **Step 5: CLAUDE.md conventions line**

Confirm Task 2's dev7→dev8 edits are present. In Conventions & gotchas, extend the Dialogs/UI bullet with:

```markdown
- **Session view:** `trace.tsx` only composes — state lives in `use-session-live.ts` (SSE stays open through idle; never `router.refresh()`), grouping in `rows.ts`, panels in `panels.tsx`. Every prompt is a `user` event (routes append it before the pod starts). The runner injects `PLATFORM_PROMPT_20260709` + wrap-up turn; runner changes bump the image tag.
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: session-view conventions; runner dev8"
```

---

## Self-Review (done at plan time)

- **Spec coverage:** §1 backend/runner → Tasks 1–2; §2 hook → Task 4; §3 layout/markdown/panels/tabs/filter/search/timeline → Tasks 3, 5, 6, 7; §4 rollout/testing → Task 8; items 1–7 each traceable (1→T5-7, 2→T5 header gap, 3→T1+T4, 4→T3+T5, 5→T2, 6→T1+T7, 7→T2). Out-of-scope list respected.
- **Type consistency:** `LiveEvent`/`Totals`/`Row`/`PanelId`/`EventFilter` defined once (T4/T5/T6) and imported by name everywhere; `SessionView({session, resources, initialEvents})` matches page.tsx; `offsetLabel` exported from rows.ts and used by header/transcript.
- **Placeholders:** none — full code in every create step; modify steps quote exact lines.
