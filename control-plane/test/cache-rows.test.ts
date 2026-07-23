import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheRows, progressPct } from "../src/cache-rows.ts";

const model = (name: string, phase = "Ready", total?: number) => ({
  metadata: { name, creationTimestamp: "2026-07-23T00:00:00Z" },
  spec: { source: `https://hf.co/${name}.gguf` },
  status: { phase, size: "6.6 GiB", ...(total ? { sourceContentLength: total } : {}) },
});
const pod = (label: string, initState: object | null, phase = "Pending") => ({
  metadata: { name: `${label}-pod-1`, labels: { "inference.llmkube.dev/model": label } },
  status: {
    phase,
    initContainerStatuses: initState ? [{ name: "model-downloader", state: initState }] : [],
  },
});

test("model with a running downloader overrides phase to Downloading", () => {
  const { rows, downloading } = cacheRows(
    [model("gemma", "Ready", 1000)],
    [pod("gemma", { running: { startedAt: "x" } })],  // mid-init pods are phase Pending
  );
  assert.equal(rows[0].phase, "Downloading");
  assert.equal(rows[0].progress, null); // exec fills it later
  assert.deepEqual(downloading, [{ name: "gemma", pod: "gemma-pod-1", total: 1000 }]);
});

test("no pod / terminated downloader passes the CR phase through", () => {
  const { rows: noPod } = cacheRows([model("a")], []);
  assert.equal(noPod[0].phase, "Ready");
  const { rows: done, downloading } = cacheRows(
    [model("b")], [pod("b", { terminated: { exitCode: 0 } }, "Running")]);
  assert.equal(done[0].phase, "Ready");
  assert.equal(downloading.length, 0);
});

test("Failed and Succeeded pods are ignored (exec into them 500s)", () => {
  const { downloading } = cacheRows(
    [model("c", "Ready", 5)],
    [pod("c", { running: {} }, "Failed"), pod("c", { running: {} }, "Succeeded")]);
  assert.equal(downloading.length, 0);
});

test("missing sourceContentLength -> Downloading but not an exec target", () => {
  const { rows, downloading } = cacheRows(
    [model("d", "Ready")], [pod("d", { running: {} })]);
  assert.equal(rows[0].phase, "Downloading");
  assert.equal(downloading.length, 0);
});

test("row shape keeps the existing /v1/cache fields", () => {
  const { rows } = cacheRows([model("e")], []);
  assert.deepEqual(Object.keys(rows[0]).sort(),
    ["created", "name", "phase", "progress", "size", "source"]);
});

test("progressPct math", () => {
  assert.equal(progressPct(500, 1000), 50);
  assert.equal(progressPct(2000, 1000), 100); // clamp
  assert.equal(progressPct(0, 1000), 0);
  assert.equal(progressPct(500, 0), null);    // unknown total degrades
});
