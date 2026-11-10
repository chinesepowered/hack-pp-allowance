/**
 * Developer check: the parent setup in a real browser, including PayPal's
 * own approval window opened by the JS SDK v6 save-payment session.
 *
 *   pnpm tsx scripts/setup-check.ts <outDir>
 */
import "./lib/load-env";
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launchOptions, loginAndConsent } from "./lib/paypal-approve";

const base = process.env.APP_URL ?? "http://localhost:3000";
const out = process.argv[2] ?? "setup-shots";

async function main() {
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch(launchOptions());
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 300)));
  let n = 0;
  const shot = async (name: string, p = page) => {
    n += 1;
    const file = path.join(out, String(n).padStart(2, "0") + "-" + name + ".png");
    await p.screenshot({ path: file });
    console.log("shot", file);
  };

  await page.goto(base + "/parent", { waitUntil: "networkidle" });
  await page.getByTestId("menu").click();
  await page.getByTestId("menu-fresh").click();
  await page.getByTestId("parent-setup").waitFor({ timeout: 20000 });
  const button = page.getByTestId("paypal-save-button");
  await button.waitFor({ state: "visible", timeout: 60000 });
  await page.waitForTimeout(2500);
  await shot("setup-step1");

  const t0 = Date.now();
  const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 30000 }), button.click()]);
  console.log("popup opened", popup.url().slice(0, 80));
  await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
  await popup.setViewportSize({ width: 520, height: 760 }).catch(() => undefined);
  await popup.waitForTimeout(3000);
  await shot("paypal-window", popup).catch((e) => console.log("popup shot failed", e.message));
  await loginAndConsent(popup);
  console.log("consent clicked after", Date.now() - t0, "ms");
  await page.getByTestId("vault-saved").waitFor({ timeout: 60000 });
  console.log("vault saved after", Date.now() - t0, "ms");
  await shot("setup-step2");

  await page.getByTestId("rules-draft").click();
  await page.getByTestId("mandate-draft").waitFor({ timeout: 60000 });
  await shot("mandate-draft");
  await page.getByTestId("mandate-sign").click();
  await page.getByTestId("mandate-card").waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  await shot("mandate-signed");

  if (errors.length > 0) console.log("console messages:\n" + [...new Set(errors)].slice(0, 15).join("\n"));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
