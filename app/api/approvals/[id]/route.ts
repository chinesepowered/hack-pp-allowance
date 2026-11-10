import type { NextRequest } from "next/server";
import { ActionError, resolveApproval } from "@/lib/actions";
import { api, jsonBody } from "@/lib/http";
import { loadSession, toClient } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The parent taps Approve, Decline, or Approve and add a rule. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return api(
    req,
    {
      feature: "Parent approval",
      limit: "money",
      scenario: async (c) => {
        const s = await loadSession(c.sid, c.mode);
        const slug = s.approvals.find((a) => a.id === id)?.replaySlug;
        return slug ? `approve-${slug}` : null;
      },
    },
    async () => {
      const { action } = await jsonBody<{ action?: string }>(req);
      if (action !== "approve" && action !== "decline" && action !== "approve_and_add_rule") throw new ActionError("Unknown action.");
      const { state } = await resolveApproval(id, action);
      return { state: toClient(state) };
    },
  );
}
