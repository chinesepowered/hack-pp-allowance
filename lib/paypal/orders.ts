/**
 * Orders v2 and Payments v2.
 *
 *   POST /v2/checkout/orders            create with payment_source.paypal.vault_id
 *   POST /v2/checkout/orders/{id}/capture   only if the create did not complete
 *   GET  /v2/checkout/orders/{id}       re-read (PayPal is the source of truth)
 *   GET  /v2/payments/captures/{id}     re-read a capture
 *   POST /v2/payments/captures/{id}/refund  the parent's Undo
 *
 * Sandbox fact worth knowing: an order created with intent CAPTURE and a
 * vaulted PayPal as the payment source is charged in that same call. The
 * response already has status COMPLETED and the capture inside, so there is
 * no separate capture request. capturedOf() handles both shapes.
 */
import { CheckoutPaymentIntent, ItemCategory, OrdersController, PaymentsController } from "@paypal/paypal-server-sdk";
import { PayPalError, sdk, sdkCall, type PPResult } from "./core";
import { toolkitReady, toolkitRun } from "./toolkit";

export type Capture = {
  id: string;
  status: string;
  amount?: { currency_code: string; value: string };
  seller_receivable_breakdown?: { paypal_fee?: { value: string }; net_amount?: { value: string } };
  invoice_id?: string;
  custom_id?: string;
};

export type Order = {
  id: string;
  status: string;
  payment_source?: { paypal?: { email_address?: string; account_id?: string; name?: { given_name?: string; surname?: string } } };
  purchase_units?: {
    reference_id?: string;
    custom_id?: string;
    invoice_id?: string;
    amount?: { currency_code: string; value: string };
    payments?: { captures?: Capture[]; refunds?: { id: string; status: string }[] };
  }[];
};

export type Refund = { id: string; status: string; amount?: { currency_code: string; value: string } };

export type ChargeInput = {
  vaultId: string;
  /** Our ledger id. Sent as custom_id so webhooks can be matched back. */
  ledgerId: string;
  invoiceId: string;
  title: string;
  description: string;
  price: number;
  requestId: string;
};

export function capturedOf(order: Order): Capture | null {
  return order.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + ".";
}

/**
 * Charges the saved PayPal through the Agent Toolkit's create_order tool.
 * Callers must have passed authorizePayment() first; see lib/agent/guard.ts.
 */
export async function chargeVaultViaToolkit(input: ChargeInput): Promise<{ order: Order; via: "agent-toolkit" | "server-sdk"; result: PPResult<Order> }> {
  if (!toolkitReady()) {
    const result = await chargeVaultViaSdk(input);
    return { order: result.body, via: "server-sdk", result };
  }
  const result = await toolkitRun<Order>(
    "create_order",
    {
      currencyCode: "USD",
      items: [{ name: clip(input.title, 120), description: clip(input.description, 120), itemCost: input.price, quantity: 1, taxPercent: 0, itemTotal: input.price }],
      discount: 0,
      shippingCost: 0,
      shippingAddress: null,
      notes: null,
    },
    {
      requestId: input.requestId,
      note: "vault_id attached in code after the mandate check",
      inject: {
        paymentSource: { paypal: { vault_id: input.vaultId } },
        unit: { custom_id: input.ledgerId, invoice_id: input.invoiceId, description: clip(input.description, 120) },
      },
    },
  );
  return { order: result.body, via: "agent-toolkit", result };
}

/** The same charge through the server SDK. Used by `pnpm seed` and as a fallback. */
export async function chargeVaultViaSdk(input: ChargeInput): Promise<PPResult<Order>> {
  const value = input.price.toFixed(2);
  return sdkCall<Order>({ op: "orders.create", method: "POST", path: "/v2/checkout/orders", requestId: input.requestId, isWrite: true, note: "payment_source.paypal.vault_id" }, () =>
    new OrdersController(sdk()).createOrder({
      paypalRequestId: input.requestId,
      prefer: "return=representation",
      body: {
        intent: CheckoutPaymentIntent.Capture,
        paymentSource: { paypal: { vaultId: input.vaultId } },
        purchaseUnits: [
          {
            customId: input.ledgerId,
            invoiceId: input.invoiceId,
            description: clip(input.description, 120),
            amount: { currencyCode: "USD", value, breakdown: { itemTotal: { currencyCode: "USD", value } } },
            items: [{ name: clip(input.title, 120), quantity: "1", unitAmount: { currencyCode: "USD", value }, category: ItemCategory.PhysicalGoods }],
          },
        ],
      },
    }),
  );
}

/** Captures an approved order. Only needed if a create came back without a capture. */
export async function captureOrder(orderId: string, requestId: string): Promise<Order> {
  const res = await sdkCall<Order>({ op: "orders.capture", method: "POST", path: `/v2/checkout/orders/${orderId}/capture`, requestId, isWrite: true }, () =>
    new OrdersController(sdk()).captureOrder({ id: orderId, paypalRequestId: requestId, prefer: "return=representation" }),
  );
  return res.body;
}

/** Re-reads an order through the Agent Toolkit's get_order tool. */
export async function getOrder(orderId: string): Promise<Order> {
  if (toolkitReady()) return (await toolkitRun<Order>("get_order", { id: orderId })).body;
  const res = await sdkCall<Order>({ op: "orders.get", method: "GET", path: `/v2/checkout/orders/${orderId}` }, () => new OrdersController(sdk()).getOrder({ id: orderId }));
  return res.body;
}

export async function getCapture(captureId: string): Promise<Capture> {
  const res = await sdkCall<Capture>({ op: "payments.getCapture", method: "GET", path: `/v2/payments/captures/${captureId}` }, () => new PaymentsController(sdk()).getCapturedPayment({ captureId }));
  return res.body;
}

/** Full refund of a capture through the Agent Toolkit's create_refund tool. */
export async function refundCapture(input: { captureId: string; requestId: string; note: string; invoiceId?: string | null }): Promise<{ refund: Refund; via: "agent-toolkit" | "server-sdk" }> {
  if (toolkitReady()) {
    const res = await toolkitRun<Refund>("create_refund", { capture_id: input.captureId, note_to_payer: clip(input.note, 250) }, { requestId: input.requestId, note: "parent Undo" });
    return { refund: res.body, via: "agent-toolkit" };
  }
  const res = await sdkCall<Refund>({ op: "payments.refund", method: "POST", path: `/v2/payments/captures/${input.captureId}/refund`, requestId: input.requestId, isWrite: true }, () =>
    new PaymentsController(sdk()).refundCapturedPayment({ captureId: input.captureId, paypalRequestId: input.requestId, prefer: "return=representation", body: { noteToPayer: clip(input.note, 250) } }),
  );
  return { refund: res.body, via: "server-sdk" };
}

/** True when PayPal says this capture was already fully refunded. */
export function alreadyRefunded(err: unknown): boolean {
  return err instanceof PayPalError && err.status === 422 && /CAPTURE_FULLY_REFUNDED|REFUND_NOT_ALLOWED|ALREADY_REFUNDED/i.test(err.issue);
}
