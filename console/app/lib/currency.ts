// Currency is a display label only (spec 2026-07-14): ISO code in settings,
// symbol where one exists, no conversion ever.
export const CURRENCY_LABELS: [string, string][] = [
  ["EUR", "EUR (€)"], ["USD", "USD ($)"], ["GBP", "GBP (£)"], ["CHF", "CHF"], ["JPY", "JPY (¥)"],
];
const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", JPY: "¥" };

export const currencySymbol = (code: string) => SYMBOLS[code] ?? code;

/** Display precision is always 2 (user 2026-07-14) — 12.3456 → "12.35 €".
 *  Stored/computed values keep full precision; only rendering rounds.
 *  (Chart axes/tooltips use their own finer scale — per-bucket costs would
 *  flatten to 0.00 at two decimals.) */
export function fmtCost(amount: number, code: string): string {
  return `${amount.toFixed(2)} ${currencySymbol(code)}`;
}

// Mirror of the CP CostSettings shape (control-plane/src/costs.ts).
export interface CostSettings {
  enabled: boolean;
  currency: string;
  trackPoolCosts: boolean;
  trackExternalCosts: boolean;
  trackEnvCosts: boolean;
  billing: {
    enabled: boolean;
    showSessionCosts: boolean;
    billSessionTime: boolean;
    billExternalTokens: boolean;
    billLocalTokens: boolean;
    billDeploymentTime: boolean;
  };
}
