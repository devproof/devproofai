import { wsGet } from "../lib/api";
import { WorkspaceRowActions, WorkspaceIdButton, NewWorkspaceButton, DeletionCell } from "./actions";
import { DateTime } from "../lib/datetime";

export const dynamic = "force-dynamic";

export default async function WorkspacesPage() {
  const { workspaces } = await wsGet<{ workspaces: any[] }>("/v1/workspaces")
    .catch(() => ({ workspaces: [] as any[] }));
  return (
    <>
      <div className="pagehead"><h1>Workspaces</h1><NewWorkspaceButton /></div>
      <p className="sub">
        Every resource is scoped to a workspace. Disabling makes a workspace read-only (running
        sessions still complete); deleting removes all its resources — usage history stays
        attributed to the workspace name and id.
      </p>
      <div className="tablewrap"><table>
        <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Created</th><th></th></tr></thead>
        <tbody>
          {workspaces.map((w: any) => (
            <tr key={w.id}>
              <td><WorkspaceIdButton ws={w} /></td>
              <td>{w.name}</td>
              <td>
                {w.status === "deleting" ? (
                  <DeletionCell id={w.id} />
                ) : (
                  <span className={`phase ${w.status === "active" ? "Ready" : "bad"}`}>{w.status}</span>
                )}
              </td>
              <td><DateTime iso={w.created_at} /></td>
              <td><WorkspaceRowActions ws={w} /></td>
            </tr>
          ))}
          {workspaces.length === 0 && <tr><td colSpan={5} className="empty">No workspaces.</td></tr>}
        </tbody>
      </table></div>
      <div className="pager">
        <span className="pager-info">{workspaces.length.toLocaleString()} item{workspaces.length === 1 ? "" : "s"}</span>
      </div>
    </>
  );
}
