"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { wsHeader } from "./lib/client";
import { ConfirmDialog, submitJson } from "./lib/modal";
import { Icon } from "./lib/icons";

async function syncGateway() {
  await fetch("/api/v1/gateway/sync", { method: "POST", headers: wsHeader() });
}

export function DeploymentActions({ name, referencedBy = [] }: { name: string; referencedBy?: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <div className="rowactions">
      <button className="iconbtn danger" title="Undeploy" aria-label="Undeploy" onClick={() => setOpen(true)}>
        <Icon.trash />
      </button>
      {open && <ConfirmDialog title="Undeploy" verb="Undeploy" onClose={() => setOpen(false)}
        message={`Undeploy "${name}"? This stops serving it and removes its gateway route.${
          referencedBy.length ? ` Referenced by routing(s): ${referencedBy.join(", ")} — their rules will treat it as unavailable.` : ""}`}
        onConfirm={async () => {
          const err = await submitJson("DELETE", `/v1/deployments/${name}`);
          if (!err) { await syncGateway(); router.refresh(); }
          return err;
        }} />}
    </div>
  );
}

export function SyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button disabled={busy} onClick={async () => {
      setBusy(true); await syncGateway(); setBusy(false); router.refresh();
    }}><Icon.sync /> {busy ? "Syncing…" : "Sync gateway"}</button>
  );
}

export function RefreshButton() {
  const router = useRouter();
  return <button className="ghost" title="Refresh" onClick={() => router.refresh()}><Icon.refresh /></button>;
}
