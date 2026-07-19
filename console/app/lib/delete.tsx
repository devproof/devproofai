"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog, submitJson } from "./modal";
import { Icon } from "./icons";

/** Quiet icon action used in the last column of list rows. Confirms via ConfirmDialog. */
export function DeleteButton({ path, confirmText, redirect, label = "Delete" }:
  { path: string; confirmText?: string; redirect?: string; label?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (<>
    <button className="iconbtn danger" title={label} aria-label={label} onClick={() => setOpen(true)}>
      <Icon.trash />
    </button>
    {open && <ConfirmDialog title={label} verb={label} onClose={() => setOpen(false)}
      message={confirmText ?? "Delete this permanently?"}
      onConfirm={async () => {
        const err = await submitJson("DELETE", path);
        if (!err) { redirect ? router.push(redirect) : router.refresh(); }
        return err;
      }} />}
  </>);
}

/** Quiet icon download action (matches DeleteButton). */
export function DownloadButton({ path, name = "file" }: { path: string; name?: string }) {
  return (
    <a className="iconbtn" title={`Download ${name}`} aria-label={`Download ${name}`}
       href={`/api${path}`} download>
      <Icon.download />
    </a>
  );
}

/** Groups row actions with consistent spacing. */
export function RowActions({ children }: { children: React.ReactNode }) {
  return <div className="rowactions">{children}</div>;
}
