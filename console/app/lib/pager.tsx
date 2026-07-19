"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

/** Fixed 100/page pager. Always rendered; controls disable when there is
 *  only a single page (≤100 items). */
export function Pager({ count, limit = 100 }: { count: number; limit?: number }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const page = Math.max(1, Number(sp.get("page") ?? 1));
  const pages = Math.max(1, Math.ceil(count / limit));
  const single = count <= limit;
  const go = (p: number) => {
    const q = new URLSearchParams(Array.from(sp.entries()));
    q.set("page", String(p));
    router.push(`${path}?${q.toString()}`);
  };
  return (
    <div className="pager">
      <span className="pager-info">
        {count.toLocaleString()} item{count === 1 ? "" : "s"}
        {!single && ` · page ${page} of ${pages}`}
      </span>
      <div className="pager-btns">
        <button disabled={single || page <= 1} onClick={() => go(page - 1)}>← Prev</button>
        <button disabled={single || page >= pages} onClick={() => go(page + 1)}>Next →</button>
      </div>
    </div>
  );
}
