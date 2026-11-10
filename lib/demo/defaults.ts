/**
 * The fictional demo family and the rules Dana writes in the brief.
 * All people here are made up.
 */
import type { MandateDraft } from "../mandate/schema";

export const FAMILY = {
  parent: { name: "Dana" },
  teen: { name: "Leo", age: 15 },
};

export const DEFAULT_RULES_TEXT =
  "Up to $60 a week. School supplies and books any time. Clothes up to $40 an item. No gaming or gift cards. Anything over $25 from a store we haven't used before needs my OK.";

/**
 * The structured form of DEFAULT_RULES_TEXT, used to pre-sign the seeded
 * demo mandate so a judge lands on a working family. When a parent edits
 * the rules in the app, the model produces this shape live instead.
 */
export const DEFAULT_DRAFT: MandateDraft = {
  rules: [
    { kind: "budget", text: "Up to $60 a week", weeklyLimit: 60 },
    { kind: "allow", text: "School supplies and books any time", categories: ["school_supplies", "books"], perItemCap: null },
    { kind: "allow", text: "Clothes up to $40 an item", categories: ["clothing"], perItemCap: 40 },
    { kind: "block", text: "No gaming or gift cards", categories: ["gaming", "gift_cards"], merchants: [] },
    { kind: "approval", text: "Anything over $25 from a store we haven't used before needs my OK", overAmount: 25, when: "new_merchant", categories: [] },
  ],
  expiresInDays: 90,
  unclear: [],
};

/** The three requests of the aha moment, also the Replay script. */
export const SCRIPTED_PROMPTS = [
  { slug: "notebooks", label: "Notebooks for school", text: "I need college ruled notebooks for school, a pack if you can" },
  { slug: "sneakers", label: "Sneakers, about $55", text: "Can you get me white canvas sneakers, around $55?" },
  { slug: "gaming", label: "Game top-up", text: "Top up my game account with a $20 gaming gift card" },
] as const;

export type ScriptedSlug = (typeof SCRIPTED_PROMPTS)[number]["slug"];

export const EXTRA_PROMPTS = [
  "I need a graphing calculator for algebra, the cheaper the better",
  "Find me a rain jacket under $40",
  "How much can I still spend this week?",
];
