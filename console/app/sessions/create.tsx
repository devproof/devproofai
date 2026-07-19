"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { wsHeader } from "../lib/client";
import { Modal, Field } from "../lib/modal";
import { AttachFiles, type AttachedFile } from "./attach";

export function CreateSession({ agents, memoryStores, ghost = false }: { agents: { id: string; name: string }[]; memoryStores: { id: string; name: string }[]; ghost?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ agent: agents[0]?.id ?? "", name: "", prompt: "" });
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [memoryStore, setMemoryStore] = useState("");

  const closeDialog = () => { setOpen(false); setFiles([]); setMemoryStore(""); setError(null); };

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/v1/sessions", {
        method: "POST", headers: { "Content-Type": "application/json", ...wsHeader() },
        body: JSON.stringify({
          agent: form.agent, prompt: form.prompt, name: form.name || undefined,
          ...(files.length ? { files: files.map((f) => f.id) } : {}),
          ...(memoryStore ? { memoryStore } : {}),
        }),
      });
      if (res.ok) { const { id } = await res.json(); setFiles([]); setMemoryStore(""); router.push(`/sessions/${id}`); return; }
      setError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    } catch (err) { setError(String(err)); }
    setBusy(false);
  };

  return (<>
    <button className={ghost ? "ghost" : undefined} onClick={() => setOpen(true)}>+ Create session</button>
    {open && (
      <Modal title="Create session" width="md" onClose={closeDialog} busy={busy} error={error}
        footer={<>
          <button className="ghost" disabled={busy} onClick={closeDialog}>Cancel</button>
          <button disabled={busy || !form.agent || !form.prompt} onClick={submit}>
            {busy ? "Starting…" : "Start session"}
          </button>
        </>}>
        <Field label="Agent" required>
          <select value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value })}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Name" hint="optional">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="First message" required stack>
          <textarea rows={4} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                    placeholder="The task for this session…" />
        </Field>
        <Field label="Files" hint="mounted at /mnt/session/uploads in the session">
          <AttachFiles value={files} onChange={setFiles} />
        </Field>
        <Field label="Memory store" hint="one store per session — persists learnings across sessions">
          <select value={memoryStore} onChange={(e) => setMemoryStore(e.target.value)}>
            <option value="">No memory store</option>
            {memoryStores.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
      </Modal>
    )}
  </>);
}

export function SendMessage({ sessionId, status }: { sessionId: string; status: string }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!["idle"].includes(status)) return null;
  return (
    <div className="formrow" style={{ marginTop: 16 }}>
      <input style={{ flex: 1 }} type="text" placeholder="Send a follow-up message (resumes the session)…"
        value={prompt} onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !busy && prompt && document.getElementById("send-btn")?.click()} />
      <button id="send-btn" disabled={busy || !prompt} onClick={async () => {
        setBusy(true); setError(null);
        try {
          const res = await fetch(`/api/v1/sessions/${sessionId}/messages`, {
            method: "POST", headers: { "Content-Type": "application/json", ...wsHeader() },
            body: JSON.stringify({ prompt }),
          });
          if (res.ok) { setPrompt(""); router.refresh(); }
          else setError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        } catch (err) {
          setError(String(err));
        } finally {
          setBusy(false);
        }
      }}>{busy ? "Sending…" : "Send"}</button>
      {error && <span className="modal-error" style={{ margin: 0 }}>{error}</span>}
    </div>
  );
}
