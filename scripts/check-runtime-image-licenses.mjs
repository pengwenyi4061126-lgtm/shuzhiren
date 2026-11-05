// Runtime image license gate (Requirement 39.10-39.14; audit L18).
//
// Usage: node scripts/check-runtime-image-licenses.mjs [--static] [--livetalking-image <ref>] [--cosyvoice-image <ref>]
//   --static             repository checks that need no Docker: runtime/patches/LIVETALKING_MODIFICATIONS.md matches
//                        the lock and the patch series, every modified or added LiveTalking file carries the header
//                        comment after the series is applied to the locked commit (throw-away index), the
//                        LiveTalking Dockerfile copies the notice into the image, and no Dockerfile.dockerignore
//                        drops a copied component's LICENSE or NOTICE.
//   --livetalking-image  reads /app/LICENSE, /app/LIVETALKING_MODIFICATIONS.md and the patched files from the image.
//   --cosyvoice-image    reads the CosyVoice and Matcha-TTS LICENSE files from the image.
// Image files are read with `docker run --rm --entrypoint cat <image> <path>` and compared byte for byte with
// `git cat-file blob <commit>:LICENSE` of each locked component and with the repository's notice file. CI runs the
// LiveTalking image check before reclaiming disk and the CosyVoice image check after its build (cross-part ruling 25).
// Exit codes: 0 pass; 1 one `IMAGE-FILE <image> <path> <reason>` or `ERROR <message>` line per problem;
// 2 usage error (no mode given, or an option without a value).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkImageLicenseFiles, dockerfileNoticeProblems, dockerignoreLicenseProblems, lockedFile, NOTICE_FILE, parseNoticeFileSet, patchedHeaderProblems, verifyLiveTalkingNotice
} from "./lib/runtime-image-licenses.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const usage = "usage: node scripts/check-runtime-image-licenses.mjs [--static] [--livetalking-image <ref>] [--cosyvoice-image <ref>]（至少给出一项）";
const options = { static: false, livetalking: undefined, cosyvoice: undefined, sourceRoot: root };
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const value = () => {
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) { console.error(`ERROR ${arg} 需要一个值\n${usage}`); process.exit(2); }
    index += 1;
    return next;
  };
  if (arg === "--static") options.static = true;
  else if (arg === "--livetalking-image") options.livetalking = value();
  else if (arg === "--cosyvoice-image") options.cosyvoice = value();
  else if (arg === "--source-root") options.sourceRoot = path.resolve(value());
  else { console.error(`ERROR 未知参数 ${arg}\n${usage}`); process.exit(2); }
}
if (!options.static && !options.livetalking && !options.cosyvoice) {
  console.error(usage);
  process.exit(2);
}

const { sourceRoot } = options;
const problems = [];
let lock;
let notice = [];
try {
  lock = JSON.parse(readFileSync(path.join(sourceRoot, "runtime", "open-source.lock.json"), "utf8"));
} catch (error) {
  problems.push(`ERROR runtime/open-source.lock.json 无法读取：${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
}
try {
  notice = parseNoticeFileSet(readFileSync(path.join(sourceRoot, ...NOTICE_FILE.split("/")), "utf8"));
} catch (error) {
  problems.push(`ERROR ${NOTICE_FILE} 无法读取或解析：${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
}

if (lock && options.static) {
  const messages = [
    ...verifyLiveTalkingNotice({ sourceRoot, lock }),
    ...patchedHeaderProblems({ sourceRoot, entries: notice }),
    ...dockerfileNoticeProblems(sourceRoot),
    ...dockerignoreLicenseProblems({ sourceRoot, lock })
  ];
  problems.push(...messages.map((message) => `ERROR ${message}`));
}

if (lock && (options.livetalking || options.cosyvoice)) {
  const readImageFile = (image, file) => execFileSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "cat", image, file], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
  problems.push(...checkImageLicenseFiles({
    lock,
    notice,
    images: { livetalking: options.livetalking, cosyvoice: options.cosyvoice },
    readImageFile,
    readLockedFile: (component, file) => lockedFile(sourceRoot, component, file),
    readRepoFile: (file) => readFileSync(path.join(sourceRoot, ...file.split("/")))
  }));
}

if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} else {
  if (options.static) console.log("PASS  static: the LiveTalking modification notice matches the lock and the patch series, every patched file carries its header comment, the Dockerfile copies the notice and no build context drops a LICENSE");
  for (const image of [options.livetalking, options.cosyvoice].filter(Boolean)) console.log(`PASS  image ${image}: LICENSE (and NOTICE) files match the locked commits${image === options.livetalking ? ", the modification notice matches the repository and every patched file carries its header comment" : ""}`);
}
