// Applies runtime/patches/livetalking.series in order to the locked commit of
// vendor/LiveTalking, the way runtime/livetalking/Dockerfile does, without
// touching the submodule work tree or its real index: the patches go into a
// throw-away index (GIT_INDEX_FILE) built from HEAD, so the result is also
// independent of Windows CRLF checkouts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function readSeries(seriesFile) {
  return readFileSync(seriesFile, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function firstLine(error) {
  const text = `${error?.stderr ?? ""}`.trim() || (error instanceof Error ? error.message : String(error));
  return text.split(/\r?\n/).find((line) => line.trim() && !/^warning:/.test(line)) ?? text.split(/\r?\n/)[0];
}

/**
 * @param {{ sourceDir: string, seriesFile: string, checkoutTo?: string, paths?: string[] }} options
 *   checkoutTo/paths: when every patch applies, write these patched paths below checkoutTo.
 * @returns {{ commit: string, patches: string[], failures: Array<{ patch: string, message: string }> }}
 */
export function checkPatchSeries({ sourceDir, seriesFile, checkoutTo, paths = [] }) {
  const patches = readSeries(seriesFile);
  const temporary = mkdtempSync(path.join(os.tmpdir(), "livetalking-series-"));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, "index") };
  const git = (args) => execFileSync("git", ["-C", sourceDir, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const failures = [];
  let commit = "";
  try {
    commit = git(["rev-parse", "HEAD"]).trim();
    git(["read-tree", "HEAD"]);
    for (const patch of patches) {
      const file = path.resolve(path.dirname(seriesFile), patch);
      try {
        git(["apply", "--cached", "--check", "--recount", file]);
        git(["apply", "--cached", "--recount", file]);
      } catch (error) {
        failures.push({ patch, message: firstLine(error) });
        break;
      }
    }
    if (checkoutTo && failures.length === 0 && paths.length > 0) {
      git(["checkout-index", "--force", `--prefix=${path.resolve(checkoutTo).replaceAll("\\", "/")}/`, "--", ...paths]);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return { commit, patches, failures };
}
