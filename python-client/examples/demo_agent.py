"""Demo: create an agent on a self-hosted model, run a session, stream its trace.
Prereqs: a running platform and an existing routing (DEVPROOF_TEST_MODEL —
agents reference routings, not deployments).
Set DEVPROOF_API_KEY (create a key on the API Keys page) before running.
Run: python examples/demo_agent.py (from the python-client folder)
"""
import os
import time

from _common import Devproof  # noqa: F401 — path shim, then the real import

client = Devproof()  # DEVPROOF_BASE_URL (default http://localhost:14000), DEVPROOF_API_KEY

environment = client.environments.create(name=f"demo-env-{int(time.time())}")
print(f"environment: {environment['id']}")

agent = client.agents.create(
    name=f"demo-agent-{int(time.time())}",
    routing=os.environ.get("DEVPROOF_TEST_MODEL", "qwen3-5-4b-q4"),
    environment_id=environment["id"],
    system_prompt="You are a concise assistant.",
    tools=["Bash"],
    max_turns=3,
)
print(f"agent: {agent['id']} v{agent['version']}")

session = client.sessions.create(agent=agent["id"], prompt="Name three Kubernetes objects, comma-separated.", name="demo")
print(f"session: {session['id']} — streaming trace:")

for event in client.sessions.events.stream(session["id"]):
    if event.get("type") == "status":
        status = event["payload"]["status"]
        print(f"       status           {status}")
        # The server keeps the stream open on `idle` (so resumes from other
        # clients appear) and only closes it on completed/failed — a
        # one-shot turn ends at idle, so break here ourselves.
        if status in ("idle", "completed", "failed"):
            break
        continue
    payload = event.get("payload") or {}
    summary = payload.get("text") or payload.get("tool") or payload.get("subtype") or ""
    print(f"  [{event['seq']:>2}] {event['type']:<16} {str(summary)[:100]}")

final = client.sessions.retrieve(session["id"])
print(f"done: {final['status']} — tokens {final['tokens_in']}/{final['tokens_out']}")
