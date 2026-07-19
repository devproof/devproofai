"use client";
// Shared dialog primitives (spec 2026-07-09). Every create/edit/confirm flow
// in the console — native browser dialogs are banned.
import { useEffect, useRef, useState } from "react";
import { wsHeader } from "./client";

// Open modals, topmost last — Escape must only dismiss the top of the stack
// (e.g. the file picker inside the create-session dialog, not both at once).
const modalStack: symbol[] = [];

/** Escape-closes this overlay only while it is the topmost open one.
 *  Shared by Modal, the session SideSheet, and the image Lightbox. */
export function useTopEscape(onClose: () => void, active = true) {
  const idRef = useRef<symbol | null>(null);
  if (idRef.current === null) idRef.current = Symbol();
  useEffect(() => {
    const id = idRef.current!;
    modalStack.push(id);
    return () => { modalStack.splice(modalStack.indexOf(id), 1); };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && active && modalStack.at(-1) === idRef.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose]);
}

export function Modal({ title, subtitle, width = "md", onClose, dismissible = true, busy = false,
                        error, footer, children }: {
  title: string; subtitle?: string; width?: "sm" | "md" | "lg"; onClose: () => void;
  dismissible?: boolean; busy?: boolean; error?: string | null;
  footer?: React.ReactNode; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useTopEscape(onClose, dismissible && !busy);
  useEffect(() => { ref.current?.querySelector<HTMLElement>("input, select, textarea")?.focus(); }, []);
  return (
    <div className="modal-overlay"
         onMouseDown={(e) => { if (e.target === e.currentTarget && dismissible && !busy) onClose(); }}>
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title}
           style={{ width: { sm: 440, md: 560, lg: 680 }[width] }}>
        <h2 className="modal-title">{title}</h2>
        {subtitle && <p className="modal-sub">{subtitle}</p>}
        <div className="modal-body">{children}</div>
        {error && <div className="modal-error" role="alert">{error}</div>}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Labeled form row. Div-based (not <label>) so it can hold checklists/multiple controls. */
export function Field({ label, hint, required, stack, children }: {
  label: string; hint?: string; required?: boolean; stack?: boolean; children: React.ReactNode;
}) {
  return (
    <div className={`field${stack ? " stack" : ""}`}>
      <span className="field-label">{label}{required && <em> *</em>}</span>
      <span className="field-control">{children}</span>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

/** JSON fetch for dialogs: resolves to an error string (shown in the modal banner) or null on success. */
export async function submitJson(method: string, path: string, body?: unknown): Promise<string | null> {
  try {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? wsHeader() : { "Content-Type": "application/json", ...wsHeader() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return null;
    return (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`;
  } catch (err) {
    return String(err);
  }
}

/** Styled replacement for window.confirm — danger verb button, inline failure. */
export function ConfirmDialog({ title, message, verb = "Delete", onConfirm, onClose }: {
  title: string; message: string; verb?: string;
  onConfirm: () => Promise<string | null>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={title} width="sm" onClose={onClose} busy={busy} error={error} footer={<>
      <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
      <button className="danger-solid" disabled={busy} onClick={async () => {
        setBusy(true);
        let err: string | null;
        try { err = await onConfirm(); } catch (e) { err = String(e); }
        setBusy(false);
        if (err) setError(err); else onClose();
      }}>{busy ? <span className="spin" /> : verb}</button>
    </>}>
      <p className="modal-msg">{message}</p>
    </Modal>
  );
}
