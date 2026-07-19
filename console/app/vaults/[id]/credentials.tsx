"use client";
// Typed add/rotate credential dialog (spec 2026-07-13, mirrors the Anthropic
// mockups): Environment variable / Bearer token / MCP OAuth (token storage —
// no Connect flow yet). Values are write-only.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal, Field, submitJson } from "../../lib/modal";
import { McpServerPicker, type McpServerPick } from "../../lib/mcp-picker";

const TYPES = [
  { id: "environment_variable", label: "Environment variable" },
  { id: "bearer_token", label: "Bearer token" },
  { id: "mcp_oauth", label: "MCP OAuth" },
];

// Mirror control-plane/src/mcp.ts — the server rejects anything else.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CRED_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export interface CredRow { name: string; type: string; mcp_server_url?: string | null; mcp_server_name?: string | null }

function CredentialModal({ vaultId, existing, onClose }: {
  vaultId: string; existing?: CredRow; onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState(existing?.type ?? "environment_variable");
  const [name, setName] = useState(existing?.name ?? "");
  const [server, setServer] = useState<McpServerPick | null>(existing?.mcp_server_url
    ? { name: existing.mcp_server_name ?? existing.name, url: existing.mcp_server_url } : null);
  // Last auto-filled name: picking a server prefills Name, but never
  // clobbers a name the user typed themselves.
  const [autoName, setAutoName] = useState<string | null>(null);
  const pickServer = (s: McpServerPick | null) => {
    setServer(s);
    if (s && (!name.trim() || name.trim() === autoName)) { setName(s.name); setAutoName(s.name); }
  };
  const [value, setValue] = useState("");        // env value | bearer token | oauth access token
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const locked = !!existing;                     // rotate: name/type/server frozen
  const isMcp = type !== "environment_variable";
  const ready = !!value && (isMcp
    ? !!server && CRED_NAME_RE.test(name.trim())
    : ENV_NAME_RE.test(name));

  const submit = async () => {
    const body: any = { type };
    if (isMcp) {
      body.mcpServerUrl = server!.url;
      body.mcpServerName = server!.name;
      body.name = name.trim();
      if (type === "bearer_token") body.token = value; else body.accessToken = value;
      if (type === "mcp_oauth" && clientId.trim()) body.clientId = clientId.trim();
      if (type === "mcp_oauth" && clientSecret) body.clientSecret = clientSecret;
    } else {
      body.name = name.trim();
      body.value = value;
    }
    setBusy(true); setError(null);
    const err = await submitJson("POST", `/v1/vaults/${vaultId}/credentials`, body);
    setBusy(false);
    if (err) setError(err); else { onClose(); router.refresh(); }
  };

  return (
    <Modal title={existing ? `Rotate credential — ${existing.name}` : "Add credential"} width="md"
      subtitle="Add a credential to this vault for agents to use. Values are write-only."
      onClose={onClose} busy={busy} error={error}
      footer={<>
        <button className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || !ready} onClick={submit}>
          {busy ? "Saving…" : existing ? "Rotate credential" : "Add credential"}
        </button>
      </>}>
      <Field label="Type" required>
        <select value={type} disabled={locked} onChange={(e) => { setType(e.target.value); setValue(""); }}>
          {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </Field>
      <Field label={isMcp ? "Name" : "Variable name"} required
             hint={isMcp ? "prefilled from the MCP server — used to derive the credential's secret keys" : "injected into session pods under this name"}>
        <input value={name} disabled={locked} placeholder={isMcp ? undefined : "MY_API_KEY"}
               onChange={(e) => setName(e.target.value)} />
      </Field>
      {isMcp && (
        <Field label="MCP server" required>
          <McpServerPicker value={server} onChange={pickServer} disabled={locked} />
        </Field>
      )}
      <Field label={type === "mcp_oauth" ? "Access token" : type === "bearer_token" ? "Token" : "Value"} required>
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      {type === "mcp_oauth" && (
        <Field label="OAuth client" hint="optional — stored for the future Connect flow; empty on rotate = keep existing">
          <input placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} />
          <input type="password" placeholder="Client secret" value={clientSecret}
                 onChange={(e) => setClientSecret(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}

export function AddCredentialButton({ vaultId }: { vaultId: string }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}>+ Add credential</button>
    {open && <CredentialModal vaultId={vaultId} onClose={() => setOpen(false)} />}
  </>);
}

/** Clicking a credential's name opens rotate (name/type/server locked). */
export function RotateCredentialName({ vaultId, cred }: { vaultId: string; cred: CredRow }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button className="namebtn" style={{ fontFamily: "var(--font-mono)" }} title="Rotate credential"
            onClick={() => setOpen(true)}>{cred.name}</button>
    {open && <CredentialModal vaultId={vaultId} existing={cred} onClose={() => setOpen(false)} />}
  </>);
}
