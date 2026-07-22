import Link from "next/link";
// Rendered by notFound() calls (e.g. a session id that exists in another
// workspace) — sibling of error.tsx, which keeps the CP-unreachable copy.

export default function NotFound() {
  return (
    <>
      <div className="pagehead"><h1>Not found</h1></div>
      <p className="sub">
        This resource doesn&rsquo;t exist — or it belongs to a different
        workspace than the one you&rsquo;re currently viewing.
      </p>
      <div className="empty"><Link href="/">Go to the dashboard</Link></div>
    </>
  );
}
