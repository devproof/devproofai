"use client";
// One centered modal for every deploy/edit flow (specs 2026-07-09), built on
// the shared Modal/Field primitives. Editing opens from the row's name.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { wsHeader } from "../lib/client";
import { Icon } from "../lib/icons";
import { Modal, Field, submitJson, ConfirmDialog } from "../lib/modal";
import { useCostSettings, usePrice, savePrice, mergePriceDoc, timeDraft, timeOut, TimePriceField, type TimePrice,
  tokenDraft, tokenOut, TokenPriceField, type TokenPrice } from "../lib/prices";

type Mode = "deploy-local" | "deploy-remote" | "edit-local" | "edit-remote";

const PRESETS: Record<string, { label: string; base: string; hint: string }> = {
  openai:     { label: "OpenAI",             base: "https://api.openai.com/v1",    hint: "gpt-4o" },
  anthropic:  { label: "Anthropic (Claude)", base: "https://api.anthropic.com",    hint: "claude-sonnet-5" },
  openrouter: { label: "OpenRouter",         base: "https://openrouter.ai/api/v1", hint: "meta-llama/llama-3.1-8b-instruct" },
  ollama:     { label: "Ollama Cloud",       base: "https://ollama.com/v1",        hint: "gpt-oss:120b" },
  custom:     { label: "OpenAI-compatible (custom URL)", base: "", hint: "served model id" },
};

const CPU_QTY = /^(\d+(\.\d+)?|\d+m)$/, MEM_QTY = /^\d+(Ki|Mi|Gi|Ti)$/;

interface Ctx {
  catalogId?: string;          // deploy-local
  defaultName?: string;        // deploy-local / deploy-remote
  contextTokens?: number;      // deploy-local: catalog default for the placeholder; edit-local: current value (restart diff + placeholder)
  catalogPick?: { id: string; displayName: string; contextTokens?: number;
    reasoning?: { efforts: Record<string, number> } | null;
    resources?: { cpu?: string; memory?: string } | null }[]; // deploy-local from /deployments: model dropdown
  name?: string;               // edit modes (immutable, shown)
  poolRef?: string;            // edit-local (shown)
  minReplicas?: number; maxReplicas?: number; reserveReplicas?: number; // edit-local (prefill)
  idleMinutes?: number;        // edit-local (prefill, scale-to-zero sleep window)
  engine?: string;             // edit-local (prefill)
  externalId?: string;         // edit-remote
  provider?: string;           // edit-remote (shown)
  baseUrl?: string | null;     // edit-remote
  modelId?: string;            // edit-remote
  reasoningOptions?: Record<string, number> | null; // deploy-local (preselected model) / edit-local: the entry's efforts
  reasoningEffort?: string | null; // edit-remote free text / edit-local current effort (already present — reuse)
  extContextTokens?: number; // edit-remote: current contextTokens (prefill) — mandatory, distinct from local's contextTokens
  resources?: { cpu?: string | null; memory?: string | null } | null; // deploy-local preselect / edit-local current values
  idle?: boolean;              // edit-local: phase Idle with no replicas — restart confirm becomes "applies on wake"
}

function DeployModal({ mode, ctx, onClose }: { mode: Mode; ctx: Ctx; onClose: () => void }) {
  const router = useRouter();
  const isLocal = mode === "deploy-local" || mode === "edit-local";
  const isEdit = mode === "edit-local" || mode === "edit-remote";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [probe, setProbe] = useState<string | null>(null);
  const [pools, setPools] = useState<{ name: string; maxNodes: number; committed: number }[]>([]);

  // local fields
  const [name, setName] = useState(ctx.name ?? ctx.defaultName ?? "");
  const [catalogId, setCatalogId] = useState(ctx.catalogId ?? "");
  const [ctxDefault, setCtxDefault] = useState<number | undefined>(ctx.contextTokens);
  const [reasonOpts, setReasonOpts] = useState<Record<string, number> | null>(ctx.reasoningOptions ?? null);
  const [poolRef, setPoolRef] = useState(ctx.poolRef ?? "");
  const [minR, setMinR] = useState(ctx.minReplicas != null ? String(ctx.minReplicas) : "1");
  const [maxR, setMaxR] = useState(ctx.maxReplicas != null ? String(ctx.maxReplicas) : "1");
  const [reserve, setReserve] = useState(ctx.reserveReplicas != null ? String(ctx.reserveReplicas) : "0");
  const [idleMin, setIdleMin] = useState(ctx.idleMinutes != null ? String(ctx.idleMinutes) : "15");
  const [cpuReq, setCpuReq] = useState(ctx.resources?.cpu ?? "");
  const [memReq, setMemReq] = useState(ctx.resources?.memory ?? "");
  const resValid = !isLocal || (CPU_QTY.test(cpuReq) && MEM_QTY.test(memReq));
  const resChanged = cpuReq !== (ctx.resources?.cpu ?? "") || memReq !== (ctx.resources?.memory ?? "");
  const nMin = Number(minR), nMax = Number(maxR), nRes = Number(reserve) || 0;
  const nIdle = Number(idleMin);
  const idleValid = nMin !== 0 || (Number.isInteger(nIdle) && nIdle >= 1 && nIdle <= 1440);
  const replicasValid = Number.isInteger(nMin) && Number.isInteger(nMax) && Number.isInteger(nRes)
    && nMin >= 0 && nMax >= 1 && nMax >= nMin && nRes >= 0 && nRes <= nMax - nMin && idleValid;
  const [ctxTokens, setCtxTokens] = useState("");
  const [engine, setEngine] = useState(ctx.engine ?? "auto");
  // remote fields
  const [provider, setProvider] = useState(ctx.provider ?? "openai");
  const [baseUrl, setBaseUrl] = useState(ctx.baseUrl ?? "");
  const [modelId, setModelId] = useState(ctx.modelId ?? "");
  const [apiKey, setApiKey] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState(ctx.reasoningEffort ?? "");
  const [extContextTokens, setExtContextTokens] = useState(ctx.extContextTokens != null ? String(ctx.extContextTokens) : "");
  const extContextNum = Number(extContextTokens);
  const extContextValid = extContextTokens !== "" && Number.isInteger(extContextNum)
    && extContextNum >= 1024 && extContextNum <= 2000000;

  useEffect(() => {
    if (!isLocal) return;
    fetch("/api/v1/pools", { headers: wsHeader() }).then((r) => r.json())
      .then((d) => {
        const rows = (d.pools ?? []).map((p: any) => ({
          name: p.metadata?.name, maxNodes: p.spec?.maxNodes ?? 0,
          committed: p.committedMaxReplicas ?? 0,
        })).filter((p: any) => p.name);
        setPools(rows);
        if (rows.length && !poolRef) setPoolRef(rows[0].name);
      }).catch(() => setPools([]));
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const cost = useCostSettings();
  const billOn = !!cost?.billing.enabled;
  const showDepTime = isLocal && billOn && cost!.billing.billDeploymentTime;
  const showLocalTok = isLocal && billOn && cost!.billing.billLocalTokens;
  const showExtReal = !isLocal && !!cost?.enabled && cost.trackExternalCosts;
  const showExtBill = !isLocal && billOn && cost!.billing.billExternalTokens;
  const priceKind = isLocal ? "deployment" : "external";
  const priceRef = isLocal ? (ctx.name ?? undefined) : ctx.externalId;   // deploy modes: ref known only after create
  const { price } = usePrice(priceKind, priceRef);
  const [depTime, setDepTime] = useState<TimePrice>(timeDraft(undefined));
  const [locTok, setLocTok] = useState<TokenPrice>(tokenDraft(undefined));
  const [extReal, setExtReal] = useState<TokenPrice>(tokenDraft(undefined));
  const [extBill, setExtBill] = useState<TokenPrice>(tokenDraft(undefined));
  useEffect(() => {
    setDepTime(timeDraft(price?.billing?.podTime));
    setLocTok(tokenDraft(price?.billing?.tokens));
    setExtReal(tokenDraft(price?.real?.tokens));
    setExtBill(tokenDraft(price?.billing?.tokens));
  }, [price]);

  const pool = pools.find((p) => p.name === poolRef);
  // On a same-pool edit the deployment's own max is already inside committed.
  const committed = (pool?.committed ?? 0) - (mode === "edit-local" && poolRef === ctx.poolRef ? (ctx.maxReplicas ?? 0) : 0);
  const budgetError = pool && pool.maxNodes > 0 && replicasValid && committed + nMax > pool.maxNodes
    ? `pool ${pool.name}: committed max replicas ${committed} + requested ${nMax} exceeds budget ${pool.maxNodes}`
    : null;

  const doSubmit = async (): Promise<string | null> => {
    const err =
      mode === "deploy-local" ? await submitJson("POST", "/v1/deployments", {
        name, catalogId: catalogId || ctx.catalogId, poolRef,
        replicas: { min: Number(minR) || 0, max: Number(maxR) || 0, reserve: Number(reserve) || 0,
          ...(Number(minR) === 0 ? { idleMinutes: Number(idleMin) || 15 } : {}) },
        ...(ctxTokens && !Number.isNaN(Number(ctxTokens)) ? { contextTokens: Number(ctxTokens) } : {}),
        ...(engine !== "auto" ? { engine } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        resources: { cpu: cpuReq, memory: memReq },
      })
      : mode === "deploy-remote" ? await submitJson("POST", "/v1/deployments/external", {
        name, provider, baseUrl: baseUrl || undefined, modelId, apiKey: apiKey || undefined,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        contextTokens: extContextNum,
      })
      : mode === "edit-local" ? await submitJson("PATCH", `/v1/deployments/${ctx.name}`, {
        replicas: { min: Number(minR) || 0, max: Number(maxR) || 0, reserve: Number(reserve) || 0,
          ...(Number(minR) === 0 ? { idleMinutes: Number(idleMin) || 15 } : {}) },
        ...(ctxTokens && !Number.isNaN(Number(ctxTokens)) ? { contextTokens: Number(ctxTokens) } : {}),
        ...(poolRef && poolRef !== ctx.poolRef ? { poolRef } : {}),
        ...(engine !== (ctx.engine ?? "auto") ? { engine } : {}),
        ...(reasoningEffort !== (ctx.reasoningEffort ?? "") ? { reasoningEffort: reasoningEffort || null } : {}),
        ...(resChanged ? { resources: { cpu: cpuReq, memory: memReq } } : {}),
      })
      : await submitJson("PATCH", `/v1/deployments/external/${ctx.externalId}`, {
        modelId: modelId || undefined, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined,
        reasoningEffort: reasoningEffort || null,
        contextTokens: extContextNum,
      });
    if (!err && (showDepTime || showLocalTok || showExtReal || showExtBill)) {
      let ref = priceRef;
      // deploy-remote: the new row has no id until after create — fetch it by
      // name from the merged list (external entries expose their row id as `id`, server.ts:346).
      if (!ref && !isLocal) {
        const j = await fetch("/api/v1/deployments", { headers: wsHeader() }).then((r) => r.json()).catch(() => null);
        ref = (j?.deployments ?? []).find((x: any) => x.name === name && x.kind === "external")?.id;
      }
      if (!ref && isLocal) ref = name;    // local deployments are keyed by name
      if (ref) {
        const edits = isLocal
          ? [
              { path: ["billing", "podTime"] as [string, string], value: timeOut(depTime), visible: showDepTime },
              { path: ["billing", "tokens"] as [string, string], value: tokenOut(locTok), visible: showLocalTok },
            ]
          : [
              { path: ["real", "tokens"] as [string, string], value: tokenOut(extReal), visible: showExtReal },
              { path: ["billing", "tokens"] as [string, string], value: tokenOut(extBill), visible: showExtBill },
            ];
        const prices = mergePriceDoc(price, edits);
        const priceErr = await savePrice(priceKind, ref, prices);
        if (priceErr) return priceErr;
      }
    }
    if (!err) { onClose(); router.refresh(); }
    return err;
  };

  // Restart-relevant diff — mirrors exactly what the PATCH body sends: an
  // unchanged contextTokens is not sent and must not warn.
  const ctxNum = ctxTokens && !Number.isNaN(Number(ctxTokens)) ? Number(ctxTokens) : undefined;
  const restartChanged = mode === "edit-local" && (
    resChanged ||
    (ctxNum !== undefined && ctxNum !== ctx.contextTokens) ||
    (!!poolRef && poolRef !== ctx.poolRef) ||
    engine !== (ctx.engine ?? "auto") ||
    reasoningEffort !== (ctx.reasoningEffort ?? ""));

  const submit = async () => {
    if (restartChanged) { setConfirmRestart(true); return; }
    setBusy(true); setError(null);
    const err = await doSubmit();
    setBusy(false);
    if (err) setError(err);
  };

  const test = async () => {
    setBusy(true); setProbe(null);
    try {
      const res = await fetch("/api/v1/deployments/external/test", {
        method: "POST", headers: { "Content-Type": "application/json", ...wsHeader() },
        body: JSON.stringify({ provider, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined,
                               modelId: modelId || undefined, reasoningEffort: reasoningEffort || undefined }),
      });
      const j = await res.json().catch(() => ({ ok: false, detail: `HTTP ${res.status}` }));
      setProbe(j.ok ? `✓ ${j.detail}` : `✗ ${j.detail ?? j.error}`);
    } catch (err) {
      setProbe(`✗ ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const title = mode === "deploy-local" ? "Deploy model"
    : mode === "deploy-remote" ? "Add remote endpoint" : `Edit ${ctx.name}`;
  const canSubmit = isEdit
    ? !busy && (isLocal ? (replicasValid && !budgetError && resValid) : extContextValid)
    : !busy && !!name && (isLocal
        ? (!!poolRef && replicasValid && !budgetError && resValid && !!(catalogId || ctx.catalogId))
        : (!!modelId && (provider !== "custom" || !!baseUrl) && extContextValid));

  if (confirmRestart) {
    // Idle with no replicas: there are no engine pods to restart — the spec
    // change lands immediately, pods pick it up on the next wake.
    return ctx.idle
      ? <ConfirmDialog title="Apply changes?" verb="Apply"
          message={`${ctx.name} is idle with no replicas — the changes apply when it wakes.${poolRef && poolRef !== ctx.poolRef ? " Moving pools re-provisions the model cache on the new nodes (weights re-download on wake)." : ""}`}
          onConfirm={doSubmit} onClose={() => setConfirmRestart(false)} />
      : <ConfirmDialog title="Restart engine pods?" verb="Restart"
          message={`This restarts ${ctx.name}'s engine pods.${poolRef && poolRef !== ctx.poolRef ? " Moving pools re-provisions the model cache on the new nodes (weights re-download)." : ""}`}
          onConfirm={doSubmit} onClose={() => setConfirmRestart(false)} />;
  }

  return (
    <Modal title={title} width="md" onClose={onClose} busy={busy} error={error}
      subtitle={isEdit ? `The name is immutable — it is the gateway model name.` : undefined}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={!canSubmit} onClick={submit}>{busy ? "Working…" : isEdit ? "Save" : "Deploy"}</button>
      </>}>
      {!isEdit && (
        <Field label="Name" required hint="lowercase letters, digits, dashes — becomes the gateway model name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-deployment" />
        </Field>
      )}
      {isLocal ? (<>
        {ctx.catalogPick && (
          <Field label="Model" required>
            <select value={catalogId} onChange={(e) => {
              const m = ctx.catalogPick!.find((x) => x.id === e.target.value);
              setCatalogId(e.target.value);
              setCtxDefault(m?.contextTokens);
              setReasonOpts(m?.reasoning?.efforts ?? null);
              setReasoningEffort("");
              setCpuReq(m?.resources?.cpu ?? "");
              setMemReq(m?.resources?.memory ?? "");
              setName(e.target.value.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, ""));
            }}>
              <option value="">— pick a model —</option>
              {[...ctx.catalogPick].sort((a, b) => a.displayName.localeCompare(b.displayName))
                .map((m) => <option key={m.id} value={m.id}>{m.displayName} ({m.id})</option>)}
              {catalogId && !ctx.catalogPick.some((m) => m.id === catalogId) &&
                <option value={catalogId}>{catalogId}</option>}
            </select>
          </Field>
        )}
        <Field label="Pool" required={mode === "deploy-local"}
               hint={mode === "deploy-local" && !pools.length ? "no pools yet — create one on the Pools page"
                     : mode === "edit-local" ? "changing the pool reschedules this deployment's pods onto the new pool's nodes"
                     : undefined}>
          <select value={poolRef} onChange={(e) => setPoolRef(e.target.value)}>
            {pools.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Replicas" hint="min 0 = scale-to-zero: sleeps after the idle window, wakes on the first request (~1-2 min); the scaler adds replicas on queued demand up to max">
          <span className="muted">min</span>
          <input style={{ width: 70, flex: "none" }} value={minR} onChange={(e) => setMinR(e.target.value)} />
          <span className="muted">max</span>
          <input style={{ width: 70, flex: "none" }} value={maxR} onChange={(e) => setMaxR(e.target.value)} />
          <span className="muted">reserve</span>
          <input style={{ width: 70, flex: "none" }} value={reserve} onChange={(e) => setReserve(e.target.value)} />
        </Field>
        {/* Always rendered — disabled rather than hidden, so editing min doesn't reflow the form. */}
        <Field label="Sleep after" hint="minutes with zero in-flight requests before scaling to zero (min 0 only)">
          <input style={{ width: 70, flex: "none" }} value={idleMin} disabled={nMin !== 0}
                 onChange={(e) => setIdleMin(e.target.value)} />
          <span className="muted">min idle</span>
        </Field>
        {!replicasValid && (minR || maxR || reserve || idleMin) !== "" && (
          <p className="modal-error" style={{ margin: "0 0 8px" }}>replicas: need 0 ≤ min ≤ max, max ≥ 1, 0 ≤ reserve ≤ max − min; idle window 1–1440 min</p>
        )}
        {budgetError && <p className="modal-error" style={{ margin: "0 0 8px" }}>{budgetError}</p>}
        <Field label="Resources" hint={mode === "edit-local"
            ? "per-replica requests — changing them restarts the engine pods"
            : "per-replica requests; prefilled from the catalog entry"}>
          <span className="muted">cpu</span>
          <input style={{ width: 70, flex: "none" }} value={cpuReq} onChange={(e) => setCpuReq(e.target.value)} />
          <span className="muted">memory</span>
          <input style={{ width: 90, flex: "none" }} value={memReq} onChange={(e) => setMemReq(e.target.value)} />
        </Field>
        {!resValid && (cpuReq || memReq) !== "" && (
          <p className="modal-error" style={{ margin: "0 0 8px" }}>resources: cpu like &quot;2&quot; or &quot;500m&quot;, memory like &quot;3Gi&quot;</p>
        )}
        <Field label="Context" hint={mode === "edit-local"
            ? "tokens — leave empty to keep the current value"
            : "tokens — leave empty for the catalog default"}>
          <input style={{ width: 170, flex: "none" }} value={ctxTokens}
                 onChange={(e) => setCtxTokens(e.target.value)}
                 placeholder={mode === "edit-local"
                   ? (ctx.contextTokens ? `${ctx.contextTokens} (current)` : "unchanged")
                   : ctxDefault ? `${ctxDefault} (catalog default)` : "engine default"} />
        </Field>
        <Field label="Engine" hint="SGLang requires a safetensors model and GPU nodes — pods will not start on the CPU-only dev cluster">
          <select value={engine} onChange={(e) => { setEngine(e.target.value); if (e.target.value === "sglang") setReasoningEffort(""); }} style={{ width: 190, flex: "none" }}>
            <option value="auto">auto (llama.cpp)</option>
            <option value="sglang">SGLang</option>
          </select>
        </Field>
        {reasonOpts && ["auto", "llama.cpp"].includes(engine) && (
          <Field label="Reasoning" hint={mode === "edit-local"
              ? "caps the model's thinking tokens — changing it restarts the engine pods"
              : "caps the model's thinking tokens; default = unlimited"}>
            <select value={reasoningEffort} onChange={(e) => setReasoningEffort(e.target.value)} style={{ width: 240, flex: "none" }}>
              <option value="">Model default (unlimited)</option>
              {Object.entries(reasonOpts).sort((a, b) => a[1] - b[1]).map(([k, v]) =>
                <option key={k} value={k}>{k} — {v === 0 ? "thinking off" : `${v} tokens`}</option>)}
            </select>
          </Field>
        )}
        {showDepTime && (
          <TimePriceField label="Billing / time" currency={cost!.currency} value={depTime} onChange={setDepTime}
            hint="charged per running replica (billing ledger); sums with token billing" />
        )}
        {showLocalTok && (
          <TokenPriceField label="Billing / tokens" currency={cost!.currency} value={locTok} onChange={setLocTok} />
        )}
      </>) : (<>
        {mode === "deploy-remote" && (
          <Field label="Provider" required>
            <select value={provider} onChange={(e) => { setProvider(e.target.value); setBaseUrl(""); setProbe(null); }}>
              {Object.entries(PRESETS).map(([v, p]) => <option key={v} value={v}>{p.label}</option>)}
            </select>
          </Field>
        )}
        <Field label="Model id" required hint={`what the provider serves, e.g. ${PRESETS[provider]?.hint}`}>
          <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder={PRESETS[provider]?.hint} />
        </Field>
        <Field label="Reasoning" hint="vendor-specific, e.g. low / high / xhigh — Test connection validates it">
          <input value={reasoningEffort} onChange={(e) => setReasoningEffort(e.target.value)}
                 placeholder="provider default" style={{ width: 190, flex: "none" }} />
        </Field>
        <Field label="Context tokens" required hint="model context window in tokens — feeds session auto-compaction">
          <input value={extContextTokens} onChange={(e) => setExtContextTokens(e.target.value)}
                 placeholder="262144" style={{ width: 190, flex: "none" }} />
        </Field>
        {!extContextValid && extContextTokens !== "" && (
          <p className="modal-error" style={{ margin: "0 0 8px" }}>context tokens: integer between 1024 and 2000000</p>
        )}
        <Field label="Base URL" required={provider === "custom"}
               hint={provider === "custom" ? "e.g. http://host.docker.internal:8081/v1"
                                           : `leave empty for the provider default (${PRESETS[provider]?.base})`}>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </Field>
        <Field label="API key" hint={isEdit ? "write-only — leave empty to keep the current key"
                                            : "write-only; optional for keyless local endpoints"}>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </Field>
        <Field label="Connection">
          <button className="ghost" disabled={busy} onClick={test}>Test connection</button>
          {probe && <span style={{ fontSize: 12, color: probe.startsWith("✓") ? "var(--good)" : "var(--accent)" }}>{probe}</span>}
        </Field>
        {showExtReal && (
          <TokenPriceField label="Real cost / tokens" currency={cost!.currency} value={extReal} onChange={setExtReal}
            hint="what the provider charges you — set the token count to match the vendor's pricing sheet" />
        )}
        {showExtBill && (
          <TokenPriceField label="Billing / tokens" currency={cost!.currency} value={extBill} onChange={setExtBill}
            hint="what consumers are charged — amount per token count, per direction" />
        )}
      </>)}
    </Modal>
  );
}

export function AddEndpointButton() {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}><Icon.deploy /> Add remote endpoint</button>
    {open && <DeployModal mode="deploy-remote" ctx={{}} onClose={() => setOpen(false)} />}
  </>);
}

/** Same dialog as DeployModelButton — the clicked model arrives preselected in the dropdown. */
export function DeployLocalButton({ catalogId, defaultName, contextTokens, reasoning, resources, small }:
  { catalogId: string; defaultName: string; contextTokens?: number;
    reasoning?: Record<string, number> | null; resources?: { cpu?: string; memory?: string } | null; small?: boolean }) {
  const [pick, setPick] = useState<any[] | null>(null);
  const slug = defaultName.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  const openIt = async () => {
    try {
      const r = await fetch("/api/v1/catalog?limit=1000", { headers: wsHeader() });
      const j = await r.json();
      setPick(j.models ?? []);
    } catch { setPick([]); }  // preselected model still submits via its fallback option
  };
  return (<>
    <button className={small ? "deploy-sm" : ""} onClick={openIt}><Icon.deploy /> Deploy</button>
    {pick && <DeployModal mode="deploy-local"
      ctx={{ catalogId, defaultName: slug, contextTokens, reasoningOptions: reasoning ?? null, resources: resources ?? null,
        catalogPick: pick.map((m: any) => ({ id: m.id, displayName: m.displayName, contextTokens: m.contextTokens, reasoning: m.reasoning ?? null, resources: m.resources ?? null })) }}
      onClose={() => setPick(null)} />}
  </>);
}

export function DeployModelButton() {
  const [models, setModels] = useState<any[] | null>(null);
  const openIt = async () => {
    try {
      const r = await fetch("/api/v1/catalog?limit=1000", { headers: wsHeader() });
      const j = await r.json();
      setModels(j.models ?? []);
    } catch { setModels([]); }
  };
  return (<>
    <button onClick={openIt}><Icon.deploy /> Deploy model</button>
    {models && <DeployModal mode="deploy-local"
      ctx={{ catalogPick: models.map((m: any) => ({ id: m.id, displayName: m.displayName, contextTokens: m.contextTokens, reasoning: m.reasoning ?? null, resources: m.resources ?? null })) }}
      onClose={() => setModels(null)} />}
  </>);
}

/** The deployment's name IS the edit affordance (console-wide pattern: click the name to open the resource). */
export function EditDeploymentName(props:
  | { kind: "local"; name: string; poolRef?: string; replicas?: { min: number; max: number }; engine?: string;
      contextTokens?: number | null; reasoningOptions?: Record<string, number> | null; reasoningEffort?: string | null;
      resources?: { cpu?: string; memory?: string } | null; idle?: boolean;
      asButton?: boolean }
  | { kind: "external"; name: string; externalId: string; provider?: string; baseUrl?: string | null;
      modelId?: string; reasoningEffort?: string | null; contextTokens?: number | null; asButton?: boolean }) {
  const [open, setOpen] = useState(false);
  const mode = props.kind === "local" ? "edit-local" : "edit-remote";
  const ctx: Ctx = props.kind === "local"
    ? { name: props.name, poolRef: props.poolRef, minReplicas: props.replicas?.min, maxReplicas: props.replicas?.max,
        reserveReplicas: (props.replicas as any)?.reserve, idleMinutes: (props.replicas as any)?.idleMinutes, engine: props.engine,
        contextTokens: props.contextTokens ?? undefined,
        reasoningOptions: props.reasoningOptions ?? null, reasoningEffort: props.reasoningEffort ?? null,
        resources: props.resources ?? null, idle: props.idle ?? false }
    : { name: props.name, externalId: props.externalId, provider: props.provider, baseUrl: props.baseUrl,
        modelId: props.modelId, reasoningEffort: props.reasoningEffort,
        extContextTokens: props.contextTokens ?? undefined };
  return (<>
    {props.asButton
      ? <button onClick={() => setOpen(true)}><Icon.deploy /> Edit deployment</button>
      : <button className="namebtn" title="Edit deployment" onClick={() => setOpen(true)}>{props.name}</button>}
    {open && <DeployModal mode={mode} ctx={ctx} onClose={() => setOpen(false)} />}
  </>);
}
