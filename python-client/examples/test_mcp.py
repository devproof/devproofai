"""MCP: registry listing, environment/agent MCP config, validation, round trip."""
from __future__ import annotations

import os

from _common import check, client, step
from devproof import APIStatusError

MODEL = os.environ.get("DEVPROOF_TEST_MODEL", "qwen-medium")
MCP_URL = "https://mcp.context7.com/mcp"


def main() -> None:
    c = client()
    env_id = agent_id = None
    try:
        step("list the bundled MCP registry")
        servers = c.mcp_registry.list()
        check(len(servers) == 5, f"registry has 5 bundled servers ({len(servers)})")
        names = {s["name"] for s in servers}
        check("context7" in names, f"context7 present ({names})")

        step("create environment with allow_mcp_servers=True")
        env = c.environments.create(name="api-example-mcp-env", allow_mcp_servers=True)
        env_id = env["id"]
        check(env.get("allowMcpServers") is True, "environment allows MCP servers")

        step("create agent with an MCP server")
        agent = c.agents.create(name="api-example-mcp-agent", routing=MODEL, environment_id=env_id,
                                system_prompt="You are a careful assistant.", tools=[], max_turns=6,
                                mcp_servers={"context7": {"type": "http", "url": MCP_URL}})
        agent_id = agent["id"]

        step("retrieve agent: mcp_servers round-tripped on the version")
        got = c.agents.retrieve(agent_id)
        version = got["versions"][0]
        check(version["mcp_servers"] == {"context7": {"type": "http", "url": MCP_URL}},
              f"mcp_servers round-tripped ({version['mcp_servers']})")

        step("bad MCP entry (missing type) rejected with 400 via update")
        try:
            c.agents.update(agent_id, name="api-example-mcp-agent", routing=MODEL,
                            environmentId=env_id, systemPrompt="You are a careful assistant.",
                            tools=[], maxTurns=6,
                            mcpServers={"bad": {"url": MCP_URL}})
            check(False, "an MCP entry missing type must 400")
        except APIStatusError as e:
            check(e.status_code == 400, f"missing-type MCP entry 400s (got {e.status_code})")

        print("PASS test_mcp")
    finally:
        step("teardown")
        if agent_id:
            try: c.agents.delete(agent_id)
            except Exception: pass
        if env_id:
            try: c.environments.delete(env_id)
            except Exception: pass


if __name__ == "__main__":
    main()
