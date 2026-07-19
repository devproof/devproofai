"use client";
// Shared add/edit form for catalog models (spec 2026-07-09). Editing a bundled
// model writes a DB override; "Reset to defaults" deletes it (YAML reappears).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal, Field, ConfirmDialog, submitJson } from "../lib/modal";

interface ProfileDraft { gpuType: string; instanceType: string; gpusPerReplica: string;
                         vramGB: string; estTokensPerSec: string; }
const EMPTY_PROFILE: ProfileDraft = { gpuType: "cpu", instanceType: "cpu-4vcpu", gpusPerReplica: "0",
                                      vramGB: "0", estTokensPerSec: "15" };

interface Draft {
  displayName: string; family: string; parameters: string; format: string; quantization: string;
  source: string; license: string; releaseDate: string; toolCalling: string; contextTokens: string;
  vramGB: string; diskGB: string; gpus: string; profiles: ProfileDraft[]; reasoning: string;
  cpu: string; memory: string;
}

function toDraft(m?: any): Draft {
  return {
    displayName: m?.displayName ?? "", family: m?.family ?? "custom",
    parameters: m?.parameters ?? "", format: m?.format ?? "gguf",
    quantization: m?.quantization ?? "Q4_K_M", source: m?.source ?? "",
    license: m?.license ?? "", releaseDate: m?.releaseDate ?? "", toolCalling: m?.toolCalling ?? "basic",
    contextTokens: m?.contextTokens != null ? String(m.contextTokens) : "",
    vramGB: String(m?.requirements?.vramGB ?? 0), diskGB: String(m?.requirements?.diskGB ?? 1),
    gpus: String(m?.requirements?.gpus ?? 0),
    profiles: (m?.capacityProfiles ?? [{ ...EMPTY_PROFILE }]).map((p: any) => ({
      gpuType: p.gpuType ?? "cpu", instanceType: p.instanceType ?? "",
      gpusPerReplica: String(p.gpusPerReplica ?? 0), vramGB: String(p.vramGB ?? 0),
      estTokensPerSec: String(p.estTokensPerSec ?? 0),
    })),
    reasoning: m?.reasoning?.efforts ? Object.entries(m.reasoning.efforts as Record<string, number>).sort((a, b) => a[1] - b[1]).map(([k, v]) => `${k}=${v}`).join(", ") : "",
    cpu: m?.resources?.cpu ?? "2", memory: m?.resources?.memory ?? "3Gi",
  };
}

// "off=0, low=1024" → { efforts: {off:0, low:1024} }; null = no reasoning.
// Lenient on purpose — the CP validates the shape and the modal surfaces its 400.
function parseEfforts(s: string): { efforts: Record<string, number> } | null {
  const pairs = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (!pairs.length) return null;
  const efforts: Record<string, number> = {};
  for (const p of pairs) {
    const [k, v] = p.split("=").map((x) => x.trim());
    efforts[k ?? ""] = v ? Number(v) : NaN;
  }
  return { efforts };
}

function toBody(d: Draft) {
  return {
    displayName: d.displayName, family: d.family || "custom", parameters: d.parameters || "—",
    format: d.format, quantization: d.format === "gguf" ? d.quantization || undefined : undefined,
    source: d.source, license: d.license || undefined, releaseDate: d.releaseDate || undefined,
    toolCalling: d.toolCalling,
    contextTokens: d.contextTokens && !Number.isNaN(Number(d.contextTokens)) ? Number(d.contextTokens) : undefined,
    requirements: { vramGB: Number(d.vramGB) || 0, diskGB: Number(d.diskGB) || 1, gpus: Number(d.gpus) || 0 },
    capacityProfiles: d.profiles.map((p) => ({
      gpuType: p.gpuType, instanceType: p.instanceType,
      gpusPerReplica: Number(p.gpusPerReplica) || 0, vramGB: Number(p.vramGB) || 0,
      estTokensPerSec: Number(p.estTokensPerSec) || 0,
    })),
    reasoning: d.format === "gguf" ? parseEfforts(d.reasoning) : null,
    resources: { cpu: d.cpu, memory: d.memory },
  };
}

export function ModelFormModal({ mode, entry, onClose }: { mode: "add" | "edit"; entry?: any; onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [d, setD] = useState<Draft>(() => toDraft(entry));
  const set = (k: keyof Draft, v: any) => setD({ ...d, [k]: v });
  const setP = (i: number, k: keyof ProfileDraft, v: string) =>
    setD({ ...d, profiles: d.profiles.map((p, j) => (j === i ? { ...p, [k]: v } : p)) });

  const submit = async () => {
    setBusy(true); setError(null);
    const err = mode === "add"
      ? await submitJson("POST", "/v1/catalog", {
          id: d.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-custom",
          ...toBody(d),
        })
      : await submitJson("PATCH", `/v1/catalog/${entry.id}`, toBody(d));
    setBusy(false);
    if (err) setError(err); else { onClose(); router.refresh(); }
  };

  return (
    <Modal title={mode === "add" ? "Add custom model" : `Edit ${entry.displayName}`} width="lg" dismissible={!resetOpen}
      subtitle={mode === "add"
        ? "Point at any HuggingFace model. GGUF → llama.cpp, safetensors → vLLM."
        : entry.overridden ? "This bundled model has site overrides."
        : entry.custom ? undefined : "Editing a bundled model stores a site override; the YAML default stays intact."}
      onClose={onClose} busy={busy} error={error}
      footer={<>
        {mode === "edit" && entry.overridden && (
          <button className="ghost danger" disabled={busy} style={{ marginRight: "auto" }}
                  onClick={() => setResetOpen(true)}>Reset to defaults</button>
        )}
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || !d.displayName || !d.source || !d.cpu || !d.memory} onClick={submit}>
          {busy ? "Saving…" : mode === "add" ? "Add model" : "Save"}
        </button>
      </>}>
      <div className="modal-section">Identity</div>
      <Field label="Display name" required>
        <input value={d.displayName} onChange={(e) => set("displayName", e.target.value)} placeholder="My Qwen 1.5B" />
      </Field>
      <Field label="Family / params">
        <input style={{ width: 130, flex: "none" }} value={d.family} onChange={(e) => set("family", e.target.value)} />
        <input style={{ width: 90, flex: "none" }} value={d.parameters} onChange={(e) => set("parameters", e.target.value)} placeholder="1.5B" />
      </Field>
      <Field label="License">
        <input style={{ width: 160, flex: "none" }} value={d.license} onChange={(e) => set("license", e.target.value)} placeholder="apache-2.0" />
      </Field>
      <Field label="Released" hint="original model release date">
        <input type="date" style={{ width: 160, flex: "none" }} value={d.releaseDate} onChange={(e) => set("releaseDate", e.target.value)} />
      </Field>

      <div className="modal-section">Artifact</div>
      <Field label="Source" required stack hint="HF resolve URL for GGUF, or repo id for safetensors">
        <input value={d.source} onChange={(e) => set("source", e.target.value)}
               placeholder="https://huggingface.co/…/resolve/main/model-Q4_K_M.gguf" />
      </Field>
      <Field label="Format">
        <select value={d.format} onChange={(e) => set("format", e.target.value)} style={{ flex: "none", width: 190 }}>
          <option value="gguf">GGUF (llama.cpp)</option>
          <option value="safetensors">safetensors (vLLM)</option>
        </select>
        {d.format === "gguf" && (<>
          <span className="muted">quant</span>
          <input style={{ width: 110, flex: "none" }} value={d.quantization} onChange={(e) => set("quantization", e.target.value)} />
        </>)}
      </Field>
      <Field label="Context">
        <input style={{ width: 110, flex: "none" }} value={d.contextTokens} onChange={(e) => set("contextTokens", e.target.value)} placeholder="tokens" />
        <span className="muted">tokens</span>
      </Field>
      {d.format === "gguf" && (
        <Field label="Reasoning" hint="effort=token budget pairs, 0 = thinking off — empty if the model cannot reason">
          <input value={d.reasoning} onChange={(e) => set("reasoning", e.target.value)}
                 placeholder="off=0, low=1024, medium=4096, high=16384" />
        </Field>
      )}

      <div className="modal-section">Capability</div>
      <Field label="Tool calling" hint="how well the model drives agent tools">
        <select value={d.toolCalling} onChange={(e) => set("toolCalling", e.target.value)} style={{ flex: "none", width: 130 }}>
          <option value="strong">strong</option><option value="basic">basic</option><option value="none">none</option>
        </select>
      </Field>
      <Field label="Requirements" hint="per replica: GPU count, VRAM, disk for weights">
        <span className="muted">GPUs</span>
        <input style={{ width: 60, flex: "none" }} value={d.gpus} onChange={(e) => set("gpus", e.target.value)} />
        <span className="muted">VRAM GB</span>
        <input style={{ width: 70, flex: "none" }} value={d.vramGB} onChange={(e) => set("vramGB", e.target.value)} />
        <span className="muted">disk GB</span>
        <input style={{ width: 70, flex: "none" }} value={d.diskGB} onChange={(e) => set("diskGB", e.target.value)} />
      </Field>

      <div className="modal-section">Capacity profiles</div>
      <Field label="Requests" hint='per-replica k8s requests (e.g. 2, 500m / 3Gi) — prefilled into new deployments'>
        <span className="muted">cpu</span>
        <input style={{ width: 90, flex: "none" }} value={d.cpu} onChange={(e) => set("cpu", e.target.value)} />
        <span className="muted">memory</span>
        <input style={{ width: 90, flex: "none" }} value={d.memory} onChange={(e) => set("memory", e.target.value)} />
      </Field>
      <Field label="Profiles" stack hint="hardware options this model can deploy on">
        <div className="kvrows">
          <div className="profile-head">
            <span>GPU type</span><span>Instance</span><span>GPUs</span><span>VRAM</span><span>tok/s</span><span />
          </div>
          {d.profiles.map((p, i) => (
            <div className="profile-row" key={i}>
              <input value={p.gpuType} onChange={(e) => setP(i, "gpuType", e.target.value)} />
              <input value={p.instanceType} onChange={(e) => setP(i, "instanceType", e.target.value)} />
              <input value={p.gpusPerReplica} onChange={(e) => setP(i, "gpusPerReplica", e.target.value)} />
              <input value={p.vramGB} onChange={(e) => setP(i, "vramGB", e.target.value)} />
              <input value={p.estTokensPerSec} onChange={(e) => setP(i, "estTokensPerSec", e.target.value)} />
              <button className="iconbtn danger" title="Remove profile" aria-label="Remove profile"
                      disabled={d.profiles.length <= 1}
                      onClick={() => set("profiles", d.profiles.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button className="ghost" onClick={() => set("profiles", [...d.profiles, { ...EMPTY_PROFILE }])}>+ Add profile</button></div>
        </div>
      </Field>
      {resetOpen && <ConfirmDialog title="Reset to defaults" verb="Reset"
        message={`Discard the site overrides for "${entry.displayName}"? The bundled catalog defaults come back.`}
        onClose={() => setResetOpen(false)}
        onConfirm={async () => {
          const err = await submitJson("DELETE", `/v1/catalog/${entry.id}`);
          if (!err) { onClose(); router.refresh(); }
          return err;
        }} />}
    </Modal>
  );
}

export function AddCustomModelButton() {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}>+ Add custom model</button>
    {open && <ModelFormModal mode="add" onClose={() => setOpen(false)} />}
  </>);
}

/** Model name = edit affordance (console-wide name-click pattern). */
export function EditModelName({ entry }: { entry: any }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button className="namebtn" title="Edit model" onClick={() => setOpen(true)}>{entry.displayName}</button>
    {open && <ModelFormModal mode="edit" entry={entry} onClose={() => setOpen(false)} />}
  </>);
}
