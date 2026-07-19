// Resolves a Usage-page date-range preset into a query window + chart bucket.
// Day presets align to UTC day starts (the DB runs UTC and buckets via
// date_trunc), so "Last N days" spans exactly N calendar days including
// today — a rolling now()-anchored window used to leak an (N+1)th partial
// day into the charts (user 2026-07-14). Calendar presets (month/last_month)
// are UTC month boundaries; 3m/6m bucket weekly so the chart stays readable.

const DAY_MS = 86_400_000;

export interface RangeWindow {
  start: Date;
  end: Date | null; // null = unbounded (now)
  bucket: "day" | "week";
}

export function rangeWindow(range: string, now = new Date()): RangeWindow {
  const dayStart = (daysBack: number) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return new Date(d.getTime() - daysBack * DAY_MS);
  };
  const monthsBack = (n: number) => {
    const d = new Date(now);
    const day = d.getUTCDate();
    d.setUTCDate(1); // avoid rollover while shifting months
    d.setUTCMonth(d.getUTCMonth() - n);
    // clamp to the target month's length (e.g. May 31 → Feb 28)
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d;
  };
  switch (range) {
    case "1d": return { start: dayStart(0), end: null, bucket: "day" };
    case "3d": return { start: dayStart(2), end: null, bucket: "day" };
    case "14d": return { start: dayStart(13), end: null, bucket: "day" };
    case "28d": return { start: dayStart(27), end: null, bucket: "day" };
    case "month":
      return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: null, bucket: "day" };
    case "last_month":
      return {
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
        end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        bucket: "day",
      };
    case "3m": return { start: monthsBack(3), end: null, bucket: "week" };
    case "6m": return { start: monthsBack(6), end: null, bucket: "week" };
    case "7d":
    default: return { start: dayStart(6), end: null, bucket: "day" };
  }
}

/** SQL fragment: one row per bucket start across the whole window (DB-side,
 *  UTC), so chart x-axes cover the full selected range even for empty
 *  buckets. LEFT JOIN the aggregate onto it: `FROM ${bucketSeries(...)} g(d)`.
 *  startParam/endParam are placeholder names ("$1"…); endParam null = now. */
export function bucketSeries(bucket: "day" | "week", startParam: string, endParam: string | null): string {
  const upper = endParam ? `${endParam}::timestamptz - interval '1 second'` : "now()";
  return `generate_series(date_trunc('${bucket}', ${startParam}::timestamptz),
                          date_trunc('${bucket}', ${upper}), interval '1 ${bucket}')`;
}
