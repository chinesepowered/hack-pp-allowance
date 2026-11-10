/**
 * pnpm screenshots
 *
 * Drives the running app through the main flow against the live sandbox
 * and saves real app states to docs/screenshots/ at 1440x960. Uses the
 * recording mode (?safe=1), so store and brand names are masked.
 */
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const OUT = path.join(process.cwd(), "docs", "screenshots");

async function waitForKip(page: Page) {
  await page.getByTestId("kip-working").waitFor({ state: "visible", timeout: 15000 }).catch(() => undefined);
  await page.getByTestId("kip-working").waitFor({ state: "hidden", timeout: 90000 });
  await page.waitForTimeout(700);
}

async function paneTo(page: Page, testId: string, block: "start" | "center" = "start") {
  await page
    .getByTestId(testId)
    .first()
    .evaluate((el, b) => {
      let pane: HTMLElement | null = el.parentElement;
      while (pane && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
      if (!pane) return;
      const offset = el.getBoundingClientRect().top - pane.getBoundingClientRect().top;
      pane.scrollTo({ top: Math.max(0, b === "start" ? pane.scrollTop + offset - 16 : pane.scrollTop + offset - (pane.clientHeight - el.getBoundingClientRect().height) / 2) });
    }, block);
  await page.waitForTimeout(400);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const shot = async (name: string) => {
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, name + ".png") });
    console.log("saved docs/screenshots/" + name + ".png");
  };
  try {
    await page.goto(`${BASE}/?safe=1`, { waitUntil: "networkidle" });
    await page.getByTestId("menu").click();
    await page.getByTestId("menu-reset").click();
    await page.getByTestId("notice-toast").waitFor({ state: "visible" }).catch(() => undefined);
    await page.getByTestId("notice-toast").getByText("Dismiss").click().catch(() => undefined);
    await page.waitForTimeout(800);
    await shot("01-teen-and-parent-side-by-side");

    await page.getByTestId("prompt-notebooks").click();
    await waitForKip(page);
    await shot("02-paid-inside-the-rules");

    await page.getByTestId("prompt-sneakers").click();
    await waitForKip(page);
    await page.getByTestId("approval-card").first().waitFor({ timeout: 20000 });
    await shot("03-needs-the-parents-ok");

    await page.getByTestId("approve").first().click();
    await page.getByTestId("approval-card").first().waitFor({ state: "hidden", timeout: 60000 });
    await page.locator('[data-testid="receipt"][data-status="paid"]').nth(1).waitFor({ timeout: 30000 });
    await page.getByTestId("notice-toast").getByText("Dismiss").click().catch(() => undefined);
    await shot("04-approved-then-paid");

    await page.getByTestId("prompt-gaming").click();
    await waitForKip(page);
    await shot("05-blocked-by-a-rule");

    await paneTo(page, "ledger");
    await page.getByTestId("undo").first().click();
    await page.locator('[data-testid="ledger-row"][data-status="refunded"]').first().waitFor({ timeout: 60000 });
    await page.getByTestId("notice-toast").getByText("Dismiss").click().catch(() => undefined);
    await page.waitForTimeout(500);
    await shot("06-undo-refunds-through-paypal");

    await page.getByTestId("hood-open").click();
    await page.getByTestId("paypal-calls").waitFor();
    await shot("07-under-the-hood-paypal-calls");
    await page.getByTestId("hood-tab-agent").click();
    await shot("08-under-the-hood-agent-trail");
    await page.getByTestId("hood-tab-mandate").click();
    await shot("09-under-the-hood-signed-mandate");
    await page.getByTestId("hood-close").click();

    await page.getByTestId("prompt-photo").click();
    await waitForKip(page);
    await shot("10-image-search-from-a-photo");

    await paneTo(page, "summary");
    await page.getByTestId("summary-write").click();
    await page.getByTestId("summary-text").waitFor({ timeout: 60000 });
    await paneTo(page, "summary", "center");
    await shot("11-weekly-note");

    await paneTo(page, "mandate-card");
    await page.getByTestId("mandate-edit").click();
    await page.getByTestId("rules-text").fill("Up to $45 a week. Books and school supplies are always fine. Clothes up to $30 an item. No gaming, gift cards or energy drinks. Ask me before anything over $20 from a store we haven't used.");
    await page.getByTestId("rules-draft").click();
    await page.getByTestId("mandate-draft").waitFor({ timeout: 60000 });
    await paneTo(page, "rules-editor");
    await shot("12-plain-english-rules-to-mandate");
    await page.getByRole("button", { name: "Cancel" }).click();

    await paneTo(page, "pause-box");
    await page.getByTestId("pause-switch").click();
    await page.getByTestId("paused-banner").waitFor({ timeout: 20000 });
    await page.waitForTimeout(600);
    await shot("13-paused");
    await page.getByTestId("pause-switch").click();
    await page.waitForTimeout(800);

    await page.getByTestId("mode-replay").click();
    await page.getByTestId("replay-banner").waitFor({ timeout: 20000 });
    await page.getByTestId("prompt-notebooks").click();
    await waitForKip(page);
    await shot("14-replay-mode");
    await page.getByTestId("mode-live").click();
    await page.waitForTimeout(800);

    // The teen's phone, as an extra.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await ctx.storageState() });
    const mobile = await phone.newPage();
    await mobile.goto(`${BASE}/teen?safe=1`, { waitUntil: "networkidle" });
    await mobile.waitForTimeout(1200);
    await mobile.screenshot({ path: path.join(OUT, "15-teen-on-a-phone.png") });
    console.log("saved docs/screenshots/15-teen-on-a-phone.png");
    await phone.close();
  } finally {
    await browser.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
