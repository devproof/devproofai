"use client";
// Screenshot-style session header: name + status + clickable meta chips.
import { Icon } from "../../lib/icons";
import { DeleteButton } from "../../lib/delete";
import type { Totals } from "./use-session-live";
import { offsetLabel } from "./rows";
import { fmtCost } from "../../lib/currency";

export type PanelId = "agent" | "env" | "files" | "outputs" | "memory" | null;

export function SessionHeader({ sessionId, name, status, live, totals, durationMs, resources, onOpen, cost }: {
  sessionId: string; name: string; status: string; live: boolean; totals: Totals; durationMs: number;
  resources: any; onOpen: (p: Exclude<PanelId, null>) => void;
  cost?: { show: boolean; currency: string } | null;
}) {
  const r = resources;
  const files = r?.inputFiles?.length ?? 0;
  const outputs = r?.outputFiles?.length ?? 0;
  const statusClass = ["completed", "idle"].includes(status) ? "Ready" : status === "failed" ? "Failed" : "Deploying";
  return (
    <div className="sv-titlebar">
      <div className="sv-title">
        <h1 style={{ fontSize: 24 }}>{name}</h1>
        <span className={`phase ${statusClass}`}>{status}{live && <span className="pulse" />}</span>
        <div style={{ marginLeft: "auto" }}>
          <DeleteButton path={`/v1/sessions/${sessionId}`} redirect="/sessions"
                        confirmText={`Delete session "${name}" and its transcript?`} label="Delete session" />
        </div>
      </div>
      <div className="metachips">
        {r?.agent && (
          <button className="chipbtn" onClick={() => onOpen("agent")}>
            <Icon.agent /> {r.agent.name} <span className="muted">v{r.agent.version}</span>
          </button>
        )}
        <button className="chipbtn" onClick={() => onOpen("env")}>
          <Icon.env /> {r?.environment?.name ?? "default environment"}
        </button>
        <button className="chipbtn" onClick={() => onOpen("memory")}>
          <Icon.memory /> {r?.memory ? 1 : 0} memory
        </button>
        <button className="chipbtn" onClick={() => onOpen("files")}>
          <Icon.file /> {files} file{files === 1 ? "" : "s"}
        </button>
        <button className="chipbtn" onClick={() => onOpen("outputs")}>
          <Icon.download /> {outputs} output{outputs === 1 ? "" : "s"}
        </button>
        <span className="chip">{offsetLabel(durationMs)}</span>
        {/* keyed remount restarts the one-shot blink on every totals change;
            static renders of finished sessions must not blink on load */}
        <span className={live ? "chip tok-tick" : "chip"} key={`${totals.tokensIn}/${totals.tokensOut}`}>
          {totals.tokensIn.toLocaleString()} / {totals.tokensOut.toLocaleString()} tok
        </span>
        {cost?.show && (
          <span className={live ? "chip tok-tick" : "chip"} key={`c${totals.billedCost}`}
                title="billed cost (tokens + session time)">
            {fmtCost(totals.billedCost, cost.currency)}
          </span>
        )}
        {totals.lastModel && (
          <span className={live ? "chip tok-tick" : "chip"} key={`m${totals.lastModel}`}
                title="last deployment this session's turns resolved to">
            <Icon.deploy /> {totals.lastModel}
          </span>
        )}
      </div>
    </div>
  );
}
