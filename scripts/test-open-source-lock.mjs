// Behavioral tests for scripts/lib/open-source-lock.mjs (Requirement 39.1-39.8; audit L17). Builds throw-away Git
// fixtures: a parent repository records vendor/A as a gitlink, vendor/A is its own repository and records the
// nested third_party/B as a gitlink, and runtime/img/Dockerfile copies vendor/A. Run by deploy:check:test.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkTemplateRefVariables, deprecatedRefVariables, verifyOpenSourceLock } from "./lib/open-source-lock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const identity = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const git = (directory, ...args) => execFileSync("git", [...identity, "-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function repository(directory, files) {
  await mkdir(directory, { recursive: true });
  git(directory, "init", "-q");
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(directory, name), text);
  git(directory, "add", ".");
  git(directory, "commit", "-q", "-m", "fixture");
  return git(directory, "rev-parse", "HEAD");
}
function gitlink(directory, sha, relative) {
  git(directory, "update-index", "--add", "--cacheinfo", `160000,${sha},${relative}`);
  git(directory, "commit", "-q", "-m", `record ${relative}`);
  return git(directory, "rev-parse", "HEAD");
}

const fixture = await mkdtemp(path.join(os.tmpdir(), "shuzhiren-open-source-lock-"));
try {
  const sourceRoot = path.join(fixture, "source");
  const a = path.join(sourceRoot, "vendor", "A");
  const b = path.join(a, "third_party", "B");
  await repository(sourceRoot, { "README.md": "parent\n" });
  await repository(a, { "LICENSE": "Apache-2.0\n", ".gitmodules": "[submodule \"third_party/B\"]\n\tpath = third_party/B\n\turl = https://example.invalid/B.git\n" });
  const bCommit = await repository(b, { "LICENSE": "MIT\n" });
  const aCommit = gitlink(a, bCommit, "third_party/B");
  gitlink(sourceRoot, aCommit, "vendor/A");
  await mkdir(path.join(sourceRoot, "runtime", "img"), { recursive: true });
  await writeFile(path.join(sourceRoot, "runtime", "img", "Dockerfile"), "FROM scratch\nCOPY vendor/A /opt/A\n");

  const entries = {
    A: { name: "A", path: "vendor/A", parent: ".", repository: "https://example.invalid/A.git", commit: aCommit, license: "Apache-2.0", images: ["img"], role: "fixture parent" },
    B: { name: "B", path: "vendor/A/third_party/B", parent: "vendor/A", repository: "https://example.invalid/B.git", commit: bCommit, license: "MIT", images: ["img"], role: "fixture nested dependency" }
  };
  const entry = (name, overrides = {}) => ({ ...entries[name], ...overrides });
  const lock = (...components) => ({ schemaVersion: "2", components });
  const verify = (value) => verifyOpenSourceLock({ sourceRoot, lock: value });

  // A lock with only the components that exist is valid; MuseTalk is no longer a required name.
  assert.deepEqual(verify(lock(entry("A"), entry("B"))), [], "a lock that matches every HEAD and gitlink must pass");

  // Field rules.
  assert.match(verify({ components: [entry("A"), entry("B")] }).join("\n"), /schemaVersion 必须是 "2"/, "a lock without schemaVersion 2 must be rejected");
  assert.match(verify(lock(entry("A", { license: "Apache-2.0 (已审查)" }), entry("B"))).join("\n"), /^A 的 license 不得写审查或合规结论/m, "a review conclusion in license must be rejected");
  assert.match(verify(lock(entry("A"), entry("B", { role: "compliant dependency" }))).join("\n"), /^B 的 role 不得写审查或合规结论/m, "a review conclusion in role must be rejected");
  assert.match(verify(lock(entry("A", { images: "img" }), entry("B"))).join("\n"), /^A 的 images 必须是镜像 target 名称数组/m, "images must be an array");
  assert.match(verify(lock(entry("A", { commit: aCommit.toUpperCase() }), entry("B"))).join("\n"), /^A 没有固定 40 位小写 Git 提交/m, "an upper-case commit must be rejected");
  assert.match(verify(lock(entry("A", { path: "vendor/../A" }), entry("B"))).join("\n"), /^A 的 path 必须是仓库内的相对路径/m, "a path that leaves the repository must be rejected");
  assert.match(verify(lock(entry("A"), entry("B", { parent: "vendor/Other" }))).join("\n"), /^B 的 path 必须位于 parent vendor\/Other 之内/m, "a path outside its parent must be rejected");

  // The nested component's HEAD and its parent's gitlink are both compared with the lock.
  const other = "f".repeat(40);
  const nestedMismatch = verify(lock(entry("A"), entry("B", { commit: other })));
  assert.ok(nestedMismatch.includes(`B 源码 HEAD ${bCommit} 与锁定提交 ${other} 不一致`), `a nested HEAD mismatch must name B:\n${nestedMismatch.join("\n")}`);
  assert.ok(nestedMismatch.includes(`B 父仓库 vendor/A 记录的子模块提交 ${bCommit} 与锁定提交 ${other} 不一致`), "a nested gitlink mismatch must name B and its parent");

  // Copied sources need a lock entry that lists the image: vendor/A and the nested B from A's .gitmodules.
  assert.ok(verify(lock(entry("A"))).includes("vendor/A/third_party/B 被 runtime/img/Dockerfile 复制进镜像，但开源运行时锁文件没有该路径的条目"), "a copied nested submodule without a lock entry must be rejected");
  assert.ok(verify(lock(entry("A"), entry("B", { images: [] }))).includes("B 被 runtime/img/Dockerfile 复制进镜像，但锁条目的 images 没有列出 img"), "a copied component whose images omit the image must be rejected");

  // Uncommitted changes in a component are rejected.
  await writeFile(path.join(a, "untracked.txt"), "dirty\n");
  assert.ok(verify(lock(entry("A"), entry("B"))).includes("A 源码目录存在未提交修改，禁止用于生产镜像构建"), "a dirty component must be rejected");
  await rm(path.join(a, "untracked.txt"));

  // An uninitialized nested submodule (a plain directory) must not be read through the parent's HEAD.
  const c = path.join(a, "third_party", "C");
  await mkdir(c, { recursive: true });
  await writeFile(path.join(c, "file.txt"), "not a repository\n");
  const plain = verify(lock({ name: "C", path: "vendor/A/third_party/C", parent: "vendor/A", repository: "https://example.invalid/C.git", commit: aCommit, license: "MIT", images: [], role: "fixture plain directory" }));
  assert.match(plain.join("\n"), /^C 源码目录无法读取 Git 信息/m, `a plain directory must be reported as unreadable:\n${plain.join("\n")}`);
  assert.ok(!plain.some((message) => message.startsWith("C 源码 HEAD")), "the parent's HEAD must not be compared as C's HEAD");
  await rm(c, { recursive: true, force: true });

  // The parent's gitlink is checked even when the component's HEAD matches the lock.
  await writeFile(path.join(b, "NEW.txt"), "moved\n");
  git(b, "add", "NEW.txt");
  git(b, "commit", "-q", "-m", "move B");
  const movedB = git(b, "rev-parse", "HEAD");
  const moved = verify(lock(entry("A"), entry("B", { commit: movedB })));
  assert.ok(moved.includes(`B 父仓库 vendor/A 记录的子模块提交 ${bCommit} 与锁定提交 ${movedB} 不一致`), `a stale parent gitlink must be rejected:\n${moved.join("\n")}`);
  assert.ok(!moved.some((message) => message.startsWith("B 源码 HEAD")), "B's HEAD matches the lock in this case");

  // *_REF template variables: a variable without a reader needs the explaining comment.
  const noReader = () => false;
  assert.deepEqual(checkTemplateRefVariables({ sourceRoot, templates: [{ file: "config/x.example.env", text: "A=1\nFOO_REF=replace-with-commit-sha\n" }], isReferenced: noReader }), ["config/x.example.env 的 FOO_REF 没有读取方；删除它，或在紧邻的注释中说明只由 deploy:check 核对、不会改变镜像"], "an unread *_REF variable must be rejected");
  assert.deepEqual(checkTemplateRefVariables({ sourceRoot, templates: [{ file: "config/x.example.env", text: "# 仅供 deploy:check 核对，不会改变镜像。\nFOO_REF=replace-with-commit-sha\n" }], isReferenced: noReader }), [], "a commented *_REF variable is allowed");
  assert.equal(checkTemplateRefVariables({ sourceRoot, templates: [{ file: "config/x.example.env", text: "# 仅供 deploy:check 核对，不会改变镜像。\n\nFOO_REF=x\n" }], isReferenced: noReader }).length, 1, "the comment must be directly above the variable");
  assert.deepEqual(checkTemplateRefVariables({ sourceRoot, templates: [{ file: "config/x.example.env", text: "FOO_REF=x\n" }], isReferenced: () => true }), [], "a *_REF variable with a reader is allowed");
  assert.deepEqual(deprecatedRefVariables(new Map([["LIVETALKING_REF", "x"], ["OTHER", "y"]])), ["LIVETALKING_REF"]);

  // The repository itself: the lock matches every submodule, and no template keeps an unread *_REF variable.
  const repositoryLock = JSON.parse(await readFile(path.join(root, "runtime", "open-source.lock.json"), "utf8"));
  assert.deepEqual(verifyOpenSourceLock({ sourceRoot: root, lock: repositoryLock }), [], "runtime/open-source.lock.json must match the repository's submodules");
  assert.ok(repositoryLock.components.some((component) => component.name === "Matcha-TTS" && component.parent === "vendor/CosyVoice"), "the lock must record the nested Matcha-TTS submodule");
  const configDirectory = path.join(root, "config");
  const templates = await Promise.all((await readdir(configDirectory)).filter((name) => name.endsWith(".example.env")).map(async (name) => ({ file: `config/${name}`, text: await readFile(path.join(configDirectory, name), "utf8") })));
  assert.deepEqual(checkTemplateRefVariables({ sourceRoot: root, templates }), [], "config/*.example.env must not keep *_REF variables without a reader");
  assert.ok(templates.every(({ text }) => !/^(LIVETALKING|MUSETALK|COSYVOICE)_REF=/m.test(text)), "the deprecated *_REF variables must be removed from the templates");
  console.log("PASS  open-source lock checks each component's HEAD, parent gitlink, clean tree and image coverage; *_REF template variables need a reader");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
