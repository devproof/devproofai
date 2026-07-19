// Platform limits stored in the app_settings JSON singleton under `limits`
// (spec 2026-07-14). Today just the durable /work PVC size cap. Mirrors the
// costs.ts normalize/validate pattern.

export interface Limits {
  maxWorkGb: number;
}

export const DEFAULT_MAX_WORK_GB = 2048;
export const DEFAULT_LIMITS: Limits = { maxWorkGb: DEFAULT_MAX_WORK_GB };

/** Coerce stored/absent JSON to a valid Limits, falling back to the default. */
export function normalizeLimits(raw: unknown): Limits {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as any) : {};
  const n = Number(r.maxWorkGb);
  return { maxWorkGb: Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_WORK_GB };
}

/** Returns an error message, or null when the input is a valid partial. */
export function validateLimits(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "limits must be an object";
  const m = (raw as any).maxWorkGb;
  if (m != null && (!Number.isInteger(m) || m < 1)) return "limits.maxWorkGb must be an integer ≥ 1";
  return null;
}
