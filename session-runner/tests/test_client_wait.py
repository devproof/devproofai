"""Wait accounting (trace follow-up 2026-07-23): a create() that survived
patient retries reports how long it waited (waited_ms) and WHEN the final,
successful attempt began (wait_ended, monotonic) so the runner can stamp a
dedicated model.wait trace row at the moment the model came back up."""
import unittest
from unittest import mock

import anyio
import httpx

from devproof_runner import client as client_mod
from devproof_runner.client import MessagesClient

SSE_OK = (
    'data: {"type":"message_start","message":{"model":"m","usage":{}}}\n\n'
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hi"}}\n\n'
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
    'data: {"type":"message_stop"}\n\n'
)


def make_client(handler) -> MessagesClient:
    c = MessagesClient(base_url="http://gw.test", auth_token="t")
    c._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://gw.test")
    return c


def call(c: MessagesClient):
    async def run():
        return await c.create(model="m", system="", messages=[], tools=None, max_tokens=8)
    return anyio.run(run)


def ok(_req):
    return httpx.Response(200, headers={"content-type": "text/event-stream"},
                          content=SSE_OK.encode())


class WaitAccountingTests(unittest.TestCase):
    def setUp(self):
        async def no_sleep(_s): return None
        p = mock.patch.object(client_mod.anyio, "sleep", no_sleep)
        p.start(); self.addCleanup(p.stop)
        # Deterministic clock: every monotonic() call advances 10s, so any
        # failed-attempt stretch is visible in waited_ms even with no-op sleeps.
        t = {"now": 0.0}
        def tick():
            t["now"] += 10.0
            return t["now"]
        p2 = mock.patch.object(client_mod.time, "monotonic", tick)
        p2.start(); self.addCleanup(p2.stop)

    def test_patient_retries_reported_as_wait(self):
        calls = []
        def handler(req):
            calls.append(1)
            if len(calls) <= 2:
                return httpx.Response(503, headers={"Retry-After": "0"},
                                      json={"error": {"message": "reloading"}})
            return ok(req)
        resp = call(make_client(handler))
        self.assertEqual(len(calls), 3)
        self.assertGreater(resp.waited_ms, 0)
        self.assertGreater(resp.wait_ended, 0.0)
        self.assertEqual(resp.content[0].text, "hi")

    def test_clean_success_reports_zero_wait(self):
        resp = call(make_client(ok))
        self.assertEqual(resp.waited_ms, 0)


if __name__ == "__main__":
    unittest.main()
