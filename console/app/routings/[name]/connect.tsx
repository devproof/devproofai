"use client";
// Connect tab (spec 2026-07-12): copy-paste client configs for Claude Code,
// Codex, and Hermes, prefilled with this deployment's name + gateway URL.
// Key values are shown once at creation and never retrievable, so snippets
// carry a dpk_… placeholder pointing at the API Keys page.
import Link from "next/link";
import { Snippet } from "../../lib/snippet";

export function ConnectTab({ name, gatewayUrl, kind, contextTokens }:
  { name: string; gatewayUrl: string; kind: string; contextTokens?: number | null }) {
  // null/undefined = llama.cpp engine default (4k); external models never warn.
  const smallContext = kind === "local" && (contextTokens ?? 4096) < 32768;
  return (
    <>
      <p className="sub" style={{ marginTop: 0 }}>
        Connect a client to this routing through the gateway. Snippets are prefilled with the
        routing name and gateway URL — replace <code>dpk_…</code> with a key from the{" "}
        <Link href="/api-keys">API Keys</Link> page (key values are shown once at creation).
      </p>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Gateway endpoint</h3>
        <code style={{ fontSize: 11.5, wordBreak: "break-all", display: "block" }}>
          {`curl ${gatewayUrl}/v1/chat/completions -H "Authorization: Bearer dpk_…" -d '{"model": "${name}", "messages": […]}'`}
        </code>
        <div className="hint" style={{ marginTop: 6 }}>
          every routing is called the same way through the gateway; create keys on the API Keys page
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Claude Code</h3>
        <Snippet text={`export ANTHROPIC_BASE_URL=${gatewayUrl}\nexport ANTHROPIC_AUTH_TOKEN=dpk_…\nclaude --model ${name}`} />
        <div className="hint" style={{ marginTop: 6 }}>
          use ANTHROPIC_AUTH_TOKEN, not ANTHROPIC_API_KEY — API_KEY needs a one-time interactive
          approval and shows Not logged in until approved
        </div>
        {smallContext && (
          <div className="hint" style={{ marginTop: 6 }}>
            ⚠ this model has a context of {contextTokens ?? 4096} tokens — likely too small for
            the Claude Code prompt; test with --strict-mcp-config --mcp-config empty.json or
            deploy a bigger-context model
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Codex</h3>
        <Snippet label="~/.codex/config.toml" text={`model = "${name}"\nmodel_provider = "devproof"\n\n[model_providers.devproof]\nname = "Devproof"\nbase_url = "${gatewayUrl}/v1"\nenv_key = "DEVPROOF_API_KEY"\nwire_api = "responses"`} />
        <Snippet label="shell" text={`export DEVPROOF_API_KEY=dpk_…`} />
        <div className="hint" style={{ marginTop: 6 }}>
          Codex speaks the OpenAI Responses API (wire_api responses is the only supported value);
          the gateway serves /v1/responses for every deployment
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Hermes</h3>
        <Snippet label="~/.hermes/config.yaml" text={`model:\n  provider: custom\n  model: "${name}"\n  base_url: "${gatewayUrl}/v1"`} />
        <Snippet label="~/.hermes/.env" text={`OPENAI_API_KEY=dpk_…`} />
        <div className="hint" style={{ marginTop: 6 }}>
          Nous Research Hermes Agent — with base_url set it calls the gateway directly and auths
          with OPENAI_API_KEY; setup verifies the endpoint against /v1/models, which the gateway
          serves
        </div>
      </div>
    </>
  );
}
