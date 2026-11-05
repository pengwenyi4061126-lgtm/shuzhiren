// package-lock.json must describe what the Linux images install with `npm ci` (L17):
// every registry package carries resolved + sha512 integrity, every dependency
// and optional dependency (platform binaries such as @next/swc-linux-x64-musl)
// resolves to a lock entry, and workspace entries match apps/*/package.json.

import { parseDockerfile } from "./dockerfile-refs.mjs";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function resolveFrom(packages, from, name) {
  let base = from;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (!base) return null;
    const cut = base.lastIndexOf("/node_modules/");
    base = cut >= 0 ? base.slice(0, cut) : "";
  }
}

/**
 * @param {any} lock parsed package-lock.json
 * @param {Record<string, any>} workspacePackages "apps/<name>" -> parsed package.json
 * @returns {string[]}
 */
export function npmLockViolations(lock, workspacePackages) {
  const problems = [];
  if (lock?.lockfileVersion !== 3) problems.push(`package-lock.json lockfileVersion must be 3, found ${lock?.lockfileVersion}`);
  const packages = lock?.packages ?? {};
  for (const [key, entry] of Object.entries(packages)) {
    if (key === "" || entry?.link) continue;
    if (key.includes("node_modules/")) {
      if (typeof entry.resolved !== "string" || !entry.resolved.startsWith("https://registry.npmjs.org/")) problems.push(`${key} must have a resolved https://registry.npmjs.org/ tarball, found ${JSON.stringify(entry.resolved)}`);
      if (typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) problems.push(`${key} must have a sha512 integrity, found ${JSON.stringify(entry.integrity)}`);
    }
    const installed = key === "" || !key.includes("node_modules/") ? ["dependencies", "devDependencies", "optionalDependencies"] : ["dependencies", "optionalDependencies"];
    for (const field of installed) {
      for (const name of Object.keys(entry?.[field] ?? {})) {
        if (!resolveFrom(packages, key, name)) problems.push(`${key || "<root>"} ${field} ${name} has no lock entry (the lock was not resolved for every platform; regenerate it)`);
      }
    }
  }
  for (const [dir, manifest] of Object.entries(workspacePackages)) {
    const entry = packages[dir];
    if (!entry) {
      problems.push(`package-lock.json has no workspace entry ${dir}`);
      continue;
    }
    if (packages[`node_modules/${manifest.name}`]?.resolved !== dir) problems.push(`package-lock.json node_modules/${manifest.name} must link to ${dir}`);
    for (const field of DEPENDENCY_FIELDS) {
      const want = JSON.stringify(Object.entries(manifest[field] ?? {}).sort());
      const have = JSON.stringify(Object.entries(entry[field] ?? {}).sort());
      if (want !== have) problems.push(`package-lock.json ${dir} ${field} ${have} must equal ${dir}/package.json ${want}`);
    }
  }
  return problems;
}

/**
 * A Dockerfile stage that runs `npm ci` must first COPY package.json,
 * package-lock.json and every workspace package.json, so npm ci sees the same
 * workspace set as the lock.
 * @param {string[]} workspaceDirs e.g. ["apps/console", ...]
 */
export function npmCiCopyViolations(file, text, workspaceDirs) {
  const problems = [];
  const stages = new Map();
  let copied = new Set();
  for (const { line, keyword, args } of parseDockerfile(text)) {
    if (keyword === "FROM") {
      const parts = args.split(/\s+/).filter((token) => token && !token.startsWith("--"));
      copied = new Set(stages.get((parts[0] ?? "").toLowerCase()) ?? []);
      if (parts.length >= 3 && parts[1].toLowerCase() === "as") stages.set(parts[2].toLowerCase(), copied);
      continue;
    }
    if (keyword === "COPY" && !/--from=/.test(args)) {
      const parts = args.split(/\s+/).filter((token) => token && !token.startsWith("--"));
      for (const source of parts.slice(0, -1)) copied.add(source.replace(/^\.\//, ""));
    }
    if (keyword === "RUN" && /(?:^|[\s;&|])npm\s+ci(?:\s|$)/.test(args)) {
      for (const required of ["package.json", "package-lock.json", ...workspaceDirs.map((dir) => `${dir}/package.json`)]) {
        if (!copied.has(required)) problems.push(`${file}:${line} npm ci runs before COPY ${required}`);
      }
    }
  }
  return problems;
}
