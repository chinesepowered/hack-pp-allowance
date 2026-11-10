import type { NextRequest } from "next/server";
import { refreshSummary } from "@/lib/actions";
import { api } from "@/lib/http";
import { toClient } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The weekly summary: numbers from the ledger in code, sentences by the model. */
export async function POST(req: NextRequest) {
  return api(req, { feature: "Weekly summary (AI)", limit: "ai", scenario: "summary" }, async () => ({ state: toClient(await refreshSummary()) }));
}
