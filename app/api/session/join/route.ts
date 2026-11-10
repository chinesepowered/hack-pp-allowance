import { NextResponse, type NextRequest } from "next/server";
import { setSessionCookies } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Opens the same demo family on a second device, for example the parent
 * view on a phone: /api/session/join?s=<session id>&to=/parent
 */
export async function GET(req: NextRequest) {
  const s = req.nextUrl.searchParams.get("s") ?? "";
  const to = req.nextUrl.searchParams.get("to") ?? "/parent";
  const target = new URL(to.startsWith("/") && !to.startsWith("//") ? to : "/parent", req.nextUrl.origin);
  const res = NextResponse.redirect(target);
  if (/^[a-z0-9]{12,40}$/.test(s)) setSessionCookies(res, s, "live");
  return res;
}
