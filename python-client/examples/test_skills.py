"""Skills: build a zip in-memory, upload, verify manifest, delete."""
from __future__ import annotations

import io
import tempfile
import zipfile
from pathlib import Path

from _common import check, client, step


def main() -> None:
    c = client()
    skill_id = None
    try:
        step("build skill zip (SKILL.md + helper) and upload")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("SKILL.md", "# Greeting skill\nAlways greet in pirate speak.\n")
            z.writestr("scripts/greet.sh", "#!/bin/sh\necho 'Ahoy!'\n")
        path = Path(tempfile.mkdtemp(prefix="dp-skill-")) / "pirate-greeting.zip"
        path.write_bytes(buf.getvalue())
        skill = c.skills.upload(path)
        skill_id = skill["id"]
        check(skill["name"] == "pirate-greeting", "skill named from filename")

        step("retrieve manifest")
        got = c.skills.retrieve(skill_id)
        paths = {f["path"] for f in got.get("files", [])}
        check("SKILL.md" in paths, "manifest contains SKILL.md")
        # A zip whose entries all share one top-level folder gets that wrapper
        # stripped; this zip has SKILL.md at the root, so paths are kept as-is.
        check("scripts/greet.sh" in paths, "manifest keeps the helper script path")

        step("listed, then delete")
        check(any(s["id"] == skill_id for s in c.skills.list()), "skill listed")
        c.skills.delete(skill_id)
        skill_id = None
        print("PASS test_skills")
    finally:
        if skill_id:
            try: c.skills.delete(skill_id)
            except Exception: pass


if __name__ == "__main__":
    main()
