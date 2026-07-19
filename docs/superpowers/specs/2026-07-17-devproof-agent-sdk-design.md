# Devproof Agent SDK — design (2026-07-17)

Goal (TODO "Next"): retire the legacy runner runtime (subprocess CLI + bundled
binary) and give the session runner its own **pure-Python, in-process** agent
SDK that implements ONLY what devproof actually uses. No Node, no bundled
binary, no identity patching. Built from scratch: behaviour derived from the
platform's needs and the open wire protocol — every line written for this
runner.

## Why (motivation from the codebase)

- **AI sovereignty**: the legacy runner runtime drove a compiled CLI whose
  hidden identity blocks had to be **binary-patched at build time**
  (`patch_cli_identity.py`) and which broke on every upgrade.
- The legacy CLI assumes ~200k context and only compacts via its own env var
  plus the gateway's SSE usage-injection hack (`_inject_prompt_estimate`).
  Owning the loop lets us compute context usage client-side.
- The gateway sanitizer strips the legacy CLI's tool schemas that break
  llama.cpp GBNF (huge `maxLength`, regex `pattern`s). Our tool schemas are
  GBNF-friendly by construction.

## Exact surface the runner used (from `session-runner/runner.py`, pre-rewrite)

1. `query(prompt, options)` — async iterator of messages.
2. Options: model, system_prompt, tools/allowed_tools, permission_mode,
   max_turns, resume, cwd, setting_sources, mcp_servers, max_buffer_size.
3. Message types consumed: `SystemMessage(subtype="init", data={session_id, tools})`,
   `AssistantMessage.content` with `TextBlock`, `ToolUseBlock(name, input, id)`,
   `ThinkingBlock(thinking)`; `UserMessage.content` with
   `ToolResultBlock(tool_use_id, content, is_error)`; `ResultMessage(subtype,
   num_turns, stop_reason, is_error, usage{input_tokens,output_tokens},
   duration_ms, result)`.
4. Resume by SDK session id; session state must live under paths the checkpoint
   tarball captures.
5. Env contract: vendor-named base-url/auth-token/custom-headers/context-window
   vars (all renamed, see below), proxy vars.
6. Tools configurable per agent (console default: Bash, Read, Write, Edit, Glob,
   Grep, WebFetch — "python runs via Bash").
7. Remote MCP servers, streamable HTTP (`type: http|sse`, url + headers; the
   bundled registry is streamable-HTTP only), tools surfaced as
   `mcp__<server>__<tool>`.
8. Skills staged as `<skill>/SKILL.md` packages in a per-session skills dir.
9. Wrap-up turn: `max_turns=2`, no tools, after `error_max_turns`.
10. Result subtypes observed by the platform: `success`, `error_max_turns`,
    `error_during_execution`; the console renders `agent.message`, `tool.call`,
    `tool.result`, `agent.thinking`, `session.result` events built from these.

## Approaches considered

- **A. Pure-Python in-process SDK (chosen).** One process, httpx streaming client
  against the gateway's `/v1/messages` (the wire format already verified through
  LiteLLM's chat-completions bridge, including thinking deltas). Smallest image
  (no Node), no identity patching, full control of tool schemas and compaction.
- B. Fork/wrap an OSS agent CLI — still a subprocess boundary, still someone else's
  identity/prompt baggage, still schema sanitization needs.
- C. OpenAI chat-completions client instead of `/v1/messages` — loses the verified
  thinking-block path (the gateway's chat-completions-bridge setting for
  /v1/messages, see the context-window notes in the repo's project notes) and
  the attribution headers the gateway metering expects.

## Devproof-native API (user decisions during build, 2026-07-17)

The runner is the SDK's only consumer, so nothing carries compat baggage:
- **Env vars renamed**: `DEVPROOF_BASE_URL`, `DEVPROOF_AUTH_TOKEN`,
  `DEVPROOF_CUSTOM_HEADERS`, `DEVPROOF_CONTEXT_WINDOW` (orchestrator renders
  these; the old vendor-named env vars are gone end to end).
- **No third-party references** anywhere in the SDK or runner: no vendor option
  aliases, no vendor version header (gateway verified to not need it), no
  vendor dot-dirs — skills stage at `/work/.devproof/skills`, transcripts at
  `~/.devproof/sessions`.
- **No dead options**: `permission_mode`, `max_buffer_size`, `allowed_tools`,
  and `setting_sources` were dropped; skills load via an explicit `skills_dir`
  option. Message/block class names (`TextBlock`, `ToolUseBlock`, …) mirror the
  open `/v1/messages` wire vocabulary, which is protocol, not SDK code.

## Architecture (`agent-sdk/devproof_agent_sdk/`)

- `types.py` — blocks, messages, `AgentOptions`.
- `client.py` — `/v1/messages` **streaming SSE** client (httpx):
  parses `message_start`, `content_block_start/delta/stop` (text_delta,
  thinking_delta, input_json_delta), `message_delta` (stop_reason, usage),
  `message_stop`, `error` frames. Retries 429/5xx/network with jittered
  backoff. Sends custom headers from `DEVPROOF_CUSTOM_HEADERS`.
- `tools/` — built-in tools with GBNF-safe schemas (no `pattern`, no big
  `maxLength`): `bash.py`, `files.py` (Read/Write/Edit), `search.py` (Glob/Grep),
  `webfetch.py` (httpx, honors proxy env, NO hostname preflight of any kind —
  the egress allowlist is the only fetch control).
- `mcp.py` — minimal MCP client: JSON-RPC 2.0 over streamable HTTP POST
  (`initialize` → `notifications/initialized` → `tools/list` → `tools/call`),
  accepts both JSON and SSE response bodies, `Mcp-Session-Id` passthrough,
  per-server headers. `type: "sse"` is treated as streamable HTTP too (registry is
  streamable-only; legacy SSE transport out of scope).
- `skills.py` — scan `<skills_dir>/*/SKILL.md`, parse minimal YAML
  frontmatter (name, description); if any exist, register a `Skill` tool and
  list available skills in the system prompt suffix. **Progressive disclosure
  (user decision 2026-07-17 rev 2):** `Skill(skill)` returns SKILL.md + the
  base dir + an INDEX of bundled files (paths + sizes, `evals/` excluded);
  `Skill(skill, path)` lazily loads one bundled file when the instructions
  call for it — keeping small local-model windows usable. The console titles
  these rows "skill loaded: X" / "skill file loaded: X/path".
- `session.py` — transcript store: JSON file per session under
  `~/.devproof/sessions/<id>.json` (API-shaped message list). `resume`
  loads it; new sessions mint a UUID. The runner has `~/.devproof` in
  CHECKPOINT_PATHS so resume survives pod death.
- `compact.py` — client-side context estimate = serialized-prompt-chars/4 (same
  rule as the gateway's injection hook). When estimate > 80% of the window
  (`DEVPROOF_CONTEXT_WINDOW` env, or `context_window` option), run a
  summarization call and restart history from the summary. Oversized tool results
  are truncated to a window-derived cap before entering history.
- `query.py` — the agentic loop:
  1. yield `SystemMessage("init", {session_id, tools})`
  2. loop: call model → yield `AssistantMessage`; if `tool_use` blocks and turns
     remain: execute tools (built-in / MCP / Skill), yield `UserMessage` with
     `ToolResultBlock`s, append to history, continue; else finish.
  3. `max_turns` reached with the model still calling tools ⇒
     `ResultMessage(subtype="error_max_turns", is_error=True)`; API/transport
     failure after retries ⇒ `error_during_execution` with `result` = error text;
     otherwise `success` (num_turns, summed usage, duration_ms).
  After an is_error result the generator raises `ErrorResultError` ("… returned
  an error result: <subtype>"), the error contract the runner's failure_detail
  path keys on. Unknown tool names get an is_error tool_result, not a crash.

## Options

model, system_prompt, tools, max_turns, resume, cwd, mcp_servers, skills_dir,
context_window, max_output_tokens, base_url, auth_token. No permission model —
the session pod is the sandbox; every configured tool is allowed.

## Testing

`agent-sdk/tests/` (unittest, stdlib + httpx only), runnable on the Windows dev
host and inside the image:
- Mock gateway: local threading HTTP server speaking scripted `/v1/messages` SSE —
  text turn; tool loop (Bash/Read); thinking blocks; max_turns → wrap-up;
  resume continues history; compaction fires under a tiny window; error frames;
  UTF-8 round-trip; empty-text-block filtering.
- Mock MCP server: JSON-RPC endpoint exposing one tool; verify discovery naming
  (`mcp__srv__tool`) and call round-trip incl. header expansion + SSE bodies.
- Egress: proxy env routing, NO_PROXY bypass (gateway path), Squid-style 403
  denials as clean tool errors, Bash children inheriting proxy env (the pip/npm
  restriction mechanism), MCP server behind a denying proxy skipped.
- Built-in tool unit tests (tmpdir-based; Bash via bash -c).
- Runner tests (`session-runner/test_runner.py`): failure_detail contract, MCP
  header expansion, event-post retry.

## Verification (2026-07-17, live on docker-desktop, routing deepseek-v4-flash unless noted)

- Suites: 54 SDK tests + 11 runner tests green on the Windows host AND inside
  the image; control-plane 435 tests + tsc green; console production build green.
- Basic loop: local qwen-medium (Idle → wake-through-hold) and external
  deepseek sessions — tool loops, outputs publishing, thinking events, token
  metering, follow-up turn resuming from a checkpoint on a fresh pod.
- All 7 built-in tools exercised in one live session (Write/Edit/Glob/Grep/
  Read/Bash-python/WebFetch).
- Egress allowlists: specific host (example.com ok, httpbin.org 403), wildcard
  (`*.wikipedia.org` ⇒ en.wikipedia.org ok, example.com 403), `*` (all), empty
  (everything 403 incl. pip ProxyError) — blocked fetches surface as clean
  tool errors, turns complete.
- Package managers: pip install + import AND npm install + require both work
  in an allowPackageManagers env (node/npm restored to the image as agent
  tooling) and fail cleanly elsewhere.
- MCP: real remote server (deepwiki via allow_mcp_servers egress) answered;
  vault bearer credential E2E against a host-side mock REQUIRING the token —
  Authorization arrived on initialize/initialized/tools-list/tools-call
  (secret never in the Job spec; ${VAR} expanded in-pod).
- Skills: multi-file package (SKILL.md + scripts + references + evals) — the
  Skill tool returns the whole package except evals/, model executed the
  bundled python script; console renders Skill rows with their own badge.
- Lifecycle: max_turns → budget_exhausted → tool-less wrap-up answer → idle;
  interrupt mid-Bash-sleep → session.interrupted → idle; memory store synced
  back diff-based (entry + exact content via API); runner event posts retry
  with backoff (live URLError crash hardened).
- Scalability posture: retries carry jitter (gateway client) so pod fleets
  don't retry in lockstep; read timeouts sized for CPU prefill (600s gateway,
  300s MCP, env-tunable); one pooled httpx client per turn; tool results,
  Bash output, and history (compaction) all bounded; no polling loops.
- Copyright: written entirely from scratch — from the platform's observed
  needs and the public wire protocol; grep audits show no third-party identity strings or
  distinctive phrasing; the only file that ever contained verbatim vendor CLI
  bytes (patch_cli_identity.py) is deleted.

## Out of scope (YAGNI, per goal)

Permissions/hooks, subagents, slash commands, plugins, sessions-over-stdio,
stdio MCP servers, image tool results, WebSearch, streaming partial-text events
(the runner emits whole blocks), OAuth flows.

## Soak / chaos / hardening (2026-07-17, dev36)

Confidence pass requested by the user. All live on docker-desktop.

- **Soak:** 26 concurrent sessions (24 short deepseek + 1 qwen-32k + 1 45-turn
  budget run) — all reached idle, zero failures, zero leaked running pods
  (finished Jobs expire on their 1h TTL). Budget run: 45 tool-call turns,
  ~81k/2.9k tokens, clean.
- **Multi-cycle compaction:** driven live against qwen-medium with a tiny
  `context_window` — TWO `compact_boundary` cycles fired against the real
  gateway (real summarization calls, 0 degraded) and the session recovered to
  `success`; also covered deterministically by `test_auto_compaction_*`.
- **Chaos:** (a) hard `kubectl delete pod` mid-turn → zombie reconciler marked
  the session `failed` → a follow-up message resumed it to idle
  ("RESUMED-AFTER-KILL"). (b) CP killed and restarted mid-turn → the running
  pod finished, posted through the retry path, session idle
  ("cp-restart-survived"), no duplicate events. (c) interrupt racing an
  immediate follow-up → clean `session.interrupted` then a fresh turn
  ("RACE-SURVIVED"), no stale-pod pollution.
- **Idempotency (migration 042):** `session_events.uid` + partial unique index;
  `appendEvents` dedupes a retried batch under the session `FOR UPDATE` lock;
  the runner mints a uid per event. Covered by a live-DB repo test.
- **Read image support:** image files return a base64 image block for vision
  models (size-capped); the base64 never enters the transcript event or the
  tool-less/wrap-up textified history, and compaction counts an image as a flat
  ~1600-token cost (not chars/4 of the base64).
- **Real MCP + large skill:** deepwiki answered a live question; a 31-file
  skill package exercised the lazy index → `Skill(path=…)` reference load → a
  bundled-script run, `evals/` excluded throughout.

## Rollout

Runner imports `devproof_agent_sdk`; the Dockerfile has no Node-for-CLI, no
third-party agent SDK, no `patch_cli_identity.py` — it installs `agent-sdk/`
(build from the repo root) plus node/npm as agent tooling. Image tags dev28+
(dev35 current on the dev CP — includes the 8-angle code-review fixes:
pair-atomic transcript saves, pre-serialization tool-id minting, tool-less
requests textified, window-clamped max_tokens, 200k default compaction window,
4MB WebFetch download cap, CRLF-safe MCP SSE parsing, concurrent MCP
handshakes, jittered retries on both HTTP paths, resumed/ignored_tools
surfaced in session.init, and the headless plotting stack).
Known accepted gaps: event posts are at-least-once without a CP dedup key
(rare duplicates on response loss — follow-up: idempotency key in
appendEvents); Read has no image support for vision models (out of scope v1).
Nothing committed by this task.
