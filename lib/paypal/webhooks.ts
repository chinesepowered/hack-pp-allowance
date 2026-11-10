/**
 * PayPal webhooks.
 *
 *   POST /v1/notifications/verify-webhook-signature   every delivery
 *   POST /v1/notifications/webhooks                   pnpm paypal:webhook <url>
 *   GET  /v1/notifications/webhooks                   to stay idempotent
 *
 * The server SDK does not cover the Webhooks API, so these use plain REST
 * with the shared OAuth token helper.
 *
 * The app never depends on delivery alone: every screen that shows money
 * also re-reads PayPal (lib/actions.ts syncFromPayPal).
 */
import { applyCaptureStatus } from "../actions";
import { runWithContext, newContext } from "../context";
import { findCapture, mutateSession } from "../session";
import { store, update } from "../store";
import type { WebhookRecord } from "../types";
import { PayPalError, rest } from "./core";
import { getCapture } from "./orders";

export const WEBHOOK_EVENTS = [
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "VAULT.PAYMENT-TOKEN.CREATED",
  "VAULT.PAYMENT-TOKEN.DELETED",
] as const;

export type WebhookEvent = {
  id: string;
  event_type: string;
  create_time?: string;
  resource_type?: string;
  summary?: string;
  resource?: {
    id?: string;
    status?: string;
    custom_id?: string;
    invoice_id?: string;
    links?: { href: string; rel: string }[];
    supplementary_data?: { related_ids?: { order_id?: string; capture_id?: string } };
  };
};

/**
 * Asks PayPal whether this delivery is genuine. The event is passed as the
 * exact bytes received: re-serializing the JSON would change what the
 * signature was computed over.
 */
export async function verifyWebhookSignature(headers: Headers, rawBody: string): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new PayPalError(503, null, "WEBHOOK_NOT_CONFIGURED", "PAYPAL_WEBHOOK_ID is not set, so deliveries cannot be verified.", null);
  const need = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];
  for (const h of need) if (!headers.get(h)) return false;
  // Build the request body by hand so `webhook_event` carries the raw bytes.
  const envelope = {
    auth_algo: headers.get("paypal-auth-algo"),
    cert_url: headers.get("paypal-cert-url"),
    transmission_id: headers.get("paypal-transmission-id"),
    transmission_sig: headers.get("paypal-transmission-sig"),
    transmission_time: headers.get("paypal-transmission-time"),
    webhook_id: webhookId,
  };
  const body = JSON.stringify(envelope).slice(0, -1) + `,"webhook_event":${rawBody}}`;
  const res = await rest<{ verification_status?: string }>({ op: "webhooks.verify", note: "verify-webhook-signature" }, "POST", "/v1/notifications/verify-webhook-signature", body);
  return res.body?.verification_status === "SUCCESS";
}

const SEEN_KEY = "webhooks/seen";

/** Idempotency: returns false when this event id was already handled. */
async function claimEvent(id: string): Promise<boolean> {
  let fresh = false;
  await update<{ ids: string[] }>(SEEN_KEY, (doc) => {
    const ids = doc?.ids ?? [];
    if (ids.includes(id)) return { ids };
    fresh = true;
    return { ids: [...ids, id].slice(-500) };
  });
  return fresh;
}

function captureIdOf(ev: WebhookEvent): string | null {
  if (ev.event_type.startsWith("PAYMENT.CAPTURE.")) {
    if (ev.event_type === "PAYMENT.CAPTURE.REFUNDED" || ev.event_type === "PAYMENT.CAPTURE.REVERSED") {
      // The resource is the refund; the capture is linked as "up".
      const up = ev.resource?.links?.find((l) => l.rel === "up")?.href;
      const fromLink = up ? up.split("/").pop() : null;
      return ev.resource?.supplementary_data?.related_ids?.capture_id ?? fromLink ?? null;
    }
    return ev.resource?.id ?? null;
  }
  return null;
}

/**
 * Handles one verified event. Idempotent: a repeated delivery is
 * acknowledged and ignored.
 */
export async function handleWebhookEvent(ev: WebhookEvent): Promise<{ handled: string }> {
  if (!(await claimEvent(ev.id))) return { handled: "duplicate, ignored" };
  let handled = "recorded";
  const record: WebhookRecord = { id: ev.id, at: new Date().toISOString(), eventType: ev.event_type, resourceId: ev.resource?.id ?? null, verified: true, handled };

  const captureId = captureIdOf(ev);
  if (captureId) {
    const ref = await findCapture(captureId);
    if (ref) {
      const c = newContext({ sid: ref.sid, mode: ref.mode, feature: `webhook ${ev.event_type}` });
      await runWithContext(c, async () => {
        // The event says something changed. PayPal is the source of truth,
        // so read the capture rather than trusting the payload.
        let status: string | null = null;
        try {
          status = (await getCapture(captureId)).status;
        } catch {
          status = ev.event_type === "PAYMENT.CAPTURE.REFUNDED" ? "REFUNDED" : (ev.resource?.status ?? null);
        }
        await mutateSession(ref.sid, ref.mode, (s) => {
          const e = s.ledger.find((x) => x.id === ref.ledgerId);
          if (e && status) {
            const changed = applyCaptureStatus(e, status, `webhook ${ev.event_type}`);
            e.paypal.lastSyncedAt = new Date().toISOString();
            handled = changed ? `ledger entry ${e.id} is now ${e.status}` : `ledger entry ${e.id} already ${e.status}`;
          } else handled = "no matching ledger entry";
          s.webhooks.push({ ...record, handled });
        });
      });
    } else handled = "capture not from an open demo session (for example a seeded purchase)";
  } else if (ev.event_type.startsWith("VAULT.PAYMENT-TOKEN.")) {
    handled = ev.event_type.endsWith("CREATED") ? "payment token saved" : "payment token removed";
  }

  await update<{ events: WebhookRecord[] }>("webhooks/recent", (doc) => ({ events: [...(doc?.events ?? []), { ...record, handled }].slice(-50) }));
  return { handled };
}

export async function recentWebhooks(): Promise<WebhookRecord[]> {
  return (await store().get<{ events: WebhookRecord[] }>("webhooks/recent"))?.events ?? [];
}

/* ----------------------------- registration ----------------------------- */

type Webhook = { id: string; url: string; event_types: { name: string }[] };

/** Registers the URL for this build's event types. Reuses an existing registration for the same URL. */
export async function registerWebhook(url: string): Promise<{ id: string; created: boolean; events: string[] }> {
  const list = await rest<{ webhooks?: Webhook[] }>({ op: "webhooks.list" }, "GET", "/v1/notifications/webhooks");
  const existing = (list.body.webhooks ?? []).find((w) => w.url === url);
  const wanted = [...WEBHOOK_EVENTS];
  if (existing) {
    const have = existing.event_types.map((e) => e.name).sort();
    if (JSON.stringify(have) !== JSON.stringify([...wanted].sort())) {
      await rest({ op: "webhooks.update" }, "PATCH", `/v1/notifications/webhooks/${existing.id}`, [{ op: "replace", path: "/event_types", value: wanted.map((name) => ({ name })) }]);
    }
    return { id: existing.id, created: false, events: wanted };
  }
  const created = await rest<Webhook>({ op: "webhooks.create" }, "POST", "/v1/notifications/webhooks", { url, event_types: wanted.map((name) => ({ name })) });
  return { id: created.body.id, created: true, events: wanted };
}
