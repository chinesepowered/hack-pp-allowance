/**
 * Renders the repo's own SVG artwork to raster files:
 *   public/demo/backpack.jpg   the sample "photo" for image search
 * Run with: pnpm tsx scripts/render-assets.ts
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 640 }, deviceScaleFactor: 1 });
    const svg = readFileSync(path.join(process.cwd(), "public", "demo", "backpack.svg"), "utf8");
    await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    await page.screenshot({ path: path.join(process.cwd(), "public", "demo", "backpack.jpg"), type: "jpeg", quality: 88 });
    console.log("rendered public/demo/backpack.jpg");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
