// Behavioral tests for scripts/release-environment.mjs (audit H1, Requirement
// 13.5-13.7). DB-free and network-free. `main(argv, env)` runs in-process with
// a private env object, so values with newlines or trailing spaces reach the
// validator exactly as GitHub Actions would pass them; console.error/log are
// captured per call. A few cases also run the CLI in a child process.
// `npm run release:environment:test` runs this file (design part 3, 1.2).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { buildArgs, main, parseAllowlist, validateRegistry } from "./release-environment.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");
const cli = path.join(scriptsDir, "release-environment.mjs");
const allowlistFile = path.join(repoRoot, ".github", "release-registry-allowlist.json");
const miniforgeFile = path.join(repoRoot, "runtime", "cosyvoice", "miniforge.json");
const miniforgePin = JSON.parse(readFileSync(miniforgeFile, "utf8"));
const SHA = "0123456789abcdef0123456789abcdef01234567";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "release-environment-"));
// RELEASE_SIGNING_KEY_PATH must be a POSIX absolute path. On Windows a path
// such as /shuzizhibo/.tmp-…/key.pem resolves against the current drive, so the
// readable key file is created under the repository (removed after the run).
const keyDir = process.platform === "win32" ? mkdtempSync(path.join(repoRoot, ".tmp-release-environment-")) : tempDir;
after(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (keyDir !== tempDir) rmSync(keyDir, { recursive: true, force: true });
});
const keyFile = path.join(keyDir, "ed25519-private.pem");
writeFileSync(keyFile, "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n");
const keyPath = process.platform === "win32" ? `/${path.relative(path.parse(keyFile).root, keyFile).split(path.sep).join("/")}` : keyFile;
const keyPathUsable = /^\/[A-Za-z0-9._/-]+$/.test(keyPath) && !keyPath.includes("..") && (process.platform !== "win32" || path.parse(process.cwd()).root.toLowerCase() === path.parse(keyFile).root.toLowerCase());

let outputCounter = 0;
function outputFile() {
  const file = path.join(tempDir, `github-output-${(outputCounter += 1)}`);
  writeFileSync(file, "previous=1\n");
  return file;
}

/** Runs main() in-process; returns { status, stdout, stderr, output } where output is the $GITHUB_OUTPUT file text. */
function run(argv, env) {
  const out = [];
  const err = [];
  const { log, error } = console;
  console.log = (...args) => out.push(args.join(" "));
  console.error = (...args) => err.push(args.join(" "));
  let status;
  try {
    status = main(argv, env);
  } finally {
    console.log = log;
    console.error = error;
  }
  const output = env.GITHUB_OUTPUT && existsSync(env.GITHUB_OUTPUT) ? readFileSync(env.GITHUB_OUTPUT, "utf8") : undefined;
  return { status, stdout: out.join("\n"), stderr: err.join("\n"), output };
}

/** Parses `key=value` and `key<<DELIM … DELIM` blocks of a $GITHUB_OUTPUT file. */
function parseOutput(text) {
  const result = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === "") continue;
    const heredoc = /^([A-Za-z_][A-Za-z0-9_-]*)<<(.+)$/.exec(line);
    if (heredoc) {
      const end = lines.indexOf(heredoc[2], i + 1);
      assert.ok(end > i, `unterminated block ${heredoc[1]}`);
      result[heredoc[1]] = lines.slice(i + 1, end).join("\n");
      i = end;
      continue;
    }
    const at = line.indexOf("=");
    assert.ok(at > 0, `malformed output line ${JSON.stringify(line)}`);
    result[line.slice(0, at)] = line.slice(at + 1);
  }
  return result;
}

const registryArgs = ["registry", "--allowlist", allowlistFile];

test("registry: an allowlisted registry and a valid namespace pass and write both outputs", () => {
  const env = { RELEASE_REGISTRY: "ghcr.io", RELEASE_IMAGE_NAMESPACE: "acme/shuzhiren", GITHUB_OUTPUT: outputFile() };
  const result = run(registryArgs, env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseOutput(result.output), { previous: "1", registry: "ghcr.io", namespace: "acme/shuzhiren" });
});

test("registry: values that are not an allowlist entry character for character exit 1 without writing $GITHUB_OUTPUT", () => {
  const rejected = ["", undefined, "GHCR.IO", "ghcr.io:443", "ghcr.io ", " ghcr.io", "ghcr.io\nevil.example", "ghcr.io/evil", "https://ghcr.io", "evil.example", "ghcr.io.evil.example", "ghcr.i0"];
  // Random single-character edits of the allowlist entry.
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-:/ \t\n";
  let seed = 13;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let n = 0; n < 200; n += 1) {
    const base = "ghcr.io";
    const at = next() % (base.length + 1);
    const char = alphabet[next() % alphabet.length];
    const variant = [`${base.slice(0, at)}${char}${base.slice(at)}`, `${base.slice(0, at)}${char}${base.slice(at + 1)}`, `${base.slice(0, at)}${base.slice(at + 1)}`][next() % 3];
    if (variant !== base) rejected.push(variant);
  }
  for (const value of rejected) {
    const env = { RELEASE_IMAGE_NAMESPACE: "shuzhiren", GITHUB_OUTPUT: outputFile() };
    if (value !== undefined) env.RELEASE_REGISTRY = value;
    const result = run(registryArgs, env);
    assert.equal(result.status, 1, JSON.stringify(value));
    assert.equal(result.output, "previous=1\n", `${JSON.stringify(value)} wrote $GITHUB_OUTPUT`);
    assert.match(result.stderr, /^::error::RELEASE_REGISTRY /m, JSON.stringify(value));
    if (value && value.trim().length > 3) assert.ok(!result.stderr.includes(value.trim()) || value.trim() === "ghcr.io", `${JSON.stringify(value)} echoed in ${result.stderr}`);
  }
});

test("registry: undefined, empty and malformed namespaces exit 1 and name only the variable", () => {
  for (const value of [undefined, "", "Acme", "acme//x", "/acme", "acme/", "acme space", "acme\nx", "acme..x"]) {
    const env = { RELEASE_REGISTRY: "ghcr.io", GITHUB_OUTPUT: outputFile() };
    if (value !== undefined) env.RELEASE_IMAGE_NAMESPACE = value;
    const result = run(registryArgs, env);
    assert.equal(result.status, 1, JSON.stringify(value));
    assert.equal(result.output, "previous=1\n");
    assert.match(result.stderr, /^::error::RELEASE_IMAGE_NAMESPACE /m);
    if (value) assert.ok(!result.stderr.includes(value), `${JSON.stringify(value)} echoed`);
  }
  const env = { GITHUB_OUTPUT: outputFile() };
  const result = run(registryArgs, env);
  assert.match(result.stderr, /::error::RELEASE_REGISTRY is not defined/);
  assert.match(result.stderr, /::error::RELEASE_IMAGE_NAMESPACE is not defined/);
});

test("registry: a malformed allowlist file is rejected with the allowlist problem", () => {
  for (const text of ["not json", "[]", '{"schemaVersion":1,"registries":[]}', '{"schemaVersion":2,"registries":["ghcr.io"]}', '{"schemaVersion":1,"registries":["GHCR.io"]}', '{"schemaVersion":1,"registries":["ghcr.io","ghcr.io"]}', '{"schemaVersion":1,"registries":["https://ghcr.io"]}', '{"schemaVersion":1,"registries":["ghcr.io"],"extra":1}']) {
    assert.ok(parseAllowlist(text).problems.length > 0, text);
    assert.throws(() => validateRegistry({ RELEASE_REGISTRY: "ghcr.io", RELEASE_IMAGE_NAMESPACE: "shuzhiren" }, text), /registry allowlist/, text);
  }
  assert.deepEqual(parseAllowlist(readFileSync(allowlistFile, "utf8")), { problems: [], registries: ["ghcr.io"] });
});

test("build-args: COSYVOICE_IMAGE gets RELEASE_REVISION and the reviewed Miniforge pin; other keys only RELEASE_REVISION", () => {
  const cosy = run(["build-args", "--matrix-key", "COSYVOICE_IMAGE", "--miniforge", miniforgeFile], { GITHUB_SHA: SHA, GITHUB_OUTPUT: outputFile() });
  assert.equal(cosy.status, 0, cosy.stderr);
  const cosyValue = parseOutput(cosy.output).value;
  assert.deepEqual(Object.fromEntries(cosyValue.split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2))), { RELEASE_REVISION: SHA, MINIFORGE_URL: miniforgePin.url, MINIFORGE_SHA256: miniforgePin.sha256 });

  for (const args of [["--matrix-key", "CONTROL_PLANE_IMAGE"], ["--matrix-key", "RUNTIME_GATEWAY_IMAGE", "--miniforge", miniforgeFile]]) {
    const result = run(["build-args", ...args], { GITHUB_SHA: SHA, GITHUB_OUTPUT: outputFile() });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parseOutput(result.output).value, `RELEASE_REVISION=${SHA}`);
  }
  // Miniforge values in the environment are ignored: the pin file is the only source.
  const ignored = run(["build-args", "--matrix-key", "COSYVOICE_IMAGE", "--miniforge", miniforgeFile], { GITHUB_SHA: SHA, MINIFORGE_URL: "https://evil.example/x.sh", MINIFORGE_SHA256: "f".repeat(64), GITHUB_OUTPUT: outputFile() });
  assert.equal(parseOutput(ignored.output).value.includes("evil.example"), false);
});

test("build-args: the output delimiter is random 32-hex and differs between runs", () => {
  const a = buildArgs({ GITHUB_SHA: SHA }, "CONTROL_PLANE_IMAGE");
  const b = buildArgs({ GITHUB_SHA: SHA }, "CONTROL_PLANE_IMAGE");
  const delimiter = (text) => /^value<<([a-f0-9]{32})\n/.exec(text)?.[1];
  assert.ok(delimiter(a) && delimiter(b));
  assert.notEqual(delimiter(a), delimiter(b));
});

test("build-args: COSYVOICE_IMAGE fails when the pin file is missing, unreadable or has a bad url or sha256", () => {
  const pins = {
    "missing-url": { sha256: miniforgePin.sha256 },
    "missing-sha256": { url: miniforgePin.url },
    "http-url": { url: "http://example.com/x.sh", sha256: miniforgePin.sha256 },
    "credential-url": { url: "https://user:pass@example.com/x.sh", sha256: miniforgePin.sha256 },
    "newline-url": { url: `${miniforgePin.url}\nMINIFORGE_SHA256=${"0".repeat(64)}`, sha256: miniforgePin.sha256 },
    "upper-sha256": { url: miniforgePin.url, sha256: miniforgePin.sha256.toUpperCase() },
    "short-sha256": { url: miniforgePin.url, sha256: "abc" },
    "empty-sha256": { url: miniforgePin.url, sha256: "" }
  };
  for (const [name, pin] of Object.entries(pins)) {
    const file = path.join(tempDir, `miniforge-${name}.json`);
    writeFileSync(file, JSON.stringify(pin));
    const result = run(["build-args", "--matrix-key", "COSYVOICE_IMAGE", "--miniforge", file], { GITHUB_SHA: SHA, GITHUB_OUTPUT: outputFile() });
    assert.equal(result.status, 1, name);
    assert.equal(result.output, "previous=1\n", name);
    assert.match(result.stderr, /^::error::Miniforge pin /m, name);
  }
  const noPin = run(["build-args", "--matrix-key", "COSYVOICE_IMAGE"], { GITHUB_SHA: SHA, GITHUB_OUTPUT: outputFile() });
  assert.equal(noPin.status, 1);
  assert.match(noPin.stderr, /COSYVOICE_IMAGE requires --miniforge/);
  const unreadable = run(["build-args", "--matrix-key", "COSYVOICE_IMAGE", "--miniforge", path.join(tempDir, "absent.json")], { GITHUB_SHA: SHA, GITHUB_OUTPUT: outputFile() });
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.stderr, /cannot read the Miniforge pin file/);
  for (const sha of [undefined, "", "ABC", SHA.toUpperCase()]) {
    const env = { GITHUB_OUTPUT: outputFile() };
    if (sha !== undefined) env.GITHUB_SHA = sha;
    const result = run(["build-args", "--matrix-key", "CONTROL_PLANE_IMAGE"], env);
    assert.equal(result.status, 1, JSON.stringify(sha));
    assert.match(result.stderr, /::error::GITHUB_SHA /);
  }
});

const signingEnv = () => ({ RELEASE_SIGNING_KEY_PATH: keyPath, RELEASE_ISSUER: "shuzhiren-release", RELEASE_KEY_ID: "release-2026-01" });

test("signing: three well-formed variables and a readable key file pass", { skip: keyPathUsable ? false : `cannot form a POSIX key path for ${keyFile}` }, () => {
  const result = run(["signing"], signingEnv());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("signing: each variable undefined, empty or malformed exits 1 naming only that variable, without echoing values", () => {
  const malformed = { RELEASE_SIGNING_KEY_PATH: ["relative/key.pem", "/run/../etc/shadow", "/run/key pem", "/run/shuzhiren-release/absent-key.pem"], RELEASE_ISSUER: ["Shuzhiren", "x", "1release", "rel ease"], RELEASE_KEY_ID: ["-key", "key id", "k".repeat(129)] };
  for (const name of Object.keys(malformed)) {
    for (const value of [undefined, "", ...malformed[name]]) {
      const env = signingEnv();
      if (value === undefined) delete env[name];
      else env[name] = value;
      const result = run(["signing"], env);
      assert.equal(result.status, 1, `${name}=${JSON.stringify(value)}`);
      const lines = result.stderr.split("\n").filter(Boolean);
      const own = lines.filter((line) => line.startsWith(`::error::${name} `));
      assert.equal(own.length, 1, `${name}=${JSON.stringify(value)}\n${result.stderr}`);
      for (const other of Object.keys(malformed).filter((key) => key !== name)) {
        if (keyPathUsable || other !== "RELEASE_SIGNING_KEY_PATH") assert.ok(!lines.some((line) => line.startsWith(`::error::${other} `)), `${other} reported for ${name}\n${result.stderr}`);
      }
      for (const shown of Object.values(env)) if (shown && shown.length > 2) assert.ok(!result.stderr.includes(shown), `value ${JSON.stringify(shown)} echoed`);
      assert.ok(!result.stderr.includes("not-a-real-key"), "key content echoed");
    }
  }
});

test("CLI: unknown subcommands and arguments exit 1 with the usage line; values never come from argv", () => {
  for (const argv of [[], ["deploy"], ["registry"], ["registry", "--allowlist"], ["registry", "--registry", "ghcr.io"], ["signing", "--issuer", "x"]]) {
    const result = run(argv, { GITHUB_OUTPUT: outputFile() });
    assert.equal(result.status, 1, argv.join(" "));
    assert.match(result.stderr, /::error::usage: /, argv.join(" "));
  }
  const missingOutput = run(registryArgs, { RELEASE_REGISTRY: "ghcr.io", RELEASE_IMAGE_NAMESPACE: "shuzhiren" });
  assert.equal(missingOutput.status, 1);
  assert.match(missingOutput.stderr, /::error::GITHUB_OUTPUT is not defined/);
});

test("CLI: the child process exits 1 for an unlisted registry and 0 for ghcr.io", () => {
  const base = { ...process.env, RELEASE_IMAGE_NAMESPACE: "shuzhiren" };
  for (const [registry, status] of [["ghcr.io", 0], ["registry.evil.example", 1]]) {
    const output = outputFile();
    const result = spawnSync(process.execPath, [cli, ...registryArgs], { cwd: repoRoot, encoding: "utf8", env: { ...base, RELEASE_REGISTRY: registry, GITHUB_OUTPUT: output } });
    assert.equal(result.status, status, `${registry}\n${result.stdout}${result.stderr}`);
    if (status === 1) {
      assert.ok(!`${result.stdout}${result.stderr}`.includes(registry));
      assert.equal(readFileSync(output, "utf8"), "previous=1\n");
    }
  }
});
