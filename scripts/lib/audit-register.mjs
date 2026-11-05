// Schema and checks of docs/AUDIT_REGISTER.md, the Audit_Register (design part 1
// §7.1-7.5; cross-part rulings 15 and 18; Requirement 6.8, 7.1-7.15).
//
// Record format: a `### <编号> <标题>` heading followed, after optional blank
// lines, by exactly one ```yaml fenced block, parsed with js-yaml's
// FAILSAFE_SCHEMA (every scalar is a string). A `###` heading is a record
// heading when its first word is capital letters followed by digits (C1, M25,
// N3, and also typos such as C5 or X1, which AR-SET reports); other headings
// and fenced blocks of other languages are prose. A ```yaml block anywhere else
// is an error.
//
// The status of every record is recomputed by deriveStatus (design part 1 §7.1):
//   1. a complete `修复` record (commit, at least one regression test, failing
//      evidence before the fix and passing evidence on the fix) → 已修复;
//   2. otherwise the `结论` of the last `核实` item;
//   3. otherwise the initial value of `来源标记`: 已核实 → 已确认,
//      需环境验证 → 需环境验证, 待复核 / 未标注 / 新发现 → 待复核.
//
// parseAuditRegister, deriveStatus, isCompleteFix and validateAuditRegister do
// no I/O.
import yaml from "js-yaml";
import { CI_ONLY_STEPS } from "../ci-required-steps.mjs";
import { LOCAL_CHECKS } from "../verify-local-checks.mjs";
import { createCheckResolver, isEntryId, isValidDate, scanSecrets } from "./verification-log.mjs";
import { normalizeNewlines } from "./workflow-model.mjs";

export const DEFAULT_REGISTER_FILE = "docs/AUDIT_REGISTER.md";

/**
 * The audit report the register is based on. It lives outside the repository
 * (design part 1 §7.1); the register cites it as "审计报告 §<章节> <编号>" and
 * docs/VERIFICATION_LOG.md records the SHA-256 of the file that was read.
 */
export const AUDIT_REPORT = Object.freeze({
  file: "f9d9e2ed-88ca-4736-978b-9c1242d28819.md",
  date: "2026-11-04",
  sha256: "9021ab946370f41adc3b25e386d16eb8b19a69dbd4d95a2dd1fd410204d940c3"
});

/** The five states of Requirement 7.4. */
export const STATUSES = Object.freeze(["待复核", "已确认", "已否定", "需环境验证", "已修复"]);
/** `来源标记` values: the report's three marks, "未标注" for unmarked report items, "新发现" for defects found while executing the spec. */
export const SOURCE_MARKS = Object.freeze(["已核实", "待复核", "需环境验证", "未标注", "新发现"]);
/** Source marks whose initial state is 待复核 (Requirement 7.5); a fix of such an issue needs a 已确认 verification first (7.8). */
export const UNREVIEWED_MARKS = Object.freeze(["待复核", "未标注", "新发现"]);
/** Verification methods and conclusions of Requirement 7.6. */
export const VERIFY_METHODS = Object.freeze(["代码阅读", "本机测试", "CI_Pipeline 运行", "外部环境测试"]);
export const VERIFY_CONCLUSIONS = Object.freeze(["已确认", "已否定", "需环境验证"]);
/** Evidence fields of each verification method (Requirement 7.7). */
export const METHOD_EVIDENCE_FIELDS = Object.freeze({
  代码阅读: Object.freeze(["文件", "行号范围", "推理"]),
  本机测试: Object.freeze(["测试名称", "命令"]),
  "CI_Pipeline 运行": Object.freeze(["run id", "步骤"]),
  外部环境测试: Object.freeze(["环境", "日期", "记录"])
});
export const PRIORITIES = Object.freeze(["P0", "P1", "P2"]);
export const ERROR_CODES = Object.freeze(["AR-SET", "AR-LOW-TEXT", "AR-FIELD", "AR-STATUS", "AR-VERIFY", "AR-ORDER", "AR-NEGATE", "AR-FIX", "AR-PRIORITY"]);

/** Issue series of the audit report: prefix → report section, number of issues, severity heading. */
export const REPORT_SERIES = Object.freeze({
  C: Object.freeze({ section: "2", count: 4, severity: "严重" }),
  H: Object.freeze({ section: "3", count: 7, severity: "高" }),
  M: Object.freeze({ section: "4", count: 25, severity: "中" }),
  L: Object.freeze({ section: "5", count: 18, severity: "低" })
});
/** C1-C4, H1-H7, M1-M25, L1-L18: the 54 issues of the report (Requirement 7.1). */
export const REPORT_ISSUE_IDS = Object.freeze(Object.entries(REPORT_SERIES).flatMap(([prefix, { count }]) => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`)));

/**
 * The bold phrase of each first-level item of section 5 ("低") of the audit
 * report, in report order: L1 is the first item (Requirement 7.2; design part 1
 * §7.1). Second-level sub-items belong to the same issue. Frozen here so that
 * the register cannot drift from the report.
 */
export const REPORT_LOW_ITEMS = Object.freeze([
  "token 比较不是常量时间",
  "租户 token 配置错误不会报错",
  "安全头偏弱",
  "错误信息外泄",
  "canonicalJson 依赖 locale",
  "发布清单有效期不一致",
  "两个服务不处理 SIGTERM",
  "跨租户改名",
  "Gateway 的小问题",
  "compose 端口配置不一致",
  "两份 runtime env 模板变量不一致",
  "systemd 单元不完善",
  "Prometheus 示例目标错误",
  "备份脚本暴露口令",
  "迁移器缺少保护",
  "审计哈希链可被改写",
  "锁文件与实际部署不符",
  "许可证事项"
]);

function reportMark(id) {
  const prefix = id[0];
  const number = Number(id.slice(1));
  if (prefix === "C" || prefix === "H") return "已核实";
  if (prefix === "L") return "未标注";
  if (number <= 9) return "已核实";
  if (number === 18 || number === 19) return "需环境验证";
  return "待复核";
}

/**
 * The mark the audit report gives each issue: C and H items and M1-M9 are
 * [已核实] (C3 "已核实代码", H5 reproduced locally, M8 "以运行结果为证");
 * M18, M19 are 需环境验证; the other M items are 待复核; the L items carry no
 * mark. The initial state follows from it (Requirement 7.5), so the register
 * may not change it.
 */
export const REPORT_SOURCE_MARKS = Object.freeze(Object.fromEntries(REPORT_ISSUE_IDS.map((id) => [id, reportMark(id)])));

const P0_REQUIREMENTS = [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
const P2_REQUIREMENTS = [35, 37, 38, 39];
/** Priority of Requirement 1-40 in the requirements overview (需求总览). */
export const REQUIREMENT_PRIORITIES = Object.freeze(Object.fromEntries(Array.from({ length: 40 }, (_, index) => {
  const number = index + 1;
  return [String(number), P0_REQUIREMENTS.includes(number) ? "P0" : P2_REQUIREMENTS.includes(number) ? "P2" : "P1"];
})));

/** C, H, M, L followed by the issue number, or N<k> for new defects; no leading zeros. */
export const ISSUE_ID = /^([CHMLN])([1-9][0-9]*)$/;
const RECORD_HEADING = /^###[ \t]+([A-Z]+[0-9]+)(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE_OPEN = /^(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const DIGITS = /^\d+$/;
const LINE_SPEC = /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/;
/** Repository-relative path (globs allowed), optionally followed by `:<lines>` such as `:21,25,62-64`. */
const LOCATION = /^(?![/~])(?!.*\.\.)[^\s:\\]+(?::\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)?$/;
const FILE_PATH = /^(?![/~])(?!.*\.\.)[^\s:\\]+$/;
const ACCEPTANCE_CRITERION = /^([1-9][0-9]*)\.([1-9][0-9]*)$/;
const NONE_REQUIREMENT = /^无(?:[：:][ \t]*(.*))?$/s;

const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";
const isTextList = (value) => Array.isArray(value) && value.length > 0 && value.every(isText);
const isCommit = (value) => typeof value === "string" && COMMIT.test(value);
const quoted = (value) => JSON.stringify(value);
const missing = (value) => value === null || value === undefined;

/** Initial state for a `来源标记` value (Requirement 7.5); unknown values count as 待复核. */
export function initialStatus(mark) {
  if (mark === "已核实") return "已确认";
  if (mark === "需环境验证") return "需环境验证";
  return "待复核";
}

/** Execution evidence of a regression test (Requirement 7.12): { 命令, 提交 } of a local run or { run id } of a CI_Pipeline run. */
export function isFixEvidence(value) {
  if (!isMapping(value)) return false;
  if (isText(value.命令) && isCommit(value.提交)) return true;
  return typeof value["run id"] === "string" && DIGITS.test(value["run id"]);
}

const FIX_PARTS = Object.freeze([
  ["提交", (fix) => isCommit(fix.提交)],
  ["回归测试", (fix) => isTextList(fix.回归测试)],
  ["修复前失败", (fix) => isFixEvidence(fix.修复前失败)],
  ["修复后通过", (fix) => isFixEvidence(fix.修复后通过)]
]);

/** Parts of a `修复` record of Requirement 7.11 and 7.12 that are missing or malformed. */
export function missingFixParts(fix) {
  if (!isMapping(fix)) return FIX_PARTS.map(([name]) => name);
  return FIX_PARTS.filter(([, valid]) => !valid(fix)).map(([name]) => name);
}

/** True when `修复` has every record of Requirement 7.11 and 7.12. */
export function isCompleteFix(fix) {
  return missingFixParts(fix).length === 0;
}

function lastVerification(list) {
  if (!Array.isArray(list)) return null;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (isMapping(list[index]) && VERIFY_CONCLUSIONS.includes(list[index].结论)) return { item: list[index], index };
  }
  return null;
}

/**
 * The one state of a record (Requirement 7.4, 7.5, 7.13; design part 1 §7.1).
 * Always one of STATUSES, whatever the input. A `核实` item whose 结论 is not
 * one of VERIFY_CONCLUSIONS is skipped (AR-VERIFY reports it).
 */
export function deriveStatus(record) {
  const data = isMapping(record) ? record : {};
  if (isCompleteFix(data.修复)) return "已修复";
  const last = lastVerification(data.核实);
  if (last) return last.item.结论;
  return initialStatus(data.来源标记);
}

/** Highest priority among requirement numbers (strings "1"-"40"); null when none is known. */
export function highestPriority(requirements) {
  const known = requirements.map((number) => REQUIREMENT_PRIORITIES[number]).filter(Boolean);
  if (known.length === 0) return null;
  return PRIORITIES.find((priority) => known.includes(priority));
}

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
 * Splits the register into records. A record whose YAML block is missing or
 * cannot be parsed has `data: null`; it still counts for AR-SET (design part 1 §7.4).
 * @returns {{ records: Array<{ id: string, title: string, line: number, data: object|null }>, errors: Array<{ code, id, field, message, line }> }}
 */
export function parseAuditRegister(text) {
  const lines = normalizeNewlines(String(text)).split("\n");
  const records = [];
  const errors = [];
  const error = (id, message, line, field = "") => errors.push({ code: "AR-FIELD", id, field, message, line });
  let fence = null;
  let pending = null;
  const unpaired = (heading) => {
    error(heading.id, "标题后没有紧跟 YAML 块", heading.line);
    records.push({ id: heading.id, title: heading.title, line: heading.line, data: null });
  };
  const finish = (heading, body) => {
    const parsed = parseYaml(body);
    if (parsed.error) {
      error(heading.id, `${parsed.error}；跳过该记录的其余规则`, heading.line);
      records.push({ id: heading.id, title: heading.title, line: heading.line, data: null });
      return;
    }
    if (!isMapping(parsed.data)) {
      error(heading.id, "YAML 块的根必须是映射", heading.line);
      records.push({ id: heading.id, title: heading.title, line: heading.line, data: null });
      return;
    }
    records.push({ id: heading.id, title: heading.title, line: heading.line, data: parsed.data });
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
      if (pending && !isYaml) unpaired(pending);
      if (!pending && isYaml) error(`第 ${number} 行`, "YAML 块前没有 `### <编号> <标题>` 记录标题", number);
      fence = { marker: open[1], body: [], heading: isYaml ? pending : null, line: number };
      pending = null;
      return;
    }
    if (line.trim() === "") return;
    if (pending) {
      unpaired(pending);
      pending = null;
    }
    const heading = RECORD_HEADING.exec(line);
    if (heading) pending = { id: heading[1], title: (heading[2] ?? "").trim(), line: number };
  });
  if (fence) {
    error(fence.heading?.id ?? `第 ${fence.line} 行`, "代码块没有结束标记", fence.line);
    if (fence.heading) records.push({ id: fence.heading.id, title: fence.heading.title, line: fence.heading.line, data: null });
  }
  if (pending) unpaired(pending);
  return { records, errors };
}

/** AR-SET (Requirement 7.1, 7.14): every report issue exactly once; N1…Nk without gaps or duplicates; no other ids. */
function checkSet(records, file) {
  const errors = [];
  const at = new Map();
  for (const record of records) {
    if (!at.has(record.id)) at.set(record.id, []);
    at.get(record.id).push(record.line);
  }
  const report = (id, message, line) => errors.push({ code: "AR-SET", id, field: "", message, ...(line ? { line } : {}) });
  for (const id of REPORT_ISSUE_IDS) {
    if (!at.has(id)) report(file, `缺少 ${id}：审计报告 §${REPORT_SERIES[id[0]].section} 的每个问题都必须登记一条记录（Requirement 7.1）`);
  }
  const newNumbers = [];
  for (const [id, lines] of at) {
    if (lines.length > 1) report(id, `重复登记（第 ${lines.join("、")} 行）；每个问题只能有一条记录`, lines[1]);
    const match = ISSUE_ID.exec(id);
    if (match?.[1] === "N") newNumbers.push(Number(match[2]));
    else if (!REPORT_ISSUE_IDS.includes(id)) report(id, "不是审计报告的问题编号（C1–C4、H1–H7、M1–M25、L1–L18），也不是新缺陷编号 N1、N2……", lines[0]);
  }
  const highest = Math.max(0, ...newNumbers);
  const gaps = [];
  for (let number = 1; number <= highest; number += 1) if (!newNumbers.includes(number)) gaps.push(`N${number}`);
  if (gaps.length > 0) report(file, `新缺陷编号必须从 N1 起顺序递增、不跳号：已登记到 N${highest}，缺少 ${gaps.join("、")}（Requirement 7.14）`);
  return errors;
}

function checkLocations(value, report) {
  if (missing(value)) return report("AR-FIELD", "位置", "缺少字段（Requirement 7.3）");
  if (!Array.isArray(value) || value.length === 0) return report("AR-FIELD", "位置", "必须是至少一项的文件路径列表");
  value.forEach((item, index) => {
    if (typeof item !== "string" || !LOCATION.test(item)) report("AR-FIELD", `位置[${index}]`, `${quoted(item)} 不是仓库相对文件路径，行号写在冒号之后（如 apps/alert-notifier/index.mjs:65-69）`);
  });
}

function checkRequirements(value, report) {
  const numbers = [];
  if (missing(value)) {
    report("AR-FIELD", "对应需求", "缺少字段（Requirement 7.3）");
    return numbers;
  }
  if (!Array.isArray(value) || value.length === 0) {
    report("AR-FIELD", "对应需求", "必须是至少一项的列表：需求编号（如 \"8\"），或 \"无：<理由>\"");
    return numbers;
  }
  value.forEach((item, index) => {
    const at = `对应需求[${index}]`;
    if (typeof item !== "string") return report("AR-FIELD", at, "必须是文本");
    const none = NONE_REQUIREMENT.exec(item);
    if (none) {
      if (!isText(none[1])) report("AR-FIELD", at, "没有对应需求时必须写明理由，格式为 \"无：<理由>\"（Requirement 7.3）");
      if (value.length > 1) report("AR-FIELD", at, "\"无\" 不能与需求编号同时出现");
      return;
    }
    if (!Object.hasOwn(REQUIREMENT_PRIORITIES, item)) return report("AR-FIELD", at, `${quoted(item)} 不是本规格的需求编号（1 至 40）`);
    if (numbers.includes(item)) return report("AR-FIELD", at, `需求 ${item} 重复`);
    numbers.push(item);
  });
  return numbers;
}

function checkPriority(value, isNew, requirements, report) {
  if (missing(value)) {
    report("AR-PRIORITY", "优先级", isNew ? "新缺陷必须按需求文档的优先级定义指定 P0、P1、P2 之一（Requirement 7.15）" : "缺少字段；取对应需求在需求总览中的最高优先级");
    return;
  }
  if (!PRIORITIES.includes(value)) {
    report("AR-PRIORITY", "优先级", `取值 ${quoted(value)} 不是 ${PRIORITIES.join("、")} 之一`);
    return;
  }
  if (isNew) return;
  const expected = highestPriority(requirements);
  if (expected && value !== expected) report("AR-PRIORITY", "优先级", `应为 ${expected}（对应需求 ${requirements.join("、")} 在需求总览中的最高优先级），此处为 ${value}`);
}

function evidenceItems(value) {
  if (isMapping(value)) return [value];
  if (Array.isArray(value) && value.length > 0 && value.every(isMapping)) return value;
  return null;
}

function checkLogReference(value, field, context, report) {
  if (!isEntryId(value)) {
    report("AR-VERIFY", field, `${quoted(value ?? null)} 不是 V-YYYYMMDD-NN 编号`);
    return;
  }
  if (context.vlog && !context.vlog.has(value)) report("AR-VERIFY", field, `docs/VERIFICATION_LOG.md 中没有 ${value}`);
}

function checkEvidence(method, value, at, context, report) {
  const fields = METHOD_EVIDENCE_FIELDS[method];
  if (missing(value)) return report("AR-VERIFY", `${at}.证据`, `缺少字段（方法为${method}时记录 ${fields.join("、")}，Requirement 7.7）`);
  const items = evidenceItems(value);
  if (!items) return report("AR-VERIFY", `${at}.证据`, `必须是 { ${fields.join(", ")} } 映射或这种映射的列表`);
  items.forEach((evidence, index) => {
    const where = isMapping(value) ? `${at}.证据` : `${at}.证据[${index}]`;
    const absent = fields.filter((field) => missing(evidence[field]) || evidence[field] === "");
    for (const field of absent) report("AR-VERIFY", `${where}.${field}`, `缺少字段（方法为${method}时必填，Requirement 7.7）`);
    const has = (field) => !absent.includes(field);
    switch (method) {
      case "代码阅读":
        if (has("文件") && (typeof evidence.文件 !== "string" || !FILE_PATH.test(evidence.文件))) report("AR-VERIFY", `${where}.文件`, `${quoted(evidence.文件)} 不是仓库相对文件路径`);
        if (has("行号范围") && (typeof evidence.行号范围 !== "string" || !LINE_SPEC.test(evidence.行号范围))) report("AR-VERIFY", `${where}.行号范围`, `${quoted(evidence.行号范围)} 不是行号范围（如 "64-72" 或 "21,25"）`);
        if (has("推理") && !isText(evidence.推理)) report("AR-VERIFY", `${where}.推理`, "必须是非空文本");
        break;
      case "本机测试":
        for (const field of ["测试名称", "命令"]) if (has(field) && !isText(evidence[field])) report("AR-VERIFY", `${where}.${field}`, "必须是非空文本");
        if (!missing(evidence.记录)) checkLogReference(evidence.记录, `${where}.记录`, context, report);
        break;
      case "CI_Pipeline 运行":
        if (has("run id") && (typeof evidence["run id"] !== "string" || !DIGITS.test(evidence["run id"]))) report("AR-VERIFY", `${where}.run id`, "必须是运行页面 URL 中的数字 ID");
        if (has("步骤") && !isTextList(evidence.步骤)) report("AR-VERIFY", `${where}.步骤`, "必须是至少一项的步骤名称列表（与结论相关的实际执行步骤，Requirement 7.7）");
        if (!missing(evidence.记录)) checkLogReference(evidence.记录, `${where}.记录`, context, report);
        break;
      case "外部环境测试":
        if (has("环境") && !isText(evidence.环境)) report("AR-VERIFY", `${where}.环境`, "必须是非空文本（如 4090 主机或 Linux 主机）");
        if (has("日期") && !isValidDate(evidence.日期)) report("AR-VERIFY", `${where}.日期`, "必须是合法的 YYYY-MM-DD 日期");
        if (has("记录")) checkLogReference(evidence.记录, `${where}.记录`, context, report);
        break;
      default:
        break;
    }
  });
}

function checkVerifications(list, context, report) {
  if (missing(list)) return [];
  if (!Array.isArray(list)) {
    report("AR-VERIFY", "核实", "必须是列表，每项为 { 提交, 方法, 结论, 证据 }");
    return [];
  }
  list.forEach((item, index) => {
    const at = `核实[${index}]`;
    if (!isMapping(item)) return report("AR-VERIFY", at, "必须是 { 提交, 方法, 结论, 证据 } 映射");
    if (missing(item.提交)) report("AR-VERIFY", `${at}.提交`, "缺少字段（Requirement 7.6）");
    else if (!isCommit(item.提交)) report("AR-VERIFY", `${at}.提交`, "必须是 7 至 40 位小写十六进制提交 SHA");
    if (missing(item.方法)) report("AR-VERIFY", `${at}.方法`, "缺少字段（Requirement 7.6）");
    else if (!VERIFY_METHODS.includes(item.方法)) report("AR-VERIFY", `${at}.方法`, `取值 ${quoted(item.方法)} 不是 ${VERIFY_METHODS.join("、")} 之一`);
    if (missing(item.结论)) report("AR-VERIFY", `${at}.结论`, "缺少字段（Requirement 7.6）");
    else if (!VERIFY_CONCLUSIONS.includes(item.结论)) report("AR-VERIFY", `${at}.结论`, `取值 ${quoted(item.结论)} 不是 ${VERIFY_CONCLUSIONS.join("、")} 之一`);
    if (VERIFY_METHODS.includes(item.方法)) checkEvidence(item.方法, item.证据, at, context, report);
    else if (missing(item.证据)) report("AR-VERIFY", `${at}.证据`, "缺少字段（Requirement 7.7）");
  });
  return list;
}

function checkFix(fix, report) {
  if (missing(fix)) return;
  if (!isMapping(fix)) return report("AR-FIX", "修复", "必须是 { 提交, 回归测试, 修复前失败, 修复后通过 } 映射");
  if (!missing(fix.提交) && !isCommit(fix.提交)) report("AR-FIX", "修复.提交", "必须是 7 至 40 位小写十六进制提交 SHA（Requirement 7.11）");
  if (!missing(fix.回归测试) && !isTextList(fix.回归测试)) report("AR-FIX", "修复.回归测试", "必须是至少一项的回归测试名称列表（Requirement 7.11）");
  for (const field of ["修复前失败", "修复后通过"]) {
    if (!missing(fix[field]) && !isFixEvidence(fix[field])) report("AR-FIX", `修复.${field}`, "必须是 { 命令, 提交 }（本机测试的命令与所在提交）或 { run id }（CI_Pipeline 运行），Requirement 7.12");
  }
}

/** Label of a check or step name per LOCAL_CHECKS / CI_ONLY_STEPS, or null when it is in neither list. */
function labelOf(name, resolver) {
  if (!isText(name)) return null;
  const candidates = name.startsWith("Run ") ? [name.slice(4), name] : [name];
  for (const candidate of candidates) {
    const resolved = resolver.resolveName(candidate);
    if (resolved) return resolved.label;
  }
  return null;
}

/**
 * Requirement 7.9: the basis of a 已否定 conclusion is a code reading record
 * (file, line range, reasoning) or a behavioral test with its execution
 * evidence. A test counts as behavioral when LOCAL_CHECKS or CI_ONLY_STEPS
 * label it behavioral, or when the evidence cites (`记录`) a valid
 * VERIFICATION_LOG entry whose verdict is 行为验证. Static checks never do.
 */
function negationBasis(item, context) {
  const items = evidenceItems(item.证据) ?? [];
  if (items.length === 0) return "已否定缺少否定依据（Requirement 7.9）";
  if (item.方法 === "代码阅读") {
    const complete = items.every((evidence) => isText(evidence.文件) && typeof evidence.行号范围 === "string" && LINE_SPEC.test(evidence.行号范围) && isText(evidence.推理));
    return complete ? null : "否定依据不完整：代码阅读必须写明文件、行号范围与推理（Requirement 7.9）";
  }
  const behavioralLog = items.some((evidence) => {
    const entry = isEntryId(evidence.记录) ? context.vlog?.get(evidence.记录) : null;
    return Boolean(entry) && entry.valid !== false && entry.verdict === "行为验证";
  });
  if (item.方法 === "外部环境测试") {
    return behavioralLog ? null : "外部环境测试作为否定依据时，记录 必须引用 VERIFICATION_LOG 中判定为行为验证的条目（Requirement 7.9）";
  }
  const local = item.方法 === "本机测试";
  const executed = items.every((evidence) => (local ? isText(evidence.命令) : typeof evidence["run id"] === "string" && DIGITS.test(evidence["run id"])));
  if (!executed) return `否定依据缺少执行证据（${local ? "本机测试的命令" : "CI_Pipeline 运行的 run id"}，Requirement 7.9）`;
  const names = local ? items.map((evidence) => evidence.测试名称) : items.flatMap((evidence) => (Array.isArray(evidence.步骤) ? evidence.步骤 : []));
  const labels = names.map((name) => labelOf(name, context.resolver));
  if (labels.includes("behavioral") || behavioralLog) return null;
  if (labels.includes("static")) return `否定依据只有 static 检查（${names.filter((name, index) => labels[index] === "static").join("、")}）；只有 Static_Gate 通过不构成否定依据（Requirement 7.9）`;
  return `无法确认否定依据是 Behavioral_Test：${names.join("、") || "（无名称）"} 不在 LOCAL_CHECKS 或 CI_ONLY_STEPS 中，证据也没有引用判定为行为验证的 VERIFICATION_LOG 条目（Requirement 7.9）`;
}

function checkNegation(data, requirements, context, report) {
  const last = lastVerification(data.核实);
  const negated = last?.item.结论 === "已否定";
  const noFix = data.无需修复;
  if (!missing(noFix)) {
    if (!Array.isArray(noFix) || !noFix.every((item) => typeof item === "string" && ACCEPTANCE_CRITERION.test(item))) {
      report("AR-NEGATE", "无需修复", "必须是 \"需求编号.条目编号\" 的列表（如 25.4），没有时写 []（Requirement 7.10）");
    } else {
      for (const item of noFix) {
        const requirement = ACCEPTANCE_CRITERION.exec(item)[1];
        if (!requirements.includes(requirement)) report("AR-NEGATE", "无需修复", `${item} 不属于本记录的对应需求（${requirements.join("、") || "无"}），Requirement 7.10`);
      }
      if (!negated && noFix.length > 0) report("AR-NEGATE", "无需修复", "只有核实结论为已否定的问题可以把验收标准标为无需修复（Requirement 7.10）");
    }
  }
  if (!negated) return;
  if (missing(noFix)) report("AR-NEGATE", "无需修复", "核实结论为已否定时必须有 无需修复 键；没有仅为修复该问题而设的验收标准时写 []（Requirement 7.10）");
  const problem = negationBasis(last.item, context);
  if (problem) report("AR-NEGATE", `核实[${last.index}]`, problem);
}

/**
 * Validates one parsed record (data is the YAML mapping). Problems carry the
 * error codes of design part 1 §7.3.
 * @param {{ id: string, title: string, data: object }} record
 * @param {{ resolver: ReturnType<typeof createCheckResolver>, vlog: Map<string, { verdict?: string, valid?: boolean }>|null }} context
 * @returns {Array<{ code: string, field: string, message: string }>}
 */
export function validateRecord(record, context) {
  const problems = [];
  const report = (code, field, message) => problems.push({ code, field, message });
  const { id, data } = record;
  const match = ISSUE_ID.exec(id);
  const prefix = match?.[1] ?? null;
  const isNew = prefix === "N";
  const fromReport = REPORT_ISSUE_IDS.includes(id);

  if (missing(data.编号)) report("AR-FIELD", "编号", "缺少字段（Requirement 7.3）");
  else if (data.编号 !== id) report("AR-FIELD", "编号", `${quoted(data.编号)} 与 ### 标题中的编号 ${id} 不一致`);
  if (!isText(record.title)) report("AR-FIELD", "标题", "### 标题缺少问题标题（### <编号> <标题>）");
  if (missing(data.标题)) report("AR-FIELD", "标题", "缺少字段");
  else if (!isText(data.标题)) report("AR-FIELD", "标题", "必须是非空文本");
  else if (isText(record.title) && data.标题 !== record.title) report("AR-FIELD", "标题", `${quoted(data.标题)} 与 ### 标题中的文字 ${quoted(record.title)} 不一致`);

  if (missing(data.来源)) report("AR-FIELD", "来源", "缺少字段");
  else if (!isText(data.来源)) report("AR-FIELD", "来源", "必须是非空文本");
  else if (fromReport) {
    const expected = `审计报告 §${REPORT_SERIES[prefix].section} ${id}`;
    if (data.来源 !== expected) report("AR-FIELD", "来源", `必须写作 ${quoted(expected)}（按章节引用审计报告）`);
  }
  const mark = data.来源标记;
  if (missing(mark)) report("AR-FIELD", "来源标记", "缺少字段（Requirement 7.5 的初始状态由它决定）");
  else if (!SOURCE_MARKS.includes(mark)) report("AR-FIELD", "来源标记", `取值 ${quoted(mark)} 不是 ${SOURCE_MARKS.join("、")} 之一`);
  else if (fromReport && mark !== REPORT_SOURCE_MARKS[id]) report("AR-FIELD", "来源标记", `审计报告对 ${id} 的标记是 ${REPORT_SOURCE_MARKS[id]}，此处写 ${mark}`);
  else if (isNew && mark !== "新发现") report("AR-FIELD", "来源标记", `新缺陷的来源标记必须是 新发现，此处写 ${mark}`);

  if (prefix === "L" && fromReport) {
    const number = Number(match[2]);
    const expected = REPORT_LOW_ITEMS[number - 1];
    if (missing(data.原始描述)) report("AR-LOW-TEXT", "原始描述", `缺少字段；必须逐字写作 ${quoted(expected)}（Requirement 7.2）`);
    else if (data.原始描述 !== expected) report("AR-LOW-TEXT", "原始描述", `${quoted(data.原始描述)} 与审计报告 §5 第 ${number} 个一级条目的原始描述 ${quoted(expected)} 不一致（Requirement 7.2）`);
  } else if (!missing(data.原始描述) && typeof data.原始描述 !== "string") {
    report("AR-FIELD", "原始描述", "必须是文本");
  }
  if (!missing(data.报告子项) && !isTextList(data.报告子项)) report("AR-FIELD", "报告子项", "必须是至少一项的文本列表");

  checkLocations(data.位置, report);
  if (missing(data.证据)) report("AR-FIELD", "证据", "缺少字段（Requirement 7.3：核实或修复前填写审计报告中的对应章节）");
  else if (!isTextList(data.证据)) report("AR-FIELD", "证据", "必须是至少一项的非空文本列表");
  const requirements = checkRequirements(data.对应需求, report);
  checkPriority(data.优先级, isNew, requirements, report);

  const verifications = checkVerifications(data.核实, context, report);
  checkFix(data.修复, report);
  if (!missing(data.修复) && UNREVIEWED_MARKS.includes(mark) && !verifications.some((item) => isMapping(item) && item.结论 === "已确认")) {
    report("AR-ORDER", "修复", `来源标记为 ${mark} 的问题在修复之前或同一提交中必须有结论为已确认的核实（Requirement 7.8）`);
  }
  checkNegation(data, requirements, context, report);

  const derived = deriveStatus(data);
  if (missing(data.状态)) report("AR-FIELD", "状态", "缺少字段（Requirement 7.3）");
  else if (!STATUSES.includes(data.状态)) report("AR-STATUS", "状态", `取值 ${quoted(data.状态)} 不是 ${STATUSES.join("、")} 之一（Requirement 7.4）`);
  else if (data.状态 !== derived) {
    if (data.状态 === "已修复") report("AR-FIX", "状态", `修复记录缺少或写错 ${missingFixParts(data.修复).join("、")}，不能标为已修复，状态保持 ${derived}（Requirement 7.11 至 7.13）`);
    else report("AR-STATUS", "状态", `写的是 ${data.状态}，按状态推导规则应为 ${derived}（Requirement 7.4、7.5）`);
  }
  return problems;
}

/**
 * Validates docs/AUDIT_REGISTER.md: structure, AR-SET over all record headings
 * (including records whose YAML failed to parse), every record, and the secret
 * patterns of design part 1 §6.1 (Requirement 6.8).
 * @param {string} text
 * @param {{ file?: string, resolver?: object, localChecks?: object[], ciOnlySteps?: object[], vlog?: Array<{ id: string, verdict?: string, valid?: boolean }> }} options
 *   `vlog` is the entry list of validateVerificationLog; without it, `记录`
 *   references are only checked for format and cannot support a 已否定.
 * @returns {{ records: Array<{ id, title, line, data, status, valid }>, errors: Array<{ code, id, field, message, line? }> }}
 */
export function validateAuditRegister(text, options = {}) {
  const file = options.file ?? DEFAULT_REGISTER_FILE;
  const resolver = options.resolver ?? createCheckResolver({ localChecks: options.localChecks ?? LOCAL_CHECKS, ciOnlySteps: options.ciOnlySteps ?? CI_ONLY_STEPS });
  const vlog = Array.isArray(options.vlog) ? new Map(options.vlog.map((entry) => [entry.id, entry])) : null;
  const parsed = parseAuditRegister(text);
  const errors = [...parsed.errors, ...checkSet(parsed.records, file)];
  const records = parsed.records.map((record) => {
    if (!record.data) return Object.freeze({ ...record, status: null, valid: false });
    const problems = validateRecord(record, { resolver, vlog });
    for (const problem of problems) errors.push({ id: record.id, line: record.line, ...problem });
    return Object.freeze({ ...record, status: deriveStatus(record.data), valid: problems.length === 0 });
  });
  for (const hit of scanSecrets(text)) errors.push({ code: "SECRET", id: `${file}:${hit.line}`, field: "", message: `命中机密模式 ${hit.pattern}；文档只写证据引用，不写机密值（Requirement 6.8）`, line: hit.line });
  return { records, errors };
}

/** Number of records per derived state, in STATUSES order (records whose YAML failed are left out). */
export function countByStatus(records) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const record of records) if (record.status) counts[record.status] += 1;
  return counts;
}
