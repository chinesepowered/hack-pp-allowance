/**
 * The mandate itself: validation of what the model proposes, signing,
 * tamper detection and one-tap amendments.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { amendMandate } from "@/lib/actions";
import { DEFAULT_DRAFT, DEFAULT_RULES_TEXT, FAMILY } from "@/lib/demo/defaults";
import { evaluatePurchase } from "@/lib/mandate/policy";
import { buildMandateBody, mandateDraftSchema, MandateDraftError, normalizeDraft, normalizeMerchant } from "@/lib/mandate/schema";
import { bodyOf, canonicalJson, digestOf, signMandate, verifyMandate } from "@/lib/mandate/sign";
import type { SignedMandate } from "@/lib/types";

const NOW = new Date("2026-11-10T18:00:00.000Z");

function sign(): SignedMandate {
  const n = normalizeDraft(DEFAULT_DRAFT);
  return signMandate(buildMandateBody({ id: "mnd_test", version: 1, rulesText: DEFAULT_RULES_TEXT, rules: n.rules, weeklyBudget: n.weeklyBudget, expiresInDays: 90, parent: FAMILY.parent, teen: FAMILY.teen, now: NOW }), "Dana", NOW);
}

beforeAll(() => {
  process.env.MANDATE_SIGNING_SECRET = "test-secret-test-secret-test-secret-1234";
});

describe("what the model may propose", () => {
  it("accepts the shape of the default draft", () => {
    expect(mandateDraftSchema.safeParse(DEFAULT_DRAFT).success).toBe(true);
  });

  it("rejects unknown categories, negative money and unknown rule kinds", () => {
    expect(mandateDraftSchema.safeParse({ rules: [{ kind: "allow", text: "Weapons any time", categories: ["weapons"], perItemCap: null }] }).success).toBe(false);
    expect(mandateDraftSchema.safeParse({ rules: [{ kind: "budget", text: "Minus ten a week", weeklyLimit: -10 }] }).success).toBe(false);
    expect(mandateDraftSchema.safeParse({ rules: [{ kind: "transfer", text: "Send money to a friend", amount: 50 }] }).success).toBe(false);
  });

  it("requires exactly one weekly budget", () => {
    expect(() => normalizeDraft({ rules: [{ kind: "allow", text: "Books any time", categories: ["books"], perItemCap: null }], expiresInDays: 90, unclear: [] })).toThrow(MandateDraftError);
    expect(() =>
      normalizeDraft({
        rules: [
          { kind: "budget", text: "Up to $60 a week", weeklyLimit: 60 },
          { kind: "budget", text: "Up to $90 a week", weeklyLimit: 90 },
        ],
        expiresInDays: 90,
        unclear: [],
      }),
    ).toThrow(MandateDraftError);
  });

  it("refuses a category that is both allowed and blocked", () => {
    let issues: string[] = [];
    try {
      normalizeDraft({
        rules: [
          { kind: "budget", text: "Up to $60 a week", weeklyLimit: 60 },
          { kind: "allow", text: "Games are fine", categories: ["gaming"], perItemCap: null },
          { kind: "block", text: "No gaming", categories: ["gaming"], merchants: [] },
        ],
        expiresInDays: 90,
        unclear: [],
      });
    } catch (err) {
      issues = err instanceof MandateDraftError ? err.issues : [];
    }
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("another rule blocks");
  });

  it("refuses a block rule that blocks nothing", () => {
    expect(() =>
      normalizeDraft({
        rules: [
          { kind: "budget", text: "Up to $60 a week", weeklyLimit: 60 },
          { kind: "block", text: "No bad stuff", categories: [], merchants: [] },
        ],
        expiresInDays: 90,
        unclear: [],
      }),
    ).toThrow(MandateDraftError);
  });

  it("normalizes store names", () => {
    expect(normalizeMerchant("https://www.Example-Store.com/path?x=1")).toBe("example-store.com");
  });
});

describe("signing", () => {
  it("canonical JSON ignores key order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }], z: undefined })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
  });

  it("verifies an untouched mandate", () => {
    const m = sign();
    expect(verifyMandate(m)).toEqual({ ok: true, reason: "Signature valid." });
    expect(m.signature.alg).toBe("HMAC-SHA256");
    expect(m.signature.digest).toBe(digestOf(bodyOf(m)));
  });

  it("detects any change to the rules, the budget or the expiry", () => {
    const m = sign();
    expect(verifyMandate({ ...m, weeklyBudget: 600 }).ok).toBe(false);
    expect(verifyMandate({ ...m, expiresAt: "2099-01-01T00:00:00.000Z" }).ok).toBe(false);
    expect(verifyMandate({ ...m, rules: m.rules.filter((r) => r.kind !== "block") }).ok).toBe(false);
    expect(verifyMandate({ ...m, trustedMerchants: ["anything.example"] }).ok).toBe(false);
  });

  it("rejects a signature made with another key", () => {
    const m = sign();
    process.env.MANDATE_SIGNING_SECRET = "a-different-secret-a-different-secret-99";
    expect(verifyMandate(m).ok).toBe(false);
    process.env.MANDATE_SIGNING_SECRET = "test-secret-test-secret-test-secret-1234";
    expect(verifyMandate(m).ok).toBe(true);
  });

  it("rejects a forged digest and signature pair", () => {
    const m = sign();
    const forgedBody = { ...bodyOf(m), weeklyBudget: 999 };
    const forged: SignedMandate = { ...forgedBody, signature: { ...m.signature, digest: digestOf(forgedBody) } };
    expect(verifyMandate(forged).ok).toBe(false);
  });

  it("refuses to sign without a real secret", () => {
    const keep = process.env.MANDATE_SIGNING_SECRET;
    process.env.MANDATE_SIGNING_SECRET = "short";
    expect(() => sign()).toThrow(/MANDATE_SIGNING_SECRET/);
    process.env.MANDATE_SIGNING_SECRET = keep;
  });
});

describe("approve and add a rule", () => {
  it("raises the clothes cap, bumps the version and re-signs", () => {
    const m = sign();
    const next = amendMandate(m, { type: "raise_cap", category: "clothing", cap: 55 }, "Clothes and shoes up to $55.00 an item", "Dana");
    expect(next.version).toBe(2);
    expect(verifyMandate(next).ok).toBe(true);
    expect(next.signature.digest).not.toBe(m.signature.digest);
    const d = evaluatePurchase({ mandate: next, paused: false, product: { title: "Sneakers", price: 55, merchant: "papertrail.example" }, classification: { category: "clothing", confidence: 0.95 }, ledger: [{ status: "paid", amount: { value: "1.00", currency: "USD" }, createdAt: new Date().toISOString(), product: { id: "p", title: "t", brand: null, image: null, merchant: "papertrail.example", buyUrl: null, price: 1 } }] });
    expect(d.outcome).toBe("auto_approved");
  });

  it("splits a category out of a shared rule instead of capping its neighbours", () => {
    const m = sign();
    const next = amendMandate(m, { type: "raise_cap", category: "books", cap: 30 }, "Books up to $30.00 an item", "Dana");
    const school = next.rules.find((r) => r.kind === "allow" && r.categories.includes("school_supplies"));
    const books = next.rules.find((r) => r.kind === "allow" && r.categories.includes("books"));
    expect(school && school.kind === "allow" ? school.perItemCap : "missing").toBeNull();
    expect(books && books.kind === "allow" ? books.perItemCap : "missing").toBe(30);
    expect(new Set(next.rules.map((r) => r.n)).size).toBe(next.rules.length);
  });

  it("trusts a store without touching the rules", () => {
    const m = sign();
    const next = amendMandate(m, { type: "trust_merchant", merchant: "https://www.New-Store.example/" }, "new-store.example is a store we trust", "Dana");
    expect(next.trustedMerchants).toEqual(["new-store.example"]);
    expect(next.rules).toEqual(m.rules);
    expect(verifyMandate(next).ok).toBe(true);
  });

  it("raises the weekly budget in the rule and the total together", () => {
    const next = amendMandate(sign(), { type: "raise_budget", weeklyLimit: 80 }, "Up to $80.00 a week", "Dana");
    expect(next.weeklyBudget).toBe(80);
    const b = next.rules.find((r) => r.kind === "budget");
    expect(b && b.kind === "budget" ? b.weeklyLimit : 0).toBe(80);
  });

  it("never lifts a block", () => {
    const next = amendMandate(sign(), { type: "allow_category", category: "electronics", cap: 30 }, "Electronics up to $30.00 an item", "Dana");
    expect(next.rules.some((r) => r.kind === "block" && r.categories.includes("gaming"))).toBe(true);
  });
});
