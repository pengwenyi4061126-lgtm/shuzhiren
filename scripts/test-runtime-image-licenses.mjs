// Behavioral tests for scripts/lib/runtime-image-licenses.mjs and scripts/check-runtime-image-licenses.mjs
// (Requirement 39.9-39.15; audit L18; Property 161). Fixtures are throw-away directories and Git repositories; the
// image readers are in-memory stand-ins, so no Docker is needed. npm run licenses:images:test.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADDED_COMMENT, aptInstalledPackages, checkImageLicenseFiles, checkImageSystemPackages, diffFileSets, dockerfileNoticeProblems, dockerignoreLicenseProblems, HEADER_COMMENT, IMAGE_NOTICE_FILE, NOTICE_FILE,
  parseNoticeFileSet, parsePatchFileSet, patchedHeaderProblems, patchSeriesFileSet, renderNoticeTables, systemPackageNoticeProblems, verifyLiveTalkingNotice
} from "./lib/runtime-image-licenses.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const identity = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "core.autocrlf=false"];
const git = (directory, ...args) => execFileSync("git", [...identity, "-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const header = `# ${HEADER_COMMENT}`;
const added = `# ${ADDED_COMMENT}`;

// Patch blocks for each operation, as `git diff` writes them.
function patchBlock({ path: file, op, from = `old/${file}` }) {
  switch (op) {
    case "修改": return `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-x\n+y\n`;
    case "新增": return `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+y\n`;
    case "删除": return `diff --git a/${file} b/${file}\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/${file}\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`;
    case "重命名": return `diff --git a/${from} b/${file}\nsimilarity index 90%\nrename from ${from}\nrename to ${file}\nindex 1111111..2222222 100644\n--- a/${from}\n+++ b/${file}\n@@ -1 +1 @@\n-x\n+y\n`;
    default: throw new Error(op);
  }
}
const patchText = (entries) => entries.map(patchBlock).join("");

// Deterministic PRNG (mulberry32) for the Property 161 runs.
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const fixture = await mkdtemp(path.join(os.tmpdir(), "shuzhiren-image-licenses-"));
const vendorStatusBefore = git(path.join(root, "vendor", "LiveTalking"), "status", "--porcelain");
try {
  // parsePatchFileSet: one entry per file header, with the operation from the extended headers.
  const sample = [{ path: "a.py", op: "修改" }, { path: "tts/new.py", op: "新增" }, { path: "gone.py", op: "删除" }, { path: "moved/b.py", op: "重命名", from: "b.py" }];
  assert.deepEqual(parsePatchFileSet(patchText(sample)), sample.map(({ path: file, op }) => ({ path: file, op })), "every file header and operation must be parsed");
  assert.throws(() => parsePatchFileSet("not a patch\n", "runtime/patches/x.patch"), /^Error: LiveTalking 补丁 runtime\/patches\/x\.patch 无法解析$/, "a patch without file headers must be rejected");
  assert.throws(() => parsePatchFileSet("diff --git a/a.py b/a.py\nweird header\n--- a/a.py\n", "p"), /LiveTalking 补丁 p 无法解析/, "an unknown extended header must be rejected");
  assert.throws(() => parsePatchFileSet("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\ndiff --git broken\n", "p"), /无法解析/, "a malformed later header must be rejected");

  // Property 161: notice tables rendered from a patch's file set parse back to the same set, and adding or removing
  // one path is reported as exactly that path.
  const random = prng(161);
  const operations = ["修改", "新增", "删除", "重命名"];
  for (let run = 0; run < 200; run += 1) {
    const count = 1 + Math.floor(random() * 8);
    const entries = Array.from({ length: count }, (_, index) => ({ path: `dir${Math.floor(random() * 3)}/file_${run}_${index}.py`, op: operations[Math.floor(random() * operations.length)] }));
    const parsed = parsePatchFileSet(patchText(entries));
    assert.deepEqual(parsed, entries.map(({ path: file, op }) => ({ path: file, op })), `run ${run}: parse must return the generated file set`);
    const patch = `runtime/patches/livetalking-p${run}.patch`;
    const withPatch = parsed.map((entry) => ({ patch, ...entry }));
    assert.deepEqual(parseNoticeFileSet(renderNoticeTables([{ patch, entries: parsed }])), withPatch, `run ${run}: rendered notice tables must parse back to the same set`);
    const extra = { patch, path: `extra/run_${run}.py`, op: operations[Math.floor(random() * operations.length)] };
    assert.deepEqual(diffFileSets(withPatch, [...withPatch, extra]), { missing: [], extra: [`${patch}:${extra.path}（${extra.op}）`] }, `run ${run}: an added path must be the only difference`);
    const removed = withPatch[Math.floor(random() * withPatch.length)];
    assert.deepEqual(diffFileSets(withPatch, withPatch.filter((entry) => entry !== removed)), { missing: [`${patch}:${removed.path}（${removed.op}）`], extra: [] }, `run ${run}: a removed path must be the only difference`);
  }
  assert.throws(() => parseNoticeFileSet("## runtime/patches/a.patch\n| 文件 | 操作 |\n| --- | --- |\n| a.py | 改写 |\n"), /a\.py 的操作“改写”无法识别/, "an unknown notice operation must be rejected");

  // verifyLiveTalkingNotice against a fixture repository layout (39.11, 39.15).
  const commit = "c".repeat(40);
  const repository = "https://example.invalid/LiveTalking.git";
  const lock = { schemaVersion: "2", components: [{ name: "LiveTalking", path: "vendor/LiveTalking", parent: ".", repository, commit, license: "Apache-2.0", images: ["livetalking"], role: "fixture" }] };
  const noticeSource = path.join(fixture, "notice");
  await mkdir(path.join(noticeSource, "runtime", "patches"), { recursive: true });
  await writeFile(path.join(noticeSource, "runtime", "patches", "livetalking.series"), "# fixture\nlivetalking-one.patch\nlivetalking-two.patch\n");
  await writeFile(path.join(noticeSource, "runtime", "patches", "livetalking-one.patch"), patchText([{ path: "a.py", op: "修改" }, { path: "b.py", op: "修改" }]));
  await writeFile(path.join(noticeSource, "runtime", "patches", "livetalking-two.patch"), patchText([{ path: "a.py", op: "修改" }, { path: "tts/none.py", op: "新增" }]));
  // A patch outside the series is not part of the notice.
  await writeFile(path.join(noticeSource, "runtime", "patches", "livetalking-unused.patch"), patchText([{ path: "unused.py", op: "修改" }]));
  const sections = [
    { patch: "runtime/patches/livetalking-one.patch", entries: [{ path: "a.py", op: "修改" }, { path: "b.py", op: "修改" }] },
    { patch: "runtime/patches/livetalking-two.patch", entries: [{ path: "a.py", op: "修改" }, { path: "tts/none.py", op: "新增" }] }
  ];
  const noticeText = ({ lockedCommit = commit, noticeLine = "- NOTICE：该锁定提交的根目录没有 NOTICE 文件。", tables = sections } = {}) => `# LiveTalking 修改声明\n- 上游仓库：${repository}\n- 被修改的锁定提交：${lockedCommit}\n${noticeLine}\n- 下列修改由 Shuzhiren 仓库作出。\n${renderNoticeTables(tables)}`;
  const writeNotice = (options) => writeFile(path.join(noticeSource, ...NOTICE_FILE.split("/")), noticeText(options));
  const verifyNotice = (hasNotice = false) => verifyLiveTalkingNotice({ sourceRoot: noticeSource, lock, hasLockedNotice: () => hasNotice });
  await writeNotice();
  assert.deepEqual(verifyNotice(), [], "a notice that matches the series must pass");
  const replaceEntries = (patchIndex, entries) => sections.map((section, index) => (index === patchIndex ? { ...section, entries } : section));

  await writeNotice({ tables: replaceEntries(0, [...sections[0].entries, { path: "c.py", op: "修改" }]) });
  assert.deepEqual(verifyNotice(), ["LiveTalking 修改声明与补丁不一致：声明多出 runtime/patches/livetalking-one.patch:c.py（修改）"], "one extra path must be reported once");
  await writeNotice({ tables: replaceEntries(0, [sections[0].entries[0]]) });
  assert.deepEqual(verifyNotice(), ["LiveTalking 修改声明与补丁不一致：声明缺少 runtime/patches/livetalking-one.patch:b.py（修改）"], "one missing path must be reported once");
  await writeNotice({ tables: replaceEntries(1, [sections[1].entries[0], { path: "tts/none.py", op: "修改" }]) });
  const wrongOperation = verifyNotice();
  assert.equal(wrongOperation.length, 1, `a wrong operation must be reported once:\n${wrongOperation.join("\n")}`);
  assert.match(wrongOperation[0], /声明缺少 runtime\/patches\/livetalking-two\.patch:tts\/none\.py（新增）；声明多出 runtime\/patches\/livetalking-two\.patch:tts\/none\.py（修改）$/);

  await writeNotice();
  assert.deepEqual(verifyNotice(true), ["LiveTalking 锁定提交 " + commit + " 有 NOTICE 文件，修改声明的 NOTICE 行必须写“NOTICE：已随镜像复制到 /app/NOTICE”"], "a NOTICE in the locked commit must be declared as shipped");
  await writeNotice({ noticeLine: "- NOTICE：已随镜像复制到 /app/NOTICE" });
  assert.deepEqual(verifyNotice(true), [], "a shipped NOTICE line matches a locked commit with NOTICE");
  assert.deepEqual(verifyNotice(false), ["LiveTalking 锁定提交 " + commit + " 没有 NOTICE 文件，修改声明的 NOTICE 行必须写“没有 NOTICE 文件”"], "a NOTICE line must not claim a NOTICE the commit does not have");
  await writeNotice({ lockedCommit: "d".repeat(40) });
  assert.deepEqual(verifyNotice(), [`LiveTalking 修改声明中被修改的锁定提交 ${"d".repeat(40)} 与锁文件中的 ${commit} 不一致`], "the declared commit must equal the lock");
  await writeNotice();
  await writeFile(path.join(noticeSource, "runtime", "patches", "livetalking-two.patch"), "garbage\n");
  assert.deepEqual(verifyNotice(), ["LiveTalking 补丁 runtime/patches/livetalking-two.patch 无法解析"], "an unparsable patch must be reported, not ignored");
  await rm(path.join(noticeSource, "runtime", "patches", "livetalking.series"));
  await writeFile(path.join(noticeSource, "runtime", "patches", "livetalking-two.patch"), patchText([{ path: "a.py", op: "修改" }, { path: "tts/none.py", op: "新增" }]));
  assert.deepEqual(patchSeriesFileSet(noticeSource).map(({ patch }) => patch).filter((value, index, all) => all.indexOf(value) === index), ["runtime/patches/livetalking-one.patch", "runtime/patches/livetalking-two.patch", "runtime/patches/livetalking-unused.patch"], "without a series file every livetalking-*.patch is used");

  // patchedHeaderProblems: apply a series to a fixture commit and read the result (39.10).
  const headerSource = path.join(fixture, "headers");
  const upstream = path.join(headerSource, "vendor", "LiveTalking");
  await mkdir(upstream, { recursive: true });
  git(upstream, "init", "-q");
  const tenLines = Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join("\n");
  await writeFile(path.join(upstream, "a.py"), `${tenLines}\n`);
  await writeFile(path.join(upstream, "b.py"), "b1\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-q", "-m", "fixture");
  const headerPatches = path.join(headerSource, "runtime", "patches");
  await mkdir(headerPatches, { recursive: true });
  await writeFile(path.join(headerPatches, "livetalking.series"), "livetalking-h.patch\n");
  const firstLine = `diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,1 +1,2 @@\n+${header}\n line1\n`;
  const eleventhLine = `diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -10,1 +10,2 @@\n line10\n+${header}\n`;
  const newFile = (lines) => `diff --git a/c.py b/c.py\nnew file mode 100644\n--- /dev/null\n+++ b/c.py\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
  const headers = async (patch, entries) => {
    await writeFile(path.join(headerPatches, "livetalking-h.patch"), patch);
    return patchedHeaderProblems({ sourceRoot: headerSource, entries });
  };
  assert.deepEqual(await headers(firstLine, [{ path: "a.py", op: "修改" }]), [], "a header on line 1 passes");
  assert.deepEqual(await headers(eleventhLine, [{ path: "a.py", op: "修改" }]), [`LiveTalking 文件 a.py 前 10 行没有修改声明注释“${HEADER_COMMENT}”`], "a header on line 11 is rejected");
  assert.deepEqual(await headers(`diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -1,1 +1,2 @@\n b1\n+b2\n`, [{ path: "b.py", op: "修改" }]), [`LiveTalking 文件 b.py 前 10 行没有修改声明注释“${HEADER_COMMENT}”`], "a modified file without header is rejected");
  assert.deepEqual(await headers(newFile([header, added, "x = 1"]), [{ path: "c.py", op: "新增" }]), [], "an added file with both comments passes");
  assert.deepEqual(await headers(newFile([header, "x = 1"]), [{ path: "c.py", op: "新增" }]), [`LiveTalking 文件 c.py 前 10 行没有新增文件说明“${ADDED_COMMENT}”`], "an added file must say it is new");
  const broken = await headers(`diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,1 +1,2 @@\n+${header}\n not-in-file\n`, [{ path: "a.py", op: "修改" }]);
  assert.equal(broken.length, 1);
  assert.match(broken[0], /^LiveTalking 补丁 livetalking-h\.patch 无法应用到锁定提交 [0-9a-f]{40}：/, "a patch that does not apply is reported");
  assert.equal(git(upstream, "status", "--porcelain"), "", "the fixture checkout and index must not change");

  // dockerignoreLicenseProblems: a context that drops a copied component's LICENSE is rejected (39.13).
  const ignoreSource = path.join(fixture, "ignore");
  await mkdir(path.join(ignoreSource, "runtime", "img"), { recursive: true });
  const ignoreLock = { components: [{ name: "A", path: "vendor/A", images: ["img"] }, { name: "B", path: "vendor/A/third_party/B", images: ["img"] }, { name: "C", path: "vendor/C", images: [] }] };
  const ignoreProblems = async (text, hasNotice = false) => {
    await writeFile(path.join(ignoreSource, "runtime", "img", "Dockerfile.dockerignore"), text);
    return dockerignoreLicenseProblems({ sourceRoot: ignoreSource, lock: ignoreLock, hasLockedFile: () => hasNotice });
  };
  assert.deepEqual(await ignoreProblems("*\n!vendor/A/**\n**/.git\n"), [], "a context that keeps both LICENSE files passes");
  assert.deepEqual(await ignoreProblems("*\n!vendor/A/**\n**/LICENSE\n"), ["runtime/img/Dockerfile.dockerignore 把 vendor/A/LICENSE 排除在镜像构建上下文之外", "runtime/img/Dockerfile.dockerignore 把 vendor/A/third_party/B/LICENSE 排除在镜像构建上下文之外"], "an excluded LICENSE is reported per component");
  assert.deepEqual(await ignoreProblems("*\n!vendor/A/**\nvendor/A/third_party/**\n"), ["runtime/img/Dockerfile.dockerignore 把 vendor/A/third_party/B/LICENSE 排除在镜像构建上下文之外"], "the nested component's LICENSE is checked");
  assert.deepEqual(await ignoreProblems("*\n!vendor/A/**\n**/NOTICE\n", true), ["runtime/img/Dockerfile.dockerignore 把 vendor/A/NOTICE 排除在镜像构建上下文之外", "runtime/img/Dockerfile.dockerignore 把 vendor/A/third_party/B/NOTICE 排除在镜像构建上下文之外"], "an existing NOTICE must stay in the context");

  // checkImageLicenseFiles with in-memory image, lock and repository readers (39.10, 39.12-39.14).
  const imageLock = { components: [
    { name: "LiveTalking", path: "vendor/LiveTalking", commit: "1".repeat(40), images: ["livetalking"] },
    { name: "CosyVoice", path: "vendor/CosyVoice", commit: "2".repeat(40), images: ["cosyvoice"] },
    { name: "Matcha-TTS", path: "vendor/CosyVoice/third_party/Matcha-TTS", commit: "3".repeat(40), images: ["cosyvoice"] },
    { name: "MuseTalk", path: "vendor/MuseTalk", commit: "4".repeat(40), images: [] }
  ] };
  const locked = new Map([["LiveTalking:LICENSE", "Apache LiveTalking\n"], ["CosyVoice:LICENSE", "Apache CosyVoice\n"], ["Matcha-TTS:LICENSE", "MIT Matcha\n"]]);
  const noticeBytes = Buffer.from("# LiveTalking 修改声明\n");
  const imageNotice = [{ path: "a.py", op: "修改" }, { path: "tts/none_tts.py", op: "新增" }, { path: "gone.py", op: "删除" }];
  const goodFiles = () => new Map([
    ["lt:/app/LICENSE", "Apache LiveTalking\n"], [`lt:${IMAGE_NOTICE_FILE}`, noticeBytes], ["lt:/app/a.py", `${header}\nimport os\n`], ["lt:/app/tts/none_tts.py", `${header}\n${added}\n`],
    ["cv:/opt/CosyVoice/CosyVoice/LICENSE", "Apache CosyVoice\n"], ["cv:/opt/CosyVoice/CosyVoice/third_party/Matcha-TTS/LICENSE", "MIT Matcha\n"]
  ]);
  const imageCheck = (files, lockedFiles = locked, images = { livetalking: "lt", cosyvoice: "cv" }) => checkImageLicenseFiles({
    lock: imageLock,
    notice: imageNotice,
    images,
    readImageFile: (image, file) => {
      if (!files.has(`${image}:${file}`)) throw new Error(`cat: ${file}: No such file or directory`);
      return Buffer.from(files.get(`${image}:${file}`));
    },
    readLockedFile: (component, file) => (lockedFiles.has(`${component.name}:${file}`) ? Buffer.from(lockedFiles.get(`${component.name}:${file}`)) : null),
    readRepoFile: (file) => {
      assert.equal(file, NOTICE_FILE);
      return noticeBytes;
    }
  });
  assert.deepEqual(imageCheck(goodFiles()), [], "images whose files match pass");
  assert.deepEqual(imageCheck(goodFiles(), locked, { cosyvoice: "cv" }), [], "only the given image is checked");
  const oneByte = goodFiles();
  oneByte.set("cv:/opt/CosyVoice/CosyVoice/third_party/Matcha-TTS/LICENSE", "MIT Matcha!\n");
  assert.deepEqual(imageCheck(oneByte), ["IMAGE-FILE cv /opt/CosyVoice/CosyVoice/third_party/Matcha-TTS/LICENSE 与 Matcha-TTS 锁定提交 3333333333333333333333333333333333333333 中的 LICENSE 不一致（镜像 12 字节，期望 11 字节）"], "a LICENSE that differs by one byte is reported");
  const missing = goodFiles();
  missing.delete("lt:/app/LICENSE");
  assert.deepEqual(imageCheck(missing), ["IMAGE-FILE lt /app/LICENSE 镜像中缺少该文件（cat: /app/LICENSE: No such file or directory）"], "a missing image file is reported");
  const noNotice = goodFiles();
  noNotice.delete(`lt:${IMAGE_NOTICE_FILE}`);
  assert.deepEqual(imageCheck(noNotice), [`IMAGE-FILE lt ${IMAGE_NOTICE_FILE} 镜像中缺少该文件（cat: ${IMAGE_NOTICE_FILE}: No such file or directory）`], "a missing modification notice is reported");
  const staleNotice = goodFiles();
  staleNotice.set(`lt:${IMAGE_NOTICE_FILE}`, "# old\n");
  assert.match(imageCheck(staleNotice).join("\n"), /^IMAGE-FILE lt \/app\/LIVETALKING_MODIFICATIONS\.md 与仓库中的 runtime\/patches\/LIVETALKING_MODIFICATIONS\.md 不一致/, "a stale notice in the image is reported");
  const lateHeader = goodFiles();
  lateHeader.set("lt:/app/a.py", `${Array.from({ length: 10 }, () => "pass").join("\n")}\n${header}\n`);
  assert.deepEqual(imageCheck(lateHeader), [`IMAGE-FILE lt /app/a.py 前 10 行没有修改声明注释“${HEADER_COMMENT}”`], "a header comment on line 11 is reported");
  const withNotice = new Map([...locked, ["CosyVoice:NOTICE", "CosyVoice NOTICE\n"]]);
  assert.deepEqual(imageCheck(goodFiles(), withNotice), ["IMAGE-FILE cv /opt/CosyVoice/CosyVoice/NOTICE 镜像中缺少该文件（cat: /opt/CosyVoice/CosyVoice/NOTICE: No such file or directory）"], "a NOTICE of the locked commit must be in the image");
  const shippedNotice = goodFiles();
  shippedNotice.set("cv:/opt/CosyVoice/CosyVoice/NOTICE", "CosyVoice NOTICE\n");
  assert.deepEqual(imageCheck(shippedNotice, withNotice), [], "a shipped NOTICE passes");
  assert.deepEqual(checkImageLicenseFiles({ lock: { components: [{ name: "Other", path: "vendor/Other", commit: "5".repeat(40), images: ["x"] }] }, notice: [], images: { livetalking: "lt" }, readImageFile: () => Buffer.alloc(0), readLockedFile: () => null, readRepoFile: () => Buffer.alloc(0) }), ["IMAGE-FILE - vendor/Other 锁条目 Other 没有登记镜像内源码路径（IMAGE_SOURCE_ROOTS）"], "an image component without a known image path is reported");

  // Distribution packages installed for their content (the AIGC label font) are declared with their license.
  assert.deepEqual(aptInstalledPackages("# apt-get install commented\nRUN apt-get update && apt-get install -y --no-install-recommends python3 \\\n  fonts-noto-cjk git && rm -rf /x\n"), ["python3", "fonts-noto-cjk", "git"]);
  const packageSource = path.join(fixture, "packages");
  await mkdir(path.join(packageSource, "runtime", "livetalking"), { recursive: true });
  const writePackageFixture = async (dockerfile, notices) => {
    await writeFile(path.join(packageSource, "runtime", "livetalking", "Dockerfile"), dockerfile);
    await writeFile(path.join(packageSource, "THIRD_PARTY_NOTICES.md"), notices);
  };
  const fontRow = "| `fonts-noto-cjk` | livetalking | SIL Open Font License 1.1 |\n";
  await writePackageFixture("RUN apt-get install -y fonts-noto-cjk\n", fontRow);
  assert.deepEqual(systemPackageNoticeProblems({ sourceRoot: packageSource }), [], "an installed and declared font package passes");
  await writePackageFixture("RUN apt-get install -y git\n", "");
  assert.deepEqual(systemPackageNoticeProblems({ sourceRoot: packageSource }), ["runtime/livetalking/Dockerfile 没有安装已登记的系统软件包 fonts-noto-cjk", "THIRD_PARTY_NOTICES.md 没有声明 livetalking 镜像安装的 fonts-noto-cjk"], "a missing font package and a missing declaration are reported");
  await writePackageFixture("RUN apt-get install -y fonts-noto-cjk fonts-wqy-zenhei\n", "| `fonts-noto-cjk` | livetalking | OFL |\n");
  assert.deepEqual(systemPackageNoticeProblems({ sourceRoot: packageSource }), ["THIRD_PARTY_NOTICES.md 中 fonts-noto-cjk 的许可证必须写明“SIL Open Font License 1.1”", "runtime/livetalking/Dockerfile 安装的字体包 fonts-wqy-zenhei 没有登记许可证（IMAGE_SYSTEM_PACKAGES 与 THIRD_PARTY_NOTICES.md）"], "a wrong license and an unregistered font package are reported");
  const copyright = "/usr/share/doc/fonts-noto-cjk/copyright";
  const packageImage = (text) => checkImageSystemPackages({ images: { livetalking: "lt" }, readImageFile: (image, file) => { if (text === null || file !== copyright) throw new Error(`cat: ${file}: No such file or directory`); return Buffer.from(text); } });
  assert.deepEqual(packageImage("Files: *\nLicense: OFL-1.1\n SIL OPEN FONT LICENSE Version 1.1\n"), [], "an image with the font's copyright file passes");
  assert.deepEqual(packageImage(null), [`IMAGE-FILE lt ${copyright} 镜像中缺少 fonts-noto-cjk 的版权文件（cat: ${copyright}: No such file or directory）`]);
  assert.deepEqual(packageImage("License: GPL\n"), [`IMAGE-FILE lt ${copyright} 没有写明 SIL Open Font License 1.1`]);
  assert.deepEqual(checkImageSystemPackages({ images: { cosyvoice: "cv" }, readImageFile: () => { throw new Error("not read"); } }), [], "only the given image is checked");
  assert.deepEqual(systemPackageNoticeProblems({ sourceRoot: root }), [], "the repository declares every registered image package");

  // CLI: no mode is a usage error.
  const cli = path.join(root, "scripts", "check-runtime-image-licenses.mjs");
  const noArgs = spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8" });
  assert.equal(noArgs.status, 2, `no arguments must exit 2:\n${noArgs.stderr}`);
  assert.equal(spawnSync(process.execPath, [cli, "--livetalking-image"], { cwd: root, encoding: "utf8" }).status, 2, "an option without a value must exit 2");

  // The repository itself: notice, series, headers, Dockerfile and build contexts agree.
  const repositoryLock = JSON.parse(await readFile(path.join(root, "runtime", "open-source.lock.json"), "utf8"));
  assert.deepEqual(verifyLiveTalkingNotice({ sourceRoot: root, lock: repositoryLock }), [], "the repository's LiveTalking notice must match its patches");
  const repositoryNotice = parseNoticeFileSet(await readFile(path.join(root, ...NOTICE_FILE.split("/")), "utf8"));
  assert.deepEqual(patchedHeaderProblems({ sourceRoot: root, entries: repositoryNotice }), [], "every modified or added LiveTalking file must carry the header comment");
  assert.deepEqual(dockerfileNoticeProblems(root), [], "the LiveTalking Dockerfile must copy the notice");
  assert.deepEqual(dockerignoreLicenseProblems({ sourceRoot: root, lock: repositoryLock }), [], "no build context may drop a copied component's LICENSE");
  const staticRun = spawnSync(process.execPath, [cli, "--static"], { cwd: root, encoding: "utf8" });
  assert.equal(staticRun.status, 0, `the static gate must pass on the repository:\n${staticRun.stderr}`);
  assert.equal(git(path.join(root, "vendor", "LiveTalking"), "status", "--porcelain"), vendorStatusBefore, "vendor/LiveTalking must not change");
  console.log("PASS  runtime image licenses: notice tables round-trip the patch file sets (Property 161, 200 runs), notice/lock/NOTICE mismatches, header comments after the series, build-context LICENSE files and image LICENSE/NOTICE/notice bytes are checked");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
