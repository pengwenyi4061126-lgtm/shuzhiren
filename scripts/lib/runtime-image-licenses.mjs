// LiveTalking modification notice and runtime image license files (Requirement 39.9-39.15; audit L18).
//
// runtime/patches/LIVETALKING_MODIFICATIONS.md declares, for every patch of runtime/patches/livetalking.series,
// the LiveTalking files it modifies, adds, deletes or renames (one `## runtime/patches/<patch>` section with a
// `| 文件 | 操作 |` table each), the locked commit it modifies and whether that commit has a NOTICE file.
//   - verifyLiveTalkingNotice() compares the notice with the lock and with the patches (Deploy_Check, 39.11, 39.15).
//   - patchedHeaderProblems() applies the series to the locked commit in a throw-away index and checks that every
//     modified or added file carries the Apache-2.0 4(b) header comment in its first 10 lines (39.10).
//   - dockerignoreLicenseProblems() checks that no image build context drops a copied component's LICENSE (39.13).
//   - checkImageLicenseFiles() compares the LICENSE, NOTICE and notice files inside the built images with the
//     locked commits and the repository, and checks the header comments in the image (39.10, 39.12-39.14).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkDockerignore } from "./dockerignore.mjs";
import { checkPatchSeries, readSeries } from "./livetalking-patches.mjs";

export const NOTICE_FILE = "runtime/patches/LIVETALKING_MODIFICATIONS.md";
export const IMAGE_NOTICE_FILE = "/app/LIVETALKING_MODIFICATIONS.md";
export const SERIES_FILE = "runtime/patches/livetalking.series";
export const HEADER_COMMENT = "Modified by the Shuzhiren project; see /app/LIVETALKING_MODIFICATIONS.md";
export const ADDED_COMMENT = "Added by the Shuzhiren project: this file is new and is not part of upstream LiveTalking.";
export const HEADER_LINE_LIMIT = 10;
export const OPERATIONS = Object.freeze(["修改", "新增", "删除", "重命名"]);
const NO_NOTICE = "没有 NOTICE 文件";
const NOTICE_SHIPPED = "NOTICE：已随镜像复制到 /app/NOTICE";

/** Where each locked component's source root lands inside its image (runtime/<image>/Dockerfile COPY targets). */
export const IMAGE_SOURCE_ROOTS = Object.freeze({
  LiveTalking: Object.freeze({ image: "livetalking", root: "/app" }),
  CosyVoice: Object.freeze({ image: "cosyvoice", root: "/opt/CosyVoice/CosyVoice" }),
  "Matcha-TTS": Object.freeze({ image: "cosyvoice", root: "/opt/CosyVoice/CosyVoice/third_party/Matcha-TTS" })
});

const EXTENDED_HEADER = /^(old mode|new mode|deleted file mode|new file mode|similarity index|dissimilarity index|index|rename from|rename to|copy from|copy to) /;

function unparsable(file) {
  return new Error(`LiveTalking 补丁 ${file} 无法解析`);
}

/**
 * Parses the `diff --git` headers of a patch.
 * @returns {Array<{ path: string, op: "修改"|"新增"|"删除"|"重命名" }>} in patch order; deletions name the old path,
 *   everything else the new path.
 * @throws {Error} `LiveTalking 补丁 <file> 无法解析` for a patch without file headers or with an unknown header line.
 */
export function parsePatchFileSet(patchText, file = "<patch>") {
  const lines = String(patchText).split(/\r?\n/);
  const result = [];
  let index = lines.findIndex((line) => line.startsWith("diff --git "));
  if (index < 0) throw unparsable(file);
  if (lines.slice(0, index).some((line) => line.trim() !== "")) throw unparsable(file);
  while (index < lines.length) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[index]);
    if (!header) throw unparsable(file);
    let [, from, to] = header;
    let op = "修改";
    index += 1;
    for (; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.startsWith("--- ") || line.startsWith("@@ ") || line.startsWith("Binary files ") || line === "GIT binary patch" || line.startsWith("diff --git ")) break;
      if (!EXTENDED_HEADER.test(line)) throw unparsable(file);
      if (line.startsWith("new file mode ")) op = "新增";
      else if (line.startsWith("deleted file mode ")) op = "删除";
      else if (line.startsWith("rename from ")) { op = "重命名"; from = line.slice("rename from ".length); }
      else if (line.startsWith("rename to ")) { op = "重命名"; to = line.slice("rename to ".length); }
    }
    result.push({ path: op === "删除" ? from : to, op });
    // Skip the hunks up to the next file header.
    while (index < lines.length && !lines[index].startsWith("diff --git ")) index += 1;
  }
  return result;
}

const stripCode = (cell) => cell.trim().replace(/^`(.*)`$/, "$1").trim();

/**
 * Parses the `## <patch>` sections of the notice markdown.
 * @returns {Array<{ patch: string, path: string, op: string }>}
 * @throws {Error} for a table row whose operation is not one of OPERATIONS.
 */
export function parseNoticeFileSet(markdown) {
  const result = [];
  let patch = null;
  for (const line of String(markdown).split(/\r?\n/)) {
    const section = /^##\s+(\S+)\s*$/.exec(line);
    if (section) { patch = stripCode(section[1]); continue; }
    if (/^#\s/.test(line)) { patch = null; continue; }
    if (!patch || !line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(stripCode);
    if (cells.length !== 2 || cells[0] === "文件" || /^:?-+:?$/.test(cells[0])) continue;
    if (!OPERATIONS.includes(cells[1])) throw new Error(`LiveTalking 修改声明 ${patch} 中 ${cells[0]} 的操作“${cells[1]}”无法识别`);
    result.push({ patch, path: cells[0], op: cells[1] });
  }
  return result;
}

/** Renders `## <patch>` sections with `| 文件 | 操作 |` tables, the format parseNoticeFileSet() reads. */
export function renderNoticeTables(sections) {
  return sections.map(({ patch, entries }) => [`## ${patch}`, "摘要：—", "", "| 文件 | 操作 |", "| --- | --- |", ...entries.map(({ path: file, op }) => `| ${file} | ${op} |`), ""].join("\n")).join("\n");
}

const entryKey = ({ patch, path: file, op }) => `${patch}:${file}（${op}）`;

/** Entries of `expected` missing from `actual` and entries of `actual` not in `expected`, as display strings. */
export function diffFileSets(expected, actual) {
  const want = new Set(expected.map(entryKey));
  const have = new Set(actual.map(entryKey));
  return { missing: [...want].filter((key) => !have.has(key)), extra: [...have].filter((key) => !want.has(key)) };
}

/** Reads the patch series: the files listed in livetalking.series, or every livetalking-*.patch when it is absent. */
export function liveTalkingPatches(sourceRoot) {
  const seriesFile = path.join(sourceRoot, ...SERIES_FILE.split("/"));
  const directory = path.dirname(seriesFile);
  const names = existsSync(seriesFile) ? readSeries(seriesFile) : readdirSync(directory).filter((name) => /^livetalking-.*\.patch$/.test(name)).sort();
  return names.map((name) => ({ patch: `runtime/patches/${name}`, file: path.join(directory, name) }));
}

/** (patch, path, op) for every file header of every patch in the series. */
export function patchSeriesFileSet(sourceRoot) {
  return liveTalkingPatches(sourceRoot).flatMap(({ patch, file }) => parsePatchFileSet(readFileSync(file, "utf8"), patch).map((entry) => ({ patch, ...entry })));
}

/** Runs a read-only git query that returns raw bytes; trusts the component directory for this command only. */
export function gitBytes(directory, args) {
  return execFileSync("git", ["-c", `safe.directory=${directory.split(path.sep).join("/")}`, "-c", "core.fsmonitor=false", "-C", directory, ...args], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
}

/** The bytes of `<commit>:<file>` in a component checkout, or null when the commit has no such file. */
export function lockedFile(sourceRoot, component, file) {
  const directory = path.join(sourceRoot, ...component.path.split("/"));
  try {
    gitBytes(directory, ["cat-file", "-e", `${component.commit}:${file}`]);
  } catch {
    return null;
  }
  return gitBytes(directory, ["cat-file", "blob", `${component.commit}:${file}`]);
}

function liveTalkingComponent(lock) {
  return Array.isArray(lock?.components) ? lock.components.find((component) => component?.name === "LiveTalking") : undefined;
}

/**
 * Deploy_Check: the notice names the locked LiveTalking commit and upstream repository, its NOTICE line matches
 * whether that commit has a NOTICE file, and its file tables equal the patch series' file headers.
 * @param {{ sourceRoot: string, lock: object, hasLockedNotice?: (component: object) => boolean }} options
 * @returns {string[]}
 */
export function verifyLiveTalkingNotice({ sourceRoot, lock, hasLockedNotice = (component) => lockedFile(sourceRoot, component, "NOTICE") !== null }) {
  const errors = [];
  const component = liveTalkingComponent(lock);
  if (!component) return ["开源运行时锁文件没有 LiveTalking 条目，无法核对 LiveTalking 修改声明"];
  let text;
  try {
    text = readFileSync(path.join(sourceRoot, ...NOTICE_FILE.split("/")), "utf8");
  } catch {
    return [`LiveTalking 修改声明 ${NOTICE_FILE} 不存在`];
  }
  const commit = /^- 被修改的锁定提交：\s*`?([0-9a-f]{40})`?\s*$/m.exec(text)?.[1];
  if (commit !== component.commit) errors.push(`LiveTalking 修改声明中被修改的锁定提交 ${commit ?? "缺失"} 与锁文件中的 ${component.commit} 不一致`);
  const upstream = /^- 上游仓库：\s*(\S+)\s*$/m.exec(text)?.[1];
  if (upstream !== component.repository) errors.push(`LiveTalking 修改声明中的上游仓库 ${upstream ?? "缺失"} 与锁文件中的 ${component.repository} 不一致`);
  const noticeLine = /^- NOTICE：.*$/m.exec(text)?.[0] ?? "";
  let present;
  try {
    present = hasLockedNotice(component);
  } catch (error) {
    errors.push(`LiveTalking 锁定提交的 NOTICE 无法读取：${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  if (present === true && !noticeLine.includes(NOTICE_SHIPPED)) errors.push(`LiveTalking 锁定提交 ${component.commit} 有 NOTICE 文件，修改声明的 NOTICE 行必须写“${NOTICE_SHIPPED}”`);
  if (present === false && !noticeLine.includes(NO_NOTICE)) errors.push(`LiveTalking 锁定提交 ${component.commit} 没有 NOTICE 文件，修改声明的 NOTICE 行必须写“${NO_NOTICE}”`);
  let declared;
  let actual;
  try {
    declared = parseNoticeFileSet(text);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    actual = patchSeriesFileSet(sourceRoot);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (declared && actual) {
    const { missing, extra } = diffFileSets(actual, declared);
    if (missing.length || extra.length) {
      errors.push(`LiveTalking 修改声明与补丁不一致：${[missing.length ? `声明缺少 ${missing.join("、")}` : "", extra.length ? `声明多出 ${extra.join("、")}` : ""].filter(Boolean).join("；")}`);
    }
  }
  return errors;
}

/**
 * The header comment problem of one patched file, or null. Modified and added files need HEADER_COMMENT in their
 * first HEADER_LINE_LIMIT lines; added files also need ADDED_COMMENT there.
 */
export function headerProblem(text, op) {
  const head = String(text).split(/\r?\n/).slice(0, HEADER_LINE_LIMIT);
  const comment = (needle) => head.some((line) => /^\s*(#|\/\/|<!--|--|;)/.test(line) && line.includes(needle));
  if (!comment(HEADER_COMMENT)) return `前 ${HEADER_LINE_LIMIT} 行没有修改声明注释“${HEADER_COMMENT}”`;
  if (op === "新增" && !comment(ADDED_COMMENT)) return `前 ${HEADER_LINE_LIMIT} 行没有新增文件说明“${ADDED_COMMENT}”`;
  return null;
}

/** Modified and added files of a notice file set (deleted files carry no header), without duplicates. */
export function headerTargets(entries) {
  const targets = new Map();
  for (const { path: file, op } of entries) {
    if (op === "删除") { targets.delete(file); continue; }
    if (op === "新增" || !targets.has(file)) targets.set(file, op === "重命名" ? "修改" : op);
  }
  return [...targets].map(([file, op]) => ({ path: file, op }));
}

/**
 * Applies the series to the locked LiveTalking commit in a throw-away index (vendor/LiveTalking and its index are
 * not touched) and checks the header comment of every modified or added file.
 * @returns {string[]}
 */
export function patchedHeaderProblems({ sourceRoot, sourceDir = path.join(sourceRoot, "vendor", "LiveTalking"), seriesFile = path.join(sourceRoot, ...SERIES_FILE.split("/")), entries }) {
  const targets = headerTargets(entries);
  if (targets.length === 0) return [];
  const checkout = mkdtempSync(path.join(os.tmpdir(), "livetalking-headers-"));
  try {
    const series = checkPatchSeries({ sourceDir, seriesFile, checkoutTo: checkout, paths: targets.map((target) => target.path) });
    if (series.failures.length) return series.failures.map(({ patch, message }) => `LiveTalking 补丁 ${patch} 无法应用到锁定提交 ${series.commit}：${message}`);
    const errors = [];
    for (const { path: file, op } of targets) {
      let text;
      try { text = readFileSync(path.join(checkout, ...file.split("/")), "utf8"); } catch { errors.push(`LiveTalking 补丁应用后没有 ${file}`); continue; }
      const problem = headerProblem(text, op);
      if (problem) errors.push(`LiveTalking 文件 ${file} ${problem}`);
    }
    return errors;
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}

/**
 * Every lock component copied into an image keeps its LICENSE (and NOTICE, when the locked commit has one) in that
 * image's build context, and the LiveTalking context keeps the modification notice.
 * @param {{ sourceRoot: string, lock: object, hasLockedFile?: (component: object, file: string) => boolean }} options
 */
export function dockerignoreLicenseProblems({ sourceRoot, lock, hasLockedFile = (component, file) => lockedFile(sourceRoot, component, file) !== null }) {
  const errors = [];
  const required = new Map();
  for (const component of Array.isArray(lock?.components) ? lock.components : []) {
    for (const image of Array.isArray(component?.images) ? component.images : []) {
      const files = required.get(image) ?? [];
      files.push(`${component.path}/LICENSE`);
      if (hasLockedFile(component, "NOTICE")) files.push(`${component.path}/NOTICE`);
      if (component.name === "LiveTalking") files.push(NOTICE_FILE);
      required.set(image, files);
    }
  }
  for (const [image, files] of required) {
    const ignoreFile = `runtime/${image}/Dockerfile.dockerignore`;
    let text;
    try { text = readFileSync(path.join(sourceRoot, "runtime", image, "Dockerfile.dockerignore"), "utf8"); } catch { errors.push(`${ignoreFile} 无法读取`); continue; }
    for (const file of checkDockerignore(text, { mustInclude: files }).missing) errors.push(`${ignoreFile} 把 ${file} 排除在镜像构建上下文之外`);
  }
  return errors;
}

/**
 * Distribution packages a runtime image installs for their content (not as build tooling), with their license.
 * fonts-noto-cjk supplies the CJK glyphs of the AIGC explicit label (runtime/livetalking/shuzhiren_aigc_label.py).
 * Each one is declared in THIRD_PARTY_NOTICES.md; the image keeps the package's Debian copyright file.
 */
export const THIRD_PARTY_NOTICES_FILE = "THIRD_PARTY_NOTICES.md";
export const IMAGE_SYSTEM_PACKAGES = Object.freeze({
  livetalking: Object.freeze([Object.freeze({ package: "fonts-noto-cjk", license: "SIL Open Font License 1.1", copyrightFile: "/usr/share/doc/fonts-noto-cjk/copyright", licenseMarker: /SIL OPEN FONT LICENSE|OFL-1\.1/i })])
});

/** Packages of every `apt-get install` command of a Dockerfile (options and shell operators dropped). */
export function aptInstalledPackages(dockerfileText) {
  const packages = [];
  for (const line of String(dockerfileText).replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    for (const match of line.matchAll(/apt-get\s+install\s+([^&|;]*)/g)) packages.push(...match[1].split(/\s+/).filter((word) => word && !word.startsWith("-")));
  }
  return packages;
}

/**
 * Every registered package is installed by its image's Dockerfile and declared (name and license) in
 * THIRD_PARTY_NOTICES.md, and every installed font package is registered.
 * @param {{ sourceRoot: string, registry?: typeof IMAGE_SYSTEM_PACKAGES }} options
 */
export function systemPackageNoticeProblems({ sourceRoot, registry = IMAGE_SYSTEM_PACKAGES }) {
  const errors = [];
  let notices = "";
  try { notices = readFileSync(path.join(sourceRoot, THIRD_PARTY_NOTICES_FILE), "utf8"); } catch { errors.push(`${THIRD_PARTY_NOTICES_FILE} 无法读取`); }
  for (const [image, packages] of Object.entries(registry)) {
    const dockerfile = `runtime/${image}/Dockerfile`;
    let installed = [];
    try { installed = aptInstalledPackages(readFileSync(path.join(sourceRoot, "runtime", image, "Dockerfile"), "utf8")); } catch { errors.push(`${dockerfile} 无法读取`); continue; }
    for (const entry of packages) {
      if (!installed.includes(entry.package)) errors.push(`${dockerfile} 没有安装已登记的系统软件包 ${entry.package}`);
      const row = notices.split(/\r?\n/).find((line) => line.includes(`\`${entry.package}\``));
      if (!row) errors.push(`${THIRD_PARTY_NOTICES_FILE} 没有声明 ${image} 镜像安装的 ${entry.package}`);
      else if (!row.includes(entry.license)) errors.push(`${THIRD_PARTY_NOTICES_FILE} 中 ${entry.package} 的许可证必须写明“${entry.license}”`);
    }
    for (const name of installed.filter((candidate) => /^fonts-/.test(candidate))) {
      if (!packages.some((entry) => entry.package === name)) errors.push(`${dockerfile} 安装的字体包 ${name} 没有登记许可证（IMAGE_SYSTEM_PACKAGES 与 ${THIRD_PARTY_NOTICES_FILE}）`);
    }
  }
  return errors;
}

/**
 * Each registered package's Debian copyright file is in the built image and names the declared license.
 * @param {{ images: Record<string, string|undefined>, readImageFile: Function, registry?: typeof IMAGE_SYSTEM_PACKAGES }} options
 * @returns {string[]} `IMAGE-FILE <image> <path> <reason>` lines.
 */
export function checkImageSystemPackages({ images, readImageFile, registry = IMAGE_SYSTEM_PACKAGES }) {
  const errors = [];
  for (const [name, packages] of Object.entries(registry)) {
    const image = images[name];
    if (!image) continue;
    for (const entry of packages) {
      let text;
      try { text = Buffer.from(readImageFile(image, entry.copyrightFile)).toString("utf8"); } catch (error) {
        errors.push(`IMAGE-FILE ${image} ${entry.copyrightFile} 镜像中缺少 ${entry.package} 的版权文件（${error instanceof Error ? error.message.split("\n")[0] : String(error)}）`);
        continue;
      }
      if (!entry.licenseMarker.test(text)) errors.push(`IMAGE-FILE ${image} ${entry.copyrightFile} 没有写明 ${entry.license}`);
    }
  }
  return errors;
}

/** The LiveTalking Dockerfile copies the modification notice to IMAGE_NOTICE_FILE. */
export function dockerfileNoticeProblems(sourceRoot) {
  const dockerfile = readFileSync(path.join(sourceRoot, "runtime", "livetalking", "Dockerfile"), "utf8");
  const copy = `COPY ${NOTICE_FILE} ${IMAGE_NOTICE_FILE}`;
  return dockerfile.split(/\r?\n/).some((line) => line.trim() === copy) ? [] : [`runtime/livetalking/Dockerfile 没有把修改声明复制进镜像：${copy}`];
}

/**
 * Compares license files inside built images. Readers: readImageFile(image, absolutePath) → Buffer (throws when the
 * file is missing or the container fails), readLockedFile(component, file) → Buffer|null (null: the locked commit
 * has no such file), readRepoFile(relativePath) → Buffer.
 * @param {{ lock: object, notice: Array<{ path: string, op: string }>, images: { livetalking?: string, cosyvoice?: string },
 *   readImageFile: Function, readLockedFile: Function, readRepoFile: Function }} options
 * @returns {string[]} `IMAGE-FILE <image> <path> <reason>` lines.
 */
export function checkImageLicenseFiles({ lock, notice, images, readImageFile, readLockedFile, readRepoFile }) {
  const errors = [];
  const report = (image, file, reason) => errors.push(`IMAGE-FILE ${image} ${file} ${reason}`);
  const fromImage = (image, file) => {
    try {
      return Buffer.from(readImageFile(image, file));
    } catch (error) {
      report(image, file, `镜像中缺少该文件（${error instanceof Error ? error.message.split("\n")[0] : String(error)}）`);
      return null;
    }
  };
  const sameBytes = (image, file, expected, source) => {
    const actual = fromImage(image, file);
    if (actual && !actual.equals(Buffer.from(expected))) report(image, file, `与${source}不一致（镜像 ${actual.length} 字节，期望 ${Buffer.from(expected).length} 字节）`);
  };
  for (const component of Array.isArray(lock?.components) ? lock.components : []) {
    const target = IMAGE_SOURCE_ROOTS[component?.name];
    const imageNames = Array.isArray(component?.images) ? component.images : [];
    if (imageNames.length && !target) { errors.push(`IMAGE-FILE - ${component.path} 锁条目 ${component.name} 没有登记镜像内源码路径（IMAGE_SOURCE_ROOTS）`); continue; }
    if (!target || !imageNames.includes(target.image)) continue;
    const image = images[target.image];
    if (!image) continue;
    const license = readLockedFile(component, "LICENSE");
    if (!license) report(image, `${target.root}/LICENSE`, `锁定提交 ${component.commit} 中没有 LICENSE`);
    else sameBytes(image, `${target.root}/LICENSE`, license, ` ${component.name} 锁定提交 ${component.commit} 中的 LICENSE `);
    const noticeFile = readLockedFile(component, "NOTICE");
    if (noticeFile) sameBytes(image, `${target.root}/NOTICE`, noticeFile, ` ${component.name} 锁定提交 ${component.commit} 中的 NOTICE `);
    if (component.name === "LiveTalking") {
      sameBytes(image, IMAGE_NOTICE_FILE, readRepoFile(NOTICE_FILE), `仓库中的 ${NOTICE_FILE} `);
      for (const { path: file, op } of headerTargets(notice)) {
        const text = fromImage(image, `${target.root}/${file}`);
        const problem = text && headerProblem(text.toString("utf8"), op);
        if (problem) report(image, `${target.root}/${file}`, problem);
      }
    }
  }
  return errors;
}
