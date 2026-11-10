/**
 * The fixed category list a mandate can talk about. The model maps the
 * parent's words and each product onto this list; the policy code only ever
 * compares these ids.
 */
export const CATEGORIES = [
  "school_supplies",
  "books",
  "clothing",
  "electronics",
  "gaming",
  "gift_cards",
  "food_drink",
  "beauty",
  "sports_outdoors",
  "toys_hobbies",
  "home",
  "entertainment",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  school_supplies: "School supplies",
  books: "Books",
  clothing: "Clothes and shoes",
  electronics: "Electronics",
  gaming: "Gaming",
  gift_cards: "Gift cards",
  food_drink: "Food and drink",
  beauty: "Beauty and personal care",
  sports_outdoors: "Sports and outdoors",
  toys_hobbies: "Toys and hobbies",
  home: "Home and room",
  entertainment: "Music, movies and streaming",
  other: "Something else",
};

export const CATEGORY_HINT: Record<Category, string> = {
  school_supplies: "notebooks, pens, binders, calculators, backpacks for school, art supplies for class",
  books: "printed books, e-books, textbooks, study guides",
  clothing: "clothes, jackets, shoes, sneakers, hats, bags worn as fashion, accessories",
  electronics: "phones, headphones, chargers, computers, cameras, smart devices",
  gaming: "video games, consoles, controllers, in-game currency, game top-ups, gaming subscriptions",
  gift_cards: "gift cards, prepaid cards, store credit, digital codes that hold money",
  food_drink: "snacks, drinks, meals, water bottles count as home unless sold as a drink",
  beauty: "skincare, makeup, hair care, fragrance",
  sports_outdoors: "sports gear, bikes, camping, fitness",
  toys_hobbies: "toys, crafts, collectibles, board games, musical instruments",
  home: "room decor, desk lamps, bedding, storage, water bottles, kitchen items",
  entertainment: "music, movies, streaming, concert and event tickets",
  other: "anything that fits nowhere else",
};

export function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

export function labelList(cats: Category[]): string {
  return cats.map((c) => CATEGORY_LABEL[c].toLowerCase()).join(", ");
}
