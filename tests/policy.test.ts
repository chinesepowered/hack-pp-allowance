/**
 * The deterministic money rules. These tests are the contract: whatever
 * the model says, a purchase is paid only when this code allows it.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_DRAFT, DEFAULT_RULES_TEXT, FAMILY } from "@/lib/demo/defaults";
import { authorizePayment, BUDGET_WINDOW_MS, budgetStatus, canUndo, CONFIDENCE_TO_ACT, evaluatePurchase, knownMerchants, screenRequest, spentThisWeek, type PolicyInput } from "@/lib/mandate/policy";
import { buildMandateBody, normalizeDraft } from "@/lib/mandate/schema";
import { signMandate } from "@/lib/mandate/sign";
import type { Category } from "@/lib/mandate/categories";
import type { SignedMandate } from "@/lib/types";

const NOW = new Date("2026-11-10T18:00:00.000Z");
let mandate: SignedMandate;

beforeAll(() => {
  process.env.MANDATE_SIGNING_SECRET = "test-secret-test-secret-test-secret-1234";
  const n = normalizeDraft(DEFAULT_DRAFT);
  mandate = signMandate(
    buildMandateBody({ id: "mnd_test", version: 1, rulesText: DEFAULT_RULES_TEXT, rules: n.rules, weeklyBudget: n.weeklyBudget, expiresInDays: 90, parent: FAMILY.parent, teen: FAMILY.teen, now: new Date("2026-11-04T18:00:00.000Z") }),
    "Dana",
    new Date("2026-11-04T18:00:00.000Z"),
  );
});

type Paid = PolicyInput["ledger"][number];
function paid(price: number, merchant: string, hoursAgo: number, status: Paid["status"] = "paid"): Paid {
  return { status, amount: { value: price.toFixed(2), currency: "USD" }, createdAt: new Date(NOW.getTime() - hoursAgo * 3600000).toISOString(), product: { id: "p", title: "t", brand: null, image: null, merchant, buyUrl: null, price } };
}

function check(over: { price?: number; merchant?: string; category?: Category; confidence?: number; ledger?: Paid[]; paused?: boolean; mandate?: SignedMandate | null; now?: Date } = {}) {
  return evaluatePurchase({
    mandate: over.mandate === undefined ? mandate : over.mandate,
    paused: over.paused ?? false,
    product: { title: "Thing", price: over.price ?? 9.5, merchant: over.merchant ?? "papertrail.example" },
    classification: { category: over.category ?? "school_supplies", confidence: over.confidence ?? 0.97 },
    ledger: over.ledger ?? [],
    now: over.now ?? NOW,
  });
}

describe("the default mandate", () => {
  it("numbers the rules with the budget first", () => {
    expect(mandate.rules.map((r) => [r.n, r.kind])).toEqual([
      [1, "budget"],
      [2, "allow"],
      [3, "allow"],
      [4, "block"],
      [5, "approval"],
    ]);
    expect(mandate.weeklyBudget).toBe(60);
  });
});

describe("auto approval", () => {
  it("pays school supplies and quotes the rule that allowed it", () => {
    const d = check({ price: 12.89 });
    expect(d.outcome).toBe("auto_approved");
    expect(d.ruleN).toBe(2);
    expect(d.summary).toBe("Paid under rule 2: School supplies and books any time");
    expect(d.checks.every((c) => c.pass)).toBe(true);
    expect(d.budget).toEqual({ limit: 60, spent: 0, remaining: 60, afterPurchase: 47.11 });
  });

  it("pays books", () => {
    expect(check({ category: "books", price: 11.49 }).outcome).toBe("auto_approved");
  });

  it("pays clothes at exactly the cap", () => {
    const d = check({ category: "clothing", price: 40, merchant: "northfield-basics.example", ledger: [paid(5, "northfield-basics.example", 30)] });
    expect(d.outcome).toBe("auto_approved");
    expect(d.ruleN).toBe(3);
  });

  it("lets a new store through when the price is at or under the threshold", () => {
    expect(check({ price: 25, merchant: "brand-new-store.example" }).outcome).toBe("auto_approved");
  });

  it("lets a store the family used before through above the threshold", () => {
    const d = check({ price: 31.99, merchant: "papertrail.example", ledger: [paid(8.75, "papertrail.example", 72)] });
    expect(d.outcome).toBe("auto_approved");
  });
});

describe("needs the parent's OK", () => {
  it("sends $55 sneakers to the parent, quoting the clothes cap", () => {
    const d = check({ category: "clothing", price: 55, merchant: "shoes.example" });
    expect(d.outcome).toBe("needs_approval");
    expect(d.code).toBe("over_item_cap");
    expect(d.ruleN).toBe(3);
    expect(d.ruleText).toBe("Clothes up to $40 an item");
    expect(d.parentLine).toContain("$15.00 over the $40.00 cap");
  });

  it("applies the new-store rule above $25", () => {
    const d = check({ price: 31.99, merchant: "never-used.example" });
    expect(d.outcome).toBe("needs_approval");
    expect(d.code).toBe("approval_rule");
    expect(d.ruleN).toBe(5);
  });

  it("asks when no rule covers the category", () => {
    const d = check({ category: "electronics", price: 15 });
    expect(d.outcome).toBe("needs_approval");
    expect(d.code).toBe("category_not_covered");
    expect(d.ruleN).toBeNull();
  });

  it("asks when the classifier is not sure enough", () => {
    const d = check({ confidence: CONFIDENCE_TO_ACT - 0.01 });
    expect(d.outcome).toBe("needs_approval");
    expect(d.code).toBe("low_confidence");
  });

  it("asks rather than blocks when a blocked label is only a weak guess", () => {
    const d = check({ category: "gaming", confidence: 0.4 });
    expect(d.outcome).toBe("needs_approval");
    expect(d.code).toBe("low_confidence");
  });

  it("asks when the weekly budget would be exceeded", () => {
    const d = check({ price: 20, ledger: [paid(30, "papertrail.example", 20), paid(15, "papertrail.example", 50)] });
    expect(d.outcome).toBe("needs_approval");
    expect(d.code).toBe("over_budget");
    expect(d.ruleN).toBe(1);
    expect(d.budget.remaining).toBe(15);
  });

  it("allows a purchase that uses the budget exactly", () => {
    const d = check({ price: 15, ledger: [paid(45, "papertrail.example", 20)] });
    expect(d.outcome).toBe("auto_approved");
    expect(d.budget.afterPurchase).toBe(0);
  });
});

describe("blocked", () => {
  it("blocks gaming and quotes the rule", () => {
    const d = check({ category: "gaming", price: 20 });
    expect(d.outcome).toBe("blocked");
    expect(d.code).toBe("blocked_category");
    expect(d.ruleN).toBe(4);
    expect(d.teenLine).toContain('"No gaming or gift cards"');
  });

  it("blocks gift cards even under every cap", () => {
    expect(check({ category: "gift_cards", price: 1 }).outcome).toBe("blocked");
  });

  it("blocks everything while paused", () => {
    const d = check({ paused: true });
    expect(d.outcome).toBe("blocked");
    expect(d.code).toBe("mandate_paused");
  });

  it("blocks when there is no mandate", () => {
    expect(check({ mandate: null }).code).toBe("mandate_missing");
  });

  it("blocks an expired mandate", () => {
    const d = check({ now: new Date(Date.parse(mandate.expiresAt) + 1000) });
    expect(d.outcome).toBe("blocked");
    expect(d.code).toBe("mandate_expired");
  });

  it("blocks when the mandate was changed after signing", () => {
    const tampered: SignedMandate = { ...mandate, weeklyBudget: 6000 };
    const d = check({ mandate: tampered });
    expect(d.outcome).toBe("blocked");
    expect(d.code).toBe("signature_invalid");
  });

  it("blocks a raised cap that was not re-signed", () => {
    const tampered: SignedMandate = { ...mandate, rules: mandate.rules.map((r) => (r.kind === "allow" && r.perItemCap !== null ? { ...r, perItemCap: 500 } : r)) };
    expect(check({ mandate: tampered, category: "clothing", price: 300 }).code).toBe("signature_invalid");
  });

  it("blocks a blocked store, including its subdomains", () => {
    const n = normalizeDraft({ ...DEFAULT_DRAFT, rules: [...DEFAULT_DRAFT.rules, { kind: "block", text: "Nothing from Sketchy Deals", categories: [], merchants: ["https://www.sketchy-deals.example/"] }] });
    const m = signMandate(buildMandateBody({ id: "mnd_b", version: 1, rulesText: "x", rules: n.rules, weeklyBudget: n.weeklyBudget, expiresInDays: 90, parent: FAMILY.parent, teen: FAMILY.teen, now: NOW }), "Dana", NOW);
    expect(check({ mandate: m, merchant: "sketchy-deals.example" }).code).toBe("blocked_merchant");
    expect(check({ mandate: m, merchant: "shop.sketchy-deals.example" }).code).toBe("blocked_merchant");
    expect(check({ mandate: m, merchant: "not-sketchy-deals.example", price: 5 }).outcome).toBe("auto_approved");
  });

  it("screens a request before any product is found", () => {
    const d = screenRequest({ mandate, paused: false, what: "game top-up", classification: { category: "gift_cards", confidence: 0.9 }, ledger: [] });
    expect(d?.outcome).toBe("blocked");
    expect(screenRequest({ mandate, paused: false, what: "notebooks", classification: { category: "school_supplies", confidence: 0.9 }, ledger: [] })).toBeNull();
  });
});

describe("the weekly budget", () => {
  it("is a rolling seven days", () => {
    const ledger = [paid(20, "a.example", 1), paid(30, "a.example", 24 * 7 + 1)];
    expect(spentThisWeek(ledger, NOW)).toBe(20);
    expect(budgetStatus(mandate, ledger, NOW)).toEqual({ limit: 60, spent: 20, remaining: 40 });
    expect(BUDGET_WINDOW_MS).toBe(604800000);
  });

  it("does not count refunded, declined, blocked or pending purchases", () => {
    const ledger = [paid(20, "a.example", 1, "refunded"), paid(20, "a.example", 1, "declined"), paid(20, "a.example", 1, "blocked"), paid(20, "a.example", 1, "pending_approval"), paid(7.5, "a.example", 1, "paid")];
    expect(spentThisWeek(ledger, NOW)).toBe(7.5);
  });

  it("counts a refund in flight until PayPal confirms it", () => {
    expect(spentThisWeek([paid(20, "a.example", 1, "refund_pending")], NOW)).toBe(20);
  });

  it("adds cents without floating point drift", () => {
    expect(spentThisWeek([paid(0.1, "a.example", 1), paid(0.2, "a.example", 2)], NOW)).toBe(0.3);
  });

  it("never reports a negative remainder", () => {
    expect(budgetStatus(mandate, [paid(80, "a.example", 1)], NOW).remaining).toBe(0);
  });
});

describe("stores the family has used", () => {
  it("come from paid and refunded purchases and from trusted stores", () => {
    const ledger = [paid(5, "www.Used-Store.example", 400), paid(5, "refunded.example", 1, "refunded"), paid(5, "blocked.example", 1, "blocked")];
    const known = knownMerchants({ ...mandate, trustedMerchants: ["trusted.example"] }, ledger);
    expect([...known].sort()).toEqual(["refunded.example", "trusted.example", "used-store.example"]);
  });
});

describe("the gate in front of PayPal", () => {
  const product = { id: "prod1", title: "Sneakers", brand: null, image: null, merchant: "shoes.example", buyUrl: null, price: 55 };
  const amount = { value: "55.00", currency: "USD" as const };

  it("lets an auto approved purchase pay under the mandate", () => {
    expect(authorizePayment(check({ price: 12 }), "prod1")).toEqual({ ok: true, by: "mandate" });
  });

  it("refuses a purchase that needs approval when there is none", () => {
    const d = check({ category: "clothing", price: 55 });
    expect(authorizePayment(d, "prod1").ok).toBe(false);
    expect(authorizePayment(d, "prod1", { status: "pending", product, amount }).ok).toBe(false);
    expect(authorizePayment(d, "prod1", { status: "declined", product, amount }).ok).toBe(false);
  });

  it("lets an approved purchase pay, credited to the parent", () => {
    const d = check({ category: "clothing", price: 55 });
    expect(authorizePayment(d, "prod1", { status: "approved", product, amount })).toEqual({ ok: true, by: "parent" });
  });

  it("refuses an approval that was given for another product", () => {
    const d = check({ category: "clothing", price: 55 });
    expect(authorizePayment(d, "other-product", { status: "approved", product, amount }).ok).toBe(false);
  });

  it("refuses when the price went up after the approval", () => {
    const d = check({ category: "clothing", price: 58 });
    expect(authorizePayment(d, "prod1", { status: "approved", product, amount }).ok).toBe(false);
  });

  it("never pays for a blocked purchase, even with an approval", () => {
    const d = check({ category: "gaming", price: 20 });
    expect(authorizePayment(d, "prod1", { status: "approved", product, amount: { value: "20.00", currency: "USD" } }).ok).toBe(false);
  });

  it("never pays while paused, even with an approval", () => {
    const d = check({ category: "clothing", price: 55, paused: true });
    expect(authorizePayment(d, "prod1", { status: "approved", product, amount }).ok).toBe(false);
  });
});

describe("undo", () => {
  const refs = { orderId: "O", captureId: "C", orderStatus: "COMPLETED", captureStatus: "COMPLETED", refundId: null, refundStatus: null, payerEmail: null, invoiceId: null, lastSyncedAt: null, via: null };
  it("is allowed for 24 hours after a paid purchase", () => {
    expect(canUndo({ status: "paid", createdAt: new Date(NOW.getTime() - 23 * 3600000).toISOString(), paypal: refs }, NOW).ok).toBe(true);
    expect(canUndo({ status: "paid", createdAt: new Date(NOW.getTime() - 25 * 3600000).toISOString(), paypal: refs }, NOW).ok).toBe(false);
  });
  it("is not offered twice or without a capture", () => {
    expect(canUndo({ status: "refunded", createdAt: NOW.toISOString(), paypal: refs }, NOW).ok).toBe(false);
    expect(canUndo({ status: "paid", createdAt: NOW.toISOString(), paypal: { ...refs, captureId: null } }, NOW).ok).toBe(false);
  });
});
