"""Devproof session runner: executes one agent turn — its in-process agent loop
(devproof_runner) — against the Devproof gateway and streams typed events to the
control plane.

Env contract (see docs/superpowers/plans/2026-07-07-agents-core.md):
  DEVPROOF_SESSION_ID, DEVPROOF_PROMPT, DEVPROOF_AGENT_CONFIG (JSON),
  DEVPROOF_EVENTS_URL (base: POST {url}/events, POST {url}/status),
  DEVPROOF_BASE_URL (gateway), DEVPROOF_AUTH_TOKEN,
  DEVPROOF_CUSTOM_HEADERS (attribution), DEVPROOF_CONTEXT_WINDOW (auto-compact),
  DEVPROOF_PRIOR_OUTPUTS (JSON; prior-turn outputs staged read-only).
"""
import json
import os
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import anyio

SESSION_ID = os.environ["DEVPROOF_SESSION_ID"]
PROMPT = os.environ["DEVPROOF_PROMPT"]
CONFIG = json.loads(os.environ["DEVPROOF_AGENT_CONFIG"])
EVENTS_URL = os.environ["DEVPROOF_EVENTS_URL"]
FILES_URL = os.environ.get("DEVPROOF_FILES_URL", "")
ATTACHMENTS = json.loads(os.environ.get("DEVPROOF_ATTACHMENTS", "[]"))
PRIOR_OUTPUTS = json.loads(os.environ.get("DEVPROOF_PRIOR_OUTPUTS", "[]"))
RESUME_ID = os.environ.get("DEVPROOF_RESUME", "")
CHECKPOINT_ID = os.environ.get("DEVPROOF_CHECKPOINT", "")
TURN = os.environ.get("DEVPROOF_TURN")  # None under a pre-guard control plane
UPLOADS_DIR = "/mnt/session/uploads"
OUTPUTS_DIR = "/mnt/session/outputs"
PRIOR_OUTPUTS_DIR = "/mnt/session/prior-outputs"
# "0" ⇒ /work lives on a durable session PVC — keep it out of the checkpoint tarball.
CHECKPOINT_WORK = os.environ.get("DEVPROOF_CHECKPOINT_WORK", "1") != "0"
# The session home holds the transcripts — capturing it is what makes
# resume survive pod death. Same resolution as the loop's sessions_dir(), so a
# relocated home can never silently fall outside the checkpoint.
SDK_HOME = os.environ.get("DEVPROOF_SDK_HOME") or os.path.expanduser("~/.devproof")
CHECKPOINT_PATHS = [SDK_HOME] + (["/work"] if CHECKPOINT_WORK else [])
START = time.monotonic()


def _download(file_id: str, dest: str) -> None:
    with urllib.request.urlopen(f"{FILES_URL}/{file_id}/content", timeout=300) as res:
        with open(dest, "wb") as out:
            out.write(res.read())


def restore_checkpoint() -> None:
    """Restore loop session state + workspace from the previous turn.

    The Job env snapshots the checkpoint id at creation; an interrupted
    turn's pod can replace (and delete) that checkpoint before this pod
    starts. On a 404, re-fetch the session's CURRENT id and retry once —
    the newer checkpoint is the salvaged state, strictly better to resume
    from. Any other failure (or a second 404) propagates: main's crash
    handler turns it into session.failed, same as before."""
    import tarfile
    import urllib.error
    if not CHECKPOINT_ID:
        return
    dest = "/tmp/checkpoint.tar.gz"
    try:
        _download(CHECKPOINT_ID, dest)
    except urllib.error.HTTPError as err:
        if err.code != 404:
            raise
        with urllib.request.urlopen(f"{EVENTS_URL}/resume", timeout=30) as res:
            current = json.loads(res.read()).get("checkpointFileId") or ""
        if not current or current == CHECKPOINT_ID:
            raise
        emit("session.checkpoint_replaced", {"stale": CHECKPOINT_ID, "current": current})
        _download(current, dest)
    with tarfile.open(dest) as tar:
        tar.extractall("/", filter="data")


def save_checkpoint() -> str | None:
    """Upload loop session state + workspace; returns the file id."""
    import tarfile
    path = "/tmp/checkpoint-out.tar.gz"
    with tarfile.open(path, "w:gz") as tar:
        for p in CHECKPOINT_PATHS:
            if os.path.exists(p):
                tar.add(p, arcname=p.lstrip("/"))
    with open(path, "rb") as f:
        data = f.read()
    req = urllib.request.Request(
        f"{FILES_URL}/raw?name=checkpoint-{SESSION_ID}.tar.gz&session={SESSION_ID}&kind=checkpoint",
        data=data, headers={"Content-Type": "application/octet-stream"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as res:
        return json.loads(res.read())["id"]


SKILLS = json.loads(os.environ.get("DEVPROOF_SKILLS", "[]"))
SKILLS_DIR = "/work/.devproof/skills"
MEMORY = json.loads(os.environ.get("DEVPROOF_MEMORY", "[]"))
# Set (to the store id) only when the session HAS a memory store. /mnt/memory is
# always writable (pre-created in the image), so without this gate a model note
# written there makes sync_memory_back hit the CP's 400 "session has no memory
# store" (live bug sesn_2i8o557ubzft).
MEMORY_STORE = os.environ.get("DEVPROOF_MEMORY_STORE", "")
MEMORY_DIR = "/mnt/memory"
# LLM wikis (spec 2026-07-18): each mounts read-only at /mnt/wiki/<name>; at most
# one is mode "write" (this agent is its sole maintainer) and syncs back on exit.
WIKIS = json.loads(os.environ.get("DEVPROOF_WIKIS", "[]"))
WIKI_DIR = "/mnt/wiki"
WRITE_WIKI = next((w for w in WIKIS if w.get("mode") == "write"), None)

SUBAGENTS = CONFIG.get("subagents") or []
SUBAGENTS_DIR = "/mnt/session/subagents"
DELEGATE_POLL_SEC = 3
# Backoff base for delegate poll/download retries (module-level so tests can
# zero it out — mirrors DELEGATE_POLL_SEC's testability pattern).
DELEGATE_RETRY_BASE = 2
DELEGATE_MAX_POLL_FAILURES = 5
DELEGATE_MAX_DOWNLOAD_ATTEMPTS = 3

MAX_TURNS = int(CONFIG.get("max_turns") or 500)

# Versioned platform contract (spec 2026-07-09, rev 2026-07-11). Always prepended
# to the agent's own system prompt — the model cannot use the sandbox without it.
# The identity line matters: without an explicit anchor, models adopt stray
# harness wording as their identity. Do NOT name any third-party assistant here,
# even to disclaim it — small models ignore negation and parrot the name
# (verified live with qwen0.5b: a disclaimer alone made it claim that identity).
# rev 2026-07-12b: /work persists across turns either way — via the checkpoint
# tarball (emptyDir) or a durable session PVC (CHECKPOINT_WORK off).


def package_line(allow_package_managers: bool) -> str:
    """Pure (like delegation_prompt_block) so tests cover both environments.
    Only claims pip is disabled when the environment actually disables it —
    with package managers enabled, egress to PyPI/npm is open and installs work."""
    base = ("Preinstalled Python packages: numpy, pandas, matplotlib, seaborn,"
            " scipy, openpyxl, pyarrow — import them directly.")
    if allow_package_managers:
        return base + " If you need another package, install it with pip."
    return base + (" Installing additional packages is disabled in this"
                   " environment (no package-manager egress) — work with the"
                   " preinstalled ones.")


ALLOW_PACKAGE_MANAGERS = bool(CONFIG.get("allow_package_managers"))

PLATFORM_PROMPT_20260712 = f"""You are an AI agent powered by the model "{CONFIG.get('model', 'unknown')}", running inside a Devproof managed session (a sandboxed container).

Filesystem contract:
- Input files attached to this session are mounted at {UPLOADS_DIR} (also listed in the first user message when present).
- Write final deliverables to {OUTPUTS_DIR} — ONLY files in that directory are published to the user as downloadable output files when the turn ends. If the user asks you to generate, save, or produce a file, create it there (never in /tmp). Publication is automatic — never Read image or binary files back to verify them; check with `ls -la` or file sizes instead.
- Published output images can be SHOWN to the user by referencing their filename in markdown in your message (e.g. ![chart](my_chart.png)) — the console renders them inline; no tool call needed.
- Files you published in earlier turns are available read-only at {PRIOR_OUTPUTS_DIR} (do not regenerate them; republish by copying into {OUTPUTS_DIR} only if changed).
- /work is your scratch workspace for ephemeral experiments; it persists across turns of THIS session, but not beyond it.
- If {MEMORY_DIR} exists, it is a shared memory store: read it before starting work, and write durable learnings back — changes sync automatically when the turn ends.

{package_line(ALLOW_PACKAGE_MANAGERS)}

Turn budget: you have {MAX_TURNS} turns in this session. Budget your work so the FINAL turn contains your answer or deliverable as a plain message, not a tool call."""


def delegation_prompt_block(subagents: list) -> str:
    """Generated per launch from structured config (never stored), so
    renaming/removing a subagent never leaves stale prompt text."""
    if not subagents:
        return ""
    lines = "\n".join(f'- "{s["name"]}": {s["instructions"]}' for s in subagents)
    return (
        f"\n\nDelegation: you can push work to the following agents with the"
        f" Delegate tool (arguments: agent name, a self-contained prompt, and"
        f" optionally files — absolute paths of files in this pod to hand"
        f" over). Each Delegate call starts a separate, isolated agent session"
        f" that only sees the files you pass it — prefer one call per task"
        f" with all related files attached, not one call per file. The call"
        f" blocks until that agent finishes and returns its answer; files it"
        f" produces are placed under {SUBAGENTS_DIR}/<agent>/."
        f" If a result is incomplete, continue the SAME agent (context"
        f" preserved) by calling Delegate again with the returned session id"
        f" in the session parameter. `complete=true` only LOCKS a child you"
        f" ALREADY started and REQUIRES that child's session id — never set it"
        f" on your first call; to start a task, call with just agent + prompt."
        f" (A busy single-session agent simply makes the call take longer while"
        f" its earlier sessions finish — that is normal, keep waiting.)\n{lines}"
    )


# Fixed structure spec for ALL wikis (OKF / karpathy "LLM wiki" conventions).
# Hardcoded platform convention — NOT user-configurable — always shown to every
# agent that reads or writes a wiki, so both navigate and maintain it the same way.
WIKI_STRUCTURE = (
    "Every wiki is a tree of markdown files with a fixed structure:\n"
    "- index.md is the catalog: a categorized list of every page with a one-line"
    " summary and a link. ALWAYS read it first to locate the right page, then drill in.\n"
    "- One page per entity/concept, each starting with YAML frontmatter"
    " (type, title, description, tags) above its markdown body.\n"
    "- log.md is an append-only, newest-first, ISO-8601-dated history of changes.\n"
    "- Pages cross-link with relative markdown links; tolerate broken links."
)


def wiki_prompt_block(wikis: list) -> str:
    """The hardcoded wiki structure spec plus role instructions. Readers navigate
    and report errors via Delegate; the single writer maintains the wiki. Generated
    per launch from the mount list (never stored)."""
    if not wikis:
        return ""
    read = [w for w in wikis if w.get("mode") != "write"]
    write = next((w for w in wikis if w.get("mode") == "write"), None)
    parts = ["\n\n" + WIKI_STRUCTURE]
    if read:
        names = ", ".join(f'"{w["name"]}" ({WIKI_DIR}/{w["name"]})' for w in read)
        parts.append(
            f"\n\nKnowledge wikis (READ-ONLY) are mounted at {WIKI_DIR}: {names}."
            f" Navigate via each wiki's index.md. Do NOT edit read-only wikis; if"
            f" you find an error or gap, report it to the wiki's maintainer agent"
            f" via the Delegate tool. Wiki mounts are a snapshot taken at turn"
            f" start: pages a delegated maintainer updates during this turn appear"
            f" in your mount on your next turn, so do not re-read the mount to"
            f" verify a delegation — trust the maintainer's report. Do not attach"
            f" {WIKI_DIR} files to Delegate calls: an agent with the wiki attached"
            f" already sees the wiki itself."
        )
    if write:
        parts.append(
            f"\n\nYou are the SOLE maintainer (writer) of the wiki \"{write['name']}\""
            f" mounted read-write at {WIKI_DIR}/{write['name']}. Maintain it exactly"
            f" per the structure above — keep index.md and log.md current with every"
            f" change; your edits are saved automatically when the turn ends. Your"
            f" wiki edits ARE the deliverable: never copy wiki pages into the outputs"
            f" directory or return them as files — just report what you changed."
        )
    return "".join(parts)


def system_prompt() -> str:
    agent = (CONFIG.get("system_prompt") or "").strip()
    return (PLATFORM_PROMPT_20260712 + ("\n\n" + agent if agent else "")
            + delegation_prompt_block(SUBAGENTS) + wiki_prompt_block(WIKIS))


import hashlib

# Baseline content hashes captured at stage time, so write-back is a diff.
_MEMORY_BASELINE: dict[str, str] = {}
# Same, keyed by path within the WRITE wiki's dir (read wikis never sync back).
_WIKI_BASELINE: dict[str, str] = {}


def _contained_dest(base_dir: str, rel_path: str) -> str | None:
    """Resolve a CP-supplied wiki/memory/skill entry path to a location strictly
    under base_dir. These paths are user-populated (e.g. via the python client's
    pages.add(path=...)) and thus untrusted: os.path.join drops the prefix on an
    absolute component and `..` segments walk out. Returns None ("skip") on any
    escape — mirrors _safe_subagent_dest for delegated outputs."""
    root = os.path.normpath(base_dir)
    dest = os.path.normpath(os.path.join(root, rel_path.replace("\\", "/").lstrip("/")))
    if os.path.commonpath([root, dest]) != root:
        return None
    return dest


def stage_memory() -> None:
    for entry in MEMORY:
        dest = _contained_dest(MEMORY_DIR, entry["path"])
        if dest is None:
            print(f"stage_memory: skipping unsafe path {entry['path']!r}", flush=True)
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with urllib.request.urlopen(f"{FILES_URL}/{entry['fileId']}/content", timeout=120) as res:
            data = res.read()
        with open(dest, "wb") as out:
            out.write(data)
        _MEMORY_BASELINE[entry["path"].lstrip("/")] = hashlib.sha256(data).hexdigest()


def sync_memory_back() -> None:
    """Diff-based write-back (scales to many concurrent sessions per store):
    upload only files whose content changed; report deleted paths explicitly.
    Only the paths THIS session touched are sent — no blind whole-tree overwrite."""
    if not MEMORY_STORE:
        return  # no store attached — nothing to sync, even if the model wrote to /mnt/memory
    entries = []
    seen = set()
    for root, _dirs, names in os.walk(MEMORY_DIR):
        for n in names:
            full = os.path.join(root, n)
            rel = os.path.relpath(full, MEMORY_DIR).replace("\\", "/")
            seen.add(rel)
            with open(full, "rb") as f:
                data = f.read()
            digest = hashlib.sha256(data).hexdigest()
            if _MEMORY_BASELINE.get(rel) == digest:
                continue  # unchanged — skip upload
            req = urllib.request.Request(
                f"{FILES_URL}/raw?name={rel}&session={SESSION_ID}&kind=memory",
                data=data, headers={"Content-Type": "application/octet-stream"}, method="POST",
            )
            with urllib.request.urlopen(req, timeout=120) as res:
                entries.append({"path": rel, "fileId": json.loads(res.read())["id"]})
    deletes = [p for p in _MEMORY_BASELINE if p not in seen]
    if entries or deletes:
        post("/memory", {"entries": entries, "deletes": deletes})


def stage_wikis() -> list[str]:
    """Mount each wiki at /mnt/wiki/<name>/. Read wikis are staged for reading;
    the single write wiki also seeds the diff baseline for write-back."""
    names = []
    for w in WIKIS:
        base = os.path.join(WIKI_DIR, w["name"])
        os.makedirs(base, exist_ok=True)
        for entry in w.get("entries", []):
            dest = _contained_dest(base, entry["path"])
            if dest is None:
                print(f"stage_wikis: skipping unsafe path {w['name']}/{entry['path']!r}", flush=True)
                continue
            os.makedirs(os.path.dirname(dest) or base, exist_ok=True)
            try:
                with urllib.request.urlopen(f"{FILES_URL}/{entry['fileId']}/content", timeout=120) as res:
                    data = res.read()
            except urllib.error.HTTPError as err:
                # A concurrent writer may have replaced/removed this page (its old
                # file was deleted) between mount-resolution and staging. Skip the
                # vanished page instead of failing the whole session (404).
                if err.code == 404:
                    print(f"stage_wikis: skipping missing {w['name']}/{entry['path']} (404)", flush=True)
                    continue
                raise
            with open(dest, "wb") as out:
                out.write(data)
            if w.get("mode") == "write":
                _WIKI_BASELINE[entry["path"].lstrip("/")] = hashlib.sha256(data).hexdigest()
        if w.get("mode") != "write":
            # Enforce READ-ONLY on the filesystem: read wikis never sync back,
            # so a silently accepted write would vanish at turn end while the
            # model believes it updated the wiki — make it a PermissionError
            # instead (the prompt's report-via-Delegate path is the recovery).
            # Not tamper-proof (the agent user could chmod +w), but it stops
            # the realistic accidental Write/Edit.
            for root, _dirs, fnames in os.walk(base, topdown=False):
                for n in fnames:
                    os.chmod(os.path.join(root, n), 0o444)
                os.chmod(root, 0o555)
        names.append(w["name"])
    return names


def sync_wiki_back() -> None:
    """Write-back for the WRITE wiki only (diff-based, like sync_memory_back).
    Read wikis are never uploaded — the writer agent is the sole mutator."""
    if not WRITE_WIKI:
        return
    base = os.path.join(WIKI_DIR, WRITE_WIKI["name"])
    if not os.path.isdir(base):
        return
    entries = []
    seen = set()
    for root, _dirs, names in os.walk(base):
        for n in names:
            full = os.path.join(root, n)
            rel = os.path.relpath(full, base).replace("\\", "/")
            seen.add(rel)
            with open(full, "rb") as f:
                data = f.read()
            digest = hashlib.sha256(data).hexdigest()
            if _WIKI_BASELINE.get(rel) == digest:
                continue  # unchanged — skip upload
            req = urllib.request.Request(
                f"{FILES_URL}/raw?name={rel}&session={SESSION_ID}&kind=wiki",
                data=data, headers={"Content-Type": "application/octet-stream"}, method="POST",
            )
            with urllib.request.urlopen(req, timeout=120) as res:
                entries.append({"path": rel, "fileId": json.loads(res.read())["id"]})
    deletes = [p for p in _WIKI_BASELINE if p not in seen]
    if entries or deletes:
        post("/wiki", {"wikiId": WRITE_WIKI["id"], "entries": entries, "deletes": deletes})


def stage_skills() -> list[str]:
    """Place agent skills where the loop's skills_dir option points.
    Each skill is a package (SKILL.md + optional scripts/resources)."""
    names = []
    for skill in SKILLS:
        dest_dir = os.path.join(SKILLS_DIR, skill["name"])
        os.makedirs(dest_dir, exist_ok=True)
        # Multi-file skills (ZIP): write every file in the manifest.
        for entry in skill.get("files", []):
            dest = _contained_dest(dest_dir, entry["path"])
            if dest is None:
                print(f"stage_skills: skipping unsafe path {skill['name']}/{entry['path']!r}", flush=True)
                continue
            os.makedirs(os.path.dirname(dest) or dest_dir, exist_ok=True)
            with urllib.request.urlopen(f"{FILES_URL}/{entry['fileId']}/content", timeout=120) as res:
                with open(dest, "wb") as out:
                    out.write(res.read())
        names.append(skill["name"])
    return names


def collect_outputs() -> None:
    """Upload anything the agent wrote to /mnt/session/outputs as output files."""
    if not os.path.isdir(OUTPUTS_DIR):
        return
    file_ids = []
    for root, _dirs, names in os.walk(OUTPUTS_DIR):
        for n in names:
            full = os.path.join(root, n)
            rel = os.path.relpath(full, OUTPUTS_DIR).replace("\\", "/")
            with open(full, "rb") as f:
                data = f.read()
            req = urllib.request.Request(
                f"{FILES_URL}/raw?name={rel}&session={SESSION_ID}&kind=output",
                data=data, headers={"Content-Type": "application/octet-stream"}, method="POST",
            )
            with urllib.request.urlopen(req, timeout=120) as res:
                file_ids.append(json.loads(res.read())["id"])
    if file_ids:
        post("/outputs", {"fileIds": file_ids})


def _stage_files_deduped(files: list[dict], dest_dir: str) -> list[str]:
    """Download files (each {"id", "name"}) into dest_dir, deduping on a
    basename collision by inserting a numeric suffix before the extension
    (name-2.ext, name-3.ext, ...). Names are caller-controlled (e.g. a parent
    delegating several files that happen to share a basename from different
    directories) and can collide — staging by plain basename would make every
    write clobber the last, so only one of the colliding files would ever
    land on disk. Shared by stage_attachments and stage_prior_outputs."""
    paths = []
    if files:
        os.makedirs(dest_dir, exist_ok=True)
    used: dict[str, int] = {}
    for f in files:
        base = os.path.basename(f["name"])
        count = used[base] = used.get(base, 0) + 1
        if count == 1:
            name = base
        else:
            stem, ext = os.path.splitext(base)
            name = f"{stem}-{count}{ext}"
        dest = os.path.join(dest_dir, name)
        _download(f["id"], dest)
        paths.append(dest)
    return paths


def stage_attachments() -> list[str]:
    """Download session input files to the conventional uploads path."""
    return _stage_files_deduped(ATTACHMENTS, UPLOADS_DIR)


def stage_prior_outputs() -> list[str]:
    """Download files the model published in EARLIER turns to a read-only
    staging dir (live gap sesn_vbgmchnl4m03: a follow-up turn's pod otherwise
    starts with an empty outputs dir, so the model can't see — and
    regenerates — work it already delivered). Deliberately NOT staged into
    OUTPUTS_DIR: collect_outputs() walks that dir and would re-publish these
    as duplicate output files every subsequent turn."""
    return _stage_files_deduped(PRIOR_OUTPUTS, PRIOR_OUTPUTS_DIR)


def run_salvage() -> str | None:
    """End-of-turn salvage with each step isolated: one failing sync must not
    starve the others (live bug sesn_2i8o557ubzft — a memory-sync 400 aborted
    the shared try block, losing the wiki write-back AND the checkpoint).
    Returns the checkpoint file id, or None if that step failed."""
    def step(name, fn):
        try:
            return fn()
        except Exception as err:  # noqa: BLE001 — salvage must never fail the turn
            emit(f"session.{name}_failed", {"error": str(err)[:500]})
            return None
    step("output_sync", collect_outputs)
    step("memory_sync", sync_memory_back)
    step("wiki_sync", sync_wiki_back)
    return step("checkpoint", save_checkpoint)


_NUL = chr(0)


def _strip_nul(value):
    """Remove U+0000 from every string in a JSON-able value. Postgres jsonb
    rejects NUL (error 22P05), so an event payload carrying one — e.g. a Bash
    tool result read from a NUL-terminated file like /proc/self/attr/current —
    would 500 the CP event insert, and the identical retried payload fails the
    whole session (live bug sesn_5r6qnuuxtwho, 2026-07-22)."""
    if isinstance(value, str):
        return value.replace(_NUL, "") if _NUL in value else value
    if isinstance(value, list):
        return [_strip_nul(v) for v in value]
    if isinstance(value, dict):
        return {_strip_nul(k): _strip_nul(v) for k, v in value.items()}
    return value


def post(path: str, body: dict, attempts: int = 4, _sleep=time.sleep) -> None:
    """POST to the control plane with retries. A transient network blip (or a
    CP restart) on a single event post must not crash an otherwise-healthy
    turn — live failure 2026-07-17 (sesn_4o4wnvaa9t4l): one mid-turn events
    POST raised URLError errno 101 and took the whole session down."""
    req = urllib.request.Request(
        EVENTS_URL + path,
        data=json.dumps(_strip_nul(body)).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    for attempt in range(attempts):
        try:
            urllib.request.urlopen(req, timeout=30).read()
            return
        except Exception:  # noqa: BLE001 — urllib raises a zoo of error types
            if attempt == attempts - 1:
                raise
            # Jitter: a fleet of pods must not retry a CP blip in lockstep.
            _sleep(2 ** attempt + random.random())


def post_status(body: dict) -> None:
    """Status posts carry this pod's turn so the CP can drop stale reports
    from a pod that outlived an interrupt (guard is CP-side; absent TURN —
    older control plane — omits the field and the post applies as before)."""
    if TURN is not None:
        body["turn"] = int(TURN)
    post("/status", body)


def _post_json(url: str, body: dict) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


def _get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=30) as res:
        return json.loads(res.read())


def _upload_file(path: str, name: str | None = None) -> str:
    """Attach a pod-local file to the delegate call: upload as a regular file
    record (mid-turn artifacts aren't registered anywhere yet). `name`
    overrides the uploaded filename — run_delegate uses it to disambiguate
    colliding basenames from different parent dirs (defaults to the plain
    basename)."""
    with open(path, "rb") as f:
        data = f.read()
    name = name or os.path.basename(path)
    req = urllib.request.Request(
        f"{FILES_URL}/raw?name={urllib.parse.quote(name)}&session={SESSION_ID}&kind=upload",
        data=data, headers={"Content-Type": "application/octet-stream"}, method="POST")
    with urllib.request.urlopen(req, timeout=300) as res:
        return json.loads(res.read())["id"]


def _safe_subagent_dest(name: str, filename: str) -> str | None:
    """Resolve a delegated child's output filename to a path strictly under
    SUBAGENTS_DIR/<name>. `filename` is CHILD-controlled — a prompt-injected
    child can register outputs with hostile names via the unauthenticated
    files/raw callback — and os.path.join silently discards the SUBAGENTS_DIR
    prefix on an absolute component while `..` segments can walk out of the
    staging dir. So the candidate path is normalized and verified to stay
    inside SUBAGENTS_DIR before use; `name` (the agent) is sanitized the same
    way even though it comes from CP config, not the child — belt and braces.
    Returns None ("skip this output") instead of raising."""
    root = os.path.normpath(SUBAGENTS_DIR)
    raw = os.path.join(root, name.replace("\\", "/"), filename.replace("\\", "/"))
    dest = os.path.normpath(raw)
    if os.path.commonpath([root, dest]) != root:
        return None
    return dest.replace("\\", "/")


def _resolve_delegate_file(path: str) -> str:
    """Resolve a Delegate `files` path. The model's transcript memory says an
    earlier-turn deliverable lives in OUTPUTS_DIR, but a follow-up turn's pod
    stages those read-only in PRIOR_OUTPUTS_DIR — fall back there so a parent
    can hand any published output file to a subagent (live bug
    sesn_4buy9z7zlyhi). A file re-created this turn wins over the prior copy."""
    if os.path.exists(path) or not path.startswith(OUTPUTS_DIR + "/"):
        return path
    prior = os.path.join(PRIOR_OUTPUTS_DIR, os.path.basename(path))
    return prior if os.path.exists(prior) else path


async def run_delegate(tool_input: dict, cwd: str) -> tuple[str, bool]:
    """Delegate-tool executor: run a configured subagent as a full platform
    session and block until it finishes. Blocking HTTP runs in worker threads
    and polls sleep on the asyncio loop — the agent loop shares it with its
    httpx/MCP clients. The result's FIRST line is a one-line JSON header
    {"session", "files"} — the loop caps tool results at window-chars in
    history and the console parses the header, so it must lead.

    `session` (amendment 2026-07-17b) continues a previously returned child of
    THIS delegation instead of starting a new one — same poll/staging path
    below, since the CP's continuation response carries the same child id.
    `complete` locks that child; it has its own short-circuit return (no
    poll/staging — the child isn't necessarily terminal yet from the runner's
    point of view, and the lock is what makes it terminal)."""
    name = tool_input.get("agent") or ""
    match = next((s for s in SUBAGENTS if s["name"] == name), None)
    if match is None:
        return f"unknown subagent: {name}", True
    session_id = tool_input.get("session")
    if tool_input.get("complete"):
        if not session_id:
            return ("complete=true only locks a child you already started and needs its "
                    "session id — omit complete and call with just agent + prompt to start the task.", True)
        body = {}
        if TURN is not None:
            body["turn"] = int(TURN)
        try:
            await anyio.to_thread.run_sync(_post_json, f"{EVENTS_URL}/delegate/{session_id}/complete", body)
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")[:500]
            return f"delegate complete failed: {err.code} {detail}", True
        except Exception as err:  # noqa: BLE001 — a tool error must never kill the turn
            return f"delegate complete failed: {type(err).__name__}: {err}", True
        return f"marked complete: {session_id}", False
    if not tool_input.get("prompt"):
        return "prompt required unless complete=true", True
    try:
        file_ids = []
        call_paths = tool_input.get("files") or []
        # Disambiguate colliding basenames within THIS call (e.g. two files
        # both named data.txt from different parent dirs) so the child sees
        # meaningful distinct names instead of stage_attachments' -2 suffix.
        # Identical full paths uploaded twice are harmless — no special case.
        base_counts: dict[str, int] = {}
        for p in call_paths:
            base = os.path.basename(p)
            base_counts[base] = base_counts.get(base, 0) + 1
        for p in call_paths:
            base = os.path.basename(p)
            upload_name = f"{os.path.basename(os.path.dirname(p))}__{base}" if base_counts[base] > 1 else base
            file_ids.append(await anyio.to_thread.run_sync(_upload_file, _resolve_delegate_file(p), upload_name))
        body = {"agent_id": match["agentId"], "prompt": tool_input.get("prompt") or "",
                "files": file_ids}
        if session_id:
            body["session"] = session_id
        if TURN is not None:
            body["turn"] = int(TURN)
        # Not retried: this create is NOT idempotent — retrying after an
        # ambiguous failure could spawn a duplicate child session. A failure
        # here surfaces as a tool error the model can deliberately retry.
        created = await anyio.to_thread.run_sync(_post_json, f"{EVENTS_URL}/delegate", body)
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:500]
        return f"delegate failed: {err.code} {detail}", True
    except FileNotFoundError as err:
        # Only the `files` uploads touch the filesystem here. Point the model
        # at the prior-outputs staging dir instead of a bare errno.
        return (f"delegate failed: file not found: {err.filename or err} — files you published "
                f"in earlier turns are staged read-only under {PRIOR_OUTPUTS_DIR}", True)
    except Exception as err:  # noqa: BLE001 — a tool error must never kill the turn
        return f"delegate failed: {type(err).__name__}: {err}", True

    # From here on `child` is known — every failure return below must still
    # lead with the JSON header (or at least the child id), so the parent
    # model (and the console) can still find the child session.
    child = created["session"]
    try:
        poll_failures = 0
        while True:
            try:
                status = await anyio.to_thread.run_sync(_get_json, f"{EVENTS_URL}/delegate/{child}")
            except Exception:
                # The child runs for minutes to hours; a lone transient blip
                # must not abort a healthy delegation (post() hardened the
                # same way — live incident sesn_4o4wnvaa9t4l).
                poll_failures += 1
                if poll_failures >= DELEGATE_MAX_POLL_FAILURES:
                    raise
                await anyio.sleep(DELEGATE_RETRY_BASE ** poll_failures + random.random())
                continue
            poll_failures = 0
            if status.get("status") in ("idle", "completed", "failed"):
                break
            await anyio.sleep(DELEGATE_POLL_SEC)
        paths = []
        skipped = []
        for f in status.get("outputs") or []:
            dest = _safe_subagent_dest(name, f["name"])
            if dest is None:
                skipped.append(f["name"])
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            download_failures = 0
            while True:
                try:
                    await anyio.to_thread.run_sync(_download, f["id"], dest)
                    break
                except Exception:
                    # Idempotent GET — a blip here must not throw away the
                    # child's already-finished work.
                    download_failures += 1
                    if download_failures >= DELEGATE_MAX_DOWNLOAD_ATTEMPTS:
                        raise
                    await anyio.sleep(DELEGATE_RETRY_BASE ** download_failures + random.random())
            paths.append(dest)
        header = json.dumps({"session": child, "files": paths})
        note = "".join(f"\n\nskipped unsafe output name: {n}" for n in skipped)
        text = status.get("resultText") or ""
        if status.get("interrupted"):
            partial = f" Partial answer: {text}" if text else ""
            return f"{header}\n\nSubagent was interrupted before finishing.{partial}{note}", True
        if status.get("status") == "failed":
            detail = status.get("failureDetail") or text or "subagent session failed"
            return f"{header}\n\nSubagent failed: {detail}{note}", True
        return f"{header}\n\n{text}{note}", False
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")[:500]
        header = json.dumps({"session": child, "files": []})
        return f"{header}\n\ndelegate failed: {err.code} {detail}", True
    except Exception as err:  # noqa: BLE001 — a tool error must never kill the turn
        header = json.dumps({"session": child, "files": []})
        return f"{header}\n\ndelegate failed: {type(err).__name__}: {err}", True


def delegate_tool():
    """The Delegate tool, injected via AgentOptions.extra_tools. Schema is
    GBNF-safe by construction (enum/string/array only — no pattern, no
    maxLength), matching the loop's built-in tool schema rules."""
    from devproof_runner.tools import Tool
    return Tool(
        name="Delegate",
        description="Push a task to another configured agent and wait for its result.",
        input_schema={
            "type": "object",
            "properties": {
                "agent": {"type": "string", "enum": [s["name"] for s in SUBAGENTS],
                          "description": "name of the configured agent to delegate to"},
                "prompt": {"type": "string", "description": "self-contained task description"},
                "files": {"type": "array", "items": {"type": "string"},
                          "description": "absolute paths of files in this pod to attach"},
                "session": {"type": "string",
                            "description": "id of a previously returned child session of this delegation to CONTINUE (its context is preserved)"},
                "complete": {"type": "boolean",
                             "description": "with session: mark that child's work final (locks it; no further continuation)"},
            },
            "required": ["agent"],
        },
        executor=run_delegate,
    )


def emit(type_: str, payload: dict, tokens_in: int = 0, tokens_out: int = 0, duration_ms: int = 0) -> None:
    post("/events", {"events": [{
        "type": type_, "payload": payload,
        "tokensIn": tokens_in, "tokensOut": tokens_out,
        "durationMs": duration_ms or int((time.monotonic() - START) * 1000),
        # Idempotency key (migration 042): post() is at-least-once — a retried
        # batch re-sends the same uid and the CP skips the duplicate.
        "uid": uuid.uuid4().hex,
    }]})


async def run_query(prompt: str, options, state: dict) -> tuple[str | None, str | None, bool]:
    """Stream one query; returns (sdk_session_id, result_subtype, is_error).
    The loop raises after an is_error result — the caller
    inspects the subtype we captured before the raise. `state` is a mutable
    out-parameter so sdk_session_id/subtype survive that raise (the local
    variables die with the stack frame when the loop raises mid-iteration)."""
    from devproof_runner import query
    from devproof_runner.types import AssistantMessage, ResultMessage, SystemMessage, UserMessage

    sdk_session_id: str | None = getattr(options, "resume", None)
    state["sdk_session_id"] = sdk_session_id
    subtype: str | None = None
    is_error = False
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, SystemMessage):
            if message.subtype == "init":
                sdk_session_id = message.data.get("session_id") or sdk_session_id
                state["sdk_session_id"] = sdk_session_id
                payload = {"session_id": sdk_session_id,
                           "tools": message.data.get("tools", [])}
                # resumed=False on a resume means the transcript did NOT
                # restore (e.g. pre-dev29 checkpoint) — surface it in the trace
                # instead of silently answering with amnesia.
                for key in ("resumed", "ignored_tools"):
                    if key in message.data:
                        payload[key] = message.data[key]
                emit("session.init", payload)
            elif message.subtype == "model_wait":
                # Dedicated trace row: time spent waiting for the model to
                # deploy/scale (patient retries). Stamped at the WAIT-END
                # offset — the console derives row durations from deltas
                # between consecutive offsets, so this row absorbs the wait
                # and the following step shows pure generation time.
                # max(1, …): emit() treats duration_ms=0 as "stamp now".
                offset_ms = max(1, int((message.data.get("wait_ended", 0.0) - START) * 1000))
                emit("model.wait",
                     {"seconds": round(message.data.get("waited_ms", 0) / 1000)},
                     duration_ms=offset_ms)
        elif isinstance(message, AssistantMessage):
            for block in message.content:
                kind = type(block).__name__
                if kind == "TextBlock":
                    emit("agent.message", {"text": block.text})
                    # Kept for failure_detail: on an error result the last
                    # assistant message IS the real error (e.g. "API Error:
                    # 400 ...ContextWindowExceededError").
                    state["last_text"] = block.text
                elif kind == "ToolUseBlock":
                    emit("tool.call", {"tool": block.name, "input": block.input, "id": block.id})
                elif kind == "ThinkingBlock":
                    emit("agent.thinking", {"text": getattr(block, "thinking", "")[:2000]})
        elif isinstance(message, UserMessage):
            content = message.content if isinstance(message.content, list) else []
            for block in content:
                if type(block).__name__ == "ToolResultBlock":
                    if isinstance(block.content, list) and any(
                            isinstance(b, dict) and b.get("type") == "image"
                            for b in block.content):
                        # Don't dump base64 into the transcript event.
                        text = "[image returned to the model]"
                    elif isinstance(block.content, str):
                        text = block.content
                    else:
                        text = json.dumps(block.content, default=str)[:4000]
                    emit("tool.result", {"id": block.tool_use_id, "output": text,
                                         "is_error": bool(block.is_error)})
        elif isinstance(message, ResultMessage):
            usage = message.usage or {}
            subtype = message.subtype
            state["subtype"] = subtype
            is_error = bool(message.is_error)
            if is_error and getattr(message, "result", None):
                state["result_text"] = message.result
            emit("session.result", {
                "subtype": message.subtype, "num_turns": message.num_turns,
                "stop_reason": getattr(message, "stop_reason", None),
                "is_error": message.is_error,
            }, tokens_in=usage.get("input_tokens", 0), tokens_out=usage.get("output_tokens", 0),
               duration_ms=message.duration_ms)
    return sdk_session_id, subtype, is_error


def failure_detail(err: BaseException, state: dict) -> str:
    """The session.failed error text for a loop raise. The loop's error-result
    exception says only "... returned an error result: <subtype>" while the
    real reason (e.g. the gateway's ContextWindowExceededError 400) is the
    turn's error result or last assistant message. Prefer those; keep the
    exception text for genuine transport/loop crashes."""
    if "returned an error result" in str(err):
        detail = state.get("result_text") or state.get("last_text")
        if detail:
            return str(detail)[:2000]
    return f"{type(err).__name__}: {err}"


_PLACEHOLDER = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def expand_mcp_headers(servers: dict | None, env=None) -> dict:
    """Expand ${VAR} placeholders in mcp_servers[*].headers values from the
    pod environment (vault envFrom). The CP injects placeholder Authorization
    headers so secret values never ride the Job spec. A header whose variable
    is unset is DROPPED (never send a literal ${...} upstream)."""
    env = os.environ if env is None else env
    out = {}
    for name, cfg in (servers or {}).items():
        if not (isinstance(cfg, dict) and isinstance(cfg.get("headers"), dict)):
            out[name] = cfg
            continue
        headers = {}
        for key, value in cfg["headers"].items():
            if isinstance(value, str):
                refs = _PLACEHOLDER.findall(value)
                # Only vault credential placeholders may be expanded. MCP auth
                # credentials are always DEVPROOF_CRED_* (bearer/oauth); refusing
                # every other name stops a crafted header from exfiltrating the
                # pod's internal gateway token (DEVPROOF_AUTH_TOKEN) or any other
                # platform env to an attacker-allowlisted MCP host.
                disallowed = [v for v in refs if not v.startswith("DEVPROOF_CRED_")]
                missing = [v for v in refs if v.startswith("DEVPROOF_CRED_") and v not in env]
                if disallowed or missing:
                    print(f"runner: dropping MCP header {name}.{key} — "
                          f"disallowed={disallowed} unset={missing}", flush=True)
                    continue
                value = _PLACEHOLDER.sub(lambda m: env[m.group(1)], value)
            headers[key] = value
        out[name] = {**cfg, "headers": headers}
    return out


async def main() -> None:
    # Import here so config/env errors still produce a session.failed event.
    from devproof_runner import AgentOptions, ErrorResultError

    restore_checkpoint()

    def options(max_turns: int, resume: str | None, no_tools: bool = False):
        return AgentOptions(
            model=CONFIG["model"],
            system_prompt=system_prompt(),
            tools=[] if no_tools else (CONFIG.get("tools") or []),
            max_turns=max_turns,
            resume=resume,
            cwd="/work",
            skills_dir=SKILLS_DIR,
            mcp_servers={} if no_tools else expand_mcp_headers(CONFIG.get("mcp_servers") or {}),
            # Wrap-up turns are tool-less end to end — Delegate included.
            extra_tools=[] if (no_tools or not SUBAGENTS) else [delegate_tool()],
        )

    # Pre-create the outputs dir so models exploring the filesystem FIND the
    # publish location instead of inventing paths like /tmp.
    os.makedirs(OUTPUTS_DIR, exist_ok=True)
    staged_skills = stage_skills()
    stage_memory()
    staged_wikis = stage_wikis()
    staged = stage_attachments()
    stage_prior_outputs()
    emit("session.created", {"model": CONFIG["model"], "tools": CONFIG.get("tools", []),
                             "files": staged, "skills": staged_skills, "wikis": staged_wikis})
    prompt = PROMPT
    if staged:
        listing = "\n".join(f"- {p}" for p in staged)
        prompt = f"Attached files ({len(staged)}) available at {UPLOADS_DIR}:\n{listing}\n\n{PROMPT}"

    sdk_session_id = RESUME_ID or None
    exhausted = False
    result_error = True
    crash: str | None = None
    state: dict = {"sdk_session_id": sdk_session_id}
    try:
        sdk_session_id, subtype, is_error = await run_query(prompt, options(MAX_TURNS, sdk_session_id), state)
        exhausted = subtype == "error_max_turns"
        result_error = is_error and not exhausted
    except Exception as err:  # noqa: BLE001 — the loop raises after error results
        sdk_session_id = state.get("sdk_session_id") or sdk_session_id
        # Typed check (the loop is in-process): never classify by matching
        # substrings that could legitimately appear inside a transport error.
        if (isinstance(err, ErrorResultError) and err.subtype == "error_max_turns") \
                or state.get("subtype") == "error_max_turns":
            exhausted = True
        else:
            # Transport/loop crash mid-turn. Don't die with the pod — salvage
            # outputs first.
            crash = failure_detail(err, state)

    if exhausted:
        # Guaranteed final answer (spec item 7): one wrap-up turn, then idle.
        emit("session.budget_exhausted", {"max_turns": MAX_TURNS})
        wrap_state: dict = {"sdk_session_id": sdk_session_id}
        try:
            # max_turns=2, not 1: a model that answers with a tool call anyway
            # needs a second turn to see the rejection and reply in text.
            sdk_session_id, _subtype, wrap_error = await run_query(
                "Your turn budget is exhausted and tools are disabled for this "
                "turn — reply with plain text only. Provide your final answer "
                "now, based on the work you have completed so far.",
                options(2, sdk_session_id, no_tools=True), wrap_state)
            sdk_session_id = wrap_state.get("sdk_session_id") or sdk_session_id
            result_error = bool(wrap_error)
        except Exception as err:  # noqa: BLE001 — a raise after the wrap-up answer is not a failure
            sdk_session_id = wrap_state.get("sdk_session_id") or sdk_session_id
            if isinstance(err, ErrorResultError):
                result_error = False
            else:
                crash = f"{type(err).__name__}: {err}"

    if crash:
        emit("session.failed", {"error": crash[:2000]})

    # Salvage runs on EVERY exit path — a failed turn must not lose the files
    # already written to outputs, memory learnings, or the resume checkpoint.
    checkpoint_id = run_salvage()
    post_status({"status": "failed" if (crash or result_error) else "idle",
                 "sdkSessionId": sdk_session_id, "checkpointFileId": checkpoint_id})


if __name__ == "__main__":
    try:
        anyio.run(main)
    except Exception as err:  # noqa: BLE001 — terminal event must always be sent
        try:
            emit("session.failed", {"error": f"{type(err).__name__}: {err}"[:2000]})
            post_status({"status": "failed"})
        finally:
            raise
