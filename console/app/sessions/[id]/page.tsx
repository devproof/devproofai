import Link from "next/link";
import { notFound } from "next/navigation";
import { SessionView } from "./trace";
import { wsGet } from "../../lib/api";
import { CopyId } from "../../lib/copy-id";
import { DateTime } from "../../lib/datetime";

export const dynamic = "force-dynamic";

// A 404 here is "no such session in THIS workspace" — render the not-found
// page, not the error boundary (whose copy blames an unreachable CP).
const or404 = (e: any): never => { if (e?.status === 404) notFound(); throw e; };

export default async function SessionDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [session, { events }, resources, settings] = await Promise.all([
    wsGet<any>(`/v1/sessions/${id}`).catch(or404),
    wsGet<{ events: any[] }>(`/v1/sessions/${id}/events`).catch(or404),
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
