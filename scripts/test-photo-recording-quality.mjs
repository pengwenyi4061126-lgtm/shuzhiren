import assert from "node:assert/strict";
import test from "node:test";
import { photoNarrationQualityProblems, photoRecordingArchiveQualityError } from "../apps/console/lib/photo-recording-quality.mjs";

test("accepts a decoded portrait recording with matching narration duration", () => {
  assert.deepEqual(photoNarrationQualityProblems({ width: 720, height: 1280, hasDecodedFrame: true, duration: 42.5 }, 42.1), []);
});

test("rejects browser WebM metadata that reports an unknown duration", () => {
  assert.deepEqual(photoNarrationQualityProblems({ width: 720, height: 1280, hasDecodedFrame: true, duration: Infinity }, 42), ["无法读取成片时长，请重新生成或更换桌面浏览器。"]);
});

test("rejects narration audio whose duration cannot be verified or is outside supported bounds", () => {
  assert.deepEqual(photoNarrationQualityProblems({ width: 720, height: 1280, hasDecodedFrame: true, duration: 42 }, NaN), ["无法读取有效的口播音频时长，请更换音频后重试。"]);
  assert.deepEqual(photoNarrationQualityProblems({ width: 720, height: 1280, hasDecodedFrame: true, duration: 301 }, 301), ["成片时长不在 1 秒到 5 分钟范围内。", "无法读取有效的口播音频时长，请更换音频后重试。"]);
});

test("rejects wrong dimensions, undecodable frames and mismatched durations", () => {
  assert.deepEqual(photoNarrationQualityProblems({ width: 640, height: 1280, hasDecodedFrame: true, duration: 42 }, 42), ["成片画面尺寸不正确，请重新生成。"]);
  assert.deepEqual(photoNarrationQualityProblems({ width: 720, height: 1280, hasDecodedFrame: false, duration: 42 }, 42), ["浏览器无法解码成片首帧，请检查照片或重新生成。"]);
  assert.deepEqual(photoNarrationQualityProblems({ width: 720, height: 1280, hasDecodedFrame: true, duration: 20 }, 42), ["成片时长与口播音频不一致，请重新生成。"]);
});

test("rejects a finite duration outside supported bounds", () => {
  assert.deepEqual(photoNarrationQualityProblems({ width: 720, height: 1280, hasDecodedFrame: true, duration: 301 }, 300), ["成片时长不在 1 秒到 5 分钟范围内。"]);
});

test("maps independent archive quality failures to actionable beginner-facing guidance", () => {
  assert.match(photoRecordingArchiveQualityError("recording_quality_probe_busy"), /稍后重试/);
  assert.match(photoRecordingArchiveQualityError("recording_quality_dimensions_invalid"), /720 × 1280/);
  assert.match(photoRecordingArchiveQualityError("unknown_server_error"), /质检失败/);
});
