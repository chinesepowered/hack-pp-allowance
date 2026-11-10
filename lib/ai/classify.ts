/**
 * Puts each product into one mandate category with a confidence score.
 * The policy code treats low confidence as "ask the parent".
 */
import { z } from "zod";
import { CATEGORIES, CATEGORY_HINT, type Category } from "../mandate/categories";
import { logStep } from "../context";
import type { Classification, ProductCard } from "../types";
import { chatJson } from "./llm";

const SYSTEM = `You label shopping products for a family spending policy.

For each product pick exactly one category id from this list:
${CATEGORIES.map((c) => `- ${c}: ${CATEGORY_HINT[c]}`).join("\n")}

Also give a confidence from 0 to 1:
- 0.9 or more when the title clearly says what the item is
- 0.5 to 0.8 when it could reasonably be two categories
- under 0.5 when you are guessing

Gift cards, prepaid codes and store credit are always gift_cards, even for a game store. In-game currency, game top-ups, consoles and video games are gaming. A calculator, notebook or backpack for school is school_supplies.

Return JSON only: {"items":[{"id":string,"category":string,"confidence":number}]}. One entry per product, same ids.`;

const schema = z.object({
  items: z.array(z.object({ id: z.string(), category: z.enum(CATEGORIES), confidence: z.number().min(0).max(1) })),
});

export async function classifyProducts(products: Pick<ProductCard, "id" | "title" | "brand" | "sourceCategory" | "description">[]): Promise<Classification[]> {
  if (products.length === 0) return [];
  const input = products.map((p) => ({ id: p.id, title: p.title.slice(0, 140), brand: p.brand, store_category: p.sourceCategory, about: p.description ? p.description.slice(0, 160) : null }));
  const { value, model, ms } = await chatJson("classify", schema, {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify(input) },
    ],
    maxTokens: 900,
    temperature: 0,
    effort: "none",
  });
  const byId = new Map(value.items.map((i) => [i.id, i]));
  const out: Classification[] = products.map((p) => {
    const hit = byId.get(p.id);
    // A product the model skipped gets the lowest confidence, so the policy
    // sends it to the parent instead of guessing.
    return hit ? { productId: p.id, category: hit.category, confidence: hit.confidence, source: "ai", model } : { productId: p.id, category: "other" as Category, confidence: 0, source: "ai", model };
  });
  logStep({
    kind: "model",
    title: `Classified ${products.length} product${products.length === 1 ? "" : "s"} into mandate categories`,
    detail: out
      .slice(0, 6)
      .map((c) => `${c.category} ${(c.confidence * 100).toFixed(0)}%`)
      .join(", "),
    ms,
    model,
  });
  return out;
}

const requestSchema = z.object({ category: z.enum(CATEGORIES), confidence: z.number().min(0).max(1) });

/** Labels what a request is about, before any product is found. */
export async function classifyRequest(text: string): Promise<{ category: Category; confidence: number; model: string }> {
  const { value, model } = await chatJson("classify-request", requestSchema, {
    messages: [
      { role: "system", content: SYSTEM.replace('Return JSON only: {"items":[{"id":string,"category":string,"confidence":number}]}. One entry per product, same ids.', 'You get one shopping request instead of a product list. Return JSON only: {"category":string,"confidence":number}.') },
      { role: "user", content: text.slice(0, 300) },
    ],
    maxTokens: 300,
    temperature: 0,
    effort: "none",
  });
  return { ...value, model };
}
