"use client";
// Price plumbing for the pool/deploy/environment dialogs (spec 2026-07-14 §2).
// Dialogs save the resource first, then PUT the price — CRD routes carry no money.
import { useEffect, useState } from "react";
import { Field, submitJson } from "./modal";
import { wsHeader } from "./client";
import { currencySymbol, type CostSettings } from "./currency";

export interface TimePrice { amount: string; per: string }
// Token price: amount per configurable token count, per direction — input
// and output denominators differ and vary by vendor (user 2026-07-14).
export interface TokenPrice { inAmount: string; inTokens: string; outAmount: string; outTokens: string }

export function useCostSettings(): CostSettings | null {
  const [s, setS] = useState<CostSettings | null>(null);
  useEffect(() => {
    fetch("/api/v1/settings", { headers: wsHeader() })
      .then((r) => r.json()).then((j) => setS(j.costs ?? null)).catch(() => setS(null));
  }, []);
  return s;
}

export function usePrice(kind: string, ref: string | undefined) {
  const [price, setPrice] = useState<any | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!ref) { setLoaded(true); return; }
    fetch("/api/v1/prices", { headers: wsHeader() })
      .then((r) => r.json())
      .then((j) => {
        setPrice((j.prices ?? []).find((p: any) => p.kind === kind && p.ref === ref)?.prices ?? null);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [kind, ref]);
  return { price, loaded };
}

export const savePrice = (kind: string, ref: string, prices: any) =>
  submitJson("PUT", `/v1/prices/${kind}/${encodeURIComponent(ref)}`, { prices });

export interface PriceEdit { path: [string, string]; value: any | undefined; visible: boolean }

/** Full-replace PUT safety (PUT /v1/prices/:kind/:ref replaces the whole doc):
 *  seed from the fetched document so hidden (toggle-off) sub-objects survive;
 *  visible keys are set (non-empty draft) or deleted (cleared draft). */
export function mergePriceDoc(fetched: any, edits: PriceEdit[]): any {
  const doc = JSON.parse(JSON.stringify(fetched ?? {}));
  for (const e of edits) {
    if (!e.visible) continue;
    const [ledger, key] = e.path;
    if (e.value === undefined) { if (doc[ledger]) delete doc[ledger][key]; }
    else { doc[ledger] = doc[ledger] ?? {}; doc[ledger][key] = e.value; }
  }
  for (const ledger of Object.keys(doc)) if (doc[ledger] && Object.keys(doc[ledger]).length === 0) delete doc[ledger];
  return doc;
}

/** Cost amounts always display with 2-decimal precision (e.g. 20.00, 0.60);
 *  blank/non-numeric drafts pass through so the placeholder still shows. */
export const money2 = (s: string): string => {
  const t = s.trim();
  if (t === "") return "";
  const n = Number(t);
  return Number.isFinite(n) ? n.toFixed(2) : s;
};

export const timeDraft = (p: any): TimePrice =>
  ({ amount: p?.amount != null ? money2(String(p.amount)) : "", per: p?.per ?? "hour" });
export const tokenDraft = (p: any): TokenPrice => ({
  inAmount: p?.in?.amount != null ? money2(String(p.in.amount)) : "",
  inTokens: p?.in?.perTokens != null ? String(p.in.perTokens) : "1000000",
  outAmount: p?.out?.amount != null ? money2(String(p.out.amount)) : "",
  outTokens: p?.out?.perTokens != null ? String(p.out.perTokens) : "1000000",
});
export const timeOut = (d: TimePrice) =>
  d.amount.trim() !== "" && Number(d.amount) >= 0 ? { amount: Number(d.amount), per: d.per } : undefined;
export const tokenOut = (d: TokenPrice) => {
  const dir = (amount: string, tokens: string) =>
    amount.trim() !== "" && Number(amount) >= 0
      ? { amount: Number(amount), perTokens: Math.max(1, Math.floor(Number(tokens) || 1_000_000)) }
      : undefined;
  const i = dir(d.inAmount, d.inTokens), o = dir(d.outAmount, d.outTokens);
  return i || o ? { ...(i ? { in: i } : {}), ...(o ? { out: o } : {}) } : undefined;
};

const UNITS = ["minute", "hour", "day", "month", "year"];

export function TimePriceField({ label, hint, value, onChange, currency, minuteOk = false }: {
  label: string; hint?: string; value: TimePrice; onChange: (v: TimePrice) => void;
  currency: string; minuteOk?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <input style={{ width: 110, flex: "none" }} value={value.amount} placeholder="0.00"
             onChange={(e) => onChange({ ...value, amount: e.target.value })}
             onBlur={(e) => onChange({ ...value, amount: money2(e.target.value) })} />
      <span className="muted">{currencySymbol(currency)} per</span>
      <select style={{ width: 110, flex: "none" }} value={value.per}
              onChange={(e) => onChange({ ...value, per: e.target.value })}>
        {UNITS.filter((u) => minuteOk || u !== "minute").map((u) => <option key={u} value={u}>{u}</option>)}
      </select>
    </Field>
  );
}

export function TokenPriceField({ label, hint, value, onChange, currency }: {
  label: string; hint?: string; value: TokenPrice; onChange: (v: TokenPrice) => void; currency: string;
}) {
  const row = (dir: "in" | "out", amount: string, tokens: string,
               aKey: keyof TokenPrice, tKey: keyof TokenPrice) => (
    <span style={{ display: "flex", gap: 8, alignItems: "center", width: "100%" }}>
      <span className="muted" style={{ width: 26 }}>{dir}</span>
      <input style={{ width: 90, flex: "none" }} value={amount} placeholder="0.00"
             onChange={(e) => onChange({ ...value, [aKey]: e.target.value })}
             onBlur={(e) => onChange({ ...value, [aKey]: money2(e.target.value) })} />
      <span className="muted">{currencySymbol(currency)} per</span>
      <input style={{ width: 110, flex: "none" }} value={tokens} placeholder="1000000"
             onChange={(e) => onChange({ ...value, [tKey]: e.target.value })} />
      <span className="muted">tokens</span>
    </span>
  );
  return (
    <Field label={label} stack hint={hint ?? "empty amount = that direction costs nothing; token counts vary by vendor"}>
      {row("in", value.inAmount, value.inTokens, "inAmount", "inTokens")}
      {row("out", value.outAmount, value.outTokens, "outAmount", "outTokens")}
    </Field>
  );
}
