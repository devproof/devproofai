"""Skills discovery/loading and auto-compaction behaviour."""
import os
import tempfile
import unittest

from helpers import EnvSandbox, by_type, collect
from mock_gateway import MockGateway

from devproof_runner import AgentOptions
from devproof_runner.compact import context_window, drop_oldest, should_compact
from devproof_runner.skills import SkillInfo, discover_skills, parse_frontmatter, skills_prompt
from devproof_runner.types import (ResultMessage, SystemMessage, ToolResultBlock,
                                      UserMessage)

SKILL_MD = """---
name: demo
description: Demo skill for tests
---

# Demo

DO THE DEMO THING step by step.
"""

FOLDED_SKILL_MD = """---
name: dremio-profile-analysis
description: >
  Analyzes Dremio query profiles for performance issues
  and produces a findings report.
---

# Dremio profile analysis
"""

FOLDED_CHOMPED_SKILL_MD = """---
name: dremio-profile-analysis
description: >-
  Analyzes Dremio query profiles for performance issues
  and produces a findings report.
---
"""

LITERAL_SKILL_MD = """---
name: multi-line-literal
description: |
  Line one.
  Line two.
---
"""

FOLDED_THEN_KEY_MD = """---
description: >
  Folded body text
  continues here.
name: after-block
---
"""


class SkillsTest(unittest.TestCase):
    def setUp(self):
        self.sandbox = EnvSandbox().__enter__()
        self.gw = MockGateway()
        os.environ["DEVPROOF_BASE_URL"] = self.gw.url
        self.cwd = tempfile.mkdtemp(prefix="devproof-skills-")
        self.skills_dir = os.path.join(self.cwd, ".devproof", "skills")
        skill_dir = os.path.join(self.skills_dir, "demo")
        os.makedirs(os.path.join(skill_dir, "references"))
        os.makedirs(os.path.join(skill_dir, "scripts"))
        os.makedirs(os.path.join(skill_dir, "evals"))
        with open(os.path.join(skill_dir, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write(SKILL_MD)
        with open(os.path.join(skill_dir, "references", "notes.md"), "w", encoding="utf-8") as f:
            f.write("REFERENCE-NOTES-CONTENT")
        with open(os.path.join(skill_dir, "scripts", "run.py"), "w", encoding="utf-8") as f:
            f.write("print('SCRIPT-CONTENT')")
        with open(os.path.join(skill_dir, "evals", "eval.md"), "w", encoding="utf-8") as f:
            f.write("EVAL-ONLY-CONTENT")
        with open(os.path.join(skill_dir, "logo.bin"), "wb") as f:
            f.write(b"\x00\x01binarystuff")

    def tearDown(self):
        self.gw.close()
        self.sandbox.__exit__(None, None, None)

    def test_skill_listed_and_loadable(self):
        self.gw.script = [
            {"blocks": [{"type": "tool_use", "id": "s1", "name": "Skill",
                         "input": {"skill": "demo"}}], "stop_reason": "tool_use"},
            {"blocks": [{"type": "text", "text": "done"}]},
        ]
        options = AgentOptions(model="m", system_prompt="Agent prompt.",
                               tools=["Read"], max_turns=5,
                               cwd=self.cwd, skills_dir=self.skills_dir)
        messages, err = collect("use the demo skill", options)
        self.assertIsNone(err)
        init = by_type(messages, SystemMessage)[0]
        self.assertIn("Skill", init.data["tools"])
        system = self.gw.requests[0]["system"]
        self.assertIn("Agent prompt.", system)
        self.assertIn("demo: Demo skill for tests", system)
        block = by_type(messages, UserMessage)[0].content[0]
        self.assertIsInstance(block, ToolResultBlock)
        self.assertFalse(block.is_error)
        self.assertIn("DO THE DEMO THING", block.content)
        self.assertIn(os.path.join(".devproof", "skills", "demo"), block.content)
        # Lazy loading (user decision 2026-07-17 rev 2): SKILL.md + a file
        # INDEX ride the result; bundled content is loaded via path on demand,
        # evals/ never appears.
        self.assertIn("references/notes.md", block.content)
        self.assertIn("scripts/run.py", block.content)
        self.assertIn("logo.bin", block.content)
        self.assertNotIn("REFERENCE-NOTES-CONTENT", block.content)
        self.assertNotIn("EVAL-ONLY-CONTENT", block.content)
        self.assertNotIn("evals/", block.content)

    def test_skill_file_lazy_load(self):
        self.gw.script = [
            {"blocks": [{"type": "tool_use", "id": "s1", "name": "Skill",
                         "input": {"skill": "demo", "path": "references/notes.md"}}],
             "stop_reason": "tool_use"},
            {"blocks": [{"type": "text", "text": "done"}]},
        ]
        options = AgentOptions(model="m", tools=["Read"], max_turns=5,
                               cwd=self.cwd, skills_dir=self.skills_dir)
        messages, err = collect("load the reference", options)
        self.assertIsNone(err)
        block = by_type(messages, UserMessage)[0].content[0]
        self.assertFalse(block.is_error)
        self.assertIn("REFERENCE-NOTES-CONTENT", block.content)
        self.assertIn("demo/references/notes.md", block.content)

    def test_skill_file_unknown_path_lists_available(self):
        self.gw.script = [
            {"blocks": [{"type": "tool_use", "id": "s1", "name": "Skill",
                         "input": {"skill": "demo", "path": "evals/eval.md"}}],
             "stop_reason": "tool_use"},
            {"blocks": [{"type": "text", "text": "done"}]},
        ]
        options = AgentOptions(model="m", tools=["Read"], max_turns=5,
                               cwd=self.cwd, skills_dir=self.skills_dir)
        messages, err = collect("x", options)
        self.assertIsNone(err)
        block = by_type(messages, UserMessage)[0].content[0]
        # evals/ is excluded even from direct path loads.
        self.assertTrue(block.is_error)
        self.assertIn("references/notes.md", block.content)

    def test_unknown_skill_is_tool_error(self):
        self.gw.script = [
            {"blocks": [{"type": "tool_use", "id": "s1", "name": "Skill",
                         "input": {"skill": "nope"}}], "stop_reason": "tool_use"},
            {"blocks": [{"type": "text", "text": "done"}]},
        ]
        options = AgentOptions(model="m", tools=["Read"], max_turns=5,
                               cwd=self.cwd, skills_dir=self.skills_dir)
        messages, err = collect("x", options)
        self.assertIsNone(err)
        block = by_type(messages, UserMessage)[0].content[0]
        self.assertTrue(block.is_error)
        self.assertIn("Unknown skill", block.content)

    def test_no_skills_dir_no_skill_tool(self):
        self.gw.script = [{"blocks": [{"type": "text", "text": "ok"}]}]
        options = AgentOptions(model="m", tools=["Read"], max_turns=5, cwd=self.cwd)
        messages, err = collect("x", options)
        self.assertIsNone(err)
        self.assertNotIn("Skill", by_type(messages, SystemMessage)[0].data["tools"])

    def test_parse_frontmatter(self):
        meta = parse_frontmatter(SKILL_MD)
        self.assertEqual(meta["name"], "demo")
        self.assertEqual(meta["description"], "Demo skill for tests")
        self.assertEqual(parse_frontmatter("no frontmatter here"), {})

    def test_parse_frontmatter_folded_block_scalar(self):
        meta = parse_frontmatter(FOLDED_SKILL_MD)
        self.assertEqual(meta["name"], "dremio-profile-analysis")
        self.assertEqual(
            meta["description"],
            "Analyzes Dremio query profiles for performance issues "
            "and produces a findings report.",
        )

    def test_parse_frontmatter_literal_block_scalar(self):
        meta = parse_frontmatter(LITERAL_SKILL_MD)
        self.assertEqual(meta["description"], "Line one.\nLine two.")

    def test_parse_frontmatter_folded_chomped_block_scalar(self):
        meta = parse_frontmatter(FOLDED_CHOMPED_SKILL_MD)
        self.assertEqual(
            meta["description"],
            "Analyzes Dremio query profiles for performance issues "
            "and produces a findings report.",
        )

    def test_parse_frontmatter_key_after_block_scalar(self):
        meta = parse_frontmatter(FOLDED_THEN_KEY_MD)
        self.assertEqual(meta["description"], "Folded body text continues here.")
        self.assertEqual(meta["name"], "after-block")

    def test_skills_prompt_renders_folded_description(self):
        skill_dir = os.path.join(self.cwd, ".devproof", "skills", "dremio-profile-analysis")
        os.makedirs(skill_dir, exist_ok=True)
        skill_path = os.path.join(skill_dir, "SKILL.md")
        with open(skill_path, "w", encoding="utf-8") as f:
            f.write(FOLDED_SKILL_MD)
        skills = discover_skills(os.path.join(self.cwd, ".devproof", "skills"))
        info = next(s for s in skills if s.name == "dremio-profile-analysis")
        self.assertEqual(
            info.description,
            "Analyzes Dremio query profiles for performance issues "
            "and produces a findings report.",
        )
        prompt = skills_prompt([info])
        self.assertIn(
            "dremio-profile-analysis: Analyzes Dremio query profiles for "
            "performance issues and produces a findings report.",
            prompt,
        )
        self.assertNotIn(": >", prompt)


class CompactTest(unittest.TestCase):
    def setUp(self):
        self.sandbox = EnvSandbox().__enter__()
        self.gw = MockGateway()
        os.environ["DEVPROOF_BASE_URL"] = self.gw.url
        self.cwd = tempfile.mkdtemp(prefix="devproof-compact-")

    def tearDown(self):
        self.gw.close()
        self.sandbox.__exit__(None, None, None)

    def test_auto_compaction_summarizes_and_continues(self):
        big = os.path.join(self.cwd, "big.txt")
        with open(big, "w", encoding="utf-8") as f:
            f.write("data line\n" * 300)
        self.gw.script = [
            {"blocks": [{"type": "tool_use", "id": "r1", "name": "Read",
                         "input": {"file_path": big}}], "stop_reason": "tool_use"},
            # Summarization request answers with the marker...
            {"blocks": [{"type": "text", "text": "SUMMARY-MARKER of the work"}]},
            # ...then the real continuation call.
            {"blocks": [{"type": "text", "text": "continuing after compact"}]},
        ]
        options = AgentOptions(model="m", tools=["Read"],
                               max_turns=10, cwd=self.cwd, context_window=200)
        messages, err = collect("read the big file", options)
        self.assertIsNone(err)
        boundaries = [m for m in by_type(messages, SystemMessage)
                      if m.subtype == "compact_boundary"]
        self.assertEqual(len(boundaries), 1)
        self.assertEqual(by_type(messages, ResultMessage)[0].subtype, "success")
        # The summarization request asked for a summary on top of full history.
        summary_req = self.gw.requests[1]
        self.assertIn("summarize", str(summary_req["messages"][-1]).lower())
        # The continuation ran on compacted history containing the summary.
        final_req = self.gw.requests[2]
        self.assertEqual(len(final_req["messages"]), 1)
        self.assertIn("SUMMARY-MARKER", str(final_req["messages"][0]))

    def test_window_from_env(self):
        os.environ["DEVPROOF_CONTEXT_WINDOW"] = "32768"
        self.assertEqual(context_window(None), 32768)
        self.assertEqual(context_window(1000), 1000)
        del os.environ["DEVPROOF_CONTEXT_WINDOW"]
        # No window anywhere ⇒ small conservative default (the platform local cap),
        # so a long turn compacts early instead of overflowing a 32k local model.
        self.assertEqual(context_window(None), 32_768)

    def test_should_compact_thresholds(self):
        self.assertTrue(should_compact(100, 90, 3))
        self.assertFalse(should_compact(100, 70, 3))
        self.assertFalse(should_compact(100, 900, 1))
        self.assertFalse(should_compact(10_000_000, 3000, 3))

    def test_drop_oldest_keeps_valid_start(self):
        messages = [
            {"role": "user", "content": [{"type": "text", "text": "task"}]},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "t",
                                               "name": "Bash", "input": {}}]},
            {"role": "user", "content": [{"type": "tool_result",
                                          "tool_use_id": "t", "content": "out"}]},
            {"role": "assistant", "content": [{"type": "text", "text": "mid"}]},
            {"role": "user", "content": [{"type": "text", "text": "more"}]},
            {"role": "assistant", "content": [{"type": "text", "text": "end"}]},
        ]
        kept = drop_oldest(messages)
        self.assertEqual(kept[0]["role"], "user")
        self.assertIn("dropped", kept[0]["content"][0]["text"])
        first_real = kept[1]
        self.assertEqual(first_real["role"], "user")
        self.assertTrue(all(b.get("type") != "tool_result" for b in first_real["content"]))


if __name__ == "__main__":
    unittest.main()
