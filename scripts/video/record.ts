/**
 * Step 1 of the demo video: record a real run of the app against the live
 * PayPal sandbox with Playwright (headless Chromium, recordVideo).
 *
 *   pnpm video:record        needs `pnpm build && pnpm start` running
 *
 * Output (git-ignored): demo/raw/main.webm, demo/raw/popup.webm and
 * demo/raw/marks.json with the time of every beat, used by compose.ts.
 *
 * The app is opened with ?safe=1 (store and brand names masked, so no other
 * company's marks are in frame) and ?zoom=1.3 (larger UI at 1080p).
 */
import "../lib/load-env";
import { chromium, type Locator } from "playwright";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchOptions, loginAndConsent } from "../lib/paypal-approve";
import { DEFAULT_RULES_TEXT } from "../../lib/demo/defaults";

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const RAW = path.join(process.cwd(), "demo", "raw");
const SIZE = { width: 1920, height: 1080 };

const OVERLAY = `
(() => {
  if (window.__alwOverlay) return;
  window.__alwOverlay = true;
  const style = document.createElement('style');
  style.textContent = [
    '#alw-cap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:99999;max-width:86vw;padding:10px 20px;border-radius:14px;background:rgba(20,28,38,.94);color:#fff;font:600 17px/1.35 "Inter Variable",system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25);opacity:0;transition:opacity .25s;pointer-events:none;text-align:center}',
    '#alw-cap.on{opacity:1}',
    '#alw-cap b{color:#8fe3d4;font-weight:700}',
    '#alw-cur{position:fixed;z-index:100000;width:22px;height:22px;margin:-4px 0 0 -4px;pointer-events:none;left:-50px;top:-50px}',
    '#alw-rip{position:fixed;z-index:99998;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:3px solid #0b6b62;opacity:0;pointer-events:none}',
    '#alw-rip.go{animation:alwrip .45s ease-out}',
    '@keyframes alwrip{from{opacity:.9;transform:scale(.3)}to{opacity:0;transform:scale(1.2)}}',
    '.alw-hl{outline:3px solid #e2603f !important;outline-offset:3px;border-radius:6px}'
  ].join('');
  document.head.appendChild(style);
  const cap = document.createElement('div'); cap.id = 'alw-cap'; document.body.appendChild(cap);
  const cur = document.createElement('div'); cur.id = 'alw-cur';
  cur.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2l15 8-6.500 1.800L9 18z" fill="#1c2530" stroke="#fff" stroke-width="1.600" stroke-linejoin="round"/></svg>';
  document.body.appendChild(cur);
  const rip = document.createElement('div'); rip.id = 'alw-rip'; document.body.appendChild(rip);
  const z = () => Number(getComputedStyle(document.documentElement).zoom) || 1;
  document.addEventListener('mousemove', (e) => { cur.style.left = (e.clientX / z()) + 'px'; cur.style.top = (e.clientY / z()) + 'px'; }, true);
  document.addEventListener('mousedown', (e) => { rip.style.left = (e.clientX / z()) + 'px'; rip.style.top = (e.clientY / z()) + 'px'; rip.classList.remove('go'); void rip.offsetWidth; rip.classList.add('go'); }, true);
  window.__alwCaption = (html) => { if (!html) { cap.classList.remove('on'); return; } cap.innerHTML = html; cap.classList.add('on'); };
})();
`.replace(/(\d)\.(\d)00/g, "$1.$2");

async function main() {
  rmSync(path.join(RAW, "rec"), { recursive: true, force: true });
  mkdirSync(path.join(RAW, "rec"), { recursive: true });
  const browser = await chromium.launch(launchOptions());
  const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, recordVideo: { dir: path.join(RAW, "rec"), size: SIZE }, locale: "en-US" });
  // The sandbox buyer's email is typed into PayPal's window. compose.ts blurs
  // that part of the picture, so the login is not readable in the video.
  const page = await ctx.newPage();
  const t0 = Date.now();
  const marks: Record<string, number> = {};
  const mark = (name: string) => {
    marks[name] = (Date.now() - t0) / 1000;
    console.log(`  ${marks[name].toFixed(1).padStart(6)}s  ${name}`);
  };
  const pause = (ms: number) => page.waitForTimeout(ms);
  const caption = (html: string | null) => page.evaluate((h) => (window as unknown as { __alwCaption?: (h: string | null) => void }).__alwCaption?.(h), html);
  const overlay = () => page.evaluate(OVERLAY).catch(() => undefined);

  const hover = async (target: Locator) => {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error("target is not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 22 });
    await pause(220);
    return box;
  };
  const click = async (target: Locator) => {
    const box = await hover(target);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  /** Scrolls only the pane that holds the target, never the page itself. */
  const scrollTo = async (target: Locator, block: "center" | "start" = "center") => {
    await target.evaluate((el, b) => {
      let pane: HTMLElement | null = el.parentElement;
      while (pane && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
      if (!pane) return;
      const er = el.getBoundingClientRect();
      const pr = pane.getBoundingClientRect();
      const z = Number(getComputedStyle(document.documentElement).zoom) || 1;
      const offset = (er.top - pr.top) / z;
      const top = b === "start" ? pane.scrollTop + offset - 16 : pane.scrollTop + offset - (pane.clientHeight - er.height / z) / 2;
      pane.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      window.scrollTo(0, 0);
    }, block);
    await pause(900);
  };
  /** Follows Kip's status line and names the API in use on screen. */
  const followKip = async (labels: [RegExp, string][]) => {
    await page.getByTestId("kip-working").waitFor({ state: "visible", timeout: 20000 }).catch(() => undefined);
    let last = "";
    for (;;) {
      const working = await page.getByTestId("kip-working").isVisible().catch(() => false);
      if (!working) break;
      const text = (await page.getByTestId("kip-status").textContent().catch(() => "")) ?? "";
      const hit = labels.find(([re]) => re.test(text));
      if (hit && hit[1] !== last) {
        last = hit[1];
        await caption(last);
      }
      await pause(120);
    }
  };

  try {
    /* ---------- setup: save PayPal, write rules, sign ---------- */
    await page.goto(`${BASE}/parent?safe=1&zoom=1.3`, { waitUntil: "networkidle" });
    await page.evaluate(() => fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "fresh" }) }));
    await page.reload({ waitUntil: "networkidle" });
    await overlay();
    await page.getByTestId("parent-setup").waitFor({ timeout: 30000 });
    const save = page.getByTestId("paypal-save-button");
    await save.waitFor({ state: "visible", timeout: 60000 });
    await pause(1500);
    mark("setup_start");
    await caption("PayPal <b>JS SDK v6</b> · save-payment session");
    await pause(2200);
    const box = await hover(save);
    mark("paypal_click");
    const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 30000 }), page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)]);
    const p0 = Date.now();
    const popupMarks: Record<string, number> = {};
    await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
    await caption("<b>Vault v3</b> · POST /v3/vault/setup-tokens · the parent approves in PayPal's own window");
    await popup.locator("#email").waitFor({ state: "visible", timeout: 60000 });
    popupMarks.login_visible = (Date.now() - p0) / 1000;
    const popupSize = await popup.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    popupMarks.width = popupSize.width;
    popupMarks.height = popupSize.height;
    await loginAndConsent(popup, { slowMo: 500 });
    popupMarks.consent_clicked = (Date.now() - p0) / 1000;
    await page.getByTestId("vault-saved").waitFor({ timeout: 60000 });
    mark("vault_saved");
    await caption("<b>Vault v3</b> · POST /v3/vault/payment-tokens · PayPal saved, token stays on the server");
    await pause(2600);

    const rules = page.getByTestId("rules-text");
    await click(rules);
    await rules.fill("");
    mark("rules_typing");
    await caption("Dana writes the rules in plain English");
    await rules.pressSequentially(DEFAULT_RULES_TEXT, { delay: 16 });
    mark("rules_typed");
    await pause(500);
    await click(page.getByTestId("rules-draft"));
    await caption("<b>AI</b> proposes a mandate · <b>Zod</b> validates it · code checks it");
    await page.getByTestId("mandate-draft").waitFor({ timeout: 60000 });
    mark("draft_shown");
    await scrollTo(page.getByTestId("mandate-draft"), "start");
    await pause(2800);
    const sign = page.getByTestId("mandate-sign");
    await scrollTo(sign);
    await click(sign);
    await page.getByTestId("mandate-card").waitFor({ timeout: 30000 });
    mark("signed");
    await caption("Signed mandate · <b>HMAC-SHA256</b> over the canonical JSON · verified before every purchase");
    await scrollTo(page.getByTestId("mandate-signature"));
    await pause(3200);
    await caption(null);

    /* ---------- the aha: three requests ---------- */
    await click(page.getByTestId("role-both"));
    await overlay();
    await page.getByTestId("teen-view").waitFor();
    await pause(1400);
    mark("aha_start");

    await click(page.getByTestId("prompt-notebooks"));
    mark("nb_click");
    await followKip([
      [/searching Channel3/i, "<b>Channel3</b> search · in stock · price cap taken from the mandate"],
      [/checking offers/i, "<b>Channel3</b> product detail · offers across retailers"],
      [/checking the rules/i, "Policy check in <b>code</b>, not in the model"],
      [/paying/i, "<b>PayPal Orders v2</b> · payment_source.paypal.vault_id · no popup"],
    ]);
    await page.locator('[data-testid="receipt"][data-status="paid"]').first().waitFor({ timeout: 30000 });
    mark("nb_paid");
    await caption("<b>PayPal Orders v2</b> · order captured with the saved PayPal · the receipt quotes the rule");
    await pause(4200);

    await click(page.getByTestId("prompt-sneakers"));
    mark("sn_click");
    await followKip([
      [/searching Channel3/i, "<b>Channel3</b> search · sneakers around $55"],
      [/checking the rules/i, "Policy check in <b>code</b> · clothes are capped at $40 an item"],
      [/asking/i, "Over the cap · Kip asks Dana instead of paying"],
      [/similar/i, "<b>Channel3</b> similar products · an alternative inside the rules"],
    ]);
    const card = page.getByTestId("approval-card").first();
    await card.waitFor({ timeout: 30000 });
    mark("sn_waiting");
    const why = (await page.getByTestId("approval-rule").first().textContent()) ?? "";
    if (!/cap in rule 3/.test(why)) throw new Error("RETRY: the sneakers did not hit the clothes cap this run: " + why.slice(0, 120));
    await caption("Needs Dana's OK · the card shows Kip's reasoning and the exact rule");
    await page.getByTestId("approval-rule").first().evaluate((el) => el.classList.add("alw-hl"));
    await pause(5200);
    await click(page.getByTestId("approve").first());
    mark("ap_click");
    await caption("<b>PayPal Orders v2</b> · charged only after Dana's approval");
    await page.getByTestId("approval-card").first().waitFor({ state: "hidden", timeout: 60000 });
    await page.locator('[data-testid="receipt"][data-status="paid"]').nth(1).waitFor({ timeout: 30000 });
    mark("ap_paid");
    await pause(3600);

    await click(page.getByTestId("prompt-gaming"));
    mark("gm_click");
    await caption("Request screened in <b>code</b> before any search");
    await page.getByTestId("blocked").first().waitFor({ timeout: 30000 });
    await page.getByTestId("kip-working").waitFor({ state: "hidden", timeout: 30000 });
    mark("gm_blocked");
    await caption("Blocked by rule 4 · nothing searched · nothing charged");
    await pause(4200);
    await caption(null);

    /* ---------- under the hood ---------- */
    await click(page.getByTestId("hood-open"));
    await page.getByTestId("paypal-calls").waitFor();
    await overlay();
    mark("hood_paypal");
    await caption("Every <b>PayPal</b> call this session made · method, path, status, PayPal-Debug-Id");
    await pause(5200);
    await click(page.getByTestId("hood-tab-agent"));
    mark("hood_agent");
    await caption("Agent trail · the <b>Agent Toolkit</b> tools sit behind the mandate check");
    await pause(4600);
    await click(page.getByTestId("hood-tab-channel3"));
    mark("hood_channel3");
    await caption("<b>Channel3</b> · search, product detail, similar products");
    await pause(3000);
    await click(page.getByTestId("hood-close"));
    await caption(null);
    await pause(600);

    /* ---------- undo, weekly note, pause ---------- */
    const undo = page.getByTestId("undo").first();
    await scrollTo(page.getByTestId("ledger"), "start");
    mark("ledger_view");
    await pause(1600);
    await click(undo);
    mark("undo_click");
    await caption("<b>PayPal Payments v2</b> · POST /v2/payments/captures/{id}/refund");
    await page.locator('[data-testid="ledger-row"][data-status="refunded"]').first().waitFor({ timeout: 60000 });
    mark("undo_done");
    await pause(3400);

    await scrollTo(page.getByTestId("summary"));
    await click(page.getByTestId("summary-write"));
    await caption("<b>AI</b> writes the weekly note · the numbers come from the ledger");
    await page.getByTestId("summary-text").waitFor({ timeout: 60000 });
    mark("summary_done");
    await pause(3600);

    await scrollTo(page.getByTestId("pause-box"));
    await click(page.getByTestId("pause-switch"));
    await page.getByTestId("paused-banner").waitFor({ timeout: 20000 });
    mark("paused");
    await caption("Pause · the kill switch takes effect on the next policy check");
    await pause(3800);

    /* ---------- the honest limitation ---------- */
    const receipt = page.locator('[data-testid="receipt"]').first();
    await scrollTo(receipt);
    await receipt.evaluate((el) => {
      const tag = [...el.querySelectorAll("span")].find((s) => /retailer order simulated/.test(s.textContent ?? ""));
      tag?.classList.add("alw-hl");
    });
    mark("limit");
    await caption("Honest limit · the retailer order step is <b>simulated</b> in this prototype");
    await pause(6500);
    await caption(null);
    await pause(800);
    mark("end");

    const popupVideo = await popup.video()?.path().catch(() => null);
    const mainVideo = await page.video()?.path();
    await ctx.close();
    if (!mainVideo) throw new Error("no main video was recorded");
    copyFileSync(mainVideo, path.join(RAW, "main.webm"));
    if (popupVideo) copyFileSync(popupVideo, path.join(RAW, "popup.webm"));
    writeFileSync(path.join(RAW, "marks.json"), JSON.stringify({ recordedAt: new Date().toISOString(), main: marks, popup: popupMarks, popupOpenedAt: marks.paypal_click }, null, 1));
    console.log("saved demo/raw/main.webm, popup.webm and marks.json");
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function run() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`recording attempt ${attempt}`);
      await main();
      return;
    } catch (err) {
      const msg = (err as Error).message;
      console.log("attempt failed:", msg.slice(0, 300));
      if (!msg.startsWith("RETRY") && attempt === 3) throw err;
    }
  }
  throw new Error("Could not record a clean run in three attempts.");
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
