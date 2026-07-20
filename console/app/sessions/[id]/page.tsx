import Link from "next/link";
import { SessionView } from "./trace";
import { wsGet } from "../../lib/api";
import { CopyId } from "../../lib/copy-id";
import { DateTime } from "../../lib/datetime";

export const dynamic = "force-dynamic";

export default async function SessionDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [session, { events }, resources, settings] = await Promise.all([
    wsGet<any>(`/v1/sessions/${id}`),
    wsGet<{ events: any[] }>(`/v1/sessions/${id}/events`),
    wsGet<any>(`/v1/sessions/${id}/resources`).catch(() => null),
    wsGet<{ costs: any }>("/v1/settings").catch(() => null),
  ]);
  const cost = settings?.costs?.billing?.enabled && settings.costs.billing?.showSessionCosts
    ? { show: true, currency: settings.costs.currency as string } : null;
  const parent = session.parent_session_id
    ? await wsGet<any>(`/v1/sessions/${session.parent_session_id}`).catch(() => null)
    : null;
  return (
    <>
      <div className="crumbs"><Link href="/sessions">Sessions</Link> / <CopyId id={session.id} /> · last activity <DateTime iso={session.updated_at} />
      {session.parent_session_id && <> · spawned by{" "}
        {parent
          ? <Link href={`/sessions/${session.parent_session_id}`}><code>{session.parent_session_id}</code></Link>
          : <code>{session.parent_session_id}</code>}</>}</div>
      <SessionView session={session} resources={resources} initialEvents={events} cost={cost} />
    </>
  );
}
