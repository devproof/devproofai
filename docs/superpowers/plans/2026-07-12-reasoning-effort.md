# Reasoning Effort for External Deployments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** External deployments (openai/anthropic/openrouter) carry an optional default `reasoning_effort` that the gateway applies to any request that doesn't set its own reasoning parameter.

**Architecture:** A nullable enum column on `external_deployments` flows through the CP API (camelCase `reasoningEffort`) into the generated LiteLLM config as `model_info.devproof_reasoning_effort`; a pre-call hook in `custom_callbacks.py` (same pattern as the existing sanitizer) injects it into requests that carry no reasoning param. LiteLLM translates per provider (verified live: `low` → Anthropic `thinking budget_tokens: 1024`; custom provider drops the param, hence excluded).

**Tech Stack:** Postgres (re-run-every-boot migrations), Fastify (control-plane), LiteLLM proxy (ConfigMap-mounted Python callbacks), Next.js console (prod builds only), Node test runner.

Spec: `docs/superpowers/specs/2026-07-12-reasoning-effort-design.md`.

## Global Constraints

- Enum is exactly `minimal | low | medium | high`; `NULL` = don't pass anything, provider default applies.
- Error strings verbatim: `reasoningEffort must be one of minimal|low|medium|high` and `reasoningEffort is not supported for custom endpoints`.
- PATCH semantics: **omitted ≠ null** — omitted leaves the column unchanged, `null` clears it.
- `custom` provider: UI hides the field, API rejects non-null values with 400 (LiteLLM `drop_params` silently discards the param for such endpoints — verified live).
- Every SQL file re-runs on every CP boot (`migrate()` has no tracking table) — DDL must be idempotent (`ADD COLUMN IF NOT EXISTS`).
- The gateway hook must never fail a request (wrap in try/except, print-and-continue).
- API field is camelCase `reasoningEffort`; DB column snake_case `reasoning_effort`; the merged deployments view exposes camelCase.
- Console is always a production build (`npx next build && npx next start -p 7090`); no `prompt()`/`confirm()`/`alert()`.
- Model identity rule: nothing in this feature may add the word "Claude" to any platform prompt (not touched here, listed for awareness).

---

### Task 1: Migration, repo, API validation, merged-view exposure

**Files:**
- Create: `control-plane/sql/023_reasoning_effort.sql`
- Modify: `control-plane/src/repo.ts` (createExternalDeployment ~line 750, updateExternalDeployment ~line 769, new getExternalDeployment)
- Modify: `control-plane/src/server.ts` (ExternalStore interface ~line 15, PROVIDERS area ~line 350, POST/PATCH external ~lines 357–396, listDeployments externals loop ~line 282)
- Modify: `control-plane/src/main.ts` (externals wiring ~line 31)
- Test: `control-plane/test/server.test.ts` (fakeExternals ~line 213, new test after line 283)

**Interfaces:**
- Consumes: existing `external_deployments` table, `rid("mdep")` id helper, `fakeExternals()` test double.
- Produces: DB column `reasoning_effort TEXT NULL`; `ExternalStore.get(id)`; `ExternalStore.create/update` accepting `reasoningEffort?: string | null`; external rows carry `reasoning_effort`; merged `/v1/deployments` rows carry `reasoningEffort` (camelCase, null when unset). Tasks 2–4 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

Append to `control-plane/test/server.test.ts` after the test ending at line 283 (`external create validates: custom needs baseUrl, name collisions 409`):

```ts
test("external reasoningEffort: validated, persisted, patched, cleared; custom rejected", async () => {
  const { store } = fakeStore();
  const { externals } = fakeExternals();
  const app = buildServer(catalog, store, undefined, externals);
  const bad = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "r1", provider: "openai", modelId: "gpt-5.1", reasoningEffort: "garbage" } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /reasoningEffort/);
  const customRe = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "r2", provider: "custom", baseUrl: "http://h:1/v1", modelId: "m", reasoningEffort: "low" } });
  assert.equal(customRe.statusCode, 400);
  assert.match(customRe.json().error, /custom endpoints/);

  const ok = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "r3", provider: "openai", modelId: "gpt-5.1", reasoningEffort: "high" } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().reasoning_effort, "high");
  const id = ok.json().id;

  // merged deployments view exposes camelCase
  const list = (await app.inject({ method: "GET", url: "/v1/deployments" })).json();
  assert.equal(list.deployments.find((d: any) => d.name === "r3").reasoningEffort, "high");

  const upd = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${id}`,
    payload: { reasoningEffort: "medium" } });
  assert.equal(upd.statusCode, 200);
  assert.equal(upd.json().reasoning_effort, "medium");

  // omitted field leaves the value unchanged
  const noop = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${id}`,
    payload: { modelId: "gpt-5.2" } });
  assert.equal(noop.json().reasoning_effort, "medium");

  // explicit null clears
  const clear = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${id}`,
    payload: { reasoningEffort: null } });
  assert.equal(clear.json().reasoning_effort, null);

  const badPatch = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${id}`,
    payload: { reasoningEffort: "xhigh" } });
  assert.equal(badPatch.statusCode, 400);

  // PATCH on a custom endpoint rejects a non-null value
  const cust = (await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "r4", provider: "custom", baseUrl: "http://h:1/v1", modelId: "m" } })).json();
  const custPatch = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${cust.id}`,
    payload: { reasoningEffort: "low" } });
  assert.equal(custPatch.statusCode, 400);
});
```

Update `fakeExternals()` (line 213) so the double mirrors the new store shape — replace the whole function with:

```ts
function fakeExternals() {
  const rows: any[] = [];
  let seq = 0;
  const externals = {
    async create(d: any) {
      const row = { id: `mdep_t${seq++}`, name: d.name, provider: d.provider,
        base_url: d.baseUrl ?? null, model_id: d.modelId, key_version: 1, has_key: d.hasKey,
        reasoning_effort: d.reasoningEffort ?? null };
      rows.push(row); return row;
    },
    async list() { return rows; },
    async get(id: string) { return rows.find((r) => r.id === id) ?? null; },
    async getByName(name: string) { return rows.find((r) => r.name === name) ?? null; },
    async update(id: string, p: any) {
      const r = rows.find((x) => x.id === id);
      if (!r) return null;
      if (p.baseUrl !== undefined) r.base_url = p.baseUrl;
      if (p.modelId !== undefined) r.model_id = p.modelId;
      if (p.reasoningEffort !== undefined) r.reasoning_effort = p.reasoningEffort;
      if (p.rotateKey) { r.key_version++; r.has_key = true; }
      return r;
    },
    async delete(id: string) {
      const i = rows.findIndex((x) => x.id === id);
      return i >= 0 ? rows.splice(i, 1)[0] : null;
    },
  };
  return { externals, rows };
}
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `cd control-plane && npx tsx --test --test-name-pattern "reasoningEffort" test/server.test.ts`
Expected: FAIL — POST with `reasoningEffort: "garbage"` returns 201 (no validation yet), so `assert.equal(bad.statusCode, 400)` throws.

- [ ] **Step 3: Create the migration**

Create `control-plane/sql/023_reasoning_effort.sql`:

```sql
-- Default reasoning effort for external deployments (spec 2026-07-12).
-- NULL = don't pass anything; the provider default applies. Applied by the
-- gateway pre-call hook only when the request carries no reasoning param.
ALTER TABLE external_deployments ADD COLUMN IF NOT EXISTS reasoning_effort TEXT
  CHECK (reasoning_effort IN ('minimal','low','medium','high'));
```

- [ ] **Step 4: Extend the repo**

In `control-plane/src/repo.ts`, replace `createExternalDeployment` (~line 750):

```ts
  async createExternalDeployment(
    d: { name: string; provider: string; baseUrl?: string; modelId: string; hasKey: boolean;
         reasoningEffort?: string | null },
  ) {
    const id = rid("mdep");
    const { rows } = await this.pool.query(
      `INSERT INTO external_deployments (id, name, provider, base_url, model_id, has_key, reasoning_effort)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, d.name, d.provider, d.baseUrl ?? null, d.modelId, d.hasKey, d.reasoningEffort ?? null],
    );
    return rows[0];
  }
```

Add below `getExternalDeploymentByName` (~line 765):

```ts
  async getExternalDeployment(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM external_deployments WHERE id = $1", [id]);
    return rows[0] ?? null;
  }
```

Replace `updateExternalDeployment` (~line 769). `reasoningEffort` uses a provided-flag because `COALESCE` cannot clear to NULL (omitted = unchanged, null = clear):

```ts
  async updateExternalDeployment(
    id: string,
    patch: { baseUrl?: string; modelId?: string; rotateKey?: boolean; reasoningEffort?: string | null },
  ) {
    const { rows } = await this.pool.query(
      `UPDATE external_deployments SET
         base_url    = COALESCE($2, base_url),
         model_id    = COALESCE($3, model_id),
         key_version = key_version + CASE WHEN $4 THEN 1 ELSE 0 END,
         has_key     = has_key OR $4,
         reasoning_effort = CASE WHEN $5 THEN $6 ELSE reasoning_effort END,
         updated_at  = now()
       WHERE id = $1 RETURNING *`,
      [id, patch.baseUrl ?? null, patch.modelId ?? null, patch.rotateKey === true,
       patch.reasoningEffort !== undefined, patch.reasoningEffort ?? null],
    );
    return rows[0] ?? null;
  }
```

- [ ] **Step 5: Extend the API**

In `control-plane/src/server.ts`, replace the `ExternalStore` interface (lines 15–21):

```ts
export interface ExternalStore {
  create(d: { name: string; provider: string; baseUrl?: string; modelId: string; hasKey: boolean;
              reasoningEffort?: string | null }): Promise<any>;
  list(): Promise<any[]>;
  get(id: string): Promise<any | null>;
  getByName(name: string): Promise<any | null>;
  update(id: string, patch: { baseUrl?: string; modelId?: string; rotateKey?: boolean;
                              reasoningEffort?: string | null }): Promise<any | null>;
  delete(id: string): Promise<any | null>;
}
```

Directly below the `PROVIDERS` const (~line 355), add:

```ts
  // Spec 2026-07-12: enum whitelist; custom endpoints rejected because LiteLLM
  // drop_params silently discards reasoning_effort for them (verified live).
  const VALID_EFFORTS = new Set(["minimal", "low", "medium", "high"]);
  const reasoningEffortError = (v: unknown, provider: string): string | null => {
    if (v == null) return null;
    if (typeof v !== "string" || !VALID_EFFORTS.has(v))
      return "reasoningEffort must be one of minimal|low|medium|high";
    if (provider === "custom") return "reasoningEffort is not supported for custom endpoints";
    return null;
  };
```

In `POST /v1/deployments/external` (line 357): widen the body type and validate after the custom-baseUrl check (after line 364):

```ts
    const b = req.body as { name?: string; provider?: string; baseUrl?: string; modelId?: string;
                            apiKey?: string; reasoningEffort?: string | null };
```
```ts
    const reErr = reasoningEffortError(b.reasoningEffort, b.provider!);
    if (reErr) return reply.code(400).send({ error: reErr });
```

and pass it through in the `externals.create` call (line 369):

```ts
    const row = await externals.create({
      name: b.name, provider: b.provider!, baseUrl: b.baseUrl, modelId: b.modelId, hasKey,
      reasoningEffort: b.reasoningEffort ?? null,
    });
```

In `PATCH /v1/deployments/external/:id` (line 380), replace the body-type line and the phase-1 update block (lines 383–386) with a get-first existence check so the provider is known before writing:

```ts
    const b = req.body as { baseUrl?: string; modelId?: string; apiKey?: string;
                            reasoningEffort?: string | null };
    const existing = await externals.get(id);
    if (!existing) return reply.code(404).send({ error: "not found" });
    const reErr = reasoningEffortError(b?.reasoningEffort, existing.provider);
    if (reErr) return reply.code(400).send({ error: reErr });
    // Phase 1: non-credential fields.
    let row = await externals.update(id, {
      baseUrl: b?.baseUrl, modelId: b?.modelId, reasoningEffort: b?.reasoningEffort,
    });
    if (!row) return reply.code(404).send({ error: "not found" });
```

In `listDeployments` (line 282), add the camelCase field to the external row literal:

```ts
      locals.push({
        kind: "external", id: e.id, name: e.name, provider: e.provider, modelId: e.model_id,
        baseUrl: e.base_url, reasoningEffort: e.reasoning_effort ?? null,
        phase: "External", downloadPercent: null, readyReplicas: 0,
        tokensPerSec: null, queueDepth: null,
      } as any);
```

In `control-plane/src/main.ts`, add the `get` mapping to the externals wiring (line 31–37):

```ts
}, {
  create: (d) => repo.createExternalDeployment(d),
  list: () => repo.listExternalDeployments(),
  get: (id) => repo.getExternalDeployment(id),
  getByName: (n) => repo.getExternalDeploymentByName(n),
  update: (id, p) => repo.updateExternalDeployment(id, p),
  delete: (id) => repo.deleteExternalDeployment(id),
});
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `cd control-plane && npx tsx --test --test-name-pattern "reasoningEffort" test/server.test.ts`
Expected: PASS.
Run: `cd control-plane && npm test` — Expected: full suite green (105 + 1 new).
Run: `cd control-plane && npx tsc --noEmit` — Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add control-plane/sql/023_reasoning_effort.sql control-plane/src/repo.ts control-plane/src/server.ts control-plane/src/main.ts control-plane/test/server.test.ts
git commit -m "feat(cp): reasoning_effort on external deployments — column, validation, merged view"
```

---

### Task 2: Gateway config emit

**Files:**
- Modify: `control-plane/src/gateway-config.ts` (ExternalLike ~line 10, externals loop ~line 45)
- Test: `control-plane/test/gateway-config.test.ts`

**Interfaces:**
- Consumes: external rows now carrying `reasoning_effort` (Task 1).
- Produces: `model_info.devproof_reasoning_effort: "<effort>"` on external routes when set, key absent when null. Task 3's hook reads exactly this key.

- [ ] **Step 1: Write the failing test**

Append to `control-plane/test/gateway-config.test.ts` (the `ext` helper at line 35 already exists):

```ts
test("external reasoning_effort lands in model_info for the gateway hook", () => {
  const cfg = parse(buildGatewayConfig([], [
    ext({ reasoning_effort: "high" }),
    ext({ id: "mdep_b1", name: "plain" }),
  ]));
  const by = Object.fromEntries(cfg.model_list.map((m: any) => [m.model_name, m]));
  assert.equal(by.gpt4o.model_info.devproof_reasoning_effort, "high");
  assert.equal("devproof_reasoning_effort" in by.plain.model_info, false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd control-plane && npx tsx --test --test-name-pattern "reasoning_effort lands" test/gateway-config.test.ts`
Expected: FAIL — `by.gpt4o.model_info.devproof_reasoning_effort` is `undefined`.

- [ ] **Step 3: Implement the emit**

In `control-plane/src/gateway-config.ts`, add to `ExternalLike` (after `has_key: boolean;`, line 17):

```ts
  reasoning_effort?: string | null;
```

Replace the `model_info` line in the externals loop (line 61):

```ts
      model_info: {
        devproof_sanitize: e.provider === "custom", key_version: e.key_version,
        // Read by the custom_callbacks.py pre-call hook: default reasoning
        // effort applied only when the request carries no reasoning param.
        ...(e.reasoning_effort ? { devproof_reasoning_effort: e.reasoning_effort } : {}),
      },
```

(Keep the existing comment block about sanitize/key_version above it intact.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd control-plane && npm test` — Expected: green.
Run: `cd control-plane && npx tsc --noEmit` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/gateway-config.ts control-plane/test/gateway-config.test.ts
git commit -m "feat(gateway): emit devproof_reasoning_effort in model_info for external routes"
```

---

### Task 3: Gateway pre-call hook + live behavioral verification

**Files:**
- Modify: `deploy/gateway/litellm.yaml` (custom_callbacks.py inside the litellm-config ConfigMap: after line 82 `SANITIZE_MODELS, SCRUB_ALL = _load_sanitize_models()`, and inside `SchemaSanitizer.async_pre_call_hook` at line 258)

There is no unit-test harness for the ConfigMap Python — verification is behavioral against the live cluster with a mock provider (technique already proven during design). The CP must run Task 1+2 code for the config emit to exist.

**Interfaces:**
- Consumes: `model_info.devproof_reasoning_effort` from Task 2; existing `CONFIG_PATH`, `CustomLogger` plumbing.
- Produces: requests to a configured endpoint gain `reasoning_effort` unless they already carry `reasoning_effort`, `thinking`, or `reasoning`.

- [ ] **Step 1: Add the loader**

In `deploy/gateway/litellm.yaml`, directly after line 82 (`SANITIZE_MODELS, SCRUB_ALL = _load_sanitize_models()`), insert (matching the ConfigMap's 4-space indent):

```python
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
```

- [ ] **Step 2: Apply the default in the pre-call hook**

In `SchemaSanitizer.async_pre_call_hook` (line 258), directly after the scrub block:

```python
            if SCRUB_ALL or data.get("model") in SANITIZE_MODELS:
                for t in data.get("tools") or []:
                    _scrub(t)
```

insert:

```python
            try:  # reasoning default must never fail a request
                eff = REASONING_EFFORTS.get(data.get("model"))
                if eff and not any(k in data for k in ("reasoning_effort", "thinking", "reasoning")):
                    data["reasoning_effort"] = eff
            except Exception as e:  # noqa: BLE001
                print(f"devproof-reasoning: apply failed: {e}", flush=True)
```

- [ ] **Step 3: Restart the dev CP on Task 1+2 code, apply the ConfigMap, roll the gateway**

```bash
# restart the dev control plane (kill the process on :7080, then relaunch per CLAUDE.md run notes)
kubectl apply -f deploy/gateway/litellm.yaml
curl -s -X POST http://localhost:7080/v1/gateway/sync     # CP regenerates config.yaml (apply reset it to the manifest's static copy)
kubectl -n devproof-gateway rollout restart deploy/gateway  # reload callbacks + config
kubectl -n devproof-gateway rollout status deploy/gateway --timeout=180s
```

Expected: rollout completes; `kubectl -n devproof-gateway logs deploy/gateway | grep devproof-reasoning` shows nothing yet (no endpoint configured) or `defaults {}`-free silence — no parse-failure line.

- [ ] **Step 4: Behavioral verification with a mock provider**

Write `mock-provider.js` in the scratchpad (logs every forwarded body, answers valid OpenAI/Anthropic responses):

```js
const http = require("http");
const fs = require("fs");
const LOG = process.argv[2] || "mock-provider.log";
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = null;
    try { parsed = body ? JSON.parse(body) : null; } catch { parsed = { raw: body.slice(0, 500) }; }
    fs.appendFileSync(LOG, JSON.stringify({ path: req.url, body: parsed }) + "\n");
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.includes("/messages")) {
      res.end(JSON.stringify({ id: "msg_01", type: "message", role: "assistant",
        model: parsed?.model ?? "probe", content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    } else {
      res.end(JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", created: 1,
        model: parsed?.model ?? "probe",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  });
}).listen(8099, () => console.log("mock listening on 8099"));
```

Run it (`node mock-provider.js mock-provider.log`), then:

```bash
# temp API key (note the returned dpk_… as $KEY and the ids for cleanup)
curl -s -X POST http://localhost:7080/v1/api-keys -H 'content-type: application/json' -d '{"name":"probe-reasoning"}'
# probe endpoint WITH default effort low, backed by the mock
curl -s -X POST http://localhost:7080/v1/deployments/external -H 'content-type: application/json' \
  -d '{"name":"probe-ant","provider":"anthropic","baseUrl":"http://host.docker.internal:8099","modelId":"<model-id>","apiKey":"sk-ant-dummy","reasoningEffort":"low"}'
kubectl -n devproof-gateway rollout status deploy/gateway --timeout=180s   # config change rolls it

# V1 — default applied: NO reasoning param in the request
curl -s http://localhost:14000/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"probe-ant","messages":[{"role":"user","content":"hi"}],"max_tokens":2000}'
# V2 — client wins: explicit reasoning_effort high
curl -s http://localhost:14000/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"probe-ant","messages":[{"role":"user","content":"hi"}],"reasoning_effort":"high","max_tokens":8000}'
# V3 — anthropic-format client wins: explicit thinking 2048
curl -s http://localhost:14000/v1/messages -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"probe-ant","max_tokens":4000,"thinking":{"type":"enabled","budget_tokens":2048},"messages":[{"role":"user","content":"hi"}]}'
```

Expected in `mock-provider.log` (order = V1, V2, V3):
- V1: `"thinking":{"type":"enabled","budget_tokens":1024}` — the configured `low` default was injected and translated.
- V2: `"budget_tokens":4096` — client's `high` won over the default.
- V3: `"budget_tokens":2048` — client's explicit `thinking` passed through; the hook did NOT override it. **If this shows 4096 or a `reasoning_effort` alongside**, the guard key tuple missed the Anthropic-format key: add a temporary `print(sorted(data.keys()), flush=True)` before the guard, re-roll, inspect `kubectl logs`, extend the tuple with the actual key, remove the print, re-verify.

- [ ] **Step 5: Clean up probes**

```bash
curl -s -X DELETE http://localhost:7080/v1/deployments/external/<probe-ant-id>
curl -s -X DELETE http://localhost:7080/v1/api-keys/<probe-key-id>
# kill the mock-provider node process
```

- [ ] **Step 6: Commit**

```bash
git add deploy/gateway/litellm.yaml
git commit -m "feat(gateway): apply per-endpoint reasoning_effort default in pre-call hook"
```

---

### Task 4: Console — modal dropdown + detail display

**Files:**
- Modify: `console/app/deployments/deploy-modal.tsx` (Ctx ~line 19, remote state ~line 55, provider select ~line 186, remote fields ~line 191, submit ~lines 88–98, EditDeploymentName ~lines 259–267)
- Modify: `console/app/deployments/[name]/tabs.tsx` (EditDeploymentName call ~line 17, Serving card external block ~line 61)

No console test harness — verification is `npx next build` + live pages. Uses shared `Modal`/`Field` (never `prompt()`).

**Interfaces:**
- Consumes: `reasoningEffort` on merged deployment rows (Task 1) and the POST/PATCH body field (Task 1).
- Produces: dropdown labeled `Reasoning` with options `— (provider default)` / minimal / low / medium / high, hidden for `provider === "custom"`; detail-page `Reasoning` row shown only when set.

- [ ] **Step 1: Modal — Ctx, state, submit bodies**

In `console/app/deployments/deploy-modal.tsx`:

Add to `interface Ctx` (after `modelId?: string;`, line 30):

```ts
  reasoningEffort?: string | null; // edit-remote
```

Add to the remote-fields state block (after `const [apiKey, setApiKey] = useState("");`, line 58):

```ts
  const [reasoningEffort, setReasoningEffort] = useState(ctx.reasoningEffort ?? "");
```

In the provider `<select>` onChange (line 186), reset the effort when switching to custom:

```tsx
            <select value={provider} onChange={(e) => { setProvider(e.target.value); setBaseUrl(""); setProbe(null); if (e.target.value === "custom") setReasoningEffort(""); }}>
```

In `submit`, the `deploy-remote` body (line 89) becomes:

```ts
        name, provider, baseUrl: baseUrl || undefined, modelId, apiKey: apiKey || undefined,
        ...(reasoningEffort ? { reasoningEffort } : {}),
```

and the `edit-remote` body (line 97) becomes (always sent: empty string → null clears):

```ts
        modelId: modelId || undefined, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined,
        reasoningEffort: reasoningEffort || null,
```

- [ ] **Step 2: Modal — the dropdown field**

Insert after the `Model id` Field (after line 193, before `Base URL`):

```tsx
        {provider !== "custom" && (
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
        )}
```

- [ ] **Step 3: Edit plumbing + detail display**

In `EditDeploymentName` (line 259), extend the external props variant and ctx:

```ts
  | { kind: "external"; name: string; externalId: string; provider?: string; baseUrl?: string | null;
      modelId?: string; reasoningEffort?: string | null; asButton?: boolean }) {
```
```ts
    : { name: props.name, externalId: props.externalId, provider: props.provider, baseUrl: props.baseUrl,
        modelId: props.modelId, reasoningEffort: props.reasoningEffort };
```

In `console/app/deployments/[name]/tabs.tsx`, pass the prop (lines 17–18):

```tsx
          ? <EditDeploymentName asButton kind="external" name={d.name} externalId={d.id}
              provider={d.provider} baseUrl={d.baseUrl ?? null} modelId={d.modelId}
              reasoningEffort={d.reasoningEffort ?? null} />
```

and in the Serving card's external block (after the `Model` row, line 63), a row shown only when set:

```tsx
              {d.reasoningEffort && (
                <div className="row"><span className="muted">Reasoning</span><span>{d.reasoningEffort}</span></div>
              )}
```

- [ ] **Step 4: Build and restart the console**

```bash
cd console && npx next build
# kill the process on :7090, then: npx next start -p 7090
```

Expected: build clean (no type errors), `/deployments` and a deployment detail page return 200.

- [ ] **Step 5: Live UI check**

On `/deployments` → "Add remote endpoint": Reasoning dropdown visible for OpenAI/Anthropic/OpenRouter, disappears when provider = OpenAI-compatible (custom). On an external deployment's detail page → Edit: value prefilled; setting it shows the Reasoning row on the Serving card after save; clearing to `— (provider default)` removes the row.

- [ ] **Step 6: Commit**

```bash
git add console/app/deployments/deploy-modal.tsx console/app/deployments/[name]/tabs.tsx
git commit -m "feat(console): reasoning effort dropdown on remote endpoints + detail display"
```

---

### Task 5: End-to-end verification + docs

**Files:**
- Modify: `CLAUDE.md` (External model endpoints bullet)

**Interfaces:**
- Consumes: everything above, live.

- [ ] **Step 1: Full-chain verification (spec §8, definition of done)**

With CP, console, and gateway running the new code:

1. Console: create an external endpoint (any named provider) with Reasoning = high. Confirm the dropdown hides for the custom provider.
2. `kubectl -n devproof-gateway get cm litellm-config -o yaml | grep devproof_reasoning_effort` → shows `devproof_reasoning_effort: high` on that route; gateway rolled (`kubectl -n devproof-gateway rollout status deploy/gateway`).
3. Mock-provider spot check (reuse Task 3 technique) if the endpoint was mock-backed; otherwise Task 3's V1–V3 results stand as the behavioral proof.
4. All console pages 200: `/`, `/catalog`, `/deployments`, `/pools`, the endpoint's detail page.
5. `cd control-plane && npm test && npx tsc --noEmit` — green/clean.
6. Delete the endpoint created in 1 if it was only for verification.

- [ ] **Step 2: Update CLAUDE.md**

In the `External model endpoints` bullet, extend the end (after `sanitizer applies only to \`devproof_local\` entries`):

```
; optional per-endpoint `reasoning_effort` (minimal|low|medium|high, named providers only — custom endpoints 400, LiteLLM drops the param for them) is applied by the gateway pre-call hook ONLY when the request carries no reasoning param (`reasoning_effort`/`thinking`/`reasoning`) — NULL = provider default, nothing injected.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: reasoning_effort defaults for external endpoints"
```
