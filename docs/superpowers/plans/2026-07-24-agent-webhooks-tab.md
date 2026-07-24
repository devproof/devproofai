# Agent "Webhooks" Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth "Webhooks" tab to the console's agent detail page showing copy-paste curl examples for triggering the agent via the existing public `/api` surface.

**Architecture:** Console-only (spec `docs/superpowers/specs/2026-07-24-agent-webhooks-tab-design.md`). No API, DB, or control-plane changes. Extract the `Snippet`/`CopyButton` components from the routing Connect tab into a shared module, build a new `WebhooksTab` component with four curl cards, and wire it into the existing `AgentTabs` client component.

**Tech Stack:** Next.js (App Router), React client components, TypeScript. The console has NO component-test infrastructure (deliberate, per spec) — verification is `npx next build` (which type-checks) plus a live check against the running console.

## Global Constraints

- **No AI references in commit messages** — no `Co-Authored-By: Claude`, no "Generated with Claude Code" (project rule, overrides harness default).
- **Console is always a production build**: `npx next build && npx next start -p 7090`. A rebuild under a running `next start` pins old chunk hashes — kill the old server before restarting.
- **No transparent text buttons; table links regular weight** (console UI rules). The tab buttons and `iconbtn` copy buttons used here are the existing sanctioned patterns — copy them verbatim, don't restyle.
- **Do not export server-callable helpers from a `"use client"` module** — `app/lib/snippet.tsx` must export client components only.
- **Placeholders in snippets**: agent id is interpolated for real; session id, file id, and API key stay literal placeholders `sesn_…`, `file_…`, `dpk_…`.
- Gateway base URL: `process.env.DEVPROOF_GATEWAY_PUBLIC_URL ?? "http://localhost:14000"`, resolved server-side (same pattern as `console/app/routings/[name]/page.tsx:17`).
- This repo is CRLF on disk; when deleting whole lines with Edit, re-check `git diff` afterwards (known Edit line-collapse gotcha).

---

### Task 1: Extract `Snippet`/`CopyButton` into `app/lib/snippet.tsx`

**Files:**
- Create: `console/app/lib/snippet.tsx`
- Modify: `console/app/routings/[name]/connect.tsx` (lines 1–34: imports + the two local component definitions)

**Interfaces:**
- Consumes: nothing new — code moves verbatim from `connect.tsx`.
- Produces: `Snippet({ label?: string; text: string })` and `CopyButton({ text: string })`, exported from `console/app/lib/snippet.tsx`. Task 2 imports `Snippet` from `"../../lib/snippet"`. `ConnectTab`'s rendered output must be byte-identical.

- [ ] **Step 1: Create the shared module**

Create `console/app/lib/snippet.tsx` with exactly this content (the two components are moved verbatim from `connect.tsx`, plus `export` keywords and the header comment):

```tsx
"use client";
// Copy-paste snippet block with a copy button — shared by the routing
// Connect tab and the agent Webhooks tab. Client components only: nothing
// server-callable may be exported from this module.
import { useState } from "react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="iconbtn" title={copied ? "Copied!" : "Copy"} aria-label="Copy snippet"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); } catch { return; }
        setCopied(true); setTimeout(() => setCopied(false), 1500);
      }}>
      {copied
        ? <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 8.5 6 12.5 14 3.5" /></svg>
        : <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5" y="5" width="9" height="9" rx="1.5" /><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" /></svg>}
    </button>
  );
}

export function Snippet({ label, text }: { label?: string; text: string }) {
  return (
    <>
      {label && <div className="hint" style={{ marginTop: 8 }}>{label}</div>}
      <div style={{ position: "relative", marginTop: 6 }}>
        <pre className="block" style={{ margin: 0 }}>{text}</pre>
        <div style={{ position: "absolute", top: 6, right: 6 }}><CopyButton text={text} /></div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Point `connect.tsx` at the shared module**

In `console/app/routings/[name]/connect.tsx`, replace the file's header block — everything from line 1 through the end of the local `Snippet` definition (line 34, i.e. up to but NOT including the blank line before `export function ConnectTab`) — with:

```tsx
"use client";
// Connect tab (spec 2026-07-12): copy-paste client configs for Claude Code,
// Codex, and Hermes, prefilled with this deployment's name + gateway URL.
// Key values are shown once at creation and never retrievable, so snippets
// carry a dpk_… placeholder pointing at the API Keys page.
import Link from "next/link";
import { Snippet } from "../../lib/snippet";
```

Notes: the `useState` import goes away (it was only used by the removed `CopyButton`); `ConnectTab` itself uses only `Snippet`, so `CopyButton` is not imported here. Nothing inside `export function ConnectTab` changes.

- [ ] **Step 3: Verify the extraction with a production build**

```bash
cd console && npx next build
```

Expected: build completes with no TypeScript errors ("Compiled successfully", route listing printed). If it fails, the errors will name the offending import/path.

Also run `git diff console/app/routings` and confirm the diff shows ONLY removed component definitions + the import change (CRLF line-collapse gotcha check).

- [ ] **Step 4: Commit**

```bash
git add console/app/lib/snippet.tsx "console/app/routings/[name]/connect.tsx"
git commit -m "refactor(console): extract Snippet/CopyButton into shared app/lib/snippet"
```

---

### Task 2: `WebhooksTab` component + wiring into the agent detail page

**Files:**
- Create: `console/app/agents/[id]/webhooks.tsx`
- Modify: `console/app/agents/[id]/tabs.tsx` (tab union at lines 11–16, tab buttons at lines 31–35, new render block after the `obs` block at line 161)
- Modify: `console/app/agents/[id]/page.tsx` (resolve `gatewayUrl`, pass to `AgentTabs` at line 59)

**Interfaces:**
- Consumes: `Snippet` from `console/app/lib/snippet.tsx` (Task 1): `Snippet({ label?: string; text: string })`.
- Produces: `WebhooksTab({ agentId, gatewayUrl }: { agentId: string; gatewayUrl: string })` exported from `console/app/agents/[id]/webhooks.tsx`; `AgentTabs` gains an optional `gatewayUrl?: string` prop (defaulted to `"http://localhost:14000"` so other callers, if any, stay compilable).

- [ ] **Step 1: Create the WebhooksTab component**

Create `console/app/agents/[id]/webhooks.tsx` with exactly this content:

```tsx
"use client";
// Webhooks tab (spec 2026-07-24): copy-paste curl examples for triggering
// this agent from external systems via the public /api surface through the
// gateway pass-through. Documentation only — the endpoints are always live
// for any active agent; no server-side toggle exists.
import Link from "next/link";
import { Snippet } from "../../lib/snippet";

export function WebhooksTab({ agentId, gatewayUrl }: { agentId: string; gatewayUrl: string }) {
  return (
    <>
      <p className="sub" style={{ marginTop: 0 }}>
        Trigger this agent over HTTP through the gateway. Snippets are prefilled with this
        agent&apos;s id and the gateway URL — replace <code>dpk_…</code> with a key from the{" "}
        <Link href="/api-keys">API Keys</Link> page (key values are shown once at creation).
        The key determines the workspace.
      </p>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Create session</h3>
        <Snippet text={`curl -X POST ${gatewayUrl}/api/sessions \\\n  -H "Authorization: Bearer dpk_…" \\\n  -H "Content-Type: application/json" \\\n  -d '{"agent": "${agentId}", "prompt": "Describe the task…", "files": ["file_…"]}'`} />
        <div className="hint" style={{ marginTop: 6 }}>
          {'returns 201 {"id": "sesn_…", "status": "queued"} — the session id for the calls below; '}
          files is optional (ids from the upload call); 409 = agent disabled or its deployment
          failed, 400 = unknown file id
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Send a message to a session</h3>
        <Snippet text={`curl -X POST ${gatewayUrl}/api/sessions/sesn_…/messages \\\n  -H "Authorization: Bearer dpk_…" \\\n  -H "Content-Type: application/json" \\\n  -d '{"prompt": "Follow-up…", "files": ["file_…"]}'`} />
        <div className="hint" style={{ marginTop: 6 }}>
          returns 202; only idle or failed sessions accept new messages (failed resumes from the
          last completed turn&apos;s checkpoint) — a running session returns 409
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Upload a file</h3>
        <Snippet text={`curl -X POST ${gatewayUrl}/api/files \\\n  -H "Authorization: Bearer dpk_…" \\\n  -F "file=@report.pdf"`} />
        <div className="hint" style={{ marginTop: 6 }}>
          {'returns 201 {"id": "file_…"} — pass the id in files[]; single call up to 32 MB, use '}
          the chunked upload API (POST {gatewayUrl}/api/files/uploads) for larger files
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Check status / result</h3>
        <Snippet text={`curl ${gatewayUrl}/api/sessions/sesn_… \\\n  -H "Authorization: Bearer dpk_…"`} />
        <div className="hint" style={{ marginTop: 6 }}>
          poll status (queued | running | idle | completed | failed); produced output files are
          listed at GET {gatewayUrl}/api/sessions/sesn_…/resources
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Wire the tab into `tabs.tsx`**

Four edits in `console/app/agents/[id]/tabs.tsx`:

(a) Add the import below the existing imports (after `import { DateTime } from "../../lib/datetime";`):

```tsx
import { WebhooksTab } from "./webhooks";
```

(b) Extend the signature — replace:

```tsx
export function AgentTabs({ agent, observability, sessions, sessionCount = 0, initialTab = "agent",
                            skills = [], environments = [], vaults = [], routingWindows = {}, agents = [], wikis = [] }:
  { agent: any; observability: any; sessions: any[]; sessionCount?: number;
    initialTab?: "agent" | "sessions" | "obs"; skills?: any[]; environments?: any[]; vaults?: any[];
    routingWindows?: Record<string, number | null>; agents?: any[]; wikis?: any[] }) {
  const [tab, setTab] = useState<"agent" | "sessions" | "obs">(initialTab);
```

with:

```tsx
export function AgentTabs({ agent, observability, sessions, sessionCount = 0, initialTab = "agent",
                            skills = [], environments = [], vaults = [], routingWindows = {}, agents = [], wikis = [],
                            gatewayUrl = "http://localhost:14000" }:
  { agent: any; observability: any; sessions: any[]; sessionCount?: number;
    initialTab?: "agent" | "sessions" | "obs" | "webhooks"; skills?: any[]; environments?: any[]; vaults?: any[];
    routingWindows?: Record<string, number | null>; agents?: any[]; wikis?: any[]; gatewayUrl?: string }) {
  const [tab, setTab] = useState<"agent" | "sessions" | "obs" | "webhooks">(initialTab);
```

(c) Add the tab button — replace:

```tsx
        <button className={tab === "obs" ? "active" : ""} onClick={() => setTab("obs")}>Observability</button>
```

with:

```tsx
        <button className={tab === "obs" ? "active" : ""} onClick={() => setTab("obs")}>Observability</button>
        <button className={tab === "webhooks" ? "active" : ""} onClick={() => setTab("webhooks")}>Webhooks</button>
```

(d) Add the render block — after the closing of the `{tab === "obs" && (...)}` block (between its `)}` and the final `</>`), insert:

```tsx
      {tab === "webhooks" && <WebhooksTab agentId={agent.id} gatewayUrl={gatewayUrl} />}
```

- [ ] **Step 3: Pass the gateway URL from `page.tsx`**

Two edits in `console/app/agents/[id]/page.tsx`:

(a) After the `routingWindows` block (after the `await Promise.all(routingNames.map(...)));` statement, before `return (`), add:

```tsx
  // Gateway base URL for the Webhooks tab's curl examples — same resolution
  // as the routing Connect tab (routings/[name]/page.tsx).
  const gatewayUrl = process.env.DEVPROOF_GATEWAY_PUBLIC_URL ?? "http://localhost:14000";
```

(b) Pass it to `AgentTabs` — replace:

```tsx
      <AgentTabs agent={agent} observability={obs} sessions={sessions.sessions} sessionCount={sessions.count}
                 initialTab={sp.page ? "sessions" : "agent"}
                 skills={skills} environments={environments} vaults={vaults} routingWindows={routingWindows}
                 agents={allAgents} wikis={wikis} />
```

with:

```tsx
      <AgentTabs agent={agent} observability={obs} sessions={sessions.sessions} sessionCount={sessions.count}
                 initialTab={sp.page ? "sessions" : "agent"}
                 skills={skills} environments={environments} vaults={vaults} routingWindows={routingWindows}
                 agents={allAgents} wikis={wikis} gatewayUrl={gatewayUrl} />
```

- [ ] **Step 4: Verify with a production build**

```bash
cd console && npx next build
```

Expected: build completes with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add "console/app/agents/[id]/webhooks.tsx" "console/app/agents/[id]/tabs.tsx" "console/app/agents/[id]/page.tsx"
git commit -m "feat(console): agent Webhooks tab with public-API curl examples"
```

---

### Task 3: Live verification against the running console

**Files:** none (verification only).

**Interfaces:**
- Consumes: the running control plane on `:7080` (the agent page server-fetches from it) and the console production build from Task 2.
- Produces: nothing — a pass/fail report.

- [ ] **Step 1: Restart the console on the new build**

Kill any running `next start` first (a build under a running server pins old chunk hashes → client-side exception), then:

```bash
cd console && npx next start -p 7090
```

(The build already happened in Task 2 Step 4. The control plane must be running per the repo-root CLAUDE.md dev instructions; if it isn't, start it as documented there.)

- [ ] **Step 2: Exercise the touched flows**

In a browser (or curl for the 200-checks):

1. `http://localhost:7090/agents` → 200, open any agent.
2. Agent detail shows FOUR tabs: Agent, Sessions, Observability, Webhooks.
3. Webhooks tab: four cards (Create session, Send a message to a session, Upload a file, Check status / result); the create-session snippet contains the REAL agent id (`agent_…` of this agent) and the gateway URL (`http://localhost:14000` in dev); other ids are `sesn_…`/`file_…`/`dpk_…` placeholders; the API Keys link navigates to `/api-keys`.
4. Copy button on a snippet copies the full multi-line curl command (paste somewhere to confirm).
5. Agent/Sessions/Observability tabs still render (regression check on the union/prop changes).
6. `http://localhost:7090/routings` → open a routing → Connect tab renders exactly as before (regression check on the Snippet extraction).

Expected: all six pass. Any failure: stop and fix before claiming done (systematic-debugging skill).

- [ ] **Step 3: Optional end-to-end smoke of a copied snippet**

If a dpk_ key is at hand, run the copied create-session curl against `http://localhost:14000` with a real key: expect `201` with `{"id": "sesn_…"}` (or a 409 naming the deployment if the agent's routing target is down — both prove the snippet is wire-correct).

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** shared snippet module → Task 1; WebhooksTab with intro + four cards and exact hints (32 MB limit, idle|failed constraint, status enum, resources endpoint) → Task 2 Step 1; page/tabs wiring incl. gatewayUrl resolution → Task 2 Steps 2–3; verification incl. Connect-tab regression → Tasks 2 Step 4 + Task 3. Out-of-scope list respected (no toggle, no new routes, no inline upload).
- **Placeholder scan:** all code blocks are complete file contents or exact before/after replacements; no TBDs.
- **Type consistency:** `Snippet({ label?, text })` matches Task 1's export; `WebhooksTab({ agentId, gatewayUrl })` matches Task 2's usage `<WebhooksTab agentId={agent.id} gatewayUrl={gatewayUrl} />`; `gatewayUrl?: string` prop matches the `page.tsx` call site.
