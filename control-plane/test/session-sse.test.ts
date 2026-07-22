// Unit test with fakes — no DB. Scripted getSession results drive the loop;
// the fake notify hub's captured wake fn substitutes for pg NOTIFY.
// (The loop's heartbeat setTimeout is unref'd, so armed timers no longer
// pin the process after the suite resolves.)
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

test("console mode: failed keeps streaming (resumable) and heartbeats are ping events", async () => {
  const h = harness([
    { status: "failed", tokens_in: 0, tokens_out: 0, turns: 1 },
    { status: "failed", tokens_in: 0, tokens_out: 0, turns: 1 },       // stays open across failed
    { status: "completed", tokens_in: 0, tokens_out: 0, turns: 1 },
  ]);
  const tick = setInterval(h.wake, 50); // slow tick so the ping write isn't skipped by `pending`
  try {
    await streamSessionEvents(h.req, h.reply, h.repo, h.notify, "sesn_test", 0, { console: true });
  } finally {
    clearInterval(tick);
  }
  const frames = h.chunks.filter((c) => c.startsWith("event: status"));
  assert.match(frames[0], /"status":"failed"/);
  assert.match(frames.at(-1)!, /"status":"completed"/);                // survived past failed
  const pings = h.chunks.filter((c) => c.startsWith("event: ping"));
  assert.ok(pings.length > 0);                                          // real event, not a comment
  assert.match(pings[0], /"status":"failed"/);                          // ping carries current status
  assert.ok(h.chunks.every((c) => !c.startsWith(": ka")));
  assert.ok(h.chunks.some((c) => c.startsWith("event: end")));          // completed still ends
});

test("public mode unchanged: failed is terminal, keep-alive stays a comment", async () => {
  const h = harness([
    { status: "running", tokens_in: 0, tokens_out: 0, turns: 1 },
    { status: "failed", tokens_in: 0, tokens_out: 0, turns: 1 },
  ]);
  const tick = setInterval(h.wake, 50);
  try {
    await streamSessionEvents(h.req, h.reply, h.repo, h.notify, "sesn_test", 0);
  } finally {
    clearInterval(tick);
  }
  const frames = h.chunks.filter((c) => c.startsWith("event: status"));
  assert.match(frames.at(-1)!, /"status":"failed"/);
  assert.ok(h.chunks.some((c) => c.startsWith(": ka")));               // deployed clients' parser contract
  assert.ok(h.chunks.every((c) => !c.startsWith("event: ping")));
  assert.ok(h.chunks.some((c) => c.startsWith("event: end")));
});
