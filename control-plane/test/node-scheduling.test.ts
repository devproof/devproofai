import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateNodeScheduling } from "../src/node-scheduling.ts";

test("aggregates distinct label values and dedupes taints across nodes", () => {
  const nodes = [
    { metadata: { labels: { "topology.kubernetes.io/zone": "b", role: "gpu" } },
      spec: { taints: [{ key: "nvidia.com/gpu", value: "true", effect: "NoSchedule" }] } },
    { metadata: { labels: { "topology.kubernetes.io/zone": "a", role: "gpu" } },
      spec: { taints: [{ key: "nvidia.com/gpu", value: "true", effect: "NoSchedule" }] } },
    { metadata: { labels: {} }, spec: {} },
  ];
  const out = aggregateNodeScheduling(nodes);
  assert.deepEqual(out.labels["topology.kubernetes.io/zone"], ["a", "b"]);
  assert.deepEqual(out.labels["role"], ["gpu"]);
  assert.deepEqual(out.taints, [{ key: "nvidia.com/gpu", value: "true", effect: "NoSchedule" }]);
});

test("empty node list yields empty maps", () => {
  assert.deepEqual(aggregateNodeScheduling([]), { labels: {}, taints: [] });
});
