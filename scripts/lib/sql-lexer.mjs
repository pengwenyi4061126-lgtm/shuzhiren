// A subset of the PostgreSQL lexer for static checks of migration files (Migration_Lint, Requirement 10).
// It never executes SQL. Comments are dropped; string literals ('…', E'…', U&'…', N'…', B'…', X'…'), dollar-quoted
// strings ($tag$…$tag$), quoted identifiers, numbers, operators and punctuation become tokens, so text inside a
// comment or a literal can never be mistaken for code. Every token records its 1-based start line and its offsets
// in the source (after a leading BOM is removed). CR LF and LF give the same line numbers.

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);
const OPERATOR_CHARS = new Set(["+", "-", "*", "/", "<", ">", "=", "~", "!", "@", "#", "%", "^", "&", "|", "`", "?"]);
// An operator may end in + or - only when it also contains one of these characters (PostgreSQL scan.l).
const OPERATOR_TAIL_ALLOWED = /[~!@#%^&|`?]/;
const SINGLE_PUNCT = new Set(["(", ")", ",", ";", ".", "[", "]"]);

const isIdentStart = (ch) => ch !== undefined && (/[A-Za-z_]/.test(ch) || ch.charCodeAt(0) >= 0x80);
const isIdentPart = (ch) => ch !== undefined && (/[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80);
const isDollarTagPart = (ch) => ch !== undefined && (/[A-Za-z0-9_]/.test(ch) || ch.charCodeAt(0) >= 0x80);
const isDigit = (ch) => ch !== undefined && ch >= "0" && ch <= "9";

/**
 * @typedef {{ type: "ident"|"quoted_ident"|"string"|"dollar_string"|"number"|"param"|"op"|"punct",
 *             value: string, line: number, start: number, end: number,
 *             body?: string, bodyLine?: number, bodyStart?: number, tag?: string }} Token
 *   value: the source text for ident, number, param, op and punct; the decoded content for string and
 *   quoted_ident; the body for dollar_string. body/bodyLine/bodyStart describe the content of string and
 *   dollar_string tokens (bodyStart is the source offset of the first content character).
 * @typedef {{ line: number, message: string }} LexError
 */

/** Tokenizes SQL. startLine numbers the first line (used when a function body is lexed on its own). */
export function lexSql(source, { startLine = 1 } = {}) {
  const text = String(source).startsWith("\uFEFF") ? String(source).slice(1) : String(source);
  const tokens = [];
  const errors = [];
  let index = 0;
  let line = startLine;
  const advance = (to) => {
    for (let cursor = index; cursor < to; cursor += 1) if (text[cursor] === "\n") line += 1;
    index = to;
  };
  const push = (token) => { tokens.push(token); return token; };

  while (index < text.length) {
    const ch = text[index];
    const next = text[index + 1];
    if (WHITESPACE.has(ch)) { advance(index + 1); continue; }
    if (ch === "-" && next === "-") {
      const newline = text.indexOf("\n", index);
      advance(newline < 0 ? text.length : newline);
      continue;
    }
    if (ch === "/" && next === "*") {
      const startLineOfComment = line;
      let depth = 1;
      let cursor = index + 2;
      while (cursor < text.length && depth > 0) {
        if (text[cursor] === "/" && text[cursor + 1] === "*") { depth += 1; cursor += 2; }
        else if (text[cursor] === "*" && text[cursor + 1] === "/") { depth -= 1; cursor += 2; }
        else cursor += 1;
      }
      if (depth > 0) errors.push({ line: startLineOfComment, message: "unterminated block comment" });
      advance(cursor);
      continue;
    }
    if (isIdentStart(ch)) {
      let cursor = index + 1;
      while (isIdentPart(text[cursor])) cursor += 1;
      const word = text.slice(index, cursor);
      const after = text[cursor];
      if (word.length === 1 && after === "'" && /[eEnNbBxX]/.test(word)) {
        lexQuoted(cursor, { escapes: /[eE]/.test(word) });
        continue;
      }
      if (word.length === 1 && /[uU]/.test(word) && after === "&" && (text[cursor + 1] === "'" || text[cursor + 1] === "\"")) {
        if (text[cursor + 1] === "'") lexQuoted(cursor + 1, { escapes: false });
        else lexQuotedIdentifier(cursor + 1);
        continue;
      }
      push({ type: "ident", value: word, line, start: index, end: cursor });
      advance(cursor);
      continue;
    }
    if (ch === "'") { lexQuoted(index, { escapes: false }); continue; }
    if (ch === "\"") { lexQuotedIdentifier(index); continue; }
    if (ch === "$") {
      if (isDigit(next)) {
        let cursor = index + 1;
        while (isDigit(text[cursor])) cursor += 1;
        push({ type: "param", value: text.slice(index, cursor), line, start: index, end: cursor });
        advance(cursor);
        continue;
      }
      let cursor = index + 1;
      if (isIdentStart(text[cursor])) while (isDollarTagPart(text[cursor])) cursor += 1;
      if (text[cursor] === "$") {
        const delimiter = text.slice(index, cursor + 1);
        const bodyStart = cursor + 1;
        const close = text.indexOf(delimiter, bodyStart);
        const tokenLine = line;
        const bodyLine = tokenLine + countNewlines(text, index, bodyStart);
        if (close < 0) {
          errors.push({ line: tokenLine, message: `unterminated dollar-quoted string ${delimiter}` });
          advance(text.length);
          continue;
        }
        const body = text.slice(bodyStart, close);
        push({ type: "dollar_string", value: body, line: tokenLine, start: index, end: close + delimiter.length, body, bodyLine, bodyStart, tag: delimiter.slice(1, -1) });
        advance(close + delimiter.length);
        continue;
      }
      push({ type: "punct", value: "$", line, start: index, end: index + 1 });
      advance(index + 1);
      continue;
    }
    if (isDigit(ch) || (ch === "." && isDigit(next))) { lexNumber(index); continue; }
    if (ch === ":" && (next === ":" || next === "=")) {
      push({ type: "punct", value: ch + next, line, start: index, end: index + 2 });
      advance(index + 2);
      continue;
    }
    if (ch === ":" || SINGLE_PUNCT.has(ch)) {
      push({ type: "punct", value: ch, line, start: index, end: index + 1 });
      advance(index + 1);
      continue;
    }
    if (OPERATOR_CHARS.has(ch)) { lexOperator(index); continue; }
    // Anything else (for example a stray backslash) is kept as a one-character token.
    push({ type: "punct", value: ch, line, start: index, end: index + 1 });
    advance(index + 1);
  }
  return { tokens, errors };

  function lexQuoted(quoteIndex, { escapes }) {
    const tokenLine = line;
    let cursor = quoteIndex + 1;
    let value = "";
    let closed = false;
    while (cursor < text.length) {
      const current = text[cursor];
      if (escapes && current === "\\") {
        const [decoded, length] = decodeEscape(text, cursor);
        value += decoded;
        cursor += length;
        continue;
      }
      if (current === "'") {
        if (text[cursor + 1] === "'") { value += "'"; cursor += 2; continue; }
        closed = true;
        break;
      }
      value += current;
      cursor += 1;
    }
    if (!closed) {
      errors.push({ line: tokenLine, message: "unterminated string literal" });
      advance(text.length);
      return;
    }
    const bodyStart = quoteIndex + 1;
    push({ type: "string", value, line: tokenLine, start: index, end: cursor + 1, body: value, bodyLine: tokenLine + countNewlines(text, index, bodyStart), bodyStart });
    advance(cursor + 1);
  }

  function lexQuotedIdentifier(quoteIndex) {
    const tokenLine = line;
    let cursor = quoteIndex + 1;
    let value = "";
    let closed = false;
    while (cursor < text.length) {
      if (text[cursor] === "\"") {
        if (text[cursor + 1] === "\"") { value += "\""; cursor += 2; continue; }
        closed = true;
        break;
      }
      value += text[cursor];
      cursor += 1;
    }
    if (!closed) {
      errors.push({ line: tokenLine, message: "unterminated quoted identifier" });
      advance(text.length);
      return;
    }
    push({ type: "quoted_ident", value, line: tokenLine, start: index, end: cursor + 1 });
    advance(cursor + 1);
  }

  function lexNumber(startIndex, sign = "") {
    let cursor = startIndex;
    while (isDigit(text[cursor])) cursor += 1;
    // "1..10" in a PL/pgSQL FOR loop: the first dot belongs to the range operator, not to the number.
    if (text[cursor] === "." && text[cursor + 1] !== ".") {
      cursor += 1;
      while (isDigit(text[cursor])) cursor += 1;
    }
    if (/[eE]/.test(text[cursor] ?? "") && (isDigit(text[cursor + 1]) || (/[+-]/.test(text[cursor + 1] ?? "") && isDigit(text[cursor + 2])))) {
      cursor += 2;
      while (isDigit(text[cursor])) cursor += 1;
    }
    const tokenStart = startIndex - sign.length;
    push({ type: "number", value: sign + text.slice(startIndex, cursor), line, start: tokenStart, end: cursor });
    advance(cursor);
  }

  function lexOperator(startIndex) {
    let cursor = startIndex;
    // The operator ends where a comment starts ("--" or "/*"); the main loop never calls this at a comment start.
    while (cursor < text.length && OPERATOR_CHARS.has(text[cursor])) {
      if ((text[cursor] === "-" && text[cursor + 1] === "-") || (text[cursor] === "/" && text[cursor + 1] === "*")) break;
      cursor += 1;
    }
    let operator = text.slice(startIndex, cursor);
    if (operator.length > 1 && !OPERATOR_TAIL_ALLOWED.test(operator)) {
      while (operator.length > 1 && /[+-]$/.test(operator)) operator = operator.slice(0, -1);
    }
    const signed = (operator === "-" || operator === "+") && isDigit(text[startIndex + 1]) && signMayPrefixNumber(tokens[tokens.length - 1]);
    if (signed) {
      advance(startIndex + 1);
      lexNumber(startIndex + 1, operator);
      return;
    }
    push({ type: "op", value: operator, line, start: startIndex, end: startIndex + operator.length });
    advance(startIndex + operator.length);
  }
}

/** A leading - or + is part of a number literal when no operand precedes it (start, an operator, "(" or ","). */
function signMayPrefixNumber(previous) {
  if (!previous) return true;
  if (previous.type === "op") return true;
  return previous.type === "punct" && ["(", ",", "[", "::", ":=", ";", ":"].includes(previous.value);
}

function countNewlines(text, from, to) {
  let count = 0;
  for (let cursor = from; cursor < to; cursor += 1) if (text[cursor] === "\n") count += 1;
  return count;
}

function decodeEscape(text, slash) {
  const next = text[slash + 1];
  if (next === undefined) return ["\\", 1];
  const simple = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  if (Object.hasOwn(simple, next)) return [simple[next], 2];
  if (/[0-7]/.test(next)) {
    const digits = /^[0-7]{1,3}/.exec(text.slice(slash + 1))[0];
    return [String.fromCharCode(Number.parseInt(digits, 8)), 1 + digits.length];
  }
  if (next === "x") {
    const digits = /^[0-9A-Fa-f]{1,2}/.exec(text.slice(slash + 2))?.[0];
    if (digits) return [String.fromCharCode(Number.parseInt(digits, 16)), 2 + digits.length];
  }
  if (next === "u" || next === "U") {
    const width = next === "u" ? 4 : 8;
    const digits = text.slice(slash + 2, slash + 2 + width);
    if (digits.length === width && /^[0-9A-Fa-f]+$/.test(digits)) return [String.fromCodePoint(Number.parseInt(digits, 16)), 2 + width];
  }
  return [next, 2];
}

/**
 * Splits a token list into statements at top-level ";" (outside parentheses and brackets). String, dollar-quoted
 * and comment content never produces a ";" token, so a function body is always inside one statement.
 * Returns [{ tokens, line, start, end }] for each non-empty statement; the ";" itself is not included.
 */
export function splitStatements(tokens) {
  const statements = [];
  let current = [];
  let depth = 0;
  const flush = () => {
    if (current.length) statements.push({ tokens: current, line: current[0].line, start: current[0].start, end: current[current.length - 1].end });
    current = [];
  };
  for (const token of tokens) {
    if (token.type === "punct" && (token.value === "(" || token.value === "[")) depth += 1;
    else if (token.type === "punct" && (token.value === ")" || token.value === "]")) depth = Math.max(0, depth - 1);
    else if (token.type === "punct" && token.value === ";" && depth === 0) { flush(); continue; }
    current.push(token);
  }
  flush();
  return statements;
}

/**
 * The source with every comment, string literal, dollar-quoted string and quoted identifier content replaced by
 * spaces. Newlines are kept, so offsets and line numbers still match the input. Returns { masked, errors }.
 */
export function maskSql(source) {
  const text = String(source).startsWith("\uFEFF") ? String(source).slice(1) : String(source);
  const { tokens, errors } = lexSql(text);
  const out = text.split("").map((ch) => (ch === "\n" || ch === "\r" ? ch : " "));
  for (const token of tokens) {
    if (token.type === "string" || token.type === "dollar_string" || token.type === "quoted_ident") continue;
    for (let cursor = token.start; cursor < token.end; cursor += 1) out[cursor] = text[cursor];
  }
  return { masked: out.join(""), errors };
}

/** Lower-cased identifier text for keyword comparisons; quoted identifiers keep their exact text. */
export function identifierName(token) {
  if (!token) return null;
  if (token.type === "ident") return token.value.toLowerCase();
  if (token.type === "quoted_ident") return token.value;
  return null;
}

/** True when token is the unquoted keyword (case-insensitive). */
export function isKeyword(token, keyword) {
  return token?.type === "ident" && token.value.toLowerCase() === keyword;
}

/**
 * psql variable references (:name, :'name', :"name") outside comments and literals. psql does not substitute
 * inside quotes or dollar quotes, so only references in code are returned: [{ name, form, line, start, end }].
 * "::" casts and ":=" are punctuation tokens of their own and never match.
 */
export function findPsqlVariables(source) {
  const text = String(source).startsWith("\uFEFF") ? String(source).slice(1) : String(source);
  const { tokens, errors } = lexSql(text);
  const variables = [];
  for (let position = 0; position < tokens.length - 1; position += 1) {
    const colon = tokens[position];
    const name = tokens[position + 1];
    if (colon.type !== "punct" || colon.value !== ":" || name.start !== colon.end) continue;
    if (name.type === "ident") variables.push({ name: name.value, form: "bare", line: colon.line, start: colon.start, end: name.end });
    else if (name.type === "quoted_ident") variables.push({ name: name.value, form: "identifier", line: colon.line, start: colon.start, end: name.end });
    else if (name.type === "string") variables.push({ name: name.value, form: "literal", line: colon.line, start: colon.start, end: name.end });
  }
  return { variables, errors };
}

/**
 * Substitutes :"name" with the double-quoted identifier value, as psql -v name=value does. Throws when the source
 * uses any other psql variable or form, has a psql meta-command line, or does not lex cleanly, so a test that
 * executes the file through a driver runs exactly what psql would run.
 */
export function substitutePsqlIdentifierVariable(source, name, value) {
  const text = String(source).startsWith("\uFEFF") ? String(source).slice(1) : String(source);
  const { variables, errors } = findPsqlVariables(text);
  if (errors.length) throw new Error(`cannot lex psql script: ${errors.map((error) => `line ${error.line}: ${error.message}`).join("; ")}`);
  const { masked } = maskSql(text);
  const metaLine = masked.split("\n").findIndex((lineText) => /^\s*\\/.test(lineText));
  if (metaLine >= 0) throw new Error(`psql meta-commands are not allowed (line ${metaLine + 1})`);
  const unexpected = variables.filter((variable) => variable.name !== name || variable.form !== "identifier");
  if (unexpected.length) throw new Error(`only the psql variable :"${name}" is allowed; found ${unexpected.map((variable) => `line ${variable.line}`).join(", ")}`);
  if (!variables.length) throw new Error(`psql variable :"${name}" is not used`);
  const quoted = `"${String(value).replaceAll("\"", "\"\"")}"`;
  let result = "";
  let cursor = 0;
  for (const variable of variables) {
    result += text.slice(cursor, variable.start) + quoted;
    cursor = variable.end;
  }
  return result + text.slice(cursor);
}
