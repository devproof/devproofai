# Reasoning effort for external deployments — design

Date: 2026-07-12. Status: approved (brainstormed in session; empirically verified against the live gateway).

## Goal

Let an external deployment (remote endpoint) carry a default **reasoning effort**
that the gateway applies to every request that doesn't set its own reasoning
parameter. Reasoning by deployment name — e.g. `gpt5-fast` (minimal) and
`gpt5-deep` (high) over the same provider model — so Devproof-native callers
(agents, warmup, console), which only pick a model name, can select reasoning
too.

## Scope

- **In:** external deployments with provider `openai`, `anthropic`, `openrouter`.
- **Out — `custom` provider:** LiteLLM's `drop_params` silently strips
  `reasoning_effort` for models it doesn't know as reasoning-capable (verified
  live: a custom endpoint never received the param). Offering the field would
  store a dead value: the UI hides it and the API rejects it for custom.
- **Out — local deployments:** llama.cpp doesn't take `reasoning_effort`;
  thinking on local models is chat-template flags — a separate feature.
- **Out — agents:** agents select reasoning by pointing at a deployment
  (the alias pattern above). No agent-level field.
- **Out — effort value `none`:** NULL means "Devproof stays silent, provider
  decides". A literal `reasoning_effort: "none"` (force reasoning off) is a
  possible future fifth option, not built now.

## Semantics (the load-bearing rule)

**Default if not overwritten.** The configured effort is applied by our own
pre-call hook in `custom_callbacks.py` **only when the request carries no
reasoning parameter** (`reasoning_effort`, `thinking`, or `reasoning` key).
We deliberately do NOT use LiteLLM's documented `litellm_params.reasoning_effort`
per-model config: its merge precedence against request-supplied values is
undocumented and version-dependent — if config won, "default" would silently
become "forced". The hook makes the semantics ours.

## Verified behavior (live gateway, mock provider, 2026-07-12)

| Input through gateway | Observed at provider |
|---|---|
| OpenAI-format `reasoning_effort: "low"` → anthropic endpoint | `thinking: {type: "enabled", budget_tokens: 1024}` |
| `reasoning_effort: "minimal"` → anthropic endpoint | `thinking: {type: "enabled", budget_tokens: 1024}` (clamped to floor) |
| Anthropic-format `/v1/messages` with explicit `thinking` | passed through unchanged |
| `reasoning_effort: "high"` → custom (OpenAI-compatible) endpoint | **dropped** (`drop_params`) |
| No reasoning param | nothing injected |

LiteLLM docs: `low/medium/high` → `budget_tokens` 1024/2048/4096 on older
Anthropic models; adaptive thinking + `output_config.effort` on newer
Anthropic models (≥4.6).
`minimal` is OpenAI-native and degrades to the 1024 floor on Anthropic.

## Design

### 1. Data — migration `control-plane/sql/023_reasoning_effort.sql`

```sql
-- Default reasoning effort for external deployments (spec 2026-07-12).
-- NULL = don't pass anything; provider default applies.
ALTER TABLE external_deployments ADD COLUMN IF NOT EXISTS reasoning_effort TEXT
  CHECK (reasoning_effort IN ('minimal','low','medium','high'));
```

Idempotent under the re-run-every-boot `migrate()` (`ADD COLUMN IF NOT EXISTS`).

### 2. Repo — `control-plane/src/repo.ts`

- `createExternalDeployment` gains `reasoningEffort?: string | null`.
- `updateExternalDeployment` patch gains `reasoningEffort?: string | null`
  with **omitted ≠ null**: `undefined` leaves the column unchanged, `null`
  clears it. The existing `COALESCE` pattern can't clear, so this field uses
  a provided-flag: `reasoning_effort = CASE WHEN $n THEN $m ELSE reasoning_effort END`
  where `$n` is `patch.reasoningEffort !== undefined`.

### 3. API — `control-plane/src/server.ts`

`POST /v1/deployments/external` and `PATCH /v1/deployments/external/:id`:

- Accept `reasoningEffort?: string | null` in the body.
- Validation (shared helper, both routes):
  - value not in `{minimal, low, medium, high, null/undefined}` →
    400 `{"error": "reasoningEffort must be one of minimal|low|medium|high"}`
  - non-null value while the endpoint's provider is `custom` →
    400 `{"error": "reasoningEffort is not supported for custom endpoints"}`
    (POST checks `b.provider`; PATCH checks the existing row's provider).
- Both routes already call `syncGateway()` — no new sync work.

### 4. Gateway config — `control-plane/src/gateway-config.ts`

`ExternalLike` gains `reasoning_effort: string | null`. In the externals loop,
`model_info` gains the flag only when set:

```ts
model_info: {
  devproof_sanitize: e.provider === "custom",
  key_version: e.key_version,
  ...(e.reasoning_effort ? { devproof_reasoning_effort: e.reasoning_effort } : {}),
},
```

Setting/clearing the value changes the config bytes → the existing diff-aware
sync rolls the gateway → the hook (which loads its map at boot, like the
sanitizer) picks it up. No new roll mechanism.

### 5. Hook — `custom_callbacks.py` in `deploy/gateway/litellm.yaml`

Next to `_load_sanitize_models()`:

```python
def _load_reasoning_efforts():
    # {model_name: effort} from model_info.devproof_reasoning_effort.
    # Parse failure -> empty map (requests pass through untouched).
    try:
        import yaml
        with open(CONFIG_PATH) as f:
            cfg = yaml.safe_load(f) or {}
        return {m.get("model_name"): (m.get("model_info") or {}).get("devproof_reasoning_effort")
                for m in (cfg.get("model_list") or [])
                if (m.get("model_info") or {}).get("devproof_reasoning_effort")}
    except Exception as e:  # noqa: BLE001
        print(f"devproof-reasoning: config parse failed, no defaults: {e}", flush=True)
        return {}

REASONING_EFFORTS = _load_reasoning_efforts()
```

In `SchemaSanitizer.async_pre_call_hook`, before the trace block, wrapped so
it can never fail a request:

```python
try:  # reasoning default must never fail a request
    eff = REASONING_EFFORTS.get(data.get("model"))
    if eff and not any(k in data for k in ("reasoning_effort", "thinking", "reasoning")):
        data["reasoning_effort"] = eff
except Exception as e:  # noqa: BLE001
    print(f"devproof-reasoning: apply failed: {e}", flush=True)
```

Implementation-time verification (the one inferred detail): temporarily print
`sorted(data.keys())` for an Anthropic-format `/v1/messages` request carrying
`thinking` and confirm the guard key names match what the hook actually sees;
adjust the key tuple if needed, then remove the print. Worst case is benign —
a redundant default beside an explicit `thinking`, which LiteLLM resolves in
favor of the explicit value (verified: explicit `thinking` passes through).

### 6. Console — `console/app/deployments/deploy-modal.tsx`

Remote section, after the Model id field, **hidden when `provider === "custom"`**:

```tsx
<Field label="Reasoning" hint="default effort when the request doesn't set one">
  <select value={reasoningEffort} onChange={(e) => setReasoningEffort(e.target.value)}
          style={{ flex: "none", width: 190 }}>
    <option value="">— (provider default)</option>
    <option value="minimal">minimal</option>
    <option value="low">low</option>
    <option value="medium">medium</option>
    <option value="high">high</option>
  </select>
</Field>
```

- State prefilled from `ctx.reasoningEffort ?? ""`; switching provider to
  `custom` resets it to `""`.
- Create/save body sends `reasoningEffort: reasoningEffort || null` (null
  clears on edit; POST treats null as absent).
- `DeployCtx` (and the row → ctx plumbing in the deployments/detail pages)
  gains `reasoningEffort?: string | null` sourced from the API row's
  `reasoning_effort`.

**Detail page** (external deployment variant): a "Reasoning" line next to
provider/model id, shown only when set. List table unchanged.

### 7. Tests

- `gateway-config.test.ts`: external with `reasoning_effort: "high"` emits
  `model_info.devproof_reasoning_effort: "high"`; with `null` the key is
  absent.
- `server.test.ts`:
  - POST with `reasoningEffort: "garbage"` → 400 matching `/reasoningEffort/`.
  - POST `provider: "custom"` + `reasoningEffort: "low"` → 400.
  - POST openai + `reasoningEffort: "high"` → 201, row carries it.
  - PATCH to `"medium"` → persisted; PATCH `reasoningEffort: null` → cleared;
    PATCH omitting the field → unchanged.
- `npx tsc --noEmit` clean; `npm test` green.

### 8. Live verification (definition of done)

1. Console: create/edit an external endpoint with a reasoning effort; confirm
   the dropdown hides for custom provider.
2. `kubectl -n devproof-gateway get cm litellm-config -o yaml` shows
   `devproof_reasoning_effort` on that route; gateway rolled.
3. Mock-provider check (same technique as design verification): request
   **without** reasoning param arrives at the mock **with** the configured
   effort applied (translated to `thinking` for anthropic provider); request
   **with** an explicit reasoning param arrives with the client's value, not
   the default.
4. All console pages 200 after prod build restart.
