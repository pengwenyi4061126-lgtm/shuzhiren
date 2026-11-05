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
