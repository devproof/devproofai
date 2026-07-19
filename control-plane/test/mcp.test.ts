import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeCredentialName, credentialSecretKeys, normalizeMcpUrl,
  renderMcpServers, mcpHostnames, validateMcpServers, validateCredentialBody,
} from "../src/mcp.ts";

test("sanitizeCredentialName → [A-Z0-9_] only", () => {
  assert.equal(sanitizeCredentialName("context7"), "CONTEXT7");
  assert.equal(sanitizeCredentialName("mcp.context7.com"), "MCP_CONTEXT7_COM");
  assert.equal(sanitizeCredentialName("my-cred 2"), "MY_CRED_2");
});

test("credentialSecretKeys per type", () => {
  assert.deepEqual(credentialSecretKeys("MY_API_KEY", "environment_variable"), ["MY_API_KEY"]);
  assert.deepEqual(credentialSecretKeys("context7", "bearer_token"), ["DEVPROOF_CRED_CONTEXT7_TOKEN"]);
  assert.deepEqual(credentialSecretKeys("gh", "mcp_oauth"),
    ["DEVPROOF_CRED_GH_TOKEN", "DEVPROOF_CRED_GH_CLIENT_ID", "DEVPROOF_CRED_GH_CLIENT_SECRET"]);
});

test("normalizeMcpUrl: lowercase host, trailing slash stripped, path kept", () => {
  assert.equal(normalizeMcpUrl("HTTPS://MCP.Context7.COM/mcp/"), "https://mcp.context7.com/mcp");
  assert.equal(normalizeMcpUrl("https://a.com"), "https://a.com");
  assert.equal(normalizeMcpUrl("https://a.com/x") === normalizeMcpUrl("https://a.com/y"), false);
});

test("renderMcpServers injects a placeholder Authorization for URL-matched credentials", () => {
  const servers = { context7: { type: "http", url: "https://mcp.context7.com/mcp/" } };
  const creds = [{ name: "context7", type: "bearer_token" as const, mcp_server_url: "https://mcp.context7.com/mcp" }];
  const out = renderMcpServers(servers, creds);
  assert.equal(out.context7.headers.Authorization, "Bearer ${DEVPROOF_CRED_CONTEXT7_TOKEN}");
  assert.equal(out.context7.url, "https://mcp.context7.com/mcp/"); // original config untouched otherwise
});

test("renderMcpServers: no match / env-var creds / preset Authorization → unchanged", () => {
  const servers = {
    a: { type: "http", url: "https://a.com/mcp" },
    b: { type: "http", url: "https://b.com/mcp", headers: { authorization: "Bearer preset" } },
  };
  const creds = [
    { name: "x", type: "bearer_token" as const, mcp_server_url: "https://other.com/mcp" },
    { name: "ENV_ONLY", type: "environment_variable" as const },
    { name: "b", type: "bearer_token" as const, mcp_server_url: "https://b.com/mcp" },
  ];
  const out = renderMcpServers(servers, creds);
  assert.equal(out.a.headers, undefined);
  assert.equal(out.b.headers.authorization, "Bearer preset"); // preset (any case) wins
  assert.equal(Object.keys(out.b.headers).length, 1);
});

test("renderMcpServers: mcp_oauth matches like bearer", () => {
  const out = renderMcpServers(
    { gh: { type: "http", url: "https://api.githubcopilot.com/mcp/" } },
    [{ name: "gh", type: "mcp_oauth" as const, mcp_server_url: "https://api.githubcopilot.com/mcp" }]);
  assert.equal(out.gh.headers.Authorization, "Bearer ${DEVPROOF_CRED_GH_TOKEN}");
});

test("mcpHostnames: unique sorted hostnames, invalid urls skipped", () => {
  assert.deepEqual(mcpHostnames([
    { a: { url: "https://mcp.context7.com/mcp" }, b: { url: "https://api.githubcopilot.com/mcp/" } },
    { c: { url: "https://mcp.context7.com/other" } },
    { d: { url: "not a url" } }, { e: {} },
  ]), ["api.githubcopilot.com", "mcp.context7.com"]);
});

test("validateMcpServers: shape errors", () => {
  assert.equal(validateMcpServers(undefined), null);
  assert.equal(validateMcpServers({}), null);
  assert.equal(validateMcpServers({ ok: { type: "http", url: "https://a.com/mcp" } }), null);
  assert.match(validateMcpServers([])!, /object/);
  assert.match(validateMcpServers({ "bad name!": { url: "https://a.com" } })!, /bad server name/);
  assert.match(validateMcpServers({ a: { url: "ftp://a.com" } })!, /http\(s\)/);
  assert.match(validateMcpServers({ a: "nope" })!, /must be an object/);
});

test("validateMcpServers: transport type required", () => {
  assert.match(validateMcpServers({ a: { url: "https://a.com/mcp" } })!, /type must be "http" or "sse"/);
  assert.equal(validateMcpServers({ a: { type: "http", url: "https://a.com/mcp" } }), null);
  assert.equal(validateMcpServers({ a: { type: "sse", url: "https://a.com/mcp" } }), null);
  assert.match(validateMcpServers({ a: { type: "stdio", url: "https://a.com/mcp" } })!, /type must be "http" or "sse"/);
});

test("validateCredentialBody: env var type (legacy body shape)", () => {
  const r = validateCredentialBody({ name: "MY_API_KEY", value: "s3cret" });
  assert.deepEqual(r, { name: "MY_API_KEY", type: "environment_variable", secrets: { MY_API_KEY: "s3cret" } });
  assert.match((validateCredentialBody({ name: "2bad", value: "x" }) as any).error, /environment variable name/);
  assert.match((validateCredentialBody({ name: "OK" }) as any).error, /value required/);
});

test("validateCredentialBody: bearer_token", () => {
  const r: any = validateCredentialBody({
    type: "bearer_token", mcpServerUrl: "https://mcp.context7.com/mcp", mcpServerName: "context7", token: "tok",
  });
  assert.equal(r.name, "context7"); // derived from mcpServerName when name empty
  assert.deepEqual(r.secrets, { DEVPROOF_CRED_CONTEXT7_TOKEN: "tok" });
  assert.match((validateCredentialBody({ type: "bearer_token", mcpServerUrl: "nope", token: "t" }) as any).error, /http\(s\)/);
  assert.match((validateCredentialBody({ type: "bearer_token", mcpServerUrl: "https://a.com" }) as any).error, /token required/);
});

test("validateCredentialBody: mcp_oauth with optional client fields", () => {
  const r: any = validateCredentialBody({
    type: "mcp_oauth", mcpServerUrl: "https://api.githubcopilot.com/mcp/", accessToken: "at", clientId: "cid",
  });
  assert.equal(r.name, "api.githubcopilot.com"); // no name/mcpServerName → hostname
  assert.deepEqual(r.secrets, {
    "DEVPROOF_CRED_API_GITHUBCOPILOT_COM_TOKEN": "at",
    "DEVPROOF_CRED_API_GITHUBCOPILOT_COM_CLIENT_ID": "cid",
  }); // clientSecret omitted → key not written (rotate leaves it unchanged)
  assert.match((validateCredentialBody({ type: "mcp_oauth", mcpServerUrl: "https://a.com" }) as any).error, /accessToken required/);
});

test("validateCredentialBody: unknown type", () => {
  assert.match((validateCredentialBody({ type: "wat" }) as any).error, /unknown credential type/);
});
