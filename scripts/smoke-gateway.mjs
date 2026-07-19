// Smoke test: the AI gateway answers on BOTH dialects for a routed model.
// Usage: node scripts/smoke-gateway.mjs [model] [baseUrl]
// Starts its own kubectl port-forward unless baseUrl is given.
import { spawn } from "node:child_process";

const model = process.argv[2] ?? "qwen05b-dp";
const baseUrl = process.argv[3] ?? "http://127.0.0.1:14000";
let pf = null;

async function waitFor(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`gateway not reachable within ${ms}ms`);
}

try {
  if (!process.argv[3]) {
    pf = spawn("kubectl", ["-n", "devproof-gateway", "port-forward", "svc/gateway", "14000:4000"],
               { stdio: "ignore" });
  }
  await waitFor(`${baseUrl}/health/readiness`, 30000);

  const openai = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with one word: pong" }], max_tokens: 10 }),
    signal: AbortSignal.timeout(120000),
  });
  if (!openai.ok) throw new Error(`openai dialect HTTP ${openai.status}: ${await openai.text()}`);
  const oa = (await openai.json())?.choices?.[0]?.message?.content;
  if (!oa) throw new Error("openai dialect: empty content");

  const anthropic = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "none", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: "user", content: "Reply with one word: pong" }] }),
    signal: AbortSignal.timeout(120000),
  });
  if (!anthropic.ok) throw new Error(`anthropic dialect HTTP ${anthropic.status}: ${await anthropic.text()}`);
  const an = (await anthropic.json())?.content?.[0]?.text;
  if (!an) throw new Error("anthropic dialect: empty content");

  console.log(`SMOKE PASS — ${model} via openai: ${JSON.stringify(oa.trim())}, anthropic: ${JSON.stringify(an.trim())}`);
  process.exit(0);
} catch (err) {
  console.error(`SMOKE FAIL — ${err.message}`);
  process.exit(1);
} finally {
  pf?.kill();
}
