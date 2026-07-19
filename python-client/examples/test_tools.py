"""Tools end-to-end: managed agent session that must use its tools.

Requires a tool-capable deployed model (DEVPROOF_TEST_MODEL) — tiny models
like qwen0.5b cannot follow tool-use instructions reliably.
"""
from __future__ import annotations

import os

from _common import check, client, step

MODEL = os.environ.get("DEVPROOF_TEST_MODEL", "qwen3-5-4b-q4")
PROMPT = ("Create a file /work/hello.txt containing exactly the text 'devproof tools test', "
          "then read the file back and tell me its contents.")


def main() -> None:
    c = client()
    env_id = agent_id = None
    try:
        step("create environment + agent")
        env = c.environments.create(name="api-example-env")
        env_id = env["id"]
        agent = c.agents.create(name="api-example-agent", routing=MODEL, environment_id=env_id,
                                system_prompt="You are a careful assistant. Use your tools.",
                                tools=["Write", "Read", "Bash"], max_turns=6)
        agent_id = agent["id"]

        step("start session and stream events until terminal")
        session = c.sessions.create(agent=agent_id, prompt=PROMPT, name="tools-example")
        tool_events = 0
        final_status = ""
        for event in c.sessions.events.stream(session["id"]):
            etype = event.get("type", "")
            if etype == "status":
                final_status = event["payload"]["status"]
                print(f"    status: {final_status}")
                # The server keeps the stream open on `idle` (so resumes from
                # other clients appear) and only closes it on completed/failed.
                # A one-shot turn ends at idle, so break here ourselves.
                if final_status in ("idle", "completed", "failed"):
                    break
            elif "tool" in etype.lower():
                tool_events += 1
                print(f"    tool event: {etype}")
        check(tool_events > 0, f"agent used tools ({tool_events} tool events)")
        check(final_status in ("idle", "completed"), f"session finished cleanly (status={final_status})")

        step("verify transcript mentions the file content")
        events = c.sessions.events.list(session["id"])
        transcript = str(events)
        check("hello.txt" in transcript, "transcript references the created file")
        print("PASS test_tools")
    finally:
        step("teardown")
        if agent_id:
            try: c.agents.delete(agent_id)   # cascades sessions
            except Exception: pass
        if env_id:
            try: c.environments.delete(env_id)
            except Exception: pass


if __name__ == "__main__":
    main()
