/**
 * Shared wrapper for API routes: session cookie, Live or Replay mode,
 * per-request context, rate limits and one place that turns errors into
 * honest HTTP answers.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ActionError } from "./actions";
import { CatalogError } from "./channel3/client";
import { newContext, runWithContext, type RequestContext, type StreamEvent } from "./context";
import { MandateDraftError } from "./mandate/schema";
import { PayPalError, PayPalUnknownOutcome } from "./paypal/core";
import { loadTape } from "./replay/tapes";
import { ReplayMiss } from "./replay/vcr";
import { flushLogs, newSid } from "./session";
import type { Mode } from "./types";

export const SID_COOKIE = "alw_sid";
export const MODE_COOKIE = "alw_mode";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 14;

export function readSession(req: NextRequest): { sid: string; mode: Mode; isNew: boolean } {
  const existing = req.cookies.get(SID_COOKIE)?.value;
  const valid = existing && /^[a-z0-9]{12,40}$/.test(existing) ? existing : null;
  const mode: Mode = req.cookies.get(MODE_COOKIE)?.value === "replay" ? "replay" : "live";
  return { sid: valid ?? newSid(), mode, isNew: !valid };
}

export function setSessionCookies(res: NextResponse, sid: string, mode?: Mode): void {
  const secure = process.env.NODE_ENV === "production";
  res.cookies.set(SID_COOKIE, sid, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: COOKIE_MAX_AGE });
  if (mode) res.cookies.set(MODE_COOKIE, mode, { httpOnly: false, sameSite: "lax", secure, path: "/", maxAge: COOKIE_MAX_AGE });
}

/* ----------------------------- rate limiting ----------------------------- */

const hits = new Map<string, number[]>();

export function clientIp(req: NextRequest): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

/**
 * Sliding window per IP, in memory. On serverless each instance keeps its
 * own window, which is enough to stop one visitor from draining the free
 * model and catalog credits.
 */
export function rateLimit(req: NextRequest, bucket: string, max: number, windowMs: number): { ok: boolean; retryAfter: number } {
  if (process.env.ALLOWANCE_RATE_LIMIT === "off") return { ok: true, retryAfter: 0 };
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) {
    hits.set(key, list);
    return { ok: false, retryAfter: Math.ceil((windowMs - (now - list[0])) / 1000) };
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t > windowMs)) hits.delete(k);
  return { ok: true, retryAfter: 0 };
}

export const LIMITS = {
  ai: { max: 20, windowMs: 60_000 },
  money: { max: 12, windowMs: 60_000 },
  read: { max: 240, windowMs: 60_000 },
};

/* ----------------------------- errors ----------------------------- */

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ActionError) return NextResponse.json({ error: err.message }, { status: err.httpStatus });
  if (err instanceof MandateDraftError) return NextResponse.json({ error: err.message, issues: err.issues }, { status: 422 });
  if (err instanceof ReplayMiss) return NextResponse.json({ error: "Replay mode only covers the recorded demo steps. Switch to Live to do this.", replayMiss: true }, { status: 409 });
  if (err instanceof PayPalUnknownOutcome) return NextResponse.json({ error: "PayPal did not answer. The outcome is unknown and will be re-read; nothing is assumed." }, { status: 502 });
  if (err instanceof PayPalError) {
    // 401 and 403 are about this app's credentials, not the user's input.
    if (err.status === 401 || err.status === 403) return NextResponse.json({ error: "PayPal did not accept this app's sandbox credentials.", debugId: err.debugId }, { status: 502 });
    if (err.status === 429) return NextResponse.json({ error: "PayPal is rate limiting this app. Try again in a moment.", debugId: err.debugId }, { status: 503 });
    if (err.status >= 500 || err.status === 0) return NextResponse.json({ error: "PayPal had a problem on its side. Nothing was changed.", debugId: err.debugId }, { status: 502 });
    return NextResponse.json({ error: err.message, issue: err.issue, debugId: err.debugId }, { status: err.status });
  }
  if (err instanceof CatalogError) return NextResponse.json({ error: "The product catalog (Channel3) did not answer." }, { status: 502 });
  // Anything unmapped is ours. The detail goes to the server log, never to
  // the caller: an SDK or library message can name internal URLs.
  console.error("[api]", err);
  return NextResponse.json({ error: "Something went wrong on our side. Nothing was charged by this step." }, { status: 500 });
}

/* ----------------------------- the wrapper ----------------------------- */

type Options = {
  feature: string;
  limit?: keyof typeof LIMITS;
  /** In Replay mode, the tape to answer outside calls from. */
  scenario?: string | null | ((c: RequestContext) => Promise<string | null> | string | null);
};

export function buildContext(sid: string, mode: Mode, feature: string, emit: ((ev: StreamEvent) => void) | null = null): RequestContext {
  const c = newContext({ sid, mode, feature });
  c.emit = emit;
  return c;
}

export async function attachTape(c: RequestContext, scenario: Options["scenario"]): Promise<void> {
  if (c.mode !== "replay") return;
  const name = typeof scenario === "function" ? await scenario(c) : scenario;
  const tape = name ? loadTape(name) : null;
  // No tape means every outside call misses, which the routes report as
  // "Replay does not cover this".
  c.tape = { mode: "replay", tape: tape ?? { scenario: name ?? "none", recordedAt: "", note: "", exchanges: [] }, used: new Set() };
}

export async function api(req: NextRequest, opts: Options, fn: (c: RequestContext) => Promise<unknown>): Promise<NextResponse> {
  if (opts.limit) {
    const l = LIMITS[opts.limit];
    const r = rateLimit(req, opts.limit, l.max, l.windowMs);
    if (!r.ok) return NextResponse.json({ error: `Slow down a little. Try again in ${r.retryAfter} seconds.` }, { status: 429, headers: { "Retry-After": String(r.retryAfter) } });
  }
  const { sid, mode, isNew } = readSession(req);
  const c = buildContext(sid, mode, opts.feature);
  let res: NextResponse;
  try {
    res = await runWithContext(c, async () => {
      await attachTape(c, opts.scenario);
      try {
        const out = await fn(c);
        return out instanceof NextResponse ? out : NextResponse.json(out ?? { ok: true });
      } finally {
        await flushLogs().catch(() => undefined);
      }
    });
  } catch (err) {
    res = errorResponse(err);
  }
  if (isNew) setSessionCookies(res, sid, mode);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function jsonBody<T>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ActionError("The request body must be JSON.", 400);
  }
}
