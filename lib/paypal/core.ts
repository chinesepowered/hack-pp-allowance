/**
 * PayPal plumbing shared by every PayPal feature.
 *
 *  - sdk(): the @paypal/paypal-server-sdk client, built once and held (its
 *    OAuth token cache lives on it).
 *  - sdkCall(): runs one SDK operation, logs it for the Under the hood
 *    drawer (method, path, status, PayPal-Debug-Id) and turns SDK errors
 *    into PayPalError.
 *  - rest(): plain REST for the endpoints the server SDK does not cover
 *    (webhook verification and registration, the browser-safe client token),
 *    using one cached OAuth token.
 *
 * Sandbox only: the base URL is fixed to api-m.sandbox.paypal.com.
 */
import { ApiError, Client, Environment } from "@paypal/paypal-server-sdk";
import type { ApiResponse } from "@paypal/paypal-server-sdk";
import { randomUUID } from "node:crypto";
import { assertSandbox, PAYPAL_BASE_URL, requireEnv } from "../env";
import { ctx, logPayPalCall } from "../context";
import { external } from "../replay/vcr";

export type PPResult<T = unknown> = { status: number; debugId: string | null; body: T; ms: number };

export class PayPalError extends Error {
  constructor(
    public status: number,
    public debugId: string | null,
    public issue: string,
    message: string,
    public details: unknown,
  ) {
    super(message);
    this.name = "PayPalError";
  }
  /** INSTRUMENT_DECLINED and friends: the saved PayPal cannot pay. Do not retry. */
  get declined(): boolean {
    return this.status === 422 && /INSTRUMENT_DECLINED|PAYER_CANNOT_PAY|TRANSACTION_REFUSED|PAYMENT_SOURCE_DECLINED/i.test(this.issue);
  }
}

/** Thrown when a write may have reached PayPal but no answer came back. */
export class PayPalUnknownOutcome extends Error {
  constructor(
    public requestId: string,
    public cause_: unknown,
  ) {
    super("PayPal did not answer. The outcome is unknown until it is re-read.");
    this.name = "PayPalUnknownOutcome";
  }
}

let client: Client | null = null;

export function sdk(): Client {
  assertSandbox();
  if (client) return client;
  client = new Client({
    clientCredentialsAuthCredentials: {
      oAuthClientId: requireEnv("PAYPAL_CLIENT_ID"),
      oAuthClientSecret: requireEnv("PAYPAL_CLIENT_SECRET"),
    },
    environment: Environment.Sandbox,
    timeout: 30000,
    // No `logging` block on purpose: bodies carry payer details, and the
    // SDK's logLevel is the level it logs every request at, not a
    // threshold. The app logs its own call summary instead.
  });
  return client;
}

function header(headers: Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : null;
}

function parseBody(raw: unknown): unknown {
  if (typeof raw === "string") {
    if (raw.length === 0) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw ?? null;
}

function issueOf(body: unknown): { issue: string; message: string } {
  const b = (body ?? {}) as { name?: string; message?: string; details?: { issue?: string; description?: string }[]; error?: string; error_description?: string };
  const first = b.details?.[0];
  return {
    issue: first?.issue ?? b.name ?? b.error ?? "PAYPAL_ERROR",
    message: first?.description ?? b.message ?? b.error_description ?? "PayPal could not complete the request.",
  };
}

type CallMeta = { op: string; method: string; path: string; requestId?: string | null; note?: string | null; isWrite?: boolean };

/**
 * One server SDK operation. Returns the raw JSON body (snake_case, exactly
 * as PayPal sent it) so the app speaks the same field names as the REST
 * reference and the agent toolkit.
 */
export async function sdkCall<T = unknown>(meta: CallMeta, fn: () => Promise<ApiResponse<unknown>>): Promise<PPResult<T>> {
  const res = await external<PPResult<T> & { error?: { issue: string; message: string; details: unknown } }>("paypal", meta.op, async () => {
    const t0 = Date.now();
    try {
      const r = await fn();
      return { status: r.statusCode, debugId: header(r.headers, "paypal-debug-id"), body: parseBody(r.body) as T, ms: Date.now() - t0 };
    } catch (err) {
      if (err instanceof ApiError) {
        const body = parseBody(err.body);
        const { issue, message } = issueOf(body);
        // Recorded as data so the caller below can raise it in both modes.
        return { status: err.statusCode, debugId: header(err.headers, "paypal-debug-id"), body: body as T, ms: Date.now() - t0, error: { issue, message, details: body } };
      }
      if (meta.isWrite && meta.requestId) throw new PayPalUnknownOutcome(meta.requestId, err);
      throw err;
    }
  });
  logPayPalCall({ method: meta.method, path: meta.path, status: res.status, debugId: res.debugId, via: "server-sdk", ms: res.ms, requestId: meta.requestId ?? null, note: meta.note ?? null });
  if (res.error) throw new PayPalError(res.status, res.debugId, res.error.issue, res.error.message, res.error.details);
  return { status: res.status, debugId: res.debugId, body: res.body, ms: res.ms };
}

/* ----------------------------- plain REST ----------------------------- */

let cachedToken: { token: string; expiresAt: number } | null = null;

/** Client credentials token, cached until a minute before it expires. */
export async function accessToken(): Promise<string> {
  assertSandbox();
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.token;
  const basic = Buffer.from(`${requireEnv("PAYPAL_CLIENT_ID")}:${requireEnv("PAYPAL_CLIENT_SECRET")}`).toString("base64");
  const t0 = Date.now();
  const r = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const debugId = r.headers.get("paypal-debug-id");
  logPayPalCall({ method: "POST", path: "/v1/oauth2/token", status: r.status, debugId, via: "rest", ms: Date.now() - t0, requestId: null, note: "client credentials" });
  const json = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!r.ok || !json.access_token) throw new PayPalError(r.status, debugId, "OAUTH_FAILED", json.error_description ?? "Could not get a PayPal access token.", json);
  cachedToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 300) * 1000 };
  return cachedToken.token;
}

export async function rest<T = unknown>(
  meta: { op: string; note?: string | null },
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<PPResult<T>> {
  const requestId = method === "POST" ? (extraHeaders["PayPal-Request-Id"] ?? randomUUID()) : null;
  const res = await external<PPResult<T>>("paypal", meta.op, async () => {
    const t0 = Date.now();
    const headers: Record<string, string> = { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...extraHeaders };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    // A string body is sent byte for byte (webhook verification needs that).
    const r = await fetch(`${PAYPAL_BASE_URL}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, debugId: r.headers.get("paypal-debug-id"), body: parseBody(text) as T, ms: Date.now() - t0 };
  });
  logPayPalCall({ method, path, status: res.status, debugId: res.debugId, via: "rest", ms: res.ms, requestId, note: meta.note ?? null });
  if (res.status >= 400) {
    const { issue, message } = issueOf(res.body);
    throw new PayPalError(res.status, res.debugId, issue, message, res.body);
  }
  return res;
}

/** A PayPal-Request-Id that is the same for every retry of the same thing. */
export function requestIdFor(...parts: string[]): string {
  return ["alw", ctx().mode === "replay" ? "replay" : "live", ...parts].join("-").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 100);
}
