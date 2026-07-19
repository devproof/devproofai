"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { wsHeader } from "../lib/client";

export function UploadFile({ url = "/api/v1/files", label = "+ Upload file" }:
  { url?: string; label?: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <input ref={input} type="file" style={{ display: "none" }} onChange={async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setBusy(true); setError(null);
        try {
          const body = new FormData();
          body.append("file", file);
          const res = await fetch(url, { method: "POST", headers: wsHeader(), body });
          if (res.ok) router.refresh();
          else setError(`Upload failed: ${res.status}`);
        } catch (err) {
          setError(String(err));
        } finally {
          setBusy(false);
          e.target.value = "";
        }
      }} />
      <button disabled={busy} onClick={() => input.current?.click()}>{busy ? "Uploading…" : label}</button>
      {error && <span className="modal-error" style={{ margin: 0, marginLeft: 8 }}>{error}</span>}
    </>
  );
}
