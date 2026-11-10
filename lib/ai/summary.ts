/**
 * The weekly summary for the parent. Code computes every number from the
 * ledger; the model only writes the sentences around them.
 */
import { CATEGORY_LABEL } from "../mandate/categories";
import { budgetStatus, BUDGET_WINDOW_MS, usd } from "../mandate/policy";
import type { SessionState } from "../types";
import { chat } from "./llm";
import { logStep } from "../context";

export type WeeklyFacts = {
  weekStart: string;
  purchases: number;
  spent: string;
  budget: string;
  left: string;
  refunded: number;
  refundedAmount: string;
  askedParent: number;
  approvedByParent: number;
  declinedByParent: number;
  blocked: number;
  topCategory: string;
  items: string;
};

export function weeklyFacts(s: Pick<SessionState, "mandate" | "ledger" | "approvals">, now: Date = new Date()): WeeklyFacts {
  const from = now.getTime() - BUDGET_WINDOW_MS;
  const inWeek = s.ledger.filter((e) => Date.parse(e.createdAt) >= from);
  const paid = inWeek.filter((e) => e.status === "paid");
  const refunded = inWeek.filter((e) => e.status === "refunded");
  const budget = budgetStatus(s.mandate, s.ledger, now);
  const byCat = new Map<string, number>();
  for (const e of paid) byCat.set(e.category, (byCat.get(e.category) ?? 0) + Number(e.amount.value));
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0];
  const approvals = s.approvals.filter((a) => Date.parse(a.createdAt) >= from);
  return {
    weekStart: new Date(from).toISOString().slice(0, 10),
    purchases: paid.length,
    spent: usd(budget.spent),
    budget: usd(budget.limit),
    left: usd(budget.remaining),
    refunded: refunded.length,
    refundedAmount: usd(refunded.reduce((sum, e) => sum + Number(e.amount.value), 0)),
    askedParent: approvals.length,
    approvedByParent: approvals.filter((a) => a.status === "approved").length,
    declinedByParent: approvals.filter((a) => a.status === "declined").length,
    blocked: inWeek.filter((e) => e.status === "blocked").length,
    topCategory: top ? `${CATEGORY_LABEL[top[0] as keyof typeof CATEGORY_LABEL]} (${usd(top[1])})` : "none",
    items: paid
      .slice(0, 8)
      .map((e) => `${e.product.title.slice(0, 60)} (${usd(Number(e.amount.value))}, rule ${e.decision.ruleN ?? "none"}${e.approvedBy === "parent" ? ", you approved it" : ""})`)
      .join("; "),
  };
}

export async function writeWeeklySummary(s: Pick<SessionState, "mandate" | "ledger" | "approvals" | "family">): Promise<{ text: string; model: string; facts: WeeklyFacts }> {
  const facts = weeklyFacts(s);
  const r = await chat("summary", {
    messages: [
      {
        role: "system",
        content: `You are Kip, a shopping agent for a teenager, writing the weekly note to the parent, ${s.family.parent.name}. Be polite, precise and brief: three or four sentences, plain text, no lists, no emoji, no dashes used as punctuation. Use only the numbers in the facts. Mention what ${s.family.teen.name} bought and under which rules, what needed approval, anything blocked or refunded, and how much budget is left. If nothing was bought, say so plainly. Do not give parenting advice.`,
      },
      { role: "user", content: `Facts for the last seven days:\n${JSON.stringify(facts, null, 1)}` },
    ],
    maxTokens: 500,
    temperature: 0.3,
    effort: "none",
  });
  logStep({ kind: "model", title: "Wrote the weekly summary from the ledger", detail: `${facts.purchases} purchases, ${facts.spent} of ${facts.budget}.`, ms: r.ms, model: r.model });
  return { text: r.content, model: r.model, facts };
}
