/**
 * pnpm paypal:webhook <public-url>
 *
 * Registers <public-url>/api/paypal/webhook with PayPal for this build's
 * event types and prints the webhook id. Run it once after deploying, then
 * set PAYPAL_WEBHOOK_ID in the hosting environment. Safe to re-run: an
 * existing registration for the same URL is reused.
 */
import "./lib/load-env";
import { registerWebhook, WEBHOOK_EVENTS } from "../lib/paypal/webhooks";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: pnpm paypal:webhook <public-url>   (for example https://allowance.example.com)");
    process.exitCode = 1;
    return;
  }
  let base: URL;
  try {
    base = new URL(arg);
  } catch {
    console.error("That is not a URL: " + arg);
    process.exitCode = 1;
    return;
  }
  if (base.protocol !== "https:") {
    console.error("PayPal only delivers webhooks to https URLs.");
    process.exitCode = 1;
    return;
  }
  const url = base.pathname.endsWith("/api/paypal/webhook") ? base.toString() : new URL("/api/paypal/webhook", base).toString();
  const r = await registerWebhook(url);
  console.log(r.created ? "Registered a new webhook." : "A webhook for this URL already exists. Reusing it.");
  console.log("URL:    " + url);
  console.log("Events: " + WEBHOOK_EVENTS.join(", "));
  console.log("Webhook id: " + r.id);
  console.log("\nNow set PAYPAL_WEBHOOK_ID=" + r.id + " in the hosting environment and redeploy.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
