import Link from "next/link";
import { CreateSkill } from "./create";
import { wsGet, offsetOf } from "../lib/api";
import { Pager } from "../lib/pager";
import { DeleteButton } from "../lib/delete";

export const dynamic = "force-dynamic";

export default async function SkillsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const offset = offsetOf((await searchParams).page);
  const { skills, count } = await wsGet<{ skills: any[]; count: number }>(`/v1/skills?offset=${offset}`);
  return (
    <>
      <div className="pagehead"><h1>Skills</h1><CreateSkill /></div>
      <p className="sub">
        Reusable instruction packages your agents can follow. Upload a single <code>SKILL.md</code> or a
        Claude Code skill <b>.zip</b> (SKILL.md + scripts &amp; resources).
      </p>
      <div className="tablewrap"><table>
        <thead><tr><th>ID</th><th>Name</th><th>Version</th><th>Files</th><th>Last modified</th><th></th></tr></thead>
        <tbody>
          {skills.map((s: any) => (
            <tr key={s.id}>
              <td><Link href={`/skills/${s.id}`}><code>{s.id}</code></Link></td>
              <td>{s.name}</td>
              <td><span className="phase ver">v{s.version ?? 1}</span></td>
              <td>{Array.isArray(s.files) ? s.files.length : 1}</td>
              <td>{new Date(s.updated_at).toLocaleString()}</td>
              <td><DeleteButton path={`/v1/skills/${s.id}`} confirmText={`Delete skill "${s.name}"?`} /></td>
            </tr>
          ))}
          {skills.length === 0 && <tr><td colSpan={6} className="empty">No skills yet — upload a SKILL.md or a skill .zip.</td></tr>}
        </tbody>
      </table></div>
      <Pager count={count} />
    </>
  );
}
