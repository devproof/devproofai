// Smoke test: the serving foundation answers chat completions.
// Usage: node scripts/smoke-serving.mjs [baseUrl]
// Starts its own kubectl port-forward unless baseUrl is given.
import { spawn, execSync } from "node:child_process";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:18080";
let pf = null;

async function waitFor(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { await fetch(url); return; } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  throw new Error(`not reachable within ${ms}ms: ${url}`);
}

try {
  if (!process.argv[2]) {
    execSync("kubectl -n devproof-serving get svc qwen05b", { stdio: "pipe" });
    pf = spawn("kubectl", ["-n", "devproof-serving", "port-forward", "svc/qwen05b", "18080:8080"],
               { stdio: "ignore" });
    await waitFor(`${baseUrl}/v1/models`, 30000).catch(() => {}); // readiness probe only
  }
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Reply with the single word: pong" }], max_tokens: 10 }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (!text || typeof text !== "string") throw new Error(`no content in response: ${JSON.stringify(body).slice(0, 500)}`);
  console.log(`SMOKE PASS — model replied: ${JSON.stringify(text.trim().slice(0, 80))}`);
  process.exit(0);
} catch (err) {
  console.error(`SMOKE FAIL — ${err.message}`);
  process.exit(1);
} finally {
  pf?.kill();
}
