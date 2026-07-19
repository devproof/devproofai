import { test } from "node:test";
import assert from "node:assert/strict";
import { shortId, secretToken } from "../src/id.ts";

test("shortId is exactly 12 chars of a-z0-9", () => {
  for (let i = 0; i < 1000; i++) assert.match(shortId(), /^[a-z0-9]{12}$/);
});

test("shortId does not collide over a large sample", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100_000; i++) seen.add(shortId());
  assert.equal(seen.size, 100_000);
});

test("secretToken: exact length and base62 charset", () => {
  for (let i = 0; i < 50; i++) {
    const t = secretToken(33);
    assert.equal(t.length, 33);
    assert.match(t, /^[0-9A-Za-z]{33}$/);
  }
});

test("secretToken: tokens are distinct", () => {
  const seen = new Set(Array.from({ length: 200 }, () => secretToken(33)));
  assert.equal(seen.size, 200);
});
