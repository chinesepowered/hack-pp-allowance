import { NextResponse, type NextRequest } from "next/server";
import { kipSays } from "@/lib/actions";
import { handleTeenMessage } from "@/lib/agent/kip";
import { runWithContext, type StreamEvent } from "@/lib/context";
import { SCRIPTED_PROMPTS } from "@/lib/demo/defaults";
import { attachTape, buildContext, LIMITS, rateLimit, readSession, setSessionCookies } from "@/lib/http";
import { flushLogs, mutateSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_IMAGE_BASE64 = 2_000_000;
const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];

type Body = { text?: string; slug?: string | null; image?: { base64?: string; mime?: string } | null };

/**
 * The teen talks to Kip. The answer is streamed as newline-delimited JSON:
 * status lines ("Kip is checking the rules"), each agent step, each PayPal
 * and Channel3 call, then {type:"done"}. The client reloads state after.
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "ai", LIMITS.ai.max, LIMITS.ai.windowMs);
  if (!limited.ok) return NextResponse.json({ error: `Kip needs a short break. Try again in ${limited.retryAfter} seconds.` }, { status: 429, headers: { "Retry-After": String(limited.retryAfter) } });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "The request body must be JSON." }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 600) : "";
  const image = body.image && typeof body.image.base64 === "string" && typeof body.image.mime === "string" ? { base64: body.image.base64, mime: body.image.mime } : null;
  if (!text && !image) return NextResponse.json({ error: "Say something to Kip first." }, { status: 400 });
  if (image && (!IMAGE_MIMES.includes(image.mime) || image.base64.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(image.base64))) {
    return NextResponse.json({ error: "That photo could not be used. Try a JPEG or PNG under 1.5 MB." }, { status: 400 });
  }
  const slug = SCRIPTED_PROMPTS.find((p) => p.slug === body.slug)?.slug ?? null;

  const { sid, mode, isNew } = readSession(req);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (ev: StreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
        } catch {
          closed = true;
        }
      };
      const c = buildContext(sid, mode, "Teen chat with Kip", send);
      void runWithContext(c, async () => {
        try {
          await attachTape(c, mode === "replay" && slug ? `chat-${slug}` : null);
          if (mode === "replay" && !slug) {
            await mutateSession(sid, mode, (s) => {
              s.chat.push({ id: "msg_" + Date.now().toString(36), at: new Date().toISOString(), role: "teen", text: text || "Something like this", image: null, cards: [], ai: null, mood: null, voice: null });
              s.chat.push(kipSays("You are watching a replay, so I can only do the three recorded requests below. Switch to Live to ask me anything.", { mood: "idle", cards: [{ type: "notice", tone: "info", text: "Replay mode runs recorded sandbox and AI responses. Live is the default." }] }));
            });
          } else {
            await handleTeenMessage({ text, image, slug });
          }
          send({ type: "done", ok: true });
        } catch (err) {
          console.error("[chat]", err);
          send({ type: "done", ok: false, error: "Kip could not finish that. Nothing was charged." });
        } finally {
          await flushLogs().catch(() => undefined);
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      });
    },
  });

  const res = new NextResponse(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  if (isNew) setSessionCookies(res, sid, mode);
  return res;
}
