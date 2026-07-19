// Generates the LiteLLM proxy config from Ready ModelDeployments (concept §5.7)
// plus registered external provider endpoints (spec 2026-07-09).
import { stringify } from "yaml";

export interface DeploymentLike {
  metadata: { name: string; namespace: string };
  status?: { phase?: string; endpoint?: string };
}

export interface ExternalLike {
  id: string;
  name: string;
  provider: string; // openai | anthropic | openrouter | ollama | custom
  base_url: string | null;
  model_id: string;
  key_version: number;
  has_key: boolean;
  reasoning_effort?: string | null;
}

/** Secret entry / env var name for an external deployment's API key. */
export function envKeyFor(id: string): string {
  return "DEVPROOF_EP_" + id.replace(/[^A-Za-z0-9_]/g, "_");
}

// custom endpoints are OpenAI-compatible servers, hence the openai/ prefix.
// ollama = Ollama Cloud's OpenAI-compat surface (https://ollama.com/v1).
const PROVIDER_PREFIX: Record<string, string> = {
  openai: "openai", anthropic: "anthropic", openrouter: "openrouter", custom: "openai", ollama: "openai",
};

// Providers that ride the openai/ prefix but must NOT fall back to
// api.openai.com when the row has no base_url (NULL = provider default).
const PROVIDER_DEFAULT_BASE: Record<string, string> = { ollama: "https://ollama.com/v1" };

export function buildGatewayConfig(
  deployments: DeploymentLike[], externals: ExternalLike[] = [],
  opts: { publicApiTarget?: string; routingNames?: string[] } = {},
): string {
  const model_list: any[] = deployments
    // Ready AND Idle are routed: sleeping deployments (scale-to-zero, spec
    // 2026-07-15) keep their route so sleep/wake never changes this config —
    // no rolling reload, so requests held by the pre-call hook survive.
    .filter((d) => (d.status?.phase === "Ready" || d.status?.phase === "Idle") && d.status?.endpoint)
    .map((d) => ({
      model_name: d.metadata.name,
      litellm_params: {
        model: `openai/${d.metadata.name}`,
        // endpoint is .../v1/chat/completions; LiteLLM wants the /v1 base
        api_base: d.status!.endpoint!.replace(/\/chat\/completions$/, ""),
        api_key: "none",
      },
      // devproof_sanitize drives the GBNF sanitizer scope in custom_callbacks.py.
      // Local models are always llama.cpp/GGUF → always sanitize.
      model_info: { devproof_sanitize: true },
    }));
  for (const e of externals) {
    model_list.push({
      model_name: e.name,
      litellm_params: {
        model: `${PROVIDER_PREFIX[e.provider] ?? "openai"}/${e.model_id}`,
        ...((e.base_url || PROVIDER_DEFAULT_BASE[e.provider])
          ? { api_base: e.base_url || PROVIDER_DEFAULT_BASE[e.provider] } : {}),
        // Real key → env ref only (never in this config; gateway-provider-keys Secret).
        // Keyless (e.g. a local llama.cpp custom endpoint) → dummy "none", which
        // LiteLLM's provider requires and the backend ignores.
        api_key: e.has_key ? `os.environ/${envKeyFor(e.id)}` : "none",
      },
      // Sanitize custom endpoints (OpenAI-compatible local servers — typically
      // llama.cpp, which needs GBNF-safe schemas; harmless for others). Named
      // APIs (openai/anthropic/openrouter/ollama) get full-fidelity schemas.
      // key_version changes the config bytes on rotation → diff-aware sync rolls
      // the gateway → new Secret env is picked up.
      model_info: {
        devproof_sanitize: e.provider === "custom", key_version: e.key_version,
        // Read by the custom_callbacks.py pre-call hook: default reasoning
        // effort applied only when the request carries no reasoning param.
        ...(e.reasoning_effort ? { devproof_reasoning_effort: e.reasoning_effort } : {}),
      },
    });
  }
  // Routings (spec 2026-07-16): listed so /v1/models shows them (Hermes
  // validates against it; claude --model discovery). NEVER routed — the
  // pre-call hook rewrites data["model"] before LiteLLM validates, so the
  // blackhole api_base is unreachable except on a hook bug (loud failure
  // beats silent misrouting). Rule edits do NOT resync this config; only
  // routing create/delete does. A routing MAY shadow a deployment/external of
  // the same name (spec 2026-07-16): skip the blackhole then — two same-named
  // entries form a LiteLLM load-balance group and real requests to the
  // resolved target would round-robin onto the blackhole.
  const emitted = new Set(model_list.map((m) => m.model_name));
  for (const name of opts.routingNames ?? []) {
    if (emitted.has(name)) continue;
    model_list.push({
      model_name: name,
      litellm_params: { model: `openai/${name}`, api_base: "http://devproof-routing-unresolved.invalid", api_key: "none" },
      model_info: { devproof_routing: true },
    });
  }
  return stringify({
    model_list,
    litellm_settings: {
      drop_params: true,
      // Route /v1/messages for openai-provider models through the
      // chat/completions bridge, NOT the default Responses-API bridge: the
      // Responses adapter only translates OpenAI's reasoning *summary*
      // (summary_text) and drops llama.cpp's raw reasoning
      // (response.reasoning_text.delta / content[].reasoning_text) — thinking
      // blocks arrive empty. The chat/completions adapter maps
      // reasoning_content → thinking_delta (verified 2026-07-13).
      use_chat_completions_url_for_anthropic_messages: true,
      // custom_callbacks.py (mounted beside config.yaml) strips oversized
      // string-length bounds from tool schemas — they break llama.cpp's
      // JSON-schema→grammar conversion ("failed to parse grammar").
      callbacks: "custom_callbacks.proxy_handler_instance",
    },
    general_settings: {
      // API-key enforcement against the api_keys table (custom_callbacks.py).
      custom_auth: "custom_callbacks.user_custom_auth",
      // Public /api pass-through → control plane (spec 2026-07-12). The CP
      // re-validates the dpk_ key; custom_auth above also fires (verified).
      ...(opts.publicApiTarget ? {
        pass_through_endpoints: [{
          path: "/api",
          target: opts.publicApiTarget,
          include_subpath: true,
          forward_headers: true,
          auth: false,
          methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        }],
      } : {}),
    },
  });
}

/** Tracks the ready-routed set across gateway syncs; returns the names that
 *  just became routed (Ready + endpoint) so the caller can warm them. A name
 *  that leaves the ready set is forgotten, so a re-deploy re-warms.
 *  Ready-phase only BY DESIGN — Idle models are routed-but-not-warm, and a
 *  CP restart must not wake them. */
export function newlyRouted(routed: Set<string>, deployments: DeploymentLike[]): string[] {
  const ready = new Set(
    deployments.filter((d) => d.status?.phase === "Ready" && d.status?.endpoint).map((d) => d.metadata.name),
  );
  const fresh = [...ready].filter((n) => !routed.has(n));
  for (const n of routed) if (!ready.has(n)) routed.delete(n);
  for (const n of fresh) routed.add(n);
  return fresh;
}
