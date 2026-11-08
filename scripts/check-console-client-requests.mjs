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

// M8: the checks above only look at import text. Run the helper itself: a request that never answers must be
// aborted after the 20 s bound and reported as a timeout, and a normal answer passes through unchanged.
{
  const { register } = await import("node:module");
  const { mock } = await import("node:test");
  register("./lib/console-ts-loader.mjs", import.meta.url);
  const { clientFetch } = await import("../apps/console/lib/client-request.ts");
  const realFetch = globalThis.fetch;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let signal;
    globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => { signal = init.signal; init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); });
    const pending = clientFetch("/api/v1/never-answers");
    mock.timers.tick(19_999);
    if (signal.aborted) throw new Error("clientFetch must not abort a request before its 20 s bound");
    mock.timers.tick(1);
    if (!signal.aborted) throw new Error("clientFetch must abort a request that has not answered after 20 s");
    const outcome = await pending.then(() => "resolved", (error) => error.message);
    if (!signal.aborted || outcome !== "请求超时，请检查网络或稍后重试") throw new Error(`clientFetch must abort and report a timeout after 20 s, got ${outcome}`);
    const answer = new Response("{}", { status: 200 });
    globalThis.fetch = async () => answer;
    if ((await clientFetch("/api/v1/answers")) !== answer) throw new Error("clientFetch must return the response of a request that answers in time");
    let uploadSignal;
    globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => { uploadSignal = init.signal; init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); });
    const upload = clientFetch("https://storage.example/upload", { method: "PUT" }, 120_000);
    mock.timers.tick(119_999);
    if (uploadSignal.aborted) throw new Error("clientFetch must retain the longer configured bound for a signed media upload");
    mock.timers.tick(1);
    if (!uploadSignal.aborted) throw new Error("clientFetch must abort a signed media upload at its configured bound");
    const uploadOutcome = await upload.then(() => "resolved", (error) => error.message);
    if (uploadOutcome !== "请求超时，请检查网络或稍后重试") throw new Error(`clientFetch must report a timeout for a signed media upload, got ${uploadOutcome}`);
  } finally {
    mock.timers.reset();
    globalThis.fetch = realFetch;
  }
  console.log("PASS  clientFetch aborts an unanswered console request after 20 s and reports a timeout");
}
