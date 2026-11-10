/**
 * The whole flow, offline. The application code runs for real (agent loop,
 * policy check, guarded payment, ledger) while PayPal, Channel3 and the
 * model answer from the recorded Replay tapes. No network, no keys.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { refreshSummary, resolveApproval, setPaused, undoPurchase } from "@/lib/actions";
import { handleTeenMessage } from "@/lib/agent/kip";
import { draftMandate } from "@/lib/ai/mandate-parser";
import { newContext, runWithContext } from "@/lib/context";
import { DEFAULT_DRAFT, SCRIPTED_PROMPTS } from "@/lib/demo/defaults";
import { normalizeDraft } from "@/lib/mandate/schema";
import { verifyMandate } from "@/lib/mandate/sign";
import { createPaymentToken, createSetupToken } from "@/lib/paypal/vault";
import { loadTape, tapeInfo } from "@/lib/replay/tapes";
import { ReplayMiss } from "@/lib/replay/vcr";
import { flushLogs, loadSession, resetSession, toClient } from "@/lib/session";
import { useMemoryStore } from "@/lib/store";
import type { SessionState } from "@/lib/types";

const SID = "replaytestsession";

function inReplay<T>(scenario: string | null, fn: () => Promise<T>): Promise<T> {
  const c = newContext({ sid: SID, mode: "replay", feature: "test" });
  const tape = scenario ? loadTape(scenario) : null;
  c.tape = { mode: "replay", tape: tape ?? { scenario: "none", recordedAt: "", note: "", exchanges: [] }, used: new Set() };
  return runWithContext(c, async () => {
    try {
      return await fn();
    } finally {
      await flushLogs();
    }
  });
}

const prompt = (slug: string) => SCRIPTED_PROMPTS.find((p) => p.slug === slug)!.text;
let state: SessionState;

beforeAll(async () => {
  process.env.MANDATE_SIGNING_SECRET = "test-secret-test-secret-test-secret-1234";
  useMemoryStore();
  state = await inReplay(null, () => resetSession(SID, "replay"));
});

describe("replay fixtures", () => {
  it("are all recorded", () => {
    for (const t of tapeInfo()) expect(t.exchanges, `${t.scenario} is empty, run pnpm replay:record`).toBeGreaterThan(0);
  });

  it("start from the seeded family: saved PayPal, signed mandate, three past purchases", () => {
    expect(state.vault?.source).toBe("replay");
    expect(verifyMandate(state.mandate).ok).toBe(true);
    expect(state.ledger).toHaveLength(3);
    expect(toClient(state).budget).toEqual({ limit: 60, spent: 23.25, remaining: 36.75 });
  });
});

describe("the aha, end to end", () => {
  it("buys notebooks at once, under the school supplies rule, with a PayPal capture", async () => {
    const s = await inReplay("chat-notebooks", () => handleTeenMessage({ text: prompt("notebooks"), slug: "notebooks" }));
    const reply = s.chat.at(-1)!;
    const receipt = reply.cards.find((c) => c.type === "receipt");
    expect(receipt, "a receipt card").toBeTruthy();
    const entry = s.ledger.find((e) => e.replaySlug === "notebooks")!;
    expect(entry.status).toBe("paid");
    expect(entry.approvedBy).toBe("mandate");
    expect(entry.decision.summary).toBe("Paid under rule 2: School supplies and books any time");
    expect(entry.paypal.orderId).toMatch(/^[A-Z0-9]{17}$/);
    expect(entry.paypal.captureId).toMatch(/^[A-Z0-9]{17}$/);
    expect(entry.paypal.via).toBe("agent-toolkit");
    expect(entry.retailerHandoff.simulated).toBe(true);
    // The charge equals the Channel3 offer price, never a number from the model.
    const products = reply.cards.find((c) => c.type === "products");
    const picked = products && products.type === "products" ? products.products.find((p) => p.id === entry.product.id) : null;
    expect(picked?.best?.price.toFixed(2)).toBe(entry.amount.value);
    expect(products && products.type === "products" ? products.source : "").toBe("channel3");
    // Every PayPal call was logged for Under the hood, with a debug id.
    const calls = s.paypalCalls.filter((c) => c.feature === "test");
    expect(calls.some((c) => c.method === "POST" && c.path === "/v2/checkout/orders" && c.status === 201 && c.debugId)).toBe(true);
    expect(calls.every((c) => c.replay)).toBe(true);
  });

  it("sends $55 sneakers to the parent instead of paying", async () => {
    const before = (await inReplay(null, () => loadSession(SID, "replay"))).paypalCalls.length;
    const s = await inReplay("chat-sneakers", () => handleTeenMessage({ text: prompt("sneakers"), slug: "sneakers" }));
    const approval = s.approvals.find((a) => a.replaySlug === "sneakers")!;
    expect(approval.status).toBe("pending");
    expect(approval.decision.outcome).toBe("needs_approval");
    expect(approval.decision.code).toBe("over_item_cap");
    expect(approval.decision.ruleText).toBe("Clothes up to $40 an item");
    expect(Number(approval.amount.value)).toBeGreaterThan(40);
    expect(approval.kipReasoning.length).toBeGreaterThan(20);
    expect(approval.suggestedRule?.patch.type).toBe("raise_cap");
    expect(s.ledger.find((e) => e.id === approval.ledgerId)?.status).toBe("pending_approval");
    // Nothing reached PayPal while waiting.
    expect(s.paypalCalls.length).toBe(before);
    // Channel3 "similar products" offered something inside the rules.
    const similar = s.chat.at(-1)!.cards.find((c) => c.type === "products" && c.mode === "similar");
    if (similar && similar.type === "products") for (const p of similar.products) expect(similar.policy[p.id].outcome).toBe("auto_approved");
  });

  it("pays after the parent approves, and only once", async () => {
    const s0 = await inReplay(null, () => loadSession(SID, "replay"));
    const approval = s0.approvals.find((a) => a.replaySlug === "sneakers")!;
    const { state: s } = await inReplay("approve-sneakers", () => resolveApproval(approval.id, "approve"));
    const entry = s.ledger.find((e) => e.id === approval.ledgerId)!;
    expect(entry.status).toBe("paid");
    expect(entry.approvedBy).toBe("parent");
    expect(entry.paypal.captureId).toBeTruthy();
    expect(s.chat.at(-1)!.text).toContain("approved");
    await expect(inReplay("approve-sneakers", () => resolveApproval(approval.id, "approve"))).rejects.toThrow(/Already approved/);
  });

  it("refuses a gaming gift card in code, before any search or charge", async () => {
    const before = await inReplay(null, () => loadSession(SID, "replay"));
    const s = await inReplay("chat-gaming", () => handleTeenMessage({ text: prompt("gaming"), slug: "gaming" }));
    const reply = s.chat.at(-1)!;
    const blocked = reply.cards.find((c) => c.type === "blocked");
    expect(blocked && blocked.type === "blocked" ? blocked.ruleText : null).toBe("No gaming or gift cards");
    expect(blocked && blocked.type === "blocked" ? blocked.ruleN : null).toBe(4);
    expect(s.paypalCalls.length).toBe(before.paypalCalls.length);
    expect(s.channel3Calls.length).toBe(before.channel3Calls.length);
    expect(s.ledger[0].status).toBe("blocked");
  });

  it("undoes the notebooks with a PayPal refund and gives the money back to the week", async () => {
    const s0 = await inReplay(null, () => loadSession(SID, "replay"));
    const entry = s0.ledger.find((e) => e.replaySlug === "notebooks")!;
    const spentBefore = toClient(s0).budget.spent;
    const s = await inReplay("undo-notebooks", () => undoPurchase(entry.id));
    const after = s.ledger.find((e) => e.id === entry.id)!;
    expect(after.status).toBe("refunded");
    expect(after.paypal.refundId).toMatch(/^[A-Z0-9]{17}$/);
    expect(toClient(s).budget.spent).toBeCloseTo(spentBefore - Number(entry.amount.value), 2);
    await expect(inReplay("undo-notebooks", () => undoPurchase(entry.id))).rejects.toThrow();
  });

  it("stops buying the moment the parent pauses", async () => {
    await inReplay(null, () => setPaused(true));
    const s = await inReplay("chat-notebooks", () => handleTeenMessage({ text: prompt("notebooks"), slug: "notebooks" }));
    const reply = s.chat.at(-1)!;
    expect(reply.cards.some((c) => c.type === "receipt")).toBe(false);
    expect(reply.cards.some((c) => c.type === "blocked")).toBe(true);
    expect(s.ledger[0].status).toBe("blocked");
    expect(s.ledger[0].decision.code).toBe("mandate_paused");
    await inReplay(null, () => setPaused(false));
  });
});

describe("the other AI jobs", () => {
  it("turns the plain-English rules into the same mandate the demo family signed", async () => {
    const draft = await inReplay("mandate-draft", () => draftMandate("Up to $60 a week. School supplies and books any time. Clothes up to $40 an item. No gaming or gift cards. Anything over $25 from a store we haven't used before needs my OK."));
    const expected = normalizeDraft(DEFAULT_DRAFT);
    expect(draft.weeklyBudget).toBe(60);
    expect(draft.rules.map((r) => r.kind)).toEqual(expected.rules.map((r) => r.kind));
    const cap = draft.rules.find((r) => r.kind === "allow" && r.categories.includes("clothing"));
    expect(cap && cap.kind === "allow" ? cap.perItemCap : null).toBe(40);
    const block = draft.rules.find((r) => r.kind === "block");
    expect(block && block.kind === "block" ? [...block.categories].sort() : []).toEqual(["gaming", "gift_cards"]);
    const ask = draft.rules.find((r) => r.kind === "approval");
    expect(ask && ask.kind === "approval" ? [ask.overAmount, ask.when] : []).toEqual([25, "new_merchant"]);
  });

  it("writes the weekly note with numbers taken from the ledger", async () => {
    const s = await inReplay("summary", () => refreshSummary());
    expect(s.summary?.text.length).toBeGreaterThan(40);
    expect(s.summary?.model).toBeTruthy();
    expect(s.summary?.facts.budget).toBe("$60.00");
  });

  it("replays the Vault save without exposing a real token", async () => {
    await inReplay("vault-save", async () => {
      const setup = await createSetupToken({ returnUrl: "https://example.com/r", cancelUrl: "https://example.com/c" });
      expect(setup.status).toBe("PAYER_ACTION_REQUIRED");
      const vault = await createPaymentToken(setup.id, "replay");
      expect(vault.paymentTokenId).toBe("replay0vault0token");
      expect(vault.kind).toBe("paypal");
    });
  });
});

describe("outside the recording", () => {
  it("fails loudly instead of inventing a response", async () => {
    await expect(inReplay(null, () => createSetupToken({ returnUrl: "https://example.com/r", cancelUrl: "https://example.com/c" }))).rejects.toBeInstanceOf(ReplayMiss);
  });
});
