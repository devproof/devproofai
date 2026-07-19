# Session File Attachment UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach workspace files (existing or freshly uploaded) to sessions from the UI — in the create-session dialog and the follow-up composer — plus a memory-store selector in the create dialog.

**Architecture:** Spec: `docs/superpowers/specs/2026-07-10-session-file-attachment-design.md` (approved; §2 resolved to zero backend changes — uploads are `kind="upload"` and `GET /v1/files?kind=upload` already selects the attachable set). One shared controlled component (`AttachFiles` + internal `FilePicker` modal) consumed by both attach points; both session routes already accept `files[]`/`memoryStore`.

**Tech Stack:** Next.js 15 App Router, existing dialog system (`Modal` from `console/app/lib/modal.tsx`), hand-rolled CSS.

## Global Constraints

- Console verified with production builds (`cd console && npx next build`); dev mode banned.
- No browser `prompt()`/`confirm()`/`alert()`; grep gate stays at zero hits.
- No transparent text buttons; quiet `.iconbtn` row/inline icons are the allowed exception.
- Picker query exactly `GET /v1/files?kind=upload&limit=100` → `{files, total, limit, offset}`; memory stores from `GET /v1/memory-stores` → `{stores, count, offset}`.
- Create body fields: `files: string[]` (omit when empty), `memoryStore: string` (omit when none). Message body: `files: string[]` (omit when empty).
- Copy fix rides along: create dialog Name hint becomes exactly `optional`.
- Work directly on `main` (established pattern for post-merge feature waves this size).

## File Structure

| File | Role |
|---|---|
| `console/app/lib/icons.tsx` | + `clip` (paperclip) icon |
| `console/app/sessions/attach.tsx` | **new** — `AttachFiles` control + `FilePicker` modal |
| `console/app/globals.css` | + attach-chip styles |
| `console/app/sessions/create.tsx` | Files field, Memory store field, hint copy |
| `console/app/sessions/page.tsx` | fetch memory stores, pass through |
| `console/app/sessions/[id]/trace.tsx` | compact control + chips row + send body |

---

### Task 1: `AttachFiles` control (icon, component, CSS)

**Files:**
- Modify: `console/app/lib/icons.tsx` (after `edit`)
- Create: `console/app/sessions/attach.tsx`
- Modify: `console/app/globals.css` (append)

**Interfaces:**
- Consumes: `Modal` (`console/app/lib/modal.tsx`), `wsHeader` (`console/app/lib/client.ts`), `Icon` set, `.checklist`/`.chip` CSS.
- Produces (Tasks 2–3 rely on): `AttachedFile { id: string; name: string }` and
  `AttachFiles({ value, onChange, compact }: { value: AttachedFile[]; onChange: (f: AttachedFile[]) => void; compact?: boolean })` exported from `console/app/sessions/attach.tsx`.

- [ ] **Step 1: Add the `clip` icon to `console/app/lib/icons.tsx`** (after the `edit` entry)

```tsx
  clip: () => <S><path d="M21.2 11.2l-8.4 8.4a5.6 5.6 0 0 1-7.9-7.9l8.4-8.4a3.7 3.7 0 0 1 5.3 5.3l-8.5 8.4a1.9 1.9 0 0 1-2.6-2.6l7.8-7.8" /></S>,
```

- [ ] **Step 2: Create `console/app/sessions/attach.tsx`**

```tsx
"use client";
// Shared file-attachment control (spec 2026-07-10): removable chips + a
// picker modal over existing workspace uploads, with inline multipart upload.
import { useEffect, useRef, useState } from "react";
import { wsHeader } from "../lib/client";
import { Icon } from "../lib/icons";
import { Modal } from "../lib/modal";

export interface AttachedFile { id: string; name: string; }

const fmtSize = (n: number) =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

export function AttachFiles({ value, onChange, compact }: {
  value: AttachedFile[]; onChange: (files: AttachedFile[]) => void; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="attach">
      <button type="button" className={compact ? "iconbtn" : "ghost"}
        title="Attach files" aria-label="Attach files" onClick={() => setOpen(true)}>
        <Icon.clip />{!compact && <> Attach files</>}
      </button>
      {value.map((f) => (
        <span key={f.id} className="chip">
          {f.name}
          <button type="button" className="chip-x" aria-label={`Remove ${f.name}`}
            onClick={() => onChange(value.filter((v) => v.id !== f.id))}>✕</button>
        </span>
      ))}
      {open && <FilePicker selected={value} onClose={() => setOpen(false)}
        onAttach={(files) => { onChange(files); setOpen(false); }} />}
    </div>
  );
}

function FilePicker({ selected, onClose, onAttach }: {
  selected: AttachedFile[]; onClose: () => void; onAttach: (files: AttachedFile[]) => void;
}) {
  const [files, setFiles] = useState<any[]>([]);
  const [sel, setSel] = useState<Map<string, string>>(new Map(selected.map((f) => [f.id, f.name])));
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/v1/files?kind=upload&limit=100", { headers: wsHeader() });
      if (res.ok) setFiles((await res.json()).files);
      else setError(`Could not load files: ${res.status}`);
    } catch (err) { setError(String(err)); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (f: any) => setSel((m) => {
    const n = new Map(m);
    if (n.has(f.id)) n.delete(f.id); else n.set(f.id, f.name);
    return n;
  });

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true); setError(null);
    try {
      for (const file of Array.from(list)) {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch("/api/v1/files", { method: "POST", headers: wsHeader(), body });
        if (!res.ok) { setError(`Upload failed for ${file.name}: ${res.status}`); continue; }
        const rec = await res.json();
        setSel((m) => new Map(m).set(rec.id, rec.name));
      }
      await load();          // freshly uploaded files appear in the list, pre-checked
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  };

  const q = search.trim().toLowerCase();
  const visible = q ? files.filter((f) => String(f.name).toLowerCase().includes(q)) : files;
  return (
    <Modal title="Attach files" width="sm" onClose={onClose} busy={busy} error={error}
      subtitle="Attached files are mounted at /mnt/session/uploads for the agent."
      footer={<>
        <input ref={fileInput} type="file" multiple style={{ display: "none" }}
          onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
        <button className="ghost" disabled={busy} style={{ marginRight: "auto" }}
          onClick={() => fileInput.current?.click()}>Upload new…</button>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy} onClick={() => onAttach([...sel].map(([id, name]) => ({ id, name })))}>
          Attach {sel.size} file{sel.size === 1 ? "" : "s"}
        </button>
      </>}>
      <input type="search" placeholder="Search files…" value={search}
        onChange={(e) => setSearch(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
      <div className="checklist" style={{ maxHeight: 260, gridTemplateColumns: "1fr" }}>
        {visible.map((f) => (
          <label key={f.id}>
            <input type="checkbox" checked={sel.has(f.id)} onChange={() => toggle(f)} />
            <span>{f.name} <span className="muted">{fmtSize(Number(f.size))}</span></span>
          </label>
        ))}
        {visible.length === 0 && <span className="muted">{q ? "no files match" : "no uploaded files yet"}</span>}
      </div>
    </Modal>
  );
}
```

- [ ] **Step 3: Append attach CSS to `console/app/globals.css`**

```css
/* ── File-attachment control (create dialog + session composer) ──── */
.attach { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; min-width: 0; }
.chip-x { background: none; border: 0; padding: 0 0 0 3px; color: var(--muted);
  cursor: pointer; font-size: 10px; line-height: 1; }
.chip-x:hover { background: none; color: var(--bad); }
```

- [ ] **Step 4: Build + commit**

Run: `cd console && npx next build` — expected PASS (component unused yet).

```bash
git add console/app/lib/icons.tsx console/app/sessions/attach.tsx console/app/globals.css
git commit -m "feat(console): shared AttachFiles control — picker over workspace uploads + inline upload"
```

---

### Task 2: Create-session dialog — files, memory store, hint copy

**Files:**
- Modify: `console/app/sessions/create.tsx`, `console/app/sessions/page.tsx`

**Interfaces:**
- Consumes: `AttachFiles`/`AttachedFile` (Task 1); `GET /v1/memory-stores` → `{stores}`; create body accepts `files[]` + `memoryStore`.
- Produces: `CreateSession({ agents, memoryStores })` — page passes the new prop.

- [ ] **Step 1: Extend `console/app/sessions/create.tsx`**

Add imports and state to `CreateSession` (which currently holds `{agent, name, prompt}` state and a Modal):

```tsx
import { AttachFiles, type AttachedFile } from "./attach";
```

Signature: `export function CreateSession({ agents, memoryStores }: { agents: { id: string; name: string }[]; memoryStores: { id: string; name: string }[] })`.

New state: `const [files, setFiles] = useState<AttachedFile[]>([]);` and `const [memoryStore, setMemoryStore] = useState("");`

Submit body becomes:

```tsx
        body: JSON.stringify({
          agent: form.agent, prompt: form.prompt, name: form.name || undefined,
          ...(files.length ? { files: files.map((f) => f.id) } : {}),
          ...(memoryStore ? { memoryStore } : {}),
        }),
```

Fields — change the Name hint to `optional`, and add after the "First message" field:

```tsx
        <Field label="Files" hint="mounted at /mnt/session/uploads in the session">
          <AttachFiles value={files} onChange={setFiles} />
        </Field>
        <Field label="Memory store" hint="one store per session — persists learnings across sessions">
          <select value={memoryStore} onChange={(e) => setMemoryStore(e.target.value)}>
            <option value="">No memory store</option>
            {memoryStores.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
```

On modal close/cancel, reset the new state alongside existing behavior (`setFiles([]); setMemoryStore("");` wherever the dialog closes after success; on plain cancel keep the existing pattern of the file — match it).

- [ ] **Step 2: Pass stores from `console/app/sessions/page.tsx`**

Add to the page's `Promise.all`: `wsGet<{ stores: any[] }>("/v1/memory-stores")` and pass `memoryStores={stores.map((s: any) => ({ id: s.id, name: s.name }))}` into `<CreateSession …>`.

- [ ] **Step 3: Build + commit**

Run: `cd console && npx next build` — expected PASS.

```bash
git add console/app/sessions/create.tsx console/app/sessions/page.tsx
git commit -m "feat(console): create-session dialog — attach files, pick memory store"
```

---

### Task 3: Composer attachment + live verification

**Files:**
- Modify: `console/app/sessions/[id]/trace.tsx`

**Interfaces:**
- Consumes: `AttachFiles`/`AttachedFile` (Task 1); message body accepts `files[]`; resources refetch at turn boundaries already updates the Files chip.

- [ ] **Step 1: Wire the composer in `console/app/sessions/[id]/trace.tsx`**

Imports: `import { AttachFiles, type AttachedFile } from "../attach";`
State: `const [attached, setAttached] = useState<AttachedFile[]>([]);`

`send()` body:

```tsx
        body: JSON.stringify({ prompt, ...(attached.length ? { files: attached.map((f) => f.id) } : {}) }),
```
and on success clear both: `setPrompt(""); setAttached([]); …` (keep the rest of the success line).

Composer block — chips row above, paperclip inside:

```tsx
      {!["completed", "failed"].includes(status) && (
        <div className="sv-composer">
          {attached.length > 0 && (
            <div className="attach" style={{ padding: "0 2px" }}>
              <AttachFiles value={attached} onChange={setAttached} compact />
            </div>
          )}
          <div className="sv-input">
            {attached.length === 0 && <AttachFiles value={attached} onChange={setAttached} compact />}
            <input type="text"
              placeholder={status === "idle"
                ? "Send a follow-up message (resumes the session)…"
                : "Send a message — interrupts the current run and starts a new turn…"}
              value={prompt} onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && send()} />
            <button disabled={busy || !prompt.trim()} onClick={send}>{busy ? "Sending…" : "Send ▸"}</button>
            {error && <span className="modal-error" style={{ margin: 0 }}>{error}</span>}
          </div>
        </div>
      )}
```
(The `AttachFiles` control includes its own trigger button, so when files are attached the trigger+chips live in the row above and the inline one is hidden — exactly one visible trigger at a time.)

Add the wrapper CSS to `console/app/globals.css` (append):

```css
.sv-composer { display: flex; flex-direction: column; gap: 6px; }
```

- [ ] **Step 2: Build + grep gates**

Run: `cd console && npx next build` — expected PASS.
Run: `grep -rnE "confirm\(|prompt\(|alert\(" console/app` — zero hits (the `prompt` state var doesn't match the call pattern).

- [ ] **Step 3: Live verification (stack per CLAUDE.md; CP with `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev10`)**

1. Sessions page → Create session: pick an agent, attach one EXISTING upload + upload one NEW file in the picker (both end checked), select a memory store, create. Session page shows `2 files` and `1 memory` chips; the first user row contains the runner's attachment listing; Files panel lists both with sizes.
2. On the idle session: paperclip in the composer → attach a file → chips row appears above the input → send a message → user row appears, and after the turn ends the Files chip count increases (resources refetch).
3. Failure path: stop the control plane, open the picker → inline "Could not load files" banner; restart the CP.
4. Escape closes the picker; the create dialog's Name hint reads exactly `optional`.

- [ ] **Step 4: Commit**

```bash
git add "console/app/sessions/[id]/trace.tsx" console/app/globals.css
git commit -m "feat(console): follow-up composer file attachment"
```

---

## Self-Review (done at plan time)

- **Spec coverage:** §1 control/picker → T1; create dialog + memory store + copy fix → T2; composer + send body + chip refresh → T3 (refresh rides existing turn-boundary refetch, verified in T3 step 3.2); §2 resolved-no-backend reflected (no backend task). Out-of-scope respected.
- **Type consistency:** `AttachedFile {id, name}` and `AttachFiles({value, onChange, compact})` used identically in T2/T3; picker query and list shapes match the verified endpoints.
- **Placeholders:** none — full code or exact edits in every step.
