import { NextRequest } from "next/server";

// Runtime proxy for browser calls to the control plane. Replaces the old
// next.config rewrite, whose destination was baked into the standalone bundle
// at build time (breaks the generic Docker image). Streams bodies untouched —
// the CP already sends identity encoding + keep-alives for SSE.
const API = () => process.env.DEVPROOF_API ?? "http://127.0.0.1:7080";

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("connection");
  const res = await fetch(`${API()}/${path.join("/")}${url.search}`, {
    method: req.method,
    headers,
    body: req.body,
    // @ts-expect-error undici requires half-duplex for streamed request bodies
    duplex: "half",
    redirect: "manual",
  });
  const out = new Headers(res.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  out.delete("transfer-encoding");
  return new Response(res.body, { status: res.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
