/**
 * PayPal Vault v3: the parent saves their PayPal once, and Kip pays with
 * the resulting payment token later, with no popup.
 *
 *   POST /v3/vault/setup-tokens      create a setup token for a PayPal wallet
 *   (parent approves in PayPal's window: JS SDK v6 save-payment session,
 *    or the approve link when Playwright drives it in `pnpm seed`)
 *   POST /v3/vault/payment-tokens    exchange the approved setup token
 *   GET  /v3/vault/payment-tokens/{id}   re-read the saved method (pnpm seed)
 *   POST /v1/oauth2/token (response_type=client_token)  browser-safe token
 *        for the JS SDK v6, which needs a client token for vault flows
 */
import {
  ExperienceContextShippingPreference,
  PaypalPaymentTokenCustomerType,
  PaypalPaymentTokenUsageType,
  UsagePattern,
  VaultController,
  VaultInstructionAction,
  VaultTokenRequestType,
} from "@paypal/paypal-server-sdk";
import { randomUUID } from "node:crypto";
import { PAYPAL_BASE_URL, requireEnv } from "../env";
import { logPayPalCall } from "../context";
import { external } from "../replay/vcr";
import { PayPalError, sdk, sdkCall } from "./core";
import type { VaultInfo } from "../types";

export type SetupToken = {
  id: string;
  status: string;
  customer?: { id?: string };
  links?: { href: string; rel: string; method?: string }[];
  payment_source?: { paypal?: { email_address?: string; payer_id?: string } };
};

export type PaymentToken = {
  id: string;
  customer?: { id?: string };
  payment_source?: { paypal?: { email_address?: string; payer_id?: string; name?: { given_name?: string; surname?: string } } };
};

export async function createSetupToken(input: { returnUrl: string; cancelUrl: string; requestId?: string }): Promise<SetupToken> {
  const requestId = input.requestId ?? randomUUID();
  const res = await sdkCall<SetupToken>({ op: "vault.createSetupToken", method: "POST", path: "/v3/vault/setup-tokens", requestId, isWrite: true }, () =>
    new VaultController(sdk()).createSetupToken({
      paypalRequestId: requestId,
      body: {
        paymentSource: {
          paypal: {
            description: "Allowance: purchases by Kip inside your signed mandate",
            // The agent charges later, when the parent is not present.
            usageType: PaypalPaymentTokenUsageType.Merchant,
            customerType: PaypalPaymentTokenCustomerType.Consumer,
            usagePattern: UsagePattern.Immediate,
            permitMultiplePaymentTokens: false,
            experienceContext: {
              brandName: "Allowance",
              locale: "en-US",
              returnUrl: input.returnUrl,
              cancelUrl: input.cancelUrl,
              shippingPreference: ExperienceContextShippingPreference.NoShipping,
              vaultInstruction: VaultInstructionAction.OnPayerApproval,
            },
          },
        },
      },
    }),
  );
  return res.body;
}

export function approveLink(token: SetupToken): string | null {
  return token.links?.find((l) => l.rel === "approve")?.href ?? null;
}

/** Exchanges an approved setup token for the long-lived payment token. */
export async function createPaymentToken(setupTokenId: string, source: VaultInfo["source"]): Promise<VaultInfo> {
  // The same setup token always maps to the same request id, so a double
  // click cannot mint two payment tokens.
  const requestId = `alw-ptoken-${setupTokenId}`;
  const res = await sdkCall<PaymentToken>({ op: "vault.createPaymentToken", method: "POST", path: "/v3/vault/payment-tokens", requestId, isWrite: true }, () =>
    new VaultController(sdk()).createPaymentToken({
      paypalRequestId: requestId,
      body: { paymentSource: { token: { id: setupTokenId, type: VaultTokenRequestType.SetupToken } } },
    }),
  );
  return toVaultInfo(res.body, source);
}

export function toVaultInfo(t: PaymentToken, source: VaultInfo["source"]): VaultInfo {
  const pp = t.payment_source?.paypal;
  const name = [pp?.name?.given_name, pp?.name?.surname].filter(Boolean).join(" ");
  return {
    paymentTokenId: t.id,
    customerId: t.customer?.id ?? null,
    payerEmail: pp?.email_address ?? null,
    payerName: name.length > 0 ? name : null,
    savedAt: new Date().toISOString(),
    source,
    kind: "paypal",
  };
}

export async function getPaymentToken(id: string): Promise<PaymentToken | null> {
  try {
    const res = await sdkCall<PaymentToken>({ op: "vault.getPaymentToken", method: "GET", path: `/v3/vault/payment-tokens/${id}` }, () => new VaultController(sdk()).getPaymentToken(id));
    return res.body;
  } catch (err) {
    if (err instanceof PayPalError && err.status === 404) return null;
    throw err;
  }
}

/**
 * A browser-safe client token for the JS SDK v6. v6 needs a client token
 * (not just the client id) for vault flows. `domains[]` binds the token to
 * the page that asked for it.
 */
export async function createClientToken(origin: string): Promise<{ clientToken: string; expiresIn: number }> {
  const out = await external<{ status: number; debugId: string | null; ms: number; token: string | null; expiresIn: number; error: string | null }>("paypal", "oauth.clientToken", async () => {
    const t0 = Date.now();
    const basic = Buffer.from(`${requireEnv("PAYPAL_CLIENT_ID")}:${requireEnv("PAYPAL_CLIENT_SECRET")}`).toString("base64");
    const form = new URLSearchParams({ grant_type: "client_credentials", response_type: "client_token", intent: "sdk_init" });
    // PayPal rejects "localhost" and ports here ("Domain format not valid"),
    // so the token is bound to a domain only when the app runs on a real one.
    const host = origin.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) && !/^\d+(\.\d+){3}$/.test(host)) form.append("domains[]", host);
    const r = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const json = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    return { status: r.status, debugId: r.headers.get("paypal-debug-id"), ms: Date.now() - t0, token: json.access_token ?? null, expiresIn: json.expires_in ?? 0, error: r.ok ? null : (json.error_description ?? "Could not create a client token.") };
  });
  logPayPalCall({ method: "POST", path: "/v1/oauth2/token", status: out.status, debugId: out.debugId, via: "rest", ms: out.ms, requestId: null, note: "response_type=client_token (browser-safe, for JS SDK v6)" });
  if (!out.token) throw new PayPalError(out.status, out.debugId, "CLIENT_TOKEN_FAILED", out.error ?? "Could not create a client token.", null);
  return { clientToken: out.token, expiresIn: out.expiresIn };
}
