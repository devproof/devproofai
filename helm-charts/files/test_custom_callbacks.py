# Offline tests for the routing evaluator inside custom_callbacks.py (the
# chart-owned copy in this directory). Loads the module, stubs the
# gateway-only imports, and drives _evaluate_routing with injected deps.
# Run: python helm-charts/files/test_custom_callbacks.py   (from repo root)
import asyncio, pathlib, sys, types

def load_module():
    src = (pathlib.Path(__file__).parent / "custom_callbacks.py").read_text(encoding="utf-8")
    for name in ("asyncpg", "httpx", "litellm", "litellm.integrations",
                 "litellm.integrations.custom_logger", "litellm.proxy", "litellm.proxy._types"):
        sys.modules.setdefault(name, types.ModuleType(name))
    sys.modules["litellm.integrations.custom_logger"].CustomLogger = object

    class HTTPException(Exception):
        def __init__(self, status_code=None, detail=None, headers=None):
            self.status_code, self.detail, self.headers = status_code, detail, headers
    fastapi = types.ModuleType("fastapi")
    fastapi.HTTPException = HTTPException
    sys.modules["fastapi"] = fastapi

    class UserAPIKeyAuth:
        def __init__(self, **kw):
            self.__dict__.update(kw)
    sys.modules["litellm.proxy._types"].UserAPIKeyAuth = UserAPIKeyAuth
    mod = types.ModuleType("custom_callbacks")
    exec(compile(src, "custom_callbacks.py", "exec"), mod.__dict__)
    return mod

M = load_module()
FAILS = []

def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        FAILS.append(name)

def run(coro):
    return asyncio.run(coro)

TARGETS = {"phases": {"qwen": "Ready", "big-ctx": "Idle", "broken": "Failed"}, "external": {"gpt4o"}}
async def fake_targets():
    return TARGETS

def deps(**over):
    async def no_cost(cond, md, name, target): return 0.0
    async def no_tokens(cond, md, name, target): return 0
    async def no_classify(cond, data, cache, name): return False
    async def all_on(): return {"enabled": True, "billing": {"enabled": True}}
    d = {"targets": fake_targets, "cost": no_cost, "tokens": no_tokens, "settings": all_on,
         "classify": no_classify, "estimate": M._estimate_tokens, "time": M._match_time, "rand": lambda: 0.5}
    d.update(over)
    return d

# terminal route / reject / unavailable
r = run(M._evaluate_routing("r", {"rules": [], "terminal": {"action": "route", "target": "qwen"}}, {}, {}, deps()))
check("terminal route", r == ("route", "qwen", -1))
r = run(M._evaluate_routing("r", {"rules": [], "terminal": {"action": "reject"}}, {}, {}, deps()))
check("terminal reject", r == ("reject", None, None))
r = run(M._evaluate_routing("r", {"rules": [], "terminal": {"action": "route", "target": "gone"}}, {}, {}, deps()))
check("terminal unavailable", r == ("unavailable", "gone", -1))

# first-match ordering + missing rule target skipped
routing = {"rules": [{"conditions": [], "target": "gone"}, {"conditions": [], "target": "qwen"},
                     {"conditions": [], "target": "gpt4o"}], "terminal": {"action": "reject"}}
check("missing target skipped, first live match wins",
      run(M._evaluate_routing("r", routing, {}, {}, deps())) == ("route", "qwen", 1))

# AND semantics: one false condition kills the rule
async def cost_60(cond, md, name, target): return 60.0
routing = {"rules": [{"conditions": [
    {"type": "cost", "ledger": "billed", "scope": "key", "op": "<", "threshold": 50, "window": {"kind": "month"}},
    {"type": "context", "op": "<=", "tokens": 999999}], "target": "qwen"}],
    "terminal": {"action": "route", "target": "gpt4o"}}
check("AND: cost>=50 fails the rule -> terminal",
      run(M._evaluate_routing("r", routing, {"messages": [{"role": "user", "content": "hi"}]},
          {"devproof_key_id": "k1"}, deps(cost=cost_60))) == ("route", "gpt4o", -1))

# tokens condition (G1): thresholds on metered token consumption, no ledger
async def tokens_2m(cond, md, name, target): return 2_000_000
routing = {"rules": [{"conditions": [
    {"type": "tokens", "scope": "routing", "op": ">=", "threshold": 1_000_000, "window": {"kind": "day"}}],
    "target": "qwen"}], "terminal": {"action": "route", "target": "gpt4o"}}
check("tokens >= threshold matches -> route to rule target",
      run(M._evaluate_routing("r", routing, {}, {}, deps(tokens=tokens_2m))) == ("route", "qwen", 0))
async def tokens_low(cond, md, name, target): return 10
check("tokens below threshold falls through to terminal",
      run(M._evaluate_routing("r", routing, {}, {}, deps(tokens=tokens_low))) == ("route", "gpt4o", -1))
# tokens scope without attribution never matches
async def tokens_none(cond, md, name, target): return None
routing = {"rules": [{"conditions": [
    {"type": "tokens", "scope": "agent", "op": ">=", "threshold": 0, "window": {"kind": "month"}}],
    "target": "qwen"}], "terminal": {"action": "reject"}}
check("tokens agent-scope without attribution -> reject",
      run(M._evaluate_routing("r", routing, {}, {}, deps(tokens=tokens_none))) == ("reject", None, None))
# tokens value + ok land in the eval log (trace shows the summed count)
log_t = []
run(M._evaluate_routing("r", routing, {}, {"devproof_agent": "a1"}, deps(tokens=tokens_2m), log=log_t))
check("tokens eval-log carries the summed value + ok",
      log_t[0]["conditions"][0]["type"] == "tokens" and log_t[0]["conditions"][0]["value"] == 2_000_000
      and log_t[0]["conditions"][0]["ok"] is True)

# cost ⇄ settings coupling (G2): a cost condition on a disabled ledger is
# skipped-with-reason (unmatched), the trace value says why.
cost_rule = lambda ledger: {"rules": [{"conditions": [
    {"type": "cost", "ledger": ledger, "scope": "key", "op": ">=", "threshold": 0, "window": {"kind": "month"}}],
    "target": "qwen"}], "terminal": {"action": "reject"}}
async def billing_off(): return {"enabled": True, "billing": {"enabled": False}}
async def tracking_off(): return {"enabled": False, "billing": {"enabled": True}}
log_b = []
run(M._evaluate_routing("r", cost_rule("billed"), {}, {"devproof_key_id": "k"},
    deps(settings=billing_off, cost=cost_60), log=log_b))
check("cost billed ledger skipped when billing disabled",
      log_b[0]["verdict"] == "no-match" and log_b[0]["conditions"][0]["ok"] is False
      and log_b[0]["conditions"][0]["value"] == "skipped: billing disabled")
log_r = []
run(M._evaluate_routing("r", cost_rule("real"), {}, {"devproof_key_id": "k"},
    deps(settings=tracking_off, cost=cost_60), log=log_r))
check("cost real ledger skipped when cost tracking disabled",
      log_r[0]["conditions"][0]["ok"] is False
      and log_r[0]["conditions"][0]["value"] == "skipped: cost tracking disabled")
# with the ledger enabled, the cost condition evaluates normally
log_ok = []
run(M._evaluate_routing("r", cost_rule("billed"), {}, {"devproof_key_id": "k"},
    deps(cost=cost_60), log=log_ok))
check("cost condition evaluates normally when its ledger is enabled",
      log_ok[0]["conditions"][0]["value"] == 60.0 and log_ok[0]["conditions"][0]["ok"] is True)

# cost scope without attribution never matches
routing = {"rules": [{"conditions": [
    {"type": "cost", "ledger": "billed", "scope": "agent", "op": ">=", "threshold": 0, "window": {"kind": "day"}}],
    "target": "qwen"}], "terminal": {"action": "reject"}}
async def cost_none(cond, md, name, target): return None
check("agent-scope cost without agent attribution -> reject",
      run(M._evaluate_routing("r", routing, {}, {}, deps(cost=cost_none))) == ("reject", None, None))

# available: Ready and Idle yes, Failed no, external yes
for target, want in (("qwen", True), ("big-ctx", True), ("broken", False), ("gpt4o", True)):
    routing = {"rules": [{"conditions": [{"type": "available"}], "target": target}],
               "terminal": {"action": "reject"}}
    got = run(M._evaluate_routing("r", routing, {}, {}, deps()))
    check(f"available {target}", (got[0] == "route") is want)

# split determinism via injected rand
routing = {"rules": [{"conditions": [{"type": "split", "percent": 10}], "target": "qwen"}],
           "terminal": {"action": "route", "target": "gpt4o"}}
check("split: rand 0.05 -> in bucket",
      run(M._evaluate_routing("r", routing, {}, {}, deps(rand=lambda: 0.05))) == ("route", "qwen", 0))
check("split: rand 0.50 -> falls through",
      run(M._evaluate_routing("r", routing, {}, {}, deps(rand=lambda: 0.5))) == ("route", "gpt4o", -1))

# time windows incl. overnight wrap (fixed clock)
from datetime import datetime, timezone
wed_10 = datetime(2026, 7, 15, 10, 0, tzinfo=timezone.utc)   # Wednesday
wed_23 = datetime(2026, 7, 15, 23, 30, tzinfo=timezone.utc)
check("time: inside business window", M._match_time({"days": ["wed"], "from": "09:00", "to": "18:00", "tz": "UTC"}, wed_10))
check("time: outside business window", not M._match_time({"days": ["wed"], "from": "09:00", "to": "18:00", "tz": "UTC"}, wed_23))
check("time: overnight wrap matches late evening", M._match_time({"from": "22:00", "to": "06:00", "tz": "UTC"}, wed_23))
check("time: overnight wrap rejects midday", not M._match_time({"from": "22:00", "to": "06:00", "tz": "UTC"}, wed_10))
check("time: bad tz never matches", not M._match_time({"from": "00:00", "to": "23:59", "tz": "Mars/Olympus"}, wed_10))

# context estimation drives the guard
big = {"messages": [{"role": "user", "content": "x" * 200000}]}
routing = {"rules": [{"conditions": [{"type": "context", "op": ">", "tokens": 30000}], "target": "gpt4o"}],
           "terminal": {"action": "route", "target": "qwen"}}
check("context guard routes big prompts", run(M._evaluate_routing("r", routing, big, {}, deps())) == ("route", "gpt4o", 0))
check("context guard passes small prompts",
      run(M._evaluate_routing("r", routing, {"messages": [{"role": "user", "content": "hi"}]}, {}, deps())) == ("route", "qwen", -1))

# label extraction (live finding 2026-07-16)
check("label: exact", M._extract_label("chat", {"code": "", "chat": ""}) == "chat")
check("label: prefix with echo", M._extract_label("code (programming related)", {"code": "", "chat": ""}) == "code")
check("label: word boundary", M._extract_label("the label is chat.", {"code": "", "chat": ""}) == "chat")
check("label: unknown -> None", M._extract_label("bananas", {"code": "", "chat": ""}) is None)

# condition error degrades to unmatched, terminal applies
async def boom(cond, md, name, target):
    raise RuntimeError("db down")
routing = {"rules": [{"conditions": [
    {"type": "cost", "ledger": "real", "scope": "key", "op": "<", "threshold": 1, "window": {"kind": "day"}}],
    "target": "qwen"}], "terminal": {"action": "reject"}}
check("condition error -> rule skipped -> reject terminal",
      run(M._evaluate_routing("r", routing, {}, {"devproof_key_id": "k"}, deps(cost=boom))) == ("reject", None, None))

# ── fix wave L: cold-cache hardening ────────────────────────────────────────
# targets UNKNOWN (cold-cache load failure, no stale value) -> route/reject
# terminal verbatim, WITHOUT fabricating an empty world (rules never checked).
async def unknown_targets():
    return None
routing = {"rules": [{"conditions": [], "target": "qwen"}], "terminal": {"action": "route", "target": "gpt4o"}}
check("targets unknown -> terminal route (verbatim, rules skipped)",
      run(M._evaluate_routing("r", routing, {}, {}, deps(targets=unknown_targets))) == ("route", "gpt4o", -1))
routing_reject = {"rules": [{"conditions": [], "target": "qwen"}], "terminal": {"action": "reject"}}
check("targets unknown + reject terminal -> reject",
      run(M._evaluate_routing("r", routing_reject, {}, {}, deps(targets=unknown_targets))) == ("reject", None, None))
log_u = []
run(M._evaluate_routing("r", routing, {}, {}, deps(targets=unknown_targets), log=log_u))
check("targets unknown -> no rules visited (no eval-log entries)", log_u == [])

# _get_routing cold-miss DB error (no cached entry) raises the sentinel;
# a stale cached entry still degrades gracefully (unchanged behavior).
async def _boom_db():
    raise RuntimeError("db down")
class _BoomPool:
    async def fetchrow(self, *a, **kw):
        raise RuntimeError("db down")
async def _boom_db_pool():
    return _BoomPool()
_real_db = M._db
M._db = _boom_db_pool
M._rules_cache.pop("cold-route", None)
try:
    run(M._get_routing("cold-route"))
    _raised = False
except M._RoutingLookupUnavailable:
    _raised = True
check("_get_routing cold-miss DB error raises _RoutingLookupUnavailable", _raised)
# a stale cached entry is served instead of raising
M._rules_cache["stale-route"] = (0.0, {"rules": [], "terminal": {"action": "reject"}})
r = run(M._get_routing("stale-route"))
check("_get_routing stale cache served on DB error (no raise)", r == {"rules": [], "terminal": {"action": "reject"}})
M._rules_cache.pop("stale-route", None)
M._db = _real_db  # restore before the pre_call_hook tests below

# async_pre_call_hook: cold-miss routing lookup -> 503 for EXTERNAL callers,
# pass-through (unresolved, direct-call fallback) for INTERNAL callers.
_real_get_routing = M._get_routing
async def _spy_boom_routing(name):
    raise M._RoutingLookupUnavailable(name)
M._get_routing = _spy_boom_routing
uak_ext2 = types.SimpleNamespace(metadata={})
data_ext2 = {"model": "some-routing"}
try:
    run(M.proxy_handler_instance.async_pre_call_hook(uak_ext2, None, data_ext2, "completion"))
    _cold_503 = None
except Exception as _e:
    _cold_503 = (getattr(_e, "status_code", None), getattr(_e, "headers", None))
check("cold routing lookup -> external caller 503 w/ Retry-After",
      _cold_503 is not None and _cold_503[0] == 503 and (_cold_503[1] or {}).get("Retry-After") == "5")
uak_int2 = types.SimpleNamespace(metadata={"devproof_internal": True})
data_int2 = {"model": "some-model"}
out2 = run(M.proxy_handler_instance.async_pre_call_hook(uak_int2, None, data_int2, "completion"))
check("cold routing lookup -> internal caller passes through unresolved", out2["model"] == "some-model")
M._get_routing = _real_get_routing  # restore the real implementation

# B1: per-rule evaluation log (out-param). Matched-rule case: rule 0 no-match
# (context guard), rule 1 matched (split 100%). Rules after the match aren't
# visited; conditions after the first failure aren't recorded.
log = []
routing = {"rules": [
    {"conditions": [{"type": "context", "op": ">", "tokens": 30000},
                    {"type": "split", "percent": 100}], "target": "qwen"},
    {"conditions": [{"type": "split", "percent": 100}], "target": "gpt4o"},
    {"conditions": [], "target": "big-ctx"}], "terminal": {"action": "reject"}}
small = {"messages": [{"role": "user", "content": "hi"}]}
r = run(M._evaluate_routing("r", routing, small, {}, deps(rand=lambda: 0.5), log=log))
check("eval-log: matched rule 1 wins", r == ("route", "gpt4o", 1))
check("eval-log: exactly 2 rules visited (rule 2 not evaluated)", len(log) == 2)
check("eval-log: rule 0 no-match on failing context, split not recorded",
      log[0]["rule"] == 0 and log[0]["target"] == "qwen" and log[0]["verdict"] == "no-match"
      and [c["type"] for c in log[0]["conditions"]] == ["context"]
      and log[0]["conditions"][0]["ok"] is False and isinstance(log[0]["conditions"][0]["value"], int))
check("eval-log: rule 1 matched with split value + ok",
      log[1]["rule"] == 1 and log[1]["verdict"] == "matched"
      and log[1]["conditions"][0]["type"] == "split" and log[1]["conditions"][0]["ok"] is True
      and log[1]["conditions"][0]["value"] == 50.0)
check("eval-log: condition entry carries the original cond dict verbatim",
      log[1]["conditions"][0]["cond"] == {"type": "split", "percent": 100})

# B1: fall-through to terminal — every rule visited & no-match/missing-target,
# no "matched" entry.
log2 = []
routing = {"rules": [{"conditions": [{"type": "split", "percent": 0}], "target": "qwen"},
                     {"conditions": [], "target": "deleted-model"}],
           "terminal": {"action": "route", "target": "gpt4o"}}
r = run(M._evaluate_routing("r", routing, small, {}, deps(rand=lambda: 0.9), log=log2))
check("eval-log: fall-through routes terminal", r == ("route", "gpt4o", -1))
check("eval-log: fall-through visits all rules, none matched",
      len(log2) == 2 and log2[0]["verdict"] == "no-match"
      and log2[1]["verdict"] == "missing-target" and log2[1]["conditions"] == []
      and all(rv["verdict"] != "matched" for rv in log2))

# devproof_direct escape hatch (spec 2026-07-16): under name shadowing a
# routing may share a deployment name. Drive the real async_pre_call_hook with
# a _get_routing spy + a no-op trace poller to prove the marker skips routing
# resolution for internal callers and is ignored for external callers.
_calls = {"n": 0}
async def _spy_get_routing(name):
    _calls["n"] += 1
    return None            # returns None so external falls to the routing-only 403
M._get_routing = _spy_get_routing
async def _noop_poller():
    return None
M._ensure_trace_poller = _noop_poller

# internal + direct marker + routing-named model → resolution skipped entirely
_calls["n"] = 0
uak_int = types.SimpleNamespace(metadata={"devproof_internal": True})
data_int = {"model": "qwen", "metadata": {"devproof_direct": True}}
out = run(M.proxy_handler_instance.async_pre_call_hook(uak_int, None, data_int, "completion"))
check("devproof_direct (internal): _get_routing not called (resolution skipped)", _calls["n"] == 0)
check("devproof_direct (internal): data['model'] unchanged", out["model"] == "qwen")

# external + direct marker → marker IGNORED: resolution runs; a bare
# (non-routing) name still hits the routing-only 403.
_calls["n"] = 0
uak_ext = types.SimpleNamespace(metadata={})
data_ext = {"model": "qwen", "metadata": {"devproof_direct": True}}
try:
    run(M.proxy_handler_instance.async_pre_call_hook(uak_ext, None, data_ext, "completion"))
    _ext_403 = False
except Exception as _e:
    _ext_403 = getattr(_e, "status_code", None) == 403
check("devproof_direct ignored for external: _get_routing still called", _calls["n"] == 1)
check("devproof_direct ignored for external: bare name 403s", _ext_403)

# ── Auto-compact usage injection (spec 2026-07-16) ──────────────────────────
# _inject_prompt_estimate raises the input_tokens the CLI reads on the
# /v1/messages bridge (message_start seeds 0; the final message_delta overwrites
# it, so both must carry >= est).
import json as _json
# dict form (offline / non-bridge surfaces)
ms = M._inject_prompt_estimate({"type": "message_start",
    "message": {"usage": {"input_tokens": 0, "output_tokens": 0}}}, 1234)
check("inject dict: message_start 0 -> est", ms["message"]["usage"]["input_tokens"] == 1234)
md = M._inject_prompt_estimate({"type": "message_delta",
    "usage": {"input_tokens": 4, "output_tokens": 40}}, 1234)
check("inject dict: message_delta small input raised to est", md["usage"]["input_tokens"] == 1234)
md2 = M._inject_prompt_estimate({"type": "message_delta",
    "usage": {"input_tokens": 5000, "output_tokens": 40}}, 1234)
check("inject dict: message_delta larger input left alone", md2["usage"]["input_tokens"] == 5000)

# bytes SSE frames — the real /v1/messages bridge shape the hook receives.
frame = (b'event: message_start\ndata: {"type": "message_start", "message": '
         b'{"id": "msg_x", "role": "assistant", "content": [], '
         b'"usage": {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0}}}\n\n')
outb = M._inject_prompt_estimate(frame, 1234)
data_line = [l for l in outb.decode().split("\n") if l.startswith("data:")][0][5:].strip()
obj = _json.loads(data_line)
check("inject bytes: message_start input_tokens -> est", obj["message"]["usage"]["input_tokens"] == 1234)
check("inject bytes: returns bytes, frame terminator preserved", isinstance(outb, bytes) and outb.endswith(b"\n\n"))
check("inject bytes: other usage fields preserved", obj["message"]["usage"]["cache_read_input_tokens"] == 0)

dframe = 'event: message_delta\ndata: {"type": "message_delta", "usage": {"input_tokens": 4, "output_tokens": 40}}\n\n'
outd = M._inject_prompt_estimate(dframe, 9000)
obj2 = _json.loads([l for l in outd.split("\n") if l.startswith("data:")][0][5:].strip())
check("inject str: message_delta input raised to est", obj2["usage"]["input_tokens"] == 9000)

cbframe = b'event: content_block_delta\ndata: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "x"}}\n\n'
check("inject bytes: non-usage frame untouched", M._inject_prompt_estimate(cbframe, 1234) == cbframe)
check("inject: est<=0 no-op", M._inject_prompt_estimate(frame, 0) == frame)
check("inject: [DONE] frame untouched", M._inject_prompt_estimate(b"data: [DONE]\n\n", 1234) == b"data: [DONE]\n\n")
check("inject: unknown type passes through", M._inject_prompt_estimate(42, 1234) == 42)

# Full hook: SANITIZE-class model rewrites message_start; a non-usage chunk and
# the final delta flow through with the estimate applied. (In-harness the config
# path is absent so SCRUB_ALL is True — the model gate is satisfied for any name.)
async def _aiter(items):
    for it in items:
        yield it
async def _drive_hook(model, chunks):
    out = []
    resp = _aiter(chunks)
    async for c in M.proxy_handler_instance.async_post_call_streaming_iterator_hook(
            types.SimpleNamespace(metadata={}), resp, {"model": model,
            "messages": [{"role": "user", "content": "x" * 8000}]}):
        out.append(c)
    return out
chunks_in = [
    b'event: message_start\ndata: {"type": "message_start", "message": {"usage": {"input_tokens": 0, "output_tokens": 0}}}\n\n',
    b'event: content_block_delta\ndata: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "hi"}}\n\n',
    b'event: message_delta\ndata: {"type": "message_delta", "usage": {"input_tokens": 3, "output_tokens": 7}}\n\n',
]
hooked = run(_drive_hook("qwen05b-dp", list(chunks_in)))
_est = M._estimate_tokens({"messages": [{"role": "user", "content": "x" * 8000}]})
def _usage(frame):
    return _json.loads([l for l in frame.decode().split("\n") if l.startswith("data:")][0][5:].strip())
check("hook: 3 chunks streamed through", len(hooked) == 3)
check("hook: message_start input_tokens injected (>0)", _usage(hooked[0])["message"]["usage"]["input_tokens"] == _est and _est > 0)
check("hook: content_block_delta passthrough", hooked[1] == chunks_in[1])
check("hook: message_delta input raised to est", _usage(hooked[2])["usage"]["input_tokens"] == _est)

# ── B2: rejected/unavailable requests emit trace events ────────────────────
# A terminal reject/unavailable verdict raises from async_pre_call_hook BEFORE
# the normal request-capture block runs; the fix emits best-effort trace
# events (request + error) from inside the reject/unavailable branches
# themselves when the routing name is subscribed. Drive the real hook
# end-to-end with _emit_trace_multi captured (fake _targets avoids a real DB
# round-trip so the eval-log is populated exactly like the live path).
_captured = []
def _spy_emit(keys, event):
    _captured.append((keys, event))
_real_emit_trace_multi = M._emit_trace_multi
_real_targets_fn = M._targets
M._emit_trace_multi = _spy_emit
async def _fake_targets_b2():
    return TARGETS
M._targets = _fake_targets_b2

async def _reject_routing(name):
    return {"rules": [{"conditions": [{"type": "context", "op": ">", "tokens": 1999999}], "target": "qwen"}],
            "terminal": {"action": "reject"}}
M._get_routing = _reject_routing
M._trace_subs = {"t-reject": {"http://fake-cp"}}
uak_rej = types.SimpleNamespace(metadata={"devproof_key_id": "k1"})
data_rej = {"model": "t-reject", "messages": [{"role": "user", "content": "hi"}]}
_captured.clear()
try:
    run(M.proxy_handler_instance.async_pre_call_hook(uak_rej, None, data_rej, "completion"))
    _rej_403 = None
except Exception as _e:
    _rej_403 = getattr(_e, "status_code", None)
check("B2 reject: still 403s", _rej_403 == 403)
check("B2 reject: emits exactly 2 trace events (request + error)", len(_captured) == 2)
req_ev = _captured[0][1] if _captured else {}
err_ev = _captured[1][1] if len(_captured) > 1 else {}
check("B2 reject: request event carries routing/target/rule/rejected + evaluation",
      _captured and _captured[0][0] == ("t-reject",) and req_ev.get("kind") == "request"
      and req_ev.get("deployment") is None and req_ev.get("routing") == "t-reject"
      and req_ev.get("target") is None and req_ev.get("rule") == -1
      and req_ev.get("rejected") is True
      and isinstance(req_ev.get("evaluation"), list) and len(req_ev["evaluation"]) == 1
      and req_ev["evaluation"][0]["verdict"] == "no-match")
check("B2 reject: error event shares the request's trace id",
      err_ev.get("kind") == "error" and err_ev.get("id") == req_ev.get("id")
      and err_ev.get("routing") == "t-reject" and err_ev.get("error") == "no routing rule matched")

# unavailable path: terminal routes to a target that doesn't exist -> 503 +
# an "unavailable" marker instead of "rejected".
async def _unavailable_routing(name):
    return {"rules": [], "terminal": {"action": "route", "target": "gone-model"}}
M._get_routing = _unavailable_routing
_captured.clear()
try:
    run(M.proxy_handler_instance.async_pre_call_hook(uak_rej, None, {"model": "t-reject", "messages": []}, "completion"))
    _unavail_503 = None
except Exception as _e:
    _unavail_503 = getattr(_e, "status_code", None)
check("B2 unavailable: still 503s", _unavail_503 == 503)
check("B2 unavailable: emits 2 trace events", len(_captured) == 2)
check("B2 unavailable: request event carries the unavailable marker (not rejected)",
      _captured and _captured[0][1].get("unavailable") is True and _captured[0][1].get("rejected") is None)
check("B2 unavailable: error event text",
      len(_captured) > 1 and _captured[1][1].get("error") == "routing target unavailable")

# no open trace window -> best-effort skip, still 403s, nothing emitted.
M._get_routing = _reject_routing
M._trace_subs = {}
_captured.clear()
try:
    run(M.proxy_handler_instance.async_pre_call_hook(uak_rej, None, {"model": "t-reject", "messages": []}, "completion"))
except Exception:
    pass
check("B2: no subscriber -> no trace events emitted", _captured == [])

M._emit_trace_multi = _real_emit_trace_multi
M._targets = _real_targets_fn
M._get_routing = _real_get_routing
M._trace_subs = {}

# trace tool_names: both wire shapes, non-dict entries skipped, capped at 200.
check("tool_names: anthropic + openai shapes, junk skipped",
      M._tool_names({"tools": [{"name": "Bash"},
                               {"type": "function", "function": {"name": "mcp__c7__query-docs"}},
                               "junk", {"nameless": True}]}) == ["Bash", "mcp__c7__query-docs"])
check("tool_names: no tools -> empty", M._tool_names({}) == [])
check("tool_names: capped at 200",
      len(M._tool_names({"tools": [{"name": f"t{i}"} for i in range(250)]})) == 200)

print(f"\n{len(FAILS)} failure(s)")
sys.exit(1 if FAILS else 0)
