/**
 * Developer check: does PayPal accept the shape of our
 * verify-webhook-signature request? Sends a made-up delivery, so the
 * expected answer is "not verified", not an error about the request body.
 *
 *   pnpm tsx scripts/try-webhook-verify.ts
 */
import "./lib/load-env";
import { PayPalError } from "../lib/paypal/core";
import { verifyWebhookSignature } from "../lib/paypal/webhooks";

async function main() {
  process.env.PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID ?? "0AB12345CD678901EFGHIJKL";
  const headers = new Headers({
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-ab66f33d",
    "paypal-transmission-id": "00000000-0000-0000-0000-000000000000",
    "paypal-transmission-sig": "bm90LWEtcmVhbC1zaWduYXR1cmU=",
    "paypal-transmission-time": new Date().toISOString(),
  });
  const raw = '{"id":"WH-TEST","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"TESTCAPTURE","status":"COMPLETED"},"note":"spacing  and \\u00e9 kept as sent"}';
  try {
    const ok = await verifyWebhookSignature(headers, raw);
    console.log("PayPal answered. verified =", ok);
  } catch (err) {
    if (err instanceof PayPalError) console.log("PayPal refused the request:", err.status, err.issue, err.message, "debug", err.debugId);
    else throw err;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
