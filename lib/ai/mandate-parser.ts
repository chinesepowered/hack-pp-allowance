/**
 * Plain-English rules in, a structured mandate draft out.
 *
 * The model proposes JSON, Zod validates the shape, normalizeDraft() checks
 * the meaning (one budget, nothing both allowed and blocked), and the
 * parent reviews the result as a readable card before signing. Nothing the
 * model writes takes effect until a parent signs it.
 */
import { CATEGORIES, CATEGORY_HINT } from "../mandate/categories";
import { mandateDraftSchema, normalizeDraft, MandateDraftError } from "../mandate/schema";
import type { Rule } from "../types";
import { chatJson } from "./llm";
import { logStep } from "../context";

const SYSTEM = `You turn a parent's plain-English spending rules for their teenager into a structured mandate.

Return JSON only, in this exact shape:
{
  "rules": [ ... ],
  "expiresInDays": 90,
  "unclear": []
}

Each rule is one of:
- {"kind":"budget","text":string,"weeklyLimit":number}
  The total the teen may spend per week, in US dollars. Exactly one budget rule. A monthly amount becomes weekly by dividing by 4.
- {"kind":"allow","text":string,"categories":[category],"perItemCap":number|null}
  Things the teen may buy. perItemCap is a per-item price limit in dollars, or null when the parent gave none.
- {"kind":"block","text":string,"categories":[category],"merchants":[string]}
  Things never to buy. "merchants" are store domains such as "example.com", only when the parent names a store.
- {"kind":"approval","text":string,"overAmount":number|null,"when":"always"|"new_merchant","categories":[category]}
  Purchases that need the parent's OK first. "new_merchant" means stores the family has not used before. "categories" empty means every category. "overAmount" null means any price.

Categories (use only these ids):
${CATEGORIES.map((c) => `- ${c}: ${CATEGORY_HINT[c]}`).join("\n")}

Rules for you:
- "text" is the parent's own sentence for that rule, lightly cleaned up, without a trailing period. Keep their wording. Never invent a rule they did not write.
- One parent sentence usually becomes one rule. Split a sentence only if it clearly holds two different rules.
- Do not allow a category that another rule blocks.
- If something cannot be expressed in this shape, leave it out of "rules" and describe it briefly in "unclear".
- expiresInDays: use what the parent says, otherwise 90.`;

export type ParsedMandate = {
  rules: Rule[];
  weeklyBudget: number;
  expiresInDays: number;
  unclear: string[];
  model: string;
  ms: number;
};

export async function draftMandate(rulesText: string): Promise<ParsedMandate> {
  const text = rulesText.trim().slice(0, 1500);
  if (text.length < 10) throw new MandateDraftError("Write a few rules first.", ["Start with a weekly budget, for example: Up to $60 a week."]);
  const { value, model, ms } = await chatJson("mandate", mandateDraftSchema, {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `The parent wrote:\n"""${text}"""` },
    ],
    maxTokens: 2000,
    temperature: 0,
    effort: "low",
  });
  const n = normalizeDraft(value);
  logStep({ kind: "model", title: "Turned the rules into a mandate draft", detail: `${n.rules.length} rules, weekly budget $${n.weeklyBudget}. Validated with Zod, then checked in code.`, ms, model });
  return { ...n, model, ms };
}
