// Unit test with fakes — no DB. Scripted getSession results drive the loop;
// the fake notify hub's captured wake fn substitutes for pg NOTIFY.
// NOTE: the loop's 5s heartbeat setTimeout stays armed after the test
// resolves, so the process lingers ~5s at suite end — harmless.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { streamSessionEvents } from "../src/session-sse.ts";

function harness(sessions: any[]) {
  let call = 0;
  const repo = {
    async listEvents() { return []; },
    async getSession() { return sessions[Math.min(call++, sessions.length - 1)]; },
  };
  const chunks: string[] = [];
  const reply = { raw: { writeHead() {}, write(c: any) { chunks.push(String(c)); return true; }, end() {} } };
  const req = { raw: new EventEmitter() };
  let wakeSub: (() => void) | undefined;
  const notify = { subscribe(_id: string, fn: () => void) { wakeSub = fn; return () => {}; } };
  return { repo, reply, req, notify, chunks, wake: () => wakeSub?.() };
}

test("totals frame re-sent when tokens change without a status flip", async () => {
  const h = harness([
    { status: "running", tokens_in: 0, tokens_out: 0, turns: 1 },
    { status: "running", tokens_in: 500, tokens_out: 20, turns: 1 },   // tokens moved, status did not
    { status: "completed", tokens_in: 500, tokens_out: 20, turns: 1 },
  ]);
  const tick = setInterval(h.wake, 5); // stand-in for the trigger's NOTIFY
  try {
    await streamSessionEvents(h.req, h.reply, h.repo, h.notify, "sesn_test", 0);
  } finally {
    clearInterval(tick);
  }
  const frames = h.chunks.filter((c) => c.startsWith("event: status"));
  assert.equal(frames.length, 3);
  assert.match(frames[1], /"status":"running"/);
  assert.match(frames[1], /"tokens_in":500/);
  assert.ok(h.chunks.some((c) => c.startsWith("event: end")));
});

test("unchanged status AND tokens sends no duplicate frame", async () => {
  const h = harness([
    { status: "running", tokens_in: 10, tokens_out: 1, turns: 1 },
    { status: "running", tokens_in: 10, tokens_out: 1, turns: 1 },     // nothing changed
    { status: "completed", tokens_in: 10, tokens_out: 1, turns: 1 },
  ]);
  const tick = setInterval(h.wake, 5);
  try {
    await streamSessionEvents(h.req, h.reply, h.repo, h.notify, "sesn_test", 0);
  } finally {
    clearInterval(tick);
  }
  assert.equal(h.chunks.filter((c) => c.startsWith("event: status")).length, 2);
});
