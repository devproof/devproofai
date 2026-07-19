import { test } from "node:test";
import assert from "node:assert/strict";
import { rangeWindow, bucketSeries } from "../src/usage-range.ts";

// Fixed "now": Wed 2026-07-15 12:00 UTC
const NOW = new Date(Date.UTC(2026, 6, 15, 12, 0, 0));

test("day presets span exactly N calendar days including today (UTC-aligned)", () => {
  for (const [preset, days] of [["1d", 1], ["3d", 3], ["7d", 7], ["14d", 14], ["28d", 28]] as const) {
    const w = rangeWindow(preset, NOW);
    // start = UTC midnight, (N-1) days back → today is the Nth day.
    assert.equal(w.start.toISOString(),
      new Date(Date.UTC(2026, 6, 15) - (days - 1) * 86_400_000).toISOString(), preset);
    assert.equal(w.end, null);
    assert.equal(w.bucket, "day");
  }
  assert.equal(rangeWindow("1d", NOW).start.toISOString(), "2026-07-15T00:00:00.000Z");
});

test("month = start of current calendar month, unbounded", () => {
  const w = rangeWindow("month", NOW);
  assert.equal(w.start.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(w.end, null);
  assert.equal(w.bucket, "day");
});

test("last_month = previous calendar month, bounded", () => {
  const w = rangeWindow("last_month", NOW);
  assert.equal(w.start.toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal(w.end!.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(w.bucket, "day");
});

test("3m/6m are rolling months with weekly buckets", () => {
  const w3 = rangeWindow("3m", NOW);
  assert.equal(w3.start.toISOString(), "2026-04-15T12:00:00.000Z");
  assert.equal(w3.bucket, "week");
  const w6 = rangeWindow("6m", NOW);
  assert.equal(w6.start.toISOString(), "2026-01-15T12:00:00.000Z");
  assert.equal(w6.bucket, "week");
  assert.equal(w6.end, null);
});

test("unknown preset falls back to 7d", () => {
  const w = rangeWindow("bogus", NOW);
  assert.equal(w.start.toISOString(), "2026-07-09T00:00:00.000Z");
  assert.equal(w.bucket, "day");
});

test("3m clamps month-end rollover instead of overflowing", () => {
  const eom = new Date(Date.UTC(2026, 4, 31, 12, 0, 0)); // 2026-05-31
  const w = rangeWindow("3m", eom);
  assert.equal(w.start.toISOString(), "2026-02-28T12:00:00.000Z");
});

test("bucketSeries: bounded windows exclude the end instant; unbounded end at now()", () => {
  assert.match(bucketSeries("day", "$1", "$2"), /\$2::timestamptz - interval '1 second'/);
  assert.match(bucketSeries("day", "$1", null), /now\(\)/);
  assert.match(bucketSeries("week", "$1", null), /interval '1 week'/);
});
