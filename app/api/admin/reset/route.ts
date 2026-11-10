import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getTemplate } from "@/lib/session";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function tokenOk(given: string | null): boolean {
  const expected = process.env.DEMO_ADMIN_TOKEN;
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Restores the seeded demo state: every visitor session is dropped, so the
 * next page load clones a clean family from the seeded template (saved
 * PayPal, signed mandate, past purchases). The template itself is kept.
 *
 *   curl -X POST https://<host>/api/admin/reset -H "x-admin-token: $DEMO_ADMIN_TOKEN"
 */
export async function POST(req: NextRequest) {
  if (!tokenOk(req.headers.get("x-admin-token"))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  const s = store();
  let sessions = 0;
  for (const key of await s.list("s/")) {
    await s.del(key);
    sessions++;
  }
  let indexes = 0;
  for (const key of await s.list("idx/")) {
    await s.del(key);
    indexes++;
  }
  await s.del("webhooks/recent");
  const template = await getTemplate("live");
  return NextResponse.json({
    ok: true,
    cleared: { sessions, indexes },
    seeded: Boolean(template?.vault),
    note: template?.vault ? "New sessions start from the seeded template." : "No seeded template found. Run `pnpm seed` against this store.",
  });
}
