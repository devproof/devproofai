# Agent delegation (subagents) — design

Date: 2026-07-17. Status: approved.

An agent can push work to another agent. Subagents are configured per agent
version (like MCP servers), the session agent invokes them via a typed tool,
the work runs as a full first-class session of the target agent, and the
parent's trace shows the call with a **Subagent** badge.

## Decisions (user-approved)

- **Synchronous**: the parent's turn blocks on the tool call; the subagent's
  result comes back into the parent's context.
- **Full session**: the delegate call creates a real session for the target
  agent — own pod, own environment/egress, own routing/model, own token/cost
  attribution, visible in the sessions list, linked to the parent.
- **One level only**: a session spawned by delegation gets no delegate
  capability at all. Cycles are structurally impossible.
- **Text + files back**: the tool result carries the subagent's final answer
  text; its output files are downloaded into the parent pod under
  `/mnt/session/subagents/<agent-name>/` so the parent can build on them.
- **Mechanism** (rev 2026-07-17b, after the Devproof Agent SDK replaced the
  vendor CLI — commit c00feeb): an in-process **`Delegate` tool** in the
  runner, injected through a new `AgentOptions.extra_tools` seam in
  `devproof_agent_sdk` (mirrors how `query()` injects the Skill tool). The
  executor calls control-plane runner-facing endpoints. No new infra, no
  egress changes; the schema is GBNF-safe by construction (enum + strings,
  no pattern/maxLength).

## MCP/egress invariant (verified)

Each agent only ever accesses its own configured MCP servers. The child runs
from the target agent's version (its own `mcp_servers`, vault, environment,
Squid allowlist); nothing of the parent's MCP config leaks in or out. The
Delegate tool is not a network MCP server — no URL, no `mcp_servers` entry,
no Squid/NetworkPolicy change; its only traffic is runner→CP, the same path
as the existing event/status/file callbacks.

## Config & data model

- **Migration `041_subagents.sql`**:
  - `agent_versions.subagents JSONB NOT NULL DEFAULT '[]'` — array of
    `{agent_id, instructions}`. `instructions` = free-text "when to use".
  - `sessions.parent_session_id TEXT NULL` + index. Plain TEXT, no FK (ids
    are opaque; workspace-delete drains sessions batch-wise; a dangling
    parent id renders as plain text).
  - Guards must survive `migrate()` re-running every file each boot
    (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, per repo convention).
- **`AgentConfig.subagents: {agentId, instructions}[]`** (`repo.ts`), rides
  the existing agent create/version payloads; returned in version detail.
- **Validation** (`agents-api.ts`, like `validateMcpServers`): each
  referenced agent exists in the same workspace, is not the agent itself;
  instructions required, length-capped. Config is a snapshot: it pins the
  target *agent*; delegation runs the target's latest version at call time
  (same as a normal session start). An agent disabled after being configured
  fails at call time with a clear error — it is not silently dropped.

## System prompt

Not stored — generated at launch. The runner appends a "Delegation" block
after the agent's system prompt: each subagent's name + instructions, plus
how to call the tool. Generated from structured config so renaming/removing
a subagent never leaves stale prompt text. (Platform-prompt rules apply:
never the word "Claude".)

## Console

- **Agent form** (`agent-form.tsx`): "Subagents" section styled like the MCP
  servers rows — dropdown of the workspace's active agents (excluding the
  agent being edited) + instructions input + remove button. Shown on the
  agent detail page like MCP servers.
- **Session trace** (rev 2026-07-17b): `rows.ts` rewrites the row kind for
  `Delegate` tool groups (exact precedent: the Skill-tool kind rewrite,
  `rows.ts:125-137`) → new `RowKind` "subagent", chip label **"Subagent"**
  with its own style; `timeline.tsx` COLOR + `filterRows`' tool filter
  include it. The event panel shows target agent, prompt, and a link to the
  child session id (parsed from the tool result header). The child session
  header shows a "spawned by `sesn_…`" link back. No sessions-list changes.

## Runtime flow

**CP → runner config.** At launch the CP resolves the version's subagents
into `DEVPROOF_AGENT_CONFIG.subagents: [{name, agent_id, instructions}]`
(name = target's current name, for prompt + tool enum). For sessions with
`parent_session_id` set, the CP omits `subagents` entirely — the one-level
rule enforced structurally (child pod never has the tool).

**Runner-facing endpoints** (authorized like existing runner callbacks;
turn-attributed like status posts — stale `turn` ⇒ rejected, dev23 guard):

- `POST /v1/sessions/:id/delegate` — body
  `{turn, agent_id, prompt, files: [file ids]}`. Validates: session
  in-flight, has no parent (defense in depth), `agent_id` in the session's
  version subagents, target agent active, workspace active. Creates the
  child through the same internals as `createSessionAction` (user event,
  `attachSessionFiles(input)`, `renderMcpServers`, `gatedLaunch`) with
  `parent_session_id` set; returns the child id. Fail-fast 409 on failed
  deployment and launch-gate parking apply unchanged.
- `GET /v1/sessions/:id/delegate/:childId` — poll target:
  `{status, resultText, outputs, failureDetail}`; `resultText` = the child's
  last `agent.message` event; `outputs` = its output-role files.

**SDK seam** (rev 2026-07-17b — the runner now drives the in-house
`devproof_agent_sdk`, commit c00feeb): `AgentOptions.extra_tools: list` —
fully-formed `Tool` instances the caller injects; `query()` merges them into
the toolbox after `select_builtins` (the Skill tool already establishes the
injected-tool pattern). Generic seam, no delegation knowledge in the SDK.

**Runner** (image tag → **dev37**; current dev36). When `subagents` is
non-empty:

- Append the Delegation block to the system prompt; pass
  `extra_tools=[delegate_tool()]` — a `Tool(name="Delegate", …)` whose
  executor is `run_delegate(input, cwd) -> (text, is_error)`. Wrap-up turns
  (`no_tools=True`) pass `extra_tools=[]`, so the tool-less contract holds.
- Tool schema: `agent` (enum of configured names), `prompt` (string),
  `files` (optional array of pod-local paths). GBNF-safe (no
  pattern/maxLength).
- Executor: upload each listed local file via existing `POST /v1/files/raw`
  (kind `upload`) → ids; POST delegate; poll ~3s until terminal; on success
  download child outputs to `/mnt/session/subagents/<name>/`; return result
  with a compact JSON header FIRST (child session id + staged paths), answer
  text after — the SDK's `_cap_result` truncates tool results to
  window-chars in history and the runner's event mapping truncates non-str
  content, so the header must never be cut. Blocking urllib runs via
  `anyio.to_thread` and polls via `anyio.sleep` — the SDK loop shares the
  event loop with the MCP/httpx clients. Multiple Delegate calls in one
  assistant message run sequentially (the SDK executes tool_use blocks in
  order); each still spawns its own child. No runner-side timeout — the
  parent pod's `activeDeadlineSeconds` is the bound.

**Verified SDK mechanics** (devproof_agent_sdk, in-repo): `Tool` is a
dataclass with async `executor(input, cwd) -> (output_text, is_error)`
(`tools/base.py:10-20`); `query()` builds its toolbox from built-in names +
injected tools and yields type-blind `ToolUseBlock`/`ToolResultBlock`
messages (`query.py:102-124, 254-278`); the runner maps those to
`tool.call`/`tool.result` events (`runner.py:293-320`), so the call lands in
the trace under the tool name `Delegate`.

## Child continuation (amendment 2026-07-17b, user decision)

Live evidence (sesn_f9wt5i29cq6d): children on some models end their turn
without delivering ("announce-then-stop"); the parent's only recovery was a
from-scratch re-delegation at full cost (observed: 3 children for one task).
Remedy: the Delegate tool gains an optional `session` parameter naming a
previously returned child of THIS parent to CONTINUE (its context intact)
instead of starting a new one.

Status semantics (user decision 2026-07-17c, supersedes the brief
auto-complete experiment): **idle = the parent can still follow up;
completed = locked forever.** Children rest at `idle` between turns like
any session; `completed` is set only by an explicit parent action and is
terminal (startTurn keeps rejecting it — no exceptions needed).

- CP: `POST /v1/sessions/:id/delegate` body gains `session?: string`. When
  set: child must exist, have `parent_session_id === :id`, its agent must
  match the named subagent, and be idle|failed (in-flight ⇒ 409; completed
  ⇒ 409 "child completed (locked)"). The continuation runs the normal
  follow-up-turn path (inputs + prior outputs re-staged, subagents
  stripped, delivery contract appended); response `{session: childId}`.
- CP: `POST /v1/sessions/:id/delegate/:childId/complete` (runner-facing,
  turn-attributed like delegate): locks an idle|failed child of this
  parent to `completed`; fires the session.completed webhook. Idempotent
  on an already-completed child.
- Runner: schema gains `session` (continue) and `complete` (boolean;
  requires `session`, no prompt — the executor calls the complete endpoint
  and returns a short confirmation). The Delegation block teaches both:
  continue an incomplete result with the returned session id (context
  preserved); mark a child complete when its work is final.
- Poll/staging/interrupt propagation unchanged (a continued child is
  in-flight again and re-covered by listChildSessions).

## Lifecycle & errors

- **Interrupt propagation**: interrupting the parent also interrupts its
  in-flight children (lookup by `parent_session_id`, both API surfaces).
  Same when the zombie reconciler fails a parent. One level ⇒ no recursion.
- **Child failure ⇒ tool error**: result is `is_error` with the child's
  `failure_detail`; the parent's model decides how to react. The child stays
  a normal failed session — resumable from the console.
- **Cold model**: a launch-gate-parked child just makes the parent wait
  through the wake; sweep fail paths (deployment Failed/vanished) surface as
  child-failed ⇒ tool error.
- **Disabled**: target agent disabled ⇒ 409 ⇒ tool error at call time.
  Disabled workspace ⇒ delegate rejected (running parent may finish, but
  cannot create new sessions in a read-only workspace).
- **Attribution**: the child is a first-class session — own `gateway_usage`,
  token totals, session-time billing, webhooks, Usage row. Nothing
  double-counts into the parent.
- **Deletion**: deleting the parent doesn't cascade to children; a dangling
  parent link renders as plain text.

## Testing & verification

- **CP tests** (Node runner, throwaway `t-` workspaces): subagents
  validation (unknown/self/cross-workspace agent, missing instructions);
  delegate endpoint auth; one-level 409; not-configured-target 403;
  disabled-agent/workspace 409; stale-turn rejection; `parent_session_id`
  set; child config stripped of subagents; interrupt propagation.
- **Runner tests** (`test_runner.py`, run inside the image): Delegation
  prompt block; tool registration + allowlist; handler happy path and
  failure paths against a mocked CP; header-leads invariant.
- **Live verify** (docker-desktop): two agents (parent configured with
  child), delegate end-to-end; Subagent badge; parent↔child links; staged
  files; `npx tsc --noEmit`, `npm test`, console production build, all
  pages 200.
