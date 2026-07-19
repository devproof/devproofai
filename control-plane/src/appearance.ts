// Console theme stored in the app_settings JSON singleton under `appearance`
// (spec 2026-07-15). Platform-wide today; a per-user override lands with user
// accounts and reads a cookie ahead of this value. Mirrors limits.ts.

export type Theme = "system" | "light" | "dark";

export interface Appearance {
  theme: Theme;
}

export const THEMES: readonly Theme[] = ["system", "light", "dark"] as const;
export const DEFAULT_THEME: Theme = "system";
export const DEFAULT_APPEARANCE: Appearance = { theme: DEFAULT_THEME };

function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}

/** Coerce stored/absent JSON to a valid Appearance, falling back to the default. */
export function normalizeAppearance(raw: unknown): Appearance {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { theme?: unknown }) : {};
  return { theme: isTheme(r.theme) ? r.theme : DEFAULT_THEME };
}

/** Returns an error message, or null when the input is a valid partial. */
export function validateAppearance(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "appearance must be an object";
  const t = (raw as { theme?: unknown }).theme;
  if (t != null && !isTheme(t)) return `appearance.theme must be one of: ${THEMES.join(", ")}`;
  return null;
}
