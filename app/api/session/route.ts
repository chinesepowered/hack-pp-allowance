import { NextResponse, type NextRequest } from "next/server";
import { ActionError } from "@/lib/actions";
import { api, jsonBody, setSessionCookies } from "@/lib/http";
import { loadSession, resetSession, toClient } from "@/lib/session";
import type { Mode } from "@/lib/types";

export const dynamic = "force-dynamic";

type Body = { action?: "reset" | "fresh" | "mode"; mode?: Mode };

/**
 * Session controls for the demo:
 *   reset  back to the seeded family (saved PayPal, signed mandate, history)
 *   fresh  an empty family, to walk through the two-minute parent setup
 *   mode   switch between Live and Replay
 */
export async function POST(req: NextRequest) {
  return api(req, { feature: "Session", limit: "read" }, async (c) => {
    const body = await jsonBody<Body>(req);
    if (body.action === "reset") return { state: toClient(await resetSession(c.sid, c.mode)) };
    if (body.action === "fresh") return { state: toClient(await resetSession(c.sid, c.mode, { fresh: true })) };
    if (body.action === "mode") {
      const mode: Mode = body.mode === "replay" ? "replay" : "live";
      const res = NextResponse.json({ state: toClient(await loadSession(c.sid, mode)) });
      setSessionCookies(res, c.sid, mode);
      return res;
    }
    throw new ActionError("Unknown session action.");
  });
}
