/**
 * Developer check: image search with the sample photo, from the terminal.
 *   pnpm tsx scripts/try-image.ts "something like this under $40"
 */
import "./lib/load-env";
import { readFileSync } from "node:fs";
import path from "node:path";
import { handleTeenMessage } from "../lib/agent/kip";
import { newContext, runWithContext } from "../lib/context";
import { flushLogs } from "../lib/session";

async function main() {
  const text = process.argv[2] ?? "Something like this under $40";
  const base64 = readFileSync(path.join(process.cwd(), "public", "demo", "backpack.jpg")).toString("base64");
  const c = newContext({ sid: "devcheck", mode: "live", feature: "teen chat (photo)" });
  c.emit = (ev) => {
    if (ev.type === "status") console.log("   .. " + ev.text);
    if (ev.type === "step") console.log("   [" + ev.step.kind + "] " + ev.step.title + ": " + ev.step.detail.slice(0, 200));
    if (ev.type === "channel3") console.log("   [channel3] " + ev.call.endpoint + " " + ev.call.summary + " " + ev.call.status + " " + ev.call.ms + " ms");
  };
  await runWithContext(c, async () => {
    const t0 = Date.now();
    const s = await handleTeenMessage({ text, image: { base64, mime: "image/jpeg" } });
    await flushLogs();
    const reply = s.chat.at(-1);
    console.log("\nKip (" + (Date.now() - t0) + " ms): " + reply?.text);
    for (const card of reply?.cards ?? []) {
      if (card.type === "products") for (const p of card.products) console.log("   " + card.mode + " | " + p.title.slice(0, 60) + " | $" + p.best?.price + " " + p.best?.domain + " => " + card.policy[p.id]?.label + " (" + card.policy[p.id]?.category + ")");
      else console.log("   card", JSON.stringify(card).slice(0, 200));
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
