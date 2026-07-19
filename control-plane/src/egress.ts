// Squid config for a per-environment egress proxy (spec 2026-07-10).
// Pure so the allowlist → ACL mapping is unit-testable.
//
// Host semantics:
//   "*"          → allow ALL outbound (traffic still flows through the proxy)
//   "*.foo.com"  → alias for "foo.com" (leading dot: apex + all subdomains)
//   "foo.com"    → foo.com + all subdomains (Squid leading-dot dstdomain)
// An allowlist entry is "*", "*.domain", or a dot-separated hostname/IP. The
// anchored classes forbid whitespace/newlines, so a crafted entry can't inject
// extra Squid directives into the generated conf (the acl line is the ONLY
// egress control).
const HOST_ENTRY_RE = /^(\*|(\*\.)?[A-Za-z0-9_-]{1,63}(\.[A-Za-z0-9_-]{1,63})*)$/;

/** Validate a user-supplied allowedHosts array. Returns an error message, or
 *  null when every entry is a legal host token. */
export function validateHosts(hosts: unknown): string | null {
  if (hosts == null) return null;
  if (!Array.isArray(hosts)) return "allowedHosts must be an array of hostnames";
  for (const h of hosts) {
    if (typeof h !== "string" || h.length > 253 || !HOST_ENTRY_RE.test(h)) {
      return `allowedHosts: invalid host ${JSON.stringify(h)} (use "*", "*.example.com", or a hostname)`;
    }
  }
  return null;
}

export function squidConf(hosts: string[], allowPackageManagers: boolean, mcpHosts: string[] = []): string {
  const all = hosts.includes("*");
  const normalized = hosts
    .filter((h) => h !== "*")
    .map((h) => h.replace(/^\*\./, "."))
    .map((h) => (h.startsWith(".") ? h : `.${h}`));
  // MCP server hostnames (env allow_mcp_servers, spec 2026-07-13) — plain
  // hostnames from URL parsing, same leading-dot subdomain semantics.
  normalized.push(...mcpHosts.map((h) => (h.startsWith(".") ? h : `.${h}`)));
  if (allowPackageManagers) {
    normalized.push(".pypi.org", ".files.pythonhosted.org", ".registry.npmjs.org");
  }
  return [
    "http_port 3128",
    "cache deny all",           // proxy-only, no caching → low memory
    "cache_mem 8 MB",
    // Containers expose a huge default FD limit; squid reserves per-FD
    // buffers and OOMs unless capped.
    "max_filedescriptors 1024",
    ...(all
      ? ["http_access allow all"]
      : normalized.length
        ? [`acl allowed dstdomain ${normalized.join(" ")}`, "http_access allow allowed"]
        : []),
    "http_access deny all",
  ].join("\n");
}
