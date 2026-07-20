// Console theme + time format stored in the app_settings JSON singleton under
// `appearance` (specs 2026-07-15 theme, 2026-07-20 time format). Platform-wide
// today; a per-user override lands with user accounts and reads a cookie ahead
// of this value. Mirrors limits.ts.

export type Theme = "system" | "light" | "dark";
export type TimeFormat = "browser" | "iso" | "us" | "eu";

export interface Appearance {
  theme: Theme;
  timeFormat: TimeFormat;
}

export const THEMES: readonly Theme[] = ["system", "light", "dark"] as const;
export const TIME_FORMATS: readonly TimeFormat[] = ["browser", "iso", "us", "eu"] as const;
export const DEFAULT_THEME: Theme = "system";
export const DEFAULT_TIME_FORMAT: TimeFormat = "browser";
export const DEFAULT_APPEARANCE: Appearance = { theme: DEFAULT_THEME, timeFormat: DEFAULT_TIME_FORMAT };

function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}
function isTimeFormat(v: unknown): v is TimeFormat {
  return typeof v === "string" && (TIME_FORMATS as readonly string[]).includes(v);
}

/** Coerce stored/absent JSON to a valid Appearance, falling back to defaults. */
export function normalizeAppearance(raw: unknown): Appearance {
  const r = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { theme?: unknown; timeFormat?: unknown }) : {};
  return {
    theme: isTheme(r.theme) ? r.theme : DEFAULT_THEME,
    timeFormat: isTimeFormat(r.timeFormat) ? r.timeFormat : DEFAULT_TIME_FORMAT,
  };
}

/** Returns an error message, or null when the input is a valid partial. */
export function validateAppearance(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "appearance must be an object";
  const r = raw as { theme?: unknown; timeFormat?: unknown };
  if (r.theme != null && !isTheme(r.theme)) return `appearance.theme must be one of: ${THEMES.join(", ")}`;
  if (r.timeFormat != null && !isTimeFormat(r.timeFormat)) return `appearance.timeFormat must be one of: ${TIME_FORMATS.join(", ")}`;
  return null;
}
