# Deployment "Connect" tab — design

**Date:** 2026-07-12
**Status:** approved
**TODO item:** Hermes, Anthropic-dialect CLI and Codex templates to connect a model

## Goal

A new **Connect** tab on the deployment detail page showing copy-paste example
configurations for connecting three client tools — **an Anthropic-dialect
coding CLI**, **Codex**, and **Hermes** (the Nous Research Hermes Agent) — to
this deployment through the gateway.

## Scope & placement

- Tab order: **Overview | Connect | Stats | Trace** (Connect is second).
- Shown for **both local and external** deployments — every deployment is
  called identically through the gateway.
- Content per tool: one pre-filled config snippet + 1–2 gotcha notes
  ("snippet + brief notes" depth — no install walkthroughs).
- The deployment **name** and **gateway URL** are prefilled into every
  snippet. The API key is always the placeholder `dpk_…` with a note pointing
  to the API Keys page — key values are returned once at creation and never
  retrievable (`agents-api.ts`), so they cannot be prefilled.

## Components

- **`console/app/deployments/[name]/connect.tsx`** (new, `"use client"`):
  `ConnectTab({ name, gatewayUrl, kind, contextTokens })`. Three `card`
  sections (Anthropic-dialect CLI, Codex, Hermes), each with a heading, one or more
  `<pre><code>` snippet blocks (Codex and Hermes have two: config file +
  env), **each block with its own copy button**, and `hint` notes.
  - `CopyButton`: small local component following the `CopyId` icon-button
    pattern (`app/lib/copy-id.tsx`) — quiet iconbtn with a 1.5 s copied
    checkmark; clipboard failure silently ignored. Iconbtn is the allowed
    exception to the no-transparent-buttons rule.
- **`tabs.tsx`**: extend the tab union to
  `"overview" | "connect" | "stats" | "trace"`, add the Connect button after
  Overview, render `<ConnectTab name={d.name} gatewayUrl={gatewayUrl}
  kind={d.kind} contextTokens={d.contextTokens} />`.
- **No changes** to `page.tsx` (already passes `gatewayUrl` from
  `DEVPROOF_GATEWAY_PUBLIC_URL`, default `http://localhost:14000`), the
  control plane, or the operator. No new API surface.

## Snippet content

`<gatewayUrl>` and `<name>` below are substituted at render time.

### Anthropic-dialect coding CLI (verified against this repo's setup notes, 2026-07-09)

```bash
export ANTHROPIC_BASE_URL=<gatewayUrl>
export ANTHROPIC_AUTH_TOKEN=dpk_…   # create on the API Keys page
<agent-cli> --model <name>
```

Notes:
- Use `ANTHROPIC_AUTH_TOKEN`, not `ANTHROPIC_API_KEY` — the latter requires a
  one-time interactive approval and shows "Not logged in" until approved.
- **Context warning (conditional):** for local deployments where
  `(contextTokens ?? 4096) < 32768` (null = llama.cpp 4k default), show a
  warning that the model's context is likely too small for a coding-agent
  CLI's prompt; suggest `--strict-mcp-config --mcp-config empty.json` or a
  bigger-context model. Never shown for external deployments.

### Codex (`~/.codex/config.toml` + env var)

```toml
model = "<name>"
model_provider = "devproof"

[model_providers.devproof]
name = "Devproof"
base_url = "<gatewayUrl>/v1"
env_key = "DEVPROOF_API_KEY"
wire_api = "responses"
```

```bash
export DEVPROOF_API_KEY=dpk_…
```

Notes:
- Codex speaks the OpenAI Responses API (`wire_api = "responses"` is the only
  supported value since Feb 2026); the gateway serves `/v1/responses` —
  **verified live 2026-07-12**: a `POST /v1/responses` with local model
  `qwen05b-dp` through the gateway completed with usage metered.

### Hermes — Nous Research Hermes Agent (`~/.hermes/config.yaml` + `~/.hermes/.env`)

```yaml
model:
  provider: custom
  model: "<name>"
  base_url: "<gatewayUrl>/v1"
```

```bash
# ~/.hermes/.env
OPENAI_API_KEY=dpk_…
```

Notes:
- When `base_url` is set, Hermes calls that endpoint directly and auths with
  `OPENAI_API_KEY`. Setup verifies the endpoint against `/v1/models`, which
  the gateway serves.

## Dynamic behavior

Only two inputs vary: deployment name and gateway URL. One conditional: the
CLI context warning above. Everything else is static text.

## Error handling

Static content — the only failure mode is clipboard copy, silently ignored
(matches `CopyId`).

## Testing / verification

No console unit-test infra; verification is the live check per the repo's
"verify before claiming done" rule:

1. `cd console && npx next build && npx next start -p 7090`.
2. Open a **local** deployment: Connect tab renders, snippets show the real
   deployment name and gateway URL, copy buttons work, context warning
   appears iff `(contextTokens ?? 4096) < 32768`.
3. Open an **external** deployment: tab renders, no context warning.
4. All other pages still 200.

(Gateway `/v1/responses` support already verified live during design — not a
per-change check.)

## Alternatives considered

- **CP endpoint serving rendered templates** — rejected: every input is
  already client-side; adds API surface and a loading state for static text.
- **Global "Connect" docs page with a deployment picker** — rejected: the
  per-deployment tab pre-fills the right model name; user explicitly chose
  the tab.
