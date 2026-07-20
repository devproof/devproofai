import Link from "next/link";
import { wsGet } from "../../lib/api";
import { DeleteButton } from "../../lib/delete";
import { SkillFiles, UpdateSkillButton } from "./viewer";
import { CopyId } from "../../lib/copy-id";
import { DateTime } from "../../lib/datetime";

export const dynamic = "force-dynamic";

export default async function SkillDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { skill } = await wsGet<{ skill: any }>(`/v1/skills/${id}`);
  if (!skill) return <p className="sub">Skill not found.</p>;
  const files: { path: string; fileId: string }[] = Array.isArray(skill.files) ? skill.files : [];
  return (
    <>
      <div className="crumbs"><Link href="/skills">Skills</Link> / <CopyId id={skill.id} /> · last modified <DateTime iso={skill.updated_at} /></div>
      <div className="pagehead">
        <h1>{skill.name}</h1>
        <div className="formrow" style={{ margin: 0 }}>
          <UpdateSkillButton name={skill.name} version={skill.version ?? 1} />
          <DeleteButton path={`/v1/skills/${skill.id}`} redirect="/skills" confirmText={`Delete skill "${skill.name}"?`} label="Delete skill" />
        </div>
      </div>
      <p className="sub">
        <span className="phase ver">v{skill.version ?? 1}</span> · {files.length} file{files.length === 1 ? "" : "s"} ·{" "}
        <code>SKILL.md</code> is the entry (●). Update skill publishes the next version in place.
      </p>
      <SkillFiles files={files} />
    </>
  );
}
