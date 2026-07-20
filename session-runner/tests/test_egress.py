"""Egress-restriction behaviour: session pods run behind a Squid forward proxy
(HTTP(S)_PROXY env) with the gateway/control-plane on NO_PROXY. The loop must
route WebFetch/MCP traffic through the proxy, keep gateway traffic direct, and
hand the proxy env down to Bash children (that is what constrains pip, curl,
npm, ... inside the sandbox)."""
import os
import shutil
import tempfile
import unittest

from helpers import EnvSandbox, by_type, collect, run_tool
from mock_gateway import MockGateway, MockProxy

from devproof_runner import AgentOptions
from devproof_runner.types import ResultMessage, SystemMessage
from devproof_runner.tools import BUILTIN_TOOLS

WEBFETCH = BUILTIN_TOOLS["WebFetch"]
BASH = BUILTIN_TOOLS["Bash"]


def set_proxy(url: str, no_proxy: str = "") -> None:
    for key in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
        os.environ[key] = url
    for key in ("NO_PROXY", "no_proxy"):
        if no_proxy:
            os.environ[key] = no_proxy
        else:
            os.environ.pop(key, None)


class EgressTest(unittest.TestCase):
    def setUp(self):
        self.sandbox = EnvSandbox().__enter__()
        self.cwd = tempfile.mkdtemp(prefix="devproof-egress-")

    def tearDown(self):
        self.sandbox.__exit__(None, None, None)

    def test_webfetch_routes_through_proxy(self):
        proxy = MockProxy(body="allowed by squid")
        try:
            set_proxy(proxy.url)
            out, err = run_tool(WEBFETCH,
                                {"url": "http://blocked-domain.invalid/data"}, self.cwd)
        finally:
            proxy.close()
        self.assertFalse(err)
        self.assertIn("allowed by squid", out)
        # The proxy saw the absolute-URI request — traffic did not go direct.
        self.assertTrue(any("blocked-domain.invalid" in seen for seen in proxy.seen))

    def test_webfetch_proxy_denial_is_clean_tool_error(self):
        proxy = MockProxy(deny=True)
        try:
            set_proxy(proxy.url)
            out, err = run_tool(WEBFETCH,
                                {"url": "http://forbidden.invalid/x"}, self.cwd)
        finally:
            proxy.close()
        self.assertTrue(err)
        self.assertIn("403", out)

    def test_no_proxy_host_bypasses_proxy(self):
        target = MockProxy(body="direct response")
        try:
            # Dead proxy: if NO_PROXY were ignored, this request would fail.
            set_proxy("http://127.0.0.1:9", no_proxy="127.0.0.1,localhost")
            out, err = run_tool(WEBFETCH, {"url": f"{target.url}/direct"}, self.cwd)
        finally:
            target.close()
        self.assertFalse(err)
        self.assertIn("direct response", out)

    def test_gateway_traffic_honors_no_proxy(self):
        """A session pod always carries proxy env; gateway calls must still work
        because the gateway host is on NO_PROXY."""
        gw = MockGateway()
        try:
            set_proxy("http://127.0.0.1:9", no_proxy="127.0.0.1,localhost")
            os.environ["DEVPROOF_BASE_URL"] = gw.url
            gw.script = [{"blocks": [{"type": "text", "text": "reached the gateway"}]}]
            messages, err = collect("hi", AgentOptions(model="m", max_turns=2,
                                                       cwd=self.cwd))
        finally:
            gw.close()
        self.assertIsNone(err)
        self.assertEqual(by_type(messages, ResultMessage)[0].subtype, "success")

    def test_bash_children_inherit_proxy_env(self):
        """pip/curl/npm restrictions ride the inherited proxy env — verify a
        shell child (and thus everything it spawns) sees it."""
        if os.name == "nt":
            # On a Windows host `bash` usually resolves to WSL bash, which does
            # not inherit Windows env vars at all — the inheritance under test
            # is unobservable through it. Use Git Bash (which does inherit), or
            # skip when it isn't installed. The pod runtime is Linux bash.
            git = shutil.which("git")
            git_bash = git and os.path.join(os.path.dirname(os.path.dirname(git)), "bin", "bash.exe")
            if not (git_bash and os.path.exists(git_bash)):
                self.skipTest("no env-inheriting bash on this Windows host")
            os.environ["DEVPROOF_SDK_SHELL"] = git_bash
        set_proxy("http://egress-env-x.devproof-agents.svc.cluster.local:3128")
        out, err = run_tool(
            BASH, {"command": 'echo "https_proxy=$HTTPS_PROXY no_proxy=$NO_PROXY"'},
            self.cwd)
        self.assertFalse(err)
        self.assertIn("https_proxy=http://egress-env-x.devproof-agents.svc.cluster.local:3128",
                      out)

    def test_mcp_server_behind_denying_proxy_is_skipped(self):
        """A Squid-denied MCP server must not fail the turn — its tools are
        simply absent."""
        gw = MockGateway()
        proxy = MockProxy(deny=True)
        try:
            set_proxy(proxy.url, no_proxy="127.0.0.1,localhost")
            os.environ["DEVPROOF_BASE_URL"] = gw.url
            gw.script = [{"blocks": [{"type": "text", "text": "no mcp, still fine"}]}]
            messages, err = collect("hi", AgentOptions(
                model="m", tools=["Bash"], max_turns=2, cwd=self.cwd,
                mcp_servers={"blocked": {"type": "http",
                                         "url": "http://mcp-blocked.invalid/mcp"}}))
        finally:
            gw.close()
            proxy.close()
        self.assertIsNone(err)
        init = by_type(messages, SystemMessage)[0]
        self.assertEqual([t for t in init.data["tools"] if t.startswith("mcp__")], [])
        self.assertEqual(by_type(messages, ResultMessage)[0].subtype, "success")


if __name__ == "__main__":
    unittest.main()
