// Module loader hooks that let `node` scripts import the console's TypeScript
// sources directly. Register them with:
//   import { register } from "node:module";
//   register("./lib/console-ts-loader.mjs", import.meta.url);
// `@/` resolves to apps/console, extensionless relative imports from .ts files
// try .ts/.tsx/index files, and .ts/.tsx files are transpiled (no type check;
// `npm run typecheck` stays the type gate).
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const consoleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "console");
const suffixes = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
// `next` has no package exports map, so ESM needs the explicit file names.
const bareRewrites = new Map([["next/server", "next/server.js"], ["next/headers", "next/headers.js"]]);

async function existingFile(base) {
  for (const suffix of suffixes) {
    try {
      if ((await stat(base + suffix)).isFile()) return base + suffix;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (bareRewrites.has(specifier)) return nextResolve(bareRewrites.get(specifier), context);
  let base;
  if (specifier.startsWith("@/")) base = path.join(consoleRoot, specifier.slice(2));
  else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:") && /\.tsx?$/.test(context.parentURL)) {
    base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  }
  if (base) {
    const file = await existingFile(base);
    if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && /\.tsx?$/.test(url)) {
    const fileName = fileURLToPath(url);
    const source = await readFile(fileName, "utf8");
    const { outputText } = ts.transpileModule(source, {
      fileName,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, isolatedModules: true, esModuleInterop: true }
    });
    return { format: "module", source: outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
