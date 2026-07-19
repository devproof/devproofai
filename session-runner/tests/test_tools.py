"""Built-in tool unit tests (executors called directly)."""
import os
import tempfile
import unittest

from helpers import EnvSandbox, run_tool
from mock_gateway import MockProxy

from devproof_runner.tools import BUILTIN_TOOLS

BASH = BUILTIN_TOOLS["Bash"]
READ = BUILTIN_TOOLS["Read"]
WRITE = BUILTIN_TOOLS["Write"]
EDIT = BUILTIN_TOOLS["Edit"]
GLOB = BUILTIN_TOOLS["Glob"]
GREP = BUILTIN_TOOLS["Grep"]
WEBFETCH = BUILTIN_TOOLS["WebFetch"]


class ToolTestBase(unittest.TestCase):
    def setUp(self):
        self.sandbox = EnvSandbox().__enter__()
        self.cwd = tempfile.mkdtemp(prefix="devproof-tools-")

    def tearDown(self):
        self.sandbox.__exit__(None, None, None)

    def write(self, rel, content):
        path = os.path.join(self.cwd, rel)
        os.makedirs(os.path.dirname(path) or self.cwd, exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        return path


class BashTest(ToolTestBase):
    def test_echo(self):
        out, err = run_tool(BASH, {"command": "echo bash-works"}, self.cwd)
        self.assertFalse(err)
        self.assertIn("bash-works", out)

    def test_nonzero_exit(self):
        out, err = run_tool(BASH, {"command": "echo before-fail; exit 3"}, self.cwd)
        self.assertTrue(err)
        self.assertIn("Exit code 3", out)
        self.assertIn("before-fail", out)

    def test_missing_command(self):
        out, err = run_tool(BASH, {}, self.cwd)
        self.assertTrue(err)

    def test_timeout(self):
        out, err = run_tool(BASH, {"command": "sleep 5", "timeout": 300}, self.cwd)
        self.assertTrue(err)
        self.assertIn("timed out", out)

    def test_runs_in_cwd(self):
        self.write("marker.txt", "x")
        out, err = run_tool(BASH, {"command": "ls"}, self.cwd)
        self.assertFalse(err)
        self.assertIn("marker.txt", out)


class ReadWriteEditTest(ToolTestBase):
    def test_read_numbered(self):
        path = self.write("a.txt", "alpha\nbeta\ngamma\n")
        out, err = run_tool(READ, {"file_path": path}, self.cwd)
        self.assertFalse(err)
        self.assertIn("1\talpha", out)
        self.assertIn("3\tgamma", out)

    def test_read_offset_limit(self):
        path = self.write("b.txt", "\n".join(f"line{i}" for i in range(10)))
        out, err = run_tool(READ, {"file_path": path, "offset": 4, "limit": 2}, self.cwd)
        self.assertFalse(err)
        self.assertIn("5\tline4", out)
        self.assertIn("6\tline5", out)
        self.assertNotIn("line6", out.replace("more lines", ""))

    def test_read_missing(self):
        out, err = run_tool(READ, {"file_path": os.path.join(self.cwd, "nope")}, self.cwd)
        self.assertTrue(err)
        self.assertIn("not found", out.lower())

    def test_read_binary_rejected(self):
        path = os.path.join(self.cwd, "bin.dat")
        with open(path, "wb") as f:
            f.write(b"\x00\x01\x02payload")
        out, err = run_tool(READ, {"file_path": path}, self.cwd)
        self.assertTrue(err)
        self.assertIn("binary", out)

    def test_read_image_returns_image_block(self):
        import base64
        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
        path = os.path.join(self.cwd, "pic.png")
        with open(path, "wb") as f:
            f.write(png)
        out, err = run_tool(READ, {"file_path": path}, self.cwd)
        self.assertFalse(err)
        self.assertIsInstance(out, list)
        block = out[0]
        self.assertEqual(block["type"], "image")
        self.assertEqual(block["source"]["media_type"], "image/png")
        self.assertEqual(base64.b64decode(block["source"]["data"]), png)

    def test_read_image_too_large_rejected(self):
        path = os.path.join(self.cwd, "big.png")
        with open(path, "wb") as f:
            f.write(b"\x00" * (3 * 1024 * 1024 + 1))
        out, err = run_tool(READ, {"file_path": path}, self.cwd)
        self.assertTrue(err)
        self.assertIn("too large", out)

    def test_write_creates_dirs(self):
        path = os.path.join(self.cwd, "deep", "nested", "f.txt")
        out, err = run_tool(WRITE, {"file_path": path, "content": "hello"}, self.cwd)
        self.assertFalse(err)
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), "hello")

    def test_edit_unique(self):
        path = self.write("c.txt", "one two three")
        out, err = run_tool(EDIT, {"file_path": path, "old_string": "two",
                                   "new_string": "2"}, self.cwd)
        self.assertFalse(err)
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), "one 2 three")

    def test_edit_ambiguous_rejected(self):
        path = self.write("d.txt", "dup dup")
        out, err = run_tool(EDIT, {"file_path": path, "old_string": "dup",
                                   "new_string": "x"}, self.cwd)
        self.assertTrue(err)
        self.assertIn("2 times", out)

    def test_edit_replace_all(self):
        path = self.write("e.txt", "dup dup dup")
        out, err = run_tool(EDIT, {"file_path": path, "old_string": "dup",
                                   "new_string": "x", "replace_all": True}, self.cwd)
        self.assertFalse(err)
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), "x x x")

    def test_edit_not_found(self):
        path = self.write("f.txt", "content")
        out, err = run_tool(EDIT, {"file_path": path, "old_string": "absent",
                                   "new_string": "x"}, self.cwd)
        self.assertTrue(err)
        self.assertIn("not found", out)


class GlobGrepTest(ToolTestBase):
    def test_glob_recursive(self):
        self.write("top.py", "x")
        self.write("pkg/mod.py", "x")
        self.write("pkg/data.txt", "x")
        out, err = run_tool(GLOB, {"pattern": "**/*.py"}, self.cwd)
        self.assertFalse(err)
        self.assertIn("top.py", out)
        self.assertIn("mod.py", out)
        self.assertNotIn("data.txt", out)

    def test_glob_no_match(self):
        out, err = run_tool(GLOB, {"pattern": "*.zig"}, self.cwd)
        self.assertFalse(err)
        self.assertEqual(out, "No files found")

    def test_grep_content_mode(self):
        self.write("g.py", "import os\nvalue = 42\n")
        out, err = run_tool(GREP, {"pattern": r"value = \d+", "output_mode": "content"},
                            self.cwd)
        self.assertFalse(err)
        self.assertIn("g.py:2:value = 42", out)

    def test_grep_files_and_count(self):
        self.write("h1.txt", "needle here\nneedle again")
        self.write("h2.txt", "nothing")
        out, _ = run_tool(GREP, {"pattern": "needle"}, self.cwd)
        self.assertIn("h1.txt", out)
        self.assertNotIn("h2.txt", out)
        out, _ = run_tool(GREP, {"pattern": "needle", "output_mode": "count"}, self.cwd)
        self.assertIn("h1.txt:2", out)

    def test_grep_glob_filter_and_case(self):
        self.write("i.py", "NEEDLE")
        self.write("i.txt", "NEEDLE")
        out, _ = run_tool(GREP, {"pattern": "needle", "glob": "*.py",
                                 "case_insensitive": True, "output_mode": "content"},
                          self.cwd)
        self.assertIn("i.py", out)
        self.assertNotIn("i.txt", out)

    def test_grep_bad_regex(self):
        out, err = run_tool(GREP, {"pattern": "["}, self.cwd)
        self.assertTrue(err)
        self.assertIn("Invalid regex", out)


class WebFetchTest(ToolTestBase):
    def test_fetch_text(self):
        server = MockProxy(body="plain text body")
        try:
            out, err = run_tool(WEBFETCH, {"url": f"{server.url}/page"}, self.cwd)
        finally:
            server.close()
        self.assertFalse(err)
        self.assertIn("plain text body", out)

    def test_http_error_status(self):
        server = MockProxy(deny=True)
        try:
            out, err = run_tool(WEBFETCH, {"url": f"{server.url}/blocked"}, self.cwd)
        finally:
            server.close()
        self.assertTrue(err)
        self.assertIn("403", out)

    def test_rejects_non_http(self):
        out, err = run_tool(WEBFETCH, {"url": "file:///etc/passwd"}, self.cwd)
        self.assertTrue(err)

    def test_schemeless_url_defaults_to_https(self):
        # No server on the other end — asserting the https upgrade happened is
        # enough (the error text carries the final URL).
        out, err = run_tool(WEBFETCH, {"url": "localhost:1/nope"}, self.cwd)
        self.assertTrue(err)
        self.assertIn("https://localhost:1", out.replace("'", ""))


if __name__ == "__main__":
    unittest.main()
