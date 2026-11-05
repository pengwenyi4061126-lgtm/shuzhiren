// Schema and checks of docs/VERIFICATION_LOG.md, the Verification_Report
// (design part 1 §1.3.4, §4.1-4.5, §6.1; part 8 §2.1; Requirement 1.12, 1.14,
// 1.15, 4.1-4.8, 6.8, 36.13, 36.14).
//
// Entry format: a `## V-YYYYMMDD-NN <结论摘要>` heading followed, after optional
// blank lines, by exactly one ```yaml fenced block. The block is parsed with
// js-yaml's FAILSAFE_SCHEMA, so every scalar is a string ("0", "41869137741").
// A ```yaml block anywhere else is an error; other fenced blocks (```text) and
// the headings inside them are ignored.
//
// parseVerificationLog, inspectSource, classifyConclusion, validateEntry,
// validateVerificationLog, parseCommitMessage, validateCommitMessage,
// scanSecrets and createCheckResolver do no I/O. loadStaticGateCoverage reads
// git objects and the working tree.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { CHECK_LABELS, covers, describeCommand, LOCAL_CHECKS } from "../verify-local-checks.mjs";
import { CI_ONLY_STEPS } from "../ci-required-steps.mjs";
import { IMAGE_NOT_COLLECTED } from "../collect-ci-run-evidence.mjs";
import { commands, jobs, normalizeNewlines, steps } from "./workflow-model.mjs";

export const VERDICTS = Object.freeze(["行为验证", "静态检查", "未验证"]);
export const SOURCE_CATEGORIES = Object.freeze(["本机运行", "CI 或 Linux 运行", "需外部环境"]);
export const PLATFORMS = Object.freeze(["GitHub Actions", "Linux"]);
export const CHANGE_KINDS = Object.freeze(["删除", "跳过", "放宽", "加强", "移动"]);
/** Commit placeholder that is valid only inside a commit message (design part 1 §4.1). */
export const THIS_COMMIT = "本提交";
/** Value written by ci:evidence:collect when it could not read the runner image; never valid evidence. */
export const NOT_TRANSCRIBED = IMAGE_NOT_COLLECTED;
export const NONE = "无";
export const STATIC_GATE_COVERAGE_PATH = "scripts/static-gate-coverage.mjs";
export const DEFAULT_LOG_FILE = "docs/VERIFICATION_LOG.md";

/** Secret patterns of design part 1 §6.1 (Requirement 6.8). Reports name the pattern id, never the matched text. */
export const SECRET_PATTERNS = Object.freeze([
  Object.freeze({ id: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }),
  Object.freeze({ id: "stream-key", pattern: /STREAM_KEY\s*[=:]\s*(?!replace-)\S/ }),
  Object.freeze({ id: "rtmp-url", pattern: /rtmps?:\/\/(?!replace-with-)\S+\/\S+/ }),
  Object.freeze({ id: "registry-or-oauth-credential", pattern: /(REGISTRY_PASSWORD|REGISTRY_USERNAME|client_secret)\s*[=:]\s*\S/ }),
  Object.freeze({ id: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{36}/ }),
  Object.freeze({ id: "github-fine-grained-token", pattern: /github_pat_/ })
]);

const ENTRY_ID = /^V-(\d{4})(\d{2})(\d{2})-(\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHORT_OR_FULL_COMMIT = /^[0-9a-f]{7,40}$/;
const FULL_COMMIT = /^[0-9a-f]{40}$/;
const DIGITS = /^\d+$/;
const EXIT_CODE = /^-?\d+$/;
const STATIC_GATE_SCRIPT = /^node scripts\/check-[^\s/]+\.mjs(?:\s|$)/;
/** Fields every entry needs, whatever its type (design part 1 §4.3). */
export const COMMON_ENTRY_FIELDS = Object.freeze(["编号", "类型", "结论", "判定", "依据来源"]);

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";
const collapse = (text) => String(text).replace(/\s+/g, " ").trim();
const quoted = (value) => JSON.stringify(value);

function isCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** True for `YYYY-MM-DD` naming a real calendar date. */
export function isValidDate(value) {
  const match = typeof value === "string" ? DATE.exec(value) : null;
  return Boolean(match) && isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** True for `V-YYYYMMDD-NN` whose date part is a real calendar date. */
export function isEntryId(value) {
  const match = typeof value === "string" ? ENTRY_ID.exec(value) : null;
  return Boolean(match) && isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function problemCollector(prefix = "") {
  const problems = [];
  const join = (field) => (prefix && field ? `${prefix}.${field}` : prefix || field);
  return {
    problems,
    report(field, message, code = "VLOG") {
      problems.push({ field: join(field), message, code });
    },
    /** Reports a missing or blank text field; returns true when the field is usable. */
    text(object, field, missing = "缺少字段") {
      const value = object?.[field];
      if (value === null || value === undefined) {
        problems.push({ field: join(field), message: missing, code: "VLOG" });
        return false;
      }
      if (!isText(value)) {
        problems.push({ field: join(field), message: "必须是非空文本", code: "VLOG" });
        return false;
      }
      return true;
    }
  };
}

function checkCommit(value, field, collector, { allowThisCommit = false, full = false } = {}) {
  if (value === null || value === undefined) {
    collector.report(field, "缺少字段");
    return false;
  }
  if (value === THIS_COMMIT) {
    if (allowThisCommit) return true;
    collector.report(field, `"${THIS_COMMIT}" 只能写在提交说明中；VERIFICATION_LOG 必须写提交 SHA`);
    return false;
  }
  if (typeof value !== "string" || !(full ? FULL_COMMIT : SHORT_OR_FULL_COMMIT).test(value)) {
    collector.report(field, full ? "必须是 40 位小写十六进制提交 SHA" : "必须是 7 至 40 位小写十六进制提交 SHA");
    return false;
  }
  return true;
}

/**
 * Maps check and step names of a Verification_Report to the Local_Verification
 * list (LOCAL_CHECKS) and the CI-only list (CI_ONLY_STEPS), which hold the
 * static/behavioral labels (Requirement 36.13; design part 8 §2.1).
 *   resolveName(name, job?)   a check id (`ci:workflow:check`), a RUN-line command
 *                              (`npm run ci:workflow:check`), a CI_ONLY_STEPS command,
 *                              or any command that covers() a LOCAL_CHECKS check.
 *   resolveStep(job, step)    a GitHub step name: `Run <command>`, a bare name as
 *                              above, or the `name:` of a non-preparation step of
 *                              `job` in `workflow`, resolved through its commands.
 * Both return { name, label, gate } or null. `gate` is the check id when the
 * check is a Static_Gate: an npm check labeled static whose package.json
 * script runs `node scripts/check-*.mjs` (design part 8 §2.1).
 */
export function createCheckResolver({ localChecks = LOCAL_CHECKS, ciOnlySteps = CI_ONLY_STEPS, scripts = {}, root = process.cwd(), workflow = null } = {}) {
  const context = { scripts, root };
  const isStaticGate = (check) => check.kind === "npm" && check.label === "static" && STATIC_GATE_SCRIPT.test(scripts[check.script] ?? "");
  const staticGateIds = new Set(localChecks.filter(isStaticGate).map((check) => check.id));
  const fromCheck = (check) => Object.freeze({ name: check.id, label: check.label, gate: staticGateIds.has(check.id) ? check.id : null });

  function resolveName(name, job) {
    if (!isText(name)) return null;
    const line = collapse(name);
    const named = localChecks.find((check) => check.id === line || describeCommand(check, { python: "python" }) === line || describeCommand(check, { python: "python3" }) === line);
    if (named) return fromCheck(named);
    const ciOnly = ciOnlySteps.filter((step) => collapse(step.command) === line);
    if (ciOnly.length > 0) {
      const step = ciOnly.find((candidate) => candidate.job === job) ?? ciOnly[0];
      return Object.freeze({ name: collapse(step.command), label: step.label, gate: null });
    }
    const covered = localChecks.find((check) => covers(line, check, context));
    return covered ? fromCheck(covered) : null;
  }

  function resolveStep(job, stepName) {
    if (!isText(stepName)) return null;
    const candidates = stepName.startsWith("Run ") ? [stepName.slice(4), stepName] : [stepName];
    for (const candidate of candidates) {
      const resolved = resolveName(candidate, job);
      if (resolved) return resolved;
    }
    if (!workflow) return null;
    for (const definition of jobs(workflow)) {
      if (definition.id !== job) continue;
      for (const step of steps(definition)) {
        if (step.isPreparation || step.name !== stepName) continue;
        for (const line of commands(step)) {
          const resolved = resolveName(line, job);
          if (resolved) return resolved;
        }
      }
    }
    return null;
  }

  return Object.freeze({ resolveName, resolveStep, isStaticGateId: (id) => staticGateIds.has(id), staticGateIds });
}

function checkLabelValue(label, field, collector) {
  if (label === null || label === undefined) return false;
  if (!CHECK_LABELS.includes(label)) {
    collector.report(field, `取值 ${quoted(label)} 不是 ${CHECK_LABELS.join(" 或 ")}`);
    return false;
  }
  return true;
}

function inspectNotRun(list, collector) {
  const field = "未执行的 CI 检查";
  if (list === null || list === undefined) {
    collector.report(field, "缺少字段（Requirement 4.5；没有时写 [无]）");
    return false;
  }
  if (!Array.isArray(list) || list.length === 0) {
    collector.report(field, "必须是列表；没有未执行的 CI 检查时写 [无]");
    return false;
  }
  if (list.includes(NONE)) {
    if (list.length === 1) return true;
    collector.report(field, "[无] 不能与其他项同时出现");
    return false;
  }
  let ok = true;
  list.forEach((item, index) => {
    const at = `${field}[${index}]`;
    if (!isMapping(item)) {
      collector.report(at, "必须是 { 名称, 原因 } 映射");
      ok = false;
      return;
    }
    if (!isText(item.名称)) {
      collector.report(`${at}.名称`, item.名称 == null ? "缺少字段" : "必须是非空文本");
      ok = false;
    }
    if (!isText(item.原因)) {
      collector.report(`${at}.原因`, item.原因 == null ? "缺少字段（Requirement 4.5）" : "必须是非空文本");
      ok = false;
    }
    if (item.job !== undefined && !isText(item.job)) {
      collector.report(`${at}.job`, "必须是非空文本");
      ok = false;
    }
  });
  return ok;
}

/** Local run or non-GitHub Linux run: the fields of Requirement 4.2 (and 4.5 for local runs). */
function inspectCommandRun(source, state, collector, options, { local }) {
  let ok = collector.text(source, "命令");
  if (source.日期 === null || source.日期 === undefined) {
    collector.report("日期", "缺少字段");
    ok = false;
  } else if (!isValidDate(source.日期)) {
    collector.report("日期", "必须是合法的 YYYY-MM-DD 日期");
    ok = false;
  }
  if (source.退出码 === null || source.退出码 === undefined) {
    collector.report("退出码", "缺少字段");
    ok = false;
  } else if (typeof source.退出码 !== "string" || !EXIT_CODE.test(source.退出码)) {
    collector.report("退出码", "必须是整数");
    ok = false;
  }
  ok = collector.text(source, "操作系统") && ok;
  if (checkCommit(source.提交, "提交", collector, options)) state.commit = source.提交;
  else ok = false;
  if (local || source["未执行的 CI 检查"] !== undefined) ok = inspectNotRun(source["未执行的 CI 检查"], collector) && ok;

  let registered = 0;
  const checks = source.检查;
  if (checks === null || checks === undefined) {
    collector.report("检查", "缺少字段（Requirement 4.2：至少一项检查名称）");
    ok = false;
  } else if (!Array.isArray(checks) || checks.length === 0) {
    collector.report("检查", "必须是至少一项的 { 名称, 标签 } 列表（Requirement 4.2）");
    ok = false;
  } else {
    checks.forEach((item, index) => {
      const at = `检查[${index}]`;
      if (!isMapping(item)) {
        collector.report(at, "必须是 { 名称, 标签 } 映射");
        ok = false;
        return;
      }
      let itemOk = true;
      if (!isText(item.名称)) {
        collector.report(`${at}.名称`, item.名称 == null ? "缺少字段" : "必须是非空文本");
        itemOk = false;
      }
      if (item.标签 === null || item.标签 === undefined) {
        collector.report(`${at}.标签`, "缺少字段（Requirement 36.13）");
        itemOk = false;
      } else if (!checkLabelValue(item.标签, `${at}.标签`, collector)) {
        itemOk = false;
      }
      if (!itemOk) {
        ok = false;
        return;
      }
      if (!options.resolver) {
        state.labels.push(item.标签);
        registered += 1;
        return;
      }
      const resolved = options.resolver.resolveName(item.名称);
      if (resolved) {
        if (resolved.label !== item.标签) {
          collector.report(`${at}.标签`, `${item.名称} 在检查清单中标为 ${resolved.label}，此处写 ${item.标签}（Requirement 36.13）`);
          return;
        }
        state.labels.push(item.标签);
        registered += 1;
        if (resolved.gate) state.gates.push(resolved.gate);
        return;
      }
      // An unregistered command may be recorded only as the source's own command
      // and only as static; it does not identify a check in the sense of
      // Requirement 4.2, so it never makes the source complete.
      if (isText(source.命令) && collapse(item.名称) === collapse(source.命令) && item.标签 === "static") return;
      collector.report(`${at}.名称`, `${item.名称} 不在 LOCAL_CHECKS 或 CI_ONLY_STEPS 中，无法核对标签`, "VLOG-LABEL-UNKNOWN");
    });
  }
  state.succeeded = source.退出码 === "0";
  state.complete = ok && registered > 0;
  return state;
}

/** GitHub Actions run: the fields of Requirement 4.3 and the runner image of Requirement 3.3. */
function inspectGitHubRun(source, state, collector, options) {
  let ok = true;
  if (source["run id"] === null || source["run id"] === undefined) {
    collector.report("run id", "缺少字段");
    ok = false;
  } else if (typeof source["run id"] !== "string" || !DIGITS.test(source["run id"])) {
    collector.report("run id", "必须是运行页面 URL 中的数字 ID");
    ok = false;
  }
  if (checkCommit(source.提交, "提交", collector, options)) state.commit = source.提交;
  else ok = false;
  ok = collector.text(source, "运行结论") && ok;
  for (const field of ["skipped 步骤数", "node20 弃用告警数"]) {
    if (source[field] !== undefined && (typeof source[field] !== "string" || !DIGITS.test(source[field]))) {
      collector.report(field, "必须是非负整数");
      ok = false;
    }
  }

  let labeled = 0;
  let stepsSucceeded = false;
  const stepJobs = new Set();
  const list = source.步骤;
  if (list === null || list === undefined) {
    collector.report("步骤", "缺少字段（Requirement 4.3：至少一个步骤的 job、名称与结论）");
    ok = false;
  } else if (!Array.isArray(list) || list.length === 0) {
    collector.report("步骤", "必须是至少一项的列表；只写 job 或运行的整体结论不满足 Requirement 4.3");
    ok = false;
  } else {
    stepsSucceeded = true;
    list.forEach((item, index) => {
      const at = `步骤[${index}]`;
      if (!isMapping(item)) {
        collector.report(at, "必须是 { job, 步骤, 结论 } 映射");
        ok = false;
        stepsSucceeded = false;
        return;
      }
      for (const field of ["job", "步骤", "结论"]) {
        if (!isText(item[field])) {
          collector.report(`${at}.${field}`, item[field] == null ? "缺少字段" : "必须是非空文本");
          ok = false;
        }
      }
      if (item.结论 !== "success") stepsSucceeded = false;
      if (isText(item.job)) stepJobs.add(item.job);
      if (item.序号 !== undefined && (typeof item.序号 !== "string" || !DIGITS.test(item.序号))) {
        collector.report(`${at}.序号`, "必须是非负整数");
        ok = false;
      }
      const hasLabel = item.标签 !== null && item.标签 !== undefined;
      if (hasLabel && !checkLabelValue(item.标签, `${at}.标签`, collector)) {
        ok = false;
        return;
      }
      if (!options.resolver) {
        if (hasLabel) {
          state.labels.push(item.标签);
          labeled += 1;
        }
        return;
      }
      const resolved = options.resolver.resolveStep(item.job, item.步骤);
      if (resolved) {
        if (!hasLabel) {
          collector.report(`${at}.标签`, `${item.步骤} 对应登记的检查 ${resolved.name}，必须标注 ${resolved.label}（Requirement 36.13）`);
          return;
        }
        if (resolved.label !== item.标签) {
          collector.report(`${at}.标签`, `${item.步骤} 对应的 ${resolved.name} 在清单中标为 ${resolved.label}，此处写 ${item.标签}（Requirement 36.13）`);
          return;
        }
        state.labels.push(item.标签);
        labeled += 1;
        if (resolved.gate) state.gates.push(resolved.gate);
        return;
      }
      if (hasLabel) collector.report(`${at}.步骤`, `${item.步骤} 不对应 LOCAL_CHECKS 或 CI_ONLY_STEPS 中的检查，无法核对标签`, "VLOG-LABEL-UNKNOWN");
    });
  }

  let imagesComplete = true;
  const imageJobs = new Set();
  const images = source["runner 镜像"];
  if (images === null || images === undefined) {
    collector.report("runner 镜像", "缺少字段（Requirement 3.3）");
    ok = false;
  } else if (!Array.isArray(images) || images.length === 0) {
    collector.report("runner 镜像", "必须是至少一项的 { job, 镜像, 版本 } 列表");
    ok = false;
  } else {
    images.forEach((item, index) => {
      const at = `runner 镜像[${index}]`;
      if (!isMapping(item)) {
        collector.report(at, "必须是 { job, 镜像, 版本 } 映射");
        ok = false;
        return;
      }
      for (const field of ["job", "镜像", "版本"]) {
        if (!isText(item[field])) {
          collector.report(`${at}.${field}`, item[field] == null ? "缺少字段" : "必须是非空文本");
          ok = false;
        } else if (field !== "job" && item[field] === NOT_TRANSCRIBED) {
          imagesComplete = false;
        }
      }
      if (isText(item.job)) imageJobs.add(item.job);
    });
    for (const job of stepJobs) {
      if (!imageJobs.has(job)) {
        collector.report("runner 镜像", `缺少 job ${job} 的 runner 镜像（Requirement 3.3）`);
        ok = false;
      }
    }
  }
  state.succeeded = source.运行结论 === "success" && stepsSucceeded;
  state.complete = ok && imagesComplete && labeled > 0;
  return state;
}

/**
 * Inspects one `依据来源` item.
 * @param {{ resolver?: ReturnType<typeof createCheckResolver>, allowThisCommit?: boolean }} options
 *   Without a resolver every written label is taken at face value.
 * @returns {{ runnable: boolean, succeeded: boolean, complete: boolean, labels: string[], gates: string[], commit: string|null, problems: Array<{ field: string, message: string, code: string }> }}
 *   `runnable` for 本机运行 and CI 或 Linux 运行; `succeeded` per Requirement 4.6;
 *   `complete` when every field of Requirement 4.2 or 4.3 is present and valid,
 *   the runner image is not 待抄录 and at least one registered check or labeled
 *   step is listed (Requirement 4.7); `labels` of the counted checks and steps.
 */
export function inspectSource(source, options = {}) {
  const collector = problemCollector();
  const state = { runnable: false, succeeded: false, complete: false, labels: [], gates: [], commit: null, problems: collector.problems };
  if (!isMapping(source)) {
    collector.report("", "必须是映射");
    return state;
  }
  const category = source.类别;
  if (typeof category !== "string" || !SOURCE_CATEGORIES.includes(category)) {
    collector.report("类别", category == null ? "缺少字段" : `取值 ${quoted(category)} 不是 ${SOURCE_CATEGORIES.join("、")} 之一`);
    return state;
  }
  if (category === "需外部环境") {
    collector.text(source, "环境", "缺少字段（Requirement 4.4）");
    collector.text(source, "命令或验收步骤", "缺少字段（Requirement 4.4）");
    return state;
  }
  state.runnable = true;
  if (category === "CI 或 Linux 运行") {
    if (!PLATFORMS.includes(source.平台)) {
      collector.report("平台", source.平台 == null ? "缺少字段" : `取值 ${quoted(source.平台)} 不是 ${PLATFORMS.join(" 或 ")}`);
      return state;
    }
    if (source.平台 === "GitHub Actions") return inspectGitHubRun(source, state, collector, options);
  }
  return inspectCommandRun(source, state, collector, options, { local: category === "本机运行" });
}

function verdictOf(inspected) {
  const runnable = inspected.filter((source) => source.runnable);
  if (runnable.some((source) => !source.succeeded)) return "未验证";
  const complete = runnable.filter((source) => source.complete);
  if (complete.length === 0) return "未验证";
  return complete.every((source) => source.labels.every((label) => label === "static")) ? "静态检查" : "行为验证";
}

/**
 * Recomputes `判定` (design part 1 §4.1), in the order of Requirement 4.6, 4.7, 4.8:
 *   1. a runnable source did not succeed (运行结论 or a step is not success, or 退出码 is not 0) → 未验证;
 *   2. no runnable source is complete → 未验证;
 *   3. every label of the complete sources is static → 静态检查;
 *   4. otherwise → 行为验证.
 * Deterministic in its inputs; `options` as for inspectSource.
 */
export function classifyConclusion(entry, options = {}) {
  const sources = Array.isArray(entry?.依据来源) ? entry.依据来源 : [];
  return verdictOf(sources.map((source) => inspectSource(source, options)));
}

function validateRootCause(entry, options) {
  const collector = problemCollector();
  if (entry.确认方式 != null && !["CI 日志摘录", "Linux 复现"].includes(entry.确认方式)) collector.report("确认方式", `取值 ${quoted(entry.确认方式)} 不是 CI 日志摘录 或 Linux 复现`);
  if (entry.确认方式 === "Linux 复现" && !isText(entry.复现命令)) collector.report("复现命令", "确认方式为 Linux 复现时必填");
  for (const field of ["根因", "日志或命令输出"]) if (entry[field] != null && !isText(entry[field])) collector.report(field, "必须是非空文本");
  if (entry.修复提交 != null) checkCommit(entry.修复提交, "修复提交", collector, { ...options, full: true });
  if (entry.候选根因 != null && !["证实", "否定"].includes(entry.候选根因)) collector.report("候选根因", `取值 ${quoted(entry.候选根因)} 不是 证实 或 否定`);
  return collector.problems;
}

const CHANGE_FIELDS = Object.freeze(["原命令", "原 job", "变更方式", "替代命令", "替代 job", "理由"]);

function validateStepChanges(entry, options) {
  const collector = problemCollector();
  if (entry.基线提交 != null) checkCommit(entry.基线提交, "基线提交", collector, { full: true });
  if (entry.变更提交 != null) checkCommit(entry.变更提交, "变更提交", collector, { ...options, full: true });
  const changes = entry.变更;
  if (changes == null) return collector.problems;
  if (!Array.isArray(changes) || changes.length === 0) {
    collector.report("变更", "必须是至少一项的列表（Requirement 1.14）");
    return collector.problems;
  }
  changes.forEach((item, index) => {
    const at = `变更[${index}]`;
    if (!isMapping(item)) {
      collector.report(at, `必须是 { ${CHANGE_FIELDS.join(", ")} } 映射`);
      return;
    }
    for (const field of CHANGE_FIELDS) if (!isText(item[field])) collector.report(`${at}.${field}`, item[field] == null ? "缺少字段" : "必须是非空文本");
    if (isText(item.变更方式) && !CHANGE_KINDS.includes(item.变更方式)) {
      collector.report(`${at}.变更方式`, item.变更方式 === "待定" ? "ci:steps:diff 草稿中的\"待定\"必须改为 删除、跳过、放宽、加强、移动 之一" : `取值 ${quoted(item.变更方式)} 不是 ${CHANGE_KINDS.join("、")} 之一`);
    }
    if (isText(item.理由) && item.理由.includes("待填写")) collector.report(`${at}.理由`, "仍含 ci:steps:diff 草稿的\"待填写\"，必须写明变更理由");
  });
  return collector.problems;
}

function validateFirstGreen(entry) {
  const collector = problemCollector();
  if (entry["run id"] != null && (typeof entry["run id"] !== "string" || !DIGITS.test(entry["run id"]))) collector.report("run id", "必须是运行页面 URL 中的数字 ID");
  if (entry.提交 != null) checkCommit(entry.提交, "提交", collector, { full: true });
  const skipped = entry["skipped 步骤数"];
  if (skipped != null && skipped !== "0") collector.report("skipped 步骤数", `必须为 0（ci:evidence:collect 统计），此处为 ${quoted(skipped)}`);
  const sources = Array.isArray(entry.依据来源) ? entry.依据来源 : [];
  const run = sources.find((source) => isMapping(source) && source.平台 === "GitHub Actions" && source["run id"] === entry["run id"]);
  if (!run) collector.report("依据来源", `缺少 run id 为 ${entry["run id"] ?? "?"} 的 GitHub Actions 来源`);
  else {
    if (typeof entry.提交 === "string" && run.提交 !== entry.提交) collector.report("依据来源", `run ${entry["run id"]} 的 提交 ${run.提交} 与条目的 提交 ${entry.提交} 不一致`);
    if (run.运行结论 !== "success") collector.report("依据来源", `run ${entry["run id"]} 的运行结论不是 success`);
    if (run["skipped 步骤数"] !== undefined && run["skipped 步骤数"] !== skipped) collector.report("依据来源", `run ${entry["run id"]} 的 skipped 步骤数 与条目不一致`);
  }
  return collector.problems;
}

/**
 * Entry types (design part 1 §1.3.4, §4.3). Every type also needs the common
 * fields 编号, 类型, 结论, 判定 and 依据来源. `validate(entry, options)` checks
 * the formats of its own fields and returns { field, message, code? }[]; a
 * missing required field is reported from `requiredFields`. Other parts
 * register their types here (for example Requirement 27.9, 35.9).
 */
export const ENTRY_TYPES = Object.freeze({
  结论: Object.freeze({ requiredFields: Object.freeze([]) }),
  "CI 根因": Object.freeze({ requiredFields: Object.freeze(["根因", "确认方式", "日志或命令输出", "修复提交", "候选根因"]), validate: validateRootCause }),
  "CI 步骤变更": Object.freeze({ requiredFields: Object.freeze(["基线提交", "变更提交", "变更"]), validate: validateStepChanges }),
  "首次绿色 CI": Object.freeze({ requiredFields: Object.freeze(["run id", "提交", "skipped 步骤数"]), validate: validateFirstGreen })
});

function sameNames(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

function coverageTests(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item : item?.test)).filter(isText);
}

/** `静态门禁覆盖` (Requirement 36.14; design part 8 §2.1). */
function validateCoverage(entry, inspected, options, collector, notes) {
  const runnable = inspected.filter((source) => source.runnable);
  const gates = [...new Set(runnable.flatMap((source) => source.gates))];
  const listed = entry.静态门禁覆盖;
  if (listed === null || listed === undefined) {
    if (gates.length > 0) collector.report("静态门禁覆盖", `依据中列出了 Static_Gate ${gates.join("、")}，必须逐个写出覆盖它的行为测试，没有时写 [无]（Requirement 36.14）`);
    return;
  }
  if (!Array.isArray(listed) || listed.length === 0) {
    collector.report("静态门禁覆盖", "必须是至少一项的 { 门禁, 行为测试 } 列表");
    return;
  }
  const items = new Map();
  listed.forEach((item, index) => {
    const at = `静态门禁覆盖[${index}]`;
    if (!isMapping(item)) return collector.report(at, "必须是 { 门禁, 行为测试 } 映射");
    if (!isText(item.门禁)) return collector.report(`${at}.门禁`, item.门禁 == null ? "缺少字段" : "必须是非空文本");
    if (items.has(item.门禁)) return collector.report(`${at}.门禁`, `${item.门禁} 重复`);
    if (options.resolver && !options.resolver.isStaticGateId(item.门禁)) collector.report(`${at}.门禁`, `${item.门禁} 不是 Static_Gate（LOCAL_CHECKS 中标为 static 且执行 scripts/check-*.mjs 的 npm 检查）`);
    const tests = item.行为测试;
    if (tests === null || tests === undefined) return collector.report(`${at}.行为测试`, "缺少字段；没有覆盖它的行为测试时写 [无]");
    if (!Array.isArray(tests) || tests.length === 0 || !tests.every(isText)) return collector.report(`${at}.行为测试`, "必须是 npm 脚本名或测试文件路径的列表；没有时写 [无]");
    if (tests.includes(NONE) && tests.length !== 1) return collector.report(`${at}.行为测试`, "[无] 不能与其他名称同时出现");
    items.set(item.门禁, tests.includes(NONE) ? [] : tests);
  });
  for (const gate of gates) if (!items.has(gate)) collector.report("静态门禁覆盖", `缺少 ${gate}（依据中列出了该 Static_Gate，Requirement 36.14）`);
  if (typeof options.coverageFor !== "function") return;
  for (const commit of [...new Set(runnable.map((source) => source.commit).filter(Boolean))]) {
    const coverage = options.coverageFor(commit);
    if (!coverage) continue;
    if (coverage.status === "unavailable") {
      notes.push({ field: "静态门禁覆盖", message: `未核对：无法读取提交 ${commit} 的 ${STATIC_GATE_COVERAGE_PATH}（${coverage.reason}）`, code: "VLOG-COVERAGE" });
      continue;
    }
    if (coverage.status !== "ok") {
      collector.report("静态门禁覆盖", `无法读取提交 ${commit} 的 ${STATIC_GATE_COVERAGE_PATH}：${coverage.reason}`);
      continue;
    }
    for (const [gate, tests] of items) {
      const expected = coverageTests(coverage.mapping[gate]);
      if (!sameNames(expected, tests)) {
        const show = (names) => (names.length === 0 ? "[无]" : names.join("、"));
        collector.report("静态门禁覆盖", `${gate} 的行为测试必须与提交 ${commit} 的 STATIC_GATE_COVERAGE 一致：应为 ${show(expected)}，此处为 ${show(tests)}`);
      }
    }
  }
}

/**
 * Validates one parsed entry.
 * @param {object} entry the YAML mapping of the entry.
 * @param {{ resolver?: object, coverageFor?: (commit: string) => ({ status: "ok", mapping: object }|{ status: "unavailable"|"error", reason: string }|undefined), allowThisCommit?: boolean }} options
 * @returns {{ problems: Array<{ field, message, code }>, notes: Array<{ field, message, code }>, verdict: string|null }}
 */
export function validateEntry(entry, options = {}) {
  const collector = problemCollector();
  const notes = [];
  if (!isMapping(entry)) {
    collector.report("", "YAML 块的根必须是映射");
    return { problems: collector.problems, notes, verdict: null };
  }
  if (entry.编号 == null) collector.report("编号", "缺少字段");
  else if (!isEntryId(entry.编号)) collector.report("编号", `${quoted(entry.编号)} 不符合 V-YYYYMMDD-NN`);
  let spec = null;
  if (entry.类型 == null) collector.report("类型", "缺少字段");
  else if (!Object.hasOwn(ENTRY_TYPES, entry.类型)) collector.report("类型", `${quoted(entry.类型)} 未在 ENTRY_TYPES 中登记（已登记：${Object.keys(ENTRY_TYPES).join("、")}）`);
  else spec = ENTRY_TYPES[entry.类型];
  collector.text(entry, "结论");
  if (entry.判定 == null) collector.report("判定", "缺少字段");
  else if (!VERDICTS.includes(entry.判定)) collector.report("判定", `取值 ${quoted(entry.判定)} 不是 ${VERDICTS.join("、")} 之一`);
  let inspected = [];
  const sources = entry.依据来源;
  if (sources == null) collector.report("依据来源", "缺少字段");
  else if (!Array.isArray(sources) || sources.length === 0) collector.report("依据来源", "必须是至少一项的列表");
  else {
    inspected = sources.map((source, index) => {
      const result = inspectSource(source, options);
      for (const problem of result.problems) collector.problems.push({ ...problem, field: problem.field ? `依据来源[${index}].${problem.field}` : `依据来源[${index}]` });
      return result;
    });
  }
  if (spec) {
    for (const field of spec.requiredFields) if (entry[field] === null || entry[field] === undefined || entry[field] === "") collector.report(field, `缺少字段（类型 ${entry.类型}）`);
    for (const problem of spec.validate?.(entry, options) ?? []) collector.report(problem.field, problem.message, problem.code);
  }
  const verdict = verdictOf(inspected);
  if (VERDICTS.includes(entry.判定) && entry.判定 !== verdict) collector.report("判定", `写的是 ${entry.判定}，按 Requirement 4.6、4.7、4.8 复核应为 ${verdict}`);
  validateCoverage(entry, inspected, options, collector, notes);
  return { problems: collector.problems, notes, verdict };
}

const FENCE_OPEN = /^(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const ENTRY_HEADING = /^##[ \t]+(V-\S*)(?:[ \t]+(.*))?$/;

function isFenceClose(line, marker) {
  const match = /^(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(match) && match[1][0] === marker[0] && match[1].length >= marker.length;
}

function parseYaml(text) {
  try {
    return { data: yaml.load(text, { schema: yaml.FAILSAFE_SCHEMA }) };
  } catch (error) {
    const where = error.mark ? `（块内第 ${error.mark.line + 1} 行）` : "";
    return { error: `YAML 解析失败：${error.reason ?? error.message}${where}` };
  }
}

/**
 * Splits the log into entries.
 * @returns {{ entries: Array<{ id: string, title: string, line: number, data: object }>, errors: Array<{ id, field, message, code, line }> }}
 */
export function parseVerificationLog(text) {
  const lines = normalizeNewlines(String(text)).split("\n");
  const entries = [];
  const errors = [];
  const seen = new Set();
  const error = (id, message, line) => errors.push({ id, field: "", message, code: "VLOG", line });
  let fence = null;
  let pending = null;
  const finish = (heading, body) => {
    const parsed = parseYaml(body);
    if (parsed.error) return error(heading.id, parsed.error, heading.line);
    if (!isMapping(parsed.data)) return error(heading.id, "YAML 块的根必须是映射", heading.line);
    if (parsed.data.编号 !== heading.id) return error(heading.id, `YAML 中的 编号 ${quoted(parsed.data.编号 ?? null)} 与标题不一致`, heading.line);
    entries.push(Object.freeze({ id: heading.id, title: heading.title, line: heading.line, data: parsed.data }));
  };
  lines.forEach((line, index) => {
    const number = index + 1;
    if (fence) {
      if (isFenceClose(line, fence.marker)) {
        if (fence.heading) finish(fence.heading, fence.body.join("\n"));
        fence = null;
      } else {
        fence.body.push(line);
      }
      return;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      const info = open[2].toLowerCase();
      const isYaml = info === "yaml" || info === "yml";
      if (pending && !isYaml) error(pending.id, "标题后没有紧跟 YAML 块", pending.line);
      if (!pending && isYaml) error(`第 ${number} 行`, "YAML 块前没有 `## V-YYYYMMDD-NN <结论摘要>` 标题", number);
      fence = { marker: open[1], body: [], heading: isYaml ? pending : null, line: number };
      pending = null;
      return;
    }
    if (line.trim() === "") return;
    if (pending) {
      error(pending.id, "标题后没有紧跟 YAML 块", pending.line);
      pending = null;
    }
    const heading = ENTRY_HEADING.exec(line);
    if (!heading) return;
    const id = heading[1];
    const title = (heading[2] ?? "").trim();
    if (!isEntryId(id)) return error(`第 ${number} 行`, `编号 ${id} 不符合 V-YYYYMMDD-NN`, number);
    if (title === "") error(id, "标题缺少结论摘要（## V-YYYYMMDD-NN <结论摘要>）", number);
    if (seen.has(id)) return error(id, `编号重复（第 ${number} 行）`, number);
    seen.add(id);
    pending = { id, title, line: number };
  });
  if (fence) error(fence.heading?.id ?? `第 ${fence.line} 行`, "代码块没有结束标记", fence.line);
  if (pending) error(pending.id, "标题后没有 YAML 块", pending.line);
  return { entries, errors };
}

/** Lines of `text` matching a SECRET_PATTERNS entry: [{ line, pattern }] with the pattern id only. */
export function scanSecrets(text) {
  const hits = [];
  normalizeNewlines(String(text)).split("\n").forEach((line, index) => {
    for (const { id, pattern } of SECRET_PATTERNS) if (pattern.test(line)) hits.push({ line: index + 1, pattern: id });
  });
  return hits;
}

/** 提交 values of the runnable sources of each parsed entry (inputs of loadStaticGateCoverage). */
export function coverageCommits(entries) {
  const commits = new Set();
  for (const data of entries) {
    const sources = isMapping(data) && Array.isArray(data.依据来源) ? data.依据来源 : [];
    for (const source of sources) {
      if (!isMapping(source) || source.类别 === "需外部环境") continue;
      if (source.提交 === THIS_COMMIT || (typeof source.提交 === "string" && SHORT_OR_FULL_COMMIT.test(source.提交))) commits.add(source.提交);
    }
  }
  return [...commits];
}

/**
 * Validates docs/VERIFICATION_LOG.md: structure (design part 1 §4.4), every
 * entry (validateEntry, with "本提交" rejected) and the secret patterns.
 * @returns {{ entries: Array<{ id, title, line, data, verdict, valid }>, errors: Array<{ id, field, message, code, line? }>, notes: Array<{ id, field, message, code }> }}
 */
export function validateVerificationLog(text, options = {}) {
  const parsed = parseVerificationLog(text);
  const errors = [...parsed.errors];
  const notes = [];
  const entries = parsed.entries.map((entry) => {
    const result = validateEntry(entry.data, { ...options, allowThisCommit: false });
    for (const problem of result.problems) errors.push({ id: entry.id, line: entry.line, ...problem });
    for (const note of result.notes) notes.push({ id: entry.id, ...note });
    return Object.freeze({ ...entry, verdict: result.verdict, valid: result.problems.length === 0 });
  });
  const file = options.file ?? DEFAULT_LOG_FILE;
  for (const hit of scanSecrets(text)) errors.push({ id: `${file}:${hit.line}`, field: "", message: `命中机密模式 ${hit.pattern}；文档只写证据引用，不写机密值（Requirement 6.8）`, code: "SECRET", line: hit.line });
  return { entries, errors, notes };
}

const TRAILER = /^verification-log:[ \t]*(.*?)[ \t]*$/i;

/** `Verification-Log:` trailer lines and ```yaml blocks of a commit message. */
export function parseCommitMessage(text) {
  const lines = normalizeNewlines(String(text)).split("\n");
  const trailers = [];
  const blocks = [];
  const errors = [];
  let fence = null;
  lines.forEach((line, index) => {
    const number = index + 1;
    if (fence) {
      if (isFenceClose(line, fence.marker)) {
        if (fence.yaml) blocks.push({ line: fence.line, text: fence.body.join("\n") });
        fence = null;
      } else {
        fence.body.push(line);
      }
      return;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      const info = open[2].toLowerCase();
      fence = { marker: open[1], body: [], yaml: info === "yaml" || info === "yml", line: number };
      return;
    }
    const trailer = TRAILER.exec(line);
    if (trailer) trailers.push({ line: number, value: trailer[1] });
  });
  if (fence) errors.push({ id: `commit-msg:${fence.line}`, field: "", message: "代码块没有结束标记", code: "VLOG", line: fence.line });
  return { trailers, blocks, errors };
}

/**
 * Validates the verification claims of a commit message (design part 1 §4.1):
 * every `Verification-Log: V-YYYYMMDD-NN` trailer names a valid entry of the
 * log; every embedded ```yaml block is an entry of the same schema, in which
 * 提交 may be "本提交"; the blocks contain no secret.
 * @param {{ entries?: Array<{ id: string, valid?: boolean }>, resolver?: object, coverageFor?: Function }} options
 */
export function validateCommitMessage(text, options = {}) {
  const { entries = [], file = DEFAULT_LOG_FILE, ...rest } = options;
  const parsed = parseCommitMessage(text);
  const errors = [...parsed.errors];
  const notes = [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const trailer of parsed.trailers) {
    const id = `commit-msg:${trailer.line}`;
    const fail = (message) => errors.push({ id, field: "Verification-Log", message, code: "VLOG", line: trailer.line });
    if (!isEntryId(trailer.value)) fail(`${quoted(trailer.value)} 不是 V-YYYYMMDD-NN 编号`);
    else if (!byId.has(trailer.value)) fail(`${file} 中没有 ${trailer.value}`);
    else if (byId.get(trailer.value).valid === false) fail(`${trailer.value} 本身没有通过校验`);
  }
  for (const block of parsed.blocks) {
    const location = `commit-msg:${block.line}`;
    const yamlResult = parseYaml(block.text);
    if (yamlResult.error) {
      errors.push({ id: location, field: "", message: yamlResult.error, code: "VLOG", line: block.line });
      continue;
    }
    const id = isMapping(yamlResult.data) && isText(yamlResult.data.编号) ? yamlResult.data.编号 : location;
    const result = validateEntry(yamlResult.data, { ...rest, allowThisCommit: true });
    for (const problem of result.problems) errors.push({ id, line: block.line, ...problem });
    for (const note of result.notes) notes.push({ id, ...note });
    for (const hit of scanSecrets(block.text)) errors.push({ id: `commit-msg:${block.line + hit.line}`, field: "", message: `命中机密模式 ${hit.pattern}；只写证据引用，不写机密值（Requirement 6.8）`, code: "SECRET", line: block.line + hit.line });
  }
  return { errors, notes, trailers: parsed.trailers, blocks: parsed.blocks };
}

function runGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? "", reason: result.error?.code ?? (result.stderr ?? "").trim().replace(/\s+/g, " ") };
}

async function evaluateCoverageModule(source, label) {
  let module;
  try {
    module = await import(`data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`);
  } catch (error) {
    throw new Error(`${label} 不能作为独立模块求值（${error.message}）；该文件只能导出数据，不能导入其他模块`);
  }
  if (!isMapping(module.STATIC_GATE_COVERAGE)) throw new Error(`${label} 没有导出 STATIC_GATE_COVERAGE 对象`);
  return module.STATIC_GATE_COVERAGE;
}

/**
 * STATIC_GATE_COVERAGE as of each commit (Requirement 36.14: the behavioral
 * tests must match the mapping of the commit the entry is based on). "本提交"
 * reads the working tree. A commit whose tree has no scripts/static-gate-coverage.mjs
 * has an empty mapping. A commit that git cannot resolve (for example in a
 * shallow clone) is "unavailable" and is reported as a note, not checked.
 * The module is evaluated on its own, so it must not import other modules.
 * @returns {Promise<Map<string, { status: "ok", mapping: object } | { status: "unavailable"|"error", reason: string }>>}
 */
export async function loadStaticGateCoverage(commits, { root = process.cwd() } = {}) {
  const result = new Map();
  for (const commit of new Set(commits)) {
    try {
      if (commit === THIS_COMMIT) {
        const file = path.join(root, STATIC_GATE_COVERAGE_PATH);
        const mapping = existsSync(file) ? await evaluateCoverageModule(readFileSync(file, "utf8"), STATIC_GATE_COVERAGE_PATH) : {};
        result.set(commit, { status: "ok", mapping });
        continue;
      }
      const resolved = runGit(root, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
      if (!resolved.ok) {
        result.set(commit, { status: "unavailable", reason: "提交不在本地 git 历史中，例如浅克隆" });
        continue;
      }
      const sha = resolved.stdout.trim();
      if (!runGit(root, ["cat-file", "-e", `${sha}:${STATIC_GATE_COVERAGE_PATH}`]).ok) {
        result.set(commit, { status: "ok", mapping: {} });
        continue;
      }
      const shown = runGit(root, ["show", `${sha}:${STATIC_GATE_COVERAGE_PATH}`]);
      if (!shown.ok) throw new Error(`git show 失败（${shown.reason}）`);
      result.set(commit, { status: "ok", mapping: await evaluateCoverageModule(shown.stdout, `${sha.slice(0, 12)}:${STATIC_GATE_COVERAGE_PATH}`) });
    } catch (error) {
      result.set(commit, { status: "error", reason: error.message });
    }
  }
  return result;
}
