import { wsGet } from "../lib/api";
import { DeleteButton } from "../lib/delete";
import { CreatePoolButton, EditPoolName } from "./pool-modal";

export const dynamic = "force-dynamic";

// The restart-confirm dialog lists a pool's deployments by name — one paged
// fetch would silently drop everything past the first page, so page through.
async function allDeployments(): Promise<any[]> {
  const rows: any[] = [];
  for (;;) {
    const { deployments, count } = await wsGet<{ deployments: any[]; count: number }>(
      `/v1/deployments?limit=1000&offset=${rows.length}`);
    rows.push(...deployments);
    if (rows.length >= count || deployments.length === 0) return rows;
  }
}

export default async function PoolsPage() {
  const settings = await wsGet<{ serving?: { localEnabled?: boolean } }>("/v1/settings").catch(() => null);
  if (settings?.serving?.localEnabled === false) return (
    <>
      <h1>Pools</h1>
      <p className="sub">Local serving is disabled on this installation.</p>
    </>
  );
  const [{ pools }, deployments] = await Promise.all([
    wsGet<{ pools: any[] }>("/v1/pools"),
    allDeployments(),
  ]);
  const users = (name: string) =>
    deployments.filter((d: any) => d.poolRef === name).map((d: any) => d.name as string);
  return (
    <>
      <div className="pagehead"><h1>Pools</h1><CreatePoolButton /></div>
      <p className="sub">
        Logical node pools map models onto physical nodes via Kubernetes node selectors.
        Deployments pick a pool; the pool's selector decides which nodes serve the pods.
      </p>
      <div className="tablewrap"><table>
        <thead><tr>
          <th>Name</th><th>Node selector</th><th>Tolerations</th><th>GPU type</th><th>GPUs/node</th>
          <th>Max nodes</th><th>Committed</th><th>In use</th><th></th>
        </tr></thead>
        <tbody>
          {pools.map((p: any) => {
            const sel = Object.entries(p.spec?.nodeSelector ?? {});
            return (
              <tr key={p.metadata.name}>
                <td><EditPoolName pool={p} deployments={users(p.metadata.name)} /></td>
                <td>{sel.length
                  ? `${sel.length} selector${sel.length === 1 ? "" : "s"}`
                  : <span className="muted">none</span>}</td>
                <td>{(p.spec?.tolerations ?? []).length
                  ? `${p.spec.tolerations.length} toleration${p.spec.tolerations.length === 1 ? "" : "s"}`
                  : <span className="muted">none</span>}</td>
                <td>{p.spec?.gpuType ?? "—"}</td>
                <td>{p.spec?.gpusPerNode ?? "—"}</td>
                <td>{p.spec?.maxNodes ? p.spec.maxNodes : "—"}</td>
                <td>{p.spec?.maxNodes ? `${p.committedMaxReplicas ?? 0} / ${p.spec.maxNodes}` : `${p.committedMaxReplicas ?? 0} / ∞`}</td>
                <td>{users(p.metadata.name).length} deployment(s)</td>
                <td><DeleteButton path={`/v1/pools/${p.metadata.name}`}
                      confirmText={`Delete pool "${p.metadata.name}"? Deployments still using it block deletion.`} /></td>
              </tr>
            );
          })}
          {pools.length === 0 && <tr><td colSpan={9} className="empty">No pools — create one to map models onto your nodes.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
