/**
 * pnpm tsx scripts/channel3-fixtures.ts
 *
 * Copies the Channel3 responses cached in the local store (.data/c3cache,
 * filled by real calls during development) into fixtures/channel3/. The
 * app serves these, labeled "cached result", when Channel3 is slow, down
 * or out of credits. One file per endpoint and query or product.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), ".data", "c3cache");
const OUT = path.join(process.cwd(), "fixtures", "channel3");
const LONG_DASH = new RegExp("[" + String.fromCharCode(0x2014, 0x2013) + "]", "g");

type Doc = { at: string; endpoint: string; request: { query?: string; product_id?: string; image?: string }; products: unknown[] };

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function main() {
  const best = new Map<string, Doc>();
  for (const name of readdirSync(SRC)) {
    const doc = JSON.parse(readFileSync(path.join(SRC, name), "utf8")) as Doc;
    if (doc.products.length === 0) continue;
    const kind = doc.endpoint.includes("/image") ? "image" : doc.endpoint.includes("/similar") ? "similar" : doc.endpoint.startsWith("GET") ? "product" : "search";
    const what = kind === "image" ? "sample-photo" : (doc.request.query ?? doc.request.product_id ?? "unknown");
    const key = `${kind}--${slug(what)}`;
    const prev = best.get(key);
    // Keep the response with the most products, then the newest.
    if (!prev || doc.products.length > prev.products.length || (doc.products.length === prev.products.length && doc.at > prev.at)) best.set(key, doc);
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const [key, doc] of best) {
    // Catalog text is third-party; normalize its dashes to the house style.
    writeFileSync(path.join(OUT, `${key}.json`), JSON.stringify(doc, null, 1).replace(LONG_DASH, "-") + "\n");
    console.log(`fixtures/channel3/${key}.json  (${doc.products.length} products)`);
  }
  console.log(`${best.size} fixtures written`);
}

main();
