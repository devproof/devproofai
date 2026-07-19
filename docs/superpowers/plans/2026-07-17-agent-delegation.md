# Agent Delegation (Subagents) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent can push work to another agent: subagents are configured per agent version (like MCP servers), invoked synchronously via an in-process `Delegate` tool, run as full first-class sessions linked to the parent, and show a "Subagent" badge in the parent's trace.

**Architecture:** Config rides `agent_versions.subagents` (migration 041) into the launch payload and `DEVPROOF_AGENT_CONFIG`. The runner injects a `Delegate` tool through a new `AgentOptions.extra_tools` seam in the in-house **Devproof Agent SDK** (`agent-sdk/`, commit c00feeb — the vendor CLI/SDK are gone); the tool's executor calls two new runner-facing CP endpoints (`POST/GET /v1/sessions/:id/delegate…`), which create/poll a child session (`sessions.parent_session_id`). One level only: the CP resolves subagents to `[]` for any session that has a parent. Spec: `docs/superpowers/specs/2026-07-17-agent-delegation-design.md` (rev 2026-07-17b).

**Tech Stack:** Node/TS Fastify control plane (Node test runner via tsx), Python runner on `devproof_agent_sdk` (unittest; SDK tests run on the Windows host AND inside the Docker image), Next.js console.

## Global Constraints

- Runner image tag bumps to **dev37** (current dev36; nodes cache same-tag rebuilds).
- `migrate()` re-runs EVERY sql file each boot — every 041 statement must be a no-op on the second run.
- Runner prompts must NEVER contain the word "Claude" (small-model parroting; see runner.py comments).
- CP tests: `cd control-plane && npm test` (whole suite, serial, ~130s) or `npm test -- test/<file>.test.ts` for one file. Never remove `--test-concurrency=1`. Throwaway workspaces must be named `t-<tag>-${Date.now()}` (the sweep collects them).
- Console is verified with a production build (`cd console && npx next build`) — dev mode is banned.
- Repo has CRLF line endings — after bulk line deletions with Edit, re-check `git diff`.
- The runner boundary key for the routing stays `model` inside `DEVPROOF_AGENT_CONFIG`; the new key `subagents` is additive.
- The SDK (`agent-sdk/devproof_agent_sdk/`) gets a GENERIC `extra_tools` seam only — no delegation knowledge inside the SDK (its spec keeps subagents out of scope; delegation lives in the runner).
- Commit after every task. Do not modify TODO.txt.

## File Structure

- `control-plane/sql/041_subagents.sql` — new columns (create)
- `control-plane/src/subagents.ts` — validation + launch resolution + child-interrupt helper (create)
- `control-plane/src/repo.ts` — `AgentConfig.subagents`, `addVersion`, `createSession` parent param, 3 new query helpers (modify)
- `control-plane/src/session-actions.ts` — subagent resolution into launches, `delegateAction`, `delegateStatusAction` (modify)
- `control-plane/src/agents-api.ts` — validation on create/versions, delegate routes, interrupt propagation (modify)
- `control-plane/src/public-api.ts` — validation on create/versions, interrupt propagation (modify)
- `control-plane/src/orchestrator.ts` — `subagents` in `DEVPROOF_AGENT_CONFIG` (modify)
- `control-plane/src/main.ts` — reconciler child-interrupt hook (modify)
- `control-plane/test/subagents.test.ts` — validator, actions, helper tests (create)
- `agent-sdk/devproof_agent_sdk/types.py` + `query.py` — `AgentOptions.extra_tools` seam (modify); test in `agent-sdk/tests/test_query_loop.py`
- `session-runner/runner.py` + `session-runner/test_runner.py` — prompt block, Delegate tool + executor (modify)
- `console/app/agents/agent-form.tsx`, `console/app/agents/page.tsx`, `console/app/agents/[id]/page.tsx`, `console/app/agents/[id]/tabs.tsx` — Subagents config UI (modify)
- `console/app/sessions/[id]/rows.ts`, `transcript.tsx`, `timeline.tsx`, `panels.tsx`, `page.tsx`, `console/app/globals.css` — Subagent badge + links (modify)

---

### Task 1: Migration 041, `AgentConfig.subagents`, validation on both API surfaces

**Files:**
- Create: `control-plane/sql/041_subagents.sql`
- Create: `control-plane/src/subagents.ts`
- Create: `control-plane/test/subagents.test.ts`
- Modify: `control-plane/src/repo.ts:18-32` (AgentConfig), `:141-149` (addVersion)
- Modify: `control-plane/src/agents-api.ts:278-294` (POST /v1/agents), `:650-669` (POST /v1/agents/:id/versions)
- Modify: `control-plane/src/public-api.ts:436-457` (POST /agents), `:467-485` (POST /agents/:id/versions)

**Interfaces:**
- Produces: `AgentConfig.subagents?: { agentId: string; instructions: string }[]`; DB columns `agent_versions.subagents JSONB NOT NULL DEFAULT '[]'` and `sessions.parent_session_id TEXT NULL`; `validateSubagents(repo, workspaceId, selfAgentId, value): Promise<string | null>` exported from `src/subagents.ts`.
- Consumes: `repo.getAgent(workspaceId, id)` (existing).

- [ ] **Step 1: Write the migration**

```sql
-- control-plane/sql/041_subagents.sql
-- Agent delegation (spec 2026-07-17): an agent version lists other agents it
-- may push work to; a session started by delegation carries its parent's id.
-- migrate() re-runs EVERY sql file on every boot — all statements are no-ops
-- on the second run.
ALTER TABLE agent_versions ADD COLUMN IF NOT EXISTS subagents JSONB NOT NULL DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_session_id)
  WHERE parent_session_id IS NOT NULL;
```

- [ ] **Step 2: Write the failing tests**

```ts
// control-plane/test/subagents.test.ts
// Validation + delegate/interrupt actions for agent delegation (spec 2026-07-17).
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSubagents } from "../src/subagents.ts";

// Fake repo: agents visible only in their own workspace (mirrors repo.getAgent).
const agentRepo = (ids: string[]) => ({
  async getAgent(_ws: string, id: string) { return ids.includes(id) ? { id, status: "active" } : null; },
});

test("validateSubagents: accepts undefined/null/empty", async () => {
  const repo = agentRepo([]);
  assert.equal(await validateSubagents(repo, "ws", null, undefined), null);
  assert.equal(await validateSubagents(repo, "ws", null, null), null);
  assert.equal(await validateSubagents(repo, "ws", null, []), null);
});

test("validateSubagents: shape errors", async () => {
  const repo = agentRepo(["agent_b"]);
  assert.match((await validateSubagents(repo, "ws", null, {}))!, /must be an array/);
  assert.match((await validateSubagents(repo, "ws", null, [{ instructions: "x" }]))!, /agentId required/);
  assert.match((await validateSubagents(repo, "ws", null, [{ agentId: "agent_b" }]))!, /instructions required/);
  assert.match((await validateSubagents(repo, "ws", null,
    [{ agentId: "agent_b", instructions: "  " }]))!, /instructions required/);
  assert.match((await validateSubagents(repo, "ws", null,
    [{ agentId: "agent_b", instructions: "x".repeat(2001) }]))!, /too long/);
});

test("validateSubagents: self, duplicate, unknown, cross-workspace", async () => {
  const repo = agentRepo(["agent_b"]);
  assert.match((await validateSubagents(repo, "ws", "agent_self",
    [{ agentId: "agent_self", instructions: "x" }]))!, /itself/);
  assert.match((await validateSubagents(repo, "ws", null, [
    { agentId: "agent_b", instructions: "x" },
    { agentId: "agent_b", instructions: "y" }]))!, /duplicate/);
  assert.match((await validateSubagents(repo, "ws", null,
    [{ agentId: "agent_missing", instructions: "x" }]))!, /unknown agent/);
  assert.equal(await validateSubagents(repo, "ws", null,
    [{ agentId: "agent_b", instructions: "use for code review" }]), null);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd control-plane && npm test -- test/subagents.test.ts`
Expected: FAIL — `Cannot find module '../src/subagents.ts'`

- [ ] **Step 4: Implement `src/subagents.ts` (validator only for now)**

```ts
// control-plane/src/subagents.ts
// Agent delegation (spec 2026-07-17). Pure-ish helpers shared by the /v1 and
// /api surfaces: config validation here; launch resolution and the delegate
// actions live in session-actions.ts (they need the full SessionDeps).
const MAX_INSTRUCTIONS = 2000;
const MAX_SUBAGENTS = 20;

export interface SubagentRef { agentId: string; instructions: string; }

/** Version-config `subagents` field guard (routes 400 on the returned message).
 *  selfAgentId is null on agent create (no id exists yet to self-reference). */
export async function validateSubagents(
  repo: { getAgent(ws: string, id: string): Promise<unknown | null> },
  workspaceId: string, selfAgentId: string | null, value: unknown,
): Promise<string | null> {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return "subagents must be an array";
  if (value.length > MAX_SUBAGENTS) return `subagents: at most ${MAX_SUBAGENTS} entries`;
  const seen = new Set<string>();
  for (const [i, s] of (value as any[]).entries()) {
    if (typeof s !== "object" || s === null || Array.isArray(s)) return `subagents[${i}]: must be an object`;
    if (typeof s.agentId !== "string" || !s.agentId) return `subagents[${i}]: agentId required`;
    if (typeof s.instructions !== "string" || !s.instructions.trim()) return `subagents[${i}]: instructions required`;
    if (s.instructions.length > MAX_INSTRUCTIONS) return `subagents[${i}]: instructions too long (max ${MAX_INSTRUCTIONS})`;
    if (s.agentId === selfAgentId) return `subagents[${i}]: an agent cannot delegate to itself`;
    if (seen.has(s.agentId)) return `subagents[${i}]: duplicate agent ${s.agentId}`;
    seen.add(s.agentId);
    if (!(await repo.getAgent(workspaceId, s.agentId))) return `subagents[${i}]: unknown agent ${s.agentId}`;
  }
  return null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd control-plane && npm test -- test/subagents.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Persist the field — `repo.ts`**

In `AgentConfig` (repo.ts:18-32) add after `vaultId?: string;`:

```ts
  /** Agents this agent may delegate to (spec 2026-07-17); instructions =
   *  free-text "when to use", rendered into the runner's Delegation block. */
  subagents?: { agentId: string; instructions: string }[];
```

Replace `addVersion` (repo.ts:141-149) with:

```ts
  private async addVersion(workspaceId: string, agentId: string, version: number, c: AgentConfig) {
    await this.pool.query(
      `INSERT INTO agent_versions (id, workspace_id, agent_id, version, routing, system_prompt, tools, max_turns, turn_deadline_sec, environment_id, skill_ids, mcp_servers, vault_id, subagents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [rid("agntv"), workspaceId, agentId, version, c.routing, c.systemPrompt ?? "",
       JSON.stringify(c.tools ?? []), c.maxTurns ?? 500, c.turnDeadlineSeconds ?? null, c.environmentId ?? null,
       JSON.stringify(c.skillIds ?? []), JSON.stringify(c.mcpServers ?? {}), c.vaultId ?? null,
       JSON.stringify(c.subagents ?? [])],
    );
  }
```

(`getAgentVersion`/`getAgentWithVersions` are `SELECT *` — they pick the column up automatically.)

- [ ] **Step 7: Route validation, all four write paths**

`agents-api.ts`: add to imports (line 11 area): `import { validateSubagents } from "./subagents.ts";`
In `POST /v1/agents` (after the `mcpErr` check, line ~287):

```ts
    const subErr = await validateSubagents(repo, ws(req), null, (b as any).subagents);
    if (subErr) return reply.code(400).send({ error: subErr });
```

In `POST /v1/agents/:id/versions` (after its `mcpErr` check, line ~659):

```ts
    const subErr = await validateSubagents(repo, ws(req), id, (b as any).subagents);
    if (subErr) return reply.code(400).send({ error: subErr });
```

`public-api.ts`: same import; same two blocks after the `mcpErr` checks in `api.post("/agents", …)` and `api.post("/agents/:id/versions", …)` — in the versions handler the self id is `req.params.id`.

- [ ] **Step 8: DB round-trip test (live dev Postgres, self-skip pattern)**

Append to `test/subagents.test.ts` (setup mirrors `test/updated-at.test.ts:11-24`):

```ts
import { createPool, migrate } from "../src/db.ts";
import { Repo } from "../src/repo.ts";

const pool = createPool();
let dbAvailable = true;
try { await pool.query("SELECT 1"); await migrate(pool); } catch { dbAvailable = false; }
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test("subagents round-trip through agent_versions; sessions get parent_session_id", { skip: !dbAvailable }, async () => {
  const repo = new Repo(pool);
  const ws = (await repo.createWorkspace(`t-sub-${uniq()}`)).id;
  const target = await repo.createAgent(ws, `t-sub-t-${uniq()}`, { routing: "r", tools: [] });
  const parent = await repo.createAgent(ws, `t-sub-p-${uniq()}`, {
    routing: "r", tools: [], subagents: [{ agentId: target.id, instructions: "reviews code" }],
  });
  const v = await repo.getAgentVersion(parent.id);
  assert.deepEqual(v.subagents, [{ agentId: target.id, instructions: "reviews code" }]);
  const { rows } = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'parent_session_id'");
  assert.equal(rows.length, 1);
});
```

- [ ] **Step 9: Run the new file, then typecheck**

Run: `cd control-plane && npm test -- test/subagents.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests), tsc clean

- [ ] **Step 10: Commit**

```bash
git add control-plane/sql/041_subagents.sql control-plane/src/subagents.ts control-plane/src/repo.ts control-plane/src/agents-api.ts control-plane/src/public-api.ts control-plane/test/subagents.test.ts
git commit -m "feat(cp): agent_versions.subagents + sessions.parent_session_id (migration 041) with validation"
```

---

### Task 2: Launch plumbing — subagents into the runner config, parent link on child sessions

**Files:**
- Modify: `control-plane/src/repo.ts:226-237` (createSession)
- Modify: `control-plane/src/session-actions.ts` (createSessionAction, sendMessageAction)
- Modify: `control-plane/src/agents-api.ts:24-42` (Orchestrator.startSession type)
- Modify: `control-plane/src/orchestrator.ts:326-341` (buildTurnJob env)
- Test: `control-plane/test/subagents.test.ts`, `control-plane/test/orchestrator.test.ts`

**Interfaces:**
- Produces: `repo.createSession(workspaceId, agentId, prompt, name?, parentSessionId?)`; launch payload field `subagents: { name: string; agentId: string; instructions: string }[]`; `DEVPROOF_AGENT_CONFIG.subagents` (same shape); `createSessionAction` body field `parentSessionId?: string`.
- Consumes: `AgentConfig.subagents` (Task 1).

- [ ] **Step 1: Write the failing tests**

Append to `test/subagents.test.ts`:

```ts
import { createSessionAction } from "../src/session-actions.ts";

// Minimal fakes for the action layer (subset of test/agents-api.test.ts fakes()).
function actionFakes(opts: { subagents?: any[]; targetStatus?: string } = {}) {
  const started: any[] = [];
  const repo = {
    agents: [
      { id: "agent_p", name: "parent", status: "active" },
      { id: "agent_t", name: "reviewer", status: opts.targetStatus ?? "active" },
    ],
    async getAgent(_ws: string, id: string) {
      return (this as any).agents.find((a: any) => a.id === id) ?? null;
    },
    async getAgentVersion(id: string) {
      return { agent_id: id, version: 1, routing: "r", system_prompt: "", tools: [],
               max_turns: 10, environment_id: "env_0", subagents: opts.subagents ?? [] };
    },
    async getEnvironment(id: string) { return { id, pod: {} }; },
    async listFileRecords(ids: string[]) { return ids.map((id) => ({ id, name: id })); },
    sessions: [] as any[],
    async createSession(_ws: string, agentId: string, prompt: string, name?: string, parentSessionId?: string) {
      const s = { id: `sesn_${(this as any).sessions.length}`, agent_id: agentId, workspace_id: _ws,
                  status: "queued", turns: 0, parent_session_id: parentSessionId ?? null };
      (this as any).sessions.push(s);
      return { id: s.id, agentId, agentVersion: 1,
               config: await (this as any).getAgentVersion(agentId) };
    },
    async appendEvents() { return 1; },
    async attachSessionFiles() {},
    async listSkills() { return []; },
    async listVaultCredentials() { return []; },
    async getSession(id: string) { return (this as any).sessions.find((s: any) => s.id === id) ?? null; },
  };
  const orchestrator = { async startSession(launch: any) { started.push(launch); } } as any;
  return { repo, orchestrator, started };
}

test("createSessionAction: resolves subagents (name + id + instructions) into the launch", async () => {
  const f = actionFakes({ subagents: [{ agentId: "agent_t", instructions: "reviews code" }] });
  const r = await createSessionAction({ repo: f.repo, orchestrator: f.orchestrator }, "ws", {
    agent: "agent_p", prompt: "go" });
  assert.equal(r.code, 201);
  assert.deepEqual(f.started[0].subagents,
    [{ name: "reviewer", agentId: "agent_t", instructions: "reviews code" }]);
});

test("createSessionAction: a child session (parentSessionId set) gets NO subagents — one level only", async () => {
  const f = actionFakes({ subagents: [{ agentId: "agent_t", instructions: "reviews code" }] });
  const r = await createSessionAction({ repo: f.repo, orchestrator: f.orchestrator }, "ws", {
    agent: "agent_p", prompt: "go", parentSessionId: "sesn_parent" });
  assert.equal(r.code, 201);
  assert.deepEqual(f.started[0].subagents, []);
  assert.equal((f.repo as any).sessions[0].parent_session_id, "sesn_parent");
});

test("createSessionAction: a configured subagent whose row was deleted is skipped, not fatal", async () => {
  const f = actionFakes({ subagents: [{ agentId: "agent_gone", instructions: "x" }] });
  const r = await createSessionAction({ repo: f.repo, orchestrator: f.orchestrator }, "ws", {
    agent: "agent_p", prompt: "go" });
  assert.equal(r.code, 201);
  assert.deepEqual(f.started[0].subagents, []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && npm test -- test/subagents.test.ts`
Expected: FAIL — `started[0].subagents` is `undefined`

- [ ] **Step 3: Implement**

`repo.ts` `createSession` (line 226): add the parameter and column:

```ts
  async createSession(workspaceId: string, agentId: string, prompt: string, name?: string, parentSessionId?: string) {
    const agent = await this.getAgentWithVersions(agentId, workspaceId);
    if (!agent) throw new Error(`agent not found: ${agentId}`);
    const v = agent.versions[0];
    const id = rid("sesn");
    await this.pool.query(
      `INSERT INTO sessions (id, workspace_id, agent_id, agent_version, name, prompt, status, parent_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7)`,
      [id, workspaceId, agentId, v.version, name ?? null, prompt, parentSessionId ?? null],
    );
    return { id, agentId, agentVersion: v.version, config: v };
  }
```

`session-actions.ts`: add near the top (after the `EnvRow` type):

```ts
/** Resolve the version's subagent refs to launch-payload entries (current
 *  target NAMES — the runner's tool enum + prompt block). A session that
 *  itself has a parent gets none: delegation is one level deep, enforced
 *  structurally (the child pod never has the tool). Deleted targets are
 *  skipped — the call would fail at delegate time anyway. */
async function resolveSubagents(
  repo: any, workspaceId: string, config: any, parentSessionId?: string | null,
): Promise<{ name: string; agentId: string; instructions: string }[]> {
  if (parentSessionId) return [];
  const out: { name: string; agentId: string; instructions: string }[] = [];
  for (const s of (config?.subagents ?? []) as { agentId: string; instructions: string }[]) {
    const target = await repo.getAgent(workspaceId, s.agentId);
    if (target) out.push({ name: target.name, agentId: s.agentId, instructions: s.instructions });
  }
  return out;
}
```

In `createSessionAction`: extend the body type with `parentSessionId?: string`, pass it to `repo.createSession(workspaceId, b.agent, b.prompt, b.name, b.parentSessionId)`, and add `subagents` to the `gatedLaunch` payload (line ~110):

```ts
  const subagents = await resolveSubagents(repo, workspaceId, session.config, b.parentSessionId);
  const gated = await gatedLaunch(deps, session.id, 0, {
    id: session.id, prompt: b.prompt, config: session.config, attachments, skills, memory, workspace: workspaceId,
    environment: { id: environment!.id, pod: environment!.pod ?? {} }, mcpServers, subagents,
  });
```

In `sendMessageAction` (follow-up turns need the tool too), before its `gatedLaunch` call:

```ts
  const subagents = await resolveSubagents(repo, workspaceId, turn.config, session?.parent_session_id);
```

and add `subagents` to that `gatedLaunch` payload object.

`agents-api.ts` `Orchestrator.startSession` type (line 24-42): add after `mcpServers?`:

```ts
    /** Resolved delegation targets (spec 2026-07-17); [] for child sessions. */
    subagents?: { name: string; agentId: string; instructions: string }[];
```

`orchestrator.ts` `buildTurnJob` `DEVPROOF_AGENT_CONFIG` value (line ~331-340): add after `mcp_servers`:

```ts
                    subagents: (session as any).subagents ?? [],
```

- [ ] **Step 4: buildTurnJob test**

Append to `test/orchestrator.test.ts` (it already imports `buildTurnJob`; mirror the existing test style — a minimal session object with `id/prompt/config/environment`):

```ts
test("buildTurnJob renders subagents into DEVPROOF_AGENT_CONFIG", () => {
  const job: any = buildTurnJob({
    id: "sesn_sub", prompt: "p",
    config: { routing: "m", system_prompt: "", tools: [], max_turns: 5 },
    environment: { id: "env_1", pod: {} },
    subagents: [{ name: "reviewer", agentId: "agent_t", instructions: "reviews code" }],
  } as any);
  const env = job.spec.template.spec.containers[0].env;
  const cfg = JSON.parse(env.find((e: any) => e.name === "DEVPROOF_AGENT_CONFIG").value);
  assert.deepEqual(cfg.subagents, [{ name: "reviewer", agentId: "agent_t", instructions: "reviews code" }]);
});
```

(If `test/orchestrator.test.ts` builds its session fixtures through a shared helper, extend that helper instead of inlining — match the file's existing style.)

- [ ] **Step 5: Run tests + typecheck**

Run: `cd control-plane && npm test -- test/subagents.test.ts test/orchestrator.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean

- [ ] **Step 6: Commit**

```bash
git add control-plane/src control-plane/test
git commit -m "feat(cp): resolve subagents into launch payload + DEVPROOF_AGENT_CONFIG; parent_session_id on child sessions"
```

---

### Task 3: Delegate endpoints (create child, poll child)

**Files:**
- Modify: `control-plane/src/repo.ts` (3 helpers, after `listSessionFiles` at :1117)
- Modify: `control-plane/src/session-actions.ts` (delegateAction, delegateStatusAction)
- Modify: `control-plane/src/agents-api.ts` (2 routes, next to the other runner callbacks at :746)
- Test: `control-plane/test/subagents.test.ts`

**Interfaces:**
- Produces: `POST /v1/sessions/:id/delegate` body `{turn?, agent_id, prompt, files?: string[]}` → 201 `{session: <childId>}`; `GET /v1/sessions/:id/delegate/:childId` → `{status, resultText?, outputs?: {id,name}[], failureDetail?}`; repo helpers `lastAgentMessage(id)`, `lastFailureDetail(id)`, `listChildSessions(parentId)`.
- Consumes: `createSessionAction` with `parentSessionId` (Task 2).

**Design notes (from the spec):**
- The workspace guard does NOT catch these calls (runner posts carry no workspace header → they resolve to the always-active default workspace), so `delegateAction` checks the session's workspace status itself.
- Stale-turn guard mirrors the dev23 status-post convention: `body.turn < session.turns` ⇒ reject.
- Terminal child states for the poll: `idle` and `completed` = success, `failed` = failure. `queued` (including launch-gate-parked) and `running` keep polling.

- [ ] **Step 1: Write the failing tests**

Append to `test/subagents.test.ts`:

```ts
import { delegateAction, delegateStatusAction } from "../src/session-actions.ts";

function delegateFakes(opts: {
  parentStatus?: string; parentTurns?: number; parentOfParent?: string | null;
  subagents?: any[]; targetStatus?: string; workspaceStatus?: string;
} = {}) {
  const f = actionFakes({ subagents: [], targetStatus: opts.targetStatus });
  const repo: any = f.repo;
  repo.sessions.push({
    id: "sesn_parent", agent_id: "agent_p", agent_version: 1, workspace_id: "ws",
    status: opts.parentStatus ?? "running", turns: opts.parentTurns ?? 0,
    parent_session_id: opts.parentOfParent ?? null,
  });
  repo.getAgentVersion = async (id: string, _v?: number) => ({
    agent_id: id, version: 1, routing: "r", system_prompt: "", tools: [], max_turns: 10,
    environment_id: "env_0",
    subagents: opts.subagents ?? [{ agentId: "agent_t", instructions: "reviews code" }],
  });
  repo.getWorkspace = async (id: string) => ({ id, status: opts.workspaceStatus ?? "active" });
  repo.events = {} as Record<string, any[]>;
  repo.listEvents = async () => [];
  repo.lastAgentMessage = async () => "the answer";
  repo.lastFailureDetail = async () => "boom";
  repo.listSessionFiles = async () => [
    { role: "output", id: "file_1", name: "report.md" },
    { role: "input", id: "file_0", name: "in.csv" }];
  return { ...f, repo };
}

test("delegateAction: happy path creates a linked child session", async () => {
  const f = delegateFakes();
  const r = await delegateAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent",
    { turn: 0, agent_id: "agent_t", prompt: "review this" });
  assert.equal(r.code, 201);
  const child = f.repo.sessions.find((s: any) => s.id === r.body.session);
  assert.equal(child.parent_session_id, "sesn_parent");
  assert.equal(child.agent_id, "agent_t");
});

test("delegateAction: one level only — a child cannot delegate", async () => {
  const f = delegateFakes({ parentOfParent: "sesn_grandparent" });
  const r = await delegateAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent",
    { agent_id: "agent_t", prompt: "x" });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /one level/);
});

test("delegateAction: target not in the version's subagents ⇒ 403", async () => {
  const f = delegateFakes({ subagents: [] });
  const r = await delegateAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent",
    { agent_id: "agent_t", prompt: "x" });
  assert.equal(r.code, 403);
});

test("delegateAction: stale turn ⇒ 409; disabled target agent ⇒ 409; read-only workspace ⇒ 409; not in-flight ⇒ 409", async () => {
  const stale = delegateFakes({ parentTurns: 3 });
  assert.equal((await delegateAction({ repo: stale.repo, orchestrator: stale.orchestrator },
    "sesn_parent", { turn: 1, agent_id: "agent_t", prompt: "x" })).code, 409);
  const disabled = delegateFakes({ targetStatus: "disabled" });
  assert.equal((await delegateAction({ repo: disabled.repo, orchestrator: disabled.orchestrator },
    "sesn_parent", { agent_id: "agent_t", prompt: "x" })).code, 409);
  const ro = delegateFakes({ workspaceStatus: "disabled" });
  assert.equal((await delegateAction({ repo: ro.repo, orchestrator: ro.orchestrator },
    "sesn_parent", { agent_id: "agent_t", prompt: "x" })).code, 409);
  const idle = delegateFakes({ parentStatus: "idle" });
  assert.equal((await delegateAction({ repo: idle.repo, orchestrator: idle.orchestrator },
    "sesn_parent", { agent_id: "agent_t", prompt: "x" })).code, 409);
});

test("delegateStatusAction: terminal child returns result text + outputs; wrong parent 404s", async () => {
  const f = delegateFakes();
  f.repo.sessions.push({ id: "sesn_child", parent_session_id: "sesn_parent", status: "idle" });
  const r = await delegateStatusAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent", "sesn_child");
  assert.equal(r.code, 200);
  assert.equal(r.body.status, "idle");
  assert.equal(r.body.resultText, "the answer");
  assert.deepEqual(r.body.outputs, [{ id: "file_1", name: "report.md" }]);
  const wrong = await delegateStatusAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_other", "sesn_child");
  assert.equal(wrong.code, 404);
});

test("delegateStatusAction: running child returns status only; failed child carries failureDetail", async () => {
  const f = delegateFakes();
  f.repo.sessions.push({ id: "sesn_run", parent_session_id: "sesn_parent", status: "running" });
  f.repo.sessions.push({ id: "sesn_fail", parent_session_id: "sesn_parent", status: "failed" });
  const run = await delegateStatusAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent", "sesn_run");
  assert.equal(run.body.resultText, undefined);
  const fail = await delegateStatusAction({ repo: f.repo, orchestrator: f.orchestrator }, "sesn_parent", "sesn_fail");
  assert.equal(fail.body.failureDetail, "boom");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && npm test -- test/subagents.test.ts`
Expected: FAIL — `delegateAction` is not exported

- [ ] **Step 3: Repo helpers**

Add to `repo.ts` after `listSessionFiles` (:1117-1125):

```ts
  /** Latest assistant text of a session — the delegate poll's resultText. */
  async lastAgentMessage(sessionId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT payload->>'text' AS text FROM session_events
       WHERE session_id = $1 AND type = 'agent.message' ORDER BY seq DESC LIMIT 1`, [sessionId]);
    return rows[0]?.text ?? null;
  }

  /** Latest session.failed error text — the delegate poll's failureDetail. */
  async lastFailureDetail(sessionId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT payload->>'error' AS text FROM session_events
       WHERE session_id = $1 AND type = 'session.failed' ORDER BY seq DESC LIMIT 1`, [sessionId]);
    return rows[0]?.text ?? null;
  }

  /** In-flight children of a parent session (interrupt/reconciler propagation).
   *  Includes launch-gate-parked children (status queued, no Job). */
  async listChildSessions(parentId: string): Promise<{ id: string; status: string }[]> {
    const { rows } = await this.pool.query(
      "SELECT id, status FROM sessions WHERE parent_session_id = $1 AND status IN ('queued','running')",
      [parentId]);
    return rows;
  }
```

- [ ] **Step 4: Actions**

Add to `session-actions.ts`:

```ts
/** Runner-facing: spawn a child session for a configured subagent (spec
 *  2026-07-17). The workspace guard can't scope runner callbacks (no
 *  workspace header), so the workspace status check lives here. */
export async function delegateAction(
  deps: SessionDeps, id: string,
  b: { turn?: number; agent_id: string; prompt: string; files?: string[] },
): Promise<{ code: number; body: any }> {
  const { repo } = deps;
  if (!b?.agent_id || !b?.prompt) return { code: 400, body: { error: "agent_id and prompt required" } };
  const session = await repo.getSession(id);
  if (!session) return { code: 404, body: { error: "session not found" } };
  // Stale-turn guard (dev23 convention): a pod that outlived an interrupt
  // must not spawn children for a turn that is no longer current.
  if (typeof b.turn === "number" && Number.isInteger(b.turn) && Number(session.turns) > b.turn) {
    return { code: 409, body: { error: "stale turn" } };
  }
  if (!["queued", "running"].includes(session.status)) {
    return { code: 409, body: { error: `session is ${session.status}, not in-flight` } };
  }
  if (session.parent_session_id) {
    return { code: 409, body: { error: "delegation is one level deep — this session was itself started by delegation" } };
  }
  const workspace = await repo.getWorkspace(session.workspace_id);
  if (workspace && workspace.status !== "active") {
    return { code: 409, body: { error: "workspace is read-only — cannot start new sessions" } };
  }
  // The SESSION's pinned version (what the pod's tool enum was built from).
  const v = await repo.getAgentVersion(session.agent_id, session.agent_version);
  const configured = ((v?.subagents ?? []) as { agentId: string }[]).some((s) => s.agentId === b.agent_id);
  if (!configured) return { code: 403, body: { error: "agent is not a configured subagent of this session's agent" } };
  const r = await createSessionAction(deps, session.workspace_id, {
    agent: b.agent_id, prompt: b.prompt, files: b.files,
    name: `delegated by ${id}`, parentSessionId: id,
  });
  if (r.code !== 201) return r; // 409 agent disabled / failed deployment; 400 bad files; 404 agent gone
  return { code: 201, body: { session: r.body.id } };
}

/** Runner-facing poll: child status; result text + output files once terminal. */
export async function delegateStatusAction(
  deps: SessionDeps, id: string, childId: string,
): Promise<{ code: number; body: any }> {
  const { repo } = deps;
  const child = await repo.getSession(childId);
  if (!child || child.parent_session_id !== id) return { code: 404, body: { error: "no such child session" } };
  const body: any = { status: child.status };
  if (["idle", "completed", "failed"].includes(child.status)) {
    body.resultText = await repo.lastAgentMessage(childId);
    body.outputs = (await repo.listSessionFiles(childId))
      .filter((f: any) => f.role === "output").map((f: any) => ({ id: f.id, name: f.name }));
    if (child.status === "failed") body.failureDetail = await repo.lastFailureDetail(childId);
  }
  return { code: 200, body };
}
```

- [ ] **Step 5: Routes**

`agents-api.ts` — extend the import from `./session-actions.ts` with `delegateAction, delegateStatusAction`, then add next to `POST /v1/sessions/:id/outputs` (:746):

```ts
  // Runner callback (spec 2026-07-17): synchronous delegation to a configured
  // subagent — creates a linked child session / polls it. Workspace checks
  // live in the action (runner posts carry no workspace header).
  app.post("/v1/sessions/:id/delegate", async (req, reply) => {
    const r = await delegateAction(sessionDeps, (req.params as any).id, req.body as any);
    return reply.code(r.code).send(r.body);
  });
  app.get("/v1/sessions/:id/delegate/:childId", async (req, reply) => {
    const { id, childId } = req.params as { id: string; childId: string };
    const r = await delegateStatusAction(sessionDeps, id, childId);
    return reply.code(r.code).send(r.body);
  });
```

- [ ] **Step 6: Run tests + typecheck, then the whole suite**

Run: `cd control-plane && npm test -- test/subagents.test.ts && npx tsc --noEmit && npm test`
Expected: new tests PASS, tsc clean, suite green

- [ ] **Step 7: Commit**

```bash
git add control-plane/src control-plane/test
git commit -m "feat(cp): runner-facing delegate endpoints — spawn + poll linked child sessions"
```

---

### Task 4: Interrupt/reconciler propagation to children

**Files:**
- Modify: `control-plane/src/subagents.ts` (interruptChildSessions helper)
- Modify: `control-plane/src/agents-api.ts:767-779` (/v1 interrupt)
- Modify: `control-plane/src/public-api.ts:552-560` (/api interrupt)
- Modify: `control-plane/src/main.ts:193-196` (reconciler onSessionFailed)
- Test: `control-plane/test/subagents.test.ts`

**Interfaces:**
- Produces: `interruptChildSessions(deps: {repo, orchestrator}, parentId, settle?): Promise<void>` exported from `src/subagents.ts`.
- Consumes: `repo.listChildSessions` (Task 3), `repo.takePendingLaunch`, `repo.setSessionStatus`, `orchestrator.stopSession` (existing).

- [ ] **Step 1: Write the failing test**

Append to `test/subagents.test.ts`:

```ts
import { interruptChildSessions } from "../src/subagents.ts";

test("interruptChildSessions: stops, un-parks, idles, and events every in-flight child", async () => {
  const stopped: string[] = []; const unparked: string[] = [];
  const statuses: Record<string, string> = {}; const events: Record<string, any[]> = {};
  const repo = {
    async listChildSessions(pid: string) {
      return pid === "sesn_parent" ? [{ id: "sesn_c1", status: "running" }, { id: "sesn_c2", status: "queued" }] : [];
    },
    async takePendingLaunch(id: string) { unparked.push(id); return null; },
    async setSessionStatus(id: string, status: string) { statuses[id] = status; return { applied: true }; },
    async appendEvents(id: string, evts: any[]) { (events[id] ??= []).push(...evts); return 1; },
  };
  const orchestrator = { async stopSession(id: string) { stopped.push(id); } };
  const settled: string[] = [];
  await interruptChildSessions({ repo, orchestrator } as any, "sesn_parent", async (id) => { settled.push(id); });
  assert.deepEqual(stopped, ["sesn_c1", "sesn_c2"]);
  assert.deepEqual(unparked, ["sesn_c1", "sesn_c2"]);
  assert.deepEqual(statuses, { sesn_c1: "idle", sesn_c2: "idle" });
  assert.deepEqual(settled, ["sesn_c1", "sesn_c2"]);
  assert.equal(events.sesn_c1[0].type, "session.interrupted");
  assert.equal(events.sesn_c1[0].payload.by, "parent");
});

test("interruptChildSessions: one failing child does not block the rest", async () => {
  const statuses: Record<string, string> = {};
  const repo = {
    async listChildSessions() { return [{ id: "sesn_bad", status: "running" }, { id: "sesn_ok", status: "running" }]; },
    async takePendingLaunch() { return null; },
    async setSessionStatus(id: string, status: string) { statuses[id] = status; return { applied: true }; },
    async appendEvents() { return 1; },
  };
  const orchestrator = { async stopSession(id: string) { if (id === "sesn_bad") throw new Error("k8s down"); } };
  await interruptChildSessions({ repo, orchestrator } as any, "sesn_parent");
  assert.equal(statuses.sesn_ok, "idle");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && npm test -- test/subagents.test.ts`
Expected: FAIL — `interruptChildSessions` is not exported

- [ ] **Step 3: Implement the helper**

Append to `src/subagents.ts`:

```ts
/** Interrupting (or zombie-failing) a parent also interrupts its in-flight
 *  children — a delegated session has nobody left to collect its result.
 *  One level deep ⇒ no recursion. Mirrors the /v1 interrupt sequence:
 *  stop Job, un-park, idle (resumable), settle costs, event. Per-child
 *  failures are logged and skipped — the next child still gets stopped. */
export async function interruptChildSessions(
  deps: {
    repo: {
      listChildSessions(parentId: string): Promise<{ id: string }[]>;
      takePendingLaunch(id: string): Promise<unknown>;
      setSessionStatus(id: string, status: string): Promise<unknown>;
      appendEvents(id: string, events: { type: string; payload?: unknown }[]): Promise<unknown>;
    };
    orchestrator: { stopSession(id: string): Promise<void> };
  },
  parentId: string, settle?: (id: string) => Promise<void>,
): Promise<void> {
  for (const child of await deps.repo.listChildSessions(parentId)) {
    try {
      await deps.orchestrator.stopSession(child.id);
      await deps.repo.takePendingLaunch(child.id);
      await deps.repo.setSessionStatus(child.id, "idle");
      await settle?.(child.id).catch(() => {});
      await deps.repo.appendEvents(child.id, [{ type: "session.interrupted", payload: { by: "parent" } }]);
    } catch (err) {
      console.warn(`child interrupt of ${child.id} failed:`, err);
    }
  }
}
```

- [ ] **Step 4: Wire the three call sites**

`agents-api.ts` — extend the `./subagents.ts` import with `interruptChildSessions`; in `POST /v1/sessions/:id/interrupt` (:767), after the parent's `appendEvents(... session.interrupted ...)`:

```ts
    await interruptChildSessions({ repo, orchestrator }, id, opts?.settleSession);
```

`public-api.ts` — same import; in `api.post("/sessions/:id/interrupt", …)` (:552), after its `appendEvents`:

```ts
      await interruptChildSessions({ repo, orchestrator }, req.params.id, opts?.settleSession);
```

`main.ts` — extend the `./subagents.ts` import (add the import line near the other `./` imports): `import { interruptChildSessions } from "./subagents.ts";` and change the `startReconciler` call (:193-196) to:

```ts
startReconciler(repo, orchestrator, async () => {
  await sweepPendingLaunches(repo, orchestrator, modelPhase, wake);
  await projectModelRouting();
}, async (id) => {
  await settle(id);
  // A zombie-failed parent leaves nobody to collect its children's results.
  await interruptChildSessions({ repo, orchestrator }, id, settle);
});
```

- [ ] **Step 5: Run tests + typecheck + suite**

Run: `cd control-plane && npm test -- test/subagents.test.ts && npx tsc --noEmit && npm test`
Expected: PASS, tsc clean, suite green

- [ ] **Step 6: Commit**

```bash
git add control-plane/src control-plane/test
git commit -m "feat(cp): interrupt/zombie-fail of a parent session propagates to its delegated children"
```

---

### Task 5: SDK `extra_tools` seam + runner Delegate tool, image dev37

**Files:**
- Modify: `agent-sdk/devproof_agent_sdk/types.py` (AgentOptions)
- Modify: `agent-sdk/devproof_agent_sdk/query.py:143-146` (toolbox build)
- Modify: `agent-sdk/tests/test_query_loop.py`
- Modify: `session-runner/runner.py`
- Modify: `session-runner/test_runner.py`

**Interfaces:**
- Consumes: `DEVPROOF_AGENT_CONFIG.subagents` (Task 2); CP endpoints `POST {EVENTS_URL}/delegate`, `GET {EVENTS_URL}/delegate/<childId>` (Task 3); existing `_download`, `FILES_URL`, `EVENTS_URL`, `TURN`; SDK `Tool` dataclass (`tools/base.py`: async `executor(input, cwd) -> (output_text, is_error)`).
- Produces: `AgentOptions.extra_tools: list` (SDK); tool `Delegate(agent, prompt, files?)`; runner module-level `SUBAGENTS`, `SUBAGENTS_DIR`, `DELEGATE_POLL_SEC`, `delegation_prompt_block(subagents)`, `run_delegate(tool_input, cwd)`, `delegate_tool()`.

**Design notes:**
- The SDK seam is GENERIC: `extra_tools` merges caller-provided `Tool` instances into the toolbox — no delegation knowledge in the SDK (mirrors the Skill-tool injection precedent in `query()`).
- Blocking urllib calls run via `anyio.to_thread.run_sync`, polls via `anyio.sleep` — the executor shares the event loop with the SDK's httpx/MCP clients. Multiple Delegate calls in one assistant message execute sequentially (query.py runs tool_use blocks in order); each spawns its own child.
- The tool result's FIRST line is a compact JSON header `{"session": …, "files": […]}` — the SDK's `_cap_result` truncates tool results to window-chars in history and the console parses the header for the child link, so the header must lead.
- Wrap-up turns (`no_tools=True`) pass `extra_tools=[]` — the tool-less wrap-up contract holds.
- The prompt block must not contain the word "Claude" (global constraint); schema uses only enum/string/array types (GBNF-safe, per the SDK's design).

- [ ] **Step 1: Write the failing SDK test (extra_tools seam)**

Append to `agent-sdk/tests/test_query_loop.py` (inside `QueryLoopTest`):

```python
    def test_extra_tools_are_registered_and_executed(self):
        from devproof_agent_sdk.tools import Tool

        async def echo(tool_input, cwd):
            return f"echo:{tool_input.get('text')}", False

        extra = Tool(name="Echo", description="Echo back",
                     input_schema={"type": "object",
                                   "properties": {"text": {"type": "string"}},
                                   "required": ["text"]},
                     executor=echo)
        self.gw.script = [
            {"blocks": [{"type": "tool_use", "id": "toolu_1", "name": "Echo",
                         "input": {"text": "hi"}}], "stop_reason": "tool_use"},
            {"blocks": [{"type": "text", "text": "done"}]},
        ]
        messages, err = collect("go", self.opts(extra_tools=[extra]))
        self.assertIsNone(err)
        init = by_type(messages, SystemMessage)[0]
        self.assertIn("Echo", init.data["tools"])
        results = [b for m in by_type(messages, UserMessage) for b in m.content
                   if isinstance(b, ToolResultBlock)]
        self.assertEqual(results[0].content, "echo:hi")
        self.assertFalse(results[0].is_error)
        # The tool schema rides the API request like any built-in's.
        tool_names = [t["name"] for t in self.gw.requests[0]["tools"]]
        self.assertIn("Echo", tool_names)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent-sdk && python -m unittest discover -s tests -v`
Expected: FAIL — `TypeError: AgentOptions.__init__() got an unexpected keyword argument 'extra_tools'`

- [ ] **Step 3: Implement the seam**

`agent-sdk/devproof_agent_sdk/types.py` — add to `AgentOptions` after `skills_dir`:

```python
    # Fully-formed Tool instances injected by the caller (e.g. the session
    # runner's Delegate tool) — merged into the toolbox alongside built-ins.
    extra_tools: list = field(default_factory=list)
```

`agent-sdk/devproof_agent_sdk/query.py` — after `toolbox.builtin = select_builtins(enabled)` (line 145):

```python
    for extra in options.extra_tools or []:
        toolbox.builtin[extra.name] = extra
```

(`ignored_tools` is computed from `options.tools` names only — extra tools ride a separate option, so it stays correct.)

- [ ] **Step 4: Run SDK tests to verify they pass**

Run: `cd agent-sdk && python -m unittest discover -s tests -v`
Expected: PASS (whole SDK suite green, incl. the new test)

- [ ] **Step 5: Write the failing runner tests**

Append to `session-runner/test_runner.py`:

```python
import anyio
import json
import tempfile


class DelegationPromptTest(unittest.TestCase):
    def test_empty_subagents_add_nothing(self):
        self.assertEqual(runner.delegation_prompt_block([]), "")

    def test_block_lists_names_and_instructions(self):
        block = runner.delegation_prompt_block([
            {"name": "reviewer", "agentId": "agent_1", "instructions": "use for code review"},
            {"name": "writer", "agentId": "agent_2", "instructions": "drafts docs"},
        ])
        self.assertIn("Delegate", block)
        self.assertIn('"reviewer": use for code review', block)
        self.assertIn('"writer": drafts docs', block)
        self.assertIn(runner.SUBAGENTS_DIR, block)
        self.assertNotIn("Claude", block)


class DelegateToolTest(unittest.TestCase):
    def setUp(self):
        runner.SUBAGENTS[:] = [{"name": "reviewer", "agentId": "agent_1", "instructions": "x"}]
        self._orig = (runner._post_json, runner._get_json, runner._upload_file, runner._download,
                      runner.SUBAGENTS_DIR, runner.DELEGATE_POLL_SEC)
        # run_delegate mkdirs under SUBAGENTS_DIR before the (mocked) download —
        # /mnt may not be writable in the test container, so point it at a tmp dir.
        runner.SUBAGENTS_DIR = tempfile.mkdtemp()

    def tearDown(self):
        runner.SUBAGENTS[:] = []
        (runner._post_json, runner._get_json, runner._upload_file, runner._download,
         runner.SUBAGENTS_DIR, runner.DELEGATE_POLL_SEC) = self._orig

    def test_unknown_agent_is_error(self):
        text, is_error = anyio.run(runner.run_delegate, {"agent": "nope", "prompt": "hi"}, "/work")
        self.assertTrue(is_error)
        self.assertIn("unknown subagent", text)

    def test_happy_path_header_leads_then_text(self):
        polls = iter([{"status": "running"}, {"status": "idle", "resultText": "done!",
                      "outputs": [{"id": "file_9", "name": "out/report.md"}]}])
        downloads = []
        runner._post_json = lambda url, body: {"session": "sesn_child"}
        runner._get_json = lambda url: next(polls)
        runner._download = lambda fid, dest: downloads.append((fid, dest))
        runner.DELEGATE_POLL_SEC = 0
        text, is_error = anyio.run(runner.run_delegate, {"agent": "reviewer", "prompt": "go"}, "/work")
        self.assertFalse(is_error)
        header = json.loads(text.split("\n", 1)[0])
        self.assertEqual(header["session"], "sesn_child")
        expected = f"{runner.SUBAGENTS_DIR}/reviewer/out/report.md"
        self.assertEqual(header["files"], [expected])
        self.assertTrue(text.endswith("done!"))
        self.assertEqual(downloads, [("file_9", expected)])

    def test_failed_child_is_error_with_detail(self):
        runner._post_json = lambda url, body: {"session": "sesn_child"}
        runner._get_json = lambda url: {"status": "failed", "failureDetail": "deployment gone"}
        runner.DELEGATE_POLL_SEC = 0
        text, is_error = anyio.run(runner.run_delegate, {"agent": "reviewer", "prompt": "go"}, "/work")
        self.assertTrue(is_error)
        self.assertIn("deployment gone", text)
        self.assertIn("sesn_child", text)  # header still leads

    def test_files_are_uploaded_and_turn_attributed(self):
        posted = {}
        runner._upload_file = lambda path: "file_up1"
        runner._post_json = lambda url, body: posted.update(body) or {"session": "sesn_child"}
        runner._get_json = lambda url: {"status": "idle", "resultText": "ok", "outputs": []}
        runner.DELEGATE_POLL_SEC = 0
        anyio.run(runner.run_delegate,
                  {"agent": "reviewer", "prompt": "go", "files": ["/work/a.csv"]}, "/work")
        self.assertEqual(posted["files"], ["file_up1"])
        self.assertEqual(posted["agent_id"], "agent_1")
        if runner.TURN is None:
            self.assertNotIn("turn", posted)
        else:
            self.assertEqual(posted["turn"], int(runner.TURN))

    def test_delegate_tool_shape(self):
        tool = runner.delegate_tool()
        self.assertEqual(tool.name, "Delegate")
        self.assertEqual(tool.input_schema["properties"]["agent"]["enum"], ["reviewer"])
        self.assertEqual(tool.input_schema["required"], ["agent", "prompt"])
```

- [ ] **Step 6: Run runner tests to verify they fail (inside the current image)**

Run (from `session-runner/`):
`docker run --rm --entrypoint python -v .:/src -w /src devproof/session-runner:dev36 -m unittest test_runner -v`
Expected: FAIL — `AttributeError: module 'runner' has no attribute 'delegation_prompt_block'`

- [ ] **Step 7: Implement in `runner.py`**

Add `import urllib.error` and `import urllib.parse` next to `import urllib.request` (line 15). After the `MEMORY_DIR` constants (line ~97):

```python
SUBAGENTS = CONFIG.get("subagents") or []
SUBAGENTS_DIR = "/mnt/session/subagents"
DELEGATE_POLL_SEC = 3
```

Replace `system_prompt()` (line 122-124) with the block builder + append:

```python
def delegation_prompt_block(subagents: list) -> str:
    """Generated per launch from structured config (never stored), so
    renaming/removing a subagent never leaves stale prompt text."""
    if not subagents:
        return ""
    lines = "\n".join(f'- "{s["name"]}": {s["instructions"]}' for s in subagents)
    return (
        f"\n\nDelegation: you can push work to the following agents with the"
        f" Delegate tool (arguments: agent name, a self-contained prompt, and"
        f" optionally files — absolute paths of files in this pod to hand"
        f" over). The call blocks until that agent finishes and returns its"
        f" answer; files it produces are placed under {SUBAGENTS_DIR}/<agent>/.\n{lines}"
    )


def system_prompt() -> str:
    agent = (CONFIG.get("system_prompt") or "").strip()
    return PLATFORM_PROMPT_20260712 + ("\n\n" + agent if agent else "") + delegation_prompt_block(SUBAGENTS)
```

After `post_status` / before `emit` (line ~253), the HTTP helpers, executor, and tool factory:

```python
def _post_json(url: str, body: dict) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


def _get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=30) as res:
        return json.loads(res.read())


def _upload_file(path: str) -> str:
    """Attach a pod-local file to the delegate call: upload as a regular file
    record (mid-turn artifacts aren't registered anywhere yet)."""
    with open(path, "rb") as f:
        data = f.read()
    name = os.path.basename(path)
    req = urllib.request.Request(
        f"{FILES_URL}/raw?name={urllib.parse.quote(name)}&session={SESSION_ID}&kind=upload",
        data=data, headers={"Content-Type": "application/octet-stream"}, method="POST")
    with urllib.request.urlopen(req, timeout=300) as res:
        return json.loads(res.read())["id"]


async def run_delegate(tool_input: dict, cwd: str) -> tuple[str, bool]:
    """Delegate-tool executor: run a configured subagent as a full platform
    session and block until it finishes. Blocking HTTP runs in worker threads
    and polls sleep on the loop — the SDK shares the event loop with its
    httpx/MCP clients. The result's FIRST line is a one-line JSON header
    {"session", "files"} — the SDK caps tool results at window-chars in
    history and the console parses the header, so it must lead."""
    name = tool_input.get("agent") or ""
    match = next((s for s in SUBAGENTS if s["name"] == name), None)
    if match is None:
        return f"unknown subagent: {name}", True
    try:
        file_ids = []
        for p in tool_input.get("files") or []:
            file_ids.append(await anyio.to_thread.run_sync(_upload_file, p))
        body = {"agent_id": match["agentId"], "prompt": tool_input.get("prompt") or "",
                "files": file_ids}
        if TURN is not None:
            body["turn"] = int(TURN)
        created = await anyio.to_thread.run_sync(_post_json, f"{EVENTS_URL}/delegate", body)
        child = created["session"]
        while True:
            status = await anyio.to_thread.run_sync(_get_json, f"{EVENTS_URL}/delegate/{child}")
            if status.get("status") in ("idle", "completed", "failed"):
                break
            await anyio.sleep(DELEGATE_POLL_SEC)
        paths = []
        for f in status.get("outputs") or []:
            dest = os.path.join(SUBAGENTS_DIR, name, f["name"]).replace("\\", "/")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            await anyio.to_thread.run_sync(_download, f["id"], dest)
            paths.append(dest)
        header = json.dumps({"session": child, "files": paths})
        text = status.get("resultText") or ""
        if status.get("status") == "failed":
            detail = status.get("failureDetail") or text or "subagent session failed"
            return f"{header}\n\nSubagent failed: {detail}", True
        return f"{header}\n\n{text}", False
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:500]
        return f"delegate failed: {err.code} {detail}", True
    except Exception as err:  # noqa: BLE001 — a tool error must never kill the turn
        return f"delegate failed: {type(err).__name__}: {err}", True


def delegate_tool():
    """The Delegate tool, injected via AgentOptions.extra_tools. Schema is
    GBNF-safe by construction (enum/string/array only — no pattern, no
    maxLength), matching the SDK's built-in tool schema rules."""
    from devproof_agent_sdk.tools import Tool
    return Tool(
        name="Delegate",
        description="Push a task to another configured agent and wait for its result.",
        input_schema={
            "type": "object",
            "properties": {
                "agent": {"type": "string", "enum": [s["name"] for s in SUBAGENTS],
                          "description": "name of the configured agent to delegate to"},
                "prompt": {"type": "string", "description": "self-contained task description"},
                "files": {"type": "array", "items": {"type": "string"},
                          "description": "absolute paths of files in this pod to attach"},
            },
            "required": ["agent", "prompt"],
        },
        executor=run_delegate,
    )
```

In `options()` (line 383-393), add one line — `extra_tools` after `mcp_servers`:

```python
    def options(max_turns: int, resume: str | None, no_tools: bool = False):
        return AgentOptions(
            model=CONFIG["model"],
            system_prompt=system_prompt(),
            tools=[] if no_tools else (CONFIG.get("tools") or []),
            max_turns=max_turns,
            resume=resume,
            cwd="/work",
            skills_dir=SKILLS_DIR,
            mcp_servers={} if no_tools else expand_mcp_headers(CONFIG.get("mcp_servers") or {}),
            # Wrap-up turns are tool-less end to end — Delegate included.
            extra_tools=[] if (no_tools or not SUBAGENTS) else [delegate_tool()],
        )
```

- [ ] **Step 8: Build dev37 and run all tests inside it**

Run (from the REPO ROOT — the Dockerfile installs `agent-sdk/`):

```bash
docker build -t devproof/session-runner:dev37 -f session-runner/Dockerfile .
docker run --rm --entrypoint python -v ./session-runner:/src -w /src devproof/session-runner:dev37 -m unittest test_runner -v
docker run --rm --entrypoint python -v ./agent-sdk:/sdk -w /sdk devproof/session-runner:dev37 -m unittest discover -s tests -v
```

Expected: all runner tests PASS (pre-existing + the 7 new ones); full SDK suite PASS inside the image.

- [ ] **Step 9: Commit**

```bash
git add agent-sdk control-plane session-runner
git commit -m "feat(runner): Delegate tool via new SDK extra_tools seam (image dev37)"
```

---

### Task 6: Console — Subagents section in the agent form + detail card

**Files:**
- Modify: `console/app/agents/agent-form.tsx`
- Modify: `console/app/agents/page.tsx` (pass `agents` to CreateAgentButton)
- Modify: `console/app/agents/[id]/page.tsx` (fetch agents; pass to EditAgentButton + AgentTabs)
- Modify: `console/app/agents/[id]/tabs.tsx` (Subagents card)

**Interfaces:**
- Consumes: `POST /v1/agents` / `POST /v1/agents/:id/versions` accepting `subagents: [{agentId, instructions}]` (Task 1); version rows now carry `subagents`.
- Produces: `AgentFormModal`/`CreateAgentButton`/`EditAgentButton` gain an `agents: {id: string; name: string; status: string}[]` prop; `AgentTabs` gains `agents?: any[]`.

- [ ] **Step 1: Form state + payload (`agent-form.tsx`)**

Add `agents` to the props of `AgentFormModal`, `CreateAgentButton`, and `EditAgentButton` (`agents: any[]`, threaded through like `environments`). Seed state (inside the `useState` initializer, after `mcp:` — note trailing comma discipline):

```ts
    subagents: ((initial?.subagents as { agentId: string; instructions: string }[] | undefined) ?? []),
```

In the `submit` body object, after `mcpServers`:

```ts
      subagents: f.subagents.filter((s: any) => s.agentId && s.instructions.trim()),
```

Add the section after the MCP servers `Field` (line ~156). Active agents only, excluding the agent being edited; an already-selected id stays selectable so editing doesn't silently drop it:

```tsx
      <Field label="Subagents" stack
             hint="agents this agent can push work to; the instructions tell it when to delegate">
        <div className="kvrows">
          {f.subagents.map((s: any, i: number) => (
            <div className="kvrow" key={i}>
              <select value={s.agentId} style={{ width: 180, flex: "none" }}
                onChange={(e) => set("subagents", f.subagents.map((x: any, j: number) =>
                  j === i ? { ...x, agentId: e.target.value } : x))}>
                <option value="" disabled>Select agent…</option>
                {agents
                  .filter((a: any) => a.id !== agentId && (a.status !== "disabled" || a.id === s.agentId))
                  .map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <input placeholder="when to use this agent…" value={s.instructions}
                onChange={(e) => set("subagents", f.subagents.map((x: any, j: number) =>
                  j === i ? { ...x, instructions: e.target.value } : x))} />
              <button className="iconbtn danger" title="Remove subagent" aria-label="Remove subagent"
                onClick={() => set("subagents", f.subagents.filter((_: any, j: number) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button className="ghost"
            onClick={() => set("subagents", [...f.subagents, { agentId: "", instructions: "" }])}>
            + Add subagent</button></div>
        </div>
      </Field>
```

- [ ] **Step 2: Thread the `agents` prop from both pages**

`console/app/agents/page.tsx`: the page already fetches the agent list for its table — pass it to `CreateAgentButton` (`agents={<that list>}`; match the local variable name).

`console/app/agents/[id]/page.tsx`: add to the `Promise.all` (line 14-23):

```ts
    wsGet<{ agents: any[] }>(`/v1/agents?limit=1000`),
```

destructure it as `{ agents: allAgents }`, then pass `agents={allAgents}` to `EditAgentButton` (line 46) and `agents={allAgents}` to `AgentTabs` (line 52).

- [ ] **Step 3: Detail card (`tabs.tsx`)**

Add `agents = []` to the `AgentTabs` props (typed `agents?: any[]`), a resolver next to `envName` (line 16):

```ts
  const agentName = (id: string) => agents.find((a: any) => a.id === id)?.name ?? id;
```

and after the MCP servers card (line 62-71):

```tsx
          {(v.subagents ?? []).length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <h3>Subagents ({v.subagents.length})</h3>
              <div>{v.subagents.map((s: any) => (
                <span className="chip" key={s.agentId} style={{ marginRight: 6 }} title={s.instructions}>
                  <Link href={`/agents/${s.agentId}`}><code>{s.agentId}</code></Link>{" "}
                  {agentName(s.agentId)} <span className="muted">{s.instructions}</span>
                </span>
              ))}</div>
            </div>
          )}
```

(Convention check: the full id is the clickable element — matches the Managed Agents id-link rule.)

- [ ] **Step 4: Build**

Run: `cd console && npx next build`
Expected: build succeeds, no type errors

- [ ] **Step 5: Commit**

```bash
git add console/app/agents
git commit -m "feat(console): subagents section on the agent form + detail card"
```

---

### Task 7: Console — Subagent badge, child link, spawned-by crumb

**Files:**
- Modify: `console/app/sessions/[id]/rows.ts` (RowKind + kind rewrite)
- Modify: `console/app/sessions/[id]/transcript.tsx` (tool filter)
- Modify: `console/app/sessions/[id]/timeline.tsx` (COLOR)
- Modify: `console/app/sessions/[id]/panels.tsx` (child-session link)
- Modify: `console/app/sessions/[id]/page.tsx` (spawned-by crumb)
- Modify: `console/app/globals.css` (chip style + token)

**Interfaces:**
- Consumes: delegate rows arrive as ordinary `tool.call`/`tool.result` events with tool name `Delegate` (Task 5); the tool result's first line is the JSON header `{"session", "files"}`; `session.parent_session_id` in `GET /v1/sessions/:id` (SELECT * — automatic).
- Precedent: the Skill-tool kind rewrite (`rows.ts:125-137`, commit c00feeb) — the chip/label/filter/timeline all key off `Row["kind"]`, so one rewrite branch lights up the whole UI.

- [ ] **Step 1: Row kind (`rows.ts`)**

Extend the kind union and chip map (lines 5, 17-18):

```ts
export type RowKind = "user" | "agent" | "thinking" | "tool" | "skill" | "subagent" | "system";
```

```ts
export const CHIP: Record<RowKind, string> =
  { user: "User", agent: "Agent", thinking: "Think", tool: "Tool", skill: "Skill",
    subagent: "Subagent", system: "Sys" };
```

In the title loop of `groupEvents`, directly after the Skill branch (`rows.ts:125-137`), add a Delegate branch (same shape):

```ts
    if (names.length === 1 && names[0] === "Delegate") {
      // Delegation rows get their own badge + title (spec 2026-07-17); the
      // result body renders exactly like a tool result.
      r.kind = "subagent";
      const targets = [...new Set(calls.map((e) => String(e.payload?.input?.agent ?? "?")))];
      r.title = `delegate: ${targets.join(", ")}`;
      if (calls.length === 1) r.preview = firstLine(String(calls[0].payload?.input?.prompt ?? ""));
      continue;
    }
```

(The pending-row check runs BEFORE this rewrite — the existing comment at `rows.ts:111-112` already documents that ordering; no change needed there.)

- [ ] **Step 2: Tool filter (`transcript.tsx`) + timeline color (`timeline.tsx`)**

`transcript.tsx` `filterRows` (line ~21) — the tool filter keeps skill AND subagent rows:

```ts
    if (filter === "tool" && r.kind !== "tool" && r.kind !== "skill" && r.kind !== "subagent") return false;
```

`timeline.tsx` COLOR map (lines 5-8) gains the kind:

```ts
const COLOR: Record<Row["kind"], string> = {
  user: "var(--accent)", agent: "var(--blue)", thinking: "#9ec1f7",
  tool: "#8a63d2", skill: "var(--skill)", subagent: "var(--subagent)", system: "var(--muted)",
};
```

(No `transcript.tsx` chip change beyond the filter — the chip class and label come from `r.kind`/`CHIP`, so the rewrite in Step 1 renders the badge automatically. Same in the `EventPanel` subtitle chip.)

- [ ] **Step 3: Child link (`panels.tsx`)**

Add a header-parser above `EventPanel` (after `StepDeployments`, line ~276):

```tsx
// Delegate tool results lead with a one-line JSON header {"session","files"}
// (runner contract — survives history/event truncation). First parseable
// header wins; a non-delegate mono block never parses as an object with .session.
function delegateChild(row: Row): string | null {
  for (const e of row.events) {
    if (e.type !== "tool.result" || typeof e.payload?.output !== "string") continue;
    try {
      const header = JSON.parse(e.payload.output.split("\n", 1)[0]);
      if (typeof header?.session === "string") return header.session;
    } catch { /* not a delegate result */ }
  }
  return null;
}
```

In `EventPanel`, next to the `titleMcp` computation:

```tsx
  const childId = row.kind === "subagent" ? delegateChild(row) : null;
```

and after `<StepDeployments …/>` add:

```tsx
          {childId && <a href={`/sessions/${childId}`}>· session <code>{childId}</code></a>}
```

- [ ] **Step 4: Spawned-by crumb (`page.tsx`)**

Spec: a dangling parent id (parent deleted) renders as plain text, not a dead link. After the existing `Promise.all` (line 10-15), add:

```ts
  const parent = session.parent_session_id
    ? await wsGet<any>(`/v1/sessions/${session.parent_session_id}`).catch(() => null)
    : null;
```

In the crumbs line (line 20), after `<CopyId id={session.id} />`:

```tsx
      {session.parent_session_id && <> · spawned by{" "}
        {parent
          ? <Link href={`/sessions/${session.parent_session_id}`}><code>{session.parent_session_id}</code></Link>
          : <code>{session.parent_session_id}</code>}</>}
```

- [ ] **Step 5: Chip style (`globals.css`)**

New colour token next to `--skill` (line ~33) — `light-dark()` form, per the theme rules:

```css
  --subagent: light-dark(#0f766e, #2dd4bf);
```

After `.trow-chip.skill` (line ~485-487):

```css
/* Subagent delegation rows (Delegate tool, rows.ts rewrites kind): same
   token + tint recipe as skill/mcp; "Subagent" doesn't fit the fixed 46px,
   so this chip alone sizes to content. */
.trow-chip.subagent { width: auto; padding: 2px 7px; color: var(--subagent);
  background: color-mix(in srgb, var(--subagent) 12%, transparent);
  border-color: color-mix(in srgb, var(--subagent) 45%, var(--line)); }
```

- [ ] **Step 6: Build + commit**

Run: `cd console && npx next build`
Expected: build succeeds

```bash
git add console/app
git commit -m "feat(console): Subagent badge, child-session link, spawned-by crumb"
```

---

### Task 8: Docs + live end-to-end verification

**Files:**
- Modify: `CLAUDE.md` (runner tag dev36 → dev37 in the run block and wherever the current tag is named; one-line delegation note)

- [ ] **Step 1: CLAUDE.md**

Update `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev36` → `:dev37` in the run block and update the "current devNN" mention in the session-runner bullet (note dev37 adds the Delegate tool — agent delegation spec 2026-07-17). Add one bullet under Conventions & gotchas:

```
- **Agent delegation (spec 2026-07-17):** `agent_versions.subagents` (migration 041) lists agents a version may push work to; the runner injects a `Delegate` tool via the SDK's `AgentOptions.extra_tools` seam (in-process, no egress) whose executor calls `POST/GET /v1/sessions/:id/delegate…` to run a FULL child session (`sessions.parent_session_id`) synchronously. One level only: the CP resolves `subagents` to `[]` for any session with a parent. Interrupt/zombie-fail of the parent interrupts in-flight children. The delegate result's first line is a JSON header `{"session","files"}` (survives result truncation; console parses it for the child link — rows.ts rewrites Delegate rows to the `subagent` kind, like Skill).
```

- [ ] **Step 2: Restart the control plane and console** (per CLAUDE.md run block, with `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev37`), confirm all pages 200: `/`, `/agents`, `/sessions`, `/deployments`, `/routings`, `/settings`.

- [ ] **Step 3: Live end-to-end** (docker-desktop cluster):
  1. Create agent `t-sub-child` (any warm routing, e.g. via an existing routing name; simple system prompt "You produce short answers and write requested files to the outputs dir").
  2. Create agent `t-sub-parent` with `t-sub-child` as a subagent (instructions: "delegate any summarization task to it") — verify the form section, then the detail card.
  3. Start a session on `t-sub-parent` with a prompt that forces delegation ("Delegate to your subagent: have it write a file greeting.txt containing 'hello' and tell me its answer.").
  4. Verify: parent trace shows a **Subagent** chip on the delegate row; the row's panel links to the child session; the child session's crumb links back; child appears in `/sessions` with its own tokens; `/mnt/session/subagents/…` files usable by the parent (parent's answer references the child's output).
  5. Interrupt propagation: start another delegating session, interrupt the parent mid-delegation, confirm the child flips to idle with a `session.interrupted {by: "parent"}` event.
  6. Config guard: `curl -X POST localhost:7080/v1/sessions/<parent>/delegate -H 'Content-Type: application/json' -d '{"agent_id":"agent_notconfigured","prompt":"x"}'` → 403 (use a live in-flight parent id, any unconfigured agent id).

- [ ] **Step 4: Final green run**

Run: `cd control-plane && npm test && npx tsc --noEmit`
Expected: suite green, tsc clean

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: agent delegation notes; runner image dev37"
```
