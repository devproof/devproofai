"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiPost } from "../lib/client";
import { Icon } from "../lib/icons";
import { ConfirmDialog } from "../lib/modal";

export function StatusToggle({ agent }: { agent: { id: string; status?: string } }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const disabled = agent.status === "disabled";

  const setStatus = async (status: "active" | "disabled") => {
    setBusy(true);
    try {
      const res = await apiPost(`/v1/agents/${agent.id}/status`, { status });
      if (!res.ok) return `HTTP ${res.status}`;
      router.refresh(); return null;
    } catch (err) { return String(err); } finally { setBusy(false); }
  };

  return (<>
    {disabled
      ? <button disabled={busy} onClick={() => setStatus("active")}><Icon.play /> {busy ? "Enabling…" : "Enable"}</button>
      : <button disabled={busy} onClick={() => setConfirming(true)}><Icon.pause /> Disable</button>}
    {confirming && <ConfirmDialog title="Disable agent" verb="Disable"
      message="New sessions and follow-up messages will be rejected; running turns finish."
      onClose={() => setConfirming(false)}
      onConfirm={() => setStatus("disabled")} />}
  </>);
}
