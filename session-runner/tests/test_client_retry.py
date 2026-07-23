"""Retry policy (spec 2026-07-23 issue 3): 503+Retry-After and
no-response transport errors retry patiently (time-bounded); other
retryables keep the bounded attempt count; 4xx fail immediately."""
import unittest
from unittest import mock

import anyio
import httpx

from devproof_runner import client as client_mod
from devproof_runner.client import MessagesClient
from devproof_runner.errors import APIError


def make_client(handler) -> MessagesClient:
    c = MessagesClient(base_url="http://gw.test", auth_token="t")
    c._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://gw.test")
    return c


def call(c: MessagesClient):
    async def run():
        return await c.create(model="m", system="", messages=[], tools=None, max_tokens=8)
    return anyio.run(run)


class RetryTests(unittest.TestCase):
    def setUp(self):
        # No real sleeping in tests.
        async def no_sleep(_s): return None
        p = mock.patch.object(client_mod.anyio, "sleep", no_sleep)
        p.start(); self.addCleanup(p.stop)

    def test_503_with_retry_after_is_patient_then_final_error_surfaces(self):
        calls = []
        def handler(req):
            calls.append(1)
            if len(calls) < 6:  # more than MAX_ATTEMPTS: proves the patient path
                return httpx.Response(503, headers={"Retry-After": "0"},
                                      json={"error": {"message": "reloading"}})
            return httpx.Response(400, json={"error": {"message": "bad"}})
        with self.assertRaises(APIError) as ctx:
            call(make_client(handler))
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(len(calls), 6)

    def test_503_without_retry_after_is_still_patient(self):
        # The /v1/messages bridge drops the Retry-After header (verified live
        # 2026-07-23) — a bare 503 must still take the patient path.
        calls = []
        def handler(req):
            calls.append(1)
            if len(calls) <= 6:  # more than MAX_ATTEMPTS bare 503s
                return httpx.Response(503, json={"error": {"message": "reloading"}})
            return httpx.Response(400, json={"error": {"message": "done"}})
        with self.assertRaises(APIError) as ctx:
            call(make_client(handler))
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(len(calls), 7)

    def test_400_never_retried(self):
        calls = []
        def handler(req):
            calls.append(1)
            return httpx.Response(400, json={"error": {"message": "invalid model"}})
        with self.assertRaises(APIError):
            call(make_client(handler))
        self.assertEqual(len(calls), 1)

    def test_patient_window_bounds_the_5xx_loop(self):
        def handler(req):
            return httpx.Response(503, headers={"Retry-After": "0"},
                                  json={"error": {"message": "reloading"}})
        c = make_client(handler)
        with mock.patch.object(client_mod, "PATIENT_WINDOW", 0.0):
            with self.assertRaises(APIError) as ctx:
                call(c)
        self.assertEqual(ctx.exception.status, 503)
        self.assertIsNotNone(ctx.exception.retry_after)

    def test_connect_error_is_patient(self):
        calls = []
        def handler(req):
            calls.append(1)
            if len(calls) < 6:
                raise httpx.ConnectError("refused")
            return httpx.Response(400, json={"error": {"message": "done"}})
        with self.assertRaises(APIError) as ctx:
            call(make_client(handler))
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(len(calls), 6)

    def test_plain_500_keeps_bounded_attempts(self):
        calls = []
        def handler(req):
            calls.append(1)
            return httpx.Response(500, json={"error": {"message": "boom"}})
        with self.assertRaises(APIError):
            call(make_client(handler))
        self.assertEqual(len(calls), client_mod.MAX_ATTEMPTS)

    def test_patient_connect_error_delay_is_paced(self):
        # Patient connect-level failures (status None, no retry_after) must
        # not fall through to the ~1s exponential-formula floor — hundreds of
        # session pods retrying in lockstep at that cadence is the exact
        # thing the patient path exists to avoid.
        delays = []
        async def record_sleep(s):
            delays.append(s)
        calls = []
        def handler(req):
            calls.append(1)
            if len(calls) < 6:
                raise httpx.ConnectError("refused")
            return httpx.Response(400, json={"error": {"message": "done"}})
        c = make_client(handler)
        with mock.patch.object(client_mod.anyio, "sleep", record_sleep):
            with self.assertRaises(APIError):
                call(c)
        self.assertEqual(len(delays), 5)
        for d in delays:
            self.assertGreaterEqual(d, 5.0)
            self.assertLessEqual(d, 6.0)

    def test_patient_then_nonpatient_retryable_gets_fresh_attempts(self):
        calls = []
        def handler(req):
            calls.append(1)
            if len(calls) <= 5:  # more patient 503s than MAX_ATTEMPTS
                return httpx.Response(503, headers={"Retry-After": "0"},
                                      json={"error": {"message": "reloading"}})
            return httpx.Response(500, json={"error": {"message": "transient"}})
        with self.assertRaises(APIError) as ctx:
            call(make_client(handler))
        self.assertEqual(ctx.exception.status, 500)
        self.assertEqual(len(calls), 5 + client_mod.MAX_ATTEMPTS)


if __name__ == "__main__":
    unittest.main()
