# Reasoning effort rework: free text + test-connection validation — design

Date: 2026-07-12. Status: approved. Reworks the shipped feature from
`2026-07-12-reasoning-effort-design.md` (merged 74b8ecf) based on user
feedback: the closed enum was wrong because effort vocabularies vary by
vendor and will keep drifting (OpenAI has `none|minimal|low|medium|high|xhigh`,
Anthropic `low|medium|high|xhigh|max`, OpenRouter `none|minimal|low|medium|high|xhigh|max`).

## Goal

1. The Reasoning field on external deployments becomes **free text**, shown
   for **all** providers including `custom`. Empty = provider default
   (nothing injected); the placeholder says so.
2. Because free text means typos can no longer be caught by a whitelist,
   **Test connection** validates the value: when the field is set, the test
   sends a tiny real completion with the value applied in the provider's
   native slot, so the provider itself accepts or rejects it.

## Verified behavior (live gateway + provider docs, 2026-07-12)

| Claim | Evidence |
|---|---|
| LiteLLM drops top-level `reasoning_effort` on custom (OpenAI-compatible) routes | live: mock never received it (design round 1) |
| LiteLLM forwards `extra_body` contents verbatim into the outgoing JSON on custom routes | live: `extra_body: {reasoning_effort: high}` arrived at the mock as top-level `"reasoning_effort":"high"` |
| OpenAI `reasoning_effort` is a schema-validated enum (`none|minimal|low|medium|high|xhigh`, per-model ranges) → bad values 400 | OpenAI API reference |
| Anthropic Messages API takes `output_config: {effort: low|medium|high|xhigh|max}`; no `budget_tokens`/`max_tokens` coupling (that's only for `thinking: enabled`) | Anthropic API reference |
| OpenRouter takes unified `reasoning: {effort: ...}` (flat `reasoning_effort` undocumented); maps to the nearest supported level rather than rejecting | OpenRouter docs — the probe cannot catch pure typos there; it reports what the provider reports |

## Design

### 1. DB — free the column

- Edit `control-plane/sql/023_reasoning_effort.sql`: remove the CHECK clause
  (fresh databases get an unconstrained TEXT column). Safe: on existing DBs
  the `ADD COLUMN IF NOT EXISTS` skips entirely, so the edited file never
  re-adds anything.
- New `control-plane/sql/024_reasoning_effort_freetext.sql`:

```sql
-- Reasoning effort became free text (spec 2026-07-12 rework): vendor
-- vocabularies differ (xhigh, max, none, …) and keep drifting — validation
-- moved to the API sanity check + Test connection probe.
ALTER TABLE external_deployments
  DROP CONSTRAINT IF EXISTS external_deployments_reasoning_effort_check;
```

Idempotent under re-run-every-boot migrate (DROP IF EXISTS; 023 skips).

### 2. API — sanity validation only

In `server.ts`, `reasoningEffortError` is replaced:

- Accepts `null`/`undefined` (unchanged semantics: omitted ≠ null on PATCH).
- Trims first, then validates the TRIMMED value; rejects with 400
  `reasoningEffort must be a short value without whitespace (max 32 chars)`
  when: not a string, trimmed value empty, trimmed value contains whitespace,
  or trimmed length > 32.
- The **trimmed** value is what gets stored and emitted.
- The custom-provider 400 is **removed** (field now valid for all providers).
- `VALID_EFFORTS` whitelist deleted.

### 3. Gateway config — unchanged emit, now also for custom

`buildGatewayConfig` already emits `model_info.devproof_reasoning_effort`
when set; custom rows now simply may carry it too. No code change expected
beyond what tests assert (a custom row with the value set emits the key).

### 4. Hook — two injection slots

In `custom_callbacks.py` (`deploy/gateway/litellm.yaml`), the apply block
changes to:

```python
try:  # reasoning default must never fail a request
    eff = REASONING_EFFORTS.get(data.get("model"))
    if eff:
        keys = ("reasoning_effort", "thinking", "reasoning")
        eb = data.get("extra_body") or {}
        if not any(k in data or k in eb for k in keys):
            if data.get("model") in SANITIZE_MODELS:
                # llama.cpp-class backend: LiteLLM drop_params strips top-level
                # reasoning_effort for these routes; extra_body passes verbatim
                # (verified live) and unknown fields are ignored by backends
                # that don't support it.
                data.setdefault("extra_body", {})["reasoning_effort"] = eff
            else:
                data["reasoning_effort"] = eff
except Exception as e:  # noqa: BLE001
    print(f"devproof-reasoning: apply failed: {e}", flush=True)
```

- Custom-vs-named detection reuses `SANITIZE_MODELS` (custom endpoints are
  exactly the sanitized externals; local models are sanitized too but never
  appear in `REASONING_EFFORTS`, so the intersection is safe). No new
  config flag.
- The guard now also checks `extra_body` for client-supplied reasoning keys.
- Named providers keep top-level injection (LiteLLM translates: verified
  `low` → Anthropic `thinking budget_tokens 1024` in round 1).

### 5. Console — text input, all providers

`deploy-modal.tsx` remote section:

- The Reasoning `<select>` becomes
  `<input value={reasoningEffort} placeholder="provider default" style={{ width: 190, flex: "none" }} />`,
  shown for ALL providers (the `provider !== "custom"` gate and the
  switch-to-custom reset are removed).
- Field hint: `vendor-specific, e.g. low / high / xhigh — Test connection validates it`.
- Submit bodies unchanged (POST sends only when set; PATCH always sends
  `reasoningEffort: reasoningEffort || null`).
- Detail page (`tabs.tsx`) Reasoning row: unchanged (shows the free-text
  value when set).

### 6. Test connection — reasoning-aware probe

`POST /v1/deployments/external/test` body gains `modelId?` and
`reasoningEffort?` (console sends both from current form state).

- `reasoningEffort` empty/absent → current behavior (GET models reachability
  probe, 8s timeout).
- `reasoningEffort` set but `modelId` empty → reachability probe; detail
  gets the suffix ` — enter a model id to validate reasoning`.
- Both set → **completion probe** (timeout 20s, `max_tokens: 16`,
  message `[{role:"user", content:"hi"}]`), value in the provider-native slot:

| provider | request | reasoning slot |
|---|---|---|
| openai | `POST {base}/chat/completions` | top-level `reasoning_effort` |
| custom | `POST {base}/chat/completions` | top-level `reasoning_effort` (direct call — no LiteLLM, nothing dropped; backend honors, ignores, or rejects) |
| openrouter | `POST {base}/chat/completions` | `reasoning: {effort: <value>}` |
| anthropic | `POST {base}/v1/messages` (headers `x-api-key`, `anthropic-version: 2023-06-01`) | `output_config: {effort: <value>}` |

- Result mapping: HTTP 2xx → `{ok: true, detail: "completion ok — reasoning accepted"}`;
  non-2xx → `{ok: false, detail: "HTTP <status>: <first 200 chars of response body>"}`
  (the provider's own validation message is the payload); network error →
  current error mapping.
- Known asymmetries, documented not fixed: the Anthropic probe speaks
  `output_config.effort` natively and is slightly stricter than the runtime
  path for values LiteLLM would translate to token budgets on older Anthropic
  models (e.g. `minimal`); OpenRouter maps to the nearest level instead of
  rejecting, so typos may still pass there.

### 7. Docs

CLAUDE.md external-endpoints bullet: replace the enum/custom-400 wording —
free text (vendor vocab), all providers, custom injected via `extra_body`,
Test connection validates with a real completion when set.

### 8. Tests

- `server.test.ts`: whitespace/overlong/non-string values → 400; `xhigh`
  → 201/200 persisted trimmed; custom provider + value → now 201 (was 400);
  PATCH null/omitted semantics unchanged (existing assertions keep passing
  with the enum cases updated).
- `gateway-config.test.ts`: custom row with `reasoning_effort` set emits
  `devproof_reasoning_effort` (previously only named providers were asserted).
- New probe test: spin a local `node:http` server inside the test, point
  `POST /v1/deployments/external/test` at it per provider, and assert the
  received body carries the value in the right slot (flat / `reasoning.effort`
  / `output_config.effort`) and that a 400 response surfaces as
  `{ok: false, detail: /HTTP 400/}`.

### 9. Live verification (definition of done)

1. Mock-provider run: custom endpoint with stored effort + request WITHOUT
   reasoning param through the gateway → mock receives `reasoning_effort`
   (extra_body path); request WITH explicit param → client value wins.
2. Test connection against the mock: value set → mock receives it in the
   flat slot and probe reports `✓ completion ok`; mock rigged to 400 → probe
   line shows the error text.
3. Console: text field visible for custom provider, placeholder
   `provider default`; pages 200; `npm test` + `tsc --noEmit` green.

## Out of scope

- Local (llama.cpp in-cluster) deployments — separate brainstorm in flight
  (LLMkube `reasoningBudget`).
- Moving client-supplied top-level reasoning params into `extra_body` for
  custom routes (client-side concern; only the deployment default uses the
  extra_body path).
- Any probe support for validating values against LiteLLM's translation
  tables (the probe speaks provider-native dialects by design).
