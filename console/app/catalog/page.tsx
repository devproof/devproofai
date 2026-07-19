import { DeployLocalButton } from "../deployments/deploy-modal";
import { wsGet, offsetOf } from "../lib/api";
import { Pager } from "../lib/pager";
import { AddCustomModelButton, EditModelName } from "./model-modal";
import { DeleteButton } from "../lib/delete";

interface CapacityProfile {
  gpuType: string; instanceType: string; gpusPerReplica: number;
  vramGB: number; estTokensPerSec: number;
}
interface CatalogEntry {
  id: string; family: string; displayName: string; parameters: string;
  format: string; quantization?: string; license?: string; releaseDate?: string;
  recommendedEngine: string; toolCalling?: string; contextTokens?: number;
  requirements?: { vramGB: number; diskGB: number; gpus: number };
  capacityProfiles?: CapacityProfile[];
  observedTokensPerSec?: number | null;
  reasoning?: { efforts: Record<string, number> } | null;
  resources?: { cpu?: string; memory?: string };
}

export const dynamic = "force-dynamic";

const toolBadge = (t?: string) =>
  t === "strong" ? "ok" : t === "basic" ? "warn" : "bad";

const PAGE_SIZE = 300;

export default async function CatalogPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const settings = await wsGet<{ serving?: { localEnabled?: boolean } }>("/v1/settings").catch(() => null);
  if (settings?.serving?.localEnabled === false) return (
    <>
      <h1>Model Catalog</h1>
      <p className="sub">Local serving is disabled on this installation.</p>
    </>
  );
  const offset = offsetOf((await searchParams).page, PAGE_SIZE);
  const { models, count } = await wsGet<{ models: (CatalogEntry & { custom?: boolean; overridden?: boolean })[]; count: number }>(`/v1/catalog?offset=${offset}&limit=${PAGE_SIZE}`);
  // Group by family (first-appearance order) with an inline headline row per group;
  // within a family newest release first (undated entries last).
  const groups: { family: string; rows: typeof models }[] = [];
  for (const m of models) {
    const g = groups.find((x) => x.family === m.family);
    if (g) g.rows.push(m); else groups.push({ family: m.family, rows: [m] });
  }
  for (const g of groups) g.rows.sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""));
  return (
    <>
      <div className="pagehead"><h1>Model catalog</h1><AddCustomModelButton /></div>
      <p className="sub">
        {count} models. Click a model's name to edit it — bundled models keep their
        YAML defaults and get a site override.
      </p>
      <div className="tablewrap"><table>
        <thead>
          <tr>
            <th>Model</th><th>Params</th><th>Ctx</th><th>Released</th><th>Tools</th>
            <th>GPU RAM</th><th>~tok/s</th><th></th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => [
            <tr className="tgroup" key={`family-${g.family}`}>
              <td colSpan={8}>{g.family} <span className="muted">· {g.rows.length} model{g.rows.length === 1 ? "" : "s"}</span></td>
            </tr>,
            ...g.rows.map((m) => {
            const p = (m.capacityProfiles ?? [])[0];
            return (
              <tr key={m.id}>
                <td>
                  <div>
                    <EditModelName entry={m} />
                    {m.custom && <span className="chip" style={{ marginLeft: 8, fontSize: 10 }}>custom</span>}
                    {m.overridden && <span className="chip" style={{ marginLeft: 8, fontSize: 10 }}>overridden</span>}
                  </div>
                  <div style={{ color: "var(--muted)", fontSize: 12 }}>
                    {m.family} · {m.license ?? "—"}{m.requirements?.diskGB ? ` · ~${m.requirements.diskGB} GB` : ""}
                    {m.reasoning ? ` · reasoning` : ""}
                  </div>
                </td>
                <td>{m.parameters}</td>
                <td>{m.contextTokens ? `${Math.round(m.contextTokens / 1024)}k` : "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>{m.releaseDate ?? <span className="muted">—</span>}</td>
                <td><span className={`phase ${toolBadge(m.toolCalling)}`}>{m.toolCalling ?? "—"}</span></td>
                <td>{p && p.gpusPerReplica > 0 && p.vramGB ? `${p.vramGB} GB` : <span className="muted">—</span>}</td>
                <td>{m.observedTokensPerSec ? <b title="measured on this cluster">{m.observedTokensPerSec.toFixed(0)}</b> : (p?.estTokensPerSec ?? "—")}</td>
                <td><div className="rowactions">
                  <DeployLocalButton catalogId={m.id} defaultName={m.id} contextTokens={m.contextTokens} reasoning={m.reasoning?.efforts ?? null} resources={m.resources ?? null} small />
                  {m.custom && <DeleteButton path={`/v1/catalog/${m.id}`} confirmText={`Remove custom model "${m.displayName}"?`} label="Remove" />}
                </div></td>
              </tr>
            );
          }),
          ])}
        </tbody>
      </table></div>
      <Pager count={count} limit={PAGE_SIZE} />
      <p className="sub" style={{ marginTop: 14 }}>
        <b>tok/s</b> and <b>GPU RAM</b> come from the model's first capacity profile;
        bold tok/s = measured live on this cluster via the learning loop.
      </p>
    </>
  );
}
