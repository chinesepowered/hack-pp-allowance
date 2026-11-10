/**
 * Drives PayPal's own approval pages with Playwright, using the sandbox
 * buyer login. Used by `pnpm seed` for the one-time "save PayPal" step and
 * by the demo recorder.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export function launchOptions() {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  return {
    headless: process.env.HEADFUL ? false : true,
    // Cloud sandboxes route traffic through an egress proxy.
    ...(proxy ? { proxy: { server: proxy } } : {}),
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  };
}

export async function launch(): Promise<Browser> {
  return chromium.launch(launchOptions());
}

export function buyer() {
  const email = process.env.PAYPAL_SANDBOX_BUYER_EMAIL;
  const password = process.env.PAYPAL_SANDBOX_BUYER_PASSWORD;
  if (!email || !password) throw new Error("PAYPAL_SANDBOX_BUYER_EMAIL and PAYPAL_SANDBOX_BUYER_PASSWORD are required for the one-time PayPal approval.");
  return { email, password };
}

/**
 * Logs the sandbox buyer in (if PayPal asks) and presses the consent
 * button on a "save this PayPal for future payments" page.
 */
export async function loginAndConsent(page: Page, opts: { slowMo?: number } = {}): Promise<void> {
  const { email, password } = buyer();
  const pause = (ms: number) => page.waitForTimeout(opts.slowMo ?? ms);
  const emailField = page.locator("#email");
  const consent = page.locator("#consentButton");
  await Promise.race([emailField.waitFor({ state: "visible", timeout: 60000 }), consent.waitFor({ state: "visible", timeout: 60000 })]);
  if (await emailField.isVisible()) {
    await emailField.fill(email);
    await pause(200);
    const next = page.locator("#btnNext");
    if (await next.isVisible().catch(() => false)) await next.click();
    const pw = page.locator("#password");
    await pw.waitFor({ state: "visible", timeout: 30000 });
    await pw.fill(password);
    await pause(200);
    await page.locator("#btnLogin").click();
  }
  await consent.waitFor({ state: "visible", timeout: 60000 });
  await pause(400);
  await consent.click();
}

/** Opens a vault approve link and approves it as the sandbox buyer. */
export async function approveVaultSetup(approveUrl: string, returnUrlPrefix: string): Promise<void> {
  const browser = await launch();
  let ctx: BrowserContext | null = null;
  try {
    ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: "en-US" });
    const page = await ctx.newPage();
    await page.goto(approveUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await loginAndConsent(page);
    await page.waitForURL((u) => u.toString().startsWith(returnUrlPrefix), { timeout: 60000 });
  } finally {
    await ctx?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
