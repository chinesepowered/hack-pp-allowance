/**
 * Developer check: can a serverless function load the PayPal Agent Toolkit?
 *
 * On a serverless host each function holds only the files Next traced for
 * its route (the route.js.nft.json lists under .next/server/app/api/). For
 * each route that pays or refunds, this check:
 *
 *  1. confirms the toolkit and the axios it requires are in the list
 *  2. copies exactly the listed files to an empty folder outside the project
 *  3. loads the toolkit from that copy, the way the compiled route does
 *  4. runs the app's own lookup (lib/paypal/toolkit-axios.ts) there and
 *     makes one toolkit tool call against a stubbed PayPal, to see that an
 *     interceptor on the axios we found observes the toolkit's requests
 *
 * No keys and no network are needed.
 *
 *   pnpm build && pnpm trace:check
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { findToolkitAxios } from "../lib/paypal/toolkit-axios";

const root = process.cwd();
const apiDir = path.join(root, ".next", "server", "app", "api");

/** The routes that move money: Kip pays, the parent approves, the parent undoes. */
const MONEY_ROUTES = ["chat", "approvals/[id]", "ledger/[id]/undo"];

const TOOLKIT_CHUNK = /^\.next\/server\/chunks\/[^/]*@paypal_agent-toolkit[^/]*\.js$/;
const posix = (p: string) => p.split(path.sep).join("/");

let failures = 0;
function check(ok: boolean, label: string, detail = ""): boolean {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  return ok;
}

/** A route's traced files, as paths from the project root. */
function tracedFiles(route: string): string[] | null {
  const traceFile = path.join(apiDir, ...route.split("/"), "route.js.nft.json");
  if (!existsSync(traceFile)) return null;
  const { files } = JSON.parse(readFileSync(traceFile, "utf8")) as { files: string[] };
  return [...new Set(files.map((f) => posix(path.relative(root, path.resolve(path.dirname(traceFile), f)))))].sort();
}

/** Every API route that has a trace list, as "chat" or "ledger/[id]/undo". */
function allRoutes(dir = apiDir, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...allRoutes(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name));
    else if (entry.name === "route.js.nft.json" && prefix) out.push(prefix);
  }
  return out;
}

/** Step 1: the toolkit and the axios it resolves are both in the list. */
function checkListed(files: string[]): boolean {
  const entry = files.find((f) => f.endsWith("node_modules/@paypal/agent-toolkit/openai/index.js"));
  const manifest = files.find((f) => f.endsWith("node_modules/@paypal/agent-toolkit/package.json"));
  const listed = check(Boolean(entry && manifest), "trace list has node_modules/@paypal/agent-toolkit (package.json and openai/index.js)", entry ?? "missing");
  if (!entry) return false;
  // "Its axios" is whatever the toolkit file itself resolves "axios" to.
  const fromToolkit = createRequire(realpathSync(path.join(root, entry)));
  const axiosFile = posix(path.relative(root, fromToolkit.resolve("axios")));
  const axiosManifest = posix(path.relative(root, fromToolkit.resolve("axios/package.json")));
  const axiosListed = check(files.includes(axiosFile) && files.includes(axiosManifest), "trace list has the axios the toolkit requires", axiosFile);
  return listed && axiosListed;
}

/** Step 2: a folder holding the listed files and nothing else. */
function copyTraced(files: string[], to: string): { files: number; links: number; problems: string[] } {
  const count = { files: 0, links: 0, problems: [] as string[] };
  for (const rel of files) {
    const src = path.join(root, rel);
    const dst = path.join(to, rel);
    try {
      if (rel.startsWith("..")) throw new Error("outside the project");
      const stat = lstatSync(src);
      mkdirSync(path.dirname(dst), { recursive: true });
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(src);
        if (path.isAbsolute(target)) throw new Error("absolute link");
        symlinkSync(target, dst);
        count.links += 1;
      } else if (stat.isDirectory()) {
        mkdirSync(dst, { recursive: true });
      } else {
        copyFileSync(src, dst);
        count.files += 1;
      }
    } catch (err) {
      count.problems.push(`${rel}: ${(err as Error).message}`);
    }
  }
  return count;
}

type StubConfig = { url?: string; method?: string };
type StubAxios = {
  defaults: { adapter?: (config: StubConfig) => Promise<unknown> };
  interceptors: { request: { use(fn: (config: StubConfig) => StubConfig): number } };
};
type ToolkitModule = {
  PayPalAgentToolkit?: new (options: unknown) => { handleToolCall(call: unknown): Promise<unknown> };
};

/** Steps 3 and 4, inside the copy. */
async function checkLoads(files: string[], copy: string): Promise<void> {
  const chunk = files.find((f) => TOOLKIT_CHUNK.test(f));
  const requireId = chunk ? /require\("([^"]+)"\)/.exec(readFileSync(path.join(root, chunk), "utf8"))?.[1] : undefined;
  if (!check(Boolean(chunk && requireId), "the compiled route loads the toolkit as an external module", requireId ?? "no toolkit chunk in the trace list")) return;

  const inside = (file: string) => realpathSync(file).startsWith(realpathSync(copy) + path.sep);
  let mod: ToolkitModule;
  try {
    // Same request, from the same place, as the compiled chunk makes.
    mod = createRequire(path.join(copy, chunk!))(requireId!) as ToolkitModule;
  } catch (err) {
    check(false, "the toolkit loads from the traced files alone", (err as Error).message.split("\n")[0]);
    return;
  }
  if (!check(typeof mod.PayPalAgentToolkit === "function", "the toolkit loads from the traced files alone")) return;

  let found: ReturnType<typeof findToolkitAxios<StubAxios>>;
  try {
    found = findToolkitAxios<StubAxios>(mod.PayPalAgentToolkit);
  } catch (err) {
    check(false, "the app's lookup finds the toolkit's axios", (err as Error).message.split("\n")[0]);
    return;
  }
  check(inside(found.toolkitFile) && inside(found.axiosFile), "the app's lookup finds the toolkit's axios inside the copy", posix(path.relative(realpathSync(copy), realpathSync(found.axiosFile))));

  // One tool call with PayPal stubbed out at the axios adapter. If our
  // interceptor sees the request, it is on the instance the toolkit uses.
  const seen: string[] = [];
  found.axios.interceptors.request.use((config) => {
    seen.push(`${String(config.method ?? "get").toUpperCase()} ${String(config.url)}`);
    return config;
  });
  found.axios.defaults.adapter = async (config) => ({
    data: String(config.url).endsWith("/v1/oauth2/token") ? { access_token: "trace-check", token_type: "Bearer", expires_in: 3600 } : { id: "TRACECHECK", status: "CREATED" },
    status: 200,
    statusText: "OK",
    headers: {},
    config,
  });
  try {
    const kit = new mod.PayPalAgentToolkit!({
      clientId: "trace-check",
      clientSecret: "trace-check",
      configuration: { actions: { orders: { get: true } }, context: { sandbox: true } },
    });
    await kit.handleToolCall({ id: "call_trace", type: "function", function: { name: "get_order", arguments: JSON.stringify({ id: "TRACECHECK" }) } });
  } catch (err) {
    seen.push(`error: ${(err as Error).message.split("\n")[0]}`);
  }
  check(
    seen.some((line) => /^GET https:\/\/api(-m)?\.sandbox\.paypal\.com\/v2\/checkout\/orders\/TRACECHECK$/.test(line)),
    "an interceptor on that axios sees the toolkit's PayPal request",
    seen.map((line) => line.replace(/^(\w+) https:\/\/[^/]+/, "$1 ")).join(", ") || "nothing seen",
  );
}

async function main() {
  if (!existsSync(apiDir)) {
    console.error("No build found. Run pnpm build first.");
    process.exit(1);
  }

  for (const route of MONEY_ROUTES) {
    console.log(`/api/${route}`);
    const files = tracedFiles(route);
    if (!files) {
      check(false, "trace list exists", "route.js.nft.json not found");
      continue;
    }
    if (!checkListed(files)) continue;
    const copy = mkdtempSync(path.join(os.tmpdir(), "allowance-function-"));
    try {
      const copied = copyTraced(files, copy);
      check(copied.problems.length === 0, `copied the ${files.length} listed entries to an empty folder`, copied.problems.length > 0 ? copied.problems.slice(0, 3).join("; ") : `${copied.files} files, ${copied.links} links`);
      // Not a requirement, but worth seeing: this is the layout in which a
      // lookup from the project root fails.
      console.log(`  note the copy ${existsSync(path.join(copy, "node_modules", "@paypal", "agent-toolkit")) ? "has" : "has no"} node_modules/@paypal/agent-toolkit at its root`);
      await checkLoads(files, copy);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }

  // Any other route whose compiled code can load the toolkit must carry it too.
  const others = allRoutes().filter((route) => !MONEY_ROUTES.includes(route) && (tracedFiles(route) ?? []).some((f) => TOOLKIT_CHUNK.test(f)));
  for (const route of others) {
    console.log(`/api/${route}`);
    checkListed(tracedFiles(route) ?? []);
  }

  console.log(failures === 0 ? "\nThe traced files are enough to load the Agent Toolkit and reach its axios." : `\n${failures} check${failures === 1 ? "" : "s"} failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
