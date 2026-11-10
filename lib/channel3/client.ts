/**
 * Channel3: the product catalog Kip shops in. Four calls, each visible in
 * the product:
 *
 *   products.search         text search, price and availability filters
 *                           taken from the mandate
 *   products.searchByImage  "something like this photo"
 *   products.findSimilar    an alternative that fits the rules
 *   products.retrieve       product detail: offers across retailers and
 *                           buy links, re-read right before paying
 *
 * Responses are cached (the key has a monthly credit allowance). If
 * Channel3 is slow, failing or out of credits, the last good response for
 * the same request is served and labeled as cached.
 */
import { Channel3, type Channel3Api } from "@channel3/sdk";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logChannel3Call } from "../context";
import { requireEnv } from "../env";
import { external, isReplay } from "../replay/vcr";
import { store } from "../store";
import type { Offer, ProductCard } from "../types";

const TIMEOUT_S = 12;
const FRESH_MS = process.env.NODE_ENV === "production" ? 10 * 60 * 1000 : 24 * 60 * 60 * 1000;

let client: Channel3 | null = null;
function c3(): Channel3 {
  if (!client) client = new Channel3({ apiKey: requireEnv("CHANNEL3_API_KEY") });
  return client;
}

export type SearchResult = {
  mode: "text" | "image" | "similar";
  query: string;
  filters: { maxPrice: number | null; availability: string[] };
  products: ProductCard[];
  cached: boolean;
  cachedAt: string | null;
};

type CacheDoc = { at: string; endpoint: string; request: unknown; products: Channel3Api.Product[] };

function hashOf(endpoint: string, request: unknown): string {
  return createHash("sha256").update(endpoint).update(JSON.stringify(request)).digest("hex").slice(0, 24);
}

const FIXTURE_DIR = path.join(process.cwd(), "fixtures", "channel3");

async function readCache(key: string): Promise<CacheDoc | null> {
  const fromStore = await store()
    .get<CacheDoc>(`c3cache/${key}`)
    .catch(() => null);
  if (fromStore) return fromStore;
  try {
    return JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, `${key}.json`), "utf8")) as CacheDoc;
  } catch {
    return null;
  }
}

async function writeCache(key: string, doc: CacheDoc): Promise<void> {
  await store()
    .set(`c3cache/${key}`, doc)
    .catch(() => undefined);
  if (process.env.CHANNEL3_WRITE_FIXTURES === "1") {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await fs.writeFile(path.join(FIXTURE_DIR, `${key}.json`), JSON.stringify(doc, null, 1));
  }
}

/**
 * Kip only buys new items that are in stock and priced in US dollars.
 * Product detail also lists second-hand marketplace offers, which can be
 * far cheaper than the item the teen was shown.
 */
export function isBuyable(o: Offer): boolean {
  return o.availability === "InStock" && o.currency === "USD" && (o.condition === null || o.condition === "new");
}

export function toCard(p: Channel3Api.Product, maxPrice: number | null = null): ProductCard {
  const offers: Offer[] = (p.offers ?? [])
    .filter((o) => o && o.price && typeof o.price.price === "number")
    .map((o) => ({
      domain: o.domain.replace(/^www\./, ""),
      url: o.url,
      price: Math.round(o.price.price * 100) / 100,
      compareAtPrice: o.price.compare_at_price ?? null,
      currency: o.price.currency,
      availability: o.availability,
      condition: o.condition ?? null,
    }))
    .sort((a, b) => a.price - b.price);
  const usable = offers.filter((o) => isBuyable(o) && (maxPrice === null || o.price <= maxPrice));
  const main = (p.images ?? []).find((i) => i.is_main_image) ?? (p.images ?? [])[0];
  return {
    id: p.id,
    title: p.title,
    brand: p.brands?.[0]?.name ?? null,
    image: main?.url ?? null,
    description: p.description ? p.description.slice(0, 400) : null,
    sourceCategory: p.category?.title ?? null,
    keyFeatures: (p.key_features ?? []).slice(0, 4).map((f) => f.slice(0, 120)),
    offers,
    best: usable[0] ?? null,
    rating: p.ratings && p.ratings.count > 0 ? { average: Math.round(p.ratings.value * 10) / 10, count: p.ratings.count } : null,
  };
}

type CallResult = { status: number; ms: number; products: Channel3Api.Product[]; error: string | null };

async function call(endpoint: string, opKey: string, request: unknown, run: () => Promise<Channel3Api.Product[]>): Promise<{ products: Channel3Api.Product[]; cached: boolean; cachedAt: string | null }> {
  const key = hashOf(endpoint, request);
  // Replay answers come from the tape, never from the cache.
  const replay = isReplay();
  const cached = replay ? null : await readCache(key);
  if (cached && Date.now() - Date.parse(cached.at) < FRESH_MS && process.env.CHANNEL3_CACHE !== "off") {
    logChannel3Call({ endpoint, summary: summarize(request), status: 200, ms: 0, cached: true, results: cached.products.length });
    return { products: cached.products, cached: true, cachedAt: cached.at };
  }
  const res = await external<CallResult>("channel3", opKey, async () => {
    const t0 = Date.now();
    try {
      const products = await run();
      return { status: 200, ms: Date.now() - t0, products, error: null };
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return { status: e.statusCode ?? 0, ms: Date.now() - t0, products: [], error: e.message ?? "Channel3 request failed" };
    }
  });
  if (res.error) {
    logChannel3Call({ endpoint, summary: `${summarize(request)} (failed: ${res.error.slice(0, 80)})`, status: res.status, ms: res.ms, cached: false, results: 0 });
    if (cached) {
      logChannel3Call({ endpoint, summary: `${summarize(request)} (served from cache)`, status: 200, ms: 0, cached: true, results: cached.products.length });
      return { products: cached.products, cached: true, cachedAt: cached.at };
    }
    throw new CatalogError(res.status, res.error);
  }
  logChannel3Call({ endpoint, summary: summarize(request), status: res.status, ms: res.ms, cached: false, results: res.products.length });
  if (!replay) await writeCache(key, { at: new Date().toISOString(), endpoint, request, products: res.products });
  return { products: res.products, cached: false, cachedAt: null };
}

export class CatalogError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

function summarize(request: unknown): string {
  const r = request as { query?: string; product_id?: string; image?: string; filters?: { price?: { max_price?: number }; availability?: string[] } };
  const bits: string[] = [];
  if (r.query) bits.push(`"${r.query}"`);
  if (r.image) bits.push("photo");
  if (r.product_id) bits.push(`product ${r.product_id}`);
  if (r.filters?.price?.max_price !== undefined) bits.push(`max $${r.filters.price.max_price}`);
  if (r.filters?.availability?.length) bits.push(r.filters.availability.join("+"));
  return bits.join(", ");
}

function filtersFor(maxPrice: number | null): Channel3Api.SearchFilters {
  return { availability: ["InStock"], conditions: ["new"], ...(maxPrice !== null ? { price: { max_price: maxPrice } } : {}) };
}

const CONFIG = { country: "US", currency: "USD", language: "en" } as const;

/** Text search. maxPrice comes from the mandate (budget left, item caps). */
export async function searchProducts(input: { query: string; maxPrice: number | null; limit?: number }): Promise<SearchResult> {
  const request = { query: input.query.trim().slice(0, 200), limit: input.limit ?? 8, filters: filtersFor(input.maxPrice), config: CONFIG };
  const r = await call("POST /v1/search", "search", request, async () => (await c3().products.search(request, { timeoutInSeconds: TIMEOUT_S, maxRetries: 1 })).response.products);
  return { mode: "text", query: request.query, filters: { maxPrice: input.maxPrice, availability: ["InStock"] }, products: usable(r.products, input.maxPrice), cached: r.cached, cachedAt: r.cachedAt };
}

/** Image search from a photo the teen attached (base64, no data: prefix). */
export async function searchByImage(input: { base64: string; maxPrice: number | null; limit?: number }): Promise<SearchResult> {
  const digest = createHash("sha256").update(input.base64).digest("hex").slice(0, 16);
  const cacheRequest = { image: digest, limit: input.limit ?? 8, filters: filtersFor(input.maxPrice), config: CONFIG };
  const r = await call("POST /v1/search/image", "image", cacheRequest, async () => {
    const page = await c3().products.searchByImage({ base64_image: input.base64, limit: cacheRequest.limit, filters: cacheRequest.filters, config: CONFIG }, { timeoutInSeconds: TIMEOUT_S + 8, maxRetries: 1 });
    return page.response.products;
  });
  return { mode: "image", query: "photo", filters: { maxPrice: input.maxPrice, availability: ["InStock"] }, products: usable(r.products, input.maxPrice), cached: r.cached, cachedAt: r.cachedAt };
}

/** Similar products, used to offer an alternative that fits the rules. */
export async function findSimilar(input: { productId: string; maxPrice: number | null; limit?: number }): Promise<SearchResult> {
  const request = { product_id: input.productId, limit: input.limit ?? 6, filters: filtersFor(input.maxPrice), config: CONFIG };
  const r = await call("POST /v1/similar", "similar", request, async () => (await c3().products.findSimilar(request, { timeoutInSeconds: TIMEOUT_S, maxRetries: 1 })).response.products);
  return {
    mode: "similar",
    query: `similar to ${input.productId}`,
    filters: { maxPrice: input.maxPrice, availability: ["InStock"] },
    products: usable(r.products, input.maxPrice).filter((p) => p.id !== input.productId),
    cached: r.cached,
    cachedAt: r.cachedAt,
  };
}

/** Product detail: every retailer offer and its buy link. */
export async function getProduct(productId: string): Promise<{ product: ProductCard; cached: boolean }> {
  const request = { product_id: productId, country: "US", currency: "USD" } as const;
  const r = await call("GET /v1/products/{id}", "product", request, async () => [await c3().products.retrieve(request, { timeoutInSeconds: TIMEOUT_S, maxRetries: 1 })]);
  if (r.products.length === 0) throw new CatalogError(404, "Product not found");
  return { product: toCard(r.products[0]), cached: r.cached };
}

function usable(products: Channel3Api.Product[], maxPrice: number | null): ProductCard[] {
  return products.map((p) => toCard(p, maxPrice)).filter((p) => p.best !== null);
}
