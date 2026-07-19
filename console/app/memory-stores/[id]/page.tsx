import Link from "next/link";
import { MemoryBrowser } from "./browser";
import { wsGet } from "../../lib/api";
import { CopyId } from "../../lib/copy-id";

export const dynamic = "force-dynamic";

export default async function MemoryStoreDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ entries }, storeRes] = await Promise.all([
    wsGet<{ entries: any[] }>(`/v1/memory-stores/${id}/tree`),
    wsGet<{ store: any }>(`/v1/memory-stores/${id}`).catch(() => null),
  ]);
  const store = storeRes?.store;
  return (
    <>
      <div className="crumbs"><Link href="/memory-stores">Memory stores</Link> / <CopyId id={id} />
        {store && <> · last modified {new Date(store.updated_at).toLocaleString()}</>}</div>
      <h1>Memory store</h1>
      <p className="sub">{entries.length} file(s)</p>
      <MemoryBrowser storeId={id} entries={entries} />
    </>
  );
}
