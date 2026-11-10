/**
 * The mandate draft the model proposes, validated with Zod before a parent
 * ever sees it. The model can only fill in this shape; anything else is
 * rejected and retried.
 */
import { z } from "zod";
import { CATEGORIES, type Category } from "./categories";
import type { MandateBody, Rule } from "../types";

const category = z.enum(CATEGORIES);
const money = z.number().finite().min(0).max(100000);
const text = z.string().trim().min(3).max(240);

export const draftRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("budget"), text, weeklyLimit: money.min(1) }),
  z.object({
    kind: z.literal("allow"),
    text,
    categories: z.array(category).min(1).max(CATEGORIES.length),
    perItemCap: money.min(1).nullable().default(null),
  }),
  z.object({
    kind: z.literal("block"),
    text,
    categories: z.array(category).max(CATEGORIES.length).default([]),
    merchants: z.array(z.string().trim().min(3).max(80)).max(20).default([]),
  }),
  z.object({
    kind: z.literal("approval"),
    text,
    overAmount: money.nullable().default(null),
    when: z.enum(["always", "new_merchant"]).default("always"),
    categories: z.array(category).max(CATEGORIES.length).default([]),
  }),
]);

export const mandateDraftSchema = z.object({
  rules: z.array(draftRuleSchema).min(1).max(12),
  expiresInDays: z.number().int().min(1).max(365).default(90),
  /** Things the model could not turn into a rule, shown to the parent. */
  unclear: z.array(z.string().trim().max(200)).max(5).default([]),
});

export type MandateDraft = z.infer<typeof mandateDraftSchema>;
export type DraftRule = z.infer<typeof draftRuleSchema>;

export class MandateDraftError extends Error {
  constructor(
    message: string,
    public issues: string[],
  ) {
    super(message);
  }
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function normalizeMerchant(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split("/")[0] ?? s;
  return s;
}

/**
 * Checks that go beyond shape: exactly one budget, no category both allowed
 * and blocked, block rules that block something. Returns numbered rules.
 */
export function normalizeDraft(draft: MandateDraft): { rules: Rule[]; weeklyBudget: number; expiresInDays: number; unclear: string[] } {
  const issues: string[] = [];
  const budgets = draft.rules.filter((r) => r.kind === "budget");
  if (budgets.length === 0) issues.push("Add a weekly budget, for example: Up to $60 a week.");
  if (budgets.length > 1) issues.push("There is more than one weekly budget. Keep one.");

  const blocked = new Set<Category>();
  for (const r of draft.rules) if (r.kind === "block") r.categories.forEach((c) => blocked.add(c));
  for (const r of draft.rules) {
    if (r.kind === "allow") {
      const clash = r.categories.filter((c) => blocked.has(c));
      if (clash.length > 0) issues.push(`"${r.text}" allows something another rule blocks (${clash.join(", ")}).`);
    }
    if (r.kind === "block" && r.categories.length === 0 && r.merchants.length === 0) {
      issues.push(`"${r.text}" does not say what to block.`);
    }
  }
  if (issues.length > 0) throw new MandateDraftError("The rules need a small fix before signing.", issues);

  // Budget first, then the rest in the parent's order. Numbers are stable
  // so receipts can say "rule 2".
  const ordered = [...draft.rules].sort((a, b) => (a.kind === "budget" ? -1 : b.kind === "budget" ? 1 : 0));
  const rules: Rule[] = ordered.map((r, i) => {
    const n = i + 1;
    switch (r.kind) {
      case "budget":
        return { kind: "budget", n, text: r.text, weeklyLimit: round2(r.weeklyLimit) };
      case "allow":
        return { kind: "allow", n, text: r.text, categories: uniq(r.categories), perItemCap: r.perItemCap === null ? null : round2(r.perItemCap) };
      case "block":
        return { kind: "block", n, text: r.text, categories: uniq(r.categories), merchants: uniq(r.merchants.map(normalizeMerchant)) };
      case "approval":
        return { kind: "approval", n, text: r.text, overAmount: r.overAmount === null ? null : round2(r.overAmount), when: r.when, categories: uniq(r.categories) };
    }
  });
  return { rules, weeklyBudget: round2(budgets[0].weeklyLimit), expiresInDays: draft.expiresInDays, unclear: draft.unclear };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function buildMandateBody(input: {
  id: string;
  version: number;
  rulesText: string;
  rules: Rule[];
  weeklyBudget: number;
  expiresInDays: number;
  trustedMerchants?: string[];
  parent: { name: string };
  teen: { name: string; age: number };
  now?: Date;
}): MandateBody {
  const now = input.now ?? new Date();
  return {
    id: input.id,
    version: input.version,
    kind: "intent-mandate",
    parent: input.parent,
    teen: input.teen,
    agent: { name: "Kip" },
    currency: "USD",
    rulesText: input.rulesText,
    weeklyBudget: input.weeklyBudget,
    rules: input.rules,
    trustedMerchants: uniq((input.trustedMerchants ?? []).map(normalizeMerchant)),
    defaultAction: "ask_parent",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.expiresInDays * 86400000).toISOString(),
  };
}
