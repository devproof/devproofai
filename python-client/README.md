# devproofai-client

Python client for the [Devproof AI](https://devproof.ai) platform — managed
agents on self-hosted models. Own your scalable AI.

The package mirrors the Anthropic SDK's design (resource namespaces, env-var
fallbacks, typed errors) over Devproof-native wire shapes, talking to the
public `/api/*` surface through the gateway.

Model inference is deliberately **not** part of this client: point the
official `anthropic` package at the same gateway
(`ANTHROPIC_BASE_URL=<gateway>` + `ANTHROPIC_AUTH_TOKEN=dpk_...`) and use a
routing name as the model.

## Install

```
pip install .
```

Requires Python ≥ 3.10; the only dependency is `httpx`.

## Quick start

```python
from devproof import Devproof

client = Devproof()  # DEVPROOF_BASE_URL (default http://localhost:14000), DEVPROOF_API_KEY

env = client.environments.create(name="my-env")
agent = client.agents.create(name="my-agent", routing="my-routing", environment_id=env["id"])
session = client.sessions.create(agent=agent["id"], prompt="Hello!")
for event in client.sessions.events.stream(session["id"]):
    print(event)
```

Create the `dpk_...` API key on the console's **API Keys** page (shown once).

## Resources

| Namespace | Covers |
|---|---|
| `client.files` | Uploads (plain + chunked for large files), downloads, listing, deletion |
| `client.skills` | Skill packages (SKILL.md or Claude-Code-style zip) |
| `client.memory_stores` | Persistent agent memory (entries, tree, content) |
| `client.wikis` | LLM wikis — hierarchical knowledge bases agents mount read/write |
| `client.vaults` | Secret bundles + typed credentials (env vars, bearer tokens, MCP OAuth) |
| `client.environments` | Session-pod environments: egress allowlists, pod resources, /work disk |
| `client.agents` | Agent definitions: versions, status, subagents, wiki refs, MCP servers |
| `client.sessions` | Managed sessions: create, follow-up messages, event streaming, interrupt |
| `client.mcp_registry` | Bundled MCP server registry |

## Examples

`examples/` contains an executable script per feature area — each asserts
real outcomes against a running platform and cleans up after itself, so the
set doubles as an end-to-end suite. See [examples/README.md](examples/README.md)
for the index.

## Errors

All errors derive from `devproof.DevproofError`; HTTP failures raise typed
subclasses of `APIStatusError` (`AuthenticationError`, `NotFoundError`,
`ConflictError`, …) with `.status_code` and `.body`. Transient failures
(429/5xx/network) are retried with exponential backoff before raising.

## License

[Apache License 2.0](LICENSE) — unlike the platform itself (Elastic License
2.0), the client is open source and can be embedded freely in your own
products.
