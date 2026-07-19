# Examples

Executable documentation for the Devproof public API — one script per feature
area. Each script asserts real outcomes against a running platform and cleans
up after itself, so the set doubles as an end-to-end suite.

## Setup

1. Create an API key on the console's **API Keys** page (copy the `dpk_...`
   secret — it is shown once).
2. Environment:

   ```
   export DEVPROOF_API_KEY=dpk_...
   export DEVPROOF_BASE_URL=http://localhost:14000   # the gateway (default)
   ```

3. No install needed — the scripts import the client straight from the repo
   (`pip install httpx` is the only dependency).

Run any script standalone, in any order:

```
python examples/test_files.py
```

## Index

| Script | Feature area | Covers | Needs a live model? |
|---|---|---|---|
| [`demo_agent.py`](demo_agent.py) | Quick start | Environment + agent + session in ~30 lines, streamed trace | yes |
| [`test_files.py`](test_files.py) | Files | Small upload round trip; big file through the chunked path with progress (`DEVPROOF_TEST_BIG_MB`, default 100); streamed download; list; delete → 404 | no |
| [`test_skills.py`](test_skills.py) | Skills | Skill zip upload (SKILL.md + scripts), manifest retrieval, path-flattening convention, delete | no |
| [`test_memory.py`](test_memory.py) | Memory stores | Create store, add entries, tree + content round trip, entry delete, store delete | no |
| [`test_wikis.py`](test_wikis.py) | LLM wikis | Create wiki, add pages (index.md/log.md convention), tree + content, page upsert, metadata update, delete | no |
| [`test_vault.py`](test_vault.py) | Vaults & credentials | Write-only secrets (never echoed), typed MCP credentials (bearer), rotation, name/server + derived-key conflicts | no |
| [`test_environments.py`](test_environments.py) | Environments | Egress allowlist (`*.domain` wildcards), package-manager toggle, pod **requests/limits** + /work disk config, pod validation 400, update, delete | no |
| [`test_agents.py`](test_agents.py) | Agents | Versioning (update = new full config), rename, disable → 409, attaching **skills/vault/turn deadline**, subagents (delegation), wiki read/write refs + writer exclusivity 409, in-use guards (skill/wiki/environment) | no¹ |
| [`test_sessions.py`](test_sessions.py) | Sessions | Create with **file attachments + memory store**, event streaming, follow-up turn, resources, list filters (agent/file), interrupt, delete | yes |
| [`test_tools.py`](test_tools.py) | Tool use | Full managed session where the agent must use Write/Read/Bash tools; transcript assertions | yes |
| [`test_mcp.py`](test_mcp.py) | MCP | Bundled registry listing, environment `allow_mcp_servers`, agent MCP server config round trip, validation 400s | no¹ |

¹ needs an existing **routing** name (`DEVPROOF_TEST_MODEL`) because agents
reference routings, but never runs a turn — the model behind it may be asleep.

Scripts marked "yes" run real turns: set `DEVPROOF_TEST_MODEL` to a routing
backed by a tool-capable deployed model (tiny models like qwen0.5b cannot
follow tool-use instructions reliably).

## Where things attach

- **Agents** carry the versioned config: routing, system prompt, tools,
  skills, vault, MCP servers, subagents, wiki refs, turn deadline.
- **Sessions** carry the per-run inputs: file attachments and the memory
  store.
- **Environments** carry the pod: egress allowlist, package managers,
  requests/limits, /work disk.

Model inference itself uses the official `anthropic` package against the same
gateway: `ANTHROPIC_BASE_URL=http://localhost:14000 ANTHROPIC_AUTH_TOKEN=dpk_...`
with a routing name as the model.
