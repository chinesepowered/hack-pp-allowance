import type { NextRequest } from "next/server";
import { ActionError, saveVault } from "@/lib/actions";
import { api, jsonBody } from "@/lib/http";
import { createPaymentToken } from "@/lib/paypal/vault";
import { toClient } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Step 2, after the parent approved in PayPal's window: exchange the setup
 * token for the payment token (POST /v3/vault/payment-tokens). The token
 * stays on the server; the browser only learns that a PayPal is saved.
 */
export async function POST(req: NextRequest) {
  return api(req, { feature: "Save PayPal (Vault)", limit: "money", scenario: "vault-save" }, async (c) => {
    const { setupTokenId } = await jsonBody<{ setupTokenId?: string }>(req);
    if (typeof setupTokenId !== "string" || !/^[A-Za-z0-9]{8,40}$/.test(setupTokenId)) throw new ActionError("The setup token is missing.");
    const vault = await createPaymentToken(setupTokenId, c.mode === "replay" ? "replay" : "parent-setup");
    return { state: toClient(await saveVault(vault)) };
  });
}
