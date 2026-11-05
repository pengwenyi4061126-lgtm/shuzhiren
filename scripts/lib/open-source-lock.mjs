// Open-source source lock checks for Deploy_Check (Requirement 39.1-39.8; audit L17).
//
// runtime/open-source.lock.json (schemaVersion "2") lists every vendored component with `path` (relative to the
// repository root), `parent` (the repository that records its gitlink; "." for top-level submodules), `commit`,
// `license`, `images` (the image targets its source is copied into) and `role`. verifyOpenSourceLock() checks each
// entry against Git rather than a fixed list of names:
//   1. `commit` is 40 hex characters, `license` is non-empty, `images` is an array, and no text field carries a
//      review conclusion ("reviewed", "compliant", "已审查", "合规");
//   2. `git -C <path> rev-parse --show-toplevel` is <path> itself, so an uninitialized nested submodule is not
//      read through its parent's HEAD;
//   3. HEAD equals `commit`;
//   4. the gitlink recorded by `git -C <parent> ls-tree HEAD <path relative to parent>` equals `commit`;
//   5. `git -C <path> status --porcelain` is empty.
// It also scans runtime/*/Dockerfile for `COPY … vendor/<X>…`: every copied submodule, and every nested submodule
// listed in its .gitmodules, needs a lock entry whose `images` names that Dockerfile's image directory.
//
// checkTemplateRefVariables() keeps `*_REF` variables out of config/*.example.env unless something reads them or
// the comment block directly above says they are only checked by deploy:check and do not change the image.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const LOCK_SCHEMA_VERSION = "2";
export const DEPRECATED_REF_VARIABLES = Object.freeze(["LIVETALKING_REF", "MUSETALK_REF", "COSYVOICE_REF"]);
const REVIEW_CONCLUSION = /reviewed|compliant|已审查|合规/i;
// Directories whose files read deployment variables: Compose, Dockerfiles, workflows and service code.
const ENV_READER_PATHS = Object.freeze(["infra", "runtime", "apps", ".github/workflows"]);

/**
 * Runs a read-only git query. The component directory is trusted for this one command only (`safe.directory`),
 * because nested submodule metadata may belong to the account that cloned it; fsmonitor is disabled so a
 * component's own Git configuration cannot run a program during `status`.
 */
export function runGit(directory, args) {
  return execFileSync("git", ["-c", `safe.directory=${directory.split(path.sep).join("/")}`, "-c", "core.fsmonitor=false", "-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function samePath(left, right) {
  const normalize = (value) => {
    let resolved = path.resolve(value);
    try { resolved = realpathSync.native(resolved); } catch { /* keep the resolved path */ }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function firstLine(error) {
  const text = error instanceof Error ? (error.stderr?.toString() || error.message) : String(error);
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "git 检查失败";
}

function relativePosix(from, to) {
  return path.relative(from, to).split(path.sep).join("/");
}

/** Returns the .gitmodules `path` values of a repository directory (empty when the file is absent). */
export function nestedSubmodulePaths(directory) {
  const file = path.join(directory, ".gitmodules");
  if (!existsSync(file)) return [];
  return [...readFileSync(file, "utf8").matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((match) => match[1]);
}

/** Maps each runtime/<image>/Dockerfile to the top-level vendor/<X> directories it copies from. */
export function dockerfileVendorCopies(sourceRoot) {
  const runtimeDirectory = path.join(sourceRoot, "runtime");
  if (!existsSync(runtimeDirectory)) return [];
  const copies = [];
  for (const entry of readdirSync(runtimeDirectory, { withFileTypes: true })) {
    const dockerfile = path.join(runtimeDirectory, entry.name, "Dockerfile");
    if (!entry.isDirectory() || !existsSync(dockerfile)) continue;
    const vendors = new Set();
    for (const line of readFileSync(dockerfile, "utf8").split(/\r?\n/)) {
      if (!/^\s*COPY\s/i.test(line)) continue;
      for (const match of line.matchAll(/(?:^|\s)vendor\/([A-Za-z0-9._-]+)/g)) vendors.add(`vendor/${match[1]}`);
    }
    if (vendors.size) copies.push({ image: entry.name, dockerfile: relativePosix(sourceRoot, dockerfile), vendors: [...vendors] });
  }
  return copies;
}

/** Returns one message per problem; every message starts with the component name. */
export function verifyOpenSourceLock({ sourceRoot, lock, git = runGit }) {
  const errors = [];
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) return ["开源运行时锁文件必须是 JSON 对象"];
  if (lock.schemaVersion !== LOCK_SCHEMA_VERSION) errors.push(`开源运行时锁文件的 schemaVersion 必须是 "${LOCK_SCHEMA_VERSION}"`);
  if (!Array.isArray(lock.components) || lock.components.length === 0) return [...errors, "开源运行时锁文件缺少组件"];
  const byPath = new Map();
  for (const component of lock.components) {
    const name = typeof component?.name === "string" && component.name ? component.name : "未知组件";
    const fieldErrors = [];
    if (!/^[0-9a-f]{40}$/.test(component?.commit ?? "")) fieldErrors.push(`${name} 没有固定 40 位小写 Git 提交`);
    if (typeof component?.license !== "string" || !component.license.trim()) fieldErrors.push(`${name} 缺少许可证记录`);
    if (!Array.isArray(component?.images) || component.images.some((image) => typeof image !== "string" || !image)) fieldErrors.push(`${name} 的 images 必须是镜像 target 名称数组`);
    if (typeof component?.path !== "string" || !component.path || path.isAbsolute(component.path) || component.path.split("/").includes("..")) fieldErrors.push(`${name} 的 path 必须是仓库内的相对路径`);
    if (typeof component?.parent !== "string" || !component.parent || path.isAbsolute(component.parent) || component.parent.split("/").includes("..")) fieldErrors.push(`${name} 的 parent 必须是 "." 或仓库内的相对路径`);
    else if (typeof component?.path === "string" && component.parent !== "." && !component.path.startsWith(`${component.parent}/`)) fieldErrors.push(`${name} 的 path 必须位于 parent ${component.parent} 之内`);
    for (const field of ["license", "role", "retainedFor"]) {
      if (typeof component?.[field] === "string" && REVIEW_CONCLUSION.test(component[field])) fieldErrors.push(`${name} 的 ${field} 不得写审查或合规结论`);
    }
    errors.push(...fieldErrors);
    if (typeof component?.path === "string" && component.path) byPath.set(component.path, { name, images: Array.isArray(component?.images) ? component.images : [] });
    if (fieldErrors.length) continue;

    const directory = path.join(sourceRoot, ...component.path.split("/"));
    let topLevel;
    try {
      topLevel = git(directory, ["rev-parse", "--show-toplevel"]);
    } catch (error) {
      errors.push(`${name} 源码目录无法读取 Git 信息：${firstLine(error)}`);
      continue;
    }
    if (!samePath(topLevel, directory)) {
      errors.push(`${name} 源码目录无法读取 Git 信息：${component.path} 不是独立的 Git 工作树（子模块可能未初始化）`);
      continue;
    }
    try {
      const head = git(directory, ["rev-parse", "HEAD"]);
      if (head !== component.commit) errors.push(`${name} 源码 HEAD ${head} 与锁定提交 ${component.commit} 不一致`);
    } catch (error) {
      errors.push(`${name} 源码目录无法读取 Git 信息：${firstLine(error)}`);
    }
    const parentDirectory = component.parent === "." ? sourceRoot : path.join(sourceRoot, ...component.parent.split("/"));
    const relative = component.parent === "." ? component.path : component.path.slice(component.parent.length + 1);
    try {
      const entry = git(parentDirectory, ["ls-tree", "HEAD", relative]);
      const gitlink = /^160000 commit ([0-9a-f]{40})\t/.exec(entry)?.[1];
      if (!gitlink) errors.push(`${name} 父仓库 ${component.parent} 没有记录 ${relative} 的子模块提交`);
      else if (gitlink !== component.commit) errors.push(`${name} 父仓库 ${component.parent} 记录的子模块提交 ${gitlink} 与锁定提交 ${component.commit} 不一致`);
    } catch (error) {
      errors.push(`${name} 父仓库 ${component.parent} 无法读取 Git 信息：${firstLine(error)}`);
    }
    try {
      if (git(directory, ["status", "--porcelain"])) errors.push(`${name} 源码目录存在未提交修改，禁止用于生产镜像构建`);
    } catch (error) {
      errors.push(`${name} 源码目录无法读取 Git 信息：${firstLine(error)}`);
    }
  }
  for (const { image, dockerfile, vendors } of dockerfileVendorCopies(sourceRoot)) {
    for (const vendor of vendors) {
      const nested = nestedSubmodulePaths(path.join(sourceRoot, ...vendor.split("/"))).map((nestedPath) => `${vendor}/${nestedPath}`);
      for (const copied of [vendor, ...nested]) {
        const entry = byPath.get(copied);
        if (!entry) errors.push(`${copied} 被 ${dockerfile} 复制进镜像，但开源运行时锁文件没有该路径的条目`);
        else if (!entry.images.includes(image)) errors.push(`${entry.name} 被 ${dockerfile} 复制进镜像，但锁条目的 images 没有列出 ${image}`);
      }
    }
  }
  return errors;
}

/** Returns the names of the deprecated `*_REF` variables present in a parsed runtime env (Map). */
export function deprecatedRefVariables(values) {
  return DEPRECATED_REF_VARIABLES.filter((name) => values.has(name));
}

function referencedByReader(sourceRoot, name) {
  try {
    execFileSync("git", ["-C", sourceRoot, "grep", "-q", "-w", "-F", name, "--", ...ENV_READER_PATHS], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks every `*_REF` variable of the given templates ([{ file, text }]). A variable passes when a reader under
 * infra/, runtime/, apps/ or .github/workflows/ names it (`isReferenced(name)`), or when the comment block directly
 * above it mentions `deploy:check` and "不会改变镜像".
 */
export function checkTemplateRefVariables({ sourceRoot, templates, isReferenced = (name) => referencedByReader(sourceRoot, name) }) {
  const errors = [];
  for (const { file, text } of templates) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const name = /^\s*([A-Za-z_][A-Za-z0-9_]*_REF)\s*=/.exec(line)?.[1];
      if (!name) return;
      const comments = [];
      for (let previous = index - 1; previous >= 0 && /^\s*#/.test(lines[previous]); previous -= 1) comments.push(lines[previous]);
      const explained = comments.some((comment) => comment.includes("deploy:check")) && comments.some((comment) => comment.includes("不会改变镜像"));
      if (!explained && !isReferenced(name)) errors.push(`${file} 的 ${name} 没有读取方；删除它，或在紧邻的注释中说明只由 deploy:check 核对、不会改变镜像`);
    });
  }
  return errors;
}
