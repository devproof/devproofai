import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { buildGatewayConfig, envKeyFor, newlyRouted } from "../src/gateway-config.ts";

const dep = (name: string, phase: string) => ({
  metadata: { name, namespace: "devproof-serving" },
  spec: {} as never,
  status: { phase, endpoint: `http://${name}.devproof-serving.svc.cluster.local:8080/v1/chat/completions` },
});

test("buildGatewayConfig routes only Ready deployments", () => {
  const cfg = parse(buildGatewayConfig([dep("a", "Ready"), dep("b", "Deploying")]));
  assert.equal(cfg.model_list.length, 1);
  assert.equal(cfg.model_list[0].model_name, "a");
  assert.equal(cfg.model_list[0].litellm_params.model, "openai/a");
  assert.equal(
    cfg.model_list[0].litellm_params.api_base,
    "http://a.devproof-serving.svc.cluster.local:8080/v1",
  );
});

test("buildGatewayConfig yields empty model_list when nothing is Ready", () => {
  const cfg = parse(buildGatewayConfig([dep("b", "Failed")]));
  assert.deepEqual(cfg.model_list, []);
});

test("buildGatewayConfig enables custom auth and keeps sanitizer callbacks", () => {
  const cfg = parse(buildGatewayConfig([dep("a", "Ready")]));
  assert.equal(cfg.general_settings.custom_auth, "custom_callbacks.user_custom_auth");
  // CLAUDE.md don't-regress: sanitizer callback must survive any config change.
  assert.equal(cfg.litellm_settings.callbacks, "custom_callbacks.proxy_handler_instance");
});

test("buildGatewayConfig routes /v1/messages through chat/completions (thinking survives)", () => {
  const cfg = parse(buildGatewayConfig([dep("a", "Ready")]));
  // LiteLLM's default Responses-API bridge for openai-provider models drops
  // llama.cpp reasoning (reasoning_text vs summary_text) → empty thinking
  // blocks in sessions. The chat/completions bridge maps reasoning_content
  // → thinking_delta correctly.
  assert.equal(cfg.litellm_settings.use_chat_completions_url_for_anthropic_messages, true);
});

const ext = (over: Partial<any> = {}) => ({
  id: "mdep_abc123", name: "gpt4o", provider: "openai", base_url: null,
  model_id: "gpt-4o", key_version: 3, has_key: true, ...over,
});

test("external entries map to provider-native litellm params", () => {
  const cfg = parse(buildGatewayConfig([], [
    ext(),
    ext({ id: "mdep_a1", name: "claude", provider: "anthropic", model_id: "claude-sonnet-5" }),
    ext({ id: "mdep_a2", name: "router", provider: "openrouter", model_id: "meta-llama/llama-3.1-8b" }),
    ext({ id: "mdep_a3", name: "gpu-box", provider: "custom", base_url: "http://host.docker.internal:8081/v1", has_key: false }),
  ]));
  const by = Object.fromEntries(cfg.model_list.map((m: any) => [m.model_name, m]));
  assert.equal(by.gpt4o.litellm_params.model, "openai/gpt-4o");
  assert.equal(by.gpt4o.litellm_params.api_base, undefined);
  assert.equal(by.gpt4o.litellm_params.api_key, "os.environ/DEVPROOF_EP_mdep_abc123");
  assert.equal(by.claude.litellm_params.model, "anthropic/claude-sonnet-5");
  assert.equal(by.router.litellm_params.model, "openrouter/meta-llama/llama-3.1-8b");
  assert.equal(by["gpu-box"].litellm_params.model, "openai/gpt-4o");
  assert.equal(by["gpu-box"].litellm_params.api_base, "http://host.docker.internal:8081/v1");
  assert.equal(by["gpu-box"].litellm_params.api_key, "none"); // keyless custom → dummy for LiteLLM
  // Named providers (openai/anthropic/openrouter) get full-fidelity schemas;
  // custom endpoints (llama.cpp-like) are sanitized.
  assert.equal(by.gpt4o.model_info.devproof_sanitize, false);
  assert.equal(by.claude.model_info.devproof_sanitize, false);
  assert.equal(by.router.model_info.devproof_sanitize, false);
  assert.equal(by["gpu-box"].model_info.devproof_sanitize, true);
  assert.equal(by.gpt4o.model_info.key_version, 3);
});

test("base_url override applies to known providers", () => {
  const cfg = parse(buildGatewayConfig([], [ext({ base_url: "https://eu.openai.azureish.example/v1" })]));
  assert.equal(cfg.model_list[0].litellm_params.api_base, "https://eu.openai.azureish.example/v1");
});

test("local entries are flagged devproof_sanitize for the sanitizer", () => {
  const cfg = parse(buildGatewayConfig([dep("a", "Ready")], []));
  assert.equal(cfg.model_list[0].model_info.devproof_sanitize, true);
});

test("envKeyFor sanitizes ids to env-var-safe names", () => {
  assert.equal(envKeyFor("mdep_x-1.z"), "DEVPROOF_EP_mdep_x_1_z");
});

// Tests for newlyRouted helper
const dep2 = (name: string, phase: string, endpoint = "http://x:8080") =>
  ({ metadata: { name }, status: { phase, endpoint } }) as any;

test("newlyRouted returns fresh Ready deployments once", () => {
  const routed = new Set<string>();
  assert.deepEqual(newlyRouted(routed, [dep2("m1", "Ready"), dep2("m2", "Deploying")]), ["m1"]);
  assert.deepEqual(newlyRouted(routed, [dep2("m1", "Ready"), dep2("m2", "Deploying")]), []);
});

test("a deployment that drops out of Ready re-warms when it returns", () => {
  const routed = new Set<string>();
  newlyRouted(routed, [dep2("m1", "Ready")]);
  newlyRouted(routed, [dep2("m1", "Deploying")]);   // not ready → forgotten
  assert.deepEqual(newlyRouted(routed, [dep2("m1", "Ready")]), ["m1"]);
});

test("Ready without endpoint is not routed", () => {
  const routed = new Set<string>();
  assert.deepEqual(newlyRouted(routed, [dep2("m1", "Ready", "")]), []);
});

test("external reasoning_effort lands in model_info for the gateway hook", () => {
  const cfg = parse(buildGatewayConfig([], [
    ext({ reasoning_effort: "high" }),
    ext({ id: "mdep_b1", name: "plain" }),
    ext({ id: "mdep_c1", name: "nulled", reasoning_effort: null }),
    ext({ id: "mdep_c2", name: "gpu-think", provider: "custom",
          base_url: "http://h:1/v1", has_key: false, reasoning_effort: "xhigh" }),
  ]));
  const by = Object.fromEntries(cfg.model_list.map((m: any) => [m.model_name, m]));
  assert.equal(by.gpt4o.model_info.devproof_reasoning_effort, "high");
  assert.equal("devproof_reasoning_effort" in by.plain.model_info, false);
  assert.equal("devproof_reasoning_effort" in by.nulled.model_info, false);
  assert.equal(by["gpu-think"].model_info.devproof_reasoning_effort, "xhigh");
});

test("publicApiTarget emits the /api pass-through block", () => {
  const yaml = buildGatewayConfig([], [], { publicApiTarget: "http://host.docker.internal:7080/api" });
  const cfg = parse(yaml);
  assert.deepEqual(cfg.general_settings.pass_through_endpoints, [{
    path: "/api",
    target: "http://host.docker.internal:7080/api",
    include_subpath: true,
    forward_headers: true,
    auth: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  }]);
  // custom_auth must survive — it also gates pass-through requests (verified)
  assert.equal(cfg.general_settings.custom_auth, "custom_callbacks.user_custom_auth");
});

test("no publicApiTarget → no pass_through_endpoints key (backward compatible)", () => {
  const cfg = parse(buildGatewayConfig([], []));
  assert.equal(cfg.general_settings.pass_through_endpoints, undefined);
});

test("Idle deployments stay routed (scale-to-zero)", () => {
  const cfg = buildGatewayConfig([
    { metadata: { name: "asleep", namespace: "s" }, status: { phase: "Idle", endpoint: "http://asleep.s.svc:8080/v1/chat/completions" } },
    { metadata: { name: "down", namespace: "s" }, status: { phase: "Deploying", endpoint: "http://x" } },
  ]);
  assert.match(cfg, /model_name: asleep/);
  assert.doesNotMatch(cfg, /model_name: down/);
});

test("newlyRouted never warms Idle models (CP restart must not wake sleepers)", () => {
  const routed = new Set<string>();
  const fresh = newlyRouted(routed, [
    { metadata: { name: "asleep", namespace: "s" }, status: { phase: "Idle", endpoint: "http://e" } },
    { metadata: { name: "warm", namespace: "s" }, status: { phase: "Ready", endpoint: "http://e" } },
  ]);
  assert.deepEqual(fresh, ["warm"]);
});

test("routing names become blackhole model_list entries (spec 2026-07-16)", () => {
  const cfg = parse(buildGatewayConfig([dep("a", "Ready")], [], { routingNames: ["main-route"] }));
  const r = cfg.model_list.find((m: any) => m.model_name === "main-route");
  // Listed for /v1/models discovery only — the pre-call hook rewrites the
  // model BEFORE LiteLLM routes, so this api_base is never reached; hitting
  // it is a loud hook-bug signal.
  assert.equal(r.litellm_params.api_base, "http://devproof-routing-unresolved.invalid");
  assert.equal(r.model_info.devproof_routing, true);
});

test("a routing shadowing a same-named deployment emits ONE entry, no blackhole (spec 2026-07-16)", () => {
  const cfg = parse(buildGatewayConfig([dep("a", "Ready")], [], { routingNames: ["a"] }));
  const entries = cfg.model_list.filter((m: any) => m.model_name === "a");
  // Two same-named entries would form a LiteLLM load-balance group and real
  // requests to the resolved target would round-robin onto the blackhole.
  assert.equal(entries.length, 1);
  assert.equal(entries[0].litellm_params.model, "openai/a"); // the real deployment, not the blackhole
  assert.notEqual(entries[0].litellm_params.api_base, "http://devproof-routing-unresolved.invalid");
});

test("ollama endpoints ride the openai prefix with a cloud api_base default", () => {
  const cfg = parse(buildGatewayConfig([], [
    ext({ id: "mdep_o1", name: "oss", provider: "ollama", model_id: "gpt-oss:120b" }),
    ext({ id: "mdep_o2", name: "oss-alt", provider: "ollama", model_id: "gpt-oss:120b",
          base_url: "https://alt.example.com/v1" }),
  ]));
  const by = Object.fromEntries(cfg.model_list.map((m: any) => [m.model_name, m]));
  assert.equal(by.oss.litellm_params.model, "openai/gpt-oss:120b");
  // ollama rides the openai/ prefix — without this default an empty base_url
  // would silently route to api.openai.com.
  assert.equal(by.oss.litellm_params.api_base, "https://ollama.com/v1");
  assert.equal(by.oss.model_info.devproof_sanitize, false);
  // Explicit base_url wins over the provider default.
  assert.equal(by["oss-alt"].litellm_params.api_base, "https://alt.example.com/v1");
});
