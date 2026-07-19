"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Field, submitJson } from "../lib/modal";

export function CreateRoutingButton({ targets }: { targets: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>+ Create routing</button>
      {open && <RoutingCreateModal targets={targets} onClose={() => setOpen(false)} />}
    </>
  );
}

function RoutingCreateModal({ targets, onClose }: { targets: string[]; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [action, setAction] = useState<"route" | "reject">("route");
  const [target, setTarget] = useState(targets[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    const err = await submitJson("POST", "/v1/routings", {
      name: name.trim(),
      terminal: action === "route" ? { action, target } : { action },
    });
    setBusy(false);
    if (err) return setError(err);
    onClose();
    router.push(`/routings/${encodeURIComponent(name.trim())}`);
  };
  return (
    <Modal title="New routing" subtitle="A named rule table clients call as a model name — add rules on its detail page."
      onClose={onClose} busy={busy} error={error} footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || !name.trim() || (action === "route" && !target)} onClick={submit}>
          {busy ? <span className="spin" /> : "Create"}
        </button>
      </>}>
      <Field label="Name" required hint="lowercase letters, digits, dashes — shares the gateway model namespace">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="main-route" />
      </Field>
      <Field label="When no rule matches" required>
        <select value={action} onChange={(e) => setAction(e.target.value as any)}>
          <option value="route">route to a model</option>
          <option value="reject">reject (403)</option>
        </select>
      </Field>
      {action === "route" && (
        <Field label="Default model" required>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
      )}
    </Modal>
  );
}
