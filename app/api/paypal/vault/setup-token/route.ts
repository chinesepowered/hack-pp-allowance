import type { NextRequest } from "next/server";
import { api } from "@/lib/http";
import { createSetupToken } from "@/lib/paypal/vault";

export const dynamic = "force-dynamic";

/** Step 1 of saving the parent's PayPal: POST /v3/vault/setup-tokens. */
export async function POST(req: NextRequest) {
  return api(req, { feature: "Save PayPal (Vault)", limit: "money", scenario: "vault-save" }, async () => {
    const origin = req.headers.get("origin") ?? req.nextUrl.origin;
    const token = await createSetupToken({ returnUrl: `${origin}/parent?vault=approved`, cancelUrl: `${origin}/parent?vault=cancelled` });
    return { id: token.id, status: token.status };
  });
}
