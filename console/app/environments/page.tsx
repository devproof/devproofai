import { CreateEnvironment, EditEnvironmentName } from "./create";
import { DeleteButton } from "../lib/delete";
import { wsGet, offsetOf } from "../lib/api";
import { Pager } from "../lib/pager";
import { DateTime } from "../lib/datetime";

export const dynamic = "force-dynamic";

export default async function EnvironmentsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const offset = offsetOf((await searchParams).page);
  const { environments, count } = await wsGet<{ environments: any[]; count: number }>(`/v1/environments?offset=${offset}`);
  return (
    <>
      <div className="pagehead"><h1>Environments</h1><CreateEnvironment /></div>
      <p className="sub">Configuration templates for session containers: network policy, package managers, and pod resources/disk.</p>
      <div className="tablewrap"><table>
        <thead><tr><th>ID</th><th>Name</th><th>Allowed hosts</th><th>Package managers</th><th>Requests</th><th>Last modified</th><th></th></tr></thead>
        <tbody>
          {environments.map((e: any) => (
            <tr key={e.id}>
              <td><EditEnvironmentName env={e} /></td>
              <td>{e.name}</td>
              <td>{(e.allowed_hosts ?? []).includes("*")
                ? <span className="phase Ready">all allowed</span>
                : (e.allowed_hosts ?? []).length
                  ? <span className="phase warn">{(e.allowed_hosts as string[]).length} host{(e.allowed_hosts as string[]).length === 1 ? "" : "s"}</span>
                  : <span className="phase bad">all blocked</span>}</td>
              <td><span className={`phase ${e.allow_package_managers ? "Ready" : "bad"}`}>
                {e.allow_package_managers ? "Enabled" : "Disabled"}</span></td>
              <td><code>{e.pod?.requests?.cpu ?? "250m"} / {e.pod?.requests?.memory ?? "512Mi"}</code></td>
              <td><DateTime iso={e.updated_at} /></td>
              <td><DeleteButton path={`/v1/environments/${e.id}`} confirmText={`Delete environment "${e.name}"?`} /></td>
            </tr>
          ))}
          {environments.length === 0 && <tr><td colSpan={7} className="empty">No environments yet.</td></tr>}
        </tbody>
      </table></div>
      <Pager count={count} />
      <p className="sub" style={{ marginTop: 14 }}>
        Egress is routed through the platform proxy: only listed hosts are reachable; enabling package
        managers additionally allows PyPI and npm registries. NetworkPolicy objects are created per
        environment (enforced on NetworkPolicy-capable CNIs).
      </p>
    </>
  );
}
