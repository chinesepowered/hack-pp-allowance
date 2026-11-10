import type { NextRequest } from "next/server";
import { setPaused } from "@/lib/actions";
import { api, jsonBody } from "@/lib/http";
import { toClient } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The kill switch. Pausing takes effect on the very next policy check. */
export async function POST(req: NextRequest) {
  return api(req, { feature: "Pause mandate", limit: "money" }, async () => {
    const { paused } = await jsonBody<{ paused?: boolean }>(req);
    return { state: toClient(await setPaused(Boolean(paused))) };
  });
}
