"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Modal, Field, submitJson } from "../lib/modal";
import { CopyId } from "../lib/copy-id";
import { LabelCombobox } from "../lib/label-combobox";
import { apiGet, wsHeader } from "../lib/client";
import { useCostSettings, usePrice, savePrice, mergePriceDoc, timeDraft, timeOut, TimePriceField, type TimePrice } from "../lib/prices";

const HOSTS_HINT = "comma or newline separated; *.domain.com = domain + subdomains; * = all outbound allowed; empty = all outbound blocked";
const parseHosts = (s: string) => s.split(/[\n,]/).map((h) => h.trim()).filter(Boolean);

const QUANTITY = /^[0-9]+(\.[0-9]+)?(m|k|M|G|T|P|Ki|Mi|Gi|Ti|Pi)?$/;
interface TolDraft { key: string; operator: string; value: string; effect: string }

function EnvironmentModal({ env, onClose }: { env?: any; onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialPod = env?.pod ?? {};
  const [form, setForm] = useState({
    name: env?.name ?? "",
    hosts: (env?.allowed_hosts ?? []).join(", "),
    pkg: env?.allow_package_managers ?? false,
    mcpAllowed: env?.allow_mcp_servers ?? false,
    reqCpu: initialPod.requests?.cpu ?? "", reqMem: initialPod.requests?.memory ?? "",
    limCpu: initialPod.limits?.cpu ?? "", limMem: initialPod.limits?.memory ?? "",
    selector: Object.entries(initialPod.nodeSelector ?? {}).map(([k, v]) => ({ k, v: String(v) })),
    tolerations: ((initialPod.tolerations ?? []) as any[]).map((t) => ({
      key: t.key ?? "", operator: t.operator ?? "Equal", value: t.value ?? "", effect: t.effect ?? "",
    })) as TolDraft[],
    persistLocal: (initialPod.disk?.type ?? "emptyDir") === "pvc",
    storageClass: initialPod.disk?.storageClass ?? "",
    sizeGb: String(initialPod.disk?.sizeGb ?? 64),
  });
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const setRow = (i: number, k: "k" | "v", v: string) =>
    set("selector", form.selector.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const setTol = (i: number, k: keyof TolDraft, v: string) =>
    set("tolerations", form.tolerations.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  // Storage classes come from the cluster; loaded once per modal open.
  const [classes, setClasses] = useState<{ name: string; isDefault: boolean }[] | null>(null);
  useEffect(() => {
    apiGet<{ storageClasses: { name: string; isDefault: boolean }[] }>("/v1/storage-classes")
      .then((r) => setClasses(r.storageClasses))
      .catch(() => { setClasses([]); setError("failed to load storage classes from the cluster"); });
  }, []);
  useEffect(() => {
    if (form.persistLocal && !form.storageClass && classes?.length)
      set("storageClass", (classes.find((c) => c.isDefault) ?? classes[0]).name);
  }, [classes, form.persistLocal]);   // eslint-disable-line react-hooks/exhaustive-deps

  const [nodeSched, setNodeSched] = useState<{ labels: Record<string, string[]>; taints: { key: string; value: string; effect: string }[] } | null>(null);
  useEffect(() => {
    apiGet<{ labels: Record<string, string[]>; taints: { key: string; value: string; effect: string }[] }>("/v1/node-scheduling")
      .then(setNodeSched)
      .catch(() => setNodeSched({ labels: {}, taints: [] })); // degrade to free-text inputs
  }, []);
  const labelKeys = Object.keys(nodeSched?.labels ?? {}).sort();

  const cost = useCostSettings();
  const showEnvReal = !!cost?.enabled && cost.trackEnvCosts;
  const showSesBill = !!cost?.billing.enabled && cost.billing.billSessionTime;
  const { price } = usePrice("environment", env?.id);
  const [envTime, setEnvTime] = useState<TimePrice>(timeDraft(undefined));
  const [sesTime, setSesTime] = useState<TimePrice>(timeDraft(undefined));
  useEffect(() => {
    setEnvTime(timeDraft(price?.real?.podTime));
    setSesTime({ ...timeDraft(price?.billing?.sessionTime), per: price?.billing?.sessionTime?.per ?? "minute" });
  }, [price]);

  const submit = async () => {
    for (const [label, v] of [["Requests CPU", form.reqCpu], ["Requests memory", form.reqMem],
                              ["Limits CPU", form.limCpu], ["Limits memory", form.limMem]] as const) {
      if (v.trim() && !QUANTITY.test(v.trim())) { setError(`${label}: not a Kubernetes quantity (e.g. 250m, 512Mi)`); return; }
    }
    if (form.persistLocal && (!form.storageClass || !(Number(form.sizeGb) >= 1))) {
      setError("Persisting turns locally needs a storage class and a size of at least 1 GiB"); return;
    }
    const pod: any = {};
    const req: any = {};
    if (form.reqCpu.trim()) req.cpu = form.reqCpu.trim();
    if (form.reqMem.trim()) req.memory = form.reqMem.trim();
    if (Object.keys(req).length) pod.requests = req;
    const lim: any = {};
    if (form.limCpu.trim()) lim.cpu = form.limCpu.trim();
    if (form.limMem.trim()) lim.memory = form.limMem.trim();
    if (Object.keys(lim).length) pod.limits = lim;
    const nodeSelector = Object.fromEntries(form.selector.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]));
    if (Object.keys(nodeSelector).length) pod.nodeSelector = nodeSelector;
    const tolerations = form.tolerations
      .filter((t) => t.key.trim() || t.operator === "Exists")
      .map((t) => ({
        ...(t.key.trim() ? { key: t.key.trim() } : {}),
        operator: t.operator,
        ...(t.operator === "Equal" && t.value ? { value: t.value } : {}),
        ...(t.effect ? { effect: t.effect } : {}),
      }));
    if (tolerations.length) pod.tolerations = tolerations;
    pod.disk = form.persistLocal
      ? { type: "pvc", storageClass: form.storageClass, sizeGb: Math.floor(Number(form.sizeGb)) }
      : { type: "emptyDir" };
    const body = { name: form.name, allowPackageManagers: form.pkg, allowMcpServers: form.mcpAllowed, allowedHosts: parseHosts(form.hosts), pod };
    setBusy(true); setError(null);
    const err = env ? await submitJson("PATCH", `/v1/environments/${env.id}`, body)
                    : await submitJson("POST", "/v1/environments", body);
    if (!err && (showEnvReal || showSesBill)) {
      let ref = env?.id;
      if (!ref) {   // create: find the new row by name
        const j = await fetch("/api/v1/environments?limit=1000", { headers: wsHeader() })
          .then((r) => r.json()).catch(() => null);
        ref = (j?.environments ?? j?.rows ?? []).find((x: any) => x.name === form.name)?.id;
      }
      if (ref) {
        const edits = [
          { path: ["real", "podTime"] as [string, string], value: timeOut(envTime), visible: showEnvReal },
          { path: ["billing", "sessionTime"] as [string, string], value: timeOut(sesTime), visible: showSesBill },
        ];
        const prices = mergePriceDoc(price, edits);
        const priceErr = await savePrice("environment", ref, prices);
        if (priceErr) { setBusy(false); setError(priceErr); return; }
      }
    }
    setBusy(false);
    if (err) setError(err); else { onClose(); router.refresh(); }
  };

  return (
    <Modal title={env ? `Edit environment — ${env.name}` : "Create environment"} width="lg"
      onClose={onClose} busy={busy} error={error}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || !form.name} onClick={submit}>
          {busy ? "Saving…" : env ? "Save changes" : "Create environment"}
        </button>
      </>}>
      {env && <p className="sub" style={{ marginTop: 0 }}><CopyId id={env.id} /></p>}
      <Field label="Name" required>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Requests" hint="cpu / memory each session pod reserves; empty = platform default (250m / 512Mi)">
        <input style={{ width: 110, flex: "none" }} value={form.reqCpu} placeholder="250m"
               onChange={(e) => set("reqCpu", e.target.value)} />
        <input style={{ width: 110, flex: "none" }} value={form.reqMem} placeholder="512Mi"
               onChange={(e) => set("reqMem", e.target.value)} />
      </Field>
      <Field label="Limits" hint="hard caps; empty cpu = uncapped, empty memory = 1Gi">
        <input style={{ width: 110, flex: "none" }} value={form.limCpu} placeholder="none"
               onChange={(e) => set("limCpu", e.target.value)} />
        <input style={{ width: 110, flex: "none" }} value={form.limMem} placeholder="1Gi"
               onChange={(e) => set("limMem", e.target.value)} />
      </Field>
      <Field label="Node selector" stack
             hint="key=value node labels session pods must land on; no rows = any node">
        <div className="kvrows">
          {form.selector.map((r, i) => (
            <div className="kvrow" key={i}>
              <LabelCombobox value={r.k} onChange={(v) => setRow(i, "k", v)} options={labelKeys}
                             placeholder="kubernetes.io/arch" />
              <span className="muted">=</span>
              <LabelCombobox value={r.v} onChange={(v) => setRow(i, "v", v)}
                             options={nodeSched?.labels?.[r.k] ?? []} placeholder="amd64" />
              <button className="iconbtn danger" title="Remove label" aria-label="Remove label"
                      onClick={() => set("selector", form.selector.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button className="ghost" onClick={() => set("selector", [...form.selector, { k: "", v: "" }])}>+ Add label</button></div>
        </div>
      </Field>
      <Field label="Tolerations" stack
             hint="let session pods run on tainted nodes — taint the nodes themselves with kubectl">
        <div className="kvrows">
          {form.tolerations.map((t, i) => (
            <div className="kvrow" key={i}>
              {(nodeSched?.taints?.length ?? 0) > 0 && (
                <select value="" style={{ flex: "none", width: 150 }}
                        onChange={(e) => {
                          const t = nodeSched!.taints[Number(e.target.value)];
                          if (!t) return;
                          set("tolerations", form.tolerations.map((r, j) => j === i
                            ? { key: t.key, operator: t.value ? "Equal" : "Exists", value: t.value, effect: t.effect }
                            : r));
                        }}>
                  <option value="">from a node taint…</option>
                  {nodeSched!.taints.map((t, ti) => (
                    <option key={ti} value={ti}>{t.key}{t.value ? `=${t.value}` : ""} · {t.effect || "any"}</option>
                  ))}
                </select>
              )}
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
                      onClick={() => set("tolerations", form.tolerations.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button className="ghost" onClick={() =>
            set("tolerations", [...form.tolerations, { key: "", operator: "Equal", value: "", effect: "" }])}>+ Add toleration</button></div>
        </div>
      </Field>
      <Field label="Disk" hint="unchecked = node-local emptyDir, /work rides the checkpoint; checked = a dedicated volume per session, deleted with it">
        <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={form.persistLocal} onChange={(e) => set("persistLocal", e.target.checked)} />
          Persist turns locally (dedicated /work volume per session)
        </label>
      </Field>
      {form.persistLocal && (<>
        <Field label="Storage class" required>
          <select value={form.storageClass} onChange={(e) => set("storageClass", e.target.value)}>
            {classes === null && <option value="">loading…</option>}
            {classes !== null && classes.length === 0 && <option value="">no storage classes found</option>}
            {(classes ?? []).map((c) => (
              <option key={c.name} value={c.name}>{c.name}{c.isDefault ? " (default)" : ""}</option>
            ))}
          </select>
        </Field>
        <Field label="Size (GiB)" required>
          <input style={{ width: 90, flex: "none" }} value={form.sizeGb} onChange={(e) => set("sizeGb", e.target.value)} />
        </Field>
      </>)}
      <Field label="Packages">
        <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={form.pkg} onChange={(e) => setForm({ ...form, pkg: e.target.checked })} />
          Allow package-manager network access (pip, npm)
        </label>
      </Field>
      <Field label="MCP servers">
        <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={form.mcpAllowed} onChange={(e) => set("mcpAllowed", e.target.checked)} />
          Allow MCP servers (auto-allows the configured MCP hosts of agents using this environment)
        </label>
      </Field>
      <Field label="Allowed hosts" stack hint={HOSTS_HINT}>
        <textarea rows={3} value={form.hosts} onChange={(e) => setForm({ ...form, hosts: e.target.value })}
                  placeholder="api.github.com, docs.python.org" />
      </Field>
      {showEnvReal && (
        <TimePriceField label="Real cost" currency={cost!.currency} value={envTime} onChange={setEnvTime}
          minuteOk hint="what one running session pod costs you — metered per minute; the unit only sets the rate" />
      )}
      {showSesBill && (
        <TimePriceField label="Session billing" currency={cost!.currency} value={sesTime} onChange={setSesTime}
          minuteOk hint="turn-pod runtime, billed per started minute — the unit only sets the rate" />
      )}
    </Modal>
  );
}

export function CreateEnvironment() {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}>+ Create environment</button>
    {open && <EnvironmentModal onClose={() => setOpen(false)} />}
  </>);
}

export function EditEnvironmentName({ env }: { env: any }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button className="namebtn" title="Edit environment"
            onClick={() => setOpen(true)}><code>{env.id}</code></button>
    {open && <EnvironmentModal env={env} onClose={() => setOpen(false)} />}
  </>);
}
