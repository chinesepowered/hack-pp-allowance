import type { NextRequest } from "next/server";
import { ActionError } from "@/lib/actions";
import { draftMandate } from "@/lib/ai/mandate-parser";
import { api, jsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Plain-English rules in, a mandate draft out. The model proposes; Zod and
 * code check it; nothing takes effect until the parent signs.
 */
export async function POST(req: NextRequest) {
  return api(req, { feature: "Rules to mandate (AI)", limit: "ai", scenario: "mandate-draft" }, async () => {
    const { rulesText } = await jsonBody<{ rulesText?: string }>(req);
    if (typeof rulesText !== "string" || rulesText.trim().length < 10) throw new ActionError("Write a few rules first, for example: Up to $60 a week.");
    const draft = await draftMandate(rulesText);
    return { draft: { rules: draft.rules, weeklyBudget: draft.weeklyBudget, expiresInDays: draft.expiresInDays, unclear: draft.unclear }, model: draft.model, ms: draft.ms };
  });
}
