// Failure-text reframe for routing rejects (fix wave M, user decision
// 2026-07-16). The Claude Agent SDK prefixes ANY 403 as an auth failure
// ("Failed to authenticate. ..."), so a routing's terminal reject surfaces
// to the user as a confusing "Failed to authenticate" error even though
// nothing is wrong with their API key. Detect the gateway's routing-reject
// body and reframe it with a clear "routing '<name>' rejected the request"
// lead-in — the misleading auth prefix is stripped, but the rest of the
// original text (the API error / JSON body) is kept intact so no detail
// is lost.
const AUTH_PREFIX = "Failed to authenticate. ";
const MARKER = "no routing rule matched";

/** Identity on any text that isn't a routing reject. */
export function reframeFailureText(text: string): string {
  if (!text || !text.includes(MARKER)) return text;
  let body = text;
  if (body.startsWith(AUTH_PREFIX) && body.includes(MARKER)) {
    body = body.slice(AUTH_PREFIX.length);
  }
  const m = body.match(/['"]routing['"]:\s*['"]([^'"]*)['"]/);
  const lead = m
    ? `routing '${m[1]}' rejected the request (no rule matched — check the routing's Trace tab). `
    : `routing rejected the request (no rule matched — check the routing's Trace tab). `;
  return lead + body;
}
