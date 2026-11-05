// Single source of the supported Node.js major (decision D3, 2026-11-05:
// Node 24 LTS, maintained until 2028-04-30). Gates read the major from here.
export const NODE_LTS_MAJOR = 24;

/** "^24.11.0" -> "24.11.0"; any other range syntax throws so a gate is updated together with it. */
export function engineMinVersion(range) {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(String(range ?? ""));
  if (!match) throw new Error(`engines.node must be written as ^MAJOR.MINOR.PATCH, found ${JSON.stringify(range)}`);
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/** Major of a node image tag ("24-alpine", "24.11.1-alpine3.22" -> "24"); null for lts, current, alpine, etc. */
export function nodeImageTagMajor(tag) {
  return /^(\d+)(?:[.-]|$)/.exec(String(tag ?? ""))?.[1] ?? null;
}

/** Lowest major allowed by an exact or ^/~/>= version of a package such as @types/node. */
export function versionMajor(spec) {
  return /^(?:\^|~|>=)?\s*(\d+)(?:\.|$)/.exec(String(spec ?? "").trim())?.[1] ?? null;
}

/** The console runner stage: `FROM node:<major>[.x.y]-alpine[...][@sha256:<digest>] AS runner`. */
export function consoleRunnerStage(major) {
  return new RegExp(`^FROM node:${major}(?:\\.\\d+){0,2}-alpine[^\\s@]*(?:@sha256:[0-9a-f]{64})? AS runner$`, "m");
}
