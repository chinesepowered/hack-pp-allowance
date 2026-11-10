/**
 * One small JSON document store. Documents are addressed by key.
 *
 *  - development: files under .data/ (git-ignored)
 *  - Vercel: Vercel Blob when BLOB_READ_WRITE_TOKEN is set
 *  - tests and Replay self-checks: in-memory
 *
 * PayPal stays the source of truth for money. This store only keeps PayPal
 * ids plus the app's own records (mandate, approvals, chat).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export interface Store {
  kind: "file" | "blob" | "memory";
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

function safeKey(key: string): string {
  return key
    .split("/")
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_"))
    .filter((part) => part.length > 0 && part !== "." && part !== "..")
    .join("/");
}

class MemoryStore implements Store {
  kind = "memory" as const;
  private docs = new Map<string, string>();
  async get<T>(key: string): Promise<T | null> {
    const raw = this.docs.get(safeKey(key));
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.docs.set(safeKey(key), JSON.stringify(value));
  }
  async del(key: string): Promise<void> {
    this.docs.delete(safeKey(key));
  }
  async list(prefix: string): Promise<string[]> {
    const p = safeKey(prefix);
    return [...this.docs.keys()].filter((k) => k.startsWith(p));
  }
}

class FileStore implements Store {
  kind = "file" as const;
  constructor(private root: string) {}
  private file(key: string) {
    return path.join(this.root, safeKey(key) + ".json");
  }
  async get<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(key), "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
  async set<T>(key: string, value: T): Promise<void> {
    const file = this.file(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 1), "utf8");
    await fs.rename(tmp, file);
  }
  async del(key: string): Promise<void> {
    await fs.rm(this.file(key), { force: true });
  }
  async list(prefix: string): Promise<string[]> {
    const p = safeKey(prefix);
    const out: string[] = [];
    const walk = async (dir: string, rel: string) => {
      let entries: import("node:fs").Dirent[] = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), r);
        else if (e.name.endsWith(".json")) out.push(r.slice(0, -5));
      }
    };
    await walk(this.root, "");
    return out.filter((k) => k.startsWith(p));
  }
}

/**
 * Vercel Blob. Reads bypass the CDN cache (useCache: false) because this is
 * application state, not static content. A small per-instance cache keeps
 * the freshest revision this instance has seen.
 */
class BlobStore implements Store {
  kind = "blob" as const;
  private access: "public" | "private";
  private prefix: string;
  constructor() {
    this.access = process.env.BLOB_ACCESS === "public" ? "public" : "private";
    this.prefix = process.env.BLOB_PREFIX ?? "allowance";
  }
  private name(key: string) {
    return `${this.prefix}/${safeKey(key)}.json`;
  }
  async get<T>(key: string): Promise<T | null> {
    const { get } = await import("@vercel/blob");
    const res = await get(this.name(key), { access: this.access, useCache: false });
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    const text = await new Response(res.stream).text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }
  async set<T>(key: string, value: T): Promise<void> {
    const { put } = await import("@vercel/blob");
    await put(this.name(key), JSON.stringify(value), {
      access: this.access,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 60,
    });
  }
  async del(key: string): Promise<void> {
    const { del } = await import("@vercel/blob");
    try {
      await del(this.name(key));
    } catch {
      /* deleting a missing blob is fine */
    }
  }
  async list(prefix: string): Promise<string[]> {
    const { list } = await import("@vercel/blob");
    const base = `${this.prefix}/`;
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: base + safeKey(prefix), cursor, limit: 1000 });
      for (const b of page.blobs) out.push(b.pathname.slice(base.length).replace(/\.json$/, ""));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  }
}

let current: Store | null = null;

export function store(): Store {
  if (current) return current;
  if (process.env.ALLOWANCE_STORE === "memory") current = new MemoryStore();
  else if (process.env.BLOB_READ_WRITE_TOKEN) current = new BlobStore();
  else {
    // On Vercel without Blob the only writable place is /tmp. State then
    // lasts only as long as the instance; the README says to add Blob.
    const root = process.env.VERCEL ? "/tmp/allowance-data" : path.join(process.cwd(), ".data");
    current = new FileStore(root);
  }
  return current;
}

/** Tests swap in a fresh in-memory store. */
export function useMemoryStore(): Store {
  current = new MemoryStore();
  return current;
}

const locks = new Map<string, Promise<unknown>>();

/**
 * Read, change, write. Serialized per key inside one process. Across
 * serverless instances the last writer wins, which is acceptable for a demo
 * because money state is always re-read from PayPal.
 */
export async function update<T>(key: string, fn: (doc: T | null) => T | Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      const doc = await store().get<T>(key);
      const changed = await fn(doc);
      await store().set(key, changed);
      return changed;
    });
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}
