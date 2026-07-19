import { test } from "node:test";
import assert from "node:assert/strict";
import { objectKey, validEntryPath } from "../src/object-key.ts";

test("objectKey builds hierarchical keys per kind", () => {
  assert.equal(
    objectKey({ kind: "upload", workspaceId: "wrkspc_default", fileId: "file_abc123def456" }),
    "wrkspc_default/files/file_abc123def456");
  assert.equal(
    objectKey({ kind: "output", workspaceId: "wrkspc_default", fileId: "file_abc123def456" }),
    "wrkspc_default/files/file_abc123def456");
  assert.equal(
    objectKey({ kind: "checkpoint", workspaceId: "wrkspc_default", sessionId: "sesn_2ef86a4c", fileId: "file_abc123def456" }),
    "wrkspc_default/sessions/sesn_2ef86a4c/file_abc123def456");
  assert.equal(
    objectKey({ kind: "memory", workspaceId: "wrkspc_default", storeId: "memstore_x1", path: "notes/a.md" }),
    "wrkspc_default/memory/memstore_x1/notes/a.md");
  assert.equal(
    objectKey({ kind: "skill", workspaceId: "wrkspc_default", skillId: "skill_u2j", path: "scripts/analyze.py" }),
    "wrkspc_default/skills/skill_u2j/scripts/analyze.py");
});

test("objectKey rejects invalid entry paths", () => {
  for (const path of ["", "/abs", "a//b", "../up", "a/../b", "a\\b", "a\x00b"]) {
    assert.throws(() => objectKey({ kind: "skill", workspaceId: "w", skillId: "s", path }), /path/);
  }
});

test("validEntryPath", () => {
  assert.equal(validEntryPath("SKILL.md"), true);
  assert.equal(validEntryPath("scripts/analyze-v2.py"), true);
  assert.equal(validEntryPath("My Notes.md"), true); // spaces are fine — real zips have them
  assert.equal(validEntryPath("../etc/passwd"), false);
  assert.equal(validEntryPath("a/./b"), false);
  assert.equal(validEntryPath("/leading"), false);
  assert.equal(validEntryPath(""), false);
  assert.equal(validEntryPath("x".repeat(513)), false);
});
