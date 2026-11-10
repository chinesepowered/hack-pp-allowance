import type { NextRequest } from "next/server";
import { undoPurchase } from "@/lib/actions";
import { api } from "@/lib/http";
import { loadSession, toClient } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The parent's Undo: a full PayPal refund, allowed for 24 hours. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return api(
    req,
    {
      feature: "Undo (refund)",
      limit: "money",
      scenario: async (c) => {
        const s = await loadSession(c.sid, c.mode);
        const slug = s.ledger.find((e) => e.id === id)?.replaySlug;
        return slug ? `undo-${slug}` : null;
      },
    },
    async () => ({ state: toClient(await undoPurchase(id)) }),
  );
}
