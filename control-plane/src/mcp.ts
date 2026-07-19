// MCP servers + typed vault credentials (spec 2026-07-13). Pure helpers:
// URL matching, placeholder header rendering, egress hosts, validation.
// Secret VALUES never pass through here — only derived key names.
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type CredentialType = "environment_variable" | "bearer_token" | "mcp_oauth";

export interface CredentialRow {
  name: string;
  type: CredentialType;
  mcp_server_url?: string | null;
}

export interface McpRegistryEntry {
  name: string;
  label: string;
  url: string;
  description?: string;
  auth: "oauth" | "bearer" | "none";
}

export function loadMcpRegistry(path: string): McpRegistryEntry[] {
  const doc = parse(readFileSync(path, "utf8"));
  return doc?.servers ?? [];
}

/** Credential name → key fragment valid as BOTH a Secret key and a
 *  C_IDENTIFIER env var name, so envFrom can never skip it. */
export function sanitizeCredentialName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

/** Every Secret key a credential may own — delete removes them all
 *  (removing a never-written key is a no-op merge patch). */
export function credentialSecretKeys(name: string, type: CredentialType): string[] {
  if (type === "environment_variable") return [name];
  const base = `DEVPROOF_CRED_${sanitizeCredentialName(name)}`;
  return type === "bearer_token"
    ? [`${base}_TOKEN`]
    : [`${base}_TOKEN`, `${base}_CLIENT_ID`, `${base}_CLIENT_SECRET`];
}

/** Credential↔server matching key: lowercase scheme+host (URL does this),
 *  trailing slash stripped, path kept (case-sensitive), query kept. */
export function normalizeMcpUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

/** Inject Authorization PLACEHOLDERS (${VAR}, expanded by the runner from the
 *  pod env) for bearer/oauth credentials whose server URL matches an agent
 *  MCP server. A server that already carries an Authorization header (any
 *  case — raw API config) is left untouched. */
export function renderMcpServers(
  mcpServers: Record<string, any>, credentials: CredentialRow[],
): Record<string, any> {
  const byUrl = new Map<string, CredentialRow>();
  for (const c of credentials) {
    if ((c.type === "bearer_token" || c.type === "mcp_oauth") && c.mcp_server_url) {
      byUrl.set(normalizeMcpUrl(c.mcp_server_url), c);
    }
  }
  const out: Record<string, any> = {};
  for (const [name, cfg] of Object.entries(mcpServers ?? {})) {
    const url = typeof cfg?.url === "string" ? normalizeMcpUrl(cfg.url) : null;
    const cred = url ? byUrl.get(url) : undefined;
    const hasAuth = cfg?.headers &&
      Object.keys(cfg.headers).some((h) => h.toLowerCase() === "authorization");
    out[name] = cred && !hasAuth
      ? { ...cfg, headers: { ...(cfg.headers ?? {}),
          Authorization: `Bearer \${DEVPROOF_CRED_${sanitizeCredentialName(cred.name)}_TOKEN}` } }
      : cfg;
  }
  return out;
}

/** Unique sorted hostnames across mcp_servers maps — the env's Squid
 *  MCP allowlist. Invalid URLs are skipped (validation rejects new ones). */
export function mcpHostnames(mcpServersList: Record<string, any>[]): string[] {
  const hosts = new Set<string>();
  for (const servers of mcpServersList) {
    for (const cfg of Object.values(servers ?? {})) {
      const url = (cfg as any)?.url;
      if (typeof url !== "string") continue;
      try { hosts.add(new URL(url).hostname); } catch { /* skip */ }
    }
  }
  return [...hosts].sort();
}

const SERVER_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Agent mcpServers shape guard (routes 400 on the returned message).
 *  Extra fields (e.g. pre-set headers) pass through untouched. */
export function validateMcpServers(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "mcpServers must be an object";
  for (const [name, cfg] of Object.entries(value as Record<string, any>)) {
    if (!SERVER_NAME_RE.test(name)) return `mcpServers: bad server name "${name}"`;
    if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) return `mcpServers.${name}: must be an object`;
    if (typeof cfg.url !== "string" || !/^https?:\/\//i.test(cfg.url)) return `mcpServers.${name}: url must be http(s)`;
    try { new URL(cfg.url); } catch { return `mcpServers.${name}: invalid url`; }
    if (cfg.type !== "http" && cfg.type !== "sse") return `mcpServers.${name}: type must be "http" or "sse"`;
  }
  return null;
}

export interface CredentialInput {
  name: string;
  type: CredentialType;
  mcpServerUrl?: string;
  mcpServerName?: string;
  /** Derived Secret keys → values to write. Omitted optional parts
   *  (oauth clientId/clientSecret) are simply absent → rotate leaves them. */
  secrets: Record<string, string>;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CRED_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function validateCredentialBody(b: any): { error: string } | CredentialInput {
  const type: CredentialType = b?.type ?? "environment_variable";
  if (!["environment_variable", "bearer_token", "mcp_oauth"].includes(type)) {
    return { error: `unknown credential type "${b?.type}"` };
  }
  if (type === "environment_variable") {
    if (!b?.name || !ENV_NAME_RE.test(b.name)) return { error: "name must be a valid environment variable name" };
    if (typeof b?.value !== "string" || !b.value) return { error: "value required" };
    return { name: b.name, type, secrets: { [b.name]: b.value } };
  }
  const url = b?.mcpServerUrl;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return { error: "mcpServerUrl must be http(s)" };
  let hostname: string;
  try { hostname = new URL(url).hostname; } catch { return { error: "mcpServerUrl invalid" }; }
  const name = String(b?.name ?? "").trim() || String(b?.mcpServerName ?? "").trim() || hostname;
  if (!CRED_NAME_RE.test(name)) return { error: "invalid credential name" };
  const token = type === "bearer_token" ? b?.token : b?.accessToken;
  if (typeof token !== "string" || !token) {
    return { error: type === "bearer_token" ? "token required" : "accessToken required" };
  }
  const base = `DEVPROOF_CRED_${sanitizeCredentialName(name)}`;
  const secrets: Record<string, string> = { [`${base}_TOKEN`]: token };
  if (type === "mcp_oauth") {
    if (b?.clientId) secrets[`${base}_CLIENT_ID`] = String(b.clientId);
    if (b?.clientSecret) secrets[`${base}_CLIENT_SECRET`] = String(b.clientSecret);
  }
  return { name, type, mcpServerUrl: url, mcpServerName: b?.mcpServerName, secrets };
}
