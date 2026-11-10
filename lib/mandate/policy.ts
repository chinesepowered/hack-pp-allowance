/**
 * The policy check. Plain code, no model.
 *
 * Every purchase Kip wants to make goes through evaluatePurchase(). The
 * model can suggest a product and a category, but the outcome (pay now, ask
 * the parent, or refuse) is decided here, and the PayPal call sits behind
 * authorizePayment() below.
 */
import { CATEGORY_LABEL, type Category } from "./categories";
import { normalizeMerchant, round2 } from "./schema";
import { verifyMandate } from "./sign";
import type { AllowRule, Approval, ApprovalRule, BlockRule, BudgetRule, Decision, LedgerEntry, PolicyCheck, Rule, SignedMandate } from "../types";

/** Below this the classifier is not sure enough for Kip to act alone. */
export const CONFIDENCE_TO_ACT = 0.75;
/** Below this we do not even trust a "blocked" label; a parent looks instead. */
export const CONFIDENCE_TO_BLOCK = 0.6;
/** The weekly budget is a rolling seven days. */
export const BUDGET_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** A parent can undo a purchase for this long. */
export const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

export type PolicyInput = {
  mandate: SignedMandate | null;
  paused: boolean;
  product: { title: string; price: number; merchant: string };
  classification: { category: Category; confidence: number };
  ledger: Pick<LedgerEntry, "status" | "amount" | "createdAt" | "product">[];
  now?: Date;
  /** Tests can skip the HMAC check; production code never sets this. */
  skipSignatureCheck?: boolean;
};

export function usd(n: number): string {
  return "$" + n.toFixed(2);
}

function quote(text: string): string {
  return `"${text.replace(/[.\s]+$/, "")}"`;
}

/** Money already spent inside the rolling window. Refunded purchases do not count. */
export function spentThisWeek(ledger: PolicyInput["ledger"], now: Date = new Date()): number {
  const from = now.getTime() - BUDGET_WINDOW_MS;
  let cents = 0;
  for (const e of ledger) {
    if (e.status !== "paid" && e.status !== "refund_pending") continue;
    const t = Date.parse(e.createdAt);
    if (Number.isNaN(t) || t < from || t > now.getTime() + 60000) continue;
    cents += Math.round(Number(e.amount.value) * 100);
  }
  return cents / 100;
}

/** Stores the family has paid before, plus the ones the parent trusts. */
export function knownMerchants(mandate: SignedMandate | null, ledger: PolicyInput["ledger"]): Set<string> {
  const known = new Set<string>((mandate?.trustedMerchants ?? []).map(normalizeMerchant));
  for (const e of ledger) {
    if (e.status === "paid" || e.status === "refunded" || e.status === "refund_pending") known.add(normalizeMerchant(e.product.merchant));
  }
  return known;
}

export function budgetStatus(mandate: SignedMandate | null, ledger: PolicyInput["ledger"], now: Date = new Date()) {
  const limit = mandate?.weeklyBudget ?? 0;
  const spent = round2(spentThisWeek(ledger, now));
  return { limit, spent, remaining: round2(Math.max(0, limit - spent)) };
}

function findRules<K extends Rule["kind"]>(mandate: SignedMandate, kind: K): Extract<Rule, { kind: K }>[] {
  return mandate.rules.filter((r) => r.kind === kind) as Extract<Rule, { kind: K }>[];
}

export function evaluatePurchase(input: PolicyInput): Decision {
  const now = input.now ?? new Date();
  const price = round2(input.product.price);
  const merchant = normalizeMerchant(input.product.merchant);
  const { category, confidence } = input.classification;
  const mandate = input.mandate;
  const checks: PolicyCheck[] = [];
  const b = budgetStatus(mandate, input.ledger, now);
  const budget = { ...b, afterPurchase: round2(b.remaining - price) };
  const parent = mandate?.parent.name ?? "your parent";
  const teen = mandate?.teen.name ?? "your teen";

  const base = {
    checks,
    budget,
    category,
    confidence,
    price,
    merchant,
    mandateVersion: mandate?.version ?? 0,
    evaluatedAt: now.toISOString(),
  };
  const done = (d: Pick<Decision, "outcome" | "code" | "ruleN" | "ruleText" | "summary" | "teenLine" | "parentLine">): Decision => ({ ...base, ...d });

  /* 1. Is there a live, untampered mandate? */
  if (!mandate) {
    checks.push({ name: "mandate_active", pass: false, detail: "No signed mandate.", ruleN: null });
    return done({
      outcome: "blocked",
      code: "mandate_missing",
      ruleN: null,
      ruleText: null,
      summary: "Blocked: there is no signed mandate yet.",
      teenLine: "I can't buy anything yet. A parent has to sign the rules first.",
      parentLine: "No mandate has been signed, so Kip cannot pay.",
    });
  }
  const sig = input.skipSignatureCheck ? { ok: true, reason: "Signature check skipped (test)." } : verifyMandate(mandate);
  checks.push({ name: "signature", pass: sig.ok, detail: sig.reason, ruleN: null });
  if (!sig.ok) {
    return done({
      outcome: "blocked",
      code: "signature_invalid",
      ruleN: null,
      ruleText: null,
      summary: "Blocked: the mandate signature is not valid.",
      teenLine: `Something is off with the rules ${parent} signed, so I have stopped buying until they are signed again.`,
      parentLine: `The mandate signature did not verify (${sig.reason}). Sign the rules again to let Kip buy.`,
    });
  }
  const expired = Date.parse(mandate.expiresAt) <= now.getTime();
  checks.push({ name: "expiry", pass: !expired, detail: expired ? `Expired ${mandate.expiresAt.slice(0, 10)}.` : `Valid until ${mandate.expiresAt.slice(0, 10)}.`, ruleN: null });
  if (expired) {
    return done({
      outcome: "blocked",
      code: "mandate_expired",
      ruleN: null,
      ruleText: null,
      summary: "Blocked: the mandate has expired.",
      teenLine: `The rules ${parent} signed have expired, so I can't buy until they are renewed.`,
      parentLine: "The mandate has expired. Review and sign it again to let Kip buy.",
    });
  }
  checks.push({ name: "mandate_active", pass: !input.paused, detail: input.paused ? "Paused by a parent." : `Mandate v${mandate.version} is active.`, ruleN: null });
  if (input.paused) {
    return done({
      outcome: "blocked",
      code: "mandate_paused",
      ruleN: null,
      ruleText: null,
      summary: "Blocked: the mandate is paused.",
      teenLine: `${parent} has paused my spending, so I can't buy anything right now. I can still help you compare things.`,
      parentLine: "You paused the mandate. Kip will not pay until you resume it.",
    });
  }

  /* 2. Hard stops: blocked stores and blocked categories. */
  const blocks = findRules(mandate, "block");
  const merchantBlock = blocks.find((r: BlockRule) => r.merchants.some((m) => merchant === m || merchant.endsWith("." + m)));
  checks.push({ name: "blocked_merchant", pass: !merchantBlock, detail: merchantBlock ? `${merchant} is blocked.` : `${merchant} is not a blocked store.`, ruleN: merchantBlock?.n ?? null });
  if (merchantBlock) {
    return done({
      outcome: "blocked",
      code: "blocked_merchant",
      ruleN: merchantBlock.n,
      ruleText: merchantBlock.text,
      summary: `Blocked by rule ${merchantBlock.n}: ${merchantBlock.text}`,
      teenLine: `I can't buy from ${merchant}. Rule ${merchantBlock.n} says ${quote(merchantBlock.text)}.`,
      parentLine: `Blocked: ${merchant} is a blocked store under rule ${merchantBlock.n}.`,
    });
  }
  const categoryBlock = blocks.find((r: BlockRule) => r.categories.includes(category));
  if (categoryBlock && confidence >= CONFIDENCE_TO_BLOCK) {
    checks.push({ name: "blocked_category", pass: false, detail: `${CATEGORY_LABEL[category]} is blocked.`, ruleN: categoryBlock.n });
    return done({
      outcome: "blocked",
      code: "blocked_category",
      ruleN: categoryBlock.n,
      ruleText: categoryBlock.text,
      summary: `Blocked by rule ${categoryBlock.n}: ${categoryBlock.text}`,
      teenLine: `I can't buy this one. Rule ${categoryBlock.n} says ${quote(categoryBlock.text)}.`,
      parentLine: `Blocked: this is ${CATEGORY_LABEL[category].toLowerCase()}, which rule ${categoryBlock.n} does not allow.`,
    });
  }
  checks.push({ name: "blocked_category", pass: true, detail: `${CATEGORY_LABEL[category]} is not a blocked category.`, ruleN: null });

  /* 3. Is the classifier sure enough for Kip to act alone? */
  const sure = confidence >= CONFIDENCE_TO_ACT;
  checks.push({
    name: "classification",
    pass: sure,
    detail: `${CATEGORY_LABEL[category]} at ${(confidence * 100).toFixed(0)}% confidence (needs ${(CONFIDENCE_TO_ACT * 100).toFixed(0)}%).`,
    ruleN: null,
  });
  if (!sure) {
    return done({
      outcome: "needs_approval",
      code: "low_confidence",
      ruleN: null,
      ruleText: null,
      summary: "Needs a parent's OK: Kip is not sure which rule covers this.",
      teenLine: `I'm not sure which of ${parent}'s rules covers this, so I asked ${parent} to take a look.`,
      parentLine: `Kip could not tell with confidence what kind of item this is (best guess: ${CATEGORY_LABEL[category].toLowerCase()}, ${(confidence * 100).toFixed(0)}%). ${teen} needs your OK.`,
    });
  }

  /* 4. Is the category covered by an allow rule, and inside its cap? */
  const allow = findRules(mandate, "allow").find((r: AllowRule) => r.categories.includes(category));
  checks.push({
    name: "allowed_category",
    pass: Boolean(allow),
    detail: allow ? `Covered by rule ${allow.n}.` : `No rule covers ${CATEGORY_LABEL[category].toLowerCase()}.`,
    ruleN: allow?.n ?? null,
  });
  if (!allow) {
    return done({
      outcome: "needs_approval",
      code: "category_not_covered",
      ruleN: null,
      ruleText: "Anything the rules do not cover needs a parent's OK",
      summary: `Needs a parent's OK: no rule covers ${CATEGORY_LABEL[category].toLowerCase()}.`,
      teenLine: `${parent}'s rules don't cover ${CATEGORY_LABEL[category].toLowerCase()}, so this one needs ${parent}'s OK.`,
      parentLine: `None of your rules covers ${CATEGORY_LABEL[category].toLowerCase()}. ${teen} needs your OK for this one.`,
    });
  }
  const overCap = allow.perItemCap !== null && price > allow.perItemCap;
  checks.push({
    name: "item_cap",
    pass: !overCap,
    detail: allow.perItemCap === null ? "No per-item cap for this category." : `${usd(price)} against a ${usd(allow.perItemCap)} cap.`,
    ruleN: allow.n,
  });
  if (overCap && allow.perItemCap !== null) {
    const over = round2(price - allow.perItemCap);
    return done({
      outcome: "needs_approval",
      code: "over_item_cap",
      ruleN: allow.n,
      ruleText: allow.text,
      summary: `Needs a parent's OK: ${usd(over)} over the cap in rule ${allow.n}.`,
      teenLine: `This is ${usd(price)}, and rule ${allow.n} says ${quote(allow.text)}. It needs ${parent}'s OK.`,
      parentLine: `This is ${usd(over)} over the ${usd(allow.perItemCap)} cap in rule ${allow.n}: ${quote(allow.text)}.`,
    });
  }

  /* 5. Approval thresholds and store rules. */
  const known = knownMerchants(mandate, input.ledger);
  const isNewMerchant = !known.has(merchant);
  const approvalHit = findRules(mandate, "approval").find((r: ApprovalRule) => {
    if (r.categories.length > 0 && !r.categories.includes(category)) return false;
    if (r.overAmount !== null && !(price > r.overAmount)) return false;
    if (r.when === "new_merchant" && !isNewMerchant) return false;
    return true;
  });
  checks.push({
    name: "merchant_rule",
    pass: !approvalHit,
    detail: approvalHit
      ? `Rule ${approvalHit.n} applies: ${usd(price)} at ${merchant}${isNewMerchant ? ", a store the family has not used before" : ""}.`
      : `${merchant} is ${isNewMerchant ? "a new store, but no approval rule applies at this price" : "a store the family has used before"}.`,
    ruleN: approvalHit?.n ?? null,
  });
  if (approvalHit) {
    return done({
      outcome: "needs_approval",
      code: "approval_rule",
      ruleN: approvalHit.n,
      ruleText: approvalHit.text,
      summary: `Needs a parent's OK under rule ${approvalHit.n}: ${approvalHit.text}`,
      teenLine: `Rule ${approvalHit.n} says ${quote(approvalHit.text)}. This is ${usd(price)} at ${merchant}, so it needs ${parent}'s OK.`,
      parentLine: `Rule ${approvalHit.n} applies: ${quote(approvalHit.text)}. This is ${usd(price)} at ${merchant}${approvalHit.when === "new_merchant" ? ", a store you have not used before" : ""}.`,
    });
  }

  /* 6. Is there enough budget left this week? */
  const budgetRule = findRules(mandate, "budget")[0] as BudgetRule | undefined;
  const fits = price <= budget.remaining;
  checks.push({
    name: "weekly_budget",
    pass: fits,
    detail: `${usd(price)} against ${usd(budget.remaining)} left of ${usd(budget.limit)} this week.`,
    ruleN: budgetRule?.n ?? null,
  });
  if (!fits) {
    const short = round2(price - budget.remaining);
    return done({
      outcome: "needs_approval",
      code: "over_budget",
      ruleN: budgetRule?.n ?? null,
      ruleText: budgetRule?.text ?? `Up to ${usd(budget.limit)} a week`,
      summary: `Needs a parent's OK: ${usd(short)} over this week's budget.`,
      teenLine: `You have ${usd(budget.remaining)} left this week and this is ${usd(price)}, so it needs ${parent}'s OK.`,
      parentLine: `This would go ${usd(short)} over the weekly budget (${usd(budget.spent)} of ${usd(budget.limit)} already spent).`,
    });
  }

  return done({
    outcome: "auto_approved",
    code: "ok",
    ruleN: allow.n,
    ruleText: allow.text,
    summary: `Paid under rule ${allow.n}: ${allow.text}`,
    teenLine: `This fits rule ${allow.n} (${quote(allow.text)}), so I can pay right away.`,
    parentLine: `Allowed by rule ${allow.n}: ${quote(allow.text)}.`,
  });
}

/**
 * Screens a request before any product is found, for example "top up my
 * game account". Returns a blocked decision or null to carry on.
 */
export function screenRequest(input: Omit<PolicyInput, "product"> & { what: string }): Decision | null {
  const d = evaluatePurchase({ ...input, product: { title: input.what, price: 0, merchant: "unknown" } });
  if (d.outcome === "blocked") return d;
  return null;
}

export type PaymentAuthorization = { ok: true; by: "mandate" | "parent" } | { ok: false; reason: string };

/**
 * The single gate in front of PayPal. A payment may go ahead only when the
 * policy said "auto_approved", or when it said "needs_approval" and a parent
 * approved this exact product at this price or less.
 */
export function authorizePayment(decision: Decision, productId: string, approval?: Pick<Approval, "status" | "product" | "amount"> | null): PaymentAuthorization {
  if (decision.outcome === "auto_approved") return { ok: true, by: "mandate" };
  if (decision.outcome === "blocked") return { ok: false, reason: decision.summary };
  if (!approval) return { ok: false, reason: "This purchase needs a parent's OK first." };
  if (approval.status !== "approved") return { ok: false, reason: "The parent has not approved this purchase." };
  if (approval.product.id !== productId) return { ok: false, reason: "The approval is for a different product." };
  if (decision.price > Number(approval.amount.value) + 0.001) return { ok: false, reason: "The price went up after the parent approved it." };
  return { ok: true, by: "parent" };
}

export function canUndo(entry: Pick<LedgerEntry, "status" | "createdAt" | "paypal">, now: Date = new Date()): { ok: boolean; reason: string } {
  if (entry.status !== "paid") return { ok: false, reason: entry.status === "refunded" ? "Already refunded." : "Only paid purchases can be undone." };
  if (!entry.paypal.captureId) return { ok: false, reason: "No PayPal capture to refund." };
  const age = now.getTime() - Date.parse(entry.createdAt);
  if (age > UNDO_WINDOW_MS) return { ok: false, reason: "The 24 hour undo window has passed." };
  return { ok: true, reason: "Inside the 24 hour undo window." };
}
