# Session-runner merge — fold agent-sdk/ into session-runner/ (2026-07-17)

## Goal

Retire the "agent SDK" terminology. The in-process agent loop (`agent-sdk/devproof_agent_sdk`)
becomes part of `session-runner/` as a plain Python package named `devproof_runner`. Pure
rename/move — no behavior change.

## Target layout

```
session-runner/
  Dockerfile
  runner.py
  devproof_runner/          # was agent-sdk/devproof_agent_sdk/ (git mv)
    __init__.py client.py compact.py errors.py mcp.py
    query.py session.py skills.py types.py tools/
  tests/                    # was agent-sdk/tests/, plus test_runner.py moves in
    helpers.py mock_gateway.py test_egress.py test_mcp.py
    test_query_loop.py test_skills_compact.py test_tools.py
    test_runner.py
```

`agent-sdk/` (incl. `pyproject.toml`) is deleted; the package is no longer pip-installable —
the Dockerfile COPYs `devproof_runner/` next to `runner.py` in `/app` (script dir is on
sys.path, imports resolve without install).

## Changes

- Imports `devproof_agent_sdk` → `devproof_runner`: 4 sites in runner.py, the test files,
  internal cross-imports (mcp.py, query.py, tools/webfetch.py).
- Docstrings/comments saying "Devproof Agent SDK" reworded to "session runner" / "runner loop".
- **Unchanged:** public API (`AgentOptions`, `query`, error types), all `DEVPROOF_*` env names,
  `~/.devproof/sessions` transcript paths, tool schemas, platform prompt.
- Dockerfile: drop `COPY agent-sdk` + `pip install`; add `COPY session-runner/devproof_runner
  /app/devproof_runner`. Build stays from repo root. New image tag **dev46**.
- Unified test command: `cd session-runner && python -m unittest discover -s tests -p "test_*.py"`
  (test_runner.py gets a sys.path shim so it finds runner.py in the parent dir; stays runnable
  in the image via bind mount).

## Docs/meta

- CLAUDE.md: merge the `agent-sdk/` bullet into the session-runner description; the
  zero-third-party-AI-references rule now scopes to `session-runner/` only.
- `docs/concept/decisions-log.md`: dated entry for the merge/rename.
- `deploy/README.md:42`: stale runtime wording → session runner.
- Historical specs/plans and the concept doc have since been scrubbed of third-party AI
  references (2026-07-18); `failure-text.ts`'s old-SDK comment stays.

## Verification

Host tests green, dev46 image builds, control-plane `npm test` + `tsc --noEmit` unaffected,
one live session smoke test with `DEVPROOF_RUNNER_IMAGE=devproof/session-runner:dev46`.
