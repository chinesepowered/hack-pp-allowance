/**
 * pnpm a11y
 *
 * Runs axe-core (WCAG 2.0, 2.1 and 2.2, levels A and AA) against the main
 * states of the running app and prints every violation. Uses Replay mode so
 * it needs no keys and spends nothing.
 */
import AxeBuilder from "@axe-core/playwright";
import { chromium, type Page } from "playwright";

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function scan(page: Page, name: string): Promise<number> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  if (results.violations.length === 0) {
    console.log(`pass  ${name}`);
    return 0;
  }
  console.log(`FAIL  ${name}`);
  for (const v of results.violations) {
    console.log(`  ${v.id} (${v.impact}): ${v.help}`);
    for (const n of v.nodes.slice(0, 4)) console.log(`    ${n.target.join(" ")}  ${(n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
  }
  return results.violations.length;
}

async function waitForKip(page: Page) {
  await page.getByTestId("kip-working").waitFor({ state: "visible", timeout: 15000 }).catch(() => undefined);
  await page.getByTestId("kip-working").waitFor({ state: "hidden", timeout: 60000 });
  await page.waitForTimeout(500);
}

async function main() {
  const browser = await chromium.launch();
  let failures = 0;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.getByTestId("mode-replay").click();
    await page.getByTestId("replay-banner").waitFor();
    await page.getByTestId("menu").click();
    await page.getByTestId("menu-reset").click();
    await page.waitForTimeout(1200);
    failures += await scan(page, "side by side, seeded family");

    await page.getByTestId("prompt-notebooks").click();
    await waitForKip(page);
    await page.getByTestId("prompt-sneakers").click();
    await waitForKip(page);
    await page.getByTestId("prompt-gaming").click();
    await waitForKip(page);
    failures += await scan(page, "after three requests: receipt, approval card, blocked card, product tiles");

    await page.getByTestId("hood-open").click();
    await page.getByTestId("paypal-calls").waitFor();
    failures += await scan(page, "Under the hood: PayPal calls");
    await page.getByTestId("hood-tab-agent").click();
    failures += await scan(page, "Under the hood: agent trail");
    await page.getByTestId("hood-tab-mandate").click();
    failures += await scan(page, "Under the hood: mandate JSON");
    await page.getByTestId("hood-close").click();

    await page.getByTestId("menu").click();
    failures += await scan(page, "demo menu open");
    await page.getByTestId("menu-fresh").click();
    await page.getByTestId("parent-setup").waitFor({ timeout: 15000 }).catch(() => undefined);
    await page.getByTestId("role-parent").click();
    await page.waitForTimeout(600);
    failures += await scan(page, "parent setup, empty family");

    const phone = await browser.newContext({ viewport: { width: 360, height: 740 }, storageState: await ctx.storageState() });
    const mobile = await phone.newPage();
    await mobile.goto(`${BASE}/teen`, { waitUntil: "networkidle" });
    await mobile.waitForTimeout(800);
    failures += await scan(mobile, "teen view at 360 px");
    await mobile.goto(`${BASE}/parent`, { waitUntil: "networkidle" });
    await mobile.waitForTimeout(800);
    failures += await scan(mobile, "parent view at 360 px");
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    console.log(overflow ? "FAIL  horizontal overflow at 360 px" : "pass  no horizontal overflow at 360 px");
    if (overflow) failures += 1;
    await mobile.goto(`${BASE}/kip`, { waitUntil: "networkidle" });
    failures += await scan(mobile, "Kip character page");
    await phone.close();

    // Leave the browser session as it was found.
    await page.getByTestId("mode-live").click().catch(() => undefined);
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? "\nNo axe violations." : `\n${failures} problem(s) found.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
