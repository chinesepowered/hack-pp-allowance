/**
 * Kip, the teen's shopping agent.
 *
 * A tool-calling loop on the W&B text model. The model can search, compare
 * and ask to buy. It cannot pay: create_order here is a wrapper that runs
 * the mandate check in code (lib/agent/guard.ts) before the PayPal Agent
 * Toolkit's create_order is ever called, and the arguments PayPal receives
 * are built by code from the Channel3 offer.
 *
 * Every step is logged so the UI can show the reasoning trail.
 */
import { randomUUID } from "node:crypto";
import { kipSays } from "../actions";
import { chat, type Msg, type ToolCall, type ToolDef } from "../ai/llm";
import { CatalogError, findSimilar, getProduct, searchByImage, searchProducts, type SearchResult } from "../channel3/client";
import { ctx, logStep, status } from "../context";
import { CATEGORIES, CATEGORY_LABEL, isCategory, type Category } from "../mandate/categories";
import { budgetStatus, knownMerchants, screenRequest, usd } from "../mandate/policy";
import { ReplayMiss } from "../replay/vcr";
import { loadSession, mutateSession } from "../session";
import type { ChatCard, ChatMessage, Classification, Decision, Offer, PolicyPreview, SessionState } from "../types";
import { decide, ensureClassified, requestPurchase } from "./guard";

const MAX_MODEL_TURNS = 5;

const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search real retailers (Channel3 catalog). The app adds the price cap and in-stock filter from the parent's rules. Returns products, each with a policy label computed by code.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for, in a few words. No store names." },
          category: { type: "string", enum: [...CATEGORIES], description: "The kind of thing the teen is asking for." },
          max_price: { type: "number", description: "Only if the teen named a price limit, in US dollars." },
        },
        required: ["query", "category"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_similar",
      description: "Find products similar to one already shown, optionally under a price. Use it to offer an alternative that fits the rules.",
      parameters: { type: "object", properties: { product_id: { type: "string" }, max_price: { type: "number" } }, required: ["product_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_product_details",
      description: "Offers for one product across retailers, with prices and stock.",
      parameters: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "create_order",
      description: "Ask the app to buy one product with the family's saved PayPal. The app checks the parent's rules in code first and may pay, ask the parent, or refuse. Use a product_id from a search result.",
      parameters: {
        type: "object",
        properties: {
          product_id: { type: "string" },
          why: { type: "string", description: "One or two sentences to the teen: why this pick, compared with one or two other options (price, store, one key spec)." },
          also_considered: { type: "array", items: { type: "string" }, description: "Up to two other product_ids you compared." },
        },
        required: ["product_id", "why"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order_status",
      description: "Status of the teen's recent purchases and requests.",
      parameters: { type: "object", properties: {} },
    },
  },
];

function rulesBlock(s: SessionState): string {
  if (!s.mandate) return "No rules are signed yet. You cannot buy anything.";
  return s.mandate.rules.map((r) => `${r.n}. ${r.text}`).join("\n");
}

function systemPrompt(s: SessionState): string {
  const teen = s.family.teen.name;
  const parent = s.family.parent.name;
  const b = budgetStatus(s.mandate, s.ledger);
  const stores = [...knownMerchants(s.mandate, s.ledger)];
  return `You are Kip, a young capybara in a bucket hat with a tiny backpack. You shop for ${teen}, who is ${s.family.teen.age}, using the family's PayPal, inside rules that ${parent} signed.

Voice: casual, warm and short, like a helpful friend. Plain text only. No emoji, no markdown, no dashes used as punctuation. Never lecture. Do not name brands or stores; say what the item is and what it costs. Talk to ${teen} as "you".

How you work:
- To find things, call search_products. Always pass the category the request is about.
- Results come back with a "policy" label per item: can_buy_now, needs_parent_ok or blocked. Code computes these from ${parent}'s rules. You cannot change or argue with them.
- When ${teen} clearly wants something bought ("I need", "get me", "can you get", "buy"), search, pick the best fit and call create_order in the same turn. Prefer items labelled can_buy_now, unless ${teen} asked for something specific that needs an OK. If they want cheap, pick the cheapest good fit. If they name a price ("around $55"), pick the matching item closest to that price, even when it needs an OK: asking ${parent} is the app's job, not yours to avoid.
- In create_order, "why" is one or two sentences to ${teen} comparing your pick with one or two other options (price, one key spec, rating). Describe items by what they are and their price, never by brand or store name. Do not say whether it was paid; the app shows the result.
- If ${teen} is only browsing, or the request is unclear, show options and ask one short question instead of buying.
- You never see or handle payment details. The app pays, and checks every purchase against the rules in code.
- If a tool says blocked, explain kindly in one or two sentences, mention the rule number, and suggest something the rules do allow. Never offer a workaround.
- Never write text in square brackets, and never say something was paid, ordered or bought. Only the app can say that, after it has paid.
- Only help with shopping for ${teen}. Politely decline anything else in one sentence.

Rules ${parent} signed${s.mandate ? ` (mandate v${s.mandate.version})` : ""}:
${rulesBlock(s)}
Anything no rule covers needs ${parent}'s OK.

Budget: ${usd(b.remaining)} left of ${usd(b.limit)} this week (rolling seven days, ${usd(b.spent)} spent).
Stores the family has used before: ${stores.length > 0 ? stores.join(", ") : "none yet"}.${
    s.paused ? `\n\nIMPORTANT: ${parent} has PAUSED spending. You can search and compare, but tell ${teen} that ${parent} paused spending and that you cannot buy until it is switched back on. Do not call create_order.` : ""
  }${!s.vault ? `\n\nIMPORTANT: ${parent} has not saved a PayPal yet, so nothing can be paid.` : ""}`;
}

function historyMessages(s: SessionState): Msg[] {
  return s.chat.slice(-9, -1).map((m): Msg => (m.role === "teen" ? { role: "user", content: m.text + (m.image ? " (attached a photo)" : "") } : { role: "assistant", content: m.text }));
}

/**
 * What the app showed and did recently, as a system note. Kept out of the
 * assistant's own past messages so the model does not imitate it.
 */
function appContext(s: SessionState): string {
  const lines: string[] = [];
  const lastProducts = [...s.chat].reverse().flatMap((m) => m.cards).find((card) => card.type === "products");
  if (lastProducts && lastProducts.type === "products") {
    lines.push("Products the app showed most recently (id, title, price, policy label):");
    for (const p of lastProducts.products.slice(0, 6)) lines.push(`- ${p.id}, ${p.title.slice(0, 60)}, ${p.best ? usd(p.best.price) : "n/a"}, ${lastProducts.policy[p.id]?.outcome ?? "unknown"}`);
  }
  const recent = s.ledger.slice(0, 4);
  if (recent.length > 0) {
    lines.push("Recent purchases and requests recorded by the app:");
    for (const e of recent) lines.push(`- ${e.product.title.slice(0, 60)}, ${usd(Number(e.amount.value))}, ${e.status.replace("_", " ")}`);
  }
  return lines.length > 0 ? `Notes from the app, for context only. Never repeat these notes or write in this format.\n${lines.join("\n")}` : "";
}

/** Does this message ask Kip to find or buy something? Then a tool call is required. */
function looksLikeShopping(text: string): boolean {
  return /\b(need|get me|can you get|buy|order|find|look for|looking for|search|top up|top-up|purchase|i want|i'd like|shop for)\b/i.test(text);
}

/** Removes anything the model wrote in the app's bracket notation. */
function cleanReply(text: string): string {
  return text
    .replace(/\[[^\]]{0,600}\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function previewOf(d: Decision, parent: string): PolicyPreview {
  const label =
    d.outcome === "auto_approved"
      ? `Kip can buy now${d.ruleN ? ` · rule ${d.ruleN}` : ""}`
      : d.outcome === "needs_approval"
        ? `Needs ${parent}'s OK${d.ruleN ? ` · rule ${d.ruleN}` : ""}`
        : `Blocked${d.ruleN ? ` · rule ${d.ruleN}` : ""}`;
  return { outcome: d.outcome, ruleN: d.ruleN, label, category: d.category, confidence: d.confidence };
}

const UNSURE: Omit<Classification, "productId"> = { category: "other", confidence: 0, source: "ai", model: null };

async function withPolicy(result: SearchResult): Promise<{ card: Extract<ChatCard, { type: "products" }>; forModel: unknown[] }> {
  const c = ctx();
  const products = result.products.slice(0, 6);
  const cls = await ensureClassified(products);
  const s = await loadSession(c.sid, c.mode);
  const policy: Record<string, PolicyPreview> = {};
  const forModel: unknown[] = [];
  for (const p of products) {
    const d = decide(s, p, p.best as Offer, cls.get(p.id) ?? { productId: p.id, ...UNSURE });
    policy[p.id] = previewOf(d, s.family.parent.name);
    forModel.push({
      id: p.id,
      title: p.title.slice(0, 90),
      brand: p.brand,
      price: p.best?.price,
      store: p.best?.domain,
      other_offers: Math.max(0, p.offers.length - 1),
      rating: p.rating ? `${p.rating.average} (${p.rating.count})` : null,
      features: p.keyFeatures.slice(0, 2).map((f) => f.slice(0, 80)),
      policy: d.outcome === "auto_approved" ? `can_buy_now (rule ${d.ruleN})` : d.outcome === "needs_approval" ? `needs_parent_ok: ${d.summary}` : `blocked: ${d.summary}`,
    });
  }
  return {
    card: { type: "products", source: "channel3", mode: result.mode, query: result.query, filters: result.filters, cached: result.cached, products, pickId: null, policy },
    forModel,
  };
}

/** The price cap sent to Channel3, taken from the mandate. */
export function priceCapFor(s: SessionState, category: Category | null, userMax: number | null): number | null {
  if (!s.mandate) return userMax;
  const b = budgetStatus(s.mandate, s.ledger);
  if (userMax !== null && userMax > 0) return Math.round(Math.min(userMax, Math.max(s.mandate.weeklyBudget, 1)) * 100) / 100;
  const allow = category ? s.mandate.rules.find((r) => r.kind === "allow" && r.categories.includes(category)) : undefined;
  const cap = allow && allow.kind === "allow" && allow.perItemCap !== null ? Math.min(allow.perItemCap, b.remaining) : b.remaining;
  // With almost nothing left, still search up to the weekly limit so Kip
  // can show what would need an OK.
  return Math.round((cap >= 5 ? cap : s.mandate.weeklyBudget) * 100) / 100;
}

function priceInText(text: string): number | null {
  const m = text.match(/(?:under|below|less than|max|up to|around|about)\s*\$?\s*(\d{1,4}(?:\.\d{1,2})?)/i) ?? text.match(/\$\s*(\d{1,4}(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

type TurnState = {
  cards: ChatCard[];
  finished: { message: Partial<ChatMessage> & { text: string } } | null;
  requestText: string;
  slug: string | null;
};

async function runTool(call: ToolCall, t: TurnState): Promise<string> {
  const c = ctx();
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: "Arguments were not valid JSON." });
  }
  const s = await loadSession(c.sid, c.mode);
  const parent = s.family.parent.name;

  switch (call.name) {
    case "search_products": {
      const query = String(args.query ?? "").trim();
      if (!query) return JSON.stringify({ error: "query is required" });
      const category = isCategory(args.category) ? args.category : null;
      const userMax = typeof args.max_price === "number" && args.max_price > 0 ? args.max_price : priceInText(t.requestText);

      // Screen the request itself before spending a catalog call on it.
      if (category && s.mandate) {
        const blocked = screenRequest({ mandate: s.mandate, paused: false, what: query, classification: { category, confidence: 0.9 }, ledger: s.ledger });
        if (blocked) {
          logStep({ kind: "policy", title: "Policy check on the request: blocked", detail: blocked.summary, ms: null, model: null, data: { checks: blocked.checks } });
          t.cards.push({ type: "blocked", ruleN: blocked.ruleN, ruleText: blocked.ruleText, title: `${CATEGORY_LABEL[category]} are not allowed` });
          await mutateSession(c.sid, c.mode, (st) => {
            st.ledger.unshift({
              id: "led_" + randomUUID().replace(/-/g, "").slice(0, 12),
              createdAt: new Date().toISOString(),
              requestText: t.requestText,
              product: { id: "request", title: `Request: ${query}`, brand: null, image: null, merchant: "no store", buyUrl: null, price: 0 },
              amount: { value: "0.00", currency: "USD" },
              category,
              status: "blocked",
              decision: blocked,
              approvedBy: null,
              approvalId: null,
              paypal: { orderId: null, captureId: null, orderStatus: null, captureStatus: null, refundId: null, refundStatus: null, payerEmail: null, invoiceId: null, lastSyncedAt: null, via: null },
              retailerHandoff: { simulated: true, buyUrl: null, note: "Nothing was searched or bought." },
              kipReason: null,
              undoUntil: null,
              seeded: false,
              replaySlug: t.slug,
              events: [{ at: new Date().toISOString(), text: blocked.summary }],
            });
          });
          const allowed = s.mandate.rules.filter((r) => r.kind === "allow").map((r) => r.text);
          return JSON.stringify({ blocked: true, rule_number: blocked.ruleN, rule_text: blocked.ruleText, nothing_was_searched: true, allowed_instead: allowed, budget_left: usd(blocked.budget.remaining) });
        }
      }

      const maxPrice = priceCapFor(s, category, userMax);
      status("Kip is searching Channel3", "thinking");
      const result = await searchProducts({ query, maxPrice });
      logStep({ kind: "channel3", title: `Channel3 text search: "${query}"`, detail: `${result.products.length} in-stock results${maxPrice !== null ? `, max ${usd(maxPrice)} (from the mandate)` : ""}${result.cached ? ", served from cache" : ""}.`, ms: null, model: null });
      if (result.products.length === 0) return JSON.stringify({ products: [], note: "No in-stock results under that price. Try a different query." });
      status("Kip is checking the rules", "thinking");
      const { card, forModel } = await withPolicy(result);
      t.cards.push(card);
      return JSON.stringify({ filters_applied: { in_stock: true, max_price: maxPrice }, products: forModel });
    }

    case "find_similar": {
      const productId = String(args.product_id ?? "");
      if (!s.seen[productId]) return JSON.stringify({ error: "Unknown product_id. Use one from a search result." });
      const maxPrice = typeof args.max_price === "number" && args.max_price > 0 ? args.max_price : priceCapFor(s, s.seen[productId].classification?.category ?? null, null);
      status("Kip is looking for similar things", "thinking");
      const result = await findSimilar({ productId, maxPrice });
      logStep({ kind: "channel3", title: "Channel3 similar products", detail: `${result.products.length} results${maxPrice !== null ? `, max ${usd(maxPrice)}` : ""}${result.cached ? ", served from cache" : ""}.`, ms: null, model: null });
      if (result.products.length === 0) return JSON.stringify({ products: [] });
      const { card, forModel } = await withPolicy(result);
      t.cards.push(card);
      return JSON.stringify({ products: forModel });
    }

    case "get_product_details": {
      const productId = String(args.product_id ?? "");
      if (!s.seen[productId]) return JSON.stringify({ error: "Unknown product_id. Use one from a search result." });
      status("Kip is checking offers across retailers", "thinking");
      const { product, cached } = await getProduct(productId);
      logStep({ kind: "channel3", title: "Channel3 product detail", detail: `${product.offers.length} offers${cached ? ", served from cache" : ""}.`, ms: null, model: null });
      return JSON.stringify({ id: product.id, title: product.title, offers: product.offers.slice(0, 6).map((o) => ({ store: o.domain, price: o.price, availability: o.availability })), features: product.keyFeatures });
    }

    case "create_order": {
      const productId = String(args.product_id ?? "");
      const why = typeof args.why === "string" && args.why.trim().length > 0 ? args.why.trim().slice(0, 400) : "";
      logStep({ kind: "tool", title: "Kip asked to buy", detail: `create_order(${productId}). The mandate check runs in code before PayPal is called.`, ms: null, model: null });
      const result = await requestPurchase({ productId, requestText: t.requestText, kipReason: why, replaySlug: t.slug });
      for (const card of t.cards) if (card.type === "products" && card.products.some((p) => p.id === productId)) card.pickId = productId;

      if (result.status === "paid") {
        t.cards.push({ type: "receipt", ledgerId: result.entry.id });
        t.finished = { message: { text: why || `Got it: ${result.entry.product.title}.`, ai: why ? { model: "" } : null, mood: "happy", voice: "paid" } };
        return JSON.stringify({ status: "paid" });
      }
      if (result.status === "needs_approval") {
        t.cards.push({ type: "approval", approvalId: result.approval.id });
        if (result.alternatives.length > 0) {
          const policy: Record<string, PolicyPreview> = {};
          for (const a of result.alternatives) policy[a.product.id] = previewOf(a.decision, parent);
          t.cards.push({ type: "products", source: "channel3", mode: "similar", query: "similar, inside the rules", filters: { maxPrice: null, availability: ["InStock"] }, cached: false, products: result.alternatives.map((a) => a.product), pickId: null, policy });
        }
        t.finished = { message: { text: why || result.decision.teenLine, ai: why ? { model: "" } : null, mood: "wait", voice: "ask" } };
        return JSON.stringify({ status: "needs_parent_ok" });
      }
      if (result.status === "blocked") {
        t.cards.push({ type: "blocked", ruleN: result.decision.ruleN, ruleText: result.decision.ruleText, title: result.decision.code === "mandate_paused" ? "Spending is paused" : "Not allowed by the rules" });
        t.finished = { message: { text: result.decision.teenLine, ai: null, mood: result.decision.code === "mandate_paused" ? "paused" : "sorry", voice: result.decision.code === "mandate_paused" ? "paused" : "blocked" } };
        return JSON.stringify({ status: "blocked" });
      }
      if (!result.entry) {
        // Nothing was attempted (for example an id that no search returned).
        // Tell the model and let it search properly.
        return JSON.stringify({ status: "not_attempted", reason: result.reason });
      }
      t.cards.push({ type: "notice", tone: "warn", text: result.reason });
      t.finished = { message: { text: "That didn't go through, and nothing was charged.", ai: null, mood: "sorry" } };
      return JSON.stringify({ status: "failed", reason: result.reason });
    }

    case "get_order_status": {
      const recent = s.ledger.slice(0, 5).map((e) => ({ item: e.product.title.slice(0, 60), amount: usd(Number(e.amount.value)), status: e.status, when: e.createdAt.slice(0, 16) }));
      return JSON.stringify({ recent });
    }

    default:
      return JSON.stringify({ error: `Unknown tool ${call.name}` });
  }
}

export async function handleTeenMessage(input: { text: string; image?: { base64: string; mime: string } | null; slug?: string | null }): Promise<SessionState> {
  const c = ctx();
  const text = input.text.trim().slice(0, 600);
  const teenMsg: ChatMessage = {
    id: "msg_" + randomUUID().slice(0, 10),
    at: new Date().toISOString(),
    role: "teen",
    text: text || "Something like this",
    image: input.image ? `data:${input.image.mime};base64,${input.image.base64}` : null,
    cards: [],
    ai: null,
    mood: null,
    voice: null,
  };
  let s = await mutateSession(c.sid, c.mode, (st) => {
    st.chat.push(teenMsg);
  });
  const t: TurnState = { cards: [], finished: null, requestText: teenMsg.text, slug: input.slug ?? null };
  let reply: ChatMessage;
  let model = "";

  try {
    const context = appContext(s);
    const messages: Msg[] = [{ role: "system", content: systemPrompt(s) + (context ? `\n\n${context}` : "") }, ...historyMessages(s)];
    let userContent = teenMsg.text;

    if (input.image) {
      status("Kip is looking at the photo", "thinking");
      const maxPrice = priceCapFor(s, null, priceInText(teenMsg.text));
      const [caption, result] = await Promise.all([
        chat("vision", {
          use: "vision",
          maxTokens: 120,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Name the main product in this photo in one short phrase for a shopping search: type, color, material. No brand names. Reply with the phrase only." },
                { type: "image_url", image_url: { url: `data:${input.image.mime};base64,${input.image.base64}` } },
              ],
            },
          ],
        }).catch(() => null),
        searchByImage({ base64: input.image.base64, maxPrice }),
      ]);
      if (caption) logStep({ kind: "model", title: "Looked at the photo", detail: caption.content.slice(0, 140), ms: caption.ms, model: caption.model });
      logStep({ kind: "channel3", title: "Channel3 image search", detail: `${result.products.length} in-stock results${maxPrice !== null ? `, max ${usd(maxPrice)} (from the mandate)` : ""}${result.cached ? ", served from cache" : ""}.`, ms: null, model: null });
      let listing = "No matching products were found.";
      if (result.products.length > 0) {
        status("Kip is checking the rules", "thinking");
        const { card, forModel } = await withPolicy(result);
        t.cards.push(card);
        listing = JSON.stringify(forModel);
      }
      userContent = `${teenMsg.text}\n\n[${s.family.teen.name} attached a photo.${caption ? ` It shows: ${caption.content.slice(0, 140)}.` : ""} The app already ran a Channel3 image search with the rules' price cap. Results: ${listing}]\nShow these as options and ask which one, unless ${s.family.teen.name} clearly asked you to buy.`;
    }
    messages.push({ role: "user", content: userContent });

    let finalText: string | null = null;
    for (let turn = 0; turn < MAX_MODEL_TURNS && !t.finished && finalText === null; turn++) {
      if (turn === 0) status("Kip is thinking", "thinking");
      // A shopping request must go through a tool, so the rules are
      // checked by code and not answered from the model's memory of them.
      const mustUseTool = turn === 0 && !input.image && looksLikeShopping(teenMsg.text);
      let r = await chat("kip", { messages, tools: TOOLS, toolChoice: mustUseTool ? "required" : "auto", maxTokens: mustUseTool ? 500 : 1400, temperature: 0.2, effort: "none" });
      if (r.toolCalls.length === 0 && (mustUseTool || cleanReply(r.content).length < 2)) {
        // Now and then the model emits a broken tool call. Ask again, this
        // time letting it think a little first.
        logStep({ kind: "note", title: "Model answer was not usable, asking again", detail: r.content.slice(0, 80), ms: r.ms, model: r.model });
        r = await chat("kip:retry", { messages, tools: TOOLS, toolChoice: "auto", maxTokens: 1400, temperature: 0.2, effort: "low" });
      }
      model = r.model;
      logStep({
        kind: "model",
        title: r.toolCalls.length > 0 ? `Kip decided to call ${r.toolCalls.map((x) => x.name).join(", ")}` : "Kip wrote a reply",
        detail: r.toolCalls.length > 0 ? r.toolCalls.map((x) => `${x.name}(${x.arguments.slice(0, 160)})`).join(" ") : r.content.slice(0, 160),
        ms: r.ms,
        model: r.model,
      });
      if (r.toolCalls.length === 0) {
        finalText = cleanReply(r.content);
        break;
      }
      messages.push({ role: "assistant", content: r.content || null, tool_calls: r.toolCalls.map((x) => ({ id: x.id, type: "function", function: { name: x.name, arguments: x.arguments } })) });
      let bought = false;
      for (const call of r.toolCalls) {
        // One purchase per turn, whatever the model asks for.
        if (call.name === "create_order" && bought) {
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "Only one create_order per message." }) });
          continue;
        }
        if (call.name === "create_order") bought = true;
        const out = t.finished ? JSON.stringify({ skipped: true }) : await runTool(call, t);
        messages.push({ role: "tool", tool_call_id: call.id, content: out });
      }
    }

    if (t.finished) {
      const m = t.finished.message;
      reply = kipSays(m.text, { cards: t.cards, mood: m.mood ?? "idle", voice: m.voice ?? null, ai: m.ai ? { model } : null });
    } else {
      const blocked = t.cards.some((card) => card.type === "blocked");
      reply = kipSays(finalText && finalText.length > 0 ? finalText : "I got a bit tangled there. Can you say that another way?", {
        cards: t.cards,
        ai: finalText ? { model } : null,
        mood: blocked ? "sorry" : s.paused ? "paused" : "idle",
        voice: blocked ? "blocked" : null,
      });
    }
  } catch (err) {
    const notice = err instanceof ReplayMiss ? "Replay mode only covers the recorded demo steps. Switch to Live to try anything else." : err instanceof CatalogError ? "The product catalog (Channel3) did not answer, and there is no cached result for this search." : "The AI model did not answer just now.";
    logStep({ kind: "note", title: "Turn ended early", detail: `${notice} ${(err as Error).message}`.slice(0, 300), ms: null, model: null });
    reply = kipSays("Sorry, I hit a snag and could not finish that. Nothing was charged. Try again in a moment.", { cards: [...t.cards, { type: "notice", tone: "warn", text: notice }], mood: "sorry" });
  }

  s = await mutateSession(c.sid, c.mode, (st) => {
    st.chat.push(reply);
  });
  return s;
}
