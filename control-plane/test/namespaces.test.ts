import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// On win32, execFileSync + shell:true routes through cmd.exe, which strips the
// double quotes inside the -e source string (verified: `import("x")` arrives
// as `import(x)` and fails to parse) — use the tsx CLI entry directly via
// process.execPath instead, which needs no shell and no extra quoting.
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const read = (env: Record<string, string>) =>
  JSON.parse(execFileSync(process.execPath, [tsxCli, "-e",
    `import("./src/namespaces.ts").then(m => console.log(JSON.stringify(m)))`],
    { env: { ...process.env, ...env }, encoding: "utf8" }));

test("namespace constants default to today's values", () => {
  const m = read({});
  assert.strictEqual(m.AGENTS_NAMESPACE, "devproof-agents");
  assert.strictEqual(m.GATEWAY_NAMESPACE, "devproof-gateway");
  assert.strictEqual(m.SERVING_NAMESPACE, "devproof-serving");
});

test("namespace constants honor env overrides", () => {
  const m = read({
    DEVPROOF_AGENTS_NAMESPACE: "a", DEVPROOF_GATEWAY_NAMESPACE: "g", DEVPROOF_SERVING_NAMESPACE: "s",
  });
  assert.deepStrictEqual([m.AGENTS_NAMESPACE, m.GATEWAY_NAMESPACE, m.SERVING_NAMESPACE], ["a", "g", "s"]);
});
