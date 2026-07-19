"use client";
// Row actions for /workspaces: rename (opened from the id — environments
// convention), enable/disable, delete with typed-name confirm + live
// deletion progress. Default workspace shows no actions.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Field, submitJson } from "../lib/modal";
import { apiGet } from "../lib/client";
import { Icon } from "../lib/icons";
import { WorkspaceModal } from "../lib/workspace-modal";

const DEFAULT_WS = "wrkspc_default";
const LABELS: Record<string, string> = {
  sessions: "sessions", skills: "skills", memory_stores: "memory stores", files: "files",
  environments: "environments", vaults: "vaults", agents: "agents", webhooks: "webhooks",
  api_keys: "API keys", file_uploads: "pending uploads",
};

export function NewWorkspaceButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}>+ New workspace</button>
    {open && <WorkspaceModal onClose={() => setOpen(false)}
                             onCreated={() => { setOpen(false); router.refresh(); }} />}
  </>);
}

/** Full id as the clickable element — opens the rename modal (env convention). */
export function WorkspaceIdButton({ ws }: { ws: { id: string; name: string; status: string } }) {
  const [open, setOpen] = useState(false);
  const immutable = ws.id === DEFAULT_WS || ws.status === "deleting";
  if (immutable) return <code>{ws.id}</code>;
  return (<>
    <button className="linklike" onClick={() => setOpen(true)}><code>{ws.id}</code></button>
    {open && <RenameDialog ws={ws} onClose={() => setOpen(false)} />}
  </>);
}

function RenameDialog({ ws, onClose }: { ws: { id: string; name: string }; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(ws.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    const err = await submitJson("PATCH", `/v1/workspaces/${ws.id}`, { name: name.trim() });
    setBusy(false);
    if (err) return setError(err);
    onClose(); router.refresh();
  };
  return (
    <Modal title="Edit workspace" subtitle={ws.id} width="sm" onClose={onClose} busy={busy} error={error}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || !name.trim() || name.trim() === ws.name} onClick={submit}>
          {busy ? "Saving…" : "Save"}</button>
      </>}>
      <Field label="Name" required>
        <input value={name} onChange={(e) => setName(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && submit()} />
      </Field>
    </Modal>
  );
}

export function WorkspaceRowActions({ ws }: { ws: { id: string; name: string; status: string } }) {
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (ws.id === DEFAULT_WS || ws.status === "deleting") return null;
  const toggle = async () => {
    const err = await submitJson("POST", `/v1/workspaces/${ws.id}/status`,
      { status: ws.status === "active" ? "disabled" : "active" });
    if (!err) router.refresh();
  };
  return (
    <div className="rowactions">
      <button className="iconbtn" title={ws.status === "active" ? "Disable (read-only)" : "Enable"}
              aria-label={ws.status === "active" ? "Disable" : "Enable"} onClick={toggle}>
        {ws.status === "active" ? <Icon.pause /> : <Icon.play />}
      </button>
      <button className="iconbtn danger" title="Delete" aria-label="Delete" onClick={() => setConfirmDelete(true)}>
        <Icon.trash />
      </button>
      {confirmDelete && <DeleteDialog ws={ws} onClose={() => setConfirmDelete(false)} />}
    </div>
  );
}

/** Destructive confirm: shows what will be destroyed, requires the name typed back. */
function DeleteDialog({ ws, onClose }: { ws: { id: string; name: string }; onClose: () => void }) {
  const router = useRouter();
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiGet<{ counts: Record<string, number> }>(`/v1/workspaces/${ws.id}/resources`)
      .then((r) => setCounts(r.counts)).catch(() => setCounts({}));
  }, [ws.id]);
  const submit = async () => {
    setBusy(true); setError(null);
    const err = await submitJson("DELETE", `/v1/workspaces/${ws.id}`);
    setBusy(false);
    if (err) return setError(err);
    onClose(); router.refresh(); // row flips to "deleting" with a progress cell
  };
  const doomed = counts ? Object.entries(counts).filter(([, n]) => n > 0) : [];
  return (
    <Modal title="Delete workspace" subtitle={ws.id} width="sm" onClose={onClose} busy={busy} error={error}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="danger-solid" disabled={busy || typed !== ws.name} onClick={submit}>
          {busy ? <span className="spin" /> : "Delete everything"}</button>
      </>}>
      <p className="modal-msg">
        Deletes <strong>{ws.name}</strong> and all its resources. Usage history stays attributed
        to the workspace name and id. This cannot be undone.
      </p>
      {counts === null ? <p className="modal-msg">Counting resources…</p> : (
        <ul className="ws-doomed">
          {doomed.length === 0 && <li>No resources — the workspace is empty.</li>}
          {doomed.map(([k, n]) => <li key={k}><strong>{n}</strong> {LABELS[k] ?? k}</li>)}
        </ul>
      )}
      <Field label="Type the workspace name to confirm" required>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={ws.name} />
      </Field>
    </Modal>
  );
}

/** Inline progress for a deleting row: polls until the tombstone appears, then
 *  stays put in its finished state until the user dismisses it. */
export function DeletionCell({ id }: { id: string }) {
  const router = useRouter();
  const [prog, setProg] = useState<{ status: string; resources: Record<string, { total: number; remaining: number; state: string }> } | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await apiGet<NonNullable<typeof prog>>(`/v1/workspaces/${id}/deletion`);
        if (stop) return;
        setProg(r);
        if (r.status === "deleted") { setDone(true); return; } // stop polling; wait for dismiss
      } catch { /* transient; retry */ }
      if (!stop) setTimeout(tick, 1500);
    };
    tick();
    return () => { stop = true; };
  }, [id]);
  if (!prog) return <span className="ws-progress"><span className="spin" /></span>;
  return (
    <div className="ws-progress-wrap">
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <span className={`phase ${done ? "Ready" : "bad"}`}>
          {done ? "deleted" : "deleting"}
        </span>
        {done && (
          <button className="iconbtn" title="Dismiss" aria-label="Dismiss" onClick={() => router.refresh()}>
            ✕
          </button>
        )}
      </div>
      <ul className="ws-progress">
        {Object.entries(prog.resources).map(([k, r]) => (
          <li key={k} className={r.state === "done" ? "done" : ""}>
            {r.state === "done" ? "✓" : <span className="spin" />} {LABELS[k] ?? k}
            {r.state !== "done" && <> · {Math.max(0, r.total - r.remaining)}/{r.total}</>}
          </li>
        ))}
      </ul>
    </div>
  );
}
