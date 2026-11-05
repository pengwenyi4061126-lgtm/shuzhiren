// Rules for the Handoff_Doc files and the other docs/*.md files (design part 1
// §4.1, §4.4, §5.1-5.5; design part 8 Requirement 40 §6.1-6.3; Requirement
// 4.1, 4.6, 4.7, 5.1-5.8, 40.2-40.4).
//
// Judgment units (splitUnits): a table cell, a list item (with its indented
// continuation lines), a heading, or a sentence of a paragraph cut at "。".
// The D1-* rules look at the sentences of each unit.
//
//   CLAIM          "已验证/已覆盖/已通过" without a VERIFICATION_LOG.md#v-… link to an
//                  entry whose verdict is not 未验证, and without "未验证" (docs/*.md
//                  and Handoff_Doc, except VERIFICATION_LOG.md and AUDIT_REGISTER.md).
//   CI-CLAIM       a unit names CI, a verb and an object of §5.1 without "未验证" or a
//                  qualifying `[run <id> @ <sha>](VERIFICATION_LOG.md#v-…)` reference.
//   RUN-REF        a run reference whose entry is missing, or whose GitHub Actions
//                  source with that run id and commit is not success in every step.
//   AUDIT-LIST     `## 审计问题状态` of RESUME_HANDOFF.md differs from the Audit_Register
//                  ids in state 已确认 or 需环境验证, or a line states another status.
//   CHECKPOINT     `## 当前检查点` of RESUME_HANDOFF.md lacks a fixed field or has a bad value.
//   STALE-SYNC     sync wording outside the checkpoint fields (Requirement 5.8).
//   MATRIX-STATUS  a unit naming an EP or RW id states a status other than the
//                  matrix's, names an id the matrix lacks, or marks "未验证" for an
//                  id the matrix lists as 代码已完成且有验证证据.
//   D1-MENTION, D1-STATUS, D1-DEFAULT  only while D1 is 待用户决策 (Requirement 40.2-40.4).
//
// All functions are pure; errors are { code, file, line, message }.
import { d1Decision, matrixStatusById, MATRIX_STATUSES, splitTableRow, STATUS_VERIFIED } from "./readiness-matrix.mjs";

export const HANDOFF_FILES = Object.freeze(["docs/RESUME_HANDOFF.md", "docs/FRAMEWORK_STATUS.md", "docs/IMPLEMENTATION_ROADMAP.md", "README.md"]);
export const RESUME_FILE = "docs/RESUME_HANDOFF.md";
/** docs/*.md files outside the CLAIM rule: they are the evidence records themselves. */
export const CLAIM_EXCLUDED_FILES = Object.freeze(["docs/VERIFICATION_LOG.md", "docs/AUDIT_REGISTER.md"]);
/**
 * docs/*.md files whose CLAIM hits are reported as NOTE instead of errors until
 * their maintainer processes them; remove a file from this list in the commit
 * that resolves its hits. Empty since docs/DEPLOYMENT_RUNBOOK.md resolved its hits.
 */
export const CLAIM_PENDING_FILES = Object.freeze([]);
export const ERROR_CODES = Object.freeze(["CLAIM", "CI-CLAIM", "RUN-REF", "AUDIT-LIST", "CHECKPOINT", "STALE-SYNC", "MATRIX-STATUS", "D1-MENTION", "D1-STATUS", "D1-DEFAULT"]);

export const CLAIM_WORDS = /已验证|已覆盖|已通过/;
export const UNVERIFIED = "未验证";
const CI_WORD = /(?<![A-Za-z])CI(?![A-Za-z])/;
const CI_VERB = /执行|覆盖|验证|负责|运行|渲染|构建|检查/;
const CI_OBJECT = /PostgreSQL|迁移|触发器|集成|Python|Gateway|Docker|镜像|compose|Compose/;
const LOG_LINK = /((?:docs\/)?)VERIFICATION_LOG\.md#(v-\d{8}-\d{2})/gi;
const RUN_REF = /\[run (\d+) @ ([0-9a-f]{7,40})\]\(((?:docs\/)?)VERIFICATION_LOG\.md#(v-\d{8}-\d{2})\)/g;
const MATRIX_ID = /\b(EP-\d{2}|RW-\d{3}-\d{2})\b/g;
const STALE_SYNC = /远端检查点|领先远端|落后远端|领先\s*\d+\s*个提交|落后\s*\d+\s*个提交/;
export const SYNC_STATE = /^(一致|领先 [1-9]\d* 个提交|落后 [1-9]\d* 个提交)$/;
export const D1_MENTION = /(目标|选定|具体)(平台|渠道)[^。；]{0,12}Adapter|平台\s*OAuth\s*\/\s*Webhook|(OAuth|Webhook|商品同步|账单)(\s*\/\s*(OAuth|Webhook|商品同步|账单))*\s*Adapter/;
export const D1_STATUS = /已完成|已实现|进行中|继续完成|仍需|仍待|待实现|外部前置条件|外部工作|部署方必须/;
export const D1_DEFAULT = /(首个|默认|已选定的?)(目标)?(直播)?平台(为|是|：)\s*(抖音|淘宝|视频号|快手|京东|小红书|Douyin|Taobao)|(抖音|淘宝|视频号|快手|京东|小红书)[^。]{0,8}(作为|为)(首个|默认)/;
const CHECKPOINT_SECTION = "当前检查点";
const AUDIT_SECTION = "审计问题状态";
const AUDIT_LISTED = Object.freeze(["已确认", "需环境验证"]);
const AUDIT_LINE = /^- ([CHMLN][1-9]\d*)：(\S+?)（\[登记\]\(AUDIT_REGISTER\.md#([a-z][1-9]\d*)\)）$/;
const CHECKPOINT_FIELDS = Object.freeze({
  核对日期: /^\d{4}-\d{2}-\d{2}$/,
  "origin/master": /^[0-9a-f]{40}$/,
  同步状态: SYNC_STATE,
  "最新 CI 运行": /^run (\d+)，提交 ([0-9a-f]{40})，结论 (success|failure|cancelled|timed_out)(?:，首个失败 job (\S+)，失败步骤序号 ([1-9]\d*))?$/
});

const normalizeNewlines = (text) => String(text).replace(/\r\n?/g, "\n");
const snippet = (text, limit = 80) => {
  const value = String(text).replace(/\s+/g, " ").trim();
  return value.length > limit ? value.slice(0, limit) : value;
};
const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Splits Markdown into judgment units, skipping fenced code blocks and table
 * separator rows. Each unit is { kind: "cell"|"item"|"heading"|"sentence", text, line }.
 */
export function splitUnits(text) {
  const lines = normalizeNewlines(text).split("\n");
  const units = [];
  let fence = null;
  let item = null;
  let paragraph = null;
  const flushItem = () => {
    if (item) units.push({ kind: "item", text: item.text, line: item.line });
    item = null;
  };
  const flushParagraph = () => {
    if (!paragraph) return;
    let start = null;
    let buffer = "";
    for (const part of paragraph) {
      for (const char of part.text) {
        if (start === null && /\S/.test(char)) start = part.line;
        buffer += char;
        if (char === "。") {
          if (buffer.trim() !== "") units.push({ kind: "sentence", text: buffer.trim(), line: start ?? part.line });
          buffer = "";
          start = null;
        }
      }
      buffer += "\n";
    }
    if (buffer.trim() !== "") units.push({ kind: "sentence", text: buffer.trim(), line: start ?? paragraph[0].line });
    paragraph = null;
  };
  const flush = () => {
    flushItem();
    flushParagraph();
  };
  lines.forEach((line, index) => {
    const number = index + 1;
    if (fence) {
      if (new RegExp(`^\\s*${fence}\\s*$`).test(line)) fence = null;
      return;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) {
      flush();
      fence = open[1][0] === "`" ? "`{3,}" : "~{3,}";
      return;
    }
    if (line.trim() === "") {
      flush();
      return;
    }
    const cells = splitTableRow(line);
    if (cells) {
      flush();
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return;
      for (const cell of cells) if (cell !== "") units.push({ kind: "cell", text: cell, line: number });
      return;
    }
    if (/^#{1,6}\s/.test(line)) {
      flush();
      units.push({ kind: "heading", text: line.replace(/^#{1,6}\s+/, "").trim(), line: number });
      return;
    }
    const marker = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (marker) {
      flush();
      item = { text: marker[1], line: number };
      return;
    }
    if (item && /^\s+\S/.test(line)) {
      item.text += line.trim();
      return;
    }
    flushItem();
    const content = line.replace(/^\s*>\s?/, "");
    if (!paragraph) paragraph = [];
    paragraph.push({ text: content, line: number });
  });
  flush();
  return units;
}

/** Sentences of one unit, cut after each "。". */
export function splitSentences(text) {
  return String(text)
    .split(/(?<=。)/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

function entryMap(vlog) {
  return new Map((Array.isArray(vlog) ? vlog : []).map((entry) => [entry.id, entry]));
}

/** Why a run reference does not qualify under Requirement 5.6, or null when it does. */
export function runReferenceProblem({ runId, sha, entryId }, vlog) {
  const entry = entryMap(vlog).get(entryId);
  if (!entry) return `VERIFICATION_LOG 中没有 ${entryId}`;
  const sources = Array.isArray(entry.data?.依据来源) ? entry.data.依据来源 : [];
  const source = sources.find((item) => isMapping(item) && item.平台 === "GitHub Actions" && item["run id"] === runId);
  if (!source) return `${entryId} 中没有 run id 为 ${runId} 的 GitHub Actions 来源`;
  if (typeof source.提交 !== "string" || !source.提交.startsWith(sha)) return `${entryId} 中 run ${runId} 的提交 ${source.提交 ?? "?"} 不以 ${sha} 开头`;
  if (source.运行结论 !== "success") return `run ${runId} 的运行结论为 ${source.运行结论 ?? "?"}，不是 success`;
  const steps = Array.isArray(source.步骤) ? source.步骤 : [];
  if (steps.length === 0) return `${entryId} 中 run ${runId} 没有列出步骤`;
  const bad = steps.find((step) => !isMapping(step) || step.结论 !== "success");
  if (bad) return `run ${runId} 的步骤"${snippet(bad?.步骤 ?? "?", 40)}"结论为 ${bad?.结论 ?? "?"}，不是 success`;
  if (source["skipped 步骤数"] !== undefined && source["skipped 步骤数"] !== "0") return `run ${runId} 有 ${source["skipped 步骤数"]} 个 skipped 步骤`;
  return null;
}

function runReferences(text) {
  return [...String(text).matchAll(RUN_REF)].map((match) => ({ runId: match[1], sha: match[2], prefix: match[3], entryId: match[4].toUpperCase(), text: match[0] }));
}

function expectedLinkPrefix(file) {
  return file.startsWith("docs/") ? "" : "docs/";
}

/**
 * CLAIM rule (design part 1 §4.4): claim words need a VERIFICATION_LOG link to
 * an entry whose verdict is not 未验证, or "未验证", in the same unit.
 */
export function findClaimViolations(files, { vlog } = {}) {
  const entries = entryMap(vlog);
  const errors = [];
  for (const [file, text] of Object.entries(files)) {
    if (CLAIM_EXCLUDED_FILES.includes(file)) continue;
    for (const unit of splitUnits(text)) {
      const claim = CLAIM_WORDS.exec(unit.text);
      if (!claim) continue;
      if (unit.text.includes(UNVERIFIED)) continue;
      const links = [...unit.text.matchAll(LOG_LINK)];
      if (links.length === 0) {
        errors.push({ code: "CLAIM", file, line: unit.line, message: `缺少验证出处：「${snippet(unit.text)}」中有"${claim[0]}"，同一单元内需要 VERIFICATION_LOG.md#v-… 链接或"未验证"` });
        continue;
      }
      const usable = links.some((link) => {
        const entry = entries.get(link[2].toUpperCase());
        return entry && entry.verdict !== UNVERIFIED && link[1] === expectedLinkPrefix(file);
      });
      if (!usable) errors.push({ code: "CLAIM", file, line: unit.line, message: `缺少验证出处：「${snippet(unit.text)}」链接的条目不存在、路径前缀不是 "${expectedLinkPrefix(file)}VERIFICATION_LOG.md"，或判定为未验证` });
    }
  }
  return errors;
}

/** True when the unit is a CI-CLAIM unit of §5.1. */
export function isCiClaim(text) {
  return CI_WORD.test(text) && CI_VERB.test(text) && CI_OBJECT.test(text);
}

function sectionLines(lines, name) {
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${name}\\s*$`).test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function checkCheckpoint(file, text, report) {
  const lines = normalizeNewlines(text).split("\n");
  const section = sectionLines(lines, CHECKPOINT_SECTION);
  const fieldLines = new Set();
  if (!section) {
    report("CHECKPOINT", file, 1, `缺少 "## ${CHECKPOINT_SECTION}" 一节（Requirement 5.4）`);
    return fieldLines;
  }
  for (const [field, pattern] of Object.entries(CHECKPOINT_FIELDS)) {
    const prefix = `- ${field}：`;
    const indexes = [];
    for (let index = section.start + 1; index < section.end; index += 1) if (lines[index].startsWith(prefix)) indexes.push(index);
    if (indexes.length === 0) {
      report("CHECKPOINT", file, section.start + 1, `当前检查点缺少字段"${field}"（Requirement 5.4、5.7）`);
      continue;
    }
    if (indexes.length > 1) report("CHECKPOINT", file, indexes[1] + 1, `字段"${field}"重复`);
    const index = indexes[0];
    fieldLines.add(index + 1);
    const value = lines[index].slice(prefix.length);
    const match = pattern.exec(value);
    if (!match) {
      report("CHECKPOINT", file, index + 1, `字段"${field}"的值"${snippet(value, 60)}"格式不符`);
      continue;
    }
    if (field === "最新 CI 运行" && match[3] !== "success" && !(match[4] && match[5])) report("CHECKPOINT", file, index + 1, "最新 CI 运行的结论不是 success 时必须写出首个失败 job 和失败步骤序号（Requirement 5.7）");
    if (field === "最新 CI 运行" && match[3] === "success" && match[4]) report("CHECKPOINT", file, index + 1, "结论为 success 的运行不应写失败 job");
  }
  return fieldLines;
}

function checkAuditList(file, text, audit, report) {
  if (!Array.isArray(audit)) return;
  const lines = normalizeNewlines(text).split("\n");
  const section = sectionLines(lines, AUDIT_SECTION);
  if (!section) {
    report("AUDIT-LIST", file, 1, `缺少 "## ${AUDIT_SECTION}" 一节（Requirement 5.3）`);
    return;
  }
  const expected = new Map(audit.filter((record) => AUDIT_LISTED.includes(record.status)).map((record) => [record.id, record.status]));
  const listed = new Map();
  for (let index = section.start + 1; index < section.end; index += 1) {
    const line = lines[index];
    if (!line.startsWith("- ")) continue;
    const match = AUDIT_LINE.exec(line);
    if (!match) {
      report("AUDIT-LIST", file, index + 1, `行格式必须为 - <ID>：<状态>（[登记](AUDIT_REGISTER.md#<id小写>)）：「${snippet(line, 60)}」`);
      continue;
    }
    const [, id, status, anchor] = match;
    if (anchor !== id.toLowerCase()) report("AUDIT-LIST", file, index + 1, `${id} 的登记链接必须指向 AUDIT_REGISTER.md#${id.toLowerCase()}`);
    if (listed.has(id)) report("AUDIT-LIST", file, index + 1, `${id} 重复`);
    listed.set(id, { status, line: index + 1 });
  }
  const missing = [...expected.keys()].filter((id) => !listed.has(id));
  const extra = [...listed.keys()].filter((id) => !expected.has(id));
  if (missing.length > 0 || extra.length > 0) {
    report("AUDIT-LIST", file, section.start + 1, `审计问题状态的编号集合与 Audit_Register 中状态为已确认或需环境验证的编号不一致：缺少 ${missing.join("、") || "无"}；多出 ${extra.join("、") || "无"}（Requirement 5.3）`);
  }
  for (const [id, { status, line }] of listed) {
    if (expected.has(id) && expected.get(id) !== status) report("AUDIT-LIST", file, line, `${id} 写的是 ${status}，Audit_Register 中为 ${expected.get(id)}`);
  }
}

function expandIds(text) {
  const ids = [];
  const ranges = /\b(RW-\d{3}|EP)-(\d{2})\s*(?:至|到|~|–|-)\s*(?:\1-)?(\d{2})\b/g;
  const consumed = [];
  for (const match of String(text).matchAll(ranges)) {
    const from = Number(match[2]);
    const to = Number(match[3]);
    if (to < from || to - from > 50) continue;
    const group = [];
    for (let n = from; n <= to; n += 1) group.push(`${match[1]}-${String(n).padStart(2, "0")}`);
    ids.push({ index: match.index, end: match.index + match[0].length, ids: group });
    consumed.push([match.index, match.index + match[0].length]);
  }
  for (const match of String(text).matchAll(MATRIX_ID)) {
    if (consumed.some(([start, end]) => match.index >= start && match.index < end)) continue;
    ids.push({ index: match.index, end: match.index + match[0].length, ids: [match[1]] });
  }
  return ids.sort((a, b) => a.index - b.index);
}

const STATUS_TOKENS = Object.freeze([...MATRIX_STATUSES, "已满足", "未满足"].sort((a, b) => b.length - a.length));

function statusTokens(text) {
  const tokens = [];
  for (const status of STATUS_TOKENS) {
    let from = 0;
    for (;;) {
      const index = text.indexOf(status, from);
      if (index < 0) break;
      if (!tokens.some((token) => index < token.end && index + status.length > token.index)) tokens.push({ index, end: index + status.length, status });
      from = index + status.length;
    }
  }
  return tokens.sort((a, b) => a.index - b.index);
}

function checkMatrixStatus(file, unit, statusById, report) {
  for (const sentence of String(unit.text).split(/(?<=[。；;])/)) {
    const groups = expandIds(sentence);
    if (groups.length === 0) continue;
    for (const group of groups) for (const id of group.ids) if (!statusById.has(id)) report("MATRIX-STATUS", file, unit.line, `${id} 不在 Readiness_Matrix 中`);
    if (sentence.includes(UNVERIFIED)) {
      for (const group of groups) for (const id of group.ids) if (statusById.get(id)?.status === STATUS_VERIFIED) report("MATRIX-STATUS", file, unit.line, `${id} 在矩阵中为${STATUS_VERIFIED}，同一单元不能标"未验证"（Requirement 5.5）`);
    }
    const events = [...groups.map((group) => ({ type: "ids", ...group })), ...statusTokens(sentence).map((token) => ({ type: "status", ...token }))].sort((a, b) => a.index - b.index);
    let pending = [];
    let held = null;
    const compare = (id, status) => {
      const row = statusById.get(id);
      if (!row) return;
      const actual = status === "已满足" || status === "未满足" ? row.condition : row.status;
      if (actual === null) return;
      if (actual !== status) report("MATRIX-STATUS", file, unit.line, `${id} 写的是"${status}"，Readiness_Matrix 中为"${actual}"（Requirement 5.5）`);
    };
    for (const event of events) {
      if (event.type === "ids") {
        if (held) for (const id of event.ids) compare(id, held);
        else pending.push(...event.ids);
      } else {
        if (pending.length > 0) {
          for (const id of pending) compare(id, event.status);
          pending = [];
          held = null;
        } else {
          held = event.status;
        }
      }
    }
  }
}

/**
 * Validates the Handoff_Doc files (and the CLAIM rule over every file given).
 * @param {{ files: Record<string, string> }} input repository-relative path → text;
 *   the four HANDOFF_FILES plus any docs/*.md file for the CLAIM rule.
 * @param {{ audit?: Array<{ id, status }>, matrix?: string|object, vlog?: Array<{ id, verdict, data }> }} context
 * @returns {Array<{ code, file, line, message }>}
 */
export function validateHandoffDocs({ files }, { audit = null, matrix = null, vlog = [] } = {}) {
  const errors = [];
  const report = (code, file, line, message) => errors.push({ code, file, line, message });
  errors.push(...findClaimViolations(files, { vlog }));
  const statusById = matrix ? matrixStatusById(matrix) : new Map();
  const decision = matrix ? d1Decision(matrix) : null;
  const d1Pending = decision?.decision === "待用户决策";
  for (const file of HANDOFF_FILES) {
    const text = files[file];
    if (text === undefined) continue;
    let checkpointFields = new Set();
    if (file === RESUME_FILE) {
      checkpointFields = checkCheckpoint(file, text, report);
      checkAuditList(file, text, audit, report);
    }
    normalizeNewlines(text).split("\n").forEach((line, index) => {
      if (checkpointFields.has(index + 1)) return;
      const stale = STALE_SYNC.exec(line);
      if (stale) report("STALE-SYNC", file, index + 1, `检查点字段以外出现同步状态描述"${stale[0]}"（Requirement 5.8）`);
    });
    for (const unit of splitUnits(text)) {
      const references = runReferences(unit.text);
      for (const reference of references) {
        const prefix = expectedLinkPrefix(file);
        const problem = reference.prefix !== prefix ? `链接路径必须是 ${prefix}VERIFICATION_LOG.md` : runReferenceProblem(reference, vlog);
        if (problem) report("RUN-REF", file, unit.line, `${reference.text}：${problem}（Requirement 5.6）`);
      }
      if (isCiClaim(unit.text) && !unit.text.includes(UNVERIFIED) && references.length === 0) {
        report("CI-CLAIM", file, unit.line, `CI 结论缺少合格的运行引用或"未验证"：「${snippet(unit.text)}」（Requirement 5.1、5.6）`);
      }
      if (matrix) checkMatrixStatus(file, unit, statusById, report);
      if (!d1Pending) continue;
      for (const sentence of splitSentences(unit.text)) {
        const mention = D1_MENTION.exec(sentence);
        if (mention && !sentence.includes("待用户决策")) report("D1-MENTION", file, unit.line, `提及目标平台 Adapter 但同一句中没有"待用户决策"：「${snippet(sentence)}」（Requirement 40.2）`);
        const status = mention ? D1_STATUS.exec(sentence) : null;
        if (status) report("D1-STATUS", file, unit.line, `目标平台 Adapter 被描述为"${status[0]}"：「${snippet(sentence)}」（Requirement 40.3）`);
        const defaulted = D1_DEFAULT.exec(sentence);
        if (defaulted) report("D1-DEFAULT", file, unit.line, `D1 待用户决策时不能写出已选定或默认的平台：「${snippet(defaulted[0])}」（Requirement 40.4）`);
      }
    }
  }
  return errors.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}
