"use client";
// Webhooks tab (spec 2026-07-24): copy-paste curl examples for triggering
// this agent from external systems via the public /api surface through the
// gateway pass-through. Documentation only — the endpoints are always live
// for any active agent; no server-side toggle exists.
import Link from "next/link";
import { Snippet } from "../../lib/snippet";

export function WebhooksTab({ agentId, gatewayUrl }: { agentId: string; gatewayUrl: string }) {
  return (
    <>
      <p className="sub" style={{ marginTop: 0 }}>
        Trigger this agent over HTTP through the gateway. Snippets are prefilled with this
        agent&apos;s id and the gateway URL — replace <code>dpk_…</code> with a key from the{" "}
        <Link href="/api-keys">API Keys</Link> page (key values are shown once at creation).
        The key determines the workspace.
      </p>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Create session</h3>
        <Snippet text={`curl -X POST ${gatewayUrl}/api/sessions \\\n  -H "Authorization: Bearer dpk_…" \\\n  -H "Content-Type: application/json" \\\n  -d '{"agent": "${agentId}", "prompt": "Describe the task…", "files": ["file_…"]}'`} />
        <div className="hint" style={{ marginTop: 6 }}>
          {'returns 201 {"id": "sesn_…", "status": "queued"} — the session id for the calls below; '}
          files is optional (ids from the upload call); 409 = agent disabled or its deployment
          failed, 400 = unknown file id
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Send a message to a session</h3>
        <Snippet text={`curl -X POST ${gatewayUrl}/api/sessions/sesn_…/messages \\\n  -H "Authorization: Bearer dpk_…" \\\n  -H "Content-Type: application/json" \\\n  -d '{"prompt": "Follow-up…", "files": ["file_…"]}'`} />
        <div className="hint" style={{ marginTop: 6 }}>
          returns 202; only idle or failed sessions accept new messages (failed resumes from the
          last completed turn&apos;s checkpoint) — a running session returns 409
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Upload a file</h3>
        <Snippet text={`curl -X POST ${gatewayUrl}/api/files \\\n  -H "Authorization: Bearer dpk_…" \\\n  -F "file=@report.pdf"`} />
        <div className="hint" style={{ marginTop: 6 }}>
          {'returns 201 {"id": "file_…"} — pass the id in files[]; single call up to 32 MB, use '}
          the chunked upload API (POST {gatewayUrl}/api/files/uploads) for larger files
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Check status / result</h3>
        <Snippet text={`curl ${gatewayUrl}/api/sessions/sesn_… \\\n  -H "Authorization: Bearer dpk_…"`} />
        <div className="hint" style={{ marginTop: 6 }}>
          poll status (queued | running | idle | completed | failed); produced output files are
          listed at GET {gatewayUrl}/api/sessions/sesn_…/resources
        </div>
      </div>
    </>
  );
}
