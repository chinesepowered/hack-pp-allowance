/**
 * Step 2 of the demo video: render the title, problem and end cards and the
 * thumbnail from HTML with Playwright. Kip is taken from the running app
 * (/kip), so the cards always show the real character.
 *
 *   pnpm tsx scripts/video/cards.ts      needs the app running
 *
 * Output: demo/raw/cards/*.png (1920x1080) and demo/thumb.png (1200x800).
 */
import { chromium, type Browser } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const OUT = path.join(process.cwd(), "demo", "raw", "cards");

function fontFace(family: string, file: string): string {
  const data = readFileSync(path.join(process.cwd(), "node_modules", file)).toString("base64");
  return `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${data}) format("woff2");font-weight:100 1000;font-display:block}`;
}

const CSS = () => `
${fontFace("Nunito", "@fontsource-variable/nunito/files/nunito-latin-wght-normal.woff2")}
${fontFace("Inter", "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2")}
*{box-sizing:border-box;margin:0}
body{background:#fbf6ee;color:#1c2530;font-family:Inter,system-ui,sans-serif;width:100vw;height:100vh;overflow:hidden;display:flex;align-items:center;justify-content:center}
h1,h2,.d{font-family:Nunito,system-ui,sans-serif;font-weight:800;letter-spacing:-0.01em}
.wrap{width:86%;max-width:1560px}
.big{font-size:86px;line-height:1.08}
.mid{font-size:44px;line-height:1.25;color:#46515f;font-weight:500}
.row{display:flex;gap:36px;margin-top:56px}
.opt{flex:1;background:#fff;border:2px solid #e3d7c3;border-radius:28px;padding:38px 40px;box-shadow:0 10px 30px -18px rgba(28,37,48,.35)}
.opt .k{font-family:Nunito;font-weight:800;font-size:24px;letter-spacing:.06em;text-transform:uppercase;color:#a8261c}
.opt .t{font-family:Nunito;font-weight:800;font-size:50px;line-height:1.12;margin-top:10px}
.opt .s{font-size:30px;color:#46515f;margin-top:14px;line-height:1.3}
.chips{display:flex;flex-wrap:wrap;gap:14px;margin-top:38px}
.chip{font-weight:650;font-size:26px;padding:10px 22px;border-radius:999px;background:#dcf0ec;color:#084f49}
.chip.p{background:#e0ecfb;color:#1d4f91}
.chip.s{background:#f1e7d6;color:#46515f}
.hero{display:flex;align-items:center;gap:70px}
.hero img{width:460px;height:460px;flex:none}
.name{font-size:150px;line-height:1}
.tag{font-size:46px;line-height:1.22;color:#46515f;margin-top:22px;font-weight:500;max-width:900px}
.small{font-size:26px;color:#5f6b7a;margin-top:34px}
`;

type Card = { name: string; width: number; height: number; html: (kip: Record<string, string>) => string };

const CARDS: Card[] = [
  {
    name: "problem-1",
    width: 1920,
    height: 1080,
    html: () => `<div class="wrap"><h1 class="big">A teenager needs things.</h1><p class="mid" style="margin-top:28px">Notebooks. Sneakers. A calculator.</p></div>`,
  },
  {
    name: "problem-2",
    width: 1920,
    height: 1080,
    html: () => `<div class="wrap"><h1 class="big">Today a parent has two bad options.</h1>
      <div class="row">
        <div class="opt"><div class="k">Option one</div><div class="t">Hand over the card</div><div class="s">No limits, no say in what gets bought.</div></div>
        <div class="opt"><div class="k">Option two</div><div class="t">Approve every purchase</div><div class="s">The parent becomes the bottleneck.</div></div>
      </div></div>`,
  },
  {
    name: "intro",
    width: 1920,
    height: 1080,
    html: (kip) => `<div class="wrap hero"><img src="${kip.happy}" alt=""/><div>
      <h1 class="name">Allowance</h1>
      <p class="tag">A shopping agent for teenagers that pays with the family's PayPal, but only inside rules a parent signs.</p>
      <div class="chips"><span class="chip p">PayPal Vault</span><span class="chip p">Orders</span><span class="chip p">Refunds</span><span class="chip p">Agent Toolkit</span><span class="chip">Channel3</span><span class="chip s">W&amp;B Inference</span></div>
      <p class="small">Meet Kip, the capybara who does the shopping.</p></div></div>`,
  },
  {
    name: "end",
    width: 1920,
    height: 1080,
    html: (kip) => `<div class="wrap hero"><img src="${kip.idle}" alt=""/><div>
      <h1 class="name">Allowance</h1>
      <p class="tag">An agent that pays, inside your rules.</p>
      <div class="chips"><span class="chip p">PayPal sandbox prototype</span><span class="chip">Product search by Channel3</span><span class="chip s">Open source, AGPL-3.0</span></div>
      <p class="small">Built for the PayPal AI Hackathon. No real money moved.</p></div></div>`,
  },
  {
    name: "thumb",
    width: 1200,
    height: 800,
    html: (kip) => `<div class="wrap" style="width:90%;display:flex;align-items:center;gap:44px"><img src="${kip.happy}" alt="" style="width:330px;height:330px;flex:none"/><div>
      <h1 class="d" style="font-size:104px;line-height:1">Allowance</h1>
      <p style="font-size:35px;line-height:1.22;color:#46515f;margin-top:16px;font-weight:500">A shopping agent for teens that pays with the family's PayPal, inside rules a parent signs.</p>
      <div class="chips" style="margin-top:26px"><span class="chip p" style="font-size:22px">Pays inside the rules</span><span class="chip s" style="font-size:22px">Asks when it matters</span></div></div></div>`,
  },
];

async function kipImages(browser: Browser): Promise<Record<string, string>> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 3 });
  await page.goto(`${BASE}/kip`, { waitUntil: "networkidle" });
  // Capture Kip alone, on a transparent background.
  await page.addStyleTag({ content: "html,body,main,li,div{background:transparent !important;box-shadow:none !important;border-color:transparent !important}" });
  const out: Record<string, string> = {};
  for (const mood of ["happy", "idle", "thinking", "wait", "sorry", "paused"]) {
    const buf = await page.locator(`[data-kip="${mood}"] svg`).screenshot({ omitBackground: true });
    out[mood] = `data:image/png;base64,${buf.toString("base64")}`;
    writeFileSync(path.join(OUT, `kip-${mood}.png`), buf);
  }
  await page.close();
  return out;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    const kip = await kipImages(browser);
    const css = CSS();
    for (const card of CARDS) {
      const page = await browser.newPage({ viewport: { width: card.width, height: card.height }, deviceScaleFactor: 1 });
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${card.html(kip)}</body></html>`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      const file = card.name === "thumb" ? path.join(process.cwd(), "demo", "thumb.png") : path.join(OUT, `${card.name}.png`);
      await page.screenshot({ path: file });
      await page.close();
      console.log("rendered", path.relative(process.cwd(), file));
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
