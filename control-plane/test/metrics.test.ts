import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVector, servingMetricsQuery, observedByCatalogId } from "../src/metrics.ts";

const promResponse = {
  status: "success",
  data: {
    result: [
      { metric: { service: "qwen05b-dp", __name__: "llamacpp:predicted_tokens_seconds" }, value: [1, "42.5"] },
      { metric: { service: "other", __name__: "llamacpp:predicted_tokens_seconds" }, value: [1, "7"] },
    ],
  },
};

test("parseVector maps service to value", () => {
  const m = parseVector(promResponse as any);
  assert.equal(m["qwen05b-dp"], 42.5);
  assert.equal(m["other"], 7);
});

test("servingMetricsQuery aggregates by service", () => {
  assert.match(servingMetricsQuery("llamacpp:requests_processing"), /sum by \(service\)/);
});

test("observedByCatalogId keeps the highest measurement per entry", () => {
  const deployments = [
    { name: "a", catalogId: "qwen" },
    { name: "b", catalogId: "qwen" },
    { name: "c", catalogId: "other" },
    { name: "d" },
  ];
  const observed = observedByCatalogId(deployments, { a: 20, b: 45, d: 99 });
  assert.equal(observed["qwen"], 45);
  assert.equal(observed["other"], undefined);
});
