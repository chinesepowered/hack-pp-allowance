import { NextResponse } from "next/server";
import { hasLiveKeys, models } from "@/lib/env";
import { tapeInfo } from "@/lib/replay/tapes";
import { getTemplate } from "@/lib/session";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

/** What is configured, without revealing any value. */
export async function GET() {
  const keys = hasLiveKeys();
  const template = await getTemplate("live").catch(() => null);
  return NextResponse.json(
    {
      ok: true,
      environment: "sandbox",
      configured: { ...keys, mandateSigning: Boolean(process.env.MANDATE_SIGNING_SECRET), webhookId: Boolean(process.env.PAYPAL_WEBHOOK_ID), adminToken: Boolean(process.env.DEMO_ADMIN_TOKEN) },
      store: store().kind,
      seeded: Boolean(template?.vault),
      seededPurchases: template?.purchases.length ?? 0,
      models: models(),
      replayTapes: tapeInfo(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
