"use client";
// Connect tab (spec 2026-07-12): copy-paste client configs for Claude Code,
// Codex, and Hermes, prefilled with this deployment's name + gateway URL.
// Key values are shown once at creation and never retrievable, so snippets
// carry a dpk_… placeholder pointing at the API Keys page.
import { useState } from "react";
import Link from "next/link";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="iconbtn" title={copied ? "Copied!" : "Copy"} aria-label="Copy snippet"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); } catch { return; }
        setCopied(true); setTimeout(() => setCopied(false), 1500);
      }}>
      {copied
        ? <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 8.5 6 12.5 14 3.5" /></svg>
        : <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5" y="5" width="9" height="9" rx="1.5" /><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" /></svg>}
    </button>
  );
}

function Snippet({ label, text }: { label?: string; text: string }) {
  return (
    <>
      {label && <div className="hint" style={{ marginTop: 8 }}>{label}</div>}
      <div style={{ position: "relative", marginTop: 6 }}>
        <pre className="block" style={{ margin: 0 }}>{text}</pre>
        <div style={{ position: "absolute", top: 6, right: 6 }}><CopyButton text={text} /></div>
      </div>
    </>
  );
}

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
