import Link from "next/link";
import { MemoryBrowser } from "./browser";
import { EditMemoryStoreButton } from "../edit";
import { wsGet } from "../../lib/api";
import { CopyId } from "../../lib/copy-id";
import { DeleteButton } from "../../lib/delete";
import { DateTime } from "../../lib/datetime";

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
        {store && <> · last modified <DateTime iso={store.updated_at} /></>}</div>
      <div className="pagehead">
        <h1>{store?.name ?? "Memory store"}</h1>
        {store && (
          <div className="formrow" style={{ margin: 0 }}>
            <EditMemoryStoreButton store={store} />
            <DeleteButton path={`/v1/memory-stores/${store.id}`} redirect="/memory-stores"
                          confirmText={`Delete memory store "${store.name}" and all its entries?`} label="Delete memory store" />
          </div>
        )}
      </div>
      <p className="sub">{entries.length} file(s)</p>
      <MemoryBrowser storeId={id} entries={entries} />
    </>
  );
}
