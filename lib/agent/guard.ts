/**
 * The guarded purchase. This is the only code path that can charge the
 * family's saved PayPal.
 *
 *   model picks a product id  ->  requestPurchase()
 *     1. the product must be one Channel3 returned in this session
 *     2. re-read price and offers from Channel3 product detail
 *     3. classify it (model) and run evaluatePurchase() (code)
 *     4. blocked        -> stop, record why
 *        needs approval -> create an approval card for the parent, stop
 *        auto approved  -> pay()
 *
 *   pay(): authorizePayment() must say yes, then
 *     claim (ledger entry "paying")  ->  PayPal call  ->  record result
 *
 * The PayPal-Request-Id is derived from the ledger entry id, so a retry of
 * the same purchase can never charge twice.
 */
import { randomUUID } from "node:crypto";
import { classifyProducts } from "../ai/classify";
import { chat } from "../ai/llm";
import { findSimilar, getProduct, isBuyable } from "../channel3/client";
import { ctx, logStep, status } from "../context";
import { CATEGORY_LABEL } from "../mandate/categories";
import { authorizePayment, evaluatePurchase, UNDO_WINDOW_MS, usd } from "../mandate/policy";
import { PayPalError, PayPalUnknownOutcome, requestIdFor } from "../paypal/core";
import { capturedOf, chargeVaultViaToolkit, getOrder, type Order } from "../paypal/orders";
import { indexCapture, loadSession, mutateSession } from "../session";
import type { Approval, Classification, Decision, LedgerEntry, Offer, ProductCard, RulePatch, SessionState } from "../types";

export type PurchaseResult =
  | { status: "paid"; entry: LedgerEntry; decision: Decision }
  | { status: "needs_approval"; approval: Approval; decision: Decision; alternatives: { product: ProductCard; decision: Decision }[] }
  | { status: "blocked"; decision: Decision; entry: LedgerEntry }
  | { status: "failed"; reason: string; entry: LedgerEntry | null };

const HANDOFF_NOTE = "Retailer order step is simulated in this prototype. Allowance charged the saved PayPal through its own sandbox merchant account and would hand off to the retailer through this Channel3 buy link.";

function newLedgerId(): string {
  return "led_" + randomUUID().replace(/-/g, "").slice(0, 12);
}

function productRef(card: ProductCard, offer: Offer): LedgerEntry["product"] {
  return { id: card.id, title: card.title, brand: card.brand, image: card.image, merchant: offer.domain, buyUrl: offer.url, price: offer.price };
}

export function decide(s: SessionState, card: ProductCard, offer: Offer, c: Classification, now: Date = new Date()): Decision {
  return evaluatePurchase({
    mandate: s.mandate,
    paused: Boolean(s.paused),
    product: { title: card.title, price: offer.price, merchant: offer.domain },
    classification: { category: c.category, confidence: c.confidence },
    ledger: s.ledger,
    now,
  });
}

/** Classifies products not classified yet and stores the result on the session. */
export async function ensureClassified(cards: ProductCard[]): Promise<Map<string, Classification>> {
  const c = ctx();
  const s = await loadSession(c.sid, c.mode);
  const out = new Map<string, Classification>();
  const todo: ProductCard[] = [];
  for (const card of cards) {
    const hit = s.seen[card.id]?.classification;
    if (hit) out.set(card.id, hit);
    else todo.push(card);
  }
  if (todo.length > 0) {
    const fresh = await classifyProducts(todo);
    for (const f of fresh) out.set(f.productId, f);
    await mutateSession(c.sid, c.mode, (st) => {
      const at = new Date().toISOString();
      for (const card of cards) st.seen[card.id] = { card, classification: out.get(card.id) ?? null, seenAt: at };
    });
  }
  return out;
}

function suggestRule(d: Decision, s: SessionState, product: LedgerEntry["product"]): Approval["suggestedRule"] {
  const price = Math.ceil(d.price / 5) * 5;
  let patch: RulePatch | null = null;
  let text = "";
  switch (d.code) {
    case "over_item_cap":
      patch = { type: "raise_cap", category: d.category, cap: price };
      text = `${CATEGORY_LABEL[d.category]} up to ${usd(price)} an item`;
      break;
    case "approval_rule":
      patch = { type: "trust_merchant", merchant: product.merchant };
      text = `${product.merchant} is a store we trust`;
      break;
    case "category_not_covered":
      patch = { type: "allow_category", category: d.category, cap: price };
      text = `${CATEGORY_LABEL[d.category]} up to ${usd(price)} an item`;
      break;
    case "over_budget":
      patch = { type: "raise_budget", weeklyLimit: Math.ceil((s.mandate?.weeklyBudget ?? 0) / 5) * 5 + Math.max(10, Math.ceil((d.price - d.budget.remaining) / 10) * 10) };
      text = `Up to ${usd(patch.weeklyLimit)} a week`;
      break;
    default:
      return null;
  }
  return { text, patch };
}

async function parentNote(s: SessionState, requestText: string, card: ProductCard, offer: Offer, kipReason: string): Promise<{ text: string; model: string | null }> {
  const fallback = `${s.family.teen.name} asked: "${requestText}". I found ${card.title} for ${usd(offer.price)} at ${offer.domain}.`;
  try {
    const r = await chat("parent-note", {
      messages: [
        {
          role: "system",
          content: `You are Kip, a shopping agent for a teenager. Write a short note to the parent, ${s.family.parent.name}, about one purchase that needs their OK. Two sentences, polite and precise, plain text, no greeting, no emoji, no dashes used as punctuation. Say what ${s.family.teen.name} asked for and why this item was picked. Refer to ${s.family.teen.name} by name only, never as he or she. State the price and store exactly as given. Do not say whether they should approve it, and do not mention rules: the card shows the rule separately.`,
        },
        { role: "user", content: JSON.stringify({ request: requestText, item: card.title, price: usd(offer.price), store: offer.domain, key_features: card.keyFeatures.slice(0, 2), why_picked: kipReason }) },
      ],
      maxTokens: 400,
      temperature: 0.2,
      effort: "none",
    });
    return { text: r.content, model: r.model };
  } catch {
    return { text: fallback, model: null };
  }
}

/** Finds similar products that the mandate would let Kip buy right now. */
async function alternativesInsideRules(s: SessionState, card: ProductCard, d: Decision): Promise<{ product: ProductCard; decision: Decision }[]> {
  if (!["over_item_cap", "over_budget", "approval_rule"].includes(d.code)) return [];
  const allow = s.mandate?.rules.find((r) => r.kind === "allow" && r.categories.includes(d.category));
  const cap = allow && allow.kind === "allow" && allow.perItemCap !== null ? allow.perItemCap : d.budget.remaining;
  const maxPrice = Math.max(1, Math.min(cap, d.budget.remaining));
  try {
    status("Kip is looking for something similar inside the rules", "thinking");
    const sim = await findSimilar({ productId: card.id, maxPrice, limit: 6 });
    const top = sim.products.slice(0, 4);
    if (top.length === 0) return [];
    const cls = await ensureClassified(top);
    const fresh = await loadSession(s.sid, s.mode);
    return top
      .map((p) => ({ product: p, decision: decide(fresh, p, p.best as Offer, cls.get(p.id) ?? { productId: p.id, category: "other", confidence: 0, source: "ai", model: null }) }))
      .filter((x) => x.decision.outcome === "auto_approved")
      .slice(0, 3);
  } catch {
    return [];
  }
}

export async function requestPurchase(input: { productId: string; requestText: string; kipReason: string; replaySlug?: string | null }): Promise<PurchaseResult> {
  const c = ctx();
  let s = await loadSession(c.sid, c.mode);
  const seen = s.seen[input.productId];
  if (!seen) return { status: "failed", reason: "I can only buy products from a search I just ran. Search first.", entry: null };

  /* Fresh price and offers from Channel3 product detail, right before paying. */
  status("Kip is checking offers across retailers", "thinking");
  let card = seen.card;
  try {
    const detail = await getProduct(input.productId);
    const usable = detail.product.offers.filter(isBuyable);
    // Stay with the store whose offer the teen was shown. Only if that
    // offer is gone does Kip fall back to the cheapest new, in-stock one.
    const sameStore = usable.find((o) => o.domain === seen.card.best?.domain);
    const fresh = sameStore ?? usable[0];
    if (fresh) {
      card = { ...seen.card, offers: detail.product.offers, best: fresh, keyFeatures: detail.product.keyFeatures.length > 0 ? detail.product.keyFeatures : seen.card.keyFeatures };
      if (seen.card.best && Math.abs(fresh.price - seen.card.best.price) > 0.005) {
        logStep({ kind: "note", title: "Price changed since the search", detail: `${usd(seen.card.best.price)} at ${seen.card.best.domain} is now ${usd(fresh.price)} at ${fresh.domain}. The rules are checked against the new price.`, ms: null, model: null });
      }
      logStep({ kind: "channel3", title: `Checked offers across ${detail.product.offers.length} retailer${detail.product.offers.length === 1 ? "" : "s"}`, detail: usable.slice(0, 3).map((o) => `${o.domain} ${usd(o.price)}`).join(", ") + (detail.cached ? " (cached)" : ""), ms: null, model: null });
    }
  } catch {
    logStep({ kind: "channel3", title: "Product detail unavailable, using the search result", detail: "Channel3 product detail did not answer.", ms: null, model: null });
  }
  const offer = card.best;
  if (!offer) return { status: "failed", reason: "That item is out of stock now.", entry: null };

  status("Kip is checking the rules", "thinking");
  const cls = (await ensureClassified([card])).get(card.id) ?? { productId: card.id, category: "other" as const, confidence: 0, source: "ai" as const, model: null };
  s = await loadSession(c.sid, c.mode);
  const decision = decide(s, card, offer, cls);
  logStep({
    kind: "policy",
    title: `Policy check: ${decision.outcome.replace("_", " ")}`,
    detail: decision.summary,
    ms: null,
    model: null,
    data: { checks: decision.checks, budget: decision.budget, category: decision.category, confidence: decision.confidence },
  });

  const base: Omit<LedgerEntry, "status" | "approvedBy" | "approvalId" | "events"> = {
    id: newLedgerId(),
    createdAt: new Date().toISOString(),
    requestText: input.requestText,
    product: productRef(card, offer),
    amount: { value: offer.price.toFixed(2), currency: "USD" },
    category: decision.category,
    decision,
    paypal: { orderId: null, captureId: null, orderStatus: null, captureStatus: null, refundId: null, refundStatus: null, payerEmail: null, invoiceId: null, lastSyncedAt: null, via: null },
    retailerHandoff: { simulated: true, buyUrl: offer.url, note: HANDOFF_NOTE },
    kipReason: input.kipReason,
    undoUntil: null,
    seeded: false,
    replaySlug: input.replaySlug ?? null,
  };

  if (decision.outcome === "blocked") {
    const entry: LedgerEntry = { ...base, status: "blocked", approvedBy: null, approvalId: null, events: [{ at: base.createdAt, text: decision.summary }] };
    await mutateSession(c.sid, c.mode, (st) => {
      st.ledger.unshift(entry);
    });
    return { status: "blocked", decision, entry };
  }

  if (decision.outcome === "needs_approval") {
    status(`Kip is asking ${s.family.parent.name}`, "wait");
    const [note, alternatives] = await Promise.all([parentNote(s, input.requestText, card, offer, input.kipReason), alternativesInsideRules(s, card, decision)]);
    const approval: Approval = {
      id: "apr_" + randomUUID().replace(/-/g, "").slice(0, 12),
      createdAt: base.createdAt,
      status: "pending",
      resolvedAt: null,
      requestText: input.requestText,
      product: base.product,
      amount: base.amount,
      category: decision.category,
      decision,
      kipReasoning: note.text,
      aiModel: note.model,
      suggestedRule: suggestRule(decision, s, base.product),
      ledgerId: base.id,
      replaySlug: input.replaySlug ?? null,
    };
    const entry: LedgerEntry = { ...base, status: "pending_approval", approvedBy: null, approvalId: approval.id, events: [{ at: base.createdAt, text: `Waiting for ${s.family.parent.name}: ${decision.summary}` }] };
    await mutateSession(c.sid, c.mode, (st) => {
      st.ledger.unshift(entry);
      st.approvals.unshift(approval);
    });
    return { status: "needs_approval", approval, decision, alternatives };
  }

  const entry: LedgerEntry = { ...base, status: "paying", approvedBy: "mandate", approvalId: null, events: [{ at: base.createdAt, text: "Mandate check passed. Paying with the saved PayPal." }] };
  // Claim first: the entry exists as "paying" before PayPal is called.
  await mutateSession(c.sid, c.mode, (st) => {
    st.ledger.unshift(entry);
  });
  return pay({ ledgerId: entry.id, decision, approval: null });
}

/**
 * Charges the saved PayPal for a claimed ledger entry. Requires a policy
 * decision that authorizePayment() accepts.
 */
export async function pay(input: { ledgerId: string; decision: Decision; approval: Approval | null }): Promise<PurchaseResult> {
  const c = ctx();
  const s = await loadSession(c.sid, c.mode);
  const entry = s.ledger.find((e) => e.id === input.ledgerId);
  if (!entry) return { status: "failed", reason: "The purchase record is missing.", entry: null };

  const fail = async (reason: string, statusText: LedgerEntry["status"] = "failed"): Promise<PurchaseResult> => {
    const st = await mutateSession(c.sid, c.mode, (state) => {
      const e = state.ledger.find((x) => x.id === input.ledgerId);
      if (e) {
        e.status = statusText;
        e.events.push({ at: new Date().toISOString(), text: reason });
      }
    });
    return { status: "failed", reason, entry: st.ledger.find((x) => x.id === input.ledgerId) ?? null };
  };

  const auth = authorizePayment(input.decision, entry.product.id, input.approval);
  if (!auth.ok) return fail(auth.reason);
  if (!s.vault) return fail(`${s.family.parent.name} has not saved a PayPal yet, so I can't pay.`);

  status("Kip is paying with the saved PayPal", "thinking");
  const requestId = requestIdFor("order", entry.id);
  const charge = {
    vaultId: s.vault.paymentTokenId,
    ledgerId: entry.id,
    invoiceId: `ALW-${entry.id.slice(4).toUpperCase()}`,
    title: entry.product.title,
    description: `Allowance: ${s.family.teen.name}'s purchase via Kip (${auth.by === "parent" ? "approved by parent" : `rule ${input.decision.ruleN}`})`,
    price: Number(entry.amount.value),
    requestId,
  };

  let order: Order;
  let via: "agent-toolkit" | "server-sdk";
  try {
    try {
      ({ order, via } = await chargeVaultViaToolkit(charge));
    } catch (err) {
      if (!(err instanceof PayPalUnknownOutcome)) throw err;
      // No answer from PayPal. The outcome is unknown, not failed. Ask
      // again with the same PayPal-Request-Id: PayPal returns the original
      // result if the first attempt went through.
      logStep({ kind: "paypal", title: "No answer from PayPal, re-reading with the same request id", detail: requestId, ms: null, model: null });
      ({ order, via } = await chargeVaultViaToolkit(charge));
    }
  } catch (err) {
    if (err instanceof PayPalUnknownOutcome) {
      const st = await mutateSession(c.sid, c.mode, (state) => {
        const e = state.ledger.find((x) => x.id === input.ledgerId);
        if (e) e.events.push({ at: new Date().toISOString(), text: "PayPal did not answer. Status unknown; it will be re-read." });
      });
      return { status: "failed", reason: "PayPal did not answer, so I don't know yet if this went through. I will check again before trying anything else.", entry: st.ledger.find((x) => x.id === input.ledgerId) ?? null };
    }
    if (err instanceof PayPalError) {
      const reason = err.declined
        ? `PayPal declined the saved payment method. ${s.family.parent.name} needs to check their PayPal.`
        : err.status === 401 || err.status === 403
          ? "PayPal did not accept this app's credentials."
          : `PayPal said no: ${err.message}`;
      return fail(`${reason} (debug id ${err.debugId ?? "none"})`);
    }
    return fail(`Something went wrong before PayPal could be reached: ${(err as Error).message}`);
  }

  let capture = capturedOf(order);
  if (!capture && order.status === "APPROVED") {
    const { captureOrder } = await import("../paypal/orders");
    order = await captureOrder(order.id, requestIdFor("capture", entry.id));
    capture = capturedOf(order);
  }
  if (!capture || !["COMPLETED", "PENDING"].includes(capture.status)) {
    return fail(`PayPal created order ${order.id} but did not capture it (status ${order.status}).`);
  }

  // Confirm with PayPal before telling anyone it is paid.
  let confirmed = order;
  try {
    confirmed = await getOrder(order.id);
  } catch {
    /* the create response is already authoritative */
  }
  const finalCapture = capturedOf(confirmed) ?? capture;
  const now = new Date().toISOString();
  const st = await mutateSession(c.sid, c.mode, (state) => {
    const e = state.ledger.find((x) => x.id === input.ledgerId);
    if (!e) return;
    e.status = "paid";
    e.approvedBy = auth.by;
    e.createdAt = now;
    e.undoUntil = new Date(Date.parse(now) + UNDO_WINDOW_MS).toISOString();
    e.paypal = {
      orderId: order.id,
      captureId: finalCapture.id,
      orderStatus: confirmed.status,
      captureStatus: finalCapture.status,
      refundId: null,
      refundStatus: null,
      payerEmail: order.payment_source?.paypal?.email_address ?? null,
      invoiceId: charge.invoiceId,
      lastSyncedAt: now,
      via,
    };
    e.events.push({ at: now, text: `PayPal order ${order.id} captured (${finalCapture.id}) for ${usd(Number(e.amount.value))}. ${auth.by === "parent" ? `Approved by ${state.family.parent.name}.` : input.decision.summary}` });
    e.events.push({ at: now, text: "Retailer handoff (simulated): buy link opened for the retailer order." });
  });
  await indexCapture(finalCapture.id, { sid: c.sid, mode: c.mode, ledgerId: input.ledgerId });
  const paid = st.ledger.find((x) => x.id === input.ledgerId) as LedgerEntry;
  return { status: "paid", entry: paid, decision: input.decision };
}
