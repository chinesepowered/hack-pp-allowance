import { NextResponse, type NextRequest } from "next/server";
import { newContext, runWithContext } from "@/lib/context";
import { PayPalError } from "@/lib/paypal/core";
import { handleWebhookEvent, verifyWebhookSignature, WEBHOOK_EVENTS, type WebhookEvent } from "@/lib/paypal/webhooks";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * PayPal webhook receiver.
 *
 *  1. Read the raw body (the signature covers the exact bytes).
 *  2. Verify with POST /v1/notifications/verify-webhook-signature.
 *     Unverified deliveries are rejected and never processed.
 *  3. Handle idempotently: the event id is claimed first, so a repeated
 *     delivery is acknowledged and ignored.
 *
 * Register this URL after deploying with: pnpm paypal:webhook <public-url>
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const c = newContext({ sid: "webhook", mode: "live", feature: "Webhook" });
  return runWithContext(c, async () => {
    let verified = false;
    try {
      verified = await verifyWebhookSignature(req.headers, raw);
    } catch (err) {
      if (err instanceof PayPalError && err.issue === "WEBHOOK_NOT_CONFIGURED") return NextResponse.json({ error: err.message }, { status: 503 });
      // Could not reach PayPal to verify: ask PayPal to retry later.
      return NextResponse.json({ error: "Could not verify the delivery right now." }, { status: 503 });
    }
    if (!verified) return NextResponse.json({ error: "Signature verification failed." }, { status: 400 });

    let event: WebhookEvent;
    try {
      event = JSON.parse(raw) as WebhookEvent;
    } catch {
      return NextResponse.json({ error: "Body is not JSON." }, { status: 400 });
    }
    if (!event.id || !event.event_type) return NextResponse.json({ error: "Not a webhook event." }, { status: 400 });
    if (!(WEBHOOK_EVENTS as readonly string[]).includes(event.event_type)) return NextResponse.json({ ok: true, handled: "event type not used by this app" });
    try {
      const { handled } = await handleWebhookEvent(event);
      return NextResponse.json({ ok: true, handled });
    } catch (err) {
      console.error("[webhook]", err);
      // A 5xx makes PayPal redeliver; the handler is idempotent.
      return NextResponse.json({ error: "Handler failed, please retry." }, { status: 500 });
    }
  });
}
