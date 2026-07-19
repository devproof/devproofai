import { wsGet, offsetOf } from "../lib/api";
import { Pager } from "../lib/pager";
import { DeleteButton } from "../lib/delete";

interface CacheEntry {
  name: string; source: string; size: string | null; phase: string; created: string;
}

export const dynamic = "force-dynamic";

export default async function CachePage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const settings = await wsGet<{ serving?: { localEnabled?: boolean } }>("/v1/settings").catch(() => null);
  if (settings?.serving?.localEnabled === false) return (
    <>
      <h1>Model Cache</h1>
      <p className="sub">Local serving is disabled on this installation.</p>
    </>
  );
  const offset = offsetOf((await searchParams).page);
  const { cache, count } = await wsGet<{ cache: CacheEntry[]; count: number }>(`/v1/cache?offset=${offset}`);
  return (
    <>
      <h1>Model Cache</h1>
      <p className="sub">Model artifacts downloaded to the cluster — deployments reuse these without re-downloading.</p>
      <table>
        <thead>
          <tr><th>Name</th><th>Size</th><th>Phase</th><th>Source</th><th>Downloaded</th><th></th></tr>
        </thead>
        <tbody>
          {cache.map((c) => (
            <tr key={c.name}>
              <td>{c.name}</td>
              <td>{c.size ?? "—"}</td>
              <td><span className={`phase ${c.phase}`}>{c.phase}</span></td>
              <td><code style={{ wordBreak: "break-all" }}>{c.source}</code></td>
              <td>{new Date(c.created).toLocaleString()}</td>
              <td><DeleteButton path={`/v1/cache/${c.name}`} confirmText={`Evict cached model "${c.name}"? It will re-download on next deploy.`} label="Evict" /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager count={count} />
    </>
  );
}
