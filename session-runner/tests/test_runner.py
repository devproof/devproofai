"""Unit tests for runner.py helpers. Run with the whole suite from
session-runner/ (host, or inside the runner image — deps live there):
  docker run --rm --entrypoint python -v .:/src -w /src \
      devproof/session-runner:devNN -m unittest discover -s tests -p "test_*.py" -v
"""
import os
import sys
import unittest

# runner.py lives one directory above this test.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# runner.py reads its env contract at import time.
os.environ.setdefault("DEVPROOF_SESSION_ID", "sesn_test")
os.environ.setdefault("DEVPROOF_PROMPT", "hi")
os.environ.setdefault("DEVPROOF_AGENT_CONFIG", '{"model": "m"}')
os.environ.setdefault("DEVPROOF_EVENTS_URL", "http://localhost:0/v1/sessions/sesn_test")

import runner  # noqa: E402


class FailureDetailTest(unittest.TestCase):
    def test_error_result_prefers_last_assistant_message(self):
        # Live bug 2026-07-13 (sesn_543c2c0j8nl3): the loop raise says only
        # "returned an error result: <subtype>" while the real reason is the
        # last assistant message (the gateway's 400).
        err = Exception("Devproof agent returned an error result: error_during_execution")
        state = {"last_text": "API Error: 400 litellm.ContextWindowExceededError: ..."}
        self.assertEqual(
            runner.failure_detail(err, state),
            "API Error: 400 litellm.ContextWindowExceededError: ...")

    def test_error_result_prefers_result_text_over_last_text(self):
        err = Exception("Devproof agent returned an error result: error_during_execution")
        state = {"result_text": "the result error", "last_text": "older message"}
        self.assertEqual(runner.failure_detail(err, state), "the result error")

    def test_error_result_without_detail_keeps_exception_text(self):
        err = Exception("Devproof agent returned an error result: error_max_turns")
        self.assertEqual(
            runner.failure_detail(err, {}),
            "Exception: Devproof agent returned an error result: error_max_turns")

    def test_genuine_crash_keeps_exception_text(self):
        err = ValueError("transport exploded")
        state = {"last_text": "unrelated assistant text"}
        self.assertEqual(runner.failure_detail(err, state), "ValueError: transport exploded")

    def test_detail_is_truncated(self):
        err = Exception("Devproof agent returned an error result: error_during_execution")
        state = {"last_text": "x" * 5000}
        self.assertEqual(len(runner.failure_detail(err, state)), 2000)


class PostRetryTest(unittest.TestCase):
    def test_retries_transient_failures_then_succeeds(self):
        calls = {"n": 0}
        naps = []

        def flaky(req, timeout):
            calls["n"] += 1
            if calls["n"] < 3:
                raise OSError(101, "Network is unreachable")
            class Res:
                def read(self):
                    return b"{}"
            return Res()

        import unittest.mock as mock
        with mock.patch.object(runner.urllib.request, "urlopen", flaky):
            runner.post("/events", {"events": []}, _sleep=naps.append)
        self.assertEqual(calls["n"], 3)
        # Exponential base plus [0,1) jitter — pods must not retry in lockstep.
        self.assertEqual(len(naps), 2)
        self.assertTrue(1 <= naps[0] < 2, naps)
        self.assertTrue(2 <= naps[1] < 3, naps)

    def test_raises_after_final_attempt(self):
        def dead(req, timeout):
            raise OSError(101, "Network is unreachable")
        import unittest.mock as mock
        with mock.patch.object(runner.urllib.request, "urlopen", dead):
            with self.assertRaises(OSError):
                runner.post("/status", {}, attempts=2, _sleep=lambda s: None)


class ExpandMcpHeadersTest(unittest.TestCase):
    def test_expands_placeholder_from_env(self):
        servers = {"c7": {"type": "http", "url": "https://x/mcp",
                          "headers": {"Authorization": "Bearer ${DEVPROOF_CRED_C7_TOKEN}"}}}
        out = runner.expand_mcp_headers(servers, env={"DEVPROOF_CRED_C7_TOKEN": "tok"})
        self.assertEqual(out["c7"]["headers"]["Authorization"], "Bearer tok")
        self.assertEqual(out["c7"]["url"], "https://x/mcp")

    def test_drops_header_with_unset_variable(self):
        servers = {"c7": {"url": "https://x/mcp",
                          "headers": {"Authorization": "Bearer ${MISSING_VAR}", "X-Ok": "plain"}}}
        out = runner.expand_mcp_headers(servers, env={})
        self.assertNotIn("Authorization", out["c7"]["headers"])
        self.assertEqual(out["c7"]["headers"]["X-Ok"], "plain")

    def test_untouched_without_headers_and_original_not_mutated(self):
        servers = {"a": {"url": "https://a/mcp"}, "b": "weird-non-dict"}
        out = runner.expand_mcp_headers(servers, env={})
        self.assertEqual(out, servers)
        withph = {"c": {"headers": {"A": "${V}"}}}
        runner.expand_mcp_headers(withph, env={"V": "x"})
        self.assertEqual(withph["c"]["headers"]["A"], "${V}")  # input dict untouched

    def test_empty_and_none(self):
        self.assertEqual(runner.expand_mcp_headers({}, env={}), {})
        self.assertEqual(runner.expand_mcp_headers(None, env={}), {})


import anyio
import io
import json
import tempfile


class DelegationPromptTest(unittest.TestCase):
    def test_empty_subagents_add_nothing(self):
        self.assertEqual(runner.delegation_prompt_block([]), "")

    def test_block_lists_names_and_instructions(self):
        block = runner.delegation_prompt_block([
            {"name": "reviewer", "agentId": "agent_1", "instructions": "use for code review"},
            {"name": "writer", "agentId": "agent_2", "instructions": "drafts docs"},
        ])
        self.assertIn("Delegate", block)
        self.assertIn('"reviewer": use for code review', block)
        self.assertIn('"writer": drafts docs', block)
        self.assertIn(runner.SUBAGENTS_DIR, block)
        self.assertNotIn("Claude", block)

    def test_advises_batching_files_into_one_call_per_task(self):
        block = runner.delegation_prompt_block([
            {"name": "reviewer", "agentId": "agent_1", "instructions": "use for code review"},
        ])
        self.assertIn(
            "Each Delegate call starts a separate, isolated agent session that "
            "only sees the files you pass it — prefer one call per task with "
            "all related files attached, not one call per file.", block)

    def test_teaches_continuation_and_complete(self):
        block = runner.delegation_prompt_block([
            {"name": "reviewer", "agentId": "agent_1", "instructions": "use for code review"},
        ])
        self.assertIn("continue the SAME agent", block)
        self.assertIn("session", block)
        self.assertIn("complete=true", block)
        self.assertIn("never set it", block)  # don't lock on the first call
        self.assertNotIn("Claude", block)


class WikiPromptTest(unittest.TestCase):
    def test_empty_wikis_add_nothing(self):
        self.assertEqual(runner.wiki_prompt_block([]), "")

    def test_read_wikis_get_hardcoded_structure_and_report_channel(self):
        block = runner.wiki_prompt_block([
            {"name": "kb", "mode": "read", "entries": []},
        ])
        self.assertIn("READ-ONLY", block)
        # Hardcoded structure spec is always present (not user config).
        self.assertIn("index.md", block)
        self.assertIn("frontmatter", block)
        self.assertIn("log.md", block)
        self.assertIn(f"{runner.WIKI_DIR}/kb", block)
        self.assertIn("Delegate", block)  # reporting channel for corrections
        self.assertNotIn("Claude", block)

    def test_write_wiki_is_sole_maintainer_with_hardcoded_structure(self):
        block = runner.wiki_prompt_block([
            {"name": "kb", "mode": "write", "entries": []},
        ])
        self.assertIn("SOLE maintainer", block)
        # Same hardcoded structure — no per-wiki guide is threaded in.
        self.assertIn("index.md", block)
        self.assertIn("frontmatter", block)
        self.assertIn("log.md", block)
        self.assertNotIn("Claude", block)


class StageWikisTest(unittest.TestCase):
    def test_skips_a_missing_page_404_instead_of_failing(self):
        import unittest.mock as mock, tempfile
        tmp = tempfile.mkdtemp(prefix="devproof-wiki-")

        class _Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return b"# ok\n"

        def fake_urlopen(url, timeout=0):
            if "file_missing" in url:
                raise runner.urllib.error.HTTPError(url, 404, "Not Found", None, io.BytesIO(b""))
            return _Resp()

        with mock.patch.object(runner, "WIKIS", [{"name": "kb", "mode": "read", "entries": [
                    {"path": "gone.md", "fileId": "file_missing"},
                    {"path": "index.md", "fileId": "file_ok"}]}]), \
             mock.patch.object(runner, "WIKI_DIR", tmp), \
             mock.patch.object(runner.urllib.request, "urlopen", fake_urlopen):
            names = runner.stage_wikis()  # a vanished page must NOT fail the session

        self.assertEqual(names, ["kb"])
        self.assertTrue(os.path.exists(os.path.join(tmp, "kb", "index.md")))
        self.assertFalse(os.path.exists(os.path.join(tmp, "kb", "gone.md")))


class PlatformPromptTest(unittest.TestCase):
    def test_mentions_prior_outputs_dir_and_markdown_image_hint(self):
        prompt = runner.system_prompt()
        self.assertIn(runner.PRIOR_OUTPUTS_DIR, prompt)
        self.assertIn("do not regenerate them", prompt)
        self.assertIn("![chart](my_chart.png)", prompt)
        self.assertNotIn("Claude", prompt)

    def test_package_line_allows_pip_when_env_allows_package_managers(self):
        line = runner.package_line(True)
        self.assertIn("Preinstalled Python packages:", line)
        self.assertIn("install it with pip", line)
        self.assertNotIn("disabled", line)

    def test_package_line_only_claims_disabled_when_env_disables(self):
        line = runner.package_line(False)
        self.assertIn("Preinstalled Python packages:", line)
        self.assertIn("disabled in this environment", line)
        self.assertNotIn("no pip install needed", line)


class StageAttachmentsTest(unittest.TestCase):
    """Live bug: a parent delegated three files all named profile_attempt_0.json
    (different source dirs). All three uploaded fine as distinct file records,
    but staging by plain basename clobbered all but the last write — the
    child only ever saw one of the three."""

    def setUp(self):
        self._orig = (runner.ATTACHMENTS, runner.UPLOADS_DIR, runner._download)
        runner.UPLOADS_DIR = tempfile.mkdtemp()

    def tearDown(self):
        runner.ATTACHMENTS, runner.UPLOADS_DIR, runner._download = self._orig

    def test_colliding_basenames_get_distinct_destinations(self):
        runner.ATTACHMENTS = [
            {"id": "file_a", "name": "a/profile_attempt_0.json"},
            {"id": "file_b", "name": "b/profile_attempt_0.json"},
            {"id": "file_c", "name": "c/profile_attempt_0.json"},
        ]

        def fake_download(file_id, dest):
            with open(dest, "w") as f:
                f.write(file_id)

        runner._download = fake_download
        paths = runner.stage_attachments()
        self.assertEqual(len(paths), 3)
        self.assertEqual(len(set(paths)), 3)  # distinct destinations
        contents = {}
        for p in paths:
            with open(p) as f:
                contents[p] = f.read()
        self.assertEqual(set(contents.values()), {"file_a", "file_b", "file_c"})


class StagePriorOutputsTest(unittest.TestCase):
    """Mirrors StageAttachmentsTest: prior-turn output files must dedupe
    colliding basenames the same way, staged into PRIOR_OUTPUTS_DIR (not
    OUTPUTS_DIR — collect_outputs() would re-publish them as duplicates)."""

    def setUp(self):
        self._orig = (runner.PRIOR_OUTPUTS, runner.PRIOR_OUTPUTS_DIR, runner._download)
        runner.PRIOR_OUTPUTS_DIR = tempfile.mkdtemp()

    def tearDown(self):
        runner.PRIOR_OUTPUTS, runner.PRIOR_OUTPUTS_DIR, runner._download = self._orig

    def test_colliding_basenames_get_distinct_destinations(self):
        runner.PRIOR_OUTPUTS = [
            {"id": "file_a", "name": "a/report.md"},
            {"id": "file_b", "name": "b/report.md"},
        ]

        def fake_download(file_id, dest):
            with open(dest, "w") as f:
                f.write(file_id)

        runner._download = fake_download
        paths = runner.stage_prior_outputs()
        self.assertEqual(len(paths), 2)
        self.assertEqual(len(set(paths)), 2)  # distinct destinations
        for p in paths:
            self.assertTrue(p.startswith(runner.PRIOR_OUTPUTS_DIR))
        contents = {}
        for p in paths:
            with open(p) as f:
                contents[p] = f.read()
        self.assertEqual(set(contents.values()), {"file_a", "file_b"})


class DelegateToolTest(unittest.TestCase):
    def setUp(self):
        runner.SUBAGENTS[:] = [{"name": "reviewer", "agentId": "agent_1", "instructions": "x"}]
        self._orig = (runner._post_json, runner._get_json, runner._upload_file, runner._download,
                      runner.SUBAGENTS_DIR, runner.DELEGATE_POLL_SEC, runner.DELEGATE_RETRY_BASE)
        # run_delegate mkdirs under SUBAGENTS_DIR before the (mocked) download —
        # /mnt may not be writable in the test container, so point it at a tmp dir.
        runner.SUBAGENTS_DIR = tempfile.mkdtemp()
        # Zero the backoff base so retry-loop tests don't sleep for real seconds.
        runner.DELEGATE_RETRY_BASE = 0

    def tearDown(self):
        runner.SUBAGENTS[:] = []
        (runner._post_json, runner._get_json, runner._upload_file, runner._download,
         runner.SUBAGENTS_DIR, runner.DELEGATE_POLL_SEC, runner.DELEGATE_RETRY_BASE) = self._orig

    def test_unknown_agent_is_error(self):
        text, is_error = anyio.run(runner.run_delegate, {"agent": "nope", "prompt": "hi"}, "/work")
        self.assertTrue(is_error)
        self.assertIn("unknown subagent", text)

    def test_happy_path_header_leads_then_text(self):
        polls = iter([{"status": "running"}, {"status": "idle", "resultText": "done!",
                      "outputs": [{"id": "file_9", "name": "out/report.md"}]}])
        downloads = []
        runner._post_json = lambda url, body: {"session": "sesn_child"}
        runner._get_json = lambda url: next(polls)
        runner._download = lambda fid, dest: downloads.append((fid, dest))
        runner.DELEGATE_POLL_SEC = 0
        text, is_error = anyio.run(runner.run_delegate, {"agent": "reviewer", "prompt": "go"}, "/work")
        self.assertFalse(is_error)
        header = json.loads(text.split("\n", 1)[0])
        self.assertEqual(header["session"], "sesn_child")
        expected = f"{runner.SUBAGENTS_DIR}/reviewer/out/report.md"
        self.assertEqual(header["files"], [expected])
        self.assertTrue(text.endswith("done!"))
        self.assertEqual(downloads, [("file_9", expected)])

    def test_failed_child_is_error_with_detail(self):
        runner._post_json = lambda url, body: {"session": "sesn_child"}
        runner._get_json = lambda url: {"status": "failed", "failureDetail": "deployment gone"}
        runner.DELEGATE_POLL_SEC = 0
        text, is_error = anyio.run(runner.run_delegate, {"agent": "reviewer", "prompt": "go"}, "/work")
        self.assertTrue(is_error)
        self.assertIn("deployment gone", text)
        self.assertIn("sesn_child", text)  # header still leads

    def test_files_are_uploaded_and_turn_attributed(self):
        posted = {}
        runner._upload_file = lambda path, name: "file_up1"
        runner._post_json = lambda url, body: posted.update(body) or {"session": "sesn_child"}
        runner._get_json = lambda url: {"status": "idle", "resultText": "ok", "outputs": []}
        runner.DELEGATE_POLL_SEC = 0
        anyio.run(runner.run_delegate,
                  {"agent": "reviewer", "prompt": "go", "files": ["/work/a.csv"]}, "/work")
        self.assertEqual(posted["files"], ["file_up1"])
        self.assertEqual(posted["agent_id"], "agent_1")
        if runner.TURN is None:
            self.assertNotIn("turn", posted)
        else:
            self.assertEqual(posted["turn"], int(runner.TURN))

    def test_uploaded_file_name_does_not_clobber_agent_name_for_outputs(self):
        # Regression: the upload-disambiguation loop used to reuse the `name`
        # variable that holds the subagent name, so a call with both `files`
        # and child `outputs` staged the outputs under the last uploaded
        # file's basename instead of SUBAGENTS_DIR/<agent>/.
        runner._upload_file = lambda path, name: "file_up1"
        runner._post_json = lambda url, body: {"session": "sesn_child"}
        runner._get_json = lambda url: {"status": "idle", "resultText": "ok",
                                        "outputs": [{"id": "file_9", "name": "report.md"}]}
        downloaded = []
        runner._download = lambda fid, dest: downloaded.append((fid, dest))
        runner.DELEGATE_POLL_SEC = 0
        text, is_error = anyio.run(runner.run_delegate, {
            "agent": "reviewer", "prompt": "go", "files": ["/work/a/data.txt"],
        }, "/work")
        self.assertFalse(is_error)
        expected = f"{runner.SUBAGENTS_DIR}/reviewer/report.md"
        self.assertEqual(downloaded, [("file_9", expected)])
        header = json.loads(text.split("\n", 1)[0])
        self.assertEqual(header["files"], [expected])

    def test_poll_survives_transient_blips(self):
        runner._post_json = lambda url, body: {"session": "sesn_child"}
        calls = {"n": 0}

        def flaky_get(url):
            calls["n"] += 1
            if calls["n"] <= 2:
                raise OSError("blip")
            return {"status": "idle", "resultText": "ok", "outputs": []}

        runner._get_json = flaky_get
        runner.DELEGATE_POLL_SEC = 0
        text, is_error = anyio.run(runner.run_delegate, {"agent": "reviewer", "prompt": "go"}, "/work")
        self.assertFalse(is_error)
        self.assertTrue(text.endswith("ok"))

    def test_poll_gives_up_after_consecutive_failures(self):
        def always_fails(url):
            raise OSError("down")

        runner._post_json = lambda url, body: {"session": "sesn_child"}
        runner._get_json = always_fails
        runner.DELEGATE_POLL_SEC = 0
        text, is_error = anyio.run(runner.run_delegate, {"agent": "reviewer", "prompt": "go"}, "/work")
        self.assertTrue(is_error)
        self.assertIn("delegate failed", text)
        header = json.loads(text.split("\n", 1)[0])  # child id survives a post-creation give-up
        self.assertEqual(header["session"], "sesn_child")

    def test_interrupted_child_is_error_with_partial_answer(self):
        runner._post_json = lambda url, body: {"session": "sesn_child"}
        runner._get_json = lambda url: {"status": "idle", "interrupted": True,
                                        "resultText": "partial work", "outputs": []}
        runner.DELEGATE_POLL_SEC = 0
        text, is_error = anyio.run(runner.run_delegate, {"agent": "reviewer", "prompt": "go"}, "/work")
        self.assertTrue(is_error)
        header = json.loads(text.split("\n", 1)[0])
        self.assertEqual(header["session"], "sesn_child")
        self.assertIn("interrupted before finishing", text)
        self.assertIn("Partial answer: partial work", text)

    def test_interrupted_child_without_text_omits_partial_answer(self):
        runner._post_json = lambda url, body: {"session": "sesn_child"}
        runner._get_json = lambda url: {"status": "idle", "interrupted": True, "outputs": []}
        runner.DELEGATE_POLL_SEC = 0
        text, is_error = anyio.run(runner.run_delegate, {"agent": "reviewer", "prompt": "go"}, "/work")
        self.assertTrue(is_error)
        self.assertIn("interrupted before finishing", text)
        self.assertNotIn("Partial answer", text)

    def test_hostile_output_name_is_skipped_not_written(self):
        runner._post_json = lambda url, body: {"session": "sesn_child"}
        runner._get_json = lambda url: {"status": "idle", "resultText": "done",
                                        "outputs": [{"id": "file_9", "name": "../../../etc/evil"}]}
        downloaded = []
        runner._download = lambda fid, dest: downloaded.append(dest)
        runner.DELEGATE_POLL_SEC = 0
        text, is_error = anyio.run(runner.run_delegate, {"agent": "reviewer", "prompt": "go"}, "/work")
        self.assertFalse(is_error)
        self.assertEqual(downloaded, [])
        header = json.loads(text.split("\n", 1)[0])
        self.assertEqual(header["files"], [])
        self.assertIn("skipped unsafe output name", text)
        self.assertIn("../../../etc/evil", text)

    def test_absolute_output_name_is_skipped(self):
        runner._post_json = lambda url, body: {"session": "sesn_child"}
        runner._get_json = lambda url: {"status": "idle", "resultText": "done",
                                        "outputs": [{"id": "file_9", "name": "/etc/passwd"}]}
        downloaded = []
        runner._download = lambda fid, dest: downloaded.append(dest)
        runner.DELEGATE_POLL_SEC = 0
        text, is_error = anyio.run(runner.run_delegate, {"agent": "reviewer", "prompt": "go"}, "/work")
        self.assertFalse(is_error)
        self.assertEqual(downloaded, [])
        header = json.loads(text.split("\n", 1)[0])
        self.assertEqual(header["files"], [])

    def test_download_retries_then_succeeds(self):
        runner._post_json = lambda url, body: {"session": "sesn_child"}
        runner._get_json = lambda url: {"status": "idle", "resultText": "ok",
                                        "outputs": [{"id": "file_9", "name": "out/report.md"}]}
        download_calls = {"n": 0}

        def flaky_download(fid, dest):
            download_calls["n"] += 1
            if download_calls["n"] == 1:
                raise OSError("blip")
            with open(dest, "w") as f:
                f.write("data")

        runner._download = flaky_download
        runner.DELEGATE_POLL_SEC = 0
        text, is_error = anyio.run(runner.run_delegate, {"agent": "reviewer", "prompt": "go"}, "/work")
        self.assertFalse(is_error)
        header = json.loads(text.split("\n", 1)[0])
        expected = f"{runner.SUBAGENTS_DIR}/reviewer/out/report.md"
        self.assertEqual(header["files"], [expected])

    def test_colliding_file_basenames_get_dir_disambiguated_names(self):
        # Two files named data.txt from different parent dirs, plus one
        # unique basename — collisions get dir__base, the unique one stays plain.
        captured = []

        def fake_upload(path, name):
            captured.append((path, name))
            return f"file_{len(captured)}"

        runner._upload_file = fake_upload
        runner._post_json = lambda url, body: {"session": "sesn_child"}
        runner._get_json = lambda url: {"status": "idle", "resultText": "ok", "outputs": []}
        runner.DELEGATE_POLL_SEC = 0
        anyio.run(runner.run_delegate, {
            "agent": "reviewer", "prompt": "go",
            "files": ["/work/a/data.txt", "/work/b/data.txt", "/work/unique.csv"],
        }, "/work")
        self.assertEqual(captured, [
            ("/work/a/data.txt", "a__data.txt"),
            ("/work/b/data.txt", "b__data.txt"),
            ("/work/unique.csv", "unique.csv"),
        ])

    def test_delegate_tool_shape(self):
        tool = runner.delegate_tool()
        self.assertEqual(tool.name, "Delegate")
        self.assertEqual(tool.input_schema["properties"]["agent"]["enum"], ["reviewer"])
        # required is just ["agent"] — prompt is required only for non-complete
        # calls (validated in the executor, not the schema, since a complete
        # call carries no prompt at all).
        self.assertEqual(tool.input_schema["required"], ["agent"])
        self.assertEqual(tool.input_schema["properties"]["session"]["type"], "string")
        self.assertEqual(tool.input_schema["properties"]["complete"]["type"], "boolean")
        self.assertNotIn("session", tool.input_schema["required"])
        self.assertNotIn("complete", tool.input_schema["required"])

    def test_complete_without_session_is_error(self):
        text, is_error = anyio.run(runner.run_delegate, {"agent": "reviewer", "complete": True}, "/work")
        self.assertTrue(is_error)
        self.assertIn("only locks a child you already started", text)
        self.assertIn("agent + prompt", text)  # guides the model to the right first call

    def test_prompt_missing_without_complete_is_error(self):
        text, is_error = anyio.run(runner.run_delegate, {"agent": "reviewer"}, "/work")
        self.assertTrue(is_error)
        self.assertIn("prompt required", text)

    def test_complete_happy_path_posts_to_complete_url_and_returns_non_error(self):
        captured = {}

        def fake_post(url, body):
            captured["url"] = url
            captured["body"] = body
            return {"ok": True, "status": "completed"}

        runner._post_json = fake_post
        text, is_error = anyio.run(
            runner.run_delegate, {"agent": "reviewer", "session": "sesn_child", "complete": True}, "/work")
        self.assertFalse(is_error)
        self.assertIn("sesn_child", text)
        self.assertEqual(captured["url"], f"{runner.EVENTS_URL}/delegate/sesn_child/complete")

    def test_complete_http_error_is_reported(self):
        def raiser(url, body):
            fp = io.BytesIO(b"child completed (locked)")
            raise runner.urllib.error.HTTPError(url, 409, "conflict", None, fp)

        runner._post_json = raiser
        text, is_error = anyio.run(
            runner.run_delegate, {"agent": "reviewer", "session": "sesn_child", "complete": True}, "/work")
        self.assertTrue(is_error)
        self.assertIn("delegate complete failed", text)

    def test_continuation_passes_session_in_delegate_body(self):
        captured = {}

        def fake_post(url, body):
            captured["url"] = url
            captured["body"] = body
            return {"session": "sesn_child"}

        runner._post_json = fake_post
        runner._get_json = lambda url: {"status": "idle", "resultText": "more", "outputs": []}
        runner.DELEGATE_POLL_SEC = 0
        text, is_error = anyio.run(
            runner.run_delegate, {"agent": "reviewer", "prompt": "keep going", "session": "sesn_child"}, "/work")
        self.assertFalse(is_error)
        self.assertEqual(captured["url"], f"{runner.EVENTS_URL}/delegate")
        self.assertEqual(captured["body"]["session"], "sesn_child")
        header = json.loads(text.split("\n", 1)[0])
        self.assertEqual(header["session"], "sesn_child")


class McpHeaderExpansionTest(unittest.TestCase):
    """A4: only DEVPROOF_CRED_* placeholders may expand — never platform env
    like the internal gateway token."""

    def test_credential_placeholder_expands(self):
        env = {"DEVPROOF_CRED_GH_TOKEN": "secret-tok"}
        out = runner.expand_mcp_headers(
            {"gh": {"url": "https://x", "headers": {"Authorization": "Bearer ${DEVPROOF_CRED_GH_TOKEN}"}}}, env)
        self.assertEqual(out["gh"]["headers"]["Authorization"], "Bearer secret-tok")

    def test_platform_secret_placeholder_is_dropped(self):
        env = {"DEVPROOF_AUTH_TOKEN": "internal-key", "DEVPROOF_CRED_X_TOKEN": "ok"}
        out = runner.expand_mcp_headers(
            {"evil": {"url": "https://attacker", "headers": {"X-Exfil": "${DEVPROOF_AUTH_TOKEN}"}}}, env)
        # header dropped entirely — the internal key never rides the request
        self.assertNotIn("X-Exfil", out["evil"]["headers"])

    def test_unset_credential_is_dropped(self):
        out = runner.expand_mcp_headers(
            {"s": {"url": "https://x", "headers": {"Authorization": "Bearer ${DEVPROOF_CRED_MISSING_TOKEN}"}}}, {})
        self.assertNotIn("Authorization", out["s"]["headers"])


class ContainedDestTest(unittest.TestCase):
    """A8: staged wiki/memory/skill paths can't escape their base dir."""

    def test_normal_path_stays_under_base(self):
        self.assertEqual(runner._contained_dest("/mnt/wiki/w", "sub/page.md"),
                         os.path.normpath("/mnt/wiki/w/sub/page.md"))

    def test_leading_slash_is_contained(self):
        self.assertEqual(runner._contained_dest("/mnt/wiki/w", "/index.md"),
                         os.path.normpath("/mnt/wiki/w/index.md"))

    def test_parent_traversal_is_rejected(self):
        self.assertIsNone(runner._contained_dest("/mnt/wiki/w", "../../session/outputs/evil.md"))

    def test_sibling_prefix_is_rejected(self):
        self.assertIsNone(runner._contained_dest("/mnt/wiki/w", "../w-evil/x.md"))


if __name__ == "__main__":
    unittest.main()
