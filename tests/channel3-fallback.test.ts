/**
 * When Channel3 cannot be reached, the catalog client serves the closest
 * recorded response from fixtures/channel3 and says it is cached.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const search = vi.fn();
const retrieve = vi.fn();
vi.mock("@channel3/sdk", () => ({
  Channel3: class {
    products = { search, retrieve, searchByImage: vi.fn(), findSimilar: vi.fn() };
  },
}));

import { CatalogError, getProduct, isBuyable, searchProducts } from "@/lib/channel3/client";
import { useMemoryStore } from "@/lib/store";

beforeEach(() => {
  process.env.CHANNEL3_API_KEY = "test-key";
  useMemoryStore();
  search.mockReset();
  retrieve.mockReset();
});

describe("Channel3 is down", () => {
  it("serves the closest recorded search, labeled as cached, and still applies the price cap", async () => {
    search.mockRejectedValue(Object.assign(new Error("402 out of credits"), { statusCode: 402 }));
    const r = await searchProducts({ query: "college ruled notebooks", maxPrice: 15 });
    expect(r.cached).toBe(true);
    expect(r.products.length).toBeGreaterThan(0);
    for (const p of r.products) {
      expect(p.best).not.toBeNull();
      expect(p.best!.price).toBeLessThanOrEqual(15);
      expect(isBuyable(p.best!)).toBe(true);
    }
  });

  it("does not pass off an unrelated recording as an answer", async () => {
    search.mockRejectedValue(new Error("timeout"));
    await expect(searchProducts({ query: "left-handed trombone polish", maxPrice: 50 })).rejects.toBeInstanceOf(CatalogError);
  });

  it("only stands in for product detail with the same product", async () => {
    retrieve.mockRejectedValue(new Error("timeout"));
    await expect(getProduct("no-such-product")).rejects.toBeInstanceOf(CatalogError);
  });
});

describe("Channel3 answers", () => {
  it("uses the live response and never picks a used or out-of-stock offer", async () => {
    search.mockResolvedValue({
      response: {
        products: [
          {
            id: "p1",
            title: "Spiral notebook",
            offers: [
              { url: "https://a.example/1", domain: "a.example", price: { price: 2, currency: "USD" }, availability: "InStock", condition: "used" },
              { url: "https://b.example/1", domain: "b.example", price: { price: 3, currency: "USD" }, availability: "OutOfStock", condition: "new" },
              { url: "https://c.example/1", domain: "www.c.example", price: { price: 4.5, currency: "USD" }, availability: "InStock", condition: "new" },
            ],
          },
        ],
      },
    });
    const r = await searchProducts({ query: "spiral notebook", maxPrice: 10 });
    expect(r.cached).toBe(false);
    expect(r.products[0].best).toMatchObject({ domain: "c.example", price: 4.5 });
    expect(search.mock.calls[0][0].filters).toMatchObject({ availability: ["InStock"], conditions: ["new"], price: { max_price: 10 } });
  });
});
