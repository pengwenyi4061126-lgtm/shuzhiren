import assert from "node:assert/strict";
import test from "node:test";
import { photoNarrationQualityProblems } from "../apps/console/lib/photo-recording-quality.mjs";

test("accepts a decoded portrait recording with matching narration duration", () => {
  assert.deepEqual(photoNarrationQualityProblems({ width: 720, height: 1280, hasDecodedFrame: true, duration: 42.5 }, 42.1), []);
});

test("accepts browser WebM metadata that reports an unknown duration", () => {
  assert.deepEqual(photoNarrationQualityProblems({ width: 720, height: 1280, hasDecodedFrame: true, duration: Infinity }, 42), []);
});

test("rejects wrong dimensions, undecodable frames and mismatched durations", () => {
  assert.deepEqual(photoNarrationQualityProblems({ width: 640, height: 1280, hasDecodedFrame: true, duration: 42 }, 42), ["成片画面尺寸不正确，请重新生成。"]);
  assert.deepEqual(photoNarrationQualityProblems({ width: 720, height: 1280, hasDecodedFrame: false, duration: 42 }, 42), ["浏览器无法解码成片首帧，请检查照片或重新生成。"]);
  assert.deepEqual(photoNarrationQualityProblems({ width: 720, height: 1280, hasDecodedFrame: true, duration: 20 }, 42), ["成片时长与口播音频不一致，请重新生成。"]);
});

test("rejects a finite duration outside supported bounds", () => {
  assert.deepEqual(photoNarrationQualityProblems({ width: 720, height: 1280, hasDecodedFrame: true, duration: 301 }, 301), ["成片时长不在 1 秒到 5 分钟范围内。"]);
});
