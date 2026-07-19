# Devproof gateway hooks — three responsibilities:
#  1. Schema sanitizer (DON'T REGRESS — Claude Code on GGUF breaks without it):
#     strips string bounds >1024 and backslash-class regex patterns that
#     llama.cpp's GBNF grammar parser rejects ("failed to parse grammar").
#  2. custom_auth: enforce console-managed API keys (api_keys table, sha256,
#     status='active'), 30s TTL cache, fail closed. Internal session-pod key
#     via DEVPROOF_INTERNAL_KEY env (gateway-auth Secret).
#  3. Metering: one gateway_usage row per successful external request
#     (spike-verified fields: standard_logging_object prompt/completion_tokens
#     + metadata.user_api_key_auth_metadata). Attribution uses model_group
#     (the requested deployment name) — kwargs["model"] is the RESOLVED
#     backend model and attributes wrongly for external aliases (live-bug
#     2026-07-09).
#  4. Scale-to-zero hold (spec 2026-07-15): requests for Idle models INSERT
#     a wake request + NOTIFY devproof_wake, then hold until model_routing
#     says 'ready' (cutoff 300s -> 503 Retry-After). Internal-key traffic
#     BYPASSES the hold — holding the CP's warmup would deadlock the wake.
#  5. Routing (spec 2026-07-16): model=<routing> resolves through the
#     routings table (rules cached 2s, stale-tolerant) BEFORE the hold;
#     external keys are routing-only; rejects 403 + routing_rejects row.
import asyncio, hashlib, hmac, os, time

import asyncpg
from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy._types import UserAPIKeyAuth

# NOTE: deliberately NOT named DATABASE_URL — LiteLLM's proxy_server
# auto-detects that exact env var name and switches into its own
# Prisma-managed "enterprise DB" mode, which runs a destructive
# migrate/baseline against the *shared* Postgres "public" schema on
# startup (verified live: it dropped api_keys/gateway_usage/all
# devproof app tables). DEVPROOF_DATABASE_URL avoids that entirely.
DATABASE_URL = os.environ.get("DEVPROOF_DATABASE_URL", "")
INTERNAL_KEY = os.environ.get("DEVPROOF_INTERNAL_KEY", "")
CACHE_TTL = 30.0          # seconds; also the max revocation latency
NEG_CACHE_TTL = 5.0       # seconds; invalid keys re-checked at most this often
TOUCH_INTERVAL = 60.0     # min seconds between last_used_at writes per key
CACHE_MAX = 10_000        # cap on _cache size; bounds bad-key-spray memory growth

MAX_BOUND = 1024

WAKE_HOLD_MAX = 300.0   # seconds a request may hold while its model wakes
WAKE_POLL = 2.0         # model_routing re-check interval while holding
ROUTING_TTL = 2.0       # per-process model_routing cache TTL

CONFIG_PATH = "/etc/litellm/config.yaml"

def _load_sanitize_models():
    # Sanitizer scope: llama.cpp/GGUF backends need GBNF scrubbing — that's
    # local cluster models AND custom-provider endpoints (OpenAI-compatible
    # local servers, typically llama.cpp). Named APIs (openai/anthropic/
    # openrouter) get full-fidelity schemas. Flagged via model_info.
    # devproof_sanitize. On ANY parse failure scrub EVERYTHING — degrade
    # toward loose schemas, never toward broken llama.cpp backends.
    try:
        import yaml
        with open(CONFIG_PATH) as f:
            cfg = yaml.safe_load(f) or {}
        names = {m.get("model_name") for m in (cfg.get("model_list") or [])
                 if (m.get("model_info") or {}).get("devproof_sanitize")}
        print(f"devproof-sanitizer: scrubbing {sorted(names)}", flush=True)
        return names, False
    except Exception as e:  # noqa: BLE001
        print(f"devproof-sanitizer: config parse failed, scrubbing all models: {e}", flush=True)
        return set(), True

SANITIZE_MODELS, SCRUB_ALL = _load_sanitize_models()

def _load_reasoning_efforts():
    # {model_name: effort} from model_info.devproof_reasoning_effort
    # (spec 2026-07-12). Parse failure -> empty map: requests pass
    # through untouched; never degrade toward failing requests.
    try:
        import yaml
        with open(CONFIG_PATH) as f:
            cfg = yaml.safe_load(f) or {}
        efforts = {m.get("model_name"): (m.get("model_info") or {}).get("devproof_reasoning_effort")
                   for m in (cfg.get("model_list") or [])
                   if (m.get("model_info") or {}).get("devproof_reasoning_effort")}
        if efforts:
            print(f"devproof-reasoning: defaults {efforts}", flush=True)
        return efforts
    except Exception as e:  # noqa: BLE001
        print(f"devproof-reasoning: config parse failed, no defaults: {e}", flush=True)
        return {}

REASONING_EFFORTS = _load_reasoning_efforts()

def _scrub(node):
    if isinstance(node, dict):
        for key in ("maxLength", "minLength"):
            v = node.get(key)
            if isinstance(v, int) and v > MAX_BOUND:
                node.pop(key, None)
        p = node.get("pattern")
        if isinstance(p, str) and "\\" in p:
            node.pop("pattern", None)
        for v in node.values():
            _scrub(v)
    elif isinstance(node, list):
        for v in node:
            _scrub(v)

_pool = None
_pool_lock = asyncio.Lock()

async def _db():
    global _pool
    if _pool is None:
        async with _pool_lock:
            if _pool is None:
                _pool = await asyncpg.create_pool(DATABASE_URL, min_size=0, max_size=4)
    return _pool

_routing_cache = {}   # model -> (expires_monotonic, state|None)

def _routing_cache_put(model, entry, now):
    # async_pre_call_hook runs BEFORE litellm validates the model name,
    # so any authenticated caller can spray distinct fake model names to
    # grow this dict forever; bound it the same way as the auth _cache
    # (evict expired entries; clear all if still full).
    if len(_routing_cache) >= CACHE_MAX:
        expired = [k for k, v in _routing_cache.items() if v[0] <= now]
        for k in expired:
            _routing_cache.pop(k, None)
        if len(_routing_cache) >= CACHE_MAX:
            _routing_cache.clear()
    _routing_cache[model] = entry

async def _routing_state(model):
    """model_routing row for a local deployment; None = no row (external/
    unknown/deleted model) -> never hold. Small TTL cache keeps the hot
    path at ~zero DB cost."""
    now = time.monotonic()
    hit = _routing_cache.get(model)
    if hit and hit[0] > now:
        return hit[1]
    pool = await _db()
    row = await pool.fetchrow("SELECT state FROM model_routing WHERE model = $1", model)
    state = row["state"] if row else None
    _routing_cache_put(model, (now + ROUTING_TTL, state), now)
    return state

async def _hold_for_wake(model, send_signal):
    """Scale-to-zero (spec 2026-07-15): signal the CP to wake the model,
    then hold this request until it is routable. litellm awaits pre-call
    hooks with a bare await (no timeout wrapper, verified 1.91.1) and the
    sleep/wake transition never changes gateway config, so held
    connections survive; the bound is the client's own timeout.

    send_signal is False for an already-'waking' model (final review I1):
    a CP restart briefly projects every Ready model as 'waking' (warmedModels
    is empty), and an unconditional NOTIFY here would wake the CP into
    re-patching target-replicas to "1", stomping the scaler's higher
    annotation on a busy min>0 deployment. Only an 'idle' model signals;
    'waking' just holds and polls until routing flips to 'ready'."""
    if send_signal:
        pool = await _db()
        await pool.execute(
            "INSERT INTO wake_requests (model) VALUES ($1) ON CONFLICT (model) DO NOTHING", model)
        await pool.execute("SELECT pg_notify('devproof_wake', $1)", model)
    deadline = time.monotonic() + WAKE_HOLD_MAX
    while time.monotonic() < deadline:
        await asyncio.sleep(WAKE_POLL)
        state = await _routing_state(model)
        if state == "ready":
            return
        if state is None:
            break  # deployment deleted while waking
    raise HTTPException(status_code=503,
                        detail=f"model {model} is waking from scale-to-zero - retry shortly",
                        headers={"Retry-After": "60"})

# ── Routing (spec 2026-07-16): resolve model=<routing> to a target. ──
# Evaluation degrades, never 500s: a failing condition counts as
# unmatched; the rules cache serves stale on DB errors (budgets stay
# hard via the reject terminal, availability degrades gracefully).
RULES_TTL = 2.0
TARGETS_TTL = 2.0
COST_TTL = 30.0
SETTINGS_TTL = 30.0
CLASSIFY_MAX_TOKENS = 512   # reasoning models think before the label
CLASSIFY_TIMEOUT = 90.0

_rules_cache = {}     # name -> (expires, parsed_row_or_None)
_targets_cache = None  # (expires, {"phases": {local: phase}, "external": set()})
# Shared cost/token cache — keys are prefixed with the condition type
# ("cost",...) / ("tokens",...) so the two never collide.
_cost_cache = {}      # ("cost", scope, ledger, ref, wkind, whours) | ("tokens", scope, ref, wkind, whours) -> (expires, value)
_settings_cache = None  # (expires, {"enabled": bool, "billing": {"enabled": bool}})

class _RoutingLookupUnavailable(Exception):
    """Sentinel (fix wave L): _get_routing DB error with NO cached entry
    to fall back on (cold cache right after a rollout). Distinct from a
    legitimate "no such routing" (parsed=None, cached) so the caller can
    503 an EXTERNAL caller instead of misrouting it into the
    routing-only 403 with a misleading "not a routing" message. Internal
    callers ignore this (direct-call fallback is harmless there)."""

async def _get_routing(name):
    import json as _json
    now = time.monotonic()
    hit = _rules_cache.get(name)
    if hit and hit[0] > now:
        return hit[1]
    try:
        pool = await _db()
        row = await pool.fetchrow("SELECT rules, terminal FROM routings WHERE name = $1", name)
        parsed = None
        if row:
            parsed = {"rules": _json.loads(row["rules"]), "terminal": _json.loads(row["terminal"])}
        if len(_rules_cache) >= CACHE_MAX:
            _rules_cache.clear()
        _rules_cache[name] = (now + RULES_TTL, parsed)
        return parsed
    except Exception as e:  # noqa: BLE001 — stale-tolerant
        print(f"devproof-routing: rules load failed ({'stale' if hit else 'miss'}): {e}", flush=True)
        if hit:
            return hit[1]
        raise _RoutingLookupUnavailable(name) from e

async def _fetch_targets():
    pool = await _db()
    loc = await pool.fetch("SELECT model, phase FROM model_routing")
    ext = await pool.fetch("SELECT name FROM external_deployments")
    return {"phases": {r["model"]: (r["phase"] or "") for r in loc},
            "external": {r["name"] for r in ext}}

async def _targets():
    # Cold cache (fresh pod right after a rollout): a load failure with
    # no cached value used to fall back to {} — an EMPTY world that
    # makes every rule/terminal target look "missing" for a few seconds
    # after every gateway roll (fix wave L). Retry once after a short
    # backoff; if that also fails, return None (UNKNOWN) rather than
    # fabricate an empty world — _evaluate_routing degrades that to the
    # terminal target verbatim. A stale cached value still beats both.
    global _targets_cache
    now = time.monotonic()
    if _targets_cache and _targets_cache[0] > now:
        return _targets_cache[1]
    try:
        val = await _fetch_targets()
    except Exception as e:  # noqa: BLE001
        print(f"devproof-routing: targets load failed: {e}", flush=True)
        if _targets_cache:
            return _targets_cache[1]  # stale beats empty
        await asyncio.sleep(0.5)
        try:
            val = await _fetch_targets()
        except Exception as e2:  # noqa: BLE001
            print(f"devproof-routing: targets retry failed: {e2}", flush=True)
            return None  # UNKNOWN: never fabricate an empty world
    _targets_cache = (now + TARGETS_TTL, val)
    return val

def _window_start(window):
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)   # calendar windows are UTC (spec)
    k = (window or {}).get("kind")
    if k == "month":
        return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if k == "day":
        return now.replace(hour=0, minute=0, second=0, microsecond=0)
    return now - timedelta(hours=float((window or {}).get("hours") or 1))

async def _consumed_cost(cond, md, routing_name, target):
    """Accumulated spend for the condition's scope, or None when the
    request carries no such attribution (condition then never matches).
    Deployment costs only — token spend via gateway_usage (+ deployment/
    pool time for target-real); session/env pod time NEVER counts (user
    decision 2026-07-16)."""
    scope = cond.get("scope")
    ledger = "billed_cost" if cond.get("ledger") == "billed" else "real_cost"   # whitelist, safe to interpolate
    ref = {"key": md.get("devproof_key_id"), "workspace": md.get("devproof_workspace"),
           "agent": md.get("devproof_agent"), "routing": routing_name, "target": target}.get(scope)
    if not ref:
        return None
    w = cond.get("window") or {}
    ck = ("cost", scope, ledger, ref, w.get("kind"), w.get("hours"))
    now = time.monotonic()
    hit = _cost_cache.get(ck)
    if hit and hit[0] > now:
        return hit[1]
    start = _window_start(w)
    pool = await _db()
    if scope == "key":
        v = await pool.fetchval(f"SELECT COALESCE(sum({ledger}),0) FROM gateway_usage WHERE api_key_id = $1 AND created_at >= $2", ref, start)
    elif scope == "workspace":
        v = await pool.fetchval(f"SELECT COALESCE(sum({ledger}),0) FROM gateway_usage WHERE workspace_id = $1 AND created_at >= $2", ref, start)
    elif scope == "agent":
        v = await pool.fetchval(f"SELECT COALESCE(sum({ledger}),0) FROM gateway_usage WHERE agent_id = $1 AND created_at >= $2", ref, start)
    elif scope == "routing":
        v = await pool.fetchval(f"SELECT COALESCE(sum({ledger}),0) FROM gateway_usage WHERE routing = $1 AND created_at >= $2", ref, start)
    else:  # target
        a = await pool.fetchval(f"SELECT COALESCE(sum({ledger}),0) FROM gateway_usage WHERE model = $1 AND created_at >= $2", ref, start)
        b = 0.0
        if ledger == "real_cost":
            b = await pool.fetchval("SELECT COALESCE(sum(real_cost),0) FROM cost_entries WHERE deployment = $1 AND ts >= $2 AND kind IN ('pool_pod','deployment_time')", ref, start)
        v = float(a) + float(b or 0)
    v = float(v or 0)
    if len(_cost_cache) >= CACHE_MAX:
        _cost_cache.clear()
    _cost_cache[ck] = (now + COST_TTL, v)
    return v

async def _consumed_tokens(cond, md, routing_name, target):
    """Total tokens (in+out) consumed for the condition's scope, or None
    when the request carries no such attribution (condition then never
    matches). Tokens are ALWAYS metered — independent of cost/billing
    settings — and live only in gateway_usage (no cost_entries ledger)."""
    scope = cond.get("scope")
    ref = {"key": md.get("devproof_key_id"), "workspace": md.get("devproof_workspace"),
           "agent": md.get("devproof_agent"), "routing": routing_name, "target": target}.get(scope)
    if not ref:
        return None
    w = cond.get("window") or {}
    ck = ("tokens", scope, ref, w.get("kind"), w.get("hours"))
    now = time.monotonic()
    hit = _cost_cache.get(ck)
    if hit and hit[0] > now:
        return hit[1]
    start = _window_start(w)
    col = {"key": "api_key_id", "workspace": "workspace_id", "agent": "agent_id",
           "routing": "routing", "target": "model"}[scope]   # whitelist, safe to interpolate
    pool = await _db()
    v = await pool.fetchval(
        f"SELECT COALESCE(sum(tokens_in),0)+COALESCE(sum(tokens_out),0) "
        f"FROM gateway_usage WHERE {col} = $1 AND created_at >= $2", ref, start)
    v = int(v or 0)
    if len(_cost_cache) >= CACHE_MAX:
        _cost_cache.clear()
    _cost_cache[ck] = (now + COST_TTL, v)
    return v

async def _cost_settings():
    """Cost/billing enablement from app_settings (spec G2). A cost
    condition on a disabled ledger never matches — this feeds the
    skip-with-reason in _cond_ok. Stale-tolerant like the rules cache."""
    global _settings_cache
    import json as _json
    now = time.monotonic()
    if _settings_cache and _settings_cache[0] > now:
        return _settings_cache[1]
    try:
        pool = await _db()
        row = await pool.fetchrow("SELECT data->'costs' AS costs FROM app_settings WHERE id = 'global'")
        costs = row["costs"] if row else None
        if isinstance(costs, str):
            costs = _json.loads(costs)
        costs = costs or {}
        val = {"enabled": bool(costs.get("enabled")),
               "billing": {"enabled": bool((costs.get("billing") or {}).get("enabled"))}}
        _settings_cache = (now + SETTINGS_TTL, val)
        return val
    except Exception as e:  # noqa: BLE001 — stale-tolerant
        print(f"devproof-routing: settings load failed: {e}", flush=True)
        return _settings_cache[1] if _settings_cache else {"enabled": False, "billing": {"enabled": False}}

def _estimate_tokens(data):
    import json as _json
    n = len(_json.dumps(data.get("messages") or [], default=str))
    for k in ("system", "tools"):
        if data.get(k):
            n += len(_json.dumps(data.get(k), default=str))
    return n // 4

def _bump_usage_dict(obj, est):
    """Raise input_tokens on an Anthropic message_start / message_delta
    event dict to at least est (in place). Returns True if it changed."""
    t = obj.get("type")
    if t == "message_start":
        u = (obj.get("message") or {}).get("usage")
    elif t == "message_delta":
        u = obj.get("usage")
    else:
        return False
    if isinstance(u, dict) and (u.get("input_tokens") or 0) < est:
        u["input_tokens"] = est
        return True
    return False

def _rewrite_sse_usage(frame, est):
    """Rewrite the input_tokens inside an SSE frame's `data: {json}` line
    (message_start / message_delta only). WHOLE-FRAME dependency: the
    iterator hook wraps LiteLLM's SSE generator, which yields complete
    `event:...\\ndata:...\\n\\n` frames — a frame split across chunks
    would fail json.loads and pass through unmodified (safe, but that
    stream's compaction trigger stays blind). Returns the modified frame text,
    or None when nothing changed. Structure/newlines are preserved so the
    Anthropic SSE ordering the CLI parses stays intact."""
    if "message_start" not in frame and "message_delta" not in frame:
        return None
    import json as _json
    lines = frame.split("\n")
    changed = False
    for i, ln in enumerate(lines):
        if not ln.startswith("data:"):
            continue
        payload = ln[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            obj = _json.loads(payload)
        except Exception:  # noqa: BLE001
            continue
        if isinstance(obj, dict) and _bump_usage_dict(obj, est):
            lines[i] = "data: " + _json.dumps(obj)
            changed = True
    return "\n".join(lines) if changed else None

def _inject_prompt_estimate(chunk, est):
    """Auto-compact trigger fix (spec 2026-07-16): raise the input_tokens
    the Claude Code CLI reads off a /v1/messages-bridge stream so its
    context counter reflects the real prompt size. The bridge's Anthropic
    adapter hardcodes message_start usage.input_tokens=0 and reports real
    counts only in the FINAL message_delta, which the SDK accumulator then
    OVERWRITES input_tokens from — so BOTH must carry >= est or the CLI
    reads ~0 and never compacts (see the hook). The proxy hands this hook
    ALREADY-SERIALIZED SSE frames (bytes/str: 'event: <t>\\ndata: {json}\\n\\n')
    on the /v1/messages surface, so rewrite the JSON payload; a raw dict is
    handled too (offline tests / other surfaces). Returns the (possibly
    rewritten) chunk; anything unrecognized passes through untouched."""
    if est <= 0:
        return chunk
    if isinstance(chunk, (bytes, bytearray)):
        try:
            out = _rewrite_sse_usage(chunk.decode("utf-8"), est)
        except Exception:  # noqa: BLE001
            return chunk
        return out.encode("utf-8") if out is not None else chunk
    if isinstance(chunk, str):
        out = _rewrite_sse_usage(chunk, est)
        return out if out is not None else chunk
    if isinstance(chunk, dict):
        _bump_usage_dict(chunk, est)
    return chunk

def _match_time(cond, now=None):
    from datetime import datetime, timezone
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(cond.get("tz") or "UTC")
    except Exception:  # noqa: BLE001 — unknown tz never matches
        return False
    local = (now or datetime.now(timezone.utc)).astimezone(tz)
    days = cond.get("days")
    if days and ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][local.weekday()] not in days:
        return False
    def _m(s):
        h, m = (s or "00:00").split(":")
        return int(h) * 60 + int(m)
    cur, f, t = local.hour * 60 + local.minute, _m(cond.get("from")), _m(cond.get("to"))
    return (f <= cur < t) if f <= t else (cur >= f or cur < t)   # from>to wraps overnight

def _extract_label(txt, labels):
    # Prefix/word-boundary, NOT equality — models echo the label with its
    # description ("code (programming related)", observed live 2026-07-16).
    import re as _re
    t = (txt or "").strip().lower()
    for lab in sorted(labels, key=len, reverse=True):
        l = lab.lower()
        if t.startswith(l) or _re.search(r"\b" + _re.escape(l) + r"\b", t):
            return lab
    return None

async def _classify(cond, data, req_cache, routing_name):
    """One classifier verdict per (deployment) per request. Idle
    classifier: fire the wake (internal traffic bypasses the hold, so
    nothing else would ever wake it — reproduced live) and count this
    request as unmatched; self-heals within a wake (~40s)."""
    import json as _json
    dep = cond.get("deployment")
    if dep not in req_cache:
        label = None
        state = await _routing_state(dep)
        if state == "idle":
            try:
                pool = await _db()
                await pool.execute("INSERT INTO wake_requests (model) VALUES ($1) ON CONFLICT (model) DO NOTHING", dep)
                await pool.execute("SELECT pg_notify('devproof_wake', $1)", dep)
            except Exception as e:  # noqa: BLE001
                print(f"devproof-routing: classifier wake failed: {e}", flush=True)
        elif state == "ready" or state is None:
            last = ""
            for m in reversed(data.get("messages") or []):
                if m.get("role") == "user":
                    c = m.get("content")
                    last = c if isinstance(c, str) else _json.dumps(c, default=str)
                    break
            labels = cond.get("labels") or {}
            prompt = ("Classify the following request into exactly one label: "
                      + ", ".join(f"{k} ({v})" for k, v in labels.items())
                      + ". Answer with only the label, nothing else.\n\nRequest: " + last[:2000])
            try:
                import httpx
                async with httpx.AsyncClient(timeout=CLASSIFY_TIMEOUT) as c:
                    r = await c.post("http://localhost:4000/v1/chat/completions",
                        headers={"Authorization": f"Bearer {INTERNAL_KEY}"},
                        json={"model": dep, "max_tokens": CLASSIFY_MAX_TOKENS, "temperature": 0,
                              # classification overhead bills to the routing
                              # (devproof_routing/-2 stamp). devproof_direct
                              # (spec 2026-07-16): this internal call names the
                              # deployment directly and must NOT recurse into a
                              # same-named shadowing routing.
                              "metadata": {"devproof_routing": routing_name, "devproof_routing_rule": -2, "devproof_direct": True},
                              "messages": [{"role": "user", "content": prompt}]})
                    if r.status_code == 200:
                        msg = ((r.json().get("choices") or [{}])[0].get("message") or {})
                        label = _extract_label(msg.get("content") or "", labels)
            except Exception as e:  # noqa: BLE001
                print(f"devproof-routing: classify via {dep} failed: {e}", flush=True)
        req_cache[dep] = label
    label = req_cache[dep]
    return label is not None and label in (cond.get("match") or [])

async def _evaluate_routing(name, routing, data, md, deps=None, log=None):
    """First rule whose conditions ALL match wins; errors degrade to
    unmatched. -> ("route", target, idx) | ("reject", None, None) |
    ("unavailable", target, -1). deps overrides IO for offline tests.
    log (optional list) collects one entry per VISITED rule for the trace:
    {"rule", "target", "verdict", "conditions":[{"type","value","ok","cond"}]}.
    cond is the original condition dict, for a full readable summary.
    Rules after the first match and conditions after the first failing one
    are NOT visited, so they never appear."""
    import random as _random
    d = {"targets": _targets, "cost": _consumed_cost, "tokens": _consumed_tokens,
         "settings": _cost_settings, "classify": _classify,
         "estimate": _estimate_tokens, "time": _match_time, "rand": _random.random}
    if deps:
        d.update(deps)
    if log is None:
        log = []
    targets = await d["targets"]()
    if targets is None:
        # Targets UNKNOWN (cold-cache load failure, no stale value):
        # existence can't be checked for rule targets OR the terminal
        # target, so skip rule evaluation entirely and apply the
        # terminal verbatim — never fabricate an empty world (fix wave
        # L). A truly-gone route target still 400s loudly at LiteLLM.
        term = routing.get("terminal") or {}
        if term.get("action") == "route":
            return ("route", term.get("target"), -1)
        return ("reject", None, None)
    req_cache = {}

    async def _cond_ok(cond, target):
        """-> (evaluated_value, ok). value is the concrete datum the trace shows."""
        t = cond.get("type")
        if t == "cost":
            # Settings coupling (spec G2): a cost condition on a disabled
            # ledger can never match — the trace value says WHY.
            s = await d["settings"]()
            led = cond.get("ledger")
            if led == "billed" and not (s.get("billing") or {}).get("enabled"):
                return ("skipped: billing disabled", False)
            if led == "real" and not s.get("enabled"):
                return ("skipped: cost tracking disabled", False)
            val = await d["cost"](cond, md, name, target)
            if val is None:
                return (None, False)
            thr = cond.get("threshold") or 0
            return (val, val < thr if cond.get("op") == "<" else val >= thr)
        if t == "tokens":
            val = await d["tokens"](cond, md, name, target)
            if val is None:
                return (None, False)
            thr = cond.get("threshold") or 0
            return (val, val < thr if cond.get("op") == "<" else val >= thr)
        if t == "context":
            est = d["estimate"](data)
            lim = cond.get("tokens") or 0
            return (est, est <= lim if cond.get("op") == "<=" else est > lim)
        if t == "available":
            phase = targets["phases"].get(target)
            val = "external" if target in targets["external"] else phase
            return (val, phase in ("Ready", "Idle") or target in targets["external"])
        if t == "time":
            from datetime import datetime, timezone
            hhmm = None
            try:
                from zoneinfo import ZoneInfo
                hhmm = datetime.now(timezone.utc).astimezone(
                    ZoneInfo(cond.get("tz") or "UTC")).strftime("%H:%M")
            except Exception:  # noqa: BLE001 — bad tz: value stays None
                pass
            return (hhmm, d["time"](cond))
        if t == "split":
            r = d["rand"]()
            return (round(r * 100, 1), r * 100 < (cond.get("percent") or 0))
        if t == "classify":
            ok = bool(await d["classify"](cond, data, req_cache, name))
            return (req_cache.get(cond.get("deployment")), ok)
        return (None, False)

    for idx, rule in enumerate(routing.get("rules") or []):
        target = rule.get("target")
        if target not in targets["phases"] and target not in targets["external"]:
            log.append({"rule": idx, "target": target, "verdict": "missing-target", "conditions": []})
            continue  # deleted target -> rule unmatched (spec)
        conds = []
        matched = True
        for cond in rule.get("conditions") or []:
            t = cond.get("type")
            try:
                value, ok = await _cond_ok(cond, target)
            except Exception as e:  # noqa: BLE001 — condition error = unmatched
                print(f"devproof-routing: condition {t} errored: {e}", flush=True)
                conds.append({"type": t, "value": str(e)[:120], "ok": False, "cond": cond})
                matched = False
                break
            conds.append({"type": t, "value": value, "ok": ok, "cond": cond})
            if not ok:
                matched = False
                break
        log.append({"rule": idx, "target": target,
                    "verdict": "matched" if matched else "no-match", "conditions": conds})
        if matched:
            return ("route", target, idx)
    term = routing.get("terminal") or {}
    if term.get("action") == "route":
        t = term.get("target")
        if t in targets["phases"] or t in targets["external"]:
            return ("route", t, -1)
        return ("unavailable", t, -1)
    return ("reject", None, None)

_cache = {}       # sha256(key) -> (expires_monotonic, key_id, workspace_id)
_last_touch = {}  # key_id -> monotonic time of last last_used_at write

def _cache_put(h, entry, now):
    if len(_cache) >= CACHE_MAX:  # evict expired entries; clear all if still full (bad-key spray)
        expired = [k for k, v in _cache.items() if v[0] <= now]
        for k in expired:
            _cache.pop(k, None)
        if len(_cache) >= CACHE_MAX:
            _cache.clear()
    _cache[h] = entry

async def _touch(key_id):
    try:
        pool = await _db()
        await pool.execute("UPDATE api_keys SET last_used_at = now() WHERE id = $1", key_id)
    except Exception as e:  # noqa: BLE001 — best-effort
        print(f"devproof-auth: last_used_at update failed: {e}", flush=True)

# ── Live trace (spec 2026-07-10): capture ONLY while a window is open. ──
# CP maintains trace_subscriptions rows (15s TTL) per open SSE viewer; we
# poll them into memory and fire-and-forget events at the subscribing CP
# instance. Content is truncated and NEVER stored. Best-effort throughout.
TRACE_POLL = 2.0
PREVIEW_MAX = 32768
_trace_subs = {}      # deployment -> set(callback_url)
_trace_task = None

async def _load_trace_subs():
    global _trace_subs
    try:
        pool = await _db()
        rows = await pool.fetch(
            "SELECT deployment, routing, callback_url FROM trace_subscriptions WHERE expires_at > now()")
        subs = {}
        for r in rows:
            subs.setdefault(r["deployment"] or r["routing"], set()).add(r["callback_url"])
        _trace_subs = subs
    except Exception as e:  # noqa: BLE001
        print(f"devproof-trace: subscription poll failed: {e}", flush=True)

async def _trace_poller():
    while True:
        await _load_trace_subs()
        await asyncio.sleep(TRACE_POLL)

async def _ensure_trace_poller():
    global _trace_task
    if _trace_task is None or _trace_task.done():
        _trace_task = asyncio.ensure_future(_trace_poller())
        # First call after (re)start: load inline so THIS request can trace.
        await _load_trace_subs()

def _response_text(resp):
    """SLO 'response' -> assistant text for both response shapes:
    OpenAI chat (choices[].message.content) and Anthropic messages
    (content block list). Falls back to _preview's own handling."""
    if isinstance(resp, dict):
        choices = resp.get("choices")
        if isinstance(choices, list) and choices:
            msg = (choices[0] or {}).get("message") or {}
            return msg.get("content")
        return resp.get("content")
    return resp

def _preview(content):
    """Message content -> (32k-capped text, true length). Handles OpenAI string
    content and Anthropic content-block lists; non-text blocks become markers."""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict):
                t = b.get("type")
                if t == "text":
                    parts.append(b.get("text") or "")
                elif t:
                    name = b.get("name")
                    parts.append(f"[{t}: {name}]" if name else f"[{t}]")
        text = "\n".join(parts)
    else:
        text = "" if content is None else str(content)
    return text[:PREVIEW_MAX], len(text)

def _attribution(md):
    out = {"source": "session" if md.get("devproof_internal") else "api"}
    if md.get("devproof_key_id"):
        out["api_key_id"] = md.get("devproof_key_id")
    if md.get("devproof_agent"):
        out["agent_id"] = md.get("devproof_agent")
    if md.get("devproof_session"):
        out["session_id"] = md.get("devproof_session")
    return out

def _tool_names(data):
    # Tool names for the trace request card (console groups mcp__<server>__
    # <tool> under their MCP server). Handles both wire shapes: Anthropic
    # tools carry a top-level "name", OpenAI chat tools nest it under
    # "function". Capped to bound the event size.
    names = []
    for t in (data.get("tools") or []):
        if not isinstance(t, dict):
            continue
        n = t.get("name") or (t.get("function") or {}).get("name")
        if n:
            names.append(str(n))
    return names[:200]

async def _post_trace(url, event):
    try:
        import httpx
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.post(f"{url}/internal/trace-events", json={"events": [event]},
                              headers={"Authorization": f"Bearer {INTERNAL_KEY}"})
            if resp.status_code >= 300:
                print(f"devproof-trace: post to {url} -> {resp.status_code}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"devproof-trace: post to {url} failed: {e}", flush=True)

def _emit_trace_multi(keys, event):
    # Emit ONCE per callback URL across the UNION of the given keys'
    # subscriber sets. A deployment-trace and routing-trace window open at
    # once share the same CP callback URL, so posting per-key would double-
    # deliver — TraceHub.publish already fans one post out to both windows.
    urls = set()
    for k in keys:
        if k:
            urls |= (_trace_subs.get(k) or set())
    for url in urls:
        asyncio.ensure_future(_post_trace(url, event))

async def _emit_reject_trace(requested, data, md0, eval_log, marker, error_text):
    """Best-effort trace emit for a terminal reject/unavailable verdict
    (spec 2026-07-16 B2): those raise from async_pre_call_hook BEFORE the
    normal request-capture block runs, so an open trace window would
    otherwise show nothing for exactly the requests where the per-rule
    evaluation detail matters most. No resolved deployment exists yet —
    the routing name is the only key."""
    try:
        await _ensure_trace_poller()
        if requested not in _trace_subs:
            return
        import time as _t, uuid
        trace_id = str(uuid.uuid4())
        msgs = []
        for m in (data.get("messages") or [])[-50:]:
            preview, length = _preview(m.get("content"))
            msgs.append({"role": m.get("role"), "preview": preview, "length": length})
        event = {
            "id": trace_id, "kind": "request", "deployment": None,
            "ts": _t.strftime("%Y-%m-%dT%H:%M:%S+00:00", _t.gmtime()),
            **_attribution(md0),
            "routing": requested, "target": None, "rule": -1,
            "messages": msgs,
            "tool_count": len(data.get("tools") or []),
            "tool_names": _tool_names(data),
            "model_params": {"stream": bool(data.get("stream")),
                             "max_tokens": data.get("max_tokens")},
            marker: True,
        }
        if data.get("system"):
            sys_preview, sys_len = _preview(data.get("system"))
            event["system"] = {"preview": sys_preview, "length": sys_len}
        if eval_log is not None:
            event["evaluation"] = eval_log
        _emit_trace_multi((requested,), event)
        _emit_trace_multi((requested,), {
            "id": trace_id, "kind": "error", "deployment": None,
            "ts": _t.strftime("%Y-%m-%dT%H:%M:%S+00:00", _t.gmtime()),
            **_attribution(md0),
            "routing": requested, "error": error_text,
        })
    except Exception as e:  # noqa: BLE001
        print(f"devproof-trace: reject capture failed: {e}", flush=True)

async def user_custom_auth(request, api_key: str) -> UserAPIKeyAuth:
    if not api_key:
        raise Exception("Missing Devproof API key")
    if INTERNAL_KEY and hmac.compare_digest(api_key, INTERNAL_KEY):
        # Attribution headers are trusted ONLY on the internal key (platform-
        # injected via ANTHROPIC_CUSTOM_HEADERS in session pods); external
        # callers' headers are ignored, so attribution cannot be spoofed.
        md = {"devproof_internal": True}
        for header, key in (("x-devproof-agent", "devproof_agent"),
                            ("x-devproof-session", "devproof_session"),
                            ("x-devproof-workspace", "devproof_workspace")):
            v = request.headers.get(header)
            if v:
                md[key] = v
        # Turn attribution (fix wave H): stamped as an INT so the metering
        # INSERT can write it to gateway_usage.turn directly (asyncpg is
        # strict about int4 params — a bare header string would raise).
        t = request.headers.get("x-devproof-turn")
        if t is not None:
            try:
                md["devproof_turn"] = int(t)
            except ValueError:
                pass
        return UserAPIKeyAuth(api_key=api_key, key_alias="devproof-internal", metadata=md)
    h = hashlib.sha256(api_key.encode()).hexdigest()
    now = time.monotonic()
    hit = _cache.get(h)
    if hit and hit[0] > now:
        _, key_id, ws = hit
        if key_id is None:
            raise Exception("Invalid Devproof API key")
    else:
        pool = await _db()  # DB unreachable + uncached -> raises -> fail closed
        # Key AND its workspace must be active (workspace disable = read-only,
        # spec 2026-07-13). Internal session-pod key bypasses above.
        row = await pool.fetchrow(
            """SELECT k.id, k.workspace_id FROM api_keys k
               JOIN workspaces w ON w.id = k.workspace_id AND w.status = 'active'
               WHERE k.secret_hash = $1 AND k.status = 'active'""", h)
        if row is None:
            _cache_put(h, (now + NEG_CACHE_TTL, None, None), now)
            raise Exception("Invalid Devproof API key")
        key_id, ws = row["id"], row["workspace_id"]
        _cache_put(h, (now + CACHE_TTL, key_id, ws), now)
    if now - _last_touch.get(key_id, 0.0) > TOUCH_INTERVAL:
        _last_touch[key_id] = now
        asyncio.ensure_future(_touch(key_id))
    return UserAPIKeyAuth(api_key=api_key, key_alias=key_id,
                          metadata={"devproof_key_id": key_id, "devproof_workspace": ws})

class SchemaSanitizer(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        md0 = getattr(user_api_key_dict, "metadata", None) or {}
        requested = data.get("model")
        _via_routing = False
        _eval_log = None   # per-rule evaluation detail for the trace (B1)
        try:  # ── routing resolution (spec 2026-07-16) — BEFORE the wake-
              # hold so the hold acts on the RESOLVED target. Degrades on
              # infra errors (stale rules cache), never 500s except the
              # deliberate 403/503 verdicts.
            # devproof_direct (spec 2026-07-16): internal-only escape hatch.
            # Under name shadowing a routing may share a deployment/external
            # name; the CP warmup and the _classify sub-call address those
            # names DIRECTLY and must not recurse into the shadowing routing
            # (warmup would deadlock the wake; classify would loop). Honored
            # ONLY for internal callers — an external caller's marker is
            # IGNORED so a bare (non-routing) name still hits the 403 below.
            _direct = bool((data.get("metadata") or {}).get("devproof_direct")
                           or (data.get("litellm_metadata") or {}).get("devproof_direct"))
            _skip_routing = _direct and bool(md0.get("devproof_internal"))
            try:
                routing = await _get_routing(requested) if (requested and not _skip_routing) else None
            except _RoutingLookupUnavailable:
                # Cold-miss DB error, no cached entry (fix wave L): an
                # EXTERNAL caller's valid routing name must not fall into
                # the routing-only 403 below with its misleading "not a
                # routing" text — 503 so the client retries once the
                # pool/DB recovers. Internal callers pass through
                # unresolved, same as a legitimate miss (direct-call
                # fallback is harmless there).
                if md0.get("devproof_internal"):
                    routing = None
                else:
                    raise HTTPException(status_code=503,
                        detail={"error": "routing lookup unavailable - retry shortly", "routing": requested},
                        headers={"Retry-After": "5"})
            if routing is not None:
                _eval_log = []
                verdict, target, rule_idx = await _evaluate_routing(requested, routing, data, md0, log=_eval_log)
                if verdict == "reject":
                    try:  # rejects never reach the metering callback — count here
                        pool = await _db()
                        await pool.execute(
                            "INSERT INTO routing_rejects (routing, api_key_id, workspace_id) VALUES ($1,$2,$3)",
                            requested, md0.get("devproof_key_id"), md0.get("devproof_workspace"))
                    except Exception as e:  # noqa: BLE001
                        print(f"devproof-routing: reject insert failed: {e}", flush=True)
                    await _emit_reject_trace(requested, data, md0, _eval_log, "rejected", "no routing rule matched")
                    raise HTTPException(status_code=403,
                        detail={"error": "no routing rule matched", "routing": requested})
                if verdict == "unavailable":
                    await _emit_reject_trace(requested, data, md0, _eval_log, "unavailable", "routing target unavailable")
                    raise HTTPException(status_code=503,
                        detail={"error": "routing target unavailable", "routing": requested, "target": target})
                data["model"] = target
                # Stamp the routing into BOTH metadata channels: on the
                # /v1/messages (Anthropic) surface LiteLLM's chat-completions
                # bridge treats `metadata` as the Anthropic-native user param
                # and rebuilds the request, so `metadata` never reaches the
                # logging callback — `litellm_metadata` is the proxy-level
                # channel that survives the bridge (verified live 2026-07-16).
                # chat/completions carries either; write both, read merged.
                for _k in ("metadata", "litellm_metadata"):
                    m = data.get(_k)
                    if not isinstance(m, dict):
                        m = {}
                        data[_k] = m
                    m["devproof_routing"] = requested
                    m["devproof_routing_rule"] = rule_idx
                _via_routing = True
            elif requested and not md0.get("devproof_internal"):
                # Routing-only for external keys (spec 2026-07-16): bare
                # deployment/external names are rejected so cost limits
                # and reject rules cannot be routed around.
                raise HTTPException(status_code=403, detail={
                    "error": f"'{requested}' is not a routing - external keys must call a routing name",
                    "model": requested})
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            # Fail CLOSED for external callers (mirrors _RoutingLookupUnavailable
            # above): passing through leaves data["model"]=requested, which under
            # name shadowing serves the deployment directly and bypasses the
            # routing's reject terminal / cost caps. Internal traffic (warmup,
            # session pods calling deployment names) passes through so the
            # wake/warmup path can never deadlock.
            print(f"devproof-routing: resolution failed: {e}", flush=True)
            if requested and not md0.get("devproof_internal"):
                raise HTTPException(status_code=503,
                    detail={"error": "routing resolution failed - retry shortly", "routing": requested},
                    headers={"Retry-After": "5"})
        try:  # scale-to-zero hold — bypass narrowed (spec 2026-07-16):
              # internal traffic IS held when routing-resolved (session
              # pods no longer park on a phase the CP can't predict);
              # the CP warmup calls deployment names directly, never a
              # routing, so the wake deadlock stays impossible (verified
              # live 2026-07-16: 13.4s Idle->200 via this exact path).
              # Fail OPEN on DB errors.
            model0 = data.get("model")
            if model0 and (not md0.get("devproof_internal") or _via_routing):
                state = await _routing_state(model0)
                if state in ("idle", "waking"):
                    await _hold_for_wake(model0, state == "idle")
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            print(f"devproof-wake: hold check failed (open): {e}", flush=True)
        if SCRUB_ALL or data.get("model") in SANITIZE_MODELS:
            for t in data.get("tools") or []:
                _scrub(t)
        try:  # reasoning default must never fail a request
            eff = REASONING_EFFORTS.get(data.get("model"))
            if eff:
                keys = ("reasoning_effort", "thinking", "reasoning")
                # Normalize: clients may send extra_body as null or a non-dict;
                # treat anything but a dict as absent (a string would turn
                # `k in eb` into a substring test and setdefault-on-None throws).
                eb = data.get("extra_body")
                if not isinstance(eb, dict):
                    eb = {}
                if not any(k in data or k in eb for k in keys):
                    if data.get("model") in SANITIZE_MODELS:
                        # llama.cpp-class backend: LiteLLM drop_params strips
                        # top-level reasoning_effort for these routes; extra_body
                        # passes verbatim (verified live 2026-07-12) and unknown
                        # fields are ignored by backends without support.
                        eb["reasoning_effort"] = eff
                        data["extra_body"] = eb
                    else:
                        data["reasoning_effort"] = eff
        except Exception as e:  # noqa: BLE001
            print(f"devproof-reasoning: apply failed: {e}", flush=True)
        try:  # llama.cpp-class: keep /v1/messages on chat/completions (2026-07-13)
            # LiteLLM reroutes provider-openai /v1/messages requests with
            # thinking enabled to its OpenAI Responses-API bridge
            # (responses/<model>), which only translates OpenAI reasoning
            # *summaries* (summary_text) and silently drops llama.cpp's raw
            # reasoning (reasoning_text) — sessions render EMPTY thinking
            # blocks. The chat/completions bridge carries the full reasoning
            # (delta.reasoning_content -> thinking_delta; verified live
            # 2026-07-13). llama.cpp-class engines reason from server-side
            # flags (--reasoning-budget), not the request param, so dropping
            # the client's thinking here loses nothing. Runs AFTER the
            # defaults block above so an explicit client thinking param
            # still suppresses the devproof_reasoning_effort default (spec
            # 2026-07-12). Scoped to SANITIZE_MODELS (NOT SCRUB_ALL): named
            # anthropic endpoints must keep extended thinking.
            if data.get("model") in SANITIZE_MODELS:
                data.pop("thinking", None)
        except Exception as e:  # noqa: BLE001
            print(f"devproof-reasoning: thinking strip failed: {e}", flush=True)
        try:  # trace capture must never fail a request
            await _ensure_trace_poller()
            deployment = data.get("model")
            routing_name = (data.get("metadata") or {}).get("devproof_routing")
            if (deployment and deployment in _trace_subs) or (routing_name and routing_name in _trace_subs):
                import time as _t, uuid
                trace_id = str(uuid.uuid4())
                # Both channels (see routing stamp): metadata is dropped by
                # the /v1/messages bridge; litellm_metadata survives.
                for _k in ("metadata", "litellm_metadata"):
                    m = data.get(_k)
                    if not isinstance(m, dict):
                        m = {}
                        data[_k] = m
                    m["devproof_trace_id"] = trace_id
                md = getattr(user_api_key_dict, "metadata", None) or {}
                msgs = []
                for m in (data.get("messages") or [])[-50:]:
                    preview, length = _preview(m.get("content"))
                    msgs.append({"role": m.get("role"), "preview": preview, "length": length})
                event = {
                    "id": trace_id, "kind": "request", "deployment": deployment,
                    "ts": _t.strftime("%Y-%m-%dT%H:%M:%S+00:00", _t.gmtime()),
                    **_attribution(md),
                    "routing": routing_name,
                    "target": deployment if routing_name else None,
                    "rule": (data.get("metadata") or {}).get("devproof_routing_rule"),
                    "messages": msgs,
                    "tool_count": len(data.get("tools") or []),
                    "tool_names": _tool_names(data),
                    "model_params": {"stream": bool(data.get("stream")),
                                     "max_tokens": data.get("max_tokens")},
                }
                if data.get("system"):
                    sys_preview, sys_len = _preview(data.get("system"))
                    event["system"] = {"preview": sys_preview, "length": sys_len}
                if _eval_log is not None:   # per-rule evaluation detail (B1)
                    event["evaluation"] = _eval_log
                _emit_trace_multi((deployment, routing_name), event)
        except Exception as e:  # noqa: BLE001
            print(f"devproof-trace: request capture failed: {e}", flush=True)
        return data

    async def async_post_call_streaming_iterator_hook(self, user_api_key_dict, response, request_data):
        # Auto-compact trigger fix (spec 2026-07-16): on the /v1/messages
        # chat-completions bridge (SANITIZE-class local models) the Anthropic
        # adapter hardcodes message_start usage.input_tokens=0 and reports
        # real prompt tokens only in the final message_delta. Claude Code
        # derives its context window — the auto-compact trigger — from the
        # assistant message usage seeded at message_start, so it reads 0 and
        # NEVER auto-compacts: CLAUDE_CODE_AUTO_COMPACT_WINDOW is blind and
        # turns overflow the served 32k model (verified live: sesn_uz6d0gd
        # csiin / sesn_86tjxdge2e32 grew to 30k/39k with zero compaction ->
        # ContextWindowExceededError). Inject a prompt-token ESTIMATE
        # (serialized prompt / 4) into message_start AND raise the final
        # message_delta input_tokens to >= that estimate, so the counter
        # moves in both the live (message_start) and finalized/resumed
        # (message_delta) paths the CLI reads (verified: a large message_start
        # fires compaction; a small final delta overwrites it). Precision is
        # secondary — the counter only needs to cross the window before the
        # hard gateway limit. Scoped to SANITIZE_MODELS: named-anthropic
        # streams already carry correct usage and stay untouched. DON'T
        # REGRESS: removing this hook silently disables ALL session
        # auto-compaction and overflow returns. Best-effort throughout — any
        # failure yields the chunk unmodified and never breaks a stream.
        est = 0
        try:
            if SCRUB_ALL or request_data.get("model") in SANITIZE_MODELS:
                est = _estimate_tokens(request_data)
        except Exception as e:  # noqa: BLE001
            print(f"devproof-compact: estimate failed: {e}", flush=True)
            est = 0
        async for chunk in response:
            if est > 0:
                try:
                    chunk = _inject_prompt_estimate(chunk, est)
                except Exception as e:  # noqa: BLE001
                    print(f"devproof-compact: usage inject failed: {e}", flush=True)
            yield chunk

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        # Metering/trace must never fail a request: everything is best-effort.
        try:
            slo = kwargs.get("standard_logging_object") or {}
            auth_md = (slo.get("metadata") or {}).get("user_api_key_auth_metadata") or {}
            lp = kwargs.get("litellm_params") or {}
            # Merge both channels: /v1/messages carries proxy metadata in
            # litellm_metadata (metadata is the dropped Anthropic user param).
            md = {**(lp.get("metadata") or {}), **(lp.get("litellm_metadata") or {})}
            model = (slo.get("model_group") or md.get("model_group")
                     or kwargs.get("model") or slo.get("model") or "unknown")
            tokens_in = int(slo.get("prompt_tokens") or 0)
            tokens_out = int(slo.get("completion_tokens") or 0)
            internal = bool(auth_md.get("devproof_internal"))
            if internal:
                key_id = None
                # NOT NULL column; pre-rollout session pods lack the header.
                ws = auth_md.get("devproof_workspace") or "wrkspc_default"
            else:
                key_id = auth_md.get("devproof_key_id")
                ws = auth_md.get("devproof_workspace")
                if not key_id:
                    return  # unattributed external traffic (shouldn't happen): skip
            pool = await _db()
            await pool.execute(
                """INSERT INTO gateway_usage
                   (workspace_id, api_key_id, model, tokens_in, tokens_out, source, agent_id, session_id, routing, routing_rule, turn)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)""",
                ws, key_id, model,
                tokens_in, tokens_out,
                "session" if internal else "api",
                auth_md.get("devproof_agent"), auth_md.get("devproof_session"),
                md.get("devproof_routing"),
                # routing_rule: matched rule index from the resolution stamp
                # (int/None; classify sub-calls carry -2). turn: session turn
                # from the internal-key attribution (int/None).
                md.get("devproof_routing_rule"),
                auth_md.get("devproof_turn"))
        except Exception as e:  # noqa: BLE001
            print(f"devproof-metering: dropped usage row: {e}", flush=True)
        try:
            slo = kwargs.get("standard_logging_object") or {}
            lp = kwargs.get("litellm_params") or {}
            md = {**(lp.get("metadata") or {}), **(lp.get("litellm_metadata") or {})}
            deployment = slo.get("model_group") or md.get("model_group") or kwargs.get("model")
            routing_name = md.get("devproof_routing")
            trace_id = md.get("devproof_trace_id")
            if trace_id and ((deployment and deployment in _trace_subs) or (routing_name and routing_name in _trace_subs)):
                auth_md = (slo.get("metadata") or {}).get("user_api_key_auth_metadata") or {}
                preview, length = _preview(_response_text(slo.get("response")))
                import time as _t
                event = {
                    "id": trace_id, "kind": "response", "deployment": deployment,
                    "ts": _t.strftime("%Y-%m-%dT%H:%M:%S+00:00", _t.gmtime()),
                    **_attribution(auth_md),
                    "routing": routing_name,
                    "tokens_in": int(slo.get("prompt_tokens") or 0),
                    "tokens_out": int(slo.get("completion_tokens") or 0),
                    "duration_ms": int(((slo.get("response_time") or 0)) * 1000),
                    "preview": preview, "length": length,
                }
                _emit_trace_multi((deployment, routing_name), event)
        except Exception as e:  # noqa: BLE001
            print(f"devproof-trace: response capture failed: {e}", flush=True)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        try:
            slo = kwargs.get("standard_logging_object") or {}
            lp = kwargs.get("litellm_params") or {}
            md = {**(lp.get("metadata") or {}), **(lp.get("litellm_metadata") or {})}
            deployment = slo.get("model_group") or md.get("model_group") or kwargs.get("model")
            routing_name = md.get("devproof_routing")
            trace_id = md.get("devproof_trace_id")
            if trace_id and ((deployment and deployment in _trace_subs) or (routing_name and routing_name in _trace_subs)):
                auth_md = (slo.get("metadata") or {}).get("user_api_key_auth_metadata") or {}
                import time as _t
                event = {
                    "id": trace_id, "kind": "error", "deployment": deployment,
                    "ts": _t.strftime("%Y-%m-%dT%H:%M:%S+00:00", _t.gmtime()),
                    **_attribution(auth_md),
                    "routing": routing_name,
                    "error": str(slo.get("error_str") or "")[:PREVIEW_MAX],
                }
                _emit_trace_multi((deployment, routing_name), event)
        except Exception as e:  # noqa: BLE001
            print(f"devproof-trace: error capture failed: {e}", flush=True)

proxy_handler_instance = SchemaSanitizer()
