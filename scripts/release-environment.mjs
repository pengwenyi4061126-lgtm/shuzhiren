// Run-time validation of the release-production environment for
// .github/workflows/release.yml (audit H1, Requirement 13.5-13.7).
//
// Values are read from environment variables only, never from argv, so they do
// not appear in the process list or in the workflow log. On failure each
// `::error::` line names the variable and the failure category, never the
// value, the command exits 1 and $GITHUB_OUTPUT is not written.
//
//   registry --allowlist <file>
//       RELEASE_REGISTRY must equal an entry of the allowlist character for
//       character (no trim, no case folding, the port is part of the entry);
//       RELEASE_IMAGE_NAMESPACE must be lowercase registry path components.
//       Writes `registry=` and `namespace=` to $GITHUB_OUTPUT.
//   build-args --matrix-key <key> --miniforge <file>
//       Writes the multi-line output `value` (random 32-hex delimiter) with
//       RELEASE_REVISION=$GITHUB_SHA and, for COSYVOICE_IMAGE, MINIFORGE_URL
//       and MINIFORGE_SHA256 from the reviewed pin file (url, sha256).
//   signing
//       RELEASE_SIGNING_KEY_PATH must be an absolute path without `..` naming a
//       readable regular file (its content is never read); RELEASE_ISSUER and
//       RELEASE_KEY_ID must match scripts/lib/release-identity.mjs. No output.
import { randomBytes } from "node:crypto";
import { accessSync, appendFileSync, constants, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE_ISSUER_PATTERN, RELEASE_KEY_ID_PATTERN } from "./lib/release-identity.mjs";

export const REGISTRY_ENTRY_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?$/;
export const IMAGE_NAMESPACE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
export const MINIFORGE_URL_PATTERN = /^https:\/\/[^\s"'\\]+$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SIGNING_KEY_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;
const MATRIX_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

export class ReleaseEnvironmentError extends Error {
  constructor(problems) {
    super(problems.join("\n"));
    this.name = "ReleaseEnvironmentError";
    this.problems = problems;
  }
}

/** Returns the failure category of an environment variable, or null when it is set and non-empty. */
function presence(env, name) {
  if (!Object.hasOwn(env, name) || env[name] === undefined) return `${name} is not defined`;
  if (env[name] === "") return `${name} is empty`;
  return null;
}

/** Parses and checks `{ "schemaVersion": 1, "registries": [...] }`; problems never quote the file content. */
export function parseAllowlist(text, label = "registry allowlist") {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return { problems: [`${label} is not valid JSON`], registries: [] };
  }
  const problems = [];
  if (document === null || typeof document !== "object" || Array.isArray(document)) return { problems: [`${label} must be a JSON object`], registries: [] };
  const extra = Object.keys(document).filter((key) => key !== "schemaVersion" && key !== "registries");
  if (extra.length > 0) problems.push(`${label} has unknown keys: ${extra.join(", ")}`);
  if (document.schemaVersion !== 1) problems.push(`${label} schemaVersion must be 1`);
  const registries = document.registries;
  if (!Array.isArray(registries) || registries.length === 0) return { problems: [...problems, `${label} registries must be a non-empty array`], registries: [] };
  registries.forEach((entry, index) => {
    if (typeof entry !== "string" || !REGISTRY_ENTRY_PATTERN.test(entry)) problems.push(`${label} registries[${index}] must be a lowercase host name with an optional :port, without scheme, path or whitespace`);
  });
  if (new Set(registries).size !== registries.length) problems.push(`${label} registries must not repeat an entry`);
  return { problems, registries: problems.length === 0 ? registries : [] };
}

export function validateRegistry(env, allowlistText) {
  const allowlist = parseAllowlist(allowlistText);
  const problems = [...allowlist.problems];
  const registryMissing = presence(env, "RELEASE_REGISTRY");
  if (registryMissing) problems.push(registryMissing);
  else if (allowlist.problems.length === 0 && !allowlist.registries.includes(env.RELEASE_REGISTRY)) problems.push("RELEASE_REGISTRY is not an entry of the registry allowlist");
  const namespaceMissing = presence(env, "RELEASE_IMAGE_NAMESPACE");
  if (namespaceMissing) problems.push(namespaceMissing);
  else if (!IMAGE_NAMESPACE_PATTERN.test(env.RELEASE_IMAGE_NAMESPACE)) problems.push("RELEASE_IMAGE_NAMESPACE has an invalid format (lowercase letters and digits separated by '.', '_', '-' or '/')");
  if (problems.length > 0) throw new ReleaseEnvironmentError(problems);
  return `registry=${env.RELEASE_REGISTRY}\nnamespace=${env.RELEASE_IMAGE_NAMESPACE}\n`;
}

function validMiniforgeUrl(value) {
  if (typeof value !== "string" || !MINIFORGE_URL_PATTERN.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export function buildArgs(env, matrixKey, miniforgeText, delimiter = randomBytes(16).toString("hex")) {
  const problems = [];
  if (typeof matrixKey !== "string" || !MATRIX_KEY_PATTERN.test(matrixKey)) problems.push("--matrix-key must be an upper-case image key");
  const shaMissing = presence(env, "GITHUB_SHA");
  if (shaMissing) problems.push(shaMissing);
  else if (!GIT_SHA_PATTERN.test(env.GITHUB_SHA)) problems.push("GITHUB_SHA must be a full 40-character lowercase git SHA");
  const lines = [];
  if (!shaMissing && GIT_SHA_PATTERN.test(env.GITHUB_SHA)) lines.push(`RELEASE_REVISION=${env.GITHUB_SHA}`);
  if (matrixKey === "COSYVOICE_IMAGE") {
    let pin;
    if (miniforgeText === undefined) problems.push("COSYVOICE_IMAGE requires --miniforge <file>");
    else {
      try {
        pin = JSON.parse(miniforgeText);
      } catch {
        problems.push("Miniforge pin file is not valid JSON");
      }
    }
    if (pin !== undefined) {
      if (!validMiniforgeUrl(pin?.url)) problems.push("Miniforge pin url must be an https:// URL without credentials, whitespace, quotes or backslashes");
      if (typeof pin?.sha256 !== "string" || !SHA256_PATTERN.test(pin.sha256)) problems.push("Miniforge pin sha256 must be 64 lowercase hexadecimal characters");
      if (problems.length === 0) lines.push(`MINIFORGE_URL=${pin.url}`, `MINIFORGE_SHA256=${pin.sha256}`);
    }
  }
  if (!/^[a-f0-9]{32}$/.test(delimiter)) problems.push("internal: the output delimiter must be 32 hexadecimal characters");
  if (problems.length > 0) throw new ReleaseEnvironmentError(problems);
  // Validated values cannot contain a newline, so they cannot end the block early or add keys.
  if (lines.some((line) => line.includes("\n") || line.includes(delimiter))) throw new ReleaseEnvironmentError(["internal: a build argument contains the output delimiter"]);
  return `value<<${delimiter}\n${lines.join("\n")}\n${delimiter}\n`;
}

export function validateSigning(env) {
  const problems = [];
  const keyPathMissing = presence(env, "RELEASE_SIGNING_KEY_PATH");
  if (keyPathMissing) problems.push(keyPathMissing);
  else if (!SIGNING_KEY_PATH_PATTERN.test(env.RELEASE_SIGNING_KEY_PATH) || env.RELEASE_SIGNING_KEY_PATH.includes("..")) {
    problems.push("RELEASE_SIGNING_KEY_PATH must be an absolute path of letters, digits, '.', '_', '-' and '/' without '..'");
  } else {
    let readable = false;
    try {
      readable = statSync(env.RELEASE_SIGNING_KEY_PATH).isFile();
      if (readable) accessSync(env.RELEASE_SIGNING_KEY_PATH, constants.R_OK);
    } catch {
      readable = false;
    }
    if (!readable) problems.push("RELEASE_SIGNING_KEY_PATH does not name a readable regular file on this runner");
  }
  const issuerMissing = presence(env, "RELEASE_ISSUER");
  if (issuerMissing) problems.push(issuerMissing);
  else if (!RELEASE_ISSUER_PATTERN.test(env.RELEASE_ISSUER)) problems.push("RELEASE_ISSUER must be 2-64 lowercase letters, digits, '_' or '-', starting with a letter");
  const keyIdMissing = presence(env, "RELEASE_KEY_ID");
  if (keyIdMissing) problems.push(keyIdMissing);
  else if (!RELEASE_KEY_ID_PATTERN.test(env.RELEASE_KEY_ID)) problems.push("RELEASE_KEY_ID must be 1-128 letters, digits, '.', '_' or '-', starting with a letter or digit");
  if (problems.length > 0) throw new ReleaseEnvironmentError(problems);
}

const USAGE = "usage: node scripts/release-environment.mjs registry --allowlist <file> | build-args --matrix-key <key> [--miniforge <file>] | signing";

function parseOptions(argv, allowed) {
  const options = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!allowed.includes(key) || value === undefined || value.startsWith("--") || options.has(key)) throw new ReleaseEnvironmentError([USAGE]);
    options.set(key, value);
  }
  return options;
}

function readFileOrFail(file, label) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new ReleaseEnvironmentError([`cannot read ${label} (${error.code ?? "read error"})`]);
  }
}

function writeOutput(env, text) {
  const target = env.GITHUB_OUTPUT;
  if (!target) throw new ReleaseEnvironmentError(["GITHUB_OUTPUT is not defined"]);
  appendFileSync(target, text, "utf8");
}

export function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  try {
    if (command === "registry") {
      const options = parseOptions(rest, ["--allowlist"]);
      if (!options.has("--allowlist")) throw new ReleaseEnvironmentError([USAGE]);
      const output = validateRegistry(env, readFileOrFail(options.get("--allowlist"), "the registry allowlist"));
      writeOutput(env, output);
      console.log("PASS  RELEASE_REGISTRY is an allowlisted registry and RELEASE_IMAGE_NAMESPACE is well formed");
    } else if (command === "build-args") {
      const options = parseOptions(rest, ["--matrix-key", "--miniforge"]);
      if (!options.has("--matrix-key")) throw new ReleaseEnvironmentError([USAGE]);
      const matrixKey = options.get("--matrix-key");
      const miniforge = matrixKey === "COSYVOICE_IMAGE" && options.has("--miniforge") ? readFileOrFail(options.get("--miniforge"), "the Miniforge pin file") : undefined;
      writeOutput(env, buildArgs(env, matrixKey, miniforge));
      console.log(`PASS  build arguments prepared for ${MATRIX_KEY_PATTERN.test(matrixKey) ? matrixKey : "the image"}`);
    } else if (command === "signing") {
      parseOptions(rest, []);
      validateSigning(env);
      console.log("PASS  RELEASE_SIGNING_KEY_PATH, RELEASE_ISSUER and RELEASE_KEY_ID are set and well formed");
    } else {
      throw new ReleaseEnvironmentError([USAGE]);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof ReleaseEnvironmentError)) throw error;
    for (const problem of error.problems) console.error(`::error::${problem}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}

export const scriptPath = fileURLToPath(import.meta.url);
