// Static reading of Dockerfiles for the image gates (runtime:images:check).
// Handles `\` continuations, comment and blank lines inside continuations,
// `FROM [--platform=...] <ref> [AS <name>]` and `COPY|ADD --from=<value>`.
// `--from` naming an earlier stage (or its index) and `FROM scratch` are internal.

/** @typedef {{ line: number, keyword: string, args: string }} Instruction */
/** @typedef {{ line: number, instruction: "FROM"|"COPY"|"ADD", ref: string, stage?: string, internal: boolean }} ImageRef */

/** @returns {Instruction[]} `line` is the 1-based line on which the instruction starts. */
export function parseDockerfile(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const instructions = [];
  let current = null;
  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (current === null && (trimmed === "" || trimmed.startsWith("#"))) return;
    if (current !== null && (trimmed === "" || trimmed.startsWith("#"))) return;
    const continued = /\\\s*$/.test(raw);
    const body = continued ? raw.replace(/\\\s*$/, "") : raw;
    if (current === null) current = { line: index + 1, text: body };
    else current.text += ` ${body.trim()}`;
    if (!continued) {
      const match = /^\s*(\S+)\s*(.*)$/s.exec(current.text);
      instructions.push({ line: current.line, keyword: match[1].toUpperCase(), args: match[2].trim() });
      current = null;
    }
  });
  if (current !== null) {
    const match = /^\s*(\S+)\s*(.*)$/s.exec(current.text);
    instructions.push({ line: current.line, keyword: match[1].toUpperCase(), args: match[2].trim() });
  }
  return instructions;
}

const tokens = (args) => args.split(/\s+/).filter(Boolean);

/** @returns {ImageRef[]} every FROM base and every COPY/ADD --from source, in file order. */
export function imageRefs(text) {
  const refs = [];
  const stages = [];
  for (const { line, keyword, args } of parseDockerfile(text)) {
    if (keyword === "FROM") {
      const parts = tokens(args).filter((token) => !token.startsWith("--"));
      const ref = parts[0] ?? "";
      const stage = parts.length >= 3 && parts[1].toLowerCase() === "as" ? parts[2].toLowerCase() : undefined;
      const internal = ref.toLowerCase() === "scratch" || stages.includes(ref.toLowerCase());
      refs.push({ line, instruction: "FROM", ref, stage, internal });
      stages.push(stage ?? `#${stages.length}`);
    } else if (keyword === "COPY" || keyword === "ADD") {
      const from = tokens(args).find((token) => token.startsWith("--from="));
      if (!from) continue;
      const ref = from.slice("--from=".length);
      const internal = /^\d+$/.test(ref) ? Number(ref) < stages.length : stages.includes(ref.toLowerCase());
      refs.push({ line, instruction: keyword, ref, internal });
    }
  }
  return refs;
}

/** "docker.io/library/node:24-alpine@sha256:..." -> { repository: "node", tag: "24-alpine", digest: "sha256:..." } */
export function splitImageRef(ref) {
  const [nameAndTag, digest] = String(ref).split("@");
  const slash = nameAndTag.lastIndexOf("/");
  const colon = nameAndTag.lastIndexOf(":");
  const name = colon > slash ? nameAndTag.slice(0, colon) : nameAndTag;
  const tag = colon > slash ? nameAndTag.slice(colon + 1) : undefined;
  const repository = name.replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "").replace(/^library\//, "");
  return { name, repository, tag, digest };
}

/** Every external `node` base image must use the supported major (Requirement 27.3). */
export function nodeMajorViolations(file, text, major) {
  const problems = [];
  for (const ref of imageRefs(text)) {
    if (ref.internal) continue;
    const { repository, tag } = splitImageRef(ref.ref);
    if (repository !== "node") continue;
    const found = /^(\d+)(?:[.-]|$)/.exec(tag ?? "")?.[1];
    if (found !== String(major)) problems.push({ file, line: ref.line, ref: ref.ref, reason: `node base image must use a Node.js ${major} tag (${major}-alpine, ${major}-bookworm-slim, ${major}.x.y-...), found ${tag ?? "no tag"}` });
  }
  return problems;
}

/** Dockerfiles built by release.yml `build-and-push` (deduplicated, vendor/ excluded). */
export function releaseDockerfiles(releaseDoc) {
  const include = releaseDoc?.jobs?.["build-and-push"]?.strategy?.matrix?.include;
  if (!Array.isArray(include)) throw new Error("release.yml build-and-push must define strategy.matrix.include");
  return [...new Set(include.map((entry) => String(entry?.dockerfile ?? "")).filter((file) => file && !file.startsWith("vendor/")))];
}

// Supply-chain pins (M24, Requirement 35).
export const PINNED_IMAGE = /^(?<name>[^@\s]+):(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})@sha256:[a-f0-9]{64}$/;

/** Every external image reference must be `<repository>:<tag>@sha256:<64 lowercase hex>` (Requirement 35.2). */
export function pinViolations(file, text) {
  const problems = [];
  for (const ref of imageRefs(text)) {
    if (ref.internal) continue;
    const match = PINNED_IMAGE.exec(ref.ref);
    const pinned = match !== null && !match.groups.name.slice(match.groups.name.lastIndexOf("/") + 1).includes(":");
    if (!pinned) {
      const why = ref.ref.includes("$") ? "is built from a variable that cannot be checked statically; " : "";
      problems.push({ file, line: ref.line, ref: ref.ref, reason: `${why}base image must be <repository>:<tag>@sha256:<64 lowercase hex>` });
    }
  }
  return problems;
}

/** `pip install ...` command segments of every RUN instruction, with their tokens. */
export function pipInstalls(text) {
  const installs = [];
  for (const { line, keyword, args } of parseDockerfile(text)) {
    if (keyword !== "RUN") continue;
    for (const segment of args.split(/&&|\|\||;|\|/)) {
      const parts = tokens(segment.trim());
      const at = parts.findIndex((token, index) => /(?:^|\/)pip3?$/.test(token) && parts[index + 1] === "install");
      if (at >= 0) installs.push({ line, tokens: parts.slice(at + 2) });
    }
  }
  return installs;
}

const requirementFiles = (install) => install.tokens.flatMap((token, index) => token === "-r" || token === "--requirement" ? [install.tokens[index + 1] ?? ""] : token.startsWith("--requirement=") ? [token.slice(14)] : token.startsWith("-r") && token.length > 2 ? [token.slice(2)] : []);

/** The Gateway image installs only the hashed lock (Requirement 35.5). */
export function gatewayLockViolations(file, text) {
  const installs = pipInstalls(text);
  const problems = [];
  if (installs.length !== 1) problems.push({ file, line: installs[1]?.line ?? 1, ref: "pip install", reason: `must run exactly one pip install, found ${installs.length}` });
  for (const install of installs) {
    const files = requirementFiles(install);
    if (!install.tokens.includes("--require-hashes")) problems.push({ file, line: install.line, ref: "pip install", reason: "must pass --require-hashes" });
    if (files.length !== 1 || files[0].replace(/^\.\//, "") !== "requirements.lock" || install.tokens.some((token) => !token.startsWith("-") && !files.includes(token))) {
      problems.push({ file, line: install.line, ref: "pip install", reason: "must install only -r requirements.lock (no unhashed package arguments or other requirement files)" });
    }
  }
  for (const { line, keyword, args } of parseDockerfile(text)) {
    if (/\brequirements\.txt\b/.test(args) && (keyword === "COPY" || keyword === "ADD" || keyword === "RUN")) problems.push({ file, line, ref: keyword, reason: "must not copy or install requirements.txt; install requirements.lock" });
  }
  if (!parseDockerfile(text).some(({ keyword, args }) => keyword === "COPY" && /(?:^|\s)requirements\.lock(?:\s|$)/.test(args))) problems.push({ file, line: 1, ref: "COPY", reason: "must COPY requirements.lock into the image" });
  return problems;
}

const normalizeName = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");

/**
 * A hashed pip lock: every requirement is `<name>[extras]==<version>[ ; marker]`
 * with at least one `--hash=sha256:<64 hex>`; no options, URLs or editables; and
 * every `==` pin of `requirementsText` appears with the same version (Requirement 35.4).
 * @returns {string[]}
 */
export function pythonLockViolations(lockText, requirementsText) {
  const problems = [];
  const locked = new Map();
  const logical = [];
  let pending = "";
  for (const raw of String(lockText).replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trimEnd();
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1)} `;
      continue;
    }
    const full = `${pending}${line}`.trim();
    pending = "";
    if (full) logical.push(full);
  }
  if (pending.trim()) logical.push(pending.trim());
  for (const entry of logical) {
    const hashes = entry.match(/--hash=\S+/g) ?? [];
    const spec = entry.replace(/--hash=\S+/g, "").trim();
    if (spec.startsWith("-")) {
      problems.push(`lock option ${spec.split(/\s+/)[0]} is not allowed`);
      continue;
    }
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]+\])?==([A-Za-z0-9.!+_-]+)(?:\s*;\s*.+)?$/.exec(spec);
    if (!match) {
      problems.push(`lock entry "${spec}" must be <name>==<version>`);
      continue;
    }
    if (hashes.length === 0) problems.push(`lock entry ${match[1]}==${match[3]} has no --hash`);
    for (const hash of hashes) if (!/^--hash=sha256:[a-f0-9]{64}$/.test(hash)) problems.push(`lock entry ${match[1]}==${match[3]} has invalid ${hash}`);
    locked.set(normalizeName(match[1]), match[3]);
  }
  if (locked.size === 0) problems.push("lock has no requirements");
  for (const raw of String(requirementsText ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?==([^\s;]+)/.exec(line);
    if (!match) {
      problems.push(`requirements input "${line}" must pin ==<version>`);
      continue;
    }
    const version = locked.get(normalizeName(match[1]));
    if (version !== match[2]) problems.push(`top-level ${match[1]}==${match[2]} is ${version === undefined ? "missing from" : `locked as ${version} in`} the lock; regenerate it`);
  }
  return problems;
}
