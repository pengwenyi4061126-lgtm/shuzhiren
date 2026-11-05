// Schema and checks of docs/DEPLOYMENT_READINESS.md, the Readiness_Matrix
// (design part 1 §6.1-6.5, Data Models "文档 schema（第 1 部分）", "外部先决条件";
// design part 8 Requirement 40 §6.1; Requirement 6.1-6.8, 13.9, 14.15, 15.14,
// 31.17, 32.10, 32.11, 39.16, 40.1, 40.5-40.7).
//
// Document structure (sections are `## ` headings):
//   ## 状态定义            the six statuses word for word
//   ## 真实开播放行条件    the two go-live conditions of Requirement 6.5
//   ## 外部先决条件        EP table, header EP_HEADER
//   ## 仓库交付项          RW table, header RW_HEADER
//   ## 待决策事项          decision table, header DECISION_HEADER, row D1
//   ## 发布判定
// Row ids: `EP-NN` rows are External_Prerequisite rows with an extra 已满足 or
// 未满足 column; `RW-NNN-MM` rows are repository deliverables (NNN is the main
// requirement number, 000 for deliverables outside Requirement 1-40) with one
// of the other five statuses.
//
// parseReadinessMatrix, validateReadinessMatrix, d1Decision and splitTableRow do
// no I/O. Every error is { code, line, message }; check-governance-docs.mjs
// prints `<code> docs/DEPLOYMENT_READINESS.md:<line> <message>`.
import { isValidDate, scanSecrets } from "./verification-log.mjs";

export const MATRIX_FILE = "docs/DEPLOYMENT_READINESS.md";

export const STATUS_VERIFIED = "代码已完成且有验证证据";
export const STATUS_PENDING_CI = "代码已完成但待 CI 或 Linux 验证";
export const STATUS_PENDING_EXTERNAL = "代码已完成但待外部环境验证";
export const STATUS_NOT_DONE = "代码未完成";
export const STATUS_EXTERNAL = "External_Prerequisite";
export const STATUS_DECISION = "待用户决策";
/** The six statuses of Requirement 6.1, word for word. */
export const MATRIX_STATUSES = Object.freeze([STATUS_VERIFIED, STATUS_PENDING_CI, STATUS_PENDING_EXTERNAL, STATUS_NOT_DONE, STATUS_EXTERNAL, STATUS_DECISION]);
/** Statuses an RW row may take (Requirement 6.7). */
export const RW_STATUSES = Object.freeze(MATRIX_STATUSES.filter((status) => status !== STATUS_EXTERNAL));
export const EXTERNAL_CONDITIONS = Object.freeze(["已满足", "未满足"]);

export const ERROR_CODES = Object.freeze(["RM-HEADER", "RM-ID", "RM-STATUS", "RM-EP-REQUIRED", "RM-EP-EVIDENCE", "RM-RW-EVIDENCE", "RM-GO-LIVE", "RM-ENV-ROW", "RM-D1", "SECRET"]);

export const EP_HEADER = Object.freeze(["编号", "事项", "状态", "外部条件", "证据", "对应需求", "说明"]);
export const RW_HEADER = Object.freeze(["编号", "事项", "状态", "证据", "对应需求", "说明"]);
export const DECISION_HEADER = Object.freeze(["编号", "事项", "决定", "所选平台", "决策日期", "覆盖规格"]);

export const SECTION_STATUS = "状态定义";
export const SECTION_GO_LIVE = "真实开播放行条件";
export const SECTION_EP = "外部先决条件";
export const SECTION_RW = "仓库交付项";
export const SECTION_DECISIONS = "待决策事项";
export const SECTION_RELEASE = "发布判定";
export const REQUIRED_SECTIONS = Object.freeze([SECTION_STATUS, SECTION_GO_LIVE, SECTION_EP, SECTION_RW, SECTION_DECISIONS, SECTION_RELEASE]);

/**
 * 事项 text of the required External_Prerequisite rows. EP-01 to EP-11 freeze
 * Requirement 6.2; EP-12 (13.9), EP-13 and EP-14 (39.16) freeze the design's
 * "外部先决条件" table. Compared after trimming only.
 */
export const REQUIRED_EXTERNAL_ROWS = Object.freeze({
  "EP-01": "4090 GPU 主机及端到端推流试播（至少 30 分钟的内部试播）",
  "EP-02": "平台账号、应用审核、OAuth scope、RTMP 推流地址与 Stream_Secret",
  "EP-03": "OIDC 提供商",
  "EP-04": "TLS 证书与反向代理",
  "EP-05": "KMS 或 HSM 与签名私钥",
  "EP-06": "对象存储版本化与保留锁",
  "EP-07": "受许可的模型权重",
  "EP-08": "授权素材（肖像、声音、音乐、商品、脚本）",
  "EP-09": "输出、素材、录制和渠道证据 verifier 的部署",
  "EP-10": "OCI registry 与受信签名 runner",
  "EP-11": "4 小时单路验收证据（试播时长至少 240 分钟，同时运行的数字人数为 1）",
  "EP-12": "`release-production` environment 的 GitHub 设置：部署分支仅限受保护分支；至少一名必需审核人；`REGISTRY_USERNAME`、`REGISTRY_PASSWORD` 和五个签名与构建变量只定义在该 environment（Requirement 13.9）",
  "EP-13": "模型权重许可证审查：LiveTalking_Runtime `--model musetalk` 从 `MODEL_VOLUME_PATH` 加载的权重（Requirement 39.16）",
  "EP-14": "模型权重许可证审查：CosyVoice_Service 从 `COSYVOICE_MODEL_PATH` 加载的模型（当前模板为 Fun-CosyVoice3-0.5B-2512）（Requirement 39.16）"
});

/**
 * Acceptance criteria that can only be verified on the 4090 host, a Linux host
 * or the release-production environment (Testing Strategy (f); Requirement
 * 14.15, 15.14, 31.17, 32.10, 32.11). Each needs exactly one RW row whose 事项
 * starts with the criterion number.
 */
export const REQUIRED_ENVIRONMENT_ROWS = Object.freeze([
  Object.freeze({ criterion: "13.7", environment: "release" }),
  Object.freeze({ criterion: "14.1", environment: "4090" }),
  Object.freeze({ criterion: "14.6", environment: "4090" }),
  Object.freeze({ criterion: "14.7", environment: "4090" }),
  Object.freeze({ criterion: "14.8", environment: "4090" }),
  Object.freeze({ criterion: "15.14(a)", environment: "4090" }),
  Object.freeze({ criterion: "15.14(b)", environment: "4090" }),
  Object.freeze({ criterion: "15.14(c)", environment: "4090" }),
  Object.freeze({ criterion: "15.14(d)", environment: "4090" }),
  Object.freeze({ criterion: "31.4", environment: "4090" }),
  Object.freeze({ criterion: "31.5", environment: "4090" }),
  Object.freeze({ criterion: "31.6", environment: "4090" }),
  Object.freeze({ criterion: "32.7", environment: "4090" }),
  Object.freeze({ criterion: "32.8", environment: "4090" }),
  Object.freeze({ criterion: "32.1", environment: "Linux" })
]);

/** Key texts of the go-live section (Requirement 6.5); all must appear. */
export const GO_LIVE_PHRASES = Object.freeze(["缺任一项即不放行", "npm run runtime:acceptance:verify", "退出码 0", "全部 External_Prerequisite 行", "已满足"]);

export const D1_PENDING = STATUS_DECISION;
export const D1_DECIDED = "已决定";
/** RW rows of Requirement 40.1 that follow decision D1. */
export const D1_ROWS = Object.freeze(["RW-040-01", "RW-040-02", "RW-040-03", "RW-040-04"]);
const D1_DECIDED_STATUSES = Object.freeze([STATUS_NOT_DONE, STATUS_PENDING_CI, STATUS_VERIFIED]);

export const NONE_CELL = "—";
const EP_ID = /^EP-\d{2}$/;
const RW_ID = /^RW-(\d{3})-(\d{2})$/;
const ENTRY_REF = /^V-\d{8}-\d{2}$/;
const EP_EVIDENCE = /^位置=(.+?)，日期=(\d{4}-\d{2}-\d{2})，提供方=(.+)$/;
/** Evidence that never counts as auditable (Requirement 6.3). */
const WEAK_EVIDENCE = /\/healthz|fixture|开发态|容器\s*`?running`?|running\s*状态|口头/i;
const SPEC_PATH = /^(?:[^\s:`]+:)?[^\s:`]+$/;
const RUNNABLE_CATEGORIES = Object.freeze(["本机运行", "CI 或 Linux 运行"]);

const normalizeNewlines = (text) => String(text).replace(/\r\n?/g, "\n");
const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const short = (text, limit = 80) => {
  const value = String(text).replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
};

/**
 * Cells of a Markdown table row; `\|` is an escaped pipe inside a cell.
 * Returns null when the line is not a table row.
 */
export function splitTableRow(line) {
  const trimmed = String(line).trim();
  if (!trimmed.startsWith("|")) return null;
  const cells = [];
  let current = "";
  for (let i = 1; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char === "\\" && trimmed[i + 1] === "|") {
      current += "\\|";
      i += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() !== "") cells.push(current.trim());
  return cells;
}

const isSeparatorRow = (cells) => cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));

function readTable(lines, start, end) {
  for (let index = start; index < end; index += 1) {
    const cells = splitTableRow(lines[index]);
    if (!cells) continue;
    const table = { headerLine: index + 1, header: cells, rows: [] };
    let cursor = index + 1;
    const separator = cursor < end ? splitTableRow(lines[cursor]) : null;
    if (separator && isSeparatorRow(separator)) cursor += 1;
    else table.missingSeparator = true;
    for (; cursor < end; cursor += 1) {
      const row = splitTableRow(lines[cursor]);
      if (!row) break;
      table.rows.push({ line: cursor + 1, cells: row });
    }
    return table;
  }
  return null;
}

/**
 * Splits the matrix into sections and tables.
 * @returns {{ sections: Map<string, { line: number, start: number, end: number }>, lines: string[],
 *   ep: object|null, rw: object|null, decisions: object|null,
 *   rows: Array<{ id, kind: "EP"|"RW", line, cells, item, status, condition?, evidence, requirements, note }>,
 *   decisionRows: Array<{ id, line, cells, item, decision, platform, date, spec }> }}
 */
export function parseReadinessMatrix(text) {
  const lines = normalizeNewlines(text).split("\n");
  const sections = new Map();
  const headings = [];
  let fence = false;
  lines.forEach((line, index) => {
    if (/^(`{3,}|~{3,})/.test(line.trim())) fence = !fence;
    if (fence) return;
    const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (heading && !line.startsWith("###")) headings.push({ name: heading[1], index });
  });
  headings.forEach((heading, position) => {
    const end = position + 1 < headings.length ? headings[position + 1].index : lines.length;
    if (!sections.has(heading.name)) sections.set(heading.name, { line: heading.index + 1, start: heading.index + 1, end });
  });
  const tableOf = (name) => {
    const section = sections.get(name);
    return section ? readTable(lines, section.start, section.end) : null;
  };
  const ep = tableOf(SECTION_EP);
  const rw = tableOf(SECTION_RW);
  const decisions = tableOf(SECTION_DECISIONS);
  const rows = [];
  for (const [kind, table] of [["EP", ep], ["RW", rw]]) {
    if (!table) continue;
    for (const row of table.rows) {
      const [id = "", item = "", status = ""] = row.cells;
      const record = { id, kind, table: kind, line: row.line, cells: row.cells, item, status };
      if (kind === "EP") Object.assign(record, { condition: row.cells[3] ?? "", evidence: row.cells[4] ?? "", requirements: row.cells[5] ?? "", note: row.cells[6] ?? "" });
      else Object.assign(record, { evidence: row.cells[3] ?? "", requirements: row.cells[4] ?? "", note: row.cells[5] ?? "" });
      rows.push(record);
    }
  }
  const decisionRows = (decisions?.rows ?? []).map((row) => {
    const [id = "", item = "", decision = "", platform = "", date = "", spec = ""] = row.cells;
    return { id, line: row.line, cells: row.cells, item, decision, platform, date, spec };
  });
  return { lines, sections, ep, rw, decisions, rows, decisionRows };
}

/** Decision D1 of `## 待决策事项`, or null when the row is missing. */
export function d1Decision(matrix) {
  const parsed = typeof matrix === "string" ? parseReadinessMatrix(matrix) : matrix;
  const row = parsed?.decisionRows?.find((item) => item.id === "D1");
  if (!row) return null;
  return Object.freeze({ decision: row.decision, platform: row.platform, date: row.date, spec: row.spec, line: row.line });
}

/** Status of each row id (EP rows also carry their 外部条件). */
export function matrixStatusById(matrix) {
  const parsed = typeof matrix === "string" ? parseReadinessMatrix(matrix) : matrix;
  const map = new Map();
  for (const row of parsed?.rows ?? []) if (!map.has(row.id)) map.set(row.id, { status: row.status, condition: row.condition ?? null, line: row.line });
  return map;
}

const splitReferences = (cell) => String(cell).split("；").map((part) => part.trim()).filter((part) => part !== "");

function sameHeader(actual, expected) {
  return actual.length === expected.length && actual.every((cell, index) => cell === expected[index]);
}

function entryProblems(entry) {
  if (!entry) return "VERIFICATION_LOG 中没有该条目";
  if (entry.valid === false) return "该条目未通过 VERIFICATION_LOG 校验";
  if (entry.verdict !== "行为验证") return `该条目的判定为 ${entry.verdict ?? "未知"}，不是行为验证`;
  const sources = Array.isArray(entry.data?.依据来源) ? entry.data.依据来源 : [];
  if (!sources.some((source) => isMapping(source) && RUNNABLE_CATEGORIES.includes(source.类别))) return "该条目没有类别为本机运行或 CI 或 Linux 运行的来源";
  return null;
}

const hasLinuxSource = (entry) => (Array.isArray(entry?.data?.依据来源) ? entry.data.依据来源 : []).some((source) => isMapping(source) && source.类别 === "CI 或 Linux 运行" && source.平台 === "Linux");

/** Leading acceptance-criterion number of an RW 事项 (`15.14(a)：…` → `15.14(a)`), or null. */
export function rowCriterion(item) {
  const match = /^(\d+\.\d+)\s*(?:[（(]\s*([a-z])\s*[)）])?\s*[：:\s]/.exec(String(item).replace(/`/g, ""));
  if (!match) return null;
  return match[2] ? `${match[1]}(${match[2]})` : match[1];
}

function checkRequirementsCell(row, report) {
  const cell = row.requirements.trim();
  const rw = RW_ID.exec(row.id);
  if (cell === "无") {
    if (!(rw && rw[1] === "000")) report("RM-ID", row.line, `${row.id} 的对应需求只有 RW-000-NN 行可以写"无"`);
    return;
  }
  const parts = cell.split(/[,，]/).map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !/^[1-9]\d*$/.test(part) || Number(part) > 40)) {
    report("RM-ID", row.line, `${row.id} 的对应需求必须是逗号分隔的需求编号（1 至 40）`);
    return;
  }
  if (rw && rw[1] !== "000" && !parts.includes(String(Number(rw[1])))) report("RM-ID", row.line, `${row.id} 的对应需求必须包含主需求 ${Number(rw[1])}`);
  if (rw && rw[1] === "000") report("RM-ID", row.line, `${row.id} 是 RW-000-NN 行，对应需求必须写"无"`);
}

/**
 * Validates docs/DEPLOYMENT_READINESS.md.
 * @param {string} text the matrix document.
 * @param {{ vlog?: Array<{ id, verdict, valid, data }>|null }} options validated
 *   VERIFICATION_LOG entries; null when the log could not be parsed, in which
 *   case every 代码已完成且有验证证据 row is reported as lacking evidence (§6.4).
 * @returns {Array<{ code: string, line: number, message: string }>}
 */
export function validateReadinessMatrix(text, options = {}) {
  const errors = [];
  const report = (code, line, message) => errors.push({ code, line, message });
  const vlog = Array.isArray(options.vlog) ? new Map(options.vlog.map((entry) => [entry.id, entry])) : null;
  const matrix = parseReadinessMatrix(text);
  const { sections, lines } = matrix;

  for (const name of REQUIRED_SECTIONS) {
    if (sections.has(name)) continue;
    const code = name === SECTION_GO_LIVE ? "RM-GO-LIVE" : name === SECTION_DECISIONS ? "RM-D1" : "RM-HEADER";
    report(code, 1, `缺少 "## ${name}" 一节`);
  }

  const statusSection = sections.get(SECTION_STATUS);
  if (statusSection) {
    const body = lines.slice(statusSection.start, statusSection.end).join("\n");
    for (const status of MATRIX_STATUSES) if (!body.includes(status)) report("RM-STATUS", statusSection.line, `状态定义一节没有逐字列出状态"${status}"`);
  }

  const goLive = sections.get(SECTION_GO_LIVE);
  if (goLive) {
    const body = lines.slice(goLive.start, goLive.end).join("\n");
    for (const phrase of GO_LIVE_PHRASES) if (!body.includes(phrase)) report("RM-GO-LIVE", goLive.line, `真实开播放行条件一节缺少关键文本"${phrase}"（Requirement 6.5）`);
  }

  for (const [name, table, header] of [[SECTION_EP, matrix.ep, EP_HEADER], [SECTION_RW, matrix.rw, RW_HEADER], [SECTION_DECISIONS, matrix.decisions, DECISION_HEADER]]) {
    if (!sections.has(name)) continue;
    const code = name === SECTION_DECISIONS ? "RM-D1" : "RM-HEADER";
    if (!table) {
      report(code, sections.get(name).line, `"## ${name}" 一节没有表格`);
      continue;
    }
    if (!sameHeader(table.header, header)) report(code, table.headerLine, `表头必须为 | ${header.join(" | ")} |`);
    if (table.missingSeparator) report(code, table.headerLine, "表头下一行必须是分隔行");
    for (const row of table.rows) if (row.cells.length !== header.length) report(code, row.line, `该行有 ${row.cells.length} 个单元格，表头有 ${header.length} 个；单元格内的 | 必须写成 \\|`);
  }

  const seen = new Map();
  for (const row of matrix.rows) {
    const expected = row.kind === "EP" ? EP_HEADER.length : RW_HEADER.length;
    if (row.cells.length !== expected) continue;
    const idPattern = row.kind === "EP" ? EP_ID : RW_ID;
    if (!idPattern.test(row.id)) {
      const other = row.kind === "EP" ? RW_ID : EP_ID;
      report("RM-ID", row.line, other.test(row.id) ? `${row.id} 不能写在 ${row.kind === "EP" ? SECTION_EP : SECTION_RW} 表中` : `编号 ${short(row.id, 30)} 不符合 ${row.kind === "EP" ? "EP-NN" : "RW-NNN-MM"}`);
      continue;
    }
    if (seen.has(row.id)) {
      report("RM-ID", row.line, `编号 ${row.id} 重复（第 ${seen.get(row.id)} 行已有）`);
      continue;
    }
    seen.set(row.id, row.line);
    if (!MATRIX_STATUSES.includes(row.status)) {
      report("RM-STATUS", row.line, `${row.id} 的状态"${short(row.status, 40)}"不是六个状态之一`);
    } else if (row.kind === "EP" && row.status !== STATUS_EXTERNAL) {
      report("RM-STATUS", row.line, `${row.id} 是外部先决条件行，状态必须为 ${STATUS_EXTERNAL}`);
    } else if (row.kind === "RW" && row.status === STATUS_EXTERNAL) {
      report("RM-STATUS", row.line, `${row.id} 是仓库交付行，状态不能是 ${STATUS_EXTERNAL}（Requirement 6.7）`);
    }
    checkRequirementsCell(row, report);
    if (row.kind === "EP") checkExternalRow(row, report);
    else checkRepositoryRow(row, vlog, report);
  }

  const epRows = new Map(matrix.rows.filter((row) => row.kind === "EP" && EP_ID.test(row.id)).map((row) => [row.id, row]));
  for (const [id, item] of Object.entries(REQUIRED_EXTERNAL_ROWS)) {
    const row = epRows.get(id);
    if (!row) report("RM-EP-REQUIRED", matrix.ep?.headerLine ?? 1, `缺少外部先决条件行 ${id}（${short(item, 40)}）`);
    else if (row.item.trim() !== item) report("RM-EP-REQUIRED", row.line, `${id} 的事项必须逐字为"${short(item, 60)}"`);
  }

  checkEnvironmentRows(matrix, vlog, report);
  checkDecision(matrix, report);

  for (const hit of scanSecrets(text)) report("SECRET", hit.line, `命中机密模式 ${hit.pattern}；文档只写证据引用，不写机密值（Requirement 6.8）`);
  return errors.sort((a, b) => a.line - b.line);
}

function checkExternalRow(row, report) {
  if (!EXTERNAL_CONDITIONS.includes(row.condition)) {
    report("RM-EP-EVIDENCE", row.line, `${row.id} 的外部条件必须是"已满足"或"未满足"`);
    return;
  }
  if (row.condition !== "已满足") return;
  const references = row.evidence.trim() === NONE_CELL ? [] : splitReferences(row.evidence);
  if (references.length === 0) {
    report("RM-EP-EVIDENCE", row.line, `${row.id} 标为已满足，但证据为空；必须写 位置=…，日期=YYYY-MM-DD，提供方=…（Requirement 6.3）`);
    return;
  }
  for (const reference of references) {
    const match = EP_EVIDENCE.exec(reference);
    if (!match) {
      report("RM-EP-EVIDENCE", row.line, `${row.id} 的证据"${short(reference, 40)}"不是 位置=…，日期=YYYY-MM-DD，提供方=… 格式`);
    } else if (!isValidDate(match[2])) {
      report("RM-EP-EVIDENCE", row.line, `${row.id} 的证据日期 ${match[2]} 不是合法的 YYYY-MM-DD 日期`);
    } else if (match[1].trim() === "" || match[3].trim() === "" || match[3].trim() === NONE_CELL) {
      report("RM-EP-EVIDENCE", row.line, `${row.id} 的证据缺少位置或提供方`);
    } else if (WEAK_EVIDENCE.test(match[1])) {
      report("RM-EP-EVIDENCE", row.line, `${row.id} 的证据位置只引用开发 fixture、/healthz、容器 running 或口头确认，不是可审计证据（Requirement 6.3）`);
    }
  }
}

function checkRepositoryRow(row, vlog, report) {
  const cell = row.evidence.trim();
  const references = cell === NONE_CELL || cell === "" ? [] : splitReferences(cell);
  const malformed = references.filter((reference) => !ENTRY_REF.test(reference));
  if (malformed.length > 0) report("RM-RW-EVIDENCE", row.line, `${row.id} 的证据列只能写 — 或以；分隔的 V-YYYYMMDD-NN 编号，此处有"${short(malformed[0], 40)}"`);
  const valid = references.filter((reference) => ENTRY_REF.test(reference));
  if (row.status !== STATUS_VERIFIED) {
    if (vlog) for (const reference of valid) if (!vlog.has(reference)) report("RM-RW-EVIDENCE", row.line, `${row.id} 引用的 ${reference} 不在 VERIFICATION_LOG 中`);
    return;
  }
  if (valid.length === 0) {
    report("RM-RW-EVIDENCE", row.line, `${row.id} 标为${STATUS_VERIFIED}，但没有引用 V- 条目（Requirement 6.4）`);
    return;
  }
  if (!vlog) {
    report("RM-RW-EVIDENCE", row.line, `${row.id} 标为${STATUS_VERIFIED}，但 VERIFICATION_LOG 解析失败，引用按无证据处理（§6.4）`);
    return;
  }
  for (const reference of valid) {
    const problem = entryProblems(vlog.get(reference));
    if (problem) report("RM-RW-EVIDENCE", row.line, `${row.id} 引用的 ${reference} 不合格：${problem}（Requirement 6.4）`);
  }
}

function checkEnvironmentRows(matrix, vlog, report) {
  const rwRows = matrix.rows.filter((row) => row.kind === "RW" && RW_ID.test(row.id));
  const byCriterion = new Map();
  for (const row of rwRows) {
    const criterion = rowCriterion(row.item);
    if (!criterion) continue;
    if (!byCriterion.has(criterion)) byCriterion.set(criterion, []);
    byCriterion.get(criterion).push(row);
  }
  for (const { criterion, environment } of REQUIRED_ENVIRONMENT_ROWS) {
    const rows = byCriterion.get(criterion) ?? [];
    if (rows.length === 0) {
      report("RM-ENV-ROW", matrix.rw?.headerLine ?? 1, `缺少事项以 ${criterion} 开头的仓库交付行（环境：${environment}，Requirement 32.10）`);
      continue;
    }
    if (rows.length > 1) {
      report("RM-ENV-ROW", rows[1].line, `${criterion} 对应多行：${rows.map((row) => row.id).join("、")}`);
      continue;
    }
    const [row] = rows;
    if (row.status === STATUS_VERIFIED) {
      if (environment === "release") continue;
      const references = splitReferences(row.evidence).filter((reference) => ENTRY_REF.test(reference));
      if (vlog && !references.some((reference) => hasLinuxSource(vlog.get(reference)))) report("RM-ENV-ROW", row.line, `${row.id}（${criterion}，环境：${environment}）标为${STATUS_VERIFIED}，但引用的条目没有平台为 Linux 的 CI 或 Linux 运行来源`);
      continue;
    }
    const allowed = environment === "Linux" ? [STATUS_PENDING_CI, STATUS_NOT_DONE] : [STATUS_PENDING_EXTERNAL, STATUS_NOT_DONE];
    if (!allowed.includes(row.status)) report("RM-ENV-ROW", row.line, `${row.id}（${criterion}，环境：${environment}）没有合格证据时只能标为${allowed.join("或")}（Requirement 32.11）`);
  }
}

function checkDecision(matrix, report) {
  if (!matrix.decisions) return;
  const rows = matrix.decisionRows.filter((row) => row.id === "D1");
  if (rows.length === 0) {
    report("RM-D1", matrix.decisions.headerLine, "待决策事项表缺少 D1 行");
    return;
  }
  if (rows.length > 1) report("RM-D1", rows[1].line, "D1 行重复");
  const d1 = rows[0];
  const rwById = new Map(matrix.rows.filter((row) => row.kind === "RW").map((row) => [row.id, row]));
  const missing = D1_ROWS.filter((id) => !rwById.has(id));
  for (const id of missing) report("RM-D1", d1.line, `缺少 Requirement 40.1 的行 ${id}`);
  const present = D1_ROWS.filter((id) => rwById.has(id)).map((id) => rwById.get(id));
  if (d1.decision === D1_PENDING) {
    for (const [field, value] of [["所选平台", d1.platform], ["决策日期", d1.date], ["覆盖规格", d1.spec]]) if (value !== NONE_CELL) report("RM-D1", d1.line, `D1 待用户决策时${field}必须为 —`);
    for (const row of present) if (row.status !== STATUS_DECISION) report("RM-D1", row.line, `D1 待用户决策时 ${row.id} 的状态必须为${STATUS_DECISION}（Requirement 40.1）`);
    return;
  }
  if (d1.decision !== D1_DECIDED) {
    report("RM-D1", d1.line, `D1 的决定必须是"${D1_PENDING}"或"${D1_DECIDED}"`);
    return;
  }
  if (d1.platform.trim() === "" || d1.platform === NONE_CELL) report("RM-D1", d1.line, "D1 已决定时所选平台不能为空（Requirement 40.5）");
  if (!isValidDate(d1.date)) report("RM-D1", d1.line, `D1 的决策日期"${short(d1.date, 20)}"不是合法的 YYYY-MM-DD 日期（Requirement 40.5）`);
  const spec = d1.spec.replace(/`/g, "").trim();
  if (spec !== NONE_CELL && !SPEC_PATH.test(spec)) report("RM-D1", d1.line, "D1 的覆盖规格必须为 —、<路径> 或 <仓库或工作区>:<路径>（Requirement 40.7）");
  for (const row of present) if (!D1_DECIDED_STATUSES.includes(row.status)) report("RM-D1", row.line, `D1 已决定后 ${row.id} 的状态只能是${D1_DECIDED_STATUSES.join("、")}之一（Requirement 40.6）`);
}
