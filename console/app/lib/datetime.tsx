"use client";
// One timestamp formatter for the whole console (spec 2026-07-20-time-format).
// The preset is stamped on <html data-timefmt> by layout.tsx (the data-theme
// mechanism). <DateTime> subscribes to the attribute via useSyncExternalStore +
// MutationObserver, so a settings save (router.refresh re-stamps <html>)
// re-renders every mounted timestamp without a reload. Formatting is
// client-side ON PURPOSE: the viewer's timezone and default locale are
// unknowable on the server, and the pod's en-US/UTC rendering was the bug.
import { useSyncExternalStore } from "react";

export type TimeFormat = "browser" | "iso" | "us" | "eu";

const OPTS: Intl.DateTimeFormatOptions =
  { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" };
const EU_OPTS: Intl.DateTimeFormatOptions =
  { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" };

// `iso` is formatted manually below; compact call sites (presetLocale) get
// sv-SE, whose time formats are ISO-like (24h clock).
const LOCALES: Record<TimeFormat, string | undefined> =
  { browser: undefined, iso: "sv-SE", us: "en-US", eu: "de-DE" };

function subscribe(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-timefmt"] });
  return () => mo.disconnect();
}
const getSnapshot = () =>
  (document.documentElement.dataset.timefmt ?? "browser") as TimeFormat;
// Server + first hydration render: no preset — <DateTime> falls back to the
// sliced ISO string, so server output equals first client output (no mismatch).
const getServerSnapshot = () => undefined;

const pad = (n: number) => String(n).padStart(2, "0");

export function fmtDateTime(d: Date, fmt: TimeFormat): string {
  if (fmt === "iso")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toLocaleString(LOCALES[fmt], fmt === "eu" ? EU_OPTS : OPTS);
}

/** Locale tag for compact context-dependent formats (deployment trace clock,
 *  stats chart ticks) so their locale follows the setting while their shapes
 *  stay context-dependent. Not a hook: safe in plain render helpers; those
 *  call sites render from client-side fetched data, so the SSR undefined
 *  branch never paints real content. */
export function presetLocale(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return LOCALES[(document.documentElement.dataset.timefmt ?? "browser") as TimeFormat];
}

/** Hydration-safe timestamp, minutes precision. Pre-hydration it shows the ISO
 *  string trimmed by pure slicing ("2026-07-20T20:13:12.000Z" → "2026-07-20
 *  20:13Z") — deterministic, no Date/timezone involved — then swaps to the
 *  preset format in the viewer's timezone. */
export function DateTime({ iso }: { iso: string }) {
  const fmt = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (!fmt) return <>{`${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`}</>;
  return <>{fmtDateTime(new Date(iso), fmt)}</>;
}
