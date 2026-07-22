// Server-side fetch helper: forwards the selected workspace to the control plane.
import { cookies } from "next/headers";

const API = process.env.DEVPROOF_API ?? "http://127.0.0.1:7080";
export const WS_COOKIE = "devproof_ws";

export async function currentWorkspace(): Promise<string> {
  const c = await cookies();
  return c.get(WS_COOKIE)?.value ?? "wrkspc_default";
}

/** Compute the API offset from a Next.js searchParams `page` value (default 100/page). */
export function offsetOf(page: unknown, limit = 100): number {
  return (Math.max(1, Number(page ?? 1)) - 1) * limit;
}

/** GET a control-plane path (workspace-scoped) and return parsed JSON.
 * Throws on non-2xx (fetch only rejects on network errors, not HTTP status):
 * a 404/401 body — e.g. a session in a workspace you're not currently in —
 * would otherwise render as a shape-less object (undefined id → the live
 * view streams `sessions/undefined` forever). Uncaught callers fall through
 * to the error boundary; `.catch()` callers keep their own fallback. */
export async function wsGet<T = any>(path: string): Promise<T> {
  const ws = await currentWorkspace();
  const res = await fetch(`${API}${path}`, {
    cache: "no-store",
    headers: { "X-Devproof-Workspace": ws },
  });
  if (!res.ok) throw Object.assign(new Error(`GET ${path} → ${res.status}`), { status: res.status });
  return res.json();
}
