/**
 * What the parent can do: sign or change the mandate, approve or decline,
 * undo a purchase (a PayPal refund), pause Kip, and refresh money state
 * from PayPal.
 */
import { randomUUID } from "node:crypto";
import { writeWeeklySummary } from "./ai/summary";
import { ctx, logStep } from "./context";
import { pay, type PurchaseResult } from "./agent/guard";
import { CATEGORY_LABEL } from "./mandate/categories";
import { canUndo, evaluatePurchase, usd } from "./mandate/policy";
import { buildMandateBody, normalizeMerchant } from "./mandate/schema";
import { bodyOf, signMandate, verifyMandate } from "./mandate/sign";
import { PayPalError, PayPalUnknownOutcome, requestIdFor } from "./paypal/core";
import { alreadyRefunded, getCapture, refundCapture } from "./paypal/orders";
import { loadSession, mutateSession } from "./session";
import type { ChatMessage, LedgerEntry, Rule, RulePatch, SessionState, SignedMandate, VaultInfo } from "./types";

export class ActionError extends Error {
  constructor(
    message: string,
    public httpStatus: number = 400,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

export function kipSays(text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "msg_" + randomUUID().slice(0, 10), at: new Date().toISOString(), role: "kip", text, image: null, cards: [], ai: null, mood: "idle", voice: null, ...extra };
}

/* ----------------------------- mandate ----------------------------- */

export async function signNewMandate(input: { rulesText: string; rules: Rule[]; weeklyBudget: number; expiresInDays: number }): Promise<SessionState> {
  const c = ctx();
  return mutateSession(c.sid, c.mode, (s) => {
    const version = (s.mandate?.version ?? 0) + 1;
    const body = buildMandateBody({
      id: s.mandate?.id ?? "mnd_" + randomUUID().slice(0, 8),
      version,
      rulesText: input.rulesText,
      rules: input.rules,
      weeklyBudget: input.weeklyBudget,
      expiresInDays: input.expiresInDays,
      trustedMerchants: s.mandate?.trustedMerchants ?? [],
      parent: s.family.parent,
      teen: s.family.teen,
    });
    s.mandate = signMandate(body, s.family.parent.name);
    s.mandateHistory.unshift({ version, signedAt: s.mandate.signature.signedAt, digest: s.mandate.signature.digest, note: version === 1 ? `Signed by ${s.family.parent.name} during setup.` : `Rules rewritten and signed again by ${s.family.parent.name}.` });
    s.paused = null;
    if (version > 1) s.chat.push(kipSays(`${s.family.parent.name} updated the rules (mandate v${version}). I will follow the new ones from now on.`, { mood: "idle" }));
  });
}

/** Applies a one-tap rule change and returns the new, re-signed mandate. */
export function amendMandate(m: SignedMandate, patch: RulePatch, text: string, signedBy: string): SignedMandate {
  const body = bodyOf(m);
  const rules: Rule[] = body.rules.map((r) => ({ ...r }));
  let trusted = [...body.trustedMerchants];
  let weeklyBudget = body.weeklyBudget;
  const nextN = Math.max(0, ...rules.map((r) => r.n)) + 1;
  switch (patch.type) {
    case "raise_cap": {
      const rule = rules.find((r) => r.kind === "allow" && r.categories.includes(patch.category));
      if (rule && rule.kind === "allow") {
        if (rule.categories.length === 1) {
          rule.perItemCap = patch.cap;
          rule.text = text;
        } else {
          // Split the category out so the other categories keep their cap.
          rule.categories = rule.categories.filter((c) => c !== patch.category);
          rules.push({ kind: "allow", n: nextN, text, categories: [patch.category], perItemCap: patch.cap });
        }
      } else {
        rules.push({ kind: "allow", n: nextN, text, categories: [patch.category], perItemCap: patch.cap });
      }
      break;
    }
    case "allow_category":
      rules.push({ kind: "allow", n: nextN, text, categories: [patch.category], perItemCap: patch.cap });
      break;
    case "trust_merchant":
      trusted = [...new Set([...trusted, normalizeMerchant(patch.merchant)])];
      break;
    case "raise_budget": {
      weeklyBudget = patch.weeklyLimit;
      const b = rules.find((r) => r.kind === "budget");
      if (b && b.kind === "budget") {
        b.weeklyLimit = patch.weeklyLimit;
        b.text = text;
      }
      break;
    }
  }
  const now = new Date();
  return signMandate({ ...body, version: body.version + 1, rules, trustedMerchants: trusted, weeklyBudget, createdAt: now.toISOString() }, signedBy, now);
}

export async function setPaused(paused: boolean): Promise<SessionState> {
  const c = ctx();
  return mutateSession(c.sid, c.mode, (s) => {
    if (!s.mandate) throw new ActionError("There is no mandate to pause yet.");
    if (paused && !s.paused) {
      s.paused = { at: new Date().toISOString(), by: s.family.parent.name };
      s.chat.push(kipSays(`${s.family.parent.name} just paused my spending. I can still look things up and compare, but I won't buy anything until it is switched back on.`, { mood: "paused", voice: "paused" }));
    } else if (!paused && s.paused) {
      s.paused = null;
      s.chat.push(kipSays(`${s.family.parent.name} switched spending back on. Same rules as before.`, { mood: "happy" }));
    }
  });
}

/* ----------------------------- vault ----------------------------- */

export async function saveVault(v: VaultInfo): Promise<SessionState> {
  const c = ctx();
  return mutateSession(c.sid, c.mode, (s) => {
    s.vault = v;
  });
}

/* ----------------------------- approvals ----------------------------- */

export async function resolveApproval(approvalId: string, action: "approve" | "decline" | "approve_and_add_rule"): Promise<{ state: SessionState; result: PurchaseResult | null }> {
  const c = ctx();
  const before = await loadSession(c.sid, c.mode);
  const approval = before.approvals.find((a) => a.id === approvalId);
  if (!approval) throw new ActionError("That approval request does not exist.", 404);
  if (approval.status !== "pending") throw new ActionError(`Already ${approval.status}.`, 409);
  const parent = before.family.parent.name;

  if (action === "decline") {
    const state = await mutateSession(c.sid, c.mode, (s) => {
      const a = s.approvals.find((x) => x.id === approvalId);
      if (!a || a.status !== "pending") throw new ActionError("Already resolved.", 409);
      a.status = "declined";
      a.resolvedAt = new Date().toISOString();
      const e = s.ledger.find((x) => x.id === a.ledgerId);
      if (e) {
        e.status = "declined";
        e.events.push({ at: a.resolvedAt, text: `${parent} declined.` });
      }
      s.chat.push(kipSays(`${parent} said no to the ${shortTitle(a.product.title)} this time. Nothing was charged. Want me to look for something that fits the rules?`, { mood: "sorry", voice: "declined" }));
    });
    return { state, result: null };
  }

  if (before.paused) throw new ActionError("The mandate is paused. Resume it before approving a purchase.", 409);
  const sig = verifyMandate(before.mandate);
  if (!sig.ok) throw new ActionError(sig.reason, 409);

  // Claim: flip the approval to "approved" first. A second tap finds it
  // already approved and stops here, before PayPal.
  let addedRule: string | null = null;
  await mutateSession(c.sid, c.mode, (s) => {
    const a = s.approvals.find((x) => x.id === approvalId);
    if (!a || a.status !== "pending") throw new ActionError("Already resolved.", 409);
    a.status = "approved";
    a.resolvedAt = new Date().toISOString();
    if (action === "approve_and_add_rule" && a.suggestedRule && s.mandate) {
      s.mandate = amendMandate(s.mandate, a.suggestedRule.patch, a.suggestedRule.text, parent);
      s.mandateHistory.unshift({ version: s.mandate.version, signedAt: s.mandate.signature.signedAt, digest: s.mandate.signature.digest, note: `${parent} added: "${a.suggestedRule.text}".` });
      addedRule = a.suggestedRule.text;
    }
    const e = s.ledger.find((x) => x.id === a.ledgerId);
    if (e) {
      e.status = "paying";
      e.events.push({ at: a.resolvedAt, text: `${parent} approved${addedRule ? ` and added a rule: "${addedRule}"` : ""}.` });
    }
  });

  const s2 = await loadSession(c.sid, c.mode);
  const a2 = s2.approvals.find((x) => x.id === approvalId);
  const entry = s2.ledger.find((x) => x.id === approval.ledgerId);
  if (!a2 || !entry) throw new ActionError("The purchase record is missing.", 500);

  // Run the policy again on today's state. Hard stops (paused, blocked)
  // still apply; the approval only covers "needs approval".
  const decision = evaluatePurchase({
    mandate: s2.mandate,
    paused: Boolean(s2.paused),
    product: { title: entry.product.title, price: Number(entry.amount.value), merchant: entry.product.merchant },
    classification: { category: approval.decision.category, confidence: approval.decision.confidence },
    ledger: s2.ledger.filter((x) => x.id !== entry.id),
  });
  logStep({ kind: "policy", title: `Policy re-check after ${parent}'s approval: ${decision.outcome.replace("_", " ")}`, detail: decision.summary, ms: null, model: null, data: { checks: decision.checks } });
  const result = await pay({ ledgerId: entry.id, decision, approval: a2 });

  const state = await mutateSession(c.sid, c.mode, (s) => {
    const a = s.approvals.find((x) => x.id === approvalId);
    if (result.status === "paid") {
      s.chat.push(
        kipSays(`${parent} approved it${addedRule ? ` and added a rule ("${addedRule}")` : ""}. Paid ${usd(Number(result.entry.amount.value))} for the ${shortTitle(result.entry.product.title)}.`, {
          mood: "happy",
          voice: "approved",
          cards: [{ type: "receipt", ledgerId: result.entry.id }],
        }),
      );
    } else if (a) {
      // The payment did not go through. Put the request back so the parent
      // can try again; nothing was charged.
      a.status = "pending";
      a.resolvedAt = null;
      const e = s.ledger.find((x) => x.id === a.ledgerId);
      if (e) e.status = "pending_approval";
    }
  });
  if (result.status !== "paid") throw new ActionError(result.status === "failed" ? result.reason : "The payment could not be made.", 502);
  return { state, result };
}

function shortTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  return t.length <= 48 ? t : t.slice(0, 45).trimEnd() + "...";
}

/* ----------------------------- undo (refund) ----------------------------- */

export async function undoPurchase(ledgerId: string): Promise<SessionState> {
  const c = ctx();
  const before = await loadSession(c.sid, c.mode);
  const entry = before.ledger.find((e) => e.id === ledgerId);
  if (!entry) throw new ActionError("That purchase does not exist.", 404);
  const check = canUndo(entry);
  if (!check.ok) throw new ActionError(check.reason, 409);
  const captureId = entry.paypal.captureId as string;
  const parent = before.family.parent.name;

  // Claim: mark the refund as in flight before calling PayPal.
  await mutateSession(c.sid, c.mode, (s) => {
    const e = s.ledger.find((x) => x.id === ledgerId);
    if (!e || e.status !== "paid") throw new ActionError("This purchase is already being undone.", 409);
    e.status = "refund_pending";
    e.events.push({ at: new Date().toISOString(), text: `${parent} tapped Undo. Asking PayPal for a refund.` });
  });

  const requestId = requestIdFor("refund", ledgerId);
  const note = `Undo by ${parent}: ${shortTitle(entry.product.title)}`;
  let refundId: string | null = null;
  let refundStatus = "COMPLETED";
  try {
    try {
      const r = await refundCapture({ captureId, requestId, note });
      refundId = r.refund.id;
      refundStatus = r.refund.status;
    } catch (err) {
      if (err instanceof PayPalUnknownOutcome) {
        // Unknown, not failed: ask again with the same request id.
        const r = await refundCapture({ captureId, requestId, note });
        refundId = r.refund.id;
        refundStatus = r.refund.status;
      } else if (alreadyRefunded(err)) {
        refundStatus = "COMPLETED";
      } else {
        throw err;
      }
    }
  } catch (err) {
    // Settle from what PayPal holds before reporting anything.
    let captureStatus: string | null = null;
    try {
      captureStatus = (await getCapture(captureId)).status;
    } catch {
      captureStatus = null;
    }
    if (captureStatus !== "REFUNDED") {
      await mutateSession(c.sid, c.mode, (s) => {
        const e = s.ledger.find((x) => x.id === ledgerId);
        if (e) {
          e.status = captureStatus === null ? "refund_pending" : "paid";
          e.events.push({ at: new Date().toISOString(), text: captureStatus === null ? "PayPal did not answer. Refund status unknown; it will be re-read." : "PayPal did not refund this purchase." });
        }
      });
      if (err instanceof PayPalError) throw new ActionError(`PayPal could not refund this: ${err.message} (debug id ${err.debugId ?? "none"})`, err.status === 401 || err.status === 403 ? 502 : err.status >= 500 ? 502 : 422);
      throw new ActionError("PayPal did not answer. The refund status is unknown and will be checked again.", 502);
    }
  }

  return mutateSession(c.sid, c.mode, (s) => {
    const e = s.ledger.find((x) => x.id === ledgerId);
    if (!e) return;
    const now = new Date().toISOString();
    e.status = refundStatus === "COMPLETED" ? "refunded" : "refund_pending";
    e.paypal.refundId = refundId;
    e.paypal.refundStatus = refundStatus;
    e.paypal.captureStatus = refundStatus === "COMPLETED" ? "REFUNDED" : e.paypal.captureStatus;
    e.paypal.lastSyncedAt = now;
    e.events.push({ at: now, text: `Refunded ${usd(Number(e.amount.value))} to ${parent}'s PayPal${refundId ? ` (refund ${refundId})` : ""}.` });
    s.chat.push(kipSays(`${parent} undid the ${shortTitle(e.product.title)}. ${usd(Number(e.amount.value))} went back to their PayPal, and it no longer counts against your week.`, { mood: "idle", voice: "undo", cards: [{ type: "receipt", ledgerId: e.id }] }));
  });
}

/* ----------------------------- re-read from PayPal ----------------------------- */

const SYNC_FRESH_MS = 20000;

/**
 * PayPal is the source of truth for money. Re-reads the captures behind the
 * most recent purchases so the dashboard is right even when no webhook has
 * arrived (or no public URL exists).
 */
export async function syncFromPayPal(max: number = 5): Promise<SessionState> {
  const c = ctx();
  const s = await loadSession(c.sid, c.mode);
  const now = Date.now();
  const due = s.ledger
    .filter((e) => e.paypal.captureId && ["paid", "refund_pending", "refunded"].includes(e.status))
    .filter((e) => !e.paypal.lastSyncedAt || now - Date.parse(e.paypal.lastSyncedAt) > SYNC_FRESH_MS)
    .filter((e) => e.status !== "refunded" || e.paypal.captureStatus !== "REFUNDED")
    .slice(0, max);
  if (due.length === 0) return s;
  const results = await Promise.all(
    due.map(async (e) => {
      try {
        return { id: e.id, capture: await getCapture(e.paypal.captureId as string) };
      } catch {
        return { id: e.id, capture: null };
      }
    }),
  );
  return mutateSession(c.sid, c.mode, (state) => {
    for (const r of results) {
      const e = state.ledger.find((x) => x.id === r.id);
      if (!e || !r.capture) continue;
      applyCaptureStatus(e, r.capture.status, "re-read from PayPal");
      e.paypal.lastSyncedAt = new Date().toISOString();
    }
  });
}

export function applyCaptureStatus(e: LedgerEntry, captureStatus: string, how: string): boolean {
  const prev = e.status;
  e.paypal.captureStatus = captureStatus;
  if (captureStatus === "REFUNDED" && e.status !== "refunded") e.status = "refunded";
  else if (captureStatus === "COMPLETED" && e.status === "paying") e.status = "paid";
  else if ((captureStatus === "DECLINED" || captureStatus === "FAILED") && e.status !== "failed") e.status = "failed";
  if (prev !== e.status) {
    e.events.push({ at: new Date().toISOString(), text: `Status is now ${e.status} (${how}: capture ${captureStatus}).` });
    return true;
  }
  return false;
}

/* ----------------------------- weekly summary ----------------------------- */

export async function refreshSummary(): Promise<SessionState> {
  const c = ctx();
  const s = await loadSession(c.sid, c.mode);
  const out = await writeWeeklySummary(s);
  return mutateSession(c.sid, c.mode, (state) => {
    state.summary = { text: out.text, model: out.model, at: new Date().toISOString(), facts: out.facts as unknown as Record<string, string | number> };
  });
}

export function describePatch(p: RulePatch): string {
  switch (p.type) {
    case "raise_cap":
      return `Raises the ${CATEGORY_LABEL[p.category].toLowerCase()} cap to ${usd(p.cap)} an item.`;
    case "allow_category":
      return `Allows ${CATEGORY_LABEL[p.category].toLowerCase()}${p.cap !== null ? ` up to ${usd(p.cap)} an item` : ""}.`;
    case "trust_merchant":
      return `Treats ${p.merchant} as a store you have used before.`;
    case "raise_budget":
      return `Raises the weekly budget to ${usd(p.weeklyLimit)}.`;
  }
}
