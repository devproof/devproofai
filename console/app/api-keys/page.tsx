import { wsGet, offsetOf } from "../lib/api";
import { CreateApiKey } from "./create";
import { DeleteButton } from "../lib/delete";
import { Pager } from "../lib/pager";
import { DateTime } from "../lib/datetime";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const offset = offsetOf((await searchParams).page);
  const { keys, count } = await wsGet<{ keys: any[]; count: number }>(`/v1/api-keys?offset=${offset}`).catch(() => ({ keys: [], count: 0 }));
  return (
    <>
      <div className="pagehead"><h1>API keys</h1><CreateApiKey /></div>
      <p className="sub">
        Keys are owned by this workspace. Point local tools (Claude Code, Codex, OpenAI SDKs) at the
        gateway with a key. The full key is shown only once at creation.
      </p>
      <div className="tablewrap"><table>
        <thead><tr><th>Key</th><th>Name</th><th>Status</th><th>Created</th><th>Last used</th><th></th></tr></thead>
        <tbody>
          {keys.map((k: any) => (
            <tr key={k.id}>
              <td><code>{k.partial_hint}</code></td>
              <td>{k.name}</td>
              <td><span className={`phase ${k.status === "active" ? "Ready" : "bad"}`}>{k.status}</span></td>
              <td><DateTime iso={k.created_at} /></td>
              <td>{k.last_used_at ? <DateTime iso={k.last_used_at} /> : "—"}</td>
              <td><DeleteButton path={`/v1/api-keys/${k.id}`} confirmText={`Delete API key "${k.name}"? Tools using it will stop working.`} /></td>
            </tr>
          ))}
          {keys.length === 0 && <tr><td colSpan={6} className="empty">No API keys yet.</td></tr>}
        </tbody>
      </table></div>
      <Pager count={count} />
    </>
  );
}
