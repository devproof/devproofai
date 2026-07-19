# Reasoning Effort Free-Text Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The external-deployment Reasoning field becomes free text for all providers (including custom, injected via `extra_body`), with Test connection sending a tiny real completion to validate the value against the provider.

**Architecture:** Reworks the shipped enum feature (merge 74b8ecf): DB CHECK dropped (migration 024), API validation reduced to trim/sanity, the gateway hook gains an `extra_body` injection slot for custom routes, the console dropdown becomes a text input, and the CP test route gains a completion probe speaking each provider's native reasoning dialect.

**Tech Stack:** Postgres (re-run-every-boot migrations), Fastify, LiteLLM ConfigMap Python callbacks, Next.js console (prod builds), Node test runner (`node:http` in-test servers).

Spec: `docs/superpowers/specs/2026-07-12-reasoning-effort-freetext-design.md`.

## Global Constraints

- Validation: trim first, then reject when not a string / trimmed empty / trimmed contains whitespace / trimmed length > 32; error string verbatim: `reasoningEffort must be a short value without whitespace (max 32 chars)`. The TRIMMED value is stored and emitted.
- The old enum whitelist and the custom-provider 400 are REMOVED — `xhigh`, `max`, `none`, even `garbage` are now valid stored values; the probe is the validator.
- PATCH semantics unchanged: omitted ≠ null (omitted = keep, null = clear).
- Hook: default applies ONLY when the request carries none of `reasoning_effort` / `thinking` / `reasoning` — now checked in BOTH `data` top-level AND `data.extra_body`. Custom (sanitized) routes get the value via `extra_body`; named providers top-level. Hook must never fail a request.
- Probe slots (exact): openai + custom → top-level `reasoning_effort`; openrouter → `reasoning: {effort}`; anthropic → `POST /v1/messages` with `output_config: {effort}`. Probe uses `max_tokens: 16`, message `[{role:"user",content:"hi"}]`, 20s timeout; runs only when reasoning value AND modelId are both present.
- Console: text input `placeholder="provider default"`, shown for ALL providers; hint `vendor-specific, e.g. low / high / xhigh — Test connection validates it`.
- Migrations re-run every CP boot — idempotent DDL only (`DROP CONSTRAINT IF EXISTS`, and 023 keeps `ADD COLUMN IF NOT EXISTS`).
- Console is always a production build; shared Modal/Field primitives; no `prompt()`/`confirm()`/`alert()`.

---

### Task 1: Free the column — migrations, validation, tests

**Files:**
- Modify: `control-plane/sql/023_reasoning_effort.sql` (remove CHECK)
- Create: `control-plane/sql/024_reasoning_effort_freetext.sql`
- Modify: `control-plane/src/server.ts:361-370` (validation helper), `:381` and `:389` (POST), `:406` and `:409-411` (PATCH)
- Test: `control-plane/test/server.test.ts` (replace the test `external reasoningEffort: validated, persisted, patched, cleared; custom rejected`), `control-plane/test/gateway-config.test.ts` (extend the reasoning emit test)

**Interfaces:**
- Consumes: shipped feature state at merge 74b8ecf (helper `reasoningEffortError(v, provider)` at server.ts:364, `VALID_EFFORTS` at :363, existing tests).
- Produces: `reasoningEffortError(v: unknown): string | null` (ONE argument now — provider dropped) and `trimEffort(v)`; free-text semantics all later tasks rely on. Repo/store/gateway-config code is untouched (emit is value-agnostic).

- [ ] **Step 1: Rewrite the failing tests**

In `control-plane/test/server.test.ts`, REPLACE the entire test `external reasoningEffort: validated, persisted, patched, cleared; custom rejected` (it asserts the old enum: `"garbage"` → 400, custom+`"low"` → 400, PATCH `"xhigh"` → 400 — all now wrong) with:

```ts
test("external reasoningEffort: free text with sanity check; custom allowed; trim; PATCH semantics", async () => {
  const { store } = fakeStore();
  const { externals } = fakeExternals();
  const app = buildServer(catalog, store, undefined, externals);
  // sanity rejections: whitespace inside, overlong, non-string
  for (const bad of ["very high", "x\thigh", "a".repeat(33), 42]) {
    const res = await app.inject({ method: "POST", url: "/v1/deployments/external",
      payload: { name: "rr-bad", provider: "openai", modelId: "gpt-5.1", reasoningEffort: bad } });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.match(res.json().error, /reasoningEffort/);
  }
  // vendor vocab passes: xhigh; value is trimmed before storing
  const ok = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "rr1", provider: "openai", modelId: "gpt-5.1", reasoningEffort: " xhigh " } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().reasoning_effort, "xhigh");
  const id = ok.json().id;
  // merged view exposes camelCase
  const list = (await app.inject({ method: "GET", url: "/v1/deployments" })).json();
  assert.equal(list.deployments.find((d: any) => d.name === "rr1").reasoningEffort, "xhigh");
  // custom provider now accepts a value (extra_body path applies it at the gateway)
  const cust = await app.inject({ method: "POST", url: "/v1/deployments/external",
    payload: { name: "rr2", provider: "custom", baseUrl: "http://h:1/v1", modelId: "m", reasoningEffort: "none" } });
  assert.equal(cust.statusCode, 201);
  assert.equal(cust.json().reasoning_effort, "none");
  // PATCH: set, omitted-noop, null-clears, sanity 400
  const upd = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${id}`,
    payload: { reasoningEffort: "max" } });
  assert.equal(upd.json().reasoning_effort, "max");
  const noop = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${id}`,
    payload: { modelId: "gpt-5.2" } });
  assert.equal(noop.json().reasoning_effort, "max");
  const clear = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${id}`,
    payload: { reasoningEffort: null } });
  assert.equal(clear.json().reasoning_effort, null);
  const badPatch = await app.inject({ method: "PATCH", url: `/v1/deployments/external/${id}`,
    payload: { reasoningEffort: "two words" } });
  assert.equal(badPatch.statusCode, 400);
});
```

Note: the shipped test also had a trailing custom-PATCH block (`cust`/`custPatch`/`custNull` asserting 400 for `"low"` on custom and 200 for null) — that block is deleted with the rest of the old test; the replacement above covers custom via `rr2`.

In `control-plane/test/gateway-config.test.ts`, extend the test `external reasoning_effort lands in model_info for the gateway hook`: add a custom row to the `buildGatewayConfig` call and one assertion:

```ts
    ext({ id: "mdep_c2", name: "gpu-think", provider: "custom",
          base_url: "http://h:1/v1", has_key: false, reasoning_effort: "xhigh" }),
```
```ts
  assert.equal(by["gpu-think"].model_info.devproof_reasoning_effort, "xhigh");
```

- [ ] **Step 2: Run to verify the new expectations fail**

Run: `cd control-plane && npx tsx --test --test-name-pattern "free text with sanity" test/server.test.ts`
Expected: FAIL — POST with `" xhigh "` returns 400 (old enum whitelist still active).

- [ ] **Step 3: Migrations**

Replace the full contents of `control-plane/sql/023_reasoning_effort.sql`:

```sql
-- Default reasoning effort for external deployments (spec 2026-07-12;
-- free text since the same-day rework — vendor vocabularies differ
-- (xhigh, max, none, …) and keep drifting, so no DB enum. Validation =
-- API sanity check + the Test connection completion probe).
-- NULL = don't pass anything; the provider default applies.
ALTER TABLE external_deployments ADD COLUMN IF NOT EXISTS reasoning_effort TEXT;
```

Create `control-plane/sql/024_reasoning_effort_freetext.sql`:

```sql
-- Reasoning effort became free text (spec 2026-07-12 rework). Existing
-- databases created the column WITH the enum CHECK via the original 023;
-- drop it. Fresh databases never get it (023 was edited in place — legal
-- here because migrate() re-runs every file and 023's ADD COLUMN IF NOT
-- EXISTS skips entirely once the column exists).
ALTER TABLE external_deployments
  DROP CONSTRAINT IF EXISTS external_deployments_reasoning_effort_check;
```

- [ ] **Step 4: Replace the validation helper and its call sites**

In `control-plane/src/server.ts`, replace lines 361–370 (the comment, `VALID_EFFORTS`, and `reasoningEffortError`) with:

```ts
  // Reasoning effort is free text (spec 2026-07-12 rework): vendor
  // vocabularies differ (xhigh, max, none, …) and keep drifting. Sanity-only
  // here — the real validator is the Test connection completion probe.
  const reasoningEffortError = (v: unknown): string | null => {
    if (v == null) return null;
    const t = typeof v === "string" ? v.trim() : null;
    if (t == null || !t || /\s/.test(t) || t.length > 32)
      return "reasoningEffort must be a short value without whitespace (max 32 chars)";
    return null;
  };
  const trimEffort = (v: string | null | undefined) => (typeof v === "string" ? v.trim() : v);
```

POST route: line 381 becomes `const reErr = reasoningEffortError(b.reasoningEffort);` and the create call's field (line 389) becomes `reasoningEffort: trimEffort(b.reasoningEffort) ?? null,`.

PATCH route: line 406 becomes `const reErr = reasoningEffortError(b?.reasoningEffort);` and the update call (lines 409–411) becomes:

```ts
    let row = await externals.update(id, {
      baseUrl: b?.baseUrl, modelId: b?.modelId, reasoningEffort: trimEffort(b?.reasoningEffort),
    });
```

(`trimEffort` maps `undefined` → `undefined` and `null` → `null`, preserving omitted ≠ null. The `externals.get` existence check stays — it still provides 404-before-write.)

- [ ] **Step 5: Run tests and typecheck**

Run: `cd control-plane && npm test` — Expected: all pass (same count; tests were replaced, not added).
Run: `cd control-plane && npx tsc --noEmit` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add control-plane/sql/023_reasoning_effort.sql control-plane/sql/024_reasoning_effort_freetext.sql control-plane/src/server.ts control-plane/test/server.test.ts control-plane/test/gateway-config.test.ts
git commit -m "feat(cp): reasoning effort is free text — drop enum + custom-provider 400 (migration 024)"
```

---

### Task 2: Reasoning-aware Test connection probe

**Files:**
- Modify: `control-plane/src/server.ts:437-451` (the `/v1/deployments/external/test` route)
- Test: `control-plane/test/server.test.ts` (new test with an in-test `node:http` server)

**Interfaces:**
- Consumes: `PROVIDERS` preset table (server.ts:354–359), Task 1's free-text semantics.
- Produces: test route accepting `modelId?: string` and `reasoningEffort?: string | null`; response `{ok, detail}` with `detail: "completion ok — reasoning accepted"` on 2xx probe, `"HTTP <status>: <body ≤200 chars>"` on provider rejection, and the reachability detail suffixed with ` — enter a model id to validate reasoning` when the value is set but modelId is empty. Task 4's console sends the two new fields.

- [ ] **Step 1: Write the failing test**

Append to `control-plane/test/server.test.ts`:

```ts
test("external test probe sends reasoning in the provider-native slot", async (t) => {
  const { createServer } = await import("node:http");
  const seen: { path: string | undefined; body: any }[] = [];
  let status = 200;
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? JSON.stringify({ ok: true })
                             : JSON.stringify({ error: { message: "Invalid value: 'hgih'" } }));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const { store } = fakeStore();
  const app = buildServer(catalog, store, undefined, fakeExternals().externals);

  // custom → flat reasoning_effort on /chat/completions
  const custom = await app.inject({ method: "POST", url: "/v1/deployments/external/test",
    payload: { provider: "custom", baseUrl: base, modelId: "m1", reasoningEffort: "high" } });
  assert.equal(custom.json().ok, true);
  assert.match(custom.json().detail, /reasoning accepted/);
  assert.equal(seen[0].path, "/chat/completions");
  assert.equal(seen[0].body.reasoning_effort, "high");
  assert.equal(seen[0].body.max_tokens, 16);

  // openrouter → nested reasoning.effort, no flat param
  const router = await app.inject({ method: "POST", url: "/v1/deployments/external/test",
    payload: { provider: "openrouter", baseUrl: base, modelId: "m1", reasoningEffort: "xhigh" } });
  assert.equal(router.json().ok, true);
  assert.deepEqual(seen[1].body.reasoning, { effort: "xhigh" });
  assert.equal(seen[1].body.reasoning_effort, undefined);

  // anthropic → /v1/messages with output_config.effort
  const ant = await app.inject({ method: "POST", url: "/v1/deployments/external/test",
    payload: { provider: "anthropic", baseUrl: base, modelId: "m2", reasoningEffort: "max", apiKey: "sk-a" } });
  assert.equal(ant.json().ok, true);
  assert.equal(seen[2].path, "/v1/messages");
  assert.deepEqual(seen[2].body.output_config, { effort: "max" });

  // provider rejection surfaces status + body text
  status = 400;
  const bad = await app.inject({ method: "POST", url: "/v1/deployments/external/test",
    payload: { provider: "custom", baseUrl: base, modelId: "m1", reasoningEffort: "hgih" } });
  assert.equal(bad.json().ok, false);
  assert.match(bad.json().detail, /HTTP 400/);
  assert.match(bad.json().detail, /Invalid value/);

  // reasoning set but no model id → reachability probe + hint
  status = 200;
  const noModel = await app.inject({ method: "POST", url: "/v1/deployments/external/test",
    payload: { provider: "custom", baseUrl: base, reasoningEffort: "high" } });
  assert.equal(noModel.json().ok, true);
  assert.match(noModel.json().detail, /enter a model id to validate reasoning/);
  assert.equal(seen[seen.length - 1].path, "/models");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd control-plane && npx tsx --test --test-name-pattern "provider-native slot" test/server.test.ts`
Expected: FAIL — the route ignores `reasoningEffort` and hits `/models`, so `seen[0].path` is `"/models"`, not `"/chat/completions"`.

- [ ] **Step 3: Replace the test route**

In `control-plane/src/server.ts`, replace the whole `app.post("/v1/deployments/external/test", …)` handler (lines 437–451, keeping the comment block above it) with:

```ts
  app.post("/v1/deployments/external/test", async (req, reply) => {
    const b = req.body as { provider?: string; baseUrl?: string; apiKey?: string;
                            modelId?: string; reasoningEffort?: string | null };
    const preset = PROVIDERS[b?.provider ?? ""];
    if (!preset) return reply.code(400).send({ error: "unknown provider" });
    const base = (b.baseUrl || preset.base).replace(/\/$/, "");
    if (!base) return reply.code(400).send({ error: "baseUrl required for custom provider" });
    const headers: Record<string, string> = b.provider === "anthropic"
      ? { "x-api-key": b.apiKey ?? "", "anthropic-version": "2023-06-01" }
      : b.apiKey ? { Authorization: `Bearer ${b.apiKey}` } : {};
    const eff = typeof b.reasoningEffort === "string" ? b.reasoningEffort.trim() : "";
    try {
      if (eff && b.modelId) {
        // Reasoning value set → tiny real completion with the value in the
        // provider-native slot, so the provider itself validates the
        // vocabulary (spec 2026-07-12 rework §6). Costs a few tokens.
        headers["Content-Type"] = "application/json";
        const [path, body] = b.provider === "anthropic"
          ? ["/v1/messages", { model: b.modelId, max_tokens: 16, output_config: { effort: eff },
                               messages: [{ role: "user", content: "hi" }] }] as const
          : ["/chat/completions", { model: b.modelId, max_tokens: 16,
                                    messages: [{ role: "user", content: "hi" }],
                                    ...(b.provider === "openrouter" ? { reasoning: { effort: eff } }
                                                                    : { reasoning_effort: eff }) }] as const;
        const res = await fetch(base + path, { method: "POST", headers,
          body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
        if (res.ok) return { ok: true, detail: "completion ok — reasoning accepted" };
        const text = (await res.text().catch(() => "")).slice(0, 200);
        return { ok: false, detail: `HTTP ${res.status}${text ? `: ${text}` : ""}` };
      }
      const res = await fetch(base + preset.modelsPath, { headers, signal: AbortSignal.timeout(8000) });
      const suffix = eff && !b.modelId ? " — enter a model id to validate reasoning" : "";
      return { ok: res.ok, detail: res.ok ? `reachable (HTTP ${res.status})${suffix}` : `HTTP ${res.status}` };
    } catch (err: any) {
      return { ok: false, detail: String(err?.cause?.message ?? err?.message ?? err) };
    }
  });
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd control-plane && npm test` — Expected: all pass (one new test).
Run: `cd control-plane && npx tsc --noEmit` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/server.ts control-plane/test/server.test.ts
git commit -m "feat(cp): test connection validates reasoning via a provider-native completion probe"
```

---

### Task 3: Hook — extra_body slot for custom routes

**Files:**
- Modify: `deploy/gateway/litellm.yaml` (the reasoning apply block inside `SchemaSanitizer.async_pre_call_hook`, currently lines 282–287)

No unit harness for the ConfigMap Python — verification is live with a mock provider. Requires the dev CP running Task 1 code (free text accepted) — restart it first if it predates Task 1.

**Interfaces:**
- Consumes: `REASONING_EFFORTS` and `SANITIZE_MODELS` module maps (already in the file), `model_info.devproof_reasoning_effort` emitted for custom rows (generic emit — no gateway-config change).
- Produces: custom (sanitized) routes get the default via `data["extra_body"]["reasoning_effort"]`; named providers keep top-level; guard covers both locations.

- [ ] **Step 1: Replace the apply block**

In `deploy/gateway/litellm.yaml`, replace exactly this block (inside `async_pre_call_hook`, after the tool-scrub `if`):

```python
            try:  # reasoning default must never fail a request
                eff = REASONING_EFFORTS.get(data.get("model"))
                if eff and not any(k in data for k in ("reasoning_effort", "thinking", "reasoning")):
                    data["reasoning_effort"] = eff
            except Exception as e:  # noqa: BLE001
                print(f"devproof-reasoning: apply failed: {e}", flush=True)
```

with:

```python
            try:  # reasoning default must never fail a request
                eff = REASONING_EFFORTS.get(data.get("model"))
                if eff:
                    keys = ("reasoning_effort", "thinking", "reasoning")
                    eb = data.get("extra_body") or {}
                    if not any(k in data or k in eb for k in keys):
                        if data.get("model") in SANITIZE_MODELS:
                            # llama.cpp-class backend: LiteLLM drop_params strips
                            # top-level reasoning_effort for these routes; extra_body
                            # passes verbatim (verified live 2026-07-12) and unknown
                            # fields are ignored by backends without support.
                            data.setdefault("extra_body", {})["reasoning_effort"] = eff
                        else:
                            data["reasoning_effort"] = eff
            except Exception as e:  # noqa: BLE001
                print(f"devproof-reasoning: apply failed: {e}", flush=True)
```

(Indentation: the replaced block sits at the same 12-space depth inside the method; inner lines step by 4 as shown. `SANITIZE_MODELS` membership = custom externals; local models are sanitized too but never appear in `REASONING_EFFORTS`, so the intersection is safe.)

- [ ] **Step 2: Apply + roll**

```bash
kubectl apply -f deploy/gateway/litellm.yaml
curl -s -X POST http://localhost:7080/v1/gateway/sync      # regenerate config.yaml (apply reset it)
kubectl -n devproof-gateway rollout restart deploy/gateway
kubectl -n devproof-gateway rollout status deploy/gateway --timeout=180s
```

Expected: rollout completes; `kubectl -n devproof-gateway logs deploy/gateway --tail=200 | grep devproof-reasoning` shows no parse/apply failure lines.

- [ ] **Step 3: Live behavioral verification (mock provider)**

Reuse the mock server from the previous feature round — write this `mock-provider.js` to the scratchpad and run `node mock-provider.js mock-provider.log` in the background:

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
    res.end(JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", created: 1,
      model: parsed?.model ?? "probe",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
}).listen(8099, () => console.log("mock listening on 8099"));
```

Then (note the ids/key from the create responses for cleanup):

```bash
# temp key + custom endpoint WITH stored effort (free text now accepted)
curl -s -X POST http://localhost:7080/v1/api-keys -H 'content-type: application/json' -d '{"name":"probe-rework"}'
curl -s -X POST http://localhost:7080/v1/deployments/external -H 'content-type: application/json' \
  -d '{"name":"probe-cx","provider":"custom","baseUrl":"http://host.docker.internal:8099/v1","modelId":"probe","reasoningEffort":"xhigh"}'
kubectl -n devproof-gateway rollout status deploy/gateway --timeout=180s

# V1 — default applied via extra_body: request WITHOUT reasoning param
curl -s http://localhost:14000/v1/chat/completions -H "Authorization: Bearer <KEY>" -H 'content-type: application/json' \
  -d '{"model":"probe-cx","messages":[{"role":"user","content":"hi"}],"max_tokens":10}'
# V2 — client wins: explicit reasoning_effort via extra_body
curl -s http://localhost:14000/v1/chat/completions -H "Authorization: Bearer <KEY>" -H 'content-type: application/json' \
  -d '{"model":"probe-cx","messages":[{"role":"user","content":"hi"}],"max_tokens":10,"extra_body":{"reasoning_effort":"low"}}'
```

Expected in `mock-provider.log`:
- V1: body contains `"reasoning_effort":"xhigh"` (stored default injected via extra_body and forwarded).
- V2: body contains `"reasoning_effort":"low"` and NOT `xhigh` (client's extra_body value won; guard saw it).

If V1 shows no reasoning_effort: check `kubectl logs` for `devproof-reasoning` lines and that the ConfigMap's `config.yaml` carries `devproof_reasoning_effort: xhigh` for `probe-cx` (re-run the sync + rollout if the apply/sync ordering was missed).

- [ ] **Step 4: Clean up probes**

```bash
curl -s -X DELETE http://localhost:7080/v1/deployments/external/<probe-cx-id>
curl -s -X DELETE http://localhost:7080/v1/api-keys/<probe-key-id>
# kill the mock-provider node process (port 8099)
```

- [ ] **Step 5: Commit**

```bash
git add deploy/gateway/litellm.yaml
git commit -m "feat(gateway): inject reasoning default via extra_body on custom routes; guard checks extra_body"
```

---

### Task 4: Console — free-text input, all providers, probe fields

**Files:**
- Modify: `console/app/deployments/deploy-modal.tsx:190` (provider onChange), `:198-208` (Reasoning field), `:107-121` (test()), hint text

**Interfaces:**
- Consumes: Task 1 free-text API; Task 2 probe fields `modelId` + `reasoningEffort` on `/v1/deployments/external/test`.
- Produces: the final UI. Submit bodies are UNCHANGED (deploy-remote spreads when set at line 92; edit-remote always sends `reasoningEffort: reasoningEffort || null` at line 101) — do not touch them.

- [ ] **Step 1: Provider onChange — drop the custom reset**

Line 190: the `onChange` loses the `if (e.target.value === "custom") setReasoningEffort("");` clause (the field now applies to custom too):

```tsx
            <select value={provider} onChange={(e) => { setProvider(e.target.value); setBaseUrl(""); setProbe(null); }}>
```

- [ ] **Step 2: Replace the dropdown with a text input, unconditional**

Replace the whole block at lines 198–208 (`{provider !== "custom" && (<Field label="Reasoning" …select…/Field>)}`) with:

```tsx
        <Field label="Reasoning" hint="vendor-specific, e.g. low / high / xhigh — Test connection validates it">
          <input value={reasoningEffort} onChange={(e) => setReasoningEffort(e.target.value)}
                 placeholder="provider default" style={{ width: 190, flex: "none" }} />
        </Field>
```

- [ ] **Step 3: test() sends the probe fields**

In `test()` (line 112), the body becomes:

```ts
        body: JSON.stringify({ provider, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined,
                               modelId: modelId || undefined, reasoningEffort: reasoningEffort || undefined }),
```

- [ ] **Step 4: Build + restart + verify**

```bash
cd /c/Users/carst/Desktop/devproofai/console && npx next build
```
Kill the :7090 listener (`Get-NetTCPConnection -LocalPort 7090 -State Listen` → `Stop-Process`), start `npx next start -p 7090` from `console/` in the background, then `curl -s -o /dev/null -w '%{http_code}' http://localhost:7090/deployments` → 200. The populated-field browser check (text input visible for custom, placeholder text, probe line) is done by the controller after review.

- [ ] **Step 5: Commit**

```bash
git add console/app/deployments/deploy-modal.tsx
git commit -m "feat(console): reasoning is a free-text field for all providers; test connection validates it"
```

---

### Task 5: Docs + end-to-end sweep

**Files:**
- Modify: `CLAUDE.md` (external endpoints bullet — replace the reasoning sentence)

- [ ] **Step 1: Replace the CLAUDE.md reasoning sentence**

In the `- **External model endpoints**` bullet, replace the segment added by the previous feature:

```
; optional per-endpoint `reasoning_effort` (minimal|low|medium|high, named providers only — custom endpoints 400, LiteLLM drops the param for them) is applied by the gateway pre-call hook ONLY when the request carries no reasoning param (`reasoning_effort`/`thinking`/`reasoning`) — NULL = provider default, nothing injected.
```

with:

```
; optional per-endpoint `reasoning_effort` (free text ≤32 chars, no whitespace — vendor vocabularies differ: xhigh, max, none, …; ALL providers incl. custom) is applied by the gateway pre-call hook ONLY when the request carries no reasoning param (`reasoning_effort`/`thinking`/`reasoning`, top-level or extra_body) — injected top-level for named providers, via `extra_body` for custom (LiteLLM drop_params strips top-level there; verified); NULL = provider default, nothing injected. Test connection validates a set value with a tiny real completion in the provider-native slot (flat `reasoning_effort` / OpenRouter `reasoning.effort` / Anthropic `output_config.effort`).
```

- [ ] **Step 2: End-to-end sweep**

1. `cd control-plane && npm test && npx tsc --noEmit` — green/clean.
2. Console pages 200: `/`, `/catalog`, `/deployments`, `/pools`.
3. Probe e2e against the mock (if still running from Task 3, else skip — Task 2's unit test covers the slots): console Test connection with provider=custom, baseUrl `http://localhost:8099/v1` (CP-side probe runs on the host — localhost reaches the mock), model id `probe`, reasoning `xhigh` → probe line `✓ completion ok — reasoning accepted`.
4. Confirm `kubectl -n devproof-gateway get cm litellm-config -o yaml | grep devproof_reasoning_effort` is empty after Task 3 cleanup (no probe endpoints left).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: reasoning effort free text + test-connection probe"
```
