// Offline model of Docker Compose variable interpolation and `env_file` path
// resolution, used by CI gates that cannot run `docker compose config`.
// Unsupported env-file syntax is rejected instead of guessed.
import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export class UnsupportedEnvSyntax extends Error {
  constructor(file, line, detail = "unsupported env file syntax") {
    super(`${file}:${line}: ${detail}`);
    this.name = "UnsupportedEnvSyntax";
    this.file = file;
    this.line = line;
    this.detail = detail;
  }
}

export class MissingRequiredVariable extends Error {
  constructor(variable, message) {
    super(`required variable ${variable} has no value${message ? `: ${message}` : ""}`);
    this.name = "MissingRequiredVariable";
    this.variable = variable;
    this.requiredMessage = message;
  }
}

export class InvalidInterpolation extends Error {
  constructor(template, offset, detail) {
    super(`invalid interpolation at offset ${offset}: ${detail}`);
    this.name = "InvalidInterpolation";
    this.template = template;
    this.offset = offset;
    this.detail = detail;
  }
}

function normalizeNewlines(text) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ENV_KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const DOUBLE_QUOTE_ESCAPES = { n: "\n", r: "\r", t: "\t", "\\": "\\", "\"": "\"", $: "$" };

function parseEnvValue(raw, file, line) {
  const quote = raw[0];
  if (quote === "'" || quote === "\"") {
    let value = "";
    let closed = false;
    let i = 1;
    for (; i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch === quote) {
        closed = true;
        break;
      }
      if (quote === "\"" && ch === "\\" && i + 1 < raw.length) {
        const next = raw[++i];
        value += DOUBLE_QUOTE_ESCAPES[next] ?? `\\${next}`;
        continue;
      }
      if (quote === "\"" && ch === "$") throw new UnsupportedEnvSyntax(file, line, "variable references inside env values are not supported");
      value += ch;
    }
    if (!closed) throw new UnsupportedEnvSyntax(file, line, "unterminated or multi-line quoted value");
    const rest = raw.slice(i + 1).trim();
    if (rest !== "" && !rest.startsWith("#")) throw new UnsupportedEnvSyntax(file, line, "unexpected text after quoted value");
    return value;
  }
  const comment = raw.search(/\s#/);
  const value = (comment >= 0 ? raw.slice(0, comment) : raw).trim();
  if (value.includes("$")) throw new UnsupportedEnvSyntax(file, line, "variable references inside env values are not supported");
  return value;
}

/**
 * Parses a compose env file: `KEY=VALUE`, `#` comment lines, blank lines,
 * single- or double-quoted values on one line, and ` #` inline comments after
 * unquoted values. Later duplicates of a key win.
 * @returns {Map<string, string>}
 * @throws {UnsupportedEnvSyntax} with the 1-based line number for anything else.
 */
export function parseEnvFile(text, file = "<env>") {
  const values = new Map();
  normalizeNewlines(text).split("\n").forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;
    const match = ENV_KEY_LINE.exec(line);
    if (!match) throw new UnsupportedEnvSyntax(file, index + 1, "expected KEY=VALUE");
    values.set(match[1], parseEnvValue(match[2], file, index + 1));
  });
  return values;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const OPERATOR = /^(:-|:\?|:\+|-|\?|\+)/;

// Splits a template into literal text and top-level references. Brace depth
// counts only `${` openings, matching compose-go; `$$` is an escaped dollar.
function scan(text) {
  const segments = [];
  let literal = "";
  let i = 0;
  const flush = () => {
    if (literal !== "") segments.push({ type: "literal", value: literal });
    literal = "";
  };
  while (i < text.length) {
    if (text[i] !== "$") {
      literal += text[i];
      i += 1;
      continue;
    }
    const next = text[i + 1];
    if (next === "$") {
      literal += "$";
      i += 2;
      continue;
    }
    if (next === "{") {
      let depth = 1;
      let j = i + 2;
      while (j < text.length) {
        if (text[j] === "$" && text[j + 1] === "$") {
          j += 2;
          continue;
        }
        if (text[j] === "$" && text[j + 1] === "{") {
          depth += 1;
          j += 2;
          continue;
        }
        if (text[j] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        j += 1;
      }
      if (depth !== 0) throw new InvalidInterpolation(text, i, "unterminated ${");
      const body = text.slice(i + 2, j);
      const name = NAME.exec(body)?.[0];
      if (!name) throw new InvalidInterpolation(text, i, `invalid variable name in \${${body}}`);
      const rest = body.slice(name.length);
      let operator = null;
      let argument = null;
      if (rest !== "") {
        operator = OPERATOR.exec(rest)?.[0] ?? null;
        if (operator === null) throw new InvalidInterpolation(text, i, `unsupported substitution in \${${body}}`);
        argument = rest.slice(operator.length);
      }
      flush();
      segments.push({ type: "reference", name, operator, argument, raw: text.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    const name = NAME.exec(text.slice(i + 1))?.[0];
    if (!name) throw new InvalidInterpolation(text, i, "'$' must be followed by a variable name, '{' or '$'");
    flush();
    segments.push({ type: "reference", name, operator: null, argument: null, raw: `$${name}` });
    i += 1 + name.length;
  }
  flush();
  return segments;
}

/**
 * Interpolation tokenizer. Recognizes `$$`, `$V`, `${V}` and the operators
 * `:-`, `-`, `:?`, `?`, `:+`, `+`. References nested inside an operator
 * argument are returned after the reference that contains them.
 * @returns {Array<{ name: string, operator: string | null, argument: string | null, raw: string }>}
 */
export function parseInterpolations(text) {
  const references = [];
  for (const segment of scan(text)) {
    if (segment.type !== "reference") continue;
    references.push({ name: segment.name, operator: segment.operator, argument: segment.argument, raw: segment.raw });
    if (segment.argument) references.push(...parseInterpolations(segment.argument));
  }
  return references;
}

function lookupOf(env) {
  if (env instanceof Map) return env;
  return new Map(Object.entries(env ?? {}).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)]));
}

function evaluate(text, lookup) {
  return scan(text).map((segment) => {
    if (segment.type === "literal") return segment.value;
    const { name, operator, argument } = segment;
    const isSet = lookup.has(name);
    const value = isSet ? lookup.get(name) : "";
    const isNonEmpty = isSet && value !== "";
    switch (operator) {
      case null:
        return value;
      case ":-":
        return isNonEmpty ? value : evaluate(argument, lookup);
      case "-":
        return isSet ? value : evaluate(argument, lookup);
      case ":?":
        if (isNonEmpty) return value;
        throw new MissingRequiredVariable(name, argument);
      case "?":
        if (isSet) return value;
        throw new MissingRequiredVariable(name, argument);
      case ":+":
        return isNonEmpty ? evaluate(argument, lookup) : "";
      case "+":
        return isSet ? evaluate(argument, lookup) : "";
      default:
        throw new InvalidInterpolation(text, 0, `unsupported operator ${operator}`);
    }
  }).join("");
}

/**
 * Compose-style interpolation of one string. An unset variable without an
 * operator becomes the empty string, as in compose.
 * @param {Map<string, string> | Record<string, string>} env
 * @throws {MissingRequiredVariable} for `${V:?m}` without a non-empty value or `${V?m}` without a value.
 */
export function interpolate(template, env) {
  return evaluate(template, lookupOf(env));
}

function isAbsolutePath(value) {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

/**
 * Resolves every service `env_file` entry of a compose file the way
 * `docker compose --env-file F1 … --env-file Fn -f <composeFile> config` does:
 * shell env overrides later env files, later env files override earlier ones,
 * and relative results resolve against the compose file's directory.
 * @param {{ composeFile: string, envFiles?: string[], shellEnv?: Record<string, string> | Map<string, string> }} options
 * @returns {Array<{ service: string, entry: string, value: string, resolvedPath: string, required: boolean }>}
 */
export function resolveComposeEnvFiles({ composeFile, envFiles = [], shellEnv = {} }) {
  const env = new Map();
  for (const file of envFiles) {
    for (const [key, value] of parseEnvFile(readFileSync(file, "utf8"), file)) env.set(key, value);
  }
  for (const [key, value] of lookupOf(shellEnv)) env.set(key, value);
  const doc = yaml.load(normalizeNewlines(readFileSync(composeFile, "utf8")), { filename: composeFile });
  const services = isMapping(doc) && isMapping(doc.services) ? doc.services : {};
  const directory = path.dirname(composeFile);
  const results = [];
  for (const [service, definition] of Object.entries(services)) {
    if (!isMapping(definition) || definition.env_file === undefined || definition.env_file === null) continue;
    const items = Array.isArray(definition.env_file) ? definition.env_file : [definition.env_file];
    for (const item of items) {
      const entry = typeof item === "string" ? item : isMapping(item) && typeof item.path === "string" ? item.path : undefined;
      if (entry === undefined) throw new Error(`${composeFile}: service ${service} has an env_file entry that is neither a string nor { path }`);
      let value;
      try {
        value = interpolate(entry, env);
      } catch (error) {
        error.service = service;
        throw error;
      }
      const required = !(isMapping(item) && (item.required === false || item.required === "false"));
      results.push({ service, entry, value, resolvedPath: isAbsolutePath(value) ? value : path.resolve(directory, value), required });
    }
  }
  return results;
}
