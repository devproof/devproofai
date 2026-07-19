"use client";
// Deployment detail (spec 2026-07-10; Connect moved to routings 2026-07-16;
// Stats merged into Overview, gateway-endpoint card moved to routing Connect, fix wave J): Overview | Trace.
import { useState } from "react";
import { EditDeploymentName } from "../deploy-modal";
import { StatsTab } from "./stats";
import { TraceTab } from "./trace";
import { phaseBadge } from "../phase";

export function DeploymentTabs({ d, keys, agents }:
  { d: any; keys: { id: string; name: string }[]; agents: { id: string; name: string }[] }) {
  const [tab, setTab] = useState<"overview" | "trace">("overview");
  const { label: phaseLabel, cls: phaseCls } = phaseBadge(d.phase, d.activity);
  return (
    <>
      <div className="pagehead">
        <h1>{d.name} <span className={`phase ${phaseCls}`} style={{ marginLeft: 10, verticalAlign: "middle" }}>{phaseLabel}</span></h1>
        {d.kind === "external"
          ? <EditDeploymentName asButton kind="external" name={d.name} externalId={d.id}
              provider={d.provider} baseUrl={d.baseUrl ?? null} modelId={d.modelId}
              reasoningEffort={d.reasoningEffort ?? null} contextTokens={d.contextTokens ?? null} />
          : <EditDeploymentName asButton kind="local" name={d.name} poolRef={d.poolRef}
              replicas={d.replicas ?? undefined} engine={d.engine}
              contextTokens={d.contextTokens ?? undefined}
              reasoningOptions={d.reasoningOptions ?? null} reasoningEffort={d.reasoning?.effort ?? null}
              resources={d.resources ?? null}
              idle={d.phase === "Idle" && !d.activity && !d.readyReplicas} />}
      </div>
      {d.phase === "Idle" && !d.activity && <p className="sub" style={{ marginTop: 4 }}>sleeping — wakes on the first request (~1–2 min)</p>}
      <p className="sub">{d.kind === "external"
        ? `Remote endpoint — ${d.provider}/${d.modelId}`
        : `Local model serving through the gateway — catalog ${d.catalogId ?? "—"}`}</p>

      <div className="tabs">
        <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>Overview</button>
        <button className={tab === "trace" ? "active" : ""} onClick={() => setTab("trace")}>Trace</button>
      </div>

      {tab === "overview" && d.kind === "local" && (
        <p className="sub" style={{ marginTop: 0 }}>
          The first request with a new prompt pays full prompt processing (prefill) on the serving
          hardware; repeated prefixes are served from the prompt cache. Deployments are warmed once
          when they become ready — a slow first call is prefill, not lazy loading.
        </p>
      )}
      {tab === "overview" && (
        <div className="cards">
          <div className="card"><h3>Serving</h3>
            <div className="row"><span className="muted">Kind</span><span>{d.kind}</span></div>
            {d.kind === "local" && <>
              <div className="row"><span className="muted">Pool</span><span>{d.poolRef ?? "—"}</span></div>
              <div className="row"><span className="muted">Engine</span><span>{d.engine ?? "auto"}</span></div>
              {(d.reasoning || d.reasoningOptions) && (
                <div className="row"><span className="muted">Reasoning</span>
                  <span>{d.reasoning
                    ? `${d.reasoning.effort} · ${d.reasoning.budgetTokens === 0 ? "thinking off" : `${d.reasoning.budgetTokens} tokens`}`
                    : "model default"}</span></div>
              )}
              <div className="row"><span className="muted">Context</span>
                <span>{d.effectiveContextTokens
                  ? `${d.effectiveContextTokens.toLocaleString()} tokens${
                      d.contextTokens && d.contextTokens > d.effectiveContextTokens
                        ? ` · capped from ${d.contextTokens.toLocaleString()}` : ""}`
                  : d.contextTokens ? `${d.contextTokens.toLocaleString()} tokens` : "engine default"}</span></div>
              <div className="row"><span className="muted">Replicas</span>
                <span>{d.readyReplicas} ready{d.replicas ? ` · ${d.replicas.min}–${d.replicas.max}` : ""}</span></div>
              <div className="row"><span className="muted">Download</span>
                <span>{d.downloadPercent != null ? `${d.downloadPercent}%` : "—"}</span></div>
            </>}
            {d.kind === "external" && <>
              <div className="row"><span className="muted">Provider</span><span>{d.provider}</span></div>
              <div className="row"><span className="muted">Model</span><code>{d.modelId}</code></div>
              {d.reasoningEffort && (
                <div className="row"><span className="muted">Reasoning</span><span>{d.reasoningEffort}</span></div>
              )}
              <div className="row"><span className="muted">Context</span>
                <span>{d.contextTokens ? `${d.contextTokens.toLocaleString()} tokens` : "—"}</span></div>
            </>}
          </div>
          <div className="card"><h3>Live</h3>
            <div className="row"><span className="muted">Tokens/sec</span>
              <span>{d.tokensPerSec != null ? d.tokensPerSec.toFixed(1) : "—"}</span></div>
            <div className="row"><span className="muted">Req queue</span>
              <span>{d.queueDepth != null ? d.queueDepth : "—"}</span></div>
          </div>
          <div className="card"><h3>{d.kind === "external" ? "Target endpoint" : "Engine endpoint"}</h3>
            <code style={{ fontSize: 11.5, wordBreak: "break-all" }}>
              {d.kind === "external" ? (d.baseUrl ?? "provider default") : (d.endpoint ?? "—")}
            </code>
            <div className="hint" style={{ marginTop: 6 }}>
              {d.kind === "external"
                ? "where the gateway forwards this model's requests"
                : "cluster-internal engine service — clients call the gateway instead"}
            </div>
          </div>
        </div>
      )}
      {tab === "overview" && <StatsTab name={d.name} keys={keys} agents={agents} />}
      {tab === "trace" && <TraceTab name={d.name} keys={keys} agents={agents} />}
    </>
  );
}
