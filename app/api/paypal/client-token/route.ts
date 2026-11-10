import type { NextRequest } from "next/server";
import { ActionError } from "@/lib/actions";
import { api } from "@/lib/http";
import { createClientToken } from "@/lib/paypal/vault";

export const dynamic = "force-dynamic";

/**
 * A browser-safe client token for the PayPal JS SDK v6. v6 needs a client
 * token, not just the client id, for the save-payment (vault) flow.
 */
export async function GET(req: NextRequest) {
  return api(req, { feature: "Save PayPal (Vault)", limit: "money" }, async (c) => {
    if (c.mode === "replay") throw new ActionError("Replay mode skips PayPal's window. Switch to Live to save a PayPal for real.", 409);
    const origin = req.headers.get("origin") ?? req.nextUrl.origin;
    const { clientToken, expiresIn } = await createClientToken(origin);
    return { clientToken, expiresIn };
  });
}
