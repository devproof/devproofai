"""Agent lifecycle & composition: versions, rename, status, subagents,
wiki refs (writer exclusivity), in-use guards.

Needs an existing routing (DEVPROOF_TEST_MODEL) — agents reference routings,
not deployments — but never launches a session, so no live model is required.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from _common import check, client, step
from devproof import ConflictError

ROUTING = os.environ.get("DEVPROOF_TEST_MODEL", "qwen3-5-4b-q4")


def main() -> None:
    c = client()
    env_id = wiki_id = skill_id = vault_id = None
    agent_ids: list[str] = []
    try:
        step("create environment + writer agent")
        env = c.environments.create(name="api-example-agents-env")
        env_id = env["id"]
        writer = c.agents.create(name="api-example-writer", routing=ROUTING, environment_id=env_id,
                                 system_prompt="You maintain the wiki.", tools=["Read", "Write"], max_turns=4)
        agent_ids.append(writer["id"])
        check(writer["version"] == 1, "agent created at version 1")

        step("new version via update; retrieve lists both versions")
        upd = c.agents.update(writer["id"], routing=ROUTING, environmentId=env_id,
                              systemPrompt="You maintain the wiki carefully.",
                              tools=["Read", "Write", "Bash"], maxTurns=6)
        check(upd["version"] == 2, "update created version 2")
        got = c.agents.retrieve(writer["id"])
        check(len(got["versions"]) == 2, f"retrieve lists 2 versions ({len(got['versions'])})")

        step("rename (row metadata, not a new version)")
        c.agents.rename(writer["id"], "api-example-wiki-writer")
        got = c.agents.retrieve(writer["id"])
        check(got["name"] == "api-example-wiki-writer", "agent renamed")
        check(len(got["versions"]) == 2, "rename did not add a version")

        step("equip the agent: skill + vault + turn deadline")
        # Skills and vaults attach to the agent's versioned config; files and
        # memory stores attach to sessions instead (see test_sessions.py).
        skill_md = Path(tempfile.mkdtemp(prefix="dp-agents-")) / "release-notes.md"
        skill_md.write_text("# Release notes skill\nWrite crisp release notes.\n")
        skill_id = c.skills.upload(skill_md)["id"]
        vault_id = c.vaults.create(name="api-example-agents-vault", secrets={"API_TOKEN": "s3cret"})["id"]
        c.agents.update(writer["id"], routing=ROUTING, environmentId=env_id,
                        skillIds=[skill_id], vaultId=vault_id, turnDeadlineSeconds=1800)
        latest = c.agents.retrieve(writer["id"])["versions"][0]
        check(latest["skill_ids"] == [skill_id], "skill attached to the latest version")
        check(latest["vault_id"] == vault_id, "vault attached")
        check(latest["turn_deadline_sec"] == 1800, "turn deadline set")

        step("in-use guard: attached skill refuses deletion")
        try:
            c.skills.delete(skill_id)
            check(False, "attached skill must refuse deletion")
        except ConflictError:
            check(True, "attached skill 409s deletion")

        step("disable -> new sessions 409, re-enable")
        c.agents.set_status(writer["id"], "disabled")
        try:
            c.sessions.create(agent=writer["id"], prompt="hello")
            check(False, "session on a disabled agent must 409")
        except ConflictError:
            check(True, "disabled agent 409s new sessions")
        c.agents.set_status(writer["id"], "active")

        step("attach a wiki as writer; a second writer agent must 409")
        wiki = c.wikis.create(name="api-example-agents-wiki")
        wiki_id = wiki["id"]
        # Each update is a FULL config (a new version): repeat skillIds/vaultId
        # or the new version silently drops them.
        c.agents.update(writer["id"], routing=ROUTING, environmentId=env_id,
                        skillIds=[skill_id], vaultId=vault_id,
                        wikiRefs=[{"wikiId": wiki_id, "mode": "write"}])
        try:
            c.agents.create(name="api-example-second-writer", routing=ROUTING, environment_id=env_id,
                            wiki_refs=[{"wikiId": wiki_id, "mode": "write"}])
            check(False, "a second writer for the same wiki must 409")
        except ConflictError:
            check(True, "writer exclusivity enforced (409)")

        step("a reader agent with the writer as subagent (correction flow)")
        reader = c.agents.create(
            name="api-example-reader", routing=ROUTING, environment_id=env_id,
            wiki_refs=[{"wikiId": wiki_id, "mode": "read"}],
            subagents=[{"agentId": writer["id"], "instructions": "Delegate wiki corrections here."}])
        agent_ids.append(reader["id"])

        step("in-use guards: attached wiki and referenced environment refuse deletion")
        try:
            c.wikis.delete(wiki_id)
            check(False, "attached wiki must refuse deletion")
        except ConflictError:
            check(True, "attached wiki 409s deletion")
        try:
            c.environments.delete(env_id)
            check(False, "in-use environment must refuse deletion")
        except ConflictError:
            check(True, "in-use environment 409s deletion")

        step("teardown order: agents first, then their attachments delete cleanly")
        for a in list(agent_ids):
            c.agents.delete(a)
            agent_ids.remove(a)
        c.wikis.delete(wiki_id)
        wiki_id = None
        c.skills.delete(skill_id)
        skill_id = None
        c.vaults.delete(vault_id)
        vault_id = None
        c.environments.delete(env_id)
        env_id = None
        print("PASS test_agents")
    finally:
        for a in agent_ids:
            try: c.agents.delete(a)
            except Exception: pass
        for kind, ref in (("wikis", wiki_id), ("skills", skill_id), ("vaults", vault_id), ("environments", env_id)):
            if ref:
                try: getattr(c, kind).delete(ref)
                except Exception: pass


if __name__ == "__main__":
    main()
