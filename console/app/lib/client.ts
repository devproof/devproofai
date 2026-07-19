"use client";

// Client-side fetch: adds the workspace header (read from cookie) to /api calls.
export function wsHeader(): Record<string, string> {
  const m = typeof document !== "undefined" && document.cookie.match(/(?:^|; )devproof_ws=([^;]+)/);
  return { "X-Devproof-Workspace": m ? decodeURIComponent(m[1]) : "wrkspc_default" };
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: wsHeader() });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

export async function apiPost(path: string, body: unknown, isForm = false): Promise<Response> {
  return fetch(`/api${path}`, {
    method: "POST",
    headers: isForm ? wsHeader() : { "Content-Type": "application/json", ...wsHeader() },
    body: isForm ? (body as BodyInit) : JSON.stringify(body),
  });
}
