"""Session lifecycle end-to-end: create with attachments + memory, stream
events, follow-up message, resources, list filters, interrupt, delete.

Requires a deployed model behind the DEVPROOF_TEST_MODEL routing (sessions
actually run turns here).
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from _common import check, client, step

ROUTING = os.environ.get("DEVPROOF_TEST_MODEL", "qwen3-5-4b-q4")


def run_turn(c, session_id: str, *, after: int = 0) -> tuple[str, int]:
    """Stream until the turn settles; return (status, last_seq)."""
    status, last_seq = "", after
    for event in c.sessions.events.stream(session_id, after=after):
        if event.get("type") == "status":
            status = event["payload"]["status"]
            print(f"    status: {status}")
            # The server keeps the stream open on `idle` (so resumes from
            # other clients appear); a one-shot turn ends at idle.
            if status in ("idle", "completed", "failed"):
                break
        else:
            last_seq = max(last_seq, event.get("seq", last_seq))
    return status, last_seq


def main() -> None:
    c = client()
    tmp = Path(tempfile.mkdtemp(prefix="dp-sessions-"))
    env_id = agent_id = store_id = file_id = session_id = None
    try:
        step("inputs: upload a file + seed a memory store")
        notes = tmp / "notes.txt"
        notes.write_bytes(b"The launch codeword is BLUEPRINT.\n")
        file_id = c.files.upload(notes)["id"]
        store = c.memory_stores.create(name="api-example-sessions-memory")
        store_id = store["id"]
        c.memory_stores.entries.add(store_id, "facts/style.md", b"Answer in one short sentence.\n")

        step("create environment + agent")
        env = c.environments.create(name="api-example-sessions-env")
        env_id = env["id"]
        agent = c.agents.create(name="api-example-sessions-agent", routing=ROUTING,
                                environment_id=env_id, tools=["Read", "Bash"], max_turns=6,
                                system_prompt="You are a careful assistant.")
        agent_id = agent["id"]

        step("turn 0: session with attachment + memory store, streamed")
        session = c.sessions.create(
            agent=agent_id, name="sessions-example",
            prompt="Read the attached notes.txt and tell me the launch codeword.",
            files=[file_id], memory_store=store_id)
        session_id = session["id"]
        status, last_seq = run_turn(c, session_id)
        check(status in ("idle", "completed"), f"turn 0 settled cleanly ({status})")
        transcript = str(c.sessions.events.list(session_id))
        check("BLUEPRINT" in transcript, "agent read the attached file")

        step("resources: attachments, memory store, environment visible")
        res = c.sessions.resources(session_id)
        check(any(f["id"] == file_id for f in res["inputFiles"]), "attachment listed in resources")
        check(res["memory"] and res["memory"]["id"] == store_id, "memory store listed")
        check(res["environment"] and res["environment"]["id"] == env_id, "environment listed")

        step("follow-up turn on the idle session")
        c.sessions.send_message(session_id, prompt="Now say the codeword backwards.")
        status, _ = run_turn(c, session_id, after=last_seq)
        check(status in ("idle", "completed"), f"follow-up settled cleanly ({status})")

        step("list filters: by agent and by attached file")
        check(any(s["id"] == session_id for s in c.sessions.list(agent=agent_id)), "listed by agent")
        check(any(s["id"] == session_id for s in c.sessions.list(file=file_id)), "listed by attached file")

        step("interrupt a running turn")
        c.sessions.send_message(session_id, prompt="Count slowly from 1 to 500, one number per line.")
        c.sessions.interrupt(session_id)
        got = c.sessions.retrieve(session_id)
        check(got["status"] == "idle", f"interrupt left the session idle ({got['status']})")
        events = c.sessions.events.list(session_id)
        check(any(e["type"] == "session.interrupted" for e in events), "interrupt recorded in the transcript")

        step("delete session")
        c.sessions.delete(session_id)
        session_id = None
        print("PASS test_sessions")
    finally:
        step("teardown")
        if session_id:
            try: c.sessions.delete(session_id)
            except Exception: pass
        if agent_id:
            try: c.agents.delete(agent_id)
            except Exception: pass
        if env_id:
            try: c.environments.delete(env_id)
            except Exception: pass
        if store_id:
            try: c.memory_stores.delete(store_id)
            except Exception: pass
        if file_id:
            try: c.files.delete(file_id)
            except Exception: pass


if __name__ == "__main__":
    main()
