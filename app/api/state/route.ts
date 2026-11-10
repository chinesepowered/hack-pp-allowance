import type { NextRequest } from "next/server";
import { syncFromPayPal } from "@/lib/actions";
import { api } from "@/lib/http";
import { loadSession, toClient } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The whole demo state for this browser's session. With ?sync=1 the money
 * state is first re-read from PayPal, so the screen is right even when no
 * webhook has arrived.
 */
export async function GET(req: NextRequest) {
  const sync = req.nextUrl.searchParams.get("sync") === "1";
  return api(req, { feature: sync ? "Refresh from PayPal" : "Load state", limit: "read" }, async (c) => {
    const state = sync && c.mode === "live" ? await syncFromPayPal() : await loadSession(c.sid, c.mode);
    return { state: toClient(state) };
  });
}
