// Load burst: sustained concurrent chat requests against the gateway to
// exercise queue-pressure autoscaling. Usage:
//   node scripts/load-burst.mjs [model] [concurrency] [seconds] [baseUrl]
import { spawn } from "node:child_process";

const model = process.argv[2] ?? "qwen05b-dp";
const concurrency = Number(process.argv[3] ?? 8);
const seconds = Number(process.argv[4] ?? 60);
const baseUrl = process.argv[5] ?? "http://127.0.0.1:14000";
let pf = null;

async function waitFor(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("gateway not reachable");
}

if (!process.argv[5]) {
  pf = spawn("kubectl", ["-n", "devproof-gateway", "port-forward", "svc/gateway", "14000:4000"],
             { stdio: "ignore" });
}
await waitFor(`${baseUrl}/health/readiness`, 30000);

const deadline = Date.now() + seconds * 1000;
let done = 0, failed = 0;

async function worker() {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Write six sentences about Kubernetes." }],
          max_tokens: 160,
        }),
        signal: AbortSignal.timeout(120000),
      });
      res.ok ? done++ : failed++;
      await res.text();
    } catch { failed++; }
  }
}

console.log(`bursting ${concurrency}x for ${seconds}s at ${model}…`);
await Promise.all(Array.from({ length: concurrency }, worker));
console.log(`burst done: ${done} ok, ${failed} failed`);
pf?.kill();
process.exit(0);
