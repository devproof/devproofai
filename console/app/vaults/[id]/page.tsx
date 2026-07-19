import Link from "next/link";
import { wsGet } from "../../lib/api";
import { DeleteButton } from "../../lib/delete";
import { AddCredentialButton, RotateCredentialName } from "./credentials";
import { CopyId } from "../../lib/copy-id";

export const dynamic = "force-dynamic";

export default async function VaultDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { vault, credentials } = await wsGet<{ vault: any; credentials: { name: string; type: string; mcp_server_url?: string | null; mcp_server_name?: string | null; created_at: string }[] }>(`/v1/vaults/${id}`);
  if (!vault) return <p className="sub">Vault not found.</p>;
  return (
    <>
      <div className="crumbs"><Link href="/vaults">Vaults</Link> / <CopyId id={vault.id} /> · last modified {new Date(vault.updated_at).toLocaleString()}</div>
      <div className="pagehead">
        <h1>{vault.name}</h1>
        <div style={{ display: "flex", gap: 10 }}>
          <AddCredentialButton vaultId={vault.id} />
          <DeleteButton path={`/v1/vaults/${vault.id}`} redirect="/vaults" confirmText={`Delete vault "${vault.name}"?`} label="Delete vault" />
        </div>
      </div>
      <p className="sub">
        Typed credentials injected into every session that uses this vault — environment variables directly, MCP
        credentials as Authorization headers on matching servers. Values are write-only; click a name to rotate.
      </p>
      <div className="tablewrap" style={{ marginTop: 16 }}><table>
        <thead><tr><th>Credential</th><th>Type</th><th>MCP server</th><th>Added</th><th></th></tr></thead>
        <tbody>
          {credentials.map((c) => (
            <tr key={c.name}>
              <td><RotateCredentialName vaultId={vault.id} cred={c} /></td>
              <td>{c.type === "mcp_oauth" ? "MCP OAuth" : c.type === "bearer_token" ? "Bearer token" : "Env var"}</td>
              <td>{c.mcp_server_url ? <span className="muted">{c.mcp_server_url}</span> : "—"}</td>
              <td>{new Date(c.created_at).toLocaleString()}</td>
              <td><DeleteButton path={`/v1/vaults/${vault.id}/credentials/${encodeURIComponent(c.name)}`}
                    confirmText={`Remove credential "${c.name}"?`} label="Remove" /></td>
            </tr>
          ))}
          {credentials.length === 0 && <tr><td colSpan={5} className="empty">No credentials yet — add one with the button above.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
