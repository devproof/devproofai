"""LLM wikis: create, pages, tree + content round trip, update, delete.

Wikis are hierarchical knowledge bases agents mount on the filesystem
(index.md catalog, one page per entity, log.md history). Attaching wikis to
agents (read/write refs, writer exclusivity) is covered in test_agents.py.
"""
from __future__ import annotations

from _common import check, client, step

INDEX = b"""---
title: Example wiki
---
# Index

- teams/platform.md - the platform team
"""


def main() -> None:
    c = client()
    wiki_id = None
    try:
        step("create wiki + pages (index.md catalog, one page per entity)")
        wiki = c.wikis.create(name="api-example-wiki", description="Example knowledge base")
        wiki_id = wiki["id"]
        c.wikis.pages.add(wiki_id, "index.md", INDEX)
        c.wikis.pages.add(wiki_id, "teams/platform.md", b"# Platform team\nOwns the gateway.\n")
        c.wikis.pages.add(wiki_id, "log.md", b"# Log\n- created example wiki\n")

        step("tree + content round trip")
        paths = {e["path"] for e in c.wikis.tree(wiki_id)}
        check(paths == {"index.md", "teams/platform.md", "log.md"}, f"tree lists all pages ({paths})")
        body = c.wikis.content(wiki_id, "teams/platform.md")
        check(b"Owns the gateway." in body, "page content round-trips")

        step("retrieve + update metadata + list")
        got = c.wikis.retrieve(wiki_id)
        check(got["name"] == "api-example-wiki", "retrieve returns the wiki")
        upd = c.wikis.update(wiki_id, description="Updated description")
        check(upd["description"] == "Updated description", "description updated")
        check(any(w["id"] == wiki_id for w in c.wikis.list()), "wiki listed")

        step("replace a page (upsert), then delete a page")
        c.wikis.pages.add(wiki_id, "teams/platform.md", b"# Platform team\nOwns gateway + operator.\n")
        body = c.wikis.content(wiki_id, "teams/platform.md")
        check(b"operator" in body, "page upsert replaced content")
        c.wikis.pages.delete(wiki_id, "log.md")
        paths = {e["path"] for e in c.wikis.tree(wiki_id)}
        check("log.md" not in paths, "page removed from tree")

        step("delete wiki")
        c.wikis.delete(wiki_id)
        wiki_id = None
        print("PASS test_wikis")
    finally:
        if wiki_id:
            try: c.wikis.delete(wiki_id)
            except Exception: pass


if __name__ == "__main__":
    main()
