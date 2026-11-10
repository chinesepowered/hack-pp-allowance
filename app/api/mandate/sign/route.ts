import type { NextRequest } from "next/server";
import { ActionError, signNewMandate } from "@/lib/actions";
import { api, jsonBody } from "@/lib/http";
import { mandateDraftSchema, normalizeDraft } from "@/lib/mandate/schema";
import { toClient } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The parent signs the reviewed draft. The draft comes back from the
 * browser, so it is validated again here before it is signed with
 * MANDATE_SIGNING_SECRET (HMAC-SHA256 over the canonical JSON).
 */
export async function POST(req: NextRequest) {
  return api(req, { feature: "Sign mandate", limit: "money" }, async () => {
    const body = await jsonBody<{ rulesText?: string; rules?: unknown; expiresInDays?: number }>(req);
    if (typeof body.rulesText !== "string" || body.rulesText.trim().length < 10) throw new ActionError("The rules text is missing.");
    const rules = Array.isArray(body.rules) ? body.rules.map((r) => ({ ...(r as object), n: undefined })) : body.rules;
    const parsed = mandateDraftSchema.safeParse({ rules, expiresInDays: body.expiresInDays ?? 90, unclear: [] });
    if (!parsed.success) throw new ActionError("That mandate draft is not valid: " + parsed.error.issues.map((i) => i.message).join("; "), 422);
    const n = normalizeDraft(parsed.data);
    const state = await signNewMandate({ rulesText: body.rulesText.trim().slice(0, 1500), rules: n.rules, weeklyBudget: n.weeklyBudget, expiresInDays: n.expiresInDays });
    return { state: toClient(state) };
  });
}
