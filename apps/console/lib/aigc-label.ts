// AIGC label (人工智能生成合成内容标识办法, in force since 2025-09-01).
//
// Explicit label: LiveTalking draws AIGC_LABEL_TEXT on every frame (runtime/patches/livetalking-aigc-label.patch)
// and reports its state through the Runtime Gateway health (dependencies.livetalking.aigc_label). Preflight blocks
// arm and START unless that report says enabled and shows the run's label text (fail closed).
// Implicit label: the release manifest snapshot and each recording keep the label text, its enabled state, the
// content producer (AIGC_CONTENT_PRODUCER, the service provider's name) and the content id of the live run.
// The spoken disclosure ("我是AI数字人主播") belongs to the interaction rules, not to this module.
import { runtimeGatewayDemoMode, runtimeGatewayHealth } from "@/lib/runtime-gateway";

/** Same default and text rules as runtime/livetalking/shuzhiren_aigc_label.py. */
export const AIGC_LABEL_DEFAULT_TEXT = "本直播由AI数字人生成";
export const AIGC_LABEL_MAX_TEXT_LENGTH = 32;
export const AIGC_CONTENT_PRODUCER_MAX_LENGTH = 128;
export const AIGC_LABEL_STANDARD = "GB 45438-2025";

export type AigcLabelMetadata = {
  standard: typeof AIGC_LABEL_STANDARD;
  explicitLabel: { enabled: boolean; text: string };
  contentProducer: string | null;
  contentId: string;
};

export type AigcLabelReadiness = { passed: boolean; detail: string };

const controlCharacter = /[\p{C}]/u;

export function aigcLabelTextProblem(text: string) {
  if (!text) return "为空";
  if ([...text].length > AIGC_LABEL_MAX_TEXT_LENGTH) return `超过 ${AIGC_LABEL_MAX_TEXT_LENGTH} 个字符`;
  if (controlCharacter.test(text)) return "包含控制字符或不可见字符";
  if (!text.toUpperCase().includes("AI") && !text.includes("人工智能")) return "没有写明内容由 AI 生成";
  return null;
}

/** The expected label text; empty falls back to the default, like the LiveTalking side. */
export function aigcLabelText() {
  return process.env.AIGC_LABEL_TEXT?.trim() || AIGC_LABEL_DEFAULT_TEXT;
}

export function aigcContentProducer() {
  const producer = process.env.AIGC_CONTENT_PRODUCER?.trim() ?? "";
  if (!producer || [...producer].length > AIGC_CONTENT_PRODUCER_MAX_LENGTH || controlCharacter.test(producer)) return null;
  return producer;
}

/** Content id of a live run's AI generated stream: one live run is one piece of content. */
export function aigcContentId(runId: string) {
  return `live-run:${runId}`;
}

/** Implicit label metadata of a live run under the current configuration (sealed into the manifest snapshot). */
export function aigcLabelMetadata(runId: string): AigcLabelMetadata {
  return { standard: AIGC_LABEL_STANDARD, explicitLabel: { enabled: true, text: aigcLabelText() }, contentProducer: aigcContentProducer(), contentId: aigcContentId(runId) };
}

export function isAigcLabelMetadata(value: unknown): value is AigcLabelMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  const explicit = metadata.explicitLabel as Record<string, unknown> | undefined;
  return metadata.standard === AIGC_LABEL_STANDARD && !!explicit && typeof explicit === "object" && typeof explicit.enabled === "boolean" && typeof explicit.text === "string"
    && (metadata.contentProducer === null || typeof metadata.contentProducer === "string") && typeof metadata.contentId === "string";
}

type GatewayLabel = { enabled?: unknown; text?: unknown; position?: unknown; frames_labelled?: unknown; last_error?: unknown };

/**
 * Evaluates the Gateway health report against the expected label (fail closed): an unreachable Gateway, a missing
 * report, enabled other than true, a different text or a missing content producer blocks.
 */
export function evaluateAigcLabelReport(health: unknown, expected: { text: string; contentProducer: string | null }): AigcLabelReadiness {
  if (!expected.contentProducer) return { passed: false, detail: "未配置 AIGC_CONTENT_PRODUCER（隐式标识的内容生成者）" };
  const textProblem = aigcLabelTextProblem(expected.text);
  if (textProblem) return { passed: false, detail: `AIGC 标识文字${textProblem}` };
  if (!health || typeof health !== "object") return { passed: false, detail: "运行时未报告 AIGC 标识状态" };
  const livetalking = (health as { dependencies?: { livetalking?: { aigc_label?: GatewayLabel } } }).dependencies?.livetalking;
  const label = livetalking?.aigc_label;
  if (!label || typeof label !== "object") return { passed: false, detail: "运行时未报告 AIGC 标识状态（LiveTalking 镜像可能缺少 AIGC 标识补丁）" };
  if (label.enabled !== true) return { passed: false, detail: `LiveTalking 未启用 AIGC 画面标识${typeof label.last_error === "string" && /^[a-z_]{1,64}$/.test(label.last_error) ? `（${label.last_error}）` : ""}` };
  if (label.text !== expected.text) return { passed: false, detail: "LiveTalking 画面标识文字与场次登记的 AIGC 标识文字不一致" };
  const position = typeof label.position === "string" && /^(top|bottom)-(left|right)$/.test(label.position) ? ` · ${label.position}` : "";
  const frames = typeof label.frames_labelled === "number" && Number.isInteger(label.frames_labelled) && label.frames_labelled >= 0 ? ` · 已标识 ${label.frames_labelled} 帧` : "";
  return { passed: true, detail: `画面标识「${expected.text}」已启用${position}${frames}` };
}

const AIGC_HEALTH_TIMEOUT_MS = 5_000;

/** Reads the Gateway health (bounded, so a lifecycle transaction never waits on it for long) and evaluates the label. */
export async function evaluateAigcLabelReadiness(expectedText: string = aigcLabelText()): Promise<AigcLabelReadiness> {
  let health: unknown;
  try {
    // Development without a Gateway (never in production: the Gateway configuration refuses demo mode there).
    if (runtimeGatewayDemoMode()) {
      const textProblem = aigcLabelTextProblem(expectedText);
      return textProblem ? { passed: false, detail: `AIGC 标识文字${textProblem}` } : { passed: true, detail: `演示网关：未连接 LiveTalking，画面标识「${expectedText}」未经运行时核验` };
    }
    health = await runtimeGatewayHealth({ timeoutMs: AIGC_HEALTH_TIMEOUT_MS, acceptDegraded: true });
  } catch {
    return { passed: false, detail: "无法读取 Runtime Gateway 健康状态，AIGC 标识状态未知" };
  }
  return evaluateAigcLabelReport(health, { text: expectedText, contentProducer: aigcContentProducer() });
}
