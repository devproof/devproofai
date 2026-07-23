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
        self.assertIsNone(resp.wait_reason)

    def test_wake_wait_ms_threshold(self):
        from devproof_runner.client import wake_wait_ms, WAKE_MIN_MS
        self.assertEqual(wake_wait_ms(WAKE_MIN_MS, False), WAKE_MIN_MS)          # at threshold -> a wake
        self.assertEqual(wake_wait_ms(WAKE_MIN_MS + 30000, False), WAKE_MIN_MS + 30000)
        self.assertEqual(wake_wait_ms(WAKE_MIN_MS - 1, False), 0)               # warm prefill, not a wake
        self.assertEqual(wake_wait_ms(WAKE_MIN_MS + 30000, True), 0)            # a retry already recorded the wait

    def test_held_first_call_reported_as_wake(self):
        # A scale-to-zero wake-hold (spec 2026-07-15) returns 200 after a long
        # pause with NO 503/retry when the wake fits inside the 300s hold, so
        # the wait leaves no retry trace and would silently fold into the first
        # model step. The client infers it from a long time-to-first-frame
        # (measured in _stream_once) and reports it as a "wake" wait so the
        # console renders a scale-up badge. (Mock _stream_once rather than the
        # clock: httpx shares time.monotonic, so a global clock mock is unsound.)
        c = MessagesClient(base_url="http://gw.test", auth_token="t")
        async def held_stream(_body):
            r = client_mod.ApiResponse()
            r.ttfb_ms = 45000  # 45s to first frame = held for a wake
            return r
        c._stream_once = held_stream
        resp = call(c)
        self.assertEqual(resp.wait_reason, "wake")
        self.assertGreaterEqual(resp.waited_ms, 45000)
        self.assertGreater(resp.wait_ended, 0.0)

    def test_short_ttfb_is_not_a_wake(self):
        # Normal warm-model prefill (short time-to-first-frame) is NOT a wait.
        c = MessagesClient(base_url="http://gw.test", auth_token="t")
        async def quick_stream(_body):
            r = client_mod.ApiResponse()
            r.ttfb_ms = 3000  # 3s prefill, below the wake threshold
            return r
        c._stream_once = quick_stream
        resp = call(c)
        self.assertEqual(resp.waited_ms, 0)
        self.assertIsNone(resp.wait_reason)

    def _reason_for(self, first_response):
        calls = []
        def handler(req):
            calls.append(1)
            return first_response if len(calls) == 1 else ok(req)
        return call(make_client(handler)).wait_reason

    def test_wait_reason_classified_from_last_error(self):
        # The gateway's 503 bodies are stable markers (custom_callbacks.py):
        # rolling-reload guard vs scale-to-zero wake hold. Connect-level
        # failures mean the gateway itself was unreachable. Anything else
        # stays unclassified (None) — the console then shows a neutral label.
        self.assertEqual(self._reason_for(httpx.Response(
            503, json={"error": {"message": "503: model m is reloading on this gateway replica - retry shortly"}})),
            "reload")
        self.assertEqual(self._reason_for(httpx.Response(
            503, headers={"Retry-After": "0"},
            json={"error": {"message": "model m is waking from scale-to-zero - retry shortly"}})),
            "wake")
        self.assertIsNone(self._reason_for(httpx.Response(
            503, json={"error": {"message": "upstream unavailable"}})))

    def test_wait_reason_gateway_on_connect_error(self):
        calls = []
        def handler(req):
            calls.append(1)
            if len(calls) == 1:
                raise httpx.ConnectError("refused")
            return ok(req)
        self.assertEqual(call(make_client(handler)).wait_reason, "gateway")


if __name__ == "__main__":
    unittest.main()
