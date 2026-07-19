import { randomBytes } from "node:crypto";

/** Short entity id: 12 chars of base36 (a-z0-9), ~62 bits of randomness.
 *  Derived from 128 random bits, so the low 12 base36 digits are uniform to
 *  within negligible bias. Legacy 24-char hex ids coexist — IDs are opaque
 *  TEXT everywhere, so no migration is needed. */
export function shortId(): string {
  return BigInt("0x" + randomBytes(16).toString("hex"))
    .toString(36)
    .slice(-12)
    .padStart(12, "0");
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Uniform base62 secret token, rejection-sampled from crypto randomBytes
 *  (bytes ≥ 248 are rejected; 248 = 4·62, so accepted bytes are uniform
 *  mod 62 — no modulo bias). 33 chars ≈ 196.5 bits, ≥ the 192 bits of the
 *  legacy dpk_ 48-hex format. */
export function secretToken(len: number): string {
  let out = "";
  while (out.length < len) {
    for (const b of randomBytes(len)) {
      if (b < 248 && out.length < len) out += B62[b % 62];
    }
  }
  return out;
}
