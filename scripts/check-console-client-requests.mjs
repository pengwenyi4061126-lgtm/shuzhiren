import { readdir, readFile } from "node:fs/promises";

const components = new URL("../apps/console/components/", import.meta.url);
const files = (await readdir(components)).filter((name) => name.endsWith(".tsx"));

for (const file of files) {
  const source = await readFile(new URL(file, components), "utf8");
  if (source.includes("clientFetch(") && !source.includes('from "@/lib/client-request"')) {
    throw new Error(`${file} must import the bounded client request helper`);
  }
  if (/\bfetch\(/.test(source) && !source.includes("clientFetch as fetch")) {
    throw new Error(`${file} must not bypass the bounded client request helper`);
  }
}

console.log(`PASS  ${files.length} console components use bounded client requests`);
