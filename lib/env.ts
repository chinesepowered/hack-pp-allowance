/**
 * Central place for environment access. Everything here is server-side
 * except NEXT_PUBLIC_PAYPAL_CLIENT_ID. Values are read lazily so that
 * scripts can load .env.local before the first call.
 */

export function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return v;
}

export const PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com";

/** This build is sandbox only. Refuse to start a PayPal call otherwise. */
export function assertSandbox(): void {
  const mode = (env("PAYPAL_ENVIRONMENT") ?? "sandbox").toLowerCase();
  if (mode !== "sandbox") {
    throw new Error("Allowance is a sandbox prototype. PAYPAL_ENVIRONMENT must be 'sandbox'.");
  }
}

export function models() {
  return {
    text: env("OPENAI_MODEL") ?? "Qwen/Qwen3.8-27B",
    vision: env("OPENAI_VISION_MODEL") ?? "google/gemma-4-31B-it",
    fallback: env("OPENAI_FALLBACK_MODEL") ?? "zai-org/GLM-5.3-Flash",
  };
}

export function hasLiveKeys() {
  return {
    paypal: Boolean(env("PAYPAL_CLIENT_ID") && env("PAYPAL_CLIENT_SECRET")),
    channel3: Boolean(env("CHANNEL3_API_KEY")),
    ai: Boolean(env("OPENAI_API_KEY") && env("OPENAI_BASE_URL")),
  };
}
