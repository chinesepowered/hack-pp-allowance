/**
 * Developer check: drive the running app through the main flow in a real
 * browser and save screenshots. Uses the live sandbox unless MODE=replay.
 *
 *   pnpm tsx scripts/flow-check.ts <outDir>
 */
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const base = process.env.APP_URL ?? "http://localhost:3000";
const out = process.argv[2] ?? "flow-shots";
const replay = process.env.MODE === "replay";

async function waitForKip(page: Page) {
  await page.getByTestId("kip-working").waitFor({ state: "visible", timeout: 15000 }).catch(() => undefined);
  await page.getByTestId("kip-working").waitFor({ state: "hidden", timeout: 90000 });
  await page.waitForTimeout(600);
}

async function main() {
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 300)));
  let n = 0;
  const shot = async (name: string) => {
    n += 1;
    const file = path.join(out, String(n).padStart(2, "0") + "-" + name + ".png");
    await page.screenshot({ path: file });
    console.log("shot", file);
  };
  const timed = async (label: string, fn: () => Promise<void>) => {
    const t0 = Date.now();
    await fn();
    console.log(label, Date.now() - t0, "ms");
  };

  await page.goto(base + "/" + (process.env.SAFE === "1" ? "?safe=1" : ""), { waitUntil: "networkidle" });
  if (replay) {
    await page.getByTestId("mode-replay").click();
    await page.getByTestId("replay-banner").waitFor();
  }
  await page.getByTestId("menu").click();
  await page.getByTestId("menu-reset").click();
  await page.waitForTimeout(1500);
  await shot("start");

  await timed("notebooks", async () => {
    await page.getByTestId("prompt-notebooks").click();
    await waitForKip(page);
  });
  await shot("notebooks-paid");

  await timed("sneakers", async () => {
    await page.getByTestId("prompt-sneakers").click();
    await waitForKip(page);
  });
  await shot("sneakers-waiting");

  const approve = page.getByTestId("approve").first();
  if (await approve.isVisible().catch(() => false)) {
    await approve.scrollIntoViewIfNeeded();
    await shot("approval-card");
    await timed("approve", async () => {
      await approve.click();
      await page.getByTestId("approval-card").first().waitFor({ state: "hidden", timeout: 60000 });
    });
    await page.waitForTimeout(800);
    await shot("approved");
  } else console.log("no approval card visible");

  await timed("gaming", async () => {
    await page.getByTestId("prompt-gaming").click();
    await waitForKip(page);
  });
  await shot("gaming-blocked");

  const undo = page.getByTestId("undo").first();
  if (await undo.isVisible().catch(() => false)) {
    await undo.scrollIntoViewIfNeeded();
    await timed("undo", async () => {
      await undo.click();
      await page.locator('[data-testid="ledger-row"][data-status="refunded"]').first().waitFor({ timeout: 60000 });
    });
    await page.waitForTimeout(600);
    await shot("undo-refunded");
  } else console.log("no undo button visible");

  await page.getByTestId("hood-open").click();
  await page.getByTestId("paypal-calls").waitFor();
  await shot("hood-paypal");
  await page.getByTestId("hood-tab-agent").click();
  await shot("hood-agent");
  await page.getByTestId("hood-close").click();

  if (errors.length > 0) console.log("console errors:\n" + [...new Set(errors)].join("\n"));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
