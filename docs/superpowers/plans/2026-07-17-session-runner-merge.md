# Session-Runner Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold `agent-sdk/` into `session-runner/` as package `devproof_runner`, erasing the "agent SDK" terminology with zero behavior change.

**Architecture:** Pure move+rename. The loop package becomes `session-runner/devproof_runner/` (plain files, no pip packaging); tests unify under `session-runner/tests/`; the Dockerfile COPYs the package next to `runner.py` in `/app`. New image tag `dev46`.

**Tech Stack:** Python 3.12 (unittest), Docker, existing CP/console untouched.

## Global Constraints

- ZERO third-party AI references in `session-runner/` sources (user decision 2026-07-17).
- Public API (`AgentOptions`, `query`, error types), all `DEVPROOF_*` env names, `~/.devproof/sessions` transcript paths: UNCHANGED.
- Runner image change ⇒ bump tag: `dev45` → `dev46`, build from repo root.
- Spec: `docs/superpowers/specs/2026-07-17-session-runner-merge-design.md`.

---

### Task 1: Move files (git mv), delete agent-sdk/

**Files:**
- Move: `agent-sdk/devproof_agent_sdk/` → `session-runner/devproof_runner/`
- Move: `agent-sdk/tests/` → `session-runner/tests/`
- Move: `session-runner/test_runner.py` → `session-runner/tests/test_runner.py`
- Delete: `agent-sdk/pyproject.toml` (and the now-empty `agent-sdk/`)

**Interfaces:**
- Produces: package importable as `devproof_runner` from `session-runner/` cwd (imports still say `devproof_agent_sdk` until Task 2 — expected broken state mid-task; Tasks 1+2 commit together).

- [ ] **Step 1: git mv everything**

```bash
git mv agent-sdk/devproof_agent_sdk session-runner/devproof_runner
git mv agent-sdk/tests session-runner/tests
git mv session-runner/test_runner.py session-runner/tests/test_runner.py
git rm agent-sdk/pyproject.toml
```

Untracked `__pycache__` dirs may remain under `agent-sdk/` — remove the leftover dir: `rm -rf agent-sdk`.

- [ ] **Step 2: Verify tree**

Run: `git status --short` — expect only renames (`R`) and one delete; `ls agent-sdk` fails.

### Task 2: Rename imports + purge "agent sdk" strings

**Files:**
- Modify: everything under `session-runner/` containing `devproof_agent_sdk` or agent-SDK wording:
  - `session-runner/runner.py` (imports at old lines 515, 555–556, 662; module docstring line 1)
  - `session-runner/devproof_runner/__init__.py`, `types.py` (docstrings)
  - `session-runner/devproof_runner/mcp.py:99` (`clientInfo.name`)
  - `session-runner/devproof_runner/query.py:156,178` (warning prefixes)
  - `session-runner/devproof_runner/tools/webfetch.py:47` (User-Agent)
  - `session-runner/tests/*.py` (imports)
  - `session-runner/Dockerfile` comments (content changes in Task 4)

**Interfaces:**
- Produces: `from devproof_runner import AgentOptions, ErrorResultError`, `from devproof_runner import query`, `from devproof_runner.types import ...`, `from devproof_runner.tools import Tool` — same symbols, new package name.

- [ ] **Step 1: Mechanical rename** — replace `devproof_agent_sdk` → `devproof_runner` and `devproof-agent-sdk` → `devproof-runner` in all `session-runner/**/*.py` (script replace, not hand edits; preserves `/0.1` suffix in webfetch User-Agent → `devproof-runner/0.1`).

- [ ] **Step 2: Reword prose** — docstrings/comments saying "Devproof Agent SDK"/"the SDK" → "session runner" / "runner loop" in `runner.py`, `devproof_runner/__init__.py`, `devproof_runner/types.py`.

- [ ] **Step 3: Grep gate**

Run: `grep -rn -i "agent.sdk\|agent_sdk" session-runner --include="*.py"`
Expected: no matches.

- [ ] **Step 4: Commit** (Tasks 1+2 together — tree is consistent now)

```bash
git add -A && git commit -m "refactor: fold agent-sdk into session-runner as devproof_runner"
```

### Task 3: Unified test run (host)

**Files:**
- Modify: `session-runner/tests/test_runner.py` (sys.path shim + updated header doc)

**Interfaces:**
- Consumes: `import runner` — runner.py now lives one dir above the test.
- Produces: one command runs all 7 test files: `cd session-runner && python -m unittest discover -s tests -p "test_*.py"`.

- [ ] **Step 1: Shim test_runner.py**

Before `import runner`, add:

```python
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
```

Update the header docstring's in-image command to `-m unittest discover -s tests -p "test_*.py"`.

- [ ] **Step 2: Run the unified suite**

Run: `cd session-runner && python -m unittest discover -s tests -p "test_*.py"`
Expected: all tests PASS (same count as agent-sdk suite + runner suite pre-move).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test: unify runner + loop tests under session-runner/tests"
```

### Task 4: Dockerfile + dev46 image

**Files:**
- Modify: `session-runner/Dockerfile`

**Interfaces:**
- Produces: image `devproof/session-runner:dev46`; `/app/runner.py` + `/app/devproof_runner/` (script-dir sys.path — no install step).

- [ ] **Step 1: Replace the pip-install of the SDK with a COPY**

Old lines 13–16 (`COPY agent-sdk /tmp/agent-sdk` + `pip install`) become, next to the existing `COPY session-runner/runner.py .` at `WORKDIR /app`:

```dockerfile
WORKDIR /app
COPY session-runner/runner.py .
COPY session-runner/devproof_runner ./devproof_runner
```

Update header comments: build stays from repo root; "Agent SDK" wording → "runner loop".

- [ ] **Step 2: Build**

Run: `docker build -f session-runner/Dockerfile -t devproof/session-runner:dev46 .`
Expected: success.

- [ ] **Step 3: In-image test smoke**

Run: `docker run --rm --entrypoint python -v ./session-runner:/src -w /src devproof/session-runner:dev46 -m unittest discover -s tests -p "test_*.py"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add session-runner/Dockerfile && git commit -m "build(runner): dev46 — COPY devproof_runner, drop pip packaging"
```

### Task 5: Docs + meta

**Files:**
- Modify: `CLAUDE.md` (merge agent-sdk bullet into session-runner bullet; test command; dev46 note)
- Modify: `docs/concept/decisions-log.md` (append dated entry)
- Modify: `deploy/README.md:42` (replace the stale runtime wording with "Devproof session runner")

- [ ] **Step 1: Edit the three docs** per spec §Docs/meta. CLAUDE.md keeps every behavioral note from the agent-sdk bullet (compaction, transcripts, Skill tool, MCP client, egress tests) under the session-runner description, with the new test command and `devproof_runner` name.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md docs/concept/decisions-log.md deploy/README.md
git commit -m "docs: agent-sdk terminology retired; loop lives in session-runner"
```

### Task 6: Platform verification

- [ ] **Step 1: CP untouched-check** — `cd control-plane && npm test && npx tsc --noEmit` → green.
- [ ] **Step 2: Live smoke** — restart CP with `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev46`, run one session turn against the cluster, confirm it completes and events stream.
- [ ] **Step 3: Update memory file** `devproof-agent-sdk.md` → merged reality.
