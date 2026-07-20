"use client";

import Link from "next/link";
import { useState } from "react";
import { Pager } from "../../lib/pager";
import { DateTime } from "../../lib/datetime";

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

export function AgentTabs({ agent, observability, sessions, sessionCount = 0, initialTab = "agent",
                            skills = [], environments = [], vaults = [], routingWindows = {}, agents = [], wikis = [] }:
  { agent: any; observability: any; sessions: any[]; sessionCount?: number;
    initialTab?: "agent" | "sessions" | "obs"; skills?: any[]; environments?: any[]; vaults?: any[];
    routingWindows?: Record<string, number | null>; agents?: any[]; wikis?: any[] }) {
  const [tab, setTab] = useState<"agent" | "sessions" | "obs">(initialTab);
  const [vi, setVi] = useState(0);
  const v = agent.versions[vi];
  const skillOf = (id: string) => skills.find((s) => s.id === id);
  const envName = (id: string) => environments.find((e) => e.id === id)?.name ?? id;
  const vaultName = (id: string) => vaults.find((x) => x.id === id)?.name ?? id;
  const agentName = (id: string) => agents.find((a: any) => a.id === id)?.name ?? id;
  const agentWritesWiki = (id: string) =>
    (((agents.find((a: any) => a.id === id)?.wiki_refs as any[] | undefined) ?? []).some((r: any) => r?.mode === "write"));
  const wikiName = (id: string) => wikis.find((w: any) => w.id === id)?.name ?? id;
  const wikiRefs: { wikiId: string; mode: string }[] = v.wiki_refs ?? [];
  const isWriter = wikiRefs.some((r) => r.mode === "write");
  const mcpEntries: [string, any][] = v.mcp_servers ? Object.entries(v.mcp_servers) : [];
  return (
    <>
      <div className="tabs">
        <button className={tab === "agent" ? "active" : ""} onClick={() => setTab("agent")}>Agent</button>
        <button className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}>Sessions</button>
        <button className={tab === "obs" ? "active" : ""} onClick={() => setTab("obs")}>Observability</button>
      </div>

      {tab === "agent" && (
        <>
          <div className="formrow">
            <select value={vi} onChange={(e) => setVi(Number(e.target.value))}>
              {agent.versions.map((x: any, i: number) => (
                <option key={x.version} value={i}>Version: v{x.version}</option>
              ))}
            </select>
            {isWriter && <span className="badge-writer" title="Writes an LLM wiki — runs one session at a time">Wiki Writer</span>}
            <span className="chip">routing <code>{v.routing}</code></span>
            <span className="chip">max turns {v.max_turns}</span>
            {v.turn_deadline_sec != null && <span className="chip">turn deadline {v.turn_deadline_sec}s</span>}
            {routingWindows[v.routing] != null &&
              <span className="chip">ctx {routingWindows[v.routing]!.toLocaleString()} tok</span>}
            {v.environment_id && <span className="chip">env {envName(v.environment_id)}</span>}
            {v.vault_id && <span className="chip">vault {vaultName(v.vault_id)}</span>}
          </div>
          <div className="card" style={{ marginBottom: 14 }}>
            <h3>Tools ({(v.tools ?? []).length})</h3>
            <div>{(v.tools ?? []).length
              ? v.tools.map((t: string) => <span className="chip" key={t} style={{ marginRight: 6 }}>{t}</span>)
              : <span className="muted">no tools</span>}</div>
          </div>
          <div className="card" style={{ marginBottom: 14 }}>
            <h3>Skills ({(v.skill_ids ?? []).length})</h3>
            <div>{(v.skill_ids?.length ?? 0)
              ? v.skill_ids.map((s: string) => {
                  const skill = skillOf(s);
                  return skill
                    ? <span className="chip" key={s} style={{ marginRight: 6 }}>{skill.name}</span>
                    : <span className="chip missing" key={s} style={{ marginRight: 6 }}
                        title="This skill was deleted — sessions on this version run without it.">
                        <code>{s}</code> deleted</span>;
                })
              : <span className="muted">no skills</span>}</div>
          </div>
          {mcpEntries.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <h3>MCP servers ({mcpEntries.length})</h3>
              <div>{mcpEntries.map(([m, cfg]) => (
                <span className="chip" key={m} style={{ marginRight: 6 }} title={cfg?.url}>
                  {m} <span className="muted">{cfg?.url}</span>
                </span>
              ))}</div>
            </div>
          )}
          {(v.subagents ?? []).length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <h3>Subagents ({v.subagents.length})</h3>
              <div>{v.subagents.map((s: any) => (
                <span className="chip" key={s.agentId} style={{ marginRight: 6 }} title={s.instructions}>
                  <Link href={`/agents/${s.agentId}`}><code>{s.agentId}</code></Link>{" "}
                  {agentName(s.agentId)}
                  {agentWritesWiki(s.agentId) && <span className="badge-writer">Wiki Writer</span>}{" "}
                  <span className="muted">{s.instructions}</span>
                </span>
              ))}</div>
            </div>
          )}
          {wikiRefs.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <h3>LLM wikis ({wikiRefs.length})</h3>
              <div>{wikiRefs.map((r) => (
                <span className="chip" key={r.wikiId} style={{ marginRight: 6 }}>
                  <Link href={`/wikis/${r.wikiId}`}>{wikiName(r.wikiId)}</Link>{" "}
                  <span className={r.mode === "write" ? "badge-writer" : "muted"}>{r.mode}</span>
                </span>
              ))}</div>
            </div>
          )}
          <div className="card"><h3>System prompt</h3>
            <pre className="block" style={{ border: 0, padding: 0 }}>{v.system_prompt || "—"}</pre></div>
        </>
      )}

      {tab === "sessions" && (
        <>
        <div className="tablewrap"><table>
          <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Version</th><th>Tokens in / out</th><th>Last activity</th></tr></thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td><Link href={`/sessions/${s.id}`}><code>{s.id}</code></Link></td>
                <td>{s.name ?? "—"}</td>
                <td><span className={`phase ${["completed", "idle"].includes(s.status) ? "Ready" : s.status === "failed" ? "Failed" : "Deploying"}`}>{s.status}</span></td>
                <td><span className="phase ver">v{s.agent_version}</span></td>
                <td>{fmt(Number(s.tokens_in))} / {fmt(Number(s.tokens_out))}</td>
                <td><DateTime iso={s.updated_at} /></td>
              </tr>
            ))}
            {sessions.length === 0 && <tr><td colSpan={6} className="empty">No sessions for this agent.</td></tr>}
          </tbody>
        </table></div>
        <Pager count={sessionCount} />
        </>
      )}

      {tab === "obs" && (
        <>
          <div className="cards">
            <div className="card"><h3>Sessions</h3><div className="big">{observability.sessions}</div></div>
            <div className="card"><h3>Error rate</h3>
              <div className="big">{(observability.errorRate * 100).toFixed(0)}%</div></div>
            <div className="card"><h3>Total input tokens</h3><div className="big">{fmt(observability.tokensIn)}</div></div>
            <div className="card"><h3>Total output tokens</h3><div className="big">{fmt(observability.tokensOut)}</div></div>
          </div>
          <div className="cards">
            <div className="card"><h3>Turns / session</h3>
              <div className="big">{observability.p50Turns}</div><div className="hint">p50 · p95 {observability.p95Turns}</div></div>
            <div className="card"><h3>Input tokens / session</h3>
              <div className="big">{fmt(observability.p50TokensIn)}</div><div className="hint">p50 · p95 {fmt(observability.p95TokensIn)}</div></div>
            <div className="card"><h3>Active time / session</h3>
              <div className="big">{observability.p50DurationS.toFixed(1)}s</div><div className="hint">p50</div></div>
          </div>
          <div className="tablewrap"><table>
            <thead><tr><th>Tool</th><th>Calls</th></tr></thead>
            <tbody>
              {observability.toolUsage.map((t: any) => (
                <tr key={t.tool}><td><code>{t.tool}</code></td><td>{t.calls}</td></tr>
              ))}
              {observability.toolUsage.length === 0 && <tr><td colSpan={2} className="empty">No tool calls yet.</td></tr>}
            </tbody>
          </table></div>
        </>
      )}
    </>
  );
}
