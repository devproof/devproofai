"use client";
// Create + edit agents on one form. Edit saves a NEW immutable version
// (POST /v1/agents/:id/versions) — running sessions keep the version they started with.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "../lib/icons";
import { Modal, Field, submitJson } from "../lib/modal";
import { McpServerPicker, type McpServerPick } from "../lib/mcp-picker";

const DEFAULT_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch"];

// Prefilled (and editable) when a wiki is attached with write access, and when a
// wiki-writer agent is added as a subagent.
const WIKI_WRITER_PROMPT = "You maintain a knowledge wiki. Use the Bash and Write tools to actually create and edit files. Other agents will ask you to correct and update wiki entries. Look at them in a critical way and verify before updating.";
const WIKI_SUBAGENT_HINT = "Use this agent if you want to write new wiki entries, update or correct them.";

export function AgentFormModal({ mode, agentId, initial, environments, skills, vaults, models, agents, wikis, onClose }: {
  mode: "create" | "edit"; agentId?: string; initial?: any;
  environments: any[]; skills: any[]; vaults: any[]; models: string[]; agents: any[]; wikis: any[]; onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState(() => ({
    name: initial?.name ?? "",
    routing: initial?.routing ?? models[0] ?? "",
    systemPrompt: initial?.system_prompt ?? "",
    tools: ((initial?.tools as string[] | undefined) ?? DEFAULT_TOOLS).join(","),
    maxTurns: String(initial?.max_turns ?? 500),
    turnDeadlineSec: initial?.turn_deadline_sec != null ? String(initial.turn_deadline_sec) : "",
    environmentId: initial?.environment_id ?? "",
    vaultId: initial?.vault_id ?? "",
    skillIds: (initial?.skill_ids as string[] | undefined) ?? [],
    // {name, url, cfg}: cfg keeps raw-API extras (headers etc.) intact on save.
    mcp: Object.entries((initial?.mcp_servers as Record<string, any>) ?? {})
      .map(([name, cfg]) => ({ name, url: cfg?.url ?? "", cfg })),
    subagents: ((initial?.subagents as { agentId: string; instructions: string }[] | undefined) ?? []),
    wikiRefs: ((initial?.wiki_refs as { wikiId: string; mode: string }[] | undefined) ?? []),
  }));
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const staleWikiIds = f.wikiRefs.filter((r: any) => !wikis.some((w: any) => w.id === r.wikiId)).map((r: any) => r.wikiId);
  const agentWritesWiki = (id: string) =>
    (((agents.find((a: any) => a.id === id)?.wiki_refs as any[] | undefined) ?? []).some((r: any) => r?.mode === "write"));
  // A wiki already has a writer agent that isn't the one being edited → its
  // "write" option is hidden (one writer per wiki; server also enforces 409).
  const wikiOtherWriter = (id: string): string | null => {
    const w = wikis.find((x: any) => x.id === id);
    return w?.writer_agent_id && w.writer_agent_id !== agentId ? w.writer_agent_id : null;
  };
  const hasWriteWiki = f.wikiRefs.some((r: any) => r.mode === "write");
  const [pickerOpen, setPickerOpen] = useState(false);
  const toggleSkill = (id: string) =>
    set("skillIds", f.skillIds.includes(id) ? f.skillIds.filter((s: string) => s !== id) : [...f.skillIds, id]);
  // Ids pointing at since-deleted skills (e.g. skill removed + re-uploaded under
  // a new id): surfaced below and excluded from the save — the API 400s on them.
  const staleSkillIds = f.skillIds.filter((id: string) => !skills.some((s) => s.id === id));
  // Same idea for subagents: a target agent deleted out from under a saved
  // reference leaves a dangling agentId — surfaced below and excluded from the save.
  const staleSubagentIds = f.subagents
    .map((s: any) => s.agentId)
    .filter((id: string) => id && !agents.some((a: any) => a.id === id));

  const submit = async () => {
    const body = {
      routing: f.routing, systemPrompt: f.systemPrompt,
      tools: f.tools.split(",").map((t: string) => t.trim()).filter(Boolean),
      maxTurns: Number(f.maxTurns) || 500,
      turnDeadlineSeconds: Number(f.turnDeadlineSec) || undefined,
      environmentId: f.environmentId,
      vaultId: f.vaultId || undefined,
      skillIds: f.skillIds.filter((id: string) => skills.some((s) => s.id === id)),
      mcpServers: Object.fromEntries(f.mcp
        .filter((r: any) => r.name && r.url)
        .map((r: any) => [r.name, { ...(r.cfg ?? {}), type: r.cfg?.type ?? "http", url: r.url }])),
      subagents: f.subagents.filter((s: any) => s.agentId && s.instructions.trim() && agents.some((a: any) => a.id === s.agentId)),
      wikiRefs: f.wikiRefs.filter((r: any) => wikis.some((w: any) => w.id === r.wikiId)),
    };
    setBusy(true); setError(null);
    // Edit = rename (row metadata) + new config version, as separate calls —
    // a rename alone must not mint a version.
    if (mode === "edit" && f.name.trim() && f.name.trim() !== initial?.name) {
      const renameErr = await submitJson("PATCH", `/v1/agents/${agentId}`, { name: f.name.trim() });
      if (renameErr) { setBusy(false); setError(renameErr); return; }
    }
    const err = mode === "create"
      ? await submitJson("POST", "/v1/agents", { name: f.name, ...body })
      : await submitJson("POST", `/v1/agents/${agentId}/versions`, body);
    setBusy(false);
    if (err) setError(err); else { onClose(); router.refresh(); }
  };

  return (
    <Modal title={mode === "create" ? "Create agent" : `Edit ${initial?.name}`} width="lg"
      subtitle={mode === "edit" ? "Saving creates a new version; running sessions keep the version they started with." : undefined}
      onClose={onClose} busy={busy} error={error}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || !f.name.trim() || !f.routing || !f.environmentId} onClick={submit}>
          {busy ? "Saving…" : mode === "create" ? "Create agent" : "Save as new version"}
        </button>
      </>}>
      <Field label="Name" required>
        <input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="your-agent-name" />
      </Field>
      <Field label="Routing" required hint="requests route through the routing's rule table">
        <select value={f.routing} onChange={(e) => set("routing", e.target.value)}>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
          {f.routing && !models.includes(f.routing) && <option value={f.routing}>{f.routing} (missing routing)</option>}
        </select>
      </Field>
      <Field label="Max turns" hint="agent-loop iterations per message">
        <input style={{ width: 90, flex: "none" }} value={f.maxTurns} onChange={(e) => set("maxTurns", e.target.value)} />
      </Field>
      <Field label="Turn deadline" hint="seconds one turn may run before its pod is killed (empty = 7200)">
        <input style={{ width: 90, flex: "none" }} value={f.turnDeadlineSec} placeholder="7200"
               onChange={(e) => set("turnDeadlineSec", e.target.value)} />
      </Field>
      <Field label="System prompt" stack>
        <textarea rows={5} value={f.systemPrompt} onChange={(e) => set("systemPrompt", e.target.value)} placeholder="You are…" />
      </Field>
      <Field label="Tools" hint="comma-separated SDK tool names (python runs via Bash)">
        <input value={f.tools} onChange={(e) => set("tools", e.target.value)} />
      </Field>
      <Field label="Environment" required hint="egress, resources, and disk the sessions run under">
        <select value={f.environmentId} onChange={(e) => set("environmentId", e.target.value)}>
          <option value="" disabled>Select environment…</option>
          {environments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </Field>
      <Field label="Vault" hint="credentials injected into sessions">
        <select value={f.vaultId} onChange={(e) => set("vaultId", e.target.value)}>
          <option value="">No vault</option>
          {vaults.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </Field>
      <Field label="Skills" stack>
        {skills.length ? (
          <div className="checklist">
            {skills.map((s) => (
              <label key={s.id}>
                <input type="checkbox" checked={f.skillIds.includes(s.id)} onChange={() => toggleSkill(s.id)} />
                <span>{s.name} <span className="muted">v{s.version}</span></span>
              </label>
            ))}
          </div>
        ) : <span className="muted">no skills uploaded yet</span>}
        {staleSkillIds.length > 0 && (
          <div style={{ fontSize: 12, color: "var(--bad)" }}>
            {staleSkillIds.map((id: string) => (
              <div key={id}>⚠ <code>{id}</code> references a deleted skill — it will be removed on save</div>
            ))}
          </div>
        )}
      </Field>
      <Field label="MCP servers" stack
             hint="remote MCP servers the agent can call; attach a matching vault credential to authenticate">
        <div className="kvrows">
          {f.mcp.map((r: any, i: number) => (
            <div className="kvrow" key={r.name}>
              <span style={{ flex: 1 }}><strong>{r.name}</strong>{" "}
                <span className="muted" style={{ fontSize: 12 }}>{r.url}</span></span>
              <button className="iconbtn danger" title="Remove server" aria-label="Remove server"
                onClick={() => set("mcp", f.mcp.filter((_: any, j: number) => j !== i))}>✕</button>
            </div>
          ))}
          {pickerOpen
            ? <McpServerPicker value={null} onChange={(v: McpServerPick | null) => {
                if (v && !f.mcp.some((r: any) => r.name === v.name)) set("mcp", [...f.mcp, { name: v.name, url: v.url }]);
                setPickerOpen(false);
              }} />
            : <div><button className="ghost" onClick={() => setPickerOpen(true)}>+ Add MCP server</button></div>}
          {f.mcp.length > 0 && (() => {
            const env = environments.find((x) => x.id === f.environmentId);
            return env && !env.allow_mcp_servers
              ? <span className="muted" style={{ color: "#b58900" }}>
                  ⚠ this environment blocks MCP egress — enable "Allow MCP servers" on it</span>
              : null;
          })()}
        </div>
      </Field>
      <Field label="Subagents" stack
             hint="agents this agent can push work to; the instructions tell it when to delegate">
        <div className="kvrows">
          {f.subagents.map((s: any, i: number) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div className="kvrow">
                <select value={s.agentId} style={{ flex: 1, minWidth: 0 }}
                  onChange={(e) => {
                    const agentId = e.target.value;
                    const prefill = agentWritesWiki(agentId) ? WIKI_SUBAGENT_HINT : "";
                    setF((prev: any) => ({ ...prev, subagents: prev.subagents.map((x: any, j: number) =>
                      // Only fill an empty box, so a manual note is never overwritten.
                      j === i ? { ...x, agentId, instructions: x.instructions.trim() ? x.instructions : prefill } : x) }));
                  }}>
                  <option value="" disabled>Select agent…</option>
                  {agents
                    .filter((a: any) => a.id !== agentId && (a.status !== "disabled" || a.id === s.agentId)
                      && !f.subagents.some((x: any, j: number) => j !== i && x.agentId === a.id))
                    .map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <button className="iconbtn danger" title="Remove subagent" aria-label="Remove subagent"
                  onClick={() => set("subagents", f.subagents.filter((_: any, j: number) => j !== i))}>✕</button>
              </div>
              <textarea rows={3} placeholder="when to use this agent…" value={s.instructions}
                style={{ width: "100%" }}
                onChange={(e) => set("subagents", f.subagents.map((x: any, j: number) =>
                  j === i ? { ...x, instructions: e.target.value } : x))} />
            </div>
          ))}
          <div><button className="ghost"
            onClick={() => set("subagents", [...f.subagents, { agentId: "", instructions: "" }])}>
            + Add subagent</button></div>
        </div>
        {staleSubagentIds.length > 0 && (
          <div style={{ fontSize: 12, color: "var(--bad)" }}>
            {staleSubagentIds.map((id: string) => (
              <div key={id}>⚠ <code>{id}</code> references a deleted agent — it will be removed on save</div>
            ))}
          </div>
        )}
      </Field>
      <Field label="LLM wikis" stack
             hint="mount knowledge wikis at /mnt/wiki. read = read-only (any number of agents); write = sole maintainer (one agent per wiki; this agent then runs one session at a time). To report wiki errors, add the writer agent as a subagent above.">
        <div className="kvrows">
          {f.wikiRefs.map((r: any, i: number) => (
            <div className="kvrow" key={i}>
              <select value={r.wikiId} style={{ flex: 1, minWidth: 0 }}
                onChange={(e) => set("wikiRefs", f.wikiRefs.map((x: any, j: number) =>
                  j === i ? { ...x, wikiId: e.target.value } : x))}>
                <option value="" disabled>Select wiki…</option>
                {wikis
                  .filter((w: any) => w.id === r.wikiId || !f.wikiRefs.some((x: any, j: number) => j !== i && x.wikiId === w.id))
                  .map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
              <select value={r.mode} style={{ width: 100, flex: "none" }}
                onChange={(e) => {
                  const mode = e.target.value;
                  setF((prev: any) => {
                    const wikiRefs = prev.wikiRefs.map((x: any, j: number) => (j === i ? { ...x, mode } : x));
                    // Prefill the maintainer prompt when write is chosen (once) — still editable.
                    const addPrompt = mode === "write" && !prev.systemPrompt.includes(WIKI_WRITER_PROMPT);
                    const systemPrompt = addPrompt
                      ? (prev.systemPrompt.trim() ? prev.systemPrompt.replace(/\s+$/, "") + "\n\n" + WIKI_WRITER_PROMPT : WIKI_WRITER_PROMPT)
                      : prev.systemPrompt;
                    return { ...prev, wikiRefs, systemPrompt };
                  });
                }}>
                <option value="read">read</option>
                {(!wikiOtherWriter(r.wikiId) || r.mode === "write") && <option value="write">write</option>}
              </select>
              <button className="iconbtn danger" title="Remove wiki" aria-label="Remove wiki"
                onClick={() => set("wikiRefs", f.wikiRefs.filter((_: any, j: number) => j !== i))}>✕</button>
            </div>
          ))}
          <div><button className="ghost" disabled={!wikis.length}
            onClick={() => set("wikiRefs", [...f.wikiRefs, { wikiId: "", mode: "read" }])}>
            {wikis.length ? "+ Add wiki" : "no wikis created yet"}</button></div>
        </div>
        {hasWriteWiki && (
          <div style={{ fontSize: 12, color: "#b58900" }}>
            ⚠ As a wiki writer, this agent runs only ONE session at a time — additional sessions are queued and run one by one (so wiki writes never conflict).
          </div>
        )}
        {staleWikiIds.length > 0 && (
          <div style={{ fontSize: 12, color: "var(--bad)" }}>
            {staleWikiIds.map((id: string) => (
              <div key={id}>⚠ <code>{id}</code> references a deleted wiki — it will be removed on save</div>
            ))}
          </div>
        )}
      </Field>
    </Modal>
  );
}

export function CreateAgentButton(props: { environments: any[]; skills: any[]; vaults: any[]; models: string[]; agents: any[]; wikis: any[] }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}>+ Create agent</button>
    {open && <AgentFormModal mode="create" {...props} onClose={() => setOpen(false)} />}
  </>);
}

export function EditAgentButton({ agent, ...props }: { agent: any; environments: any[]; skills: any[]; vaults: any[]; models: string[]; agents: any[]; wikis: any[] }) {
  const [open, setOpen] = useState(false);
  const latest = agent.versions[0]; // versions are ordered DESC — [0] is the newest
  return (<>
    <button onClick={() => setOpen(true)}><Icon.edit /> Edit agent</button>
    {open && <AgentFormModal mode="edit" agentId={agent.id}
      initial={{ ...latest, name: agent.name }} {...props} onClose={() => setOpen(false)} />}
  </>);
}
