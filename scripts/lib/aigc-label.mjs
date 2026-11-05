// AIGC explicit label deployment rules (人工智能生成合成内容标识办法, in force since 2025-09-01).
//
// LiveTalking draws the label on every pushed and recorded frame (runtime/patches/livetalking-aigc-label.patch,
// runtime/livetalking/shuzhiren_aigc_label.py). Deploy_Check fails when a production configuration lacks or
// turns off the label, when the console's expected label text differs from the runtime's, when the runtime
// Compose does not pass the label variables to LiveTalking, or when the image build drops the label patch,
// module or CJK font. The text rules mirror normalize_text() in shuzhiren_aigc_label.py.
// Messages name variables and files, never values. No I/O.
import { parseInterpolations } from "./compose-interpolation.mjs";

export const AIGC_LABEL_PATCH = "livetalking-aigc-label.patch";
export const AIGC_LABEL_POSITIONS = Object.freeze(["top-left", "top-right", "bottom-left", "bottom-right"]);
export const AIGC_LABEL_DEFAULT_TEXT = "本直播由AI数字人生成";
export const AIGC_LABEL_MAX_TEXT_LENGTH = 32;
export const AIGC_CONTENT_PRODUCER_MAX_LENGTH = 128;
/** Runtime env variables Compose must pass to the livetalking service, each as `${NAME:?set-in-runtime-env}`. */
export const AIGC_LABEL_RUNTIME_VARIABLES = Object.freeze(["AIGC_LABEL_ENABLED", "AIGC_LABEL_TEXT", "AIGC_LABEL_POSITION"]);
export const AIGC_LABEL_PATCH_HOOKS = Object.freeze([
  "+        self.aigc_label = shuzhiren_aigc_label.process_renderer()",
  "+                combine_frame = self.aigc_label.apply(combine_frame)",
  "+    app.router.add_get(\"/api/admin/aigc-label\", admin_aigc_label)"
]);
export const AIGC_LABEL_DOCKERFILE_LINES = Object.freeze(["COPY runtime/livetalking/shuzhiren_aigc_label.py /opt/shuzhiren/"]);
export const AIGC_LABEL_FONT_PACKAGE = "fonts-noto-cjk";

const isPlaceholder = (value) => /replace-with|replace-me|example\.com|<|>/.test(value);
// Unicode "C*" categories (control, format, unassigned, private use, surrogate), as unicodedata.category in Python.
const controlCharacter = /[\p{C}]/u;

/** The problem with a label text, or null. */
export function aigcLabelTextProblem(text) {
  const value = String(text ?? "").trim();
  if (!value) return "为空";
  if ([...value].length > AIGC_LABEL_MAX_TEXT_LENGTH) return `超过 ${AIGC_LABEL_MAX_TEXT_LENGTH} 个字符`;
  if (controlCharacter.test(value)) return "包含控制字符或不可见字符";
  if (!value.toUpperCase().includes("AI") && !value.includes("人工智能")) return "没有写明内容由 AI 生成（必须包含“AI”或“人工智能”）";
  return null;
}

/**
 * @param {{ runtime: Map<string, string>, control: Map<string, string>, allowPlaceholders?: boolean }} input
 *   runtime: config/runtime.example.env (or the production runtime env), control: the control-plane env.
 * @returns {string[]} errors; the label can never be turned off, so these are errors also with --allow-placeholders.
 */
export function aigcLabelEnvProblems({ runtime, control, allowPlaceholders = false }) {
  const errors = [];
  const enabled = runtime.get("AIGC_LABEL_ENABLED");
  if (enabled === undefined || enabled === "") errors.push("运行时 缺少 AIGC_LABEL_ENABLED；AIGC 显式标识必须启用（AIGC_LABEL_ENABLED=true）");
  else if (enabled !== "true") errors.push("运行时 的 AIGC_LABEL_ENABLED 必须为 true；AIGC 显式标识不能关闭，LiveTalking 启动器会以 78 退出");
  const text = runtime.get("AIGC_LABEL_TEXT");
  const textProblem = aigcLabelTextProblem(text);
  if (text === undefined) errors.push("运行时 缺少 AIGC_LABEL_TEXT（AIGC 显式标识文字）");
  else if (textProblem) errors.push(`运行时 的 AIGC_LABEL_TEXT ${textProblem}`);
  const position = runtime.get("AIGC_LABEL_POSITION");
  if (position === undefined || position === "") errors.push("运行时 缺少 AIGC_LABEL_POSITION（AIGC 显式标识位置）");
  else if (!AIGC_LABEL_POSITIONS.includes(position)) errors.push(`运行时 的 AIGC_LABEL_POSITION 必须是 ${AIGC_LABEL_POSITIONS.join("、")} 之一`);
  if (runtime.has("AIGC_LABEL_FONT_FILE")) errors.push("运行时 env 不得定义 AIGC_LABEL_FONT_FILE；生产镜像只使用随镜像安装的 fonts-noto-cjk 字体");
  const expected = control.get("AIGC_LABEL_TEXT");
  if (expected === undefined || expected === "") errors.push("控制面 缺少 AIGC_LABEL_TEXT；开播前检查用它核对运行时报告的标识文字");
  else if (text !== undefined && expected !== text) errors.push("控制面与运行时的 AIGC_LABEL_TEXT 必须一致，否则开播前检查会因标识文字不符而阻止开播");
  const producer = control.get("AIGC_CONTENT_PRODUCER") ?? "";
  if (!producer.trim()) errors.push("控制面 缺少 AIGC_CONTENT_PRODUCER（隐式标识中的内容生成者，即服务提供者名称）");
  else if (!allowPlaceholders && isPlaceholder(producer)) errors.push("控制面 的 AIGC_CONTENT_PRODUCER 仍是占位符");
  else if ([...producer.trim()].length > AIGC_CONTENT_PRODUCER_MAX_LENGTH || controlCharacter.test(producer.trim())) errors.push(`控制面 的 AIGC_CONTENT_PRODUCER 必须是不超过 ${AIGC_CONTENT_PRODUCER_MAX_LENGTH} 个字符、不含控制字符的名称`);
  return errors;
}

function environmentValue(service, key) {
  const environment = service?.environment;
  if (Array.isArray(environment)) {
    const entry = environment.find((item) => typeof item === "string" && (item === key || item.startsWith(`${key}=`)));
    return entry === undefined ? undefined : entry.includes("=") ? entry.slice(entry.indexOf("=") + 1) : null;
  }
  if (environment && typeof environment === "object") return Object.hasOwn(environment, key) ? (environment[key] === null ? null : String(environment[key])) : undefined;
  return undefined;
}

/** The runtime Compose passes every AIGC_LABEL_RUNTIME_VARIABLES entry to livetalking as a required interpolation. */
export function aigcLabelComposeProblems(composeDoc) {
  const errors = [];
  const liveTalking = composeDoc?.services?.livetalking;
  for (const name of AIGC_LABEL_RUNTIME_VARIABLES) {
    const expression = `\${${name}:?set-in-runtime-env}`;
    const value = environmentValue(liveTalking, name);
    if (value !== expression) errors.push(`运行时 Compose 的 livetalking.environment.${name} 必须为 ${expression}，AIGC 显式标识配置只能来自运行时 env`);
  }
  if (environmentValue(liveTalking, "AIGC_LABEL_FONT_FILE") !== undefined) errors.push("运行时 Compose 不得为 livetalking 设置 AIGC_LABEL_FONT_FILE");
  for (const [name, service] of Object.entries(composeDoc?.services ?? {})) {
    if (name === "livetalking") continue;
    const environment = service?.environment;
    const values = Array.isArray(environment) ? environment.map(String) : environment && typeof environment === "object" ? Object.values(environment).map((value) => String(value ?? "")) : [];
    if (values.some((value) => parseInterpolations(value).some((reference) => reference.name === "AIGC_LABEL_ENABLED"))) errors.push(`运行时 Compose 的 ${name} 不得引用 AIGC_LABEL_ENABLED`);
  }
  return errors;
}

/** The patch series and the LiveTalking image keep the label patch, its hooks, the module and the CJK font. */
export function aigcLabelBuildProblems({ seriesPatches, patchText, dockerfileText }) {
  const errors = [];
  if (!seriesPatches.includes(AIGC_LABEL_PATCH)) errors.push(`LiveTalking 补丁序列缺少 ${AIGC_LABEL_PATCH}（AIGC 显式标识）`);
  if (patchText === undefined) errors.push(`runtime/patches/${AIGC_LABEL_PATCH} 无法读取`);
  else for (const hook of AIGC_LABEL_PATCH_HOOKS) if (!patchText.includes(hook)) errors.push(`LiveTalking AIGC 标识补丁缺少挂接：${hook.slice(1).trim()}`);
  for (const line of AIGC_LABEL_DOCKERFILE_LINES) if (!dockerfileText.split(/\r?\n/).some((candidate) => candidate.trim() === line)) errors.push(`LiveTalking 镜像没有复制 AIGC 标识模块：${line}`);
  const aptInstall = dockerfileText.split(/\r?\n/).find((line) => /apt-get install/.test(line)) ?? "";
  if (!aptInstall.split(/\s+/).includes(AIGC_LABEL_FONT_PACKAGE)) errors.push(`LiveTalking 镜像没有安装中文字体包 ${AIGC_LABEL_FONT_PACKAGE}，AIGC 标识无法绘制中文`);
  return errors;
}
