// Bash quoting scanner for the Release_Workflow_Gate env-quote rule
// (Requirement 13.2). It walks a `run:` script once and reports, for every
// parameter reference `$NAME` or `${NAME…}`, whether it sits inside double
// quotes. The state is `unquoted | single | double`; `\` escapes the next
// character outside single quotes, `$( … )` starts a new unquoted context that
// ends at its matching `)` (the outer state is restored), and `#` at the start
// of a word outside quotes begins a comment that runs to the end of the line.
// Constructs the scanner does not model are reported as `unsupported` so the
// gate can reject them instead of guessing: backtick command substitution and
// heredocs (`<<` outside quotes; the here-string `<<<` is allowed).

const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const WORD_BREAK = /[\s;&|()<>]/;

/**
 * @param {string} script
 * @returns {{ refs: { name: string, offset: number, quoted: boolean }[], unsupported: { kind: "backtick" | "heredoc", offset: number }[] }}
 */
export function scanShellQuotes(script) {
  const refs = [];
  const unsupported = [];
  // Each frame is one quoting context: the script itself, a double-quoted
  // string or a command substitution. `parens` counts plain `(` inside it.
  const stack = [{ mode: "unquoted", parens: 0, substitution: false }];
  let wordStart = true;
  let i = 0;
  const n = script.length;

  const readName = (at) => {
    NAME.lastIndex = at;
    const match = NAME.exec(script);
    return match ? match[0] : null;
  };

  // Handles `$` at i; returns the next index.
  const dollar = (quoted) => {
    const next = script[i + 1];
    if (next === "(") {
      stack.push({ mode: "unquoted", parens: 0, substitution: true });
      wordStart = true;
      return i + 2;
    }
    if (next === "{") {
      const name = readName(i + 2);
      if (name) refs.push({ name, offset: i, quoted });
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (script[j] === "\\") j += 1;
        else if (script[j] === "{") depth += 1;
        else if (script[j] === "}") depth -= 1;
        j += 1;
      }
      return j;
    }
    const name = readName(i + 1);
    if (name) {
      refs.push({ name, offset: i, quoted });
      return i + 1 + name.length;
    }
    return i + 1;
  };

  while (i < n) {
    const frame = stack[stack.length - 1];
    const c = script[i];
    if (frame.mode === "double") {
      if (c === "\\") i += 2;
      else if (c === "\"") {
        stack.pop();
        i += 1;
        wordStart = false;
      } else if (c === "`") {
        unsupported.push({ kind: "backtick", offset: i });
        i += 1;
      } else if (c === "$") i = dollar(true);
      else i += 1;
      continue;
    }
    // unquoted
    if (c === "\\") {
      i += 2;
      wordStart = false;
      continue;
    }
    if (c === "'") {
      const end = script.indexOf("'", i + 1);
      i = end < 0 ? n : end + 1;
      wordStart = false;
      continue;
    }
    if (c === "\"") {
      stack.push({ mode: "double", parens: 0, substitution: false });
      i += 1;
      wordStart = false;
      continue;
    }
    if (c === "#" && wordStart) {
      const end = script.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === "`") {
      unsupported.push({ kind: "backtick", offset: i });
      i += 1;
      wordStart = false;
      continue;
    }
    if (c === "<" && script[i + 1] === "<") {
      if (script[i + 2] === "<") {
        i += 3;
      } else {
        unsupported.push({ kind: "heredoc", offset: i });
        i += 2;
      }
      wordStart = true;
      continue;
    }
    if (c === "$") {
      i = dollar(false);
      wordStart = false;
      continue;
    }
    if (c === "(") frame.parens += 1;
    if (c === ")") {
      if (frame.parens > 0) frame.parens -= 1;
      else if (frame.substitution) {
        stack.pop();
        i += 1;
        wordStart = false;
        continue;
      }
    }
    wordStart = WORD_BREAK.test(c);
    i += 1;
  }
  return { refs, unsupported };
}
