"""Memory stores: create, add entries, tree + content round trip, delete."""
from __future__ import annotations

from _common import check, client, step


def main() -> None:
    c = client()
    store_id = None
    try:
        step("create store + entries")
        store = c.memory_stores.create(name="api-example-memory")
        store_id = store["id"]
        c.memory_stores.entries.add(store_id, "facts/user.md", b"Prefers dark mode.\n")
        c.memory_stores.entries.add(store_id, "facts/project.md", b"Ships on Fridays.\n")

        step("tree + content round trip")
        paths = {e["path"] for e in c.memory_stores.tree(store_id)}
        check(paths == {"facts/user.md", "facts/project.md"}, f"tree lists both entries ({paths})")
        body = c.memory_stores.content(store_id, "facts/user.md")
        check(body == b"Prefers dark mode.\n", "entry content round-trips")

        step("delete entry, then store")
        c.memory_stores.entries.delete(store_id, "facts/project.md")
        paths = {e["path"] for e in c.memory_stores.tree(store_id)}
        check(paths == {"facts/user.md"}, "entry removed from tree")
        c.memory_stores.delete(store_id)
        store_id = None
        print("PASS test_memory")
    finally:
        if store_id:
            try: c.memory_stores.delete(store_id)
            except Exception: pass


if __name__ == "__main__":
    main()
