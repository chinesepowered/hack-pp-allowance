/**
 * Signs and verifies a mandate. The signed bytes are the canonical JSON of
 * the mandate body (keys sorted, no whitespace), so any change to a rule,
 * a cap or the budget breaks the signature.
 *
 * This is the "intent mandate" idea from agent payment protocols such as
 * AP2: the user's standing instruction, signed, that the agent must be able
 * to show for every purchase. It is not an AP2 implementation.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MandateBody, SignedMandate } from "../types";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function secret(): string {
  const s = process.env.MANDATE_SIGNING_SECRET;
  if (!s || s.length < 16) {
    throw new Error("MANDATE_SIGNING_SECRET is missing or too short. Generate one with: openssl rand -hex 32");
  }
  return s;
}

/** A short, non-secret id for the key in use, so a rotated key is visible. */
export function keyId(): string {
  return "k_" + createHash("sha256").update(secret()).digest("hex").slice(0, 8);
}

export function bodyOf(m: SignedMandate | MandateBody): MandateBody {
  const { signature: _signature, ...body } = m as SignedMandate;
  void _signature;
  return body;
}

export function digestOf(body: MandateBody): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export function signMandate(body: MandateBody, signedBy: string, now: Date = new Date()): SignedMandate {
  const digest = digestOf(body);
  const value = createHmac("sha256", secret()).update(digest).digest("base64url");
  return {
    ...body,
    signature: { alg: "HMAC-SHA256", keyId: keyId(), digest, value, signedAt: now.toISOString(), signedBy },
  };
}

export function verifyMandate(m: SignedMandate | null | undefined): { ok: boolean; reason: string } {
  if (!m) return { ok: false, reason: "No mandate has been signed yet." };
  if (!m.signature) return { ok: false, reason: "The mandate has no signature." };
  const digest = digestOf(bodyOf(m));
  if (digest !== m.signature.digest) return { ok: false, reason: "The mandate was changed after it was signed." };
  const expected = createHmac("sha256", secret()).update(digest).digest();
  let given: Buffer;
  try {
    given = Buffer.from(m.signature.value, "base64url");
  } catch {
    return { ok: false, reason: "The signature is not readable." };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "The signature does not match this mandate." };
  }
  return { ok: true, reason: "Signature valid." };
}

export function shortSignature(m: SignedMandate): string {
  return m.signature.value.slice(0, 10) + "..." + m.signature.value.slice(-6);
}
