# Vault Dialog Cleanups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the credentials box from the Create Vault dialog (navigate to the detail page instead) and make the Add-credential Name field mandatory with MCP-server prefill.

**Architecture:** Two console-only client-component edits (`console/app/vaults/create.tsx`, `console/app/vaults/[id]/credentials.tsx`). The control plane is intentionally untouched — `POST /v1/vaults` keeps accepting optional `secrets` and `validateCredentialBody` keeps its name-derivation fallback as lenient public-API behavior; the console just stops using those paths.

**Tech Stack:** Next.js (App Router, client components), existing shared helpers `Modal`/`Field` (`console/app/lib/modal.tsx`) and `apiPost` (`console/app/lib/client.ts`).

Spec: `docs/superpowers/specs/2026-07-14-vault-dialog-cleanups-design.md`.

## Global Constraints

- Console is ALWAYS verified with a production build: `npx next build && npx next start -p 7090` (dev mode is banned in this repo). A rebuild under a running `next start` pins old chunk hashes — restart the console process after building.
- No browser `prompt()`/`confirm()`/`alert()` — dialogs use the shared `Modal`/`Field` components (already the case here).
- Credential name rule must mirror the server exactly: `CRED_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/` and `ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/` (both defined in `control-plane/src/mcp.ts:123-124`).
- The console has no unit-test runner; the test cycle per task is `npx tsc --noEmit` (type check) and the final task is a live end-to-end exercise against the running control plane (:7080) and console (:7090).
- Match existing style; every changed line traces to the spec.

---

### Task 1: Create Vault dialog — drop the credentials box, navigate to detail

**Files:**
- Modify: `console/app/vaults/create.tsx` (whole file, 45 lines)

**Interfaces:**
- Consumes: `apiPost(path, body): Promise<Response>` from `console/app/lib/client.ts:15`; `Modal`/`Field` from `console/app/lib/modal.tsx`; `POST /v1/vaults {name}` → 201 with the vault row (has `id`).
- Produces: nothing consumed by later tasks (Task 2 is independent).

- [ ] **Step 1: Rewrite `console/app/vaults/create.tsx`**

Replace the full file content with (removes the `pairs` state, KEY=value parsing, and the Credentials `Field`; switches from `submitJson` to `apiPost` so the response body's `id` is available for navigation — same pattern as `console/app/sessions/create.tsx:20-34`):

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal, Field } from "../lib/modal";
import { apiPost } from "../lib/client";

export function CreateVault() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  // Credentials are added on the vault detail page after creation, so on
  // success we land there instead of refreshing the list.
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await apiPost("/v1/vaults", { name });
      if (res.ok) { const vault = await res.json(); router.push(`/vaults/${vault.id}`); return; }
      setError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    } catch (err) { setError(String(err)); }
    setBusy(false);
  };

  return (<>
    <button onClick={() => setOpen(true)}>+ Create vault</button>
    {open && (
      <Modal title="Create vault" width="md" onClose={() => setOpen(false)} busy={busy} error={error}
        footer={<>
          <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button disabled={busy || !name} onClick={submit}>{busy ? "Creating…" : "Create vault"}</button>
        </>}>
        <Field label="Name" required hint="credentials are added on the vault page after creation">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </Modal>
    )}
  </>);
}
```

Note: on success the function returns while still `busy` — the modal stays disabled during navigation (same as the sessions create dialog).

- [ ] **Step 2: Type-check**

Run (from `console/`): `npx tsc --noEmit`
Expected: exit 0, no output. (If `submitJson` is now unused in this file that's fine — the import was removed above.)

- [ ] **Step 3: Commit**

```bash
git add console/app/vaults/create.tsx
git commit -m "feat(console): create-vault dialog drops the credentials box, lands on the vault page"
```

---

### Task 2: Add-credential dialog — Name mandatory, prefilled from the MCP server pick

**Files:**
- Modify: `console/app/vaults/[id]/credentials.tsx:24-34` (state + ready check), `:36-48` (submit body), `:70-79` (Name field + picker wiring)

**Interfaces:**
- Consumes: `McpServerPicker`/`McpServerPick {name, url}` from `console/app/lib/mcp-picker.tsx` (registry picks give the registry `name`, e.g. `context7`; custom URLs give the hostname); server validation rules from `control-plane/src/mcp.ts` (mirrored as local constants).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the name-rule constants and prefill state**

In `console/app/vaults/[id]/credentials.tsx`, below the `TYPES` array (after line 14), add:

```tsx
// Mirror control-plane/src/mcp.ts — the server rejects anything else.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CRED_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
```

Inside `CredentialModal`, replace the `server` state + `ready` block (lines 26-34):

```tsx
  const [server, setServer] = useState<McpServerPick | null>(existing?.mcp_server_url
    ? { name: existing.mcp_server_name ?? existing.name, url: existing.mcp_server_url } : null);
  // Last auto-filled name: picking a server prefills Name, but never
  // clobbers a name the user typed themselves.
  const [autoName, setAutoName] = useState<string | null>(null);
  const pickServer = (s: McpServerPick | null) => {
    setServer(s);
    if (s && (!name.trim() || name.trim() === autoName)) { setName(s.name); setAutoName(s.name); }
  };
  const [value, setValue] = useState("");        // env value | bearer token | oauth access token
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const locked = !!existing;                     // rotate: name/type/server frozen
  const isMcp = type !== "environment_variable";
  const ready = !!value && (isMcp
    ? !!server && CRED_NAME_RE.test(name.trim())
    : ENV_NAME_RE.test(name));
```

(The `name` state on line 25 is unchanged. Note `pickServer` must be declared after the `name` state it reads — keeping the existing declaration order, `name` on line 25 comes first, so this is fine.)

- [ ] **Step 2: Always send the name for MCP types**

In `submit`, replace the conditional name line (line 41):

```tsx
      if (name.trim()) body.name = name.trim();
```

with:

```tsx
      body.name = name.trim();
```

- [ ] **Step 3: Make the Name field required, drop the derivation hint and the `context7` placeholder**

Replace the Name `Field` (lines 70-74):

```tsx
      <Field label={isMcp ? "Name" : "Variable name"} required
             hint={isMcp ? "prefilled from the MCP server — used to derive the credential's secret keys" : "injected into session pods under this name"}>
        <input value={name} disabled={locked} placeholder={isMcp ? undefined : "MY_API_KEY"}
               onChange={(e) => setName(e.target.value)} />
      </Field>
```

And wire the picker to the prefill handler — in the MCP server `Field` (line 77), change `onChange={setServer}` to `onChange={pickServer}`.

- [ ] **Step 4: Type-check**

Run (from `console/`): `npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add "console/app/vaults/[id]/credentials.tsx"
git commit -m "feat(console): credential name mandatory, prefilled from the MCP server pick"
```

---

### Task 3: Production build + live end-to-end verification

**Files:**
- None modified (build + verify only; fix-forward if anything fails).

**Interfaces:**
- Consumes: running control plane on :7080, console on :7090, the two dialogs from Tasks 1-2.

- [ ] **Step 1: Build and restart the console**

From `console/`: `npx next build` (expected: build succeeds, all pages compile). Then stop any running `next start` and relaunch `npx next start -p 7090` in the background (a stale `next start` serves old chunk hashes → client-side exception).

Ensure the control plane is running on :7080 (if not: from `control-plane/`, `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev27 DEVPROOF_S3_ENDPOINT=http://127.0.0.1:19000 DEVPROOF_S3_BUCKET=devproof-files npx tsx src/main.ts` in the background).

- [ ] **Step 2: Verify the create-vault flow in a real browser** (chrome-devtools MCP; plain curl can't exercise client components)

1. Open `http://localhost:7090/vaults`, click "+ Create vault".
   Expected: the modal shows ONLY the Name field (no Credentials textarea).
2. Enter a name (e.g. `verify-vault-cleanup`), click "Create vault".
   Expected: browser navigates to `/vaults/vlt_…` — the new vault's detail page, empty credentials list, "+ Add credential" button present.

- [ ] **Step 3: Verify the add-credential flow**

On that vault's detail page, click "+ Add credential":
1. Switch Type to "Bearer token". Expected: Name field shows required, no `context7` placeholder, submit disabled.
2. Pick "Context7" from the MCP server picker. Expected: Name prefills to `context7`.
3. Clear the Name field. Expected: submit stays disabled even with a token value entered.
4. Type a custom name `my-ctx`, clear the server (✕), re-pick Context7. Expected: Name stays `my-ctx` (user-typed names are never clobbered).
5. Enter a token value and submit. Expected: credential row `my-ctx` (type bearer_token) appears.
6. Add an environment-variable credential `MY_TEST_VAR` with a value. Expected: unchanged behavior, row appears.
7. Click the `my-ctx` credential name (rotate). Expected: name/type/server locked, entering a token and rotating succeeds.

- [ ] **Step 4: Clean up the test vault**

Delete the `verify-vault-cleanup` vault from the console (row delete). Expected: gone from the list.

- [ ] **Step 5: Confirm other pages still 200**

Spot-check `http://localhost:7090/` and `http://localhost:7090/vaults` load without client-side exceptions (browser console clean).
