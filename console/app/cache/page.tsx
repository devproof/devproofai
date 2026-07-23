import { wsGet, offsetOf } from "../lib/api";
import { Pager } from "../lib/pager";
import { CacheTable, type CacheEntry } from "./cache-table";

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
      <CacheTable initial={cache} offset={offset} />
      <Pager count={count} />
    </>
  );
}
