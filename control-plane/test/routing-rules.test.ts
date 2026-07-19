import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRouting, reachableLocalTargets, reachableTargets, type RoutingSpec } from "../src/routing-rules.ts";

const ctx = { localNames: new Set(["qwen", "big-ctx"]), externalNames: new Set(["gpt4o"]) };
const ok = (rules: any[], terminal: any = { action: "reject" }): RoutingSpec => ({ rules, terminal });

test("minimal routing: no rules + route terminal", () => {
  assert.equal(validateRouting(ok([], { action: "route", target: "qwen" }), ctx), null);
});

test("reject terminal with zero rules is valid", () => {
  assert.equal(validateRouting(ok([]), ctx), null);
});

test("terminal must be route-with-known-target or reject", () => {
  assert.match(validateRouting(ok([], { action: "route", target: "nope" }), ctx)!, /unknown target/);
  assert.match(validateRouting(ok([], { action: "polka" }), ctx)!, /terminal/);
});

test("rule targets must be deployment or external names (no nesting)", () => {
  assert.equal(validateRouting(ok([{ conditions: [], target: "gpt4o" }], { action: "route", target: "qwen" }), ctx), null);
  assert.match(validateRouting(ok([{ conditions: [], target: "missing" }]), ctx)!, /unknown target/);
});

test("cost condition shape", () => {
  const cost = (over: any = {}) => ({ type: "cost", ledger: "billed", scope: "key", op: ">=", threshold: 50, window: { kind: "month" }, ...over });
  assert.equal(validateRouting(ok([{ conditions: [cost()], target: "qwen" }]), ctx), null);
  assert.match(validateRouting(ok([{ conditions: [cost({ ledger: "eur" })], target: "qwen" }]), ctx)!, /ledger/);
  assert.match(validateRouting(ok([{ conditions: [cost({ scope: "planet" })], target: "qwen" }]), ctx)!, /scope/);
  assert.match(validateRouting(ok([{ conditions: [cost({ threshold: -1 })], target: "qwen" }]), ctx)!, /threshold/);
  assert.match(validateRouting(ok([{ conditions: [cost({ window: { kind: "rolling" } })], target: "qwen" }]), ctx)!, /hours/);
  assert.equal(validateRouting(ok([{ conditions: [cost({ window: { kind: "rolling", hours: 24 } })], target: "qwen" }]), ctx), null);
});

test("tokens condition shape (like cost, no ledger, integer threshold)", () => {
  const tok = (over: any = {}) => ({ type: "tokens", scope: "key", op: ">=", threshold: 1000000, window: { kind: "month" }, ...over });
  assert.equal(validateRouting(ok([{ conditions: [tok()], target: "qwen" }]), ctx), null);
  assert.equal(validateRouting(ok([{ conditions: [tok({ scope: "routing", window: { kind: "day" } })], target: "qwen" }]), ctx), null);
  assert.match(validateRouting(ok([{ conditions: [tok({ scope: "planet" })], target: "qwen" }]), ctx)!, /scope/);
  assert.match(validateRouting(ok([{ conditions: [tok({ op: "~" })], target: "qwen" }]), ctx)!, /op/);
  assert.match(validateRouting(ok([{ conditions: [tok({ threshold: -1 })], target: "qwen" }]), ctx)!, /threshold/);
  assert.match(validateRouting(ok([{ conditions: [tok({ threshold: 1.5 })], target: "qwen" }]), ctx)!, /threshold/);
  assert.match(validateRouting(ok([{ conditions: [tok({ window: { kind: "rolling" } })], target: "qwen" }]), ctx)!, /hours/);
  assert.equal(validateRouting(ok([{ conditions: [tok({ window: { kind: "rolling", hours: 24 } })], target: "qwen" }]), ctx), null);
});

test("context / available / split / time conditions", () => {
  assert.equal(validateRouting(ok([{ conditions: [{ type: "context", op: ">", tokens: 30000 }], target: "big-ctx" }]), ctx), null);
  assert.match(validateRouting(ok([{ conditions: [{ type: "context", op: "~", tokens: 1 }], target: "qwen" }]), ctx)!, /op/);
  assert.equal(validateRouting(ok([{ conditions: [{ type: "available" }], target: "qwen" }]), ctx), null);
  assert.equal(validateRouting(ok([{ conditions: [{ type: "split", percent: 10 }], target: "qwen" }]), ctx), null);
  assert.match(validateRouting(ok([{ conditions: [{ type: "split", percent: 101 }], target: "qwen" }]), ctx)!, /percent/);
  assert.equal(validateRouting(ok([{ conditions: [{ type: "time", days: ["mon", "fri"], from: "09:00", to: "18:00", tz: "Europe/Berlin" }], target: "qwen" }]), ctx), null);
  assert.match(validateRouting(ok([{ conditions: [{ type: "time", from: "9am", to: "18:00", tz: "UTC" }], target: "qwen" }]), ctx)!, /HH:MM/);
  assert.match(validateRouting(ok([{ conditions: [{ type: "time", from: "09:00", to: "18:00", tz: "Mars/Olympus" }], target: "qwen" }]), ctx)!, /timezone/);
});

test("classify condition: local or external classifier, labels, match subset", () => {
  const cls = (over: any = {}) => ({ type: "classify", deployment: "qwen", labels: { code: "programming", chat: "everything else" }, match: ["code"], ...over });
  assert.equal(validateRouting(ok([{ conditions: [cls()], target: "big-ctx" }]), ctx), null);
  assert.equal(validateRouting(ok([{ conditions: [cls({ deployment: "gpt4o" })], target: "qwen" }]), ctx), null);
  assert.match(validateRouting(ok([{ conditions: [cls({ deployment: "missing" })], target: "qwen" }]), ctx)!, /deployment or external endpoint/);
  assert.match(validateRouting(ok([{ conditions: [cls({ match: ["nope"] })], target: "qwen" }]), ctx)!, /match/);
  assert.match(validateRouting(ok([{ conditions: [cls({ labels: {} })], target: "qwen" }]), ctx)!, /labels/);
});

test("conditions AND-combine in one rule (shape only)", () => {
  assert.equal(validateRouting(ok([{
    conditions: [{ type: "context", op: "<=", tokens: 30000 },
                 { type: "cost", ledger: "billed", scope: "key", op: "<", threshold: 50, window: { kind: "month" } }],
    target: "qwen",
  }]), ctx), null);
});

test("bounds: max 50 rules, max 10 conditions per rule", () => {
  const many = Array.from({ length: 51 }, () => ({ conditions: [], target: "qwen" }));
  assert.match(validateRouting(ok(many), ctx)!, /50/);
});

test("reachableLocalTargets: rule + terminal targets, locals only, dedup", () => {
  const spec = ok(
    [{ conditions: [], target: "gpt4o" }, { conditions: [], target: "big-ctx" }, { conditions: [], target: "big-ctx" }],
    { action: "route", target: "qwen" });
  assert.deepEqual(reachableLocalTargets(spec, ctx.localNames).sort(), ["big-ctx", "qwen"]);
});

test("reachableTargets: rule + terminal targets, local AND external, dedup", () => {
  const spec = ok(
    [{ conditions: [], target: "gpt4o" }, { conditions: [], target: "big-ctx" }, { conditions: [], target: "big-ctx" }],
    { action: "route", target: "qwen" });
  assert.deepEqual(reachableTargets(spec).sort(), ["big-ctx", "gpt4o", "qwen"]);
});
