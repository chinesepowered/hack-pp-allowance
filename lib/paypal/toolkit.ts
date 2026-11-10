/**
 * PayPal Agent Toolkit (@paypal/agent-toolkit), wrapped.
 *
 * The toolkit gives an agent the tools create_order, get_order and
 * create_refund. Out of the box a model could call them with any amount.
 * Here they are never handed to the model directly:
 *
 *  - lib/agent/guard.ts runs the mandate check in code, and only then calls
 *    toolkitRun("create_order", ...) with arguments built by code from the
 *    Channel3 offer, never from model text.
 *  - The saved PayPal (the vault id) is attached here, server-side, by an
 *    axios request interceptor. The model never sees it and the toolkit's
 *    own create_order schema has no field for it.
 *  - Every toolkit HTTP call is observed so the Under the hood drawer can
 *    show method, path, status and PayPal-Debug-Id.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/openai";
import { assertSandbox, requireEnv } from "../env";
import { logPayPalCall } from "../context";
import { external } from "../replay/vcr";
import { PayPalError, PayPalUnknownOutcome, type PPResult } from "./core";

type Captured = { method: string; path: string; status: number; debugId: string | null; ms: number; data: unknown; network: boolean };

type Scope = {
  requestId: string | null;
  inject: { paymentSource: unknown; unit: Record<string, unknown> } | null;
  captured: Captured[];
};

const scope = new AsyncLocalStorage<Scope>();
const PAYPAL_HOST = /^https:\/\/api(-m)?\.sandbox\.paypal\.com\//;

type AxiosLike = {
  interceptors: {
    request: { use(fn: (config: AxiosConfig) => AxiosConfig): number };
    response: { use(ok: (res: AxiosResponse) => AxiosResponse, fail: (err: AxiosFailure) => Promise<never>): number };
  };
};
type AxiosConfig = { url?: string; method?: string; data?: unknown; headers: Record<string, string> & { set?: (k: string, v: string) => void }; __t0?: number };
type AxiosResponse = { status: number; headers: Record<string, string>; data: unknown; config: AxiosConfig };
type AxiosFailure = { response?: AxiosResponse; config?: AxiosConfig; message?: string };

let installed = false;
let interceptorAvailable = false;

/**
 * The toolkit calls PayPal with the default axios instance of its own
 * dependency tree. Resolve that exact module so the interceptors land on
 * the instance the toolkit uses.
 */
function installInterceptors(): void {
  if (installed) return;
  installed = true;
  try {
    const rootRequire = createRequire(path.join(process.cwd(), "package.json"));
    const toolkitEntry = rootRequire.resolve("@paypal/agent-toolkit/openai");
    const mod = createRequire(toolkitEntry)("axios") as AxiosLike & { default?: AxiosLike };
    const axios: AxiosLike = mod.default ?? mod;

    axios.interceptors.request.use((config) => {
      const s = scope.getStore();
      if (!s || !PAYPAL_HOST.test(String(config.url))) return config;
      config.__t0 = Date.now();
      const method = String(config.method ?? "get").toLowerCase();
      if (method === "post" && s.requestId && !String(config.url).endsWith("/v1/oauth2/token")) {
        // Idempotency: the same id is sent again if this purchase is retried.
        config.headers["PayPal-Request-Id"] = s.requestId;
      }
      if (method === "post" && s.inject && String(config.url).endsWith("/v2/checkout/orders")) {
        const data = (config.data ?? {}) as { purchase_units?: Record<string, unknown>[] };
        const units = data.purchase_units ?? [];
        config.data = {
          ...data,
          // Replace the toolkit's "ask the buyer to approve" payment source
          // with the vaulted PayPal the parent saved.
          payment_source: s.inject.paymentSource,
          purchase_units: units.length > 0 ? [{ ...units[0], ...s.inject.unit }, ...units.slice(1)] : units,
        };
        config.headers["Prefer"] = "return=representation";
      }
      return config;
    });

    const capture = (res: AxiosResponse | undefined, config: AxiosConfig | undefined, network: boolean) => {
      const s = scope.getStore();
      const url = String(config?.url ?? "");
      if (!s || !PAYPAL_HOST.test(url)) return;
      s.captured.push({
        method: String(config?.method ?? "get").toUpperCase(),
        path: new URL(url).pathname,
        status: res?.status ?? 0,
        debugId: res?.headers?.["paypal-debug-id"] ?? null,
        ms: Date.now() - (config?.__t0 ?? Date.now()),
        data: res?.data ?? null,
        network,
      });
    };
    axios.interceptors.response.use(
      (res) => {
        capture(res, res.config, false);
        return res;
      },
      (err) => {
        capture(err.response, err.config, !err.response);
        return Promise.reject(err);
      },
    );
    interceptorAvailable = true;
  } catch (err) {
    interceptorAvailable = false;
    console.warn("[paypal] agent toolkit interceptor not installed:", (err as Error).message);
  }
}

/** True when vault injection through the toolkit is possible in this runtime. */
export function toolkitReady(): boolean {
  installInterceptors();
  return interceptorAvailable;
}

let kit: { instance: PayPalAgentToolkit; builtAt: number } | null = null;
// The toolkit caches its access token and never refreshes it, so rebuild it
// well inside the token lifetime.
const KIT_MAX_AGE_MS = 4 * 60 * 60 * 1000;

function toolkit(): PayPalAgentToolkit {
  assertSandbox();
  installInterceptors();
  if (kit && Date.now() - kit.builtAt < KIT_MAX_AGE_MS) return kit.instance;
  kit = {
    builtAt: Date.now(),
    instance: new PayPalAgentToolkit({
      clientId: requireEnv("PAYPAL_CLIENT_ID"),
      clientSecret: requireEnv("PAYPAL_CLIENT_SECRET"),
      configuration: {
        // Only the three tools this product needs.
        actions: { orders: { create: true, get: true }, payments: { createRefund: true } },
        context: { sandbox: true },
      },
    }),
  };
  return kit.instance;
}

export type ToolkitTool = "create_order" | "get_order" | "create_refund";

/** Names and JSON schemas of the toolkit tools in use, for the README and the drawer. */
export function toolkitToolNames(): string[] {
  return toolkit()
    .getTools()
    .map((t) => (t as { function: { name: string } }).function.name);
}

type RunOptions = {
  requestId?: string | null;
  inject?: Scope["inject"];
  note?: string | null;
};

type Recorded<T> = PPResult<T> & { calls: Captured[]; error: { issue: string; message: string; details: unknown } | null; unknown: boolean };

/**
 * Runs one toolkit tool. Arguments come from application code. The result
 * is PayPal's JSON body.
 */
export async function toolkitRun<T = unknown>(tool: ToolkitTool, args: Record<string, unknown>, opts: RunOptions = {}): Promise<PPResult<T>> {
  const rec = await external<Recorded<T>>("paypal", `toolkit.${tool}`, async () => {
    const s: Scope = { requestId: opts.requestId ?? null, inject: opts.inject ?? null, captured: [] };
    const t0 = Date.now();
    const message = await scope.run(s, () =>
      toolkit().handleToolCall({
        id: "call_" + randomUUID().slice(0, 8),
        type: "function",
        function: { name: tool, arguments: JSON.stringify(args) },
      }),
    );
    let body: unknown = null;
    try {
      body = JSON.parse(String(message.content));
    } catch {
      body = message.content;
    }
    const calls = s.captured.map((c) => ({ ...c, data: null }));
    const main = [...s.captured].reverse().find((c) => c.path !== "/v1/oauth2/token");
    if (!main) {
      const msg = (body as { error?: { message?: string } })?.error?.message ?? "The PayPal agent toolkit rejected the request before calling PayPal.";
      return { status: 0, debugId: null, body: body as T, ms: Date.now() - t0, calls, error: { issue: "TOOLKIT_VALIDATION", message: msg, details: body }, unknown: false };
    }
    if (main.network) {
      return { status: 0, debugId: null, body: body as T, ms: main.ms, calls, error: null, unknown: true };
    }
    if (main.status >= 400) {
      const d = (main.data ?? {}) as { name?: string; message?: string; details?: { issue?: string; description?: string }[] };
      return {
        status: main.status,
        debugId: main.debugId,
        body: main.data as T,
        ms: main.ms,
        calls,
        error: { issue: d.details?.[0]?.issue ?? d.name ?? "PAYPAL_ERROR", message: d.details?.[0]?.description ?? d.message ?? "PayPal could not complete the request.", details: main.data },
        unknown: false,
      };
    }
    return { status: main.status, debugId: main.debugId, body: body as T, ms: main.ms, calls, error: null, unknown: false };
  });

  for (const c of rec.calls) {
    logPayPalCall({
      method: c.method,
      path: c.path,
      status: c.status,
      debugId: c.debugId,
      via: "agent-toolkit",
      ms: c.ms,
      requestId: c.method === "POST" && c.path !== "/v1/oauth2/token" ? (opts.requestId ?? null) : null,
      note: c.path === "/v1/oauth2/token" ? "toolkit client credentials" : `tool ${tool}${opts.note ? ": " + opts.note : ""}`,
    });
  }
  if (rec.unknown) throw new PayPalUnknownOutcome(opts.requestId ?? "", new Error("network"));
  if (rec.error) throw new PayPalError(rec.status, rec.debugId, rec.error.issue, rec.error.message, rec.error.details);
  return { status: rec.status, debugId: rec.debugId, body: rec.body, ms: rec.ms };
}
