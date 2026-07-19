import { test } from "node:test";
import assert from "node:assert/strict";
import { squidConf } from "../src/egress.ts";

test("plain hosts get leading-dot ACLs (domain + subdomains)", () => {
  const conf = squidConf(["docs.dremio.com", "api.github.com"], false);
  assert.match(conf, /acl allowed dstdomain \.docs\.dremio\.com \.api\.github\.com/);
  assert.match(conf, /http_access allow allowed/);
  assert.match(conf, /http_access deny all/);
});

test("*.foo.com normalizes to .foo.com (no double dot, no literal *)", () => {
  const conf = squidConf(["*.dremio.com"], false);
  assert.match(conf, /acl allowed dstdomain \.dremio\.com/);
  assert.ok(!conf.includes("*"));
});

test("* allows all outbound (no acl, allow all before deny)", () => {
  const conf = squidConf(["*"], false);
  assert.match(conf, /http_access allow all/);
  assert.ok(!conf.includes("dstdomain"));
  // "allow all" must come before "deny all" or it is dead config
  assert.ok(conf.indexOf("http_access allow all") < conf.indexOf("http_access deny all"));
});

test("* wins even when mixed with other hosts", () => {
  const conf = squidConf(["docs.dremio.com", "*"], true);
  assert.match(conf, /http_access allow all/);
  assert.ok(!conf.includes("dstdomain"));
});

test("empty hosts = deny all only", () => {
  const conf = squidConf([], false);
  assert.ok(!conf.includes("http_access allow"));
  assert.match(conf, /http_access deny all/);
});

test("package managers append pypi/npm registries", () => {
  const conf = squidConf([], true);
  assert.match(conf, /acl allowed dstdomain \.pypi\.org \.files\.pythonhosted\.org \.registry\.npmjs\.org/);
});

test("memory/FD guards always present", () => {
  for (const conf of [squidConf([], false), squidConf(["*"], false)]) {
    assert.match(conf, /max_filedescriptors 1024/);
    assert.match(conf, /cache deny all/);
    assert.match(conf, /http_port 3128/);
  }
});

test("mcpHosts join the allowlist with leading-dot semantics", () => {
  const conf = squidConf(["docs.dremio.com"], false, ["mcp.context7.com", "api.githubcopilot.com"]);
  assert.match(conf, /acl allowed dstdomain \.docs\.dremio\.com \.mcp\.context7\.com \.api\.githubcopilot\.com/);
});

test("mcpHosts alone still produce an allow rule", () => {
  const conf = squidConf([], false, ["mcp.context7.com"]);
  assert.match(conf, /acl allowed dstdomain \.mcp\.context7\.com/);
  assert.match(conf, /http_access allow allowed/);
});

test("omitted mcpHosts keeps existing behavior", () => {
  assert.equal(squidConf(["a.com"], false), squidConf(["a.com"], false, []));
});
