# Deployment Connect Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Connect" tab (second position) to the deployment detail page showing copy-paste client configs for an Anthropic-dialect coding CLI, Codex, and Hermes, prefilled with the deployment name and gateway URL.

**Architecture:** Pure console change — one new client component (`connect.tsx`) rendered by the existing tab switcher in `tabs.tsx`. No control-plane, operator, or API changes. All inputs (name, gateway URL, kind, contextTokens) already reach `DeploymentTabs` as props.

**Tech Stack:** Next.js (app router, client components), existing console CSS (`card`, `hint`, `pre.block`, `iconbtn` classes).

**Spec:** `docs/superpowers/specs/2026-07-12-deployment-connect-tab-design.md`

## Global Constraints

- Console is ALWAYS verified with a production build: `npx next build` (dev mode is banned as too slow).
- No transparent text buttons; quiet `iconbtn` icon-buttons are the allowed exception (the copy button uses `iconbtn`).
- No browser `prompt()`/`confirm()`/`alert()`.
- Tab order: **Overview | Connect | Stats | Trace**.
- API key values are never retrievable after creation — snippets MUST use the literal placeholder `dpk_…`, never a real key.
- Avoid raw `'` and `"` characters in JSX text nodes (react/no-unescaped-entities); phrase copy without them.
- The console has no unit-test infra; verification is production build + live check against the running console (repo rule: "Verify before claiming done").

---

### Task 1: ConnectTab component + tab wiring

**Files:**
- Create: `console/app/deployments/[name]/connect.tsx`
- Modify: `console/app/deployments/[name]/tabs.tsx`

**Interfaces:**
- Consumes: existing props of `DeploymentTabs` (`d.name`, `d.kind`, `d.contextTokens`, `gatewayUrl`) — all already present in `tabs.tsx`.
- Produces: `ConnectTab({ name, gatewayUrl, kind, contextTokens }: { name: string; gatewayUrl: string; kind: string; contextTokens?: number | null })` exported from `./connect`.

- [ ] **Step 1: Create `console/app/deployments/[name]/connect.tsx`**

```tsx
"use client";
// Connect tab (spec 2026-07-12): copy-paste client configs for an Anthropic-dialect
// coding CLI, Codex, and Hermes, prefilled with this deployment's name + gateway URL.
// Key values are shown once at creation and never retrievable, so snippets
// carry a dpk_… placeholder pointing at the API Keys page.
import { useState } from "react";
import Link from "next/link";

function CopyButton({ text }: { text: string }) {
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

function Snippet({ label, text }: { label?: string; text: string }) {
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

export function ConnectTab({ name, gatewayUrl, kind, contextTokens }:
  { name: string; gatewayUrl: string; kind: string; contextTokens?: number | null }) {
  // null/undefined = llama.cpp engine default (4k); external models never warn.
  const smallContext = kind === "local" && (contextTokens ?? 4096) < 32768;
  return (
    <>
      <p className="sub" style={{ marginTop: 0 }}>
        Connect a client to this deployment through the gateway. Snippets are prefilled with the
        deployment name and gateway URL — replace <code>dpk_…</code> with a key from the{" "}
        <Link href="/api-keys">API Keys</Link> page (key values are shown once at creation).
      </p>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Anthropic-dialect CLI</h3>
        <Snippet text={`export ANTHROPIC_BASE_URL=${gatewayUrl}\nexport ANTHROPIC_AUTH_TOKEN=dpk_…\n<agent-cli> --model ${name}`} />
        <div className="hint" style={{ marginTop: 6 }}>
          use ANTHROPIC_AUTH_TOKEN, not ANTHROPIC_API_KEY — API_KEY needs a one-time interactive
          approval and shows Not logged in until approved
        </div>
        {smallContext && (
          <div className="hint" style={{ marginTop: 6 }}>
            ⚠ this model has a context of {contextTokens ?? 4096} tokens — likely too small for
            the coding-agent CLI prompt; test with --strict-mcp-config --mcp-config empty.json or
            deploy a bigger-context model
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Codex</h3>
        <Snippet label="~/.codex/config.toml" text={`model = "${name}"\nmodel_provider = "devproof"\n\n[model_providers.devproof]\nname = "Devproof"\nbase_url = "${gatewayUrl}/v1"\nenv_key = "DEVPROOF_API_KEY"\nwire_api = "responses"`} />
        <Snippet label="shell" text={`export DEVPROOF_API_KEY=dpk_…`} />
        <div className="hint" style={{ marginTop: 6 }}>
          Codex speaks the OpenAI Responses API (wire_api responses is the only supported value);
          the gateway serves /v1/responses for every deployment
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Hermes</h3>
        <Snippet label="~/.hermes/config.yaml" text={`model:\n  provider: custom\n  model: "${name}"\n  base_url: "${gatewayUrl}/v1"`} />
        <Snippet label="~/.hermes/.env" text={`OPENAI_API_KEY=dpk_…`} />
        <div className="hint" style={{ marginTop: 6 }}>
          Nous Research Hermes Agent — with base_url set it calls the gateway directly and auths
          with OPENAI_API_KEY; setup verifies the endpoint against /v1/models, which the gateway
          serves
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Wire the tab into `console/app/deployments/[name]/tabs.tsx`**

Four edits:

2a. Update the header comment (line 2) to reflect the new tab set:

```tsx
// Deployment detail (spec 2026-07-10, connect tab 2026-07-12): Overview | Connect | Stats | Trace.
```

2b. Add the import next to the other tab imports:

```tsx
import { ConnectTab } from "./connect";
```

2c. Extend the tab state union (currently `useState<"overview" | "stats" | "trace">("overview")`):

```tsx
const [tab, setTab] = useState<"overview" | "connect" | "stats" | "trace">("overview");
```

2d. Add the tab button right after the Overview button inside `<div className="tabs">`:

```tsx
<button className={tab === "connect" ? "active" : ""} onClick={() => setTab("connect")}>Connect</button>
```

2e. Add the tab body next to the `{tab === "stats" && …}` line:

```tsx
{tab === "connect" && <ConnectTab name={d.name} gatewayUrl={gatewayUrl} kind={d.kind} contextTokens={d.contextTokens ?? null} />}
```

- [ ] **Step 3: Production build**

Run: `cd console && npx next build`
Expected: "Compiled successfully", `/deployments/[name]` listed in the route table, no type errors.

- [ ] **Step 4: Commit**

```bash
git add "console/app/deployments/[name]/connect.tsx" "console/app/deployments/[name]/tabs.tsx"
git commit -m "feat(console): deployment Connect tab — Anthropic-dialect CLI / Codex / Hermes example configs"
```

---

### Task 2: Live verification + TODO cleanup

**Files:**
- Modify: `TODO.txt` (remove the shipped line)

**Interfaces:**
- Consumes: the running console (production build from Task 1) and at least one local + one external deployment in the live cluster (e.g. `qwen05b-dp` local, `glm-5.2` external).

- [ ] **Step 1: Start the console on the production build**

Run (background): `cd console && npx next start -p 7090`
Expected: "Ready" on :7090.

- [ ] **Step 2: Confirm pages 200**

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:7090/deployments/qwen05b-dp; echo; curl -s -o /dev/null -w "%{http_code}" http://localhost:7090/deployments/glm-5.2`
Expected: `200` twice. (Substitute whatever local/external deployment names exist — check `http://localhost:7090/deployments`.)

- [ ] **Step 3: Exercise the tab in a real browser (chrome-devtools MCP)**

On the **local** deployment page (`/deployments/qwen05b-dp`):
- Click the "Connect" tab (second tab, between Overview and Stats).
- Verify all three cards render (Anthropic-dialect CLI, Codex, Hermes).
- Verify snippets contain the real deployment name (`qwen05b-dp`) and the gateway URL (`http://localhost:14000`), with `/v1` appended in the Codex and Hermes snippets only.
- Verify the context warning: qwen05b-dp has a small context, so the ⚠ hint must appear on the Anthropic-dialect CLI card. (If the chosen local deployment has ≥32768 contextTokens, the warning must NOT appear — check against the model's catalog contextTokens.)
- Click a copy button; verify the icon flips to a checkmark and the clipboard holds the snippet text.
- Verify the API Keys link navigates to `/api-keys`.

On the **external** deployment page (`/deployments/glm-5.2`):
- Click "Connect"; all three cards render; NO context warning regardless of model.

- [ ] **Step 4: Remove the shipped TODO line**

In `TODO.txt`, delete the line:

```
- Hermes, Anthropic-dialect CLI and Codex templates to connect a model -> different section
```

- [ ] **Step 5: Commit**

```bash
git add TODO.txt
git commit -m "chore: TODO — connect templates shipped as deployment Connect tab"
```
