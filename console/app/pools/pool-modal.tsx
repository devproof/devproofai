"use client";
// Create/edit ModelPools — where K8s node selectors are configured (spec 2026-07-09).
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Modal, Field, submitJson, ConfirmDialog } from "../lib/modal";
import { useCostSettings, usePrice, savePrice, timeDraft, timeOut, TimePriceField, type TimePrice } from "../lib/prices";

interface TolDraft { key: string; operator: string; value: string; effect: string }
interface Draft { name: string; gpuType: string; gpusPerNode: string; maxNodes: string;
                  selector: { k: string; v: string }[]; tolerations: TolDraft[]; }

export function PoolModal({ pool, deployments = [], onClose }:
  { pool?: any; deployments?: string[]; onClose: () => void }) {
  const isEdit = !!pool;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [d, setD] = useState<Draft>(() => ({
    name: pool?.metadata?.name ?? "",
    gpuType: pool?.spec?.gpuType ?? "cpu",
    gpusPerNode: String(pool?.spec?.gpusPerNode ?? 0),
    maxNodes: String(pool?.spec?.maxNodes ?? 1),
    selector: Object.entries(pool?.spec?.nodeSelector ?? {}).map(([k, v]) => ({ k, v: String(v) })),
    tolerations: (pool?.spec?.tolerations ?? []).map((t: any) => ({
      key: t.key ?? "", operator: t.operator ?? "Equal", value: t.value ?? "", effect: t.effect ?? "",
    })),
  }));
  const set = (k: keyof Draft, v: any) => setD({ ...d, [k]: v });
  const setRow = (i: number, k: "k" | "v", v: string) =>
    set("selector", d.selector.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const setTol = (i: number, k: keyof TolDraft, v: string) =>
    set("tolerations", d.tolerations.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  const [pendingBody, setPendingBody] = useState<any | null>(null);

  const cost = useCostSettings();
  const showPoolPrice = !!cost?.enabled && cost.trackPoolCosts;
  const { price } = usePrice("pool", pool?.metadata?.name);
  const [podTime, setPodTime] = useState<TimePrice>(timeDraft(undefined));
  useEffect(() => { setPodTime(timeDraft(price?.real?.podTime)); }, [price]);

  const buildBody = () => {
    const nodeSelector = Object.fromEntries(
      d.selector.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]));
    const tolerations = d.tolerations
      .filter((t) => t.key.trim() || t.operator === "Exists")
      .map((t) => ({
        ...(t.key.trim() ? { key: t.key.trim() } : {}),
        operator: t.operator,
        ...(t.operator === "Equal" && t.value ? { value: t.value } : {}),
        ...(t.effect ? { effect: t.effect } : {}),
      }));
    return { nodeSelector, gpuType: d.gpuType || undefined,
      gpusPerNode: Number(d.gpusPerNode) || 0, maxNodes: Number(d.maxNodes) || 0, tolerations };
  };

  // Key order is irrelevant for the selector; toleration rows are user-ordered,
  // so an order change counts as a change (harmless: one extra rollout).
  const normSel = (o: Record<string, unknown> | undefined) =>
    JSON.stringify(Object.entries(o ?? {}).map(([k, v]) => [k, String(v)])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const normTols = (ts: any[] | undefined) =>
    JSON.stringify((ts ?? []).map((t) => [t.key ?? "", t.operator ?? "", t.value ?? "", t.effect ?? ""]));
  const placementChanged = (body: any) =>
    normSel(body.nodeSelector) !== normSel(pool?.spec?.nodeSelector) ||
    normTols(body.tolerations) !== normTols(pool?.spec?.tolerations);

  const send = async (body: any) => {
    const err = isEdit
      ? await submitJson("PATCH", `/v1/pools/${pool.metadata.name}`, body)
      : await submitJson("POST", "/v1/pools", { name: d.name, ...body });
    if (!err && showPoolPrice) {
      const t = timeOut(podTime);
      const priceErr = await savePrice("pool", isEdit ? pool.metadata.name : d.name,
        t ? { real: { podTime: t } } : {});
      if (priceErr) return priceErr;   // surfaced in the modal banner; resource itself saved
    }
    if (!err) { onClose(); router.refresh(); }
    return err;
  };

  const submit = async () => {
    const body = buildBody();
    if (isEdit && deployments.length > 0 && placementChanged(body)) { setPendingBody(body); return; }
    setBusy(true); setError(null);
    const err = await send(body);
    setBusy(false);
    if (err) setError(err);
  };

  if (pendingBody) {
    return <ConfirmDialog title="Restart engine pods?" verb="Restart"
      message={`Placement changed — this restarts the engine pods of ${deployments.length} deployment${deployments.length === 1 ? "" : "s"}: ${deployments.join(", ")}. Their model caches re-provision on the target nodes (weights re-download; brief serving gap).`}
      onConfirm={() => send(pendingBody)} onClose={() => setPendingBody(null)} />;
  }

  return (
    <Modal title={isEdit ? `Edit pool ${pool.metadata.name}` : "Create pool"} width="md"
      subtitle="A pool maps deployments onto physical nodes — node labels differ per cloud and per cluster."
      onClose={onClose} busy={busy} error={error}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || (!isEdit && !d.name)} onClick={submit}>
          {busy ? "Saving…" : isEdit ? "Save" : "Create pool"}
        </button>
      </>}>
      {!isEdit && (
        <Field label="Name" required hint="DNS-1035: lowercase letters, digits, dashes; starts with a letter">
          <input value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="gpu-a100" />
        </Field>
      )}
      <Field label="Node selector" stack
             hint="key=value node labels this pool's pods must land on; no rows = any node. Saving rolls this pool's engine pods onto matching nodes.">
        <div className="kvrows">
          {d.selector.map((r, i) => (
            <div className="kvrow" key={i}>
              <input value={r.k} onChange={(e) => setRow(i, "k", e.target.value)} placeholder="nvidia.com/gpu.product" />
              <span className="muted">=</span>
              <input value={r.v} onChange={(e) => setRow(i, "v", e.target.value)} placeholder="NVIDIA-A100-SXM4-40GB" />
              <button className="iconbtn danger" title="Remove label" aria-label="Remove label"
                      onClick={() => set("selector", d.selector.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button className="ghost" onClick={() => set("selector", [...d.selector, { k: "", v: "" }])}>+ Add label</button></div>
        </div>
      </Field>
      <Field label="Tolerations" stack
             hint="let this pool's pods run on tainted nodes — taint the nodes themselves with kubectl. Currently applied to GPU pools only.">
        <div className="kvrows">
          {d.tolerations.map((t, i) => (
            <div className="kvrow" key={i}>
              <input value={t.key} placeholder="nvidia.com/gpu"
                     onChange={(e) => setTol(i, "key", e.target.value)} />
              <select value={t.operator} style={{ flex: "none", width: 90 }}
                      onChange={(e) => setTol(i, "operator", e.target.value)}>
                <option value="Equal">Equal</option><option value="Exists">Exists</option>
              </select>
              {t.operator === "Equal" && (
                <input value={t.value} placeholder="value" style={{ width: 110, flex: "none" }}
                       onChange={(e) => setTol(i, "value", e.target.value)} />
              )}
              <select value={t.effect} style={{ flex: "none", width: 150 }}
                      onChange={(e) => setTol(i, "effect", e.target.value)}>
                <option value="">any effect</option>
                <option value="NoSchedule">NoSchedule</option>
                <option value="PreferNoSchedule">PreferNoSchedule</option>
                <option value="NoExecute">NoExecute</option>
              </select>
              <button className="iconbtn danger" title="Remove toleration" aria-label="Remove toleration"
                      onClick={() => set("tolerations", d.tolerations.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button className="ghost" onClick={() =>
            set("tolerations", [...d.tolerations, { key: "", operator: "Equal", value: "", effect: "" }])}>+ Add toleration</button></div>
        </div>
      </Field>
      <Field label="GPU type" hint="accelerator class — informational, used for capacity estimates; node placement comes from the selector">
        <input style={{ width: 160, flex: "none" }} value={d.gpuType} onChange={(e) => set("gpuType", e.target.value)} />
      </Field>
      <Field label="GPUs / node">
        <input style={{ width: 90, flex: "none" }} value={d.gpusPerNode} onChange={(e) => set("gpusPerNode", e.target.value)} />
      </Field>
      <Field label="Max nodes"
             hint="replica budget — the summed max replicas of this pool's deployments cannot exceed it (0 = unlimited)">
        <input style={{ width: 90, flex: "none" }} value={d.maxNodes} onChange={(e) => set("maxNodes", e.target.value)} />
      </Field>
      {showPoolPrice && (
        <TimePriceField label="Real cost" currency={cost!.currency} value={podTime} onChange={setPodTime}
          hint="what one running engine replica costs you — metered per minute; the unit only sets the rate" />
      )}
    </Modal>
  );
}

export function CreatePoolButton() {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}>+ Create pool</button>
    {open && <PoolModal onClose={() => setOpen(false)} />}
  </>);
}

export function EditPoolName({ pool, deployments }: { pool: any; deployments: string[] }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button className="namebtn" title="Edit pool" onClick={() => setOpen(true)}>{pool.metadata.name}</button>
    {open && <PoolModal pool={pool} deployments={deployments} onClose={() => setOpen(false)} />}
  </>);
}
