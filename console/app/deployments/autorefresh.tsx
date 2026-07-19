"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Refreshes the page on an interval while something is in progress
 *  (downloading / deploying), so the progress bar updates live. */
export function AutoRefresh({ active, ms = 3000 }: { active: boolean; ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), ms);
    return () => clearInterval(t);
  }, [active, ms, router]);
  return null;
}
