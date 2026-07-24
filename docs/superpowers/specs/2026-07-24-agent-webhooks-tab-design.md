# Agent "Webhooks" tab — design

**Date:** 2026-07-24
**Status:** Approved (brainstorming session; endpoint shapes, response codes, and
transport limits verified against `public-api.ts`, `session-actions.ts`,
`repo.ts`, and spec 2026-07-12-public-api-design.md)

## Goal

Let a user trigger an agent from external systems (CI, n8n, cron, any HTTP
caller) without reading code: the agent detail page gets a fourth tab,
**Webhooks**, right of Observability, showing copy-paste curl examples for the
existing public `/api` endpoints, prefilled with the agent's id and the gateway
URL.

**Console-only. No API, DB, or control-plane changes.** The public `/api`
surface (spec 2026-07-12) already provides everything: dpk_-key-authenticated
create-session, send-message, file upload, and status reads, reached through
the gateway pass-through. No per-agent enable toggle — the endpoints are
always live for any active agent; the tab is documentation, not a gate.

## Decisions made during brainstorming

- **No new routes, no toggle** — the existing public API is the webhook
  surface; the feature is a DX/console surface only (user decision).
- **Two-step file flow stays** — upload → reference by `file_` id; no inline
  multipart variant of create/message (user decision: "we work with what we
  have").
- **Snippet/CopyButton get extracted** from `routings/[name]/connect.tsx` into
  a shared `app/lib/snippet.tsx` (approved option).
- **A fourth card for status/result polling is included** (approved option) —
  a webhook caller that creates a session needs to poll for completion.

## Changes

### 1. `console/app/lib/snippet.tsx` (new, `"use client"`)

`CopyButton` and `Snippet` moved verbatim from
`console/app/routings/[name]/connect.tsx`; `connect.tsx` imports them instead
of defining them. No visual or behavioral change to the Connect tab. (Client
components only — nothing server-callable is exported from this client module,
per the console convention.)

### 2. `console/app/agents/[id]/webhooks.tsx` (new)

`WebhooksTab({ agentId, gatewayUrl }: { agentId: string; gatewayUrl: string })`
— structured like `ConnectTab`: intro paragraph, then four cards, each a
`Snippet` with a copy button and a one-line hint.

Intro: "Trigger this agent over HTTP through the gateway. Snippets are
prefilled with this agent's id and the gateway URL — replace `dpk_…` with a
key from the **API Keys** page (key values are shown once at creation). The
key determines the workspace." (`API Keys` links to `/api-keys`, same wording
pattern as the Connect tab.)

Cards (verified endpoint shapes):

1. **Create session**
   ```bash
   curl -X POST {gatewayUrl}/api/sessions \
     -H "Authorization: Bearer dpk_…" \
     -H "Content-Type: application/json" \
     -d '{"agent": "<real agent id>", "prompt": "Describe the task…", "files": ["file_…"]}'
   ```
   Hint: returns `201 {"id": "sesn_…", "status": "queued"}` — the session id
   for the calls below; `files` is optional (ids from the upload call).
   Errors: 409 agent disabled / failed deployment, 400 unknown file id.

2. **Send a message to a session**
   ```bash
   curl -X POST {gatewayUrl}/api/sessions/sesn_…/messages \
     -H "Authorization: Bearer dpk_…" \
     -H "Content-Type: application/json" \
     -d '{"prompt": "Follow-up…", "files": ["file_…"]}'
   ```
   Hint: returns `202`; only **idle or failed** sessions accept new messages
   (failed resumes from the last completed turn's checkpoint) — a running
   session returns 409.

3. **Upload a file**
   ```bash
   curl -X POST {gatewayUrl}/api/files \
     -H "Authorization: Bearer dpk_…" \
     -F "file=@report.pdf"
   ```
   Hint: returns `201 {"id": "file_…"}` — pass the id in `files[]`. Single
   call up to 32 MB; use the chunked upload API (`POST /api/files/uploads`)
   for larger files.

4. **Check status / result**
   ```bash
   curl {gatewayUrl}/api/sessions/sesn_… \
     -H "Authorization: Bearer dpk_…"
   ```
   Hint: poll `status` (`queued | running | idle | completed | failed`);
   produced output files are listed at `GET /api/sessions/:id/resources`.

The agent id is interpolated for real; session/file ids and the key stay
placeholders (`sesn_…`, `file_…`, `dpk_…`).

### 3. `console/app/agents/[id]/page.tsx`

Resolve the gateway URL server-side, same as the routing detail page:
`process.env.DEVPROOF_GATEWAY_PUBLIC_URL ?? "http://localhost:14000"` — and
pass it to `AgentTabs`.

### 4. `console/app/agents/[id]/tabs.tsx`

- Extend the tab union: `"agent" | "sessions" | "obs" | "webhooks"` (state and
  `initialTab` prop type).
- Add a **Webhooks** button after Observability in the `.tabs` row.
- Accept `gatewayUrl` prop; render `<WebhooksTab agentId={agent.id}
  gatewayUrl={gatewayUrl} />` when active.

## Error handling

None new — the tab is static content. Auth and validation errors happen at the
gateway/CP exactly as today (gateway `custom_auth` + CP `apiKeyAuth`, defense
in depth per spec 2026-07-12).

## Testing / verification

- `cd console && npx next build` (type-checks) then `npx next start -p 7090`
  (production build per project convention).
- Agent detail page 200s; all four tabs switch; the Webhooks tab shows the
  real agent id and gateway URL; copy buttons work.
- Routing detail → Connect tab renders unchanged after the Snippet extraction.
- No new automated tests — consistent with the existing console tabs (none
  have component tests).

## Out of scope (explicitly)

- Inline file upload in create/message calls.
- Per-agent webhook enable/disable toggle.
- Webhook-specific secrets, payload templating for third-party senders,
  delivery logs.
- Any control-plane or gateway change.
