import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { localFileStore } from "../src/filestore.ts";
import { storeSkillPackage } from "../src/skill-upload.ts";

// In-memory fake of the 4 repo methods the helper touches.
function fakeRepo() {
  const rows = new Map<string, { objectKey: string }>();
  let skill: { id: string; name: string; version: number; manifest: { path: string; fileId: string }[] } | null = null;
  return {
    rows, get skill() { return skill; },
    async getSkillIdByName(_ws: string, name: string) { return skill?.name === name ? skill.id : null; },
    async createFileRecord(meta: any) { rows.set(meta.id, { objectKey: meta.objectKey }); return meta; },
    async deleteFileRecordById(id: string) {
      const key = rows.get(id)?.objectKey ?? null;
      rows.delete(id);
      if (key && [...rows.values()].some((r) => r.objectKey === key)) return null;
      return key;
    },
    async createSkill(_ws: string, name: string, manifest: any[], id?: string) {
      const previousFileIds = skill ? skill.manifest.map((m) => m.fileId) : [];
      skill = { id: skill?.id ?? id!, name, version: (skill?.version ?? 0) + 1, manifest };
      return { id: skill.id, name, version: skill.version, fileCount: manifest.length, previousFileIds };
    },
  };
}

function zipOf(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(entries)) zip.addFile(path, Buffer.from(content));
  return zip.toBuffer();
}

// adm-zip's addFile normalizes backslashes to "/" itself (verified empirically),
// so a zip built via zipOf() can never carry a raw backslash entry name — the
// bug (PowerShell's Compress-Archive writes backslash-separated entry names)
// can't be reproduced through adm-zip's own writer. Instead, patch the raw
// zip buffer bytes: entry names appear verbatim (and twice — local file header
// + central directory) in the archive, and "/" (0x2F) <-> "\" (0x5C) are both
// single-byte in the latin1/binary encoding, so a same-length string swap over
// the whole buffer flips just those bytes without disturbing any offsets.
function zipOfBackslash(entries: Record<string, string>): Buffer {
  let s = zipOf(entries).toString("latin1");
  for (const path of Object.keys(entries)) {
    s = s.split(path).join(path.split("/").join("\\"));
  }
  return Buffer.from(s, "latin1");
}

test("zip upload stores under skill-id keys and re-upload purges dropped paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-test-"));
  const files = localFileStore(root);
  const repo = fakeRepo();
  try {
    const r1 = await storeSkillPackage({ repo: repo as any, files }, "wsA", "demo", "demo.zip",
      zipOf({ "SKILL.md": "v1", "scripts/a.py": "print(1)" }));
    assert.ok("skill" in r1);
    const skillId = r1.skill.id;
    assert.equal((await files.get(`wsA/skills/${skillId}/SKILL.md`)).toString(), "v1");
    assert.equal((await files.get(`wsA/skills/${skillId}/scripts/a.py`)).toString(), "print(1)");

    // v2 drops scripts/a.py and rewrites SKILL.md in place.
    const r2 = await storeSkillPackage({ repo: repo as any, files }, "wsA", "demo", "demo.zip",
      zipOf({ "SKILL.md": "v2" }));
    assert.ok("skill" in r2 && r2.skill.version === 2);
    assert.equal((await files.get(`wsA/skills/${skillId}/SKILL.md`)).toString(), "v2");
    await assert.rejects(async () => files.get(`wsA/skills/${skillId}/scripts/a.py`)); // dropped path purged
    assert.equal(repo.rows.size, 1); // old rows purged too
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("zip with backslash entry names (Windows Compress-Archive) is accepted and normalized", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-test-"));
  const files = localFileStore(root);
  const repo = fakeRepo();
  try {
    const buf = zipOfBackslash({ "wrap/SKILL.md": "v1", "wrap/scripts/analyze.py": "print(1)" });
    const r = await storeSkillPackage({ repo: repo as any, files }, "wsA", "backslash-demo", "demo.zip", buf);
    assert.ok("skill" in r, "error" in r ? r.error : undefined);
    const skillId = (r as { skill: { id: string } }).skill.id;
    assert.equal((await files.get(`wsA/skills/${skillId}/SKILL.md`)).toString(), "v1");
    assert.equal((await files.get(`wsA/skills/${skillId}/scripts/analyze.py`)).toString(), "print(1)");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("single markdown upload becomes a 1-file package", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-test-"));
  const files = localFileStore(root);
  const repo = fakeRepo();
  try {
    const r = await storeSkillPackage({ repo: repo as any, files }, "wsA", "solo", "solo.md", Buffer.from("# hi"));
    assert.ok("skill" in r && r.skill.fileCount === 1);
    assert.equal((await files.get(`wsA/skills/${r.skill.id}/SKILL.md`)).toString(), "# hi");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects zips without root SKILL.md, traversal paths, and duplicate paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-test-"));
  const files = localFileStore(root);
  try {
    const noMd = await storeSkillPackage({ repo: fakeRepo() as any, files }, "w", "x", "x.zip", zipOf({ "readme.txt": "no" }));
    assert.ok("error" in noMd && /SKILL\.md/.test(noMd.error));
    // adm-zip normalizes "../evil.sh" (and "..\\evil.sh", "a//b", "/abs", etc.)
    // to a clean relative path before storeSkillPackage ever sees it — verified
    // empirically, so that name can't reach the validEntryPath check via a real
    // zip. A raw control character in the entry name DOES survive the adm-zip
    // round-trip intact, so use that to exercise the same rejection branch.
    const bad = await storeSkillPackage({ repo: fakeRepo() as any, files }, "w", "x", "x.zip",
      zipOf({ "SKILL.md": "ok", "a\tb": "boom" }));
    assert.ok("error" in bad && /path/.test(bad.error));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
