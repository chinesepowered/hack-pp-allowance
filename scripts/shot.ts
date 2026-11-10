/**
 * Developer helper: open a page of the running app and save a screenshot.
 *   pnpm tsx scripts/shot.ts /parent out.png [width] [height]
 */
import { chromium } from "playwright";

async function main() {
  const [path = "/", out = "shot.png", w = "1440", h = "960", scale = "1"] = process.argv.slice(2);
  const base = process.env.APP_URL ?? "http://localhost:3000";
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: Number(scale) });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 300)));
  await page.goto(base + path, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out, fullPage: process.env.FULL === "1" });
  if (errors.length > 0) console.log("console errors:\n" + errors.join("\n"));
  console.log("saved", out);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
