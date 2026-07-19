"use client";
// Route-segment error boundary. Most server pages call wsGet() with no catch
// (14 of 24 at the time of writing), so a control-plane outage threw straight
// through to a 500 — the page just died. This catches every one of them, and
// every page added later, without each having to remember.
//
// Pages that DO handle their own failure (settings, dashboard, sessions, …)
// resolve to their own "Control plane unreachable." empty state and never
// reach this boundary. It does NOT cover layout.tsx itself — that already
// degrades on its own (Promise.allSettled).
import { useEffect } from "react";

export default function Error({ error, reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <>
      <div className="pagehead"><h1>Page didn&rsquo;t load</h1></div>
      <p className="sub">
        Usually the control plane isn&rsquo;t reachable — check that it&rsquo;s running on{" "}
        <code>:7080</code>, then try again.
      </p>
      <div className="empty">
        <button onClick={reset}>Try again</button>
        {error.digest && (
          <div style={{ marginTop: 12, fontSize: 12 }}>
            <code>{error.digest}</code>
          </div>
        )}
      </div>
    </>
  );
}
