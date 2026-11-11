/**
 * Finds the axios module that the loaded PayPal Agent Toolkit uses.
 *
 * The toolkit sends every PayPal call through the default axios instance of
 * its own dependency tree, so that is where the interceptors in toolkit.ts
 * have to go. The lookup starts from the toolkit file Node actually loaded
 * and asks for "axios" from there. That repeats the toolkit's own lookup, so
 * it returns the same module instance in any layout.
 *
 * Starting from the loaded file, not from the project root, matters on
 * serverless hosts. A function only holds the files the build traced, and
 * there the toolkit is reached through the build's own link under
 * .next/node_modules. It is not at node_modules/@paypal/agent-toolkit under
 * the working directory, which is where this code used to look.
 *
 * This file imports nothing from the app, so scripts/trace-check.ts can run
 * the same code against a copy of a function's traced files.
 */
import { createRequire } from "node:module";
import path from "node:path";

/** The toolkit's CommonJS entry file, as Node names it once it is loaded. */
const TOOLKIT_ENTRY = /\/@paypal\/agent-toolkit(-[0-9a-f]+)?\/openai\/index\.c?js$/;

export type ToolkitAxios<T> = {
  /** The default axios instance the toolkit calls PayPal with. */
  axios: T;
  /** The axios file that instance came from. */
  axiosFile: string;
  /** The toolkit file Node loaded. */
  toolkitFile: string;
};

function exportsClass(mod: NodeJS.Module, toolkitClass: unknown): boolean {
  try {
    return (mod.exports as { PayPalAgentToolkit?: unknown } | null | undefined)?.PayPalAgentToolkit === toolkitClass;
  } catch {
    return false;
  }
}

/**
 * @param toolkitClass the PayPalAgentToolkit class that was just imported
 * @throws when the toolkit is not in Node's module cache, which means it was
 *         not loaded by Node from disk and its axios cannot be reached
 */
export function findToolkitAxios<T = unknown>(toolkitClass: unknown): ToolkitAxios<T> {
  const nodeRequire = createRequire(path.join(process.cwd(), "package.json"));
  const modules = Object.values(nodeRequire.cache).filter((m): m is NodeJS.Module => Boolean(m));
  // First by identity: the module whose export is this very class. Then by
  // file name, in case a loader hands out a wrapped copy of the exports.
  const loaded =
    (toolkitClass ? modules.find((m) => exportsClass(m, toolkitClass)) : undefined) ??
    modules.find((m) => TOOLKIT_ENTRY.test(String(m.filename).split(path.sep).join("/")));
  if (!loaded) throw new Error("the loaded toolkit module was not found in Node's module cache");
  const fromToolkit = createRequire(loaded.filename);
  const axiosFile = fromToolkit.resolve("axios");
  const mod = fromToolkit("axios") as T & { default?: T };
  return { axios: mod.default ?? mod, axiosFile, toolkitFile: loaded.filename };
}
