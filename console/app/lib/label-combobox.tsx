"use client";
// Editable combobox: a text input with a filtered dropdown of suggestions read
// from the cluster (node labels/values). Free text is always allowed — typing
// updates the value directly; picking a suggestion fills it. Modeled on the
// open/click-outside pattern in mcp-picker.tsx.
import { useEffect, useRef, useState } from "react";

export function LabelCombobox({ value, onChange, options, placeholder }: {
  value: string; onChange: (v: string) => void; options: string[]; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const q = value.trim().toLowerCase();
  const hits = options.filter((o) => !q || o.toLowerCase().includes(q)).slice(0, 50);

  return (
    <div className="lcbx" ref={wrapRef}
         onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); } }}>
      <input value={value} placeholder={placeholder}
             onChange={(e) => { onChange(e.target.value); setOpen(true); }}
             onFocus={() => setOpen(true)} />
      {open && hits.length > 0 && (
        <div className="lcbx-panel">
          {hits.map((o) => (
            <button type="button" key={o} className="lcbx-option"
                    onClick={() => { onChange(o); setOpen(false); }}>{o}</button>
          ))}
        </div>
      )}
    </div>
  );
}
