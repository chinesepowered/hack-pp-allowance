/**
 * The write path to PayPal: claim, call, record. These tests fake only the
 * PayPal and catalog calls and check what the app does around them:
 * no call without a passing policy, one charge per claim, an unknown
 * outcome is re-read with the same PayPal-Request-Id and never reported as
 * a failure, and a declined wallet is not retried.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/paypal/orders", async (original) => {
  const real = await original<typeof import("@/lib/paypal/orders")>();
  return { ...real, chargeVaultViaToolkit: vi.fn(), getOrder: vi.fn(), refundCapture: vi.fn(), getCapture: vi.fn() };
});
vi.mock("@/lib/channel3/client", async (original) => {
  const real = await original<typeof import("@/lib/channel3/client")>();
  return { ...real, getProduct: vi.fn(async () => Promise.reject(new Error("catalog offline in this test"))), findSimilar: vi.fn(async () => ({ mode: "similar", query: "", filters: { maxPrice: null, availability: [] }, products: [], cached: false, cachedAt: null })) };
});
vi.mock("@/lib/ai/llm", async (original) => {
  const real = await original<typeof import("@/lib/ai/llm")>();
  return { ...real, chat: vi.fn(async () => ({ content: "A short note for the parent.", toolCalls: [], model: "test-model", ms: 1, usedFallback: false, tokens: null })) };
});

import { resolveApproval, undoPurchase } from "@/lib/actions";
import { requestPurchase } from "@/lib/agent/guard";
import { newContext, runWithContext } from "@/lib/context";
import { PayPalError, PayPalUnknownOutcome } from "@/lib/paypal/core";
import { chargeVaultViaToolkit, getCapture, getOrder, refundCapture, type Order } from "@/lib/paypal/orders";
import { handleWebhookEvent, verifyWebhookSignature } from "@/lib/paypal/webhooks";
import { defaultMandate, loadSession, mutateSession } from "@/lib/session";
import { useMemoryStore } from "@/lib/store";
import type { Category } from "@/lib/mandate/categories";
import type { ProductCard } from "@/lib/types";

const charge = vi.mocked(chargeVaultViaToolkit);
const reread = vi.mocked(getOrder);
const refund = vi.mocked(refundCapture);
const capture = vi.mocked(getCapture);

let sid = "";
let n = 0;

function completed(id: string, value: string): Order {
  return { id, status: "COMPLETED", payment_source: { paypal: { email_address: "buyer@example.com" } }, purchase_units: [{ payments: { captures: [{ id: `CAP${id}`, status: "COMPLETED", amount: { currency_code: "USD", value } }] } }] };
}

function product(id: string, price: number, domain = "papertrail.example"): ProductCard {
  const offer = { domain, url: `https://${domain}/p/${id}`, price, compareAtPrice: null, currency: "USD", availability: "InStock", condition: "new" };
  return { id, title: `Test product ${id}`, brand: null, image: null, description: null, sourceCategory: null, keyFeatures: [], offers: [offer], best: offer, rating: null };
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext(newContext({ sid, mode: "live", feature: "test" }), fn);
}

async function seed(items: { card: ProductCard; category: Category; confidence?: number }[], opts: { vault?: boolean } = {}) {
  await run(() =>
    mutateSession(sid, "live", (s) => {
      s.mandate = defaultMandate();
      s.vault = opts.vault === false ? null : { paymentTokenId: "vault-test-token", customerId: "c", payerEmail: "buyer@example.com", payerName: "Test Buyer", savedAt: new Date().toISOString(), source: "seed", kind: "paypal" };
      for (const i of items) s.seen[i.card.id] = { card: i.card, classification: { productId: i.card.id, category: i.category, confidence: i.confidence ?? 0.97, source: "ai", model: "test" }, seenAt: new Date().toISOString() };
    }),
  );
}

beforeEach(() => {
  process.env.MANDATE_SIGNING_SECRET = "test-secret-test-secret-test-secret-1234";
  useMemoryStore();
  n += 1;
  sid = `paytest${String(n).padStart(8, "0")}x`;
  charge.mockReset();
  reread.mockReset();
  refund.mockReset();
  capture.mockReset();
  reread.mockImplementation(async (id: string) => completed(id, "9.50"));
});

describe("auto approved purchases", () => {
  it("claims the purchase before calling PayPal, then records the capture", async () => {
    await seed([{ card: product("nb1", 9.5), category: "school_supplies" }]);
    let statusSeenByPayPal = "";
    charge.mockImplementation(async (input) => {
      // The claim must already be in the store when the request leaves.
      const s = await loadSession(sid, "live");
      statusSeenByPayPal = s.ledger.find((e) => e.id === input.ledgerId)?.status ?? "missing";
      return { order: completed("ORDER1", "9.50"), via: "agent-toolkit", result: { status: 201, debugId: "d1", body: completed("ORDER1", "9.50"), ms: 1 } };
    });
    const r = await run(() => requestPurchase({ productId: "nb1", requestText: "notebooks", kipReason: "cheapest" }));
    expect(statusSeenByPayPal).toBe("paying");
    expect(r.status).toBe("paid");
    expect(charge).toHaveBeenCalledTimes(1);
    const sent = charge.mock.calls[0][0];
    expect(sent.vaultId).toBe("vault-test-token");
    expect(sent.price).toBe(9.5);
    // Derived from the claim, so every retry of this purchase sends the same id.
    expect(sent.requestId).toBe(`alw-live-order-${sent.ledgerId.replace("_", "")}`);
    const s = await run(() => loadSession(sid, "live"));
    expect(s.ledger[0].paypal).toMatchObject({ orderId: "ORDER1", captureId: "CAPORDER1", via: "agent-toolkit" });
    expect(s.ledger[0].undoUntil).toBeTruthy();
  });

  it("never calls PayPal for a product no search returned", async () => {
    await seed([]);
    const r = await run(() => requestPurchase({ productId: "made-up-id", requestText: "x", kipReason: "" }));
    expect(r.status).toBe("failed");
    expect(charge).not.toHaveBeenCalled();
  });

  it("never calls PayPal for a blocked category", async () => {
    await seed([{ card: product("gc1", 20), category: "gift_cards" }]);
    const r = await run(() => requestPurchase({ productId: "gc1", requestText: "gift card", kipReason: "" }));
    expect(r.status).toBe("blocked");
    expect(charge).not.toHaveBeenCalled();
  });

  it("never calls PayPal while waiting for the parent", async () => {
    await seed([{ card: product("sn1", 55, "shoes.example"), category: "clothing" }]);
    const r = await run(() => requestPurchase({ productId: "sn1", requestText: "sneakers", kipReason: "nice" }));
    expect(r.status).toBe("needs_approval");
    expect(charge).not.toHaveBeenCalled();
  });

  it("does not call PayPal when no PayPal is saved (a write that never left)", async () => {
    await seed([{ card: product("nb2", 9.5), category: "school_supplies" }], { vault: false });
    const r = await run(() => requestPurchase({ productId: "nb2", requestText: "notebooks", kipReason: "" }));
    expect(r.status).toBe("failed");
    expect(charge).not.toHaveBeenCalled();
    expect(reread).not.toHaveBeenCalled();
  });
});

describe("when PayPal does not answer", () => {
  it("asks again with the same PayPal-Request-Id and settles from PayPal's answer", async () => {
    await seed([{ card: product("nb3", 9.5), category: "school_supplies" }]);
    charge.mockRejectedValueOnce(new PayPalUnknownOutcome("rid", new Error("socket hang up")));
    charge.mockResolvedValueOnce({ order: completed("ORDER3", "9.50"), via: "agent-toolkit", result: { status: 201, debugId: "d3", body: completed("ORDER3", "9.50"), ms: 1 } });
    const r = await run(() => requestPurchase({ productId: "nb3", requestText: "notebooks", kipReason: "" }));
    expect(r.status).toBe("paid");
    expect(charge).toHaveBeenCalledTimes(2);
    expect(charge.mock.calls[1][0].requestId).toBe(charge.mock.calls[0][0].requestId);
    expect(charge.mock.calls[1][0].ledgerId).toBe(charge.mock.calls[0][0].ledgerId);
  });

  it("reports unknown, not failed, when the re-read gets no answer either", async () => {
    await seed([{ card: product("nb4", 9.5), category: "school_supplies" }]);
    charge.mockRejectedValue(new PayPalUnknownOutcome("rid", new Error("timeout")));
    const r = await run(() => requestPurchase({ productId: "nb4", requestText: "notebooks", kipReason: "" }));
    expect(charge).toHaveBeenCalledTimes(2);
    expect(r.status).toBe("failed");
    expect(r.status === "failed" ? r.reason : "").toContain("don't know yet");
    const s = await run(() => loadSession(sid, "live"));
    // Still claimed: a later attempt cannot charge a second time.
    expect(s.ledger[0].status).toBe("paying");
  });
});

describe("when PayPal says no", () => {
  it("does not retry a declined wallet and tells the family what to check", async () => {
    await seed([{ card: product("nb5", 9.5), category: "school_supplies" }]);
    charge.mockRejectedValue(new PayPalError(422, "dbg-declined", "INSTRUMENT_DECLINED", "The instrument presented was either declined by the processor or bank.", {}));
    const r = await run(() => requestPurchase({ productId: "nb5", requestText: "notebooks", kipReason: "" }));
    expect(charge).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("failed");
    expect(r.status === "failed" ? r.reason : "").toContain("declined the saved payment method");
    expect(r.status === "failed" ? r.reason : "").toContain("dbg-declined");
    const s = await run(() => loadSession(sid, "live"));
    expect(s.ledger[0].status).toBe("failed");
  });

  it("passes PayPal's own reason through for other refusals", async () => {
    await seed([{ card: product("nb6", 9.5), category: "school_supplies" }]);
    charge.mockRejectedValue(new PayPalError(422, "dbg-422", "PAYEE_ACCOUNT_RESTRICTED", "The merchant account is restricted.", {}));
    const r = await run(() => requestPurchase({ productId: "nb6", requestText: "notebooks", kipReason: "" }));
    expect(r.status === "failed" ? r.reason : "").toContain("The merchant account is restricted.");
  });
});

describe("parent approval", () => {
  it("charges once even if Approve is tapped twice at the same moment", async () => {
    await seed([{ card: product("sn2", 55, "shoes.example"), category: "clothing" }]);
    const asked = await run(() => requestPurchase({ productId: "sn2", requestText: "sneakers", kipReason: "nice" }));
    expect(asked.status).toBe("needs_approval");
    const approvalId = asked.status === "needs_approval" ? asked.approval.id : "";
    charge.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { order: completed("ORDER7", "55.00"), via: "agent-toolkit", result: { status: 201, debugId: "d7", body: completed("ORDER7", "55.00"), ms: 1 } };
    });
    const results = await Promise.allSettled([run(() => resolveApproval(approvalId, "approve")), run(() => resolveApproval(approvalId, "approve"))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(charge).toHaveBeenCalledTimes(1);
    const s = await run(() => loadSession(sid, "live"));
    expect(s.ledger.find((e) => e.product.id === "sn2")?.approvedBy).toBe("parent");
  });

  it("puts the request back when the payment fails, without charging", async () => {
    await seed([{ card: product("sn3", 55, "shoes.example"), category: "clothing" }]);
    const asked = await run(() => requestPurchase({ productId: "sn3", requestText: "sneakers", kipReason: "nice" }));
    const approvalId = asked.status === "needs_approval" ? asked.approval.id : "";
    charge.mockRejectedValue(new PayPalError(422, "dbg", "INSTRUMENT_DECLINED", "declined", {}));
    await expect(run(() => resolveApproval(approvalId, "approve"))).rejects.toThrow(/declined/);
    const s = await run(() => loadSession(sid, "live"));
    expect(s.approvals[0].status).toBe("pending");
    expect(s.ledger.find((e) => e.product.id === "sn3")?.status).toBe("pending_approval");
  });

  it("declining never reaches PayPal", async () => {
    await seed([{ card: product("sn4", 55, "shoes.example"), category: "clothing" }]);
    const asked = await run(() => requestPurchase({ productId: "sn4", requestText: "sneakers", kipReason: "nice" }));
    const approvalId = asked.status === "needs_approval" ? asked.approval.id : "";
    const { state } = await run(() => resolveApproval(approvalId, "decline"));
    expect(state.approvals[0].status).toBe("declined");
    expect(charge).not.toHaveBeenCalled();
  });
});

describe("undo", () => {
  async function paid(id: string) {
    await seed([{ card: product(id, 9.5), category: "school_supplies" }]);
    charge.mockResolvedValueOnce({ order: completed("ORDER9", "9.50"), via: "agent-toolkit", result: { status: 201, debugId: "d9", body: completed("ORDER9", "9.50"), ms: 1 } });
    const r = await run(() => requestPurchase({ productId: id, requestText: "notebooks", kipReason: "" }));
    return r.status === "paid" ? r.entry : null;
  }

  it("refunds once, with a request id tied to the purchase", async () => {
    const entry = (await paid("u1"))!;
    refund.mockResolvedValue({ refund: { id: "REFUND1", status: "COMPLETED" }, via: "agent-toolkit" });
    const s = await run(() => undoPurchase(entry.id));
    expect(s.ledger.find((e) => e.id === entry.id)?.status).toBe("refunded");
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund.mock.calls[0][0]).toMatchObject({ captureId: "CAPORDER9", requestId: `alw-live-refund-${entry.id.replace("_", "")}` });
    await expect(run(() => undoPurchase(entry.id))).rejects.toThrow();
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it("re-reads the capture when the refund outcome is unknown, and settles from PayPal", async () => {
    const entry = (await paid("u2"))!;
    refund.mockRejectedValue(new PayPalUnknownOutcome("rid", new Error("timeout")));
    capture.mockResolvedValue({ id: "CAPORDER9", status: "REFUNDED" });
    const s = await run(() => undoPurchase(entry.id));
    expect(refund).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(s.ledger.find((e) => e.id === entry.id)?.status).toBe("refunded");
  });

  it("keeps the refund marked as in progress when PayPal cannot be reached at all", async () => {
    const entry = (await paid("u3"))!;
    refund.mockRejectedValue(new PayPalUnknownOutcome("rid", new Error("timeout")));
    capture.mockRejectedValue(new Error("network"));
    await expect(run(() => undoPurchase(entry.id))).rejects.toThrow(/unknown/);
    const s = await run(() => loadSession(sid, "live"));
    expect(s.ledger.find((e) => e.id === entry.id)?.status).toBe("refund_pending");
  });

  it("leaves the purchase paid when PayPal refuses the refund", async () => {
    const entry = (await paid("u4"))!;
    refund.mockRejectedValue(new PayPalError(422, "dbg-r", "REFUND_FAILED_INSUFFICIENT_FUNDS", "Not enough funds to refund.", {}));
    capture.mockResolvedValue({ id: "CAPORDER9", status: "COMPLETED" });
    await expect(run(() => undoPurchase(entry.id))).rejects.toThrow(/Not enough funds/);
    const s = await run(() => loadSession(sid, "live"));
    expect(s.ledger.find((e) => e.id === entry.id)?.status).toBe("paid");
  });
});

describe("webhooks", () => {
  async function paidEntry() {
    await seed([{ card: product("w1", 9.5), category: "school_supplies" }]);
    charge.mockResolvedValueOnce({ order: completed("ORDERW", "9.50"), via: "agent-toolkit", result: { status: 201, debugId: "dw", body: completed("ORDERW", "9.50"), ms: 1 } });
    const r = await run(() => requestPurchase({ productId: "w1", requestText: "notebooks", kipReason: "" }));
    return r.status === "paid" ? r.entry : null;
  }
  const refunded = (id: string) => ({
    id,
    event_type: "PAYMENT.CAPTURE.REFUNDED",
    resource: { id: "REFUNDW", status: "COMPLETED", links: [{ rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/CAPORDERW" }] },
  });

  it("marks the purchase refunded from PayPal's own capture status, and handles a repeat delivery once", async () => {
    const entry = (await paidEntry())!;
    capture.mockResolvedValue({ id: "CAPORDERW", status: "REFUNDED" });
    const first = await handleWebhookEvent(refunded("WH-EVENT-1"));
    expect(first.handled).toContain("refunded");
    expect(capture).toHaveBeenCalledTimes(1);
    const s = await run(() => loadSession(sid, "live"));
    expect(s.ledger.find((e) => e.id === entry.id)?.status).toBe("refunded");
    expect(s.webhooks.at(-1)?.eventType).toBe("PAYMENT.CAPTURE.REFUNDED");

    const again = await handleWebhookEvent(refunded("WH-EVENT-1"));
    expect(again.handled).toBe("duplicate, ignored");
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a capture that belongs to no open session", async () => {
    const r = await handleWebhookEvent({ id: "WH-EVENT-2", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAPUNKNOWN", status: "COMPLETED" } });
    expect(r.handled).toContain("not from an open demo session");
    expect(capture).not.toHaveBeenCalled();
  });

  it("refuses to verify when no webhook id is configured, and rejects a delivery without signature headers", async () => {
    const keep = process.env.PAYPAL_WEBHOOK_ID;
    delete process.env.PAYPAL_WEBHOOK_ID;
    await expect(verifyWebhookSignature(new Headers(), "{}")).rejects.toMatchObject({ issue: "WEBHOOK_NOT_CONFIGURED" });
    process.env.PAYPAL_WEBHOOK_ID = "WH-TEST";
    await expect(verifyWebhookSignature(new Headers({ "paypal-transmission-id": "only-one-header" }), "{}")).resolves.toBe(false);
    if (keep === undefined) delete process.env.PAYPAL_WEBHOOK_ID;
    else process.env.PAYPAL_WEBHOOK_ID = keep;
  });
});
