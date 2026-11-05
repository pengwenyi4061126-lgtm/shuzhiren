// Offline model of `.dockerignore` matching (moby/patternmatcher semantics):
// patterns are cleaned and made relative to the context root, `*` and `?` do
// not cross `/`, `**` spans any number of path segments, a pattern also
// matches when it matches a parent directory, and the last matching rule wins.
import path from "node:path";

const SPECIAL = new Set([".", "+", "(", ")", "|", "{", "}", "$", "^"]);

function toRegex(pattern) {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
        source += i + 1 >= pattern.length ? ".*" : "(.*/)?";
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else if (ch === "\\" && i + 1 < pattern.length) {
      i += 1;
      source += `\\${pattern[i]}`;
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) throw new Error(`unterminated character class in dockerignore pattern ${pattern}`);
      const body = pattern.slice(i + 1, end).replace(/^!/, "^");
      source += `[${body}]`;
      i = end;
    } else {
      source += SPECIAL.has(ch) ? `\\${ch}` : ch;
    }
  }
  return new RegExp(`${source}$`);
}

/** @returns {Array<{ pattern: string, exclusion: boolean, regex: RegExp }>} */
export function parseDockerignore(text) {
  const rules = [];
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    let exclusion = false;
    if (line.startsWith("!")) {
      exclusion = true;
      line = line.slice(1).trim();
    }
    if (line === "") continue;
    let pattern = path.posix.normalize(line.replaceAll("\\", "/"));
    if (pattern.length > 1 && pattern.startsWith("/")) pattern = pattern.slice(1);
    if (pattern.length > 1 && pattern.endsWith("/")) pattern = pattern.slice(0, -1);
    rules.push({ pattern, exclusion, regex: toRegex(pattern) });
  }
  return rules;
}

/** True when `file` (a context-relative path with `/` separators) is left out of the build context. */
export function isExcluded(rules, file) {
  const normalized = path.posix.normalize(file).replace(/^\/+/, "");
  const segments = normalized.split("/");
  const parents = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
  let excluded = false;
  for (const rule of rules) {
    if (rule.exclusion !== excluded) continue;
    const matches = rule.regex.test(normalized) || parents.some((parent) => rule.regex.test(parent));
    if (matches) excluded = !rule.exclusion;
  }
  return excluded;
}

/** Lists the paths of `mustExclude` that the rules keep and the paths of `mustInclude` that they drop. */
export function checkDockerignore(text, { mustExclude = [], mustInclude = [] }) {
  const rules = parseDockerignore(text);
  return {
    leaked: mustExclude.filter((file) => !isExcluded(rules, file)),
    missing: mustInclude.filter((file) => isExcluded(rules, file))
  };
}
