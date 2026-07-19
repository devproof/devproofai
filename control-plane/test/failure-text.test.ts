import { test } from "node:test";
import assert from "node:assert/strict";
import { reframeFailureText } from "../src/failure-text.ts";

test("reframeFailureText strips the misleading auth prefix and names the routing", () => {
  const text = "Failed to authenticate. API Error: 403 403: {'error': 'no routing rule matched', 'routing': 'test'}";
  assert.equal(
    reframeFailureText(text),
    "routing 'test' rejected the request (no rule matched — check the routing's Trace tab). "
      + "API Error: 403 403: {'error': 'no routing rule matched', 'routing': 'test'}",
  );
});

test("reframeFailureText handles double-quoted JSON bodies too", () => {
  const text = 'API Error: 403 403: {"error": "no routing rule matched", "routing": "prod"}';
  assert.equal(
    reframeFailureText(text),
    "routing 'prod' rejected the request (no rule matched — check the routing's Trace tab). "
      + text,
  );
});

test("reframeFailureText falls back to a nameless lead-in when no routing field is present", () => {
  const text = "API Error: 403 403: {'error': 'no routing rule matched'}";
  assert.equal(
    reframeFailureText(text),
    "routing rejected the request (no rule matched — check the routing's Trace tab). " + text,
  );
});

test("reframeFailureText leaves unrelated failures untouched", () => {
  const text = "APIStatusError: Context window exceeded";
  assert.equal(reframeFailureText(text), text);
});

test("reframeFailureText only strips the auth prefix, never other text before the marker", () => {
  const text = "some other wrapper. no routing rule matched downstream";
  assert.equal(
    reframeFailureText(text),
    "routing rejected the request (no rule matched — check the routing's Trace tab). " + text,
  );
});
